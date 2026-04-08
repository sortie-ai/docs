---
title: "Claude Code Adapter"
description: "Complete reference for the Claude Code agent adapter: configuration, session lifecycle, CLI argument mapping, JSONL event stream, token accounting, error handling, SSH remote execution, and authentication."
keywords: sortie claude code adapter, claude-code, agent adapter, JSONL, session lifecycle, permission mode, max turns, token usage, SSH, ANTHROPIC_API_KEY
author: Sortie AI
date: 2026-03-28
weight: 10
url: /reference/adapter-claude-code/
---

# Claude Code adapter reference

The Claude Code adapter connects Sortie to the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) via subprocess management. It launches Claude Code in headless mode with `--output-format stream-json`, reads newline-delimited JSON (JSONL) from stdout, and normalizes events into domain types. Registered under kind `"claude-code"`.

Each `RunTurn` call spawns an independent subprocess. The adapter is safe for concurrent use: one adapter instance serves all sessions, with per-session state held in an opaque internal handle.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/#agent-runtime-variables) for `ANTHROPIC_API_KEY` and provider routing, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `claude-code` extension block (pass-through to the Claude Code CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Claude Code CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | `claude-code` | Must be `"claude-code"` to select this adapter. |
| `command` | string | `claude` | Path or name of the Claude Code binary. Resolved via `exec.LookPath` at session start. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator calls `RunTurn` up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single `RunTurn` call. The orchestrator cancels the turn context when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the session as stalled. `0` or negative disables stall detection. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: claude-code
  command: claude
  max_turns: 5
  max_sessions: 3
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
```

### `claude-code` extension section

These fields are adapter-specific. The orchestrator forwards them to the adapter without validation. Each field maps to a Claude Code CLI flag.

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `permission_mode` | `--permission-mode` | string | _(see below)_ | Permission behavior for tool calls. Values: `default`, `acceptEdits`, `bypassPermissions`. |
| `model` | `--model` | string | _(CLI default)_ | LLM model identifier (e.g., `claude-sonnet-4-20250514`). |
| `fallback_model` | `--fallback-model` | string | _(none)_ | Fallback model used when the primary model is unavailable. |
| `max_turns` | `--max-turns` | integer | _(CLI default)_ | Claude Code's internal agentic turn budget per invocation. |
| `max_budget_usd` | `--max-budget-usd` | number | _(none)_ | Per-session cost cap in USD. Claude Code stops when the cumulative API cost reaches this amount. |
| `effort` | `--effort` | string | _(CLI default)_ | Inference effort level. Values: `low`, `medium`, `high`. |
| `allowed_tools` | `--allowedTools` | string | _(none)_ | Comma-separated list of tools the agent is allowed to use. |
| `disallowed_tools` | `--disallowedTools` | string | _(none)_ | Comma-separated list of tools the agent is blocked from using. |
| `system_prompt` | `--append-system-prompt` | string | _(none)_ | Additional text appended to Claude Code's system prompt. |
| `mcp_config` | `--mcp-config` | string | _(none)_ | Path to an MCP server configuration file. |
| `session_persistence` | `--no-session-persistence` | boolean | `true` | Whether Claude Code persists session history to disk. When `false`, the flag `--no-session-persistence` is passed. |

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  fallback_model: claude-sonnet-4-20250514
  max_turns: 50
  max_budget_usd: 5
  effort: high
  allowed_tools: "Edit,Write,Bash"
  mcp_config: ./mcp-servers.json
```

### `agent.max_turns` vs. `claude-code.max_turns`

These two fields have the same name but control different systems.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator invokes `RunTurn` per worker session. |
| `claude-code.max_turns` | Claude Code's internal agentic loop | How many agentic steps Claude Code takes within a single `RunTurn` invocation. |

With `agent.max_turns: 5` and `claude-code.max_turns: 50`, the orchestrator runs up to 5 turns. Within each turn, Claude Code takes up to 50 agentic steps. The total agentic step budget per session is at most 250.

