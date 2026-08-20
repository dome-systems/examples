import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Coach voice lives on the chess-coach agent as Dome metadata:
 *   prompt.club / prompt.beginner / prompt.default
 *
 * The app resolves which key to use from the signed-in user's act-as groups
 * (club → prompt.club, else prompt.beginner). That is the pattern this demo
 * teaches: identity on the request, copy on the agent record.
 *
 * Load order:
 * 1. Live GetAgent when DOME_API_URL + DOME_PLATFORM_TOKEN are set
 * 2. Snapshot: DOME_COACH_METADATA_FILE, else config/coach-metadata.json
 *    (committed), else .dome/coach-metadata.json (local sync)
 * 3. App fallback (auth.ts coachStyle) so the board still works offline
 */

export type CoachPromptSource = "dome-live" | "dome-snapshot" | "app-fallback";

export type ResolvedCoachPrompt = {
  key: string;
  style: string;
  source: CoachPromptSource;
  agent?: string;
  groups: string[];
};

type MetadataSnapshot = {
  agent?: string;
  agent_id?: string;
  metadata?: Record<string, string>;
  synced_at?: string;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; meta: Record<string, string>; agent?: string; source: CoachPromptSource } | null =
  null;

function promptKeyForGroups(groups: string[]): string {
  if (groups.includes("club")) return "prompt.club";
  if (groups.includes("beginner") || groups.includes("players")) {
    return "prompt.beginner";
  }
  return "prompt.default";
}

async function fetchLiveMetadata(): Promise<{
  meta: Record<string, string>;
  agent?: string;
} | null> {
  const api = process.env.DOME_API_URL?.replace(/\/$/, "");
  const token = process.env.DOME_PLATFORM_TOKEN?.trim();
  if (!api || !token) return null;

  // Prefer explicit UUID; else the last synced snapshot's agent_id.
  let agentId = process.env.DOME_COACH_AGENT_ID?.trim() || "";
  if (!agentId) {
    const snap = await readSnapshot();
    agentId = snap?.agentId ?? "";
  }
  if (!agentId) return null;

  const url = `${api}/dome.agent.v1.AgentRegistry/GetAgent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    agent?: { name?: string; metadata?: Record<string, string> };
  };
  const meta = body.agent?.metadata;
  if (!meta || typeof meta !== "object") return null;
  return { meta, agent: body.agent?.name };
}

async function readSnapshot(): Promise<{
  meta: Record<string, string>;
  agent?: string;
  agentId?: string;
} | null> {
  const candidates = [
    process.env.DOME_COACH_METADATA_FILE?.trim(),
    path.join(process.cwd(), "config", "coach-metadata.json"),
    path.join(process.cwd(), ".dome", "coach-metadata.json"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as MetadataSnapshot;
      if (!parsed.metadata || typeof parsed.metadata !== "object") continue;
      return {
        meta: parsed.metadata,
        agent: parsed.agent,
        agentId: parsed.agent_id,
      };
    } catch {
      // try next
    }
  }
  return null;
}

async function loadMetadata(): Promise<{
  meta: Record<string, string>;
  agent?: string;
  source: CoachPromptSource;
} | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return {
      meta: cache.meta,
      agent: cache.agent,
      source: cache.source,
    };
  }

  const live = await fetchLiveMetadata();
  if (live) {
    cache = {
      at: Date.now(),
      meta: live.meta,
      agent: live.agent,
      source: "dome-live",
    };
    return { meta: live.meta, agent: live.agent, source: "dome-live" };
  }

  const snap = await readSnapshot();
  if (snap) {
    cache = {
      at: Date.now(),
      meta: snap.meta,
      agent: snap.agent,
      source: "dome-snapshot",
    };
    return { meta: snap.meta, agent: snap.agent, source: "dome-snapshot" };
  }

  return null;
}

export async function resolveCoachPrompt(opts: {
  groups: string[];
  fallbackStyle: string;
}): Promise<ResolvedCoachPrompt> {
  const key = promptKeyForGroups(opts.groups);
  const loaded = await loadMetadata();

  if (loaded) {
    const style =
      loaded.meta[key] ||
      loaded.meta["prompt.default"] ||
      opts.fallbackStyle;
    return {
      key: loaded.meta[key] ? key : loaded.meta["prompt.default"] ? "prompt.default" : "app-fallback",
      style,
      source: loaded.source,
      agent: loaded.agent,
      groups: opts.groups,
    };
  }

  return {
    key: "app-fallback",
    style: opts.fallbackStyle,
    source: "app-fallback",
    groups: opts.groups,
  };
}
