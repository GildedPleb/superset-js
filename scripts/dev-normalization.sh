#!/usr/bin/env bash
#
# dev-normalization.sh
# One-command local development helper for superset-js.
#
# Features:
# - Auto-loads .env file if present (so you don't have to source it manually)
# - Checks that required tools (kubectl, litestream) are installed
# - Port-forwards your cluster MinIO (minio namespace, svc/minio:9000)
# - Restores a fresh snapshot of prod DB using litestream (supports credentials)
# - Runs bun src/main.ts with ENABLE_INGESTION=false + only the
#   normalization pathway flag(s) you are currently developing.
# - Traps cleanup of port-forward on exit.
#
# Usage:
#   ./scripts/dev-normalization.sh
#   ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh
#   MINIO_ACCESS_KEY=xxx MINIO_SECRET_KEY=yyy ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh
#
# Prerequisites (script will exit early with instructions if missing):
#   - kubectl with access to your K3s cluster
#   - litestream CLI → brew tap benbjohnson/litestream && brew install litestream
#   - MinIO bucket created (default: superset-js)
#   - .env file with MINIO_ACCESS_KEY / MINIO_SECRET_KEY (and any ENABLE_* flags)
#
set -euo pipefail

# ─────────────────────────────────────────────
# Auto-load .env if it exists (convenience so you don't have to `source .env`)
# Variables from .env can still be overridden by passing them on the command line.
# ─────────────────────────────────────
if [[ -f ".env" ]]; then
  echo "Loading environment variables from .env ..."
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

# ─────────────────────────────────────────────
# Prerequisite checks (fail fast with helpful instructions)
# ─────────────────────────────────────
command -v kubectl >/dev/null 2>&1 || {
  echo "ERROR: 'kubectl' is not installed or not on your PATH."
  echo ""
  echo "Please install kubectl and ensure it can access your K3s cluster."
  echo "  macOS:   brew install kubectl"
  echo "  Linux:   https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/"
  echo ""
  exit 1
}

command -v litestream >/dev/null 2>&1 || {
  echo "ERROR: 'litestream' CLI is not installed or not on your PATH."
  echo ""
  echo "Please install it (easiest on macOS):"
  echo "  brew tap benbjohnson/litestream"
  echo "  brew install litestream"
  echo ""
  echo "Alternative:"
  echo "  go install github.com/benbjohnson/litestream/cmd/litestream@latest"
  echo ""
  exit 1
}

# ─────────────────────────────────────────────
# Configuration (override via env if needed)
# ─────────────────────────────────────
MINIO_NAMESPACE="${MINIO_NAMESPACE:-minio}"
MINIO_SERVICE="${MINIO_SERVICE:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_LOCAL_PORT="${MINIO_LOCAL_PORT:-9000}"

BUCKET="${BUCKET:-superset-js}"
DB_NAME="${DB_NAME:-superset.db}"

LOCAL_DATA_DIR="./data"
LOCAL_DB_PATH="${LOCAL_DATA_DIR}/${DB_NAME}"

LITESTREAM_ENDPOINT="http://localhost:${MINIO_LOCAL_PORT}"

# MinIO credentials for local restore
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-${LITESTREAM_ACCESS_KEY_ID:-}}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-${LITESTREAM_SECRET_ACCESS_KEY:-}}"

# Normalization feature flags (default to false for safe local dev)
ENABLE_INGESTION="${ENABLE_INGESTION:-false}"
ENABLE_NORMALIZATION_OXLINT_RAW="${ENABLE_NORMALIZATION_OXLINT_RAW:-false}"
ENABLE_NORMALIZATION_OXLINT_JS_DEPS="${ENABLE_NORMALIZATION_OXLINT_JS_DEPS:-false}"

echo ""
echo "=== superset-js local normalization development helper ==="
echo "MinIO:        ${MINIO_NAMESPACE}/${MINIO_SERVICE}:${MINIO_PORT} → localhost:${MINIO_LOCAL_PORT}"
echo "Bucket:       ${BUCKET}"
echo "Local DB:     ${LOCAL_DB_PATH}"
echo ""
echo "Active flags:"
echo "  ENABLE_INGESTION=${ENABLE_INGESTION}"
echo "  ENABLE_NORMALIZATION_OXLINT_RAW=${ENABLE_NORMALIZATION_OXLINT_RAW}"
echo "  ENABLE_NORMALIZATION_OXLINT_JS_DEPS=${ENABLE_NORMALIZATION_OXLINT_JS_DEPS}"
echo ""

if [[ -n "$MINIO_ACCESS_KEY" ]]; then
  echo "MinIO credentials: loaded"
else
  echo "MinIO credentials: NOT FOUND (set MINIO_ACCESS_KEY / MINIO_SECRET_KEY in .env)"
fi
echo ""

# Create local data dir
mkdir -p "${LOCAL_DATA_DIR}"

# ─────────────────────────────────────────────
# Port-forward MinIO (background)
# ─────────────────────────────────────
echo "Starting port-forward to MinIO..."
kubectl port-forward -n "${MINIO_NAMESPACE}" "svc/${MINIO_SERVICE}" "${MINIO_LOCAL_PORT}:${MINIO_PORT}" >/tmp/minio-portforward.log 2>&1 &
PF_PID=$!

cleanup() {
  echo ""
  echo "Cleaning up port-forward (pid ${PF_PID})..."
  kill "${PF_PID}" 2>/dev/null || true
  wait "${PF_PID}" 2>/dev/null || true
  echo "Port-forward stopped."
}
trap cleanup EXIT INT TERM

sleep 2

if ! kill -0 "${PF_PID}" 2>/dev/null; then
  echo "ERROR: Port-forward failed to start. Check /tmp/minio-portforward.log"
  exit 1
fi

echo "Port-forward running (pid ${PF_PID})."

# ─────────────────────────────────────────────
# Restore latest snapshot from MinIO using litestream
# ─────────────────────────────────────

echo ""
echo "Restoring latest DB snapshot from MinIO..."

RESTORE_ARGS=(
  -url "${LITESTREAM_ENDPOINT}"
  -bucket "${BUCKET}"
  -path "${LOCAL_DB_PATH}"
)

if [[ -n "$MINIO_ACCESS_KEY" && -n "$MINIO_SECRET_KEY" ]]; then
  RESTORE_ARGS+=( -access-key-id "$MINIO_ACCESS_KEY" -secret-access-key "$MINIO_SECRET_KEY" )
fi

litestream restore "${RESTORE_ARGS[@]}" "${LOCAL_DB_PATH}" || {
  echo ""
  echo "WARNING: litestream restore failed or no snapshot exists yet."
  echo "Continuing with whatever is in ${LOCAL_DB_PATH} (may be empty on first run)."
  echo ""
}

if [[ -f "${LOCAL_DB_PATH}" ]]; then
  echo "DB ready: $(ls -lh \"${LOCAL_DB_PATH}\" | awk '{print $5, $9}')"
else
  echo "No DB file present yet — starting fresh."
fi

echo ""

# ─────────────────────────────────────────────
# Run the application
# ─────────────────────────────────────
echo "Starting superset-js..."
echo ""

env \
  DB_PATH="${LOCAL_DB_PATH}" \
  ENABLE_INGESTION="${ENABLE_INGESTION}" \
  ENABLE_NORMALIZATION_OXLINT_RAW="${ENABLE_NORMALIZATION_OXLINT_RAW}" \
  ENABLE_NORMALIZATION_OXLINT_JS_DEPS="${ENABLE_NORMALIZATION_OXLINT_JS_DEPS}" \
  bun src/main.ts
