import { openDb } from "./services/db";
import { startAcquisitionStage } from "./pipeline/acquisition";
import { initRateLimitState } from "./services/github";
import { startRetentionStage } from "./pipeline/retention";
import { startDiscoveryStage } from "./pipeline/discovery";
import { createLogger } from "./services/logger";
import { startNormalizationStage } from "./pipeline/normalization";
import { sleep } from "./utils/time";
import { PENDING_RETENTION_DAYS, ELIGIBLE_RETENTION_DAYS } from "./constants";

const logger = createLogger("main");

const TOKEN = process.env.GITHUB_TOKEN ?? "";
if (TOKEN === "") throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

logger.info(
  `Retention policy loaded: pending=${PENDING_RETENTION_DAYS}d, eligible=${ELIGIBLE_RETENTION_DAYS}d`,
);

const dbPath = process.env.DB_PATH ?? "superset.db";
logger.info(`Using database at: ${dbPath}`);

const db = openDb(dbPath);

initRateLimitState(db);

const controller = new AbortController();
const signal = controller.signal;

let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────────────────────
// Coarse-grained stage toggles + granular normalization pathway feature flags
// (Add new ENABLE_NORMALIZATION_* flags here as pathways are completed.
//  These enable the incremental development + progressive prod rollout workflow.)
// ─────────────────────────────────────────────────────────────────────────────
const ENABLE_INGESTION = process.env.ENABLE_INGESTION !== "false"; // default: true (prod)

// Granular normalization pathways (independent — enable only what you are developing)
const ENABLE_NORMALIZATION_OXLINT_RAW =
  process.env.ENABLE_NORMALIZATION_OXLINT_RAW === "true";
const ENABLE_NORMALIZATION_OXLINT_JS_DEPS =
  process.env.ENABLE_NORMALIZATION_OXLINT_JS_DEPS === "true";

// Future pathways (examples — add new ones following the same pattern):
// const ENABLE_NORMALIZATION_ESLINT   = process.env.ENABLE_NORMALIZATION_ESLINT === "true";
// const ENABLE_NORMALIZATION_BIOME    = process.env.ENABLE_NORMALIZATION_BIOME === "true";
// const ENABLE_NORMALIZATION_PRETTIER = process.env.ENABLE_NORMALIZATION_PRETTIER === "true";

const anyNormalizationEnabled =
  ENABLE_NORMALIZATION_OXLINT_RAW ||
  ENABLE_NORMALIZATION_OXLINT_JS_DEPS; /* || ... */

// ─────────────────────────────────────────────────────────────────────────────
// Resilient stage wrapper
// ─────────────────────────────────────────────────────────────────────────────
async function runResilientStage(
  name: string,
  stageRunner: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const stageLogger = createLogger(`stage:${name}`);

  while (true) {
    try {
      await stageRunner();
    } catch (err: unknown) {
      if (signal.aborted) {
        break;
      }

      const message = err instanceof Error ? err.message : String(err);
      stageLogger.error(`unexpected error — restarting in 30s: ${message}`);

      try {
        await sleep(30000, signal);
      } catch {
        break;
      }
    }
  }
}

async function main() {
  logger.info("Starting concurrent N-stage pipeline");

  // === Feature flag observability (you will always know exactly what is active) ===
  logger.info(
    `Ingestion stages (discovery + acquisition + retention): ${ENABLE_INGESTION ? "ENABLED" : "DISABLED"}`,
  );

  if (anyNormalizationEnabled) {
    logger.info("Normalization stage: ENABLED");
    if (ENABLE_NORMALIZATION_OXLINT_RAW) {
      logger.info(
        "  └── ENABLE_NORMALIZATION_OXLINT_RAW     = true (oxlint configs without JS deps)",
      );
    }
    if (ENABLE_NORMALIZATION_OXLINT_JS_DEPS) {
      logger.info(
        "  └── ENABLE_NORMALIZATION_OXLINT_JS_DEPS = true (oxlint configs with JS deps)",
      );
    }
    // Add logging for new pathways here
  } else {
    logger.info("Normalization stage: DISABLED (no pathways enabled)");
  }

  const stages: Promise<void>[] = [];

  if (ENABLE_INGESTION) {
    const retention = startRetentionStage(db, signal);
    const discovery = startDiscoveryStage(db, signal);
    const acquisition = startAcquisitionStage(db, TOKEN, signal);
    stages.push(
      runResilientStage("retention", retention, signal),
      runResilientStage("discovery", discovery, signal),
      runResilientStage("acquisition", acquisition, signal),
    );
  } else {
    logger.info(
      "Ingestion disabled — running in local dev mode (zero GitHub quota usage)",
    );
  }

  if (anyNormalizationEnabled) {
    const normalization = startNormalizationStage(db, signal);
    stages.push(runResilientStage("normalization", normalization, signal));
  }

  await Promise.all(stages);
}

main().catch((err) => {
  if (isShuttingDown && err?.name === "AbortError") {
    logger.info("Pipelines aborted cleanly during shutdown");
    return;
  }

  logger.error(err instanceof Error ? err.message : String(err));
  throw err;
});

async function gracefulShutdown(signalName: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`🛑 ${signalName} received — aborting pipelines...`);

  controller.abort();
  await Bun.sleep(600);
  db.close();
  logger.info("✅ Database closed cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
