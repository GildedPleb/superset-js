import { addPendingRepo, getState, repoExists, setState, type Db } from "../services/db";
import {
  fetchRepoNamesForHour,
  type GhArchiveFetchResult,
} from "../services/gharchive";
import * as logger from "../services/logger";

const DISCOVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INIT_LOOKBACK_HOURS = 72;
const CHECKPOINT_KEY = "checkpoint_hour";

type DiscoveryState = {
  checkpointHour: Date;
  lastCheckAt: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const nextHour = addHours(cursor, 1);
    if (nextHour.getTime() > currentHour.getTime()) {
      return { checkpointHour: cursor, lastCheckAt: Date.now() };
    }

    const hourIso = toHourIso(nextHour);
    const result = await discoverRepos(db, hourIso);
    if (!result.ok) {
      logger.warn(`Discovery halted at ${hourIso}`);
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
  const nextHour = addHours(state.checkpointHour, 1);
  const hourIso = toHourIso(nextHour);
  const result = await discoverRepos(db, hourIso);
  if (result.ok) {
    setState(db, CHECKPOINT_KEY, toHourIso(nextHour));
    logger.info(`Discovery check succeeded for ${hourIso}`);
    return { checkpointHour: nextHour, lastCheckAt: now };
  }

  logger.info(`Discovery check skipped for ${hourIso} (status ${result.status})`);
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

  let added = 0;
  for (const name of result.repoNames) {
    if (!repoExists(db, name)) {
      addPendingRepo(db, name, targetHourIso);
      added++;
    }
  }

  logger.info(
    `Added ${added.toLocaleString()} new pending repos (${targetHourIso})`,
  );
  return { ...result, added };
}
