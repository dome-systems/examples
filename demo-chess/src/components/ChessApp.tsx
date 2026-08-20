"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { CoachPanel } from "@/components/CoachPanel";
import { EvalBar } from "@/components/EvalBar";
import { OpponentSkillPicker } from "@/components/OpponentSkillPicker";
import type { PublicUser } from "@/lib/auth";
import {
  defaultSkillForUser,
  type OpponentSkill,
} from "@/lib/dome-broker";
import { clearSession, loadSession, saveSession } from "@/lib/persist";
import type {
  ChatMessage,
  EvalSnapshot,
  QuotaState,
  StockfishMode,
} from "@/lib/types";

function newId() {
  return crypto.randomUUID();
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

type Props = {
  user: PublicUser;
};

export function ChessApp({ user }: Props) {
  const [game, setGame] = useState(() => new Chess());
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: newId(),
      role: "coach",
      text: `Signed in as ${user.name.split(" ")[0]} (${user.level}). You play White. Pick an opponent skill — Dome routes the standing agent to a different model pool for each.`,
      at: Date.now(),
    },
  ]);
  const [pending, setPending] = useState(false);
  const [opponentThinking, setOpponentThinking] = useState(false);
  const [evalSnap, setEvalSnap] = useState<EvalSnapshot | null>(null);
  const [stockfishMode, setStockfishMode] = useState<StockfishMode | null>(
    null,
  );
  const [quota, setQuota] = useState<QuotaState>({
    source: "dome",
    state: "ok",
  });
  const [lastOpponentMove, setLastOpponentMove] = useState<string | null>(
    null,
  );
  const [opponentSkill, setOpponentSkill] = useState<OpponentSkill>(() =>
    defaultSkillForUser(user.level),
  );
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  const [routeSource, setRouteSource] = useState<
    "stub" | "dome-broker" | null
  >(null);
  // Nothing is written back to localStorage until the restore pass has run,
  // otherwise the empty initial state would overwrite a saved game.
  const [restored, setRestored] = useState(false);

  // Guard against stale replies if the player hits New game mid-think.
  const gameIdRef = useRef(0);
  const skillRef = useRef(opponentSkill);
  skillRef.current = opponentSkill;

  const fen = game.fen();
  const playerToMove = game.turn() === "w";

  const status = useMemo(() => {
    if (game.isCheckmate()) {
      return game.turn() === "w"
        ? "Checkmate — opponent wins"
        : "Checkmate — you win";
    }
    if (game.isDraw()) return "Draw";
    if (opponentThinking) {
      return `Opponent thinking… (${opponentSkill})`;
    }
    if (game.isCheck()) return "Check";
    return playerToMove ? "Your move (White)" : "Black to move";
  }, [game, opponentThinking, opponentSkill, playerToMove]);

  const refreshEval = useCallback(async (nextFen: string) => {
    try {
      const res = await fetch("/api/stockfish/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fen: nextFen }),
      });
      const data = (await res.json()) as EvalSnapshot & {
        mode?: StockfishMode;
      };
      if (data.mode) setStockfishMode(data.mode);
      setEvalSnap(data);
    } catch {
      setEvalSnap({
        scoreCp: null,
        bestMove: null,
        depth: null,
        error: "Eval request failed",
      });
    }
  }, []);

  const playOpponent = useCallback(
    async (afterPlayerFen: string, id: number) => {
      setOpponentThinking(true);
      setLastOpponentMove(null);
      try {
        const res = await fetch("/api/opponent/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fen: afterPlayerFen,
            skill: skillRef.current,
          }),
        });
        const data = (await res.json()) as {
          from?: string;
          to?: string;
          promotion?: string;
          bestMove?: string;
          error?: string;
          mode?: StockfishMode;
          route?: {
            model: string;
            source: "stub" | "dome-broker";
            skill: OpponentSkill;
            depth: number;
          };
          pickedRank?: number;
        };
        if (id !== gameIdRef.current) return;
        if (data.mode) setStockfishMode(data.mode);
        if (data.route) {
          setRoutedModel(data.route.model);
          setRouteSource(data.route.source);
        }
        if (!res.ok || !data.from || !data.to) {
          setMessages((m) => [
            ...m,
            {
              id: newId(),
              role: "coach",
              text: `Opponent agent failed: ${data.error ?? "no move"}`,
              at: Date.now(),
            },
          ]);
          return;
        }

        const next = new Chess(afterPlayerFen);
        let san: string | null = null;
        try {
          const move = next.move({
            from: data.from as Square,
            to: data.to as Square,
            promotion: (data.promotion as "q" | "r" | "b" | "n") ?? "q",
          });
          if (!move) {
            setMessages((m) => [
              ...m,
              {
                id: newId(),
                role: "coach",
                text: `Opponent returned an illegal move (${data.bestMove}).`,
                at: Date.now(),
              },
            ]);
            return;
          }
          san = move.san;
        } catch {
          setMessages((m) => [
            ...m,
            {
              id: newId(),
              role: "coach",
              text: `Opponent returned an illegal move (${data.bestMove}).`,
              at: Date.now(),
            },
          ]);
          return;
        }

        if (id !== gameIdRef.current) return;
        setGame(next);
        setLastOpponentMove(san);
        void refreshEval(next.fen());
      } catch {
        if (id !== gameIdRef.current) return;
        setMessages((m) => [
          ...m,
          {
            id: newId(),
            role: "coach",
            text: "Opponent agent request failed.",
            at: Date.now(),
          },
        ]);
      } finally {
        if (id === gameIdRef.current) setOpponentThinking(false);
      }
    },
    [refreshEval],
  );

  useEffect(() => {
    const saved = loadSession(user.id);
    setRestored(true);
    if (!saved) return;

    const resumed = new Chess();
    try {
      if (saved.pgn) resumed.loadPgn(saved.pgn);
    } catch {
      clearSession(user.id);
      return;
    }

    setGame(resumed);
    if (saved.messages.length) setMessages(saved.messages);
    setOpponentSkill(saved.opponentSkill ?? defaultSkillForUser(user.level));
    // Quota status is whatever Dome last said; ignore pre-Dome saved shapes.
    if (saved.quota?.state) setQuota(saved.quota);
    setEvalSnap(saved.evalSnap ?? null);
    setLastOpponentMove(saved.lastOpponentMove ?? null);
    setStockfishMode(saved.stockfishMode ?? null);
    setRoutedModel(saved.routedModel ?? null);
    setRouteSource(saved.routeSource ?? null);

    // A reload during the opponent's turn loses the in-flight request, which
    // would leave the board frozen on Black. Ask the agent again.
    if (resumed.turn() === "b" && !resumed.isGameOver()) {
      void playOpponent(resumed.fen(), gameIdRef.current);
    }
  }, [user.id, user.level, playOpponent]);

  useEffect(() => {
    if (!restored) return;
    saveSession(user.id, {
      pgn: game.pgn(),
      messages,
      opponentSkill,
      quota,
      evalSnap,
      lastOpponentMove,
      stockfishMode,
      routedModel,
      routeSource,
    });
  }, [
    restored,
    user.id,
    game,
    messages,
    opponentSkill,
    quota,
    evalSnap,
    lastOpponentMove,
    stockfishMode,
    routedModel,
    routeSource,
  ]);

  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }) => {
      if (!targetSquare || opponentThinking) return false;
      if (game.turn() !== "w") return false;

      const next = new Chess(game.fen());
      try {
        const move = next.move({
          from: sourceSquare as Square,
          to: targetSquare as Square,
          promotion: "q",
        });
        if (!move) return false;
      } catch {
        return false;
      }

      const id = gameIdRef.current;
      setGame(next);
      void refreshEval(next.fen());

      if (!next.isGameOver()) {
        void playOpponent(next.fen(), id);
      }
      return true;
    },
    [game, opponentThinking, playOpponent, refreshEval],
  );

  const resetGame = () => {
    gameIdRef.current += 1;
    setOpponentThinking(false);
    setLastOpponentMove(null);
    setGame(new Chess());
    setEvalSnap(null);
    setMessages([
      {
        id: newId(),
        role: "coach",
        text: "New game. You are White; the standing opponent agent takes Black.",
        at: Date.now(),
      },
    ]);
  };

  const signOut = async () => {
    clearSession(user.id);
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  const askCoach = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setMessages((m) => [
      ...m,
      { id: newId(), role: "user", text: trimmed, at: Date.now() },
    ]);
    setPending(true);

    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          fen: game.fen(),
          pgn: game.pgn(),
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        error?: string;
        mode?: StockfishMode;
        quota?: QuotaState;
      };
      if (data.mode) setStockfishMode(data.mode);
      if (data.quota) setQuota(data.quota);
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: "coach",
          text: data.reply ?? data.error ?? "No reply",
          at: Date.now(),
        },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: "coach",
          text: "Coach request failed — is the app API running?",
          at: Date.now(),
        },
      ]);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <header className="flex flex-col gap-5 border-b border-[var(--line)] pb-5 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-medium tracking-[0.18em] text-[var(--accent)] uppercase">
            Dome example · interactive · delegated + standing
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-4xl leading-none tracking-tight md:text-5xl">
            Chess Coach
          </h1>
          <p className="mt-2 max-w-xl text-sm text-black/65">
            Two agents on one board: the coach acts as you (delegated); the
            opponent is standing and Dome routes its model pool from the skill
            you pick.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-3 md:items-end">
          <div className="flex items-center gap-2.5 rounded-lg border border-[var(--line)] bg-white/55 px-3 py-2">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold tracking-wide text-white"
            >
              {initials(user.name)}
            </span>
            <span className="min-w-0">
              <span className="block text-sm leading-tight font-medium">
                {user.name}
              </span>
              <span className="block text-[11px] leading-tight text-black/55">
                {user.level} · {user.rating} · depth {user.maxDepth}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={resetGame}
              className="h-9 rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 text-sm font-medium text-white transition-colors hover:bg-[#25493f]"
            >
              New game
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="h-9 rounded-md border border-[var(--line)] bg-white/50 px-3 text-sm font-medium text-black/70 transition-colors hover:bg-white/80"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex flex-col gap-3">
          <OpponentSkillPicker
            value={opponentSkill}
            disabled={opponentThinking}
            routedModel={routedModel}
            routeSource={routeSource}
            onChange={setOpponentSkill}
          />
          <EvalBar snapshot={evalSnap} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{status}</span>
            <div className="flex items-center gap-3 text-black/50">
              {lastOpponentMove ? (
                <span>
                  Opponent:{" "}
                  <span className="text-[var(--accent)]">
                    {lastOpponentMove}
                  </span>
                </span>
              ) : null}
              <span>
                Stockfish:{" "}
                {stockfishMode ? (
                  <span className="text-[var(--accent)]">{stockfishMode}</span>
                ) : (
                  "—"
                )}
              </span>
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-2)] p-2 shadow-[0_20px_50px_rgba(26,23,20,0.08)] md:p-4">
            <div className="mx-auto w-full max-w-[560px]">
              <Chessboard
                options={{
                  id: "dome-chess-coach",
                  position: fen,
                  boardOrientation: "white",
                  onPieceDrop,
                  allowDragging: playerToMove && !opponentThinking,
                  darkSquareStyle: { backgroundColor: "var(--board-dark)" },
                  lightSquareStyle: { backgroundColor: "var(--board-light)" },
                }}
              />
            </div>
          </div>
        </section>

        <CoachPanel
          messages={messages}
          pending={pending}
          user={user}
          quota={quota}
          onAsk={askCoach}
        />
      </div>
    </div>
  );
}
