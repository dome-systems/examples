/**
 * Dome Broker stub — capability / cost routing for the standing opponent.
 *
 * Today this is local policy that mirrors what the Broker will do when
 * DOME_BROKER_URL is set: given a match skill, pick a model pool and the
 * engine policy that model is allowed to use.
 *
 * The opponent agent stays standing (principal = opponent-stockfish). The
 * signed-in player only chooses the skill; they are not the act-as identity
 * on the opponent call.
 */

export type OpponentSkill = "beginner" | "club" | "master";

export type ModelRoute = {
  skill: OpponentSkill;
  /** Model pool id the Broker would return */
  model: string;
  /** Why this pool was chosen (shown in the UI) */
  reason: string;
  /** Stockfish depth this pool is allowed to request */
  depth: number;
  /** When >1, weaker pools sample from the top-N lines instead of bestmove */
  multiPv: number;
  /** Prefer a non-best line this often (0–1). Makes beginners human. */
  blunderBias: number;
  source: "stub" | "dome-broker";
};

export const OPPONENT_SKILLS: Array<{
  id: OpponentSkill;
  label: string;
  detail: string;
}> = [
  {
    id: "beginner",
    label: "Beginner",
    detail: "Cheap pool · shallow search · sometimes misses tactics",
  },
  {
    id: "club",
    label: "Club",
    detail: "Mid pool · solid depth · rare slips",
  },
  {
    id: "master",
    label: "Master",
    detail: "Strong pool · deep search · best line",
  },
];

const ROUTES: Record<OpponentSkill, Omit<ModelRoute, "source">> = {
  beginner: {
    skill: "beginner",
    model: "pool/chess-fast",
    reason: "Economic routing — beginner match does not need a strong model",
    depth: 6,
    multiPv: 5,
    blunderBias: 0.55,
  },
  club: {
    skill: "club",
    model: "pool/chess-balanced",
    reason: "Capability routing — club match needs concrete calculation",
    depth: 12,
    multiPv: 3,
    blunderBias: 0.2,
  },
  master: {
    skill: "master",
    model: "pool/chess-strong",
    reason: "Capability escalation — master match requires the strong pool",
    depth: 16,
    multiPv: 1,
    blunderBias: 0,
  },
};

export function isOpponentSkill(value: unknown): value is OpponentSkill {
  return value === "beginner" || value === "club" || value === "master";
}

/** Default skill from the signed-in player's level. */
export function defaultSkillForUser(level: string): OpponentSkill {
  const lower = level.toLowerCase();
  if (lower.includes("beginner")) return "beginner";
  if (lower.includes("club")) return "club";
  return "club";
}

/**
 * Ask the Broker which model the standing opponent should use for this skill.
 * Falls back to the local stub when DOME_BROKER_URL is unset.
 */
export async function routeOpponentModel(
  skill: OpponentSkill,
): Promise<ModelRoute> {
  const stub: ModelRoute = { ...ROUTES[skill], source: "stub" };
  const brokerUrl = process.env.DOME_BROKER_URL?.replace(/\/$/, "");
  if (!brokerUrl) return stub;

  try {
    const res = await fetch(`${brokerUrl}/v1/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.DOME_TOKEN
          ? { Authorization: `Bearer ${process.env.DOME_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        agent: "opponent-stockfish",
        identity: "standing",
        capability: "chess.move",
        skill,
      }),
    });
    if (!res.ok) return stub;
    const data = (await res.json()) as {
      model?: string;
      reason?: string;
      depth?: number;
      multiPv?: number;
      blunderBias?: number;
    };
    return {
      skill,
      model: data.model ?? stub.model,
      reason: data.reason ?? stub.reason,
      depth: data.depth ?? stub.depth,
      multiPv: data.multiPv ?? stub.multiPv,
      blunderBias: data.blunderBias ?? stub.blunderBias,
      source: "dome-broker",
    };
  } catch {
    return stub;
  }
}
