#!/usr/bin/env npx tsx
/**
 * GitHub activity report — same agent as ../python/main.py, in TypeScript.
 *
 * Governance lives in the Blueprint, not here. This process exchanges a Dome
 * agent key, then talks to the Gateway over HTTP: MCP JSON-RPC at /mcp and
 * OpenAI-shaped chat at /v1/chat/completions. There is no TypeScript SDK yet;
 * the wire is the SDK.
 */
const LOOKBACK_HOURS_DEFAULT = 24;
const PER_PAGE = 100;
const HTTP_TIMEOUT_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 120_000;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const PR_FIELDS = [
  "number",
  "title",
  "state",
  "draft",
  "html_url",
  "user",
  "created_at",
  "updated_at",
  "closed_at",
  "pull_request",
  "repository_url",
];
const ISSUE_FIELDS = [
  "number",
  "title",
  "state",
  "html_url",
  "user",
  "created_at",
  "updated_at",
];

const SYSTEM_PROMPT =
  "You write a short recurring note about one engineer's GitHub work for their " +
  "team's Slack channel. Your readers know the codebase but have not seen this " +
  "week's pull requests. Use only the pull requests and issues you are given: " +
  "never invent one, never describe work that is not listed, and never estimate " +
  "a number that is absent.";

type Repo = { owner: string; name: string };
const slug = (repo: Repo) => `${repo.owner}/${repo.name}`;

type Config = {
  domeApiKey: string;
  domeGateway: string;
  domeControlPlane: string;
  domeModel: string;
  githubUsername: string;
  repos: Repo[];
  prSearchTool: string;
  issueListTool: string;
  actAsEmail: string;
  lookbackHours: number;
  outputMode: string;
  slackWebhookUrl: string;
  slackBotToken: string;
  slackChannel: string;
};

type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updatedAt: string;
  mergedAt: string;
};

type Issue = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  createdAt: string;
};

type Activity = {
  username: string;
  lookbackHours: number;
  repos: Repo[];
  merged: PullRequest[];
  inProgress: PullRequest[];
  issues: Issue[];
};

function parseLookbackFlag(argv: string[]): number | undefined {
  const i = argv.indexOf("--lookback-hours");
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--lookback-hours must be a positive integer, got ${raw}`);
  }
  return n;
}

function parseRepos(raw: string): Repo[] {
  const repos: Repo[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const parts = value.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `GITHUB_REPOS entry ${JSON.stringify(value)} is not owner/repo; expected a list like "dome-systems/prod-dome,dome-systems/sdk-dome-python"`,
      );
    }
    repos.push({ owner: parts[0], name: parts[1] });
  }
  if (repos.length === 0) {
    throw new Error("GITHUB_REPOS is empty; it needs at least one owner/repo");
  }
  return repos;
}

function loadConfig(lookbackOverride?: number): Config {
  const required: Record<string, string> = {
    DOME_AGENT_API_KEY: process.env.DOME_AGENT_API_KEY ?? "",
    DOME_GATEWAY_URL: process.env.DOME_GATEWAY_URL ?? "",
    DOME_API_URL: process.env.DOME_API_URL ?? "",
    GITHUB_USERNAME: process.env.GITHUB_USERNAME ?? "",
    GITHUB_REPOS: process.env.GITHUB_REPOS ?? "",
    SUMMARY_MODEL: process.env.SUMMARY_MODEL ?? "",
    GITHUB_PR_SEARCH_TOOL: process.env.GITHUB_PR_SEARCH_TOOL ?? "",
    GITHUB_ISSUE_LIST_TOOL: process.env.GITHUB_ISSUE_LIST_TOOL ?? "",
  };
  const missing = Object.keys(required)
    .filter((name) => !required[name])
    .sort();
  if (missing.length) {
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }
  const outputMode = (process.env.OUTPUT_MODE ?? "slack").toLowerCase();
  if (outputMode !== "slack" && outputMode !== "stdout") {
    throw new Error(`OUTPUT_MODE must be "slack" or "stdout", got ${JSON.stringify(outputMode)}`);
  }
  let lookbackHours = LOOKBACK_HOURS_DEFAULT;
  if (lookbackOverride !== undefined) {
    lookbackHours = lookbackOverride;
  } else {
    const raw = process.env.LOOKBACK_HOURS ?? String(LOOKBACK_HOURS_DEFAULT);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`LOOKBACK_HOURS must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    lookbackHours = n;
  }
  const cfg: Config = {
    domeApiKey: required.DOME_AGENT_API_KEY,
    domeGateway: required.DOME_GATEWAY_URL.replace(/\/+$/, ""),
    domeControlPlane: required.DOME_API_URL.replace(/\/+$/, ""),
    domeModel: required.SUMMARY_MODEL,
    githubUsername: required.GITHUB_USERNAME.replace(/^@/, ""),
    repos: parseRepos(required.GITHUB_REPOS),
    prSearchTool: required.GITHUB_PR_SEARCH_TOOL,
    issueListTool: required.GITHUB_ISSUE_LIST_TOOL,
    actAsEmail: process.env.ACT_AS_EMAIL ?? "",
    lookbackHours,
    outputMode,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
    slackChannel: process.env.SLACK_CHANNEL ?? "",
  };
  if (
    cfg.outputMode === "slack" &&
    !cfg.slackWebhookUrl &&
    !(cfg.slackBotToken && cfg.slackChannel)
  ) {
    throw new Error(
      "OUTPUT_MODE=slack needs SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and SLACK_CHANNEL (or set OUTPUT_MODE=stdout)",
    );
  }
  return cfg;
}

