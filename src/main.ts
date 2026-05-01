import {
  getPendingRepos,
  getStaleGoodRepos,
  getSummaryCounts,
  openDb,
} from "./services/db";
import * as logger from "./services/logger";
import { acquireRepo, type AcquisitionStats } from "./pipeline/acquisition";
import {
  discoverToCurrent,
  initDiscovery,
  runHourlyDiscoveryCheck,
} from "./pipeline/discovery";
import { runRetention } from "./pipeline/retention";
import { initRateLimitState } from "./services/github";
import { sleep } from "./utils/time";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const db = openDb();
initRateLimitState(db);

const stats: AcquisitionStats = {
  totalChecks: 0,
  cacheHits304: 0,
  hitsThisSession: 0,
  noConfigCount: 0,
};
const RETENTION_DAYS = 365;
const IDLE_SLEEP_MS = 5 * 60 * 1000;

async function printSummary() {
  const { pending, good, totalConfigs } = getSummaryCounts(db);
  const percent304 =
    stats.totalChecks > 0
      ? Math.round((stats.cacheHits304 / stats.totalChecks) * 100)
      : 0;

  logger.info(
    `Summary: checks ${stats.totalChecks} | 304 ${stats.cacheHits304}/${stats.totalChecks} (${percent304}%) | hits ${stats.hitsThisSession} | configs ${totalConfigs} | pending ${pending} | good ${good}`,
  );
}

async function main() {
  logger.info("Simple continuous collector");

  runRetention(db, RETENTION_DAYS);

  let discoveryState = await initDiscovery(db);
  discoveryState = await discoverToCurrent(db, discoveryState);
  void runHourlyDiscoveryCheck(db, discoveryState).catch((err) => {
    logger.error(
      `Discovery loop failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  let checksSinceLastSummary = 0;

  while (true) {
    runRetention(db, RETENTION_DAYS);

    const pending = getPendingRepos(db, 120);
    const staleGood = pending.length === 0 ? getStaleGoodRepos(db, 30) : [];
    const reposToCheck = pending.length > 0 ? pending : staleGood;

    if (reposToCheck.length === 0) {
      await printSummary();
      logger.info("Nothing left to do right now");
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    for (const fullName of reposToCheck) {
      await acquireRepo(db, TOKEN, fullName, stats);
      checksSinceLastSummary++;
      if (checksSinceLastSummary >= 50) {
        await printSummary();
        checksSinceLastSummary = 0;
      }
    }
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  throw err;
});
