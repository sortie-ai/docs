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
  handoff_state: Human Review         # State set after a successful run that makes no stage hop
  handoff_evidence: observed          # observed (default) | strict | off
  in_progress_state: In Progress       # State set when agent picks up the issue

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
  stop_grace_ms: 5000                 # 5 s to exit before a force kill
  max_retry_backoff_ms: 120000        # 2 min max retry delay
  max_concurrent_agents_by_state:
    in progress: 3                    # Per-state concurrency cap
    to do: 1

# --- Dispatch (rule-based routing; optional) ----------------------
dispatch:
  rules:                                # Stage labels first, then first match in order
    - name: bug-fix                     # ^[a-z][a-z0-9_-]*$; logs/metric
      match:
        labels: ["bug", "bug/*"]        # glob vs lowercased labels
      agent: claude-code                # overrides agent.kind
      template: ./prompts/bug.md        # path relative to WORKFLOW.md
    - name: urgent
      match:
        priority: { lte: 2 }            # op: eq/in/lt/lte/gt/gte
      template: ./prompts/urgent.md
    - name: specify
      match:
        labels: ["feature"]
      next: implement                   # after a successful run, hop to this rule
      template: ./prompts/specify.md
    - name: implement
      stage: stage-implement            # selected by this issue label, no match
      template: ./prompts/implement.md
  default:                              # Applied when no rule matches
    template: ./prompts/default.md      # agent omitted -> agent.kind

# --- Reactions (post-PR feedback loops) ---------------------------
reactions:
  review_comments:
    provider: github                      # SCM adapter for review polling
    escalation: label                     # "label" or "none" ("comment" is deprecated)
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
  reviewer: "same"                         # only supported value is "same"

# --- Notifications (where Sortie's events and agent messages go; optional)
notifications:
  - kind: tracker_comment             # Built-in: comment on the issue
    events: [session.completed, session.stopped, session.failed]
  - kind: slack                       # Notifier backend
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL  # SORTIE_-prefixed reference (required)
    events: [agent.message, session.failed]
    max_per_session: 20               # Cap on the agent's own messages; 0 selects the default (20)
  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL      # Generic JSON POST endpoint
    events: [session.started, session.completed, session.stopped, session.failed]

