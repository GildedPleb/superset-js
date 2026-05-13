# superset-js: Kubernetes Deployment + Granular Normalization Feature Flags Tech Spike

**Status**: In PR review (branch: `feature/k8s-deployment-granular-normalization`)  
**Date**: 2026-05-13  
**Owner**: Gilded Pleb (@gildedpleb)  
**Goal**: Production-ready deployment to local K3s (Longhorn + existing MinIO) while enabling excellent local development against fresh production data snapshots. Support **incremental, granular rollout** of normalization pathways via independent environment variable feature flags.

Everything below is self-contained. Changes are minimal, reversible, and focused on clarity + safety.

---

## High-Level Architecture (Final Chosen Design)

### Production (K3s Cluster)
- **Namespace**: `superset-js`
- **Deployment** `superset-js` (replicas=1):
  - **Primary Container** (`superset-js`):
    - Image: `ghcr.io/gildedpleb/superset-js:latest` (`imagePullPolicy: Always`)
    - Mounts PVC `superset-js-data` at `/data`
    - `DB_PATH=/data/superset.db`
    - Granular stage & pathway flags via env vars (see below)
    - `GITHUB_TOKEN` from Secret
  - **Litestream Sidecar** (same pod, shares PVC):
    - Image: `litestream/litestream` (stable)
    - Continuously replicates WAL-mode SQLite changes to MinIO bucket (point-in-time recovery)
    - Config via env vars / mounted ConfigMap + Secret (MinIO endpoint, keys, bucket)
  - **Why single pod?** Explicit requirement: "all the data pre-processing services working in unison on the same pod and PVC". Avoids SQLite concurrency issues and extra complexity.
- **PVC**: `superset-js-data`, 5Gi, `ReadWriteOnce`, Longhorn (default storageClass)
- **Secret**: `superset-js-secrets` (or templated) containing `GITHUB_TOKEN` + MinIO access/secret keys
- **Service**: Optional initially (no external traffic yet)
- **No liveness/readiness probes** initially (add when HTTP endpoint exists)

### Local Development Workflow (One Command)
```bash
# Example: develop only the raw oxlint normalization pathway
ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh
```

`scripts/dev-normalization.sh` does:
1. Background `kubectl port-forward -n minio svc/minio 9000:9000`
2. `litestream restore` (using local Litestream CLI + config pointing at `http://localhost:9000`)
3. Run `bun src/main.ts` with:
   - `ENABLE_INGESTION=false` (zero GitHub quota on laptop)
   - Only the specific normalization feature flag(s) you are developing
   - `DB_PATH=./data/superset.db`
4. Trap cleans up port-forward on exit

**Result**: Every dev session starts with a **fresh, consistent snapshot** of prod data. Code path for DB access is **identical** to prod (`openDb()` direct). Local writes are overwritten on next run (by design — prioritizes freshness).

Ingestion disabled locally → laptop uses **zero** GitHub quota. Prod pod retains 100% of quota.

### Stage Control & Granular Feature Flags (Env Vars
**Coarse-grained (always present)**:
- `ENABLE_INGESTION=true` (default in Helm for prod). Controls the entire ingestion/discover/acquire/retention pathways + quota usage.

**Granular normalization feature flags** (naming: `ENABLE_NORMALIZATION_<PATHWAY>`):
- `ENABLE_NORMALIZATION_OXLINT_RAW` — oxlint configs without JS dependencies (first target)
- `ENABLE_NORMALIZATION_OXLINT_JS_DEPS` — oxlint configs that include JS dependencies (next)
- Later examples: `ENABLE_NORMALIZATION_ESLINT`, `ENABLE_NORMALIZATION_BIOME`, `ENABLE_NORMALIZATION_PRETTIER`, etc.

**In `main.ts`** (this PR):
- Read flags with sensible defaults.
- Log **exactly** which ingestion components and which normalization pathways are active on every start.
- Conditionally start only the enabled top-level stages.
- Normalization coordinator still runs when any pathway flag is true; finer intra-pathway branching can be added inside `src/pipeline/normalization/` later.

**Progressive rollout workflow** (the key value of granular flags):
1. Develop `ENABLE_NORMALIZATION_OXLINT_RAW` locally against snapshot.
2. Enable it in prod Helm values → deploy.
3. Prod normalization now processes raw oxlint while ingestion continues 24/7.
4. Develop next pathway (`ENABLE_NORMALIZATION_OXLINT_JS_DEPS`) locally.
5. Enable it in prod.
6. Repeat.

Production data stays continuously up-to-date with development progress. No monolithic flag forcing "enable everything at once". Each flag addition is a small, low-risk change.

**In Helm `values.yaml`** (future chart):
```yaml
enable:
  ingestion: true
  normalization:
    oxlintRaw: false      # set to true only after pathway is complete & tested
    oxlintJsDeps: false
```

Easy to extend: new flag = new env var in values + one conditional in code + docs update.

---

## Implementation Plan (Phased, This PR = Phase 0 + Phase 1)

### Phase 0: Kickoff & Prep (Done)
- Inspected current code (`src/main.ts`, `package.json`, `Dockerfile`, normalization pipeline structure, etc.).
- Confirmed understanding of granular flag design and single-pod + snapshot dev workflow.
- This document created.

### Phase 1: Application Changes (This PR)
**Files changed/added**:
- `src/main.ts` — Added coarse + granular flags, excellent logging, conditional stage startup.
- `package.json` — Added `"dev:normalization": "scripts/dev-normalization.sh"`
- `scripts/dev-normalization.sh` (new, executable) — One-command dev workflow using your MinIO service.
- `litestream.yml` (new, example) — Reference config for local restore / prod sidecar.
- `.env.example` — Documented new flags + dev usage.
- `README.md` — Added pointer to new docs + quick dev command.
- `docs/architecture-and-implementation-plan.md` (this file) — Full self-contained reference.

