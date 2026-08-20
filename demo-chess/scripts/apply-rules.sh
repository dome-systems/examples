#!/usr/bin/env bash
# Apply the demo policy in the currently selected Dome workspace.
set -euo pipefail

DOME="${DOME_BIN:-dome}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$DOME" context current
"$DOME" rules apply "$ROOT/policies/chess-coach.cedar" \
  --agent chess-coach \
  --name chess-coach
"$DOME" rules apply "$ROOT/policies/opponent-stockfish.cedar" \
  --agent opponent-stockfish \
  --name opponent-stockfish
"$DOME" gateway get Default
echo "OK — rules applied in the current workspace."
