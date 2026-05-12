#!/usr/bin/env bun
/**
 * Database Integrity Test Suite for superset-js
 *
 * Run with: bun src/scripts/integrity/integrity-check.ts [--json] [--quick] [db-path]
 *
 * Features:
 * - Modular check system: add new checks by appending to the `checks` array
 * - Clear ✅ / ⚠️ / ❌ output with timing
 * - Human-readable console report + optional JSON output for CI/monitoring
 * - Uses existing openDb() helper (respects WAL, schema, retention constants)
 * - Designed for regular cron / pre-deploy runs against the live 4M+ row DB
 *
 * Adding a new check (example):
 *   1. Define an async function `checkFoo(db: Db): Promise<CheckResult>`
 *   2. Push it to the `checks` array below (order matters for report flow)
 *   3. Update this header comment
 *
 * Future enhancements (TODO):
 *   - --mode quick|full|audit
 *   - Slack/ email alerting on failures
 *   - Historical trend tracking via app_state table
 *   - Auto-fix for safe issues (e.g. backfill obvious NULLs)
 */

import { openDb, type Db } from "../services/db.ts";

interface CheckResult {
  name: string;
  status: "✅" | "⚠️" | "❌";
  message: string;
  details?: Record<string, number | string | boolean | object>;
  durationMs: number;
}

type CheckFn = (db: Db) => CheckResult | Promise<CheckResult>;

// ============================================================
// CHECK IMPLEMENTATIONS (modular — add new ones here)
// ============================================================

/** 1. Critical: No NULL last_pushed (was root cause of 485k purge incident) */
async function checkNoNullLastPushed(db: Db): Promise<CheckResult> {
  const start = performance.now();
  const row = db
    .query("SELECT COUNT(*) as c FROM repos WHERE last_pushed IS NULL")
    .get() as { c: number };
  const durationMs = performance.now() - start;

  if (row.c === 0) {
    return {
      name: "No NULL last_pushed",
      status: "✅",
      message: "All repos have valid last_pushed timestamps",
      details: { nullCount: 0 },
      durationMs,
    };
  }
  return {
    name: "No NULL last_pushed",
    status: "❌",
    message: `${row.c} repos have NULL last_pushed — immediate data loss risk on next retention run!`,
    details: { nullCount: row.c },
    durationMs,
  };
}

/** 2. Referential integrity: orphaned records in child tables */
async function checkReferentialIntegrity(db: Db): Promise<CheckResult> {
  const start = performance.now();

  const orphanConfigs = db
    .query(
      `SELECT COUNT(*) as c FROM configs c
       LEFT JOIN repos r ON c.full_name = r.full_name
       WHERE r.full_name IS NULL`,
    )
    .get() as { c: number };

  const orphanNormalized = db
    .query(
      `SELECT COUNT(*) as c FROM normalized_configs n
       LEFT JOIN repos r ON n.full_name = r.full_name
       WHERE r.full_name IS NULL`,
    )
    .get() as { c: number };

  const durationMs = performance.now() - start;

  const totalOrphans = orphanConfigs.c + orphanNormalized.c;

  if (totalOrphans === 0) {
    return {
      name: "Referential Integrity",
      status: "✅",
      message:
        "No orphaned configs or normalized_configs (all reference valid repos)",
      details: { orphanConfigs: 0, orphanNormalized: 0 },
      durationMs,
    };
  }

  return {
    name: "Referential Integrity",
    status: "❌",
    message: `${totalOrphans} orphaned child records detected — potential leak from retention or manual deletes`,
    details: {
      orphanConfigs: orphanConfigs.c,
      orphanNormalized: orphanNormalized.c,
    },
    durationMs,
  };
}

