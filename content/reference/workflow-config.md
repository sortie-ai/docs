---
title: Workflow Configuration
linkTitle: "Workflow File"
description: "Reference for every WORKFLOW.md field: tracker, polling, workspace root and retention, hooks, agent, notifications, database, prompt template, server, logging, and SSH worker."
author: Sortie AI
date: 2026-04-26
weight: 20
url: /reference/workflow-config/
---
`WORKFLOW.md` is a Markdown file with YAML front matter. Front matter between `---` delimiters defines runtime settings. The body after the closing `---` is the default prompt template, rendered per issue with Go `text/template`. When the front matter defines [dispatch rules](/guides/configure-dispatch-rules/), a matching rule can select a different per-rule template file in place of the body.

See also: [CLI reference](/reference/cli/) for startup flags, [environment variables reference](/reference/environment/) for `$VAR` behavior, [error reference](/reference/errors/) for configuration error diagnostics, [Jira adapter reference](/reference/adapter-jira/) for Jira-specific fields, [GitHub adapter reference](/reference/adapter-github/) for GitHub-specific fields, [Linear adapter reference](/reference/adapter-linear/) for Linear-specific fields, [Gitea adapter reference](/reference/adapter-gitea/) for Gitea-specific fields, [GitLab adapter reference](/reference/adapter-gitlab/) for GitLab-specific fields, [Claude Code adapter reference](/reference/adapter-claude-code/) for Claude Code pass-through options, [Copilot CLI adapter reference](/reference/adapter-copilot/) for Copilot CLI pass-through options, [Codex adapter reference](/reference/adapter-codex/) for Codex pass-through options, [OpenCode CLI adapter reference](/reference/adapter-opencode/) for OpenCode pass-through options, [Kiro CLI adapter reference](/reference/adapter-kiro/) for Kiro CLI pass-through options, [Configure dispatch rules](/guides/configure-dispatch-rules/) for routing issues to different agents and prompt templates, [Configure CI feedback](/guides/configure-ci-feedback/) for operational guidance.

