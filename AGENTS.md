# AGENTS

## Overview

Continuous Bun/TS collector for linter configs (ESLint/Oxlint) from public GitHub repos. Discovers via GHArchive PushEvents, fetches via GitHub API (cached/rate-limited), dedups/gzips configs into SQLite DB `linter-configs.db`. Runs indefinitely: prioritizes pending/stale-good repos, purges old data.

**Pipeline Architecture**:
The system uses an **arbitrary N-stage concurrent data-driven pipeline**.

- Any number of stages can exist and be added ad-hoc.
- Each stage is a completely independent loop.
- All stages run **concurrently** in a single Bun process (`Promise.all`).
- Stage progression is driven purely by **database state** (presence/absence of specific fields on a row) — there is no explicit `status` flag used for pipeline hand-off.
- This makes the code clean, extensible, and eliminates nested loops or shared control-flow flags while preserving the mental model of a straight linear pipeline.

## Directory Structure

```
superset-js/
├── linter-configs.db     # SQLite DB (repos, configs, blobs, cache, state)
└── src/                  # TypeScript source
    ├── main.ts           # Entry: loop (discovery/acquisition/retention)
    ├── pipeline/         # acquisition.ts, discovery.ts, retention.ts
    ├── services/         # db.ts, gharchive.ts, github.ts, logger.ts
    └── utils/            # http.ts, time.ts
```

## DB Schema

- `repos`: `full_name`(PK), `status`(pending/good/no-config/gone), `last_checked`, `last_pushed`
- `configs`: `full_name`, `filename`(PK), `content_hash`(SHA256), `sha`, `pushed_at`
- `config_blobs`: `hash`(PK), `content_blob`(gzipped), `content_bytes`
- `http_cache`: `cache_key`(PK), `etag`, `last_modified`, etc.
- `app_state`: `key`(PK), `value` (e.g., "checkpoint_hour")

## Run Commands

- Req: `GITHUB_TOKEN` (classic PAT).
- `bun src/main.ts` (continuous; Ctrl+C stop). Network-heavy.

## Workflow (main.ts)

The entry point starts an arbitrary number of independent, concurrent stage loops:

1. **Retention stage** – periodically purges >365d configs/unused blobs.
2. **Discovery stage** – continual reconciler: scans GHArchive hourly JSON.gz, checkpoints, and adds/updates repos that need processing.
3. **Acquisition stage** – processes repos that have the required discovery fields but are missing acquired config data (respects internal GitHub rate limiting).
4. **Future stages** – each new stage watches for rows that contain its input data and lack its output data, then performs its work.

All stages:

- Run concurrently via `Promise.all` in a single process.
- Use polite polling (`Bun.sleep()`) when idle.
- Log clearly when they start work on a row or are waiting.
- Handle their own errors/retries independently.
- Never block other stages.

## Outputs/Side Effects

- Updates `linter-configs.db`.
- Console logs (progress/stats, no JSON summary).
- Handles 304 cache, retries, rate limits (~80% utilization).

## Details

- Configs: ESLint `.eslintrc.*`, Oxlint `oxlint.config.*` etc.
- No deps (Bun natives). Edge: Skips >1y stale repos, 429/5xx.
