# Architecture & Implementation Plan: superset-js on K3s (with Granular Normalization Flags)

**Status**: Phase 1 complete (feature flags + dev workflow + docs). Helm chart & cluster deploy in next phase.
**Date**: 2026-05-13
**Owner**: Gilded Pleb (@gildedpleb)
**Goal**: Production-ready deployment to local K3s while enabling excellent incremental local development against fresh prod data.

---

## Project Overview & Current State (Inspected)

- **Main App Repo**: https://github.com/gildedpleb/superset-js
  - Bun.js (TypeScript) long-running concurrent pipeline.
  - Stages: Ingestion (discovery via GHArchive, acquisition, retention) + Normalization (being broken into granular pathways: oxlint raw, oxlint+JS-deps, eslint, biome, prettier, ...).
  - Storage: SQLite WAL mode (`superset.db*` files, currently ~1.5 GB locally — significant GitHub quota investment).
  - Config: `GITHUB_TOKEN` (classic PAT), `DB_PATH` env var supported.
  - Runtime: `bun src/main.ts`. Dockerfile on `oven/bun:1` (non-root).
  - CI: Builds & pushes `ghcr.io/gildedpleb/superset-js:latest` + SHA tag.
  - **Current state (pre-spike)**: Fully working locally only. No K8s, no Helm, no feature flags.

- **Helm Charts Repo**: https://github.com/GildedPleb/helm-charts (uses GitHub Pages: `helm repo add gildedpleb https://gildedpleb.github.io/helm-charts`).
- **Cluster**: Local K3s + Longhorn (RWO PVCs). Existing single-container MinIO (S3-compatible) in `minio` namespace.
- **Target Namespace**: `superset-js`

## Goals

Deploy production-ready to K3s while preserving the ability to develop normalization (and future) stages **locally against fresh production data** without:
- Diverging databases
- Burning GitHub quota on the laptop
- Maintaining separate code paths

All pre-processing stages must continue to run "in unison" on the **same pod and PVC** in production.

**Key new capability**: Support **incremental, granular rollout of normalization pathways** via independent `ENABLE_NORMALIZATION_<PATHWAY>` environment variable feature flags. This allows:
- Develop one pathway (e.g. raw oxlint configs)
- Enable it in production
- Move to the next (oxlint with JS dependencies)
- Keep production data continuously up-to-date

## High-Level Architecture (Final Chosen Design)

### Production (K3s Cluster)
- **Namespace**: `superset-js`
- **Deployment** `superset-js` (replicas=1 initially):
  - **Primary Container** (`superset-js`):
    - Image: `ghcr.io/gildedpleb/superset-js:latest` (`imagePullPolicy: Always`)
    - Mounts PVC `superset-js-data` at `/data`
    - `DB_PATH=/data/superset.db`
    - Granular stage & feature flags via env vars (see below)
    - `GITHUB_TOKEN` from Secret
  - **Litestream Sidecar** (same pod, shares PVC):
    - Image: `litestream/litestream` (stable)
    - Continuously replicates WAL from `/data/superset.db` to MinIO bucket.
    - Why one pod? Matches explicit requirement that all stages work "in unison on the same pod/PVC". Avoids SQLite multi-writer problems.
- **PVC**: `superset-js-data`, 5Gi, `ReadWriteOnce`, Longhorn default storageClass.
- **Secret**: `superset-js-secrets` (or templated) containing `GITHUB_TOKEN` + MinIO access/secret keys.
- **Service**: Optional initially (add later for internal/debug access).

### Local Development Workflow (One-Command, Zero Quota)
Command: `ENABLE_INGESTION=false ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh`

The script:
1. Background `kubectl port-forward -n minio svc/minio 9000:9000`
2. `litestream restore` using local Litestream CLI + config pointing at `http://localhost:9000` + your MinIO credentials + bucket.
3. Runs `bun src/main.ts` with `DB_PATH=./data/superset.db` + your chosen flags (ingestion disabled, only the pathway(s) you are developing enabled).

**Result**: Every dev session starts with a **fresh, consistent snapshot** of prod data. Normalization code path is **identical** to prod (direct `openDb()`). Local writes are overwritten on next run (by design — prioritizes freshness).

Ingestion disabled locally → zero GitHub quota on laptop. Prod pod retains 100% quota.

