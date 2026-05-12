import { purgeOldConfigs, purgeUnusedBlobs, purgeExpiredRepos, type Db } from "../services/db";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("retention");

const RETENTION_DAYS = 365;

export function runRetention(db: Db) {
  const repoPurgeResult = purgeExpiredRepos(db);
  const configsPurged = purgeOldConfigs(db, RETENTION_DAYS);
  const blobsPurged = purgeUnusedBlobs(db);

  const totalConfigsPurged = configsPurged + repoPurgeResult.purgedConfigs;
  const totalNormalizedPurged = repoPurgeResult.purgedNormalized;

  if (
    repoPurgeResult.purgedPending > 0 ||
    repoPurgeResult.purgedPromoted > 0 ||
    configsPurged > 0 ||
    blobsPurged > 0
  ) {
    logger.info(
      `Retention: purged ${repoPurgeResult.purgedPending} pending repos, ${repoPurgeResult.purgedPromoted} promoted repos, ${totalConfigsPurged} configs, ${totalNormalizedPurged} normalized, ${blobsPurged} blobs`,
    );
  }
}

export const startRetentionStage = (db: Db, signal: AbortSignal) => {
  return async () => {
    logger.info("stage started");
    // 30 minute offset from discovery pipeline start
    await sleep(30 * 60 * 1000, signal);
    while (true) {
      signal.throwIfAborted();
      runRetention(db);
      await sleep(3600_000, signal); // 1 hour
    }
  };
};
