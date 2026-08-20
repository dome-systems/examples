"""Tests for the pure logic behind the GitHub activity report.

Only the gateway is faked, and only at the SDK boundary: tool replies are real
``dome.ToolCallResult`` objects carrying the JSON the GitHub MCP server actually
returns, so the parsing under test is the parsing that runs in production.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import dome
import pytest

import main

WINDOW_START = datetime(2026, 8, 9, 12, 0, 0, tzinfo=UTC)
REPOS = (
    main.Repo("dome-systems", "prod-dome"),
    main.Repo("dome-systems", "sdk-dome-python"),
)


# --------------------------------------------------------------------------
# Repository lists
# --------------------------------------------------------------------------


def test_repos_are_parsed_from_a_comma_separated_list():
    repos = main.parse_repos("dome-systems/prod-dome, dome-systems/sdk-dome-python")
    assert [repo.slug for repo in repos] == [
        "dome-systems/prod-dome",
        "dome-systems/sdk-dome-python",
    ]
    assert repos[0].owner == "dome-systems"
    assert repos[0].name == "prod-dome"


def test_repo_without_an_owner_is_rejected():
    with pytest.raises(SystemExit, match="not owner/repo"):
        main.parse_repos("prod-dome")


def test_repo_with_a_trailing_path_segment_is_rejected():
    with pytest.raises(SystemExit, match="not owner/repo"):
        main.parse_repos("dome-systems/prod-dome/pulls")


def test_repo_list_of_only_separators_is_rejected():
    with pytest.raises(SystemExit, match="at least one owner/repo"):
        main.parse_repos(" , ")


def test_a_repo_list_is_split_on_commas_and_trimmed():
    repos = main.parse_repos(" dome-systems/prod-dome , dome-systems/sdk-dome-python ")
    assert [repo.slug for repo in repos] == [
        "dome-systems/prod-dome",
        "dome-systems/sdk-dome-python",
    ]


# --------------------------------------------------------------------------
# The window and GitHub's search grammar
# --------------------------------------------------------------------------


def test_window_start_subtracts_the_lookback():
    now = datetime(2026, 8, 10, 12, 0, 0, tzinfo=UTC)
    assert main.window_start(now, 24) == datetime(2026, 8, 9, 12, 0, 0, tzinfo=UTC)


def test_search_timestamps_are_utc_with_a_z_suffix():
    assert main.github_timestamp(WINDOW_START) == "2026-08-09T12:00:00Z"


def test_search_timestamps_convert_a_non_utc_instant():
    from datetime import timedelta, timezone

    kolkata = timezone(timedelta(hours=5, minutes=30))
    moment = datetime(2026, 8, 9, 17, 30, 0, tzinfo=kolkata)
    assert main.github_timestamp(moment) == "2026-08-09T12:00:00Z"


def test_merged_query_scopes_every_repository_and_the_author():
    query = main.merged_pull_request_query(REPOS, "dcohen", WINDOW_START)
    assert "repo:dome-systems/prod-dome" in query
    assert "repo:dome-systems/sdk-dome-python" in query
    assert "author:dcohen" in query
    assert "is:merged" in query
    assert "merged:>=2026-08-09T12:00:00Z" in query


def test_open_query_asks_for_work_still_open_and_touched_in_the_window():
    query = main.open_pull_request_query(REPOS, "dcohen", WINDOW_START)
    assert "is:open" in query
    assert "updated:>=2026-08-09T12:00:00Z" in query
    assert "is:merged" not in query


# --------------------------------------------------------------------------
# Reading the tool replies
# --------------------------------------------------------------------------


def test_repository_slug_is_recovered_from_the_api_url():
    url = "https://api.github.com/repos/dome-systems/prod-dome"
    assert main.repo_slug_from_api_url(url) == "dome-systems/prod-dome"


def test_unrecognized_repository_url_is_rejected():
    with pytest.raises(RuntimeError, match="unrecognized repository URL"):
        main.repo_slug_from_api_url("https://example.invalid/nothing")


def pull_request_item(number: int, *, merged_at: str = "", draft: bool = False) -> dict:
    return {
        "number": number,
        "title": f"Change {number}",
        "state": "closed" if merged_at else "open",
        "draft": draft,
        "html_url": f"https://github.com/dome-systems/prod-dome/pull/{number}",
        "user": {"login": "dcohen"},
        "created_at": "2026-08-09T08:00:00Z",
        "updated_at": "2026-08-10T09:12:00Z",
        "closed_at": merged_at or None,
        "repository_url": "https://api.github.com/repos/dome-systems/prod-dome",
        "pull_request": {"merged_at": merged_at or None},
    }


def test_merged_pull_requests_are_read_with_their_merge_time():
    payload = {
        "total_count": 1,
        "incomplete_results": False,
        "items": [pull_request_item(412, merged_at="2026-08-10T09:12:00Z")],
    }
    pulls, total = main.parse_pull_requests(payload)
    assert total == 1
    assert pulls[0].repo == "dome-systems/prod-dome"
    assert pulls[0].number == 412
    assert pulls[0].title == "Change 412"
    assert pulls[0].merged_at == "2026-08-10T09:12:00Z"
    assert pulls[0].draft is False


def test_unmerged_pull_request_has_no_merge_time():
    payload = {"total_count": 1, "items": [pull_request_item(413, draft=True)]}
    pulls, _ = main.parse_pull_requests(payload)
    assert pulls[0].merged_at == ""
    assert pulls[0].draft is True


def test_total_count_is_reported_separately_from_the_page():
    payload = {"total_count": 250, "items": [pull_request_item(1)]}
    pulls, total = main.parse_pull_requests(payload)
    assert len(pulls) == 1
    assert total == 250


def test_pull_request_reply_without_items_is_rejected():
    with pytest.raises(RuntimeError, match="pull request search reply has no 'items'"):
        main.parse_pull_requests({"total_count": 0})


def test_pull_request_reply_that_is_not_an_object_is_rejected():
    with pytest.raises(RuntimeError, match="no 'items' list"):
        main.parse_pull_requests([])


def issue_item(number: int, created_at: str, *, author: str = "alice") -> dict:
    return {
        "number": number,
        "title": f"Issue {number}",
        "state": "OPEN",
        "html_url": f"https://github.com/dome-systems/prod-dome/issues/{number}",
        "user": {"login": author},
        "created_at": created_at,
        "updated_at": "2026-08-10T11:00:00Z",
    }


def test_issue_listing_is_read_into_records():
    payload = {
        "issues": [issue_item(455, "2026-08-10T08:00:00Z")],
        "totalCount": 1,
        "pageInfo": {"hasNextPage": False, "endCursor": "Y3Vyc29y"},
    }
    issues, total = main.parse_issues(payload, REPOS[0])
    assert total == 1
    assert issues[0].repo == "dome-systems/prod-dome"
    assert issues[0].number == 455
    assert issues[0].author == "alice"


def test_issue_listing_without_an_issues_key_is_rejected():
    with pytest.raises(
        RuntimeError, match="issue listing for dome-systems/prod-dome reply has no"
    ):
        main.parse_issues({"totalCount": 0}, REPOS[0])


def test_issues_updated_but_not_created_in_the_window_are_dropped():
    # The listing filters on last-updated, so an old issue someone commented on
    # today comes back too. Only the one opened inside the window belongs.
    issues = [
        main.Issue(
            "r", 1, "old but commented on", "u", "alice", "2026-06-01T09:00:00Z"
        ),
        main.Issue("r", 2, "opened today", "u", "bob", "2026-08-10T08:00:00Z"),
    ]
    kept = main.issues_opened_since(issues, WINDOW_START)
    assert [issue.number for issue in kept] == [2]


def test_issue_created_exactly_at_the_window_start_is_kept():
    issues = [main.Issue("r", 3, "on the boundary", "u", "bob", "2026-08-09T12:00:00Z")]
    assert len(main.issues_opened_since(issues, WINDOW_START)) == 1


def test_issues_are_ordered_newest_first():
    issues = [
        main.Issue("r", 1, "earlier", "u", "alice", "2026-08-09T13:00:00Z"),
        main.Issue("r", 2, "later", "u", "bob", "2026-08-10T08:00:00Z"),
    ]
    assert [i.number for i in main.issues_opened_since(issues, WINDOW_START)] == [2, 1]


# --------------------------------------------------------------------------
# Prompt building
# --------------------------------------------------------------------------


def sample_activity(**overrides) -> main.Activity:
    defaults = {
        "username": "dcohen",
        "lookback_hours": 24,
        "repos": REPOS,
        "merged": [
            main.PullRequest(
                "dome-systems/prod-dome",
                412,
                "Add workspace blueprint document",
                "https://github.com/dome-systems/prod-dome/pull/412",
                False,
                "2026-08-10T09:12:00Z",
                "2026-08-10T09:12:00Z",
            )
        ],
        "in_progress": [
            main.PullRequest(
                "dome-systems/sdk-dome-python",
                88,
                "Retry gateway exchange",
                "https://github.com/dome-systems/sdk-dome-python/pull/88",
                True,
                "2026-08-10T10:00:00Z",
                "",
            )
        ],
        "issues": [
            main.Issue(
                "dome-systems/prod-dome",
                455,
                "Gateway 500s on an empty catalog",
                "https://github.com/dome-systems/prod-dome/issues/455",
                "alice",
                "2026-08-10T08:00:00Z",
            )
        ],
    }
    return main.Activity(**{**defaults, **overrides})


def test_prompt_names_the_three_sections_the_report_must_have():
    prompt = main.build_prompt(sample_activity())
    assert "\nDone\n" in prompt
    assert "\nIn progress\n" in prompt
    assert "\nIssues found\n" in prompt


def test_prompt_carries_every_item_with_its_repository_and_number():
    prompt = main.build_prompt(sample_activity())
    assert "dome-systems/prod-dome#412 Add workspace blueprint document" in prompt
    assert "dome-systems/sdk-dome-python#88 Retry gateway exchange" in prompt
    assert "dome-systems/prod-dome#455 Gateway 500s on an empty catalog" in prompt


def test_prompt_marks_a_draft_pull_request():
    assert "[draft]" in main.build_prompt(sample_activity())


def test_prompt_names_the_issue_author():
    assert "opened by alice" in main.build_prompt(sample_activity())


def test_prompt_shows_an_empty_section_as_none():
    prompt = main.build_prompt(sample_activity(merged=[], in_progress=[], issues=[]))
    assert prompt.count("- none") == 3


def test_prompt_states_the_window_and_the_repositories_searched():
    prompt = main.build_prompt(sample_activity())
    assert "last 24 hours" in prompt
    assert "dome-systems/prod-dome, dome-systems/sdk-dome-python" in prompt


def test_prompt_forbids_inventing_work():
    assert "never invent" in main.SYSTEM_PROMPT.lower()


def test_activity_with_nothing_in_any_bucket_is_empty():
    assert sample_activity(merged=[], in_progress=[], issues=[]).is_empty
    assert not sample_activity().is_empty


# --------------------------------------------------------------------------
# Explaining an empty completion
# --------------------------------------------------------------------------


def test_empty_completion_at_the_output_ceiling_names_the_reasoning_trap():
    reason = main.Gateway.empty_completion_reason(
        {"finish_reason": "length"},
        {"model": "some-reasoner", "usage": {"completion_tokens": 1500}},
    )
    assert "reasoning" in reason
    assert "SUMMARY_MODEL" in reason
    assert "some-reasoner" in reason


def test_empty_completion_for_another_reason_reports_that_reason():
    reason = main.Gateway.empty_completion_reason(
        {"finish_reason": "content_filter"}, {"usage": {"completion_tokens": 0}}
    )
    assert "content_filter" in reason
    assert "reasoning" not in reason


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


@pytest.fixture
def env(monkeypatch):
    """A minimal environment in which load_config succeeds."""
    for name in list(main.os.environ):
        if name.startswith(("DOME_", "GITHUB_", "SLACK_", "AXIOM_")) or name in (
            "OUTPUT_MODE",
            "LOOKBACK_HOURS",
            "SUMMARY_MODEL",
            "ACT_AS_EMAIL",
        ):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DOME_AGENT_API_KEY", "agent-key")
    monkeypatch.setenv("DOME_GATEWAY_URL", "https://gateway.example/gateways/abc/")
    monkeypatch.setenv("DOME_API_URL", "https://app.example/")
    monkeypatch.setenv("GITHUB_USERNAME", "dcohen")
    monkeypatch.setenv("GITHUB_REPOS", "dome-systems/prod-dome")
    monkeypatch.setenv("SUMMARY_MODEL", "summarizer")
    monkeypatch.setenv("GITHUB_PR_SEARCH_TOOL", "GitHub/search_pull_requests")
    monkeypatch.setenv("GITHUB_ISSUE_LIST_TOOL", "GitHub/list_issues")
    monkeypatch.setenv("OUTPUT_MODE", "stdout")
    return monkeypatch


def test_missing_required_env_vars_are_named_together(env):
    env.delenv("DOME_GATEWAY_URL")
    env.delenv("GITHUB_USERNAME")
    with pytest.raises(SystemExit) as excinfo:
        main.load_config()
    assert "DOME_GATEWAY_URL" in str(excinfo.value)
    assert "GITHUB_USERNAME" in str(excinfo.value)


def test_trailing_slashes_are_trimmed_from_the_dome_urls(env):
    cfg = main.load_config()
    assert cfg.dome_gateway == "https://gateway.example/gateways/abc"
    assert cfg.dome_control_plane == "https://app.example"


def test_username_is_accepted_with_a_leading_at_sign(env):
    env.setenv("GITHUB_USERNAME", "@dcohen")
    assert main.load_config().github_username == "dcohen"


def test_invalid_output_mode_is_rejected(env):
    env.setenv("OUTPUT_MODE", "email")
    with pytest.raises(SystemExit, match="OUTPUT_MODE"):
        main.load_config()


def test_slack_output_without_any_credential_is_rejected(env):
    env.setenv("OUTPUT_MODE", "slack")
    with pytest.raises(SystemExit, match="SLACK_WEBHOOK_URL"):
        main.load_config()


def test_slack_bot_token_without_a_channel_is_rejected(env):
    env.setenv("OUTPUT_MODE", "slack")
    env.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    with pytest.raises(SystemExit, match="SLACK_CHANNEL"):
        main.load_config()


def test_slack_webhook_alone_is_enough(env):
    env.setenv("OUTPUT_MODE", "slack")
    env.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.example/x")
    assert main.load_config().output_mode == "slack"


def test_lookback_defaults_to_twenty_four_hours(env):
    assert main.load_config().lookback_hours == 24


def test_lookback_flag_overrides_the_environment(env):
    env.setenv("LOOKBACK_HOURS", "24")
    assert main.load_config(lookback_override=72).lookback_hours == 72


def test_non_numeric_lookback_is_rejected(env):
    env.setenv("LOOKBACK_HOURS", "a while")
    with pytest.raises(SystemExit, match="positive integer"):
        main.load_config()


def test_zero_lookback_is_rejected(env):
    env.setenv("LOOKBACK_HOURS", "0")
    with pytest.raises(SystemExit, match="positive integer"):
        main.load_config()


def test_negative_lookback_flag_is_rejected(env):
    with pytest.raises(SystemExit, match="positive integer"):
        main.load_config(lookback_override=-1)


@pytest.mark.parametrize(
    "name",
    [
        "GITHUB_REPOS",
        "SUMMARY_MODEL",
        "GITHUB_PR_SEARCH_TOOL",
        "GITHUB_ISSUE_LIST_TOOL",
    ],
)
def test_a_missing_resource_name_is_reported_rather_than_guessed(env, name):
    """No fallback: a name this program cannot invent has to be supplied.

    Guessing one produces a confidently wrong report — the wrong repositories, or
    a tool the gateway does not publish — where refusing to start names the gap.
    """
    env.delenv(name)
    with pytest.raises(SystemExit) as excinfo:
        main.load_config()
    assert name in str(excinfo.value)


def test_tool_names_can_be_overridden_when_they_drift(env):
    env.setenv("GITHUB_PR_SEARCH_TOOL", "gh/search_prs")
    env.setenv("GITHUB_ISSUE_LIST_TOOL", "gh/list_issues")
    cfg = main.load_config()
    assert cfg.pr_search_tool == "gh/search_prs"
    assert cfg.issue_list_tool == "gh/list_issues"


def test_lookback_flag_is_read_from_the_command_line():
    assert main.parse_args(["--lookback-hours", "48"]).lookback_hours == 48
    assert main.parse_args([]).lookback_hours is None


# --------------------------------------------------------------------------
# Driving the collector against a faked gateway
# --------------------------------------------------------------------------


class FakeTools:
    """The SDK's tools client, answering from a scripted queue of replies."""

    def __init__(self, catalog: list[str], replies: list[dict]) -> None:
        self.catalog = catalog
        self.replies = list(replies)
        self.calls: list[tuple[str, dict]] = []

    def list(self, *, act_as=None):
        return dome.ToolsListResult(
            tools=tuple(dome.Tool(name=n) for n in self.catalog)
        )

    def call(self, name, arguments, *, act_as=None):
        self.calls.append((name, dict(arguments)))
        payload = self.replies.pop(0)
        return dome.ToolCallResult(
            content=({"type": "text", "text": json.dumps(payload)},)
        )


