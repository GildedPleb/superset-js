#!/usr/bin/env bash
#
# dev-normalization.sh
# One-command local development helper for superset-js.
#
# - Port-forwards your cluster MinIO (minio namespace, svc/minio:9000)
# - Restores a fresh snapshot of prod DB using litestream
# - Runs bun src/main.ts with ENABLE_INGESTION=false + only the
#   normalization pathway flag(s) you are currently developing.
# - Traps cleanup of port-forward on exit.
#
# Usage examples:
#   ./scripts/dev-normalization.sh
#   ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh
#   ENABLE_NORMALIZATION_OXLINT_RAW=true ENABLE_NORMALIZATION_OXLINT_JS_DEPS=false ./scripts/dev-normalization.sh
#
# Prerequisites:
#   - kubectl with access to your K3s cluster
#   - litestream CLI installed (go install github.com/benbjohnson/litestream/cmd/litestream@latest)
#   - MinIO bucket created (default: superset-js)
#   - Local ./data/ directory will be created
#
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration (override via env if needed)
# ─────────────────────────────────────────────────────────────────────────────
MINIO_NAMESPACE="${MINIO_NAMESPACE:-minio}"
MINIO_SERVICE="${MINIO_SERVICE:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_LOCAL_PORT="${MINIO_LOCAL_PORT:-9000}"

BUCKET="${BUCKET:-superset-js}"
DB_NAME="${DB_NAME:-superset.db}"

LOCAL_DATA_DIR="./data"
LOCAL_DB_PATH="${LOCAL_DATA_DIR}/${DB_NAME}"

# Lit estream will use these (or a litestream.yml). We use flags for simplicity in dev.
LITESTREAM_ENDPOINT="http://localhost:${MINIO_LOCAL_PORT}"

# Default flags for this dev session (override on command line)
ENABLE_INGESTION="${ENABLE_INGESTION:-false}"
ENABLE_NORMALIZATION_OXLINT_RAW="${ENABLE_NORMALIZATION_OXLINT_RAW:-false}"
ENABLE_NORMALIZATION_OXLINT_JS_DEPS="${ENABLE_NORMALIZATION_OXLINT_JS_DEPS:-false}"

# You can pass additional ENABLE_* vars on the command line; they will be preserved.

echo "=== superset-js local normalization development helper ==="
echo "MinIO:        ${MINIO_NAMESPACE}/${MINIO_SERVICE}:${MINIO_PORT} → localhost:${MINIO_LOCAL_PORT}"
echo "Bucket:       ${BUCKET}"
echo "Local DB:     ${LOCAL_DB_PATH}"
echo ""
echo "Flags for this session:"
echo "  ENABLE_INGESTION=${ENABLE_INGESTION}"
echo "  ENABLE_NORMALIZATION_OXLINT_RAW=${ENABLE_NORMALIZATION_OXLINT_RAW}"
echo "  ENABLE_NORMALIZATION_OXLINT_JS_DEPS=${ENABLE_NORMALIZATION_OXLINT_JS_DEPS}"
echo ""
echo "Any extra ENABLE_* vars you exported will also be passed through."
echo ""

# Create local data dir
mkdir -p "${LOCAL_DATA_DIR}"

# ─────────────────────────────────────────────────────────────────────────────
# Port-forward MinIO (background)
# ─────────────────────────────────────────────────────────────────────────────
echo "Starting port-forward to MinIO..."
kubectl port-forward -n "${MINIO_NAMESPACE}" "svc/${MINIO_SERVICE}" "${MINIO_LOCAL_PORT}:${MINIO_PORT}" >/tmp/minio-portforward.log 2>&1 &
PF_PID=$!

# Cleanup trap
cleanup() {
  echo ""
  echo "Cleaning up port-forward (pid ${PF_PID})..."
  kill "${PF_PID}" 2>/dev/null || true
  wait "${PF_PID}" 2>/dev/null || true
  echo "Port-forward stopped."
}
trap cleanup EXIT INT TERM

# Give port-forward a moment to establish
sleep 2

if ! kill -0 "${PF_PID}" 2>/dev/null; then
  echo "ERROR: Port-forward failed to start. Check /tmp/minio-portforward.log"
  exit 1
fi

echo "Port-forward running (pid ${PF_PID})."

# ─────────────────────────────────────────────────────────────────────────────
# Restore latest snapshot from MinIO using litestream
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Restoring latest DB snapshot from MinIO (this may take a while for large DBs)..."

# We use a minimal inline config via environment for the restore.
# For more advanced needs, create a local litestream.yml and pass -config.
litestream restore \
  -url "${LITESTREAM_ENDPOINT}" \
  -bucket "${BUCKET}" \
  -path "${LOCAL_DB_PATH}" \
  "${LOCAL_DB_PATH}" || {
    echo ""
    echo "WARNING: litestream restore failed or no snapshot exists yet."
    echo "If this is the first run, the local DB will be created empty."
    echo "You can also seed manually or wait for prod to replicate first."
    echo ""
  }

if [[ -f "${LOCAL_DB_PATH}" ]]; then
  echo "Restore complete (or file already existed)."
  ls -lh "${LOCAL_DB_PATH}"
else
  echo "No existing snapshot restored — starting with fresh/empty local DB."
fi

echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Run the application with the desired flags
# ─────────────────────────────────────────────────────────────────────────────
echo "Starting superset-js with targeted flags..."
echo "Command: DB_PATH=${LOCAL_DB_PATH} ENABLE_INGESTION=${ENABLE_INGESTION} ... bun src/main.ts"
echo ""

# Preserve all ENABLE_* and other relevant vars, override DB_PATH
env \
  DB_PATH="${LOCAL_DB_PATH}" \
  ENABLE_INGESTION="${ENABLE_INGESTION}" \
  ENABLE_NORMALIZATION_OXLINT_RAW="${ENABLE_NORMALIZATION_OXLINT_RAW}" \
  ENABLE_NORMALIZATION_OXLINT_JS_DEPS="${ENABLE_NORMALIZATION_OXLINT_JS_DEPS}" \
  bun src/main.ts

# Script ends here — trap will fire and clean up port-forward
