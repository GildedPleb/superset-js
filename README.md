# superset-js

Continuous, concurrent collector and normalizer of real-world linter configurations from thousands of GitHub repositories.

Focuses first on **Oxlint**, with extensibility for ESLint, Biome, Prettier, etc.

Built with Bun + TypeScript.

## Quick Start (Local)

1. Clone the repo
2. `bun install`
3. Copy `.env.example` to `.env` and add your `GITHUB_TOKEN`
4. `bun run dev`

## Development

- `bun run dev` — run the full pipeline
- `bun run dev:normalization` — **recommended for normalization work** (uses fresh prod snapshot from MinIO + only enables the pathway(s) you are developing). See `scripts/dev-normalization.sh` and `docs/architecture-and-implementation-plan.md`.
- `bun run type-check` — TypeScript check
- `bun run test`

See `docs/architecture-and-implementation-plan.md` for the full Kubernetes deployment architecture, granular feature flag system, dev workflow, and Helm chart usage.

## Architecture

See `AGENTS.md`, `extensible.md`, and the new `docs/architecture-and-implementation-plan.md` for agent-friendly architecture, extension points, and the K8s + incremental normalization rollout design.

## Deployment

This project publishes Docker images to `ghcr.io/gildedpleb/superset-js` automatically on every merge to `main`.

Full production deployment to K3s (with Litestream sidecar + MinIO backups and granular normalization flags) is documented in `docs/architecture-and-implementation-plan.md`. A Helm chart will be added to https://github.com/GildedPleb/helm-charts shortly.
