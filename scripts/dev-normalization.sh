#!/usr/bin/env bash
#
# dev-normalization.sh
# One-command local development against a fresh production snapshot.
#
# Prerequisites:
#   - kubectl with access to your K3s cluster
#   - litestream CLI in PATH (go install github.com/benbjohnson/litestream/cmd/litestream@latest)
#   - MinIO credentials available (LITESTREAM_ACCESS_KEY_ID / LITESTREAM_ACCESS_KEY_SECRET or in litestream.yml)
#
# Usage (recommended):
#   ENABLE_INGESTION=false ENABLE_NORMALIZATION_OXLINT_RAW=true ./scripts/dev-normalization.sh
#
# Or export the flags first, then run the script.
#
# The script will:
#   1. Port-forward MinIO (svc/minio in namespace minio) to localhost:9000
#   2. Run litestream restore to ./data/superset.db (fresh prod data)
#   3. Execute bun src/main.ts with your env vars + DB_PATH=./data/superset.db
#
# Local writes are overwritten on next run (by design — prioritizes freshness over local experiments).

set -euo pipefail

MINIO_NAMESPACE="minio"
MINIO_SERVICE="minio"
LOCAL_PORT=9000
REMOTE_PORT=9000

echo "[dev-normalization] Starting port-forward to MinIO (${MINIO_NAMESPACE}/${MINIO_SERVICE}:${REMOTE_PORT})..."
kubectl port-forward -n "${MINIO_NAMESPACE}" "svc/${MINIO_SERVICE}" "${LOCAL_PORT}:${REMOTE_PORT}" > /tmp/minio-pf.log 2>&1 &
PF_PID=$!

echo "[dev-normalization] Port-forward PID: ${PF_PID} (logs: /tmp/minio-pf.log)"

cleanup() {
  echo "[dev-normalization] Cleaning up port-forward (PID ${PF_PID})..."
  kill "${PF_PID}" 2>/dev/null || true
  wait "${PF_PID}" 2>/dev/null || true
  echo "[dev-normalization] Port-forward stopped."
}

trap cleanup EXIT INT TERM

# Give port-forward a moment to establish
sleep 2

# Ensure data directory exists
mkdir -p ./data

echo "[dev-normalization] Restoring latest snapshot from MinIO to ./data/superset.db ..."
# You can customize the litestream restore command (config, bucket, etc.)
# Example using env vars or litestream.yml:
litestream restore -config litestream.yml -o ./data/superset.db || {
  echo "[dev-normalization] WARNING: litestream restore failed or no previous snapshot."
  echo "[dev-normalization] Continuing with empty/fresh DB (or check your MinIO bucket and credentials)."
}

echo "[dev-normalization] Starting application with current env flags (ENABLE_INGESTION=false recommended for dev)..."
echo "[dev-normalization] DB_PATH=./data/superset.db"

# Inherit all env vars from caller (flags, DB_PATH override if set, etc.)
exec DB_PATH=./data/superset.db bun src/main.ts
