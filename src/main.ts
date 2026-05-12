import { openDb } from "./services/db";
import { startAcquisitionStage } from "./pipeline/acquisition";
import { initRateLimitState } from "./services/github";
import { startRetentionStage } from "./pipeline/retention";
import { startDiscoveryStage } from "./pipeline/discovery";
import { createLogger } from "./services/logger";
import { startNormalizationStage } from "./pipeline/normalization";
import { sleep } from "./utils/time";

const logger = createLogger("main");

const TOKEN = process.env.GITHUB_TOKEN ?? "";
if (TOKEN === "") throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const dbPath = process.env.DB_PATH ?? "superset.db";
const db = openDb(dbPath);

initRateLimitState(db);

const controller = new AbortController();
const signal = controller.signal;

let isShuttingDown = false;

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

  // Start stages normally
  const retention = startRetentionStage(db, signal);
  const discovery = startDiscoveryStage(db, signal);
  const acquisition = startAcquisitionStage(db, TOKEN, signal);
  const normalization = startNormalizationStage(db, signal);

  // Run them with resilience
  await Promise.all([
    runResilientStage("retention", retention, signal),
    runResilientStage("discovery", discovery, signal),
    runResilientStage("acquisition", acquisition, signal),
    runResilientStage("normalization", normalization, signal),
  ]);
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
