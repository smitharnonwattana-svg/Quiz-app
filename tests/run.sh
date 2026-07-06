#!/usr/bin/env bash
# รัน regression suite: start static server → รัน Playwright checks → kill server
# ใช้: bash tests/run.sh   (จาก repo root)
set -u
cd "$(dirname "$0")/.."

PORT=8901
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

# รอ server พร้อม (สูงสุด ~5 วิ)
for _ in $(seq 1 25); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then break; fi
  sleep 0.2
done

TEST_BASE_URL="http://127.0.0.1:$PORT" node tests/regression.mjs
exit $?
