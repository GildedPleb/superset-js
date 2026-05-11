# superset-js

Continuous, concurrent collector and normalizer of real-world linter configurations from thousands of GitHub repositories.

Focuses first on **Oxlint**, with extensibility for ESLint, Biome, Prettier, etc.

Built with Bun + TypeScript.

## Quick Start

1. Clone the repo
2. `bun install`
3. Copy `.env.example` to `.env` and add your `GITHUB_TOKEN`
4. `bun run dev`

## Development

- `bun run dev` - run with watch mode
- `bun run type-check` - TypeScript check

## Architecture

See `AGENTS.md` and `extensible.md` for agent-friendly architecture and extension points.

## Deployment

This project publishes Docker images to `ghcr.io/gildedpleb/superset-js` automatically on every merge to `main`.