Setting `claude-code.max_turns` too low causes Claude Code to exit mid-task. Setting `agent.max_turns` too low causes the orchestrator to stop re-invoking the agent before the issue is resolved.

### Permission mode

When `permission_mode` is absent, the adapter passes `--dangerously-skip-permissions` as a legacy fallback. This flag is deprecated by the Claude Code CLI.

| Value | Behavior |
|---|---|
| `default` | Claude Code prompts for approval on each tool call. Incompatible with headless operation — the session stalls until the orchestrator's stall timeout kills it. |
| `acceptEdits` | Auto-approves file edits. Prompts for other tool calls (shell commands, MCP tools). |
| `bypassPermissions` | Auto-approves all tool calls without prompting. Required for unattended operation. |

For autonomous workflows, set `permission_mode: bypassPermissions` explicitly.

---

## Session lifecycle

### `StartSession`

Validates the workspace path and resolves the agent binary. No subprocess is spawned.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` via `exec.LookPath`. In SSH mode, resolves the local `ssh` binary instead; the agent command resolves on the remote host.
3. Generates a v4 UUID session ID (or adopts the `ResumeSessionID` for continuation sessions).
4. Returns an opaque `Session` handle containing workspace path, resolved binary, session ID, and SSH configuration.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

### `RunTurn`

Spawns a Claude Code subprocess, reads JSONL events from stdout, and delivers normalized events via the `OnEvent` callback.

1. Builds the CLI argument list from session state and pass-through configuration.
2. Spawns the subprocess with `exec.Command` (not `exec.CommandContext` — see [process shutdown](#process-shutdown) for rationale).
3. Sets `cmd.Dir` to the workspace path and `cmd.Env` to the full parent process environment.
4. Reads stdout line by line via a buffered scanner (64 KB initial buffer, 10 MB max line).
5. Parses each line as JSON and dispatches to the appropriate event handler.
6. After stdout closes, calls `cmd.Wait` to collect the exit status.
7. Returns a `TurnResult` with the session ID, exit reason, and cumulative token usage.

**Session management flags:**

| Condition | CLI flag |
|---|---|
| First turn of a new session | `--session-id <UUID>` |
| Subsequent turns and continuation sessions | `--resume <UUID>` |

Every invocation includes `--output-format stream-json` and `--verbose`.

### `StopSession`

Terminates a running subprocess. Safe to call when no subprocess is active.

1. Sends `SIGTERM` to the subprocess.
2. Waits up to 5 seconds for the process to exit.
3. Sends `SIGKILL` if the process has not exited.

### `EventStream`

Returns `nil`. The adapter delivers all events synchronously through the `OnEvent` callback in `RunTurn`.

---

## Process shutdown

The adapter uses `exec.Command` instead of `exec.CommandContext`. This is intentional.

`exec.CommandContext` sends `SIGKILL` on context cancellation by default. `SIGKILL` is immediate and untrappable — the agent process cannot flush output buffers, close network connections, or emit final token-usage events. The adapter sends `SIGTERM` first and escalates to `SIGKILL` after 5 seconds, preserving the agent's opportunity for a clean exit.

A dedicated goroutine monitors `ctx.Done()` and calls the graceful-kill sequence when the context is cancelled. This covers both orchestrator-initiated cancellation (reconciliation kill, stall detection) and shutdown signals.

---

## JSONL event stream

Claude Code emits one JSON object per line on stdout when invoked with `--output-format stream-json`. The adapter parses each line and maps it to a normalized domain event.

### Event type mapping

| Claude Code event | Subtype / condition | Domain event type | Notes |
|---|---|---|---|
| `system` | `init` | `session_started` | Captures `session_id` from the payload. |
| `system` | `api_retry` | `notification` | Formats retry metadata (attempt, delay, status). |
| `system` | _(other)_ | `notification` | Generic system notification. |
| `assistant` | — | `notification` | Summarizes content blocks (text, tool_use). |
| `assistant` | _(with usage)_ | `token_usage` | Emits cumulative token counts and model identifier. |
| `assistant` | _(with tool_use block)_ | `tool_result` | Records tool name, duration, and error status. |
| `user` | _(tool_result blocks)_ | `tool_result` | Correlates with in-flight `tool_use` blocks for duration. |
| `result` | `subtype=success`, `is_error=false` | `turn_completed` | Successful turn completion. |
| `result` | `subtype≠success` or `is_error=true` | `turn_failed` | Agent-reported failure. |
| `stream_event` | — | `notification` | Heartbeat event with no payload. |
| _(parse failure)_ | — | `malformed` | Unparseable JSONL line, truncated to 500 characters. |

### Result event fields

The `result` event carries turn-level metadata:

| Field | Type | Description |
|---|---|---|
| `result` | string | Final text output from the agent. |
| `is_error` | boolean | `true` when the agent reported a failure. |
| `subtype` | string | `"success"` on normal completion. |
| `total_cost_usd` | number | Cumulative API cost for the session. |
| `duration_ms` | integer | Wall-clock turn duration in milliseconds. |
| `duration_api_ms` | integer | Aggregate API response wait time in milliseconds. |
| `num_turns` | integer | Number of agentic steps taken in this turn. |
| `usage` | object | Token counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. |

---

## Token accounting

The adapter accumulates token counts across all `assistant` messages within a turn, because Claude Code reports per-request usage (not cumulative). The orchestrator expects cumulative values for its delta algorithm.

### Accumulation logic

1. Each `assistant` event with a `usage` field increments the running totals for `input_tokens`, `output_tokens`, and `cache_read_input_tokens`.
2. `total_tokens` is computed as `input_tokens + output_tokens`.
3. The cumulative totals are emitted as a `token_usage` event after each `assistant` message.
4. If no per-message usage was emitted during the turn, the `result` event's usage serves as the fallback. This avoids inflating the orchestrator's API request counter.

### Model tracking

The `model` field from `assistant` events (e.g., `claude-sonnet-4-20250514`) is captured and included in `token_usage` events. The orchestrator uses this for per-model cost attribution.

### API timing

The adapter measures wall-clock time between events to estimate per-request API latency:

- A monotonic timer starts after `system/init` (first API call) and after each `user` event (subsequent API calls).
- The timer stops when the next `assistant` event with usage data arrives.
- The measured duration is emitted in `APIDurationMS` on the `token_usage` event.
- If per-request timing is available, the turn-level `duration_api_ms` from the `result` event is not re-emitted to avoid double-counting.

---

## Tool call tracking

The adapter observes tool execution by correlating `tool_use` and `tool_result` content blocks.

### Correlation

1. An `assistant` message containing a `tool_use` block records the tool name and a monotonic timestamp in an in-flight map, keyed by the block's `id`.
2. A `user` message containing a `tool_result` block looks up the matching `tool_use_id` in the in-flight map.
3. When a match is found, the adapter emits a `tool_result` event with `ToolName`, `ToolDurationMS` (elapsed since the `tool_use` timestamp), and `ToolError` (from the `is_error` field on the content block).

### Tool error formatting

When a `tool_result` carries `is_error: true`, the adapter extracts the error text and applies three transformations:

1. **XML stripping:** If the text is wrapped in `<tool_use_error>...</tool_use_error>`, the envelope is removed.
2. **ANSI stripping:** VT100/ANSI SGR escape sequences (color codes, formatting) are removed for clean log output.
3. **Truncation:** Error text exceeding 2048 bytes is truncated to the first line plus the last bytes of the remaining output. This preserves both the exit-code header and CLI failure lines at the tail.

---

## Error handling

### Exit code mapping

| Exit code | Error kind | Description |
|---|---|---|
| `0` (no result event) | _(none)_ | Treated as success. |
| `0` (result: `success`) | _(none)_ | Normal completion. |
| `0` (result: `is_error` or subtype ≠ `success`) | `turn_failed` | Agent-reported failure despite clean exit. |
| `127` | `agent_not_found` | Binary not found on local or remote host. |
| Non-zero (non-127) | `port_exit` | Unexpected subprocess exit. |
| Signal termination | `turn_cancelled` | Process killed by signal (SIGTERM/SIGKILL). |
| Context cancelled | `turn_cancelled` | Orchestrator cancelled the turn. |

### Stdout scanner failure

If the stdout scanner encounters an error (buffer overflow, broken pipe), the adapter:

1. Sends a graceful-kill signal to the subprocess.
2. Waits for exit.
3. Returns a `turn_failed` result with error kind `port_exit`.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches Claude Code on a remote host via SSH instead of locally.

### How it works

1. `StartSession` resolves the local `ssh` binary via `exec.LookPath`. The agent command is stored for remote execution rather than resolved locally.
2. `RunTurn` builds an SSH command that wraps the remote Claude Code invocation.
3. The remote command is: `cd '<workspace_path>' && '<agent_command>' <args...>`

### SSH options

The adapter uses these SSH options:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | `accept-new` | Auto-accepts new host keys, rejects changed keys. |
| `BatchMode` | `yes` | Disables interactive prompts (password, passphrase). |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### Shell quoting

All arguments in the remote command string are single-quoted with embedded single-quote escaping (the standard POSIX `'\''` pattern). This prevents injection when SSH passes the remote command through the remote shell.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

Sortie does not manage Claude Code's API credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and Claude Code reads its authentication variables directly.

The required variable depends on the API provider:

| Provider | Required variables |
|---|---|
| Anthropic direct | `ANTHROPIC_API_KEY` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` |
| Custom proxy | `ANTHROPIC_BASE_URL` (optionally with `ANTHROPIC_API_KEY`) |

