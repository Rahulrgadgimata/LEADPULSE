#!/usr/bin/env bash
# Container entrypoint — host-agnostic (Render, Railway, plain Docker).
set -euo pipefail

# No database directory to create: data lives in Postgres (DATABASE_URL), so the
# container holds nothing that has to survive it.

# Winston's file transports use paths relative to the working directory and do
# not create it themselves, so without this they fail open and only the console
# transport survives.
mkdir -p /app/backend/logs

echo "[boot] Starting Scrapling sidecar..."
python3 /app/backend/scrapling/server.py &
SCRAPLING_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://${SCRAPLING_HOST:-127.0.0.1}:${SCRAPLING_PORT:-3765}/health" >/dev/null 2>&1; then
    echo "[boot] Scrapling ready"
    break
  fi
  sleep 1
done

trap 'kill $SCRAPLING_PID 2>/dev/null || true' EXIT

echo "[boot] Starting LeadPulse API on port ${PORT:-3000}..."
exec node /app/backend/server.js
