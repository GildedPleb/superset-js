#!/usr/bin/env bun

import { Database } from "bun:sqlite";

const DB_PATH = process.argv[2] || "superset.db"; // change default if needed (e.g. linter-configs.db)
const STALE_DAYS = 30; // matches PENDING_RETENTION_DAYS in the codebase

const db = new Database(DB_PATH, { readonly: true });

console.log("=== Stale Repo Stats ===\n");
console.log(`DB: ${DB_PATH}`);
console.log(
  `Definition: status='good' AND (last_checked IS NULL OR last_checked < now - ${STALE_DAYS} days)\n`,
);

// === Basic counts ===
const totalRepos = (
  db.query("SELECT COUNT(*) as c FROM repos").get() as { c: number }
).c;
const good = (
  db.query("SELECT COUNT(*) as c FROM repos WHERE status = 'good'").get() as {
    c: number;
  }
).c;
const pending = (
  db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'pending'")
    .get() as { c: number }
).c;
const eligible = (
  db
    .query("SELECT COUNT(*) as c FROM repos WHERE status = 'eligible'")
    .get() as { c: number }
).c;

const stale = (
  db
    .query(
      `
  SELECT COUNT(*) as c
  FROM repos
  WHERE status = 'good'
    AND (last_checked IS NULL OR last_checked < datetime('now', '-${STALE_DAYS} days'))
`,
    )
    .get() as { c: number }
).c;

const neverChecked = (
  db
    .query(
      `
  SELECT COUNT(*) as c
  FROM repos
  WHERE status = 'good' AND last_checked IS NULL
`,
    )
    .get() as { c: number }
).c;

console.log("Overview:");
console.log(`  Total repos     : ${totalRepos.toLocaleString()}`);
console.log(`  Good            : ${good.toLocaleString()}`);
console.log(`  Eligible        : ${eligible.toLocaleString()}`);
console.log(`  Pending         : ${pending.toLocaleString()}`);
console.log(`  Stale (needs refresh): ${stale.toLocaleString()}`);
console.log(
  `    - Never checked (last_checked = NULL): ${neverChecked.toLocaleString()}\n`,
);

// === Oldest stale repo ===
const oldest = db
  .query(
    `
  SELECT
    full_name,
    last_checked,
    last_pushed,
    CASE
      WHEN last_checked IS NULL THEN 999999
      ELSE CAST(julianday('now') - julianday(last_checked) AS INTEGER)
    END as days_old
  FROM repos
  WHERE status = 'good'
    AND (last_checked IS NULL OR last_checked < datetime('now', '-${STALE_DAYS} days'))
  ORDER BY days_old DESC, last_checked ASC
  LIMIT 1
`,
  )
  .get() as {
  full_name: string;
  last_checked: string | null;
  last_pushed: string | null;
  days_old: number;
} | null;

if (oldest) {
  console.log("Oldest stale repo:");
  console.log(`  ${oldest.full_name}`);
  console.log(
    `  last_checked: ${oldest.last_checked ?? "NEVER"} (${oldest.days_old} days)`,
  );
  console.log(`  last_pushed : ${oldest.last_pushed ?? "unknown"}\n`);
}

// === Age distribution ===
console.log("Stale age distribution:");

const buckets = db
  .query(
    `
  WITH stale_repos AS (
    SELECT
      CASE
        WHEN last_checked IS NULL THEN 999999
        ELSE CAST(julianday('now') - julianday(last_checked) AS INTEGER)
      END as days_old
    FROM repos
    WHERE status = 'good'
      AND (last_checked IS NULL OR last_checked < datetime('now', '-${STALE_DAYS} days'))
  )
  SELECT
    CASE
      WHEN days_old >= 999999 THEN 'Never checked (NULL)'
      WHEN days_old < 45  THEN '30–45 days'
      WHEN days_old < 60  THEN '45–60 days'
      WHEN days_old < 90  THEN '60–90 days'
      WHEN days_old < 180 THEN '90–180 days'
      WHEN days_old < 365 THEN '180–365 days'
      ELSE '365+ days (very stale)'
    END as bucket,
    COUNT(*) as count
  FROM stale_repos
  GROUP BY bucket
  ORDER BY
    CASE bucket
      WHEN 'Never checked (NULL)' THEN 0
      WHEN '30–45 days' THEN 1
      WHEN '45–60 days' THEN 2
      WHEN '60–90 days' THEN 3
      WHEN '90–180 days' THEN 4
      WHEN '180–365 days' THEN 5
      ELSE 6
    END
`,
  )
  .all() as Array<{ bucket: string; count: number }>;