class FakeLLM:
    def __init__(self, response: dict) -> None:
        self.response = response
        self.messages: list[dict] = []

    def chat(self, *, model, messages, act_as=None):
        self.messages = list(messages)
        return self.response


class FakeGatewayNamespace:
    def __init__(self, tools: FakeTools, llm: FakeLLM) -> None:
        self.tools = tools
        self.llm = llm


class FakeClient:
    def __init__(self, gateway: FakeGatewayNamespace) -> None:
        self.gateway = gateway


DEFAULT_CATALOG = [
    "github/search_pull_requests",
    "github/list_issues",
    "github/merge_pull_request",
    "github/issue_write",
]


def build_gateway(
    replies: list[dict], *, catalog=None, llm_response=None
) -> main.Gateway:
    cfg = main.Config(
        dome_api_key="k",
        dome_gateway="https://gateway.example/gateways/abc",
        dome_control_plane="https://app.example",
        dome_model="github-summarizer",
        github_username="dcohen",
        repos=REPOS,
        pr_search_tool="github/search_pull_requests",
        issue_list_tool="github/list_issues",
        act_as_email="",
        lookback_hours=24,
        output_mode="stdout",
        slack_webhook_url="",
        slack_bot_token="",
        slack_channel="",
    )
    tools = FakeTools(DEFAULT_CATALOG if catalog is None else catalog, replies)
    llm = FakeLLM(llm_response or {"choices": [{"message": {"content": "ok"}}]})
    return main.Gateway(cfg, FakeClient(FakeGatewayNamespace(tools, llm)))


