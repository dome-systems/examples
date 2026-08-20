package main

// GitHub activity report — same agent as ../python/main.py, in Go.
//
// Governance lives in the Blueprint, not here. This process exchanges a Dome
// agent key, then talks to the Gateway over HTTP: MCP JSON-RPC at /mcp and
// OpenAI-shaped chat at /v1/chat/completions. There is no Go SDK yet; the
// wire is the SDK.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	lookbackHoursDefault = 24
	perPage              = 100
	httpTimeout          = 60 * time.Second
	gatewayTimeout       = 120 * time.Second
	slackPostMessageURL  = "https://slack.com/api/chat.postMessage"
)

var prFields = []string{
	"number", "title", "state", "draft", "html_url", "user",
	"created_at", "updated_at", "closed_at", "pull_request", "repository_url",
}

var issueFields = []string{
	"number", "title", "state", "html_url", "user", "created_at", "updated_at",
}

const systemPrompt = "You write a short recurring note about one engineer's GitHub work for their " +
	"team's Slack channel. Your readers know the codebase but have not seen this " +
	"week's pull requests. Use only the pull requests and issues you are given: " +
	"never invent one, never describe work that is not listed, and never estimate " +
	"a number that is absent."

type repo struct {
	owner string
	name  string
}

func (r repo) slug() string { return r.owner + "/" + r.name }

type config struct {
	domeAPIKey       string
	domeGateway      string
	domeControlPlane string
	domeModel        string
	githubUsername   string
	repos            []repo
	prSearchTool     string
	issueListTool    string
	actAsEmail       string
	lookbackHours    int
	outputMode       string
	slackWebhookURL  string
	slackBotToken    string
	slackChannel     string
}

type pullRequest struct {
	repo      string
	number    int
	title     string
	url       string
	draft     bool
	updatedAt string
	mergedAt  string
}

type issue struct {
	repo      string
	number    int
	title     string
	url       string
	author    string
	createdAt string
}

type activity struct {
	username      string
	lookbackHours int
	repos         []repo
	merged        []pullRequest
	inProgress    []pullRequest
	issues        []issue
}

func (a activity) empty() bool {
	return len(a.merged) == 0 && len(a.inProgress) == 0 && len(a.issues) == 0
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	lookback, err := parseLookbackFlag(args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(lookback)
	if err != nil {
		return err
	}
	since := time.Now().UTC().Add(-time.Duration(cfg.lookbackHours) * time.Hour)
	gw, err := newGateway(cfg)
	if err != nil {
		return err
	}
	if err := gw.checkTools(); err != nil {
		return err
	}
	act, err := collectActivity(gw, since)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "read %d merged and %d open pull requests by %s and %d new issues from %d repositories over the last %dh\n",
		len(act.merged), len(act.inProgress), cfg.githubUsername, len(act.issues), len(cfg.repos), cfg.lookbackHours)

	header := fmt.Sprintf("GitHub activity for @%s — last %d hours", cfg.githubUsername, cfg.lookbackHours)
	body := "No merged or open pull requests, and no new issues, in this window."
	if !act.empty() {
		body, err = gw.summarize(buildPrompt(act))
		if err != nil {
			return err
		}
	}
	return deliver(cfg, header+"\n\n"+body)
}

func parseLookbackFlag(args []string) (*int, error) {
	for i := 0; i < len(args); i++ {
		if args[i] == "--lookback-hours" {
			if i+1 >= len(args) {
				return nil, errors.New("--lookback-hours needs a positive integer")
			}
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 1 {
				return nil, fmt.Errorf("--lookback-hours must be a positive integer, got %s", args[i+1])
			}
			return &n, nil
		}
	}
	return nil, nil
}

