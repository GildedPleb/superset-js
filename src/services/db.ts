import { Database } from "bun:sqlite";

export type Db = Database;

export type PendingRepo = {
  fullName: string;
  pushedAt: string;
};

export function openDb(path = "linter-configs.db"): Db {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  initSchema(db);
  return db;
}

function initSchema(db: Db) {
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_repos_status        ON repos (status);
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

export function addPendingRepos(db: Db, repos: PendingRepo[]): number {
  if (repos.length === 0) return 0;
  const values = repos.map(() => "(?, 'pending', ?)").join(", ");
  const params: string[] = [];
  for (const repo of repos) {
    params.push(repo.fullName, repo.pushedAt);
  }

  const result = db
    .query(
      `INSERT OR IGNORE INTO repos (full_name, status, last_pushed) VALUES ${values}`,
    )
    .run(...params);
  return result.changes;
}

function upsertRepoStatus(
  db: Db,
  fullName: string,
  status: "pending" | "good" | "no-config" | "gone",
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

export function getPendingRepos(db: Db, limit: number): string[] {
  const rows = db
    .query("SELECT full_name FROM repos WHERE status = 'pending' LIMIT ?")
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
  const good = db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'good'")
    .get() as { c: number };
  const totalConfigs = db.query("SELECT COUNT(*) as c FROM configs").get() as {
    c: number;
  };

  return {
    pending: pending.c,
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
