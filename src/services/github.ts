import * as logger from "./logger";

export type GithubFetchResult<T> = {
  status: number;
  etag: string | null;
  data: T | null;
  was304: boolean;
  rateLimitRemaining: number | null;
  rateLimitReset: number | null;
};

const RATE_LIMIT_TARGET_UTILIZATION = 0.8;
const RATE_LIMIT_LOG_THRESHOLD_MS = 500;
const RATE_LIMIT_LOG_COOLDOWN_MS = 5000;
const DEBUG_LOG_COOLDOWN_MS = 5 * 60 * 1000;
let nextAllowedAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();
let lastRateLimitLogAt = 0;
let lastDebugLogAt = 0;

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

  if (remaining === null || resetEpochSeconds === null) {
    return { remaining: null, reset: null };
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
    if (
      delayMs >= RATE_LIMIT_LOG_THRESHOLD_MS &&
      now - lastRateLimitLogAt >= RATE_LIMIT_LOG_COOLDOWN_MS
    ) {
      const resetInSeconds = Math.ceil(timeLeftMs / 1000);
      logger.info(
        `Rate limit pacing: sleeping ${Math.round(delayMs)}ms (remaining ${remaining}, reset in ${resetInSeconds}s)`,
      );
      lastRateLimitLogAt = now;
    }
  }

  return { remaining, reset: resetEpochSeconds };
}

function logDebugStatus(
  url: string,
  res: Response,
  rateLimit: { remaining: number | null; reset: number | null },
) {
  const now = Date.now();
  if (now - lastDebugLogAt < DEBUG_LOG_COOLDOWN_MS) return;
  const nextDelayMs = Math.max(0, nextAllowedAt - now);
  const resetInSeconds = rateLimit.reset
    ? Math.max(0, Math.ceil(rateLimit.reset - now / 1000))
    : null;
  logger.info(
    `GitHub status: ${res.status} remaining ${rateLimit.remaining ?? "n/a"} reset in ${resetInSeconds ?? "n/a"}s next delay ${Math.round(nextDelayMs)}ms url ${url}`,
  );
  lastDebugLogAt = now;
}

export async function githubFetch<T>(
  url: string,
  token: string,
): Promise<GithubFetchResult<T>> {
  const task = async () => {
    await waitForTurn();

    const headers: Record<string, string> = {
      Authorization: `token ${token}`,
      "User-Agent": "linter-config-collector",
      Accept: "application/vnd.github.v3+json",
    };

    const res = await fetch(url, { headers });
    const was304 = res.status === 304;
    const rateLimit = updateRateLimit(res);
    logDebugStatus(url, res, rateLimit);

    return {
      status: res.status,
      etag: res.headers.get("etag"),
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
