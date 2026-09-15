#!/bin/bash
# Double-click this on a Mac to run the table.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Get it from https://nodejs.org (pick the LTS button), then run this again."
  echo ""
  read -r -p "Press return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run — installing. This takes a minute."
  npm install --omit=dev || { echo "  Install failed."; read -r -p "Press return to close."; exit 1; }
fi

PORT="${PORT:-3000}"
( sleep 2; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
node server.js
