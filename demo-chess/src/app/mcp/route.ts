import { NextResponse } from "next/server";
import { analyzeFenWasm, runWasmCommand } from "@/lib/stockfish-wasm";

/**
 * App-hosted MCP server for Stockfish (WASM).
 *
 * Register this URL (via cloudflared tunnel) as a Dome tool connection so
 * coach/opponent agents reach the engine through the Gateway.
 */

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

const TOOLS = [
  {
    name: "chess_engine",
    description:
      "Run a UCI command against Stockfish, or analyze a FEN to a given depth.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Raw UCI command (e.g. 'go depth 12')",
        },
        fen: {
          type: "string",
          description: "Position to analyze (shortcut; uses go depth)",
        },
        depth: {
          type: "number",
          description: "Search depth when fen is provided (default 12)",
        },
      },
    },
  },
];

function ok(id: JsonRpc["id"], result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? 1, result });
}

function fail(id: JsonRpc["id"], message: string, code = -32000) {
  return NextResponse.json({
    jsonrpc: "2.0",
    id: id ?? 1,
    error: { code, message },
  });
}

async function callChessEngine(args: Record<string, unknown>) {
  const fen = typeof args.fen === "string" ? args.fen : undefined;
  const depth =
    typeof args.depth === "number"
      ? args.depth
      : typeof args.depth === "string"
        ? Number(args.depth)
        : 12;
  const command = typeof args.command === "string" ? args.command : undefined;

  if (fen) {
    const result = await analyzeFenWasm(fen, depth);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: result.status === "error",
    };
  }

  if (!command) {
    return {
      content: [
        {
          type: "text",
          text: "Provide fen+depth or a UCI command",
        },
      ],
      isError: true,
    };
  }

  const result = await runWasmCommand(command);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.status === "error",
  };
}

export const maxDuration = 60;

export async function POST(req: Request) {
  let body: JsonRpc;
  try {
    body = (await req.json()) as JsonRpc;
  } catch {
    return fail(null, "invalid json", -32700);
  }

  const method = body.method ?? "";

  if (method === "initialize") {
    return ok(body.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "demo-chess-stockfish", version: "0.1.0" },
    });
  }

  if (method === "notifications/initialized") {
    // Some gateways decode a JSON body even for notifications — return empty object.
    return NextResponse.json({});
  }

  if (method === "tools/list") {
    return ok(body.id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (name !== "chess_engine") {
      return fail(body.id, `unknown tool: ${name}`);
    }
    try {
      const result = await callChessEngine(args);
      return ok(body.id, result);
    } catch (err) {
      return fail(
        body.id,
        err instanceof Error ? err.message : "chess_engine failed",
      );
    }
  }

  return fail(body.id, `unsupported method: ${method}`);
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    server: "demo-chess-stockfish",
    tools: TOOLS.map((t) => t.name),
  });
}