function githubTimestamp(moment: Date): string {
  return moment.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTimestamp(value: string): Date {
  if (!value) throw new Error("empty timestamp");
  return new Date(value);
}

function repoScope(repos: Repo[]): string {
  return repos.map((repo) => `repo:${slug(repo)}`).join(" ");
}

function mergedPullRequestQuery(repos: Repo[], username: string, since: Date): string {
  return `${repoScope(repos)} author:${username} is:merged merged:>=${githubTimestamp(since)}`;
}

function openPullRequestQuery(repos: Repo[], username: string, since: Date): string {
  return `${repoScope(repos)} author:${username} is:open updated:>=${githubTimestamp(since)}`;
}

function repoSlugFromApiUrl(url: string): string {
  const marker = "/repos/";
  const index = url.lastIndexOf(marker);
  if (index < 0) throw new Error(`unrecognized repository URL in search result: ${JSON.stringify(url)}`);
  const parts = url.slice(index + marker.length).replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`unrecognized repository URL in search result: ${JSON.stringify(url)}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

function parsePullRequests(payload: unknown): { pulls: PullRequest[]; total: number } {
  const obj = payload as Record<string, unknown> | null;
  const items = obj?.items;
  if (!Array.isArray(items)) {
    throw new Error(`pull request search reply has no 'items' list: ${JSON.stringify(payload)?.slice(0, 500)}`);
  }
  const pulls = items.map((item) => {
    const row = item as Record<string, unknown>;
    const pr = (row.pull_request ?? {}) as Record<string, unknown>;
    return {
      repo: repoSlugFromApiUrl(String(row.repository_url ?? "")),
      number: Number(row.number),
      title: String(row.title ?? "").trim(),
      url: String(row.html_url ?? ""),
      draft: Boolean(row.draft),
      updatedAt: String(row.updated_at ?? ""),
      mergedAt: String(pr.merged_at ?? ""),
    };
  });
  return { pulls, total: Number(obj?.total_count ?? pulls.length) };
}

function parseIssues(payload: unknown, repo: Repo): { issues: Issue[]; total: number } {
  const obj = payload as Record<string, unknown> | null;
  const items = obj?.issues;
  if (!Array.isArray(items)) {
    throw new Error(
      `issue listing for ${slug(repo)} reply has no 'issues' list: ${JSON.stringify(payload)?.slice(0, 500)}`,
    );
  }
  const issues = items.map((item) => {
    const row = item as Record<string, unknown>;
    const user = (row.user ?? {}) as Record<string, unknown>;
    return {
      repo: slug(repo),
      number: Number(row.number),
      title: String(row.title ?? "").trim(),
      url: String(row.html_url ?? ""),
      author: String(user.login ?? "").trim(),
      createdAt: String(row.created_at ?? ""),
    };
  });
  return { issues, total: Number(obj?.totalCount ?? issues.length) };
}

function issuesOpenedSince(issues: Issue[], since: Date): Issue[] {
  return issues
    .filter((issue) => parseTimestamp(issue.createdAt) >= since)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function extractApiKey(credential: string): string {
  if (credential.startsWith("dome_")) return credential;
  try {
    const envelope = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as {
      auth_method?: string;
      api_key?: string;
    };
    if (envelope.auth_method != null && envelope.auth_method !== "api_key") {
      throw new Error(`unsupported auth_method in token envelope: ${JSON.stringify(envelope.auth_method)}`);
    }
    if (envelope.api_key) return envelope.api_key;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("unsupported auth_method")) throw err;
  }
  throw new Error("invalid agent token: must be a dome_ key or base64 agent token envelope");
}

async function exchangeToken(controlPlane: string, apiKey: string): Promise<string> {
  const response = await fetch(`${controlPlane.replace(/\/+$/, "")}/dome.identity.v1.Identity/ExchangeToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grantType: "api_key", apiKey }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text) as { accessToken?: string };
  if (!data.accessToken) throw new Error("token exchange returned empty access token");
  return data.accessToken;
}

