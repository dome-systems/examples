#!/usr/bin/env bash
# Sync chess-coach agent metadata (including prompt.*) into:
#   - config/coach-metadata.json  (committed — ships with Vercel)
#   - .dome/coach-metadata.json   (local-only mirror)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOME="${DOME_BIN:-dome}"
OUT_CONFIG="${ROOT}/config/coach-metadata.json"
OUT_LOCAL="${ROOT}/.dome/coach-metadata.json"
AGENT="${DOME_COACH_AGENT:-chess-coach}"

mkdir -p "${ROOT}/.dome" "${ROOT}/config"

"$DOME" agents get "$AGENT" --json | python3 -c '
import json, sys, datetime
raw = sys.stdin.read()
start = raw.find("{")
d = json.loads(raw[start:])
agent = d.get("data", d).get("agent", {})
meta = agent.get("metadata") or {}
out = {
  "agent": agent.get("name"),
  "agent_id": agent.get("id"),
  "metadata": meta,
  "synced_at": datetime.datetime.utcnow().isoformat() + "Z",
  "note": "Public snapshot of chess-coach agent metadata. Refresh with ./scripts/sync-coach-metadata.sh",
}
payload = json.dumps(out, indent=2) + "\n"
for path in ["'"$OUT_CONFIG"'", "'"$OUT_LOCAL"'"]:
  open(path, "w").write(payload)
  print(f"wrote {path}")
prompts = sorted(k for k in meta if k.startswith("prompt."))
print("prompt keys:", ", ".join(prompts) or "(none — set with dome agents update --metadata)")
'
