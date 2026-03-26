---
title: "Environment Variables | Sortie"
description: "Complete reference for every environment variable Sortie reads, injects, or filters. Agent passthrough, $VAR indirection, hook subprocess environment, and install script variables."
keywords: sortie environment variables, ANTHROPIC_API_KEY, SORTIE_ISSUE_ID, env var, configuration, hooks, install
author: Sortie AI
---

# Environment variables reference

Sortie does not use a `.env` file or a dedicated environment configuration block. Environment variables flow in four distinct directions — each covered in its own section below.

| Section | Direction | When it matters |
|---|---|---|
| [Agent runtime variables](#agent-runtime-variables) | Parent shell → agent subprocess | Before starting Sortie |
| [`$VAR` indirection in WORKFLOW.md](#var-indirection-in-workflowmd) | Parent shell → config fields at startup | Writing the workflow file |
| [Hook subprocess environment](#hook-subprocess-environment) | Sortie → hook subprocess | Writing hook scripts |
| [Install script variables](#install-script-variables) | Parent shell → `install.sh` | Installing the binary |

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

**A missing `ANTHROPIC_API_KEY` is the most common deployment failure.** Sortie starts and polls the tracker normally, but every agent session fails at launch with an auth error. The Sortie logs show a worker exit with `exit_type=error`; the root cause is only visible in the agent's stderr output.

Future agent adapters (Copilot CLI, Gemini CLI, etc.) will require their own authentication variables. This table will expand as adapters are added.

---

## `$VAR` indirection in WORKFLOW.md

Selected [WORKFLOW.md configuration](workflow-config.md) fields resolve environment variable references at startup. This keeps secrets and deployment-specific values out of the workflow file.

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

**`SORTIE_*` prefix** — All parent environment variables whose names start with `SORTIE_` are inherited. This is the intended mechanism for passing additional values (API tokens, repository URLs, custom flags) into hooks without exposing the full process environment.

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

## Install script variables

The [`install.sh`](https://get.sortie-ai.com/install.sh) script accepts three environment variables that control installation behavior.

| Variable | Default | Description |
|---|---|---|
| `SORTIE_VERSION` | Latest GitHub release | Pin a specific release tag (e.g., `1.0.0` or `0.0.7`). When set, the script skips the GitHub API call to discover the latest version. |
| `SORTIE_INSTALL_DIR` | `/usr/local/bin` (root) or `~/.local/bin` (non-root) | Override the directory where the `sortie` binary is placed. |
| `SORTIE_NO_VERIFY` | `0` | Set to `1` to skip SHA-256 checksum verification of the downloaded binary. |

Example:

```sh
SORTIE_VERSION=0.8.0 SORTIE_INSTALL_DIR=/opt/bin \
  curl -sSL https://get.sortie-ai.com/install.sh | sh
```

---

## See also

- [WORKFLOW.md configuration reference](workflow-config.md) — all configuration fields, defaults, and types
- [CLI reference](cli.md) — command-line flags and exit codes
- [Prometheus metrics reference](prometheus-metrics.md) — `sortie_*` metric names (these are Prometheus metrics, not environment variables)
