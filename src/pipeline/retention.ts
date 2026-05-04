import { purgeOldConfigs, purgeUnusedBlobs, type Db } from "../services/db";
import { createLogger } from "../services/logger";

const logger = createLogger("retention");

const RETENTION_DAYS = 365;

export function runRetention(db: Db) {
  const configsPurged = purgeOldConfigs(db, RETENTION_DAYS);
  const blobsPurged = purgeUnusedBlobs(db);
  if (configsPurged > 0 || blobsPurged > 0) {
    logger.info(
      `Retention: purged configs ${configsPurged}, blobs ${blobsPurged}`,
    );
  }
}

export const startRetentionStage = (db: Db) => {
  return async () => {
    logger.info("stage started");
    while (true) {
      runRetention(db);
      await Bun.sleep(3600_000); // 1 hour
    }
  };
};
