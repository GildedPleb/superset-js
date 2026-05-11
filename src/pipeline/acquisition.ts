import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  clearHttpCacheEntry,
  countConfigs,
  getConfigFilenamesForRepo,
  getEligibleRepos,
  getRepoLastPushed,
  getStaleRepos,
  getSummaryCounts,
  markGone,
  markGood,
  markNoConfig,
  markStale,
  saveConfig,
  saveConfigBlob,
  type Db,
} from "../services/db";
import { githubFetch, type GithubFetchResult } from "../services/github";
import { createLogger } from "../services/logger";

const stats = {
  totalChecks: 0,
  cacheHits304: 0,
  hitsThisSession: 0,
  noConfigCount: 0,
  totalRepos: 0,
  maxEligible: 0,
};

/**
 * Returns a compact human-readable estimate of remaining processing time
 * in "XdYh" format (lowercase, days + hours only).
 * Examples: "10d4h", "3d", "7h"
 * Returns 'Done' if nothing pending, or 'Calculating...' if rate unknown.
 */
function getEstimatedTimeRemaining(
  processedLastHour: number,
  pendingCount: number,
): string {
  if (pendingCount <= 0) {
    return "Done";
  }

  if (processedLastHour <= 0) {
    return "Calculating...";
  }

  const hoursRemaining = pendingCount / processedLastHour;
  const days = Math.floor(hoursRemaining / 24);
  const hours = Math.floor(hoursRemaining % 24);

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  } else {
    return `${hours}h`;
  }
}

// Add these near the top of the file (after the existing `stats` declaration and before any functions)
const ONE_HOUR_MS = 60 * 60 * 1000;

const logger = createLogger("acquisition");

const LINT_CONFIG_FILENAMES = new Set([
  "oxlintrc.json",
  ".oxlintrc.json",
  "oxlint.config.ts",
  "oxlint.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc",
]);

const PACKAGE_JSON_LINT_KEYS = new Set([
  "eslintConfig",
  "eslint",
  "prettier",
  "oxlint",
  // Add more keys here in the future if needed (e.g. "stylelint", "lint-staged", etc.)
]);

function packageJsonHasLintConfig(content: string): boolean {
  try {
    const pkg = JSON.parse(content);
    for (const key of PACKAGE_JSON_LINT_KEYS) {
      if (pkg[key] !== undefined) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // invalid JSON → treat as no lint config
  }
}

function getTargetConfigFiles(
  files: Array<{ name: string; type: string }>,
): Array<{ name: string }> {
  const rootFiles = files.filter((f) => f.type === "file");

  const lintFiles = rootFiles.filter((f) => LINT_CONFIG_FILENAMES.has(f.name));
  const hasLintConfigFile = lintFiles.length > 0;

  const targets: Array<{ name: string }> = [...lintFiles];

  // Always collect package.json (we'll decide later whether to keep it)
  const packageJson = rootFiles.find((f) => f.name === "package.json");
  if (packageJson) {
    targets.push(packageJson);
  }

  // tsconfig*.json only if we have at least one traditional lint config file
  if (hasLintConfigFile) {
    const tsconfigs = rootFiles.filter((f) =>
      /^tsconfig.*\.json$/.test(f.name),
    );
    targets.push(...tsconfigs);
  }

  return targets;
}

const IDLE_SLEEP_MS = 5 * 60 * 1000;
const PUSH_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const TRANSIENT_STATUS_CODES = new Set([0, 408, 425, 429]);

function isTransientStatus(status: number): boolean {
  if (status >= 500) return true;
  return TRANSIENT_STATUS_CODES.has(status);
}

async function fetchWithStats<T>(
  db: Db,
  token: string,
  url: string,
): Promise<GithubFetchResult<T>> {
  const result = await githubFetch<T>(db, url, token);
  stats.totalChecks++;
  if (result.was304) stats.cacheHits304++;
  return result;
}

export async function acquireRepo(db: Db, token: string, fullName: string) {
  // Pre-flight stale gate (zero-request). The discovery stage writes
  // `repos.last_pushed` from GHArchive PushEvent timestamps, which is
  // authoritative for our purposes. Trusting the DB here lets us skip a
  // dedicated /repos/{full_name} round-trip and consult /contents directly.
  const pushedAt = getRepoLastPushed(db, fullName);
  if (!pushedAt) {
    logger.warn(`No cached last_pushed for ${fullName}`);
    markStale(db, fullName);
    return false;
  }

  const pushedAtMs = Date.parse(pushedAt);
  if (!Number.isFinite(pushedAtMs)) {
    logger.warn(`Bad last_pushed for ${fullName}: ${pushedAt}`);
    markStale(db, fullName);
    return false;
  }

  if (Date.now() - pushedAtMs > PUSH_WINDOW_MS) {
    logger.info(`Stale ${fullName}`);
    markStale(db, fullName, pushedAt);
    return false;
  }

  const rootRes = await fetchWithStats<Array<{ name: string; type: string }>>(
    db,
    token,
    `https://api.github.com/repos/${fullName}/contents`,
  );

  if (isTransientStatus(rootRes.status)) {
    logger.warn(`Transient GitHub error ${rootRes.status} for ${fullName}`);
    return false;
  }

  // 404 on /contents covers the previously-distinct "repo gone" case from
  // the deleted /repos/{full_name} request. Empty repos with no default
  // branch (vanishingly rare) would also land here; treating them as gone
  // is harmless.
  if (rootRes.status === 404) {
    markGone(db, fullName);
    return false;
  }

  let matching: Array<{ name: string }> = [];
  if (rootRes.was304) {
    const cachedFilenames = getConfigFilenamesForRepo(db, fullName);
    if (cachedFilenames.length === 0) {
      logger.warn(`304 root but no cached configs ${fullName}`);
      markStale(db, fullName, pushedAt);
      return false;
    }
    // If the cache was populated under the *old* acquisition contract
    // (lint configs only), it may be missing package.json even though the
    // repo has one. Detect that gap and clear the /contents cache entry
    // so the next sweep fetches fresh and the new contract's
    // getTargetConfigFiles can include package.json. Single-row PK delete.
    const hasLintConfig = cachedFilenames.some((n) =>
      LINT_CONFIG_FILENAMES.has(n),
    );
    const hasPackageJson = cachedFilenames.includes("package.json");
    if (hasLintConfig && !hasPackageJson) {
      // Cache key shape mirrors github.ts: `${url}|${accept}`. Default
      // accept is `application/vnd.github.v3+json` (see githubFetch).
      const contentsUrl = `https://api.github.com/repos/${fullName}/contents`;
      const cacheKey = `${contentsUrl}|application/vnd.github.v3+json`;
      clearHttpCacheEntry(db, cacheKey);
      logger.info(
        `304 with no cached package.json for ${fullName} — cleared /contents cache, will re-fetch on next sweep`,
      );
      markStale(db, fullName, pushedAt);
      return false;
    }
    matching = cachedFilenames.map((name) => ({ name }));
  } else {
    const files = rootRes.data ?? [];
    matching = getTargetConfigFiles(files);
  }

  if (matching.length === 0) {
    stats.noConfigCount++;
    markNoConfig(db, fullName);
    return false;
  }

  let savedCount = 0;

  for (const file of matching) {
    const fileRes = await fetchWithStats<{ content: string; sha: string }>(
      db,
      token,
      `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(file.name)}`,
    );
    if (isTransientStatus(fileRes.status)) {
      logger.warn(
        `Transient GitHub error ${fileRes.status} for ${fullName}/${file.name}`,
      );
      return false;
    }
    if (fileRes.status === 200 && fileRes.data) {
      const content = Buffer.from(fileRes.data.content, "base64").toString(
        "utf-8",
      );

      // Special handling for package.json – eject if it doesn't contain any lint config keys
      // AND we have no traditional lint config files in the repo
      if (file.name === "package.json") {
        const hasLintConfigFile = matching.some(
          (f) => f.name !== "package.json" && LINT_CONFIG_FILENAMES.has(f.name),
        );
        const hasRelevantKeys = packageJsonHasLintConfig(content);

        if (!hasLintConfigFile && !hasRelevantKeys) {
          continue; // eject – do not save this package.json
        }
      }

      // Save the file (lint configs, tsconfigs, or qualified package.json)
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
        pushedAt,
      );

      stats.hitsThisSession++;
      savedCount++;
    }
  }

  if (savedCount === 0) {
    // We only had a package.json and it got ejected → treat as no-config
    stats.noConfigCount++;
    markNoConfig(db, fullName);
    return false;
  }

  const total = countConfigs(db);
  logger.success(
    `Complete ${fullName} (${savedCount} configs), total configs ${total}`,
  );
  markGood(db, fullName, pushedAt);
  return true;
}

