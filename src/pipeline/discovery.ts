import {
  addPendingRepos,
  getAllRepoNames,
  getState,
  setState,
  type Db,
  type PendingRepo,
} from "../services/db";
import {
  fetchRepoNamesForHour,
  type GhArchiveFetchResult,
} from "../services/gharchive";
import { createLogger } from "../services/logger";

const logger = createLogger("discovery");

const DISCOVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INIT_LOOKBACK_HOURS = 72;
const CHECKPOINT_KEY = "checkpoint_hour";
const INSERT_BATCH_SIZE = 400;
const FLUSH_INTERVAL_MS = 250;
const GRACE_PERIOD_HOURS = 3; // don't attempt hours newer than this
const MAX_MISSING_HOURS = 24; // permanently skip after this many hours of 404

const pendingQueue: PendingRepo[] = [];
let flushScheduled = false;
let flushInProgress = false;

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

function enqueuePendingRepos(
  db: Db,
  repoNames: string[],
  pushedAt: string,
): number {
  for (const fullName of repoNames) {
    pendingQueue.push({ fullName, pushedAt });
  }
  scheduleFlush(db);
  return repoNames.length;
}

function scheduleFlush(db: Db) {
  if (flushScheduled || flushInProgress || pendingQueue.length === 0) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    flushOnce(db);
  }, FLUSH_INTERVAL_MS);
}

function flushOnce(db: Db) {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const batch = pendingQueue.splice(0, INSERT_BATCH_SIZE);
    if (batch.length === 0) return;
    db.exec("BEGIN");
    try {
      addPendingRepos(db, batch);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      pendingQueue.unshift(...batch);
      logger.warn(
        `Repo insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    flushInProgress = false;
    if (pendingQueue.length > 0) {
      scheduleFlush(db);
    }
  }
}

export async function initDiscovery(db: Db): Promise<DiscoveryState> {
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
    const result = await fetchRepoNamesForHour(iso);
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
 */
export async function advanceDiscovery(
  db: Db,
  state: DiscoveryState,
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

    const result = await discoverRepos(db, hourIso);

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

export async function runHourlyDiscoveryCheck(
  db: Db,
  state: DiscoveryState,
): Promise<never> {
  let currentState = state;

  while (true) {
    const now = Date.now();
    const elapsed = now - currentState.lastCheckAt;
    const waitMs = Math.max(0, DISCOVERY_CHECK_INTERVAL_MS - elapsed);
    await Bun.sleep(waitMs);
    currentState = await advanceDiscovery(db, currentState);
  }
}

export async function discoverRepos(
  db: Db,
  targetHourIso: string,
): Promise<GhArchiveFetchResult & { added: number }> {
  const result = await fetchRepoNamesForHour(targetHourIso);
  if (!result.ok) {
    return { ...result, added: 0 };
  }

  const knownRepoNames = new Set(getAllRepoNames(db));
  let knownCount = 0;
  for (const fullName of result.repoNames) {
    if (knownRepoNames.has(fullName)) knownCount++;
  }
  const discovered = result.repoNames.length;
  const newCount = discovered - knownCount;

  const added = enqueuePendingRepos(db, result.repoNames, targetHourIso);

  logger.info(
    `Discovered ${discovered.toLocaleString()} repos: new ${newCount.toLocaleString()}, known ${knownCount.toLocaleString()} (${knownCount > 0 ? ((newCount / knownCount) * 100).toFixed(0) : "0"}% unknown)`,
  );
  return { ...result, added };
}

export const startDiscoveryStage = (db: Db) => {
  let discoveryState: DiscoveryState | null = null;

  return async () => {
    logger.info("stage started");

    discoveryState = await initDiscovery(db);
    discoveryState = await advanceDiscovery(db, discoveryState);

    // Use the existing hourly runner (it now uses namespaced logger)
    void runHourlyDiscoveryCheck(db, discoveryState!).catch((err) => {
      logger.error(
        `discovery runner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // Keep stage alive
    while (true) await Bun.sleep(3600_000);
  };
};
