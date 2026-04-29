import {
  purgeOldConfigs,
  purgeUnusedBlobs,
  type Db,
} from "../services/db";
import * as logger from "../services/logger";

export function runRetention(db: Db, retentionDays: number) {
  const configsPurged = purgeOldConfigs(db, retentionDays);
  const blobsPurged = purgeUnusedBlobs(db);
  if (configsPurged > 0 || blobsPurged > 0) {
    logger.info(
      `Retention: purged configs ${configsPurged}, blobs ${blobsPurged}`,
    );
  }
}