/** 3. Status consistency & last_checked coverage */
async function checkStatusConsistency(db: Db): Promise<CheckResult> {
  const start = performance.now();

  const statusRows = db
    .query(
      "SELECT status, COUNT(*) as count FROM repos GROUP BY status ORDER BY count DESC",
    )
    .all() as { status: string; count: number }[];

  const goodWithoutConfig = db
    .query(
      `SELECT COUNT(*) as c FROM repos r
       LEFT JOIN configs c ON r.full_name = c.full_name
       WHERE r.status = 'good' AND c.full_name IS NULL`,
    )
    .get() as { c: number };

  const eligibleWithConfig = db
    .query(
      `SELECT COUNT(*) as c FROM repos r
       INNER JOIN configs c ON r.full_name = c.full_name
       WHERE r.status = 'eligible'`,
    )
    .get() as { c: number };

  const durationMs = performance.now() - start;

  const issues: string[] = [];
  if (goodWithoutConfig.c > 0)
    issues.push(`${goodWithoutConfig.c} 'good' repos have zero configs`);
  if (eligibleWithConfig.c > 0)
    issues.push(
      `${eligibleWithConfig.c} 'eligible' repos already have configs (unexpected)`,
    );

  const statusSummary = statusRows
    .map((r) => `${r.status}:${r.count}`)
    .join(", ");

  if (issues.length === 0) {
    return {
      name: "Status Consistency",
      status: "✅",
      message: `All statuses look healthy. Breakdown: ${statusSummary}`,
      details: {
        goodWithoutConfig: goodWithoutConfig.c,
        eligibleWithConfig: eligibleWithConfig.c,
        statusCounts: Object.fromEntries(
          statusRows.map((r) => [r.status, r.count]),
        ),
      },
      durationMs,
    };
  }

  return {
    name: "Status Consistency",
    status: "⚠️",
    message: issues.join("; "),
    details: {
      goodWithoutConfig: goodWithoutConfig.c,
      eligibleWithConfig: eligibleWithConfig.c,
      statusCounts: Object.fromEntries(
        statusRows.map((r) => [r.status, r.count]),
      ),
    },
    durationMs,
  };
}

/** 4. last_checked NULL distribution (known ~4M issue, but track by status) */
async function checkLastCheckedNulls(db: Db): Promise<CheckResult> {
  const start = performance.now();

  const nullsByStatus = db
    .query(
      `SELECT status, COUNT(*) as null_count
       FROM repos
       WHERE last_checked IS NULL
       GROUP BY status
       ORDER BY null_count DESC`,
    )
    .all() as { status: string; null_count: number }[];

  const totalNulls = nullsByStatus.reduce((sum, r) => sum + r.null_count, 0);

  const durationMs = performance.now() - start;

  const problematic = nullsByStatus.filter(
    (r) => (r.status === "good" || r.status === "eligible") && r.null_count > 0,
  );

  if (problematic.length === 0 && totalNulls < 100_000) {
    return {
      name: "last_checked NULLs",
      status: "✅",
      message: `Only ${totalNulls.toLocaleString()} NULL last_checked (mostly expected for pending)`,
      details: {
        totalNulls,
        byStatus: Object.fromEntries(
          nullsByStatus.map((r) => [r.status, r.null_count]),
        ),
      },
      durationMs,
    };
  }

  return {
    name: "last_checked NULLs",
    status: "⚠️",
    message: `${totalNulls.toLocaleString()} repos have NULL last_checked (high for good/eligible = acquisition gap)`,
    details: {
      totalNulls,
      byStatus: Object.fromEntries(
        nullsByStatus.map((r) => [r.status, r.null_count]),
      ),
      problematicStatuses: problematic.map((p) => p.status),
    },
    durationMs,
  };
}

