import type { ActAsIdentity } from "@/lib/actas";
import { signHMACActAs } from "@/lib/actas";

export function domeConfigured(): boolean {
  return Boolean(process.env.DOME_GATEWAY_URL?.trim());
}

function gatewayBase(): string {
  const base = process.env.DOME_GATEWAY_URL?.trim();
  if (!base) throw new Error("DOME_GATEWAY_URL is not set");
  return base.replace(/\/$/, "");
}

function authHeaders(
  token: string,
  actAs?: ActAsIdentity | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (actAs) {
    const secret = process.env.DOME_ACTAS_SECRET?.trim();
    if (!secret) {
      throw new Error("DOME_ACTAS_SECRET required for act-as calls");
    }
    headers["X-Dome-Act-As"] = signHMACActAs(secret, actAs);
  }
  return headers;
}

export type DomeChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DomeChatResult = {
  text: string;
  model: string;
  raw: unknown;
};

/**
 * Gateway rejection with enough detail to tell a spend cap apart from a
 * policy denial. Dome answers 429 when a Quota is exhausted.
 */
export class DomeChatError extends Error {
  readonly status: number;
  readonly quotaExceeded: boolean;
  /** Dome quota subject that tripped, e.g. act_as / agent / workspace */
  readonly quotaSubject?: string;

  constructor(
    message: string,
    status: number,
    opts?: { quotaSubject?: string },
  ) {
    super(message);
    this.name = "DomeChatError";
    this.status = status;
    this.quotaExceeded = status === 429;
    this.quotaSubject = opts?.quotaSubject;
  }
}

/** "llm: quota exceeded (act_as): spend cap reached" → "act_as" */
function quotaSubjectFromMessage(message: string): string | undefined {
  return /quota exceeded \(([^)]+)\)/i.exec(message)?.[1];
}

/** OpenAI-compatible chat via Dome LLM gateway. */
export async function domeChat(opts: {
  token: string;
  model: string;
  messages: DomeChatMessage[];
  actAs?: ActAsIdentity | null;
  temperature?: number;
  maxTokens?: number;
}): Promise<DomeChatResult> {
  const url = `${gatewayBase()}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(opts.token, opts.actAs),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 600,
    }),
  });

  const raw: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = raw as { error?: { message?: string }; message?: string };
    const message =
      err.error?.message ?? err.message ?? `Dome chat HTTP ${res.status}`;
    throw new DomeChatError(message, res.status, {
      quotaSubject: quotaSubjectFromMessage(message),
    });
  }

  const body = raw as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, model: body.model ?? opts.model, raw };
}

export type DomeToolDescriptor = {
  name: string;
  description?: string;
};

export type DomeToolsListResult = {
  ok: boolean;
  tools: DomeToolDescriptor[];
  error?: string;
  raw: unknown;
  httpStatus: number;
};

export type DomeToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  raw: unknown;
  httpStatus: number;
};

type JsonRpcErrorBody = {
  error?: { message?: string; data?: { reason?: string } };
};

/**
 * MCP tools/list via Dome Tools gateway.
 *
 * The list is filtered by agent grants + Cedar + verified act-as, so Alex and
 * Sam can see different tools without the app hardcoding names.
 */
export async function domeToolsList(opts: {
  token: string;
  actAs?: ActAsIdentity | null;
}): Promise<DomeToolsListResult> {
  const url = `${gatewayBase()}/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(opts.token, opts.actAs),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  const raw: unknown = await res.json().catch(() => ({}));
  const body = raw as JsonRpcErrorBody & {
    result?: { tools?: Array<{ name?: string; description?: string }> };
  };

  if (!res.ok || body.error) {
    return {
      ok: false,
      tools: [],
      error:
        body.error?.data?.reason ??
        body.error?.message ??
        `Dome tools/list HTTP ${res.status}`,
      raw,
      httpStatus: res.status,
    };
  }

  const tools = (body.result?.tools ?? [])
    .filter((t): t is { name: string; description?: string } =>
      Boolean(t.name),
    )
    .map((t) => ({ name: t.name, description: t.description }));

  return { ok: true, tools, raw, httpStatus: res.status };
}

/** MCP tools/call via Dome Tools gateway. */
export async function domeToolCall(opts: {
  token: string;
  tool: string;
  arguments?: Record<string, unknown>;
  actAs?: ActAsIdentity | null;
}): Promise<DomeToolResult> {
  const url = `${gatewayBase()}/mcp`;
  const requestBody = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call" as const,
    params: {
      name: opts.tool,
      arguments: opts.arguments ?? {},
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(opts.token, opts.actAs),
    body: JSON.stringify(requestBody),
  });

  const raw: unknown = await res.json().catch(() => ({}));
  const body = raw as JsonRpcErrorBody & {
    result?: {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ text?: string }>;
    };
  };

  if (!res.ok || body.error) {
    return {
      ok: false,
      error:
        body.error?.data?.reason ??
        body.error?.message ??
        `Dome tool HTTP ${res.status}`,
      raw,
      httpStatus: res.status,
    };
  }

  if (body.result?.isError) {
    return {
      ok: false,
      error: body.result.content?.[0]?.text ?? "tool returned isError",
      raw,
      httpStatus: res.status,
    };
  }

  const data =
    body.result?.structuredContent ??
    parseTextJson(body.result?.content?.[0]?.text) ??
    body.result?.content;

  return { ok: true, data, raw, httpStatus: res.status };
}

