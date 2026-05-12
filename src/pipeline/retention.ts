import {
  purgeOldConfigs,
  purgeUnusedBlobs,
  purgeStaleRepos,
  type Db,
  ELIGIBLE_RETENTION_DAYS,
} from "../services/db";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("retention");

// === TIMING CONSTANTS ===
const INITIAL_OFFSET_MS = 30 * 60 * 1000; // 30-minute offset after discovery starts
const RETENTION_INTERVAL_MS = 60 * 60 * 1000; // run every hour thereafter

// Legacy constant kept for purgeOldConfigs compatibility
const RETENTION_DAYS = ELIGIBLE_RETENTION_DAYS;

function runRetention(db: Db) {
  // New core retention: eject stale repos + clean ALL their relations
  const startTime = Date.now();
  const {
    purgedRepos,
    purgedConfigs: staleConfigsPurged,
    purgedNormalized,
  } = purgeStaleRepos(db);
  const durationMs = Date.now() - startTime;

  // Legacy cleanup (still needed for old configs)
  const oldConfigsPurged = purgeOldConfigs(db, RETENTION_DAYS);
  const blobsPurged = purgeUnusedBlobs(db);

  const totalConfigsPurged = staleConfigsPurged + oldConfigsPurged;

  logger.info(
    `Purged ${purgedRepos} repos, ${totalConfigsPurged} configs ` +
      `(${staleConfigsPurged} stale + ${oldConfigsPurged} old), ${purgedNormalized} normalized, ${blobsPurged} blobs (${durationMs}ms)`,
  );
}

export const startRetentionStage = (db: Db, signal: AbortSignal) => {
  return async () => {
    logger.info("stage started");

    // 30-minute offset so retention runs *after* discovery (as requested)
    await sleep(INITIAL_OFFSET_MS, signal);

    while (true) {
      signal.throwIfAborted();
      runRetention(db);
      await sleep(RETENTION_INTERVAL_MS, signal);
    }
  };
};
