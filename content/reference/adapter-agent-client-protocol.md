---
title: "Agent Client Protocol Adapter"
description: "Reference for the agent-client-protocol adapter: a generic, runtime-neutral kind that drives any Agent Client Protocol runtime named by agent.command, its session lifecycle, capability handling, permission refusal, and the transport-level limits every runtime on it shares."
author: Sortie AI
date: 2026-09-09
weight: 145
url: /reference/adapter-agent-client-protocol/
---
The Agent Client Protocol adapter connects Sortie to any runtime that speaks the [Agent Client Protocol](https://agentclientprotocol.com/), a newline-delimited JSON-RPC 2.0 protocol several coding-agent CLIs implement. It launches the runtime named by `agent.command` as a persistent subprocess, local or over SSH, performs an `initialize` handshake, and drives a session that survives across turns. Registered under kind `"agent-client-protocol"`.

Unlike every other agent kind, this one names no default runtime. `claude-code` always launches `claude` and `kiro` always launches `kiro-cli`; this kind launches whatever `agent.command` names, together with the flag or subcommand that puts that binary into protocol mode. One operator build of this adapter can therefore drive several different vendor runtimes, and this page describes only what the protocol and the adapter guarantee across all of them. What one specific runtime does with a capability the protocol leaves optional, and the launch switches that runtime needs, are covered on that runtime's own page: see [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/) and [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/).

Session start launches the subprocess once and keeps it alive for the whole session; each turn sends one `session/prompt` request on that same session rather than spawning a new process.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [Kiro CLI adapter reference](/reference/adapter-kiro/) for the other route to a runtime that also ships a hand-written kind.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `agent-client-protocol` extension block.

### `agent` section

These fields control the orchestrator's scheduling behavior. None of them is a protocol parameter; `agent.command` is the one field this kind reads differently from its siblings.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"agent-client-protocol"` to select this adapter. |
| `command` | string | _(none)_ | The runtime binary together with whatever flag or subcommand puts it into protocol mode, for example `gemini --acp` or `kiro-cli acp -a`. Required: this kind has no default binary. Resolved from `PATH` at session start; in SSH mode the local `ssh` binary is resolved instead and this value travels to the remote host as the command to run there. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator runs a turn up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `max_concurrent_agents_by_state` | map | `{}` | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single turn. The orchestrator cancels the turn when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Bounds every synchronous wait on the runtime: the `initialize`, `session/new`, `session/load`, and `session/resume` responses, the negative-control probe that precedes a continuation attempt, the bounded wait for a replayed chunk after a `session/load` response, the wait for a `session/prompt` response after the adapter has sent `session/cancel`, and, once any write to the runtime fails while a turn is active, the wait to see whether the connection's own end of stream arrives before the turn is finalized as a failed send instead. Falls back to 30 seconds when set to a non-positive value. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive emitted events before the orchestrator treats the turn as stalled. `0` or negative disables stall detection. |
| `stop_grace_ms` | integer | `5000` (5 seconds) | How long teardown waits for the subprocess to exit on its own after a graceful termination signal, before it force-terminates the process group. Also bounds, at half its value, the `session/close` call teardown sends when the handshake advertised that capability, and the wait for the session to finish answering every request it had open before teardown continues. Must be positive. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: agent-client-protocol
  command: gemini --acp
  max_turns: 15
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
```

### `agent-client-protocol` extension section

This kind reads exactly one pass-through field. Every other setting a specific runtime needs, such as a model flag or a trust switch, is part of `agent.command` rather than a field here, because those settings are the runtime's own and this kind has no runtime-specific schema.

| Field | Type | Default | Description |
|---|---|---|---|
| `mcp_config` | string | _(none)_ | Path to an operator-supplied MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the generated configuration; the adapter re-expresses the merged result on `session/new`. See [MCP](#mcp). |

```yaml
agent-client-protocol:
  mcp_config: ./mcp-servers.json
```

The block itself is never forwarded to the runtime; only `mcp_config` is checked, to reject the wrong YAML type before any session starts. What actually reaches a session is the resolved MCP configuration path, prepared by the worker the same way it is for every other kind.

---

## Validate-time checks

When `agent.kind` is `agent-client-protocol`, the [`sortie validate`](/reference/cli/#validate) pipeline runs this kind's own config check in addition to the generic preflight validation. It builds no adapter and launches no subprocess, and the same check runs at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `agent-client-protocol.mcp_config.wrong_type` | `agent-client-protocol.mcp_config` is present with a YAML type other than a string | Names the key and the type found. |

Building the adapter reports the same fault with the same message, so the two paths can never disagree.

This kind declares no check that would leave the runtime waiting for a person: unlike `codex.approval_policy` or `claude-code.permission_mode`, there is no pass-through field here whose value could put the runtime into an interactive posture, because whatever posture the runtime takes is spelled inside `agent.command` itself. See [permission handling](#permission-handling) for what happens when a runtime asks anyway.

---

## Session lifecycle

### Session start

Launches the subprocess, performs the `initialize` handshake, and creates or continues a session with `session/new`, `session/load`, or `session/resume`.

1. Resolves the launch target: validates that the workspace path is a non-empty absolute path pointing to an existing directory, and resolves `command` from `PATH` with no default to fall back to. In SSH mode, resolves the local `ssh` binary instead.
2. Parses the generated MCP configuration from the resolved configuration path on a local launch only; a remote launch holds no servers regardless of the path, because the protocol's stdio server declaration names an executable the remote host would have to resolve, and the configuration's environment block can carry tracker credentials that must not cross to a remote host. A server whose `enabled` field is present and `false` is dropped here.
3. Starts the subprocess with the full parent process environment, places it in its own process group, and wires stdin, stdout, and stderr.
4. Sends `initialize` with the pinned protocol version and no filesystem or terminal client capability. A response reporting any other protocol version ends the session, because the protocol defines no renegotiation and leaves the decision to disconnect to the client.
5. Renders the parsed MCP servers into the wire format `session/new` (or a continuation call) will carry, omitting any HTTP server when the handshake's `mcpCapabilities.http` is not `true`. A stdio server is never withheld this way; the protocol allows omitting a server type, not the whole channel.
6. Resolves the session: `session/new` alone when no session ID from a previous run is supplied, or the handshake advertises no continuation method; otherwise the advertised route, confirmed and falling back to `session/new` within this same call when not confirmed. See [session resume mechanism](#session-resume-mechanism).
7. Records the identifier to close through the protocol later, only when the handshake advertised `sessionCapabilities.close`.
8. The session records the identifier the runtime actually created as its session ID, and the subprocess PID as the agent's process ID.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty | `agent_not_found` |
| Local runtime binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |
| Generated MCP configuration unreadable or malformed | `response_error` |
| Subprocess failed to start, or a stdio pipe could not be created | `port_exit` |
| The connection ends, including the subprocess exiting or the standard-output wait described under [process shutdown](#process-shutdown) giving up, before `initialize`, `session/new`, `session/load`, or `session/resume` receives a response | `port_exit` |
| `initialize` timed out | `response_timeout` |
| `initialize` returned a protocol-level error, or reported a version other than the one this adapter is generated against | `response_error` |
| `session/new`, `session/load`, or `session/resume` returned a protocol-level error after continuation was not confirmed and the `session/new` fallback also failed | `response_error` |

### Turn

Sends one `session/prompt` request on the existing session and relays `session/update` notifications until the response arrives.

1. Submits the prompt to the session, then waits, bounded by `read_timeout_ms`, for it to accept or reject the request.
2. Sends `session/prompt` with the rendered text. Streams every recognized `session/update` notification as a normalized event for as long as the request is outstanding. See [event stream](#event-stream).
3. When the turn is cancelled, sends `session/cancel` once and keeps waiting, bounded by `read_timeout_ms`, for the runtime's own response to the prompt it already sent.
4. Ends the turn from the `session/prompt` response's `stopReason`, from a protocol-level error on that response, from the runtime's own cancellation acknowledgment, or from the bounded wait above elapsing. See [turn disposition](#turn-disposition).

Only one turn may be in flight per session. A second turn started while one is still active is refused with `response_error` before anything reaches the runtime.

### Session stop

Runs a fixed teardown order regardless of how far the session progressed, so a session that never finished starting is torn down the same way as one that ran turns: answer any request the session is still holding open, send `session/close` when the handshake advertised it, signal the process group to exit gracefully, close standard input, wait for the process to exit, force-terminate the process group unconditionally as a backstop, close standard output and the connection, collect stderr and reap, and release the pipes last. See [process shutdown](#process-shutdown).

---

## Process shutdown

| Step | What it does |
|---|---|
| Answer any open request | Answers any protocol request the session received but had not yet replied to, then waits, bounded the same way `session/close` is, both for that answer to finish being written and for it to actually reach the runtime. |
| Close the session | Sends `session/close` for the recorded session identifier, bounded by half of whatever remains of the graceful window, only when the handshake advertised `sessionCapabilities.close`. Does nothing otherwise. |
| Signal graceful termination | Sends a catchable termination signal to the launched process group. On a remote launch this reaches the local `ssh` relay's group, not the runtime itself. |
| Close standard input | Hands the runtime end-of-input immediately behind the signal, without waiting for that close to finish, so a close stuck at the OS level cannot delay the wait for exit or the force-terminate step that follows. |
| Wait for exit | Waits for the process to exit and be reaped, bounded by `stop_grace_ms` and by the orchestrator's own deadline, whichever is nearer. |
| Force-terminate the process group | Runs unconditionally after the wait, whatever it observed. This is the backstop for a descendant that escaped the direct child or a runtime that ignored every signal. |
| Close standard output and the connection | Releases the connection's own parked read and write. The standard-error read end stays open, because the drain below still needs it. |
| Drain stderr and reap | Collects diagnostics and reaps the process, bounded so this step never holds teardown open indefinitely. |
| Release the pipes | Closes both read ends the session owns. It runs last because the session owns them for its whole lifetime: closing either one earlier would cut off the stderr drain above while it is still reading buffered output, and a session that failed during startup reports its collected stderr after teardown finishes. |

On Unix, graceful termination is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful termination is `CTRL_BREAK_EVENT` to the process group, and the subprocess is assigned to a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree. The subprocess starts suspended and is resumed only after that assignment succeeds, so nothing it spawns can run before the job takes effect. A failed assignment logs WARN `process group assignment failed` and the runtime subprocess runs without a job; a failed resume logs WARN `process resume failed` and fails session start with error kind `port_exit`, the same row the errors table above gives for any subprocess that fails to start. Since this adapter launches the runtime once and keeps it alive for the whole session, a resume failure here means no turn for that session ever reaches the runtime.

A runtime that has already received its answer by the time the graceful signal reaches it can act on that answer and exit inside `stop_grace_ms` on its own, rather than still waiting on it once the force-terminate step runs. A runtime that never reads the answer still leaves teardown on schedule: the answer step completes within its own bound regardless, and the rest of the order runs as listed.

The runtime process can exit while a descendant it spawned still holds its standard-output handle open. Reaping the process does not close that handle, so a handshake call or a turn already waiting on the runtime's output keeps waiting; Sortie gives it up to five seconds past the reap, then stops waiting and closes standard output and the connection itself. A turn ended this way reports `port_exit` with the message `the agent runtime exited before the session finished collecting its output`; a turn started after this has already happened is refused with the same message before it reaches the runtime. Sortie logs `agent stdout was not fully collected before the session ended` at WARN, with the five-second bound in its `drain_bound` attribute. On a remote launch, the process watched for exit is the local `ssh` relay rather than the runtime on the far end. Stopping the session afterward still runs the fixed order above in full.

---

## Event stream

The Agent Client Protocol declares eleven `session/update` notification variants. The adapter maps each onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces.

| `session/update` variant | Normalized event |
|---|---|
| `agent_message_chunk` (text content) | `notification`, carrying the text, truncated to 500 runes |
| `agent_message_chunk` (non-text content) | `malformed`, message `agent sent a message chunk this client does not render` |
| `agent_thought_chunk` | `other_message`, message `reasoning block` |
| `user_message_chunk` | No event. This variant exists only as replay evidence for session continuation; the adapter observes it directly rather than through a normalized event. |
| `tool_call` | No event yet; the call is recorded internally, keyed by its own identifier, until its terminal update arrives. |
| `tool_call_update`, status `completed` or `failed` | `tool_result`, carrying the tool name, the duration between the call's begin and end, the error flag set when the status is `failed`, and the update's own `title` as the message, truncated to 500 runes and empty when the update carries none |
| `tool_call_update`, any other status | No event; the internal record is updated, nothing more. |
| `plan` | `other_message`, message `plan update` |
| `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` | No event; logged at debug level only |
| Any other, or unrecognized, discriminator value | `malformed` |

A notification naming a session identifier other than the one this session is running is dropped rather than normalized, once the session's own identifier is known.

---

## Turn disposition

The `session/prompt` response's `stopReason` decides how the turn ends, unless the adapter itself induced a cancellation or the runtime asked for something only a person could answer, either of which overrides whatever `stopReason` the response goes on to carry.

| `stopReason` | Outcome | Error kind |
|---|---|---|
| `end_turn` | `turn_completed` | _(none)_ |
| `refusal` | `turn_failed` | `turn_refused` |
| `max_tokens` | `turn_failed` | `turn_token_limit` |
| `max_turn_requests` | `turn_failed` | `turn_request_limit` |
| `cancelled`, and this adapter or the orchestrator asked for the cancellation | `turn_cancelled` | `turn_cancelled` |
| `cancelled`, and neither side asked for it | `turn_failed` | `turn_failed`, message `agent reported a cancelled stop reason without a cancellation on either side` |
| Any other value | `turn_failed` | `turn_outcome_unknown` |

Whether a runtime's own implementation actually produces every one of these five values, and what each one means for that runtime specifically, is that runtime's to document; see the runtime-specific pages linked at the top of this page. `refusal` and `max_tokens` are treated as non-retryable classification decisions rather than transport failures: a retry of the same input would meet the same refusal or the same limit. `max_turn_requests` is retryable with exponential backoff, since a fresh turn starts a new request budget on the runtime's side.

Two conditions precede a `stopReason` read at all: a protocol-level error on the response reports `response_error`, and a lost connection reports `port_exit`. A lost connection covers the subprocess exiting, the stream ending, and a write to the runtime failing while a turn is active, when the connection's own end of stream does not follow within `read_timeout_ms` of that failure; a line exceeding the connection's bound reports `turn_outcome_unknown` instead, because it is a different failure from losing the process. A lost connection also covers a runtime that exits while a descendant still holds its standard output open: rather than run until `stall_timeout_ms` or `turn_timeout_ms` catches it, this ends within a five-second bound; see [process shutdown](#process-shutdown) for the mechanism and message.

---

## Token accounting

A session on this kind reports no token usage: no figure arrives at any point in a turn, on a local launch or over SSH alike, and there is none to attribute to a model. Time-based budgeting through `agent.turn_timeout_ms` is the mechanism that applies instead. For this kind's declaration beside every other kind's, see the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind).

The transport carries no per-turn token counter the orchestrator can record. `session/prompt`'s response carries a stop reason and nothing else. The one usage notification the protocol defines, `usage_update`, reports the tokens currently in context, the context window's total size, and an optional cumulative session cost, none of which is the per-turn input and output count Sortie records; the adapter logs that notification at debug level and takes no figure from it.

No built-in path on this kind ever emits a `token_usage` event, so every session over this route is recorded unmeasured, contributes nothing to `agent.max_tokens`, advances no `sortie_tokens_total` series, is excluded from `sortie stats` token and cost figures, and is counted in that command's `tokens_unmeasured_runs`. The dashboard states this directly for a running session on this kind: its Usage reporting field reads `this session reports no token usage`, and the Model, API Requests, Tokens, and Est. Cost fields below it show an em dash rather than a zero. [`sortie validate`](/reference/cli/#validate) says the same offline when a workflow sets `agent.max_tokens` or prices this kind in `token_rates`, as an `agent.kind.no_usage_reporting` or `agent.kind.no_cost_estimate` warning.

A specific runtime may attach its own vendor-namespaced usage figure to a turn's result. The generic adapter reads only the fields the pinned schema defines, so no such figure reaches Sortie's own accounting; what one runtime publishes there, and what that figure leaves out, is on that runtime's own page.

Model reporting has the same shape: the protocol carries no model field the adapter reads, so no built-in path on this kind reports a model name.

---

## Permission handling

An operator neither answers a permission request nor configures the answer. The adapter's refusal posture is the one every agent adapter shares, applied here to `session/request_permission`:

| What the request asks for | What the adapter does |
|---|---|
| Consent to act, selecting from a runtime-offered set of options | Selects the first offered option whose own kind refuses (`reject_once`, or `reject_always` when no `reject_once` option is offered), emits a `notification`, and the turn continues. |
| Consent to act, with no refusing option offered at all | Answers with the cancelled outcome, emits a `notification`, and ends the attempt with [`turn_input_required`](/reference/errors/#agent-errors); the option set gave the adapter no way to decline without granting something. |
| An answer only a person could give, `elicitation/create` | Answered `method not found` at the protocol level, emits a `notification`, and ends the attempt with `turn_input_required`. |
| Any other method this client does not implement | Answered `method not found`; the turn continues and a `malformed` event is recorded. |

A request arriving between turns is answered the same way, and an ending it produces is held until the next turn: that turn starts, delivers the notification, and ends immediately without sending a prompt. A request ending the attempt releases the claim instead of scheduling a retry, and the run is recorded with status `needs_person` rather than `failed`.

A session that delivered at least one declared tool server, and then meets a permission request answered by refusal, is told once per session that any tool gated the same way cannot be called: the adapter emits one `notification` and logs one `Warn` record. A posture that never asks in the first place leaves no such signal on this path; see the runtime-specific pages for what each runtime's own configuration needs to reach that posture, and [what a delivered tool server needs to be callable](#tool-call-tracking).

---

## Tool call tracking

Sortie's tools reach the session as MCP servers declared on `session/new` (or a continuation call), and the runtime carries every call and result. The adapter observes rather than routes: it correlates a `tool_call` update with its own terminal `tool_call_update` by the call's own identifier and emits one `tool_result` event per completed or failed call, carrying the tool name, the duration between begin and end, the error flag, and the terminal update's own `title` as the message.

Every tool call's declared kind is normalized to a closed, ten-value set for the orchestrator's tool-call metric: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, and `other`, substituting `other` for an absent or unrecognized value.

Delivery and discovery are not the same as callability. The session-creation request carries the declaration and the runtime launches the server and reads its tool list, but a runtime that asks for consent before invoking a tool meets this adapter's refusal, and the tool is never invoked. The protocol's stdio server declaration carries no trust or pre-authorization field, so a declared server cannot be marked pre-authorized on the wire; the only lever is the runtime's own configuration, reached through `agent.command` and whatever configuration file that runtime reads. See the runtime-specific pages for what each runtime's own switches grant.

---

## MCP

The worker writes `.sortie/mcp.json` for every agent kind. On a local launch, session start parses it and renders its servers into the wire shape `session/new` carries; on a remote launch, no servers are parsed at all, so a session over SSH reaches none of Sortie's tools and its first-turn prompt names none, for the same reason the [Codex](/reference/adapter-codex/#mcp_config) and [OpenCode](/reference/adapter-opencode/#mcp) adapters withhold theirs on SSH: the configuration's credential values would otherwise sit on the local `ssh` process's own argument list, readable by any other user of the orchestrator host.

An HTTP server is delivered only when the handshake's `mcpCapabilities.http` reports `true`; when it does not, the server is silently omitted and the toolServers capability entry is lowered for the rest of the session (see [capability tracking](#capability-tracking)). A stdio server is always attempted; the protocol's `mcpCapabilities` distinguishes HTTP and SSE support, not stdio support. A server whose `enabled` field is explicitly `false` in the generated configuration is dropped before rendering, because the protocol carries no disabled state of its own.

Whether a declared server's tools are actually reachable once the session starts depends on the runtime's own workspace-trust and approval configuration, not on delivery; see [tool call tracking](#tool-call-tracking).

### `mcp_config`

`agent-client-protocol.mcp_config` names an operator-supplied MCP server configuration file. The worker reads it, merges its servers with the `sortie-tools` entry into the generated copy, and this adapter renders the merged result the same way it renders the generated configuration on its own. A relative path resolves against the directory containing `WORKFLOW.md`. An unreadable path, a file that is not valid JSON, or a file already declaring a server named `sortie-tools` fails the attempt before the session starts.

---

## Capability tracking

Every session keeps a record of four capabilities this transport can deliver, each starting at a resolved state before the handshake and only ever lowering, never rising, within the session:

| Capability | Starts at | Lowered when |
|---|---|---|
| Tool servers | Delivered, unless the launch is remote | An HTTP server is withheld because the handshake did not advertise `mcpCapabilities.http`. |
| Token counts | Absent | Never lowered further; no per-turn token count reaches this adapter on any launch. See [token accounting](#token-accounting). |
| Session continuation | Delivered | The handshake advertises neither `session/load` nor `session/resume`, or an attempted continuation call is not confirmed. See [session resume mechanism](#session-resume-mechanism). |
| Agent version | Delivered | The handshake's `initialize` response carries no `agentInfo`. |

The first time a turn starts, the adapter emits one `notification` naming every entry then in the gap state, in this fixed order. The token counts entry always starts there, so every session carries this notice; a session whose other three entries hold reads `this session started with a declared capability gap in: token counts`. A capability lowered afterward is logged at `Warn` instead of producing a second notice, so an unfamiliar line in the run log after that point is recognizable as a declared limit rather than as an unreported error.

---

## Session resume mechanism

Supplying a session ID saved from a previous run at session start attempts continuation; the route depends on what the handshake advertised, in this fixed order: `session/load` when the handshake advertises `loadSession: true`, otherwise `session/resume` when the handshake advertises `sessionCapabilities.resume`, otherwise no continuation is attempted and a fresh session is created with `session/new`.

Before either continuation call, the adapter sends one request naming a vendor-namespace method no protocol release can claim, and records the error code the runtime answers it with, if any. This negative control lets the adapter tell an unimplemented continuation method apart from a genuinely broken one by comparing that code against the one the continuation call returns, though both outcomes still lower the capability and fall back the same way.

`session/resume`'s own response is enough to confirm it: a successful response means the identifier resumed. `session/load` needs more: a successful response alone is not treated as confirmation, because a runtime can answer success while replaying nothing. The adapter also requires at least one replayed message chunk for the loaded identifier, observed either before the response arrives or within `read_timeout_ms` after it; without one, the load is treated as unconfirmed.

Whichever continuation route is attempted, an error response, a timeout on that call or on the negative control before it, or (for `session/load`) no observed replay lowers the session continuation capability entry and falls back to `session/new` within the same session-start call; none of these outcomes fails the session on their own account.

A `session/load` call for a session this adapter's own process created is held until the wall clock leaves the UTC minute in which that creation happened, bounded at one minute. This spacing exists to protect against a class of runtime defect where a load issued too soon after a session's own creation destroys that session's resumability outright, including every later attempt to load it; a runtime with this defect is documented on its own page. The wait is measured in process memory, so it does not cover a session created by a previous process, and on an SSH launch it is measured on the orchestrator host's clock rather than the runtime host's.

---

## Session close

`session/close` is sent during teardown only when the handshake's `initialize` response advertises `sessionCapabilities.close`. A handshake advertising no `sessionCapabilities` object at all, or one that omits `close`, means this adapter never selects it: the session then ends only through process termination, described in [process shutdown](#process-shutdown). The call is bounded at half of whatever remains of the graceful teardown window, so it can never itself consume the whole window at the expense of the signal that follows it.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches the local `ssh` binary and runs the configured command on the remote host instead of locally. The subprocess model stays persistent per session: one SSH invocation wraps the runtime for the session's whole lifetime, the same as a local launch keeps one subprocess alive across turns.

### SSH options

The adapter uses the shared `sshutil` transport defaults, the same ones every other SSH-capable adapter uses:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). Allowed values: `accept-new`, `yes`, `no`. |
| `BatchMode` | `yes` | Disables interactive prompts. |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### What an SSH launch does not carry

No configured environment reaches the remote runtime beyond what OpenSSH itself forwards, and the generated MCP configuration is never parsed for a remote launch at all; see [MCP](#mcp). A credential a specific runtime needs on the remote host has to already be present there, or forwarded by whatever mechanism that runtime's own page describes; this kind manages none of its own.

### Exit codes

This adapter reads no subprocess exit code, so SSH exit code `255` (a connection failure) and exit code `127` (the remote binary not on `PATH`) are not special-cased. Both reach the session as the loss of its connection and report `port_exit`, whether the session was still starting or running a turn. A missing local `ssh` binary is the one launch failure reported as `agent_not_found`.

---

## Authentication

Sortie manages no credential for this kind. The subprocess inherits the full parent process environment, and whichever runtime `agent.command` names reads its own credential from it, exactly as every other agent adapter's subprocess does. There is no preflight, no canary, and no adapter-specific environment variable, because there is no fixed runtime to preflight.

See [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/) and [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/) for what each of those two runtimes actually reads, and what a stored login versus an API-key credential changes about what the session can do.

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex | OpenCode | Kiro | Agent Client Protocol |
|---|---|---|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` | `opencode` | `kiro` | `agent-client-protocol` |
| Default command | `claude` | `copilot` | `codex app-server` | `opencode` | `kiro-cli` | None; `agent.command` names both the runtime and its protocol-mode switch |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns | New process per turn, plus an `export` subprocess | New process per turn | Persistent process across turns |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout | CLI flags + newline-delimited stdout envelopes | CLI flags + plain-text stdout transcript | Agent Client Protocol: newline-delimited JSON-RPC 2.0 over stdio |
| Session ID source | UUID generated by adapter | Discovered from `result` event | Thread ID from `thread/start` response | Discovered from the first JSON envelope | None; carries only the session ID saved from a previous run | `session/new` response, or the resumed identifier when continuation is confirmed |
| Resume mechanism | `--resume <UUID>` | `--resume <sessionId>` or `--continue` fallback | `thread/resume` or automatic within session | `--session <sessionID>` | `--resume` (cwd-scoped), after first success | `session/load` or `session/resume`, whichever the handshake advertises, confirmed by a negative control and, for load, by observed replay |
| Token accounting | Result event `modelUsage`, with top-level `usage` fallback | Session-state journal on disk | `thread/tokenUsage/updated` notification | Separate `export` subprocess | None (credits only); every run unmeasured | None; no per-turn token count reaches the adapter, so every run is unmeasured |
| Model reporting | From `assistant` events | From `assistant.message`/`model.message` records | From the thread-open response, updated on reroute | Recovered from export `providerID/modelID` | Not available | Not available |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + tool scoping | `approvalPolicy` and sandbox policy | `--dangerously-skip-permissions` plus `OPENCODE_PERMISSION` | `--trust-all-tools` or `--trust-tools=<csv>` | `session/request_permission`, refused in a form that lets the turn continue, or ends the attempt when only a person could answer |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as command-line overrides, local launch only | Generated servers re-expressed as an inline configuration document, local launch only | None; the profile gate disables MCP under `KIRO_API_KEY` | Generated servers re-expressed on `session/new`, local launch only, and reachable only when the runtime's own configuration authorizes the call without asking |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth | `KIRO_API_KEY` | None managed by Sortie; the named runtime authenticates itself |

---

## External references

- [Agent Client Protocol specification](https://agentclientprotocol.com/protocol/overview): the protocol's own reference for `initialize`, `session/new`, `session/prompt`, and every method this adapter drives
- [Agent Client Protocol schema](https://github.com/agentclientprotocol/agent-client-protocol): the versioned schema this adapter's generated wire types are pinned against
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification): wire format used over stdio
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification): the protocol behind a declared tool server's own tool calls

---

## Related pages

- [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/): the first runtime published on this route
- [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/): a second route to a runtime that also ships a hand-written kind
- [Kiro CLI adapter reference](/reference/adapter-kiro/): the native `kiro` kind, and what the two routes to that runtime each deliver
- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema and the `agent-client-protocol` extension block
- [Environment variables reference](/reference/environment/): how a runtime's own credential reaches its subprocess
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
- [Adapter model](/concepts/adapter-model/): why adding a kind never changes the orchestration core
- [ADR-0029: Adopt Agent Client Protocol as a generic agent transport](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0029-adopt-agent-client-protocol-as-a-generic-agent-transport.md): the decision behind this kind, and why the roster does not consolidate onto it
- [Run the full cycle with Gemini CLI](/getting-started/github-gemini-end-to-end/): a first run on this kind end to end, with Gemini CLI and GitHub Issues