# --- Claude Code adapter (pass-through) ------------------------------
claude-code:
  permission_mode: bypassPermissions  # Auto-approve tool calls
  model: <model-id>
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
    cache_write_per_mtok: 3.75        # USD per million cache-write tokens

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
| `handoff_state`   | string          | _(absent)_            | Target state after a successful agent run. A run whose dispatch rule carries `next` advances the issue to the next stage instead and writes no state; it takes this write only when the hop is not made. See [Stage chains](#stage-chains). Absent disables handoff, and a rule that carries `next` requires it. |
| `no_change_state` | string          | _(absent)_            | Target state for a run that declared the requested outcome already held (`no-change-needed` on `.sortie/status`). Absent falls back to `handoff_state`. A declared run on a rule that carries `next` advances to the next stage instead, and this target applies only when that hop is not made. Requires `handoff_state` to be set, and must equal `handoff_state` or name a member of `terminal_states`. It is the one target-state field allowed to name a terminal state. See [handoff evidence: declaring that nothing needed changing](/reference/state-machine/#declaring-that-nothing-needed-changing). |
| `handoff_evidence` | string         | `"observed"`           | Evidence policy consulted before the handoff write. `observed` withholds the write only on a positively observed absence of workspace change; `strict` also withholds it when evidence cannot be determined; `off` performs no evidence check and leaves the write governed by the other handoff conditions alone. See [state machine reference](/reference/state-machine/#handoff-evidence). |
| `in_progress_state` | string        | _(absent)_            | Target state for dispatch-time transition at the start of each worker attempt. Absent disables dispatch-time transitions. |
| `api_version`     | string          | `"3"`                 | Jira REST API version: `"3"` for Jira Cloud, `"2"` for Jira Server / Data Center. Quote the value; a bare integer draws a `sortie validate` advisory. Adapters other than Jira ignore this field. `sortie validate` rejects a value other than `"2"` or `"3"`, and rejects `"2"` against an `.atlassian.net` endpoint. See the [Jira adapter reference](/reference/adapter-jira/#api_version) for deployment-mode behavior and [offline validation](/reference/adapter-jira/#offline-validation) for the full check list. |
| `comments.on_dispatch`   | bool   | `false`               | Deprecated. Post a tracker comment when a worker is dispatched. See [Tracker comments](#tracker-comments).                     |
| `comments.on_completion` | bool   | `false`               | Deprecated. Post a tracker comment when a worker completes normally or stops on a status signal. See [Tracker comments](#tracker-comments).                |
| `comments.on_failure`    | bool   | `false`               | Deprecated. Post a tracker comment when a worker exits with an error. See [Tracker comments](#tracker-comments).               |

### Environment variable expansion

`api_key` applies full environment expansion: `$VAR` and `${VAR}` references are resolved at any position in the string.

`endpoint`, `project`, `query_filter`, `handoff_state`, `no_change_state`, `in_progress_state`, and `api_version` use targeted resolution: the value is expanded only when the entire trimmed string starts with `$`. Literal URIs and project keys that contain `$` characters elsewhere are returned unchanged.

See the [environment variables reference](/reference/environment/#var-indirection-in-workflowmd) for expansion mechanics.

### Constraints

At least one of `active_states` or `terminal_states` must be non-empty. When both are empty, Sortie refuses to start. An empty `active_states` with non-empty `terminal_states` is valid but means no issues are dispatched.

`handoff_state`, when set, must not appear in `active_states` (causes immediate re-dispatch loop) or `terminal_states` (handoff is not a terminal outcome). Jira handoff requires write permissions on the API token: `write:jira-work` (classic) or `write:issue:jira` (granular).

`no_change_state`, when set, requires `handoff_state` to be non-empty: a declared run with no handoff path performs no transition. Compared case-insensitively, its value must equal `handoff_state` or name a member of `terminal_states` as written, with no fallback to an adapter's default terminal list; any other value is a configuration error. Unlike its sibling target-state fields, naming a terminal state is exactly the case `no_change_state` exists for (a handoff with no pull request and no diff put in front of a reviewer), so a terminal `no_change_state` is never the default and stays an explicit opt-in.

`in_progress_state`, when set, must appear in `active_states` (otherwise reconciliation would immediately cancel the worker after the transition). It must not appear in `terminal_states` or collide with `handoff_state`. If the issue is already in the target state at dispatch time, the transition call is skipped (debug log only). Other transition failures at runtime are non-fatal: the worker logs a warning and continues to workspace preparation. Requires the same write permissions as `handoff_state`.

`handoff_evidence`, when set, must be one of `observed`, `strict`, or `off`. The check is a closed-set comparison that needs no network access, so an invalid value is rejected offline at startup, on dynamic reload, and by `sortie validate`.

> [!NOTE]
> Workspace cleanup for issues that reach a terminal state while no worker is running is handled by a periodic sweep, not by an instant event. The sweep runs every 60 poll cycles: with the default 30-second `polling.interval_ms`, cleanup occurs within approximately 30 minutes; with a 60-second interval, within approximately 60 minutes. When a worker is still running and reconciliation detects a terminal state, cleanup happens on the current poll tick. On the same pass, and only after that terminal check, the sweep applies a second removal ground based on workspace age; it is opt-in and off by default (see [`workspace.retention_days`](#workspace)). At startup Sortie runs the terminal check alone: it queries the tracker for the states of the workspace directories it finds and removes those reported terminal, and it cleans nothing on that pass if the listing or the tracker read fails.

### Tracker comments

The `comments` flags are deprecated. A comment on the issue is now one of the destinations in [`notifications`](#notifications): an entry of `kind: tracker_comment` lists the events it comments on. The flags still work. Each one that is `true` subscribes that destination to the matching events, draws a deprecation warning that names the replacement, and posts the same comment as before. All three default to `false`.

| Flag | Subscribes `tracker_comment` to | Replacement |
|---|---|---|
| `on_dispatch` | `session.started` | `events: [session.started]` |
| `on_completion` | `session.completed` and `session.stopped` | `events: [session.completed, session.stopped]` |
| `on_failure` | `session.failed` | `events: [session.failed]` |

The comment text for each event, and the rules for combining a flag with a `tracker_comment` entry, are under [The `tracker_comment` destination](#the-tracker_comment-destination).

The `comments` value must be a map when present. Non-boolean values for the flags produce a configuration error at startup. The flags do not support `$VAR` expansion. [Environment variables](/reference/environment/#configuration-overrides) can still set them.

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

Gitea state names are repository label names, compared case-insensitively and stored lowercased. A configured label absent from the repository is created on demand the first time an issue transitions into it, so labels need not exist beforehand. When `active_states` or `terminal_states` is omitted, the adapter carries internal fallback labels (active `["backlog", "in-progress", "review"]`, terminal `["done", "wontfix"]`) that derive an issue's state from its labels; they do not drive dispatch, which the orchestrator gates on the workflow's `active_states` and `terminal_states`. `handoff_state` and `in_progress_state` name repository labels too, and a transition swaps the current state label for the target, closing the issue on a terminal target and reopening it on an active one. Unlike Jira's appended JQL, the Gitea `query_filter` is a URL query fragment merged into the repository issue-list query: the adapter reserves the `state`, `type`, `page`, and `limit` keys (a fragment naming any of them fails when the adapter is built), warns on an unrecognized key, and warns when a `labels` value does not resolve to a repository label, because Gitea's server-side `labels` filter is AND-across-names, case-sensitive, and drops entirely on an unresolvable name. See the [Gitea adapter reference](/reference/adapter-gitea/) for the state model, field mapping, and the full `query_filter` surface.

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

Unlike Jira's appended JQL and Linear's `IssueFilter` JSON object, the GitLab `query_filter` is a URL query fragment merged into the project issue-list query, validated against a closed allowlist when the adapter is built. The adapter rejects the eight keys it owns (`state`, `issue_type`, `order_by`, `sort`, `page`, `per_page`, `pagination`, `with_labels_details`) and rejects any key outside the eighteen the issue-list route honors. That is stricter than the Gitea adapter, which warns and forwards an unrecognized key: GitLab silently ignores a parameter it does not recognize and returns an unfiltered result set with HTTP 200, so a typo such as `assignee=` for `assignee_username=` would widen the candidate set with no visible signal. Negation uses GitLab's `not[...]` hash, accepted for the subset GitLab honors there. The adapter warns, without refusing to build, when a `labels` value names a label the project does not hold, because GitLab's server-side `labels` filter is AND-across-names and case-sensitive and returns an empty result on an unmatched name. `sortie validate` reports the same verdict offline. See the [GitLab adapter reference](/reference/adapter-gitlab/) for the state model, field mapping, and the full `query_filter` allowlist.

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

`~` expands to the user's home directory. All `$VAR` and `${VAR}` references are expanded at any position. Issue identifiers are sanitized to `[A-Za-z0-9._-]` for subdirectory names; other characters become `_`.

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

Two exclusions are absolute. A workspace whose issue holds an entry in the running map or the retry map is never removed, whatever its age and however large the directory. A workspace pinned by an unexpired pending reaction is excluded until that entry expires, a bound set by that reaction kind's `watch_window_ms` (30 minutes by default, up to 24 hours by default for `ci_failure`); see the [reactions reference](/reference/reactions/#retry-budgets) for which reaction kinds pin a workspace and which do not. Everything else on disk is a candidate.

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
| `timeout_ms`    | integer      | `60000`  | Timeout in milliseconds for all hooks. Non-positive values fall back to the default; a value outside the range an integer setting accepts is rejected when the configuration loads instead, whatever its sign. |

### Failure behavior

| Hook            | On failure                                 |
| --------------- | ------------------------------------------ |
| `after_create`  | Aborts workspace creation.                 |
| `before_run`    | Aborts the current run attempt. May retry. |
| `after_run`     | Logged and ignored.                        |
| `before_remove` | Logged and ignored. Cleanup proceeds.      |

Timeouts count as failures and follow the same semantics.

### Hook process lifetime

When a hook's shell exits, whatever its exit status, Sortie terminates every process still in its process group (its Job Object on Windows), resending the termination on a fixed poll interval until the group or job reports no member left or a 2-second bound elapses. A background command inside the script ends with the hook: on Linux and macOS `&`, `nohup … &`, and `( … & )`; on Linux also `systemd-run --scope`; on Windows `start /b`, `pg_ctl start`, and `pm2 start`. A process meant to outlive the hook needs a supervisor outside that tree:

| Platform | Route | Prerequisite |
| --- | --- | --- |
| Linux, container engine | `docker compose up -d` or `docker run -d` | The hook's user reaches the Docker daemon: group membership or `sudo` for a rootful daemon. For rootless Docker, the CLI's persisted current context set to the rootless one (`docker context use rootless`, saved under `~/.docker/config.json`, which `HOME`, already on the allowlist, is enough to reach); `DOCKER_HOST` itself is not on the allowlist and is never forwarded, even if it is set in Sortie's own environment. |
| Linux, systemd user unit | `systemctl --user start`, `systemd-run --user` (without `--scope`), or `brew services start` as a non-root user | A running user manager (an active login session, or lingering enabled), and `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` present in Sortie's own environment: the hook inherits only variables Sortie itself already has. Sortie run as the systemd system service in [how to run Sortie as a systemd service](/guides/run-as-systemd-service/) has neither by default, so this route needs Sortie run as a systemd `--user` service or interactively instead, or the variable added to Sortie's own environment explicitly. |
| Linux, systemd system unit | `systemctl start` | Sortie runs as `root`, or a polkit rule grants its user `org.freedesktop.systemd1.manage-units`. |
| macOS, launchd | `brew services start` | The user Sortie runs as is logged in at the graphical console. |
| macOS, Docker Desktop | `docker compose up -d` or `docker run -d` | Docker Desktop has started for the user Sortie runs as. |
| Windows, Service Control Manager | `Start-Service` or `sc start` | The service is installed, and the account Sortie runs as holds the `SERVICE_START` right on it. |
| Windows, Docker Desktop | `docker compose up -d` or `docker run -d` | Docker Desktop is running for the user Sortie runs as. |
| Windows, Task Scheduler | `schtasks /run /tn <task>` or `Start-ScheduledTask` on a task the user registered | The task exists and runs in the user's own security context. |

Prefer a supervisor that owns the service across runs, such as `docker compose up -d` on Linux and macOS, which recreates a service's containers only when its configuration or image changed, or a service manager. A hook whose next step uses the service should wait until the service accepts connections, since these start commands can return before it does.

On Windows, a hook whose Job Object could not be created or assigned still runs, with the failure logged, and that teardown then reaches only the shell itself. When a hook that exits on its own leaves a process running that it did not start through one of the routes above, Sortie logs one INFO record, `leftover processes terminated after the command exited`, carrying `hook` and `workspace`; a termination that still cannot confirm the group or job empty once the 2-second bound elapses is logged as a warning instead.

For the practical walkthrough, see [how to set up workspace hooks: start a service that outlives a hook](/guides/setup-workspace-hooks/#start-a-service-that-outlives-a-hook).

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
| `kind`                           | string  | `claude-code`   | Agent adapter identifier. Built-in adapters: `claude-code`, `copilot-cli`, `codex`, `opencode`, `agent-client-protocol` (a generic kind driving any runtime that speaks the [Agent Client Protocol](/reference/adapter-agent-client-protocol/), named by `command`), and `mock`, which simulates a session for local testing and launches no process. |
| `command`                        | string or list of strings | the kind's default command | Command that launches the agent, read for the default kind only: `dispatch.default.agent` when set, otherwise `agent.kind`. It applies to kinds that run a local subprocess (`claude-code`, `copilot-cli`, `codex`, `opencode`, `agent-client-protocol`). Every one of them except `agent-client-protocol` has a default command (`claude`, `copilot`, `codex app-server`, `opencode`), so `command` can be left out; `agent-client-protocol` has none and requires it, and it also carries the flag or subcommand that puts the named binary into protocol mode. A kind that a [`dispatch` rule](#dispatch) selects, and that is not the default kind, never reads this field and launches its own default command. Adapters that do not start a local process ignore this field. Written as a string, the value is split on whitespace into an argument vector on a local launch and run without a shell, so shell syntax is not interpreted and `~` and `$VAR` are not expanded. When [`worker.ssh_hosts`](#worker) sends the agent to a remote host, the string reaches the remote shell unsplit, so shell syntax in it is interpreted there. Sortie waits for the agent it starts and talks to it, so a string ending in `&` detaches the agent and the session cannot work. Written as a list, element zero is the program and each later element is one argument, passed exactly as written: a local launch neither splits nor expands it, and over SSH each element reaches the remote shell as one word. Use the list form when the program path or an argument contains a space. A list must not be empty, and every element must be a non-empty string. [`SORTIE_AGENT_COMMAND`](/reference/environment/#agent-variables) sets the string form and replaces a list written in the file. |
| `max_turns`                      | integer | `20`            | Maximum turns per worker session. The worker re-checks tracker state after each turn. |
| `max_sessions`                   | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying. Must be non-negative. The separate `max_consecutive_absences` governs the consecutive-absence ceiling below. It is no longer derived from this field. Reaching this ceiling also posts one comment on the issue naming the session budget and `agent.max_sessions` as the setting that raises it. |
| `max_tokens`                     | integer | `0` (unlimited) | Cumulative per-issue token ceiling. Sortie sums the `total_tokens` recorded for every completed session of the issue from run history, adds the running session's own reported spend, and stops once the sum reaches a non-zero budget. Three lanes evaluate it: the retry timer and the poll tick's rebuild each block the next dispatch, and Sortie stops the session already running as soon as a usage figure carries the sum to the ceiling. When this cancellation is what ends the session, it is recorded with status `budget_stopped` and increments `sortie_runs_stopped_by_budget_total`. See [how to control agent costs](/guides/control-costs/#cap-tokens-per-issue). Independent of `max_sessions`; the first ceiling reached wins. A run whose agent reported no token usage contributes nothing to the sum; that case and a failed token-sum query both allow the dispatch with a warning instead of blocking it. On the in-flight lane a failed read leaves the run going, unless the running session's own spend has reached the ceiling by itself, which needs no read to establish. Must be non-negative. Reaching this ceiling also posts one comment on the issue naming the token budget and `agent.max_tokens` as the setting that raises it, and counting the sessions stopped in flight when there were any. `token_warning_percent`, below, warns before this ceiling stops a run. |
| `token_warning_percent`          | integer | `0` (off)       | Warning threshold below `max_tokens`, as a percentage of the ceiling. The threshold in tokens is that percentage of `max_tokens`, rounded up to the nearest whole token. Must be `0` to `99`; an out-of-range value is rejected as a configuration error when the configuration loads. Has no effect while `max_tokens` is `0`; [`sortie validate`](/reference/cli/#validate) reports that combination as an `ineffective_setting` warning. Evaluated on the same live per-issue token sum the ceiling reads: once when a run is dispatched and again on each usage figure while it runs. While set above `0`, the `cost_budget` tool's response always carries `warning_tokens` and `warning_reached`; `warning_reached` turns `true` once the sum reaches the threshold, and Sortie also logs one warning for that run at that point, so the agent can wrap up or hand off before `max_tokens` stops the run. A run warns at most once. See [how to control agent costs](/guides/control-costs/#warn-before-the-ceiling-stops-a-run). |
| `max_consecutive_absences`       | integer | `3`             | Bounds how many runs in a row may be observed to have produced no evidence of work before the issue is parked. Any run that produces evidence of work resets the count to zero. The separate `max_sessions` governs the total per-issue session budget; the two ceilings are independent. Unlike `max_sessions` and `max_tokens`, `0` does not mean unlimited here: `0` and negative values are rejected as a configuration error. |
| `max_concurrent_agents`          | integer | `10`            | Global concurrency limit across all issues.                                           |
| `max_concurrent_agents_by_state` | map     | `{}`            | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored; an entry outside the range an integer setting accepts is rejected when the configuration loads instead. |
| `turn_timeout_ms`                | integer | `3600000` (1h)  | Total timeout for a single agent turn. When the deadline passes, Sortie cancels the turn and the attempt fails as `turn_timeout`; a turn that completed or failed on its own keeps its own outcome even if it finished after the deadline. Must be positive; a non-positive value is rejected when the configuration loads. Unlike `stall_timeout_ms` below, this bound cannot be disabled. |
| `read_timeout_ms`                | integer | `5000` (5s)     | Timeout for startup and synchronous operations.                                       |
| `stall_timeout_ms`               | integer | `300000` (5m)   | Inactivity timeout based on event stream gaps. `0` or negative disables stall detection. |
| `stop_grace_ms`                  | integer | `5000` (5s)     | How long an adapter waits for the agent to exit on its own after a graceful termination signal, before it force-terminates the process group. Must be positive and no greater than `9223372036854` (about 292 years); any other value is rejected when the configuration loads. An adapter that launches no process, such as `mock`, has no such period. Stopping one session is allowed this value plus a fixed 15 seconds for the output collection and process reaping that follow it, 20 seconds at the default. The force-terminate step itself waits for the process group to report no member left, resending the termination for up to 2 more seconds when a member needs more than one resend to clear, so a session whose process group is slow to tear down can take up to 2 seconds longer than that total. Raising `stop_grace_ms` raises both that bound and the [shutdown worker-drain ceiling](/reference/cli/#signals) by the same amount. |
| `max_retry_backoff_ms`           | integer | `300000` (5m)   | Maximum delay cap for exponential backoff on retries.                                 |

`max_concurrent_agents`, `max_concurrent_agents_by_state`, `max_retry_backoff_ms`, `max_sessions`, `max_tokens`, `token_warning_percent`, and `max_consecutive_absences` reload dynamically without restart; a reloaded `max_tokens` reaches the sessions already running from the next poll tick onward, and applies at the next retry evaluation. A reloaded `token_warning_percent` reaches the event loop the same way: a run already in flight that has not yet warned is evaluated against the new threshold from its next usage figure, and a run dispatched after the reload starts under it. All other fields apply to future dispatches only, except where the per-field Dynamic reload table at the end of this document states a finer-grained answer.

### Credential verification

Before a worker attempt sends the working session's first turn, it opens a separate, short-lived session with the configured agent kind, asks it to answer one fixed prompt, and closes that session again. This runs on every worker attempt, every agent kind, and every host, including one assigned from [`worker.ssh_hosts`](#worker); there is nothing to configure. Its purpose is to catch a credential the runtime cannot actually use before the agent starts working the issue, rather than partway through a turn.

A runtime that cannot complete that one request fails the worker attempt with error kind `credential_unverified` before any working turn runs. A runtime that exits before it responds fails it with `port_exit` instead, carrying its exit status and the end of its standard error; see the [early exit report](/reference/errors/#early-exit-report). Either failure is retryable with exponential backoff, the same as most agent errors; see the [`credential_unverified` row](/reference/errors/#agent-errors) for what else can surface from this step and what to do about it. A successful check costs one short model request, priced at the configured model's rate like any other request; that spend counts toward the run's own token usage and toward `agent.max_tokens` the same way a working turn's spend does. The extra time to start and stop the short-lived session is wall-clock overhead only; it is not itself token spend. The step reuses the session's own configuration, so it authenticates exactly the way the working session that follows it would.

Every built-in kind cleans up after itself where its runtime allows it: `claude-code` disables session persistence for this one session, so it leaves no file behind; `codex` marks the session ephemeral and read-only; `copilot-cli` and `opencode` delete the conversation they created once the check is done; `agent-client-protocol` deletes it only when the runtime's own handshake advertises a delete method, and otherwise falls back to whatever teardown a working session on that runtime would use, which for a runtime whose handshake advertises neither a close nor a delete method leaves the conversation in the runtime's own store; `mock` creates nothing to clean up. See each kind's own adapter reference for the exact mechanism, and the [Agent Client Protocol kind's session-close section](/reference/adapter-agent-client-protocol/#session-close) for which specific runtimes fall into that last case.

`agent.read_timeout_ms` bounds this step's own network waits the same way it bounds a working session's; the [Agent Client Protocol adapter](/reference/adapter-agent-client-protocol/#agent-section) additionally holds its handshake open for at least 60 seconds regardless of a shorter `read_timeout_ms`, because a runtime that has to establish its credential with its own backend before it answers needs more room than an already-authenticated one does. See that adapter's own `read_timeout_ms` row for the detail.

### Usage reporting by agent kind

Every agent kind Sortie ships declares when a session's token figures reach the orchestrator and what those figures attribute to. The dashboard prints that declaration in the **Usage reporting** field of an expanded [running session](/reference/dashboard/#running-sessions-table), and the [JSON API](/reference/http-api/#get-apiv1state-system-state) carries it as `usage_arrival` and `usage_attribution`. The pair is resolved per session rather than fixed per kind: a kind's own pass-through block and whether the session runs over SSH can put a different pair in force, and the Usage reporting column names every case where they do.

| Agent kind | Usage reporting | How the figure is produced |
|---|---|---|
| `claude-code` | `figures arrive during each turn, per model` | The runtime reports usage on each model API request while the turn is still streaming. See [Claude Code adapter reference](/reference/adapter-claude-code/#token-accounting). |
| `copilot-cli` | `figures arrive when a turn ends, per model` on a local launch, `this session reports no token usage` over SSH | The authoritative figure is the runtime's own session-state journal, read from disk after the turn's subprocess exits, naming whichever model's usage grew the most since the previous record. An SSH launch skips that read. See [Copilot CLI adapter reference](/reference/adapter-copilot/#token-accounting). |
| `codex` | `figures arrive during each turn, per model` | A dedicated token-usage notification carries a run-cumulative snapshot once per model API request. See [Codex adapter reference](/reference/adapter-codex/#token-accounting). |
| `opencode` | `figures arrive when a turn ends, per model` | An export subprocess, run after the turn's subprocess exits, recovers the figure. See [OpenCode CLI adapter reference](/reference/adapter-opencode/#token-accounting). |
| `agent-client-protocol` | `figures arrive when a turn ends, per model` on a local launch, whatever runtime it starts; `this session reports no token usage` over SSH | The declaration depends on the launch mode alone, and no source claiming the launch or being turned away by the handshake changes it. The protocol's own usage notification reports context occupancy rather than a per-turn count, so a figure comes only from a source that reads the runtime's own output outside the wire; Gemini CLI is the one runtime with such a source today. A local session with no confirmed source reports nothing despite its declaration. An SSH launch skips that read. See [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/#token-accounting). |
| `mock` | `figures arrive during each turn, as a session total`, with `, per model` instead when `mock.model_name` is set to a non-empty value, and `this session reports no token usage` when `mock.report_token_usage` is `false` whatever else the block sets | Canned figures from a simulated session. The kind launches no process, and its own block decides what a session reports. |

The following behaviors follow from a session's declared arrival.

`agent.max_tokens` bounds the session in progress for a kind whose figures arrive at all, and bounds nothing for a kind that reports none: Sortie records `token ceiling cannot bound this run` at the dispatch that starts such a session, and `agent.turn_timeout_ms` is the bound that remains for it. A declaration is a promise about the kind, not about the runtime behind it, so a session can be dispatched under a reporting declaration and still end having reported nothing; Sortie records `run reported no token usage, token ceiling could not bound it` when it does. `agent.token_warning_percent` follows the same rule but leaves no record of its own: it never fires for a kind that reports none, and a session dispatched under a reporting declaration that ends having reported nothing never reaches it either, whatever the issue's already-completed sessions add up to. The `cost_budget` tool answers independently of that: `warning_reached` reads `used_tokens`, the sum of every completed session on the issue regardless of kind, so it can already read `true` for such a session while that session's own spend adds nothing to the sum. See [how to control agent costs](/guides/control-costs/#cap-tokens-per-issue) for what the ceiling does when a session reaches it, and the [logging guide](/guides/monitor-with-logs/#token-ceiling-stops-a-run-in-flight) for the records that surround it.

A session's API request count is a count of requests only where figures arrive during each turn, the one arrival that emits a figure per model API request. The dashboard's **API Requests** field and the API's `api_request_count` carry a number for such a session while no turn has begun or once a figure has arrived. They carry no count for one whose first turn has begun with nothing counted, or for any other session.

[`token_rates`](#token_rates) prices a session from the figures it reports, so a kind reporting none has nothing to price and its estimated cost stays blank. [`sortie validate`](/reference/cli/#validate) reports an inert ceiling as an `agent.kind.no_usage_reporting` warning and an unpriceable kind as an `agent.kind.no_cost_estimate` warning, each naming the kind, so neither has to be discovered from a budget that never fires or a blank column.

A `none` declaration is enforced rather than trusted. If a session's runtime sends a usage figure anyway, Sortie discards it: the figure never reaches the dashboard, the JSON API, `agent.max_tokens`, or [`sortie stats`](/reference/cli/#stats), and Sortie logs one warning per run, naming the agent kind, the first time it happens.

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

Routing for the dispatch of each issue. Rules select an agent kind, a prompt template, and that kind's settings from the issue's tracker metadata, evaluated first-match-wins in declaration order. A rule can instead be selected by a stage label on the issue, and a rule can name the rule that a successful run moves the issue to, so rules form a [stage chain](#stage-chains). When the `dispatch` block is absent, every issue dispatches with the top-level `agent.kind`, the WORKFLOW.md body template, and the top-level settings block of that kind. The block is additive and changes no default.

The block accepts three keys:

| Field     | Type | Default     | Description                                                                 |
| --------- | ---- | ----------- | --------------------------------------------------------------------------- |
| `rules`   | list | _(absent)_  | Dispatch rules. A rule with `stage` is selected by its label first; the other rules are evaluated first-match-wins in YAML declaration order. See [Resolution and fallback](#resolution-and-fallback). |
| `max_consecutive_hops` | integer | the larger of `10` and the hops in the longest chain | Per-issue ceiling on consecutive automatic stage hops. Must be greater than `0` and at least the number of hops in the longest chain, which is that chain's rule count minus one. No upper bound. Absent or null takes the default. See [Stage chains](#stage-chains). |
| `default` | map  | _(absent)_  | Fallback selection applied when no rule matches. Keys: `agent`, `template`. It carries no settings block: a key that names an agent kind fails the load, because the top-level block of each kind holds the default settings. |

Each entry in `rules` accepts:

| Field      | Type   | Default      | Description                                                                                                  |
| ---------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `name`     | string | _(absent)_   | Rule identifier recorded in logs, in run history, and in the dispatch rule-match metric. Must match `^[a-z][a-z0-9_-]*$` when set, and must be unique. Required when the rule carries a settings block, `stage`, or `next`, and with a settings block must not be `default`. Unnamed rules report as `<none>`. |
| `stage`    | string | _(absent)_   | Stage label that selects the rule. An issue that carries the label runs on this rule wherever it sits in the list. Compared case-insensitively with the issue's labels, taken literally: no glob characters, no `$VAR` resolution, and surrounding white space is part of the label. A rule with `stage` cannot carry `match` and must have a `name`. See [Stage chains](#stage-chains). |
| `next`     | string | _(absent)_   | `name` of the rule a successful run advances the issue to. The named rule must exist, must not be this rule, and must carry `stage`. The rule that carries `next` must have a `name`, may be any rule, with or without `stage`, and requires `tracker.handoff_state`. See [Stage chains](#stage-chains). |
| `match`    | map    | _(absent)_   | Predicate block. On a rule without `stage`, an absent or empty `match` matches every issue (catch-all).        |
| `agent`    | string | _(fallback)_ | Agent kind for matching issues. Must name a registered adapter. Falls through to `default.agent`, then `agent.kind`. |
| `template` | string | _(fallback)_ | Prompt template path, relative to the WORKFLOW.md directory. Falls through to `default.template`, then the body template. |
| `<kind>`   | map    | _(absent)_   | Settings block for the agent kind the rule runs, written under that kind's name, for example `claude-code:`. Holds the keys the kind's top-level block accepts. See [Rule settings blocks](#rule-settings-blocks). |

A rule must carry at least one of `match`, `stage`, `agent`, `template`, or a settings block; `next` alone does not count. A key in a rule that is not one of these and does not name a registered agent kind fails the load as an unknown key.

A session a rule routes to an agent kind other than the top-level `agent.kind` reads the matching [adapter pass-through block](#adapter-pass-through-configuration) and no other, with the rule's own settings block laid over it. When neither the top-level block nor a rule's block exists for that kind, Sortie refuses to dispatch rather than falling back to the shared `agent` settings: the check fires as [`dispatch.agent.missing_block`](/reference/errors/#startup-and-configuration-errors), which fails `sortie validate` and blocks Sortie from starting; a fault introduced only by a later config reload blocks dispatch on every poll instead, until the block is added. A kind that every one of its selectors reaches through a rule carrying its block needs no top-level block.

The default kind is the kind resolution produces when no rule supplies an agent: `dispatch.default.agent` when set, otherwise `agent.kind`. Only it reads [`agent.command`](#agent).

### Match predicates

The `match` block accepts six keys. A rule matches when every key present in the block matches (AND across keys); within a single key, a list matches when any element matches (OR within a key). Absent keys do not participate.

| Key          | Type           | Matching                                                                          |
| ------------ | -------------- | --------------------------------------------------------------------------------- |
| `labels`     | string or list | Glob (`*`, `?`, `[set]`) against the adapter-normalized lowercase label set.      |
| `issue_type` | string or list | Case-insensitive equality. Globs are not expanded.                                |
| `priority`   | predicate      | Numeric comparison. An issue with no priority value never matches.                |
| `identifier` | string or list | Glob against the issue key or number.                                             |
| `assignee`   | string or list | Case-insensitive equality. An issue with no assignee never matches a non-empty value. |
| `title`      | string or list | Whole-word phrase against the issue title. No wildcards. An issue with an empty title never matches. See [Title phrases](#title-phrases). |

The `priority` predicate carries exactly one operator. Priority is an integer where lower values are more urgent.

| Operator | Match condition                                       |
| -------- | ----------------------------------------------------- |
| `eq`     | Equal to the value.                                   |
| `in`     | A member of the list, for example `{ in: [1, 2] }`.   |
| `lt`     | Less than the value.                                  |
| `lte`    | Less than or equal to the value.                      |
| `gt`     | Greater than the value.                               |
| `gte`    | Greater than or equal to the value.                   |

Tracker support differs. GitHub supplies `labels`, `issue_type`, `assignee`, and `identifier` (the issue number) and carries no priority. Jira supplies all five of those, with `identifier` as the issue key (for example `ACME-123`). Every tracker supplies a title.

A `labels`, `issue_type`, `identifier`, or `assignee` key whose value is null or an empty list is left out of the match. A `title` key in that state fails the load instead.

#### Title phrases

The `title` key takes one phrase or a list of phrases. It matches when any phrase appears in the issue title as whole words.

- **Case and spacing.** Letter case is ignored: every case form of a letter compares equal, so `σ`, `ς`, and `Σ` match each other. A letter that only expands under full case folding stays distinct, so `ß` does not match `ss`. White space at either end of a phrase or a title is ignored, and each run of white space, tabs and no-break spaces included, compares as one space. The invisible emoji variation selectors U+FE0E and U+FE0F are dropped from both sides, so a phrase written without one matches a title that carries one.
- **Whole words.** A word is a run of letters, digits, and combining marks. Every other character, hyphen and underscore included, separates words. A phrase matches only where it neither starts nor ends inside a word: `fix` matches `Fix login redirect` but neither `Add prefix to logs` nor `Fixes typo in docs`.
- **Punctuation in a phrase.** A phrase that starts or ends with a character that is not part of a word, such as `[docs]` or `wip:`, is held to no word boundary on that side. The punctuation must appear in the title: `[infra]` matches `[INFRA] rotate keys` but not `Improve infra docs`, while `infra` matches both.
- **Scripts written without spaces.** Each character of the Han, Hiragana, Katakana, Thai, Lao, Khmer, and Myanmar scripts counts as a word of its own, so `设计` matches inside `缓存设计文档`. A combining mark, such as a Thai vowel or tone mark, stays with the character before it in every script. Hangul is written with spaces and is not in this group: a bare noun such as `버그` does not match its in-title form `버그를`.
- **No wildcards.** A phrase is literal text. `*` and `?` match themselves, unlike in `labels` and `identifier`, and a phrase is never a regular expression. Accents and other combining marks are compared as written: `cafe` does not match `Café opening hours`.

A `title` key must list at least one phrase, and every phrase must contain a character other than white space. A null, bare, or empty-list `title` fails the load, and so does an empty or blank phrase; remove the key to leave the title out of the match. A `title` value or list element that YAML read as something other than text fails the load with a message that names the quoting that fixes it.

YAML reads an unquoted phrase that starts with `[` as a list, one that contains `: ` as a mapping, and a bare number or date as a number or a timestamp. Quote a phrase in these cases:

```yaml
match:
  title: ["[infra]", "fix: typo"]
```

Two unquoted forms escape the load check. `title: [infra]` is the list holding the word `infra`, so it loads and matches the bare word `infra`, not `[infra]`. `title: fix: typo` is not valid YAML, and the load fails with a front matter error.

`title` combines with the other keys under the rules above. In one `match` block it is ANDed with them. Across rules, the first rule in YAML order that matches wins, so an issue titled `[docs] Fix broken link` that also carries the label `bug` runs whichever of a `title` rule and a `labels` rule comes first. A rule whose only key is `title` is not a catch-all.

The title counts when a claim is first dispatched, like a label. Renaming an issue whose claim is held does not re-route it; the [selection is frozen](#freeze-and-reload). Whoever can edit an issue's title can change which rule it matches, and on many trackers that includes the author, who may not be allowed to change its labels. A rule whose settings or template not every author should reach pairs `title` with `labels` or `assignee`.

### Resolution and fallback

A rule is selected in three steps. The first step that yields a rule decides:

1. The target rule of the issue's latest [stage hop](#stage-chains), when the issue carries the stage label that hop added and a rule of that name still exists.
2. The rules that carry `stage`, when the issue carries one of their labels. Of several, the rule furthest along a chain runs: a staged rule that leads, through `next`, to another stage label the issue carries is set aside, and of the rules left the one listed first runs. Without `next` in the workflow, that is the first listed.
3. The rules without `stage`, first match in YAML order, then `dispatch.default`, then the workflow-wide defaults below.

A rule with `stage` never matches an issue that does not carry its label, and an earlier rule, a catch-all included, cannot capture an issue that carries one. An issue with several stage labels draws one `Warn` record, `several stage labels found`, with `stage_labels`, every stage label the issue carries in list order, and `rule_name`, the rule selected. The record is logged on each evaluation of the issue: a poll tick, or a retry that is routed again.

After a hop, the issue waits until the poll listing shows the label the hop added or, when the listing lacks it, until a direct read of the issue finds it still active, and then it is routed by the labels that read returns; the [state machine reference](/reference/state-machine/#candidate-eligibility) describes that wait.

`agent` and `template` resolve independently. Each follows this chain until a value is found:

1. The matched rule's `agent` or `template`.
2. `dispatch.default.agent` or `dispatch.default.template`.
3. The top-level `agent.kind`, and the WORKFLOW.md body template.

A rule's kind is therefore its `agent`, else `dispatch.default.agent`, else `agent.kind`. That is the kind its settings block must be named for.

Resolution runs at the issue's first dispatch. The resolved kind, template, and rule name are frozen for the life of the claim; retries and reaction-driven continuations reuse them. A retry that is waiting when the configuration reloads is the one exception; see [Freeze and reload](#freeze-and-reload).

### Stage chains

A rule that carries `next` names the rule an issue moves to after a successful run. The named rule carries `stage`, so the move, a stage hop, puts that rule's stage label on the issue. A chain is any number of rules linked by `next`; its last rule has no `next` and ends on `tracker.handoff_state` like any rule without chains. A stage is an issue label Sortie adds and removes, never a tracker state.

```yaml
tracker:
  active_states: ["To Do", "In Progress"]
  handoff_state: Human Review

dispatch:
  rules:
    - name: specify
      match:
        labels: ["feature"]
      next: implement
      template: ./prompts/specify.md
    - name: implement
      stage: stage-implement
      template: ./prompts/implement.md
```

A successful `specify` run makes a stage hop in place of the handoff write: Sortie adds `stage-implement`, removes the issue's other stage labels, and writes no tracker state, so the issue stays active and the next poll tick runs `implement` on a new claim and in a new session. A successful `implement` run, which has no `next`, moves the issue to `Human Review`. A hop that cannot be made, because the label add fails or the issue's count reached `dispatch.max_consecutive_hops`, falls back to the handoff write. That count is the number of hops Sortie has made on the issue in a row; it is kept in the database and survives a restart. The [state machine reference](/reference/state-machine/#stage-hop) gives the exact exits that hop, the recorded results, the log records, and every count reset.

For a copyable chain, placing an issue on a stage, and sending it back, see [how to configure dispatch rules](/guides/configure-dispatch-rules/#chain-rules-into-stages). For why chains work this way, see [stage chains](/concepts/stage-chains/).

### Rule settings blocks

A rule may carry one settings block, written under the name of the agent kind the rule runs. The block holds the keys that kind's top-level block accepts, so `model` and `effort` are the usual ones, and every other key the kind reads from its block is overridable the same way, per-invocation limits such as `claude-code.max_turns` included. Sortie does not check `model` or `effort` against a list of names; the runtime judges them, as it does for a top-level block.

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: <default-model-id>

dispatch:
  rules:
    - name: hard
      match:
        labels: ["hard"]
      claude-code:
        model: <strong-model-id>
        effort: high
```

The block an attempt runs with is the top-level block of the rule's kind with the rule's block laid over it, one level deep:

- A key the rule writes replaces the inherited value whole, whatever its type. A map or a list is replaced, never merged or appended: `codex.turn_sandbox_policy`, `opencode.allowed_tools`, and `opencode.denied_tools` are the keys that hold one.
- A key the rule writes as `null` removes the inherited key, so the adapter sees it as never written and applies its own default. For `model` and `effort` that is the runtime's own default.
- Every key the rule does not write is inherited.
- A kind with no top-level block inherits nothing; the rule's block is the whole block.
- The rule's block is laid only over the top-level block of its own kind.

An adapter applies its defaults after the overlay, so no key is defaulted or coerced before it. `$VAR` and `${VAR}` references in a rule's block resolve as they do in a top-level block, and Sortie redacts their values under the same rules; an unset variable draws the `unresolved_extension_var` warning, with the field named `dispatch.rules[<i>].<kind>.<key>`.

A rule's block cannot write `kind`, `command`, `turn_timeout_ms`, `read_timeout_ms`, `stall_timeout_ms`, or `stop_grace_ms`. Sortie derives them from the [`agent`](#agent) section, which stays workflow-wide, so writing one in a rule would read as an override that does not happen. For the same reason a rule cannot override `agent.max_tokens`, `agent.max_sessions`, `agent.max_consecutive_absences`, the concurrency and backoff limits, or `agent.max_turns`: every rule an issue passes through shares them.

A block must be a mapping. An empty block is written `{}`; a bare `claude-code:` key with no value fails the load.

### Validation

Errors fail the load, so `sortie validate` exits non-zero and Sortie does not start. A reload with an error keeps the last good configuration.

- `dispatch` is not a mapping, `dispatch.rules` is not a sequence, or `dispatch.default` is not a mapping; a rule is not a mapping or carries none of `match`, `stage`, `agent`, `template`, or a settings block.
- `dispatch.default` carries a key other than `agent` or `template`, `stage` and `next` included.
- A rule `name` does not match `^[a-z][a-z0-9_-]*$`, or two rules share a `name`.
- A catch-all rule (no `stage` and an absent or empty `match`) precedes a rule without `stage`, reported as `unreachable_rules`. Only rules with `stage` may follow a catch-all.
- A `rule.agent` or `default.agent` names an unregistered adapter kind.
- A `match` key is not one of `labels`, `issue_type`, `priority`, `identifier`, `assignee`, or `title`.
- A `labels` or `identifier` glob is malformed.
- A `priority` predicate carries no operator or more than one.
- A `title` value is null, empty, an empty list, or contains an empty or blank phrase, or a phrase that YAML read as a list, mapping, number, or date. The check is reported under `config.dispatch.rules[<i>].match.title`, with `[<j>]` appended for a list element.
- A rule's settings block names a kind other than the one the rule runs. The message reads `settings block for agent kind "<block>", but this rule runs agent kind "<kind>"`, followed by `, taken from dispatch.default.agent` or `, taken from agent.kind` when the rule has no `agent` of its own. A block left behind after a rule's `agent`, `dispatch.default.agent`, or `agent.kind` changed draws it too.
- A rule's settings block is not a mapping, or writes one of the keys listed above that Sortie derives from `agent`.
- A rule carries a settings block and has no `name`, or is named `default`, the name run history gives the `dispatch.default` selection.
- A referenced template is missing, unreadable, contains front matter, or fails to parse.
- A `stage`, `next`, or `dispatch.max_consecutive_hops` fault from the table below.

Each stage chain error reads `config: <field>: <message>`:

| Field | Message | Cause |
|---|---|---|
| `dispatch.rules[<i>]` | `rule must specify at least one of match, stage, agent, template, or a settings block` | The rule carries none of those keys; `next` alone does not count. |
| `dispatch.rules[<i>].stage` | `expected a label, got <shape>` | The value is not text. `<shape>` is `a number`, `a true/false value`, `a list`, `a map`, or `a value of an unexpected type`. |
| `dispatch.rules[<i>].stage` | `needs a label with a character other than white space` | The value is null, a bare `stage:`, empty, or only white space. |
| `dispatch.rules[<i>]` | `a rule with a stage label is selected by that label and cannot also carry match` | The rule carries `stage` and `match`, an empty `match` included. |
| `dispatch.rules[<i>]` | `a rule that carries a stage label must have a name` | The rule carries `stage` and no `name`. |
| `dispatch.rules[<j>].stage` | `duplicate stage label "<label>" (first at index <i>)` | Two rules carry labels that differ at most in case. |
| `dispatch.rules[<i>].next` | `expected a rule name, got <shape>` | The value is not text, with `<shape>` as for `stage`. |
| `dispatch.rules[<i>].next` | `needs a rule name` | The value is null, a bare `next:`, empty, or only white space. |
| `dispatch.rules[<i>]` | `a rule that carries next must have a name` | The rule carries `next` and no `name`. |
| `dispatch.rules[<i>].next` | `next "<value>" names no dispatch rule` | No rule has that `name`. |
| `dispatch.rules[<i>].next` | `next names the rule that carries it` | The rule names itself. |
| `dispatch.rules[<i>].next` | `next "<value>" names a rule without a stage label; the rule a next names must carry stage` | The named rule has no `stage`. |
| `dispatch.rules[<s>].next` | `next links form a cycle: <a> -> <b> -> <a>` | Following `next` returns to a rule already on the path. `<s>` is the loop's first rule in list order, and the path starts there. |
| `dispatch.max_consecutive_hops` | `invalid integer value: <value>` | The value is not an integer. A whole number outside the platform's integer range reads `value is outside the range an integer setting accepts, <min> to <max>` instead. |
| `dispatch.max_consecutive_hops` | `must be greater than 0` | The value is `0` or negative. |
| `dispatch.max_consecutive_hops` | `must be at least <n>, the number of hops in the longest stage chain (<a> -> <b> -> ...)` | The value is below the hops of the longest chain, which the message names. |
| `dispatch.rules[<i>].next` | `next requires tracker.handoff_state, the state a stage ends on when a hop is not made` | A rule carries `next` and `tracker.handoff_state` is unset. |

Load errors are reported one at a time: the first one stops the run, so two unrelated dispatch errors surface across two runs.

The checks that every top-level block draws also run on each rule's resolved block, the top-level block with the rule's laid over it: key types, the adapter's own configuration checks, the session-resume check, and conflicts that appear only once the layers are combined, such as `opencode.effort` beside a `variant` inherited from the top level. Each message opens with `dispatch rule "<name>" (dispatch.rules[<i>].<kind>): `. They run at startup, on every reload, before every dispatch, and in `sortie validate`. Two advisories concern rules and never block: `agent.effort.inherited`, drawn when a rule writes `model`, does not write `effort`, and inherits a non-empty `effort` from the top-level block, and `agent.effort.not_forwarded`, which also fires for a rule whose kind passes no reasoning level; see [Advisory warning check values](/reference/cli/#advisory-warning-check-values). Level names depend on the model, so write `effort` in the rule to choose the level for its model, or `effort: null` to clear the inherited one.

A `rule.agent` or `default.agent` naming a registered kind that differs from `agent.kind` is checked separately, alongside every other agent block preflight validates: see [`dispatch.agent.missing_block`](#adapter-pass-through-configuration). The same pass reports an `agent.command` error for a rule that routes to a kind with no default command while another kind is the default; [errors](/reference/errors/#startup-and-configuration-errors) gives the message.

The same pass checks every stage label against the states and labels Sortie writes, as [`dispatch.stage.collision`](/reference/errors/#startup-and-configuration-errors). Compared ignoring case, a stage label must not equal an entry of `tracker.active_states` or `tracker.terminal_states` (the tracker adapter's own list when the workflow leaves one empty), `tracker.handoff_state`, `tracker.in_progress_state`, `tracker.no_change_state`, the `escalation_label` of a reaction, or the parking label. Each rule and each collision draws its own error, which names the rule, the label, and the value it collides with. Like `dispatch.agent.missing_block`, it fails `sortie validate` and blocks Sortie from starting, and a collision introduced by a reload blocks dispatch on every poll until it is fixed. One advisory concerns chains and never blocks: `dispatch.next.max_sessions`, drawn when `agent.max_sessions` is above `0` and below the number of runs the longest chain needs; see [Advisory warning check values](/reference/cli/#advisory-warning-check-values).

> [!NOTE]
> Environment variable overrides for `dispatch` fields are not supported. Rule definitions, template paths, and rule settings blocks must come from WORKFLOW.md.

### Template paths

Per-rule `template` paths resolve relative to the directory containing WORKFLOW.md. Per-rule template files are plain `text/template` bodies and carry no YAML front matter. They use the same variables and functions as the body template; see [Prompt template](#prompt-template). The following are rejected at load time:

- Absolute paths and `~`-prefixed paths.
- Paths that resolve outside the WORKFLOW.md directory tree, including through symlinks or `..` traversal.
- Files that begin with `---`, since front matter is not permitted in per-rule templates.

### Freeze and reload

An issue keeps its agent kind, template, and rule until its claim is released. What the selection contains is read from WORKFLOW.md at the start of every attempt: the first dispatch, each retry, and each reaction continuation. That covers the settings block (the rule's block laid over the top-level block of the kind, as in [Rule settings blocks](#rule-settings-blocks)), the template text, and the `agent.*` timeouts. A change to a settings block, in a rule or at the top level, therefore applies from the next attempt without a restart, including for a claim that is already held. A running session never changes settings.

A retry or continuation that resumes a session keeps the session identifier across a change of `model` or `effort` and sends the settings it resolved. A change of settings does not end the session by itself.

An attempt whose resolved block fails an error-severity check starts no session. The first dispatch skips the issue for that poll and leaves it unclaimed; a retry or continuation is rescheduled with backoff and keeps its claim.

When a rule whose block an earlier attempt used no longer exists, or no longer carries a block for the claim's kind, the attempt runs on the top-level block of that kind and Sortie logs one `Info` record naming the rule.

The rule set reloads with WORKFLOW.md changes and applies to future claims only. An in-flight issue keeps the kind, template, and rule frozen at its first dispatch until its claim is released, and moving a label on, or renaming, an issue whose claim is held does not re-route it. That includes adding or removing a stage label.

`next`, its target's `stage`, and `dispatch.max_consecutive_hops` are read from the configuration in force when the worker exits, not frozen at dispatch. A reload that adds `next` to the rule an issue is running on makes its successful exit hop; one that removes that `next`, removes the rule it names, or removes the named rule's `stage` makes the exit take the handoff write. A hop releases the claim, so the next stage always starts on a new claim and a selection resolved against the configuration in force then. The [`.stage`](#stage) data is part of the selection: a retry or reaction continuation that keeps its rule renders the same `.stage.previous` and `.stage.previous_outcome`, also after a restart, while `.stage.current` is read at each dispatch. A retry that is routed again uses the same three selection steps as a poll tick, stage labels included.

A waiting retry keeps its recorded selection too, as long as the configuration still reaches its agent kind and still holds its template, whether or not the rule still matches the issue. When either is gone, for example after `agent.kind` moved to another kind or a rule's template file was renamed, the retry is routed again by the current rules when its timer fires and starts a new session instead of resuming the earlier one. Sortie logs one `Info` record, `retry dispatching on the selection the configuration in force gives it`, when a retry dispatches on a different selection. A retry whose agent kind has no adapter, because that adapter failed to start with Sortie, is rescheduled with backoff and keeps its claim until Sortie restarts. Per-rule template files are read at WORKFLOW.md load and on every reload; a standalone edit to a per-rule template file applies on the next WORKFLOW.md change or the next dispatch, whichever comes first.

A reload that moves `agent.kind` or `dispatch.default.agent` while a rule without its own `agent` carries a block for the old kind is rejected as a validation error, because the rule would run another kind than its block names. Sortie keeps the last good configuration. Fix the block or give the rule an `agent`, and the next reload applies.

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

For setup procedures, a worked model-routing example, title recipes, and verification, see [how to configure dispatch rules](/guides/configure-dispatch-rules/).

---

## `self_review`

Self-review configuration. When enabled, Sortie runs an orchestrator-controlled review loop between the coding turn loop and worker exit. The orchestrator generates a workspace diff, runs verification commands, and feeds structured results to the agent for bounded iteration. Self-review is opt-in and adds zero overhead when disabled.

| Field                      | Type            | Default    | Description                                                                                                |
| -------------------------- | --------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`                  | boolean         | `false`    | Activates the self-review loop. When false or absent, no review phase runs.                                |
| `max_iterations`           | integer         | `3`        | Hard cap on review iterations. Range: 1–10. Each iteration includes a review turn and (if verdict is “iterate”) a fix turn. |
| `verification_commands`    | list of strings | _(none)_   | Shell commands to run during each review iteration. Required and non-empty when `enabled: true`.           |
| `verification_timeout_ms`  | integer         | `120000`   | Per-command timeout in milliseconds.                |
| `max_diff_bytes`           | integer         | `102400`   | Maximum bytes of diff included in the review prompt. Larger diffs are truncated with a note.                |
| `reviewer`                 | string          | `"same"`   | Which agent runs the review turns. `"same"` (reuse existing session) is the only supported value.               |

`enabled: true` with empty or absent `verification_commands` produces a configuration error. `max_iterations` outside [1, 10] produces a configuration error. `reviewer` values other than `"same"` produce a configuration error. All integer fields accept quoted string integers (e.g., `"3"`) following the same coercion rules as other integer config fields.

> [!NOTE]
> Environment variable overrides for `self_review` fields are not supported. Verification commands are security-sensitive privileged configuration that must come from the version-controlled WORKFLOW.md. All `self_review` values must be set in WORKFLOW.md.

### Turn accounting

Each iteration runs one review turn. Non-final iterations that produce an “iterate” verdict also run a fix turn. `max_iterations: N` means up to `2N − 1` additional agent turns in the worst case (N review turns + N−1 fix turns). For the default `max_iterations: 3`, this is up to **5 additional agent turns**. Factor this into token budget and wall-clock time expectations.

### Verification command process lifetime

Each verification command's process group (its Job Object on Windows) is torn down the same way a hook's is: see [hook process lifetime](#hook-process-lifetime) for the resend, the 2-second bound, and the Windows fallback when a Job Object could not be created or assigned. Two things differ here: the command's own exit status, not its timeout or its output, decides whether it passed, and the INFO and WARN records this produces carry `command` in place of `hook` and `workspace`.

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
  reviewer: "same"                   # only supported value is "same"
```

For operational guidance on setting up self-review, choosing verification commands, and verifying the loop, see [how to configure self-review](/guides/configure-self-review/).

---

## `reactions`

The `reactions` block configures post-PR feedback loops. Each key is a reaction kind (e.g. `review_comments`) with its own provider, retry budget, and escalation policy, and four of the kinds also accept an optional [`triage` command](/reference/reactions/#triage-command) that runs before a continuation is dispatched. Reactions are opt-in: omit the block entirely to disable all reaction types. The `label_commands` key is configured in the same block but is human-triggered rather than event-driven, and it carries no retry budget or escalation.

For the shared reaction lifecycle and every kind Sortie ships, with field tables and safety rules, see the [reactions reference](/reference/reactions/).

### `reactions.review_comments`

Polls `CHANGES_REQUESTED` review comments on Sortie-created PRs and dispatches continuation turns so the agent can address reviewer feedback. Requires `provider` to be set. Only human reviewer comments are processed; bot and automated comments are filtered by author type.

| Field                    | Type    | Default        | Description                                                                                          |
| ------------------------ | ------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `provider`               | string  | _(required)_   | SCM adapter kind (e.g. `"github"`). Must match a registered SCM adapter.                           |
| `escalation`             | string  | `"label"`     | Action on budget exhaustion, and on a [`triage` command](/reference/reactions/#triage-command) answering `escalate`: `"label"`, `"none"`, or the deprecated `"comment"`. See [escalation actions](/reference/reactions/#escalation-actions). |
| `escalation_label`       | string  | `"needs-human"` | Label applied when `escalation` is `"label"`.                                                    |
| `poll_interval_ms`       | integer | `120000`       | Minimum interval between review API polls per issue. Minimum: `30000`.                               |
| `debounce_ms`            | integer | `60000`        | Wait time after last detected comment before dispatch. Non-negative.                                 |
| `max_continuation_turns` | integer | `3`            | Hard cap on review-triggered continuations per PR before escalation. Positive integer.               |
| `watch_window_ms`        | integer | `1800000`      | Milliseconds a pending entry is kept, measured from the entry's creation. Non-negative, not above `9223372036854` (about 292 years); `0` removes the bound.  |

`provider` is required when `reactions.review_comments` is present; omitting it does not produce an error, but review polling is inactive without a provider. This kind also accepts the common `max_retries` field and validates it like every other kind, but does not consume it: its escalation budget is `max_continuation_turns` instead, so a `max_retries` value set here has no effect. `escalation` must be `"label"`, `"none"`, or the deprecated `"comment"`; other values produce a configuration error. `poll_interval_ms` has a minimum of `30000`; values below are rejected. `max_continuation_turns` must be positive. `watch_window_ms` must be non-negative and must not exceed `9223372036854`. When more than one SCM reaction kind is active, every active kind must name the same `provider`; a mismatch is a fatal startup error.

Review feedback requires `.sortie/scm.json` in the workspace to contain `pr_number` (integer > 0), `owner`, and `repo` fields. The agent or `after_run` hook writes these. When any field is missing or zero, review polling is skipped for that workspace. No error is logged; the feature degrades silently.

> [!NOTE]
> Environment variable overrides for `reactions` fields are not supported. Reaction configuration must come from WORKFLOW.md.

`reactions.review_comments` is captured once when the orchestrator starts and is not rebuilt on a dynamic reload. Changing any field here, and adding or removing the block itself, takes effect only on the next restart. This holds for every reaction kind except `ci_failure`, which is folded into the CI feedback configuration and re-read on every tick, apart from its `max_log_lines` and its `triage` block.

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
    escalation: label                   # "label", "none", or deprecated "comment"
    escalation_label: needs-human       # label applied on escalation
    poll_interval_ms: 120000            # 2 min between API polls
    debounce_ms: 60000                  # 60s debounce after last comment
    max_continuation_turns: 3           # hard cap per PR; the escalation budget for this kind
    watch_window_ms: 1800000            # optional; shown at its default (30 min)
```

When a review-fix continuation dispatches, the prompt receives a `review_comments` template variable: a list of maps with keys `id`, `file`, `start_line`, `end_line`, `reviewer`, `body`. Templates should guard with `{{ if .review_comments }}`. The variable is also set on the first turn of a new run of an issue that already has a pull request, when the pull request holds comments no earlier run was given; see [comments already given](/reference/reactions/#comments-already-given). See the [`.review_comments`](#review_comments) template variable reference below for the full schema, and [how to write a prompt template](/guides/write-prompt-template/) for syntax.

For operational guidance on setting up review feedback, see [how to configure PR review feedback](/guides/configure-review-feedback/).

### `reactions.merge_completion`

Observes the merge state of Sortie-managed PRs and transitions the linked tracker issue to one configured terminal state once the PR merges, whoever performed the merge. This is the only reaction kind whose action is a tracker write; it performs no SCM write and dispatches no continuation turn. It is off by default, and a deployment that omits the block is unaffected. The runtime kind value is `merge-completion`.

| Field              | Type    | Default         | Description                                                                                          |
| ------------------ | ------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `provider`         | string  | _(required)_    | SCM adapter kind (e.g. `"github"`). Activates the kind, and must match the provider of every other active SCM reaction. |
| `target_state`     | string  | _(required)_    | The terminal state the linked issue moves to. No default; never inferred from `tracker.terminal_states`. |
| `poll_interval_ms` | integer | `60000`         | Minimum interval between merge-state polls per issue. Minimum: `30000`.                              |
| `max_retries`      | integer | `2`             | Retryable transition attempts before escalation. `0` escalates on the first failed attempt.          |
| `escalation`       | string  | `"label"`       | Action on escalation: `"label"`, `"none"`, or the deprecated `"comment"`. See [escalation actions](/reference/reactions/#escalation-actions). |
| `escalation_label` | string  | `"needs-human"` | Label applied when `escalation` is `"label"`.                                                    |

Two `tracker` fields are required whenever `provider` is set, each reported as its own configuration error when absent: `tracker.handoff_state` must be non-empty, and `tracker.terminal_states` must be written out in front matter rather than left to the adapter's default list. `target_state` is required, and compared case-insensitively it must not equal `tracker.handoff_state`, must not be a member of `tracker.active_states` (falling back to the adapter's default active list only when that list is empty), and must be a member of `tracker.terminal_states` as written. `poll_interval_ms` below `30000` is rejected, not clamped. `sortie validate` reports all of these offline, before a run.

Every field here, `target_state` included, is captured once when the orchestrator starts, as the other reaction kinds are; changing any of them, or either tracker prerequisite, requires a restart. Review feedback's `.sortie/scm.json` requirements apply with one exception: this kind reads `pr_number`, `owner`, and `repo`, and needs no `branch`, because it performs no checkout.

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
    escalation: label                   # "label", "none", or deprecated "comment"
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
| `poll_interval_ms` | integer | `60000`           | Minimum interval between label-journal polls per PR. Minimum `30000`; lower values are clamped up to the floor rather than rejected, recorded as a `reactions.label_commands.poll_interval_ms.clamped` [advisory warning](/reference/cli/#advisory-warnings). |

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

The destinations for Sortie's outbound messages. Each entry is one destination, and its `events` list names the event types it receives. Two producers feed the list: the agent, through the `notify_operator` tool (event `agent.message`), and Sortie itself, which produces every other event in the [catalog](#event-catalog). Routing depends only on the configuration and the event type. The agent never chooses a destination, and an event reaches only the entries that list it.

The value is a sequence: a second channel is a second entry. The `notify_operator` tool is registered only when at least one entry receives `agent.message`; otherwise the agent is never offered it. The tool contract (input schema, response shapes, error kinds) lives in the [agent extensions reference](/reference/agent-extensions/#notify_operator). To choose events for a deployment, see [how to route Sortie's events to the issue, Slack, or a webhook](/guides/route-notifications/).

Each entry accepts three typed fields:

| Field             | Type            | Default      | Description |
| ----------------- | --------------- | ------------ | ----------- |
| `kind`            | string          | _(required)_ | Destination discriminator. Built-in values: `webhook`, `slack`, and the reserved `tracker_comment`. |
| `events`          | list of strings | `[agent.message]` for `webhook` and `slack`; _(required)_ for `tracker_comment` | The event types the entry receives. Each name must come from the [catalog](#event-catalog), none may repeat, and there is no wildcard. A `webhook` or `slack` entry that omits the key receives `agent.message` only, which is deprecated. A `tracker_comment` entry must write the key; `[]` means only the comments that deprecated settings enable. |
| `max_per_session` | integer         | `20`         | Cap on the agent's own `notify_operator` calls for the whole agent run. `0` selects the default (`20`); it never means unlimited. Must be non-negative. It has no effect on an entry that does not receive `agent.message`, and a `tracker_comment` entry rejects it. |

Every other key in a `webhook` or `slack` entry has `$VAR` and `${VAR}` references resolved on string values, the same mechanism as [adapter pass-through configuration](#adapter-pass-through-configuration). Per-backend fields:

| `kind`    | Field         | Description                                                               |
| --------- | ------------- | -------------------------------------------------------------------------- |
| `webhook` | `url`         | Endpoint that receives an HTTP POST of the notification as a JSON object. |
| `slack`   | `webhook_url` | Slack incoming webhook URL that receives a Slack-shaped JSON body.        |
| `tracker_comment` | _(none)_ | Takes only `kind` and `events`. Any other key is rejected. |

The URL is the only setting a `webhook` or `slack` backend has. There is no key for headers, authentication, a Slack channel, or a timeout, and every send is a JSON POST with a fixed 10-second timeout. A key a backend does not read is ignored without an error, and `sortie validate` reports no warning for it, so a misspelled or unsupported key has no effect. A credential for the endpoint has to be part of the URL: a user and password written into it, such as `https://user:password@host/path`, are sent as HTTP Basic authentication. Sortie registers every endpoint URL as a secret and masks it in logs; see [secrets and credential handling](/concepts/security/#secrets-and-credential-handling).

When more than one entry receives `agent.message` and sets `max_per_session`, the effective cap is the maximum non-zero value across those entries, falling back to `20` when every one is `0` or unset. The cap applies to the whole agent run: every turn and every tool server process the run spawns share one count. A retry or a continuation of a resumed session starts a new run and a new count. Events Sortie produces never count against the cap, and an agent that has used its cap never suppresses one. See the [agent extensions reference](/reference/agent-extensions/#notify_operator) for how calls are counted and what happens when the count cannot be established.

> [!WARNING]
> Backend secrets must be references to `SORTIE_`-prefixed environment variables (`$SORTIE_NAME` or `${SORTIE_NAME}`). The prefix is required for an entry that receives `agent.message`: the `notify_operator` tool runs in a separate `sortie mcp-server` process that receives only `SORTIE_`-prefixed variables, and a reference without the prefix, or to an unset variable, resolves to the empty string there and surfaces as a fatal sidecar startup error at session start rather than a notification posted nowhere. An entry that receives only events Sortie produces is built in the main process alone, where the prefix is not required. Use the prefix on every notification secret anyway, so adding `agent.message` to the entry later does not break it.

`sortie validate` checks the section's shape: a sequence of maps, a non-empty `kind`, a non-negative `max_per_session`, and the `events` and `tracker_comment` rules below. For an entry that receives an event Sortie produces, it also builds the destination, which catches an unknown `kind` and a required secret that resolved to the empty string. It cannot do either for an entry that receives only `agent.message`, because the main process never builds that entry.

> [!NOTE]
> Environment variable overrides for `notifications` fields are not supported. Backend configuration must come from WORKFLOW.md; environment values reach a backend only through `$VAR` references inside its entry.

The `webhook` backend is an outbound POST to an operator-supplied endpoint. Sortie has no inbound webhook receiver of its own (it discovers tracker state only by polling), so this is the only kind of webhook Sortie has.

```yaml
notifications:
  - kind: tracker_comment
    events: [session.completed, session.stopped, session.failed]
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    events: [agent.message, session.stopped, session.failed]
    max_per_session: 20
  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL
    events: [session.started, session.completed, session.stopped, session.failed]
```

### Event catalog

The catalog is closed. Validation accepts exactly these names and rejects any other.

| Event type | Sent when | Severity |
| ---------- | --------- | -------- |
| `session.started` | A session is dispatched on an issue whose dispatch drives issue state, after the in-progress transition and before the workspace is prepared. | `info` |
| `session.completed` | A worker exits normally. | `info` |
| `session.stopped` | A worker exits on a status signal: `blocked`, `needs-human-review`, or `no-change-needed`. Carries the agent's [stop statement](/reference/agent-extensions/#stop-statement) when it wrote one. | `warning`; `info` for `no-change-needed` |
| `session.failed` | A worker exits with an error, or exits normally but the [handoff-evidence policy](/reference/state-machine/#handoff-evidence) withheld the handoff. | `warning` |
| `escalation.ci_failure`, `escalation.review_comments`, `escalation.bot_review`, `escalation.merge_conflicts`, `escalation.auto_merge`, `escalation.merge_completion` | The matching [reaction](/reference/reactions/#escalation-actions) hands its subject to a person, under any `escalation` value. | `warning` |
| `auto_merge.merged` | The auto-merge reaction merges a pull request. | `info` |
| `budget.held` | An issue is held out of dispatch by `agent.max_sessions` or `agent.max_tokens`. | `warning` |
| `stage.advanced` | A [stage hop](#stage-chains) is made, including one that left an old stage label on the issue. | `info` |
| `stage.not_advanced` | A stage hop is due and not made. The reason is `failed` when the label add failed, or `ceiling` when the issue reached `dispatch.max_consecutive_hops`. | `warning` |
| `agent.message` | The agent calls `notify_operator`. | Set by the agent. |

A run Sortie cancels (stall timeout, reconciliation, shutdown) produces no session event. A stage event follows the exit that reached the hop decision, in addition to that exit's session event, and a destination receives it only when its `events` list names it.

### The `tracker_comment` destination

A `tracker_comment` entry posts each event it receives as a comment on the event's issue. The comment text for the session events is:

| Event | Comment text |
|---|---|
| `session.started` | The single line `Sortie session started.` |
| `session.completed` | `Sortie session completed.`, then the duration and the turns completed. The headline gains a `(re-queuing)` suffix when a continuation retry is scheduled. |
| `session.stopped` | `Sortie session completed (agent signaled: <value>).`, then the duration and the turns completed, then the agent's stop statement in a literal block when it wrote one. |
| `session.failed` | `Sortie session failed.`, then the duration and the retry status: `Retry: yes (attempt N)` with the next attempt number, or `Retry: no (not retryable)`. |

A stage event comments with a headline, then one line each for the source rule, the target rule, the reason when the hop was not made, the hop count, and the chain identifier:

```text
Sortie did not advance the issue to the next stage.
From: specify
To: implement
Reason: the issue reached its limit of consecutive stage moves (dispatch.max_consecutive_hops)
Hop count: 10
Chain: <chain id>
```

The `stage.advanced` headline is `Sortie advanced the issue to the next stage.` and carries no `Reason` line. For reason `failed` the line reads `Reason: the next stage's label could not be added to the issue`. The chain identifier is a random value that ties together the runs of one pass through a chain.

No comment carries the agent session ID, the agent kind, or the error text. The cause of a failure is in the log, the run history, and the dashboard. The stop statement is the one piece of agent-written text a comment can carry. Sortie masks the secrets it knows in the statement, and the tracker shows it as literal text, so no slash command, mention, or markup in it takes effect. Slack and webhook destinations receive the full notification, including session and dispatch identity.

Comment failures are non-fatal. A failed comment logs WARN and never blocks dispatch, completion, retry, or handoff.

The destination follows these rules:

- At most one entry has this kind, and it requires a configured `tracker.kind`.
- It requires `events`, and `agent.message` is rejected there: messages from the agent never reach the issue.
- It receives the union of three sets: the events its entry lists, the events that the deprecated [`tracker.comments`](#tracker-comments) flags and `escalation: comment` enable, and, while no `tracker_comment` entry exists, `auto_merge.merged` and `budget.held`. Writing the new form never withdraws a comment an old setting enabled. One event is delivered at most once to a destination however many of these select it, so keeping `tracker.comments.on_completion: true` and also listing `session.completed` on the entry gives one comment per completion, not two.

**An explicit entry is authoritative for two comments.** The auto-merge success comment and the budget-hold comment have no setting of their own: they post whenever a tracker is configured. They keep posting only while no `tracker_comment` entry exists. Once you write an entry, it posts `auto_merge.merged` and `budget.held` only when it lists them, so an entry that omits them stops those comments. With no `tracker.kind` there is no issue to comment on and nothing posts.

### What Slack and webhook receive

For an event Sortie produces, the `title` is `<issue key>: <event type>`, the `severity` is the catalog severity, and the `body` is the same text the tracker comment carries.

The `slack` backend posts a Slack incoming-webhook body whose `text` field is the severity in uppercase and the title on one line, then the body. A stop statement follows after a blank line, with `&`, `<`, and `>` escaped so it cannot form a mention, a channel-wide ping, or a link:

```json
{"text": "[WARNING] PROJ-42: session.stopped\nSortie session completed (agent signaled: blocked).\nDuration: 12m4s\nTurns: 7\n\nThe ticket asks for both soft and hard delete of invoices.\nWhich one should the API expose?"}
```

The `webhook` backend posts the same JSON object it posts for an `agent.message`, plus two keys that appear only on an event Sortie produces: `event_type`, the catalog name, and `agent_text`, the stop statement, present only when the event carries one. An `agent.message` payload carries neither key, so an endpoint configured before these keys existed receives the same JSON as before.

```json
{
  "notification_id": "3f8a2c1d-9b4e-4f6a-8c2d-1e7b5a9d0c3f",
  "timestamp": "2026-10-01T14:03:05Z",
  "source": "build-host-01",
  "issue_id": "abc123",
  "identifier": "PROJ-42",
  "dispatch_id": "C5SHAUWY3XNYELVKFV46X6B2UP",
  "session_id": "session-abc-001",
  "attempt": 2,
  "agent": "claude-code",
  "severity": "warning",
  "title": "PROJ-42: session.stopped",
  "body": "Sortie session completed (agent signaled: blocked).\nDuration: 12m4s\nTurns: 7",
  "event_type": "session.stopped",
  "agent_text": "The ticket asks for both soft and hard delete of invoices.\nWhich one should the API expose?"
}
```

A stage event carries the identity of the run whose exit reached the hop decision, and adds a `stage` object that no other payload carries:

| Key | Type | Value |
|---|---|---|
| `stage.source_rule` | string | The rule whose run reached the decision. |
| `stage.target_rule` | string | The rule `next` names. |
| `stage.chain_id` | string | The chain identifier. |
| `stage.hop_count` | integer | The issue's consecutive hop count once the decision applies: the new count after a hop, the unchanged count otherwise. |
| `stage.reason` | string | `failed` or `ceiling` on `stage.not_advanced`. Absent on `stage.advanced`. |

A stage event carries no `agent_text`. The `slack` backend has no `stage` field: its `text` holds the comment body above.

Events from reactions and the budget hold have no run behind them, so their `dispatch_id`, `session_id`, and `agent` are empty strings and `attempt` is `null`. The [agent extensions reference](/reference/agent-extensions/#what-each-backend-delivers) describes every other field.

### Delivery

Sortie sends an event it produces to every destination that lists it, all at once. A failure to deliver to one destination is logged at WARN as `notification delivery failed` with the `event_type`, `destination`, and `notifier_kind`, and never stops the others. Sortie does not retry a failed send. A slow Slack or webhook endpoint never delays the agent's start or the comment on the issue.

A reload whose destinations for events Sortie produces cannot be built, such as an unknown `kind` or a required secret that resolved to an empty string, is rejected. The previous configuration stays in force and the error is reported as for any other invalid reload.

### Deprecated forms

Every form below keeps working. Each one the configuration relies on draws one warning that names its replacement, once per configuration change and never per event. [`sortie validate`](/reference/cli/#advisory-warnings) and the dry run show the same warnings without changing the verdict or the exit code. Sortie sets no removal date.

| Deprecated form | Replacement |
| --------------- | ----------- |
| `tracker.comments.on_dispatch: true`, or `SORTIE_TRACKER_COMMENTS_ON_DISPATCH` | List `session.started` in a `tracker_comment` entry, then remove the key. |
| `tracker.comments.on_completion: true`, or `SORTIE_TRACKER_COMMENTS_ON_COMPLETION` | List `session.completed` and `session.stopped`, then remove the key. |
| `tracker.comments.on_failure: true`, or `SORTIE_TRACKER_COMMENTS_ON_FAILURE` | List `session.failed`, then remove the key. |
| `reactions.<kind>.escalation: comment` on an active reaction | Set `escalation: none` and list `escalation.<kind>` in a `tracker_comment` entry. |
| The auto-merge success comment, with the auto-merge reaction active, a tracker configured, and no `tracker_comment` entry | Add an entry that lists `auto_merge.merged`. |
| The budget-hold comment, with `agent.max_sessions` or `agent.max_tokens` above `0`, a tracker configured, and no `tracker_comment` entry | Add an entry that lists `budget.held`. |
| A `webhook` or `slack` entry without `events` | Add `events: [agent.message]`. |

A configuration in the old form:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme/billing-api
  comments:
    on_completion: true
    on_failure: true

reactions:
  ci_failure:
    provider: github
    escalation: comment

notifications:
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
```

The same comments and messages in the new form. The auto-merge and budget-hold comments are listed because an explicit entry ends their implicit delivery. Neither feature is configured here, so they post nothing until it is:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme/billing-api

reactions:
  ci_failure:
    provider: github
    escalation: none

notifications:
  - kind: tracker_comment
    events: [session.completed, session.stopped, session.failed, escalation.ci_failure, auto_merge.merged, budget.held]
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    events: [agent.message]
```

Changes to this section apply as described in [dynamic reload](#dynamic-reload-1).

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

Each adapter reads additional settings from a top-level block named after its `kind` value. The orchestrator forwards these blocks to the adapter as written, with two exceptions, both checked before any run starts. Either draws an error or a warning at startup, on every workflow reload, and from [`sortie validate`](/reference/cli/#validate). Each adapter reference page lists its own checks.

The first exception is a value that changes the permission posture an unattended launch depends on. Every agent runs unattended, so nobody is there to answer a prompt. A value that would leave the agent waiting for one is refused as an error: `codex.approval_policy` and `claude-code.permission_mode`. A value that only narrows what the agent may do, without leaving a turn waiting, draws a warning instead: `copilot-cli.allowed_tools` and `opencode.dangerously_skip_permissions`.

The second exception is a value that stops the agent kind resuming a session across separate agent launches. Sortie re-dispatches an issue carrying its earlier session after a retry, a continuation, a stall, or a restart, so such a value makes every resumed turn fail. `claude-code.session_persistence` set to `false` is the only key any built-in adapter declares this way; the refusal is an `agent.kind.session_resume` error and carries no condition on `agent.max_turns` or on any other core setting.

A session that a [`dispatch` rule](#dispatch) routed to an agent kind other than the workflow default uses that kind's own block. The block named by `agent.kind` applies only to sessions no rule routed elsewhere. A rule can also carry its own settings block for the kind it runs, which Sortie lays over the kind's top-level block for the issues that rule selects; see [Rule settings blocks](#rule-settings-blocks).

Sortie resolves a kind's block, with the selected rule's block laid over it, at the start of every attempt: the first dispatch, each retry, and each reaction continuation. A change to a block therefore takes effect from the next attempt without a restart, and a running session keeps the settings it started with. See [Freeze and reload](#freeze-and-reload).

**Reasoning effort.** `effort` is an optional string key with one meaning in the block of every agent kind that reads it. An absent key, a YAML null, and an empty string leave the level unset, and the agent runs at its own default level. Any other string is the level, delivered exactly as written: Sortie does not trim it, change its case, or check it against a list of names, because the names a runtime accepts depend on its version and on the model. A set level reaches every turn of every session, credential verification included. A [dispatch rule's settings block](#rule-settings-blocks) can set or clear it for the issues the rule selects. A non-string value fails construction and, offline, is reported by [`sortie validate`](/reference/cli/#validate) under the check `<kind>.effort.wrong_type`.

The `claude-code`, `codex`, `copilot-cli`, and `opencode` kinds forward the level. The `agent-client-protocol` and `mock` kinds pass none: a workflow that reaches either with `effort` set in its block draws the `agent.effort.not_forwarded` warning from `sortie validate` and in the run log. For `agent-client-protocol`, write the runtime's own reasoning option in [`agent.command`](#agent) instead. Each kind's adapter reference states the flag or field the level rides on.

A kind that `dispatch.default.agent` or a `dispatch.rules[i].agent` names, and that differs from the top-level `agent.kind`, must carry its own top-level block in the front matter, unless every selector of that kind is a rule that carries the kind's block in its own settings block. An empty top-level block is enough, written as `codex: {}` or as a bare `codex:` key with nothing after it. A block present as a scalar or a list does not count. Its absence is a `dispatch.agent.missing_block` error at startup, on every workflow reload, and from `sortie validate`, naming the selector that introduced the kind and the block it expects; the workflow does not start until the block is added. The check is skipped for a kind Sortie does not recognize as a registered adapter, since that is already reported separately as an unknown adapter kind. Adding the block does not give the route a command: a routed kind's own block cannot override [`agent.command`](#agent).

### `claude-code`

| Field | Type | Default | CLI flag | Description |
|---|---|---|---|---|
| `permission_mode` | string | _(absent)_ | `--permission-mode` | Claude Code permission mode. `bypassPermissions` is the only value Sortie accepts; any other value is refused before the run. When absent, the adapter passes `--dangerously-skip-permissions` instead. See [validate-time checks](/reference/adapter-claude-code/#validate-time-checks). |
| `model` | string | _(CLI default)_ | `--model` | Model for agent sessions. Accepts an alias such as `sonnet`, or a full model name. |
| `fallback_model` | string | _(none)_ | `--fallback-model` | Model to switch to when the primary is overloaded, unavailable, or returns another non-retryable server error. Accepts a comma-separated chain, capped at three models. Authentication, billing, rate-limit, request-size, and transport errors never trigger a switch, and the switch lasts one turn only. See [Fallback model scope](/reference/adapter-claude-code/#fallback-model-scope). |
| `max_turns` | integer | _(CLI default)_ | `--max-turns` | Claude Code's internal agentic turn budget per invocation. |
| `max_budget_usd` | number | _(none)_ | `--max-budget-usd` | Per-invocation cost cap. Resets each turn. |
| `effort` | string | _(CLI default)_ | `--effort` | Inference effort level; see [reasoning effort](#adapter-pass-through-configuration). Which levels the CLI accepts depends on the model and is Claude Code's to document. A set value outranks `CLAUDE_CODE_EFFORT_LEVEL`. See the [Claude Code adapter reference](/reference/adapter-claude-code/#reasoning-effort). |
| `allowed_tools` | string | _(none)_ | `--allowedTools` | Comma- or space-separated list of tools that run without a permission prompt, including scoped rules such as `Bash(git diff *)`. |
| `disallowed_tools` | string | _(none)_ | `--disallowedTools` | Comma- or space-separated list of tools to deny. A bare tool name removes the tool from the model's context; a scoped rule denies only matching calls. |
| `system_prompt` | string | _(none)_ | `--append-system-prompt` | Text appended to Claude Code's default system prompt rather than replacing it. |
| `mcp_config` | string | _(none)_ | `--mcp-config` | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Sortie reads that file and passes a generated copy carrying its own `sortie-tools` server, leaving the original unmodified; a file already declaring `sortie-tools` fails the attempt. |
| `session_persistence` | boolean | `true` | `--no-session-persistence` | Whether Claude Code saves session history to disk. When `false`, the flag is passed and no session file is written. The adapter passes `--resume <session_id>`, which reads the persisted session, on every turn but the first of a session it opened itself, so `false` is refused before the run. See [session persistence and resume](/reference/adapter-claude-code/#session-persistence-and-resume). |

`permission_mode` and `session_persistence` are the keys checked before the run. The rest reach the CLI unvalidated, and what it does with an invalid value differs per flag: `--effort` with a name Claude Code does not recognize falls back to the model's default level and logs a warning, and an unknown model name reaches the API and fails there. A string key whose YAML value is not a string fails construction and, offline, is reported by `sortie validate` under the check `claude-code.<key>.wrong_type`. An integer, number, or boolean key with a value of the wrong type is ignored and the default applies.

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and `claude-code.max_turns` (CLI internal turn budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls the Claude Code CLI's internal turn budget per invocation.

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: <model-id>
  fallback_model: <fallback-model-id>
  max_turns: 50
  max_budget_usd: 5
  effort: high
  allowed_tools: "Read Edit Bash(git diff *)"
  mcp_config: ./mcp-servers.json
```

### `copilot-cli`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(CLI default)_ | Forwarded to `--model` unchanged. See `copilot --help` on your installed version for the accepted values. |
| `effort` | string | _(CLI default)_ | Forwarded to `--reasoning-effort`; see [reasoning effort](#adapter-pass-through-configuration). `copilot --help` on your installed version lists the accepted values. |
| `max_autopilot_continues` | integer | `50` | Forwarded to `--max-autopilot-continues`, the ceiling on autopilot continuation steps inside one turn. The flag is always passed: an absent key, a non-integer value, and any value of zero or less all send `50`. |
| `agent` | string | _(none)_ | Forwarded to `--agent`. Selects a named Copilot agent for the turn. |
| `allowed_tools` | string | _(none)_ | Forwarded to `--allow-tool` as a single argument. |
| `denied_tools` | string | _(none)_ | Forwarded to `--deny-tool` as a single argument. |
| `available_tools` | string | _(none)_ | Forwarded to `--available-tools` as a single argument. |
| `excluded_tools` | string | _(none)_ | Forwarded to `--excluded-tools` as a single argument. |
| `mcp_config` | string | _(none)_ | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the copy Sortie generates for its own tool sidecar; the original is never modified, and a file already declaring `sortie-tools` fails the attempt. That generated copy is what reaches `--additional-mcp-config`, so this value is forwarded on its own only when no copy was generated. See [Sortie's own tools and the `mcp_config` field](/reference/adapter-copilot/#sorties-own-tools-and-the-mcp_config-field). |
| `disable_builtin_mcps` | boolean | `false` | Adds `--disable-builtin-mcps` when true, withholding the CLI's built-in MCP servers. |
| `no_custom_instructions` | boolean | `false` | Adds `--no-custom-instructions` when true, so the CLI skips the custom instruction files it would otherwise read. |
| `experimental` | boolean | `false` | Adds `--experimental` when true, enabling the CLI's experimental features. |

No value in this block is refused before the run; `allowed_tools` draws a warning only. A string key whose YAML value is not a string fails construction and, offline, is reported by `sortie validate` under the check `copilot-cli.<key>.wrong_type`. An integer or boolean key with a value of the wrong type, `max_autopilot_continues` included, is ignored and the default applies.

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and `copilot-cli.max_autopilot_continues` (CLI autonomy budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls how many autonomous continuation steps Copilot CLI takes within a single turn.

The adapter passes `--allow-all` for unattended operation unless `allowed_tools` is set, in which case `--allow-all` is omitted because the grant would otherwise subsume the allow-list. `denied_tools`, `available_tools`, and `excluded_tools` are forwarded alongside `--allow-all` rather than replacing it: a `denied_tools` rule still denies a matching call, and the other two still limit what the model sees. Setting `allowed_tools` draws the `copilot-cli.allowed_tools.auto_deny` warning rather than an error: every call outside the list is denied without a prompt and the session keeps going, so the narrower configuration limits what the agent may do without leaving it waiting for a person. See [validate-time checks](/reference/adapter-copilot/#validate-time-checks).

```yaml
copilot-cli:
  model: <model-id>
  effort: high
  max_autopilot_continues: 100
  mcp_config: ./mcp-servers.json
```

### `codex`

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(API default)_ | Model override, forwarded unchanged. Maps to `model` on `thread/start`. See `codex --help` on your installed version for the accepted values. |
| `effort` | string | _(API default)_ | Reasoning effort, sent as `effort` on every `turn/start`; see [reasoning effort](#adapter-pass-through-configuration). The names Codex accepts depend on the model. |
| `approval_policy` | string | `never` | Approval policy for the thread. Maps to `approvalPolicy` on `thread/start`, which governs every turn. `never` is the only value Sortie accepts. See [validate-time checks](/reference/adapter-codex/#validate-time-checks). |
| `thread_sandbox` | string | `workspaceWrite` | Thread sandbox mode, forwarded unchanged. The default confines writes to the workspace and allows no network access. |
| `personality` | string | _(none)_ | Personality preset. Maps to `personality` on `thread/start`. |
| `turn_sandbox_policy` | map | _(none)_ | Per-turn sandbox policy override. Keys such as `networkAccess`, `writableRoots`. |
| `mcp_config` | string | _(none)_ | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the copy Sortie generates for its own tool sidecar; the original is never modified, and a file already declaring `sortie-tools` fails the attempt. |

The Codex adapter uses a persistent subprocess model: the `codex app-server` is launched once, when the session starts, and kept alive across turns. This differs from Claude Code, Copilot CLI, and OpenCode, which spawn a new subprocess per turn. The runtime accepts no MCP configuration path, so instead of handing over the generated file the adapter re-expresses its servers as configuration overrides on the app-server command line. That happens on a local launch only; an SSH session receives none, and reaches no Sortie tool. See the [Codex adapter reference](/reference/adapter-codex/) for the full lifecycle and [MCP](/reference/adapter-codex/#mcp) for the delivery detail.

> [!WARNING]
> `approval_policy: never` allows arbitrary command execution within the sandbox boundary. Use only in sandboxed environments. The default `thread_sandbox: workspaceWrite` restricts writes to the workspace path with no network access.

> [!WARNING]
> Keep `approval_policy` at its default. `untrusted`, `on-request`, and any other non-`never` string value let the app-server stop and ask for a decision an unattended run has nobody to give, so all of them are refused with the `codex.approval_policy.interactive` error before any run starts, and the app-server never sees the value. Codex accepts an object form of this policy too, a `granular` member whose booleans decide each approval category, but this field is read as a string, so a map value is dropped and the thread starts under `never`. What the adapter does when an approval request arrives anyway is described in the [Codex adapter reference](/reference/adapter-codex/#approval-policy-and-sandbox).

```yaml
codex:
  model: <model-id>
  effort: medium
  approval_policy: never
  thread_sandbox: workspaceWrite
  personality: concise
  turn_sandbox_policy:
    networkAccess: true
```

### `opencode`

The adapter runs OpenCode 2.x. It queries the version `agent.command` reports at the start of each session and refuses one it cannot read or one that is not 2.x; see the [version check](/reference/adapter-opencode/#version-check) for every refusal and [settings refused at session start](/reference/adapter-opencode/#settings-refused-at-session-start) for the configuration it rejects.

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(CLI default)_ | Model identifier in `provider/model` form. |
| `agent` | string | _(none)_ | OpenCode agent name, passed through unchanged. |
| `effort` | string | _(none)_ | Reasoning level; see [reasoning effort](#adapter-pass-through-configuration). It fills OpenCode's model-variant slot, so it needs a `model` without a `#` suffix of its own; see [settings refused at session start](/reference/adapter-opencode/#settings-refused-at-session-start). Setting it together with `variant` is an error. |
| `variant` | string | _(none)_ | Reasoning variant. Fills the same slot as `effort`; setting both fails under `opencode.effort.conflict`. It needs a `model` without a `#` suffix of its own; see [settings refused at session start](/reference/adapter-opencode/#settings-refused-at-session-start). |
| `thinking` | boolean | `false` | Requests reasoning output. |
| `dangerously_skip_permissions` | boolean | `true` | Auto-approves permission requests. `false` changes tool-call behavior; see [validate-time checks](/reference/adapter-opencode/#validate-time-checks). |
| `disable_autocompact` | boolean | `true` | Disables OpenCode's own context autocompaction. |
| `allowed_tools` | list of strings | `[]` | Builds an allowlist permission policy: listed keys become `allow`, every known key not listed becomes `deny`, unknown keys are forwarded unchanged. |
| `denied_tools` | list of strings | `[]` | Adds `deny` rules to the same policy `allowed_tools` builds. Overlap with `allowed_tools` is rejected when the adapter is built. |
| `mcp_config` | string | _(none)_ | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the copy Sortie generates for its own tool sidecar; the original is never modified, and a file already declaring `sortie-tools` fails the attempt. |

The OpenCode runtime accepts no MCP configuration path either, so the adapter re-expresses the generated servers as the runtime's own server entries and sets them in the turn's environment. That happens on a local launch only; an SSH session receives none, and reaches no Sortie tool. See [MCP](/reference/adapter-opencode/#mcp).

The adapter runs one `opencode run --format json` subprocess per turn and a second subprocess after the turn to recover authoritative token usage. The adapter exposes none of `--attach`, `--port`, `--command`, `--file`, `--title`, `--continue`, or `--fork` through WORKFLOW.md. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the exact commands, the full lifecycle, SSH behavior, and authentication model.

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and OpenCode's internal step budget are not the same thing. The adapter does not expose an OpenCode-specific inner turn cap.

```yaml
opencode:
  model: <provider>/<model-id>
  effort: high
  dangerously_skip_permissions: true
  disable_autocompact: true
  allowed_tools:
    - read
    - edit
    - glob
```

### `agent-client-protocol`

| Field | Type | Default | Description |
|---|---|---|---|
| `mcp_config` | string | _(none)_ | Path to an MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the copy Sortie generates for its own tool sidecar; the original is never modified, and a file already declaring `sortie-tools` fails the attempt. |

This kind names no default runtime and has no other pass-through fields: every runtime-specific setting, such as a model flag, a reasoning option, or a trust switch, is part of `agent.command` itself rather than a field in this block. An `effort` key here has no effect and draws `agent.effort.not_forwarded`. Because it has no default command, a [`dispatch` rule](#dispatch) can route to it only when it is also the default kind. The adapter re-expresses the generated MCP configuration's servers on `session/new`, on a local launch only; an SSH session receives none, and reaches no Sortie tool. See the [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the full lifecycle, the transport-level limits every runtime on this kind shares, and [MCP](/reference/adapter-agent-client-protocol/#mcp) for the delivery detail.

```yaml
agent-client-protocol:
  mcp_config: ./mcp-servers.json
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

Unknown top-level keys are collected into an extensions map for forward compatibility. The orchestrator does not validate extension fields at runtime; each consumer defines its own schema. However, [`sortie validate`](/reference/cli/#validate) emits advisory warnings for unknown top-level keys that are not recognized extensions or adapter pass-through blocks, catching typos before deployment.

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
| `logging.level` | string | `info` | No | **No** (requires restart) | Log verbosity: `debug`, `info`, `warn`, `error` (case-insensitive). |
| `logging.format` | string | `text` | No | **No** (requires restart) | Log output format: `text` or `json` (case-insensitive). `text` emits structured `key=value` lines. `json` emits newline-delimited JSON objects. |

The CLI [`--log-level`](/reference/cli/#--log-level) flag takes precedence over `logging.level`, and [`--log-format`](/reference/cli/#--log-format) takes precedence over `logging.format`. Changing either field in the workflow file takes effect only after a restart; dynamic reload does not change the active log level or format.

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
| `token_rates.<kind>.input_per_mtok` | number | _(not set)_ | USD per million fresh input tokens, and the fallback rate for either cache class when its rate is omitted. Required with `output_per_mtok` for this kind to produce cost estimates. |
| `token_rates.<kind>.output_per_mtok` | number | _(not set)_ | USD per million output tokens. Required with `input_per_mtok` for this kind to produce cost estimates. |
| `token_rates.<kind>.cache_read_per_mtok` | number | `input_per_mtok` | USD per million cache-read tokens. |
| `token_rates.<kind>.cache_write_per_mtok` | number | `input_per_mtok` | USD per million cache-write tokens. |

An entry must set both `input_per_mtok` and `output_per_mtok` to price any usage. Cache rates are optional: an omitted cache-read or cache-write rate falls back to `input_per_mtok`. A zero value is valid.

Sortie prices fresh input, cache reads, cache writes, and output as disjoint buckets. Fresh input is `input_tokens - cache_read_tokens - cache_write_tokens`, floored at zero. This prevents cache tokens, which are already included in `input_tokens`, from being charged twice.

An entry keyed to an agent kind that reports no token usage for the sessions a workflow produces has no effect: there is nothing to price, and the dashboard's Est. Cost field for such a session stays blank. [`sortie validate`](/reference/cli/#validate) reports that combination as an `agent.kind.no_cost_estimate` warning naming the kind, so it is not something to discover from a blank column. Whether a kind reports usage can depend on the launch: `copilot-cli` reports it locally and none over SSH, so adding a [`worker.ssh_hosts`](#worker) pool can make a previously effective entry inert.

Validation rules:

- `token_rates` must be a map when present. Non-map values produce a warning (not a fatal error).
- Each agent-kind value must be a map. A different type produces a warning, and the entry prices nothing.
- Rate values must be finite, non-negative numbers. Invalid values produce a warning and are treated as not configured.
- Unknown keys inside an entry produce a warning and are ignored.
- An entry missing `input_per_mtok` or `output_per_mtok` produces a warning and prices nothing.
- An entry keyed to the empty string is dropped with a warning. It prices no kind.

These warnings are configuration advisories under the `token_rates` check. They appear in `sortie validate` without changing `valid` or the exit status, in a dry run, and once per applicable configuration in the running orchestrator's log. `sortie stats` also includes the warnings in its report because they affect which runs it can price.

Token rates do not reload dynamically. Changes require a process restart, consistent with `server.port` and `server.host`.

```yaml
token_rates:
  claude-code:
    input_per_mtok: 3.00
    output_per_mtok: 15.00
    cache_read_per_mtok: 0.30
    cache_write_per_mtok: 3.75
  copilot-cli:
    input_per_mtok: 2.00
    output_per_mtok: 8.00
    cache_read_per_mtok: 0.20
    cache_write_per_mtok: 2.50
  codex:
    input_per_mtok: 2.50
    output_per_mtok: 10.00
    cache_read_per_mtok: 0.25
```

See [how to control agent costs](/guides/control-costs/) for operational guidance on cost monitoring.

### `worker`

SSH remote execution. The host with the fewest active sessions is selected per dispatch. See the [scale agents with SSH](/guides/scale-agents-with-ssh/) guide for operational setup.

> [!NOTE]
> SSH worker mode requires POSIX remote hosts (Linux, macOS). The orchestrator itself runs on any platform, but remote command execution relies on `cd`, `--` and `&&` shell chaining via the remote host's POSIX shell. A launch that carries an environment variable also needs the standard `dd` utility on the remote host.

| Field                          | Type            | Default                        | Description                                                                 |
| ------------------------------ | --------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `ssh_hosts`                    | list of strings | _(absent; runs locally)_       | SSH host targets for remote agent execution.                                |
| `max_concurrent_agents_per_host` | integer       | _(absent; no per-host cap)_    | Per-host concurrency limit. Hosts at capacity are skipped during dispatch.  |
| `ssh_strict_host_key_checking` | string          | `accept-new`                   | OpenSSH `StrictHostKeyChecking` value for remote sessions. Allowed values: `accept-new`, `yes`, `no`. |
| `ssh_pass_env`                 | list of strings | _(absent)_                     | Names of environment variables Sortie reads from its own process environment and sends to every remote agent launch. Names only, never values. See [environment variables carried to a remote agent](#environment-variables-carried-to-a-remote-agent). |
| `ssh_disallow_pass_env`        | list of strings | _(absent)_                     | Names Sortie never sends to a remote agent launch, whether they come from `ssh_pass_env` or from the agent kind's own credential set. |

When `ssh_hosts` is absent or empty, all agents run locally and every other field in this block is ignored; `ssh_pass_env` and `ssh_disallow_pass_env` each draw a startup warning naming the field in that case. Every field reloads dynamically: a change applies to sessions dispatched after the reload, and a session already running keeps what it started with.

### `ssh_strict_host_key_checking` values

| Value | Behavior |
|---|---|
| `accept-new` | Trust on first use: accept unknown host keys, reject changed keys. Default. |
| `yes` | Refuse connections unless the host key is already in `known_hosts`. Requires pre-populated `known_hosts`. |
| `no` | Accept any host key. Intended for isolated test or CI environments with ephemeral hosts. |

Invalid values produce a warning log at parse time and fall back to `accept-new`.

### Environment variables carried to a remote agent

The system `ssh` binary does not hand the orchestrator's environment to the remote shell, so a remote agent starts with the remote host's environment and nothing else. Two fields change that.

`ssh_pass_env` names variables Sortie reads from its own process environment and sends with every remote launch. Each agent kind also carries a fixed set of credential variables without being listed; the [environment variables reference](/reference/environment/#variables-carried-to-a-remote-agent) gives the names per kind. `ssh_disallow_pass_env` names variables Sortie never sends, from either source.

| Rule | Behavior |
|---|---|
| Delivery | A carried value travels on the SSH session's standard input, ahead of the agent command, never in a process argument. |
| Precedence on the host | A carried variable overrides whatever value or login the remote host already holds for that name. |
| Value unset, empty, or whitespace-only | The variable is skipped. A name listed under `ssh_pass_env` also logs `ssh_pass_env variable is not set or empty in the orchestrator environment` with the name; a name carried only because the agent kind declares it is skipped silently. |
| Name in both fields | `ssh_disallow_pass_env` wins, and the entry logs `ssh_pass_env variable is disallowed by ssh_disallow_pass_env, not carrying it`. Sortie sends nothing of its own for that name, so the remote host's own value or login stays in effect. |
| Literal names | Both fields take variable names, not values. An entry written as `$VAR` resolves before Sortie reads it, so the entry holds a value rather than a name; Sortie drops it and warns with the entry's position, never its contents. |
| Entry that is not a variable name | Dropped with a warning naming the entry's position, never its contents. A valid name that Sortie reserves for the delivery mechanism itself is also dropped, with a warning that names it. |
| Adapter-computed settings | Unaffected by either field. A kind that computes settings for its own runtime, such as OpenCode's managed `OPENCODE_*` values, sends them on the same carrier under neither field's control. |
| Local launches | Unaffected by either field. A local agent subprocess already inherits Sortie's full environment. |
| Remote host requirement | Any launch that carries a variable needs the standard `dd` utility on the remote host. Every remote `opencode` launch carries one, whatever these fields say. A host without `dd` fails the launch with `sortie: dd is required on the remote host to receive environment variables` on the agent's standard error. |

```yaml
worker:
  ssh_hosts:
    - build01.internal
    - build02.internal
  max_concurrent_agents_per_host: 2
  ssh_strict_host_key_checking: "yes"
  ssh_pass_env:
    - SENTRY_AUTH_TOKEN
    - NPM_TOKEN
  ssh_disallow_pass_env:
    - GITHUB_TOKEN
```

`sortie validate` reports none of these warnings. They are produced when the worker block is read for dispatch: at startup, after a reload that changes them, and once in [`--dry-run`](/reference/cli/#--dry-run).

---

## Prompt template

The markdown body after the closing `---` is a Go `text/template` rendered per issue. The template engine runs in strict mode (`missingkey=error`): referencing an undefined variable or function fails rendering immediately.

The template receives four core top-level variables on every render, `.issue`, `.attempt`, `.run`, and `.stage`, plus six reaction continuation variables that are `nil` except on the first turn of the matching reaction-triggered dispatch (`.review_comments` and `.bot_review_comments` are also set on the first turn of a new run, as described under each): `.ci_failure`, `.review_comments`, `.bot_review_comments`, `.merge_conflict`, `.label_review`, and `.label_fix`. Every continuation variable defaults to `nil` so a template referencing it renders under `missingkey=error` even when the corresponding reaction is never configured.

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
| `.issue.blocked_by`  | list of objects | Blocker references, each with `.id`, `.identifier`, `.state`, and `.display_id`. Non-nil empty list when no blockers. Sortie holds an issue out of dispatch until this list is resolved, so it is always authoritative by the time a session starts. `.display_id` is the qualified form when the tracker's own identifier is ambiguous (for example GitHub's `owner/repo#5` against an `identifier` of `5`), and empty otherwise. |
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

### `.stage`

Present on every render, first and continuation turns alike, and never `nil`, so a template that reads it renders in a workflow without [stage chains](#stage-chains). Every value is a string. When no hop led to the dispatch, `.stage.previous` and `.stage.previous_outcome` are empty strings.

| Field                     | Type   | Description |
| ------------------------- | ------ | ----------- |
| `.stage.current`          | string | `name` of the rule this dispatch runs, when that rule carries `stage`. Empty for a rule without `stage`, for `dispatch.default`, and when no rule applies. |
| `.stage.previous`         | string | `name` of the rule whose hop led to this dispatch. Set when the dispatch runs the target of the issue's latest hop and the hop count has not reset since; empty otherwise. |
| `.stage.previous_outcome` | string | `succeeded`, or `no_change` when the previous stage's run declared `no-change-needed`. Empty when `.stage.previous` is empty. |

```
{{ if .stage.previous }}The {{ .stage.previous }} stage finished first ({{ .stage.previous_outcome }}). Read what it left in the workspace before you start.{{ end }}
```

### `.ci_failure`

Available only on the first turn of a CI-fix continuation dispatch. `nil` on normal dispatches and non-CI retries.

| Field                    | Type            | Description                                                                                       |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `.ci_failure.status`     | string          | Always `"failing"` when present.                                                                  |
| `.ci_failure.check_runs` | list of objects | Individual check runs. Each has `.name` (string), `.status` (string), `.conclusion` (string), `.details_url` (string). |
| `.ci_failure.log_excerpt` | string         | Output of the failing step of the first failing check, or the end of its job log when that step cannot be found. A log-derived excerpt opens with a `[sortie]` line; see the [excerpt format](/reference/reactions/#reactionsci_failure). Empty when log fetching is disabled or logs are unavailable. |
| `.ci_failure.failing_count` | integer      | Number of checks with a failure conclusion.                                                       |
| `.ci_failure.ref`        | string          | The git ref (branch or SHA) that was checked.                                                     |

### `.review_comments`

Set on the first turn of a review-fix continuation dispatch, and on the first turn of a new run of an issue whose pull request holds review comments no earlier run was given, under the conditions in [comments already given](/reference/reactions/#comments-already-given). `nil` on every other turn.

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

### `.bot_review_comments`

Set on the first turn of a bot-review-fix continuation dispatch, triggered by [`reactions.bot_review`](/reference/reactions/#reactionsbot_review), and on the first turn of a new run of an issue whose pull request holds bot comments no earlier run was given, under the same conditions as `.review_comments`. `nil` on every other turn.

Same per-element shape as [`.review_comments`](#review_comments): a list of maps with `.id`, `.file`, `.start_line`, `.end_line`, `.reviewer` (the bot's login), and `.body`.

### `.merge_conflict`

Available only on the first turn of a merge-conflict-resolution continuation dispatch, triggered by [`reactions.merge_conflicts`](/reference/reactions/#reactionsmerge_conflicts). `nil` on normal dispatches and non-conflict retries.

| Field                        | Type    | Description                                                                    |
| ---------------------------- | ------- | -------------------------------------------------------------------------------- |
| `.merge_conflict.pr_number`  | integer | Pull request number.                                                             |
| `.merge_conflict.branch`     | string  | PR head branch the agent rebases.                                                |
| `.merge_conflict.head_sha`   | string  | Latest commit SHA on the PR head branch.                                         |
| `.merge_conflict.base`       | string  | PR's actual base branch, read live from the PR object; the rebase target.        |

### `.label_review`

Available only on the first turn of a read-only label-review dispatch, triggered when an operator applies [`reactions.label_commands.review_label`](#reactionslabel_commands) to a Sortie-managed PR. `nil` on every other dispatch.

| Field                          | Type    | Description                                            |
| ------------------------------- | ------- | -------------------------------------------------------- |
| `.label_review.pr_number`      | integer | Pull request number to review.                           |
| `.label_review.owner`          | string  | Repository owner.                                         |
| `.label_review.repo`           | string  | Repository name.                                          |
| `.label_review.actor`          | string  | Login of the operator who applied the review label.       |
| `.label_review.requested_at`   | string  | RFC 3339 timestamp of the labeling gesture.                |

The orchestrator injects only these coordinates. It never fetches the PR diff and never posts a comment itself; a template that omits `{{ if .label_review }}` produces no review on a label-review dispatch.

### `.label_fix`

Available only on the first turn of a fix dispatch, triggered when an operator applies [`reactions.label_commands.fix_label`](#reactionslabel_commands) to a Sortie-managed PR. `nil` on every other dispatch.

| Field                       | Type    | Description                                              |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `.label_fix.pr_number`       | integer | Pull request number to fix.                                  |
| `.label_fix.owner`           | string  | Repository owner.                                             |
| `.label_fix.repo`            | string  | Repository name.                                              |
| `.label_fix.branch`          | string  | PR head branch to check out and push to.                      |
| `.label_fix.actor`           | string  | Login of the operator who applied the fix label.               |
| `.label_fix.requested_at`    | string  | RFC 3339 timestamp of the labeling gesture.                     |

The orchestrator injects only these coordinates. It never fetches review comments and never pushes or comments itself; a template that omits `{{ if .label_fix }}` runs the normal work prompt against a real checkout with push capability instead of producing a fix.

### Turn semantics

The full template is rendered on every turn. The runtime passes the complete rendered result to the agent regardless of turn number. Template authors branch on `.attempt`, `.run.is_continuation`, and each continuation variable to vary content.

| Scenario                     | `.attempt`        | `.run.is_continuation` | The dispatch's own continuation variable | Every other continuation variable |
| ----------------------------- | ----------------- | ----------------------- | ------------------------------------------ | ------------------------------------ |
| First run                    | `0`                | `false`                  | n/a                                          | `nil`                                 |
| Continuation                  | same as turn 1     | `true`                   | n/a                                          | `nil`                                 |
| Retry after error             | `>= 1`             | `false`                  | n/a                                          | `nil`                                 |
| Reaction-triggered dispatch (CI-fix, review-fix, bot-review-fix, merge-conflict, label-review, label-fix) | same as previous   | `false`                  | populated (see the variable's own section above) | `nil`                                 |

Only the one continuation variable matching the triggering reaction is non-nil on that dispatch's first turn; the other five are `nil`. On continuation turns, if the rendered prompt is empty, Sortie substitutes a built-in default continuation prompt. On the first turn, an empty rendered prompt is passed through as-is.

### Template functions

| Function | Signature              | Result                 |
| -------- | ---------------------- | ---------------------- |
| `toJSON` | `toJSON value`         | Compact JSON string. `{{ .issue.labels \| toJSON }}` produces `["bug","urgent"]`. |
| `join`   | `join separator list`  | Joined string. `{{ .issue.labels \| join ", " }}` produces `bug, urgent`. |
| `lower`  | `lower string`         | Lowercased string. `{{ .issue.state \| lower }}` produces `in progress`. |

`join` uses pipe syntax with reversed arguments: the piped value is passed as the last argument per Go template convention.

### Built-in actions

Every action, control structure, and comparison function of Go's [`text/template`](https://pkg.go.dev/text/template) package is available unmodified. Sortie adds no restrictions and no additional actions beyond the three functions above.

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
| `agent.max_tokens`                     | Next poll tick for a session already running; next retry evaluation for a blocked dispatch. |
| `agent.token_warning_percent`          | Next poll tick for a run already running and not yet warned; runs dispatched after the reload use it from the start. A running session's `cost_budget` reading, `warning_tokens` and `budget_tokens` alike, reflects whatever WORKFLOW.md said when its tool server last started: on a kind that launches a fresh process each turn, that is the next turn; on a kind with a persistent process for the whole session, not until the next dispatch. |
| `agent.max_consecutive_absences`       | Next worker exit, retry evaluation, or poll-tick park sweep. |
| `tracker.*`                            | Future dispatches and reconciliation.  |
| `tracker.comments.on_dispatch`         | Future dispatches.                     |
| `tracker.comments.on_completion`, `tracker.comments.on_failure` | Future worker exits. Both toggles are evaluated against the active configuration when a worker exits, so a reload can change whether an in-flight session posts its completion or failure comment. |
| `hooks.*`                              | Future hook executions.                |
| `agent.kind`, `agent.command`, `agent.max_turns` | Future dispatches.            |
| `agent.turn_timeout_ms`, `agent.read_timeout_ms`, `agent.stall_timeout_ms` | Future worker attempts. |
| `agent.stop_grace_ms`                  | Future worker attempts for the per-session stop bound, which each attempt freezes when it starts. The shutdown worker-drain ceiling reads the active value instead, so a reloaded value bounds the next shutdown without waiting for a new attempt. |
| `worker.ssh_hosts`, `worker.max_concurrent_agents_per_host`, `worker.ssh_strict_host_key_checking`, `worker.ssh_pass_env`, `worker.ssh_disallow_pass_env` | Dynamic. Future dispatches use the reloaded value; in-flight sessions are unaffected. |
| Prompt template                        | Future worker attempts.                |
| `dispatch.rules`, `dispatch.default`   | Future claims. In-flight issues keep the agent and template frozen at first dispatch. A waiting retry keeps its recorded selection unless the configuration no longer reaches its kind or holds its template; see [Freeze and reload](#freeze-and-reload). A rule's settings block applies from the next attempt, like the top-level block of its kind. A rule's `next` and its target's `stage` are read when the worker exits; see [Stage chains](#stage-chains). |
| `dispatch.max_consecutive_hops`       | The next worker exit that reaches a hop decision. |
| Per-rule `dispatch` template files     | Read on WORKFLOW.md load and reload; a standalone edit applies on the next WORKFLOW.md change or dispatch. |
| `reactions.ci_failure.max_retries`, `reactions.ci_failure.escalation`, `reactions.ci_failure.escalation_label` | Next reconcile tick. |
| `reactions.ci_failure.provider`, `reactions.ci_failure.max_log_lines` | Requires restart. The CI provider is built once at startup with its log limit, so a reload neither swaps the provider nor turns CI feedback on or off. The reload is not refused; the running provider stays in use. |
| `reactions.ci_failure.watch_window_ms` | Next reconcile tick.                   |
| `reactions.ci_failure.triage.*`        | Requires restart. The triage configuration is frozen when the orchestrator is built. |
| `self_review.*`                        | Next dispatch. Running workers use the snapshot captured at review-phase entry. |
| `reactions.*`, every kind except `ci_failure` | Requires restart. The whole block is captured once when the orchestrator starts, including whether each kind is active, so adding or removing a kind's block changes nothing until the process restarts. |
| `notifications` (`agent.message` entries, `max_per_session`) | Next agent session. Each session's MCP sidecar reads the workflow file at startup; in-flight sessions are unaffected. |
| `notifications` (events Sortie produces) | The next poll tick, and each worker exit. Sortie routes an event against the configuration in force when it decides to send it, so a change to `events` or to a destination never affects an event already routed. A reload whose destinations for these events cannot be built is rejected and the previous configuration stays in force. The `escalation: comment` of every reaction other than `ci_failure` keeps the value read at startup, and so does the comment it posts, whatever a reload changes in `notifications`. |
| `claude-code.*`, `codex.*`, `copilot-cli.*`, `opencode.*`, `agent-client-protocol.*` | Next attempt of any claim, a claim already held included. Sortie resolves the block at the start of every attempt; a running session keeps the settings it started with. |
| `db_path`                              | Requires restart.                      |
| `server.port`                          | Requires restart.                      |
| `server.host`                          | Requires restart.                      |
| `logging.level`                        | Requires restart.                      |
| `logging.format`                       | Requires restart.                      |
| `token_rates.*`                        | Requires restart.                      |

An in-flight agent session keeps its agent and prompt template frozen at first dispatch. The exception is exit-time behavior: the destinations of the session events a worker exit produces, including those enabled by `tracker.comments.on_completion` and `tracker.comments.on_failure`, are selected against the active configuration when the worker exits, so a reload during a session can change whether it posts a completion or failure comment.
