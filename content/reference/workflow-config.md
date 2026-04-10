---
title: Workflow Configuration
linkTitle: "Workflow File"
description: Complete reference for every WORKFLOW.md configuration field. Tracker, polling, workspace, hooks, agent, database, prompt template, server, logging, and SSH worker.
keywords: sortie configuration, WORKFLOW.md, YAML, tracker, agent, ci_feedback, self_review, reactions, review_comments, hooks, workspace, server, worker, SSH, config reference
author: Sortie AI
date: 2026-03-23
weight: 20
url: /reference/workflow-config/
---
`WORKFLOW.md` is a Markdown file with YAML front matter. Front matter between `---` delimiters defines runtime settings. The body after the closing `---` is the prompt template, rendered per issue with Go `text/template`.

See also: [CLI reference](/reference/cli/) for startup flags, [environment variables reference](/reference/environment/) for `$VAR` behavior, [error reference](/reference/errors/) for configuration error diagnostics, [Jira adapter reference](/reference/adapter-jira/) for Jira-specific fields, [GitHub adapter reference](/reference/adapter-github/) for GitHub-specific fields, [Claude Code adapter reference](/reference/adapter-claude-code/) for Claude Code pass-through options, [Copilot CLI adapter reference](/reference/adapter-copilot/) for Copilot CLI pass-through options, [Configure CI feedback](/guides/configure-ci-feedback/) for operational guidance.

