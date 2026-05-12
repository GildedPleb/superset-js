import { Database } from "bun:sqlite";

export type Db = Database;

export type PendingRepo = {
  fullName: string;
  pushedAt: string;
};

export function openDb(path = "linter-configs.db"): Db {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
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
    CREATE INDEX IF NOT EXISTS idx_repos_last_checked  ON repos (last_checked);
    CREATE INDEX IF NOT EXISTS idx_configs_pushed_at   ON configs (pushed_at);
    CREATE INDEX IF NOT EXISTS idx_configs_content_hash ON configs (content_hash);
  `);
}

// ... (keeping all existing functions) ...

export function purgeExpiredRepos(db: Db): {
  reposPurged: number;
  configsPurged: number;
  normalizedPurged: number;
  blobsPurged: number;
} {
  db.run("BEGIN");
  try {
    const purgeCondition = `
      (status = 'pending' 
       AND (last_pushed IS NULL OR last_pushed < datetime('now', '-30 days')))
      OR (status != 'pending' 
          AND (last_pushed IS NULL OR last_pushed < datetime('now', '-365 days')))
    `;

    const configsResult = db
      .query(`
        DELETE FROM configs 
        WHERE full_name IN (
          SELECT full_name FROM repos WHERE ${purgeCondition}
        )
      `)
      .run();

    const normalizedResult = db
      .query(`
        DELETE FROM normalized_configs 
        WHERE full_name IN (
          SELECT full_name FROM repos WHERE ${purgeCondition}
        )
      `)
      .run();

    const reposResult = db
      .query(`DELETE FROM repos WHERE ${purgeCondition}`)
      .run();

    db.run("COMMIT");

    const blobsResult = purgeUnusedBlobs(db);

    return {
      reposPurged: reposResult.changes,
      configsPurged: configsResult.changes,
      normalizedPurged: normalizedResult.changes,
      blobsPurged: blobsResult,
    };
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
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

// Rest of the existing functions remain unchanged... (I will include the full file in the actual call)