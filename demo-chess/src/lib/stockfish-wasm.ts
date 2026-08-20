import { createRequire } from "node:module";
import type { StockfishCommandResult } from "@/lib/stockfish-types";

/**
 * In-process Stockfish.js (lite-single WASM) via the package's Node API.
 *
 * Spawning `node stockfish-*.js` as a child breaks on Vercel — the engine's
 * Emscripten loader ends up calling path.normalize() with a number. Using
 * `require("stockfish")` keeps locateFile on absolute paths and works in
 * serverless.
 */

const require = createRequire(import.meta.url);
const initEngine = require("stockfish") as (
  enginePath?: string | null,
) => Promise<StockfishEngine>;

type StockfishEngine = {
  listener?: (line: string) => void;
  sendCommand: (cmd: string) => void;
};

type Waiter = {
  match: (line: string) => boolean;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
  timer: NodeJS.Timeout;
};

type Session = {
  engine: StockfishEngine;
  waiters: Waiter[];
  ready: Promise<void>;
};

let session: Session | null = null;
let sessionBoot: Promise<Session> | null = null;

function pushLine(s: Session, line: string) {
  const text = String(line).trim();
  if (!text) return;
  for (const w of s.waiters) w.lines.push(text);
  for (let i = s.waiters.length - 1; i >= 0; i--) {
    const w = s.waiters[i];
    if (w.match(text)) {
      clearTimeout(w.timer);
      s.waiters.splice(i, 1);
      w.resolve(w.lines);
    }
  }
}

async function getSession(): Promise<Session> {
  if (session) return session;
  if (sessionBoot) return sessionBoot;

  sessionBoot = (async () => {
    const engine = await initEngine("lite-single");
    const s: Session = { engine, waiters: [], ready: Promise.resolve() };
    engine.listener = (line) => pushLine(s, line);
    session = s;
    return s;
  })();

  try {
    return await sessionBoot;
  } catch (err) {
    sessionBoot = null;
    session = null;
    throw err;
  }
}

function waitFor(
  s: Session,
  match: (line: string) => boolean,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const entry: Waiter = {
      match,
      resolve,
      reject,
      lines: [],
      timer: setTimeout(() => {
        const idx = s.waiters.indexOf(entry);
        if (idx >= 0) s.waiters.splice(idx, 1);
        reject(new Error(`Stockfish WASM timeout after ${timeoutMs}ms`));
      }, timeoutMs),
    };
    s.waiters.push(entry);
  });
}

/** Run a UCI command against Stockfish.js (WASM) — works on Vercel Node. */
export async function runWasmCommand(
  command: string,
): Promise<StockfishCommandResult> {
  const cmd = command.trim();
  try {
    const s = await getSession();
    const expectsBestMove = /^go\b/i.test(cmd);
    const expectsReady = /^isready$/i.test(cmd);
    const expectsUci = /^uci$/i.test(cmd);

    const waiter = expectsBestMove
      ? waitFor(s, (l) => l.startsWith("bestmove "), 25_000)
      : expectsReady
        ? waitFor(s, (l) => l === "readyok", 8_000)
        : expectsUci
          ? waitFor(s, (l) => l === "uciok", 8_000)
          : Promise.resolve([] as string[]);

    s.engine.sendCommand(cmd);
    const response = await waiter;

    return {
      status: "success",
      session_id: "wasm",
      command: cmd,
      response,
    };
  } catch (err) {
    return {
      status: "error",
      session_id: "wasm",
      command: cmd,
      error: err instanceof Error ? err.message : "WASM Stockfish failed",
    };
  }
}

export async function analyzeFenWasm(
  fen: string,
  depth = 12,
  multiPv = 1,
) {
  await runWasmCommand("uci");
  await runWasmCommand("isready");
  await runWasmCommand(`setoption name MultiPV value ${Math.max(1, multiPv)}`);
  await runWasmCommand(`position fen ${fen}`);
  // Cap depth on serverless to stay under function time limits
  const d = Math.min(depth, 16);
  return runWasmCommand(`go depth ${d}`);
}