func loadConfig(lookbackOverride *int) (config, error) {
	required := map[string]string{
		"DOME_AGENT_API_KEY":     os.Getenv("DOME_AGENT_API_KEY"),
		"DOME_GATEWAY_URL":       os.Getenv("DOME_GATEWAY_URL"),
		"DOME_API_URL":           os.Getenv("DOME_API_URL"),
		"GITHUB_USERNAME":        os.Getenv("GITHUB_USERNAME"),
		"GITHUB_REPOS":           os.Getenv("GITHUB_REPOS"),
		"SUMMARY_MODEL":          os.Getenv("SUMMARY_MODEL"),
		"GITHUB_PR_SEARCH_TOOL":  os.Getenv("GITHUB_PR_SEARCH_TOOL"),
		"GITHUB_ISSUE_LIST_TOOL": os.Getenv("GITHUB_ISSUE_LIST_TOOL"),
	}
	var missing []string
	for name, value := range required {
		if value == "" {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		return config{}, fmt.Errorf("missing required env vars: %s", strings.Join(missing, ", "))
	}
	outputMode := strings.ToLower(getenv("OUTPUT_MODE", "slack"))
	if outputMode != "slack" && outputMode != "stdout" {
		return config{}, fmt.Errorf(`OUTPUT_MODE must be "slack" or "stdout", got %q`, outputMode)
	}
	lookbackHours := lookbackHoursDefault
	if lookbackOverride != nil {
		lookbackHours = *lookbackOverride
	} else {
		raw := getenv("LOOKBACK_HOURS", strconv.Itoa(lookbackHoursDefault))
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return config{}, fmt.Errorf("LOOKBACK_HOURS must be a positive integer, got %q", raw)
		}
		lookbackHours = n
	}
	repos, err := parseRepos(required["GITHUB_REPOS"])
	if err != nil {
		return config{}, err
	}
	cfg := config{
		domeAPIKey:       required["DOME_AGENT_API_KEY"],
		domeGateway:      strings.TrimRight(required["DOME_GATEWAY_URL"], "/"),
		domeControlPlane: strings.TrimRight(required["DOME_API_URL"], "/"),
		domeModel:        required["SUMMARY_MODEL"],
		githubUsername:   strings.TrimPrefix(required["GITHUB_USERNAME"], "@"),
		repos:            repos,
		prSearchTool:     required["GITHUB_PR_SEARCH_TOOL"],
		issueListTool:    required["GITHUB_ISSUE_LIST_TOOL"],
		actAsEmail:       os.Getenv("ACT_AS_EMAIL"),
		lookbackHours:    lookbackHours,
		outputMode:       outputMode,
		slackWebhookURL:  os.Getenv("SLACK_WEBHOOK_URL"),
		slackBotToken:    os.Getenv("SLACK_BOT_TOKEN"),
		slackChannel:     os.Getenv("SLACK_CHANNEL"),
	}
	if cfg.outputMode == "slack" && cfg.slackWebhookURL == "" && (cfg.slackBotToken == "" || cfg.slackChannel == "") {
		return config{}, errors.New("OUTPUT_MODE=slack needs SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and SLACK_CHANNEL (or set OUTPUT_MODE=stdout)")
	}
	return cfg, nil
}

func parseRepos(raw string) ([]repo, error) {
	var repos []repo
	for _, entry := range strings.Split(raw, ",") {
		slug := strings.TrimSpace(entry)
		if slug == "" {
			continue
		}
		parts := strings.Split(slug, "/")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			return nil, fmt.Errorf("GITHUB_REPOS entry %q is not owner/repo; expected a list like %q", slug, "dome-systems/prod-dome,dome-systems/sdk-dome-python")
		}
		repos = append(repos, repo{owner: parts[0], name: parts[1]})
	}
	if len(repos) == 0 {
		return nil, errors.New("GITHUB_REPOS is empty; it needs at least one owner/repo")
	}
	return repos, nil
}

func githubTimestamp(moment time.Time) string {
	return moment.UTC().Format("2006-01-02T15:04:05Z")
}

func parseTimestamp(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, errors.New("empty timestamp")
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, nil
	}
	return time.Parse("2006-01-02T15:04:05Z", value)
}

func repoScope(repos []repo) string {
	parts := make([]string, len(repos))
	for i, r := range repos {
		parts[i] = "repo:" + r.slug()
	}
	return strings.Join(parts, " ")
}

