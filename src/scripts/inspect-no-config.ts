import { Database } from "bun:sqlite";

const db = new Database("superset.db", { readonly: true });

console.log("=== No-config repo observability ===\n");

// 1. Total no-config
const total = db
  .query("SELECT COUNT(*) as count FROM repos WHERE status = 'no-config'")
  .get() as { count: number };
console.log(`Total no-config repos: ${total.count}`);

// 2. no-config repos that still have a /contents cache entry (fixed version)
const withCache = db
  .query(
    `
  SELECT COUNT(*) as count
  FROM http_cache
  WHERE url LIKE 'https://api.github.com/repos/%/contents'
    AND EXISTS (
      SELECT 1 FROM repos
      WHERE full_name = SUBSTR(
        url,
        34,
        INSTR(SUBSTR(url, 34), '/') - 1
      )
      AND status = 'no-config'
    )
`,
  )
  .get() as { count: number };

console.log(
  `no-config repos with active /contents cache (would hit 304): ${withCache.count}`,
);

// 3. Age distribution
console.log("\nBy last_checked age:");
const ageRows = db
  .query(
    `
  SELECT
    CASE
      WHEN last_checked IS NULL THEN 'never_checked'
      WHEN last_checked > datetime('now', '-7 days')  THEN 'last_7_days'
      WHEN last_checked > datetime('now', '-30 days') THEN 'last_30_days'
      WHEN last_checked > datetime('now', '-90 days') THEN 'last_90_days'
      ELSE 'older_than_90_days'
    END as bucket,
    COUNT(*) as count
  FROM repos
  WHERE status = 'no-config'
  GROUP BY bucket
  ORDER BY count DESC
`,
  )
  .all() as Array<{ bucket: string; count: number }>;

for (const row of ageRows) {
  console.log(`  ${row.bucket.padEnd(20)} : ${row.count}`);
}

// 4. Recently pushed
const recent = db
  .query(
    `
  SELECT COUNT(*) as count
  FROM repos
  WHERE status = 'no-config'
    AND last_pushed > datetime('now', '-30 days')
`,
  )
  .get() as { count: number };
console.log(`\nno-config repos pushed in last 30 days: ${recent.count}`);

db.close();
