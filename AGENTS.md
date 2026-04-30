# AGENTS

## Overview
Continuous Bun/TS collector for linter configs (ESLint/Oxlint) from public GitHub repos. Discovers via GHArchive PushEvents, fetches via GitHub API (cached/rate-limited), dedups/gzips configs into SQLite DB `linter-configs.db`. Runs indefinitely: prioritizes pending/stale-good repos, purges old data.

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
- `repos`: `full_name`(PK), `status`(pending/good/no-config/gone/stale), `last_checked`, `last_pushed`
- `configs`: `full_name`, `filename`(PK), `content_hash`(SHA256), `sha`, `pushed_at`
- `config_blobs`: `hash`(PK), `content_blob`(gzipped), `content_bytes`
- `http_cache`: `cache_key`(PK), `etag`, `last_modified`, etc.
- `app_state`: `key`(PK), `value` (e.g., "checkpoint_hour")

## Run Commands
- Req: `GITHUB_TOKEN` (classic PAT).
- `bun src/main.ts` (continuous; Ctrl+C stop). Network-heavy.

## Workflow (main.ts)
1. Retention: Purge >365d configs/unused blobs.
2. Discovery: Init/checkpoint from GHArchive hourly JSON.gz → enqueue pending repos.
3. Loop: Pending (≤120 newest) or stale-good (>30d); `acquireRepo` per repo:
   - Skip gone/stale/transient.
   - Fetch `contents/`, configs (10 filenames), base64→hash→gzip→store; mark good.
4. Stats/logs every 50 checks. Idle: 5min sleep.

## Outputs/Side Effects
- Updates `linter-configs.db`.
- Console logs (progress/stats, no JSON summary).
- Handles 304 cache, retries, rate limits (~80% utilization).

## Details
- Configs: ESLint `.eslintrc.*`, Oxlint `oxlint.config.*` etc.
- No deps (Bun natives). Edge: Skips >1y stale repos, 429/5xx.
