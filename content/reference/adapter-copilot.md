---
title: "Copilot CLI Adapter"
description: "Copilot CLI agent adapter reference: configuration, session lifecycle, JSONL event stream, token accounting, errors, SSH remote execution, and auth."
author: Sortie AI
date: 2026-04-26
weight: 110
url: /reference/adapter-copilot/
---
The Copilot CLI adapter connects Sortie to the [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) via subprocess management. It launches the `copilot` binary with `--output-format json`, reads newline-delimited JSON from stdout, and normalizes events into Sortie's own event vocabulary. Registered under kind `"copilot-cli"`.

Each turn spawns an independent subprocess. Session start runs a version canary before a session is created, local-mode only; whether the credential actually works is settled separately, by the [credential-verification step](/reference/workflow-config/#credential-verification) every kind runs before its first working turn, unless Sortie proved the same setup recently.

Copilot CLI 1.0.51 or later is required: this adapter assigns its own session identifier with `--session-id`, a flag older releases reject. See [session identity](#session-identity).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for GitHub token variables, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `copilot-cli` extension block (pass-through to the Copilot CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Copilot CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"copilot-cli"` to select this adapter. |
| `command` | string or list | `copilot` | Path or name of the Copilot CLI binary, resolved from `PATH` at session start. Only the default kind reads `agent.command`, so a rule-routed `copilot-cli` session beside a different default kind runs `copilot`, whatever `agent.command` holds. See [`agent.command`](/reference/workflow-config/#agent) for the list form. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator runs up to this many turns, re-checking tracker state after each one. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single turn. The orchestrator cancels the turn when exceeded. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the session as stalled. `0` or negative disables stall detection. |
| `stop_grace_ms` | integer | `5000` (5 seconds) | How long the adapter waits for the subprocess to exit on its own after a graceful termination signal, before it force-terminates the process group. Must be positive. |
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
| `effort` | `--reasoning-effort` | string | _(CLI default)_ | Reasoning level, passed on every turn, credential verification included, and forwarded unchanged. See `copilot --help` on your installed version for the accepted values, and [adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration) for how an unset value is read. |
| `max_autopilot_continues` | `--max-autopilot-continues` | integer | `50` | Maximum autopilot continuation steps within a single turn. |
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
  effort: high
  max_autopilot_continues: 100
  agent: coding-agent
  mcp_config: ./mcp-servers.json
  disable_builtin_mcps: true
```

### `agent.max_turns` vs. `copilot-cli.max_autopilot_continues`

These two fields control different systems at different levels.

| Field | Controls | Scope |
|---|---|---|
| `agent.max_turns` | Sortie's orchestrator turn loop | How many times the orchestrator runs a turn per worker session. |
| `copilot-cli.max_autopilot_continues` | Copilot CLI's internal autopilot loop | How many autopilot continuation steps Copilot takes within a single turn. |

With `agent.max_turns: 5` and `max_autopilot_continues: 50`, the orchestrator runs up to 5 turns. Within each turn, Copilot takes up to 50 autopilot steps. The total step budget per session is at most 250.

Setting `max_autopilot_continues` too low causes Copilot to exit mid-task. Setting `agent.max_turns` too low causes the orchestrator to stop re-invoking the agent before the issue is resolved.

### Tool scoping behavior

The adapter passes `--allow-all` to auto-approve all tool calls unless `allowed_tools` is a non-whitespace value. `--allow-all` grants tool approval, file-path verification, and URL access in one flag, and `allowed_tools` is itself an approval allow-list (a subset of that grant), so the grant would subsume and defeat it if both were sent.

`denied_tools`, `available_tools`, and `excluded_tools` do not affect `--allow-all`. They are forwarded alongside it: a `--deny-tool` rule outranks the grant for a matching call, and `--available-tools` / `--excluded-tools` control what the model sees rather than what it may do. Setting one of these three, without setting `allowed_tools`, still runs with `--allow-all` present.

Every invocation also includes `--autopilot` and `--no-ask-user`, which are always present regardless of tool scoping configuration. `--no-ask-user` closes the CLI's route for putting a question to a person, so a request the runtime cannot satisfy on its own is always a request for consent to act rather than a question.

### Sortie's own tools and the `mcp_config` field

Sortie generates one MCP server configuration per session, declaring a `sortie-tools` stdio server that exposes Sortie's own tools to the agent. When that generated file exists, the adapter passes the generated servers to `--additional-mcp-config`, regardless of whether `copilot-cli.mcp_config` is also set.

On a local launch the adapter writes a derived file, `.sortie/copilot-mcp.json`, and passes it as `@<path>`. The derived file names each operator HTTP header value by an environment variable, `${SORTIE_MCP_HEADER_<n>}`, instead of holding the value; Sortie sets those variables in the runtime's environment. The file keeps the generated file's `env` block, which carries every `SORTIE_`-prefixed variable of Sortie's environment, so treat it as holding the same secrets.

On an SSH launch no file is passed, because a host path names nothing on the worker host. The adapter passes the servers as an inline JSON document. In it, `sortie-tools` is an HTTP server at the address of the launch's reverse forward, with an `Authorization` header that refers to `${SORTIE_TOOL_SERVER_BEARER}`. Operator HTTP servers appear with their URLs, and operator stdio servers are left out. See [delivery over SSH](/reference/agent-extensions/#delivery-over-ssh).

When `copilot-cli.mcp_config` names an operator-supplied file, Sortie reads it, inserts the `sortie-tools` entry into its `mcpServers` object, and writes the merged result. This is the same merge the Claude Code adapter performs, since both read from the orchestrator-generated config. A relative path resolves against the directory containing `WORKFLOW.md`. A server already named `sortie-tools` in the operator's file fails generation with a name-collision error rather than being silently overwritten.

Only when no generated configuration was merged, and only on a local launch, does the adapter fall back to forwarding `copilot-cli.mcp_config` directly to `--additional-mcp-config`. In that fallback path the adapter also decides how to present the value to the flag: a value starting with `{` is passed through as inline JSON, a value already starting with `@` is passed through unchanged, and any other value is treated as a file path and prefixed with `@`, matching the flag's own file-vs-inline convention.

### Runtime-denied permission requests

The CLI answers a permission request under its own non-interactive policy rather than handing it to Sortie: it denies the call, reports the denial as a `tool.execution_complete` event carrying the error code `denied`, and continues the session. The adapter recognizes that code and reports it as a `notification` event naming the reason. The turn is not ended, and no consent was granted. This is the path a tool call excluded by `allowed_tools`, `denied_tools`, `available_tools`, or `excluded_tools` takes.

---

## Validate-time checks

When `agent.kind` is `copilot-cli`, the [`sortie validate`](/reference/cli/#validate) pipeline runs a Copilot CLI-specific config check in addition to the generic preflight validation. It builds no adapter and launches no subprocess, and the same check runs at startup and on every workflow reload, so the verdict is identical in all three places.

### Warnings

| Check | Condition | Message |
|---|---|---|
| `copilot-cli.allowed_tools.auto_deny` | `allowed_tools` is set | `copilot-cli.allowed_tools replaces the --allow-all grant, so only a call the list matches is approved; every other permissioned call is denied without a prompt, the turn continues, and a turn whose calls were all denied still reports success` |

This is a warning rather than an error. Warnings leave `valid` true and the exit code `0`. `allowed_tools` narrows what the agent may do without leaving it waiting for a person: a call outside the list is denied and the session goes on, and the check flags that so a turn that got nothing approved does not read as an ordinary success.

---

## Session lifecycle

### Session start

Validates the workspace path, resolves the agent binary, runs a canary check, and mints the session identifier. No subprocess is spawned.

1. Validates that the workspace path is a non-empty absolute path pointing to an existing directory.
2. Resolves the `command` from `PATH`. In SSH mode, resolves the local `ssh` binary instead; the agent command resolves on the remote host.
3. **Canary check (local mode only):** runs `copilot --version` with a 5-second timeout. Any non-zero exit or timeout fails the session with `agent_not_found`, except that a session whose own context ends before the canary process starts running ends as `turn_cancelled`; the adapter does not read the version it printed, so this check confirms only that a working binary is present, not that it is new enough for `--session-id` (see [session identity](#session-identity)) or that any credential works.
4. Mints a fresh v4 UUID as the session identifier, unless a session ID saved from a previous run was supplied for a continuation session, in which case that value is used instead.
5. For a continuation session, reads the session's usage records from the session-state journal, on the runtime's host, to fix the session's starting point. A failed read leaves it unknown and does not fail the session start; see [accumulation logic](#accumulation-logic).
6. The session then records the workspace path, resolved binary, session ID, and SSH configuration for later turns to use.

No credential check runs here. Whether the environment or an authenticated `gh` actually lets Copilot CLI answer is settled before the working session's first turn, by the [credential-verification step](/reference/workflow-config/#credential-verification); see [authentication](#authentication).

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent binary not found in `PATH` | `agent_not_found` |
| Canary `copilot --version` timed out or exited non-zero | `agent_not_found` |
| Session start's own context ended before the canary process started running | `turn_cancelled` |
| Session identifier could not be generated (the system's random source is unavailable) | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

### Turn

Spawns a Copilot CLI subprocess, reads JSONL events from stdout, and delivers them to the orchestrator as they arrive.

1. Builds the CLI argument list from session state and pass-through configuration.
2. Always includes: `-p <prompt>`, `--output-format json`, `-s`, `--autopilot`, `--no-ask-user`, and `--max-autopilot-continues <n>` (`50` when `copilot-cli.max_autopilot_continues` is unset or not positive).
3. Applies session management flags (see [session identity](#session-identity)).
4. Spawns the subprocess in the workspace path, with the full parent process environment, and with the shutdown behavior described under [process shutdown](#process-shutdown).
5. Emits `session_started` event before it starts reading output.
6. Reads stdout one line at a time (64 KB initial buffer, 10 MB maximum line length).
7. Drains stderr separately (debug-level logging).
8. Parses each line as JSON.
9. Collects the exit status as soon as the subprocess exits, independent of output reading, then gives stdout and stderr reading a fixed five seconds each to finish before classifying the turn.
10. Captures session ID from the `result` event for subsequent turns.
11. Settles the turn's spend from its last usage checkpoint, reading the session-state journal when the checkpoint cannot settle it; see [token accounting](#token-accounting).
12. Ends the turn, recording the session ID, exit reason, and cumulative token usage.

### Session stop

Terminates a running subprocess. Safe to call when no subprocess is active.

1. Sends a graceful shutdown signal to the process group (POSIX: `SIGTERM`; Windows: `CTRL_BREAK_EVENT`).
2. Waits up to `stop_grace_ms` for the process to exit.
3. Force-terminates the process tree if still running (POSIX: `SIGKILL` to process group; Windows: `TerminateJobObject`).

---

## Process shutdown

By default, stopping a running subprocess sends an immediate kill signal, giving the agent process no chance to flush output buffers, close network connections, or emit final token-usage events. Sortie overrides that default: it sends a graceful shutdown signal instead (POSIX: `SIGTERM`; Windows: `CTRL_BREAK_EVENT` via the process group) and waits up to `stop_grace_ms` before force-killing the process (POSIX: `SIGKILL`; Windows: `TerminateJobObject`).

This applies whenever Sortie stops the subprocess, whether the orchestrator initiated it (a reconciliation kill, stall detection, or a turn timeout) or Sortie itself received a shutdown signal.

On all platforms, the subprocess runs in its own process group. On Windows, it is additionally assigned to a Job Object with `KILL_ON_JOB_CLOSE`, so the entire process tree (including MCP servers and other children) is terminated on shutdown or if Sortie crashes. The subprocess starts suspended and is resumed only after that assignment succeeds, so nothing it spawns can run before the job takes effect.

This covers every subprocess the adapter launches on Windows, not only turns: the `copilot --version` canary starts suspended too. A failed assignment logs WARN `process group assignment failed`; a failed resume logs WARN `process resume failed` and fails whichever launch it was, reporting `agent_not_found` for the canary and `port_exit` for a turn.

A launch whose context is already done when the resume is reached, by cancellation or by its deadline, is never resumed: Sortie terminates the subprocess before it runs and logs no resume warning. A turn ends this way as `turn_cancelled`, and so does a session start whose own context ended during the canary; a canary cut off by its own 5-second limit still reports `agent_not_found`.

Session stop follows the same shape: it sends the graceful signal, waits up to `stop_grace_ms`, and force-kills the process group if the wait elapses. If the stop request is itself interrupted before the grace period elapses, the process group is still force-killed and the interruption is reported as the error.

---

## Event stream

Copilot CLI emits one JSON object per line on stdout. The adapter parses each line and maps it onto Sortie's [normalized event vocabulary](/guides/write-custom-agent-adapter/), so what reaches the orchestrator, the logs, and the dashboard is the same set of events every adapter produces. The CLI's own event types and result payload are Copilot's to define; see [external references](#external-references).

Most of the stream is informational. It reaches the orchestrator as `notification` events with an empty message, which count as activity for stall detection but are not kept in the run's events; the agent's own text, the `session.warning` and `session.info` messages, and the `session.task_complete` summary keep their text. A tool call the runtime denies is reported as a `notification` and the turn continues, with no consent granted; see [runtime-denied permission requests](#runtime-denied-permission-requests).

---

## Token accounting

**Key difference from Claude Code:** Copilot CLI's `result` event carries no token counts. Its `usage` object holds premium requests, durations, and code-change stats, and the adapter reads only the API duration from it (see [API timing](#api-timing)). The adapter reads the figures from the `session.usage_checkpoint` lines on the JSONL stream, and the runtime's own session-state journal on disk. The checkpoint settles an ordinary turn; the journal settles a turn the checkpoints leave open.

The figure reaches the orchestrator once per turn, when the turn ends, split by served model, and the declaration is the same on a local launch and over SSH. Reported counts are cumulative over the run and never decrease. For this kind's declaration beside every other kind's, see the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind); for what a run records about the source of its figure, what a lower bound means, and which ceilings reach a run, see [spend measurement](/concepts/spend-measurement/).

### Usage checkpoints

The runtime writes a `session.usage_checkpoint` line after each prompt or autopilot continuation, not after each model request. The adapter reads `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` under `data.accountingSnapshot.modelMetrics.<model>.usage`. These are totals over the whole session, across every process that resumed it, so a turn's spend is its last checkpoint less the session's position before the turn.

`input_tokens` includes the cache-read and cache-write counts, which `cache_read_tokens` and `cache_write_tokens` carry separately as disjoint subsets of input. Reasoning tokens sit inside `output_tokens`. `total_tokens` is `input_tokens + output_tokens`. A count that is absent, null, or not a JSON integer makes the reading unknown rather than zero.

A turn settled by its checkpoint is recorded with the usage provenance `output` / `live`.

### Session-state journal

The runtime writes one journal per session at `<COPILOT_HOME>/session-state/<session id>/events.jsonl`, falling back to `~/.copilot/session-state/...` when `COPILOT_HOME` is unset or empty. On an SSH launch the remote shell resolves that location on the worker host. The adapter reads only the `session.usage_record` lines, one per model request, each carrying the same token counts under `data.usage`, the model that served the request, and an identifier that makes each request count once.

The adapter reads the journal at these points:

- At the start of a resumed session, where the total of every usage record is the session's starting point. See [accumulation logic](#accumulation-logic).
- At the end of a turn the checkpoints leave unsettled: a turn that ends without a `result` event carrying `exitCode: 0`, one for which the runtime wrote `abort`, one with no checkpoint, one that starts from an unknown position, and every turn after an interrupted one, until the records have caught up with what it left uncounted.

Each read is bounded by `read_timeout_ms` and runs locally or through the session's SSH launch. A read fails on a missing file, a session ID that fails the path-segment check, a journal above 64 MB or a line above 10 MB, an SSH connection failure, or the timeout. A failed read logs `copilot journal read failed` at debug level and leaves the starting point or the turn's records unknown, never zero; a later turn reads again.

Under a custom model provider the runtime writes no `session.usage_checkpoint` line, so the journal settles every turn. A turn settled from the journal is recorded with the usage provenance `journal` / `records`.

### Accumulation logic

1. At session start the adapter fixes the session's starting point. It is zero for a session the run creates. For a session the run resumes, it is the total of the journal's usage records, because a resumed process's counter starts from that total, which also holds the records a killed process wrote and no checkpoint reported. A failed read leaves the starting point unknown and does not fail the session start.
2. A turn that ends with a `result` event carrying `exitCode: 0`, no `abort`, and a checkpoint reports the checkpoint's growth over the session's position. That figure is complete.
3. Any other turn reads the journal. A turn that ended without a `result` event carrying `exitCode: 0`, or with `abort`, takes the records in place of its checkpoint: the figure is the records' growth over what the run already counted, and the turn counts toward `unaccounted_turns` even when the read succeeds, because a request in flight when the turn ended leaves no record. A turn that ended normally with no checkpoint, such as every turn under a custom model provider, takes the records' growth as a complete figure. A turn whose read fails or holds nothing new reports no figure and emits no `token_usage` event, and counts toward `unaccounted_turns` when the runtime had streamed model output or started a tool.
4. When the starting point is unknown, the first checkpoint becomes it. That turn reports no figure and counts toward `unaccounted_turns`, because its own share cannot be separated from what the session already held. Later turns report their own growth, and no figure the run reports claims to cover the whole session.
5. A turn that reports no figure adds nothing and lowers nothing: the run total is the sum of what every turn settled. A run in which no turn ever settles a figure is recorded as unmeasured.

Sortie cancels a turn with `SIGTERM` to the process group, then `SIGKILL` once `stop_grace_ms` elapses; see [process shutdown](#process-shutdown). The runtime does not always write its journal in the grace period. When it does write `abort`, it follows it with a final checkpoint that omits the request in flight and a `result` event carrying `exitCode: 0`; the adapter reads `abort` as a cancelled turn, so the journal settles it in place of that checkpoint. Under a custom model provider the runtime writes the whole journal when the turn ends and exits within milliseconds of `SIGTERM`, so a turn cancelled mid-request can leave no journal at all. After `SIGKILL` the journal can lack the records of completed requests too. Either way the turn reports what the records hold, possibly nothing, and the run's figure is a lower bound.

### Model tracking

Each `modelMetrics` key of a checkpoint names a model that served requests, and the turn's growth is attributed to those keys. A model switch on resume adds a key, and a sub-agent's requests count under the model that served the sub-agent. A journal record names the model of its own request. The adapter never reports the configured `copilot-cli.model` value, which names the model requested rather than the model that served.

### Premium requests and AI credits

The same `modelMetrics.<model>` entry carries the model's premium requests (`requests.cost`) and AI credits (`totalNanoAiu`, in billionths), totals over the session like the token counts. The adapter records each as the growth over the session's history, per model, in its own unit: `premium requests`, and `AI credits` as the reported number divided by 10^9. The checkpoint's top-level `totalPremiumRequests` and `totalNanoAiu` and the `result` event's `usage.premiumRequests` are not read.

A turn the journal settles takes both amounts from its records. A record's premium requests are its `cost` when `initiator` is `user`, 0 when it is `agent` or `sub-agent`, and unknown for any other or absent initiator, which leaves the run's premium requests a lower bound. Its AI credits are `copilotUsage.totalNanoAiu` divided by 10^9 whatever the initiator. An amount that is absent, null, not a number, or negative reads unknown rather than zero.

Neither amount is added to a token count, converted to the other, or converted to US dollars. The run's estimated cost comes from its token counts and [`token_rates`](/reference/workflow-config/#token_rates), and no token or money ceiling counts premium requests or AI credits. The run keeps both amounts with its history, served as `vendor_amounts` by the [run history API](/reference/http-api/#get-apiv1runs-run-history).

### Why a run exceeds the session journal

A run's reported usage can exceed what the session journal holds for the working session. The difference is the credential-verification request. The check runs in a Copilot session of its own, and the journal of that session is deleted with it when the check ends, so the working session's journal never held it. Sortie counts the request in the run's usage, its premium requests and AI credits, and its cost estimate because the model call is billed like any other, and adds it to every figure the working session reports.

The extra amount is one request from a fresh session: input that is nearly all cache write with no cache read, because a new session writes its whole prompt to cache, and the few output tokens of the one-sentence answer. Its size is the size of the verification prompt, which depends on the CLI version and the model. The request is small because the check sends only the built-in system prompt and one tool; see [authentication](#authentication).

A run adds at most one such request. A run whose log shows `agent credential verification skipped` adds none, and its usage equals the journal's growth over the run. A run that performed the check, local or over SSH, exceeds the journal by exactly that request.

### API timing

The `result` event carries `usage.totalApiDurationMs`, which the adapter attaches to the turn completion or failure event. Unlike the Claude Code adapter, there is no per-request API latency tracking between individual events.

---

## Usage limits

When each turn ends, the adapter reads the monthly quotas of the signed-in GitHub account. A turn that was cancelled or timed out reads nothing. A failed read reports nothing and leaves the limits already reported in place. A session started with `COPILOT_PROVIDER_BASE_URL` set reads nothing for the rest of the session, because a custom provider spends no Copilot quota.

The adapter takes the first of `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` that is set in the agent's environment and sends a request to `api.github.com` with it. Sortie's own host sends the request, including when the agent runs on an SSH worker. The token goes only into the request's authorization header; Sortie does not store or log it. When no variable is set, or GitHub answers `401`, `403`, or `404`, the adapter instead starts a one-shot headless server of the CLI (`--headless --no-auto-update --stdio`) and asks it for the account quota, so the answer comes from the CLI's own sign-in. On an SSH worker that server runs on the worker host. Any other status from GitHub is a failed read.

| Quota | Label |
|---|---|
| Premium requests | `Monthly premium request limit` |
| Chat | `Monthly chat limit` |
| Completions | `Monthly completion limit` |

A quota the account has without a limit is not reported. The share used is 100 less the percentage of the quota that remains, and the reset time is the quota reset date GitHub states. The quotas carry no status.

---

## Tool call tracking

The adapter observes tool execution by correlating `tool.execution_start` and `tool.execution_complete` events.

### Correlation

1. A `tool.execution_start` event records the call, as described under [Tool kind and argument](#tool-kind-and-argument), and a start time, keyed by `toolCallId`.
2. A `tool.execution_complete` event looks up the matching `toolCallId`.
3. On a match, the adapter emits a `tool_result` event carrying the recorded tool name, kind and argument, how long the call took since that start time, and whether it errored, inverted from the `success` field. With no match (the completion arrived without a recorded start), the event still fires, with no tool name, kind or argument and a duration of `0`.

### Tool kind and argument

The adapter gives each call a kind and one main argument, both read from the `tool.execution_start` event. Which members the event serves, and how they show in the session view, are on the [HTTP API](/reference/http-api/) and [dashboard](/reference/dashboard/#session-view) pages.

| Copilot CLI tool | Kind | Argument comes from the input member |
|---|---|---|
| `bash` | `shell` | `command` |
| `view` | `read` | `path` |
| `create` | `edit` | `path` |
| `edit` | `edit` | `path` |
| `skill` | `skill` | `skill` |

A tool outside this table has its name and no kind or argument. A call in the table whose input is not a JSON object, or has no string member of the listed name, has its kind and no argument. The argument is that one member only; no other input of the call is read or carried.

An MCP call is named `{server}.{tool}`, from the `mcpServerName` and `mcpToolName` members of the start event, and has no kind or argument. The name applies only when both members are present; otherwise the call is treated as any other tool, by its `toolName`.

### Tool error detail

**Key difference from Claude Code:** the `success` boolean is the only error signal. There is no error text extraction or ANSI stripping. The Claude Code adapter extracts error text from `tool_result` content blocks and applies XML stripping, ANSI removal, and truncation. The Copilot CLI adapter reports only whether the tool succeeded or failed.

---

## Error handling

### Turn outcome

The outcome is not decided by the exit code alone. The shared decision table evaluates evidence in a fixed order and returns on the first match, so a `result` event outranks the process exit status.

| Evidence, in evaluation order | Exit reason | Error kind |
|---|---|---|
| Orchestrator cancelled the turn while the process was still running | `turn_cancelled` | `turn_cancelled` |
| Exit code `127`, after writing output | `turn_failed` | `agent_not_found` |
| `result` event carrying `exitCode: 0`, no `session.task_complete` event this turn | `turn_failed` | `turn_incomplete` |
| `result` event carrying `exitCode: 0`, a `session.task_complete` event reporting `success: false` | `turn_failed` | `turn_failed` |
| `result` event carrying `exitCode: 0`, a `session.task_complete` event reporting `success` true or omitted | `turn_completed` | _(none)_ |
| `result` event carrying any other `exitCode`, or carrying no `exitCode` field | `turn_failed` | `turn_failed` |
| No `result` event, the process exited before writing a line the adapter decodes as an event, whatever its exit status | `turn_failed` | `port_exit`, as the [early exit report](/reference/errors/#early-exit-report) |
| No `result` event, non-zero exit, including death by a signal Sortie did not send | `turn_failed` | `port_exit` |
| No `result` event, exit `0`, no message from the agent and no tool call this turn | `turn_failed` | `turn_failed` |
| No `result` event, exit `0`, a message from the agent or a tool call this turn | `turn_completed` | _(none)_ |

The cancellation and exit-`127` rows are decided before the adapter's own classifier runs; the exit-`127` row applies only once the process has written output, because an exit before that is the early-exit row. A cancellation counts only when the stop began while the process was still running: a process that had already exited on its own is classified by its own exit status, however long the wait for its output ran.

A process ended by a signal Sortie did not send is a non-zero exit, and the error text names the signal, for example `signal: killed`. The work test reads this turn's own stream rather than any token count.

A message from the agent is a non-empty `data.content` on an `assistant.message`, or any `assistant.message_delta`, whose event type names an assistant message even though its payload stays unparsed. A tool call is a non-empty `data.toolRequests` on an `assistant.message`, or a `tool.execution_start` or `tool.execution_complete` whose data parsed. Stderr from a failing turn is re-emitted at WARN level.

When the `result` event reports a failed exit (a non-zero or missing `exitCode`), the failure text is the trimmed `data.message` of the turn's last `session.error` event, so an error from the model provider reaches the run as the provider wrote it. If the runtime sent no `session.error` with a readable message, the text is `non-zero exit in result event`.

Each `session.error` event also reaches the orchestrator as a `notification` event with an empty message. Every turn starts with no stored message, so an earlier turn's error never labels a later one.

A `result` event with `exitCode: 0` is not decisive by itself: the adapter also checks whether this turn saw a `session.task_complete` report, the runtime's own record of whether the work finished. The [`max_autopilot_continues`](#agentmax_turns-vs-copilot-climax_autopilot_continues) ceiling can stop the runtime mid-task with a clean exit and no such report; without this check that outcome read as an ordinary success.

`turn_incomplete` is retried like the other transient turn failures, on exponential backoff. The retry starts a new session with a fresh continuation ceiling over the same workspace. Raise `copilot-cli.max_autopilot_continues` if the task genuinely needs more autopilot steps per turn. No other built-in adapter reports `turn_incomplete` today.

`--no-ask-user` is on every invocation, so this adapter has no path to `turn_input_required`: the runtime cannot put a question to a person, and a denied tool call continues the session instead of ending the turn.

### Stdout read failure

If output reading from stdout fails (buffer overflow, broken pipe), the adapter:

1. Sends a graceful-kill signal to the subprocess.
2. Waits for exit.
3. Ends the turn as `turn_failed` with error kind `port_exit`.

---

## Session identity

This adapter assigns the identifier itself: session start mints a fresh v4 UUID for every session it creates, before any turn runs, the same way the [Claude Code adapter](/reference/adapter-claude-code/#session-persistence-and-resume) does.

| Turn | CLI flag |
|---|---|
| First turn of a session this run created | `--session-id <uuid>` |
| Every later turn of that session | `--resume <uuid>` |
| Any turn of a session the orchestrator handed back from an earlier attempt | `--resume <uuid>`, from the first turn |

`--continue` is never passed: that flag resumes whichever session the home directory saw most recently, possibly another issue's, or the [credential-verification step's](/reference/workflow-config/#credential-verification) own session. Minting the identifier up front avoids that risk entirely.

`--session-id` requires Copilot CLI 1.0.51 or later; an older CLI rejects the flag, and Sortie does not check the installed version for this. The [credential-verification step](/reference/workflow-config/#credential-verification) opens its own session the same way, with `--session-id` on its own first request, so an outdated CLI fails there, before the working session ever starts.

A CLI that rejects the switch on standard error and exits before writing to stdout is reported as the [early exit report](/reference/errors/#early-exit-report), `port_exit`, so its own complaint about `--session-id` appears in the error text.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches Copilot CLI on a remote host via SSH instead of locally.

### How it works

1. Session start resolves the local `ssh` binary from `PATH`. The agent command is stored for remote execution rather than resolved locally. The version canary is skipped in SSH mode; the [credential-verification step](/reference/workflow-config/#credential-verification) still runs, against the remote host.
2. Each turn builds an SSH command that wraps the remote Copilot CLI invocation.
3. The remote shell enters the workspace, exports the [environment variables the launch carries](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent), and only then runs the configured command with that turn's arguments, each step chained on the success of the one before it. The workspace path and each argument are individually single-quoted; the agent command is inserted as configured, unquoted.
4. The carried set includes this kind's own credential variables, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`. See [authentication](#authentication) for what that overrides on the host.

### Usage measurement over SSH

A remote session is measured the same way as a local one. The usage checkpoints arrive on the SSH session's standard output, and every session-state journal read, at the start of a resumed session and at the end of an unsettled turn, runs on the worker host through the session's own SSH launch, where the remote shell resolves `COPILOT_HOME`. The session's `usage_arrival` is `turn_end` and its `usage_attribution` is `per_model` on either launch, so `agent.max_tokens` and the money ceilings bound a remote run as they bound a local one. An SSH connection failure during a read is a failed read: it leaves the turn's figure unknown, never zero; see [session-state journal](#session-state-journal).

### SSH options

The adapter uses these SSH options. A launch that delivers Sortie's tools adds a reverse forward and the options that go with it; see [delivery over SSH](/reference/agent-extensions/#delivery-over-ssh).

| Option | Value | Purpose |
|---|---|---|
| `StrictHostKeyChecking` | Configurable (default: `accept-new`) | Host key verification policy. Set via [`worker.ssh_strict_host_key_checking`](/reference/workflow-config/#worker). Allowed values: `accept-new`, `yes`, `no`. |
| `BatchMode` | `yes` | Disables interactive prompts (password, passphrase). |
| `ConnectTimeout` | `30` | Connection timeout in seconds. |
| `ServerAliveInterval` | `15` | Keepalive interval in seconds. |
| `ServerAliveCountMax` | `3` | Number of missed keepalives before disconnect. |

### Shell quoting

The workspace path and each per-turn CLI argument are single-quoted with embedded single-quote escaping (the standard POSIX `'\''` pattern) before being placed in the remote command string. This prevents injection when SSH passes the remote command through the remote shell. A string agent command itself is not quoted this way, since it may legitimately be more than one shell token; each element of a list command is single-quoted.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit`. Exit code `127` means the remote agent binary is not in `PATH`; the process wrote nothing to stdout, so the turn takes the [early exit report](/reference/errors/#early-exit-report) under `port_exit`, carrying `exit status 127` and the remote shell's own message.

---

## Authentication

Sortie does not manage Copilot CLI credentials and runs no preflight of its own: the adapter spawns the subprocess with the full parent process environment, and the Copilot CLI resolves its own credential from it. Which source it reads, and in what order, is the CLI's own to document.

Whether that resolves to a working credential is settled before the working session's first turn, by the [credential-verification step](/reference/workflow-config/#credential-verification) every agent kind runs unless Sortie proved the same setup recently: it opens a session of its own, sends one fixed request, and reports `credential_unverified` if the CLI cannot answer it.

A CLI that rejects the credential by printing a message and exiting before it writes to stdout is reported as the [early exit report](/reference/errors/#early-exit-report) instead, `port_exit`, carrying that message. The step exercises the credential rather than checking for its presence, so whichever source the CLI actually resolves, an environment variable or a stored login, passes or fails on the same footing.

That verification session carries the same switches as the working session it precedes, with these exceptions: `--max-autopilot-continues 0` in place of the configured ceiling, `--disable-builtin-mcps` in place of any MCP configuration, no tool server, `--available-tools view` in place of `copilot-cli.available_tools`, no `--excluded-tools`, and `--no-custom-instructions` whatever `copilot-cli.no_custom_instructions` says. The request therefore carries the built-in system prompt and one read-only tool, and none of the custom instructions or other tool descriptions the working session sends. A CLI build that rejects one of these switches and exits before it responds is checked once more without `--available-tools view` and `--no-custom-instructions`, with the operator's own tool and instruction settings, after a warning in the log. Once the check completes, session stop deletes that session's own conversation through a one-shot `copilot --server --stdio` process, sending it a `session.delete` request; a failed delete is only logged, never retried, and never fails the run.

A remote session receives the tokens directly instead of running any check locally. This kind declares `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` as its credential variables, so a remote launch carries whichever of them Sortie's own environment sets into the agent's environment on the build host.

A carried token overrides a `copilot auth login` stored there, which matters when Sortie holds one of those names for something else: `tracker.api_key: $GITHUB_TOKEN` is enough to re-authenticate every remote session as the tracker's identity. Name the variable under [`worker.ssh_disallow_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) to leave the host's own login in effect.

{{< callout type="warning" >}}
**A present token does not guarantee a working one**

Neither Sortie nor the credential-verification step inspects a token's type or scopes; the step only confirms that a real request completes. Whether a given token authenticates with Copilot CLI, and what type and permission it needs, is GitHub's to document; see [managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) in the external references. A token with the wrong scopes can still fail the credential-verification request even though a variable is set.
{{< /callout >}}

---

## Key differences from Claude Code adapter

| Aspect | Claude Code | Copilot CLI |
|---|---|---|
| Kind | `claude-code` | `copilot-cli` |
| Default command | `claude` | `copilot` |
| Output format flag | `--output-format stream-json` | `--output-format json` |
| Session ID at start | UUID generated by adapter | UUID generated by adapter |
| Resume flag | `--resume <UUID>` | `--session-id <uuid>` on the first turn of a session this run created, `--resume <uuid>` on every later turn; `--continue` is never used |
| Input token reporting | Provisional per request from `assistant` events, settled by the `result` events' `model_usage_since_last_result`; the [session journal](/reference/adapter-claude-code/#session-journal) settles a turn they do not cover | From the last `session.usage_checkpoint` of the turn, or the session-state journal's usage records when the checkpoint cannot settle it, once per turn, locally and over SSH |
| Model reporting | From `assistant` events | From the served-model keys of the checkpoint, or each journal record's own model |
| Permission mode | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user`, plus `--allow-all` unless `allowed_tools` is set |
| Tool error detail | Error text with XML/ANSI stripping | Boolean `success` flag only |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` |
| Canary check | None | `copilot --version` (5-second timeout) |
| Credential check | None; settled by [credential verification](/reference/workflow-config/#credential-verification) like every kind | Settled by [credential verification](/reference/workflow-config/#credential-verification) like every kind; no adapter-specific preflight of its own |
| Minimum runtime version | None enforced | 1.0.51, for `--session-id`; not checked by Sortie |

For Claude Code configuration, see [Claude Code adapter reference](/reference/adapter-claude-code/).

---

## External references

- [Using GitHub Copilot in the command line](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line): official Copilot CLI documentation
- [`gh auth login` reference](https://cli.github.com/manual/gh_auth_login): establishes the credentials this adapter inherits when no `*_TOKEN` env var is set
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens): GitHub token types and permissions
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification): the MCP server protocol consumed via `--additional-mcp-config`

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema and `copilot-cli` extension block
- [Environment variables reference](/reference/environment/): GitHub token variables
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/): turn caps, session caps, concurrency limits, and model selection
- [How to write a prompt template](/guides/write-prompt-template/): template variables, conditionals, and built-in functions
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/): remote execution setup and host pool configuration
- [State machine reference](/reference/state-machine/): orchestration states, turn lifecycle, and stall detection
