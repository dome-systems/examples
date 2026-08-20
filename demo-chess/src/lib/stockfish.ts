import type { StockfishMode } from "@/lib/types";
import type { StockfishCommandResult } from "@/lib/stockfish-types";
import { analyzeFenWasm, runWasmCommand } from "@/lib/stockfish-wasm";

export type { StockfishCommandResult } from "@/lib/stockfish-types";

/**
 * Stockfish backends:
 * - wasm   (default): Stockfish.js in-process / child — works on Vercel
 * - local:  docker compose stockfish bridge → mcp-stockfish
 * - remote: STOCKFISH_URL → deployed mcp-stockfish bridge
 */
export function getStockfishMode(): StockfishMode {
  const mode = process.env.STOCKFISH_MODE?.toLowerCase();
  if (mode === "local" || mode === "remote" || mode === "wasm") return mode;
  // Vercel / no Docker: prefer WASM so Deploy works out of the box
  if (process.env.VERCEL || process.env.STOCKFISH_URL == null) return "wasm";
  return "local";
}

export function getStockfishUrl(): string {
  return (
    process.env.STOCKFISH_URL?.replace(/\/$/, "") ||
    "http://localhost:8080"
  );
}

async function runHttpCommand(
  command: string,
  sessionId?: string,
): Promise<StockfishCommandResult> {
  const url = getStockfishUrl();
  const mode = getStockfishMode();
  const endpoint = `${url}/mcp`;

  const body = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: {
      name: "chess_engine",
      arguments: {
        command,
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    },
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return {
        status: "error",
        command,
        error: `Stockfish ${mode} (${url}) HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      error?: { message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: StockfishCommandResult;
      };
    };

    if (json.error?.message) {
      return { status: "error", command, error: json.error.message };
    }

    if (json.result?.structuredContent) {
      return json.result.structuredContent;
    }

    const text = json.result?.content
      ?.map((c) => c.text)
      .filter(Boolean)
      .join("\n");
    if (text) {
      try {
        return JSON.parse(text) as StockfishCommandResult;
      } catch {
        return {
          status: json.result?.isError ? "error" : "success",
          command,
          response: [text],
        };
      }
    }

    return {
      status: "error",
      command,
      error: `Empty response from Stockfish ${mode} at ${url}`,
    };
  } catch (err) {
    return {
      status: "error",
      command,
      error:
        err instanceof Error
          ? `${err.message} (is the stockfish bridge running in ${mode} mode at ${url}?)`
          : "Stockfish request failed",
    };
  }
}

export async function runStockfishCommand(
  command: string,
  sessionId?: string,
): Promise<StockfishCommandResult> {
  if (getStockfishMode() === "wasm") {
    return runWasmCommand(command);
  }
  return runHttpCommand(command, sessionId);
}

/** Analyze a FEN: set position, search depth, return UCI lines. */
export async function analyzeFen(
  fen: string,
  depth = 12,
  multiPv = 1,
) {
  if (getStockfishMode() === "wasm") {
    return analyzeFenWasm(fen, depth, multiPv);
  }
  const session = crypto.randomUUID();
  await runStockfishCommand("uci", session);
  await runStockfishCommand("isready", session);
  await runStockfishCommand(
    `setoption name MultiPV value ${Math.max(1, multiPv)}`,
    session,
  );
  await runStockfishCommand(`position fen ${fen}`, session);
  return runStockfishCommand(`go depth ${depth}`, session);
}