def collector_replies() -> list[dict]:
    """Replies for the four calls a two-repository run makes, in order."""
    return [
        {
            "total_count": 1,
            "items": [pull_request_item(412, merged_at="2026-08-10T09:12:00Z")],
        },
        {"total_count": 1, "items": [pull_request_item(413, draft=True)]},
        {
            "issues": [
                issue_item(455, "2026-08-10T08:00:00Z"),
                issue_item(300, "2026-05-01T08:00:00Z"),
            ],
            "totalCount": 2,
        },
        {"issues": [], "totalCount": 0},
    ]


def test_activity_is_bucketed_into_merged_open_and_new_issues():
    gateway = build_gateway(collector_replies())
    activity = main.collect_activity(gateway, WINDOW_START)
    assert [pull.number for pull in activity.merged] == [412]
    assert [pull.number for pull in activity.in_progress] == [413]
    assert [issue.number for issue in activity.issues] == [455]


def test_collector_asks_each_repository_for_its_issues():
    gateway = build_gateway(collector_replies())
    main.collect_activity(gateway, WINDOW_START)
    issue_calls = [
        args
        for name, args in gateway.client.gateway.tools.calls
        if "list_issues" in name
    ]
    assert [(a["owner"], a["repo"]) for a in issue_calls] == [
        ("dome-systems", "prod-dome"),
        ("dome-systems", "sdk-dome-python"),
    ]
    assert issue_calls[0]["since"] == "2026-08-09T12:00:00Z"
    assert issue_calls[0]["orderBy"] == "CREATED_AT"


