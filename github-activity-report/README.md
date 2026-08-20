# GitHub activity report

Reads one developer's recent GitHub activity across a set of repositories, has an
LLM write a short three-section report — what they finished, what is still moving,
and what issues the team opened — and posts it to a Slack channel.

Everything goes through the Dome gateway: GitHub is read with governed MCP tool
calls and the report comes from an LLM call on the same gateway, so this program
holds no GitHub credential and no model credential of its own — only a Dome agent
key.

The agent is entitled to exactly two read tools. GitHub's MCP server publishes its
whole write surface on the same connection, so being unable to merge a pull
request or file an issue is a property the Blueprint proves rather than a promise
the code makes; see [Read-only is a guardrail, not a convention](#read-only-is-a-guardrail-not-a-convention).

The agent is language-agnostic. `dome-agent.yaml` and `dome-workspace.yaml` are
the agent — identity, entitlements, the closed-world guardrail, the checks.
`main.py`, `ts/main.ts` and `go/main.go` are three processes that carry that
same agent to the Gateway. Swap `runtime.command` to pick a language; do not
edit the entitlements.

## Setup

Python (the Blueprint's default runtime):

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

TypeScript (Node 22+, talks to the Gateway over HTTP — there is no TS SDK yet):

```bash
cd ts && npm install
```

Go (stdlib only):

```bash
# nothing to vendor; `go run ./go` from the repo root
```

`dome blueprint run` uses the Python command in `dome-agent.yaml`. To run the same applied agent in another language without editing the document:

```bash
dome blueprint run -- ts/node_modules/.bin/tsx ts/main.ts
dome blueprint run -- go run ./go
```

## Running it in a workspace

Two Blueprint documents describe everything this agent needs, so a new
environment is a matter of applying them rather than clicking through the
dashboard:

| Document | Declares |
|---|---|
| `dome-workspace.yaml` | everything the workspace provides: the `Default` Gateway, the `GitHub` MCP connection, and the `claude-sonnet` model connection |
| `dome-agent.yaml` | what the agent asserts about itself: identity, entitlements, the guardrail, the checks, and the resource names it passes to the program |

Those names are the workspace's, not this program's, and they are the seam
between the three files. `dome-workspace.yaml` attaches the connection and the
model to a Gateway; `dome-agent.yaml` entitles `GitHub/…` tools and the
`claude-sonnet` model on that Gateway, and passes both names to the program through
`runtime.environment.defaults`. So pointing this agent at a workspace that spells
them differently is an edit to the two documents and nothing more — every
runtime takes the names as configuration and does not need to change.

Tools are addressed `connection/tool` and **both halves are case-sensitive**: a
connection named `GitHub` publishes `GitHub/list_issues`, and `github/list_issues`
resolves to nothing. Check the workspace's own spelling with `dome tool list`
before writing entitlements.

### Connect GitHub before applying

You can let `apply` create the GitHub connection, but configuring it yourself
first is the better habit, and it is the one thing worth doing by hand. Add
GitHub's hosted MCP server as a connection **named `GitHub`** — in the dashboard,
or:

```bash
dome tool add --name GitHub --protocol streamable-http \
  --url https://api.githubcopilot.com/mcp/ \
  --auth-method api-key --credential-type shared \
  --authorization "Bearer github_pat_…" --gateway Default
```

The token goes straight to Dome and stays on the connection, so `apply` finds it
present, reads no secret, and never needs `GITHUB_MCP_TOKEN` in your shell or in
`.env` at all. Applying against a workspace that already has the connection
leaves it alone.

Declaring it in `dome-workspace.yaml` anyway is not redundant. `assess` resolves
the name against the live workspace, so it catches a connection you spelled
differently before anything else fails, and the declaration is what lets this
document stand up a workspace where nobody has done the step above.

This is *not* Dome's GitHub catalog entry, which is a REST toolset publishing
`repos-list-pulls` and friends — different tool names, and nothing this agent's
entitlements or checks would resolve against. See
[Why the hosted MCP server](#why-the-hosted-mcp-server-and-not-domes-github-catalog-integration).

Entitlements resolve against the connection's **observed** tool catalog, not
against the names in the document, and a connection can sit with an empty catalog
for a while after it is created. Check, and sync if it is empty:

```bash
dome tool catalog list GitHub         # expect ~44 tools, not 0
dome tool catalog sync GitHub         # if it is empty
```

Worth catching here, because the failure it produces later is indirect:
entitlements have nothing to resolve against, and the calls fail at run time
rather than at apply.

### Apply

```bash
cp .env.prod.example .env             # then fill it in
dome context use <your-workspace>     # `dome context list` if you don't know its name

# Both documents. Unscoped `blueprint` fans out in dependency order —
# workspace, then agent — because the agent attaches to what workspace creates.
dome blueprint assess                 # confirm the gaps and that you hold the permissions
dome blueprint apply

# Pin what the names resolved to, so a replaced connection is caught later.
dome blueprint bind
```

A Blueprint cannot create a credential; it can only name one, and it reads the
value it names at exactly one moment — see `.env.prod.example`.

**Which credentials you need depends on what the workspace already has.**
Everything in `dome-workspace.yaml` is create-if-missing, and a credential is
read only by a create:

- The workspace already has the connection and the model — the step above, an
  administrator, or an earlier apply. Then nothing needs a secret. Dome
  holds the GitHub token on its connection and the provider key on its model,
  and `assess` reports the workspace half `satisfied` with an empty environment.
- Either one is missing. Then the matching variable must be set before apply,
  because that is the moment the value is handed to Dome. `assess` says so by
  name, as a blocker, before it attempts anything.

A workspace with GitHub connected from the catalog and a model connection an
administrator already configured needs no secrets in the environment whatsoever
— only `GITHUB_USERNAME`, which is not one.

Either way the *program* never sees those secrets: it authenticates as the agent
and reaches GitHub and the model through the Gateway.

`assess` is worth reading rather than skipping. It resolves every declared name
against the live workspace, so a connection spelled differently, a model that
does not exist, or a tool the connection does not publish shows up as
`unresolved` there instead of as a failure at run time. Entitlements resolve
against the Gateway's *observed* tool catalog, and `apply` waits for a newly
created connection's tools to be observed before attaching them.

### Run

Put the values the Blueprint declares but deliberately does not carry in `.env`,
which `run` reads from beside the Blueprint:

```bash
cat > .env <<'ENV'
export GITHUB_USERNAME=your-login
export OUTPUT_MODE=stdout          # print instead of posting, for a first run
ENV
```

Mint a key once and record it in the same file, then every later run needs no
flags at all:

```bash
dome blueprint run --provision-key --write-key-to .env
dome blueprint run
```

`run` injects `DOME_AGENT_API_KEY`, `DOME_GATEWAY_URL`, `DOME_API_URL`,
`DOME_WORKSPACE_ID` and `DOME_AGENT_ID` from the applied Blueprint and runs
`main.py` with them. Before starting it reports *every* reason it cannot — a
missing required variable, an unregistered agent, an absent key — rather than one
per attempt.

`--provision-key` creates or rotates this user's agent key. Rotation invalidates
whatever key was there before, so it asks first; `--yes` answers in advance.
`--write-key-to` is what makes it a one-time step: the key is written as an
`export` statement, replacing any previous one, and the file is left readable
only by you. Without it nothing is persisted, which is the right default for a
credential but means the flag is needed on every run.

The `export` prefixes are not required — `NAME=value` parses too — but they keep
the same file usable with `source .env` when running `main.py` directly. Values
already in your environment win over the file, so a one-off override needs no
edit. Use `--env-file` for a file under another name, and keep any file holding a
key out of version control; `run` warns when git does not ignore the one it wrote
to.

`.env` and `.env.*` are covered by `.gitignore`. Treat the file as the credential
it holds, and re-provision when the key is revoked or rotated elsewhere.

`OUTPUT_MODE=stdout` is what keeps a first run out of Slack: an env file beats the
Blueprint's `runtime.environment.defaults`, so that one line is enough.

## Running it directly

Useful for iterating without a Blueprint. Every variable is documented in the
docstring at the top of `main.py`. Nothing here is optional guesswork: the tool
and model names must match what the target workspace actually publishes, which is
what the Blueprint would otherwise pass in for you.

```bash
DOME_AGENT_API_KEY=<agent key or envelope> \
DOME_GATEWAY_URL=https://gateway.example/gateways/<gateway-uuid> \
DOME_API_URL=https://app.domesystems.ai \
GITHUB_USERNAME=dcohen \
GITHUB_REPOS=dome-systems/prod-dome,dome-systems/sdk-dome-python \
SUMMARY_MODEL=claude-sonnet \
GITHUB_PR_SEARCH_TOOL=GitHub/search_pull_requests \
GITHUB_ISSUE_LIST_TOOL=GitHub/list_issues \
OUTPUT_MODE=stdout \
./.venv/bin/python main.py --lookback-hours 72
# or:  ts/node_modules/.bin/tsx ts/main.ts --lookback-hours 72
# or:  go run ./go --lookback-hours 72
```

To post to Slack, drop `OUTPUT_MODE` and set either `SLACK_WEBHOOK_URL`, or
`SLACK_BOT_TOKEN` together with `SLACK_CHANNEL`.

## Tests

```bash
./.venv/bin/pip install pytest ruff
./.venv/bin/python -m pytest test_main.py
./.venv/bin/ruff check . && ./.venv/bin/ruff format --check .
```

The window arithmetic, the GitHub search grammar, the reply parsing and the
prompt are all importable and covered. Only the gateway is faked, and only at the
SDK boundary: the fake hands back real `dome.ToolCallResult` objects carrying the
JSON GitHub's MCP server actually returns.

## Read-only is a guardrail, not a convention

`dome-agent.yaml` sets `entitlements.exclusive: true`. That makes the entitled
lists a closed world rather than a minimum, and compiles a generated
`dome-exclusive-entitlements.cedar` into the Revision:

```cedar
forbid (principal is Dome::Agent, action == Dome::Action::"mcp:call", resource)
unless { resource in [Dome::MCPTool::"GitHub/list_issues", Dome::MCPTool::"GitHub/search_pull_requests"] };
```

The point is the `unless`. A hand-written deny-list would name today's mutating
tools and quietly stop covering the next one GitHub ships; a closed world denies
everything that is not one of the two reads, including tools that do not exist
yet. The `checks` block then asserts both halves — the two reads allowed, three
mutating tools denied — and `dome blueprint assess` re-runs them against the live
effective policy in every environment.

## Things that bite

- **The agent key must be exchanged, not sent raw.** A key minted through the API
  or CLI arrives as a base64 envelope wrapping a `dome_…` key, and the gateway
  rejects that inner key as a bearer token with `401 invalid or expired token`.
  It has to be exchanged at the control plane first, which is why `DOME_API_URL`
  is required. The SDK's `auto` mode resolves to raw whenever a gateway URL is
  set, so this program names `exchange` explicitly.
- **A reasoning model can spend its whole budget and return nothing.** Hidden
  reasoning bills against the output ceiling, and raising the ceiling only helps
  until the gateway's own upstream timeout cuts the request off — so past a
  point such a model simply cannot finish this task. The declared
  `gpt-5.5` is one; `claude-sonnet` answers directly, which makes this worth watching rather than
  theoretical: an empty completion is reported with its `finish_reason` and token
  count so the case is recognisable rather than looking like a server fault. If
  you see `finish_reason=length` with no text, point `SUMMARY_MODEL` at a model
  that answers directly.
- **`exclusive: true` starts managing the agent's rule bundle.** Omitting a
  `rules` block normally means "leave the existing user-authored bundle alone".
  With `exclusive`, the compiler synthesizes one, and apply then owns it. On an
  agent that already had a hand-written bundle, that is a replacement.
- **A check on a tool the connection does not publish does not pass — it does not
  resolve.** Checks resolve against the observed catalog, so an unpublished
  resource is reported as `Unresolved`. This is why the connection uses the plain
  MCP endpoint rather than the `/readonly` variant GitHub also offers: on a
  read-only endpoint the mutating tools would be absent, and the deny-checks that
  prove the guardrail would have nothing to resolve against.
- **GitHub is renaming its write tools underneath you.** The server is moving from
  a consolidated `issue_write` to feature-flagged granular tools (`create_issue`
  and friends), so which of them a given deployment publishes varies. If
  `issue-write-denied` starts reporting `Unresolved`, the tool was renamed, not
  un-denied — repoint the check. The guardrail itself is unaffected, because it
  denies by omission rather than by name.
- **Tool names drift, so they are configuration.** `GITHUB_PR_SEARCH_TOOL` and
  `GITHUB_ISSUE_LIST_TOOL` carry them, supplied by the Blueprint under
  `runtime.environment.defaults` and overridable from the environment. The program
  checks the published catalog before doing any work — a missing tool fails
  immediately, names what the Gateway does publish, and says which variable to
  set. `main.py`'s own constants are a fallback for running without a Blueprint
  and name no particular workspace's spelling, so trust the Blueprint or the
  environment over them.
- **`search_issues` is no longer a search.** GitHub's MCP server now documents it
  as natural-language semantic matching, which cannot be trusted to return every
  issue opened in a window. The issues section therefore uses `list_issues` per
  repository instead. Its `since` filter is *last updated*, not *created*, so it
  returns a superset — an old issue someone commented on today comes back too —
  and `main.py` filters to genuinely new issues itself.
- **The two GitHub tools answer in two different envelopes.** `search_pull_requests`
  is REST-backed and returns `{total_count, items}`; `list_issues` is
  GraphQL-backed and returns `{totalCount, issues}`. Both are read through the
  same helper, which is why it takes the key as an argument.
- **Both tools cap at 100 results per call and this program does not paginate.**
  Each reply carries its own total, and a run that overflows warns on stderr
  naming the count it missed rather than silently reporting a partial window. A
  busy monorepo over a long `--lookback-hours` is the case that hits it.
- **Search has its own, much lower rate limit.** GitHub allows roughly 30
  search requests per minute against 5,000 core requests per hour, and two of
  every run's calls are searches. One run per hour is nowhere near it; a retry
  loop around the whole program would find it quickly.
- **Give the PAT the smallest scope that works.** A fine-grained token needs only
  read access to Contents, Issues, Pull requests and Metadata on the repositories
  in `GITHUB_REPOS`. A classic token has no read-only equivalent for private
  repositories — `repo` grants write as well — which is the strongest practical
  argument for the fine-grained kind here. For public repositories `public_repo`
  alone is enough. Note that the guardrail constrains the *agent*, not the token:
  anything else holding that token still has whatever it grants.
- **Generated context names are not stable identifiers.** A context name is
  derived from the org, tenant and workspace names at sync time, so a sync that
  runs before the org name resolves produces one name and the next sync renames
  it — `--context` in a saved script or a note to a colleague then matches
  nothing, with no hint that the name merely moved. Run `dome context use` once
  and let commands inherit it; reach for `dome context list` when a name that
  worked yesterday stops matching.
- **`dome blueprint run` is not a deployment.** It supervises one local process.
  A recurring report still needs a cron job or container of its own, consuming
  the same environment the Blueprint declares.
- **The two applies need different permissions.** Workspace apply needs
  `gateway.manage`; agent apply needs `agent.register` and `rules.deploy`. If
  those are different people, `assess` reports a handoff rather than failing.
- **No environment variable this program reads may start with `DOME_`** unless the
  Blueprint runtime injects it. That namespace is reserved, which is why the
  model name is `SUMMARY_MODEL` rather than `DOME_MODEL`.
- **Slack is the one ungoverned hop.** The bot token lives in `.env` and the
  post goes straight to Slack. Routing it through the Gateway's
  `slack_send_message` tool would put it under the same policy as everything else.
- **The report carries private repository content.** Pull request and issue titles
  from private repositories go into whatever channel you point it at, so pick the
  channel as deliberately as you picked the token's scope.

## Why the hosted MCP server, and not Dome's GitHub catalog integration

Dome ships a GitHub REST toolset in its own catalog, with tools named
`repos-list-issues`, `repos-list-pulls`, `repos-pulls-merge` and so on. Two
reasons this agent does not use it.

A workspace Blueprint can only declare a `streamable-http` MCP connection.
Catalog connections are instantiated exclusively through
`InstallCatalogConnection` from the dashboard, which would put the one thing this
repository exists to declare back into a per-environment click-through — the
declaration could not be checked, diffed or pinned.

The two toolsets are also not interchangeable. Every tool name here would change,
so the entitlements, the `GITHUB_*_TOOL` values and all six checks are written
against one or the other and cannot straddle both. Anyone repointing this agent at
the catalog toolset is editing both documents, not swapping a URL.
