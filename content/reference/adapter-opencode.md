---
title: "OpenCode CLI Adapter"
description: "Complete reference for the OpenCode CLI agent adapter: configuration, session lifecycle, CLI argument mapping, event stream, token accounting via export subprocess, error handling, SSH remote execution, and multi-provider authentication."
keywords: sortie opencode adapter, opencode, opencode-ai, agent adapter, session lifecycle, token usage, SSH, multi-provider, ANTHROPIC_API_KEY, OPENAI_API_KEY
author: Sortie AI
date: 2026-04-26
weight: 130
url: /reference/adapter-opencode/
---
The OpenCode adapter connects Sortie to the [OpenCode CLI](https://opencode.ai/docs/cli/) via subprocess management. It launches `opencode run --format json`, reads newline-delimited stdout envelopes, tolerates plain-text permission warnings mixed into stdout, and normalizes the stream into domain event types. Registered under kind `"opencode"`.

Each `RunTurn` call spawns a fresh subprocess. One reader goroutine owns stdout, the adapter emits activity-visible events so the orchestrator stall watchdog can observe progress, per-session state is mutex-guarded, and `StartSession` performs no binary canary check or authentication preflight.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for runtime environment behavior, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `opencode` extension block.

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the OpenCode CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"opencode"` to select this adapter. |
| `command` | string | `opencode` | Path or name of the OpenCode binary. Resolved via `exec.LookPath` at session start. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator calls `RunTurn` up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `max_concurrent_agents_by_state` | map | `{}` | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single `RunTurn` call. The orchestrator cancels the turn context when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive emitted events before the orchestrator treats the turn as stalled. `0` or negative disables stall detection. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: opencode
  command: opencode
  max_turns: 5
  max_sessions: 3
  max_concurrent_agents: 4
  stall_timeout_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 3
    to do: 1
```

### `opencode` extension section

These fields are adapter-specific. Some map to OpenCode CLI flags. Others map to managed `OPENCODE_*` environment variables that the adapter injects on every `run` and `export` subprocess.

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `model` | `--model` | string | _(CLI default)_ | Model identifier in `provider/model` form. |
| `agent` | `--agent` | string | _(none)_ | OpenCode agent name passed through unchanged. |
| `variant` | `--variant` | string | _(none)_ | Provider-specific reasoning variant passed through unchanged. |
| `thinking` | `--thinking` | boolean | `false` | Requests reasoning blocks in stdout output. |
| `pure` | `--pure` | boolean | `false` | Runs OpenCode without external plugins. This flag is present in the shipped CLI even though it is omitted from the public CLI docs page. |
| `dangerously_skip_permissions` | `--dangerously-skip-permissions` | boolean | `true` | Auto-approves permission requests that are not explicitly denied by policy. Omitted when `false`. |
| `disable_autocompact` | `OPENCODE_DISABLE_AUTOCOMPACT` | boolean | `true` | Managed environment override applied to both `run` and `export` subprocesses. |
| `allowed_tools` | `OPENCODE_PERMISSION` | list of strings | `[]` | Builds an allowlist policy. Listed permission keys become `allow`. Every known key not listed becomes `deny`. Unknown keys are forwarded unchanged. |
| `denied_tools` | `OPENCODE_PERMISSION` | list of strings | `[]` | Adds `deny` entries to the managed permission policy. When combined with `allowed_tools`, denied keys override allowed keys. Overlap is rejected during adapter construction. |

The adapter always adds `run --format json --dir <workspace> -- <prompt>`. It does not expose `--attach`, `--port`, `--command`, `--file`, `--title`, `--continue`, or `--fork`.

```yaml
opencode:
  model: anthropic/claude-sonnet-4-5
  variant: high
  pure: true
  dangerously_skip_permissions: true
  disable_autocompact: true
  allowed_tools:
    - read
    - edit
    - glob
```

### `agent.max_turns` vs. OpenCode inner turn scope

The adapter exposes no OpenCode-specific inner turn or step-budget field.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator invokes `RunTurn` per worker session. |
| `(none)` | OpenCode inner turn budget | The adapter does not expose an OpenCode equivalent to `claude-code.max_turns` or `copilot-cli.max_autopilot_continues`. Each `RunTurn` executes one `opencode run` process and lets the CLI run until it exits. |

Use `turn_timeout_ms` to bound wall-clock time for a single turn. There is no adapter-level cap on OpenCode's internal step count within that turn.

### Permission policy

The adapter synthesizes a managed permission policy from `allowed_tools` and `denied_tools`, then injects it through `OPENCODE_PERMISSION`. The policy is separate from `--dangerously-skip-permissions`.

| Input | Adapter behavior |
|---|---|
| No `allowed_tools`, no `denied_tools` | Does not set `OPENCODE_PERMISSION`. OpenCode falls back to on-disk config and its own defaults. |
| `allowed_tools` only | Sets each listed key to `allow`, then sets every known key not listed to `deny`. |
| `denied_tools` only | Sets only the listed keys to `deny`. Other keys fall through to OpenCode defaults or operator config. |
| Both fields present | Starts with the allowlist behavior above, then applies `deny` overrides from `denied_tools`. |
| Overlap between the two fields | Adapter construction fails. |
| Unknown permission key | Forwards the key verbatim and logs it at debug level. |

The adapter's known permission-key set is:

| Key | Included in blanket deny when `allowed_tools` is non-empty |
|---|---|
| `bash` | Yes |
| `codesearch` | Yes |
| `doom_loop` | Yes |
| `edit` | Yes |
| `external_directory` | Yes |
| `glob` | Yes |
| `grep` | Yes |
| `list` | Yes |
| `lsp` | Yes |
| `question` | Yes |
| `read` | Yes |
| `skill` | Yes |
| `task` | Yes |
| `todowrite` | Yes |
| `webfetch` | Yes |
| `websearch` | Yes |

`list` and `todowrite` are included even though the public OpenCode permissions page does not list them. The adapter mirrors the runtime schema, not only the rendered docs page.

The adapter also manages these environment variables on every subprocess:

| Variable | Value |
|---|---|
| `OPENCODE_AUTO_SHARE` | `false` |
| `OPENCODE_DISABLE_AUTOCOMPACT` | `true` or `false`, from `opencode.disable_autocompact` |
| `OPENCODE_DISABLE_AUTOUPDATE` | `true` |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `true` |
| `OPENCODE_PERMISSION` | JSON-encoded policy, only when tool scoping is configured |

Before adding its managed value, the adapter removes any inherited `OPENCODE_PERMISSION` entry from the parent process environment. It does not remove permission rules from `opencode.json`, so OpenCode still deep-merges the adapter policy with on-disk configuration.

---

## Session lifecycle

### `StartSession`

Validates the workspace path, resolves the launch target, and initializes adapter-owned session state. No OpenCode subprocess is started.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the configured command via `exec.LookPath`, defaulting to `opencode` when `agent.command` is empty. In SSH mode, resolves the local `ssh` binary instead and stores the remote command string for later use.
3. Copies `ResumeSessionID` into session state when continuation is requested.
4. Returns an opaque `Session` handle with per-session state, no running PID, and no started subprocess.

`StartSession` performs no version canary, no provider-auth probe, and no remote OpenCode binary check.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| Local OpenCode binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

### `RunTurn`

Spawns one OpenCode subprocess, reads stdout through a single reader goroutine, and delivers normalized events via `OnEvent`.

1. Builds the managed environment and the per-turn argument list.
2. Adds `run --format json --dir <workspace>` to every invocation.
3. Adds `--session <id>` when the session already has an OpenCode session ID.
4. Launches the subprocess locally or through SSH, with `cmd.Dir` set to the workspace and `cmd.Env` set to the inherited environment plus managed `OPENCODE_*` overrides.
5. Configures process-group isolation before start, then sets `cmd.Cancel` to a graceful process-group signal and `cmd.WaitDelay` to 5 seconds.
6. Starts one stderr collector goroutine, one stdout reader goroutine, and one wait goroutine.
7. Applies a startup timer derived from `read_timeout_ms`. Plain-text stdout lines reset the timer before the first JSON envelope arrives.
8. On the first JSON envelope with `sessionID`, adopts the session ID if unset or verifies it matches the resumed session. Emits `session_started` once per session.
9. Maps JSON envelopes and tolerated plain-text lines into domain events.
10. After stdout drains and the process exits, runs `opencode export --sanitize <sessionID>` to recover final token usage.
11. Returns a `TurnResult` based on the terminal error envelope, cancellation state, startup timeout, or process exit status.

### `StopSession`

Marks the session closed and terminates the currently running turn subprocess, if any.

1. Marks the session closed and detaches the active turn runtime from session state.
2. Sends a graceful process-group signal when a turn is still running.
3. Waits up to 5 seconds for the subprocess to exit.
4. Force-kills the process group if it is still alive after the grace window.
5. Returns `ctx.Err()` if the caller's `StopSession` context expires first.

Safe to call when no subprocess is active.

### `EventStream`

Returns `nil`. The adapter delivers all events synchronously through `RunTurn`'s `OnEvent` callback.

---

## Process shutdown

The OpenCode adapter uses `exec.CommandContext`, not `exec.Command`. This is a deliberate deviation from the earlier CLI adapters.

Before start, the adapter places the subprocess in its own process group via the shared `procutil` package. It also overrides `cmd.Cancel` to send a graceful signal to the process group and sets `cmd.WaitDelay` to 5 seconds. On Unix, graceful shutdown is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful shutdown is `CTRL_BREAK_EVENT` to the process group, and `AssignProcess` attaches a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree.

Shutdown is turn-scoped, not session-scoped. `StopSession` performs an explicit graceful-to-force sequence. Turn-context cancellation is stricter: `CommandContext` triggers the graceful cancel hook, and the adapter's cancellation path also force-kills the process group during teardown if the process is still alive. After `cmd.Wait` returns, the adapter performs a best-effort group kill to clean up surviving children.

---

## Event stream

The adapter reads stdout as newline-delimited envelopes. Most lines are JSON objects from `opencode run --format json`. Permission rejection warnings can also appear as plain text on stdout even in JSON mode. The stdout scanner allows up to 10 MB per line to accommodate large tool payloads.

### Event type mapping

| OpenCode stdout line | Domain event type | Notes |
|---|---|---|
| First JSON envelope with `sessionID` on a session that has no stored ID | `session_started` | Synthetic adapter event. Emitted once per session. |
| `step_start` | `notification` | Emits message `step started`. |
| `text` | `notification` | Emits `part.text`, truncated to 500 runes. |
| `reasoning` | `other_message` | Emits fixed message `reasoning block`. Requires `--thinking`. |
| `tool_use` with `part.state.status = "completed"` | `tool_result` | Emits `ToolName`, `ToolDurationMS`, and `ToolError=false`. |
| `tool_use` with `part.state.status = "error"` | `tool_result` | Emits `ToolName`, `ToolDurationMS`, `ToolError=true`, and truncated `part.state.error`. |
| `step_finish` | `notification` | Emits message `step finished: <reason>`. Step token payload is ignored for final accounting. |
| `error` | `turn_failed` | Message comes from `error.data.message`, falling back to `error.name`. |
| `! permission requested: ...` plain-text line | `notification` | Passed through verbatim. This is a documented drift case in `--format json` mode. |
| Unknown JSON `type` | `malformed` | Emits `unknown event type: <type>`. |
| Known JSON `type` with invalid payload | `malformed` | Emits `invalid <event> payload`. |
| Any other non-JSON stdout line | `malformed` | Emits the raw line, truncated to 500 runes. |

### Result event fields

OpenCode does not emit a dedicated final result envelope. The adapter reads these terminal fields from the envelopes that determine session identity, tool status, and failure state.

| Field path | Type | Description |
|---|---|---|
| `sessionID` | string | Session identifier on every JSON envelope. Adopted from the first event or verified against the resumed session ID. |
| `error.name` | string | Fallback terminal error name when `error.data.message` is absent. |
| `error.data.message` | string | Preferred terminal failure message for `turn_failed`. |
| `part.reason` | string | Step-finish reason used in notification text. |
| `part.text` | string | Text notification body, truncated to 500 runes. |
| `part.tool` | string | Tool name for `tool_result`. |
| `part.state.status` | string | `completed` or `error`. Drives `ToolError`. |
| `part.state.error` | string | Tool error detail, truncated to 500 runes when emitted. |
| `part.state.time.start` | integer | Tool start time in milliseconds since epoch. |
| `part.state.time.end` | integer | Tool end time in milliseconds since epoch. |

### Non-JSON output handling

If a stdout line fails JSON parsing and begins with `! permission requested:`, the adapter emits a `notification` event instead of treating the line as a protocol failure. This compensates for the documented drift where OpenCode prints permission warnings to stdout before the JSON `tool_use` error envelope.

Any other non-JSON line becomes `malformed`. Before the first JSON envelope arrives, all plain-text lines still reset the startup `read_timeout_ms` timer.

---

## Token accounting

The adapter does not trust `step_finish.part.tokens` as the final turn total. It recovers authoritative usage from a second subprocess after the main turn exits.

### Accumulation logic

1. After the main `opencode run` subprocess exits, `finalizeExitedTurn` calls `queryExportUsage` when a session ID is known.
2. `queryExportUsage` launches a second subprocess with `opencode export --sanitize <sessionID>` in the same workspace.
3. The export subprocess runs with the same managed environment as the turn subprocess: `OPENCODE_AUTO_SHARE=false`, `OPENCODE_DISABLE_AUTOCOMPACT=<bool>`, `OPENCODE_DISABLE_AUTOUPDATE=true`, `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, and optional `OPENCODE_PERMISSION=<json>`.
4. The export subprocess timeout is `min(2 * read_timeout_ms, 30s)`. With the workflow default `read_timeout_ms: 5000`, the export timeout is 10 seconds.
5. The parser unmarshals the export JSON, scans `messages` in reverse order, and selects the most recent `assistant` message whose `info.sessionID` matches the current session.
6. It reads `info.tokens.input`, `info.tokens.output`, optional `info.tokens.total`, and optional `info.tokens.cache.read`.
7. `total_tokens` defaults to `input + output` when `tokens.total` is absent.
8. If export setup fails, the subprocess exits non-zero, the JSON is malformed, or no matching assistant message with tokens exists, usage falls back to zero. The adapter logs a warning and emits no `token_usage` event.

The adapter emits at most one `token_usage` event per turn, after the export subprocess succeeds. It does not emit any token event when every recovered token counter is zero.

### Model tracking

The main stdout stream does not supply a stable final model identifier. The adapter reconstructs `Model` only from the export payload, using `info.providerID + "/" + info.modelID` when both fields are present.

Per-model attribution works only when the export payload includes both values. The adapter parses `info.cost` from the export payload but does not surface cost on normalized domain events.

### API timing

The adapter does not emit per-request API timing and does not populate `APIDurationMS` on completion, failure, or token events. The export subprocess runs after the main turn exits inside its own timeout window, but its duration is not surfaced as a separate metric.

---

## Tool call tracking

### Correlation

OpenCode's CLI envelope already carries terminal tool state. The adapter does not correlate a start event with a later completion event.

1. Parses the `tool_use` envelope.
2. Reads the tool name from `part.tool`.
3. Computes duration from `part.state.time.end - part.state.time.start`.
4. Sets `ToolError` when `part.state.status` equals `error`.

`callID` is parsed but not used for cross-event correlation.

### Tool error detail

When `part.state.status` is `error`, the adapter copies `part.state.error` into the normalized event message and truncates it to 500 runes. It does not strip XML wrappers, ANSI sequences, or stderr text.

Permission rejections surface as OpenCode reports them, for example: `The user rejected permission to use this specific tool call.`

---

## Error handling

### Exit code mapping

| Condition | Exit reason | Error kind | Description |
|---|---|---|---|
| Stdout `error` envelope observed, process exits `0` | `turn_failed` | _(none)_ | Structured logical failure. Compensates for OpenCode returning exit code `0` on failure. |
| Stdout `error` envelope observed, process exits non-zero | `turn_failed` | _(none)_ | Structured error still takes precedence over the process exit status. |
| No `error` envelope, clean exit `0` after the first JSON envelope | `turn_completed` | _(none)_ | Normal completion. |
| No `error` envelope, non-zero exit after the first JSON envelope | `turn_ended_with_error` | `port_exit` | Process-level failure. Message is `opencode exited with code N` or the wait error text. |
| Process exits before the first JSON envelope | `turn_ended_with_error` | `port_exit` | Startup or protocol failure before session establishment. |
| Turn context cancelled | `turn_cancelled` | _(none)_ | Cancellation wins over process-exit classification. |
| Session stopped via `StopSession` | `turn_cancelled` | _(none)_ | Closed-session teardown path. |

The adapter never trusts exit code `0` as sufficient proof of success. A terminal stdout `error` envelope is authoritative.

### Stdout scanner failure

If the stdout scanner returns an error while the turn is still active, the adapter:

1. Emits `turn_ended_with_error` with message `stdout read error`.
2. Stops the reader loop and kills the process group.
3. Re-emits collected stderr lines at WARN level.
4. Returns an `AgentError` with kind `response_error`.

If the scanner fails while the turn is already being cancelled or stopped, the adapter returns `turn_cancelled` instead.

### Stall detection

The adapter does not run its own inter-event stall timer. `read_timeout_ms` only covers startup and waits for the first JSON envelope, although plain-text stdout lines reset that timer before the first JSON line arrives.

After the first JSON envelope, stall detection is orchestrator-owned. The adapter emits `notification` or `malformed` events for plain-text warnings, unknown JSON types, and normal OpenCode envelopes so the orchestrator's `stall_timeout_ms` watchdog can observe output activity. When the orchestrator cancels a stalled turn, `RunTurn` tears down the process and returns `turn_cancelled`.

---

## Session resume mechanism

OpenCode continuation is flag-based. The adapter persists the OpenCode session ID and passes it back on the next subprocess launch.

| Turn state | Stored session ID | CLI flag |
|---|---|---|
| Fresh session before first JSON envelope | Empty | _(no `--session` flag)_ |
| Subsequent turn in the same worker session | Known | `--session <sessionID>` |
| Continuation after worker restart | `ResumeSessionID` from orchestrator | `--session <sessionID>` |

The adapter never uses `--continue` or `--fork`.

If a resumed turn emits a different `sessionID` from the one already stored, the adapter aborts the turn with `response_error` and emits `turn_ended_with_error`. `session_started` is emitted only once per session, on the first accepted JSON envelope.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches the local `ssh` client and runs OpenCode on the remote host. The process model stays launch-per-turn: each turn is a separate SSH invocation that wraps one remote `opencode` subprocess, and the export recovery step uses a second SSH invocation.

### How it works

1. `StartSession` resolves the local `ssh` binary. It does not validate the remote `opencode` binary at this stage.
2. `RunTurn` prefixes managed `OPENCODE_*` variables onto the remote command string.
3. `sshutil.BuildSSHArgs` wraps the turn command as `cd -- '<workspace>' && <remoteCommand> 'run' '--format' 'json' ...`.
4. `queryExportUsage` uses the same SSH path with `export --sanitize <sessionID>`.

### SSH options

The adapter uses the shared `sshutil` transport defaults:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). Allowed values: `accept-new`, `yes`, `no`. |
| `BatchMode` | `yes` | Disables interactive prompts. |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### Shell quoting

The workspace path, adapter-generated OpenCode arguments, and managed environment-variable values are single-quoted with standard POSIX escaping before they are embedded in the remote shell command. The configured remote base command itself is treated as a pre-formed shell fragment. Quoting inside `agent.command` is the operator's responsibility.

### Exit codes

SSH exit codes `255` and `127` are not special-cased. They fall through the adapter's generic non-zero process-exit branch and map to `port_exit` unless OpenCode already emitted a terminal stdout `error` envelope. Exit code `0` is still not sufficient to prove success, because OpenCode can emit a terminal `error` envelope and still exit `0`.

---

## Authentication

In local mode, the adapter launches OpenCode with the parent process environment plus managed `OPENCODE_*` overrides. OpenCode then resolves provider credentials from its own environment, auth store, project `.env`, or `opencode.json` provider config. In SSH mode, the adapter prefixes only managed `OPENCODE_*` variables on the remote command. Provider credentials are not forwarded to the remote host.

`StartSession` performs no authentication preflight. It checks no provider environment variables and does not call `opencode providers`, `opencode auth`, or any provider-specific login command.

The research notes explicitly evidence these provider environment-variable families and configuration entry points:

| Provider or source | Variables or config | Adapter behavior |
|---|---|---|
| Anthropic direct | `ANTHROPIC_API_KEY` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| OpenAI direct | `OPENAI_API_KEY` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| Google direct | `GOOGLE_API_KEY` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| AWS-backed providers | `AWS_*` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| GitLab Duo | `GITLAB_TOKEN` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| Cloudflare-backed providers | `CLOUDFLARE_*` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| Google / Vertex-backed providers | `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION` | Passed through unchanged in local mode. Must already exist on the remote host in SSH mode. |
| OpenCode provider config injection | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` | Points OpenCode at config content without modifying the repository workspace. |
| Interactive auth store | `~/.local/share/opencode/auth.json` from `opencode providers login` or `opencode auth login` | Used by OpenCode itself. The adapter does not inspect it. In SSH mode, the remote host uses its own store. |

{{< callout type="warning" >}}
**SSH mode does not forward provider credentials.** The adapter only prefixes managed `OPENCODE_*` variables on the remote command. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `AWS_*`, `GITLAB_TOKEN`, `CLOUDFLARE_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, and `VERTEX_LOCATION` must already exist on the remote host, or the remote OpenCode install must already be authenticated through its own config or auth store.
{{< /callout >}}

---

## Concurrency safety

The adapter is safe for concurrent use. One `OpenCodeAdapter` instance serves all sessions. Per-session state is isolated in the opaque `Session.Internal` handle.

Within a session, a mutex guards the stored session ID, closed flag, and active turn runtime. One reader goroutine owns stdout. A separate wait goroutine does not call `cmd.Wait` until the reader goroutine finishes draining stdout, then stores the result behind `waitMu` and closes `waitCh`. This prevents `cmd.Wait` from racing the scanner on the stdout pipe.

---

## Adapter registration

The adapter registers itself under kind `"opencode"` via an `init` function in `internal/agent/opencode`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |

The orchestrator's preflight validation uses this metadata to require a non-empty `agent.command` field for `agent.kind: opencode`. Binary lookup still happens during `StartSession` via `exec.LookPath`.

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex | OpenCode |
|---|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` | `opencode` |
| Default command | `claude` | `copilot` | `codex app-server` | `opencode` |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns | New process per turn, plus a second `export` subprocess after each turn |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout | CLI flags + newline-delimited stdout envelopes |
| Output format flag | `--output-format stream-json` | `--output-format json` | JSON-RPC notifications | `--format json` |
| Session ID source | UUID generated by adapter | Discovered from `result` event | Thread ID from `thread/start` response | Discovered from the first JSON envelope, or resumed via `--session` |
| Resume mechanism | `--resume <UUID>` | `--resume <sessionId>` or `--continue` fallback | `thread/resume` or automatic within session | `--session <sessionID>` only |
| Input token reporting | Per-request cumulative | Not available (always 0) | Per-turn from `turn/completed` | Recovered from `opencode export --sanitize` |
| Model reporting | From `assistant` events | Not available | Not available | Recovered from export `providerID/modelID` only |
| Token accounting source | Event stream, with `result` fallback | Event stream output tokens only | `turn/completed` usage object | Separate `export` subprocess after main turn exit |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + explicit tool scoping | `approvalPolicy` and sandbox policy in JSON-RPC | `--dangerously-skip-permissions` plus synthesized `OPENCODE_PERMISSION` JSON |
| Sandbox enforcement | None at adapter level | None at adapter level | OS-level sandbox plus configurable policy | No adapter-level sandbox; permission policy only |
| Dynamic tools | MCP sidecar via `--mcp-config` | MCP sidecar via `--additional-mcp-config` | `dynamicTools` on `thread/start` | None injected by this adapter |
| Authentication | `ANTHROPIC_API_KEY` and provider routing flags | GitHub token variables or `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth from env, auth store, `.env`, or `opencode.json`; SSH mode does not forward provider env vars |
| Provider multiplexing | Anthropic direct, Bedrock, Vertex | GitHub only | OpenAI or cached Codex auth | Multi-provider through OpenCode model/provider config |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None | None exposed by the adapter |
| Exit-code reliability | Structured result event plus process exit | Structured `result.exitCode` plus process exit | JSON-RPC turn status | Process exit alone is unreliable. Terminal stdout `error` can still exit `0`. |
| Non-JSON stdout tolerance | Not required | Not required | Not applicable | Required. Permission warnings can appear as plain text in `--format json` mode. |

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `opencode` extension block
- [Environment variables reference](/reference/environment/) - runtime environment behavior and configuration overrides
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - orchestrator-level cost caps that matter most for OpenCode
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
