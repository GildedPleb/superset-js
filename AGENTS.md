# AGENTS

## What this repo does
- Bun entrypoint `src/main.ts` collects lint configs from GitHub and stores them in a local SQLite DB `linter-configs.db`.
- Config content is gzipped + deduped in `config_blobs`, while `configs` keeps per-repo votes via `content_hash`.

## Run commands
- Requires `GITHUB_TOKEN` (classic PAT) or the script throws.
- Run collector: `bun src/main.ts`.

## Outputs and side effects
- Writes/updates `linter-configs.db` and `last-run-summary.json` in repo root.
- Network-heavy: pulls GHArchive data and GitHub API on each run.
