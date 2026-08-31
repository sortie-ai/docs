---
title: "Copilot CLI Adapter"
description: "Copilot CLI agent adapter reference: configuration, session lifecycle, JSONL event stream, token accounting, errors, SSH remote execution, and auth."
author: Sortie AI
date: 2026-04-26
weight: 110
url: /reference/adapter-copilot/
---
The Copilot CLI adapter connects Sortie to the [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) via subprocess management. It launches the `copilot` binary with `--output-format json`, reads newline-delimited JSON from stdout, and normalizes events into domain types. Registered under kind `"copilot-cli"`.

Each `RunTurn` call spawns an independent subprocess. The adapter is safe for concurrent use: one adapter instance serves all sessions, with per-session state held in an opaque internal handle. `StartSession` runs a canary check and a credential preflight before it returns a session; both are local-mode only.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for GitHub token variables, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `copilot-cli` extension block (pass-through to the Copilot CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Copilot CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"copilot-cli"` to select this adapter. |
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

These fields are adapter-specific, and each maps to a Copilot CLI flag. The orchestrator forwards them as written, and `allowed_tools` draws an advisory warning because it changes the permission posture; see [validate-time checks](#validate-time-checks).

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `model` | `--model` | string | _(CLI default)_ | LLM model identifier, forwarded unchanged. See `copilot --help` on your installed version for the accepted values. |
| `max_autopilot_continues` | `--max-autopilot-continues` | integer | `50` | Maximum autopilot continuation steps within a single `RunTurn` invocation. |
| `agent` | `--agent` | string | _(none)_ | Agent persona to use. |
| `allowed_tools` | `--allow-tool` | string | _(none)_ | Tool to allow explicitly. |
| `denied_tools` | `--deny-tool` | string | _(none)_ | Tool to deny explicitly. |
| `available_tools` | `--available-tools` | string | _(none)_ | Set of available tools. |
| `excluded_tools` | `--excluded-tools` | string | _(none)_ | Set of excluded tools. |
| `mcp_config` | `--additional-mcp-config` | string | _(none)_ | Path to, or inline JSON for, an operator-supplied MCP server configuration. Sortie does not forward this value unchanged when it also has its own tools to wire in; see [Sortie's own tools and the mcp_config field](#sorties-own-tools-and-the-mcp_config-field). |
| `disable_builtin_mcps` | `--disable-builtin-mcps` | boolean | `false` | Disable built-in MCP servers. |
| `no_custom_instructions` | `--no-custom-instructions` | boolean | `false` | Skip custom instruction files. |
| `experimental` | `--experimental` | boolean | `false` | Enable experimental features. |

```yaml
copilot-cli:
  model: <model-id>
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

The adapter passes `--allow-all` to auto-approve all tool calls unless `allowed_tools` is a non-whitespace value. `--allow-all` grants tool approval, file-path verification, and URL access in one flag, and `allowed_tools` is itself an approval allow-list - a subset of that grant - so the grant would subsume and defeat it if both were sent.

`denied_tools`, `available_tools`, and `excluded_tools` do not affect `--allow-all`. They are forwarded alongside it: a `--deny-tool` rule outranks the grant for a matching call, and `--available-tools` / `--excluded-tools` control what the model sees rather than what it may do. Setting one of these three, without setting `allowed_tools`, still runs with `--allow-all` present.

Every invocation also includes `--autopilot` and `--no-ask-user`, which are always present regardless of tool scoping configuration. `--no-ask-user` closes the CLI's route for putting a question to a person, so a request the runtime cannot satisfy on its own is always a request for consent to act rather than a question.

### Sortie's own tools and the `mcp_config` field

Sortie generates one MCP server configuration per session, declaring a `sortie-tools` stdio server that exposes Sortie's own tools to the agent. When that generated file exists, the adapter passes it to `--additional-mcp-config` as `@<path>`, regardless of whether `copilot-cli.mcp_config` is also set.

When `copilot-cli.mcp_config` names an operator-supplied file, Sortie reads it, inserts the `sortie-tools` entry into its `mcpServers` object, and writes the merged result - the same merge the Claude Code adapter performs, since both read from the orchestrator-generated config. A relative path resolves against the directory containing `WORKFLOW.md`. A server already named `sortie-tools` in the operator's file fails generation with a name-collision error rather than being silently overwritten.

Only when no such merge has taken place - `MCPConfigPath` is empty - does the adapter fall back to forwarding `copilot-cli.mcp_config` directly to `--additional-mcp-config`. In that fallback path the adapter also decides how to present the value to the flag: a value starting with `{` is passed through as inline JSON, a value already starting with `@` is passed through unchanged, and any other value is treated as a file path and prefixed with `@`, matching the flag's own file-vs-inline convention.

### Runtime-denied permission requests

The CLI answers a permission request under its own non-interactive policy rather than handing it to Sortie: it denies the call, reports the denial as a `tool.execution_complete` event carrying the error code `denied`, and continues the session. The adapter recognizes that code and reports it as a `notification` event naming the reason. The turn is not ended, and no consent was granted. This is the path a tool call excluded by `allowed_tools`, `denied_tools`, `available_tools`, or `excluded_tools` takes.

---

## Validate-time checks

When `agent.kind` is `copilot-cli`, the [`sortie validate`](/reference/cli/#validate) pipeline runs a Copilot CLI-specific config check in addition to the generic preflight validation. It constructs no adapter instance and launches no subprocess, and the same check runs at startup and on every workflow reload, so the verdict is identical in all three places.

### Warnings

| Check | Condition | Message |
|---|---|---|
| `copilot-cli.allowed_tools.auto_deny` | `allowed_tools` is set | `copilot-cli.allowed_tools replaces the --allow-all grant, so only a call the list matches is approved; every other permissioned call is denied without a prompt, the turn continues, and a turn whose calls were all denied still reports success` |

This is a warning rather than an error. Warnings leave `valid` true and the exit code `0`. `allowed_tools` narrows what the agent may do without leaving it waiting for a person: a call outside the list is denied and the session goes on, and the check flags that so a turn that got nothing approved does not read as an ordinary success.

---

## Session lifecycle

### `StartSession`

Validates the workspace path, resolves the agent binary, runs a canary check, and verifies authentication. No subprocess is spawned.

1. Validates that `WorkspacePath` is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` via `exec.LookPath`. In SSH mode, resolves the local `ssh` binary instead; the agent command resolves on the remote host.
3. **Canary check (local mode only):** runs `copilot --version` with a 5-second timeout. Any non-zero exit or timeout fails the session with `agent_not_found`; the adapter does not read the version it printed.
4. **Credential preflight (local mode only):** accepts a non-empty `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. With none of them set, it falls back to `gh auth status` (2-second timeout), and only when `gh` itself is on `PATH`. The adapter tests only that a source exists; it never inspects the token's value.
5. Adopts `ResumeSessionID` for continuation sessions. The session ID may remain empty until the first `result` event populates it.
6. Returns an opaque `Session` handle containing workspace path, resolved binary, session ID, and SSH configuration.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent binary not found in `PATH` | `agent_not_found` |
| Canary `copilot --version` timed out or exited non-zero | `agent_not_found` |
| No GitHub authentication source found | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

### `RunTurn`

Spawns a Copilot CLI subprocess, reads JSONL events from stdout, and delivers normalized events via the `OnEvent` callback.

The subprocess lifecycle belongs to the shared fork-per-turn skeleton in `internal/agent/agentcore`, which the Claude Code and Kiro adapters use as well; the Copilot CLI adapter supplies the argument list, the line parser, and the end-of-turn classifier.

1. Builds the CLI argument list from session state and pass-through configuration.
2. Always includes: `-p <prompt>`, `--output-format json`, `-s`, `--autopilot`, `--no-ask-user`, and `--max-autopilot-continues <n>` (`50` when `copilot-cli.max_autopilot_continues` is unset or not positive).
3. Applies session management flags (see [session resume mechanism](#session-resume-mechanism)).
4. Spawns the subprocess with `exec.CommandContext`, overriding its default cancel behavior - see [process shutdown](#process-shutdown) for how.
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

Copilot CLI emits one JSON object per line on stdout. The adapter parses each line and maps it onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. The CLI's own event types and result payload are Copilot's to define; see [external references](#external-references).

Most of the stream is informational and reaches the logs as `notification` events. A tool call the runtime denies is reported as a `notification` and the turn continues, with no consent granted; see [runtime-denied permission requests](#runtime-denied-permission-requests).

---

## Token accounting

**Key difference from Claude Code:** Copilot CLI's JSONL stream carries no input token counts anywhere. `assistant.message` events carry output counts only, and the `result` event's `usage` object carries premium requests, durations, and code-change stats but no token breakdown. Full counts come from the runtime's own session-state journal on disk, read after the subprocess exits.

Reported counts are cumulative over the whole session the orchestrator opened, across every turn of it, and never decrease.

### Session-state journal

The runtime writes one journal per session at `<COPILOT_HOME>/session-state/<session id>/events.jsonl`, falling back to `~/.copilot/session-state/...` when `COPILOT_HOME` is unset. The last line whose `type` is `session.shutdown` holds the session's authoritative totals, taken from its `data.modelMetrics` map summed across every model entry, or from `data.tokenDetails` when `modelMetrics` is absent or empty.

`input_tokens` is the sum of plain input, cache-read, and cache-write counts; `cache_read_tokens` carries the cache-read count separately as a subset of input; `total_tokens` is computed as `input_tokens + output_tokens`.

### Accumulation logic

1. Each `assistant.message` event with `outputTokens` in its data increments a running output-only estimate, emitted as a `token_usage` event. Input and cache-read stay 0 in this estimate.
2. After the subprocess exits, the adapter reads the journal. The journal is cumulative across every invocation that resumed the same session, so the adapter subtracts a baseline — the shutdown record that predates this run — to recover the run's own contribution. That figure replaces the output-only estimate.
3. The journal read is skipped in SSH mode, when the session ID is unknown or fails a path-segment check, and when the boundary record needed to separate this run's spend from a resumed session's prior spend is no longer available. The read is also abandoned when the journal exceeds 64 MB or holds a line above 10 MB.
4. When the journal is unavailable, the output-only estimate stands. The run still counts as measured if any `assistant.message` carried the output-token field, so its recorded total is output-only, with no input or cache-read component. Only a run where neither source produced a figure is recorded as unmeasured.

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
3. The adapter emits a `tool_result` event with `ToolName`, `ToolDurationMS`, and `ToolError` (inverted from the `success` field: `ToolError = !success`). On a match, `ToolName` and the elapsed duration come from the in-flight entry. With no match - the completion arrived without a recorded start - the event still fires, carrying the tool name from the completion event and a duration of `0`.

### Tool error detail

**Key difference from Claude Code:** the `success` boolean is the only error signal. There is no error text extraction or ANSI stripping. The Claude Code adapter extracts error text from `tool_result` content blocks and applies XML stripping, ANSI removal, and truncation - the Copilot CLI adapter reports only whether the tool succeeded or failed.

---

## Error handling

### Turn outcome

The outcome is not decided by the exit code alone. The shared decision table evaluates evidence in a fixed order and returns on the first match, so a `result` event outranks the process exit status.

| Evidence, in evaluation order | Exit reason | Error kind |
|---|---|---|
| Orchestrator cancelled the turn, or the process was killed by a signal | `turn_cancelled` | `turn_cancelled` |
| Exit code `127` | `turn_failed` | `agent_not_found` |
| `result` event carrying `exitCode: 0`, no `session.task_complete` event this turn | `turn_failed` | `turn_incomplete` |
| `result` event carrying `exitCode: 0`, a `session.task_complete` event reporting `success: false` | `turn_failed` | `turn_failed` |
| `result` event carrying `exitCode: 0`, a `session.task_complete` event reporting `success` true or omitted | `turn_completed` | _(none)_ |
| `result` event carrying any other `exitCode`, or carrying no `exitCode` field | `turn_failed` | `turn_failed` |
| No `result` event, non-zero exit | `turn_failed` | `port_exit` |
| No `result` event, exit `0`, this turn reported no output tokens | `turn_failed` | `turn_failed` |
| No `result` event, exit `0`, this turn reported output tokens | `turn_completed` | _(none)_ |

The cancellation and exit-`127` rows are decided before the adapter's own classifier runs. The output-token test reads this turn's own count, not the run-cumulative figure. Stderr from a failing turn is re-emitted at WARN level.

A `result` event with `exitCode: 0` is not decisive by itself: the adapter also checks whether this turn saw a `session.task_complete` report, the runtime's own record of whether the work finished. The [`max_autopilot_continues`](#agentmax_turns-vs-copilot-climax_autopilot_continues) ceiling can stop the runtime mid-task with a clean exit and no such report; without this check that outcome read as an ordinary success. `turn_incomplete` is retried like the other transient turn failures, on exponential backoff, and the retry resumes the same session with a fresh continuation ceiling. Raise `copilot-cli.max_autopilot_continues` if the task genuinely needs more autopilot steps per turn. No other built-in adapter reports `turn_incomplete` today.

`--no-ask-user` is on every invocation, so this adapter has no path to `turn_input_required`: the runtime cannot put a question to a person, and a denied tool call continues the session instead of ending the turn.

### Stdout scanner failure

If the stdout scanner encounters an error (buffer overflow, broken pipe), the adapter:

1. Sends a graceful-kill signal to the subprocess.
2. Waits for exit.
3. Returns a `turn_failed` result with error kind `port_exit`.

---

## Session resume mechanism

**Key difference from Claude Code:** session ID discovery is deferred.

Claude Code knows its session ID before its first turn: the adapter generates a UUID for a new session, or adopts the one carried over from an earlier attempt. Copilot CLI reports its session ID only in the `result` event at the end of a turn. The adapter handles this with a fallback mechanism:

| Turn | Session ID known? | CLI flag |
|---|---|---|
| First turn, new session | No | _(neither `--resume` nor `--continue`)_ |
| First turn, session ID carried over from an earlier worker attempt on the same issue | Yes | `--resume <sessionId>` |
| Subsequent turn, ID captured from result | Yes | `--resume <sessionId>` |
| Subsequent turn, no ID ever captured | No | `--continue` (resumes most recent conversation in workspace) |

The `--continue` fallback is a safety net. Under normal operation, the first turn's result event provides the session ID for all subsequent turns.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches Copilot CLI on a remote host via SSH instead of locally.

### How it works

1. `StartSession` resolves the local `ssh` binary via `exec.LookPath`. The agent command is stored for remote execution rather than resolved locally. The canary check and authentication preflight are skipped in SSH mode.
2. `RunTurn` builds an SSH command that wraps the remote Copilot CLI invocation.
3. The remote command is: `cd -- '<workspace_path>' && <agent_command> <args...>`, with the workspace path and each argument individually single-quoted; `<agent_command>` is inserted as configured, unquoted.

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

The workspace path and each per-turn CLI argument are single-quoted with embedded single-quote escaping (the standard POSIX `'\''` pattern) before being placed in the remote command string. This prevents injection when SSH passes the remote command through the remote shell. The configured agent command itself is not quoted this way, since it may legitimately be more than one shell token.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

Sortie does not manage Copilot CLI credentials. The adapter spawns the subprocess with the full parent process environment (`cmd.Env = os.Environ()`), and the Copilot CLI reads its authentication variables directly.

Authentication check order at `StartSession` (local mode only):

1. `COPILOT_GITHUB_TOKEN` environment variable.
2. `GH_TOKEN` environment variable.
3. `GITHUB_TOKEN` environment variable.
4. `gh auth status` (2-second timeout), attempted only when `gh` resolves on `PATH`. If it exits cleanly, the adapter logs a warning and proceeds.

If none are found, `StartSession` returns `agent_not_found` with a descriptive message listing the expected variables.

At runtime, the Copilot CLI handles its own authentication using whichever token is available in the process environment.

{{< callout type="warning" >}}
**A present token does not guarantee a working one**

Sortie's preflight only checks that one of the token variables is set, or that `gh auth status` succeeds - it does not inspect the token's type or scopes. Whether a given token authenticates with Copilot CLI, and what type and permission it needs, is GitHub's to document; see [managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in the external references. A token that satisfies Sortie's preflight can still be rejected by the CLI itself at runtime.
{{< /callout >}}

---

## Concurrency safety

The adapter is safe for concurrent use. One `CopilotAdapter` instance serves all sessions. Per-session state (workspace path, session ID, process handle) is isolated in the opaque `Session.Internal` field. A mutex guards the subprocess handle for concurrent access between `RunTurn` and `StopSession`.

No adapter-level serialization is needed for `RunTurn` calls - each spawns an independent subprocess with its own stdout pipe and scanner.

---

## Adapter registration

The adapter registers itself under kind `"copilot-cli"` via an `init` function in `internal/agent/copilot`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |
| `ValidateAgentConfig` | the check described in [Validate-time checks](#validate-time-checks) |
| `MCPInjection` | `supported` - the adapter hands the generated configuration file's path to the agent process, on a local launch and over SSH alike. See [Sortie's own tools and the `mcp_config` field](#sorties-own-tools-and-the-mcp_config-field). |

The orchestrator's preflight validation uses `RequiresCommand` to produce a specific error message if the binary cannot be found before attempting session creation.

---

## Key differences from Claude Code adapter

| Aspect | Claude Code | Copilot CLI |
|---|---|---|
| Kind | `claude-code` | `copilot-cli` |
| Default command | `claude` | `copilot` |
| Output format flag | `--output-format stream-json` | `--output-format json` |
| Session ID at start | UUID generated by adapter | Discovered from first `result` event |
| Resume flag | `--resume <UUID>` | `--resume <sessionId>` or `--continue` fallback |
| Input token reporting | Per-request, from the result event's per-model breakdown | Recovered from the runtime's session-state journal after exit; unavailable in SSH mode |
| Model reporting | From `assistant` events | Not available |
| Permission mode | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user`, plus `--allow-all` unless `allowed_tools` is set |
| Tool error detail | Error text with XML/ANSI stripping | Boolean `success` flag only |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` |
| Canary check | None | `copilot --version` (5-second timeout) |
| Auth preflight | None | Checks env vars + `gh auth status` |

For Claude Code configuration, see [Claude Code adapter reference](/reference/adapter-claude-code/).

---

## External references

- [Using GitHub Copilot in the command line](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) - official Copilot CLI documentation
- [`gh auth login` reference](https://cli.github.com/manual/gh_auth_login) - establishes the credentials this adapter inherits when no `*_TOKEN` env var is set
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) - GitHub token types and permissions
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) - the MCP server protocol consumed via `--additional-mcp-config`

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `copilot-cli` extension block
- [Environment variables reference](/reference/environment/) - GitHub token variables
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - turn caps, session caps, concurrency limits, and model selection
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
