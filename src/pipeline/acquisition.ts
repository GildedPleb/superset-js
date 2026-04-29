import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  countConfigs,
  markGone,
  markGood,
  markNoConfig,
  markStale,
  saveConfig,
  saveConfigBlob,
  type Db,
} from "../services/db";
import { githubFetch } from "../services/github";
import * as logger from "../services/logger";

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

const PUSH_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type AcquisitionStats = {
  totalChecks: number;
  cacheHits304: number;
  hitsThisSession: number;
  noConfigCount: number;
};

export async function acquireRepo(
  db: Db,
  token: string,
  fullName: string,
  stats: AcquisitionStats,
) {
  stats.totalChecks++;

  logger.rewriteLine(`checking ${fullName}`);

  const repoRes = await githubFetch<{ pushed_at?: string }>(
    `https://api.github.com/repos/${fullName}`,
    token,
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
    token,
  );

  if (rootRes.was304) {
    stats.cacheHits304++;
    logger.info(`304 ${fullName}`);
    return false;
  }

  const files = rootRes.data ?? [];
  const matching = files.filter(
    (file) => file.type === "file" && CONFIG_FILENAMES.has(file.name),
  );

  if (matching.length === 0) {
    stats.noConfigCount++;
    logger.rewriteLine(`no-config ${stats.noConfigCount} ${fullName}`);
    markNoConfig(db, fullName);
    return false;
  }

  logger.success(`Hit ${fullName} (${matching.length} configs)`);

  for (const file of matching) {
    const fileRes = await githubFetch<{ content: string; sha: string }>(
      `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(file.name)}`,
      token,
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
      stats.hitsThisSession++;
    }
  }

  markGood(db, fullName, pushedAt);
  return true;
}