> [!TIP]
> Most configuration fields in this reference can be overridden by `SORTIE_*` environment variables without modifying the workflow file. See the [environment variables reference](/reference/environment/#configuration-overrides) for the full list and precedence rules.

## Complete annotated example

```yaml
---
# --- Tracker ----------------------------------------------------------
tracker:
  kind: jira                          # Adapter: "jira" or "file"
  endpoint: $SORTIE_JIRA_ENDPOINT     # Jira base URL ($VAR expanded)
  api_key: $SORTIE_JIRA_API_KEY       # API token ($VAR expanded anywhere)
  project: PLATFORM                   # Jira project key
  query_filter: "labels = 'agent-ready'"  # JQL fragment appended to queries
  active_states:                      # Issues in these states get dispatched
    - To Do
    - In Progress
  terminal_states:                    # Issues in these states trigger cleanup
    - Done
    - Won't Do
  handoff_state: Human Review         # State set after successful agent run
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
  after_create: |                     # Runs once when workspace is created
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
  max_concurrent_agents: 4            # Global concurrency cap
  turn_timeout_ms: 1800000            # 30 min per turn
  read_timeout_ms: 10000              # 10 s startup timeout
  stall_timeout_ms: 300000            # 5 min inactivity detection
  max_retry_backoff_ms: 120000        # 2 min max retry delay
  max_concurrent_agents_by_state:
    in progress: 3                    # Per-state concurrency cap
    to do: 1

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

# --- Claude Code adapter (pass-through) ------------------------------
claude-code:
  permission_mode: bypassPermissions  # Auto-approve tool calls
  model: claude-sonnet-4-20250514
  max_turns: 50                       # CLI --max-turns (not agent.max_turns)
  max_budget_usd: 5                   # Per-session cost cap

# --- Server -----------------------------------------------------------
server:
  port: 9090                          # HTTP observability server (default: 7678, 0 to disable)
  host: "0.0.0.0"                     # Bind address (default: 127.0.0.1)

# --- Logging ----------------------------------------------------------
logging:
  level: info                         # debug | info | warn | error
  format: json                        # text | json (default: text)

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
| `kind`            | string          | _(required)_          | Adapter identifier. `"jira"`, `"github"`, or `"file"`.                  |
| `endpoint`        | string          | adapter-defined       | Tracker API base URL.                                                   |
| `api_key`         | string          | _(required for Jira)_ | API authentication token.                                               |
| `project`         | string          | _(required for Jira)_ | Project key (e.g., `PLATFORM`).                                         |
| `active_states`   | list of strings | `[]`                  | Issue states eligible for dispatch.                                     |
| `terminal_states` | list of strings | `[]`                  | Issue states that trigger workspace cleanup.                            |
| `query_filter`    | string          | `""`                  | Query fragment appended to tracker queries. For Jira: a JQL expression. |
| `handoff_state`   | string          | _(absent)_            | Target state after a successful agent run. Absent disables handoff.     |
| `in_progress_state` | string        | _(absent)_            | Target state for dispatch-time transition at the start of each worker attempt. Absent disables dispatch-time transitions. |
| `comments.on_dispatch`   | bool   | `false`               | Post a tracker comment when a worker is dispatched.                     |
| `comments.on_completion` | bool   | `false`               | Post a tracker comment when a worker completes normally.                |
| `comments.on_failure`    | bool   | `false`               | Post a tracker comment when a worker exits with an error.               |

### Environment variable expansion

`api_key` applies full environment expansion: `$VAR` and `${VAR}` references are resolved at any position in the string.

`endpoint`, `project`, `handoff_state`, and `in_progress_state` use targeted resolution: the value is expanded only when the entire trimmed string starts with `$`. Literal URIs and project keys that contain `$` characters elsewhere are returned unchanged.

See the [environment variables reference](/reference/environment/#var-indirection-in-workflowmd) for expansion mechanics.

### Constraints

At least one of `active_states` or `terminal_states` must be non-empty. When both are empty, Sortie refuses to start. An empty `active_states` with non-empty `terminal_states` is valid but means no issues are dispatched.

`handoff_state`, when set, must not appear in `active_states` (causes immediate re-dispatch loop) or `terminal_states` (handoff is not a terminal outcome). Jira handoff requires write permissions on the API token: `write:jira-work` (classic) or `write:issue:jira` (granular).

`in_progress_state`, when set, must appear in `active_states` (otherwise reconciliation would immediately cancel the worker after the transition). It must not appear in `terminal_states` or collide with `handoff_state`. If the issue is already in the target state at dispatch time, the transition call is skipped (debug log only). Other transition failures at runtime are non-fatal: the worker logs a warning and continues to workspace preparation. Requires the same write permissions as `handoff_state`.

### Tracker comments

The `comments` sub-object controls whether Sortie posts plain-text comments on tracker issues at session lifecycle points. Each flag is independent. All default to `false`.

| Flag | Fires when | Comment content |
|---|---|---|
| `on_dispatch` | Worker starts (after in-progress transition, before workspace preparation) | Session started acknowledgment with agent kind and attempt number. Session ID and workspace are "pending" at this point. |
| `on_completion` | Worker exits normally | Session ID, duration, turns completed. Includes "(re-queuing)" suffix when a continuation retry is scheduled. |
| `on_failure` | Worker exits with an error | Session ID, duration, truncated error message (200 char limit), retry status and next attempt number. |

Comment failures are non-fatal. A failed comment logs WARN and never blocks dispatch, completion, retry, or handoff. Completion and failure comments are posted from a detached goroutine — the event loop is never blocked by the tracker API.

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
  active_states: [backlog, in-progress, review]
  terminal_states: [done, wontfix]
  handoff_state: review
  in_progress_state: in-progress
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true
```

GitHub state names are issue label names. They must exist as labels in the repository before Sortie starts. State values are compared case-insensitively and stored lowercased. See the [GitHub adapter reference](/reference/adapter-github/) for state derivation rules.

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

Base directory for per-issue workspaces.

| Field  | Type | Default                           | Description                                                          |
| ------ | ---- | --------------------------------- | -------------------------------------------------------------------- |
| `root` | path | `<system-temp>/sortie_workspaces` | Base directory. Per-issue subdirectories are created under this path. |

`~` expands to the home directory via `os.UserHomeDir()`. All `$VAR` and `${VAR}` references are expanded via `os.ExpandEnv` at any position. Issue identifiers are sanitized to `[A-Za-z0-9._-]` for subdirectory names; other characters become `_`.

> [!WARNING]
> Changing `workspace.root` and restarting leaves old workspace directories on disk. Sortie scans only the currently configured root during startup cleanup. Remove old directory contents manually before switching roots.

```yaml
workspace:
  root: ~/workspace/sortie
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

---

## `agent`

Coding agent adapter, concurrency, timeouts, and retry behavior. These fields control the orchestrator's scheduling decisions, not the agent process itself. Adapter-specific settings use [separate pass-through blocks](#adapter-pass-through-configuration).

| Field                            | Type    | Default         | Description                                                                           |
| -------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------- |
| `kind`                           | string  | `claude-code`   | Agent adapter identifier.                                                             |
| `command`                        | string  | adapter-defined | Shell command to launch the agent. Required for local-process adapters.               |
| `max_turns`                      | integer | `20`            | Maximum turns per worker session. The worker re-checks tracker state after each turn. |
| `max_sessions`                   | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying. Must be non-negative. |
| `max_concurrent_agents`          | integer | `10`            | Global concurrency limit across all issues.                                           |
| `max_concurrent_agents_by_state` | map     | `{}`            | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored. |
| `turn_timeout_ms`                | integer | `3600000` (1h)  | Total timeout for a single agent turn.                                                |
| `read_timeout_ms`                | integer | `5000` (5s)     | Timeout for startup and synchronous operations.                                       |
| `stall_timeout_ms`               | integer | `300000` (5m)   | Inactivity timeout based on event stream gaps. `0` or negative disables stall detection. |
| `max_retry_backoff_ms`           | integer | `300000` (5m)   | Maximum delay cap for exponential backoff on retries.                                 |

`max_concurrent_agents`, `max_concurrent_agents_by_state`, `max_retry_backoff_ms`, and `max_sessions` reload dynamically without restart. All other fields apply to future dispatches only.

```yaml
agent:
  kind: claude-code
  command: claude
  max_turns: 5
  max_sessions: 3
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 3
    to do: 1
```

---

## `ci_feedback`

CI feedback configuration. When activated, Sortie detects CI failures on agent-created branches and dispatches continuation runs with failure context injected into the agent prompt. When retries are exhausted, Sortie escalates to a human via label or comment.

| Field              | Type    | Default                          | Description                                                                                                          |
| ------------------ | ------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `kind`             | string  | _(absent; CI feedback disabled)_ | CI status provider adapter identifier (e.g., `"github"`). Absent or empty disables CI feedback entirely.            |
| `max_retries`      | integer | `2`                              | Maximum CI-fix continuation dispatches per issue before escalation. Zero means escalate immediately on first CI failure. Must be non-negative. |
| `max_log_lines`    | integer | `50`                             | Lines to fetch from the first failing check run's log. Positive: fetch up to N lines. Zero: disable log fetching. Must be non-negative. |
| `escalation`       | string  | `"label"`                        | Action when `max_retries` is exceeded. Valid values: `"label"`, `"comment"`.                                         |
| `escalation_label` | string  | `"needs-human"`                  | Label applied to the issue when `escalation` is `"label"`. The label must exist in the repository. Ignored when `escalation` is `"comment"`. |

CI feedback follows the same activation pattern as other optional Sortie features. Presence of `kind` activates the feature; absence disables it. This is consistent with `worker.ssh_hosts` (absent = local mode). There is no `ci_feedback.enabled` boolean.

Repository coordinates (owner, repo name, API token, endpoint) are not part of the `ci_feedback` section. They live in the adapter pass-through block that matches the CI provider kind. When `ci_feedback.kind: github`, the CI adapter reads credentials from the `github:` top-level section in [Extensions](#extensions). When `tracker.kind` and `ci_feedback.kind` match (the common single-platform case), both adapters share the same credentials from the tracker config. See [adapter pass-through configuration](#adapter-pass-through-configuration) for the extension block pattern.

`sortie validate` checks `ci_feedback` sub-keys against the known schema. Unknown sub-keys produce an advisory warning. Adapter-specific keys nested inside `ci_feedback:` (e.g., `ci_feedback.github.owner`) are flagged as unknown because `ci_feedback` does not use adapter pass-through. Place adapter-specific config in a top-level extension block instead.

> [!NOTE]
> Environment variable overrides for `ci_feedback` fields are not currently supported. All `ci_feedback` values must be set in WORKFLOW.md. This differs from `tracker` and `agent` sections, which support `SORTIE_TRACKER_*` and `SORTIE_AGENT_*` overrides respectively.

### Escalation behavior

| Escalation          | Behavior                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` (default)   | Adds `escalation_label` (default `needs-human`) to the issue via the tracker adapter's `AddLabel` API. The label must already exist in the repository.  |
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

The `reactions` block configures post-PR feedback loops. Each key is a reaction kind (e.g. `review_comments`) with its own provider, retry budget, and escalation policy. Reactions are opt-in: omit the block entirely to disable all reaction types.

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

`reactions.review_comments` fields take effect on future dispatches. A currently polling reaction uses the config snapshot from the most recent reconcile tick. Adding or removing the `reactions.review_comments` block via dynamic reload activates or deactivates review polling on the next tick.

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

| Field             | Type    | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `permission_mode` | string  | Claude Code permission mode (e.g., `bypassPermissions`). |
| `model`           | string  | Model for agent sessions.                                |
| `max_turns`       | integer | CLI `--max-turns` flag.                                  |
| `max_budget_usd`  | number  | Per-session cost cap.                                    |

> [!WARNING]
> `agent.max_turns` (orchestrator turn-loop limit) and `claude-code.max_turns` (CLI internal turn budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls the Claude Code CLI's internal turn budget per invocation.

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  max_turns: 50
  max_budget_usd: 5
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

Unknown top-level keys are collected into an extensions map for forward compatibility. The orchestrator does not validate extension fields at runtime; each consumer defines its own schema. However, [`sortie validate`](/reference/cli/#validate) emits advisory warnings for unknown top-level keys that are not recognized extensions or adapter pass-through blocks — catching typos before deployment.

### `server`

Embedded HTTP observability server. Exposes a JSON API, HTML dashboard, health probes, and Prometheus metrics on a single port. See the [HTTP API reference](http-api.md) for endpoint details and the [Prometheus metrics reference](/reference/prometheus-metrics/) for metric definitions.

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
| `logging.level` | string | `info` | No | **No** — requires restart | Log verbosity: `debug`, `info`, `warn`, `error` (case-insensitive). |
| `logging.format` | string | `text` | No | **No** — requires restart | Log output format: `text` or `json` (case-insensitive). `text` emits structured `key=value` lines. `json` emits newline-delimited JSON objects. |

The CLI [`--log-level`](/reference/cli/#-log-level) flag takes precedence over `logging.level`, and [`--log-format`](/reference/cli/#-log-format) takes precedence over `logging.format`. Changing either field in the workflow file takes effect only after a restart; dynamic reload does not re-initialize the log handler.

Unknown values for either field cause startup failure with exit code `1`.

```yaml
logging:
  level: debug
  format: json
```

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
| `accept-new` | Trust on first use — accept unknown host keys, reject changed keys. Default. |
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
| `tracker.*` (including `tracker.comments.*`) | Future dispatches and reconciliation.  |
| `hooks.*`                              | Future hook executions.                |
| `agent.kind`, `agent.command`, `agent.max_turns` | Future dispatches.            |
| `agent.turn_timeout_ms`, `agent.read_timeout_ms`, `agent.stall_timeout_ms` | Future worker attempts. |
| `worker.ssh_hosts`, `worker.max_concurrent_agents_per_host`, `worker.ssh_strict_host_key_checking` | Dynamic. Future dispatches use the reloaded value; in-flight sessions are unaffected. |
| Prompt template                        | Future worker attempts.                |
| `ci_feedback.max_retries`              | Next reconcile tick.                   |
| `ci_feedback.escalation`, `ci_feedback.escalation_label` | Next reconcile tick.   |
| `ci_feedback.kind`, `ci_feedback.max_log_lines` | Requires restart.              |
| `self_review.*`                        | Next dispatch. Running workers use the snapshot captured at review-phase entry. |
| `reactions.review_comments.provider`   | Next reconcile tick. Adding/removing the block activates/deactivates polling. |
| `reactions.review_comments.max_retries` | Future dispatches.                    |
| `reactions.review_comments.escalation`, `reactions.review_comments.escalation_label` | Future dispatches. |
| `reactions.review_comments.poll_interval_ms` | Next reconcile tick.             |
| `reactions.review_comments.debounce_ms` | Next reconcile tick.                 |
| `reactions.review_comments.max_continuation_turns` | Future dispatches.          |
| `db_path`                              | Requires restart.                      |
| `server.port`                          | Requires restart.                      |
| `server.host`                          | Requires restart.                      |
| `logging.level`                        | Requires restart.                      |
| `logging.format`                       | Requires restart.                      |

In-flight agent sessions are not affected by any reload.
