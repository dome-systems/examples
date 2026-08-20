import type { EvalSnapshot } from "@/lib/types";

type Props = {
  snapshot: EvalSnapshot | null;
};

function formatScore(cp: number | null) {
  if (cp == null) return "—";
  const pawns = (cp / 100).toFixed(2);
  return cp > 0 ? `+${pawns}` : pawns;
}

export function EvalBar({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="rounded-md border border-dashed border-[var(--line)] px-3 py-2 text-xs text-black/45">
        Make a move — Stockfish will score the position and the opponent agent will reply.
      </div>
    );
  }

  if (snapshot.error) {
    return (
      <div className="rounded-md border border-[var(--warn)]/30 bg-[#f8e8e4] px-3 py-2 text-xs text-[var(--warn)]">
        {snapshot.error}
      </div>
    );
  }

  const clamped = Math.max(-500, Math.min(500, snapshot.scoreCp ?? 0));
  const whitePct = ((clamped + 500) / 1000) * 100;

  return (
    <div className="rounded-md border border-[var(--line)] bg-white/40 px-3 py-2">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium" title="Centipawns from White's view (+ favors White)">
          Eval {formatScore(snapshot.scoreCp)}
        </span>
        <span className="text-black/50" title="Best move in UCI · search depth">
          best {snapshot.bestMove ?? "—"}
          {snapshot.depth != null ? ` · d${snapshot.depth}` : ""}
        </span>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-[#3a342e]"
        title="White advantage ← → Black advantage"
      >
        <div
          className="bg-[var(--board-light)] transition-all"
          style={{ width: `${whitePct}%` }}
        />
      </div>
    </div>
  );
}
