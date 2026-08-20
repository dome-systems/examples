#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["dome-sdk>=0.3.0", "httpx"]
# ///
"""Report one developer's recent GitHub activity across a set of repositories.

Everything that touches data goes through the Dome gateway: pull requests and
issues are read with governed MCP tool calls, and the prose report comes from an
LLM call on the same gateway. The result is posted to Slack, or printed for
testing.

The report has three sections: work merged in the window, unmerged pull requests
still moving, and issues opened in the window.

Run it:

    ./.venv/bin/python main.py

or, with a Dome Blueprint applied, let the platform supply the gateway
environment:

    dome blueprint dev

Required environment. The first three are injected by `dome blueprint dev`, so
their names are the platform's rather than this program's:

    DOME_AGENT_API_KEY  Dome agent API key, exchanged at the control plane for a
                        gateway-scoped token
    DOME_GATEWAY_URL    Scoped gateway URL, including its /gateways/{id} path
    DOME_API_URL        Control-plane URL, used to exchange the agent key

The rest name things this program cannot invent: which developer to report on,
which repositories to read, and what the workspace calls the gateway resources it
routes. A Blueprint supplies them under runtime.environment.defaults, so
`dome blueprint dev` needs none of them set by hand; a direct run must pass them,
and is told by name which are missing:

    GITHUB_USERNAME     The GitHub login whose work is being reported
    GITHUB_REPOS        Comma-separated owner/repo list to report on
    SUMMARY_MODEL       Model connection the gateway routes, e.g. "claude-sonnet"
    GITHUB_PR_SEARCH_TOOL
                        Gateway tool that searches pull requests, addressed
                        connection/tool, e.g. "GitHub/search_pull_requests"
    GITHUB_ISSUE_LIST_TOOL
                        Gateway tool that lists a repository's issues, e.g.
                        "GitHub/list_issues"

Optional environment. None of these may start with DOME_, which the Blueprint
runtime reserves for values it injects itself:

    LOOKBACK_HOURS      Size of the window to report on (default 24).
                        --lookback-hours overrides it.
    OUTPUT_MODE         "slack" (default) or "stdout" to print instead of posting
    ACT_AS_EMAIL        Identity to act as; omit to act as the agent itself
    SLACK_WEBHOOK_URL   Incoming webhook URL; the simplest way to post
    SLACK_BOT_TOKEN     Bot token ("xoxb-...") for chat.postMessage
    SLACK_CHANNEL       Channel ID or name, required alongside SLACK_BOT_TOKEN

To post to Slack, set either SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN together
with SLACK_CHANNEL.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import dome
import httpx

# The one value with a defensible default: a day's window is what a daily report
# means, and it is true of every environment. Everything else this program reads
# either names a resource the workspace owns or scopes the report, and guessing
# either produces a confidently wrong answer instead of an error.
LOOKBACK_HOURS_DEFAULT = 24

# The most either tool will return in one call. Both cap at 100, and a window
# that overflows that is reported rather than silently truncated.
PER_PAGE = 100

# Only the fields the report actually reads. Left off, both tools return every
# pull request and issue body, which is by far the largest part of the payload
# and is never used here.
PR_FIELDS = [
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
]
ISSUE_FIELDS = [
    "number",
    "title",
    "state",
    "html_url",
    "user",
    "created_at",
    "updated_at",
]

SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"
HTTP_TIMEOUT = 60.0
# The SDK defaults to 30s, which covers the GitHub reads but not a report
# completion. The gateway enforces its own, shorter ceiling on the upstream
# call, so this only has to be generous enough not to be the first to give up.
GATEWAY_TIMEOUT = 120.0


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Repo:
    owner: str
    name: str

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"


@dataclass(frozen=True)
class Config:
    dome_api_key: str
    dome_gateway: str
    dome_control_plane: str
    dome_model: str
    github_username: str
    repos: tuple[Repo, ...]
    pr_search_tool: str
    issue_list_tool: str
    act_as_email: str
    lookback_hours: int
    output_mode: str
    slack_webhook_url: str
    slack_bot_token: str
    slack_channel: str


def parse_repos(raw: str) -> tuple[Repo, ...]:
    """Read a comma-separated owner/repo list.

    Both tools take the owner and the repository as separate arguments, so a
    malformed entry has to be caught here rather than becoming a confusing
    argument error one call later.
    """
    repos: list[Repo] = []
    for entry in raw.split(","):
        slug = entry.strip()
        if not slug:
            continue
        parts = slug.split("/")
        if len(parts) != 2 or not all(parts):
            raise SystemExit(
                f"GITHUB_REPOS entry {slug!r} is not owner/repo; expected a list "
                'like "dome-systems/prod-dome,dome-systems/sdk-dome-python"'
            )
        repos.append(Repo(owner=parts[0], name=parts[1]))
    if not repos:
        raise SystemExit("GITHUB_REPOS is empty; it needs at least one owner/repo")
    return tuple(repos)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Report one developer's recent GitHub activity."
    )
    parser.add_argument(
        "--lookback-hours",
        type=int,
        default=None,
        help="size of the window to report on, overriding LOOKBACK_HOURS",
    )
    return parser.parse_args(argv)


def load_config(lookback_override: int | None = None) -> Config:
    required = {
        "DOME_AGENT_API_KEY": os.environ.get("DOME_AGENT_API_KEY", ""),
        "DOME_GATEWAY_URL": os.environ.get("DOME_GATEWAY_URL", ""),
        "DOME_API_URL": os.environ.get("DOME_API_URL", ""),
        "GITHUB_USERNAME": os.environ.get("GITHUB_USERNAME", ""),
        "GITHUB_REPOS": os.environ.get("GITHUB_REPOS", ""),
        "SUMMARY_MODEL": os.environ.get("SUMMARY_MODEL", ""),
        "GITHUB_PR_SEARCH_TOOL": os.environ.get("GITHUB_PR_SEARCH_TOOL", ""),
        "GITHUB_ISSUE_LIST_TOOL": os.environ.get("GITHUB_ISSUE_LIST_TOOL", ""),
    }
    missing = sorted(name for name, value in required.items() if not value)
    if missing:
        raise SystemExit(f"missing required env vars: {', '.join(missing)}")

    output_mode = os.environ.get("OUTPUT_MODE", "slack").lower()
    if output_mode not in ("slack", "stdout"):
        raise SystemExit(
            f'OUTPUT_MODE must be "slack" or "stdout", got {output_mode!r}'
        )

    if lookback_override is not None:
        if lookback_override < 1:
            raise SystemExit(
                f"--lookback-hours must be a positive integer, got {lookback_override}"
            )
        lookback_hours = lookback_override
    else:
        lookback_raw = os.environ.get("LOOKBACK_HOURS", str(LOOKBACK_HOURS_DEFAULT))
        if not lookback_raw.isdigit() or int(lookback_raw) < 1:
            raise SystemExit(
                f"LOOKBACK_HOURS must be a positive integer, got {lookback_raw!r}"
            )
        lookback_hours = int(lookback_raw)

    cfg = Config(
        dome_api_key=required["DOME_AGENT_API_KEY"],
        dome_gateway=required["DOME_GATEWAY_URL"].rstrip("/"),
        dome_control_plane=required["DOME_API_URL"].rstrip("/"),
        dome_model=required["SUMMARY_MODEL"],
        github_username=required["GITHUB_USERNAME"].lstrip("@"),
        repos=parse_repos(required["GITHUB_REPOS"]),
        pr_search_tool=required["GITHUB_PR_SEARCH_TOOL"],
        issue_list_tool=required["GITHUB_ISSUE_LIST_TOOL"],
        act_as_email=os.environ.get("ACT_AS_EMAIL", ""),
        lookback_hours=lookback_hours,
        output_mode=output_mode,
        slack_webhook_url=os.environ.get("SLACK_WEBHOOK_URL", ""),
        slack_bot_token=os.environ.get("SLACK_BOT_TOKEN", ""),
        slack_channel=os.environ.get("SLACK_CHANNEL", ""),
    )

    if (
        cfg.output_mode == "slack"
        and not cfg.slack_webhook_url
        and not (cfg.slack_bot_token and cfg.slack_channel)
    ):
        raise SystemExit(
            "OUTPUT_MODE=slack needs SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and "
            "SLACK_CHANNEL (or set OUTPUT_MODE=stdout)"
        )
    return cfg


# --------------------------------------------------------------------------
# The activity window and GitHub's search grammar
# --------------------------------------------------------------------------


def window_start(now: datetime, lookback_hours: int) -> datetime:
    return now - timedelta(hours=lookback_hours)


def github_timestamp(moment: datetime) -> str:
    """Format an instant the way GitHub's search qualifiers expect it."""
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_timestamp(value: str) -> datetime:
    """Read a GitHub API timestamp into an aware datetime."""
    if not value:
        raise ValueError("empty timestamp")
    moment = datetime.fromisoformat(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def repo_scope(repos: tuple[Repo, ...]) -> str:
    """The repo: qualifiers that bound a search. Repeating one ORs them."""
    return " ".join(f"repo:{repo.slug}" for repo in repos)


def merged_pull_request_query(
    repos: tuple[Repo, ...], username: str, since: datetime
) -> str:
    """Pull requests by this author that reached main during the window."""
    return (
        f"{repo_scope(repos)} author:{username} is:merged "
        f"merged:>={github_timestamp(since)}"
    )


def open_pull_request_query(
    repos: tuple[Repo, ...], username: str, since: datetime
) -> str:
    """Pull requests by this author still open and touched during the window."""
    return (
        f"{repo_scope(repos)} author:{username} is:open "
        f"updated:>={github_timestamp(since)}"
    )


# --------------------------------------------------------------------------
# Reading GitHub through the gateway
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PullRequest:
    repo: str
    number: int
    title: str
    url: str
    draft: bool
    updated_at: str
    merged_at: str


@dataclass(frozen=True)
class Issue:
    repo: str
    number: int
    title: str
    url: str
    author: str
    created_at: str


def repo_slug_from_api_url(url: str) -> str:
    """Recover "owner/name" from a repository API URL.

    Search hits carry their repository only as
    https://api.github.com/repos/{owner}/{name}, and the report groups by
    repository, so the slug has to come back out of the URL.
    """
    marker = "/repos/"
    index = url.rfind(marker)
    if index < 0:
        raise RuntimeError(f"unrecognized repository URL in search result: {url!r}")
    parts = url[index + len(marker) :].strip("/").split("/")
    if len(parts) < 2 or not all(parts[:2]):
        raise RuntimeError(f"unrecognized repository URL in search result: {url!r}")
    return f"{parts[0]}/{parts[1]}"


def reply_records(payload: Any, key: str, what: str) -> list[Any]:
    """Take the list of records out of a tool reply.

    The reply is JSON the gateway passed through from GitHub untouched, so a
    shape that does not hold the expected list means the tool changed under us.
    Naming the key that was missing is what makes that debuggable from a log.
    """
    records = payload.get(key) if isinstance(payload, dict) else None
    if records is None or not isinstance(records, list):
        raise RuntimeError(f"{what} reply has no {key!r} list: {payload!r:.500}")
    return records


def parse_pull_requests(payload: Any) -> tuple[list[PullRequest], int]:
    """Read the pull-request search reply into records plus its total count.

    The total is reported separately because it counts every match, while
    ``items`` holds only the page that was asked for.
    """
    items = reply_records(payload, "items", "pull request search")

    pull_requests = []
    for item in items:
        merged_at = (item.get("pull_request") or {}).get("merged_at") or ""
        pull_requests.append(
            PullRequest(
                repo=repo_slug_from_api_url(item.get("repository_url") or ""),
                number=int(item["number"]),
                title=(item.get("title") or "").strip(),
                url=item.get("html_url") or "",
                draft=bool(item.get("draft")),
                updated_at=item.get("updated_at") or "",
                merged_at=merged_at,
            )
        )
    return pull_requests, int(payload.get("total_count") or len(pull_requests))


def parse_issues(payload: Any, repo: Repo) -> tuple[list[Issue], int]:
    """Read one repository's issue listing into records plus its total count."""
    items = reply_records(payload, "issues", f"issue listing for {repo.slug}")

    issues = [
        Issue(
            repo=repo.slug,
            number=int(item["number"]),
            title=(item.get("title") or "").strip(),
            url=item.get("html_url") or "",
            author=((item.get("user") or {}).get("login") or "").strip(),
            created_at=item.get("created_at") or "",
        )
        for item in items
    ]
    return issues, int(payload.get("totalCount") or len(issues))


def issues_opened_since(issues: list[Issue], since: datetime) -> list[Issue]:
    """Keep the issues actually created in the window, newest first.

    The listing is filtered server-side on last-updated rather than created, so
    it is a superset: every issue created in the window was also updated in it,
    but so was every older issue someone commented on.
    """
    recent = [issue for issue in issues if parse_timestamp(issue.created_at) >= since]
    recent.sort(key=lambda issue: issue.created_at, reverse=True)
    return recent


class Gateway:
    """The Dome gateway, which is this program's only route to data.

    GitHub reads are MCP tool calls so they stay governed and audited, and the
    report is an LLM call on the same connection.
    """

    def __init__(self, cfg: Config, client: dome.Client) -> None:
        self.cfg = cfg
        self.client = client
        self.act_as = (
            dome.PlainActAs(email=cfg.act_as_email) if cfg.act_as_email else None
        )

    def check_tools(self) -> None:
        """Fail before doing any work if either tool isn't published."""
        catalog = self.client.gateway.tools.list(act_as=self.act_as)
        published = {tool.name for tool in catalog.tools}
        wanted = {
            "GITHUB_PR_SEARCH_TOOL": self.cfg.pr_search_tool,
            "GITHUB_ISSUE_LIST_TOOL": self.cfg.issue_list_tool,
        }
        for variable, name in sorted(wanted.items()):
            if name not in published:
                raise SystemExit(
                    f"gateway does not publish tool {name!r}; available tools: "
                    f"{', '.join(sorted(published)) or '(none)'}. "
                    f"Set {variable} to the right one."
                )

    def search_pull_requests(self, query: str) -> tuple[list[PullRequest], int]:
        result = self.client.gateway.tools.call(
            self.cfg.pr_search_tool,
            {"query": query, "perPage": PER_PAGE, "fields": PR_FIELDS},
            act_as=self.act_as,
        )
        return parse_pull_requests(result.json())

    def list_issues(self, repo: Repo, since: datetime) -> tuple[list[Issue], int]:
        result = self.client.gateway.tools.call(
            self.cfg.issue_list_tool,
            {
                "owner": repo.owner,
                "repo": repo.name,
                "since": github_timestamp(since),
                "orderBy": "CREATED_AT",
                "direction": "DESC",
                "perPage": PER_PAGE,
                "fields": ISSUE_FIELDS,
            },
            act_as=self.act_as,
        )
        return parse_issues(result.json(), repo)

    @staticmethod
    def empty_completion_reason(choice: dict, response: dict) -> str:
        """Explain an empty completion in terms the reader can act on.

        A reasoning model bills its hidden reasoning against the output ceiling,
        so it can spend the whole budget and return nothing. That looks
        identical to a server fault unless the finish reason and token count are
        reported.
        """
        finish = choice.get("finish_reason") or "unknown"
        usage = response.get("usage") or {}
        detail = f"finish_reason={finish}, completion_tokens={usage.get('completion_tokens')}"
        if finish == "length":
            return (
                f"model {response.get('model') or '?'} reached its output ceiling "
                f"without producing any text ({detail}). That is what a reasoning "
                "model does when hidden reasoning consumes the whole budget — and "
                "raising the ceiling only works until the gateway's upstream timeout "
                "stops the request, so point SUMMARY_MODEL at a model that answers "
                "directly instead."
            )
        return f"gateway LLM call returned an empty completion ({detail})"

    def summarize(self, prompt: str) -> str:
        """Have a model behind the gateway turn the activity into prose."""
        response = self.client.gateway.llm.chat(
            model=self.cfg.dome_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            act_as=self.act_as,
        )
        error = response.get("error")
        if error:
            raise RuntimeError(f"gateway LLM call returned an error: {error}")
        choices = response.get("choices") or []
        if not choices:
            raise RuntimeError(
                f"gateway LLM call returned no completion: {dict(response)}"
            )
        content = (choices[0].get("message") or {}).get("content") or ""
        if not content.strip():
            raise RuntimeError(self.empty_completion_reason(choices[0], response))
        return content.strip()


# --------------------------------------------------------------------------
# Collecting the window
# --------------------------------------------------------------------------


@dataclass
class Activity:
    username: str
    lookback_hours: int
    repos: tuple[Repo, ...]
    merged: list[PullRequest]
    in_progress: list[PullRequest]
    issues: list[Issue]

    @property
    def is_empty(self) -> bool:
        return not (self.merged or self.in_progress or self.issues)


def warn_if_truncated(kind: str, returned: int, total: int) -> None:
    if total > returned:
        print(
            f"warning: {kind} returned {returned} of {total} matches, so the report "
            f"covers only the first {returned}; shorten LOOKBACK_HOURS or narrow "
            "GITHUB_REPOS",
            file=sys.stderr,
        )


def collect_activity(gateway: Gateway, since: datetime) -> Activity:
    cfg = gateway.cfg

    merged, merged_total = gateway.search_pull_requests(
        merged_pull_request_query(cfg.repos, cfg.github_username, since)
    )
    warn_if_truncated("merged pull request search", len(merged), merged_total)
    merged.sort(key=lambda pull: pull.merged_at, reverse=True)

    in_progress, open_total = gateway.search_pull_requests(
        open_pull_request_query(cfg.repos, cfg.github_username, since)
    )
    warn_if_truncated("open pull request search", len(in_progress), open_total)
    in_progress.sort(key=lambda pull: pull.updated_at, reverse=True)

    issues: list[Issue] = []
    for repo in cfg.repos:
        listed, listed_total = gateway.list_issues(repo, since)
        warn_if_truncated(f"issue listing for {repo.slug}", len(listed), listed_total)
        issues.extend(issues_opened_since(listed, since))
    issues.sort(key=lambda issue: issue.created_at, reverse=True)

    return Activity(
        username=cfg.github_username,
        lookback_hours=cfg.lookback_hours,
        repos=cfg.repos,
        merged=merged,
        in_progress=in_progress,
        issues=issues,
    )


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You write a short recurring note about one engineer's GitHub work for their "
    "team's Slack channel. Your readers know the codebase but have not seen this "
    "week's pull requests. Use only the pull requests and issues you are given: "
    "never invent one, never describe work that is not listed, and never estimate "
    "a number that is absent."
)