/** 5. Age distribution by last_pushed (helps spot retention / discovery skew) */
async function checkAgeDistribution(db: Db): Promise<CheckResult> {
  const start = performance.now();

  const buckets = db
    .query(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN last_pushed >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as "0-30d",
        SUM(CASE WHEN last_pushed < datetime('now', '-30 days') AND last_pushed >= datetime('now', '-90 days') THEN 1 ELSE 0 END) as "31-90d",
        SUM(CASE WHEN last_pushed < datetime('now', '-90 days') AND last_pushed >= datetime('now', '-180 days') THEN 1 ELSE 0 END) as "91-180d",
        SUM(CASE WHEN last_pushed < datetime('now', '-180 days') AND last_pushed >= datetime('now', '-365 days') THEN 1 ELSE 0 END) as "181-365d",
        SUM(CASE WHEN last_pushed < datetime('now', '-365 days') THEN 1 ELSE 0 END) as ">365d"
      FROM repos
      WHERE last_pushed IS NOT NULL
      `,
    )
    .get() as {
    total: number;
    "0-30d": number;
    "31-90d": number;
    "91-180d": number;
    "181-365d": number;
    ">365d": number;
  };

  const durationMs = performance.now() - start;

  const pct = (n: number) => ((n / buckets.total) * 100).toFixed(1) + "%";

  return {
    name: "Age Distribution (last_pushed)",
    status: "✅",
    message: `${buckets.total.toLocaleString()} repos analyzed`,
    details: {
      total: buckets.total,
      "0-30d": `${buckets["0-30d"].toLocaleString()} (${pct(buckets["0-30d"])})`,
      "31-90d": `${buckets["31-90d"].toLocaleString()} (${pct(buckets["31-90d"])})`,
      "91-180d": `${buckets["91-180d"].toLocaleString()} (${pct(buckets["91-180d"])})`,
      "181-365d": `${buckets["181-365d"].toLocaleString()} (${pct(buckets["181-365d"])})`,
      ">365d": `${buckets[">365d"].toLocaleString()} (${pct(buckets[">365d"])})`,
    },
    durationMs,
  };
}

// Register all checks here (order = report order)
const checks: CheckFn[] = [
  checkNoNullLastPushed,
  checkReferentialIntegrity,
  checkStatusConsistency,
  checkLastCheckedNulls,
  checkAgeDistribution,
];

// ============================================================
// MAIN RUNNER
// ============================================================

async function runIntegrityChecks(
  options: { json?: boolean; quick?: boolean; dbPath?: string } = {},
) {
  const { json = false, quick = false, dbPath } = options;

  console.log("🔍 superset-js Database Integrity Test Suite");
  console.log("═".repeat(60));
  console.log(`Started: ${new Date().toISOString()}`);
  if (dbPath) console.log(`DB: ${dbPath}`);
  console.log("");

  const db = openDb(dbPath);

  const results: CheckResult[] = [];
  let totalDuration = 0;

  for (const check of checks) {
    if (quick && check.name.includes("Age")) continue;

    try {
      const result = await Promise.resolve(check(db));
      results.push(result);
      totalDuration += result.durationMs;

      if (!json) {
        const timing = `(${result.durationMs.toFixed(0)}ms)`;
        console.log(
          `${result.status} ${result.name.padEnd(28)} ${result.message} ${timing}`,
        );
        if (result.details && Object.keys(result.details).length > 0) {
          console.log(
            "   " +
              JSON.stringify(result.details, null, 2).replace(/\n/g, "\n   "),
          );
        }
      }
    } catch (err) {
      const errorResult: CheckResult = {
        name: (check as any).name || "Unknown Check",
        status: "❌",
        message: `Check failed: ${(err as Error).message}`,
        durationMs: 0,
      };
      results.push(errorResult);
      if (!json)
        console.error(`❌ ${errorResult.name}: ${errorResult.message}`);
    }
  }

  const passed = results.filter((r) => r.status === "✅").length;
  const warned = results.filter((r) => r.status === "⚠️").length;
  const failed = results.filter((r) => r.status === "❌").length;

  const summary = {
    totalChecks: results.length,
    passed,
    warned,
    failed,
    totalDurationMs: Math.round(totalDuration),
    timestamp: new Date().toISOString(),
    results,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    console.log("═".repeat(60));
    console.log(
      `✅ Passed: ${passed}   ⚠️ Warned: ${warned}   ❌ Failed: ${failed}`,
    );
    console.log(`Total time: ${(totalDuration / 1000).toFixed(1)}s`);
    console.log("═".repeat(60));

    if (failed > 0) {
      console.log(
        "\n🚨 ACTION REQUIRED: Fix critical issues before next retention/discovery run.",
      );
      process.exitCode = 1;
    } else if (warned > 0) {
      console.log("\n⚠️  Review warnings — not blocking but worth monitoring.");
    } else {
      console.log("\n🎉 All integrity checks passed cleanly.");
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json") || args.includes("-j");
  const quick = args.includes("--quick") || args.includes("-q");
  const dbPath = args.find((a) => !a.startsWith("-")) || "superset.db";

  runIntegrityChecks({ json, quick, dbPath }).catch((err) => {
    console.error("Fatal error running integrity suite:", err);
    process.exit(1);
  });
}

export { runIntegrityChecks, checks };
