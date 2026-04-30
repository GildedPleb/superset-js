import { getHttpCache, upsertHttpCache, type Db } from "./db";
import * as logger from "./logger";
import { sleep } from "../utils/time";
import { fetchWithRetry } from "../utils/http";

export type GithubFetchResult<T> = {
  status: number;
  data: T | null;
  was304: boolean;
  rateLimitRemaining: number | null;
  rateLimitReset: number | null;
};

const RATE_LIMIT_TARGET_UTILIZATION = 0.8;
const DEBUG_LOG_COOLDOWN_MS = 1 * 60 * 1000;

let nextScheduledAt = Date.now();
let rateLimitQueue: Promise<void> = Promise.resolve();
let lastDebugLogAt = 0;
let pacingSamples = 0;
let pacingDelayTotalMs = 0;
let lastKnownReset: number | null = null;
let lastKnownRawRemaining: number | null = null;
let reservedCalls = 0;

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function waitForTurn(): Promise<void> {
  const now = Date.now();
  const behindMs = now - nextScheduledAt;
  if (behindMs > 100) {
    logger.info(
      `---> GitHub rate limit schedule was ${Math.round(behindMs)}ms in the past`,
    );
    return;
  }
  if (behindMs >= 0) return;
  await sleep(-behindMs);
}

function updateRateLimit(res: Response, was304: boolean) {
  const rawRemaining = parseHeaderInt(res.headers.get("x-ratelimit-remaining"));
  const resetEpochSec = parseHeaderInt(res.headers.get("x-ratelimit-reset"));
  if (rawRemaining === null || resetEpochSec === null)
    return { remaining: null, reset: null };

  const now = Date.now();
  const resetMs = resetEpochSec * 1000;
  const timeLeftMs = Math.max(0, resetMs - now);

  const windowChanged =
    lastKnownReset === null || resetEpochSec !== lastKnownReset;
  const remainingIncreased =
    lastKnownRawRemaining !== null && rawRemaining > lastKnownRawRemaining;

  if (windowChanged || remainingIncreased) {
    reservedCalls = Math.round(
      rawRemaining * (1 - RATE_LIMIT_TARGET_UTILIZATION),
    );
    nextScheduledAt = now; // only place that re-anchors
    logger.info(
      `GitHub rate-limit re-anchor (reset=${resetEpochSec}, reserved=${reservedCalls})`,
    );
  }

  const budgeted = rawRemaining - reservedCalls;

  if (budgeted <= 0) {
    nextScheduledAt = Math.max(nextScheduledAt, resetMs);
  } else if (timeLeftMs > 0 && !was304) {
    const intervalMs = timeLeftMs / budgeted;
    nextScheduledAt += intervalMs; // pure additive, always from current position
    pacingSamples++;
    pacingDelayTotalMs += intervalMs;
  }

  lastKnownReset = resetEpochSec;
  lastKnownRawRemaining = rawRemaining;
  return { remaining: Math.max(0, budgeted), reset: resetEpochSec };
}

function logDebugStatus(rateLimit: {
  remaining: number | null;
  reset: number | null;
}): void {
  const now = Date.now();
  if (now - lastDebugLogAt < DEBUG_LOG_COOLDOWN_MS) return;
  const nextDelayMs = Math.max(0, nextScheduledAt - now);
  const avgDelayMs =
    pacingSamples > 0 ? Math.round(pacingDelayTotalMs / pacingSamples) : 0;
  let theoreticalIntervalMs = 0;
  if (rateLimit.remaining && rateLimit.remaining > 0 && rateLimit.reset) {
    const timeLeftMs = Math.max(0, rateLimit.reset * 1000 - now);
    theoreticalIntervalMs = Math.round(timeLeftMs / rateLimit.remaining);
  }
  const resetInSeconds = rateLimit.reset
    ? Math.max(0, Math.ceil((rateLimit.reset * 1000 - now) / 1000))
    : null;
  logger.info(
    `GitHub Throttling Status: ` +
      `Reset in ${resetInSeconds ?? "n/a"}s, ` +
      `Remaining ${rateLimit.remaining ?? "n/a"}, ` +
      `Theoretical Interval ${theoreticalIntervalMs}ms, ` +
      `Next Scheduled Interval ${Math.round(nextDelayMs)}ms, ` +
      `Avg Interval ${avgDelayMs}ms, `,
  );
  lastDebugLogAt = now;
}

export async function githubFetch<T>(
  db: Db,
  url: string,
  token: string,
  accept = "application/vnd.github.v3+json",
): Promise<GithubFetchResult<T>> {
  const task = async (): Promise<GithubFetchResult<T>> => {
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

    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers });
    } catch (err) {
      logger.warn(
        `GitHub request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        status: 0,
        data: null,
        was304: false,
        rateLimitRemaining: null,
        rateLimitReset: null,
      };
    }
    const was304 = res.status === 304;
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const rateLimit = updateRateLimit(res, was304);
    logDebugStatus(rateLimit);

    if (etag || lastModified) {
      upsertHttpCache(db, cacheKey, url, accept, etag, lastModified);
    }

    return {
      status: res.status,
      data: res.ok && !was304 ? ((await res.json()) as T) : null,
      was304,
      rateLimitRemaining: rateLimit.remaining,
      rateLimitReset: rateLimit.reset,
    };
  };

  const resultPromise = rateLimitQueue.then(task, task);
  rateLimitQueue = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}
