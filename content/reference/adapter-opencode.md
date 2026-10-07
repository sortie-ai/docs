---
title: "OpenCode CLI Adapter"
description: "Complete reference for the OpenCode CLI agent adapter: OpenCode 2.x requirements, configuration, session lifecycle, CLI argument mapping, event stream, token accounting, error handling, SSH remote execution, and multi-provider authentication."
author: Sortie AI
date: 2026-04-26
weight: 130
url: /reference/adapter-opencode/
---
The OpenCode adapter connects Sortie to the [OpenCode CLI](https://opencode.ai/docs/cli/) via subprocess management. It runs OpenCode 2.x, published on npm as `@opencode/cli`, and checks at the start of every session that `agent.command` reports a 2.x version; see [version check](#version-check). It launches `opencode run --format json`, reads newline-delimited stdout envelopes, reads the runtime's permission warnings from stderr, and normalizes the stream into Sortie's own event vocabulary. Registered under kind `"opencode"`.

Each turn spawns a fresh subprocess. The adapter emits activity-visible events so the orchestrator stall watchdog can observe progress. Session start does run a version query (see [version check](#version-check)), but that query checks no credential and performs no authentication preflight. The CLI accepts no MCP configuration path, so on a local launch the adapter translates the generated configuration into OpenCode's own form and delivers it in the turn's environment; see [MCP](#mcp).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for runtime environment behavior, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `opencode` extension block.

### Version check

Session start runs the configured command with `--version`, bounded the same way the post-turn `export` launch is (see `read_timeout_ms` below), and reads only the first non-empty line of the output. It scans that line's whitespace-separated fields, dropping one leading `v` from each, for the first one that matches a bare semantic version, and requires that version's leading number to be `2`. A version on a later line is never found: if the first non-empty line carries no such field, or the output was truncated, the check fails. The check runs once per session, over SSH when the launch is remote, and is never repeated or cached. A later major than 2 fails the check like any other, so install `@opencode/cli@2` to stay on a supported major.

**Errors:**

| Condition | Error kind | Message |
|---|---|---|
| The version query could not be started | `response_error` | `could not start the agent runtime to read its version` |
| Session start's own context ended before the query finished | `response_error` | `the session start ended while the agent runtime was reporting its version` |
| The version query did not finish within its bound | `response_timeout` | `the agent runtime did not report its version within <N> ms` |
| The command exited unexpectedly | `port_exit` | An SSH connection failure on a remote launch, otherwise the [early exit report](/reference/errors/#early-exit-report) |
| The command's output carries no version Sortie can read | `agent_not_found` | `the configured OpenCode command reported no version Sortie can read: <line or "no output">` |
| The reported major is not `2` | `agent_not_found` | `OpenCode <version> is not supported; install OpenCode 2.x, published on npm as @opencode/cli` |

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the OpenCode CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"opencode"` to select this adapter. |
| `command` | string or list | `opencode` | Path or name of the OpenCode binary. Resolved from `PATH` at session start. `agent.command` reaches this kind only when it is the default kind; a rule-routed `opencode` session beside another default kind runs `opencode` itself. See [`agent.command`](/reference/workflow-config/#agent) for the list form. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator runs a turn up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `max_concurrent_agents_by_state` | map | `{}` | Per-state concurrency limits. Keys are state names, lowercased for matching. See [`agent.max_concurrent_agents_by_state`](/reference/workflow-config/#agent) for how an invalid entry is handled. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single turn. The orchestrator cancels the turn when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Bounds the wait for the turn's first JSON envelope, and, doubled and capped at 30 seconds, the version query every session start makes, the post-turn `export` subprocess, and, on a [credential-verification](/reference/workflow-config/#credential-verification) session, the `session delete` cleanup call. It does not bound anything after the first envelope arrives. Falls back to 30 seconds when unset or not positive. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive emitted events before the orchestrator treats the turn as stalled. `0` or negative disables stall detection. |
| `stop_grace_ms` | integer | `5000` (5 seconds) | How long the adapter waits for the subprocess to exit on its own after a graceful termination signal, before it force-terminates the process group. Must be positive. |
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

These fields are adapter-specific. Each maps to a CLI flag or to a member of the inline configuration document the adapter delivers in `OPENCODE_CONFIG_CONTENT`; see [managed environment](#managed-environment).

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | _(CLI default)_ | Value forwarded to `--model`. A non-empty `effort` or `variant` is appended after a `#`. |
| `agent` | string | _(none)_ | OpenCode agent name forwarded to `--agent`. |
| `effort` | string | _(none)_ | Reasoning level, carried on every turn, credential verification included, in OpenCode's one model-variant slot. See [adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration) for how an unset value is read. Folded into `model` as a `#`-separated suffix, so it needs an `opencode.model` that carries no `#` of its own; see [settings refused at session start](#settings-refused-at-session-start). Setting it together with `variant` is an error; see [validate-time checks](#validate-time-checks). |
| `variant` | string | _(none)_ | Fills the same slot as `effort`, and setting both is an error. Folded into `model` as a `#`-separated suffix under the same requirements as `effort`. |
| `thinking` | boolean | `false` | Adds `--thinking`. |
| `dangerously_skip_permissions` | boolean | `true` | Adds `--dangerously-skip-permissions` when `true`. When `false`, the runtime refuses every permissioned tool call instead of performing it, and the first refusal also ends the turn; see [validate-time checks](#validate-time-checks). |
| `disable_autocompact` | boolean | `true` | When `true`, sets the inline configuration document's `compaction.auto` to `false`. |
| `allowed_tools` | list of strings | `[]` | Builds an allowlist policy: listed keys become `allow`, every known key not listed becomes `deny`, unknown keys are forwarded unchanged. The policy rides in the inline configuration document's `permission` member. |
| `denied_tools` | list of strings | `[]` | Adds `deny` entries to the same policy `allowed_tools` builds. Overlap with `allowed_tools` is refused at session start; see [settings refused at session start](#settings-refused-at-session-start). |
| `mcp_config` | string | _(none; read by the worker)_ | Path to an operator-supplied MCP server configuration file, resolved relative to the WORKFLOW.md directory when not absolute. Its servers are merged into the generated configuration, and the adapter translates the merged result into OpenCode's own server entries on a local launch. See [MCP](#mcp). |

The adapter always adds `run --format json --standalone`, and delivers the prompt on standard input.

```yaml
opencode:
  model: <provider>/<model-id>
  effort: high
  dangerously_skip_permissions: true
  disable_autocompact: true
  allowed_tools:
    - read
    - edit
    - glob
```

### Settings refused at session start

Session start refuses the settings below before it launches anything. Each fails with error kind `agent_not_found` and starts no subprocess.

| Condition | Message |
|---|---|
| `allowed_tools` and `denied_tools` name at least one of the same keys | `allowed_tools and denied_tools overlap: <keys>`, with the shared keys sorted and comma-separated |
| `opencode.pure` is `true` | `opencode.pure is not supported by OpenCode 2.x; remove it` |
| `opencode.effort` or `opencode.variant` is set without `opencode.model` | `opencode.<key> needs opencode.model on OpenCode 2.x; set opencode.model or remove opencode.<key>`, with `<key>` the one that is set, `effort` or `variant` |
| `opencode.model` already carries a `#`-separated suffix and `opencode.effort` or `opencode.variant` is also set | `opencode.model already names a variant after #; remove that suffix or remove opencode.<key>` |
| `opencode.effort` and `opencode.variant` are both set | `opencode.effort and opencode.variant both set the model variant; set one of them` |

The overlap and the effort/variant conflict are also [validate-time checks](#validate-time-checks).

### `agent.max_turns` vs. OpenCode inner turn scope

The adapter exposes no OpenCode-specific inner turn or step-budget field.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator runs a turn per worker session. |
| `(none)` | OpenCode inner turn budget | The adapter does not expose an OpenCode equivalent to `claude-code.max_turns` or `copilot-cli.max_autopilot_continues`. Each turn executes one `opencode run` process and lets the CLI run until it exits. |

Use `turn_timeout_ms` to bound wall-clock time for a single turn. There is no adapter-level cap on OpenCode's internal step count within that turn.

### Permission policy

The adapter synthesizes one managed permission policy from `allowed_tools` and `denied_tools` and injects it as the `permission` member of the inline configuration document (see [managed environment](#managed-environment)). The policy is separate from `--dangerously-skip-permissions`.

| Input | Adapter behavior |
|---|---|
| No `allowed_tools`, no `denied_tools` | Sets no policy. OpenCode falls back to on-disk config and its own defaults. |
| `allowed_tools` only | Sets each listed key to `allow`, then sets every known key not listed to `deny`. |
| `denied_tools` only | Sets only the listed keys to `deny`. Other keys fall through to OpenCode defaults or operator config. |
| Both fields present | Starts with the allowlist behavior above, then applies `deny` overrides from `denied_tools`. |
| Overlap between the two fields | Session start fails. |
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
| `opencode_list_mcp_resources` | Yes |
| `opencode_models` | Yes |
| `opencode_read_mcp_resource` | Yes |
| `opencode_session_move` | Yes |
| `opencode_session_rename` | Yes |
| `question` | Yes |
| `read` | Yes |
| `skill` | Yes |
| `task` | Yes |
| `todowrite` | Yes |
| `webfetch` | Yes |
| `websearch` | Yes |

This is the set this version of the adapter knows about, not a catalogue of OpenCode's tools. A key OpenCode adds later is unknown to the adapter until the adapter learns it, and an unknown key you write is forwarded unchanged. The adapter forwards every key unchanged, so a key takes effect only where the runtime itself recognizes it.

### Managed environment

The adapter sets one environment variable on every subprocess it launches, the version check, the usage export, and the credential-verification `session delete` included:

| Variable | Value |
|---|---|
| `OPENCODE_DISABLE_AUTOUPDATE` | `true` |

Sharing, compaction, the permission policy, and tool servers ride together in one inline configuration document, delivered through `OPENCODE_CONFIG_CONTENT` on every local turn, whether or not the session carries tool servers. `share` is always `"disabled"`. `compaction.auto` is `false` only when `opencode.disable_autocompact` is `true`. `permission` carries the policy above and `mcp` carries the translated tool servers; see [MCP](#mcp). `agent.title.disable` is `true`, the title-agent switch described in [Token accounting](#token-accounting). The document never travels to a remote launch, and the version check, usage export, and `session delete` invocations never carry it.

Before adding its managed values, the adapter strips `OPENCODE_AUTO_SHARE`, `OPENCODE_DISABLE_AUTOCOMPACT`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_PERMISSION`, and `OPENCODE_CONFIG_CONTENT` out of the inherited environment, so an operator-side value never reaches the subprocess. It does not remove permission rules from `opencode.json`, so OpenCode still deep-merges the adapter policy with on-disk configuration, the adapter's own document loading last.

---

## Validate-time checks

When `agent.kind` is `opencode`, the [`sortie validate`](/reference/cli/#validate) pipeline runs OpenCode-specific config checks in addition to the generic preflight validation. They build no adapter and launch no subprocess, and the same checks run at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `opencode.allowed_tools.overlap` | `allowed_tools` and `denied_tools` name at least one of the same keys | `allowed_tools and denied_tools overlap: <keys>` |
| `opencode.effort.conflict` | `effort` and `variant` are both set to a non-empty value | `opencode.effort and opencode.variant both set the model variant; set one of them` |

Session start reports each of these with the same message, so the two paths can never disagree.

### Warnings

| Check | Condition | Message |
|---|---|---|
| `opencode.dangerously_skip_permissions.auto_reject` | `dangerously_skip_permissions` is explicitly `false` | `opencode.dangerously_skip_permissions is set to false, so the runtime refuses every permissioned tool call instead of performing it, and OpenCode 2.x also ends the turn at the first refusal` |

This is a warning rather than an error. Warnings leave `valid` true and the exit code `0`. The runtime refuses the request itself, so the setting never leaves a turn waiting for a person; it does stop the agent from using any permissioned tool, and the first refusal also ends the turn. An absent or `true` value draws nothing.

---

## Session lifecycle

### Session start

Refuses unusable settings, validates the workspace path, resolves the launch target, checks the OpenCode version, and initializes adapter-owned session state. No turn subprocess is started, but the version query below does start and exit a subprocess of its own.

1. Refuses the settings listed under [settings refused at session start](#settings-refused-at-session-start).
2. Validates that the workspace path is a non-empty absolute path pointing to an existing directory.
3. Resolves the configured command from `PATH`, defaulting to `opencode` when `agent.command` is empty. In SSH mode, resolves the local `ssh` binary instead and stores the remote command string for later use.
4. On a local launch, reads the generated MCP configuration and parses it into OpenCode's own server-entry shape, holding the result for every turn of the session. Skipped entirely in SSH mode. See [MCP](#mcp).
5. Queries the resolved command's version, over SSH when the launch is remote, and refuses the session when it is unreadable or not a 2.x release; see [version check](#version-check).
6. Builds the inline configuration document every turn of the session will carry, from the settings and the servers parsed in step 4.
7. The session has no running process ID or subprocess yet, and takes the session ID saved from a previous run as its own when continuation is requested.

Session start performs no provider-auth probe.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| Local OpenCode binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |
| Generated MCP configuration unreadable or not expressible | `response_error` |
| A refused setting | `agent_not_found`; see [settings refused at session start](#settings-refused-at-session-start) |
| Version query fails, times out, or reports a version other than 2.x | See [version check](#version-check) for the full set of conditions, kinds, and messages |

### Turn

Spawns one OpenCode subprocess, reads its stdout, and delivers normalized events to the orchestrator.

1. Builds the managed environment and the per-turn argument list.
2. Adds `run --format json --standalone` to every invocation and delivers the prompt on the subprocess's standard input. `--standalone` keeps the launch from joining a shared background service another client started.
3. Adds `--session <id>` when the session already has an OpenCode session ID.
4. Launches the subprocess locally or through SSH, with the full parent process environment plus the [managed environment](#managed-environment), which on a local launch includes `OPENCODE_CONFIG_CONTENT` on every turn. On a local launch, `PWD` in that environment names the same verified workspace path the subprocess's own working directory is set to, so the subprocess lands in the workspace.
5. Isolates the subprocess in its own process group before start, then arms a graceful process-group signal for cancellation, bounded by `stop_grace_ms`.
6. Reads stdout and stderr concurrently while waiting for the subprocess to exit.
7. Applies a startup timer derived from `read_timeout_ms`. A stdout line that fails to parse as a JSON envelope still resets the timer before the first accepted envelope arrives, but does not itself count as the runtime having responded; see [early exit report](/reference/errors/#early-exit-report).
8. On the first JSON envelope with `sessionID`, adopts the session ID if unset or verifies it matches the resumed session. Emits `session_started` once per session.
9. Maps JSON envelopes and tolerated plain-text lines into events.
10. Once the subprocess has been reaped, gives stderr collection up to five seconds to finish, then gives whatever stdout is still in flight another five seconds to arrive, before recovering final token usage with `opencode session export --standalone --sanitize <sessionID>`.
11. The turn ends based on the terminal error envelope, cancellation state, startup timeout, or process exit status.

A turn that instead ends by cancellation, a read timeout, or a stdout read error still attempts this export before reporting its outcome; see [Accumulation logic](#accumulation-logic) for the one ending that does not.

### Session stop

Marks the session closed and terminates the currently running turn subprocess, if any.

1. Marks the session closed and detaches the active turn runtime from session state.
2. Sends a graceful process-group signal when a turn is still running.
3. Waits up to `stop_grace_ms` for the subprocess to exit.
4. Force-kills the process group if it is still alive after the grace window.
5. Reports the orchestrator's own deadline error instead of a clean stop if that deadline expires first.
6. On a [credential-verification](/reference/workflow-config/#credential-verification) session that reached a session ID, runs `opencode session delete --standalone <id>` in the workspace before returning. A failed delete, including exit `1` for an identifier the runtime does not recognize, is only logged; it never fails the run.

Safe to call when no subprocess is active.

---

## Process shutdown

Before start, the subprocess is isolated in its own process group. A graceful process-group signal is armed for cancellation, bounded by `stop_grace_ms`. On Unix, graceful shutdown is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful shutdown is `CTRL_BREAK_EVENT` to the process group, and the subprocess is assigned to a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree. The subprocess starts suspended and is resumed only after that assignment succeeds, so nothing it spawns can run before the job takes effect; this covers the auxiliary launches described below, not only turns. A failed assignment logs WARN `process group assignment failed` and the launch runs without a job; a failed resume logs WARN `process resume failed` and reports `response_error`, unless the turn's cancellation had already begun, in which case the turn ends as `turn_cancelled`.

Shutdown is turn-scoped, not session-scoped. Session stop performs an explicit graceful-to-force sequence. Turn cancellation is stricter: when the turn is cancelled, the graceful signal fires immediately, and the adapter's cancellation path also force-kills the process group during teardown if the process is still alive. After the subprocess exits, the adapter performs a best-effort group kill to clean up surviving children.

---

## Event stream

The adapter reads stdout as newline-delimited envelopes. Most lines are JSON objects from `opencode run --format json`. Permission rejection warnings can also appear as plain text on stdout even in JSON mode. Reading stdout allows lines up to 10 MB long, to accommodate large tool payloads.

### What the adapter emits

The adapter maps each envelope onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. OpenCode's own envelope types and their fields are OpenCode's to define; see [external references](#external-references).

Two behaviours are the adapter's own. Every stdout line that fails to parse becomes a `malformed` event, truncated, rather than failing the turn, and it still resets the startup read timer, but it does not count as the runtime having responded; see [early exit report](/reference/errors/#early-exit-report). A permission request the runtime refuses surfaces twice, as a `tool_result` carrying the tool error and as a `notification`; no consent was granted, and the runtime also ends the turn at the first such refusal. Sortie scans stderr for those refusals only after the process exits.

---

## Token accounting

The adapter does not trust `step_finish.part.tokens` as the final turn total. It recovers authoritative usage from a second subprocess once the turn's subprocess is gone, not only when the turn ran to completion; see [Accumulation logic](#accumulation-logic) for which endings recover a figure. Reported counts are cumulative over the whole session the orchestrator opened, across every turn of it, and never decrease. On a local launch the adapter disables OpenCode's title agent by setting `agent.title.disable` to `true` in the `OPENCODE_CONFIG_CONTENT` document, so a turn makes no session-title request. That request is billed by the provider but recorded in no assistant message, so the per-message sum below would not have counted it. The session keeps OpenCode's default title. A remote launch receives no such document, so a title request there stays uncounted. For this kind's declaration beside every other kind's, see the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind).

### Accumulation logic

1. Once the main `opencode run` subprocess has exited or been killed and waited for, the adapter launches a second subprocess to recover usage, when a session ID is known: `opencode session export --standalone --sanitize <sessionID>`, in the same workspace. This runs on every turn ending: normal completion, a non-zero exit, a stdout `error` envelope, cancellation, a read timeout, and a stdout read error. A session ID mismatch is the one ending that does not run it, because the work ran in a session other than the one the export would read.
2. A session ID, once learned, persists for the rest of the session: either from a resumed session's saved ID, or from the first JSON envelope, in this turn or an earlier one, that carries one. A read timeout recovers a figure only on a resumed session or a later turn, because it fires only before that turn's own first JSON envelope arrives, so it never recovers one on the first turn of a new session. Cancellation and a stdout read error on that same first turn recover a figure only if an envelope carrying the session ID had already arrived before the turn ended.
3. The export subprocess runs with only `OPENCODE_DISABLE_AUTOUPDATE=true`. It never carries `OPENCODE_CONFIG_CONTENT`, so it never carries the tool policy or the tool servers either.
4. The export subprocess timeout is `min(2 * read_timeout_ms, 30s)`, where an unset or non-positive `read_timeout_ms` counts as 30 seconds. With the workflow default `read_timeout_ms: 5000`, the export timeout is 10 seconds.
5. The adapter reads the export JSON and sums **every** `assistant` message whose `finish` field is present and non-empty, not just the most recent message, provided the document's own `info.id` matches the current session. A message with an empty or absent `finish` is excluded regardless of its token counts. Each message carries `type`, `finish`, `tokens`, `model`, and `cost` at its own top level. When the run resumed an existing session, messages created before the run started are excluded, so a resumed session's earlier spend never lands in this run's total.
6. From each remaining message it reads `tokens.input`, `tokens.output`, and the optional `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`. A message with no `tokens` object is skipped.
7. `input_tokens` is `input + cache.read + cache.write`; `output_tokens` is `output + reasoning`. `cache_read_tokens` and `cache_write_tokens` carry the two cache counts separately as disjoint subsets of input. `total_tokens` is computed as `input_tokens + output_tokens` rather than read from `tokens.total`, which counts cache and reasoning tokens on a different basis.
8. If export setup fails, the subprocess exits non-zero, the JSON is malformed, or no message satisfies the session, creation-time, and `finish` conditions above, the adapter logs the warning `no assistant token usage found in opencode export`, emits no `token_usage` event, and leaves the previously reported snapshot in place rather than lowering it to zero.

The adapter emits at most one `token_usage` event per turn, when the export recovers a figure. A genuine zero still counts as recovered, so that session is recorded as measured rather than unmeasured; only a session for which no export ever recovered a figure, for any of the reasons above, is recorded as unmeasured.

### Model tracking

The main stdout stream does not supply a stable final model identifier. The adapter reconstructs the reported model only from the export payload, using `providerID + "/" + modelID` from the last counted assistant message, when both fields are present. Those fields are the message's own `model.providerID` and `model.id`.

Per-model attribution works only when the export payload includes both values. Sortie ignores the export payload's vendor cost field and derives estimates from the normalized token counters and configured `token_rates` instead.

### API timing

The adapter does not emit per-request API timing and does not report how long an API request took on completion, failure, or token events. The export subprocess runs after the main turn exits inside its own timeout window, but its duration is not surfaced as a separate metric.

---

## Tool call tracking

### Correlation

OpenCode's CLI envelope already carries terminal tool state. The adapter does not correlate a start event with a later completion event.

1. Parses the `tool_use` envelope.
2. Reads the tool name from `part.tool`.
3. Computes duration from `part.state.time.end - part.state.time.start`.
4. Marks the tool result as an error when `part.state.status` equals `error`, compared case-insensitively.

`callID` is parsed but not used for cross-event correlation.

### Tool error detail

When `part.state.status` is `error`, the adapter copies `part.state.error` into the normalized event message and truncates it to 500 runes. It does not strip XML wrappers, ANSI sequences, or stderr text.

A rejected permission request reaches the message field as whatever the runtime wrote into `part.state.error`; the adapter neither recognizes nor rewrites that text. The separate `notification` for a rejection comes from a stderr line beginning `! permission requested:`, matched after the process exits and after the escape sequences the runtime styles that line with are stripped.

---

## Error handling

### Turn outcome

An error kind is absent only on a `turn_completed` outcome; every other outcome carries one.

| Condition | Exit reason | Error kind | Description |
|---|---|---|---|
| No JSON envelope arrived within `read_timeout_ms` of launch | `turn_failed` | `response_timeout` | Message is `timed out waiting for first opencode json event`. The subprocess is killed and its stderr re-emitted at WARN level. |
| A JSON envelope carried a `sessionID` other than the one already adopted | `turn_failed` | `response_error` | Message is `session id mismatch: expected "...", got "..."`. The turn is aborted rather than reconciled. |
| Stdout `error` envelope observed, whatever the process exit status | `turn_failed` | `turn_failed` | Structured logical failure, authoritative over the exit code. Message is the envelope's own detail; see [masked failures](#masked-failures). On OpenCode's hosted free tier, a refusal naming a denied `bash` or `read` tool gains a trailing clause naming the setting that denied it; see [free-tier refusals](#free-tier-refusals). |
| Turn cancelled, or the session stopped, while the subprocess was still running | `turn_cancelled` | `turn_cancelled` | Message is `turn cancelled`. Cancellation outranks the process-exit classification. A subprocess that had already exited on its own is classified by its own exit status instead, however long the wait for its output ran. |
| No `error` envelope, and the process exited before writing a line the adapter decodes as a JSON envelope, whatever its exit status | `turn_failed` | `port_exit` | The [early exit report](/reference/errors/#early-exit-report): `the agent runtime exited before responding: exit status N`, followed by the end of the process's stderr. A stdout line the adapter cannot decode as an envelope does not count as a response, even if the process later exits `0`. |
| No `error` envelope, exit `0`, at least one `text`, `reasoning`, or `tool_use` part parsed | `turn_completed` | _(none)_ | Normal completion. |
| No `error` envelope, exit `0`, output written but no such part parsed | `turn_failed` | `turn_failed` | The model produced nothing this turn. Message is `agent exited without producing output: no message from the agent and no tool call`. |
| No `error` envelope, non-zero exit after writing output | `turn_failed` | `port_exit` | Process-level failure. Message is `exit code N`; when a signal Sortie did not send ended the process, the error text also names the signal, for example `signal: killed`. |

The adapter never trusts exit code `0` as sufficient proof of success. A terminal stdout `error` envelope is authoritative.

### Free-tier refusals

OpenCode's hosted free-tier model refuses any request whose tool set lacks its shell tool or its read tool, and that refusal reaches the adapter as the stdout `error` envelope row above rather than as the permission-refusal notice. When the session's own `opencode.allowed_tools` or `opencode.denied_tools` is what denied one or both of `bash` and `read`, the adapter appends a clause naming the denied tool (or tools) to the vendor's own refusal text; a refusal from a model that is not free-tier limited, or from tool settings that do not touch either required tool, gets no such clause. The recognition depends on the vendor's current error wording, so an upstream rewording can make the clause stop appearing without changing the underlying refusal.

### Masked failures

One failure can surface as two stdout `error` envelopes: one carrying the actionable diagnostic and one carrying OpenCode's generic placeholder, `Unexpected server error. Check server logs for details.`. Their order on the stream is not guaranteed, so the adapter keeps whichever carries detail. When the placeholder is the only failure detail on the stream, it reaches the operator unchanged, and the adapter does not try to name the cause.

### Stdout read failure

If reading stdout encounters an error while the turn is still active, the adapter:

1. Stops reading and kills the process group.
2. Recovers token usage from the session export, the same as any other turn ending; see [Accumulation logic](#accumulation-logic).
3. Re-emits collected stderr lines at WARN level.
4. Emits `turn_failed` with message `stdout read error` and reports an error of kind `response_error`.

If a cancellation or stop had already begun when the adapter killed the process, the turn ends as `turn_cancelled` instead: stderr is not re-emitted, but the process is still killed and usage is still recovered the same way.

### Stall detection

The adapter does not run its own inter-event stall timer. `read_timeout_ms` only covers startup and waits for the first JSON envelope, although plain-text stdout lines reset that timer before the first JSON line arrives.

After the first JSON envelope, stall detection is orchestrator-owned. The adapter emits `notification` or `malformed` events for plain-text warnings, unknown JSON types, and normal OpenCode envelopes so the orchestrator's `stall_timeout_ms` watchdog can observe output activity. When the orchestrator cancels a stalled turn, the adapter tears down the process and the turn ends as `turn_cancelled`.

---

## Session resume mechanism

OpenCode continuation is flag-based. The adapter persists the OpenCode session ID and passes it back on the next subprocess launch.

| Turn state | Stored session ID | CLI flag |
|---|---|---|
| Fresh session before first JSON envelope | Empty | _(no `--session` flag)_ |
| Subsequent turn in the same worker session | Known | `--session <sessionID>` |
| Continuation after worker restart | The session ID saved from a previous run | `--session <sessionID>` |


If a resumed turn emits a different `sessionID` from the one already stored, the adapter aborts the turn with `response_error` and emits `turn_failed`. `session_started` is emitted only once per session, on the first accepted JSON envelope.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches the local `ssh` client and runs OpenCode on the remote host. The process model stays launch-per-turn: each turn is a separate SSH invocation that wraps one remote `opencode` subprocess, and the export recovery step uses a second SSH invocation.

### How it works

1. Session start resolves the local `ssh` binary, then runs the remote command's version query over that same SSH path to check its OpenCode version; see [version check](#version-check). A version query failure fails session start the same way it does on a local launch, and needs the remote host's `dd` utility (step 4).
2. Each turn sends `OPENCODE_DISABLE_AUTOUPDATE` to the remote shell on the SSH session's standard input, together with any variable [`worker.ssh_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) names. The rest of the adapter's settings ride in the inline configuration document, which is not sent to a remote session; see [MCP](#mcp).
3. The remote shell enters the workspace, exports what the launch sent it, and only then runs the configured command with the turn's arguments, each step chained on the success of the one before it.
4. Because every remote launch on this kind sends the managed variables, every remote host needs the standard `dd` utility. A host without it fails the launch with `sortie: dd is required on the remote host to receive environment variables` on standard error.
5. The export recovery step uses the same SSH path with the export arguments described in [Token accounting](#token-accounting).

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

The workspace path and the adapter-generated OpenCode arguments are single-quoted with standard POSIX escaping before they are embedded in the remote shell command. A string `agent.command` is treated as a pre-formed shell fragment, so quoting inside it is the operator's responsibility; each element of a list command is single-quoted. Environment-variable values are not part of that command string.

### Exit codes

SSH exit code `255` indicates a connection failure and maps to `port_exit` unless OpenCode already emitted a terminal stdout `error` envelope. Exit code `127` means the remote binary is not in `PATH`; the process wrote nothing to stdout, so the turn takes the [early exit report](/reference/errors/#early-exit-report) under `port_exit`, carrying `exit status 127` and the remote shell's own message. Exit code `0` is still not sufficient to prove success, because OpenCode can emit a terminal `error` envelope and still exit `0`.

---

## Authentication

Sortie does not manage OpenCode credentials and runs no authentication preflight for this adapter. The subprocess inherits the Sortie process environment, so whichever provider credentials OpenCode expects must already be present there. Which providers OpenCode supports, and which variable each one reads, is OpenCode's to document; see [external references](#external-references).

{{< callout type="warning" >}}
**A remote session carries no provider credential by default.** This kind declares none, so a remote launch sends only `OPENCODE_DISABLE_AUTOUPDATE` unless you name others. The remote host must already be authenticated for the model you select, or the variables that authenticate it must be listed under [`worker.ssh_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent). A run that works locally can fail on a remote host for this reason alone.
{{< /callout >}}

---

## MCP

The OpenCode CLI accepts no MCP configuration path as an argument, and it does not read the `mcpServers` key the generated `.sortie/mcp.json` is written under. The adapter delivers the servers rather than the file: on a local launch, session start reads the generated configuration and parses its servers into OpenCode's own server-entry shape, keyed under `mcp`, with a stdio server becoming a local entry and an HTTP server a remote one. A server entry that omits its enable flag is rendered enabled, matching the runtime's own default.

The turn sets those entries on the turn subprocess through the runtime's inline-configuration environment variable, `OPENCODE_CONFIG_CONTENT`. The `mcp` entries live inside the one inline document that also carries the tool policy, sharing, and compaction (see [managed environment](#managed-environment)), so the variable is set on every local turn whether or not the session carries servers. The runtime merges the document with whatever project or global configuration the operator already has, rather than replacing it, and the auxiliary `export` and `session delete` invocations the adapter also runs rebuild their environment without it, so none of them spawns a tool sidecar of its own. Any `OPENCODE_CONFIG_CONTENT` inherited from the orchestrator's own environment is stripped first, on every one of those.

### SSH mode delivers nothing

A remote session receives no document. The adapter renders the generated servers into OpenCode's configuration document on a local launch only, so an OpenCode session on an SSH host reaches none of Sortie's tools and its first-turn prompt carries no tool advertisement. What a remote session lacks is that document, not an environment: `OPENCODE_DISABLE_AUTOUPDATE` reaches it, and so does anything [`worker.ssh_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) names.

### Startup failures

The run projection this adapter reads carries no MCP startup signal, so a server that fails to start produces no distinct diagnostic here. It surfaces only indirectly, as the agent's own tool calls failing. OpenCode starts every configured server without waiting for a tool call first: it starts each server's connection in the background while it prepares the session, without waiting for either the process to spawn or the connection to finish before the turn proceeds.

### `mcp_config`

`opencode.mcp_config` names an operator-supplied MCP server configuration file. The worker reads it, merges its servers with the `sortie-tools` entry into the generated copy, and the adapter translates the merged result, so an operator's own servers reach a local OpenCode session alongside Sortie's. A relative path resolves against the directory containing `WORKFLOW.md`. An unreadable path, a file that is not valid JSON, or a file already declaring a server named `sortie-tools` fails the attempt before the session starts.

Two more conditions fail the session with `response_error` when the merged configuration reaches the adapter, and the message names the offending server: an entry that carries neither `command` nor `url`, carries both, or declares a `type` contradicting the fields it carries; and an entry carrying a key outside the modeled set, which is `type`, `command`, `args`, `env`, `url`, `headers`, and `enabled`. Both come from shared validation, so a file that fails here fails a `codex` session the same way. A header on an HTTP entry is carried into the document as written, which a `codex` session does not do; see the [Codex adapter reference](/reference/adapter-codex/#http-headers).

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex | OpenCode |
|---|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` | `opencode` |
| Default command | `claude` | `copilot` | `codex app-server` | `opencode` |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns | New process per turn, plus a usage-recovery subprocess after each turn |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout | CLI flags + newline-delimited stdout envelopes |
| Output format flag | `--output-format stream-json` | `--output-format json` | JSON-RPC notifications | `--format json` |
| Session ID source | UUID generated by adapter | UUID generated by adapter | Thread ID from `thread/start` response | Discovered from the first JSON envelope, or resumed via `--session` |
| Resume mechanism | `--resume <UUID>` | `--session-id <uuid>` on the first turn, `--resume <uuid>` after; never `--continue` | `thread/resume` or automatic within session | `--session <sessionID>` only |
| Input token reporting | Per-request, from the result event's per-model breakdown | Recovered from the runtime's session-state journal after exit | From `thread/tokenUsage/updated`, baseline-subtracted | Recovered from `opencode session export --standalone --sanitize` |
| Model reporting | From `assistant` events | Not available | Not available | Recovered from export `providerID/modelID` only |
| Token accounting source | Result event `modelUsage`, with top-level `usage` fallback | Session-state journal on disk, with stream output tokens as the in-turn estimate | `thread/tokenUsage/updated` notification | Separate export subprocess after main turn exit |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + explicit tool scoping | `approvalPolicy` and sandbox policy in JSON-RPC | `--dangerously-skip-permissions` plus a synthesized policy in the inline configuration document |
| Sandbox enforcement | None at adapter level | None at adapter level | OS-level sandbox plus configurable policy | No adapter-level sandbox; permission policy only |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as command-line overrides, local launch only | Generated servers re-expressed as an inline configuration document in the turn environment, local launch only (see [MCP](#mcp)) |
| Authentication | `ANTHROPIC_API_KEY` and provider routing flags | GitHub token variables or `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth from env, auth store, `.env`, or `opencode.json`; a remote session uses the host's own, or whatever `worker.ssh_pass_env` names |
| Provider multiplexing | Anthropic direct, Bedrock, Vertex | GitHub only | OpenAI or cached Codex auth | Multi-provider through OpenCode model/provider config |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None | None exposed by the adapter |
| Exit-code reliability | Structured result event plus process exit | Structured `result.exitCode` plus process exit | JSON-RPC turn status | Process exit alone is unreliable. Terminal stdout `error` can still exit `0`. |
| Non-JSON stdout tolerance | Not required | Not required | Not applicable | Required. Permission warnings can appear as plain text in `--format json` mode. |

---

## External references

- [OpenCode CLI documentation](https://opencode.ai/docs/cli/): official command reference for `opencode run`, `opencode export`, and session flags
- [OpenCode configuration reference](https://opencode.ai/docs/config/): `opencode.json` schema, provider auth store, and permission policy fields
- [`anomalyco/opencode` on GitHub](https://github.com/anomalyco/opencode): source repository, releases, and issue tracker
- [OpenCode permissions documentation](https://opencode.ai/docs/permissions/): semantics of the permission policy this adapter synthesizes

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema and `opencode` extension block
- [Environment variables reference](/reference/environment/): runtime environment behavior and configuration overrides
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/): orchestrator-level cost caps that matter most for OpenCode
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/): remote execution setup and host pool configuration
- [How to write a prompt template](/guides/write-prompt-template/): template variables, conditionals, and built-in functions
- [State machine reference](/reference/state-machine/): orchestration states, turn lifecycle, and stall detection
