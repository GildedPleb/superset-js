import { openDb } from "./services/db";
import { startAcquisitionStage } from "./pipeline/acquisition";
import { initRateLimitState } from "./services/github";
import { startRetentionStage } from "./pipeline/retention";
import { startDiscoveryStage } from "./pipeline/discovery";
import { createLogger } from "./services/logger";
import { startNormalizationStage } from "./pipeline/normalization";

const logger = createLogger("main");

const TOKEN = process.env.GITHUB_TOKEN ?? "";
if (TOKEN === "") throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const dbPath = process.env.DB_PATH ?? "superset.db";
const db = openDb(dbPath);

initRateLimitState(db);

const controller = new AbortController();
const signal = controller.signal;

let isShuttingDown = false;

async function main() {
  logger.info("Starting concurrent N-stage pipeline");

  const retention = startRetentionStage(db, signal);
  const discovery = startDiscoveryStage(db, signal);
  const acquisition = startAcquisitionStage(db, TOKEN, signal);
  const normalization = startNormalizationStage(db, signal);

  await Promise.all([retention(), discovery(), acquisition(), normalization()]);
}

main().catch((err) => {
  if (isShuttingDown && err.name === "AbortError") {
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

  // Give pipelines a tiny moment to react to the abort signal
  await Bun.sleep(600);

  db.close();
  logger.info("✅ Database closed cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
