---
title: "OpenCode CLI Adapter"
description: "Complete reference for the OpenCode CLI agent adapter: configuration, session lifecycle, CLI argument mapping, event stream, token accounting via export subprocess, error handling, SSH remote execution, and multi-provider authentication."
author: Sortie AI
date: 2026-04-26
weight: 130
url: /reference/adapter-opencode/
---
The OpenCode adapter connects Sortie to the [OpenCode CLI](https://opencode.ai/docs/cli/) via subprocess management. It launches `opencode run --format json`, reads newline-delimited stdout envelopes, reads the runtime's permission warnings from stderr, and normalizes the stream into domain event types. Registered under kind `"opencode"`.

Each `RunTurn` call spawns a fresh subprocess. One reader goroutine owns stdout, the adapter emits activity-visible events so the orchestrator stall watchdog can observe progress, per-session state is mutex-guarded, and `StartSession` performs no binary canary check or authentication preflight. The CLI accepts no MCP configuration path, so on a local launch the adapter translates the generated configuration into OpenCode's own form and delivers it in the turn's environment; see [MCP](#mcp).

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
| `read_timeout_ms` | integer | `5000` (5 seconds) | Bounds the wait for the turn's first JSON envelope, and, doubled and capped at 30 seconds, the post-turn `export` and `models` subprocesses. It does not bound anything after the first envelope arrives. Falls back to 30 seconds when unset or not positive. |
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
| `pure` | `--pure` | boolean | `false` | Runs OpenCode without external plugins. |
| `dangerously_skip_permissions` | `--dangerously-skip-permissions` | boolean | `true` | Auto-approves permission requests that are not explicitly denied by policy. Omitted when `false`, which makes the runtime auto-reject every permissioned tool call; see [validate-time checks](#validate-time-checks). |
| `disable_autocompact` | `OPENCODE_DISABLE_AUTOCOMPACT` | boolean | `true` | Managed environment override applied to both `run` and `export` subprocesses. |
| `allowed_tools` | `OPENCODE_PERMISSION` | list of strings | `[]` | Builds an allowlist policy. Listed permission keys become `allow`. Every known key not listed becomes `deny`. Unknown keys are forwarded unchanged. |
| `denied_tools` | `OPENCODE_PERMISSION` | list of strings | `[]` | Adds `deny` entries to the managed permission policy. When combined with `allowed_tools`, denied keys override allowed keys. Overlap is rejected during adapter construction. |
| `mcp_config` | _(none; read by the worker)_ | string | _(none)_ | Path to an operator-supplied MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the generated configuration, and the adapter translates the merged result into OpenCode's own configuration document on a local launch. See [MCP](#mcp). |

The adapter always adds `run --format json --dir <workspace> -- <prompt>`.

```yaml
opencode:
  model: <provider>/<model-id>
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

This is the set this version of the adapter knows about, not a catalogue of OpenCode's tools. A key OpenCode adds later is unknown to the adapter until the adapter learns it, and an unknown key you write is forwarded unchanged.

The adapter also manages these environment variables on every subprocess:

| Variable | Value |
|---|---|
| `OPENCODE_AUTO_SHARE` | `false` |
| `OPENCODE_DISABLE_AUTOCOMPACT` | `true` or `false`, from `opencode.disable_autocompact` |
| `OPENCODE_DISABLE_AUTOUPDATE` | `true` |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `true` |
| `OPENCODE_PERMISSION` | JSON-encoded policy, only when tool scoping is configured |

The adapter also sets `OPENCODE_CONFIG_CONTENT` on a local turn subprocess when the session carries a translated MCP configuration; see [MCP](#mcp). It is not part of the managed set above and is never prefixed onto an SSH remote command.

Before adding its managed values, the adapter strips all five of those variables, and `OPENCODE_CONFIG_CONTENT`, out of the inherited environment, so an operator-side value never reaches the subprocess. It does not remove permission rules from `opencode.json`, so OpenCode still deep-merges the adapter policy with on-disk configuration.

---

## Validate-time checks

When `agent.kind` is `opencode`, the [`sortie validate`](/reference/cli/#validate) pipeline runs OpenCode-specific config checks in addition to the generic preflight validation. They construct no adapter instance and launch no subprocess, and the same checks run at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `opencode.allowed_tools.overlap` | `allowed_tools` and `denied_tools` name at least one of the same keys | `allowed_tools and denied_tools overlap: <keys>` |

The adapter constructor reports the overlap with the same message, so the two paths can never disagree.

### Warnings

| Check | Condition | Message |
|---|---|---|
| `opencode.dangerously_skip_permissions.auto_reject` | `dangerously_skip_permissions` is explicitly `false` | `opencode.dangerously_skip_permissions is set to false, so the runtime auto-rejects every permissioned tool call and reports each rejection as a warning rather than performing the call` |

This is a warning rather than an error. Warnings leave `valid` true and the exit code `0`. The runtime rejects the request itself and the session goes on, so the setting never leaves a turn waiting for a person; it does stop the agent from using any permissioned tool. An absent or `true` value draws nothing.

---

## Session lifecycle

### `StartSession`

Validates the workspace path, resolves the launch target, and initializes adapter-owned session state. No OpenCode subprocess is started.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the configured command via `exec.LookPath`, defaulting to `opencode` when `agent.command` is empty. In SSH mode, resolves the local `ssh` binary instead and stores the remote command string for later use.
3. On a local launch, reads the generated MCP configuration and renders it into OpenCode's own configuration document, holding the result for every turn of the session. Skipped entirely in SSH mode. See [MCP](#mcp).
4. Copies `ResumeSessionID` into session state when continuation is requested.
5. Returns an opaque `Session` handle with per-session state, no running PID, and no started subprocess.

`StartSession` performs no version canary, no provider-auth probe, and no remote OpenCode binary check.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| Local OpenCode binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |
| Generated MCP configuration unreadable or not expressible | `response_error` |

### `RunTurn`

Spawns one OpenCode subprocess, reads stdout through a single reader goroutine, and delivers normalized events via `OnEvent`.

1. Builds the managed environment and the per-turn argument list.
2. Adds `run --format json --dir <workspace>` to every invocation.
3. Adds `--session <id>` when the session already has an OpenCode session ID.
4. Launches the subprocess locally or through SSH, with `cmd.Dir` set to the workspace and `cmd.Env` set to the inherited environment plus managed `OPENCODE_*` overrides, and, on a local launch carrying one, the translated MCP configuration document.
5. Configures process-group isolation before start, then sets `cmd.Cancel` to a graceful process-group signal and `cmd.WaitDelay` to 5 seconds.
6. Starts one stderr collector goroutine, one stdout reader goroutine, and one wait goroutine.
7. Applies a startup timer derived from `read_timeout_ms`. Plain-text stdout lines reset the timer before the first JSON envelope arrives.
8. On the first JSON envelope with `sessionID`, adopts the session ID if unset or verifies it matches the resumed session. Emits `session_started` once per session.
9. Maps JSON envelopes and tolerated plain-text lines into domain events.
10. After stdout drains and the process exits, runs `opencode export --sanitize <sessionID>` to recover final token usage, and, on a masked failure, `opencode models` to reconstruct the diagnostic; see [masked failures](#masked-failures).
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

The OpenCode adapter uses `exec.CommandContext` with its default cancel behavior overridden - the same pattern the shared `agentcore.ForkPerTurnSession` skeleton uses for the Claude Code, Copilot CLI, and Kiro adapters. This adapter implements the pattern itself rather than going through that skeleton, because `RunTurn` needs a deadline on the first stdout line rather than on the whole turn, and a post-exit subprocess query to recover usage that the skeleton has no hook for.

Before start, the adapter places the subprocess in its own process group via the shared `procutil` package. It also overrides `cmd.Cancel` to send a graceful signal to the process group and sets `cmd.WaitDelay` to 5 seconds. On Unix, graceful shutdown is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful shutdown is `CTRL_BREAK_EVENT` to the process group, and `AssignProcess` attaches a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree.

Shutdown is turn-scoped, not session-scoped. `StopSession` performs an explicit graceful-to-force sequence. Turn-context cancellation is stricter: `CommandContext` triggers the graceful cancel hook, and the adapter's cancellation path also force-kills the process group during teardown if the process is still alive. After `cmd.Wait` returns, the adapter performs a best-effort group kill to clean up surviving children.

---

## Event stream

The adapter reads stdout as newline-delimited envelopes. Most lines are JSON objects from `opencode run --format json`. Permission rejection warnings can also appear as plain text on stdout even in JSON mode. The stdout scanner allows up to 10 MB per line to accommodate large tool payloads.

### What the adapter emits

The adapter maps each envelope onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. OpenCode's own envelope types and their fields are OpenCode's to define; see [external references](#external-references).

Two behaviours are the adapter's own. Every stdout line that fails to parse becomes a `malformed` event, truncated, rather than failing the turn, and a plain-text line still resets the startup read timer. A permission request the runtime auto-rejects surfaces twice, as a `tool_result` carrying the tool error and as a `notification`; the turn is not ended and no consent was granted. Sortie scans stderr for those rejections only after the process exits.

---

## Token accounting

The adapter does not trust `step_finish.part.tokens` as the final turn total. It recovers authoritative usage from a second subprocess after the main turn exits. Reported counts are cumulative over the whole session the orchestrator opened, across every turn of it, and never decrease.

### Accumulation logic

1. After the main `opencode run` subprocess exits, the adapter launches a second subprocess with `opencode export --sanitize <sessionID>` in the same workspace, when a session ID is known.
2. The export subprocess runs with the same managed environment as the turn subprocess: `OPENCODE_AUTO_SHARE=false`, `OPENCODE_DISABLE_AUTOCOMPACT=<bool>`, `OPENCODE_DISABLE_AUTOUPDATE=true`, `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, and optional `OPENCODE_PERMISSION=<json>`.
3. The export subprocess timeout is `min(2 * read_timeout_ms, 30s)`, where an unset or non-positive `read_timeout_ms` counts as 30 seconds. With the workflow default `read_timeout_ms: 5000`, the export timeout is 10 seconds.
4. The parser unmarshals the export JSON and sums **every** `assistant` message whose `info.sessionID` matches the current session, not just the most recent one. When the run resumed an existing session, messages created before the run started are excluded, so a resumed session's earlier spend never lands in this run's total.
5. From each message it reads `info.tokens.input`, `info.tokens.output`, and the optional `info.tokens.reasoning`, `info.tokens.cache.read`, and `info.tokens.cache.write`. A message with no `tokens` object, or without both `input` and `output`, is skipped.
6. `input_tokens` is `input + cache.read + cache.write`; `output_tokens` is `output + reasoning`; `cache_read_tokens` carries `cache.read` separately as a subset of input; `total_tokens` is computed as `input_tokens + output_tokens` rather than read from `tokens.total`, which counts cache and reasoning tokens on a different basis.
7. If export setup fails, the subprocess exits non-zero, the JSON is malformed, or no matching assistant message with tokens exists, the adapter logs a warning, emits no `token_usage` event, and leaves the previously reported snapshot in place rather than lowering it to zero.

The adapter emits at most one `token_usage` event per turn, after the export subprocess succeeds. It emits no token event when every recovered counter is zero, and a session for which no export ever produced a figure is recorded as unmeasured rather than as having spent zero.

### Model tracking

The main stdout stream does not supply a stable final model identifier. The adapter reconstructs `Model` only from the export payload, using `info.providerID + "/" + info.modelID` from the last counted assistant message, when both fields are present.

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
4. Sets `ToolError` when `part.state.status` equals `error`, compared case-insensitively.

`callID` is parsed but not used for cross-event correlation.

### Tool error detail

When `part.state.status` is `error`, the adapter copies `part.state.error` into the normalized event message and truncates it to 500 runes. It does not strip XML wrappers, ANSI sequences, or stderr text.

A rejected permission request reaches the message field as whatever the runtime wrote into `part.state.error`; the adapter neither recognizes nor rewrites that text. The separate `notification` for a rejection comes from a stderr line beginning `! permission requested:`, matched after the process exits.

---

## Error handling

### Turn outcome

An error kind is absent only on a `turn_completed` outcome; every other outcome carries one.

| Condition | Exit reason | Error kind | Description |
|---|---|---|---|
| No JSON envelope arrived within `read_timeout_ms` of launch | `turn_failed` | `response_timeout` | Message is `timed out waiting for first opencode json event`. The subprocess is killed and its stderr re-emitted at WARN level. |
| A JSON envelope carried a `sessionID` other than the one already adopted | `turn_failed` | `response_error` | Message is `session id mismatch: expected "...", got "..."`. The turn is aborted rather than reconciled. |
| Stdout `error` envelope observed, whatever the process exit status | `turn_failed` | `turn_failed` | Structured logical failure, authoritative over the exit code. Message is the envelope's own detail; see [masked failures](#masked-failures). |
| Turn context cancelled, or session stopped via `StopSession` | `turn_cancelled` | `turn_cancelled` | Message is `turn cancelled`. Cancellation outranks the process-exit classification. |
| No `error` envelope, exit `0`, at least one `text`, `reasoning`, or `tool_use` part parsed | `turn_completed` | _(none)_ | Normal completion. |
| No `error` envelope, exit `0`, no such part parsed | `turn_failed` | `turn_failed` | The model produced nothing this turn. Message is `agent exited without producing output: no assistant output on the run stream`. |
| No `error` envelope, non-zero exit | `turn_failed` | `port_exit` | Process-level failure. Message is `exit code N`. |

The adapter never trusts exit code `0` as sufficient proof of success. A terminal stdout `error` envelope is authoritative.

### Masked failures

When the only failure detail on the stream is OpenCode's generic server-error placeholder, the adapter runs a third subprocess - `opencode models`, in the same workspace, under the same managed environment and the same timeout as the export - and compares the configured `opencode.model` against the catalog it prints. When the model is absent from a non-empty catalog, the terminal message is replaced with `Model not found: <model>`. The lookup is skipped when no model is configured, and any other masked cause reaches the operator as the placeholder unchanged.

### Stdout scanner failure

If the stdout scanner returns an error while the turn is still active, the adapter:

1. Emits `turn_failed` with message `stdout read error`.
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


If a resumed turn emits a different `sessionID` from the one already stored, the adapter aborts the turn with `response_error` and emits `turn_failed`. `session_started` is emitted only once per session, on the first accepted JSON envelope.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches the local `ssh` client and runs OpenCode on the remote host. The process model stays launch-per-turn: each turn is a separate SSH invocation that wraps one remote `opencode` subprocess, and the export recovery step uses a second SSH invocation.

### How it works

1. `StartSession` resolves the local `ssh` binary. It does not validate the remote `opencode` binary at this stage.
2. `RunTurn` prefixes managed `OPENCODE_*` variables onto the remote command string. The translated MCP configuration document is not among them and is never rendered onto a remote command; see [MCP](#mcp).
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

Sortie does not manage OpenCode credentials and runs no authentication preflight for this adapter. The subprocess inherits the Sortie process environment, so whichever provider credentials OpenCode expects must already be present there. Which providers OpenCode supports, and which variable each one reads, is OpenCode's to document; see [external references](#external-references).

{{< callout type="warning" >}}
**SSH mode forwards no provider credentials.** The adapter prefixes only the managed `OPENCODE_*` variables onto the remote command, so the remote host must already be authenticated for the model you select. A run that works locally can fail on a remote host for this reason alone.
{{< /callout >}}

---

## MCP

The OpenCode CLI accepts no MCP configuration path as an argument, and it does not read the `mcpServers` key the generated `.sortie/mcp.json` is written under. The adapter delivers the servers rather than the file: on a local launch, `StartSession` reads the generated configuration and renders its servers into OpenCode's own configuration document, keyed under `mcp`, with a stdio server becoming a local entry and an HTTP server a remote one. A server entry that omits its enable flag is rendered enabled, matching the runtime's own default.

`RunTurn` sets that document on the turn subprocess through the runtime's inline-configuration environment variable, `OPENCODE_CONFIG_CONTENT`. The runtime merges it with whatever project or global configuration the operator already has, rather than replacing it. The variable is added to the turn subprocess's environment only. The auxiliary `export` and `models` invocations the adapter also runs rebuild their environment without it, so neither spawns a tool sidecar of its own. Any `OPENCODE_CONFIG_CONTENT` inherited from the orchestrator's own environment is stripped first, on every one of the three.

### SSH mode delivers nothing

A remote session receives no document. This adapter renders its managed environment as `KEY=<value>` onto the remote command string, and doing the same with the generated configuration would publish its credential values on the local `ssh` process's own argument list, where any other user of the orchestrator host can read them. The adapter delivers nothing rather than pay that price, so an OpenCode session on an SSH host reaches none of Sortie's tools and its first-turn prompt carries no tool advertisement.

### Startup failures

The run projection this adapter reads carries no MCP startup signal, so a server that fails to start produces no distinct diagnostic here. It surfaces only indirectly, as the agent's own tool calls failing.

### `mcp_config`

`opencode.mcp_config` names an operator-supplied MCP server configuration file. The worker reads it, merges its servers with the `sortie-tools` entry into the generated copy, and the adapter translates the merged result, so an operator's own servers reach a local OpenCode session alongside Sortie's. A relative path resolves against the directory containing `WORKFLOW.md`. An unreadable path, a file that is not valid JSON, or a file already declaring a server named `sortie-tools` fails the attempt before the session starts.

Two more conditions fail the session with `response_error` when the merged configuration reaches the adapter, and the message names the offending server: an entry that carries neither `command` nor `url`, carries both, or declares a `type` contradicting the fields it carries; and an entry carrying a key outside the modeled set, which is `type`, `command`, `args`, `env`, `url`, `headers`, and `enabled`. Both are the shared parser's, so a file that fails here fails a `codex` session the same way. A header on an HTTP entry is carried into the document as written, which a `codex` session does not do; see the [Codex adapter reference](/reference/adapter-codex/#http-headers).

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
| `ValidateAgentConfig` | the checks described in [Validate-time checks](#validate-time-checks) |
| `MCPInjection` | `translated` - the adapter re-expresses the generated configuration's servers in the form its runtime parses, and delivers that on a local launch only. See [MCP](#mcp). |

The orchestrator's preflight validation uses `RequiresCommand` to require a non-empty `agent.command` field for `agent.kind: opencode`. Binary lookup still happens during `StartSession` via `exec.LookPath`.

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex | OpenCode |
|---|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` | `opencode` |
| Default command | `claude` | `copilot` | `codex app-server` | `opencode` |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns | New process per turn, plus an `export` subprocess after each turn and a `models` subprocess after a masked failure |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout | CLI flags + newline-delimited stdout envelopes |
| Output format flag | `--output-format stream-json` | `--output-format json` | JSON-RPC notifications | `--format json` |
| Session ID source | UUID generated by adapter | Discovered from `result` event | Thread ID from `thread/start` response | Discovered from the first JSON envelope, or resumed via `--session` |
| Resume mechanism | `--resume <UUID>` | `--resume <sessionId>` or `--continue` fallback | `thread/resume` or automatic within session | `--session <sessionID>` only |
| Input token reporting | Per-request, from the result event's per-model breakdown | Recovered from the runtime's session-state journal after exit | From `thread/tokenUsage/updated`, baseline-subtracted | Recovered from `opencode export --sanitize` |
| Model reporting | From `assistant` events | Not available | Not available | Recovered from export `providerID/modelID` only |
| Token accounting source | Result event `modelUsage`, with top-level `usage` fallback | Session-state journal on disk, with stream output tokens as the in-turn estimate | `thread/tokenUsage/updated` notification | Separate `export` subprocess after main turn exit |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + explicit tool scoping | `approvalPolicy` and sandbox policy in JSON-RPC | `--dangerously-skip-permissions` plus synthesized `OPENCODE_PERMISSION` JSON |
| Sandbox enforcement | None at adapter level | None at adapter level | OS-level sandbox plus configurable policy | No adapter-level sandbox; permission policy only |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as command-line overrides, local launch only | Generated servers re-expressed as an inline configuration document in the turn environment, local launch only - see [MCP](#mcp) |
| Authentication | `ANTHROPIC_API_KEY` and provider routing flags | GitHub token variables or `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth from env, auth store, `.env`, or `opencode.json`; SSH mode does not forward provider env vars |
| Provider multiplexing | Anthropic direct, Bedrock, Vertex | GitHub only | OpenAI or cached Codex auth | Multi-provider through OpenCode model/provider config |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None | None exposed by the adapter |
| Exit-code reliability | Structured result event plus process exit | Structured `result.exitCode` plus process exit | JSON-RPC turn status | Process exit alone is unreliable. Terminal stdout `error` can still exit `0`. |
| Non-JSON stdout tolerance | Not required | Not required | Not applicable | Required. Permission warnings can appear as plain text in `--format json` mode. |

---

## External references

- [OpenCode CLI documentation](https://opencode.ai/docs/cli/) - official command reference for `opencode run`, `opencode export`, and session flags
- [OpenCode configuration reference](https://opencode.ai/docs/config/) - `opencode.json` schema, provider auth store, and permission policy fields
- [`anomalyco/opencode` on GitHub](https://github.com/anomalyco/opencode) - source repository, releases, and issue tracker
- [OpenCode permissions documentation](https://opencode.ai/docs/permissions/) - semantics of the `OPENCODE_PERMISSION` policy this adapter synthesizes

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `opencode` extension block
- [Environment variables reference](/reference/environment/) - runtime environment behavior and configuration overrides
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - orchestrator-level cost caps that matter most for OpenCode
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