export const startAcquisitionStage = (db: Db, token: string) => {
  // Inside `startAcquisitionStage`, right before the `return async () => {` (or inside the returned function, before `while (true)`)
  let repoProcessTimes: number[] = [];
  return async () => {
    logger.info("stage started");
    while (true) {
      // Engagement-gate paradigm: acquisition only consumes 'eligible' repos
      // (push + engagement-confirmed within 30 days). Plain 'pending' rows
      // sit dormant until they earn an engagement signal in discovery.
      const eligible = getEligibleRepos(db, 100);
      const stale = eligible.length === 0 ? getStaleRepos(db, 30) : [];
      const toProcess = eligible.length > 0 ? eligible : stale;

      if (toProcess.length === 0) {
        logger.info("idle");
        stats.maxEligible = 0;
        await Bun.sleep(IDLE_SLEEP_MS);
        continue;
      }

      for (const fullName of toProcess) {
        await acquireRepo(db, token, fullName);
        repoProcessTimes.push(Date.now());
        stats.totalRepos++;
      }

      const {
        pending: pendingCount,
        eligible: eligibleCount,
        good,
        totalConfigs,
      } = getSummaryCounts(db);
      const percent304 =
        stats.totalChecks > 0
          ? Math.round((stats.cacheHits304 / stats.totalChecks) * 100)
          : 0;

      stats.maxEligible =
        eligibleCount > stats.maxEligible ? eligibleCount : stats.maxEligible;

      const cutoff = Date.now() - ONE_HOUR_MS;
      repoProcessTimes = repoProcessTimes.filter((time) => time >= cutoff);
      const processedLastHour = repoProcessTimes.length;

      // ETA is based on 'eligible' (the actual acquisition queue), not 'pending'
      // which under the engagement-gate paradigm is the dormant superset.
      logger.info(
        `pending ${pendingCount} ` +
          `| eligible ${eligibleCount}/${stats.maxEligible} ` +
          `| repos ${stats.totalRepos} ` +
          `| checks ${stats.totalChecks} ` +
          `| 304s ${stats.cacheHits304} (${percent304}%) ` +
          `| hits ${stats.hitsThisSession} ` +
          `| configs ${totalConfigs} ` +
          `| total good ${good} ` +
          `| repos/h ${processedLastHour} ` +
          `| finish in ${getEstimatedTimeRemaining(processedLastHour, eligibleCount)} (${(((stats.maxEligible - eligibleCount) / (stats.maxEligible || 1)) * 100).toFixed(2)}%)`,
      );
    }
  };
};
