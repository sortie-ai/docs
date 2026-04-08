---
title: "Copilot CLI Adapter"
description: "Complete reference for the Copilot CLI agent adapter: configuration, session lifecycle, CLI argument mapping, JSONL event stream, token accounting, error handling, SSH remote execution, and authentication."
keywords: sortie copilot cli adapter, copilot-cli, agent adapter, JSONL, session lifecycle, autopilot, max continues, token usage, SSH, GITHUB_TOKEN
author: Sortie AI
date: 2026-03-31
weight: 110
url: /reference/adapter-copilot/
---
The Copilot CLI adapter connects Sortie to the [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) via subprocess management. It launches the `copilot` binary with `--output-format json`, reads newline-delimited JSON from stdout, and normalizes events into domain types. Registered under kind `"copilot-cli"`.

Each `RunTurn` call spawns an independent subprocess. The adapter is safe for concurrent use: one adapter instance serves all sessions, with per-session state held in an opaque internal handle. Node.js 22+ is required — a canary check runs `copilot --version` at session start to verify the binary is functional.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for GitHub token variables, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `copilot-cli` extension block (pass-through to the Copilot CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Copilot CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | — | Must be `"copilot-cli"` to select this adapter. |
| `command` | string | `copilot` | Path or name of the Copilot CLI binary. Resolved via `exec.LookPath` at session start. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator calls `RunTurn` up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single `RunTurn` call. The orchestrator cancels the turn context when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the session as stalled. `0` or negative disables stall detection. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: copilot-cli
  command: copilot
  max_turns: 5
  max_sessions: 3
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
```

### `copilot-cli` extension section

These fields are adapter-specific. The orchestrator forwards them to the adapter without validation. Each field maps to a Copilot CLI flag.

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `model` | `--model` | string | _(CLI default)_ | LLM model identifier (e.g., `gpt-4.1`). |
| `max_autopilot_continues` | `--max-autopilot-continues` | integer | `50` | Maximum autopilot continuation steps within a single `RunTurn` invocation. |
| `agent` | `--agent` | string | _(none)_ | Agent persona to use. |
| `allowed_tools` | `--allow-tool` | string | _(none)_ | Tool to allow explicitly. |
| `denied_tools` | `--deny-tool` | string | _(none)_ | Tool to deny explicitly. |
| `available_tools` | `--available-tools` | string | _(none)_ | Set of available tools. |
| `excluded_tools` | `--excluded-tools` | string | _(none)_ | Set of excluded tools. |
| `mcp_config` | `--additional-mcp-config` | string | _(none)_ | Path to an MCP server configuration file. |
| `disable_builtin_mcps` | `--disable-builtin-mcps` | boolean | `false` | Disable built-in MCP servers. |
| `no_custom_instructions` | `--no-custom-instructions` | boolean | `false` | Skip custom instruction files. |
| `experimental` | `--experimental` | boolean | `false` | Enable experimental features. |

```yaml
copilot-cli:
  model: gpt-4.1
  max_autopilot_continues: 100
  agent: coding-agent
  mcp_config: ./mcp-servers.json
  disable_builtin_mcps: true
```

### `agent.max_turns` vs. `copilot-cli.max_autopilot_continues`

These two fields control different systems at different levels.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator invokes `RunTurn` per worker session. |
| `copilot-cli.max_autopilot_continues` | Copilot CLI's internal autopilot loop | How many autopilot continuation steps Copilot takes within a single `RunTurn` invocation. |

With `agent.max_turns: 5` and `max_autopilot_continues: 50`, the orchestrator runs up to 5 turns. Within each turn, Copilot takes up to 50 autopilot steps. The total step budget per session is at most 250.

Setting `max_autopilot_continues` too low causes Copilot to exit mid-task. Setting `agent.max_turns` too low causes the orchestrator to stop re-invoking the agent before the issue is resolved.

### Tool scoping behavior

When no explicit tool scoping flags are configured (`allowed_tools`, `denied_tools`, `available_tools`, and `excluded_tools` are all empty), the adapter passes `--allow-all` to auto-approve all tool calls. When any scoping flag is set, `--allow-all` is omitted and the explicit scoping flags take effect instead.

Every invocation also includes `--autopilot` and `--no-ask-user`, which are always present regardless of tool scoping configuration.

---

## Session lifecycle

### `StartSession`

Validates the workspace path, resolves the agent binary, runs a canary check, and verifies authentication. No subprocess is spawned.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` via `exec.LookPath`. In SSH mode, resolves the local `ssh` binary instead; the agent command resolves on the remote host.
3. **Canary check (local mode only):** runs `copilot --version` with a 5-second timeout to verify the binary is functional and Node.js 22+ is available.
4. **Authentication preflight (local mode only):** checks for `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` environment variables. Falls back to `gh auth status` (2-second timeout) if no env var is set.
5. Adopts `ResumeSessionID` for continuation sessions. The session ID may remain empty until the first `result` event populates it.
6. Returns an opaque `Session` handle containing workspace path, resolved binary, session ID, and SSH configuration.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent binary not found in `PATH` | `agent_not_found` |
| Binary found but not functional (Node.js missing) | `agent_not_found` |
| No GitHub authentication source found | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

### `RunTurn`

Spawns a Copilot CLI subprocess, reads JSONL events from stdout, and delivers normalized events via the `OnEvent` callback.

1. Builds the CLI argument list from session state and pass-through configuration.
2. Always includes: `-p <prompt>`, `--output-format json`, `-s`, `--autopilot`, `--no-ask-user`.
3. Applies session management flags (see [session resume mechanism](#session-resume-mechanism)).
4. Spawns the subprocess with `exec.Command` (not `exec.CommandContext` — see [process shutdown](#process-shutdown) for rationale).
5. Sets `cmd.Dir` to the workspace path and `cmd.Env` to the full parent process environment.
6. Emits `session_started` event before the scan loop begins.
7. Reads stdout line by line via a buffered scanner (64 KB initial buffer, 10 MB max line).
8. Drains stderr in a separate goroutine (debug-level logging).
9. Parses each line as JSON and dispatches to the appropriate event handler.
10. After stdout closes, calls `cmd.Wait` to collect exit status.
11. Captures session ID from the `result` event for subsequent turns.
12. Returns a `TurnResult` with session ID, exit reason, and cumulative token usage.

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

Copilot CLI emits one JSON object per line on stdout when invoked with `--output-format json`. The adapter parses each line and maps it to a normalized domain event.

### Event type mapping

| Copilot CLI event | Domain event type | Notes |
|---|---|---|
| `assistant.message_delta` | `notification` | Stall timer reset. Ephemeral streaming content. |
| `assistant.message` | `token_usage` + `notification` | Extracts `outputTokens` from data, accumulates cumulatively. Summarizes content or tool requests. |
| `assistant.turn_start` | `notification` | Turn boundary marker. |
| `assistant.turn_end` | `notification` | Turn boundary marker. |
| `tool.execution_start` | `notification` | Records tool name and timestamp in in-flight map. |
| `tool.execution_complete` | `tool_result` | Correlates with in-flight `tool.execution_start` for duration. Includes `ToolError` from `success` field. |
| `session.warning` | `notification` | Logs at warn level. Extracts message from data. |
| `session.info` | `notification` | Informational message. Extracts message from data. |
| `session.task_complete` | `notification` | Task completion summary. Extracts summary from data. |
| `session.mcp_server_status_changed` | _(debug log only)_ | Not emitted as domain event. |
| `session.mcp_servers_loaded` | _(debug log only)_ | Not emitted as domain event. |
| `session.tools_updated` | _(debug log only)_ | Not emitted as domain event. |
| `user.message` | _(debug log only)_ | Not emitted as domain event. |
| `result` | `turn_completed` or `turn_failed` | Final event. Contains session ID, exit code, usage stats. |
| _(parse failure)_ | `malformed` | Unparseable line, truncated to 500 characters. |
| _(unknown type)_ | `other_message` | Unrecognized event type. |

### Result event fields

The `result` event carries turn-level metadata at the top level (no `data` wrapper):

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Copilot CLI session ID. Captured for subsequent turns. |
| `exitCode` | integer | Process-level exit code. `0` = success. |
| `usage.premiumRequests` | integer | Number of premium API requests in this session. |
| `usage.totalApiDurationMs` | integer | Aggregate API response wait time in milliseconds. |
| `usage.sessionDurationMs` | integer | Wall-clock session duration in milliseconds. |
| `usage.codeChanges.linesAdded` | integer | Lines of code added. |
| `usage.codeChanges.linesRemoved` | integer | Lines of code removed. |
| `usage.codeChanges.filesModified` | array of strings | Files modified in this session. |

---

## Token accounting

**Key difference from Claude Code:** Copilot CLI does not report per-request input token counts. The adapter accumulates `outputTokens` from `assistant.message` events. Input tokens are reported as 0.

### Accumulation logic

1. Each `assistant.message` event with `outputTokens` in its data increments the running total.
2. `totalTokens` is computed as `outputTokens` (since `inputTokens` is always 0).
3. Cumulative totals are emitted as `token_usage` events after each assistant message.
4. The `result` event's usage (if present) provides API duration and premium request counts but does not carry per-token breakdowns.

### Model tracking

Copilot CLI does not report the model name in event payloads. The `Model` field on `token_usage` events is empty. Per-model cost attribution is not available for this adapter.

### API timing

The `result` event carries `usage.totalApiDurationMs`, which the adapter attaches to the turn completion or failure event. Unlike the Claude Code adapter, there is no per-request API latency tracking between individual events.

---

## Tool call tracking

The adapter observes tool execution by correlating `tool.execution_start` and `tool.execution_complete` events.

### Correlation

1. A `tool.execution_start` event records the tool name and a monotonic timestamp in an in-flight map, keyed by `toolCallId`.
2. A `tool.execution_complete` event looks up the matching `toolCallId` in the in-flight map.
3. When a match is found, the adapter emits a `tool_result` event with `ToolName`, `ToolDurationMS` (elapsed since the start timestamp), and `ToolError` (inverted from the `success` field: `ToolError = !success`).

### Tool error detail

**Key difference from Claude Code:** the `success` boolean is the only error signal. There is no error text extraction or ANSI stripping. The Claude Code adapter extracts error text from `tool_result` content blocks and applies XML stripping, ANSI removal, and truncation — the Copilot CLI adapter reports only whether the tool succeeded or failed.

---

## Error handling

### Exit code mapping

| Exit code | Condition | Error kind | Description |
|---|---|---|---|
| `0` | No result event, output tokens > 0 | _(none)_ | Treated as success. Agent produced output but no result event (partial output). |
| `0` | No result event, output tokens = 0 | `turn_failed` | Agent exited without producing output. Retryable with exponential backoff. Check WARN-level logs for stderr content. |
| `0` | Result event with `exitCode: 0` | _(none)_ | Normal completion. |
| `0` | Result event with `exitCode != 0` | `turn_failed` | Non-zero exit in result event despite clean process exit. |
| `127` | — | `agent_not_found` | Binary not found on local or remote host. |
| Non-zero (non-127) | No result event | `port_exit` | Unexpected subprocess exit. |
| Signal termination | — | `turn_cancelled` | Process killed by signal (SIGTERM/SIGKILL). |
| Context cancelled | — | `turn_cancelled` | Orchestrator cancelled the turn. |

### Stdout scanner failure

If the stdout scanner encounters an error (buffer overflow, broken pipe), the adapter:

1. Sends a graceful-kill signal to the subprocess.
2. Waits for exit.
3. Returns a `turn_failed` result with error kind `port_exit`.

---

## Session resume mechanism

**Key difference from Claude Code:** session ID discovery is deferred.

Claude Code generates a UUID session ID at session start and passes it immediately via `--session-id`. Copilot CLI reports its session ID only in the `result` event at the end of a turn. The adapter handles this with a fallback mechanism:

| Turn | Session ID known? | CLI flag |
|---|---|---|
| First turn, new session | No | _(neither `--resume` nor `--continue`)_ |
| Subsequent turn, ID captured from result | Yes | `--resume <sessionId>` |
| Subsequent turn, no ID ever captured | No | `--continue` (resumes most recent conversation in workspace) |

The `--continue` fallback is a safety net. Under normal operation, the first turn's result event provides the session ID for all subsequent turns.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches Copilot CLI on a remote host via SSH instead of locally.

### How it works

1. `StartSession` resolves the local `ssh` binary via `exec.LookPath`. The agent command is stored for remote execution rather than resolved locally. The canary check and authentication preflight are skipped in SSH mode.
2. `RunTurn` builds an SSH command that wraps the remote Copilot CLI invocation.
3. The remote command is: `cd '<workspace_path>' && '<agent_command>' <args...>`

### SSH options

The adapter uses these SSH options:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). Allowed values: `accept-new`, `yes`, `no`. |
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

Sortie does not manage Copilot CLI credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and the Copilot CLI reads its authentication variables directly.

Authentication check order at `StartSession` (local mode only):

1. `COPILOT_GITHUB_TOKEN` environment variable.
2. `GH_TOKEN` environment variable.
3. `GITHUB_TOKEN` environment variable.
4. `gh auth status` (2-second timeout, fallback). If `gh` is authenticated, the adapter logs a warning and proceeds.

If none are found, `StartSession` returns `agent_not_found` with a descriptive message listing the expected variables.

At runtime, the Copilot CLI handles its own authentication using whichever token is available in the process environment.

{{< callout type="warning" >}}
**Classic PATs do not work with Copilot CLI**

Copilot CLI requires a **fine-grained personal access token** (prefix `github_pat_`) with the **Copilot Requests** permission enabled. Classic PATs (prefix `ghp_`) fail authentication silently — the CLI falls through all token variables and reports no valid credential. OAuth tokens (`gho_` from `copilot auth login`) and GitHub App user-to-server tokens (`ghu_`) also work. If you see authentication failures despite having a token set, check the token prefix.
{{< /callout >}}

---

## Concurrency safety

The adapter is safe for concurrent use. One `CopilotAdapter` instance serves all sessions. Per-session state (workspace path, session ID, process handle) is isolated in the opaque `Session.Internal` field. A mutex guards the subprocess handle for concurrent access from `StopSession` and the graceful-kill goroutine.

No adapter-level serialization is needed for `RunTurn` calls — each spawns an independent subprocess with its own stdout pipe and scanner.

---

## Adapter registration

The adapter registers itself under kind `"copilot-cli"` via an `init` function in `internal/agent/copilot`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |

The orchestrator's preflight validation uses this to produce a specific error message if the binary cannot be found before attempting session creation.

---

## Key differences from Claude Code adapter

| Aspect | Claude Code | Copilot CLI |
|---|---|---|
| Kind | `claude-code` | `copilot-cli` |
| Default command | `claude` | `copilot` |
| Output format flag | `--output-format stream-json` | `--output-format json` |
| Session ID at start | UUID generated by adapter | Discovered from first `result` event |
| Resume flag | `--resume <UUID>` | `--resume <sessionId>` or `--continue` fallback |
| Input token reporting | Per-request cumulative | Not available (always 0) |
| Model reporting | From `assistant` events | Not available |
| Permission mode | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + `--allow-all` |
| Tool error detail | Error text with XML/ANSI stripping | Boolean `success` flag only |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` |
| Canary check | None | `copilot --version` (5-second timeout) |
| Auth preflight | None | Checks env vars + `gh auth status` |

For Claude Code configuration, see [Claude Code adapter reference](/reference/adapter-claude-code/).

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) — full `agent` schema and `copilot-cli` extension block
- [Environment variables reference](/reference/environment/) — GitHub token variables
- [Error reference](/reference/errors/#agent-errors) — all agent error kinds with retry behavior
- [How to write a prompt template](/guides/write-prompt-template/) — template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) — remote execution setup and host pool configuration
- [How to use the file adapter for local testing](/guides/use-file-adapter-for-testing/) — test prompts without a live tracker
- [State machine reference](/reference/state-machine/) — orchestration states, turn lifecycle, and stall detection
- [Dashboard reference](/reference/dashboard/) — live monitoring of running sessions and token usage
- [Prometheus metrics reference](/reference/prometheus-metrics/) — `sortie_agent_turns_total` and related counters
- [Agent extensions reference](/reference/agent-extensions/) — `tracker_api` tool available during agent sessions
- [Claude Code adapter reference](/reference/adapter-claude-code/) — sibling adapter for comparison
