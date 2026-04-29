import { addPendingRepo, repoExists, type Db } from "../services/db";
import { fetchRecentRepoNames } from "../services/gharchive";
import * as logger from "../services/logger";

export async function discoverRepos(db: Db, hours = 4) {
  logger.info("Scanning latest GHArchive");
  const repoNames = await fetchRecentRepoNames(hours);
  let added = 0;

  for (const name of repoNames) {
    if (!repoExists(db, name)) {
      addPendingRepo(db, name, new Date().toISOString());
      added++;
    }
  }

  logger.info(`Added ${added.toLocaleString()} new pending repos`);
}
