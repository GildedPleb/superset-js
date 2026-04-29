import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  addPendingRepo,
  countConfigs,
  getPendingRepos,
  getStaleGoodRepos,
  getSummaryCounts,
  markGone,
  markGood,
  markNoConfig,
  markStale,
  openDb,
  purgeOldConfigs,
  purgeUnusedBlobs,
  repoExists,
  saveConfig,
  saveConfigBlob,
} from "./services/db";
import { fetchRecentRepoNames } from "./services/gharchive";
import { githubFetch } from "./services/github";
import * as logger from "./services/logger";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const CONFIG_FILENAMES = new Set([
  ".oxlintrc.json",
  "oxlint.config.ts",
  "oxlint.config.js",
  "eslint.config.js",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc",
]);

const db = openDb();

let totalChecks = 0;
let cacheHits304 = 0;
let hitsThisSession = 0;
let noConfigCount = 0;
const RETENTION_DAYS = 365;
const PUSH_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DISCOVER_INTERVAL_MS = 60 * 60 * 1000;
let lastDiscoverAt = 0;

async function discover() {
  logger.info("Scanning latest GHArchive");
  const repoNames = await fetchRecentRepoNames(4);
  let added = 0;

  for (const name of repoNames) {
    if (!repoExists(db, name)) {
      addPendingRepo(db, name, new Date().toISOString());
      added++;
    }
  }

  logger.info(`Added ${added.toLocaleString()} new pending repos`);
}

async function processOne(fullName: string) {
  totalChecks++;

  logger.rewriteLine(`checking ${fullName}`);

  const repoRes = await githubFetch<{ pushed_at?: string }>(
    `https://api.github.com/repos/${fullName}`,
    TOKEN,
  );

  if (repoRes.status === 404) {
    logger.warn(`Gone ${fullName}`);
    markGone(db, fullName);
    return false;
  }

  const pushedAt = repoRes.data?.pushed_at;
  if (!pushedAt) {
    logger.warn(`Missing pushed_at ${fullName}`);
    markStale(db, fullName);
    return false;
  }

  const pushedAtMs = Date.parse(pushedAt);
  if (!Number.isFinite(pushedAtMs)) {
    logger.warn(`Bad pushed_at ${fullName}`);
    markStale(db, fullName);
    return false;
  }

  if (Date.now() - pushedAtMs > PUSH_WINDOW_MS) {
    logger.info(`Stale ${fullName}`);
    markStale(db, fullName, pushedAt);
    return false;
  }

  const rootRes = await githubFetch<Array<{ name: string; type: string }>>(
    `https://api.github.com/repos/${fullName}/contents`,
    TOKEN,
  );

  if (rootRes.was304) {
    cacheHits304++;
    logger.info(`304 ${fullName}`);
    return false;
  }

  const files = rootRes.data ?? [];
  const matching = files.filter(
    (file) => file.type === "file" && CONFIG_FILENAMES.has(file.name),
  );

  if (matching.length === 0) {
    noConfigCount++;
    logger.rewriteLine(`no-config ${noConfigCount} ${fullName}`);
    markNoConfig(db, fullName);
    return false;
  }

  logger.success(`Hit ${fullName} (${matching.length} configs)`);

  for (const file of matching) {
    const fileRes = await githubFetch<{ content: string; sha: string }>(
      `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(file.name)}`,
      TOKEN,
    );
    if (fileRes.status === 200 && fileRes.data) {
      const content = Buffer.from(fileRes.data.content, "base64").toString(
        "utf-8",
      );
      const contentHash = createHash("sha256").update(content).digest("hex");
      const contentBuffer = Buffer.from(content, "utf-8");
      const contentBlob = gzipSync(contentBuffer);
      saveConfigBlob(db, contentHash, contentBlob, contentBuffer.byteLength);
      saveConfig(
        db,
        fullName,
        file.name,
        contentHash,
        fileRes.data.sha,
        fileRes.etag,
        new Date().toISOString(),
      );

      const total = countConfigs(db);
      logger.success(`Saved ${file.name} (config #${total})`);
      hitsThisSession++;
    }
  }

  markGood(db, fullName, pushedAt);
  return true;
}

function runRetention() {
  const configsPurged = purgeOldConfigs(db, RETENTION_DAYS);
  const blobsPurged = purgeUnusedBlobs(db);
  if (configsPurged > 0 || blobsPurged > 0) {
    logger.info(
      `Retention: purged configs ${configsPurged}, blobs ${blobsPurged}`,
    );
  }
}

async function printSummary() {
  const { pending, good, totalConfigs } = getSummaryCounts(db);
  const percent304 =
    totalChecks > 0 ? Math.round((cacheHits304 / totalChecks) * 100) : 0;

  logger.info(
    `Summary: checks ${totalChecks} | 304 ${cacheHits304}/${totalChecks} (${percent304}%) | hits ${hitsThisSession} | configs ${totalConfigs} | pending ${pending} | good ${good}`,
  );
}

async function main() {
  logger.info("Simple continuous collector");

  runRetention();

  const startTime = Date.now();
  let checksSinceLastSummary = 0;

  while (true) {
    const now = Date.now();
    if (now - lastDiscoverAt >= DISCOVER_INTERVAL_MS) {
      await discover();
      lastDiscoverAt = now;
    }
    runRetention();

    const pending = getPendingRepos(db, 120);

    if (pending.length === 0) {
      const staleGood = getStaleGoodRepos(db, 30);

      if (staleGood.length === 0) {
        await printSummary();
        logger.info("Nothing left to do right now");
        break;
      }

      for (const fullName of staleGood) {
        await processOne(fullName);
        checksSinceLastSummary++;
        if (checksSinceLastSummary >= 50) {
          await printSummary();
          checksSinceLastSummary = 0;
        }
      }
    } else {
      for (const fullName of pending) {
        await processOne(fullName);
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
    hitsThisSession,
    durationMinutes: Math.round((Date.now() - startTime) / 60000),
  };
  writeFileSync("last-run-summary.json", JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  throw err;
});
