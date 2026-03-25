---
title: Workflow Configuration | Sortie
description: Complete reference for every WORKFLOW.md configuration field. Tracker, polling, workspace, hooks, agent, database, and prompt template.
keywords: sortie configuration, WORKFLOW.md, YAML, tracker, agent, hooks, workspace, config reference
author: Sortie AI
---

# WORKFLOW.md configuration reference

`WORKFLOW.md` is a single file that configures Sortie. YAML front matter between `---` delimiters defines runtime settings. Everything after the closing `---` is the prompt template rendered per issue.

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
| `kind`            | string          | _(required)_          | Adapter identifier. `"jira"` or `"file"`.                               |
| `endpoint`        | string          | adapter-defined       | Tracker API base URL.                                                   |
| `api_key`         | string          | _(required for Jira)_ | API authentication token.                                               |
| `project`         | string          | _(required for Jira)_ | Project key (e.g., `PLATFORM`).                                         |
| `active_states`   | list of strings | `[]`                  | Issue states eligible for dispatch.                                     |
| `terminal_states` | list of strings | `[]`                  | Issue states that trigger workspace cleanup.                            |
| `query_filter`    | string          | `""`                  | Query fragment appended to tracker queries. For Jira: a JQL expression. |
| `handoff_state`   | string          | _(absent)_            | Target state after a successful agent run. Omit to disable handoff.     |

!!! tip
    `endpoint`, `api_key`, `project`, and `handoff_state` support `$VAR` environment variable expansion. `api_key` expands `$VAR` references anywhere in the string. The other fields expand the entire value only when it starts with `$`.

!!! warning
    At least one of `active_states` or `terminal_states` must be non-empty. If both are empty, Sortie refuses to start. An empty `active_states` with non-empty `terminal_states` is valid but means no issues will be dispatched.

!!! warning
    `handoff_state` must not appear in `active_states` (causes immediate re-dispatch) or `terminal_states` (handoff is not terminal). Jira handoff requires write permissions on the API token.

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
```

**Example: file-based tracker (for local testing)**

```yaml
tracker:
  kind: file
  active_states: [To Do, In Progress]
  terminal_states: [Done]

file:
  path: /path/to/issues.json
```

---

## `polling`

Poll loop timing.

| Field         | Type    | Default | Description                       |
| ------------- | ------- | ------- | --------------------------------- |
| `interval_ms` | integer | `30000` | Milliseconds between poll cycles. |

Changes to `interval_ms` take effect on the next tick without restart.

```yaml
polling:
  interval_ms: 60000 # Poll every minute
```

---

## `workspace`

Base directory for per-issue workspaces.

| Field  | Type | Default                           | Description                                                           |
| ------ | ---- | --------------------------------- | --------------------------------------------------------------------- |
| `root` | path | `<system-temp>/sortie_workspaces` | Base directory. Per-issue subdirectories are created under this path. |

`~` expands to the home directory. `$VAR` references are expanded anywhere in the string. Issue identifiers are sanitized to `[A-Za-z0-9._-]` for subdirectory names (other characters become `_`).

!!! warning
    Changing `workspace.root` and restarting leaves old workspace directories on disk. Sortie only scans the currently configured root during startup cleanup. Remove the old directory contents manually before switching.

```yaml
workspace:
  root: ~/workspace/sortie