> [!TIP]
> Most configuration fields in this reference can be overridden by `SORTIE_*` environment variables without modifying the workflow file. See the [environment variables reference](/reference/environment/#configuration-overrides) for the full list and precedence rules.

## Complete annotated example

```yaml
---
# --- Tracker ----------------------------------------------------------
tracker:
  kind: jira                          # Adapter: "jira", "github", "linear", "gitea", "gitlab", or "file"
  endpoint: $SORTIE_JIRA_ENDPOINT     # Jira base URL ($VAR expanded)
  api_key: $SORTIE_JIRA_API_KEY       # API token ($VAR expanded anywhere)
  project: PLATFORM                   # Jira project key
  api_version: "3"                    # Jira REST API version: "3" Cloud, "2" Server/DC
  query_filter: "labels = 'agent-ready'"  # JQL fragment appended to queries
  active_states:                      # Issues in these states get dispatched
    - To Do
    - In Progress
  terminal_states:                    # Issues in these states trigger cleanup
    - Done
    - Won't Do
  handoff_state: Human Review         # State set after successful agent run
  handoff_evidence: observed          # observed (default) | strict | off
  in_progress_state: In Progress       # State set when agent picks up the issue
  comments:
    on_dispatch: true                  # Post comment when agent starts
    on_completion: true                # Post comment when agent finishes
    on_failure: true                   # Post comment when agent fails

# --- Polling ----------------------------------------------------------
polling:
  interval_ms: 60000                  # Poll every 60 seconds

# --- Workspace --------------------------------------------------------
workspace:
  root: ~/workspace/sortie            # Base dir for per-issue workspaces

# --- Hooks ------------------------------------------------------------
hooks:
  after_create: |                     # Runs once, in the freshly created (empty) workspace
    git clone --depth 1 git@github.com:myorg/myrepo.git .
    go mod download
  before_run: |                       # Runs before each agent attempt
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
  after_run: |                        # Runs after each agent attempt
    make fmt 2>/dev/null || true
    git add -A
    git diff --cached --quiet || \
      git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
  before_remove: |                    # Runs before workspace deletion
    git push origin --delete "sortie/${SORTIE_ISSUE_IDENTIFIER}" 2>/dev/null || true
  timeout_ms: 120000                  # 2-minute timeout for all hooks

# --- Agent ------------------------------------------------------------
agent:
  kind: claude-code                   # Agent adapter
  command: claude                     # CLI binary to launch
  max_turns: 5                        # Orchestrator turn-loop limit
  max_sessions: 3                     # Max completed sessions per issue
  max_tokens: 1500000                 # Cumulative per-issue token ceiling (0 = unlimited)
  max_concurrent_agents: 4            # Global concurrency cap
  turn_timeout_ms: 1800000            # 30 min per turn
  read_timeout_ms: 10000              # 10 s startup timeout
  stall_timeout_ms: 300000            # 5 min inactivity detection
  max_retry_backoff_ms: 120000        # 2 min max retry delay
  max_concurrent_agents_by_state:
    in progress: 3                    # Per-state concurrency cap
    to do: 1

# --- Dispatch (rule-based routing; optional) ----------------------
dispatch:
  rules:                                # First match wins, in order
    - name: bug-fix                     # ^[a-z][a-z0-9_-]*$; logs/metric
      match:
        labels: ["bug", "bug/*"]        # glob vs lowercased labels
      agent: claude-code                # overrides agent.kind
      template: ./prompts/bug.md        # path relative to WORKFLOW.md
    - name: urgent
      match:
        priority: { lte: 2 }            # op: eq/in/lt/lte/gt/gte
      template: ./prompts/urgent.md
  default:                              # Applied when no rule matches
    template: ./prompts/default.md      # agent omitted -> agent.kind

# --- CI Feedback --------------------------------------------------
ci_feedback:
  kind: github                        # CI provider; absent = disabled
  max_retries: 2                      # CI-fix attempts before escalation
  max_log_lines: 50                   # Log lines from failing check; 0 = off
  escalation: label                   # "label" or "comment"
  escalation_label: needs-human       # Label for escalation

# --- Reactions (post-PR feedback loops) ---------------------------
reactions:
  review_comments:
    provider: github                      # SCM adapter for review polling
    max_retries: 2                        # review-fix turns before escalation
    escalation: label                     # "label" or "comment"
    escalation_label: needs-human         # label on escalation
    poll_interval_ms: 120000              # 2 min poll interval
    debounce_ms: 60000                    # 60s debounce window
    max_continuation_turns: 3             # hard cap per PR
  label_commands:
    provider: github                      # SCM adapter for PR label commands
    review_label: "sortie:review"         # label that triggers a read-only review
    fix_label: "sortie:fix"               # label that triggers pushed fixes
    poll_interval_ms: 60000               # 60s poll interval; floor 30000

# --- Self-Review --------------------------------------------------
self_review:
  enabled: true                           # default false; opt-in
  max_iterations: 3                        # review iteration cap
  verification_commands:                   # required when enabled
    - "go test ./..."
    - "go vet ./..."
  verification_timeout_ms: 120000          # per-command timeout
  max_diff_bytes: 102400                   # diff truncation limit
  reviewer: "same"                         # only "same" in v1

# --- Notifications (notify_operator backends; optional) ------------
notifications:
  - kind: slack                       # Notifier backend
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL  # SORTIE_-prefixed reference (required)
    max_per_session: 20               # Per-session cap; 0 selects the default (20)
  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL      # Generic JSON POST endpoint

# --- Claude Code adapter (pass-through) ------------------------------
claude-code:
  permission_mode: bypassPermissions  # Auto-approve tool calls
  model: claude-sonnet-4-20250514
  max_turns: 50                       # CLI --max-turns (not agent.max_turns)
  max_budget_usd: 5                   # Per-invocation cost cap (x agent.max_turns per session)

# --- Server -----------------------------------------------------------
server:
  port: 9090                          # HTTP observability server (default: 7678, 0 to disable)
  host: "0.0.0.0"                     # Bind address (default: 127.0.0.1)

# --- Logging ----------------------------------------------------------
logging:
  level: info                         # debug | info | warn | error
  format: json                        # text | json (default: text)

# --- Token Rates (cost estimation) -----------------------------------
token_rates:
  claude-code:                        # Agent adapter kind string
    input_per_mtok: 3.00              # USD per million input tokens
    output_per_mtok: 15.00            # USD per million output tokens
    cache_read_per_mtok: 0.30         # USD per million cache-read tokens

# --- Database ---------------------------------------------------------
db_path: .sortie.db                   # SQLite file (relative to WORKFLOW.md)
---

You are a senior engineer working on {{ .issue.identifier }}.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ if .issue.description }}
{{ .issue.description }}
{{ end }}

{{ if .run.is_continuation }}
Resuming turn {{ .run.turn_number }}/{{ .run.max_turns }}. Review workspace state and continue.
{{ end }}

{{ if .attempt }}
Retry attempt {{ .attempt }}. Check previous failure before proceeding.
{{ end }}
```

---

## `tracker`

Issue tracker connection and query settings.

| Field             | Type            | Default               | Description                                                             |
| ----------------- | --------------- | --------------------- | ----------------------------------------------------------------------- |
| `kind`            | string          | _(required)_          | Adapter identifier. `"jira"`, `"github"`, `"linear"`, `"gitea"`, `"gitlab"`, or `"file"`.      |
| `endpoint`        | string          | adapter-defined       | Tracker API base URL. Required for Gitea (self-hosted, no default host); the adapter appends `/api/v1` and tolerates a value already ending in `/api/v1`. Optional for GitLab, which defaults to `https://gitlab.com`; supply the instance base URL only to reach a self-managed instance. The GitLab adapter trims a trailing slash, appends `/api/v4`, and tolerates a value already ending in `/api/v4`.                                                   |
| `api_key`         | string          | _(required for Jira)_ | API authentication token.                                               |
| `project`         | string          | _(required for Jira)_ | Project identifier, adapter-defined: Jira project key (e.g., `PLATFORM`), GitHub or Gitea `owner/repo` (e.g., `sortie-ai/sortie`), or Linear team key (e.g., `ENG`, the prefix in `ENG-123`; not a Linear project). For GitLab: the project's namespace path (e.g., `group/project`) or its numeric project ID. GitLab nests subgroups to any depth, so `group/subgroup/project` is equally valid and no single-slash rule applies; write the path unencoded, since the adapter percent-encodes it. |
| `active_states`   | list of strings | `[]`                  | Issue states eligible for dispatch.                                     |
| `terminal_states` | list of strings | `[]`                  | Issue states that trigger workspace cleanup. This is the primary removal ground and is always on; the opt-in age bound in [`workspace.retention_days`](#workspace) is the second. |
| `query_filter`    | string          | `""`                  | Query fragment that narrows candidate and terminal-state queries. For Jira: a JQL expression appended to the query. For Linear: an `IssueFilter` JSON object merged into the query (see the Linear example below). For Gitea: a URL query fragment merged into the repository issue-list query (see the Gitea example below). For GitLab: a URL query fragment merged into the project issue-list query, key-checked against a closed allowlist (see the GitLab example below). |
| `handoff_state`   | string          | _(absent)_            | Target state after a successful agent run. Absent disables handoff.     |
| `handoff_evidence` | string         | `"observed"`           | Evidence policy consulted before the handoff write. `observed` withholds the write only on a positively observed absence of workspace change; `strict` also withholds it when evidence cannot be determined; `off` performs no evidence check and leaves the write governed by the other handoff conditions alone. See [state machine reference](/reference/state-machine/#handoff-evidence). |
| `in_progress_state` | string        | _(absent)_            | Target state for dispatch-time transition at the start of each worker attempt. Absent disables dispatch-time transitions. |
| `api_version`     | string          | `"3"`                 | Jira REST API version: `"3"` for Jira Cloud, `"2"` for Jira Server / Data Center. Quote the value; a bare integer draws a `sortie validate` advisory. Adapters other than Jira ignore this field. `sortie validate` rejects a value other than `"2"` or `"3"`, and rejects `"2"` against an `.atlassian.net` endpoint. See the [Jira adapter reference](/reference/adapter-jira/#api_version) for deployment-mode behavior and [offline validation](/reference/adapter-jira/#offline-validation) for the full check list. |
| `comments.on_dispatch`   | bool   | `false`               | Post a tracker comment when a worker is dispatched.                     |
| `comments.on_completion` | bool   | `false`               | Post a tracker comment when a worker completes normally.                |
| `comments.on_failure`    | bool   | `false`               | Post a tracker comment when a worker exits with an error.               |

### Environment variable expansion

`api_key` applies full environment expansion: `$VAR` and `${VAR}` references are resolved at any position in the string.

`endpoint`, `project`, `query_filter`, `handoff_state`, `in_progress_state`, and `api_version` use targeted resolution: the value is expanded only when the entire trimmed string starts with `$`. Literal URIs and project keys that contain `$` characters elsewhere are returned unchanged.

See the [environment variables reference](/reference/environment/#var-indirection-in-workflowmd) for expansion mechanics.

### Constraints

At least one of `active_states` or `terminal_states` must be non-empty. When both are empty, Sortie refuses to start. An empty `active_states` with non-empty `terminal_states` is valid but means no issues are dispatched.

`handoff_state`, when set, must not appear in `active_states` (causes immediate re-dispatch loop) or `terminal_states` (handoff is not a terminal outcome). Jira handoff requires write permissions on the API token: `write:jira-work` (classic) or `write:issue:jira` (granular).

`in_progress_state`, when set, must appear in `active_states` (otherwise reconciliation would immediately cancel the worker after the transition). It must not appear in `terminal_states` or collide with `handoff_state`. If the issue is already in the target state at dispatch time, the transition call is skipped (debug log only). Other transition failures at runtime are non-fatal: the worker logs a warning and continues to workspace preparation. Requires the same write permissions as `handoff_state`.

`handoff_evidence`, when set, must be one of `observed`, `strict`, or `off`. The check is a closed-set comparison that needs no network access, so an invalid value is rejected offline at startup, on dynamic reload, and by `sortie validate`.

> [!NOTE]
> Workspace cleanup for issues that reach a terminal state while no worker is running is handled by a periodic sweep, not by an instant event. The sweep runs every 60 poll cycles - with the default 30-second `polling.interval_ms`, cleanup occurs within approximately 30 minutes; with a 60-second interval, within approximately 60 minutes. When a worker is still running and reconciliation detects a terminal state, cleanup happens on the current poll tick. On the same pass, and only after that terminal check, the sweep applies a second removal ground based on workspace age; it is opt-in and off by default (see [`workspace.retention_days`](#workspace)). At startup Sortie runs the terminal check alone: it queries the tracker for the states of the workspace directories it finds and removes those reported terminal, and it cleans nothing on that pass if the listing or the tracker read fails.

### Tracker comments

The `comments` sub-object controls whether Sortie posts plain-text comments on tracker issues at session lifecycle points. Each flag is independent. All default to `false`.

| Flag | Fires when | Comment content |
|---|---|---|
| `on_dispatch` | Worker starts (after in-progress transition, before workspace preparation) | Session started acknowledgment with agent kind and attempt number. Session ID and workspace are "pending" at this point. |
| `on_completion` | Worker exits normally | Session ID, duration, turns completed. Includes "(re-queuing)" suffix when a continuation retry is scheduled. |
| `on_failure` | Worker exits with an error | Session ID, duration, truncated error message (200 char limit), retry status and next attempt number. |

Comment failures are non-fatal. A failed comment logs WARN and never blocks dispatch, completion, retry, or handoff. Completion and failure comments are posted from a detached goroutine - the event loop is never blocked by the tracker API.

No comment is posted on worker cancellation (stall timeout, reconciliation, shutdown).

The `comments` value must be a map when present. Non-boolean values for the flags produce a configuration error at startup. The flags do not support `$VAR` expansion.

**Example: Jira**

```yaml
tracker:
  kind: jira
  endpoint: https://mycompany.atlassian.net
  api_key: $JIRA_TOKEN
  project: BILLING
  query_filter: "component = 'api' AND labels = 'agent-ready'"
  active_states: [To Do, In Progress]
  terminal_states: [Done, Won't Do]
  handoff_state: Human Review
  in_progress_state: In Progress
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true
```

**Example: file-based tracker**

```yaml
tracker:
  kind: file
  active_states: [To Do, In Progress]
  terminal_states: [Done]

file:
  path: /path/to/issues.json
```

**Example: GitHub Issues tracker**

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  query_filter: "label:agent-ready"
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]
  handoff_state: review
  in_progress_state: in-progress
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true
```

GitHub state names are issue label names. Create the `active_states` labels before Sortie starts, since an issue can only carry a label that already exists; labels Sortie applies itself, such as `handoff_state`, are created on demand in default gray. State values are compared case-insensitively and stored lowercased. See the [GitHub adapter reference](/reference/adapter-github/) for state derivation rules.

**Example: Linear**

```yaml
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
  query_filter: '{ "labels": { "name": { "eq": "agent-ready" } } }'
  active_states: [Backlog, Todo, In Progress]
  terminal_states: [Done, Canceled, Duplicate]
  handoff_state: In Review
```

`project` is the Linear team key (the prefix in identifiers such as `ENG-123`), not a Linear project. `api_key` is a Linear personal API key, sent verbatim in the `Authorization` header with no `Bearer` prefix. Linear state names match workflow states by display name, compared case-insensitively and verified against the team at startup. When `active_states` or `terminal_states` is omitted, the adapter applies the stock defaults: active `["Backlog", "Todo", "In Progress"]`, terminal `["Done", "Canceled", "Duplicate"]`. Unlike Jira's appended JQL, the Linear `query_filter` is an `IssueFilter` JSON object merged into the query: it must be a JSON object, and it must not contain a top-level `team` or `state` key, which the adapter reserves for its own team and state constraints. See the [Linear adapter reference](/reference/adapter-linear/) for field mapping, the state model, and the full `IssueFilter` surface.

**Example: Gitea**

```yaml
tracker:
  kind: gitea
  endpoint: https://gitea.example.com
  api_key: $SORTIE_GITEA_TOKEN
  project: sortie-ai/sortie
  query_filter: "assigned_by=hermes-bot"
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]
  handoff_state: review
```

`endpoint` is required for Gitea: the instance is self-hosted, so there is no default host. The adapter trims a trailing slash and appends `/api/v1`, and tolerates a value already ending in `/api/v1`. `api_key` is a Gitea access token, sent verbatim as `Authorization: token <key>` (the canonical Gitea scheme, not a `Bearer` prefix), so surrounding whitespace fails authentication. `project` is the repository in `owner/repo` form.

Gitea state names are repository label names, compared case-insensitively and stored lowercased. A configured label absent from the repository is created on demand the first time an issue transitions into it, so labels need not exist beforehand. When `active_states` or `terminal_states` is omitted, the adapter carries internal fallback labels (active `["backlog", "in-progress", "review"]`, terminal `["done", "wontfix"]`) that derive an issue's state from its labels; they do not drive dispatch, which the orchestrator gates on the workflow's `active_states` and `terminal_states`. `handoff_state` and `in_progress_state` name repository labels too, and a transition swaps the current state label for the target, closing the issue on a terminal target and reopening it on an active one. Unlike Jira's appended JQL, the Gitea `query_filter` is a URL query fragment merged into the repository issue-list query: the adapter reserves the `state`, `type`, `page`, and `limit` keys (a fragment naming any of them fails at construction), warns on an unrecognized key, and warns when a `labels` value does not resolve to a repository label, because Gitea's server-side `labels` filter is AND-across-names, case-sensitive, and drops entirely on an unresolvable name. See the [Gitea adapter reference](/reference/adapter-gitea/) for the state model, field mapping, and the full `query_filter` surface.

**Example: GitLab**

```yaml
tracker:
  kind: gitlab
  # endpoint omitted: defaults to https://gitlab.com. Set it for self-managed GitLab.
  api_key: $SORTIE_GITLAB_TOKEN
  project: group/subgroup/project
  query_filter: "assignee_username=hermes-bot&not[labels]=blocked"
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]
  handoff_state: review
```

`endpoint` is optional for GitLab, which ships both as SaaS and as a self-managed install: it defaults to `https://gitlab.com`, so a GitLab.com workflow omits it and a self-managed workflow sets the instance base URL. The adapter trims a trailing slash and appends `/api/v4`, and tolerates a value already ending in `/api/v4`, though `sortie validate` warns about the redundant suffix. `api_key` is a GitLab access token (personal, project, or group) with the `api` scope, sent verbatim in the `PRIVATE-TOKEN` header (GitLab's own scheme, neither `Authorization: Bearer` nor `Authorization: token`), so surrounding whitespace fails authentication. `project` is the project's full namespace path or its numeric project ID, quoted so YAML keeps a numeric ID a string. GitLab nests subgroups to any depth, so `group/subgroup/project` is as valid as `group/project` and the adapter enforces no one-slash rule, unlike the GitHub and Gitea `owner/repo` grammar. Write the path unencoded: the adapter percent-encodes it once for the API path.

GitLab state names are project labels, compared case-insensitively and stored lowercased; a group label the project inherits counts as a project label. A configured label absent from the project is created by GitLab itself on the write that names it, so labels need not exist beforehand. Because GitLab label names are case-sensitive, that same behavior would turn a configured `review` into a second label next to an existing `Review`; to prevent the duplicate, the adapter reads the project label catalog at startup and rewrites every configured state label to the casing the project already stores. When `active_states` or `terminal_states` is omitted, the adapter carries internal fallback labels (active `["backlog", "in-progress", "review"]`, terminal `["done", "wontfix"]`) that derive an issue's state from its labels; they do not drive dispatch, which the orchestrator gates on the workflow's `active_states` and `terminal_states`. `handoff_state` names a project label too, and `in_progress_state` is an orchestrator-level field the GitLab adapter itself does not read; both reach GitLab through the same transition, a single request that swaps the current state label for the target and reconciles the native state, closing the issue on a terminal target and reopening it on an active one. A handoff-only target does neither.

Unlike Jira's appended JQL and Linear's `IssueFilter` JSON object, the GitLab `query_filter` is a URL query fragment merged into the project issue-list query, validated against a closed allowlist at construction. The adapter rejects the eight keys it owns (`state`, `issue_type`, `order_by`, `sort`, `page`, `per_page`, `pagination`, `with_labels_details`) and rejects any key outside the eighteen the issue-list route honors. That is stricter than the Gitea adapter, which warns and forwards an unrecognized key: GitLab silently ignores a parameter it does not recognize and returns an unfiltered result set with HTTP 200, so a typo such as `assignee=` for `assignee_username=` would widen the candidate set with no visible signal. Negation uses GitLab's `not[...]` hash, accepted for the subset GitLab honors there. The adapter warns, without blocking construction, when a `labels` value names a label the project does not hold, because GitLab's server-side `labels` filter is AND-across-names and case-sensitive and returns an empty result on an unmatched name. `sortie validate` reports the same verdict offline. See the [GitLab adapter reference](/reference/adapter-gitlab/) for the state model, field mapping, and the full `query_filter` allowlist.

---

## `polling`

Poll loop timing.

| Field         | Type    | Default | Description                       |
| ------------- | ------- | ------- | --------------------------------- |
| `interval_ms` | integer | `30000` | Milliseconds between poll cycles. |

Accepts plain integers or quoted string integers (e.g., `"30000"`). Reloads dynamically; changes take effect on the next tick without restart.

```yaml
polling:
  interval_ms: 60000
```

---

## `workspace`

Base directory for per-issue workspaces, and the optional age bound on how long they survive.

| Field            | Type    | Default                           | Description                                                          |
| ---------------- | ------- | --------------------------------- | -------------------------------------------------------------------- |
| `root`           | path    | `<system-temp>/sortie_workspaces` | Base directory. Per-issue subdirectories are created under this path. |
| `retention_days` | integer | `0`                               | Maximum age in days of a workspace's latest recorded activity before the periodic sweep removes it. `0` disables the bound. |

`~` expands to the home directory via `os.UserHomeDir()`. All `$VAR` and `${VAR}` references are expanded via `os.ExpandEnv` at any position. Issue identifiers are sanitized to `[A-Za-z0-9._-]` for subdirectory names; other characters become `_`.

### Age-based retention

`retention_days` bounds how long a workspace survives when its issue never reaches a terminal state. It is opt-in and off by default: a deployment that does not set the field behaves exactly as it did before, in every observable respect, with no run-history read and no age comparison on any pass. Terminal-state cleanup stays the primary mechanism and is always on. The age bound is a backstop for what the terminal gate cannot reach: an issue parked in the handoff state with no automation to advance it, an issue moved to a state the configuration does not name, an issue abandoned in an active state after a permanent failure, and an issue deleted from the tracker, which reports no state at all.

Accepted values are `0`, which disables the bound, and any integer of `30` or greater, which enables it. A value between `1` and `29` is rejected outright, neither clamped nor rounded up:

```
config: workspace.retention_days: must be 0 to disable or at least 30 days
```

A negative value is rejected as well:

```
config: workspace.retention_days: must not be negative
```

Both are configuration-shape checks that need no network access, so `sortie validate` reports them offline, at `error` severity, before a run starts.

The window is counted in days while every other duration in this file is counted in milliseconds. The departure is deliberate. The millisecond fields are poll intervals, timeouts, debounces, and backoff caps, all sub-hour timings where the unit is proportionate to the value. A retention window runs on the order of weeks, and thirty days written in milliseconds is `2592000000`, a figure no operator can read back or check. Drop three digits from it and an intended thirty days becomes forty-three minutes. Days keep a misconfiguration visible on the line where it is written.

The floor of `30` is fixed by a second window rather than chosen for taste. Pending reaction recovery rebuilds runtime reaction entries after a restart by reading `.sortie/scm.json` out of the workspace directory, and it considers a candidate only when that workspace's latest activity falls inside a thirty-day lookback. The retention window may not be set below the window reaction recovery honors, which makes one invariant true by construction: any workspace the bound may remove is one recovery would already have skipped as stale.

Age is measured from the later of two recorded timestamps: the most recent run completion recorded for that workspace's identifier, and the `pushed_at` value in the workspace's `.sortie/scm.json`. A workspace is removable when that anchor is older than the window. Directory modification time is not used, and was rejected deliberately: lifecycle hooks, agent processes, and background tooling inside the checkout all move it, so it reports filesystem activity rather than work. A workspace with neither timestamp is retained, never removed. Absence of a record is not evidence of age, and that case covers a run that never completed, a directory produced by an operator or a hook, and a directory Sortie did not create.

Two exclusions are absolute. A workspace whose issue holds an entry in the running map or the retry map is never removed, whatever its age and however large the directory. A workspace pinned by an unexpired pending reaction is excluded until that entry expires, which takes at most 30 minutes; see the [reactions reference](/reference/reactions/#retry-budgets) for which reaction kinds pin a workspace and which do not. Everything else on disk is a candidate.

The bound removes directories and does nothing else. It performs no tracker write, no source-control write, and no change to reaction state, so a workspace removed by age leaves every reaction latch exactly as it found it. Removal runs through the same path as terminal cleanup, so workspace key sanitization, containment under `root`, and the [`before_remove` hook](/guides/setup-workspace-hooks/) all apply unchanged.

`retention_days` reloads dynamically. A change applies on the next sweep pass, with no restart.

The bound never removes a workspace whose latest activity is inside the window, so a deployment that processes many issues quickly still holds every workspace produced during the last window. Size the disk for that, not for the steady state.

> [!WARNING]
> Changing `workspace.root` and restarting leaves old workspace directories on disk. Sortie scans only the currently configured root during startup cleanup. Remove old directory contents manually before switching roots.

> [!WARNING]
> Removal by `retention_days` is irreversible. A workspace holds a source checkout, any uncommitted work in it, and the `.sortie/scm.json` metadata that is the only durable record of a pull request's coordinates. Nothing restores it. Set the field to a window longer than any workspace you expect to keep aside for inspection.

```yaml
workspace:
  root: ~/workspace/sortie
  retention_days: 30        # max age in days of latest recorded activity; 0 disables the bound
```

---

## `hooks`

Shell scripts that run at workspace lifecycle points. On POSIX systems, each hook executes via `sh -c` (not `bash`). On Windows, hooks execute via `cmd.exe /C`. The working directory is always the per-issue workspace directory.

| Field           | Type         | Default  | Description                                            |
| --------------- | ------------ | -------- | ------------------------------------------------------ |
| `after_create`  | shell script | _(none)_ | Runs once when a workspace directory is first created.  |
| `before_run`    | shell script | _(none)_ | Runs before each agent attempt.                        |
| `after_run`     | shell script | _(none)_ | Runs after each agent attempt.                         |
| `before_remove` | shell script | _(none)_ | Runs before workspace deletion.                        |
| `timeout_ms`    | integer      | `60000`  | Timeout in milliseconds for all hooks. Non-positive values fall back to the default. |

### Failure behavior

| Hook            | On failure                                 |
| --------------- | ------------------------------------------ |
| `after_create`  | Aborts workspace creation.                 |
| `before_run`    | Aborts the current run attempt. May retry. |
| `after_run`     | Logged and ignored.                        |
| `before_remove` | Logged and ignored. Cleanup proceeds.      |

Timeouts count as failures and follow the same semantics.

### Hook environment variables

| Variable                  | Value                                         |
| ------------------------- | --------------------------------------------- |
| `SORTIE_ISSUE_ID`         | Tracker-internal issue ID.                    |
| `SORTIE_ISSUE_IDENTIFIER` | Human-readable ticket key (e.g., `PROJ-123`). |
| `SORTIE_WORKSPACE`        | Absolute path to the workspace directory.     |
| `SORTIE_ATTEMPT`          | Current attempt number (integer).             |
| `SORTIE_SSH_HOST`         | Target SSH host for the current session. Present only when [SSH worker mode](#worker) is active. |
| `SORTIE_SELF_REVIEW_STATUS` | Self-review outcome: `"disabled"`, `"passed"`, `"cap_reached"`, `"error"`. Set on `after_run`. |
| `SORTIE_SELF_REVIEW_SUMMARY_PATH` | Absolute path to `.sortie/review_summary.md`. Absent when self-review did not run. |

### Restricted environment

Hook subprocesses do not inherit the full parent process environment. They receive:

- A POSIX allowlist: `PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`.
- All parent environment variables prefixed with `SORTIE_`.
- The orchestrator-injected variables listed above.

All other parent variables are stripped. Secrets such as `JIRA_API_TOKEN` or `AWS_ACCESS_KEY_ID` are not available unless exposed under a `SORTIE_` prefix in the parent environment.

> [!NOTE]
> Hooks run under POSIX `sh` and do not source login profiles. Tools that depend on login-shell initialization (`nvm`, `rbenv`, `pyenv`) require a nested invocation: `bash -lc 'nvm use 20 && npm ci'`.

```yaml
hooks:
  after_create: |
    git clone --depth 1 git@github.com:myorg/myrepo.git .
    npm ci
  before_run: |
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
  after_run: ./hooks/post-run.sh
  timeout_ms: 120000
```

> [!NOTE]
> `after_create` runs only when the per-issue workspace directory is first created, so the clone above starts in an empty directory. When `after_create` fails, Sortie removes the directory, and the retry again starts empty; a clone error such as "destination path already exists" does not come from this example. An SSH clone must reach its key through `SSH_AUTH_SOCK` or `~/.ssh` via `HOME`, because a variable outside the [restricted environment](#restricted-environment), such as `GIT_SSH_COMMAND`, is stripped.

---

## `agent`

Coding agent adapter, concurrency, timeouts, and retry behavior. These fields control the orchestrator's scheduling decisions, not the agent process itself. Adapter-specific settings use [separate pass-through blocks](#adapter-pass-through-configuration).

| Field                            | Type    | Default         | Description                                                                           |
| -------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------- |
| `kind`                           | string  | `claude-code`   | Agent adapter identifier. Built-in adapters: `claude-code`, `copilot-cli`, `codex`, `opencode`, `kiro`, `mock`.   |
| `command`                        | string  | adapter-defined | Shell command to launch the agent. Required for local-process adapters.               |
| `max_turns`                      | integer | `20`            | Maximum turns per worker session. The worker re-checks tracker state after each turn. |
| `max_sessions`                   | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying. Must be non-negative. |
| `max_tokens`                     | integer | `0` (unlimited) | Cumulative per-issue token ceiling. Sortie sums the `total_tokens` recorded for every session of the issue from run history and stops dispatching new sessions once the sum reaches a non-zero budget. The check runs before re-dispatch; it never stops a running session. Independent of `max_sessions`; the first ceiling reached wins. A run whose agent reported no token usage contributes nothing to the sum; that case and a failed token-sum query both allow the dispatch with a warning instead of blocking it. Must be non-negative. |
| `max_concurrent_agents`          | integer | `10`            | Global concurrency limit across all issues.                                           |
| `max_concurrent_agents_by_state` | map     | `{}`            | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored. |
| `turn_timeout_ms`                | integer | `3600000` (1h)  | Total timeout for a single agent turn. Must be positive; a non-positive value is rejected when the configuration loads. Unlike `stall_timeout_ms` below, this bound cannot be disabled. |
| `read_timeout_ms`                | integer | `5000` (5s)     | Timeout for startup and synchronous operations.                                       |
| `stall_timeout_ms`               | integer | `300000` (5m)   | Inactivity timeout based on event stream gaps. `0` or negative disables stall detection. |
| `max_retry_backoff_ms`           | integer | `300000` (5m)   | Maximum delay cap for exponential backoff on retries.                                 |

`max_concurrent_agents`, `max_concurrent_agents_by_state`, `max_retry_backoff_ms`, `max_sessions`, and `max_tokens` reload dynamically without restart; `max_tokens` takes effect at the next retry evaluation. All other fields apply to future dispatches only, except where the [dynamic reload table](#dynamic-reload) below states a finer-grained answer.

```yaml
agent:
  kind: claude-code
  command: claude
  max_turns: 5
  max_sessions: 3
  max_tokens: 1500000
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 3
    to do: 1
```

Agents can read the remaining token budget mid-session through the `cost_budget` tool; see the [agent extensions reference](/reference/agent-extensions/) for the tool contract and [how to control agent costs](/guides/control-costs/) for budget strategy.

---

## `dispatch`

Routing for the initial dispatch of each issue. Rules select an agent kind and prompt template from the issue's tracker metadata, evaluated first-match-wins in declaration order. When the `dispatch` block is absent, every issue dispatches with the top-level `agent.kind` and the WORKFLOW.md body template. The block is additive and changes no default.

The block accepts two keys:

| Field     | Type | Default     | Description                                                                 |
| --------- | ---- | ----------- | --------------------------------------------------------------------------- |
| `rules`   | list | _(absent)_  | Ordered dispatch rules, evaluated first-match-wins in YAML declaration order. |
| `default` | map  | _(absent)_  | Fallback selection applied when no rule matches. Keys: `agent`, `template`.  |

Each entry in `rules` accepts:

| Field      | Type   | Default      | Description                                                                                                  |
| ---------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `name`     | string | _(absent)_   | Rule identifier recorded in logs and the dispatch rule-match metric. Must match `^[a-z][a-z0-9_-]*$` when set. Unnamed rules report as `<none>`. |
| `match`    | map    | _(absent)_   | Predicate block. An absent or empty `match` matches every issue (catch-all).                                 |
| `agent`    | string | _(fallback)_ | Agent kind for matching issues. Must name a registered adapter. Falls through to `default.agent`, then `agent.kind`. |
| `template` | string | _(fallback)_ | Prompt template path, relative to the WORKFLOW.md directory. Falls through to `default.template`, then the body template. |

A rule whose `agent` differs from the top-level `agent.kind` requires the matching [adapter pass-through block](#adapter-pass-through-configuration) to be present in the front matter.

### Match predicates

The `match` block accepts five keys. A rule matches when every key present in the block matches (AND across keys); within a single key, a list matches when any element matches (OR within a key). Absent keys do not participate.

| Key          | Type           | Matching                                                                          |
| ------------ | -------------- | --------------------------------------------------------------------------------- |
| `labels`     | string or list | Glob (`*`, `?`, `[set]`) against the adapter-normalized lowercase label set.      |
| `issue_type` | string or list | Case-insensitive equality. Globs are not expanded.                                |
| `priority`   | predicate      | Numeric comparison. An issue with no priority value never matches.                |
| `identifier` | string or list | Glob against the issue key or number.                                             |
| `assignee`   | string or list | Case-insensitive equality. An issue with no assignee never matches a non-empty value. |

The `priority` predicate carries exactly one operator. Priority is an integer where lower values are more urgent.

| Operator | Match condition                                       |
| -------- | ----------------------------------------------------- |
| `eq`     | Equal to the value.                                   |
| `in`     | A member of the list, for example `{ in: [1, 2] }`.   |
| `lt`     | Less than the value.                                  |
| `lte`    | Less than or equal to the value.                      |
| `gt`     | Greater than the value.                               |
| `gte`    | Greater than or equal to the value.                   |

Tracker support differs. GitHub supplies `labels`, `issue_type`, `assignee`, and `identifier` (the issue number) and carries no priority. Jira supplies all five, with `identifier` as the issue key (for example `ACME-123`).

### Resolution and fallback

`agent` and `template` resolve independently. Each follows this chain until a value is found:

1. The matched rule's `agent` or `template`.
2. `dispatch.default.agent` or `dispatch.default.template`.
3. The top-level `agent.kind`, and the WORKFLOW.md body template.

Resolution runs once, at the issue's first dispatch. The resolved `(agent, template)` is frozen for the life of the claim; retries and reaction-driven continuations reuse it.

### Template paths

Per-rule `template` paths resolve relative to the directory containing WORKFLOW.md. Per-rule template files are plain `text/template` bodies and carry no YAML front matter. They use the same variables and functions as the body template; see [Prompt template](#prompt-template). The following are rejected at load time:

- Absolute paths and `~`-prefixed paths.
- Paths that resolve outside the WORKFLOW.md directory tree, including through symlinks or `..` traversal.
- Files that begin with `---`, since front matter is not permitted in per-rule templates.

### Validation

`sortie validate` parses the `dispatch` block, resolves and parses every referenced template, and reports the first error before dispatch:

- `dispatch.rules` is not a YAML sequence.
- A rule `name` does not match `^[a-z][a-z0-9_-]*$`.
- Two rules share a `name`.
- A catch-all rule (absent or empty `match`) precedes another rule, reported as `unreachable_rules`. A catch-all must be the last entry.
- A `rule.agent` or `default.agent` names an unregistered adapter kind.
- A `match` key is not one of `labels`, `issue_type`, `priority`, `identifier`, or `assignee`.
- A `labels` or `identifier` glob is malformed.
- A `priority` predicate carries no operator or more than one.
- A referenced template is missing, unreadable, contains front matter, or fails to parse.

Validation is single-pass: the first error short-circuits the run, so two unrelated dispatch errors surface across two runs.

> [!NOTE]
> Environment variable overrides for `dispatch` fields are not supported. Rule definitions and template paths must come from WORKFLOW.md.

### Dynamic reload

The rule set reloads with WORKFLOW.md changes and applies to future claims only. An in-flight issue keeps the agent and template frozen at its first dispatch until its claim is released. Per-rule template files are read at WORKFLOW.md load and on every reload; a standalone edit to a per-rule template file applies on the next WORKFLOW.md change or the next dispatch, whichever comes first.

**Minimal:**

```yaml
dispatch:
  rules:
    - name: bug-fix
      match:
        labels: ["bug"]
      template: ./prompts/bug.md
  default:
    template: ./prompts/default.md
```

For setup procedures, match-type recipes, and `--dry-run` verification, see [how to configure dispatch rules](/guides/configure-dispatch-rules/).

---

## `ci_feedback`

CI feedback configuration. When activated, Sortie detects CI failures on agent-created branches and dispatches continuation runs with failure context injected into the agent prompt. When retries are exhausted, Sortie escalates to a human via label or comment.

| Field              | Type    | Default                          | Description                                                                                                          |
| ------------------ | ------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `kind`             | string  | _(absent; CI feedback disabled)_ | CI status provider adapter identifier (e.g., `"github"`). Absent or empty disables CI feedback entirely.            |
| `max_retries`      | integer | `2`                              | Maximum CI-fix continuation dispatches per issue before escalation. Zero means escalate immediately on first CI failure. Must be non-negative. |
| `max_log_lines`    | integer | `50`                             | Lines to fetch from the first failing check run's log. Positive: fetch up to N lines. Zero: disable log fetching. Must be non-negative. |
| `escalation`       | string  | `"label"`                        | Action when `max_retries` is exceeded. Valid values: `"label"`, `"comment"`.                                         |
| `escalation_label` | string  | `"needs-human"`                  | Label applied to the issue when `escalation` is `"label"`. Created on demand if the tracker does not already have it. Ignored when `escalation` is `"comment"`. |

CI feedback follows the same activation pattern as other optional Sortie features. Presence of `kind` activates the feature; absence disables it. This is consistent with `worker.ssh_hosts` (absent = local mode). There is no `ci_feedback.enabled` boolean.

Repository coordinates (owner, repo name, API token, endpoint) are not part of the `ci_feedback` section. They live in the adapter pass-through block that matches the CI provider kind. When `ci_feedback.kind: github`, the CI adapter reads credentials from the `github:` top-level section in [Extensions](#extensions). When `tracker.kind` and `ci_feedback.kind` match (the common single-platform case), both adapters share the same credentials from the tracker config. See [adapter pass-through configuration](#adapter-pass-through-configuration) for the extension block pattern.

`watch_window_ms` is not a key of this block. A deployment configured through `ci_feedback` always gets its default; see the [`reactions.ci_failure` field table](/reference/reactions/#reactionsci_failure) for where it lives and what it does.

`sortie validate` checks `ci_feedback` sub-keys against the known schema. Unknown sub-keys produce an advisory warning. Adapter-specific keys nested inside `ci_feedback:` (e.g., `ci_feedback.github.owner`) are flagged as unknown because `ci_feedback` does not use adapter pass-through. Place adapter-specific config in a top-level extension block instead.

> [!NOTE]
> Environment variable overrides for `ci_feedback` fields are not currently supported. All `ci_feedback` values must be set in WORKFLOW.md. This differs from `tracker` and `agent` sections, which support `SORTIE_TRACKER_*` and `SORTIE_AGENT_*` overrides respectively.

### Escalation behavior

| Escalation          | Behavior                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` (default)   | Adds `escalation_label` (default `needs-human`) to the issue via the tracker adapter's `AddLabel` API. The label is created on demand if the tracker does not already have it.  |
| `comment`           | Posts a plain-text comment on the issue listing the number of CI-fix attempts, which checks failed, their conclusions, and details URLs.                 |

Both escalation actions release the claim on the issue and cancel any pending retry. The issue will not be re-dispatched until its tracker state changes.

### Dynamic reload

`max_retries`, `escalation`, and `escalation_label` reload dynamically. Changes take effect on the next reconcile tick. `kind` and `max_log_lines` are read at startup and do not change at runtime because the CI provider is constructed once. Changing `kind` or `max_log_lines` requires a restart.

**Minimal:**

```yaml
ci_feedback:
  kind: github
```

**Full:**

```yaml
ci_feedback:
  kind: github            # activates CI feedback; absent = disabled
  max_retries: 2           # default 2; 0 = escalate immediately
  max_log_lines: 50        # default 50; 0 = disable log fetching
  escalation: label        # "label" or "comment"; default "label"
  escalation_label: needs-human  # default "needs-human"
```

For operational guidance on CI feedback setup, hook scripts that produce `.sortie/scm.json`, and prompt template examples with `{{ .ci_failure }}`, see [how to configure CI feedback](/guides/configure-ci-feedback/).

---

## `self_review`

Self-review configuration. When enabled, Sortie runs an orchestrator-controlled review loop between the coding turn loop and worker exit. The orchestrator generates a workspace diff, runs verification commands, and feeds structured results to the agent for bounded iteration. Self-review is opt-in and adds zero overhead when disabled.

| Field                      | Type            | Default    | Description                                                                                                |
| -------------------------- | --------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`                  | boolean         | `false`    | Activates the self-review loop. When false or absent, no review phase runs.                                |
| `max_iterations`           | integer         | `3`        | Hard cap on review iterations. Range: 1–10. Each iteration includes a review turn and (if verdict is “iterate”) a fix turn. |
| `verification_commands`    | list of strings | _(none)_   | Shell commands to run during each review iteration. Required and non-empty when `enabled: true`.           |
| `verification_timeout_ms`  | integer         | `120000`   | Per-command timeout in milliseconds. Timed-out commands are killed via process group signal.                |
| `max_diff_bytes`           | integer         | `102400`   | Maximum bytes of diff included in the review prompt. Larger diffs are truncated with a note.                |
| `reviewer`                 | string          | `"same"`   | Which agent runs the review turns. Only `"same"` (reuse existing session) is supported in v1.               |

`enabled: true` with empty or absent `verification_commands` produces a `ConfigError`. `max_iterations` outside [1, 10] produces a `ConfigError`. `reviewer` values other than `"same"` produce a `ConfigError`. All integer fields accept quoted string integers (e.g., `"3"`) following the same coercion rules as other integer config fields.

> [!NOTE]
> Environment variable overrides for `self_review` fields are not supported. Verification commands are security-sensitive privileged configuration that must come from the version-controlled WORKFLOW.md. All `self_review` values must be set in WORKFLOW.md.

### Turn accounting

Each iteration runs one review turn. Non-final iterations that produce an “iterate” verdict also run a fix turn. `max_iterations: N` means up to `2N − 1` additional agent turns in the worst case (N review turns + N−1 fix turns). For the default `max_iterations: 3`, this is up to **5 additional agent turns**. Factor this into token budget and wall-clock time expectations.

### Dynamic reload

`self_review` fields take effect on future dispatches. A running worker uses the config snapshot captured at the start of the review phase. Changing `enabled` to `false` via dynamic reload stops future workers from entering review but does not interrupt a currently-running review loop.

**Minimal:**

```yaml
self_review:
  enabled: true
  verification_commands:
    - "go test ./..."
```

**Full:**

```yaml
self_review:
  enabled: true                     # default false; opt-in
  max_iterations: 3                  # default 3; range [1, 10]
  verification_commands:             # required when enabled
    - "go test ./..."
    - "go vet ./..."
    - "golangci-lint run"
  verification_timeout_ms: 120000    # default 2 min per command
  max_diff_bytes: 102400             # default 100 KB
  reviewer: "same"                   # only "same" in v1
```

For operational guidance on setting up self-review, choosing verification commands, and verifying the loop, see [how to configure self-review](/guides/configure-self-review/).

---

## `reactions`

The `reactions` block configures post-PR feedback loops. Each key is a reaction kind (e.g. `review_comments`) with its own provider, retry budget, and escalation policy. Reactions are opt-in: omit the block entirely to disable all reaction types. The `label_commands` key is configured in the same block but is human-triggered rather than event-driven, and it carries no retry budget or escalation.

For the shared reaction lifecycle and every kind Sortie ships, with field tables and safety rules, see the [reactions reference](/reference/reactions/).

### `reactions.review_comments`

Polls `CHANGES_REQUESTED` review comments on Sortie-created PRs and dispatches continuation turns so the agent can address reviewer feedback. Requires `provider` to be set. Only human reviewer comments are processed; bot and automated comments are filtered by author type.

| Field                    | Type    | Default        | Description                                                                                          |
| ------------------------ | ------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `provider`               | string  | _(required)_   | SCM adapter kind (e.g. `"github"`). Must match a registered SCM adapter.                           |
| `max_retries`            | integer | `2`            | Maximum review-fix continuation turns before escalation. Non-negative.                               |
| `escalation`             | string  | `"label"`     | Action on retry exhaustion: `"label"` or `"comment"`.                                            |
| `escalation_label`       | string  | `"needs-human"` | Label applied when `escalation` is `"label"`.                                                    |
| `poll_interval_ms`       | integer | `120000`       | Minimum interval between review API polls per issue. Minimum: `30000`.                               |
| `debounce_ms`            | integer | `60000`        | Wait time after last detected comment before dispatch. Non-negative.                                 |
| `max_continuation_turns` | integer | `3`            | Hard cap on review-triggered continuations per PR. Positive integer.                                 |

`provider` is required when `reactions.review_comments` is present; omitting it does not produce an error, but review polling is inactive without a provider. `max_retries` must be non-negative. `escalation` must be `"label"` or `"comment"`; other values produce a configuration error. `poll_interval_ms` has a minimum of `30000`; values below are rejected. `max_continuation_turns` must be positive.

Review feedback requires `.sortie/scm.json` in the workspace to contain `pr_number` (integer > 0), `owner`, and `repo` fields. The agent or `after_run` hook writes these. When any field is missing or zero, review polling is skipped for that workspace. No error is logged; the feature degrades silently.

> [!NOTE]
> Environment variable overrides for `reactions` fields are not supported. Reaction configuration must come from WORKFLOW.md.

`reactions.review_comments` is captured once when the orchestrator starts and is not rebuilt on a dynamic reload. Changing any field here, and adding or removing the block itself, takes effect only on the next restart. This holds for every reaction kind except `ci_failure`, which is folded into the CI feedback configuration and re-read on every tick.

**Minimal:**

```yaml
reactions:
  review_comments:
    provider: github
```

**Full:**

```yaml
reactions:
  review_comments:
    provider: github                    # required; registered SCM adapter
    max_retries: 2                      # continuation turns before escalation
    escalation: label                   # "label" or "comment"
    escalation_label: needs-human       # label applied on escalation
    poll_interval_ms: 120000            # 2 min between API polls
    debounce_ms: 60000                  # 60s debounce after last comment
    max_continuation_turns: 3           # hard cap per PR
```

When a review-fix continuation dispatches, the prompt receives a `review_comments` template variable: a list of maps with keys `id`, `file`, `start_line`, `end_line`, `reviewer`, `body`. Templates should guard with `{{ if .review_comments }}`. See the [`.review_comments`](#review_comments) template variable reference below for the full schema, and [how to write a prompt template](/guides/write-prompt-template/) for syntax.

For operational guidance on setting up review feedback, see [how to configure PR review feedback](/guides/configure-review-feedback/).

### `reactions.merge_completion`

Observes the merge state of Sortie-managed PRs and transitions the linked tracker issue to one configured terminal state once the PR merges, whoever performed the merge. This is the only reaction kind whose action is a tracker write; it performs no SCM write and dispatches no continuation turn. It is off by default, and a deployment that omits the block is unaffected. The runtime kind value is `merge-completion`.

| Field              | Type    | Default         | Description                                                                                          |
| ------------------ | ------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `provider`         | string  | _(required)_    | SCM adapter kind (e.g. `"github"`). Activates the kind, and must match the provider of every other active SCM reaction. |
| `target_state`     | string  | _(required)_    | The terminal state the linked issue moves to. No default; never inferred from `tracker.terminal_states`. |
| `poll_interval_ms` | integer | `60000`         | Minimum interval between merge-state polls per issue. Minimum: `30000`.                              |
| `max_retries`      | integer | `2`             | Retryable transition attempts before escalation. `0` escalates on the first failed attempt.          |
| `escalation`       | string  | `"label"`       | Action on escalation: `"label"` or `"comment"`.                                                  |
| `escalation_label` | string  | `"needs-human"` | Label applied when `escalation` is `"label"`.                                                    |

Two `tracker` fields are required whenever `provider` is set, each reported as its own configuration error when absent: `tracker.handoff_state` must be non-empty, and `tracker.terminal_states` must be written out in front matter rather than left to the adapter's default list. `target_state` is required, and compared case-insensitively it must not equal `tracker.handoff_state`, must not be a member of `tracker.active_states` (falling back to the adapter's default active list only when that list is empty), and must be a member of `tracker.terminal_states` as written. `poll_interval_ms` below `30000` is rejected, not clamped. `sortie validate` reports all of these offline, before a run.

Every field here, `target_state` included, is captured once at orchestrator construction, as the other reaction kinds are; changing any of them, or either tracker prerequisite, requires a restart. Review feedback's `.sortie/scm.json` requirements apply with one exception: this kind reads `pr_number`, `owner`, and `repo`, and needs no `branch`, because it performs no checkout.

**Minimal:**

```yaml
reactions:
  merge_completion:
    provider: github
    target_state: done
```

**Full:**

```yaml
reactions:
  merge_completion:
    provider: github                    # required; registered SCM adapter
    target_state: done                  # required; member of tracker.terminal_states
    poll_interval_ms: 60000             # 60s between merge-state polls
    max_retries: 2                      # transition attempts before escalation
    escalation: label                   # "label" or "comment"
    escalation_label: needs-human       # label applied on escalation
```

> [!WARNING]
> The transition is irreversible by the orchestrator, and no validator can tell you that a valid `target_state` is the wrong one: a terminal list usually mixes a completion state with abandonment states. Enabling this block also requires the tracker credential to hold write authority sufficient to transition an issue, which nothing checks in advance.

For the lifecycle, the idempotency latch, and the failure matrix, see the [merge-completion reference](/reference/reactions/#reactionsmerge_completion). For setup guidance, see [how to set up PR reactions](/guides/setup-pr-reactions/).

### `reactions.label_commands`

Configures the PR label commands: an operator applies a configured label to a Sortie-managed PR, and Sortie dispatches an agent session in response. The `review_label` (`sortie:review` by default) dispatches a read-only review; the `fix_label` (`sortie:fix` by default) dispatches a session that pushes review-feedback fixes. Unlike the other reaction kinds, this block is human-triggered: it parses through its own path, carries no retry budget or escalation fields, and never appears as a generic reaction entry. For detection semantics, session behavior, and authorization, see the [label commands reference](/reference/label-commands/).

| Field              | Type    | Default           | Description                                                                                                                                  |
| ------------------ | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`         | string  | _(required)_      | SCM adapter kind (e.g. `"github"`). Must match a registered SCM adapter. Absent or empty leaves the feature off, and no label polling happens. |
| `review_label`     | string  | `"sortie:review"` | Label that triggers the read-only review command. An explicit empty string (`""`) disables the review command.                               |
| `fix_label`        | string  | `"sortie:fix"`    | Label that triggers the fix command. An explicit empty string (`""`) disables the fix command.                                               |
| `poll_interval_ms` | integer | `60000`           | Minimum interval between label-journal polls per PR. Minimum `30000`; lower values are clamped up to the floor with a warning, not rejected.  |

Activation is by `provider`: with the block absent or `provider` empty, the feature is off and no label polling happens for either command. An absent `review_label` or `fix_label` takes its default; an explicit empty string is a deliberate disable of that command. Setting `provider` while both labels are empty strings is a configuration error, which `sortie validate` reports offline; because the defaults are non-empty, this occurs only when you empty both. A `provider` naming an unregistered SCM adapter is also a validate error. When more than one SCM reaction kind is active, every active kind must name the same `provider`, and `sortie validate` reports a mismatch offline.

Every `reactions.label_commands` field, including `provider`, takes effect at startup; changing any of them requires a restart.

A block using the defaults:

```yaml
reactions:
  label_commands:
    provider: github
    review_label: "sortie:review"
    fix_label: "sortie:fix"
    poll_interval_ms: 60000
```

---

## `notifications`

Notification backends for the `notify_operator` agent tool. While a session runs, the agent escalates decisions, reports progress, or flags blockers through these channels. The tool is registered only when the list configures at least one backend; when the list is absent or empty, the agent is never offered the tool. The value is a sequence: a second channel is a second entry. The tool contract (input schema, response shapes, error kinds) lives in the [agent extensions reference](/reference/agent-extensions/#notify_operator).

Each entry accepts two typed fields:

| Field             | Type    | Default      | Description                                                                                         |
| ----------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `kind`            | string  | _(required)_ | Backend discriminator. Built-in backends: `webhook`, `slack`.                                       |
| `max_per_session` | integer | `20`         | Per-session notification cap. `0` selects the default (`20`); it never means unlimited. Must be non-negative. |

Every other key in an entry passes through to the backend untyped, with `$VAR` and `${VAR}` references resolved on string values, the same mechanism as [adapter pass-through configuration](#adapter-pass-through-configuration). Per-backend required fields:

| `kind`    | Field         | Description                                                               |
| --------- | ------------- | -------------------------------------------------------------------------- |
| `webhook` | `url`         | Endpoint that receives an HTTP POST of the notification as a JSON object. |
| `slack`   | `webhook_url` | Slack incoming webhook URL that receives a Slack-shaped JSON body.        |

When more than one entry sets `max_per_session`, the effective cap is the maximum non-zero value across entries, falling back to `20` when every entry is `0` or unset. The cap counts `notify_operator` calls, not per-backend sends.

> [!WARNING]
> Backend secrets must be references to `SORTIE_`-prefixed environment variables (`$SORTIE_NAME` or `${SORTIE_NAME}`). The `notify_operator` tool runs in a separate `sortie mcp-server` process that receives only `SORTIE_`-prefixed variables; a reference without the prefix, or to an unset variable, resolves to the empty string there and surfaces as a fatal sidecar startup error at session start rather than a notification posted nowhere. `sortie validate` checks the section's shape (a sequence of maps, a non-empty `kind`, a non-negative `max_per_session`) but cannot catch an unknown `kind` or an empty secret.

> [!NOTE]
> Environment variable overrides for `notifications` fields are not supported. Backend configuration must come from WORKFLOW.md; environment values reach a backend only through `$VAR` references inside its entry.

The `webhook` backend is an outbound POST to an operator-supplied endpoint. It is unrelated to inbound tracker webhooks, which trigger reconciliation.

```yaml
notifications:
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    max_per_session: 20
  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL
```

Changes to this section apply to the next agent session: each session's MCP sidecar reads the workflow file at startup, so in-flight sessions keep their backends.

---

## `db_path`

SQLite database file path.

| Field     | Type | Default      | Description                                                                                         |
| --------- | ---- | ------------ | --------------------------------------------------------------------------------------------------- |
| `db_path` | path | `.sortie.db` | Path to the SQLite database. Relative paths resolve against the directory containing `WORKFLOW.md`. |

Supports `~` home directory expansion and `$VAR` environment expansion. An explicit empty string (`db_path: ""`) is equivalent to omitting the field. Non-string values produce a configuration error.

> [!WARNING]
> Changing `db_path` requires a restart. The new path opens a fresh database. Retry queues and run history from the old file are not migrated automatically.

```yaml
db_path: /var/lib/sortie/state.db
```

---

## Adapter pass-through configuration

Each adapter reads additional settings from a top-level block named after its `kind` value. The orchestrator forwards these blocks to the adapter without validation.

### `claude-code`

| Field | Type | Default | CLI flag | Description |
|---|---|---|---|---|
| `permission_mode` | string | _(absent)_ | `--permission-mode` | Claude Code permission mode. Values: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `manual` (an alias for `default`), `plan`. When absent, the adapter passes `--dangerously-skip-permissions` instead. |
| `model` | string | _(CLI default)_ | `--model` | Model for agent sessions. Accepts an alias such as `sonnet`, or a full model name. |
| `fallback_model` | string | _(none)_ | `--fallback-model` | Model to switch to when the primary is overloaded, unavailable, or returns another non-retryable server error. Accepts a comma-separated chain, capped at three models. Authentication, billing, rate-limit, request-size, and transport errors never trigger a switch, and the switch lasts one turn only. See [Fallback model scope](/reference/adapter-claude-code/#fallback-model-scope). |
| `max_turns` | integer | _(CLI default)_ | `--max-turns` | Claude Code's internal agentic turn budget per invocation. |
| `max_budget_usd` | number | _(none)_ | `--max-budget-usd` | Per-invocation cost cap. Resets each turn. |
| `effort` | string | _(CLI default)_ | `--effort` | Inference effort level. Values: `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode`, which starts the session at `xhigh` with ultracode enabled. The accepted set depends on the model; an unrecognized value falls back to the default effort with a warning. |
| `allowed_tools` | string | _(none)_ | `--allowedTools` | Comma- or space-separated list of tools that run without a permission prompt, including scoped rules such as `Bash(git diff *)`. |
| `disallowed_tools` | string | _(none)_ | `--disallowedTools` | Comma- or space-separated list of tools to deny. A bare tool name removes the tool from the model's context; a scoped rule denies only matching calls. |
| `system_prompt` | string | _(none)_ | `--append-system-prompt` | Text appended to Claude Code's default system prompt rather than replacing it. |
| `mcp_config` | string | _(none)_ | `--mcp-config` | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Sortie reads that file and passes a generated copy carrying its own `sortie-tools` server, leaving the original unmodified; a file already declaring `sortie-tools` fails the attempt. |
| `session_persistence` | boolean | `true` | `--no-session-persistence` | Whether Claude Code saves session history to disk. When `false`, the flag is passed and no session file is written. The adapter continues a session on later turns with `--resume <session_id>`, which reads the persisted session, so with persistence off every turn after the first fails with `No conversation found with session ID`. |

The adapter validates none of these values. What the CLI does with an invalid one differs per flag: `--permission-mode` is rejected at launch, `--effort` falls back to the default effort with a warning, and an unknown model name reaches the API and fails there. A key whose YAML value has the wrong type is ignored and the default applies.

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and `claude-code.max_turns` (CLI internal turn budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls the Claude Code CLI's internal turn budget per invocation.

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  fallback_model: claude-haiku-4-5
  max_turns: 50
  max_budget_usd: 5
  effort: high
  allowed_tools: "Read Edit Bash(git diff *)"
  mcp_config: ./mcp-servers.json
```

### `copilot-cli`

| Field                     | Type    | Description                                                                 |
| ------------------------- | ------- | --------------------------------------------------------------------------- |
| `model`                   | string  | LLM model identifier (e.g., `claude-sonnet-4.5`, `gpt-5`).                |
| `max_autopilot_continues` | integer | Maximum autonomous continuation steps. Default: `50`.                       |
| `agent`                   | string  | Custom agent name for routing.                                              |
| `allowed_tools`           | string  | Tools permitted without confirmation (glob patterns).                       |
| `denied_tools`            | string  | Tools denied (takes precedence over `allowed_tools`).                       |
| `available_tools`         | string  | Restrict tool palette to listed tools only.                                 |
| `excluded_tools`          | string  | Remove specific tools from the available set.                               |
| `mcp_config`              | string  | Inline JSON or path to an MCP server configuration file.                    |
| `disable_builtin_mcps`    | boolean | Disable all built-in MCP servers.                                           |
| `no_custom_instructions`  | boolean | Disable loading custom instructions from workspace files.                   |
| `experimental`            | boolean | Enable experimental Copilot CLI features.                                   |

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and `copilot-cli.max_autopilot_continues` (CLI autonomy budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls how many autonomous continuation steps Copilot CLI takes within a single `RunTurn` invocation.

When any tool-scoping flag (`allowed_tools`, `denied_tools`, `available_tools`, `excluded_tools`) is configured, the adapter omits `--allow-all` and uses the scoped flags instead. When none are set, `--allow-all` is passed for unattended operation.

```yaml
copilot-cli:
  model: claude-sonnet-4.5
  max_autopilot_continues: 100
  mcp_config: ./mcp-servers.json
```

### `codex`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(API default)_ | Model override (e.g., `o3`, `gpt-5.4`). Maps to `model` on `thread/start`. |
| `effort` | string | _(API default)_ | Reasoning effort: `low`, `medium`, `high`. Maps to `effort` on `turn/start`. |
| `approval_policy` | string | `never` | Approval policy for thread and turn. Values: `never`, `onRequest`, `unlessTrusted`, `always`. |
| `thread_sandbox` | string | `workspaceWrite` | Thread sandbox mode. Values: `workspaceWrite`, `readOnly`, `dangerFullAccess`, `externalSandbox`. |
| `personality` | string | _(none)_ | Personality preset. Maps to `personality` on `thread/start`. |
| `turn_sandbox_policy` | map | _(none)_ | Per-turn sandbox policy override. Keys such as `networkAccess`, `writableRoots`. |

The Codex adapter uses a persistent subprocess model: the `codex app-server` is launched once in `StartSession` and kept alive across turns. This differs from Claude Code, Copilot CLI, and OpenCode, which spawn a new subprocess per turn. See the [Codex adapter reference](/reference/adapter-codex/) for the full lifecycle.

> [!WARNING]
> `approval_policy: never` allows arbitrary command execution within the sandbox boundary. Use only in sandboxed environments. The default `thread_sandbox: workspaceWrite` restricts writes to the workspace path with no network access.

```yaml
codex:
  model: o3
  effort: medium
  approval_policy: never
  thread_sandbox: workspaceWrite
  personality: concise
  turn_sandbox_policy:
    networkAccess: true
```

### `opencode`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(CLI default)_ | Model identifier in `provider/model` form. |
| `agent` | string | _(none)_ | OpenCode agent name passed through unchanged. |
| `variant` | string | _(none)_ | Provider-specific reasoning variant passed through unchanged. |
| `thinking` | boolean | `false` | Adds the `--thinking` flag. |
| `pure` | boolean | `false` | Adds the `--pure` flag. |
| `dangerously_skip_permissions` | boolean | `true` | Adds `--dangerously-skip-permissions` when true. Omitted when false. |
| `disable_autocompact` | boolean | `true` | Sets the managed `OPENCODE_DISABLE_AUTOCOMPACT` environment variable for both `run` and `export` subprocesses. |
| `allowed_tools` | list of strings | `[]` | Builds the managed `OPENCODE_PERMISSION` allowlist. Listed keys become `allow`; every known key not listed becomes `deny`. Unknown keys are forwarded unchanged. |
| `denied_tools` | list of strings | `[]` | Adds deny rules to `OPENCODE_PERMISSION`. Overlap with `allowed_tools` is rejected during adapter construction. |

The OpenCode adapter always adds `run --format json --dir <workspace> -- <prompt>`. It does not expose `--attach`, `--port`, `--command`, `--file`, `--title`, `--continue`, or `--fork` through WORKFLOW.md.

The OpenCode adapter spawns one `opencode run --format json` subprocess per turn and a second `opencode export --sanitize <sessionID>` subprocess after the turn to recover authoritative token usage. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the full lifecycle, SSH behavior, and authentication model.

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and OpenCode's internal step budget are not the same thing. The adapter does not expose an OpenCode-specific inner turn cap.

```yaml
opencode:
  model: anthropic/claude-sonnet-4-5
  variant: high
  pure: true
  dangerously_skip_permissions: true
  disable_autocompact: true
  allowed_tools:
    - read
    - edit
    - glob
```

### `kiro`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(none)_ | Maps to `--model`. The model must be pinned here because the `/model` slash command is unavailable in headless mode. |
| `trust_all_tools` | boolean | `false` | Maps to `--trust-all-tools`, auto-approving every tool call. Mutually exclusive with `trust_tools`. |
| `trust_tools` | list of strings | `[]` | Maps to `--trust-tools=<comma-joined>`. An empty list trusts nothing. Mutually exclusive with `trust_all_tools`. |
| `agent` | string | _(none)_ | Maps to `--agent`, an optional custom-agent selector. |

The Kiro adapter spawns one `kiro-cli chat --no-interactive` subprocess per turn. The headless path reports no token counts, so budget enforcement is time-based through `agent.turn_timeout_ms`, and MCP is unavailable on the `KIRO_API_KEY` path. See the [Kiro CLI adapter reference](/reference/adapter-kiro/) for the full lifecycle.

> [!WARNING]
> `kiro.trust_all_tools: true` combined with a non-empty `kiro.trust_tools` list is rejected at adapter construction. Use `--trust-all-tools` only inside a hardened sandbox; prefer a least-privilege `trust_tools` allowlist.

```yaml
kiro:
  model: claude-sonnet-4.6
  trust_tools:
    - read
    - grep
    - glob
```

### `file` (file-based tracker)

| Field  | Type   | Description                                                        |
| ------ | ------ | ------------------------------------------------------------------ |
| `path` | string | Filesystem path to a JSON file containing issue records. Required. |

```yaml
file:
  path: ./test-issues.json
```

---

## Extensions

Unknown top-level keys are collected into an extensions map for forward compatibility. The orchestrator does not validate extension fields at runtime; each consumer defines its own schema. However, [`sortie validate`](/reference/cli/#validate) emits advisory warnings for unknown top-level keys that are not recognized extensions or adapter pass-through blocks - catching typos before deployment.

### `server`

Embedded HTTP observability server. Exposes a JSON API, HTML dashboard, health probes, and Prometheus metrics on a single port. See the [HTTP API reference](/reference/http-api/) for endpoint details and the [Prometheus metrics reference](/reference/prometheus-metrics/) for metric definitions.

| Field  | Type        | Default     | Description                                                                      |
| ------ | ----------- | ----------- | -------------------------------------------------------------------------------- |
| `port` | integer     | `7678`      | TCP port for the HTTP server. `0` disables the server.                           |
| `host` | string (IP) | `127.0.0.1` | Bind address. Must be a parseable IP address. DNS hostnames are not accepted.    |

The CLI `--port` flag takes precedence over `server.port`, and `--host` takes precedence over `server.host`. Both require a restart to change.

> [!NOTE]
> The HTTP server starts by default on `127.0.0.1:7678` with no configuration required. Pass `--port 0` to disable it. When disabled, the orchestrator uses a no-op metrics implementation with zero overhead.

```yaml
server:
  port: 9090
  host: "0.0.0.0"
```

### `logging`

Process-wide log verbosity and output format. Controls the minimum severity level and the serialization format for log lines emitted to stderr.

| Field | Type | Default | Required | Dynamic Reload | Description |
|---|---|---|---|---|---|
| `logging.level` | string | `info` | No | **No** - requires restart | Log verbosity: `debug`, `info`, `warn`, `error` (case-insensitive). |
| `logging.format` | string | `text` | No | **No** - requires restart | Log output format: `text` or `json` (case-insensitive). `text` emits structured `key=value` lines. `json` emits newline-delimited JSON objects. |

The CLI [`--log-level`](/reference/cli/#-log-level) flag takes precedence over `logging.level`, and [`--log-format`](/reference/cli/#-log-format) takes precedence over `logging.format`. Changing either field in the workflow file takes effect only after a restart; dynamic reload does not re-initialize the log handler.

Unknown values for either field cause startup failure with exit code `1`.

```yaml
logging:
  level: debug
  format: json
```

### `token_rates`

Per-adapter token pricing for cost estimation on the [dashboard](/reference/dashboard/#cost-estimation). Keys are agent adapter kind strings (e.g., `"claude-code"`, `"copilot-cli"`, `"opencode"`). All rates are in USD per 1 million tokens.

| Field | Type | Default | Description |
|---|---|---|---|
| `token_rates` | map | _(absent)_ | Top-level extension key. Keys are agent adapter kind strings. With rates configured, the dashboard shows estimated cost and the [`sortie stats`](/reference/cli/#stats) subcommand prices the runs it aggregates from run history. When absent or empty, the dashboard shows raw token counts without cost estimates, and `sortie stats` reports no cost figures. |
| `token_rates.<kind>.input_per_mtok` | number | _(not set)_ | USD per million input tokens. |
| `token_rates.<kind>.output_per_mtok` | number | _(not set)_ | USD per million output tokens. |
| `token_rates.<kind>.cache_read_per_mtok` | number | _(not set)_ | USD per million cache-read tokens. |

Each rate field is optional. A missing field means cost is not estimated for that token type. A zero value is valid and produces `$0.00`. Partial rates are accepted - configuring only `output_per_mtok` computes cost from output tokens alone.

Validation rules:

- `token_rates` must be a map when present. Non-map values produce a warning (not a fatal error).
- Rate values must be non-negative numbers. Negative values produce a warning and are treated as not configured.
- Invalid sub-values produce warnings logged at startup. They do not prevent boot.

Token rates do not reload dynamically. Changes require a process restart, consistent with `server.port` and `server.host`.

```yaml
token_rates:
  claude-code:
    input_per_mtok: 3.00
    output_per_mtok: 15.00
    cache_read_per_mtok: 0.30
  copilot-cli:
    input_per_mtok: 2.00
    output_per_mtok: 8.00
    cache_read_per_mtok: 0.20
  codex:
    input_per_mtok: 2.50
    output_per_mtok: 10.00
    cache_read_per_mtok: 0.25
```

See [how to control agent costs](/guides/control-costs/) for operational guidance on cost monitoring.

### `worker`

SSH remote execution. The host with the fewest active sessions is selected per dispatch. See the [scale agents with SSH](/guides/scale-agents-with-ssh/) guide for operational setup.

> [!NOTE]
> SSH worker mode requires POSIX remote hosts (Linux, macOS). The orchestrator itself runs on any platform, but remote command execution relies on `cd`, `--` and `&&` shell chaining via the remote host's POSIX shell.

| Field                          | Type            | Default                        | Description                                                                 |
| ------------------------------ | --------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `ssh_hosts`                    | list of strings | _(absent; runs locally)_       | SSH host targets for remote agent execution.                                |
| `max_concurrent_agents_per_host` | integer       | _(absent; no per-host cap)_    | Per-host concurrency limit. Hosts at capacity are skipped during dispatch.  |
| `ssh_strict_host_key_checking` | string          | `accept-new`                   | OpenSSH `StrictHostKeyChecking` value for remote sessions. Allowed values: `accept-new`, `yes`, `no`. |

When `ssh_hosts` is absent or empty, all agents run locally. The `ssh_strict_host_key_checking` field is ignored in local mode. All three fields reload dynamically.

### `ssh_strict_host_key_checking` values

| Value | Behavior |
|---|---|
| `accept-new` | Trust on first use - accept unknown host keys, reject changed keys. Default. |
| `yes` | Refuse connections unless the host key is already in `known_hosts`. Requires pre-populated `known_hosts`. |
| `no` | Accept any host key. Intended for isolated test or CI environments with ephemeral hosts. |

Invalid values produce a warning log at parse time and fall back to `accept-new`.

```yaml
worker:
  ssh_hosts:
    - build01.internal
    - build02.internal
  max_concurrent_agents_per_host: 2
  ssh_strict_host_key_checking: "yes"
```

---

## Prompt template

The markdown body after the closing `---` is a Go `text/template` rendered per issue. The template engine runs in strict mode (`missingkey=error`): referencing an undefined variable or function fails rendering immediately.

The template receives five top-level variables: `.issue`, `.attempt`, `.run`, `.ci_failure`, and `.review_comments`.

### `.issue`

Normalized issue object. All fields are present regardless of the underlying tracker system.

| Field                | Type            | Description                                                                        |
| -------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `.issue.id`          | string          | Tracker-internal ID.                                                               |
| `.issue.identifier`  | string          | Human-readable ticket key (e.g., `PROJ-123`).                                      |
| `.issue.title`       | string          | Issue summary.                                                                     |
| `.issue.description` | string          | Full description body. Empty string when absent.                                   |
| `.issue.state`       | string          | Current tracker state name.                                                        |
| `.issue.priority`    | integer or nil  | Numeric priority (lower = higher). `nil` when the tracker does not provide it.     |
| `.issue.url`         | string          | Web URL to the issue. Empty string when absent.                                    |
| `.issue.labels`      | list of strings | Labels, normalized to lowercase. Non-nil empty list when none.                     |
| `.issue.assignee`    | string          | Assignee identity. Empty string when absent.                                       |
| `.issue.issue_type`  | string          | Tracker-defined type (Bug, Story, Task, Epic). Empty string when absent.           |
| `.issue.branch_name` | string          | Tracker-provided branch metadata. Empty string when absent.                        |
| `.issue.parent`      | object or nil   | Parent issue reference. `nil` when no parent. Has `.id` and `.identifier`.         |
| `.issue.comments`    | list or nil     | Comment records. `nil` means not fetched; empty list means no comments exist. Each comment has `.id`, `.author`, `.body`, and `.created_at`. |
| `.issue.blocked_by`  | list of objects | Blocker references. Each has `.id`, `.identifier`, `.state`. Non-nil empty list when no blockers. |
| `.issue.created_at`  | string          | ISO-8601 creation timestamp. Empty string when absent.                             |
| `.issue.updated_at`  | string          | ISO-8601 last-update timestamp. Empty string when absent.                          |

### `.attempt`

Integer. `0` on the first try, `>= 1` on retries. The value does not change on continuation turns within the same session.

In template conditionals, `0` evaluates to false: `{{ if .attempt }}` is true only on retries.

### `.run`

| Field                  | Type    | Description                                                                                                      |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `.run.turn_number`     | integer | Current turn number within the session.                                                                          |
| `.run.max_turns`       | integer | Configured maximum turns (`agent.max_turns`).                                                                    |
| `.run.is_continuation` | boolean | `true` when this is a continuation turn (not the first turn, not a retry after error).                           |

### `.ci_failure`

Available only on the first turn of a CI-fix continuation dispatch. `nil` on normal dispatches and non-CI retries.

| Field                    | Type            | Description                                                                                       |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `.ci_failure.status`     | string          | Always `"failing"` when present.                                                                  |
| `.ci_failure.check_runs` | list of objects | Individual check runs. Each has `.name` (string), `.status` (string), `.conclusion` (string), `.details_url` (string). |
| `.ci_failure.log_excerpt` | string         | Truncated log from the first failing check. Empty when log fetching is disabled or logs are unavailable. |
| `.ci_failure.failing_count` | integer      | Number of checks with a failure conclusion.                                                       |
| `.ci_failure.ref`        | string          | The git ref (branch or SHA) that was checked.                                                     |

### `.review_comments`

Available only on the first turn of a review-fix continuation dispatch. `nil` on normal dispatches and non-review retries.

A list of maps, one per actionable review comment. Outdated comments (referring to code modified by a subsequent push) are excluded.

| Field              | Type    | Description                                                                                     |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `.id`              | string  | SCM-platform comment identifier.                                                                |
| `.file`            | string  | File path the comment is attached to. Empty for PR-level (non-inline) review comments.          |
| `.start_line`      | integer | First line of the commented range. `0` when the comment is not attached to a specific line.     |
| `.end_line`        | integer | Last line of the commented range. `0` for single-line or non-inline comments.                   |
| `.reviewer`        | string  | Username of the comment author.                                                                 |
| `.body`            | string  | Comment text.                                                                                   |

```
{{ if .review_comments }}
## Review Comments to Address

{{ range .review_comments }}
### {{ .reviewer }} on {{ .file }}{{ if .start_line }} (line {{ .start_line }}{{ if .end_line }}-{{ .end_line }}{{ end }}){{ end }}

{{ .body }}

{{ end }}
{{ end }}
```

### Turn semantics

The full template is rendered on every turn. The runtime passes the complete rendered result to the agent regardless of turn number. Template authors branch on `.attempt`, `.run.is_continuation`, `.ci_failure`, and `.review_comments` to vary content.

| Scenario             | `.attempt`       | `.run.is_continuation` | `.ci_failure`         | `.review_comments`      |
| -------------------- | ---------------- | ---------------------- | --------------------- | ----------------------- |
| First run            | `0`              | `false`                | `nil`                 | `nil`                   |
| Continuation         | same as turn 1   | `true`                 | `nil`                 | `nil`                   |
| Retry after error    | `>= 1`           | `false`                | `nil`                 | `nil`                   |
| CI-fix dispatch      | same as previous  | `false`               | map with failure data | `nil`                   |
| Review-fix dispatch  | same as previous  | `false`               | `nil`                 | list of comment maps    |

On continuation turns, if the rendered prompt is empty, Sortie substitutes a built-in default continuation prompt. On the first turn, an empty rendered prompt is passed through as-is.

### Template functions

| Function | Signature              | Result                 |
| -------- | ---------------------- | ---------------------- |
| `toJSON` | `toJSON value`         | Compact JSON string. `{{ .issue.labels \| toJSON }}` produces `["bug","urgent"]`. |
| `join`   | `join separator list`  | Joined string. `{{ .issue.labels \| join ", " }}` produces `bug, urgent`. |
| `lower`  | `lower string`         | Lowercased string. `{{ .issue.state \| lower }}` produces `in progress`. |

`join` uses pipe syntax with reversed arguments: the piped value is passed as the last argument per Go template convention.

### Built-in actions

All standard Go `text/template` actions are available:

| Action | Purpose |
| ------ | ------- |
| `{{ if COND }}...{{ else }}...{{ end }}`  | Conditional branching. |
| `{{ range LIST }}...{{ end }}`            | Iteration over lists and maps. |
| `{{ with VALUE }}...{{ end }}`            | Scope dot to value if non-empty. |
| `eq`, `ne`, `lt`, `le`, `gt`, `ge`       | Comparison. |
| `and`, `or`, `not`                        | Logical operators. |
| `len`, `index`                            | Length and index access. |
| `print`, `printf`, `println`             | Formatted output. |

> [!NOTE]
> Inside `{{ range }}`, the dot (`.`) rebinds to the current element. Use `{{ $.issue.identifier }}` to access top-level variables from within a range block. `sortie validate` detects references to `.issue`, `.attempt`, or `.run` inside `{{ range }}` and `{{ with }}` blocks and emits a `dot_context` warning.

---

## Dynamic reload

Sortie watches `WORKFLOW.md` for filesystem changes and re-applies configuration without restart. The file watcher monitors the parent directory to detect atomic-rename saves (`vim`, `sed -i`). Invalid config after reload does not crash Sortie; the last valid configuration remains active and an error is logged.

| Field                                  | When it takes effect                   |
| -------------------------------------- | -------------------------------------- |
| `polling.interval_ms`                  | Next tick.                             |
| `agent.max_concurrent_agents`          | Next dispatch decision.                |
| `agent.max_concurrent_agents_by_state` | Next dispatch decision.                |
| `agent.max_retry_backoff_ms`           | Next retry schedule.                   |
| `agent.max_sessions`                   | Next retry evaluation.                 |
| `agent.max_tokens`                     | Next retry evaluation.                 |
| `tracker.*`                            | Future dispatches and reconciliation.  |
| `tracker.comments.on_dispatch`         | Future dispatches.                     |
| `tracker.comments.on_completion`, `tracker.comments.on_failure` | Future worker exits. Both toggles are evaluated against the active configuration when a worker exits, so a reload can change whether an in-flight session posts its completion or failure comment. |
| `hooks.*`                              | Future hook executions.                |
| `agent.kind`, `agent.command`, `agent.max_turns` | Future dispatches.            |
| `agent.turn_timeout_ms`, `agent.read_timeout_ms`, `agent.stall_timeout_ms` | Future worker attempts. |
| `worker.ssh_hosts`, `worker.max_concurrent_agents_per_host`, `worker.ssh_strict_host_key_checking` | Dynamic. Future dispatches use the reloaded value; in-flight sessions are unaffected. |
| Prompt template                        | Future worker attempts.                |
| `dispatch.rules`, `dispatch.default`   | Future claims. In-flight issues keep the agent and template frozen at first dispatch. |
| Per-rule `dispatch` template files     | Read on WORKFLOW.md load and reload; a standalone edit applies on the next WORKFLOW.md change or dispatch. |
| `ci_feedback.max_retries`              | Next reconcile tick.                   |
| `ci_feedback.escalation`, `ci_feedback.escalation_label` | Next reconcile tick.   |
| `ci_feedback.kind`, `ci_feedback.max_log_lines` | Requires restart.              |
| `reactions.ci_failure.watch_window_ms` | Next reconcile tick.                   |
| `self_review.*`                        | Next dispatch. Running workers use the snapshot captured at review-phase entry. |
| `reactions.*`, every kind except `ci_failure` | Requires restart. The whole block is captured once at construction, including whether each kind is active, so adding or removing a kind's block changes nothing until the process restarts. |
| `notifications`                        | Next agent session. Each session's MCP sidecar reads the workflow file at startup; in-flight sessions are unaffected. |
| `db_path`                              | Requires restart.                      |
| `server.port`                          | Requires restart.                      |
| `server.host`                          | Requires restart.                      |
| `logging.level`                        | Requires restart.                      |
| `logging.format`                       | Requires restart.                      |
| `token_rates.*`                        | Requires restart.                      |

An in-flight agent session keeps its agent and prompt template frozen at first dispatch. The exception is exit-time behavior: `tracker.comments.on_completion` and `tracker.comments.on_failure` are evaluated against the active configuration when the worker exits, so a reload during a session can change whether it posts a completion or failure comment.
