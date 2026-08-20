# Stockfish tool backends

Three ways to run the engine for demo-chess:

| `STOCKFISH_MODE` | What runs | Vercel? |
|---|---|---|
| **`wasm`** (default) | [Stockfish.js](https://github.com/nmrugg/stockfish.js) via Next.js API (`lite-single`) | **Yes** — same deploy as the app |
| **`local`** | Docker bridge → [mcp-stockfish](https://github.com/sonirico/mcp-stockfish) stdio | No (sidecar) |
| **`remote`** | Same Docker image hosted elsewhere (`STOCKFISH_URL`) | App on Vercel, engine elsewhere |

## Recommended: WASM on Vercel

Yes — host Stockfish **with** the Next app on Vercel. No separate service.

```bash
STOCKFISH_MODE=wasm   # default when STOCKFISH_MODE unset / on VERCEL
npm run dev           # or: vercel deploy
```

The API routes spawn `stockfish-18-lite-single.js` (WASM, ~7MB) as a child Node process and speak UCI. Depth is capped for serverless time limits.

**Caveats on Vercel:** cold start + WASM load adds latency; keep depth ≤ 12–14; Hobby plan timeouts are short — Pro is safer for deeper search. This is great for the demo; for heavy analysis prefer `local` / `remote` mcp-stockfish.

## Local mcp-stockfish (Docker)

Fixes the Alpine error: image is **Debian** + `apt install stockfish`, and `.dockerignore` keeps `node_modules` out of the build context.

```bash
# stop any stuck build, then:
docker compose up --build stockfish
```

```bash
STOCKFISH_MODE=local
STOCKFISH_URL=http://localhost:8080
```

Health: `curl http://localhost:8080/health`

Upstream mcp-stockfish HTTP mode is a stub, so we wrap stdio with `services/stockfish-bridge/`.

## Remote (deploy the bridge)

```bash
docker build -f services/stockfish-bridge/Dockerfile -t demo-chess-stockfish .
# push + run on Fly / Cloud Run / Railway / a VPS, port 8080
```

```bash
STOCKFISH_MODE=remote
STOCKFISH_URL=https://stockfish.your-domain.com
```

You can still deploy the **Next app** to Vercel while pointing `STOCKFISH_URL` at that remote bridge.

## Later: Dome Gateway

Attach either the Docker URL or (eventually) a Dome-mediated tool. Coach path:

`app → Dome Gateway (act-as) → chess_engine → stockfish`
