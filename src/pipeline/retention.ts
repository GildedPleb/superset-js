import { purgeOldConfigs, purgeUnusedBlobs, purgeStaleRepos, type Db, PENDING_RETENTION_DAYS, ELIGIBLE_RETENTION_DAYS } from "../services/db";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("retention");

// === TIMING CONSTANTS ===
const INITIAL_OFFSET_MS = 30 * 60 * 1000;     // 30-minute offset after discovery starts
const RETENTION_INTERVAL_MS = 60 * 60 * 1000; // run every hour thereafter

// Legacy constant kept for purgeOldConfigs compatibility
const RETENTION_DAYS = ELIGIBLE_RETENTION_DAYS;

export function runRetention(db: Db) {
  // New core retention: eject stale repos + clean ALL their relations
  const { purgedRepos, purgedConfigs: staleConfigsPurged, purgedNormalized } = purgeStaleRepos(db);

  // Legacy cleanup (still needed for old configs)
  const oldConfigsPurged = purgeOldConfigs(db, RETENTION_DAYS);
  const blobsPurged = purgeUnusedBlobs(db);

  const totalConfigsPurged = staleConfigsPurged + oldConfigsPurged;

  if (purgedRepos > 0 || totalConfigsPurged > 0 || purgedNormalized > 0 || blobsPurged > 0) {
    logger.info(
      `Retention: purged ${purgedRepos} repos, ${totalConfigsPurged} configs ` +
      `(${staleConfigsPurged} stale + ${oldConfigsPurged} old), ${purgedNormalized} normalized, ${blobsPurged} blobs`
    );
  }
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