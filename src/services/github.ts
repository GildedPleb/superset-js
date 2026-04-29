import { getHttpCache, upsertHttpCache, type Db } from "./db";
import * as logger from "./logger";

export type GithubFetchResult<T> = {
  status: number;
  data: T | null;
  was304: boolean;
  rateLimitRemaining: number | null;
  rateLimitReset: number | null;
  rateLimitLimit: number | null;
};

const RATE_LIMIT_TARGET_UTILIZATION = 0.8;
const DEBUG_LOG_COOLDOWN_MS = 5 * 60 * 1000;
let nextAllowedAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();
let lastDebugLogAt = 0;
let pacingSamples = 0;
let pacingDelayTotalMs = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHeaderInt(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function waitForTurn() {
  const now = Date.now();
  if (nextAllowedAt <= now) return;
  await sleep(nextAllowedAt - now);
}

function updateRateLimit(res: Response) {
  const remaining = parseHeaderInt(res.headers.get("x-ratelimit-remaining"));
  const resetEpochSeconds = parseHeaderInt(
    res.headers.get("x-ratelimit-reset"),
  );
  const limit = parseHeaderInt(res.headers.get("x-ratelimit-limit"));

  if (remaining === null || resetEpochSeconds === null) {
    return { remaining: null, reset: null, limit: limit ?? null };
  }

  const resetMs = resetEpochSeconds * 1000;
  const now = Date.now();
  const timeLeftMs = Math.max(0, resetMs - now);

  let delayMs = 0;
  if (remaining <= 0) {
    delayMs = timeLeftMs;
  } else if (timeLeftMs > 0) {
    const intervalMs = timeLeftMs / remaining;
    delayMs = intervalMs / RATE_LIMIT_TARGET_UTILIZATION;
  }

  if (delayMs > 0) {
    nextAllowedAt = Math.max(nextAllowedAt, now + delayMs);
    pacingSamples++;
    pacingDelayTotalMs += delayMs;
  }

  return { remaining, reset: resetEpochSeconds, limit: limit ?? null };
}

function logDebugStatus(
  res: Response,
  rateLimit: {
    remaining: number | null;
    reset: number | null;
    limit: number | null;
  },
) {
  const now = Date.now();
  if (now - lastDebugLogAt < DEBUG_LOG_COOLDOWN_MS) return;
  const nextDelayMs = Math.max(0, nextAllowedAt - now);
  const avgDelayMs =
    pacingSamples > 0 ? Math.round(pacingDelayTotalMs / pacingSamples) : 0;
  const resetInSeconds = rateLimit.reset
    ? Math.max(0, Math.ceil(rateLimit.reset - now / 1000))
    : null;
  const resetAt = rateLimit.reset
    ? new Date(rateLimit.reset * 1000).toISOString()
    : null;
  logger.info(
    `GitHub status: status ${res.status}, limit ${rateLimit.limit ?? "n/a"}, remaining ${rateLimit.remaining ?? "n/a"}, reset in ${resetInSeconds ?? "n/a"}s, reset at ${resetAt ?? "n/a"}, avg delay ${avgDelayMs}ms, next delay ${Math.round(nextDelayMs)}ms`,
  );
  lastDebugLogAt = now;
}

export async function githubFetch<T>(
  db: Db,
  url: string,
  token: string,
  accept = "application/vnd.github.v3+json",
): Promise<GithubFetchResult<T>> {
  const task = async () => {
    await waitForTurn();

    const cacheKey = `${url}|${accept}`;
    const cacheEntry = getHttpCache(db, cacheKey);

    const headers: Record<string, string> = {
      Authorization: `token ${token}`,
      "User-Agent": "linter-config-collector",
      Accept: accept,
    };

    if (cacheEntry?.etag) {
      headers["If-None-Match"] = cacheEntry.etag;
    }
    if (cacheEntry?.lastModified) {
      headers["If-Modified-Since"] = cacheEntry.lastModified;
    }

    const res = await fetch(url, { headers });
    const was304 = res.status === 304;
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const rateLimit = updateRateLimit(res);
    logDebugStatus(res, rateLimit);

    if (etag || lastModified) {
      upsertHttpCache(db, cacheKey, url, accept, etag, lastModified);
    }

    return {
      status: res.status,
      data: res.ok && !was304 ? ((await res.json()) as T) : null,
      was304,
      rateLimitRemaining: rateLimit.remaining,
      rateLimitReset: rateLimit.reset,
      rateLimitLimit: rateLimit.limit,
    };
  };

  const resultPromise = rateLimitQueue.then(task, task);
  rateLimitQueue = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}
