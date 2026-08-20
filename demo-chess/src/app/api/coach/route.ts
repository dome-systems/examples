import { NextResponse } from "next/server";
import {
  analyzeFen,
  getStockfishMode,
  getStockfishUrl,
} from "@/lib/stockfish";
import { getCurrentUser } from "@/lib/session";
import { toPublicUser } from "@/lib/auth";
import { identityFromUser } from "@/lib/actas";
import { resolveCoachPrompt } from "@/lib/coach-prompts";
import {
  coachPool,
  coachToken,
  DomeChatError,
  domeChat,
  domeConfigured,
  domeDiscoverAndCall,
} from "@/lib/dome-client";
import type { StockfishCommandResult } from "@/lib/stockfish-types";
import type { QuotaState } from "@/lib/types";

/**
 * Spend caps are enforced by Dome per act-as subject, so the app reports
 * what the Gateway said instead of keeping its own counter.
 */
const QUOTA_OK: QuotaState = { source: "dome", state: "ok" };
const QUOTA_UNENFORCED: QuotaState = { source: "unenforced", state: "ok" };

async function engineAnalysis(
  fen: string,
  depth: number,
  actAs: ReturnType<typeof identityFromUser>,
): Promise<{
  analysis: StockfishCommandResult;
  via: "dome" | "local";
  tool?: string;
  discovered?: string[];
}> {
  if (domeConfigured() && process.env.DOME_COACH_TOKEN) {
    const result = await domeDiscoverAndCall({
      token: coachToken(),
      actAs,
      prefer: ["chess_engine", "stockfish"],
      arguments: { fen, depth },
    });
    if (result.ok) {
      const data = result.data as StockfishCommandResult;
      return {
        analysis:
          data && typeof data === "object" && "status" in data
            ? data
            : {
                status: "success",
                command: `analyze ${fen}`,
                response: [JSON.stringify(result.data)],
              },
        via: "dome",
        tool: result.tool,
        discovered: result.discovered,
      };
    }
    // Fall through to local on tool miss so the board stays playable
  }

  return { analysis: await analyzeFen(fen, depth), via: "local" };
}

/**
 * Delegated coach — principal is chess-coach + X-Dome-Act-As (signed-in user).
 * Voice: chess-coach agent metadata (`prompt.club` / `prompt.beginner`) keyed
 * by act-as groups — not app-side coachStyle.
 * Engine: Gateway tools/list → tools/call. Prose: pool/coach.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await req.json()) as {
    message?: string;
    fen?: string;
    pgn?: string;
  };

  if (!body.message || !body.fen) {
    return NextResponse.json(
      { error: "message and fen required" },
      { status: 400 },
    );
  }

  const actAs = identityFromUser(toPublicUser(user));
  const prompt = await resolveCoachPrompt({
    groups: user.groups,
    fallbackStyle: user.coachStyle,
  });
  const { analysis, via, tool, discovered } = await engineAnalysis(
    body.fen,
    user.maxDepth,
    actAs,
  );

  const mode = getStockfishMode();
  if (analysis.status === "error") {
    return NextResponse.json({
      reply: `I couldn’t reach Stockfish (${via}/${mode}): ${analysis.error}`,
      mode,
      via,
      quota: domeConfigured() ? QUOTA_OK : QUOTA_UNENFORCED,
      prompt: { key: prompt.key, source: prompt.source },
    });
  }

  const lines = analysis.response ?? [];
  const best =
    lines.find((l) => l.startsWith("bestmove "))?.split(/\s+/)[1] ?? "—";
  const info = [...lines]
    .reverse()
    .find((l) => l.startsWith("info ") && l.includes(" score "));

  const engineBrief = [
    info ? `Engine line: ${info}` : null,
    `Best move (UCI): ${best}`,
    `Depth: ${user.maxDepth}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (!domeConfigured() || !process.env.DOME_COACH_TOKEN) {
    const personaNote =
      user.id === "sam" ? "Keeping it plain — " : "Tactical read — ";
    return NextResponse.json({
      reply: `${personaNote}looking at this position for you. ${engineBrief}. You asked: “${body.message}” — set DOME_GATEWAY_URL to enable Dome model routing.`,
      mode,
      via,
      url: getStockfishUrl(),
      quota: QUOTA_UNENFORCED,
      engine: analysis,
      prompt: { key: prompt.key, source: prompt.source },
    });
  }

  try {
    const chat = await domeChat({
      token: coachToken(),
      model: coachPool(),
      actAs,
      messages: [
        {
          role: "system",
          content: [
            `You are Chess Coach, speaking to ${user.name} (${user.level}, rating ${user.rating}).`,
            prompt.style,
            discovered?.length
              ? `Tools Dome exposed for this identity: ${discovered.join(", ")}.`
              : `Allowed tools for this user (app profile): ${user.tools.join(", ")}.`,
            "Ground every claim in the engine brief; never invent an evaluation.",
            "",
            "Format for a narrow chat panel:",
            "- Under 90 words. No headings, no horizontal rules, no tables.",
            "- Open with the move or verdict in one short sentence.",
            "- At most 3 short bullets after that, only if they add something.",
            "- Bold only actual moves (**Nf3**). Write moves in algebraic notation.",
            prompt.key === "prompt.beginner" || user.id === "sam"
              ? "- No jargon and no long variations; explain the idea in plain words."
              : "- One concrete variation is welcome; keep it to a single line.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `FEN: ${body.fen}`,
            body.pgn ? `PGN: ${body.pgn}` : null,
            `Engine brief:\n${engineBrief}`,
            `Question: ${body.message}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      maxTokens: 320,
    });

    return NextResponse.json({
      reply: chat.text,
      mode,
      via,
      tool,
      discovered,
      model: chat.model,
      pool: coachPool(),
      identity: "delegated",
      quota: QUOTA_OK,
      engine: analysis,
      prompt: {
        key: prompt.key,
        source: prompt.source,
        agent: prompt.agent,
      },
    });
  } catch (err) {
    if (err instanceof DomeChatError && err.quotaExceeded) {
      const quota: QuotaState = {
        source: "dome",
        state: "exceeded",
        subject: err.quotaSubject,
        detail: err.message,
      };
      return NextResponse.json(
        {
          error: `Dome spend cap reached for ${user.name}${
            err.quotaSubject ? ` (${err.quotaSubject} quota)` : ""
          }. The engine still says best move ${best} — raise the quota in Dome or wait for the window to reset.`,
          mode,
          via,
          tool,
          discovered,
          quota,
          engine: analysis,
          prompt: { key: prompt.key, source: prompt.source },
        },
        { status: 429 },
      );
    }

    return NextResponse.json({
      reply: `Dome model call failed: ${
        err instanceof Error ? err.message : "unknown error"
      }. Engine still says best move ${best}.`,
      mode,
      via,
      tool,
      discovered,
      quota: QUOTA_OK,
      engine: analysis,
      prompt: { key: prompt.key, source: prompt.source },
    });
  }
}
