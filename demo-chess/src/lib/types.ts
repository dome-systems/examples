export type StockfishMode = "wasm" | "local" | "remote";

export type ChatMessage = {
  id: string;
  role: "user" | "coach";
  text: string;
  at: number;
};

export type EvalSnapshot = {
  scoreCp: number | null;
  bestMove: string | null;
  depth: number | null;
  raw?: string[];
  error?: string;
};

/**
 * Quota status as reported by Dome. The app never counts usage itself —
 * the Gateway enforces spend caps per act-as subject and answers 429.
 */
export type QuotaState = {
  source: "dome" | "unenforced";
  state: "ok" | "exceeded";
  /** Which Dome quota subject tripped (act_as, agent, workspace, pool, model) */
  subject?: string;
  detail?: string;
};
