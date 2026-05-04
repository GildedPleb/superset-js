import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  countConfigs,
  getConfigFilenamesForRepo,
  getPendingRepos,
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
};

const logger = createLogger("acquisition");

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
  // logger.rewriteLine(`checking ${fullName}`);

  const repoRes = await fetchWithStats<{ pushed_at?: string }>(
    db,
    token,
    `https://api.github.com/repos/${fullName}`,
  );

  if (isTransientStatus(repoRes.status)) {
    logger.warn(`Transient GitHub error ${repoRes.status} for ${fullName}`);
    return false;
  }

  if (repoRes.status === 404) {
    // logger.warn(`Gone ${fullName}`);
    markGone(db, fullName);
    return false;
  }

  let pushedAt = repoRes.data?.pushed_at;
  if (!pushedAt && repoRes.was304) {
    pushedAt = getRepoLastPushed(db, fullName) ?? undefined;
    if (!pushedAt) {
      logger.warn(`304 repo metadata but no cached pushed_at ${fullName}`);
      markStale(db, fullName);
      return false;
    }
  }
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

  const rootRes = await fetchWithStats<Array<{ name: string; type: string }>>(
    db,
    token,
    `https://api.github.com/repos/${fullName}/contents`,
  );

  if (isTransientStatus(rootRes.status)) {
    logger.warn(`Transient GitHub error ${rootRes.status} for ${fullName}`);
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
    matching = cachedFilenames.map((name) => ({ name }));
  } else {
    const files = rootRes.data ?? [];
    matching = files.filter(
      (file) => file.type === "file" && CONFIG_FILENAMES.has(file.name),
    );
  }

  if (matching.length === 0) {
    stats.noConfigCount++;
    // logger.rewriteLine(`no-config ${stats.noConfigCount} ${fullName}`);
    markNoConfig(db, fullName);
    return false;
  }

  // logger.success(`Hit ${fullName} (${matching.length} configs)`);

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

      const total = countConfigs(db);
      logger.success(`Saved ${fullName}: ${file.name} (config #${total})`);
      stats.hitsThisSession++;
    }
  }

  markGood(db, fullName, pushedAt);
  return true;
}

export const startAcquisitionStage = (db: Db, token: string) => {
  return async () => {
    logger.info("stage started");
    while (true) {
      const pending = getPendingRepos(db, 120);
      const stale = pending.length === 0 ? getStaleRepos(db, 30) : [];
      const toProcess = pending.length > 0 ? pending : stale;

      if (toProcess.length === 0) {
        logger.info("idle");
        await Bun.sleep(IDLE_SLEEP_MS);
        continue;
      }

      for (const fullName of toProcess) {
        await acquireRepo(db, token, fullName);
      }

      const {
        pending: pendingCount,
        good,
        totalConfigs,
      } = getSummaryCounts(db);
      const percent304 =
        stats.totalChecks > 0
          ? Math.round((stats.cacheHits304 / stats.totalChecks) * 100)
          : 0;

      logger.info(
        `checks ${stats.totalChecks} (${((stats.totalChecks / (pendingCount || 1)) * 100).toFixed(2)}%) ` +
          `| 304 ${stats.cacheHits304}/${stats.totalChecks} (${percent304}%) ` +
          `| hits ${stats.hitsThisSession} | configs ${totalConfigs} | pending ${pendingCount} | good ${good}`,
      );
    }
  };
};
