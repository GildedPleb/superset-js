import { Database } from "bun:sqlite";

export type Db = Database;

// === RETENTION POLICY CONSTANTS (single source of truth) ===
/** How long pending repos are allowed to stay before ejection */
export const PENDING_RETENTION_DAYS = 30;
/** How long eligible/good/no-config/gone (and any promoted) repos live */
export const ELIGIBLE_RETENTION_DAYS = 365;

export type PendingRepo = {
  fullName: string;
  pushedAt: string;
};

export function openDb(path = "linter-configs.db"): Db {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  // synchronous=NORMAL is safe under WAL: durability is guaranteed at
  // checkpoint boundaries, and worst-case power-loss only loses the
  // last few transactions (never corrupts). Our workload is replayable
  // from GHArchive and idempotent, so this trade is correct. Empirically
  // takes per-hour flush from ~6s to ~1-2s.
  db.run("PRAGMA synchronous = NORMAL;");
  initSchema(db);
  return db;
}

function initSchema(db: Db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS repos (
      full_name      TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      last_checked   TEXT,
      last_pushed    TEXT
    );

    CREATE TABLE IF NOT EXISTS configs (
      full_name   TEXT NOT NULL,
      filename    TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      sha         TEXT NOT NULL,
      pushed_at   TEXT NOT NULL,
      PRIMARY KEY (full_name, filename)
    );

    CREATE TABLE IF NOT EXISTS http_cache (
      cache_key     TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      accept        TEXT NOT NULL,
      etag          TEXT,
      last_modified TEXT,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_blobs (
      hash          TEXT PRIMARY KEY,
      content_blob  BLOB NOT NULL,
      content_bytes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS normalized_configs (
      full_name       TEXT NOT NULL,
      filename        TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      normalized_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (full_name, filename, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_normalized_fullname ON normalized_configs (full_name);
    CREATE INDEX IF NOT EXISTS idx_normalized_hash    ON normalized_configs (content_hash);

    CREATE INDEX IF NOT EXISTS idx_repos_status        ON repos (status);
    CREATE INDEX IF NOT EXISTS idx_repos_status_pushed ON repos (status, last_pushed);
    CREATE INDEX IF NOT EXISTS idx_repos_last_checked  ON repos (last_checked);
    CREATE INDEX IF NOT EXISTS idx_configs_pushed_at   ON configs (pushed_at);
    CREATE INDEX IF NOT EXISTS idx_configs_content_hash ON configs (content_hash);
  `);
}

export function addPendingRepo(db: Db, fullName: string, pushedAt: string) {
  db.query(
    "INSERT INTO repos (full_name, status, last_pushed) VALUES (?, 'pending', ?)",
  ).run(fullName, pushedAt);
}

// Push handler under the engagement-gate paradigm.
// On a PushEvent we either:
//   - insert a brand-new repo as 'pending' with last_pushed=eventTime, or
//   - update only last_pushed if the new timestamp is strictly greater
//     than the existing value (status untouched).
// The WHERE clause in the ON CONFLICT branch suppresses no-op writes
// against the existing 3M-row table — SQLite will not dirty the page
// when the value isn't actually changing.
export function recordPushes(db: Db, repos: PendingRepo[]): number {
  if (repos.length === 0) return 0;

  // Prepared statement, one row at a time, inside a single transaction.
  // Multi-VALUES with ON CONFLICT DO UPDATE locks the writer too long
  // and blows query parsing when batch sizes grow.
  const stmt = db.query(
    `INSERT INTO repos (full_name, status, last_pushed) VALUES (?, 'pending', ?)
     ON CONFLICT(full_name) DO UPDATE SET
       last_pushed = excluded.last_pushed
     WHERE excluded.last_pushed > repos.last_pushed`,
  );

  let changes = 0;
  for (const repo of repos) {
    const r = stmt.run(repo.fullName, repo.pushedAt);
    changes += r.changes;
  }
  return changes;
}

// Backwards-compat alias retained briefly so callers that haven't migrated
// keep working. New callers should use recordPushes directly.
export const addPendingRepos = recordPushes;

// Compute the 30-day cutoff timestamp in JS (avoids per-row datetime()
// computation in SQLite, which measured ~130ms/1k vs ~10ms/1k for plain
// string comparison on PK index).
function thirtyDaysBefore(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new Error(`Bad ISO timestamp: ${iso}`);
  }
  return new Date(t - 30 * 24 * 60 * 60 * 1000).toISOString();
}

// Engagement handler. The single-statement gate that promotes a repo from
// 'pending' to 'eligible' when an engagement event arrives within 30 days
// of the most recent push. All four discard cases (no row, stale push,
// non-pending status, already-eligible) are absorbed by the WHERE clause —
// the UPDATE just affects 0 rows in those cases.
export function promoteToEligible(
  db: Db,
  fullName: string,
  eventCreatedAt: string,
): boolean {
  const cutoff = thirtyDaysBefore(eventCreatedAt);
  const result = db
    .query(
      `UPDATE repos
          SET status = 'eligible'
        WHERE full_name = ?
          AND status    = 'pending'
          AND last_pushed >= ?`,
    )
    .run(fullName, cutoff);
  return result.changes > 0;
}

// Batched engagement promotion. Same semantics as promoteToEligible but
// processes a list in a single query per row inside an outer transaction,
// for the per-hour ingestion path.
export function promoteManyToEligible(
  db: Db,
  events: { fullName: string; createdAt: string }[],
): number {
  if (events.length === 0) return 0;
  const stmt = db.query(
    `UPDATE repos
        SET status = 'eligible'
      WHERE full_name = ?
        AND status    = 'pending'
        AND last_pushed >= ?`,
  );
  let promoted = 0;
  for (const ev of events) {
    const cutoff = thirtyDaysBefore(ev.createdAt);
    const r = stmt.run(ev.fullName, cutoff);
    if (r.changes > 0) promoted++;
  }
  return promoted;
}

function upsertRepoStatus(
  db: Db,
  fullName: string,
  status: "pending" | "eligible" | "good" | "no-config" | "gone",
  pushedAt?: string,
) {
  if (pushedAt) {
    db.query(
      "INSERT OR REPLACE INTO repos (full_name, status, last_checked, last_pushed) VALUES (?, ?, CURRENT_TIMESTAMP, ?)",
    ).run(fullName, status, pushedAt);
    return;
  }

  db.query(
    "INSERT OR REPLACE INTO repos (full_name, status, last_checked) VALUES (?, ?, CURRENT_TIMESTAMP)",
  ).run(fullName, status);
}

export function markGone(db: Db, fullName: string) {
  upsertRepoStatus(db, fullName, "gone");
}

export function markNoConfig(db: Db, fullName: string) {
  upsertRepoStatus(db, fullName, "no-config");
}

export function markStale(db: Db, fullName: string, pushedAt?: string) {
  // Stale is now derived from good repos with old last_checked.
  // We mark them pending so they get re-acquired.
  upsertRepoStatus(db, fullName, "pending", pushedAt);
}

export function markGood(db: Db, fullName: string, pushedAt: string) {
  upsertRepoStatus(db, fullName, "good", pushedAt);
}

export function saveConfig(
  db: Db,
  fullName: string,
  filename: string,
  contentHash: string,
  sha: string,
  pushedAt: string,
) {
  db.query(
    `
      INSERT INTO configs (full_name, filename, content_hash, sha, pushed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(full_name, filename) DO UPDATE SET
        content_hash = excluded.content_hash,
        sha = excluded.sha,
        pushed_at = MAX(excluded.pushed_at, pushed_at)
    `,
  ).run(fullName, filename, contentHash, sha, pushedAt);
}

export function getHttpCache(
  db: Db,
  cacheKey: string,
): { etag: string | null; lastModified: string | null } | null {
  const row = db
    .query("SELECT etag, last_modified FROM http_cache WHERE cache_key = ?")
    .get(cacheKey) as {
    etag: string | null;
    last_modified: string | null;
  } | null;

  if (!row) return null;
  return { etag: row.etag, lastModified: row.last_modified };
}

export function upsertHttpCache(
  db: Db,
  cacheKey: string,
  url: string,
  accept: string,
  etag: string | null,
  lastModified: string | null,
) {
  db.query(
    `
      INSERT INTO http_cache (cache_key, url, accept, etag, last_modified, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(cache_key) DO UPDATE SET
        url = excluded.url,
        accept = excluded.accept,
        etag = COALESCE(excluded.etag, http_cache.etag),
        last_modified = COALESCE(excluded.last_modified, http_cache.last_modified),
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(cacheKey, url, accept, etag, lastModified);
}

export function saveConfigBlob(
  db: Db,
  hash: string,
  contentBlob: Uint8Array,
  contentBytes: number,
) {
  db.query(
    `
      INSERT OR IGNORE INTO config_blobs (hash, content_blob, content_bytes)
      VALUES (?, ?, ?)
    `,
  ).run(hash, contentBlob, contentBytes);
}

export function getState(db: Db, key: string): string | null {
  const row = db
    .query("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setState(db: Db, key: string, value: string) {
  db.query(
    `
      INSERT INTO app_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value
    `,
  ).run(key, value);
}

export function countConfigs(db: Db): number {
  const row = db.query("SELECT COUNT(*) as c FROM configs").get() as {
    c: number;
  };
  return row.c;
}

// Returns repos ready for acquisition. Under the engagement-gate paradigm,
// only 'eligible' repos (push + engagement-confirmed within 30 days) qualify.
// Plain 'pending' repos sit dormant until they earn an engagement signal.
export function getEligibleRepos(db: Db, limit: number): string[] {
  const rows = db
    .query("SELECT full_name FROM repos WHERE status = 'eligible' LIMIT ?")
    .all(limit) as { full_name: string }[];
  return rows.map((row) => row.full_name);
}

export function getStaleRepos(db: Db, limit: number): string[] {
  const rows = db
    .query(
      "SELECT full_name FROM repos WHERE status = 'good' AND (last_checked IS NULL OR last_checked < datetime('now', '-30 days')) LIMIT ?",
    )
    .all(limit) as { full_name: string }[];
  return rows.map((row) => row.full_name);
}

export function getSummaryCounts(db: Db) {
  const pending = db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'pending'")
    .get() as { c: number };
  const eligible = db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'eligible'")
    .get() as { c: number };
  const good = db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'good'")
    .get() as { c: number };
  const totalConfigs = db.query("SELECT COUNT(*) as c FROM configs").get() as {
    c: number;
  };

  return {
    pending: pending.c,
    eligible: eligible.c,
    good: good.c,
    totalConfigs: totalConfigs.c,
  };
}

export function getAllRepoNames(db: Db): string[] {
  const rows = db.query("SELECT full_name FROM repos").all() as {
    full_name: string;
  }[];
  return rows.map((row) => row.full_name);
}

export function getRepoLastPushed(db: Db, fullName: string): string | null {
  const row = db
    .query("SELECT last_pushed FROM repos WHERE full_name = ?")
    .get(fullName) as { last_pushed: string | null } | null;
  return row?.last_pushed ?? null;
}

export function getConfigFilenamesForRepo(db: Db, fullName: string): string[] {
  const rows = db
    .query("SELECT filename FROM configs WHERE full_name = ?")
    .all(fullName) as { filename: string }[];
  return rows.map((row) => row.filename);
}

export function purgeOldConfigs(db: Db, days: number): number {
  const result = db
    .query("DELETE FROM configs WHERE pushed_at < datetime('now', ?)")
    .run(`-${days} days`);
  return result.changes;
}

export function purgeUnusedBlobs(db: Db): number {
  const result = db
    .query(
      "DELETE FROM config_blobs WHERE hash NOT IN (SELECT DISTINCT content_hash FROM configs)",
    )
    .run();
  return result.changes;
}

/**
 * Optimized core retention policy (per spec + performance improvements):
 * - Pending repos: eject if last_pushed IS NULL or older than PENDING_RETENTION_DAYS
 * - Eligible/good/no-config/gone/etc.: eject if older than ELIGIBLE_RETENTION_DAYS
 * - Non-conforming data auto-purged
 * - Stale set is computed **once** using the new composite index (status, last_pushed)
 * - All deletes use fast PRIMARY KEY lookups via a temporary table
 * - Fully atomic in one transaction; only repo-related tables touched
 * - Uses db.run() for raw DDL to match current Bun SQLite idioms and project style
 */
export function purgeStaleRepos(db: Db): {
  purgedRepos: number;
  purgedConfigs: number;
  purgedNormalized: number;
} {
  return db.transaction(() => {
    // Create temporary table for the stale full_names (computed once)
    db.run(`
      CREATE TEMP TABLE IF NOT EXISTS temp_stale_repos (full_name TEXT PRIMARY KEY);
    `);

    // Populate stale repos exactly once — this benefits from the new index
    db.query(`
      INSERT OR IGNORE INTO temp_stale_repos (full_name)
      SELECT full_name FROM repos
      WHERE (
        -- Pending: max ${PENDING_RETENTION_DAYS} days (null last_pushed = immediate eject)
        (status = 'pending' AND (last_pushed IS NULL OR last_pushed < datetime('now', '-${PENDING_RETENTION_DAYS} days')))
        OR
        -- Higher-tier: max ${ELIGIBLE_RETENTION_DAYS} days
        (status != 'pending' AND (last_pushed IS NULL OR last_pushed < datetime('now', '-${ELIGIBLE_RETENTION_DAYS} days')))
      )
    `).run();

    // Fast deletes against the temp table (PRIMARY KEY lookups only)
    const purgeConfigsResult = db
      .query(`DELETE FROM configs WHERE full_name IN (SELECT full_name FROM temp_stale_repos)`)
      .run();

    const purgeNormalizedResult = db
      .query(`DELETE FROM normalized_configs WHERE full_name IN (SELECT full_name FROM temp_stale_repos)`)
      .run();

    const purgeReposResult = db
      .query(`DELETE FROM repos WHERE full_name IN (SELECT full_name FROM temp_stale_repos)`)
      .run();

    // Clean up temp table
    db.run(`DROP TABLE IF EXISTS temp_stale_repos;`);

    return {
      purgedRepos: purgeReposResult.changes,
      purgedConfigs: purgeConfigsResult.changes,
      purgedNormalized: purgeNormalizedResult.changes,
    };
  })();
}

export function getUnprocessedRawConfigs(
  db: Db,
  limit: number = 1,
): {
  full_name: string;
  filename: string;
  content_hash: string;
}[] {
  // Restrict to filenames the normalization stage currently supports.
  // Today: native oxlint JSON only. As new paths land (eslint flat,
  // eslint legacy, biome, ...), widen this IN clause one entry at a time.
  // Anything not on the list never enters the queue and is silently
  // skipped — no "unsupported" log noise, no operator gating.
  const rows = db
    .query(
      `
      SELECT c.full_name, c.filename, c.content_hash
      FROM configs c
      LEFT JOIN normalized_configs n
        ON c.full_name = n.full_name
       AND c.filename = n.filename
       AND c.content_hash = n.content_hash
      WHERE n.content_hash IS NULL
        AND c.filename IN ('.oxlintrc.json', 'oxlintrc.json')
      LIMIT ?
    `,
    )
    .all(limit) as {
    full_name: string;
    filename: string;
    content_hash: string;
  }[];
  return rows;
}

export function getConfigContent(db: Db, hash: string): string | null {
  const row = db
    .query("SELECT content_blob FROM config_blobs WHERE hash = ?")
    .get(hash) as { content_blob: Uint8Array } | null;

  if (!row?.content_blob) return null;

  const blob = new Uint8Array(row.content_blob);
  const decompressed = Bun.gunzipSync(blob);
  return new TextDecoder().decode(decompressed);
}

export function saveNormalizedConfig(
  db: Db,
  fullName: string,
  filename: string,
  contentHash: string,
  normalizedJson: string,
) {
  db.query(
    `
    INSERT INTO normalized_configs (full_name, filename, content_hash, normalized_json, normalized_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(full_name, filename, content_hash) DO UPDATE SET
      normalized_json = excluded.normalized_json,
      normalized_at = CURRENT_TIMESTAMP
  `,
  ).run(fullName, filename, contentHash, normalizedJson);
}

// Delete a single http_cache row by PK. Used by the acquisition stage to
// invalidate a stale 304 entry when we discover that the cached file list
// is incomplete (e.g. missing package.json under the new acquisition
// contract). PK lookup, no scan.
export function clearHttpCacheEntry(db: Db, cacheKey: string): void {
  db.query("DELETE FROM http_cache WHERE cache_key = ?").run(cacheKey);
}