/**
 * Prefer an exact qualified name, else a bare tool leaf, else a suffix match.
 * Gateway names look like `stockfish/chess_engine`.
 */
export function pickTool(
  tools: DomeToolDescriptor[],
  want: string,
): DomeToolDescriptor | null {
  const exact = tools.find((t) => t.name === want);
  if (exact) return exact;
  const leaf = tools.find((t) => t.name.split("/").pop() === want);
  if (leaf) return leaf;
  const ends = tools.find(
    (t) => t.name === want || t.name.endsWith(`/${want}`),
  );
  return ends ?? null;
}

const ENGINE_TOOL_CANDIDATES = ["chess_engine", "stockfish"] as const;

/** Find the Stockfish / chess engine tool Dome exposed to this principal. */
export function pickChessEngineTool(
  tools: DomeToolDescriptor[],
): DomeToolDescriptor | null {
  for (const want of ENGINE_TOOL_CANDIDATES) {
    const hit = pickTool(tools, want);
    if (hit) return hit;
  }
  return null;
}

type DiscoverCacheEntry = {
  at: number;
  tools: DomeToolDescriptor[];
};

const DISCOVER_TTL_MS = 30_000;
const discoverCache = new Map<string, DiscoverCacheEntry>();

function discoverCacheKey(
  token: string,
  actAs?: ActAsIdentity | null,
): string {
  const who = actAs
    ? `actas:${actAs.sub}:${[...(actAs.groups ?? [])].sort().join(",")}`
    : "standing";
  return `${token.slice(0, 12)}:${who}`;
}

/**
 * Discover tools for this agent (+ optional act-as), then call one.
 * This is the norm the demo teaches: do not hardcode tool names in env.
 */
export async function domeDiscoverAndCall(opts: {
  token: string;
  actAs?: ActAsIdentity | null;
  /** Leaf or qualified name to pick from the discovered list */
  prefer: string | string[];
  arguments?: Record<string, unknown>;
  /** Skip the short-lived tools/list cache */
  fresh?: boolean;
}): Promise<
  DomeToolResult & {
    tool?: string;
    discovered: string[];
    listError?: string;
  }
> {
  const cacheKey = discoverCacheKey(opts.token, opts.actAs);
  let tools: DomeToolDescriptor[] | null = null;

  if (!opts.fresh) {
    const hit = discoverCache.get(cacheKey);
    if (hit && Date.now() - hit.at < DISCOVER_TTL_MS) {
      tools = hit.tools;
    }
  }

  if (!tools) {
    const listed = await domeToolsList({
      token: opts.token,
      actAs: opts.actAs,
    });
    if (!listed.ok) {
      return {
        ok: false,
        error: listed.error ?? "tools/list failed",
        raw: listed.raw,
        httpStatus: listed.httpStatus,
        discovered: [],
        listError: listed.error,
      };
    }
    tools = listed.tools;
    discoverCache.set(cacheKey, { at: Date.now(), tools });
  }

  const prefers = Array.isArray(opts.prefer) ? opts.prefer : [opts.prefer];
  let chosen: DomeToolDescriptor | null = null;
  for (const want of prefers) {
    chosen = pickTool(tools, want);
    if (chosen) break;
  }
  if (!chosen) {
    chosen = pickChessEngineTool(tools);
  }

  const discovered = tools.map((t) => t.name);
  if (!chosen) {
    return {
      ok: false,
      error: `No matching tool in Gateway tools/list (wanted ${prefers.join(" | ")}); saw: ${discovered.join(", ") || "(none)"}`,
      raw: { tools },
      httpStatus: 200,
      discovered,
    };
  }

  const called = await domeToolCall({
    token: opts.token,
    tool: chosen.name,
    arguments: opts.arguments,
    actAs: opts.actAs,
  });

  return { ...called, tool: chosen.name, discovered };
}

function parseTextJson(text: unknown) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function coachToken(): string {
  const t = process.env.DOME_COACH_TOKEN?.trim();
  if (!t) throw new Error("DOME_COACH_TOKEN is not set");
  return t;
}

export function opponentToken(): string {
  const t = process.env.DOME_OPPONENT_TOKEN?.trim();
  if (!t) throw new Error("DOME_OPPONENT_TOKEN is not set");
  return t;
}

export function coachPool(): string {
  return process.env.DOME_COACH_POOL?.trim() || "pool/coach";
}

export function opponentPool(skill: "beginner" | "club" | "master"): string {
  if (skill === "beginner") {
    return (
      process.env.DOME_OPPONENT_POOL_BEGINNER?.trim() || "pool/chess-fast"
    );
  }
  if (skill === "master") {
    return (
      process.env.DOME_OPPONENT_POOL_MASTER?.trim() || "pool/chess-strong"
    );
  }
  return process.env.DOME_OPPONENT_POOL_CLUB?.trim() || "pool/chess-balanced";
}