```

---

## `hooks`

Shell scripts that run at workspace lifecycle points. Each hook executes with `sh -c` in the per-issue workspace directory.

| Field           | Type         | Default  | Description                                            |
| --------------- | ------------ | -------- | ------------------------------------------------------ |
| `after_create`  | shell script | _(none)_ | Runs once when a workspace directory is first created. |
| `before_run`    | shell script | _(none)_ | Runs before each agent attempt.                        |
| `after_run`     | shell script | _(none)_ | Runs after each agent attempt.                         |
| `before_remove` | shell script | _(none)_ | Runs before workspace deletion.                        |
| `timeout_ms`    | integer      | `60000`  | Timeout in milliseconds for all hooks.                 |

**Failure behavior:**

| Hook            | On failure                                 |
| --------------- | ------------------------------------------ |
| `after_create`  | Aborts workspace creation.                 |
| `before_run`    | Aborts the current run attempt. May retry. |
| `after_run`     | Logged and ignored.                        |
| `before_remove` | Logged and ignored. Cleanup proceeds.      |

Timeouts count as failures.

**Environment variables available in all hooks:**

| Variable                  | Value                                         |
| ------------------------- | --------------------------------------------- |
| `SORTIE_ISSUE_ID`         | Tracker-internal issue ID.                    |
| `SORTIE_ISSUE_IDENTIFIER` | Human-readable ticket key (e.g., `PROJ-123`). |
| `SORTIE_WORKSPACE`        | Absolute path to the workspace directory.     |
| `SORTIE_ATTEMPT`          | Current attempt number.                       |

!!! warning
    Hooks receive a restricted environment: `PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`, plus any variable prefixed with `SORTIE_`. Other parent process variables (including secrets like `JIRA_API_TOKEN` or `AWS_ACCESS_KEY_ID`) are stripped. To pass additional values, set them with a `SORTIE_` prefix in the parent environment.

!!! tip
    For hooks that need a login shell (e.g., `nvm`, `rbenv`), wrap the script: `bash -lc 'nvm use 20 && npm ci'`

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

Coding agent adapter, concurrency, timeouts, and retry behavior. These fields control the orchestrator's scheduling decisions, not the agent itself.

| Field                            | Type    | Default         | Description                                                                           |
| -------------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------- |
| `kind`                           | string  | `claude-code`   | Agent adapter identifier.                                                             |
| `command`                        | string  | adapter-defined | Shell command to launch the agent. Required for local-process adapters.               |
| `max_turns`                      | integer | `20`            | Maximum turns per worker session. The worker re-checks tracker state after each turn. |
| `max_sessions`                   | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying.          |
| `max_concurrent_agents`          | integer | `10`            | Global concurrency limit across all issues.                                           |
| `max_concurrent_agents_by_state` | map     | `{}`            | Per-state concurrency limits. Keys are state names, lowercased for matching.          |
| `turn_timeout_ms`                | integer | `3600000` (1h)  | Total timeout for a single agent turn.                                                |
| `read_timeout_ms`                | integer | `5000` (5s)     | Timeout for startup and synchronous operations.                                       |
| `stall_timeout_ms`               | integer | `300000` (5m)   | Inactivity timeout based on event stream gaps.                                        |
| `max_retry_backoff_ms`           | integer | `300000` (5m)   | Maximum delay cap for exponential backoff on retries.                                 |

!!! tip
    `stall_timeout_ms` set to `0` or negative disables stall detection entirely.

!!! tip
    `max_concurrent_agents`, `max_concurrent_agents_by_state`, `max_retry_backoff_ms`, and `max_sessions` reload dynamically without restart. Other fields apply to future dispatches only.

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

Supports `~` and `$VAR` expansion.

!!! warning
    Changing `db_path` requires a restart. The new path opens a fresh database. Retry queues and run history from the old file are not migrated. Copy the old `.sortie.db` to the new path before restarting to preserve state.

```yaml
db_path: /var/lib/sortie/state.db
```

---

## Adapter pass-through configuration

Each adapter reads additional settings from a top-level block named after its `kind` value. The orchestrator forwards these blocks without validation.

### `claude-code`

| Field             | Type    | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `permission_mode` | string  | Claude Code permission mode (e.g., `bypassPermissions`). |
| `model`           | string  | Model for agent sessions.                                |
| `max_turns`       | integer | CLI `--max-turns` flag.                                  |
| `max_budget_usd`  | number  | Per-session cost cap.                                    |

!!! warning
    `agent.max_turns` (orchestrator turn-loop limit) and `claude-code.max_turns` (CLI internal turn budget) are distinct values with different purposes.

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

## Prompt template

The markdown body after the closing `---` is a Go `text/template` rendered per issue. The template receives three top-level variables.

### `.issue`

| Field                | Type            | Description                                                             |
| -------------------- | --------------- | ----------------------------------------------------------------------- |
| `.issue.id`          | string          | Tracker-internal ID.                                                    |
| `.issue.identifier`  | string          | Human-readable ticket key (e.g., `PROJ-123`).                           |
| `.issue.title`       | string          | Issue summary.                                                          |
| `.issue.description` | string          | Full description body. Empty string when absent.                        |
| `.issue.state`       | string          | Current tracker state name.                                             |
| `.issue.priority`    | integer or nil  | Numeric priority (lower = higher). `nil` when unavailable.              |
| `.issue.url`         | string          | Web URL to the issue. Empty string when absent.                         |
| `.issue.labels`      | list of strings | Labels, normalized to lowercase. Empty list when none.                  |
| `.issue.assignee`    | string          | Assignee identity. Empty string when absent.                            |
| `.issue.issue_type`  | string          | Tracker-defined type (Bug, Story, Task). Empty string when absent.      |
| `.issue.branch_name` | string          | Tracker-provided branch metadata. Empty string when absent.             |
| `.issue.parent`      | object or nil   | Parent issue reference. `nil` when no parent. Has `.identifier`.        |
| `.issue.comments`    | list or nil     | Comment records. `nil` means not fetched; empty list means no comments. |
| `.issue.blocked_by`  | list of objects | Blocker references. Each has `.id`, `.identifier`, `.state`.            |
| `.issue.created_at`  | string          | ISO-8601 creation timestamp. Empty string when absent.                  |
| `.issue.updated_at`  | string          | ISO-8601 last-update timestamp. Empty string when absent.               |

### `.attempt`

Integer. `0` on the first try, `>= 1` on retries. Use `{{ if .attempt }}` to branch on retries (0 evaluates to false).

### `.run`

| Field                  | Type    | Description                                                 |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `.run.turn_number`     | integer | Current turn number within the session.                     |
| `.run.max_turns`       | integer | Configured maximum turns.                                   |
| `.run.is_continuation` | boolean | `true` on continuation turns (not first turn, not a retry). |

### Template functions

| Function | Usage                              | Result             |
| -------- | ---------------------------------- | ------------------ |
| `toJSON` | `{{ .issue.labels \| toJSON }}`    | `["bug","urgent"]` |
| `join`   | `{{ .issue.labels \| join ", " }}` | `bug, urgent`      |
| `lower`  | `{{ .issue.state \| lower }}`      | `in progress`      |

All standard Go `text/template` actions are available: `if`/`else`, `range`, `with`, `eq`, `ne`, `lt`, `gt`, `len`, `index`, `and`, `or`, `not`.

!!! tip
    Inside `{{ range .issue.labels }}`, the dot (`.`) refers to the current element. Use `{{ $.issue.identifier }}` to access top-level variables from within a range block.

### Template patterns

**First run vs continuation vs retry:**

```
{{ if not .run.is_continuation }}
Start from scratch. Read the spec.
{{ end }}

