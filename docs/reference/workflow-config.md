---
title: Workflow Configuration | Sortie
description: Complete reference for every WORKFLOW.md configuration field. Tracker, polling, workspace, hooks, agent, database, prompt template, server, logging, and SSH worker.
keywords: sortie configuration, WORKFLOW.md, YAML, tracker, agent, hooks, workspace, server, worker, SSH, config reference
author: Sortie AI
---

# WORKFLOW.md configuration reference

`WORKFLOW.md` is a Markdown file with YAML front matter. Front matter between `---` delimiters defines runtime settings. The body after the closing `---` is the prompt template, rendered per issue with Go `text/template`.

See also: [CLI reference](cli.md) for startup flags, [environment variables reference](environment.md) for `$VAR` behavior, [error reference](errors.md) for configuration error diagnostics, [Jira adapter reference](adapter-jira.md) for Jira-specific fields, [GitHub adapter reference](adapter-github.md) for GitHub-specific fields, [Claude Code adapter reference](adapter-claude-code.md) for agent-specific pass-through options.

!!! tip
    Most configuration fields in this reference can be overridden by `SORTIE_*` environment variables without modifying the workflow file. See the [environment variables reference](environment.md#configuration-overrides) for the full list and precedence rules.

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

# --- Claude Code adapter (pass-through) ------------------------------
claude-code:
  permission_mode: bypassPermissions  # Auto-approve tool calls
  model: claude-sonnet-4-20250514
  max_turns: 50                       # CLI --max-turns (not agent.max_turns)
  max_budget_usd: 5                   # Per-session cost cap

# --- Server -----------------------------------------------------------
server:
  port: 8642                          # HTTP observability server

# --- Logging ----------------------------------------------------------
logging:
  level: info                         # debug | info | warn | error

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

See the [environment variables reference](environment.md#var-indirection-in-workflowmd) for expansion mechanics.

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

GitHub state names are issue label names. They must exist as labels in the repository before Sortie starts. State values are compared case-insensitively and stored lowercased. See the [GitHub adapter reference](adapter-github.md) for state derivation rules.

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

!!! warning
    Changing `workspace.root` and restarting leaves old workspace directories on disk. Sortie scans only the currently configured root during startup cleanup. Remove old directory contents manually before switching roots.

```yaml
workspace:
  root: ~/workspace/sortie
```

---

## `hooks`

Shell scripts that run at workspace lifecycle points. Each hook executes via `sh -c` in the per-issue workspace directory. The shell is POSIX `sh`, not `bash`.

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

### Restricted environment

Hook subprocesses do not inherit the full parent process environment. They receive:

- A POSIX allowlist: `PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`.
- All parent environment variables prefixed with `SORTIE_`.
- The orchestrator-injected variables listed above.

All other parent variables are stripped. Secrets such as `JIRA_API_TOKEN` or `AWS_ACCESS_KEY_ID` are not available unless exposed under a `SORTIE_` prefix in the parent environment.

!!! note
    Hooks run under POSIX `sh` and do not source login profiles. Tools that depend on login-shell initialization (`nvm`, `rbenv`, `pyenv`) require a nested invocation: `bash -lc 'nvm use 20 && npm ci'`.

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

## `db_path`

SQLite database file path.

| Field     | Type | Default      | Description                                                                                         |
| --------- | ---- | ------------ | --------------------------------------------------------------------------------------------------- |
| `db_path` | path | `.sortie.db` | Path to the SQLite database. Relative paths resolve against the directory containing `WORKFLOW.md`. |

Supports `~` home directory expansion and `$VAR` environment expansion. An explicit empty string (`db_path: ""`) is equivalent to omitting the field. Non-string values produce a configuration error.

!!! warning
    Changing `db_path` requires a restart. The new path opens a fresh database. Retry queues and run history from the old file are not migrated automatically.

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

!!! warning
    `agent.max_turns` (orchestrator turn-loop limit) and `claude-code.max_turns` (CLI internal turn budget) are distinct values with different semantics. The orchestrator limit controls how many turns the worker runs before exiting. The adapter limit controls the Claude Code CLI's internal turn budget per invocation.

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  max_turns: 50
  max_budget_usd: 5
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

Unknown top-level keys are collected into an extensions map for forward compatibility. The orchestrator does not validate extension fields at runtime; each consumer defines its own schema. However, [`sortie validate`](cli.md#validate) emits advisory warnings for unknown top-level keys that are not recognized extensions or adapter pass-through blocks — catching typos before deployment.

### `server`

Embedded HTTP observability server. Exposes a JSON API, HTML dashboard, health probes, and Prometheus metrics on a single port. See the [HTTP API reference](http-api.md) for endpoint details and the [Prometheus metrics reference](prometheus-metrics.md) for metric definitions.

| Field  | Type    | Default                      | Description                                           |
| ------ | ------- | ---------------------------- | ----------------------------------------------------- |
| `port` | integer | _(absent; server disabled)_  | TCP port on `127.0.0.1`. Port `0` requests an OS-assigned ephemeral port. |

The CLI `--port` flag takes precedence over `server.port`. Requires a restart to change.

!!! note
    When `server.port` is absent and `--port` is not provided, the HTTP server does not start and Prometheus metrics are not collected. The orchestrator uses a no-op metrics implementation with zero overhead.

```yaml
server:
  port: 8642
```

### `logging`

Process-wide log verbosity. Controls the minimum severity level emitted to stderr.

| Field | Type | Default | Required | Dynamic Reload | Description |
|---|---|---|---|---|---|
| `logging.level` | string | `info` | No | **No** — requires restart | Log verbosity: `debug`, `info`, `warn`, `error` (case-insensitive). |

The CLI `--log-level` flag takes precedence over this field when both are present. Changing `logging.level` in the workflow file takes effect only after a restart; dynamic reload does not re-initialize the log handler.

Unknown values cause startup failure with exit code `1`.

```yaml
logging:
  level: debug
```

### `worker`

SSH remote execution. The host with the fewest active sessions is selected per dispatch. See the [scale agents with SSH](../guides/scale-agents-with-ssh.md) guide for operational setup.

| Field                          | Type            | Default                        | Description                                                                 |
| ------------------------------ | --------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `ssh_hosts`                    | list of strings | _(absent; runs locally)_       | SSH host targets for remote agent execution.                                |
| `max_concurrent_agents_per_host` | integer       | _(absent; no per-host cap)_    | Per-host concurrency limit. Hosts at capacity are skipped during dispatch.  |

When `ssh_hosts` is absent or empty, all agents run locally. Both fields reload dynamically.

```yaml
worker:
  ssh_hosts:
    - build01.internal
    - build02.internal
  max_concurrent_agents_per_host: 2
```

---

## Prompt template

The markdown body after the closing `---` is a Go `text/template` rendered per issue. The template engine runs in strict mode (`missingkey=error`): referencing an undefined variable or function fails rendering immediately.

The template receives three top-level variables: `.issue`, `.attempt`, and `.run`.

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

### Turn semantics

The full template is rendered on every turn. The runtime passes the complete rendered result to the agent regardless of turn number. Template authors branch on `.attempt` and `.run.is_continuation` to vary content.

| Scenario       | `.attempt` | `.run.is_continuation` |
| -------------- | ---------- | ---------------------- |
| First run      | `0`        | `false`                |
| Continuation   | same as turn 1 | `true`             |
| Retry after error | `>= 1`  | `false`                |

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

!!! note
    Inside `{{ range }}`, the dot (`.`) rebinds to the current element. Use `{{ $.issue.identifier }}` to access top-level variables from within a range block. `sortie validate` detects references to `.issue`, `.attempt`, or `.run` inside `{{ range }}` and `{{ with }}` blocks and emits a `dot_context` warning.

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
| `worker.ssh_hosts`, `worker.max_concurrent_agents_per_host` | Dynamic.          |
| Prompt template                        | Future worker attempts.                |
| `db_path`                              | Requires restart.                      |
| `server.port`                          | Requires restart.                      |
| `logging.level`                        | Requires restart.                      |

In-flight agent sessions are not affected by any reload.
