import { writeFileSync } from "node:fs";
import {
  countConfigs,
  getPendingRepos,
  getStaleGoodRepos,
  getSummaryCounts,
  openDb,
} from "./services/db";
import * as logger from "./services/logger";
import { acquireRepo, type AcquisitionStats } from "./pipeline/acquisition";
import { discoverRepos } from "./pipeline/discovery";
import { runRetention } from "./pipeline/retention";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const db = openDb();

const stats: AcquisitionStats = {
  totalChecks: 0,
  cacheHits304: 0,
  hitsThisSession: 0,
  noConfigCount: 0,
};
const RETENTION_DAYS = 365;
const DISCOVER_INTERVAL_MS = 60 * 60 * 1000;
let lastDiscoverAt = 0;

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

  const startTime = Date.now();
  let checksSinceLastSummary = 0;

  while (true) {
    const now = Date.now();
    if (now - lastDiscoverAt >= DISCOVER_INTERVAL_MS) {
      await discoverRepos(db, 4);
      lastDiscoverAt = now;
    }
    runRetention(db, RETENTION_DAYS);

    const pending = getPendingRepos(db, 120);

    if (pending.length === 0) {
      const staleGood = getStaleGoodRepos(db, 30);

      if (staleGood.length === 0) {
        await printSummary();
        logger.info("Nothing left to do right now");
        break;
      }

      for (const fullName of staleGood) {
        await acquireRepo(db, TOKEN, fullName, stats);
        checksSinceLastSummary++;
        if (checksSinceLastSummary >= 50) {
          await printSummary();
          checksSinceLastSummary = 0;
        }
      }
    } else {
      for (const fullName of pending) {
        await acquireRepo(db, TOKEN, fullName, stats);
        checksSinceLastSummary++;
        if (checksSinceLastSummary >= 50) {
          await printSummary();
          checksSinceLastSummary = 0;
        }
      }
    }
  }

  const summary = {
    runAt: new Date().toISOString(),
    totalConfigs: countConfigs(db),
    hitsThisSession: stats.hitsThisSession,
    durationMinutes: Math.round((Date.now() - startTime) / 60000),
  };
  writeFileSync("last-run-summary.json", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  throw err;
});