func mergedPullRequestQuery(repos []repo, username string, since time.Time) string {
	return fmt.Sprintf("%s author:%s is:merged merged:>=%s", repoScope(repos), username, githubTimestamp(since))
}

func openPullRequestQuery(repos []repo, username string, since time.Time) string {
	return fmt.Sprintf("%s author:%s is:open updated:>=%s", repoScope(repos), username, githubTimestamp(since))
}

func repoSlugFromAPIURL(url string) (string, error) {
	marker := "/repos/"
	index := strings.LastIndex(url, marker)
	if index < 0 {
		return "", fmt.Errorf("unrecognized repository URL in search result: %q", url)
	}
	parts := strings.Split(strings.Trim(url[index+len(marker):], "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("unrecognized repository URL in search result: %q", url)
	}
	return parts[0] + "/" + parts[1], nil
}

func parsePullRequests(payload any) ([]pullRequest, int, error) {
	obj, ok := payload.(map[string]any)
	if !ok {
		return nil, 0, fmt.Errorf("pull request search reply has no %q list: %v", "items", payload)
	}
	items, ok := obj["items"].([]any)
	if !ok {
		return nil, 0, fmt.Errorf("pull request search reply has no %q list: %v", "items", payload)
	}
	var pulls []pullRequest
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		mergedAt := ""
		if pr, ok := item["pull_request"].(map[string]any); ok {
			mergedAt, _ = pr["merged_at"].(string)
		}
		slug, err := repoSlugFromAPIURL(asString(item["repository_url"]))
		if err != nil {
			return nil, 0, err
		}
		pulls = append(pulls, pullRequest{
			repo:      slug,
			number:    asInt(item["number"]),
			title:     strings.TrimSpace(asString(item["title"])),
			url:       asString(item["html_url"]),
			draft:     asBool(item["draft"]),
			updatedAt: asString(item["updated_at"]),
			mergedAt:  mergedAt,
		})
	}
	total := asInt(obj["total_count"])
	if total == 0 {
		total = len(pulls)
	}
	return pulls, total, nil
}

func parseIssues(payload any, r repo) ([]issue, int, error) {
	obj, ok := payload.(map[string]any)
	if !ok {
		return nil, 0, fmt.Errorf("issue listing for %s reply has no %q list: %v", r.slug(), "issues", payload)
	}
	items, ok := obj["issues"].([]any)
	if !ok {
		return nil, 0, fmt.Errorf("issue listing for %s reply has no %q list: %v", r.slug(), "issues", payload)
	}
	var issues []issue
	for _, raw := range items {
		item, _ := raw.(map[string]any)
		author := ""
		if user, ok := item["user"].(map[string]any); ok {
			author = strings.TrimSpace(asString(user["login"]))
		}
		issues = append(issues, issue{
			repo:      r.slug(),
			number:    asInt(item["number"]),
			title:     strings.TrimSpace(asString(item["title"])),
			url:       asString(item["html_url"]),
			author:    author,
			createdAt: asString(item["created_at"]),
		})
	}
	total := asInt(obj["totalCount"])
	if total == 0 {
		total = len(issues)
	}
	return issues, total, nil
}

func issuesOpenedSince(issues []issue, since time.Time) []issue {
	var recent []issue
	for _, iss := range issues {
		t, err := parseTimestamp(iss.createdAt)
		if err != nil {
			continue
		}
		if !t.Before(since) {
			recent = append(recent, iss)
		}
	}
	sort.Slice(recent, func(i, j int) bool { return recent[i].createdAt > recent[j].createdAt })
	return recent
}

type gateway struct {
	cfg   config
	http  *http.Client
	token string
}

func newGateway(cfg config) (*gateway, error) {
	apiKey, err := extractAPIKey(cfg.domeAPIKey)
	if err != nil {
		return nil, err
	}
	token, err := exchangeToken(cfg.domeControlPlane, apiKey)
	if err != nil {
		return nil, err
	}
	return &gateway{
		cfg:   cfg,
		http:  &http.Client{Timeout: gatewayTimeout},
		token: token,
	}, nil
}

