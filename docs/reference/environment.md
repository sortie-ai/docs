---
title: "Environment Variables | Sortie"
description: "Complete reference for every environment variable Sortie reads, injects, or filters. SORTIE_* config overrides, .env file support, agent passthrough, $VAR indirection, hook subprocess environment, and install script variables."
keywords: sortie environment variables, SORTIE_*, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, SORTIE_ISSUE_ID, env var, configuration, .env, overrides, hooks, install, MCP server
author: Sortie AI
---

# Environment variables reference

Sortie supports `SORTIE_*` environment variable overrides for most configuration fields, with optional `.env` file loading. Environment variables flow in six distinct directions — each covered in its own section below.

| Section | Direction | When it matters |
|---|---|---|
| [Configuration overrides](#configuration-overrides) | Parent shell / `.env` file → config fields | Deploying in containers, CI, cloud-native environments |
| [Agent runtime variables](#agent-runtime-variables) | Parent shell → agent subprocess | Before starting Sortie |
| [`$VAR` indirection in WORKFLOW.md](#var-indirection-in-workflowmd) | Parent shell → config fields at startup | Writing the workflow file |
| [Hook subprocess environment](#hook-subprocess-environment) | Sortie → hook subprocess | Writing hook scripts |
| [MCP server environment](#mcp-server-environment) | Worker → `.sortie/mcp.json` → agent runtime → MCP server | Writing custom tools, debugging tool execution |
| [Install script variables](#install-script-variables) | Parent shell → `install.sh` | Installing the binary |

---

## Configuration overrides

Twenty-four `SORTIE_*` environment variables override individual [WORKFLOW.md](workflow-config.md) configuration fields. Set them in the parent shell, in a `.env` file, or both.

### Precedence

Four sources feed configuration, highest priority first:

1. **`SORTIE_*` environment variables** in the real process environment
2. **`.env` file values** (opt-in via `SORTIE_ENV_FILE` or [`--env-file`](cli.md#-env-file))
3. **WORKFLOW.md front matter** YAML
4. **Built-in defaults**

A real env var always beats a `.env` value for the same key. Both beat whatever the YAML says.

### Tracker variables

| Env var | Overrides | Type |
|---|---|---|
| `SORTIE_TRACKER_KIND` | [`tracker.kind`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_ENDPOINT` | [`tracker.endpoint`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_API_KEY` | [`tracker.api_key`](workflow-config.md#tracker) | string (secret — never logged) |
| `SORTIE_TRACKER_PROJECT` | [`tracker.project`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_ACTIVE_STATES` | [`tracker.active_states`](workflow-config.md#tracker) | csv |
| `SORTIE_TRACKER_TERMINAL_STATES` | [`tracker.terminal_states`](workflow-config.md#tracker) | csv |
| `SORTIE_TRACKER_QUERY_FILTER` | [`tracker.query_filter`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_HANDOFF_STATE` | [`tracker.handoff_state`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_IN_PROGRESS_STATE` | [`tracker.in_progress_state`](workflow-config.md#tracker) | string |
| `SORTIE_TRACKER_COMMENTS_ON_DISPATCH` | [`tracker.comments.on_dispatch`](workflow-config.md#tracker-comments) | bool (`true`/`false`/`1`/`0`) |
| `SORTIE_TRACKER_COMMENTS_ON_COMPLETION` | [`tracker.comments.on_completion`](workflow-config.md#tracker-comments) | bool |
| `SORTIE_TRACKER_COMMENTS_ON_FAILURE` | [`tracker.comments.on_failure`](workflow-config.md#tracker-comments) | bool |

### Polling variables

| Env var | Overrides | Type |
|---|---|---|
| `SORTIE_POLLING_INTERVAL_MS` | [`polling.interval_ms`](workflow-config.md#polling) | int |

### Workspace variables

| Env var | Overrides | Type |
|---|---|---|
| `SORTIE_WORKSPACE_ROOT` | [`workspace.root`](workflow-config.md#workspace) | string (path — `~` expanded) |

### Agent variables

| Env var | Overrides | Type |
|---|---|---|
| `SORTIE_AGENT_KIND` | [`agent.kind`](workflow-config.md#agent) | string |
| `SORTIE_AGENT_COMMAND` | [`agent.command`](workflow-config.md#agent) | string |
| `SORTIE_AGENT_TURN_TIMEOUT_MS` | [`agent.turn_timeout_ms`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_READ_TIMEOUT_MS` | [`agent.read_timeout_ms`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_STALL_TIMEOUT_MS` | [`agent.stall_timeout_ms`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_MAX_CONCURRENT_AGENTS` | [`agent.max_concurrent_agents`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_MAX_TURNS` | [`agent.max_turns`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_MAX_RETRY_BACKOFF_MS` | [`agent.max_retry_backoff_ms`](workflow-config.md#agent) | int |
| `SORTIE_AGENT_MAX_SESSIONS` | [`agent.max_sessions`](workflow-config.md#agent) | int |

### Top-level variables

| Env var | Overrides | Type |
|---|---|---|
| `SORTIE_DB_PATH` | [`db_path`](workflow-config.md#db_path) | string (path — `~` expanded) |

### Control variables

These are not config field overrides. They control how overrides are loaded.

| Env var | Purpose | Type |
|---|---|---|
| `SORTIE_ENV_FILE` | Path to a `.env` file containing `SORTIE_*` overrides | string |

When [`--env-file`](cli.md#-env-file) is provided, the CLI resolves the path to absolute and exports it as `SORTIE_ENV_FILE` in the process environment. This ensures the value is captured by `CollectSortieEnv` and propagated to the MCP server, which runs in a different working directory and needs the absolute path to locate the `.env` file. When both `SORTIE_ENV_FILE` and `--env-file` are set, the CLI flag wins.

### Type coercion

| Type | Rule | Error behavior |
|---|---|---|
| string | Used as-is | — |
| int | Parsed via `strconv.Atoi`. Leading/trailing whitespace trimmed. | Startup error: `config: polling.interval_ms: invalid integer value: abc (from SORTIE_POLLING_INTERVAL_MS)` |
| bool | Accepts `true`, `false`, `1`, `0` (case-insensitive) | Startup error naming the env var and rejected value |
| csv | Comma-separated. Items trimmed. Empty items discarded. Empty string produces an empty list. | — |

### Fields not overridable via env

| Field | Reason |
|---|---|
| `hooks.*` (all hook scripts) | Multiline shell scripts do not fit in a single env var |
| `hooks.timeout_ms` | Grouped with hooks for consistency |
| `agent.max_concurrent_agents_by_state` | Complex map structure (`{"in progress": 3, "to do": 1}`) |
| Extension sections (`server`, `worker`, `claude-code`, etc.) | Plugin-owned configuration; overrides belong to the adapter |
| `logging.level` | Controlled by the [`--log-level`](cli.md#-log-level) CLI flag |

### `.env` file support

Loading a `.env` file is opt-in.

!!! warning
    Sortie does not auto-discover `.env` files in the working directory. Its working directory is the WORKFLOW.md location, and a `.env` file placed there could silently alter behavior for any operator who runs `sortie` from that directory. Always load `.env` explicitly via `SORTIE_ENV_FILE` or `--env-file`.

Enable `.env` loading with either:

```sh
# Via environment variable
export SORTIE_ENV_FILE=/etc/sortie/prod.env
sortie WORKFLOW.md

# Via CLI flag (takes precedence over the env var)
sortie --env-file /etc/sortie/prod.env WORKFLOW.md
```

**File format:**

```sh
# /etc/sortie/jira.env
# Comments start with #. Blank lines are ignored.

SORTIE_TRACKER_KIND=jira
SORTIE_TRACKER_ENDPOINT=https://myco.atlassian.net
SORTIE_TRACKER_API_KEY="you@company.com:xpat_abc123def456"
SORTIE_TRACKER_PROJECT=PLATFORM
SORTIE_POLLING_INTERVAL_MS=30000
SORTIE_WORKSPACE_ROOT=~/workspace/sortie
```

GitHub adapter equivalent:

```sh
# /etc/sortie/github.env
SORTIE_TRACKER_KIND=github
SORTIE_TRACKER_API_KEY="ghp_your_personal_access_token"
SORTIE_TRACKER_PROJECT=myorg/myrepo
SORTIE_POLLING_INTERVAL_MS=30000
SORTIE_WORKSPACE_ROOT=~/workspace/sortie
```

Rules:

- One `KEY=VALUE` per line. No multiline values.
- `#` lines and blank lines are ignored.
- Optional single or double quotes around values — outer quotes are stripped, no escape processing.
- Only keys starting with `SORTIE_` are loaded. All other keys are silently ignored.
- No variable interpolation within values. `$HOME` in a `.env` value is the literal string `$HOME`.
- Real environment variables always take precedence over `.env` values.
- The `.env` file is re-read on every WORKFLOW.md reload (file change detection). Real env vars require a process restart to change.

### CSV encoding for list fields

`active_states` and `terminal_states` accept comma-separated values:

```sh
SORTIE_TRACKER_ACTIVE_STATES="To Do,In Progress"
SORTIE_TRACKER_TERMINAL_STATES="Done,Won't Do"
```

Each item is trimmed of surrounding whitespace. Empty items (from trailing commas or double commas) are discarded. An empty string produces an empty list.

### Interaction with `$VAR` indirection

When a `SORTIE_*` override is set for a field, it replaces the YAML value entirely. The [`$VAR` expansion](#var-indirection-in-workflowmd) that would normally run on the YAML value is skipped for that field. Values from env overrides are literal — `$` characters are not expanded.

Example: WORKFLOW.md has `api_key: $MY_TOKEN`. If `SORTIE_TRACKER_API_KEY=tok$5abc` is set, the `api_key` becomes the literal string `tok$5abc`. The `$MY_TOKEN` indirection never executes. The `$5` is not expanded.

Path fields (`workspace.root`, `db_path`) still receive `~` expansion even when set via env overrides. Only `$VAR` expansion is skipped.

---

## Agent runtime variables

Agent adapters spawn subprocesses that inherit the **full** parent process environment. Sortie itself does not read or validate these variables — they pass straight through. If one is missing, the agent subprocess fails, not Sortie.

| Variable | Required by | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `claude-code` adapter (Anthropic direct) | API key for the Anthropic API. The Claude Code CLI reads this on startup. Missing or invalid values cause an authentication error in the agent subprocess. |
| `CLAUDE_CODE_USE_BEDROCK` | `claude-code` adapter (AWS Bedrock) | Set to `1` to route Claude Code through AWS Bedrock instead of the direct API. |
| `AWS_ACCESS_KEY_ID` | `claude-code` adapter (AWS Bedrock) | AWS access key. Required when `CLAUDE_CODE_USE_BEDROCK=1`. |
| `AWS_SECRET_ACCESS_KEY` | `claude-code` adapter (AWS Bedrock) | AWS secret key. Required when `CLAUDE_CODE_USE_BEDROCK=1`. |
| `AWS_REGION` | `claude-code` adapter (AWS Bedrock) | AWS region for Bedrock inference. Required when `CLAUDE_CODE_USE_BEDROCK=1`. |
| `CLAUDE_CODE_USE_VERTEX` | `claude-code` adapter (Google Vertex AI) | Set to `1` to route Claude Code through Google Vertex AI. |
| `ANTHROPIC_VERTEX_PROJECT_ID` | `claude-code` adapter (Google Vertex AI) | GCP project ID. Required when `CLAUDE_CODE_USE_VERTEX=1`. |
| `CLOUD_ML_REGION` | `claude-code` adapter (Google Vertex AI) | GCP region. Required when `CLAUDE_CODE_USE_VERTEX=1`. |
| `ANTHROPIC_BASE_URL` | `claude-code` adapter (proxy) | Override the Anthropic API base URL. Use for LiteLLM, custom gateways, or corporate proxies. |
| `COPILOT_GITHUB_TOKEN` | `copilot-cli` adapter | GitHub token dedicated to Copilot CLI. Highest priority among the three token variables the CLI checks. |
| `GH_TOKEN` | `copilot-cli` adapter | GitHub token shared with the `gh` CLI. Second priority for Copilot CLI authentication. Also used by many GitHub tooling integrations. |
| `GITHUB_TOKEN` | `copilot-cli` adapter | GitHub token common in CI environments. Third priority for Copilot CLI authentication. |

**A missing `ANTHROPIC_API_KEY` is the most common `claude-code` deployment failure.** Sortie starts and polls the tracker normally, but every agent session fails at launch with an auth error. The Sortie logs show a worker exit with `exit_type=error`; the root cause is only visible in the agent's stderr output.

**For `copilot-cli`, a missing GitHub token is the equivalent failure.** The adapter's preflight check validates that at least one of `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` is set, or that `gh auth status` succeeds. If none are available, `StartSession` fails with `agent_not_found`. The Copilot CLI itself implements try-and-fallback across these three variables — precedence matters only when multiple sources hold different valid tokens.

!!! warning "Classic PATs do not work with Copilot CLI"
    Copilot CLI requires a **fine-grained personal access token** (prefix `github_pat_`) with the **Copilot Requests** permission enabled. Classic PATs (prefix `ghp_`) fail authentication silently — the CLI falls through all three token variables and reports no valid credential. OAuth tokens (`gho_` from `copilot auth login`) and GitHub App user-to-server tokens (`ghu_`) also work. If you see authentication failures despite having a token set, check the token prefix.

---

## `$VAR` indirection in WORKFLOW.md

Selected [WORKFLOW.md configuration](workflow-config.md) fields resolve environment variable references at startup. This keeps secrets and deployment-specific values out of the workflow file.

When a field is overridden by a `SORTIE_*` environment variable, `$VAR` indirection is skipped for that field. See [Configuration overrides](#configuration-overrides).

### Expansion modes

Two expansion functions exist. The mode depends on the field.

**`resolveEnvRef`** — Expands only when the **entire** trimmed value is a variable reference (`$VAR` or `${VAR}`). Mixed content like `https://example.com/$VAR` is returned unchanged, preventing destructive rewriting of URIs and paths.

**`resolveEnv`** — Full `os.ExpandEnv` semantics. Expands `$VAR` and `${VAR}` references **anywhere** in the string, including within larger values.

**`expandPath`** — Expands `~` or `~/` at the start of the value to the user's home directory, then applies full `os.ExpandEnv`.

### Fields with `$VAR` support

| Field | Expansion mode | Example value | Resolves to |
|---|---|---|---|
| `tracker.endpoint` | `resolveEnvRef` | `$SORTIE_JIRA_ENDPOINT` | `https://myco.atlassian.net` |
| `tracker.api_key` | `resolveEnv` | `user@example.com:$SORTIE_JIRA_API_KEY` | `user@example.com:xyztoken123` |
| `tracker.project` | `resolveEnvRef` | `$SORTIE_JIRA_PROJECT` | `PLATFORM` |
| `tracker.query_filter` | `resolveEnvRef` | `$SORTIE_JIRA_QUERY_FILTER` | `labels = 'agent-ready'` |
| `tracker.handoff_state` | `resolveEnvRef` | `$SORTIE_HANDOFF_STATE` | `Human Review` |
| `workspace.root` | `expandPath` | `~/workspace/sortie` | `/home/deploy/workspace/sortie` |
| `db_path` | `expandPath` | `$SORTIE_DB_DIR/sortie.db` | `/var/lib/sortie/sortie.db` |

All other fields (including `agent.kind`, `agent.max_turns`, hook scripts, etc.) are treated as literal strings with no expansion.

The variable names in the table are user-defined conventions, not Sortie-internal identifiers. For the GitHub adapter, common conventions are `$SORTIE_GITHUB_TOKEN` or `$GITHUB_TOKEN` for `tracker.api_key` (a plain personal access token, **not** `email:token` format) and `$SORTIE_GITHUB_PROJECT` for `tracker.project` (an `owner/repo` string). See the [GitHub adapter reference](adapter-github.md#configuration) for per-field semantics.

### Behavior when a variable is unset or empty

| Scenario | Behavior |
|---|---|
| `$VAR` resolves to an empty string | The field is treated as missing. For required fields (e.g., `tracker.api_key` when the adapter declares it required), this is a startup error. |
| The referenced variable does not exist in the environment | Same as empty — `os.ExpandEnv` returns `""` for undefined variables. |
| `tracker.handoff_state` resolves to empty | Startup error: `config: tracker.handoff_state: resolved to empty (check environment variable)`. |
| `db_path` resolves to empty | Startup error: `config: db_path: resolved to empty (check environment variable)`. |

### What this is not

`$VAR` indirection is **not** general shell expansion. It does not support:

- Command substitution (`$(command)` or `` `command` ``)
- Arithmetic expansion (`$((1+2))`)
- Default values (`${VAR:-default}`)
- Glob expansion (`*`, `?`)

Only the Go standard library `os.ExpandEnv` function is used. See the [Go documentation](https://pkg.go.dev/os#ExpandEnv) for exact semantics.

---

## Hook subprocess environment

Hook scripts (`after_create`, `before_run`, `after_run`, `before_remove`) run as `sh -c` subprocesses with a **restricted** environment. The full parent process environment is not inherited.

### Injected variables

Sortie injects these variables into every hook invocation. They override any same-named variable from the parent environment.

| Variable | Type | Description |
|---|---|---|
| `SORTIE_ISSUE_ID` | string | Stable tracker-internal issue ID. |
| `SORTIE_ISSUE_IDENTIFIER` | string | Human-readable ticket key (e.g., `PROJ-123`). |
| `SORTIE_WORKSPACE` | string | Absolute path to the per-issue workspace directory. Always the same as the hook's working directory. |
| `SORTIE_ATTEMPT` | string | Current attempt number as a decimal integer. Starts at `1`. Increments on retries. `0` if the attempt count is unavailable. |
| `SORTIE_SSH_HOST` | string | SSH host allocated for this issue. **Present only when SSH mode is active** ([`extensions.worker.ssh_hosts`](workflow-config.md) is configured and a host was assigned). Absent in local mode. |

### Inherited variables

Beyond the injected variables above, hooks inherit two categories from the parent Sortie process:

**POSIX allowlist** — A fixed set of standard infrastructure variables:

`PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`

**`SORTIE_*` prefix** — All parent environment variables whose names start with `SORTIE_` are inherited. This includes any `SORTIE_*` variables set via [configuration overrides](#configuration-overrides). This is the intended mechanism for passing additional values (API tokens, repository URLs, custom flags) into hooks without exposing the full process environment.

### Stripped variables

Everything not in the allowlist and not prefixed with `SORTIE_` is **stripped**. This includes:

- Cloud credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`
- API tokens: `JIRA_API_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`
- Application config: `DATABASE_URL`, `REDIS_URL`, etc.

This is a security boundary. Hooks run user-authored shell scripts; restricting their environment limits the blast radius of a compromised or buggy hook.

### Providing additional values to hooks

Two approaches:

1. **`SORTIE_`-prefixed variables.** Export the value with a `SORTIE_` prefix in the parent environment. It passes through automatically.

    ```sh
    export SORTIE_JIRA_API_TOKEN="xyztoken123"
    export SORTIE_REPO_URL="git@github.com:myorg/myrepo.git"
    sortie WORKFLOW.md
    ```

    Inside the hook:

    ```sh
    git clone "$SORTIE_REPO_URL" .
    ```

2. **In-hook credential loading.** Fetch credentials from external sources inside the script.

    ```sh
    source /etc/sortie/hooks-env
    aws sts get-caller-identity
    ```

### Override precedence

When the same variable name exists in both the parent environment (via `SORTIE_*` passthrough) and the injected set, the **injected value wins**. For example, a parent `SORTIE_ISSUE_ID=stale` is overwritten by the orchestrator's current `SORTIE_ISSUE_ID` for the active issue.

---

## MCP server environment

The MCP tool server (`sortie mcp-server`) runs as a child process of the agent runtime, not of the Sortie orchestrator. The agent runtime constructs the MCP server's environment exclusively from the `env` field in `.sortie/mcp.json` — variables not listed in that block do not reach the server. The worker writes per-session context variables and all `SORTIE_*`-prefixed process environment variables into this block before launching the agent.

### Environment composition

The `env` block is built in two layers:

1. **`SORTIE_*` process variables** (lower precedence). The worker scans the orchestrator's process environment and collects every variable whose name starts with `SORTIE_`. This captures credential variables (e.g., `SORTIE_TRACKER_API_KEY`), configuration overrides (e.g., `SORTIE_POLLING_INTERVAL_MS`), and any operator-defined `SORTIE_*` values.

2. **Per-session variables** (higher precedence). The worker writes these six variables, overriding any same-named key from layer 1:

| Variable | Type | Description |
|---|---|---|
| `SORTIE_ISSUE_ID` | string | Tracker-internal issue ID. Scopes tool operations to the current issue. |
| `SORTIE_ISSUE_IDENTIFIER` | string | Human-readable ticket key (e.g., `PROJ-123`). Used by `tracker_api` for project-level scoping. |
| `SORTIE_WORKSPACE` | string | Absolute path to the per-issue workspace directory. |
| `SORTIE_DB_PATH` | string | Absolute path to the Sortie SQLite database. The MCP server opens this in read-only mode for Tier 1 tools that query run history (e.g., `workspace_history`). This is the same resolved path that the orchestrator uses — if you set `SORTIE_DB_PATH` as a [configuration override](#configuration-overrides), the MCP server receives that same value. |
| `SORTIE_SESSION_ID` | string | Opaque session identifier for the current worker run. Used by tools that query session-specific data. |
| `SORTIE_ATTEMPT` | string | Current retry attempt number as a decimal integer. Written when the orchestrator has attempt information (retries and continuations). Absent on the very first dispatch. Starts at `1` for the first retry and increments on subsequent retries. |

Per-session variables always win. A stale `SORTIE_ISSUE_ID` in the process environment is overwritten by the orchestrator's value for the active issue.

### Credential delivery

Tier 2 tools (like `tracker_api`) need tracker API credentials. These reach the MCP server through the `env` block: the worker's process environment contains credential variables (e.g., `SORTIE_TRACKER_API_KEY`), the `SORTIE_*` prefix scan collects them, and the worker writes them into `.sortie/mcp.json`. The MCP server's config parser (`applyEnvOverrides`) resolves `$VAR` indirection in the workflow file against these variables.

When the operator uses [`--env-file`](cli.md#-env-file), the CLI exports the resolved absolute path as `SORTIE_ENV_FILE` in the process environment. The prefix scan captures this variable, so the MCP server receives the `.env` file path and can load it through its own `applyEnvOverrides` mechanism.

The `.sortie/mcp.json` file is written with `0o600` permissions (owner read/write only) and resides within the per-issue workspace directory. The credential is already available to the agent subprocess via `os.Environ()` — writing it to the config file does not expand the agent's access.

### Controlled environment

Unlike the [hook subprocess environment](#hook-subprocess-environment), which uses a POSIX allowlist plus `SORTIE_*` prefix filter on the parent process, the MCP server receives its environment entirely from the config file's `env` block. Non-`SORTIE_*` variables from the orchestrator's process (e.g., `PATH`, `HOME`, `ANTHROPIC_API_KEY`) are not passed to the MCP server. The `SORTIE_*` prefix acts as a bounded namespace — no non-Sortie secrets leak into the config file.

### Relationship to hook variables

Four per-session variables (`SORTIE_ISSUE_ID`, `SORTIE_ISSUE_IDENTIFIER`, `SORTIE_WORKSPACE`, `SORTIE_ATTEMPT`) are shared with the [hook subprocess environment](#hook-subprocess-environment). `SORTIE_DB_PATH` and `SORTIE_SESSION_ID` are specific to the MCP execution channel — hooks don't receive them. In hooks, `SORTIE_ATTEMPT` is always present (defaulting to `0` on the first dispatch). In the MCP env block, `SORTIE_ATTEMPT` is written only when the orchestrator has attempt information (retries and continuations); on the very first dispatch it is absent from the per-session set, though it may still appear if the operator's process environment contains a `SORTIE_ATTEMPT` variable captured by the `SORTIE_*` prefix scan.

---

## Install script variables

The [`install.sh`](https://get.sortie-ai.com/install.sh) script accepts three environment variables that control installation behavior.

| Variable | Default | Description |
|---|---|---|
| `SORTIE_VERSION` | Latest GitHub release | Pin a specific release tag (e.g., `1.3.0`). When set, the script skips the GitHub API call to discover the latest version. |
| `SORTIE_INSTALL_DIR` | `/usr/local/bin` (root) or `~/.local/bin` (non-root) | Override the directory where the `sortie` binary is placed. |
| `SORTIE_NO_VERIFY` | `0` | Set to `1` to skip SHA-256 checksum verification of the downloaded binary. |

Example:

```sh
SORTIE_VERSION=1.3.0 SORTIE_INSTALL_DIR=/opt/bin \
  curl -sSL https://get.sortie-ai.com/install.sh | sh
```

---

## See also

- [WORKFLOW.md configuration reference](workflow-config.md) — all configuration fields, defaults, and types
- [CLI reference](cli.md) — command-line flags (including [`--env-file`](cli.md#-env-file)) and exit codes
- [Agent extensions reference](agent-extensions.md) — tool schemas, MCP execution channel, and response formats
- [Prometheus metrics reference](prometheus-metrics.md) — `sortie_*` metric names (these are Prometheus metrics, not environment variables)
