import {
  purgeOldConfigs,
  purgeUnusedBlobs,
  purgeStaleRepos,
  type Db,
} from "../services/db";
import {
  ELIGIBLE_RETENTION_DAYS,
  THIRTY_MIN_MS,
  ONE_HOUR_MS,
} from "../constants";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("retention");

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
  const oldConfigsPurged = purgeOldConfigs(db, ELIGIBLE_RETENTION_DAYS);
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
    await sleep(THIRTY_MIN_MS, signal);

    while (true) {
      signal.throwIfAborted();
      runRetention(db);
      await sleep(ONE_HOUR_MS, signal);
    }
  };
};
