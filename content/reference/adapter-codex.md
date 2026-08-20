---
title: "Codex CLI Adapter"
description: "Codex CLI agent adapter reference: configuration, session lifecycle, JSON-RPC protocol, token accounting, errors, SSH remote execution, and auth."
author: Sortie AI
date: 2026-04-26
weight: 120
url: /reference/adapter-codex/
---
The Codex CLI adapter connects Sortie to the [OpenAI Codex CLI](https://github.com/openai/codex) via a persistent subprocess. It launches `codex app-server`, communicates over JSON-RPC 2.0 on stdin/stdout (JSONL), and normalizes event notifications into domain types. Registered under kind `"codex"`.

Unlike the Claude Code and Copilot CLI adapters, the Codex adapter uses a **persistent subprocess model**. `StartSession` launches the process and keeps it alive across turns. Each `RunTurn` sends a `turn/start` request on the existing thread rather than spawning a new process.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for `CODEX_API_KEY` and related variables, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring, [Jira + Codex end-to-end tutorial](/getting-started/jira-codex-end-to-end/) for a step-by-step walkthrough.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `codex` extension block (pass-through to the adapter).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Codex CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"codex"` to select this adapter. |
| `command` | string | `codex app-server` | Path or name of the Codex binary with arguments. Resolved via `exec.LookPath` at session start. The first space-separated token is the binary name; remaining tokens are arguments. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator calls `RunTurn` up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single `RunTurn` call. The orchestrator cancels the turn context when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for synchronous operations during `StartSession` (initialize, account/read, thread/start responses). Defaults to 30 seconds internally if not set. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the session as stalled. `0` or negative disables stall detection. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: codex
  command: codex app-server
  max_turns: 15
  max_sessions: 3
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
```

### `codex` extension section

These fields are adapter-specific. The orchestrator forwards them to the adapter without validation. Each field maps to a JSON-RPC parameter on `thread/start` or `turn/start`.

| Field | JSON-RPC param | Type | Default | Description |
|---|---|---|---|---|
| `model` | `model` (thread/start, turn/start) | string | _(CLI default)_ | LLM model identifier (e.g., `o3`, `gpt-5.4`). |
| `effort` | `effort` (turn/start) | string | _(CLI default)_ | Reasoning effort level. Values: `low`, `medium`, `high`. |
| `approval_policy` | `approvalPolicy` (thread/start) | string | `never` | Approval behavior for tool calls. Values: `never`, `onRequest`, `unlessTrusted`, `always`. |
| `thread_sandbox` | `sandbox` (thread/start) | string | `workspaceWrite` | Sandbox mode for the thread. Values: `readOnly`, `workspaceWrite`, `dangerFullAccess`, `externalSandbox`. |
| `turn_sandbox_policy` | `sandboxPolicy` (turn/start) | map | _(see below)_ | Per-turn sandbox policy override. Merged on top of the default policy. |
| `personality` | `personality` (thread/start) | string | _(none)_ | Personality preset. |

```yaml
codex:
  model: o3
  effort: medium
  approval_policy: never
  thread_sandbox: workspaceWrite
  personality: ""
```

### `agent.max_turns` and the persistent thread model

The Codex adapter does not have an inner turn limit equivalent to `claude-code.max_turns` or `copilot-cli.max_autopilot_continues`. Each `RunTurn` call sends a single `turn/start` request, and the agent works until it produces a `turn/completed` notification. The orchestrator controls the total number of turns via `agent.max_turns`.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator invokes `RunTurn` per worker session. |

Within a single turn, Codex's internal agentic loop runs until completion, interruption, or failure. There is no adapter-level cap on the number of agentic steps within a turn. Use `turn_timeout_ms` to bound wall-clock time per turn.

### Approval policy and sandbox

For headless orchestration, the adapter defaults `approval_policy` to `"never"` and `thread_sandbox` to `"workspaceWrite"`. This auto-approves all tool calls within the workspace sandbox boundary.

The default `sandboxPolicy` sent on `turn/start` sets `type` to `workspaceWrite`, `writableRoots` to the workspace path, and `networkAccess` to `false`. Operator overrides from `turn_sandbox_policy` are merged on top.

{{< callout type="warning" >}}
**`approval_policy: never` allows arbitrary command execution within the sandbox.** Use this only in sandboxed environments. Sortie's workspace isolation does not replace container-level isolation.
{{< /callout >}}

---

## Session lifecycle

### `StartSession`

Launches the app-server subprocess, performs the JSON-RPC initialization handshake, authenticates if needed, and starts or resumes a thread.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` via `exec.LookPath` (splits on whitespace to extract the binary and its argument tokens). In SSH mode, resolves the local `ssh` binary instead.
3. Launches the subprocess with `cmd.Dir` set to the workspace path and `cmd.Env` set to the full parent process environment. Process group isolation via `procutil.SetProcessGroup`.
4. Wires stdin, stdout, and stderr pipes. Starts a background scanner goroutine on stdout (1 MB max line size).
5. **Initialize handshake:** sends `initialize` request with `clientInfo` and `capabilities.experimentalApi: true`. Waits for response. Sends `initialized` notification.
6. **Authentication check:** sends `account/read`. If account is null and `CODEX_API_KEY` is set, performs API key login. See [authentication](#authentication).
7. **Thread start:** sends `thread/start` with model, cwd, approvalPolicy, sandbox, and dynamicTools (from `ToolRegistry`). Records `threadId`.
8. **Resume path:** if `ResumeSessionID` is non-empty, sends `thread/resume` instead. Falls back to `thread/start` if resume fails.
9. Returns a `Session` with `ID` set to the thread ID and `AgentPID` set to the subprocess PID.

The workspace does not need to be a Git repository: `thread/start` accepts a non-git `cwd` and reports `gitInfo: null`.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent binary not found in `PATH` | `agent_not_found` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |
| Subprocess failed to start | `port_exit` |
| Pipe creation failed (stdin, stdout, stderr) | `port_exit` |
| Initialize handshake failed | `response_error` |
| Authentication failed | `response_error` |
| Thread start/resume failed | `response_error` |

### `RunTurn`

Sends a `turn/start` JSON-RPC request on the existing thread and reads event notifications until `turn/completed`.

1. Builds `turn/start` params with `threadId`, input (prompt as text), `cwd`, and optionally `sandboxPolicy`, `model`, and `effort`.
2. Sends the request and waits for the matching response.
3. Enters the event loop, selecting on the message channel and context cancellation.
4. Dispatches notifications by method name (see [event stream](#event-stream)).
5. On context cancellation, sends `turn/interrupt` using a detached 2-second context.
6. On `turn/completed`, emits the terminal turn event carrying the session's cumulative usage and returns `TurnResult`.
7. Waits for in-flight dynamic tool call goroutines to complete before returning.

### `StopSession`

Terminates the persistent app-server subprocess. Safe to call when no subprocess is active.

1. Signals the reader goroutine to stop. Closes the stdin pipe.
2. Sends `SIGTERM` to the process group. Waits up to 5 seconds.
3. Force-kills via `SIGKILL` if still running.
4. Waits for the reader goroutine to finish.

### `EventStream`

Returns `nil`. The adapter delivers all events synchronously through the `OnEvent` callback in `RunTurn`.

---

## Process shutdown

Because the subprocess persists across turns, `StopSession` handles shutdown rather than `RunTurn`. The shutdown sequence closes stdin (EOF signal), sends `SIGTERM` to the process group, waits up to 5 seconds, then escalates to `SIGKILL`. On Windows, a Job Object with `KILL_ON_JOB_CLOSE` terminates the process tree on shutdown or crash.

`RunTurn` handles context cancellation by sending `turn/interrupt` via JSON-RPC, allowing the app-server to complete gracefully.

---

## Event stream

The Codex app-server emits JSON-RPC 2.0 notifications on stdout (JSONL). The adapter parses each line, discriminates between responses (non-zero `id`, no `method`) and notifications (`method` present), and maps notifications to normalized domain events.

### Event type mapping

| App-server notification | Item type / condition | Domain event type | Notes |
|---|---|---|---|
| `turn/started` | First turn | `session_started` | Captures thread ID and agent PID. |
| `turn/started` | Subsequent turns | `notification` | |
| `turn/completed` | `status: "completed"` | `turn_completed` | |
| `turn/completed` | `status: "failed"` | `turn_failed` | Includes error message from `turn.error`. |
| `turn/completed` | `status: "interrupted"`, turn context already cancelled | `turn_cancelled` | Sortie asked for the interruption. |
| `turn/completed` | `status: "interrupted"`, turn context still live | `turn_failed` | An interruption Sortie did not request is a failure, so the claim is retried rather than released. |
| `turn/completed` | Any other status | `turn_failed` | An unrecognized status is treated as a failure. |
| `thread/tokenUsage/updated` | `tokenUsage` present, turn id matches the running turn | `token_usage` | Carries the run-cumulative snapshot. See [token accounting](#token-accounting). |
| `thread/tokenUsage/updated` | `tokenUsage` absent, or turn id belongs to another turn | _(no event)_ | A foreign turn's totals raise the subtraction baseline instead. |
| `turn/plan/updated` | - | `notification` | Agent plan update. |
| `turn/diff/updated` | - | _(debug log only)_ | Not emitted as domain event. |
| `item/started` | `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall` | `notification` | Records tool name and timestamp in in-flight map. |
| `item/started` | Other types | `notification` | |
| `item/completed` | Matching in-flight tool | `tool_result` | Includes `ToolName` and `ToolDurationMS`. |
| `item/completed` | `agentMessage` with text | `notification` | Text truncated to 200 characters. |
| `item/agentMessage/delta` | - | `notification` | Stall timer reset. No payload. |
| `item/commandExecution/outputDelta` | - | `notification` | Stall timer reset. No payload. |
| `item/tool/call` | Tool found in registry | `tool_result` | Dispatched asynchronously. See [tool call tracking](#tool-call-tracking). |
| `item/tool/call` | Tool not found | `unsupported_tool_call` | Error response sent to app-server. |
| _(parse failure)_ | - | _(logged)_ | Malformed JSONL line logged at debug level. |
| _(unknown method)_ | - | `other_message` | Unrecognized notification method. |

### Turn completion fields

The `turn/completed` notification carries the final turn state:

| Field path | Type | Description |
|---|---|---|
| `turn.id` | string | Turn identifier. |
| `turn.status` | string | `"completed"`, `"failed"`, or `"interrupted"`. |
| `turn.error.message` | string | Error description (present when status is `"failed"`). |
| `turn.error.codexErrorInfo` | string | Error category for retry classification. See [error handling](#error-handling). |

The notification carries no token counts. Usage arrives on its own notification; see [token accounting](#token-accounting).

### Token usage fields

Token usage arrives on `thread/tokenUsage/updated`, which carries a `tokenUsage` object with two breakdowns of the same shape:

| Field path | Type | Description |
|---|---|---|
| `turnId` | string | The turn these counts belong to. |
| `tokenUsage.total` | object | Thread-cumulative counts, spanning every turn of the thread including turns from an earlier run of a resumed thread. |
| `tokenUsage.last` | object | Counts for the most recent model request alone. |
| `<breakdown>.inputTokens` | integer | Input tokens, already inclusive of `cachedInputTokens`. |
| `<breakdown>.outputTokens` | integer | Output tokens, already inclusive of `reasoningOutputTokens`. |
| `<breakdown>.cachedInputTokens` | integer | Cached input tokens, a subset of `inputTokens`. |

---

## Token accounting

Reported token counts are cumulative over the whole session the orchestrator opened, across every turn of it, and never decrease. Unlike the Claude Code adapter, which derives its figures from the event stream and the turn's terminal event, the Codex adapter reads a dedicated `thread/tokenUsage/updated` notification.

### Accumulation logic

1. `tokenUsage.total` is thread-cumulative, so a resumed thread reports spend the current run did not incur. The adapter subtracts a baseline to recover this run's own contribution: at the first notification matching the running turn, the baseline is `total` minus `last`.
2. Each later notification for the running turn reports `total` minus that baseline as the run-cumulative snapshot, emitted as one `token_usage` event.
3. A notification whose `turnId` belongs to another turn raises the baseline instead of emitting an event, so a foreign turn's spend never lands in this run's total.
4. `input_tokens` comes from `inputTokens`, `output_tokens` from `outputTokens`, and `cache_read_tokens` from `cachedInputTokens`. `total_tokens` is computed as `input_tokens + output_tokens` rather than read from the notification's own `totalTokens`.
5. A notification carrying no `tokenUsage` object emits no event and leaves the session's measurement state untouched. A session that never receives one is recorded as unmeasured rather than as having spent zero.

### Model tracking

The adapter does not extract a model name from event payloads. The `Model` field on `token_usage` events is empty. The model is configured via `codex.model` in WORKFLOW.md but not echoed in turn events.

### API timing

The adapter does not track per-request API latency. No `APIDurationMS` field is populated. For observability, use the Codex CLI's built-in OpenTelemetry export.

---

## Tool call tracking

The adapter tracks two categories of tool execution: **item-level tools** (commands, file changes, MCP calls) and **dynamic tool calls** (`tracker_api` and other registry tools).

### Item-level correlation

1. An `item/started` notification with `type` in `commandExecution`, `fileChange`, `mcpToolCall`, or `dynamicToolCall` records the tool name and a monotonic timestamp in an in-flight map, keyed by `item.id`.
2. An `item/completed` notification looks up the matching `item.id`. When found, the adapter emits a `tool_result` event with `ToolName` and `ToolDurationMS`.

### Dynamic tool dispatch

When the app-server sends an `item/tool/call` JSON-RPC request (with both `method` and `id`), the adapter looks up the tool in the `ToolRegistry` and executes it asynchronously in a goroutine. The goroutine acquires `state.mu` before writing the JSON-RPC response to stdin. If the tool is not registered, an error response is sent immediately and `unsupported_tool_call` is emitted. A `sync.WaitGroup` tracks in-flight tool goroutines; `RunTurn` waits for all to complete before returning.

### Tool error detail

Dynamic tool errors include the error message from `tool.Execute`. Item-level tool errors are not extracted from event payloads.

---

## Error handling

### Error category mapping

When `turn/completed` carries `status: "failed"`, the `turn.error.codexErrorInfo` field classifies the failure:

| `codexErrorInfo` | Error kind | Retryable | Description |
|---|---|---|---|
| `Unauthorized` | `response_error` | No | Invalid or expired API credentials. |
| `BadRequest` | `response_error` | No | Malformed request. |
| `ContextWindowExceeded` | `turn_failed` | No | Token limit exceeded. |
| `UsageLimitExceeded` | `turn_failed` | No | API usage quota exhausted. |
| `SandboxError` | `turn_failed` | No | Sandbox enforcement failure. |
| `HttpConnectionFailed` | `turn_failed` | Yes | Upstream API connection failure. |
| `ResponseStreamConnectionFailed` | `turn_failed` | Yes | SSE/WebSocket stream connection failure. |
| `ResponseStreamDisconnected` | `turn_failed` | Yes | Mid-stream disconnect. |
| `ResponseTooManyFailedAttempts` | `turn_failed` | Yes | Internal retry budget exhausted. |
| `InternalServerError` | `turn_failed` | Yes | Server-side error. |
| `Other` | `turn_failed` | Yes | Catch-all. |
| _(unknown value)_ | `turn_failed` | Yes | Unrecognized error info defaults to `turn_failed`. |

### Process exit handling

Because the Codex adapter uses a persistent subprocess, process exit during a turn is abnormal.

| Condition | Error kind |
|---|---|
| Stdout channel closed during turn | `port_exit` |
| Stdout scanner error | `port_exit` |
| `turn/start` response error | `turn_failed` |
| Context cancelled before response | `port_exit` |

### Stdout reader failure

If the reader goroutine encounters an error or EOF, it delivers the error to the message channel. `RunTurn` emits `turn_failed` and returns with error kind `port_exit`.

---

## Session resume mechanism

Within a session, multi-turn continuation is automatic. Each `RunTurn` sends `turn/start` on the same `threadId`. No resume flag or session ID propagation is needed between turns.

Across sessions (after an orchestrator restart), the adapter sends `thread/resume` with the saved thread ID. History is restored from Codex's on-disk rollout file. If resume fails, the adapter falls back to `thread/start` (new thread, previous context lost).

The session ID is the Codex thread ID (e.g., `thr_abc123`), assigned by the app-server in the `thread/start` response.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches the app-server on a remote host via SSH.

### How it works

1. `StartSession` resolves the local `ssh` binary via `exec.LookPath`. The agent command is stored for remote execution.
2. Prefixes `CODEX_API_KEY` inline in the remote command if set, since OpenSSH does not forward local environment variables.
3. Constructs SSH arguments via `sshutil.BuildSSHArgs`.
4. All JSON-RPC communication flows over the SSH tunnel's stdin/stdout.

### SSH options

The adapter uses these SSH options via the shared `sshutil` package:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). Allowed values: `accept-new`, `yes`, `no`. |
| `BatchMode` | `yes` | Disables interactive prompts (password, passphrase). |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### Shell quoting

All arguments in the remote command string are single-quoted with embedded single-quote escaping (`'\''`). The `CODEX_API_KEY` value is quoted using the same mechanism.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

Sortie does not manage Codex CLI credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and the Codex CLI reads its authentication variables directly.

Authentication sequence at `StartSession`: sends `account/read`. If `result.account` is non-null, authentication is valid. If null and `CODEX_API_KEY` is set, sends `account/login/start` with `type: "apiKey"`. Waits for `account/login/completed`. If `CODEX_API_KEY` is not set, the adapter proceeds without login (the app-server may use cached credentials).

| Auth mode | Mechanism | Notes |
|---|---|---|
| API key (recommended for CI) | `CODEX_API_KEY` environment variable | Standard OpenAI API key. Billed at API rates. |
| ChatGPT managed | Browser-based OAuth via `codex login` | Requires prior interactive login; credentials cached in `~/.codex/auth.json`. |

{{< callout type="warning" >}}
**`CODEX_API_KEY` must be set in the Sortie process environment.** The adapter does not prompt for credentials. In SSH mode, `CODEX_API_KEY` is injected inline in the remote command because OpenSSH does not forward local environment variables by default.
{{< /callout >}}

---

## Concurrency safety

The adapter is safe for concurrent use. One `CodexAdapter` instance serves all sessions. Per-session state (workspace path, thread ID, subprocess handle, stdin/stdout pipes) is isolated in the opaque `Session.Internal` field.

A mutex (`state.mu`) guards the subprocess handle, stdin pipe, and stdout pipe for concurrent access from `StopSession` and dynamic tool call goroutines that write JSON-RPC responses to stdin. Within a session, `RunTurn` calls are serialized by the orchestrator.

---

## Adapter registration

The adapter registers itself under kind `"codex"` via an `init` function in `internal/agent/codex`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |

The orchestrator's preflight validation uses this to produce a specific error message if the binary cannot be found before attempting session creation.

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex |
|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` |
| Default command | `claude` | `copilot` | `codex app-server` |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout |
| Session ID source | UUID generated by adapter | Discovered from `result` event | Thread ID from `thread/start` response |
| Resume mechanism | `--resume <UUID>` (new subprocess) | `--resume <sessionId>` or `--continue` | `thread/resume` (JSON-RPC) or automatic within session |
| Input token reporting | Per-request, from the result event's per-model breakdown | Recovered from the runtime's session-state journal after exit | From `thread/tokenUsage/updated`, baseline-subtracted |
| Model reporting | From `assistant` events | Not available | Not available |
| Permission mode | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + `--allow-all` | `approvalPolicy: "never"` (JSON-RPC param) |
| Sandbox enforcement | None (external container) | None (external container) | OS-level (Seatbelt/bwrap/seccomp) + configurable policies |
| Dynamic tools | `--mcp-config` (MCP sidecar) | `--additional-mcp-config` (MCP sidecar) | `dynamicTools` on `thread/start` (no sidecar) |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` | `CODEX_API_KEY` or `~/.codex/auth.json` |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None (agent runs to completion per turn) |

For Claude Code configuration, see [Claude Code adapter reference](/reference/adapter-claude-code/). For Copilot CLI configuration, see [Copilot CLI adapter reference](/reference/adapter-copilot/).

---

## External references

- [Codex Documentation](https://developers.openai.com/codex) - official OpenAI documentation site for the Codex CLI
- [`openai/codex` on GitHub](https://github.com/openai/codex) - Codex CLI source repository, releases, and issue tracker
- [Codex `config.md`](https://github.com/openai/codex/blob/main/docs/config.md) - sandbox modes, approval policies, and other settings this adapter forwards via JSON-RPC params
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) - wire format used over Codex's stdin/stdout
- [OpenAI API authentication](https://platform.openai.com/docs/api-reference/authentication) - the `CODEX_API_KEY` credential format
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) - the dynamic-tools protocol delivered via `dynamicTools` on `thread/start`

---

## Related pages

- [Jira + Codex end-to-end tutorial](/getting-started/jira-codex-end-to-end/) - step-by-step walkthrough from Jira issue to pushed branch
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `codex` extension block
- [Environment variables reference](/reference/environment/) - `CODEX_API_KEY` and related variables
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - session caps, turn caps, concurrency limits, and model selection
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