def test_collector_sends_the_merged_and_open_searches_in_that_order():
    gateway = build_gateway(collector_replies())
    main.collect_activity(gateway, WINDOW_START)
    searches = [
        args["query"]
        for name, args in gateway.client.gateway.tools.calls
        if "search_pull_requests" in name
    ]
    assert "is:merged" in searches[0]
    assert "is:open" in searches[1]


def test_truncated_search_warns_without_failing(capsys):
    replies = collector_replies()
    replies[0]["total_count"] = 250
    gateway = build_gateway(replies)
    activity = main.collect_activity(gateway, WINDOW_START)
    assert len(activity.merged) == 1
    assert "returned 1 of 250 matches" in capsys.readouterr().err


def test_unpublished_tool_names_the_variable_that_overrides_it():
    gateway = build_gateway([], catalog=["github/list_issues"])
    with pytest.raises(SystemExit) as excinfo:
        gateway.check_tools()
    assert "GITHUB_PR_SEARCH_TOOL" in str(excinfo.value)
    assert "github/search_pull_requests" in str(excinfo.value)


def test_published_tools_pass_the_preflight():
    build_gateway([]).check_tools()


def test_summary_is_returned_from_the_gateway_completion():
    gateway = build_gateway(
        [], llm_response={"choices": [{"message": {"content": "  Done\n- a  "}}]}
    )
    assert gateway.summarize("prompt") == "Done\n- a"


def test_gateway_error_in_the_completion_is_surfaced():
    gateway = build_gateway([], llm_response={"error": {"message": "model gone"}})
    with pytest.raises(RuntimeError, match="model gone"):
        gateway.summarize("prompt")


def test_completion_with_no_choices_is_surfaced():
    gateway = build_gateway([], llm_response={"choices": []})
    with pytest.raises(RuntimeError, match="no completion"):
        gateway.summarize("prompt")


def test_blank_completion_is_surfaced_with_its_finish_reason():
    gateway = build_gateway(
        [],
        llm_response={
            "choices": [{"message": {"content": "   "}, "finish_reason": "length"}],
            "model": "some-reasoner",
            "usage": {"completion_tokens": 1500},
        },
    )
    with pytest.raises(RuntimeError, match="SUMMARY_MODEL"):
        gateway.summarize("prompt")
