import { purgeExpiredRepos, purgeUnusedBlobs, type Db } from "../services/db";
import { createLogger } from "../services/logger";
import { sleep } from "../utils/time";

const logger = createLogger("retention");

export function runRetention(db: Db) {
  const result = purgeExpiredRepos(db);
  const total = result.reposPurged + result.configsPurged + result.normalizedPurged + result.blobsPurged;

  if (total > 0) {
    logger.info(
      `Retention: purged ${result.reposPurged} repos, ${result.configsPurged} configs, ${result.normalizedPurged} normalized_configs, ${result.blobsPurged} blobs`
    );
  }
}

export const startRetentionStage = (db: Db, signal: AbortSignal) => {
  return async () => {
    logger.info("stage started");

    // 30 minute offset so retention runs after discovery
    await sleep(30 * 60 * 1000, signal);

    while (true) {
      signal.throwIfAborted();
      runRetention(db);
      await sleep(3600_000, signal); // 1 hour
    }
  };
};