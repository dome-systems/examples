import { NextResponse } from "next/server";
import {
  analyzeFen,
  getStockfishMode,
  getStockfishUrl,
} from "@/lib/stockfish";
import { getCurrentUser } from "@/lib/session";

function parseEval(lines: string[] | undefined) {
  let scoreCp: number | null = null;
  let bestMove: string | null = null;
  let depth: number | null = null;

  for (const line of lines ?? []) {
    if (line.startsWith("bestmove ")) {
      bestMove = line.split(/\s+/)[1] ?? null;
    }
    if (line.includes(" score cp ")) {
      const parts = line.split(/\s+/);
      const i = parts.indexOf("cp");
      if (i >= 0 && parts[i + 1]) scoreCp = Number(parts[i + 1]);
      const d = parts.indexOf("depth");
      if (d >= 0 && parts[d + 1]) depth = Number(parts[d + 1]);
    }
    if (line.includes(" score mate ")) {
      const parts = line.split(/\s+/);
      const i = parts.indexOf("mate");
      if (i >= 0 && parts[i + 1]) {
        const mate = Number(parts[i + 1]);
        scoreCp = mate > 0 ? 100000 : -100000;
      }
    }
  }

  return { scoreCp, bestMove, depth };
}

export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as { fen?: string };
  if (!body.fen) {
    return NextResponse.json({ error: "fen required" }, { status: 400 });
  }

  const mode = getStockfishMode();
  const result = await analyzeFen(body.fen, user.maxDepth);

  if (result.status === "error") {
    return NextResponse.json({
      scoreCp: null,
      bestMove: null,
      depth: null,
      error: result.error ?? "Stockfish error",
      mode,
      url: getStockfishUrl(),
      raw: result.response,
    });
  }

  return NextResponse.json({
    ...parseEval(result.response),
    mode,
    url: getStockfishUrl(),
    requestedDepth: user.maxDepth,
    raw: result.response,
  });
}
