import { NextResponse } from "next/server";
import {
  analyzeFen,
  getStockfishMode,
  getStockfishUrl,
} from "@/lib/stockfish";
import { getCurrentUser } from "@/lib/session";
import {
  isOpponentSkill,
  routeOpponentModel,
  type OpponentSkill,
} from "@/lib/dome-broker";
import {
  domeChat,
  domeConfigured,
  domeDiscoverAndCall,
  opponentPool,
  opponentToken,
} from "@/lib/dome-client";
import type { StockfishCommandResult } from "@/lib/stockfish-types";

/**
 * Standing opponent agent — principal is opponent-stockfish (no act-as).
 * Engine: Gateway tools/list → tools/call (no hardcoded tool name).
 * Model pool follows match skill.
 */
const OPPONENT_ID = "opponent-stockfish";

function parseCandidateMoves(lines: string[] | undefined): string[] {
  const byPv = new Map<number, { move: string; depth: number }>();

  for (const line of lines ?? []) {
    if (!line.startsWith("info ") || !line.includes(" pv ")) continue;
    const parts = line.split(/\s+/);
    const mp = parts.indexOf("multipv");
    const d = parts.indexOf("depth");
    const pv = parts.indexOf("pv");
    if (pv < 0 || !parts[pv + 1]) continue;
    const multipv = mp >= 0 ? Number(parts[mp + 1]) : 1;
    const depth = d >= 0 ? Number(parts[d + 1]) : 0;
    const move = parts[pv + 1];
    const prev = byPv.get(multipv);
    if (!prev || depth >= prev.depth) {
      byPv.set(multipv, { move, depth });
    }
  }

  const ranked = [...byPv.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v.move)
    .filter((m) => m && m !== "(none)");

  if (ranked.length) return ranked;

  for (const line of lines ?? []) {
    if (line.startsWith("bestmove ")) {
      const mv = line.split(/\s+/)[1];
      if (mv && mv !== "(none)") return [mv];
    }
  }
  return [];
}

function pickMove(
  candidates: string[],
  blunderBias: number,
): { move: string; rank: number } {
  if (candidates.length === 1) return { move: candidates[0], rank: 1 };
  const useSecondary =
    blunderBias > 0 &&
    candidates.length > 1 &&
    Math.random() < blunderBias;
  if (!useSecondary) return { move: candidates[0], rank: 1 };
  const rest = candidates.slice(1);
  const idx = Math.floor(Math.random() * rest.length);
  return { move: rest[idx], rank: idx + 2 };
}

async function analyzeStanding(
  fen: string,
  depth: number,
  multiPv: number,
): Promise<{
  result: StockfishCommandResult;
  tool?: string;
  discovered?: string[];
}> {
  if (domeConfigured() && process.env.DOME_OPPONENT_TOKEN) {
    const call = await domeDiscoverAndCall({
      token: opponentToken(),
      // standing — no actAs
      prefer: ["chess_engine", "stockfish"],
      arguments: { fen, depth },
    });
    if (call.ok) {
      const data = call.data as StockfishCommandResult;
      if (data && typeof data === "object" && "status" in data) {
        return {
          result: data,
          tool: call.tool,
          discovered: call.discovered,
        };
      }
    }
  }
  return { result: await analyzeFen(fen, depth, multiPv) };
}

export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as {
    fen?: string;
    skill?: OpponentSkill;
  };
  if (!body.fen) {
    return NextResponse.json({ error: "fen required" }, { status: 400 });
  }
  if (!isOpponentSkill(body.skill)) {
    return NextResponse.json(
      { error: "skill must be beginner | club | master" },
      { status: 400 },
    );
  }

  const parts = body.fen.split(/\s+/);
  if (parts[1] !== "b") {
    return NextResponse.json(
      { error: "Opponent only moves as Black" },
      { status: 400 },
    );
  }

  const route = await routeOpponentModel(body.skill);
  const pool = opponentPool(body.skill);
  const mode = getStockfishMode();
  const {
    result,
    tool: engineTool,
    discovered,
  } = await analyzeStanding(body.fen, route.depth, route.multiPv);

  if (result.status === "error") {
    return NextResponse.json(
      {
        error: result.error ?? "Stockfish error",
        mode,
        url: getStockfishUrl(),
        route,
        pool,
        tool: engineTool,
        discovered,
      },
      { status: 502 },
    );
  }

  const candidates = parseCandidateMoves(result.response);
  if (!candidates.length) {
    return NextResponse.json(
      {
        error: "Engine returned no move",
        mode,
        route,
        pool,
        raw: result.response,
      },
      { status: 502 },
    );
  }

  let { move: bestMove, rank: pickedRank } = pickMove(
    candidates,
    route.blunderBias,
  );

  let modelNote: string | null = null;
  if (domeConfigured() && process.env.DOME_OPPONENT_TOKEN) {
    try {
      const chat = await domeChat({
        token: opponentToken(),
        model: pool,
        // standing — no actAs
        messages: [
          {
            role: "system",
            content:
              "You are a standing chess opponent. Reply with ONLY a UCI move from the candidate list. No commentary.",
          },
          {
            role: "user",
            content: `FEN: ${body.fen}\nCandidates (best first): ${candidates.join(", ")}\nPick one UCI move.`,
          },
        ],
        temperature: body.skill === "beginner" ? 0.9 : 0.2,
        maxTokens: 16,
      });
      const maybe = chat.text.trim().split(/\s+/)[0]?.toLowerCase();
      if (maybe && candidates.includes(maybe)) {
        bestMove = maybe;
        pickedRank = candidates.indexOf(maybe) + 1;
        modelNote = chat.model;
      } else {
        modelNote = `${chat.model} (fell back to engine pick)`;
      }
    } catch (err) {
      modelNote = `model error: ${
        err instanceof Error ? err.message : "unknown"
      }`;
    }
  }

  return NextResponse.json({
    agent: OPPONENT_ID,
    identity: "standing",
    bestMove,
    from: bestMove.slice(0, 2),
    to: bestMove.slice(2, 4),
    promotion: bestMove.length >= 5 ? bestMove[4] : undefined,
    candidates,
    pickedRank,
    depth: route.depth,
    mode,
    tool: engineTool,
    discovered,
    route: { ...route, model: pool, source: domeConfigured() ? "dome-broker" : route.source },
    pool,
    model: modelNote,
    requestedBy: user.id,
  });
}