### Stage Control & Granular Feature Flags (Env Vars)

**Coarse-grained**:
- `ENABLE_INGESTION=true` (default in prod Helm values)

**Granular normalization feature flags** (naming: `ENABLE_NORMALIZATION_<PATHWAY>`):
- `ENABLE_NORMALIZATION_OXLINT_RAW` — First target (oxlint configs without JS dependencies)
- `ENABLE_NORMALIZATION_OXLINT_JS_DEPS` — Next
- Later: `ENABLE_NORMALIZATION_ESLINT`, `ENABLE_NORMALIZATION_BIOME`, `ENABLE_NORMALIZATION_PRETTIER`, etc.

In `main.ts` (implemented in Phase 1):
- Read flags with sensible defaults.
- Log *exactly* which ingestion components and which normalization pathways are active.
- Conditionally start only the enabled top-level stages.
- Normalization coordinator still runs when any pathway flag is true; finer per-pathway branching can be added inside `src/pipeline/normalization/` as needed.

In production Helm `values.yaml`:
- Start with completed pathways set to `true`; others `false`.
- Easy to extend: new flag = small change in values + deployment template.

This enables true **progressive rollout** while production data stays fresh and aligned with development.

### Data & Backup
- Prod DB: `/data/superset.db` (WAL) on PVC.
- Litestream provides continuous, safe, point-in-time replication to MinIO **without stopping the writer**.
- Initial 1.5 GB migration: One-time safe process (debug pod + `sqlite3 .backup` or Litestream tooling) after first deploy.

## Key Decisions & Explicit Tradeoffs (Final — Do Not Revisit Unless Asked)

1. **Single Pod/PVC + Env Toggles (Chosen)** vs Separate Dev Deployment or Shared PVC
   - Chosen because user explicitly wants all stages "in unison on the same pods/PVCs in production".
   - Granular flags give fine-grained control without architectural split.
   - Tradeoff: Dev uses snapshots (eventual consistency). Simplicity + safety + fidelity win.

2. **Direct SQLite Access Everywhere (Chosen)** vs HTTP API for Dev
   - Chosen: All pathways always call `openDb(process.env.DB_PATH)` directly. No dual code paths.
   - Rejected HTTP approach (user explicitly disliked divergence).
   - Tradeoff: Snapshot restore for dev instead of live queries.

3. **Litestream Sidecar + MinIO (Chosen)** vs Periodic `kubectl cp` + backup
   - Chosen: Continuous replication, PITR, faster/smaller restores as DB grows, excellent FOSS.
   - Requires lightweight sidecar + dev script port-forward. Worth it for robustness.

4. **Helm in Existing `helm-charts` repo + GitHub Pages (Chosen)**
   - Matches user's established pattern exactly.

5. **Granular Normalization Flags (This Update)**
   - Enables the exact incremental workflow requested.
   - Far better than one big `ENABLE_NORMALIZATION` flag.

6. **DB name**: `superset.db` (confirmed fine).

Other: No probes initially. Resources configurable. Future stages follow same pattern.

## Detailed Implementation Plan (Phased Execution)

### Phase 0: Kickoff & Prep (COMPLETE)
- Inspected current code (`main.ts`, `package.json`, Dockerfile, normalization/ dir, etc.).
- Created this document.
- Proposed & received approval for flag handling in `main.ts`.
- Collected MinIO details (Service `minio` in namespace `minio`, port 9000) and confirmed first flag `ENABLE_NORMALIZATION_OXLINT_RAW`.

### Phase 1: Application Changes (COMPLETE — this commit)
- Added coarse `ENABLE_INGESTION` + granular `ENABLE_NORMALIZATION_*` flags in `src/main.ts`.
- Clear logging of exactly which pathways are active.
- Conditional stage startup (ingestion and/or normalization).
- Added `scripts/dev-normalization.sh` (port-forward + litestream restore + run with flags).
- Added example `litestream.yml`.
- Updated `package.json` with `"dev:normalization"` script.
- Updated `.env.example`.
- Local flag behavior can be tested with `bun run dev:normalization` after setting env vars.

### Phase 2: Helm Chart (Next — in helm-charts repo)
Create `charts/superset-js/`:
- `Chart.yaml`, `values.yaml` (with `enable.ingestion`, `enable.normalization.oxlintRaw`, etc., Litestream section, persistence, resources).
- `templates/deployment.yaml` (injects granular env vars from values + Secret).
- `templates/pvc.yaml`, `secret.yaml` (or external), `configmap.yaml` (Litestream), `NOTES.txt`.
- Excellent documentation for install/upgrade/delete (see below).

