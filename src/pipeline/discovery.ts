import {
  getState,
  promoteManyToEligible,
  recordPushes,
  setState,
  type Db,
  type PendingRepo,
} from "../services/db";
import {
  fetchEventsForHour,
  type GhArchiveFetchResult,
} from "../services/gharchive";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("discovery");

const DISCOVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INIT_LOOKBACK_HOURS = 72;
const CHECKPOINT_KEY = "checkpoint_hour";
const GRACE_PERIOD_HOURS = 3; // don't attempt hours newer than this
const MAX_MISSING_HOURS = 24; // permanently skip after this many hours of 404

export type DiscoveryState = {
  checkpointHour: Date;
  lastCheckAt: number;
};

function floorToUtcHour(date: Date): Date {
  const floored = new Date(date.getTime());
  floored.setUTCMinutes(0, 0, 0);
  return floored;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toHourIso(date: Date): string {
  return date.toISOString();
}

// Synchronous, single-transaction flush of one hour's events.
// One BEGIN/COMMIT per hour: empirical testing showed each commit's
// fsync is the dominant cost (~80ms each under synchronous=NORMAL),
// not the row writes themselves. Sub-transactioning multiplies fsyncs
// without reducing real write contention. Pushes run before engagements
// so an engagement event whose corresponding push arrived in the same
// hour can find the row in 'pending' state.
function flushHourSync(
  db: Db,
  pushes: PendingRepo[],
  engagements: { fullName: string; createdAt: string }[],
): { pushUpdates: number; promoted: number } {
  if (pushes.length === 0 && engagements.length === 0) {
    return { pushUpdates: 0, promoted: 0 };
  }

  db.run("BEGIN");
  try {
    const pushUpdates = recordPushes(db, pushes);
    const promoted = promoteManyToEligible(db, engagements);
    db.run("COMMIT");
    return { pushUpdates, promoted };
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

async function initDiscovery(
  db: Db,
  signal: AbortSignal,
): Promise<DiscoveryState> {
  const existing = getState(db, CHECKPOINT_KEY);
  if (existing) {
    const parsed = new Date(existing);
    if (Number.isFinite(parsed.getTime())) {
      return { checkpointHour: parsed, lastCheckAt: Date.now() };
    }
  }

  logger.info("Initializing discovery checkpoint");
  const currentHour = floorToUtcHour(new Date());

  for (let i = 0; i <= INIT_LOOKBACK_HOURS; i++) {
    const candidate = addHours(currentHour, -i);
    const iso = toHourIso(candidate);
    const result = await fetchEventsForHour(iso, signal);
    if (result.ok) {
      setState(db, CHECKPOINT_KEY, iso);
      logger.info(`Checkpoint set to ${iso}`);
      return { checkpointHour: candidate, lastCheckAt: Date.now() };
    }
  }

  throw new Error(
    `No GHArchive hours found in last ${INIT_LOOKBACK_HOURS} hours`,
  );
}

/**
 * Core greedy catch-up logic.
 * Processes as many consecutive hours as possible until it hits the grace period
 * or a genuinely-not-ready hour. Used at startup AND by the hourly loop.
 *
 * Each hour: fetch -> flush synchronously -> advance cursor. The cursor
 * is never advanced until the hour's events are durably committed, so
 * a crash mid-flush is safe (re-processing is idempotent).
 */
async function advanceDiscovery(
  db: Db,
  state: DiscoveryState,
  signal: AbortSignal,
): Promise<DiscoveryState> {
  let cursor = state.checkpointHour;
  let lastCheckAt = Date.now();
  let processedAny = false;

  while (true) {
    const currentHour = floorToUtcHour(new Date());
    const latestProcessable = addHours(currentHour, -GRACE_PERIOD_HOURS);
    const nextHour = addHours(cursor, 1);

    if (nextHour.getTime() > latestProcessable.getTime()) {
      if (processedAny) {
        logger.info(
          `Discovery catch-up complete — next hour ${toHourIso(
            nextHour,
          )} still inside grace period`,
        );
      }
      return { checkpointHour: cursor, lastCheckAt };
    }

    const hourIso = toHourIso(nextHour);
    logger.info(`Scanning GHArchive ${hourIso}`);

    const result = await discoverRepos(db, hourIso, signal);

    if (result.ok) {
      cursor = nextHour;
      setState(db, CHECKPOINT_KEY, hourIso);
      lastCheckAt = Date.now();
      processedAny = true;
      continue; // keep catching up aggressively
    }

    const hoursOld = (Date.now() - nextHour.getTime()) / (1000 * 60 * 60);

    if (hoursOld > MAX_MISSING_HOURS) {
      logger.warn(
        `GHArchive ${hourIso} permanently missing (404 after ${Math.round(
          hoursOld,
        )}h) — skipping`,
      );
      cursor = nextHour;
      setState(db, CHECKPOINT_KEY, hourIso);
      lastCheckAt = Date.now();
      processedAny = true;
      continue;
    }

    logger.info(
      `GHArchive ${hourIso} not ready yet (404) — will retry on next check`,
    );
    return { checkpointHour: cursor, lastCheckAt };
  }
}

async function discoverRepos(
  db: Db,
  targetHourIso: string,
  signal: AbortSignal,
): Promise<
  GhArchiveFetchResult & {
    pushedCount: number;
    engagementCount: number;
    pushUpdates: number;
    promoted: number;
  }
> {
  const t0 = Date.now();
  const result = await fetchEventsForHour(targetHourIso, signal);
  if (!result.ok) {
    return {
      ...result,
      pushedCount: 0,
      engagementCount: 0,
      pushUpdates: 0,
      promoted: 0,
    };
  }

  const tFetch = Date.now();

  // Convert ArchiveEntry[] to PendingRepo[] for the push side.
  const pushes: PendingRepo[] = result.pushes.map((p) => ({
    fullName: p.fullName,
    pushedAt: p.createdAt,
  }));
  const engagements = result.engagements.map((e) => ({
    fullName: e.fullName,
    createdAt: e.createdAt,
  }));

  const { pushUpdates, promoted } = flushHourSync(db, pushes, engagements);

  const tFlush = Date.now();

  logger.info(
    `Hour ${targetHourIso}: discovered ${pushes.length.toLocaleString()} (updated last push for ${pushUpdates.toLocaleString()}) ` +
      `| engagements ${engagements.length.toLocaleString()} (${promoted.toLocaleString()} promoted) ` +
      `| fetch ${tFetch - t0}ms flush ${tFlush - tFetch}ms`,
  );
  return {
    ...result,
    pushedCount: pushes.length,
    engagementCount: engagements.length,
    pushUpdates,
    promoted,
  };
}

export const startDiscoveryStage = (db: Db, signal: AbortSignal) => {
  return async () => {
    logger.info("stage started");

    let currentState = await initDiscovery(db, signal);

    while (true) {
      signal.throwIfAborted();
      currentState = await advanceDiscovery(db, currentState, signal);
      const now = Date.now();
      const elapsed = now - currentState.lastCheckAt;
      const waitMs = Math.max(0, DISCOVERY_CHECK_INTERVAL_MS - elapsed);
      await sleep(waitMs, signal);
    }
  };
};
