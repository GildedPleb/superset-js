type FetchRetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxElapsedMs?: number;
  retryStatusCodes?: Set<number>;
};

const DEFAULT_TIMEOUT_MS = parseEnvInt("HTTP_TIMEOUT_MS", 15000);
const DEFAULT_MAX_RETRIES = parseEnvInt("HTTP_RETRY_MAX", 4);
const DEFAULT_BASE_DELAY_MS = parseEnvInt("HTTP_RETRY_BASE_MS", 500);
const DEFAULT_MAX_DELAY_MS = parseEnvInt("HTTP_RETRY_MAX_DELAY_MS", 10000);
const DEFAULT_MAX_ELAPSED_MS = parseEnvInt("HTTP_MAX_ELAPSED_MS", 60000);

const DEFAULT_RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function computeDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
) {
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jitter = rawDelay * (0.7 + Math.random() * 0.6);
  return Math.max(0, Math.round(jitter));
}

function isRetryableStatus(status: number, retryStatusCodes: Set<number>) {
  return retryStatusCodes.has(status);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function withTimeoutSignal(
  signal: AbortSignal | undefined | null,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  };

  return { signal: controller.signal, cleanup };
}

/** Browser-like defaults to defeat Cloudflare negative caching on GHArchive (and other CDNs) */
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: FetchRetryOptions,
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxElapsedMs = options?.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const retryStatusCodes =
    options?.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES;

  // Merge defaults (caller headers win on conflict — safe for GitHub API Authorization etc.)
  const headers = {
    ...DEFAULT_HEADERS,
    ...(init?.headers ? Object.fromEntries(new Headers(init.headers)) : {}),
  };

  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > maxElapsedMs) {
      throw lastError ?? new Error("Request timed out");
    }

    const { signal, cleanup } = withTimeoutSignal(init?.signal, timeoutMs);

    try {
      const res = await fetch(url, { ...init, headers, signal });
      cleanup();

      if (
        isRetryableStatus(res.status, retryStatusCodes) &&
        attempt < maxRetries
      ) {
        lastError = new Error(`Retryable status ${res.status}`);
        const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs);
        const remainingMs = maxElapsedMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          throw lastError;
        }
        await Bun.sleep(Math.min(delayMs, remainingMs));
        attempt++;
        continue;
      }

      return res;
    } catch (err) {
      cleanup();

      if (init?.signal?.aborted) {
        throw err;
      }

      if (isAbortError(err) || err instanceof Error) {
        lastError = err;
      } else {
        lastError = new Error("Request failed");
      }

      if (attempt >= maxRetries) {
        throw lastError;
      }

      const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs);
      const remainingMs = maxElapsedMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw lastError;
      }
      await Bun.sleep(Math.min(delayMs, remainingMs));
      attempt++;
    }
  }
}