See [environment variables reference](/reference/environment/#agent-runtime-variables) for the full list.

A missing `ANTHROPIC_API_KEY` is the most common deployment failure. Sortie starts and dispatches workers normally, but every agent session fails at launch. The failure is visible in Sortie's logs as a worker exit with `exit_type=error`.

---

## Concurrency safety

The adapter is safe for concurrent use. One `ClaudeCodeAdapter` instance serves all sessions. Per-session state (workspace path, session ID, process handle) is isolated in the opaque `Session.Internal` field. A mutex guards the subprocess handle for concurrent access from `StopSession` and the graceful-kill goroutine.

No adapter-level serialization is needed for `RunTurn` calls — each spawns an independent subprocess with its own stdout pipe and scanner.

---

## Adapter registration

The adapter registers itself under kind `"claude-code"` via an `init` function in `internal/agent/claude`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |

The orchestrator's preflight validation uses this to produce a specific error message if the binary cannot be found before attempting session creation.

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) — full `agent` schema and `claude-code` extension block
- [Environment variables reference](/reference/environment/#agent-runtime-variables) — `ANTHROPIC_API_KEY`, Bedrock, Vertex AI, and proxy variables
- [Error reference](/reference/errors/#agent-errors) — all agent error kinds with retry behavior
- [How to write a prompt template](/guides/write-prompt-template/) — template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) — remote execution setup and host pool configuration
- [How to use the file adapter for local testing](/guides/use-file-adapter-for-testing/) — test prompts without a live tracker
- [State machine reference](/reference/state-machine/) — orchestration states, turn lifecycle, and stall detection
- [Dashboard reference](/reference/dashboard/) — live monitoring of running sessions and token usage
- [Prometheus metrics reference](/reference/prometheus-metrics/) — `sortie_agent_turns_total` and related counters
- [Agent extensions reference](/reference/agent-extensions/) — `tracker_api` tool available during agent sessions
