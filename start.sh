#!/bin/bash
# Run the table on Linux.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it, then run this again."
  exit 1
fi

[ -d node_modules ] || npm install --omit=dev || exit 1

PORT="${PORT:-3000}"
( sleep 2; xdg-open "http://localhost:$PORT" >/dev/null 2>&1 ) &
node server.js