func extractAPIKey(credential string) (string, error) {
	if strings.HasPrefix(credential, "dome_") {
		return credential, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(credential)
	if err != nil {
		return "", errors.New("invalid agent token: must be a dome_ key or base64 agent token envelope")
	}
	var envelope map[string]any
	if err := json.Unmarshal(decoded, &envelope); err != nil {
		return "", errors.New("invalid agent token: must be a dome_ key or base64 agent token envelope")
	}
	if method, ok := envelope["auth_method"]; ok && method != nil && method != "api_key" {
		return "", fmt.Errorf("unsupported auth_method in token envelope: %v", method)
	}
	key, _ := envelope["api_key"].(string)
	if key == "" {
		return "", errors.New("invalid agent token: must be a dome_ key or base64 agent token envelope")
	}
	return key, nil
}

func exchangeToken(controlPlane, apiKey string) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"grantType": "api_key",
		"apiKey":    apiKey,
	})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(controlPlane, "/")+"/dome.identity.v1.Identity/ExchangeToken", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("token exchange failed: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 500))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", errors.New("token exchange returned empty access token")
	}
	return out.AccessToken, nil
}

func (g *gateway) headers() http.Header {
	h := make(http.Header)
	h.Set("Authorization", "Bearer "+g.token)
	h.Set("Content-Type", "application/json")
	if g.cfg.actAsEmail != "" {
		payload, _ := json.Marshal(map[string]string{"email": g.cfg.actAsEmail})
		h.Set("X-Dome-Act-As", base64.StdEncoding.EncodeToString(payload))
	}
	return h
}

func (g *gateway) mcp(method string, params any) (any, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      fmt.Sprintf("%d", time.Now().UnixNano()),
		"method":  method,
	}
	if params != nil {
		payload["params"] = params
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, g.cfg.domeGateway+"/mcp", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = g.headers()
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dome gateway call failed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("dome gateway call failed: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 500))
	}
	var rpc map[string]any
	if err := json.Unmarshal(raw, &rpc); err != nil {
		return nil, err
	}
	if errObj, ok := rpc["error"]; ok {
		return nil, fmt.Errorf("dome gateway call failed: %v", errObj)
	}
	if result, ok := rpc["result"]; ok {
		return result, nil
	}
	return map[string]any{}, nil
}

func toolResultJSON(result any) (any, error) {
	obj, _ := result.(map[string]any)
	if obj == nil {
		return nil, errors.New("tool result does not contain JSON content")
	}
	if isError, _ := obj["isError"].(bool); isError {
		return nil, fmt.Errorf("dome gateway call failed: tool returned isError=true raw=%v", obj)
	}
	if sc := obj["structuredContent"]; sc != nil {
		return sc, nil
	}
	if sc := obj["structured_content"]; sc != nil {
		return sc, nil
	}
	content, _ := obj["content"].([]any)
	var texts []string
	for _, item := range content {
		block, _ := item.(map[string]any)
		if asString(block["type"]) == "text" {
			texts = append(texts, asString(block["text"]))
		}
	}
	text := strings.TrimSpace(strings.Join(texts, "\n"))
	if text == "" {
		return nil, errors.New("tool result does not contain JSON content")
	}
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil, errors.New("tool result text is not valid JSON")
	}
	return parsed, nil
}

