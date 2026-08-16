#!/usr/bin/env bash
# Container entrypoint — host-agnostic (Render, Railway, plain Docker).
set -euo pipefail

# The database directory depends on where the host mounts its disk, so derive it
# from SQLITE_PATH rather than hard-coding one platform's convention. Without
# this, better-sqlite3 fails at require() time on a fresh container.
DB_PATH="${SQLITE_PATH:-/var/data/database.sqlite}"
mkdir -p "$(dirname "$DB_PATH")"

# Winston's file transports use paths relative to the working directory and do
# not create it themselves, so without this they fail open and only the console
# transport survives.
mkdir -p /app/backend/logs

echo "[boot] Data directory: $(dirname "$DB_PATH")"

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