### Phase 3: First Deployment + Data Migration
- User creates namespace + Secret.
- `helm install superset-js gildedpleb/superset-js --namespace superset-js --create-namespace`
- Verify pod, logs, PVC, Litestream replicating.
- One-time safe data migration steps (documented).

### Phase 4: Dev Workflow, Testing, Documentation
- Polish dev script.
- Update main README with architecture, deploy instructions, "How to add a new normalization pathway" guide, troubleshooting.
- End-to-end tests.

### Phase 5: Polish & Handoff
- Resource defaults, comments, logging.
- Final review + PR guidance.

## How to Add a New Normalization Pathway / Feature Flag (Guide)

1. Add the new env var constant + logging in `src/main.ts` (follow the existing pattern for `ENABLE_NORMALIZATION_OXLINT_RAW`).
2. Add corresponding key under `enable.normalization.*` in Helm `values.yaml` + wire it into the Deployment env in the template.
3. (Optional but recommended) Add conditional logic inside `src/pipeline/normalization/` (e.g. `oxlint.ts` or new file) if the pathway needs internal branching.
4. Update `dev-normalization.sh` docs / examples if special handling needed.
5. Deploy/upgrade Helm release with the new flag set to `true` **only after** the pathway is complete and tested locally.
6. Update this doc and main README.

This keeps changes small, low-risk, and additive.

## Local Dev Workflow (Detailed)

```bash
# 1. Make sure you have kubectl access to your K3s cluster and litestream CLI
#    (go install github.com/benbjohnson/litestream/cmd/litestream@latest or download binary)

# 2. Set the flags you want for this dev session (example: only raw oxlint)
export ENABLE_INGESTION=false
export ENABLE_NORMALIZATION_OXLINT_RAW=true
# export ENABLE_NORMALIZATION_OXLINT_JS_DEPS=true   # when you're ready for the next pathway

# 3. Run the one-command dev script
./scripts/dev-normalization.sh

# Inside the script:
# - Port-forwards MinIO (minio namespace, svc minio, port 9000)
# - Runs litestream restore to ./data/superset.db (fresh prod snapshot)
# - Executes bun src/main.ts with your env vars + DB_PATH=./data/superset.db
```

**Important**:
- Local writes during a session are intentionally overwritten on the next run.
- A future "push snapshot back" helper can be added if needed.
- Always use the granular flags to keep dev focused.

## Production Deployment Notes (Helm Lifecycle — Critical for Long-Term Usability)

When the Helm chart is created, it will include **excellent, copy-paste-ready documentation** in:
- `charts/superset-js/README.md`
- `templates/NOTES.txt`

Expected content will cover:
- Prerequisites (create namespace, create Secret with GITHUB_TOKEN + MinIO keys)
- `helm repo add` command
- Full `helm install` example with common `--set` values (image tag, flags, resources)
- `helm upgrade` and `helm rollback`
- `helm uninstall` + notes on PVC/data retention (warn about data loss)
- How to view logs (`kubectl logs -l app=superset-js -c superset-js -f` and sidecar)
- Port-forward for local inspection or debugging
- Checking Litestream replication status
- Troubleshooting (common issues + solutions)
- How to update feature flags post-deploy

This ensures that months later you (or future you) can still install, update, and cleanly tear down the release without guessing.

## MinIO Details (from cluster)
- Service: `minio` in namespace `minio`
- API port: 9000 (ClusterIP)
- Console: 9001
- Used for: Litestream replication target (prod sidecar) and snapshot restore (local dev via port-forward)

## Troubleshooting & Safety
- Never use plain `cp` on live WAL files — always use Litestream or `sqlite3 .backup`.
- DB growth: Monitor via logs / Litestream.
- Feature flags: Check pod logs on start — they explicitly list what is enabled.
- Local dev: Ensure port-forward succeeds and you have MinIO credentials in env or config.

---

**Next step**: Create Helm chart in `helm-charts` repo (with outstanding install/upgrade/delete docs). Then first deploy + migration.

All changes are minimal, focused, and fully reproducible from the two GitHub repos.