func (g *gateway) checkTools() error {
	result, err := g.mcp("tools/list", map[string]any{})
	if err != nil {
		return err
	}
	obj, _ := result.(map[string]any)
	published := map[string]struct{}{}
	if tools, ok := obj["tools"].([]any); ok {
		for _, t := range tools {
			tool, _ := t.(map[string]any)
			if name := asString(tool["name"]); name != "" {
				published[name] = struct{}{}
			}
		}
	}
	wanted := map[string]string{
		"GITHUB_ISSUE_LIST_TOOL": g.cfg.issueListTool,
		"GITHUB_PR_SEARCH_TOOL":  g.cfg.prSearchTool,
	}
	names := make([]string, 0, len(published))
	for n := range published {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, variable := range []string{"GITHUB_ISSUE_LIST_TOOL", "GITHUB_PR_SEARCH_TOOL"} {
		name := wanted[variable]
		if _, ok := published[name]; !ok {
			available := strings.Join(names, ", ")
			if available == "" {
				available = "(none)"
			}
			return fmt.Errorf("gateway does not publish tool %q; available tools: %s. Set %s to the right one.", name, available, variable)
		}
	}
	return nil
}

func (g *gateway) searchPullRequests(query string) ([]pullRequest, int, error) {
	result, err := g.mcp("tools/call", map[string]any{
		"name": g.cfg.prSearchTool,
		"arguments": map[string]any{
			"query":   query,
			"perPage": perPage,
			"fields":  prFields,
		},
	})
	if err != nil {
		return nil, 0, err
	}
	payload, err := toolResultJSON(result)
	if err != nil {
		return nil, 0, err
	}
	return parsePullRequests(payload)
}

func (g *gateway) listIssues(r repo, since time.Time) ([]issue, int, error) {
	result, err := g.mcp("tools/call", map[string]any{
		"name": g.cfg.issueListTool,
		"arguments": map[string]any{
			"owner":     r.owner,
			"repo":      r.name,
			"since":     githubTimestamp(since),
			"orderBy":   "CREATED_AT",
			"direction": "DESC",
			"perPage":   perPage,
			"fields":    issueFields,
		},
	})
	if err != nil {
		return nil, 0, err
	}
	payload, err := toolResultJSON(result)
	if err != nil {
		return nil, 0, err
	}
	return parseIssues(payload, r)
}

func emptyCompletionReason(choice, response map[string]any) string {
	finish := asString(choice["finish_reason"])
	if finish == "" {
		finish = "unknown"
	}
	usage, _ := response["usage"].(map[string]any)
	detail := fmt.Sprintf("finish_reason=%s, completion_tokens=%v", finish, usage["completion_tokens"])
	if finish == "length" {
		model := asString(response["model"])
		if model == "" {
			model = "?"
		}
		return fmt.Sprintf("model %s reached its output ceiling without producing any text (%s). That is what a reasoning model does when hidden reasoning consumes the whole budget — and raising the ceiling only works until the gateway's upstream timeout stops the request, so point SUMMARY_MODEL at a model that answers directly instead.", model, detail)
	}
	return "gateway LLM call returned an empty completion (" + detail + ")"
}

func (g *gateway) summarize(prompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": g.cfg.domeModel,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": prompt},
		},
	})
	req, err := http.NewRequest(http.MethodPost, g.cfg.domeGateway+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header = g.headers()
	resp, err := g.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("gateway LLM call failed: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 500))
	}
	var response map[string]any
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", err
	}
	if errObj, ok := response["error"]; ok && errObj != nil {
		return "", fmt.Errorf("gateway LLM call returned an error: %v", errObj)
	}
	choices, _ := response["choices"].([]any)
	if len(choices) == 0 {
		return "", fmt.Errorf("gateway LLM call returned no completion: %v", response)
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	content := strings.TrimSpace(asString(message["content"]))
	if content == "" {
		return "", errors.New(emptyCompletionReason(choice, response))
	}
	return content, nil
}

func warnIfTruncated(kind string, returned, total int) {
	if total > returned {
		fmt.Fprintf(os.Stderr, "warning: %s returned %d of %d matches, so the report covers only the first %d; shorten LOOKBACK_HOURS or narrow GITHUB_REPOS\n", kind, returned, total, returned)
	}
}

