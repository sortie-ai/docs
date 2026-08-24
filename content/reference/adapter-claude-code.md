---
title: "Claude Code Adapter"
description: "Claude Code agent adapter reference: configuration, session lifecycle, JSONL event stream, token accounting, errors, SSH remote execution, and auth."
author: Sortie AI
date: 2026-04-26
weight: 100
url: /reference/adapter-claude-code/
---
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

These fields are adapter-specific, and each maps to a Claude Code CLI flag. `permission_mode` is checked before any run starts; see [validate-time checks](#validate-time-checks). The rest reach the CLI as written, unvalidated by Sortie; consult `claude --help` on your installed version for what each flag accepts and how the CLI reacts to an invalid value.

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `permission_mode` | `--permission-mode` | string | _(see below)_ | Permission behavior for tool calls. `bypassPermissions` is the only value Sortie accepts. See [Permission mode](#permission-mode). |
| `model` | `--model` | string | _(CLI default)_ | LLM model identifier (e.g., `<model-id>`). |
| `fallback_model` | `--fallback-model` | string | _(none)_ | Alternate model identifier, forwarded unchanged. See [Fallback model scope](#fallback-model-scope). |
| `max_turns` | `--max-turns` | integer | _(CLI default)_ | Claude Code's internal agentic turn budget per invocation. Forwarded only when greater than `0`. |
| `max_budget_usd` | `--max-budget-usd` | number | _(none)_ | Cost cap in USD, forwarded only when greater than `0`. The adapter spawns one CLI invocation per turn, so the flag reaches the CLI once per turn with the same value. What the CLI does with it is Claude Code's to document. |
| `effort` | `--effort` | string | _(CLI default)_ | Inference effort level, forwarded to the CLI unvalidated. See `claude --help` for the accepted values on your installed version. |
| `allowed_tools` | `--allowedTools` | string | _(none)_ | Tool allowlist, forwarded verbatim as a single argument. Sortie neither parses nor validates the value. |
| `disallowed_tools` | `--disallowedTools` | string | _(none)_ | Tool denylist, forwarded verbatim as a single argument. Sortie neither parses nor validates the value. |
| `system_prompt` | `--append-system-prompt` | string | _(none)_ | Additional text appended to Claude Code's system prompt. |
| `mcp_config` | `--mcp-config` | string | _(none)_ | Path to an operator-supplied MCP server configuration file. Sortie does not forward this path unchanged; see [Sortie's own tools and the mcp_config field](#sorties-own-tools-and-the-mcp_config-field). |
| `session_persistence` | `--no-session-persistence` | boolean | `true` | Whether Claude Code persists session history to disk. `false` is refused before any run starts, because the adapter resumes a session from the file that flag suppresses. See [Session persistence and resume](#session-persistence-and-resume). |

```yaml
claude-code:
  permission_mode: bypassPermissions
  model: <model-id>
  fallback_model: <fallback-model-id>
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

### Fallback model scope

The adapter forwards `fallback_model` to `--fallback-model` unchanged and does not validate or interpret it - it may name a single model or a comma-separated list. Which failure classes Claude Code treats as fallback-eligible, and any limit on how many models a chain may name, are the CLI's own behavior; see the [external references](#external-references) for where to look it up.

Whatever the CLI decides applies only within the current invocation. The adapter spawns one CLI invocation per turn, and each turn starts that invocation with the configured primary model.

### Sortie's own tools and the `mcp_config` field

Sortie generates one MCP server configuration per session, declaring a `sortie-tools` stdio server that exposes Sortie's own tools to the agent. That generated file, not the raw `claude-code.mcp_config` value, is what the adapter passes to `--mcp-config`.

When `claude-code.mcp_config` names an operator-supplied file, Sortie reads it, parses its `mcpServers` object, and inserts the `sortie-tools` entry into it before writing the merged result. A relative path resolves against the directory containing `WORKFLOW.md`. If the operator's file already defines a server named `sortie-tools`, generation fails with a name-collision error rather than silently overwriting it. If the file is missing, unreadable, or not valid JSON, generation fails with the underlying error.

### Session persistence and resume

The adapter opens a session with `--session-id <uuid>` on the first turn and continues it with `--resume <session_id>` on every turn after that. `--resume` reads the session file Claude Code wrote to disk.

`session_persistence: false` passes `--no-session-persistence`, and Claude Code then writes no session file for `--resume` to read. Sortie refuses that configuration before any run starts, as the `agent.kind.session_resume` error under [validate-time checks](#validate-time-checks).

The refusal is unconditional. It does not depend on `agent.max_turns`, on the configured reactions, on the retry budgets, or on `tracker.handoff_state`. A single-turn budget does not avoid the conflict either: Sortie re-dispatches an issue carrying its earlier session after a retry, a continuation, a stall, or a restart, so the first turn of such a dispatch is already a resumed turn.

Leaving `session_persistence` unset, or setting it to `true`, resumes normally. `agent.max_turns` defaults to `20`, so a session ordinarily runs more than one turn.

### Permission mode

Set `permission_mode: bypassPermissions`, or leave the field out. Those are the only two configurations that pass validation.

`bypassPermissions` approves every tool call without prompting. Every run is unattended, so a mode that can stop and prompt has nobody to answer it, and the `claude-code.permission_mode.interactive` error refuses any other value before the run rather than letting the session reach the prompt. The check is an allowlist rather than a list of known-asking modes, so a mode the CLI adds later is also refused until someone establishes what it does headless.

With the field absent the adapter passes `--dangerously-skip-permissions` instead, which bypasses the same checks. Which permission modes the CLI itself offers, and what each one does, is Claude Code's to document; see the [external references](#external-references).

### Runtime-denied tool calls

Under the launch flags Sortie passes, Claude Code exposes no channel for answering a permission request: the runtime denies the call itself and carries on. The adapter recognizes that denial, reports it as a `notification` event, and takes one of two paths.

| Denied tool | Consequence |
|---|---|
| `AskUserQuestion` | A genuine question addressed to a person. The attempt ends at once with the [`turn_input_required`](/reference/errors/#agent-errors) error, the claim is released rather than retried, and the run is recorded with status `needs_person`. |
| Any other tool | A request for consent to act, already denied by the runtime. The session continues, and the agent may reach the result another way. |

---

## Validate-time checks

When `agent.kind` is `claude-code`, the [`sortie validate`](/reference/cli/#validate) pipeline runs two checks over the `claude-code` block in addition to the generic preflight validation. Neither constructs an adapter instance nor launches a subprocess, and both run at startup and on every workflow reload, so the verdict is identical in all three places. The first is declared by the adapter itself; the second is a generic preflight rule that reads the blocking key this adapter declares.

### Errors

| Check | Condition | Message |
|---|---|---|
| `claude-code.permission_mode.interactive` | `claude-code.permission_mode` is set to any value other than `bypassPermissions` | `claude-code.permission_mode is set to a value that lets the agent stop and ask for approval, and an unattended run has no one to answer; only "bypassPermissions" is supported` |
| `agent.kind.session_resume` | `claude-code.session_persistence` is the boolean `false` | `claude-code.session_persistence stops this agent kind from resuming a session across separate agent launches, but Sortie re-dispatches an issue with its earlier session after a retry, a continuation, a stall, or a restart, and every such turn fails. Change claude-code.session_persistence, or use an agent kind that can resume a session.` |

An absent `permission_mode` draws nothing: the adapter passes `--dangerously-skip-permissions`, which bypasses the same checks.

An absent `session_persistence`, and the value `true`, draw nothing. So does a value whose YAML type is not a boolean, such as the quoted string `"false"`: the adapter reads a wrong-typed value as the default `true`, and the check reads it the same way, so the configuration validates and the flag is not passed. Both checks run for every agent kind the configuration can reach, so a `claude-code` block that only a [dispatch rule](/reference/workflow-config/#dispatch) routes to is checked as well.

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

The subprocess lifecycle itself belongs to the shared fork-per-turn skeleton in `internal/agent/agentcore`, which the Copilot CLI and Kiro adapters use as well; the Claude Code adapter supplies the argument list, the line parser, and the end-of-turn classifier.

1. Builds the CLI argument list from session state and pass-through configuration.
2. Spawns the subprocess with `exec.CommandContext`, overriding its default cancel behavior - see [process shutdown](#process-shutdown) for how.
3. Sets `cmd.Dir` to the workspace path and `cmd.Env` to the full parent process environment.
4. Reads stdout line by line via a buffered scanner (64 KB initial buffer, 10 MB max line), while a separate goroutine drains stderr.
5. Parses each line as JSON and dispatches to the appropriate event handler. A line that fails to parse becomes a `malformed` event and the scan continues.
6. After stdout closes, collects the drained stderr lines and calls `cmd.Wait` to collect the exit status. Stderr is re-emitted at WARN level on any failing turn.
7. Classifies the outcome and returns a `TurnResult` with the session ID, exit reason, and cumulative token usage.

**Session management flags:**

| Condition | CLI flag |
|---|---|
| First turn of a new session | `--session-id <UUID>` |
| Subsequent turns and continuation sessions | `--resume <UUID>` |

Every invocation includes `--output-format stream-json` and `--verbose`.

### `StopSession`

Terminates a running subprocess. Safe to call when no subprocess is active.

1. Sends a graceful shutdown signal to the process group (POSIX: `SIGTERM`; Windows: `CTRL_BREAK_EVENT`).
2. Waits up to 5 seconds for the process to exit.
3. Force-terminates the process tree if still running (POSIX: `SIGKILL` to process group; Windows: `TerminateJobObject`).

### `EventStream`

Returns `nil`. The adapter delivers all events synchronously through the `OnEvent` callback in `RunTurn`.

---

## Process shutdown

`exec.CommandContext` sends an immediate kill signal on context cancellation by default. The agent process would have no chance to flush output buffers, close network connections, or emit final token-usage events. The adapter overrides that default: `cmd.Cancel` is set to send a graceful shutdown signal instead of a kill (POSIX: `SIGTERM`; Windows: `CTRL_BREAK_EVENT` via the process group), and `cmd.WaitDelay` bounds how long `Wait` gives the process to exit after that signal - 5 seconds - before force-killing it (POSIX: `SIGKILL`; Windows: `TerminateJobObject`). This covers both orchestrator-initiated cancellation (reconciliation kill, stall detection) and shutdown signals, since all of them reach the subprocess through the same context.

On all platforms, the subprocess is placed in its own process group at launch. On Windows, the subprocess is additionally assigned to a Job Object with `KILL_ON_JOB_CLOSE`, so the entire process tree (including MCP servers and other children) is terminated on shutdown or if Sortie crashes.

`StopSession` follows the same shape independently of context cancellation: it sends the graceful signal, waits up to 5 seconds, and force-kills the process group if the wait times out.

---

## Event stream

Claude Code emits one JSON object per line on stdout. The adapter parses each line and maps it onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. The CLI's own message types and result payload are Claude Code's to define; see [external references](#external-references).

Two mappings carry consequences a user can act on. A tool call the runtime denies becomes a `notification`, and a denied question to the user also ends the attempt with `turn_input_required`; see [runtime-denied tool calls](#runtime-denied-tool-calls). A line that fails to parse becomes a `malformed` event, truncated, rather than failing the turn.

---

## Token accounting

Reported token counts are cumulative over the whole session the orchestrator opened, across every turn of it, and never decrease. The `result` event at the end of each turn carries the authoritative figure for that turn; `assistant` events supply a provisional running estimate while the turn is still in flight.

### Accumulation logic

1. Each `assistant` event carrying a `usage` object contributes a provisional per-message figure, keyed by the message id. Claude Code repeats one message id across every streamed event of the same model request and grows the usage object as the response generates, so the adapter keeps the largest value seen per id rather than summing the repeats.
2. A `token_usage` event is emitted the first time a message id is seen, and not again for that id, so the count matches API requests rather than stream events.
3. On the `result` event, the per-model `modelUsage` breakdown is summed across every model entry, added to the session's settled total, and the turn's provisional contribution is cleared. The reported snapshot is raised against the highest snapshot already reported, so settling never lowers a figure the turn already published. The top-level `usage` object is used only when `modelUsage` is absent or empty. `modelUsage` is preferred because the top-level figure excludes sub-agent activity while the breakdown includes it — see [how to use sub-agents](/guides/use-subagents-with-sortie/#account-for-sub-agent-costs).
4. In both shapes, `input_tokens` is the sum of the plain input count, cache-read tokens, and cache-creation tokens; `cache_read_tokens` carries the cache-read count separately as a subset of input; `total_tokens` is computed as `input_tokens + output_tokens` rather than read from any vendor total.

### Model tracking

The `model` field from `assistant` events (e.g., `<model-id>`) is captured and included in `token_usage` events. The orchestrator uses this for per-model cost attribution.

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

### Turn outcome

The outcome is not decided by the exit code alone. The shared decision table evaluates evidence in a fixed order and returns on the first match, so a `result` event outranks the process exit status, and a recognized request for human input outranks both.

| Evidence, in evaluation order | Exit reason | Error kind |
|---|---|---|
| A denied `AskUserQuestion` was observed during the turn | `turn_input_required` | `turn_input_required` |
| Orchestrator cancelled the turn, or the process was killed by a signal | `turn_cancelled` | `turn_cancelled` |
| Exit code `127` | `turn_failed` | `agent_not_found` |
| `result` event with subtype `success` and `is_error` false | `turn_completed` | _(none)_ |
| `result` event that is `is_error` or has any other subtype | `turn_failed` | `turn_failed` |
| No `result` event, non-zero exit | `turn_failed` | `port_exit` |
| No `result` event, exit `0`, this turn produced no output tokens | `turn_failed` | `turn_failed` |
| No `result` event, exit `0`, this turn produced output tokens | `turn_completed` | _(none)_ |

The human-input, cancellation, and exit-`127` rows are decided before the adapter's own classifier runs. The output-token test reads this turn's own assistant output, not the run-cumulative figure. Stderr from a failing turn is re-emitted at WARN level.

### Stdout scanner failure

If the stdout scanner encounters an error (buffer overflow, broken pipe), the adapter:

1. Sends a graceful shutdown signal to the process group.
2. Waits for exit.
3. Returns a `turn_failed` result with error kind `port_exit`.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches Claude Code on a remote host via SSH instead of locally.

### How it works

1. `StartSession` resolves the local `ssh` binary via `exec.LookPath`. The agent command is stored for remote execution rather than resolved locally.
2. `RunTurn` builds an SSH command that wraps the remote Claude Code invocation.
3. The remote command is: `cd -- '<workspace_path>' && <agent_command> <args...>`, with the workspace path and each argument individually single-quoted; `<agent_command>` is inserted as configured, unquoted, so a multi-token or env-prefixed command (e.g. `FOO=bar claude`) still runs as intended.

### SSH options

The adapter uses these SSH options:

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). |
| `BatchMode` | `yes` | Disables interactive prompts (password, passphrase). |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### Shell quoting

The workspace path and each per-turn CLI argument are single-quoted with embedded single-quote escaping (the standard POSIX `'\''` pattern) before being placed in the remote command string. This prevents injection when SSH passes the remote command through the remote shell. The configured agent command itself is not quoted this way, since it may legitimately be more than one shell token.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

Sortie does not manage Claude Code's API credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and Claude Code reads its authentication variables directly.

The adapter runs no credential preflight and names no credential variable of its own: it neither reads nor sets one, and `StartSession` succeeds whether or not the environment can authenticate the CLI. Which variables authenticate a given backend - Anthropic's API, a cloud vendor's hosted models, or a gateway in front of either - is Claude Code's to document; see the [external references](#external-references) and the [environment variables reference](/reference/environment/#agent-runtime-variables).

A credential the CLI rejects therefore surfaces as a failing turn rather than as a session that refuses to start.

---

## Concurrency safety

The adapter is safe for concurrent use. One `ClaudeCodeAdapter` instance serves all sessions. Per-session state (workspace path, session ID, process handle) is isolated in the opaque `Session.Internal` field. A mutex guards the subprocess handle for concurrent access between `RunTurn` and `StopSession`.

No adapter-level serialization is needed for `RunTurn` calls - each spawns an independent subprocess with its own stdout pipe and scanner.

---

## Adapter registration

The adapter registers itself under kind `"claude-code"` via an `init` function in `internal/agent/claude`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |
| `ValidateAgentConfig` | the check described in [Validate-time checks](#validate-time-checks) |
| `MCPInjection` | `supported` - the adapter hands the generated configuration file's path to the agent process, on a local launch and over SSH alike. See [Sortie's own tools and the `mcp_config` field](#sorties-own-tools-and-the-mcp_config-field). |
| `SessionResumeBlockedBy` | `session_persistence` when the `claude-code` block sets that key to the boolean `false`, and nothing otherwise. This is the declaration the generic `agent.kind.session_resume` refusal reads. See [Session persistence and resume](#session-persistence-and-resume). |

The orchestrator's preflight validation uses `RequiresCommand` to produce a specific error message if the binary cannot be found before attempting session creation.

---

## External references

- [Claude Code overview](https://docs.anthropic.com/en/docs/claude-code) - Anthropic's official product documentation
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference) - every flag this adapter forwards (`--permission-mode`, `--output-format`, `--resume`, `--mcp-config`, etc.)
- [`anthropics/claude-code` on GitHub](https://github.com/anthropics/claude-code) - source repository, releases, and issue tracker
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) - the MCP server protocol consumed via `--mcp-config`

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `claude-code` extension block
- [Environment variables reference](/reference/environment/#agent-runtime-variables) - `ANTHROPIC_API_KEY`, Bedrock, Vertex AI, and proxy variables
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - per-turn budget, turn caps, session caps, and concurrency limits
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
