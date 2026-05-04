import { openDb } from "./services/db";
import { startAcquisitionStage } from "./pipeline/acquisition";
import { initRateLimitState } from "./services/github";
import { startRetentionStage } from "./pipeline/retention";
import { startDiscoveryStage } from "./pipeline/discovery";
import { createLogger } from "./services/logger";

const logger = createLogger("main");

const TOKEN = process.env.GITHUB_TOKEN ?? "";
if (TOKEN === "") throw new Error("Set GITHUB_TOKEN env var (classic PAT)");

const db = openDb();
initRateLimitState(db);

async function main() {
  logger.info("Starting concurrent N-stage pipeline");

  const retention = startRetentionStage(db);
  const discovery = startDiscoveryStage(db);
  const acquisition = startAcquisitionStage(db, TOKEN);

  // Run all stages concurrently
  await Promise.all([retention(), discovery(), acquisition()]);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  throw err;
});

// At the top of main.ts (after db = new Database(...))
process.on("SIGTERM", async () => {
  console.log("🛑 Graceful shutdown received...");
  db.close();
  await Bun.sleep(100);
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 Graceful shutdown received...");
  db.close();
  await Bun.sleep(100);
  process.exit(0);
});