func collectActivity(gw *gateway, since time.Time) (activity, error) {
	cfg := gw.cfg
	merged, mergedTotal, err := gw.searchPullRequests(mergedPullRequestQuery(cfg.repos, cfg.githubUsername, since))
	if err != nil {
		return activity{}, err
	}
	warnIfTruncated("merged pull request search", len(merged), mergedTotal)
	sort.Slice(merged, func(i, j int) bool { return merged[i].mergedAt > merged[j].mergedAt })

	inProgress, openTotal, err := gw.searchPullRequests(openPullRequestQuery(cfg.repos, cfg.githubUsername, since))
	if err != nil {
		return activity{}, err
	}
	warnIfTruncated("open pull request search", len(inProgress), openTotal)
	sort.Slice(inProgress, func(i, j int) bool { return inProgress[i].updatedAt > inProgress[j].updatedAt })

	var issues []issue
	for _, r := range cfg.repos {
		listed, listedTotal, err := gw.listIssues(r, since)
		if err != nil {
			return activity{}, err
		}
		warnIfTruncated("issue listing for "+r.slug(), len(listed), listedTotal)
		issues = append(issues, issuesOpenedSince(listed, since)...)
	}
	sort.Slice(issues, func(i, j int) bool { return issues[i].createdAt > issues[j].createdAt })
	return activity{
		username:      cfg.githubUsername,
		lookbackHours: cfg.lookbackHours,
		repos:         cfg.repos,
		merged:        merged,
		inProgress:    inProgress,
		issues:        issues,
	}, nil
}

func buildPrompt(act activity) string {
	slugs := make([]string, len(act.repos))
	for i, r := range act.repos {
		slugs[i] = r.slug()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "GitHub activity for @%s over the last %d hours, across %s.\n\n", act.username, act.lookbackHours, strings.Join(slugs, ", "))
	fmt.Fprintf(&b, "Pull requests merged (%d):\n", len(act.merged))
	for _, pull := range act.merged {
		fmt.Fprintf(&b, "- %s#%d %s (merged %s)\n", pull.repo, pull.number, pull.title, pull.mergedAt)
	}
	if len(act.merged) == 0 {
		b.WriteString("- none\n")
	}
	fmt.Fprintf(&b, "\nPull requests still open and updated in the window (%d):\n", len(act.inProgress))
	for _, pull := range act.inProgress {
		draft := ""
		if pull.draft {
			draft = " [draft]"
		}
		fmt.Fprintf(&b, "- %s#%d %s%s (last updated %s)\n", pull.repo, pull.number, pull.title, draft, pull.updatedAt)
	}
	if len(act.inProgress) == 0 {
		b.WriteString("- none\n")
	}
	fmt.Fprintf(&b, "\nIssues opened in the window (%d):\n", len(act.issues))
	for _, iss := range act.issues {
		author := iss.author
		if author == "" {
			author = "unknown"
		}
		fmt.Fprintf(&b, "- %s#%d %s (opened by %s, %s)\n", iss.repo, iss.number, iss.title, author, iss.createdAt)
	}
	if len(act.issues) == 0 {
		b.WriteString("- none\n")
	}
	b.WriteString(`
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
every sentence. Do not repeat these instructions.`)
	return b.String()
}

func deliver(cfg config, message string) error {
	if cfg.outputMode == "stdout" {
		fmt.Println(message)
		return nil
	}
	client := &http.Client{Timeout: httpTimeout}
	if cfg.slackWebhookURL != "" {
		body, _ := json.Marshal(map[string]string{"text": message})
		resp, err := client.Post(cfg.slackWebhookURL, "application/json", bytes.NewReader(body))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			raw, _ := io.ReadAll(resp.Body)
			return fmt.Errorf("slack webhook failed: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 500))
		}
		fmt.Fprintln(os.Stderr, "posted report to Slack via webhook")
		return nil
	}
	body, _ := json.Marshal(map[string]string{"channel": cfg.slackChannel, "text": message})
	req, err := http.NewRequest(http.MethodPost, slackPostMessageURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.slackBotToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("slack chat.postMessage failed: HTTP %d: %s", resp.StatusCode, truncate(string(raw), 500))
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return err
	}
	if ok, _ := out["ok"].(bool); !ok {
		return fmt.Errorf("slack chat.postMessage failed: %v", out["error"])
	}
	fmt.Fprintf(os.Stderr, "posted report to Slack channel %s\n", cfg.slackChannel)
	return nil
}

func getenv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