**How to add a new normalization pathway / feature flag** (documented for future you):
1. Add the new `ENABLE_NORMALIZATION_XXX` const + log line in `src/main.ts`.
2. (Optional) Add conditional logic inside `src/pipeline/normalization/` if the pathway needs internal enable/disable.
3. Add the flag to Helm `values.yaml` + deployment template env injection (future).
4. Update this doc + `.env.example`.
5. Deploy with flag set to `true` **only after** the pathway is complete and tested locally against snapshot.
6. (Optional) Later consolidate completed flags under a parent `ENABLE_NORMALIZATION` if desired.

### Phase 2: Helm Chart (Next, after this PR merged/reviewed)
Create `charts/superset-js/` in https://github.com/GildedPleb/helm-charts following your existing GitHub Pages pattern:
- `Chart.yaml`, `values.yaml` (with `enable.ingestion`, `enable.normalization.*`, litestream section, persistence, resources)
- `templates/deployment.yaml` (primary + sidecar, env injection from values + Secret)
- `templates/pvc.yaml`, `secret.yaml` (or external secret notes), `configmap.yaml` (litestream fragments), `NOTES.txt`
- Excellent `README.md` / chart docs covering:
  - Prerequisites (namespace, Secret creation)
  - `helm install` / `helm upgrade` / `helm uninstall` commands
  - How to create/update the Secret
  - Feature flag toggling examples for progressive rollout
  - Data migration notes
  - Troubleshooting (Litestream, PVC, logs)
- Update your root helm-charts README if needed.

**Secrets approach** (per your request for clear long-term docs):
- Chart will include a `secret.yaml` template (disabled by default or with placeholders).
- Primary documented path: Create Secret manually once:
  ```bash
  kubectl create secret generic superset-js-secrets \
    --namespace superset-js \
    --from-literal=GITHUB_TOKEN=ghp_xxx \
    --from-literal=MINIO_ACCESS_KEY=xxx \
    --from-literal=MINIO_SECRET_KEY=xxx
  ```
- Or use `--set` on install for one-liner (documented).
- Future: sealed-secrets or external-secrets operator can be layered on top. The chart README will have a dedicated "Secrets & Credentials" section that survives "I forgot what I installed".

### Phase 3: First Deployment + Data Migration (After chart review)
- User creates namespace + Secret.
- `helm install superset-js gildedpleb/superset-js --namespace superset-js --create-namespace`
- Verify pod, logs (ingestion running), PVC, Litestream replicating to MinIO.
- **One-time safe 1.5 GB data migration** (documented in chart NOTES + this doc):
  - Option A (recommended): Use a debug pod with `sqlite3` + `.backup` to MinIO or direct restore.
  - Option B: Litestream tooling for initial seed.
  - Never use plain `cp` on live WAL files.

### Phase 4–5: Dev Workflow Polish, Testing, Handoff
- End-to-end tests (prod ingestion + targeted normalization dev sessions).
- Resource defaults, comments, logging polish.
- Final review on PR.
- User can then develop normalization pathways incrementally while prod runs safely 24/7 with continuous backups.

---

## Technical Guardrails (Followed)
- Safe DB handling only (Litestream or `sqlite3 .backup`).
- Keep changes minimal and focused.
- Prioritize clarity in logs and docs (especially active flags).
- Everything reproducible from the two GitHub repos.
- New flags are additive and low-risk.
- All changes in this PR on a feature branch (never direct to `main`).

---

## Local Testing of Flags (After PR checkout)
```bash
git checkout feature/k8s-deployment-granular-normalization
bun install

# Test ingestion disabled + one pathway
ENABLE_INGESTION=false ENABLE_NORMALIZATION_OXLINT_RAW=true DB_PATH=./data/superset.db bun src/main.ts

# Or use the helper (once you have litestream + kubectl access + MinIO bucket)
./scripts/dev-normalization.sh
```

Expected logs clearly show exactly which stages/pathways started.

---

## Data & Backup Notes
- Prod: `/data/superset.db` (WAL) on PVC + Litestream → MinIO (continuous, PITR capable).
- Local dev: Fresh restore from MinIO snapshot on every run.
- The ~1.5 GB corpus represents significant GitHub API quota investment — protected by design.

---

## Next Steps After This PR
1. Review this PR + approve/merge.
2. I will create the Helm chart in your `helm-charts` repo (on its own feature branch) with excellent install/update/delete/secret docs.
3. You create namespace + Secret in cluster.
4. `helm install` (after your approval of chart).
5. One-time data migration.
6. Start using `./scripts/dev-normalization.sh ENABLE_NORMALIZATION_OXLINT_RAW=true` for targeted development.

---

**Tradeoffs & Rationale (Why Granular Flags Win)**
- Granular flags give you precise control for incremental development without forcing a monolithic enable or separate dev deployment.
- Snapshot-based dev (eventual consistency) is an acceptable tradeoff for zero quota burn, identical code paths, and simplicity.
- Single pod + sidecar matches your "in unison on the same pod/PVC" requirement exactly.
- Litestream + MinIO gives robust continuous backup + fast restores vs. periodic manual copies.
- All future stages follow the same pattern.

This design keeps the system simple, observable, and perfectly aligned with how you want to develop normalization pathways going forward.

Questions or tweaks? Open discussion on the PR. Let's get this shipped cleanly.