function gatewayHeaders(token: string, actAsEmail: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (actAsEmail) {
    headers["X-Dome-Act-As"] = Buffer.from(JSON.stringify({ email: actAsEmail })).toString("base64");
  }
  return headers;
}

async function mcp(
  cfg: Config,
  token: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
  };
  if (params !== undefined) payload.params = params;
  const response = await fetch(`${cfg.domeGateway}/mcp`, {
    method: "POST",
    headers: gatewayHeaders(token, cfg.actAsEmail),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`dome gateway call failed: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const rpc = JSON.parse(text) as { error?: unknown; result?: unknown };
  if (rpc.error) throw new Error(`dome gateway call failed: ${JSON.stringify(rpc.error)}`);
  return rpc.result ?? {};
}

function toolResultJson(result: unknown): unknown {
  const obj = result as Record<string, unknown> | null;
  if (!obj) throw new Error("tool result does not contain JSON content");
  if (obj.isError) {
    throw new Error(`dome gateway call failed: tool returned isError=true raw=${JSON.stringify(obj)}`);
  }
  if (obj.structuredContent != null) return obj.structuredContent;
  if (obj.structured_content != null) return obj.structured_content;
  const content = Array.isArray(obj.content) ? obj.content : [];
  const text = content
    .filter((item) => (item as { type?: string }).type === "text")
    .map((item) => String((item as { text?: string }).text ?? ""))
    .join("\n")
    .trim();
  if (!text) throw new Error("tool result does not contain JSON content");
  return JSON.parse(text);
}

async function checkTools(cfg: Config, token: string): Promise<void> {
  const result = (await mcp(cfg, token, "tools/list", {})) as { tools?: { name?: string }[] };
  const published = new Set((result.tools ?? []).map((tool) => tool.name ?? "").filter(Boolean));
  const wanted: Record<string, string> = {
    GITHUB_ISSUE_LIST_TOOL: cfg.issueListTool,
    GITHUB_PR_SEARCH_TOOL: cfg.prSearchTool,
  };
  for (const variable of Object.keys(wanted).sort()) {
    const name = wanted[variable];
    if (!published.has(name)) {
      const available = [...published].sort().join(", ") || "(none)";
      throw new Error(
        `gateway does not publish tool ${JSON.stringify(name)}; available tools: ${available}. Set ${variable} to the right one.`,
      );
    }
  }
}

function emptyCompletionReason(
  choice: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const finish = String(choice.finish_reason ?? "unknown");
  const usage = (response.usage ?? {}) as Record<string, unknown>;
  const detail = `finish_reason=${finish}, completion_tokens=${usage.completion_tokens}`;
  if (finish === "length") {
    return (
      `model ${String(response.model ?? "?")} reached its output ceiling without producing any text (${detail}). ` +
      "That is what a reasoning model does when hidden reasoning consumes the whole budget — and " +
      "raising the ceiling only works until the gateway's upstream timeout stops the request, so point SUMMARY_MODEL at a model that answers directly instead."
    );
  }
  return `gateway LLM call returned an empty completion (${detail})`;
}

async function summarize(cfg: Config, token: string, prompt: string): Promise<string> {
  const response = await fetch(`${cfg.domeGateway}/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(token, cfg.actAsEmail),
    body: JSON.stringify({
      model: cfg.domeModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`gateway LLM call failed: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  if (body.error) throw new Error(`gateway LLM call returned an error: ${JSON.stringify(body.error)}`);
  const choices = (body.choices ?? []) as Record<string, unknown>[];
  if (!choices.length) {
    throw new Error(`gateway LLM call returned no completion: ${JSON.stringify(body)}`);
  }
  const content = String(((choices[0].message as Record<string, unknown> | undefined)?.content ?? "")).trim();
  if (!content) throw new Error(emptyCompletionReason(choices[0], body));
  return content;
}

function warnIfTruncated(kind: string, returned: number, total: number): void {
  if (total > returned) {
    console.error(
      `warning: ${kind} returned ${returned} of ${total} matches, so the report covers only the first ${returned}; shorten LOOKBACK_HOURS or narrow GITHUB_REPOS`,
    );
  }
}

async function collectActivity(cfg: Config, token: string, since: Date): Promise<Activity> {
  const mergedCall = await mcp(cfg, token, "tools/call", {
    name: cfg.prSearchTool,
    arguments: {
      query: mergedPullRequestQuery(cfg.repos, cfg.githubUsername, since),
      perPage: PER_PAGE,
      fields: PR_FIELDS,
    },
  });
  const mergedParsed = parsePullRequests(toolResultJson(mergedCall));
  warnIfTruncated("merged pull request search", mergedParsed.pulls.length, mergedParsed.total);
  mergedParsed.pulls.sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));

  const openCall = await mcp(cfg, token, "tools/call", {
    name: cfg.prSearchTool,
    arguments: {
      query: openPullRequestQuery(cfg.repos, cfg.githubUsername, since),
      perPage: PER_PAGE,
      fields: PR_FIELDS,
    },
  });
  const openParsed = parsePullRequests(toolResultJson(openCall));
  warnIfTruncated("open pull request search", openParsed.pulls.length, openParsed.total);
  openParsed.pulls.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const issues: Issue[] = [];
  for (const repo of cfg.repos) {
    const listedCall = await mcp(cfg, token, "tools/call", {
      name: cfg.issueListTool,
      arguments: {
        owner: repo.owner,
        repo: repo.name,
        since: githubTimestamp(since),
        orderBy: "CREATED_AT",
        direction: "DESC",
        perPage: PER_PAGE,
        fields: ISSUE_FIELDS,
      },
    });
    const listed = parseIssues(toolResultJson(listedCall), repo);
    warnIfTruncated(`issue listing for ${slug(repo)}`, listed.issues.length, listed.total);
    issues.push(...issuesOpenedSince(listed.issues, since));
  }
  issues.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    username: cfg.githubUsername,
    lookbackHours: cfg.lookbackHours,
    repos: cfg.repos,
    merged: mergedParsed.pulls,
    inProgress: openParsed.pulls,
    issues,
  };
}

function buildPrompt(activity: Activity): string {
  const repos = activity.repos.map(slug).join(", ");
  const lines = [
    `GitHub activity for @${activity.username} over the last ${activity.lookbackHours} hours, across ${repos}.`,
    "",
    `Pull requests merged (${activity.merged.length}):`,
  ];
  for (const pull of activity.merged) {
    lines.push(`- ${pull.repo}#${pull.number} ${pull.title} (merged ${pull.mergedAt})`);
  }
  if (!activity.merged.length) lines.push("- none");
  lines.push(
    "",
    `Pull requests still open and updated in the window (${activity.inProgress.length}):`,
  );
  for (const pull of activity.inProgress) {
    const draft = pull.draft ? " [draft]" : "";
    lines.push(`- ${pull.repo}#${pull.number} ${pull.title}${draft} (last updated ${pull.updatedAt})`);
  }
  if (!activity.inProgress.length) lines.push("- none");
  lines.push("", `Issues opened in the window (${activity.issues.length}):`);
  for (const issue of activity.issues) {
    lines.push(
      `- ${issue.repo}#${issue.number} ${issue.title} (opened by ${issue.author || "unknown"}, ${issue.createdAt})`,
    );
  }
  if (!activity.issues.length) lines.push("- none");
  lines.push(`
How to read the data above:
- Every pull request and issue is listed with the repository it belongs to and
  its number. Use those verbatim; they are how a reader finds the thing.
- Titles are the author's own words. Say what the change was about in plain
  language rather than quoting the title back, and never infer scope, impact or
  status that the title does not state.
- Issues are listed for the repositories, not for this engineer. They are what
  the team found, not necessarily what this engineer did.

Write the note with exactly these three sections, each on its own line as a
bare heading, in this order:

Done
In progress
Issues found

Under each heading put one "- " bullet per item listed above for that section,
in the same order, each opening with "<repo>#<number>" and then one clause
saying what it is about. Mark a draft as a draft. Where a section has no items,
put a single bullet reading "- Nothing in this window."

Under 200 words total. Plain text, "- " for bullets, no headings beyond the
three above, no bold, no tables, no preamble and no closing remarks. Finish
every sentence. Do not repeat these instructions.`);
  return lines.join("\n");
}

async function deliver(cfg: Config, message: string): Promise<void> {
  if (cfg.outputMode === "stdout") {
    console.log(message);
    return;
  }
  if (cfg.slackWebhookUrl) {
    const response = await fetch(cfg.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`slack webhook failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    console.error("posted report to Slack via webhook");
    return;
  }
  const response = await fetch(SLACK_POST_MESSAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.slackBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: cfg.slackChannel, text: message }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`slack chat.postMessage failed: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text) as { ok?: boolean; error?: string };
  if (!body.ok) throw new Error(`slack chat.postMessage failed: ${body.error}`);
  console.error(`posted report to Slack channel ${cfg.slackChannel}`);
}

async function main(): Promise<void> {
  const lookback = parseLookbackFlag(process.argv.slice(2));
  const cfg = loadConfig(lookback);
  const since = new Date(Date.now() - cfg.lookbackHours * 3600 * 1000);
  const token = await exchangeToken(cfg.domeControlPlane, extractApiKey(cfg.domeApiKey));
  await checkTools(cfg, token);
  const activity = await collectActivity(cfg, token, since);
  console.error(
    `read ${activity.merged.length} merged and ${activity.inProgress.length} open pull requests by ${cfg.githubUsername} and ${activity.issues.length} new issues from ${cfg.repos.length} repositories over the last ${cfg.lookbackHours}h`,
  );
  const header = `GitHub activity for @${cfg.githubUsername} — last ${cfg.lookbackHours} hours`;
  const empty = !activity.merged.length && !activity.inProgress.length && !activity.issues.length;
  const body = empty
    ? "No merged or open pull requests, and no new issues, in this window."
    : await summarize(cfg, token, buildPrompt(activity));
  await deliver(cfg, `${header}\n\n${body}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
