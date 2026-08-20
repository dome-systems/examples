import type { OpponentSkill } from "@/lib/dome-broker";
import type {
  ChatMessage,
  EvalSnapshot,
  QuotaState,
  StockfishMode,
} from "@/lib/types";

const VERSION = 1;
const KEY_PREFIX = "dome-chess:session:";
const MAX_MESSAGES = 60;

export type PersistedSession = {
  version: number;
  pgn: string;
  messages: ChatMessage[];
  opponentSkill: OpponentSkill;
  quota: QuotaState;
  evalSnap: EvalSnapshot | null;
  lastOpponentMove: string | null;
  stockfishMode: StockfishMode | null;
  routedModel: string | null;
  routeSource: "stub" | "dome-broker" | null;
  savedAt: number;
};

function key(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

export function loadSession(userId: string): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (parsed.version !== VERSION) return null;
    if (typeof parsed.pgn !== "string" || !Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(
  userId: string,
  session: Omit<PersistedSession, "version" | "savedAt">,
) {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedSession = {
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES),
      version: VERSION,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(key(userId), JSON.stringify(payload));
  } catch {
    // Private-mode or quota-exceeded: the demo still works, just not resumable.
  }
}

export function clearSession(userId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(userId));
  } catch {
    // ignore
  }
}
