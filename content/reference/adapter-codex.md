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
| `read_timeout_ms` | integer | `5000` (5 seconds) | Bounds three waits for a message the app-server may never send: the `account/login/completed` notification, the `thread/started` notification, and the wait for `turn/completed` after a cancelled turn's `turn/interrupt`. It does not bound the `initialize`, `account/read`, `thread/start`, or `thread/resume` responses, which are bounded by the caller's context instead. Falls back to 30 seconds when unset or not positive. |
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

These fields are adapter-specific. Most map to a JSON-RPC parameter on `thread/start` or `turn/start`; `mcp_config` is read by the worker instead and never becomes a parameter. The orchestrator forwards them to the adapter as written, except for `approval_policy`, which is checked before any run starts; see [validate-time checks](#validate-time-checks).

| Field | JSON-RPC param | Type | Default | Description |
|---|---|---|---|---|
| `model` | `model` (thread/start, turn/start) | string | _(CLI default)_ | LLM model identifier, forwarded unchanged. See `codex --help` on your installed version for the accepted values. |
| `effort` | `effort` (turn/start) | string | _(CLI default)_ | Reasoning effort level, forwarded unchanged. See `codex --help` on your installed version for the accepted values. |
| `approval_policy` | `approvalPolicy` (thread/start) | string | `never` | When the app-server asks for a decision before running a command or applying an edit. `never` is the only value Sortie accepts; which policies Codex itself offers is Codex's to document. See [approval policy and sandbox](#approval-policy-and-sandbox). |
| `thread_sandbox` | `sandbox` (thread/start) | string | `workspaceWrite` | Sandbox mode for the thread. The adapter rewrites the four camelCase spellings it recognizes - `readOnly`, `workspaceWrite`, `dangerFullAccess`, `externalSandbox` - into the kebab-case forms `thread/start` expects, and forwards any other value untouched. See [approval policy and sandbox](#approval-policy-and-sandbox). |
| `turn_sandbox_policy` | `sandboxPolicy` (turn/start) | map | _(see below)_ | Per-turn sandbox policy override, merged key-by-key on top of the adapter's default policy and able to replace any key in it. Setting it also makes the adapter send `sandboxPolicy` on every turn rather than only the first. |
| `personality` | `personality` (thread/start) | string | _(none)_ | Personality preset. |
| `mcp_config` | _(none; read by the worker)_ | string | _(none)_ | Path to an operator-supplied MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the generated configuration, and the adapter translates the merged result onto the app-server command line on a local launch. See [MCP](#mcp). |

```yaml
codex:
  model: <model-id>
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

For headless orchestration, the adapter defaults `approval_policy` to `"never"` and `thread_sandbox` to `"workspaceWrite"`. `approvalPolicy` travels on `thread/start` only; the adapter sends no turn-level override, so the thread's policy governs every turn of the session.

`never` is the only value Sortie accepts. Every run is unattended, so a policy that lets the app-server stop and ask for a decision has nobody to answer it, and the `codex.approval_policy.interactive` error refuses it before the run. Which policies Codex itself offers, and what each one does, is Codex's to document; see [external references](#external-references). Two shapes of wrong value fail differently: one the app-server rejects makes `thread/start` fail with `response_error` and no session is created, while a map value is read as a string, discarded without a diagnostic, and the thread starts under `never`.

The default keeps the app-server from asking most questions. The adapter refuses the ones that still arrive rather than leaving any of them waiting, and it splits them by what was asked for rather than by which method asked.

| What the request asks for | What the adapter does |
|---|---|
| Consent to act, such as running a command or changing a file | Refuses in the form that lets the agent try another route, emits a `notification`, and the turn continues. |
| An answer only a person could give | Ends the attempt at once with [`turn_input_required`](/reference/errors/#agent-errors), which releases the claim instead of scheduling a retry. The run is recorded with status `needs_person` rather than `failed`. |

No reply schema in the second class carries a value that both refuses and lets the turn continue, which is why those attempts end rather than degrade. A request that asks for something a program can supply is reported as an `other_message` event.

`turn/start` carries a `sandboxPolicy` on the session's first turn, and on every turn when `turn_sandbox_policy` is set; otherwise later turns send none and the thread's own sandbox stands. The default policy sets `type` to the camelCase spelling of `thread_sandbox` (`workspaceWrite` when unset), `writableRoots` to the workspace path, and `networkAccess` to `false`. Operator overrides from `turn_sandbox_policy` are merged on top and may replace any of the three.

The two requests spell the sandbox differently, and the adapter translates between them: `thread/start` receives the kebab-case form (`workspace-write`), the `turn/start` policy's `type` receives the camelCase form (`workspaceWrite`). A value the adapter does not recognize is forwarded to both as written.

{{< callout type="warning" >}}
**`approval_policy: never` allows arbitrary command execution within the sandbox.** Use this only in sandboxed environments. Sortie's workspace isolation does not replace container-level isolation.
{{< /callout >}}

---

## Validate-time checks

When `agent.kind` is `codex`, the [`sortie validate`](/reference/cli/#validate) pipeline runs a Codex-specific config check in addition to the generic preflight validation. It constructs no adapter instance and makes no network call, and the same check runs at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `codex.approval_policy.interactive` | `codex.approval_policy` is set to any value other than `never` | `codex.approval_policy is set to a value that lets the agent stop and ask for approval, and an unattended run has no one to answer; only "never" is supported` |

An absent `approval_policy` draws nothing: the adapter sends `never` for it.

---

## Session lifecycle

### `StartSession`

Launches the app-server subprocess, performs the JSON-RPC initialization handshake, authenticates if needed, and starts or resumes a thread.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` via `exec.LookPath` (splits on whitespace to extract the binary and its argument tokens). In SSH mode, resolves the local `ssh` binary instead.
3. On a local launch, reads the generated MCP configuration and appends one `-c` / `mcp_servers.<name>=<inline table>` argument pair per declared server to the launch arguments. Skipped entirely in SSH mode. See [MCP](#mcp).
4. Launches the subprocess with `cmd.Dir` set to the workspace path and `cmd.Env` set to the full parent process environment. Process group isolation via `procutil.SetProcessGroup`.
5. Wires stdin, stdout, and stderr pipes. Starts a background scanner goroutine on stdout (1 MB max line size).
6. **Initialize handshake:** sends `initialize` request with `clientInfo` and `capabilities.experimentalApi: true`. Waits for response. Sends `initialized` notification.
7. **Authentication check:** sends `account/read`. If account is null and `CODEX_API_KEY` is set, performs API key login. See [authentication](#authentication).
8. **Thread start:** sends `thread/start` with model, cwd, approvalPolicy, and sandbox. Records `threadId`. The adapter registers no client-side tool declarations; Sortie's tools reach the session through the MCP servers the runtime spawns from the overrides in step 3.
9. **Resume path:** if `ResumeSessionID` is non-empty, sends `thread/resume` instead. Falls back to `thread/start` if resume fails.
10. Returns a `Session` with `ID` set to the thread ID and `AgentPID` set to the subprocess PID.

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
| Generated MCP configuration unreadable or not expressible | `response_error` |
| Initialize handshake failed | `response_error` |
| Authentication failed | `response_error` |
| Thread start/resume failed | `response_error` |

### `RunTurn`

Sends a `turn/start` JSON-RPC request on the existing thread and reads event notifications until `turn/completed`.

1. Builds `turn/start` params with `threadId`, input (prompt as text), `cwd`, and optionally `sandboxPolicy`, `model`, and `effort`.
2. Sends the request and waits for the matching response.
3. Enters the event loop, selecting on the message channel and context cancellation.
4. Dispatches notifications by method name (see [event stream](#event-stream)).
5. On context cancellation, writes one best-effort `turn/interrupt` to the app-server's stdin - not through the cancelled context - then keeps reading for `read_timeout_ms` in case the app-server reports its own `turn/completed`. Past that bound the turn returns cancelled.
6. On `turn/completed`, emits the terminal turn event carrying the session's cumulative usage and returns `TurnResult`.

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

`RunTurn` handles context cancellation by writing one `turn/interrupt` request to stdin and then reading for at most `read_timeout_ms` more, so the app-server has a bounded chance to report the turn's own completion. The app-server acknowledges no client-sent response, so that bound is what keeps an unacknowledged interrupt from holding the turn open.

---

## Event stream

The Codex app-server emits JSON-RPC notifications on stdout. The adapter reads each line, separates responses from notifications, and maps notifications onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. The app-server's own notification methods and payload shapes are Codex's to define; see [external references](#external-references).

Two of those mappings decide how a run ends, and both follow from the [approval policy](#approval-policy-and-sandbox). A request that asks for consent to act is refused in a form that lets the agent try another route, reported as a `notification`, and the turn continues. A request addressed to a person ends the attempt with `turn_input_required`, which releases the claim instead of scheduling a retry and records the run as `needs_person` rather than `failed`.

Token counts do not travel on the turn-completion notification. They arrive on their own notification; see [token accounting](#token-accounting).

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

The adapter does not track per-request API latency. No `APIDurationMS` field is populated on any event this adapter emits.

---

## Tool call tracking

The adapter routes no tool call of its own. Sortie's tools reach the session as MCP servers the runtime spawns from the overrides described under [MCP](#mcp), and the runtime carries every call and result. What the adapter does is observe: it correlates the app-server's item notifications into `tool_result` events for the orchestrator, the logs, and the dashboard.

### Item-level correlation

1. An `item/started` notification with `type` in `commandExecution`, `fileChange`, `mcpToolCall`, or `dynamicToolCall` records the tool name and a monotonic timestamp in an in-flight map, keyed by `item.id`.
2. An `item/completed` notification looks up the matching `item.id`. When found, the adapter emits a `tool_result` event with `ToolName` and `ToolDurationMS`.

### Tool error detail

Item-level tool errors are not extracted from event payloads. A `tool_result` event from this adapter carries the tool name and duration and never sets the error flag.

---

## Error handling

### Error category mapping

When `turn/completed` carries `status: "failed"`, the `turn.error.codexErrorInfo` field classifies the failure:

| `codexErrorInfo` | Error kind | Description |
|---|---|---|
| `Unauthorized` | `response_error` | Invalid or expired API credentials. |
| `BadRequest` | `response_error` | Malformed request. |
| `ContextWindowExceeded` | `turn_failed` | Token limit exceeded. |
| `UsageLimitExceeded` | `turn_failed` | API usage quota exhausted. |
| `SandboxError` | `turn_failed` | Sandbox enforcement failure. |
| `HttpConnectionFailed` | `turn_failed` | Upstream API connection failure. |
| `ResponseStreamConnectionFailed` | `turn_failed` | SSE/WebSocket stream connection failure. |
| `ResponseStreamDisconnected` | `turn_failed` | Mid-stream disconnect. |
| `ResponseTooManyFailedAttempts` | `turn_failed` | Internal retry budget exhausted. |
| `InternalServerError` | `turn_failed` | Server-side error. |
| `Other` | `turn_failed` | Catch-all. |
| _(unknown value)_ | `turn_failed` | Unrecognized error info defaults to `turn_failed`. |

Both `response_error` and `turn_failed` are retryable with exponential backoff by [Sortie's default agent-error retry classification](/reference/errors/#agent-errors), same as every other agent error kind above `agent_not_found` and `invalid_workspace_cwd`; `codexErrorInfo` distinguishes only which error kind is reported, not whether the orchestrator retries.

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

The session ID is the Codex thread ID, read from the `thread/start` response and never generated by the adapter. A `thread/start` response carrying an empty thread ID fails the session.

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

The workspace path and each per-turn argument are single-quoted with embedded single-quote escaping (`'\''`) before being placed in the remote command string. The `CODEX_API_KEY` value, when prefixed onto the remote command, is quoted using the same mechanism. The configured agent command itself is not quoted this way.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

Sortie does not manage Codex CLI credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and the Codex CLI reads its authentication variables directly.

Authentication sequence at `StartSession`: sends `account/read`. If `result.account` is non-null, authentication is valid. If null and `CODEX_API_KEY` is set, sends `account/login/start` with `type: "apiKey"`. Waits for `account/login/completed`. If `CODEX_API_KEY` is not set, the adapter proceeds without login (the app-server may use cached credentials).

| Auth mode | Mechanism | Notes |
|---|---|---|
| API key | `CODEX_API_KEY` in the Sortie process environment | Consumed only when `account/read` reports no account. The adapter forwards the value verbatim and never inspects it. |
| Credentials the runtime already holds | `account/read` returns a non-null account | The adapter performs no login and starts the thread. How those credentials were established is Codex's to document. |

{{< callout type="warning" >}}
**The adapter never prompts for credentials, and a missing `CODEX_API_KEY` is not by itself an error.** With no key set and no account reported, `StartSession` proceeds to `thread/start` and the failure surfaces there or on the first turn. In SSH mode, `CODEX_API_KEY` is shell-quoted and injected inline in the remote command, because OpenSSH does not forward the orchestrator's local environment.
{{< /callout >}}

---

## MCP

`codex app-server` accepts no MCP-config path argument. The adapter delivers the servers rather than the file: it reads the generated `.sortie/mcp.json` and re-expresses each declared server as configuration the runtime parses for itself.

On a local launch, `StartSession` appends one `-c` / `mcp_servers.<name>=<inline table>` argument pair per declared server to the app-server command line. One pair per server rather than one for the whole table, so an operator's own `[mcp_servers]` entries in their own Codex configuration merge with Sortie's instead of being replaced. The runtime spawns each declared server itself over stdio, which makes `sortie-tools` a child of the app-server and the same sidecar every other kind reaches.

### Environment values

For a stdio server, an environment entry whose variable the adapter's own process already holds under the same value is delivered by name, through the runtime's environment-passthrough key, and the runtime resolves it from the environment it hands the spawned server. Every other entry is rendered as a literal value inside the inline table. Credentials that Sortie already holds therefore travel by name and never appear on the command line the host's process list exposes.

### HTTP headers

A header on an HTTP server entry is delivered by variable name, never by value. The adapter looks through its own process environment for a variable holding that header's value and renders the variable's name into the entry's header-passthrough key, leaving the runtime to resolve it. This is the same rule the [SSH exclusion](#ssh-mode-delivers-nothing) rests on: a header value written into the inline table would sit on the app-server's argument list, which any other user of the host can read.

A header whose value is in none of those variables cannot be delivered that way, and the session fails with `response_error` naming the header but never its value. This is the one condition on which a file that works for `claude-code`, `copilot-cli`, and `opencode` fails here, because each of those three carries the header's value as written. An operator moving a header-authenticated HTTP server onto Codex has to put that header's value in an environment variable of the orchestrator process first.

### SSH mode delivers nothing

A remote session receives no overrides at all. The overrides ride on the app-server's own launch arguments, and an SSH launch has none of its own: the local process is `ssh`, and the agent command travels to the host inside a remote command string. Writing the overrides into that string would place the configuration's credential values on the local `ssh` process's own argument list, where any other user of the orchestrator host can read them. The adapter delivers nothing rather than pay that price, so a Codex session on an SSH host reaches none of Sortie's tools and its first-turn prompt carries no tool advertisement.

### Startup failures

The runtime reports each declared server's startup outcome on its own notification. A failure status is logged at WARN naming the server and the reported reason. It fails neither the turn nor the session: a session that lost its tools this way still runs to completion, and the log is the only place that records it.

### `mcp_config`

`codex.mcp_config` names an operator-supplied MCP server configuration file. The worker reads it, merges its servers with the `sortie-tools` entry into the generated copy, and the merged result is what this adapter translates, so an operator's own servers reach a local Codex session alongside Sortie's. A relative path resolves against the directory containing `WORKFLOW.md`. An unreadable path, a file that is not valid JSON, or a file already declaring a server named `sortie-tools` fails the attempt before the session starts.

Three more conditions fail the session with `response_error` when the merged configuration reaches the adapter, and the message names the offending server:

| Condition | Also fails on `opencode` |
|---|---|
| An entry carries neither `command` nor `url`, or carries both, or declares a `type` that contradicts the fields it carries | Yes |
| An entry carries a key outside the modeled set: `type`, `command`, `args`, `env`, `url`, `headers`, `enabled` | Yes |
| A server name is not a valid bare segment of the runtime's dotted-path override grammar | No |

An HTTP entry's headers carry a fourth condition of their own; see [HTTP headers](#http-headers).

Codex also reads its own MCP server list from configuration files of its own, entirely outside anything this adapter writes; which files it consults, and under what trust conditions, is Codex's to document - see the [external references](#external-references). Because the adapter runs the app-server with the per-issue workspace as its working directory, whatever project-scoped configuration behavior Codex has applies to that workspace like any other Codex working directory.

---

## Concurrency safety

The adapter is safe for concurrent use. One `CodexAdapter` instance serves all sessions. Per-session state (workspace path, thread ID, subprocess handle, stdin/stdout pipes) is isolated in the opaque `Session.Internal` field.

A mutex (`state.mu`) guards the subprocess handle, stdin pipe, and stdout pipe against concurrent access from `StopSession` and the turn loop. Within a session, `RunTurn` calls are serialized by the orchestrator.

---

## Adapter registration

The adapter registers itself under kind `"codex"` via an `init` function in `internal/agent/codex`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |
| `ValidateAgentConfig` | the check described in [Validate-time checks](#validate-time-checks) |
| `MCPInjection` | `translated` - the adapter re-expresses the generated configuration's servers in the form its runtime parses, and delivers that on a local launch only. See [MCP](#mcp). |

The orchestrator's preflight validation uses `RequiresCommand` to produce a specific error message if the binary cannot be found before attempting session creation.

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
| Sandbox enforcement | None at adapter level | None at adapter level | Requested through `sandbox` on `thread/start` and `sandboxPolicy` on `turn/start`; enforcement is the app-server's |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as `-c mcp_servers.<name>=...` overrides, local launch only - see [MCP](#mcp) |
| Authentication | No preflight; the CLI reads the inherited environment | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` | `CODEX_API_KEY`, or credentials the app-server already holds |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None (agent runs to completion per turn) |

For Claude Code configuration, see [Claude Code adapter reference](/reference/adapter-claude-code/). For Copilot CLI configuration, see [Copilot CLI adapter reference](/reference/adapter-copilot/).

---

## External references

- [Codex Documentation](https://developers.openai.com/codex) - official OpenAI documentation site for the Codex CLI
- [`openai/codex` on GitHub](https://github.com/openai/codex) - Codex CLI source repository, releases, and issue tracker
- [Codex `config.md`](https://github.com/openai/codex/blob/main/docs/config.md) - sandbox modes, approval policies, and other settings this adapter forwards via JSON-RPC params
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) - wire format used over Codex's stdin/stdout
- [OpenAI API authentication](https://platform.openai.com/docs/api-reference/authentication) - the `CODEX_API_KEY` credential format
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) - the protocol behind the `mcpToolCall` items in the event stream and the `mcpServer/elicitation/request` approval request

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