def build_prompt(activity: Activity) -> str:
    repos = ", ".join(repo.slug for repo in activity.repos)
    lines = [
        (
            f"GitHub activity for @{activity.username} over the last "
            f"{activity.lookback_hours} hours, across {repos}."
        ),
        "",
        f"Pull requests merged ({len(activity.merged)}):",
    ]
    for pull in activity.merged:
        lines.append(
            f"- {pull.repo}#{pull.number} {pull.title} (merged {pull.merged_at})"
        )
    if not activity.merged:
        lines.append("- none")

    lines += [
        "",
        f"Pull requests still open and updated in the window ({len(activity.in_progress)}):",
    ]
    for pull in activity.in_progress:
        draft = " [draft]" if pull.draft else ""
        lines.append(
            f"- {pull.repo}#{pull.number} {pull.title}{draft} "
            f"(last updated {pull.updated_at})"
        )
    if not activity.in_progress:
        lines.append("- none")

    lines += ["", f"Issues opened in the window ({len(activity.issues)}):"]
    for issue in activity.issues:
        lines.append(
            f"- {issue.repo}#{issue.number} {issue.title} "
            f"(opened by {issue.author or 'unknown'}, {issue.created_at})"
        )
    if not activity.issues:
        lines.append("- none")

    lines.append(
        """
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
every sentence. Do not repeat these instructions."""
    )
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Delivery
# --------------------------------------------------------------------------