for (const b of buckets) {
  const pct = stale > 0 ? ((b.count / stale) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${b.bucket.padEnd(22)} : ${b.count.toString().padStart(7)}  (${pct}%)`,
  );
}
console.log("");

// === Top 10 oldest ===
console.log("Top 10 oldest stale repos:");

const top10 = db
  .query(
    `
  SELECT
    full_name,
    last_checked,
    CASE
      WHEN last_checked IS NULL THEN 999999
      ELSE CAST(julianday('now') - julianday(last_checked) AS INTEGER)
    END as days_old
  FROM repos
  WHERE status = 'good'
    AND (last_checked IS NULL OR last_checked < datetime('now', '-${STALE_DAYS} days'))
  ORDER BY days_old DESC, last_checked ASC
  LIMIT 10
`,
  )
  .all() as Array<{
  full_name: string;
  last_checked: string | null;
  days_old: number;
}>;

top10.forEach((r, i) => {
  const age = r.last_checked ? `${r.days_old}d ago` : `NEVER (${r.days_old}d)`;
  console.log(
    `  ${(i + 1).toString().padStart(2)}. ${r.full_name.padEnd(45)}  last_checked: ${age}`,
  );
});

// --- Oldest repo overall (stale or not) ---
// --- Oldest repo by last_checked (only repos that have been checked) ---
const oldestByChecked = db
  .query(
    `
  SELECT
    full_name,
    status,
    last_checked,
    last_pushed,
    CAST(julianday('now') - julianday(last_checked) AS INTEGER) as days_old
  FROM repos
  WHERE last_checked IS NOT NULL
  ORDER BY last_checked ASC
  LIMIT 1
`,
  )
  .get() as {
  full_name: string;
  status: string;
  last_checked: string;
  last_pushed: string | null;
  days_old: number;
} | null;

if (oldestByChecked) {
  console.log(
    "Oldest repo by last_checked (repos that have been checked at least once):",
  );
  console.log(`  ${oldestByChecked.full_name}`);
  console.log(`  status:       ${oldestByChecked.status}`);
  console.log(
    `  last_checked: ${oldestByChecked.last_checked} (${oldestByChecked.days_old} days ago)`,
  );
  console.log(`  last_pushed:  ${oldestByChecked.last_pushed ?? "unknown"}\n`);
}

// --- Oldest repo by last_pushed ---
const oldestByPushed = db
  .query(
    `
  SELECT
    full_name,
    status,
    last_checked,
    last_pushed,
    CAST(julianday('now') - julianday(last_pushed) AS INTEGER) as days_old
  FROM repos
  WHERE last_pushed IS NOT NULL
  ORDER BY last_pushed ASC
  LIMIT 1
`,
  )
  .get() as {
  full_name: string;
  status: string;
  last_checked: string | null;
  last_pushed: string;
  days_old: number;
} | null;

if (oldestByPushed) {
  console.log("Oldest repo by last_pushed:");
  console.log(`  ${oldestByPushed.full_name}`);
  console.log(`  status:       ${oldestByPushed.status}`);
  console.log(
    `  last_pushed:  ${oldestByPushed.last_pushed} (${oldestByPushed.days_old} days ago)`,
  );
  console.log(`  last_checked: ${oldestByPushed.last_checked ?? "NEVER"}\n`);
}

console.log("\nDone.");
