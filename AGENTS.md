# AGENTS

## Overview

Continuous Bun/TS collector and normalizer for linter configs (Oxlint
today; ESLint, Biome, Prettier, etc. as paths land) from public GitHub
repos. Discovers via GHArchive PushEvents, fetches via GitHub API
(cached/rate-limited), dedups/gzips configs into SQLite DB
`linter-configs.db`, then normalizes one row at a time into a canonical
queryable shape. Runs indefinitely; the autonomous stages prioritize
pending/stale-good repos and purge old data, while the normalization
stage gates on operator review.

**Project goal**: a JavaScript "superset" rule corpus — mine real-world
configs across thousands of repos, vote on rules, resolve conflicts,
publish a unified rule set. Normalization produces the canonical input
to the voting/resolution/publishing stages.

## Pipeline Architecture

**Arbitrary N-stage concurrent data-driven pipeline.**

- Any number of stages can exist and be added ad-hoc.
- Each stage is a completely independent loop.
- All stages run **concurrently** in a single Bun process (`Promise.all`).
- Stage progression is driven purely by **database state** (presence /
  absence of specific fields on a row) — no explicit status flag is used
  for pipeline hand-off.
- This makes the code clean, extensible, and eliminates nested loops or
  shared control-flow flags while preserving the mental model of a
  straight linear pipeline.

Stages fall into two categories:

- **Autonomous stages** (retention, discovery, acquisition) run
  unattended at full speed. They handle their own errors and retries.
- **Operator-supervised stages** (normalization, today) gate on every
  attempted row. The operator hits ENTER on every save and every
  failure. See `extensible.md` for the contract.

## Directory Structure

```
superset-js/
├── linter-configs.db     # SQLite DB
├── AGENTS.md             # this file
├── extensible.md         # rules for extending normalization
├── migration-step.md     # original normalization design notes
└── src/
    ├── main.ts           # entry: starts all stages concurrently
    ├── pipeline/
    │   ├── acquisition.ts
    │   ├── discovery.ts
    │   ├── retention.ts
    │   └── normalization/
    │       ├── index.ts   # loop, dispatch, gating, logging
    │       ├── types.ts   # NormalizedConfig, ConfigBlock, RuleSetting
    │       └── oxlint.ts  # native oxlint JSON normalizer (only path today)
    ├── services/
    │   ├── db.ts
    │   ├── gharchive.ts
    │   ├── github.ts
    │   └── logger.ts
    └── utils/
        └── http.ts
```

When a new normalization path lands (eslint, biome, prettier, …) it
adds **one file** to `pipeline/normalization/`. See `extensible.md`.

## DB Schema

- `repos`: `full_name`(PK), `status`(pending/good/no-config/gone),
  `last_checked`, `last_pushed`
- `configs`: `(full_name, filename)`(PK), `content_hash`(SHA256), `sha`,
  `pushed_at`
- `config_blobs`: `hash`(PK), `content_blob`(gzipped), `content_bytes`
- `normalized_configs`: `(full_name, filename, content_hash)`(PK),
  `normalized_json`, `normalized_at`
- `http_cache`: `cache_key`(PK), `etag`, `last_modified`, …
- `app_state`: `key`(PK), `value` (e.g. "checkpoint_hour")

The `acquisition.ts` stage already pulls `package.json` and
`tsconfig.json` alongside lint configs (stored as additional `configs`
rows) so future eslint normalization has the deps it needs.

## Run Commands

- Required env: `GITHUB_TOKEN` (classic PAT).
- `bun src/main.ts` — runs all stages concurrently. Ctrl+C stops.
  Network-heavy in steady state. Normalization gates on ENTER for every
  attempted row, so foreground attention is required when the
  normalization queue is non-empty.

## Workflow (main.ts)

`main.ts` starts every stage concurrently:

1. **Retention stage** — periodically purges >365d configs and unused
   blobs.
2. **Discovery stage** — continual reconciler: scans GHArchive hourly
   JSON.gz, checkpoints, adds/updates repos that need processing.
3. **Acquisition stage** — processes repos that need their configs
   fetched. Honors GitHub rate limits (~80% utilization). Pulls lint
   configs + `package.json` + `tsconfig.json`. Handles 304s, including
   one-shot cache invalidation when a 304-cached file list is missing
   `package.json` (the legacy backlog gets fixed by single-row PK cache
   delete).
4. **Normalization stage** — pulls one un-normalized config row whose
   filename matches a currently-supported kind (today: native oxlint
   JSON), runs the normalizer, gates on ENTER, then writes. See
   `extensible.md` for the contract and how to extend.

All autonomous stages:

- Use polite polling (`Bun.sleep()`) when idle.
- Log clearly when they start work on a row or are waiting.
- Handle their own errors/retries independently.
- Never block other stages.

## Outputs / Side Effects

- Writes to `linter-configs.db`.
- Console logs (progress/stats, structured failure blocks for
  normalization).
- Handles 304 cache, retries, rate limits (~80% utilization).

## Invariants

These hold across all stages and must never be broken without explicit
direction:

- **No deps.** Bun natives only. Anything else is a deliberate decision
  with an explicit reason.
- **No schema changes** without explicit user direction. Migrations are
  out of scope for any single stage's work.
- **No editing prod data** It's fine to inspect the database, but do not
  f\*cking edit prod-data without explicit user direction.
- **Stages don't couple.** A stage reads the DB and writes the DB. It
  does not call into other stages or share in-memory state with them.
- **Autonomous stages fail and retry on their own.** Operator-supervised
  stages gate on ENTER for every attempted row.
- **Data-driven progression.** Stages decide what to do based on
  database state alone — no flags passed between stages.
- **Idempotent.** Every stage's work is restartable. Partial work is
  never written.

## Details

- Lint configs targeted: native oxlint JSON today; ESLint legacy + flat,
  Biome, Prettier, native oxlint TS as future paths.
- Sidecars acquired alongside lint configs: `package.json`,
  `tsconfig.json`. Stored as additional `configs` rows (no schema
  change).
- Stale repo handling: skips >1y-stale repos; 429/5xx are transient and
  retried.
- Normalization is operator-supervised; see `extensible.md` for the
  full contract and the rules for extending it.
