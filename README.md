# superset-js

A high-performance, concurrent data pipeline for collecting and normalizing linter configurations (starting with Oxlint) from thousands of GitHub repositories.

Built with Bun + TypeScript. Uses GHArchive + GitHub API for efficient large-scale data collection.

## Features
- Concurrent scraping pipeline
- SQLite storage with normalized schema
- Extensible architecture (see `AGENTS.md` and `extensible.md`)
- Focused on linter configs (Oxlint, ESLint, etc.)

## Quick Start

1. Clone the repo
   ```bash
   git clone https://github.com/gildedpleb/superset-js.git
   cd superset-js
   ```

2. Install dependencies
   ```bash
   bun install
   ```

3. Set up your GitHub token
   ```bash
   cp .env.example .env
   # Edit .env and add your GITHUB_TOKEN
   ```

4. Run the pipeline
   ```bash
   bun src/main.ts
   ```

## Development

```bash
# Type check
bun run typecheck

# Run with watch mode
bun run dev

# Build
bun run build
```

## Architecture

See `AGENTS.md` and `extensible.md` for details on how to extend the pipeline with new normalizers, sources, etc.

## License
MIT