{{ if .run.is_continuation }}
Resuming turn {{ .run.turn_number }}/{{ .run.max_turns }}.
{{ end }}

{{ if and .attempt (not .run.is_continuation) }}
Retry attempt {{ .attempt }}. Diagnose the previous failure.
{{ end }}
```

**Conditional sections for optional fields:**

```
{{ if .issue.description }}
## Description
{{ .issue.description }}
{{ end }}

{{ if .issue.blocked_by }}
## Blockers
{{ range .issue.blocked_by }}- {{ .identifier }} ({{ .state }})
{{ end }}
{{ end }}
```

---

## Dynamic reload

Sortie watches `WORKFLOW.md` for changes and re-applies configuration without restart. In-flight agent sessions are not affected.

| What reloads                           | When it takes effect                   |
| -------------------------------------- | -------------------------------------- |
| `polling.interval_ms`                  | Next tick.                             |
| `agent.max_concurrent_agents`          | Next dispatch decision.                |
| `agent.max_concurrent_agents_by_state` | Next dispatch decision.                |
| `agent.max_retry_backoff_ms`           | Next retry schedule.                   |
| `agent.max_sessions`                   | Next retry evaluation.                 |
| All other config fields                | Future dispatches and hook executions. |
| `db_path`, `server.port`               | Requires restart.                      |
| Prompt template                        | Future worker attempts.                |

Invalid config after reload does not crash Sortie. It continues with the last valid configuration and logs an error.
