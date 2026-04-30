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
import * as logger from "../services/logger";
import { sleep } from "../utils/time";

const DISCOVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INIT_LOOKBACK_HOURS = 72;
const CHECKPOINT_KEY = "checkpoint_hour";
const INSERT_BATCH_SIZE = 400;
const FLUSH_INTERVAL_MS = 250;
const GRACE_PERIOD_HOURS = 3; // don't even attempt hours newer than this
const MAX_MISSING_HOURS = 24; // if still 404 after this many hours → skip it

const pendingQueue: PendingRepo[] = [];
let flushScheduled = false;
let flushInProgress = false;

type DiscoveryState = {
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

export async function discoverToCurrent(
  db: Db,
  state: DiscoveryState,
): Promise<DiscoveryState> {
  let cursor = state.checkpointHour;

  while (true) {
    const currentHour = floorToUtcHour(new Date());
    const latestProcessable = addHours(currentHour, -GRACE_PERIOD_HOURS);
    const nextHour = addHours(cursor, 1);

    if (nextHour.getTime() > latestProcessable.getTime()) {
      return { checkpointHour: cursor, lastCheckAt: Date.now() };
    }

    const hourIso = toHourIso(nextHour);
    const result = await discoverRepos(db, hourIso);
    if (!result.ok) {
      const hoursOld = (Date.now() - nextHour.getTime()) / (1000 * 60 * 60);

      if (hoursOld > MAX_MISSING_HOURS) {
        logger.warn(
          `GHArchive ${hourIso} appears permanently missing (404 after ${Math.round(hoursOld)}h) — skipping`,
        );
        cursor = nextHour;
        setState(db, CHECKPOINT_KEY, toHourIso(cursor));
        continue;
      }

      logger.warn(
        `GHArchive ${hourIso} not ready yet (404) — will retry later`,
      );
      return { checkpointHour: cursor, lastCheckAt: Date.now() };
    }

    cursor = nextHour;
    setState(db, CHECKPOINT_KEY, toHourIso(cursor));
  }
}

async function runDiscoveryCheckOnce(
  db: Db,
  state: DiscoveryState,
): Promise<DiscoveryState> {
  const now = Date.now();
  const currentHour = floorToUtcHour(new Date());
  const latestProcessable = addHours(currentHour, -GRACE_PERIOD_HOURS);
  const nextHour = addHours(state.checkpointHour, 1);
  const hourIso = toHourIso(nextHour);

  if (nextHour.getTime() > latestProcessable.getTime()) {
    logger.info(
      `Discovery check skipped — ${hourIso} still inside grace period`,
    );
    return { checkpointHour: state.checkpointHour, lastCheckAt: now };
  }

  const result = await discoverRepos(db, hourIso);
  if (result.ok) {
    setState(db, CHECKPOINT_KEY, toHourIso(nextHour));
    logger.info(`Discovery check succeeded for ${hourIso}`);
    return { checkpointHour: nextHour, lastCheckAt: now };
  }

  const hoursOld = (Date.now() - nextHour.getTime()) / (1000 * 60 * 60);

  if (hoursOld > MAX_MISSING_HOURS) {
    logger.warn(
      `GHArchive ${hourIso} permanently missing (404 after ${Math.round(hoursOld)}h) — skipping`,
    );
    setState(db, CHECKPOINT_KEY, toHourIso(nextHour));
    return { checkpointHour: nextHour, lastCheckAt: now };
  }

  logger.info(`Discovery check skipped for ${hourIso} (not ready yet)`);
  return { checkpointHour: state.checkpointHour, lastCheckAt: now };
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
    await sleep(waitMs);
    currentState = await runDiscoveryCheckOnce(db, currentState);
  }
}

export async function discoverRepos(
  db: Db,
  targetHourIso: string,
): Promise<GhArchiveFetchResult & { added: number }> {
  logger.info(`Scanning GHArchive ${targetHourIso}`);
  const result = await fetchRepoNamesForHour(targetHourIso);
  if (!result.ok) {
    return { ...result, added: 0 };
  }

  const knownRepoNames = new Set(getAllRepoNames(db));
  let knownCount = 0;
  for (const fullName of result.repoNames) {
    if (knownRepoNames.has(fullName)) {
      knownCount += 1;
    }
  }
  const discovered = result.repoNames.length;
  const newCount = discovered - knownCount;

  const added = enqueuePendingRepos(db, result.repoNames, targetHourIso);

  logger.info(
    `Discovered ${discovered.toLocaleString()} repos: new ${newCount.toLocaleString()}, known ${knownCount.toLocaleString()} (${targetHourIso})`,
  );
  logger.info(`Queued ${added.toLocaleString()} repos (${targetHourIso})`);
  return { ...result, added };
}
