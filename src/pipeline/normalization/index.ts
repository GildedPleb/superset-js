// Normalization stage. The loop:
//
//   1. Pull one un-normalized config row that the SQL filter has already
//      restricted to currently-supported kinds (today: oxlint JSON).
//   2. Run it through the matching normalizer.
//   3. On failure: log loudly, wait for ENTER, do NOT write.
//   4. On success: print the normalized result, wait for ENTER, THEN write.
//
// Idempotent: failures and Ctrl-C-before-ENTER both leave the row eligible
// for the next iteration. No silent saves, no silent advances on processed
// rows. Rows whose kind we don't support yet are excluded by the SQL filter
// and never appear in this loop.

import { createInterface } from "node:readline";
import {
  getConfigContent,
  getUnprocessedRawConfigs,
  saveNormalizedConfig,
  type Db,
} from "../../services/db";
import { createLogger } from "../../services/logger";
import { normalizeOxlint } from "./oxlint";
import { sleep } from "../../utils/time";

const logger = createLogger("normalization");

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function logFailureBlock(args: {
  fullName: string;
  filename: string;
  contentHash: string;
  source: string;
  error: unknown;
}) {
  const msg =
    args.error instanceof Error ? args.error.message : String(args.error);
  const stack =
    args.error instanceof Error && args.error.stack ? args.error.stack : "";
  const lines = [
    "",
    "============================================================",
    "NORMALIZATION FAILURE — config not saved, advance is gated",
    "============================================================",
    `REPO:   ${args.fullName}`,
    `FILE:   ${args.filename}`,
    `HASH:   ${args.contentHash}`,
    `ERROR:  ${msg}`,
    "----- SOURCE -----",
    args.source,
    "----- STACK -----",
    stack || "(no stack)",
    "============================================================",
  ];
  logger.error(lines.join("\n"));
}

function logSuccessBlock(args: {
  fullName: string;
  filename: string;
  contentHash: string;
  source: string;
  normalizedJson: string;
}) {
  const lines = [
    "",
    "============================================================",
    "NORMALIZATION SUCCESS — review before commit",
    "============================================================",
    `REPO:   ${args.fullName}`,
    `FILE:   ${args.filename}`,
    `HASH:   ${args.contentHash}`,
    "----- SOURCE -----",
    args.source,
    "----- NORMALIZED -----",
    args.normalizedJson,
    "============================================================",
  ];
  logger.info(lines.join("\n"));
}

function dispatch(
  filename: string,
  source: string,
  fullName: string,
):
  | { kind: "supported"; result: ReturnType<typeof normalizeOxlint> }
  | { kind: "unsupported" } {
  // Today: only native oxlint JSON. The SQL filter in
  // getUnprocessedRawConfigs already excludes everything else; this
  // double-check is a tripwire for filter drift.
  if (filename === ".oxlintrc.json" || filename === "oxlintrc.json") {
    return { kind: "supported", result: normalizeOxlint(source, fullName) };
  }
  return { kind: "unsupported" };
}

export function startNormalizationStage(db: Db, signal: AbortSignal) {
  return async () => {
    logger.info("Normalization stage started (oxlint-only path)");

    while (true) {
      signal.throwIfAborted();
      const pending = getUnprocessedRawConfigs(db, 1);
      if (pending.length === 0) {
        await sleep(10000, signal);
        continue;
      }
      const { full_name, filename, content_hash } = pending[0]!;

      const source = getConfigContent(db, content_hash);
      if (source === null) {
        // Blob missing — should be impossible. Skip the row silently and
        // continue; we don't want to gate on something the operator can't fix.
        await sleep(50, signal);
        continue;
      }

      try {
        const out = dispatch(filename, source, full_name);
        if (out.kind === "unsupported") {
          // SQL filter drift — log once and advance silently.
          logger.warn(
            `Unsupported filename slipped through SQL filter: ${full_name}/${filename}`,
          );
          await sleep(50, signal);
          continue;
        }
        const normalizedJson = JSON.stringify(out.result, null, 2);
        logSuccessBlock({
          fullName: full_name,
          filename,
          contentHash: content_hash,
          source,
          normalizedJson,
        });
        await waitForEnter(
          "Press ENTER to commit this row to the database (Ctrl-C to reject and re-process next run): ",
        );
        saveNormalizedConfig(
          db,
          full_name,
          filename,
          content_hash,
          normalizedJson,
        );
        logger.success(`Saved ${full_name}/${filename}`);
      } catch (err) {
        logFailureBlock({
          fullName: full_name,
          filename,
          contentHash: content_hash,
          source,
          error: err,
        });
        await waitForEnter(
          "Press ENTER to advance to next row (config NOT saved): ",
        );
      }
    }
  };
}
