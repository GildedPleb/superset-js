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

let lastTaskUrl: string | null = null;
let lastTaskTotalMs = 0; // total "work" time of the previous task (AFTER waitForTurn)
let lastFetchMs = 0; // network + fetchWithRetry time
let lastProcessingMs = 0; // everything else after waitForTurn (cache lookup, headers, JSON parse, DB upsert, rate-limit math, etc.)
let lastPacedIntervalMs = 0; // the pacing interval that was calculated for this slot

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function waitForTurn(): Promise<void> {
  const now = Date.now();
  const behindMs = now - nextScheduledAt;
  if (behindMs > 100) {
    // const overrunMs = Math.max(0, lastTaskTotalMs - lastPacedIntervalMs);
    // if (lastTaskUrl)
    //   logger.info(
    //     `---> GitHub rate limit schedule was ${Math.round(behindMs)}ms in the past: ` +
    //       `total work time ${lastTaskTotalMs}ms, ` +
    //       `network/fetch ${lastFetchMs}ms, ` +
    //       `processing ${lastProcessingMs}ms, ` +
    //       `last paced interval ${lastPacedIntervalMs}ms, ` +
    //       `overrun ${overrunMs}ms`,
    //   );
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
    lastPacedIntervalMs = Math.round(intervalMs); // ← NEW: remember what we were aiming for
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
  // FULLY REPLACED `task` function inside githubFetch
  // (this is the only place that needed bigger changes)
  const task = async (): Promise<GithubFetchResult<T>> => {
    await waitForTurn(); // ← now contains the rich "behind" log

    const taskStart = Date.now(); // timing starts AFTER the wait (this is the "internal" part)

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

    const fetchStart = Date.now();
    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers });
    } catch (err) {
      logger.warn(
        `GitHub request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const taskEnd = Date.now();
      // still record metrics on failure
      lastTaskUrl = url;
      lastTaskTotalMs = taskEnd - taskStart;
      lastFetchMs = 0;
      lastProcessingMs = lastTaskTotalMs;
      return {
        status: 0,
        data: null,
        was304: false,
        rateLimitRemaining: null,
        rateLimitReset: null,
      };
    }

    const fetchEnd = Date.now();
    const fetchDurationMs = fetchEnd - fetchStart;

    const was304 = res.status === 304;
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");

    const rateLimit = updateRateLimit(res, was304);
    logDebugStatus(rateLimit);

    let data: T | null = null;
    if (res.ok && !was304) {
      data = (await res.json()) as T; // JSON parsing is included in processing time
    }

    if (etag || lastModified) {
      upsertHttpCache(db, cacheKey, url, accept, etag, lastModified);
    }

    const taskEnd = Date.now();
    const totalTaskMs = taskEnd - taskStart;
    const processingMs = totalTaskMs - fetchDurationMs; // everything that is NOT the network call

    // Save for the NEXT time waitForTurn logs a "behind" situation
    lastTaskUrl = url;
    lastTaskTotalMs = totalTaskMs;
    lastFetchMs = fetchDurationMs;
    lastProcessingMs = processingMs;

    return {
      status: res.status,
      data,
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