def deliver(cfg: Config, message: str) -> None:
    if cfg.output_mode == "stdout":
        print(message)
        return

    if cfg.slack_webhook_url:
        response = httpx.post(
            cfg.slack_webhook_url, json={"text": message}, timeout=HTTP_TIMEOUT
        )
        if response.is_error:
            raise RuntimeError(
                f"slack webhook failed: HTTP {response.status_code}: {response.text[:500]}"
            )
        print("posted report to Slack via webhook", file=sys.stderr)
        return

    response = httpx.post(
        SLACK_POST_MESSAGE_URL,
        headers={"Authorization": f"Bearer {cfg.slack_bot_token}"},
        json={"channel": cfg.slack_channel, "text": message},
        timeout=HTTP_TIMEOUT,
    )
    if response.is_error:
        raise RuntimeError(
            f"slack chat.postMessage failed: HTTP {response.status_code}: {response.text[:500]}"
        )
    body = response.json()
    if not body.get("ok"):
        raise RuntimeError(f"slack chat.postMessage failed: {body.get('error')}")
    print(f"posted report to Slack channel {cfg.slack_channel}", file=sys.stderr)


# --------------------------------------------------------------------------


def main() -> None:
    args = parse_args()
    cfg = load_config(args.lookback_hours)
    since = window_start(datetime.now(UTC), cfg.lookback_hours)

    # An agent key issued by the API arrives as a base64 envelope wrapping a
    # dome_ key, and the gateway rejects that inner key as a bearer token — it
    # has to be exchanged at the control plane for a gateway-scoped token first.
    # "auto" resolves to raw whenever a gateway URL is set, so the mode is named
    # explicitly rather than inferred.
    with dome.Client(
        token=cfg.dome_api_key,
        gateway_url=cfg.dome_gateway,
        control_plane_url=cfg.dome_control_plane,
        gateway_auth_mode="exchange",
        request_timeout=GATEWAY_TIMEOUT,
    ) as client:
        gateway = Gateway(cfg, client)
        gateway.check_tools()

        activity = collect_activity(gateway, since)
        print(
            f"read {len(activity.merged)} merged and {len(activity.in_progress)} open "
            f"pull requests by {cfg.github_username} and {len(activity.issues)} new "
            f"issues from {len(cfg.repos)} repositories over the last "
            f"{cfg.lookback_hours}h",
            file=sys.stderr,
        )

        header = f"GitHub activity for @{cfg.github_username} — last {cfg.lookback_hours} hours"
        if activity.is_empty:
            body = "No merged or open pull requests, and no new issues, in this window."
        else:
            body = gateway.summarize(build_prompt(activity))

    deliver(cfg, f"{header}\n\n{body}")


if __name__ == "__main__":
    try:
        main()
    except dome.DomeGatewayError as exc:
        print(
            f"dome gateway call failed: {exc} (status={exc.status_code}, "
            f"gateway={exc.gateway_id or exc.gateway_url or '?'}, "
            f"request_id={exc.request_id or '?'}, raw={exc.raw})",
            file=sys.stderr,
        )
        sys.exit(1)
    except (dome.DomeError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
