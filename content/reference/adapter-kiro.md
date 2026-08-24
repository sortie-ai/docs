---
title: "Kiro CLI Adapter"
description: "Complete reference for the Kiro CLI agent adapter: configuration, session lifecycle, plain-transcript headless output, credential preflight, time-based budgeting, error handling, cwd-scoped resume, and SSH remote execution."
author: Sortie AI
date: 2026-05-29
weight: 140
url: /reference/adapter-kiro/
---
The Kiro CLI adapter connects Sortie to the [Kiro CLI](https://kiro.dev/docs/cli/), the rebranded Amazon Q Developer CLI, via subprocess management. It launches `kiro-cli chat --no-interactive`, reads a plain human transcript from stdout, and classifies the turn outcome from the process exit status and stderr. Headless Kiro emits no structured event stream, so the adapter parses no JSON. Registered under kind `"kiro"`.

Each `RunTurn` call spawns a fresh subprocess (fork-per-turn). `StartSession` runs a credential preflight but starts no long-lived process. `EventStream()` returns `nil`; events arrive through the `RunTurn` `OnEvent` callback. The adapter is safe for concurrent use: one adapter instance serves all sessions, with per-session state held in an opaque internal handle.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for `KIRO_API_KEY`, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `kiro` extension block (pass-through to the Kiro CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Kiro CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"kiro"` to select this adapter. |
| `command` | string | `kiro-cli` | Path or name of the Kiro CLI binary. Resolved via `exec.LookPath` at session start. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator calls `RunTurn` up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `max_concurrent_agents_by_state` | map | `{}` | Per-state concurrency limits. Keys are state names, lowercased for matching. Non-positive or non-numeric entries are silently ignored. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single `RunTurn` call. The orchestrator cancels the turn context when exceeded. See `stall_timeout_ms` below for the bound on a turn that stops producing output. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the turn as stalled. `0` or negative disables stall detection. |
| `max_retry_backoff_ms` | integer | `300000` (5 minutes) | Maximum delay cap for exponential backoff between retry attempts. |

```yaml
agent:
  kind: kiro
  command: kiro-cli
  max_turns: 5
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  max_retry_backoff_ms: 300000
```

### `kiro` extension section

These fields are adapter-specific, and each maps to a `kiro-cli chat` flag. The trust keys are checked before any run starts; see [validate-time checks](#validate-time-checks).

| Field | CLI flag | Type | Default | Description |
|---|---|---|---|---|
| `model` | `--model` | string | _(CLI default)_ | Model identifier passed on every turn. Pinned per turn because the `/model` slash command is unavailable headless. |
| `trust_all_tools` | `--trust-all-tools` | boolean | `true` when neither trust key is set | Auto-approves every tool call. Mutually exclusive with `trust_tools`. |
| `trust_tools` | `--trust-tools=<csv>` | list of strings | _(absent)_ | Comma-joined tool allowlist. Setting it is refused; see [tool trust behavior](#tool-trust-behavior). Mutually exclusive with `trust_all_tools`. |
| `agent` | `--agent` | string | _(none)_ | Named Kiro context profile (custom agent). |

```yaml
kiro:
  model: <model-id>
```

### Tool trust behavior

The adapter resolves one trust posture from the configuration and serializes it into a single argument per turn. `trust_all_tools` resolves to `true` when the `kiro` block sets neither trust key, so a configuration that names only a model trusts every tool. An explicit value is used unmodified, including an explicit `false` and an explicit empty `trust_tools` list.

| Configuration | Argument emitted | Effect |
|---|---|---|
| Neither key set | `--trust-all-tools` | Approves every tool call. |
| `trust_all_tools: true` | `--trust-all-tools` | Approves every tool call. |
| `trust_all_tools: false`, or any `trust_tools` value | `--trust-tools=<comma-joined>` | Approves only the listed tools. Refused before the run. |

Only full trust is accepted today. What `kiro-cli chat --no-interactive` does when it meets a tool the allowlist does not cover is unestablished: observing it needs an authenticated headless turn, and the credential to drive one was not available. The conservative reading is that the CLI waits for an approval an unattended run has nobody to give, so any posture that can still reach an untrusted tool call draws the `kiro.trust_tools.untrusted` error rather than being accepted unexamined. Leave both keys unset, or set `trust_all_tools: true`, and run the agent inside a hardened sandbox.

---

## Validate-time checks

When `agent.kind` is `kiro`, the [`sortie validate`](/reference/cli/#validate) pipeline runs Kiro-specific config checks in addition to the generic preflight validation. They construct no adapter instance and launch no subprocess, and the same checks run at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `kiro.trust_tools.conflict` | `trust_all_tools` is true and `trust_tools` is also non-empty | `trust_all_tools and trust_tools are mutually exclusive` |
| `kiro.trust_tools.untrusted` | The resolved trust posture is anything short of full trust | `trust_all_tools does not resolve to true, and kiro-cli's behavior on an untrusted tool under --no-interactive is unestablished; the conservative assumption is that it waits for an approval this unattended run cannot give, so trust_all_tools: true (or leaving trust_all_tools and trust_tools both unset) is required` |

The adapter constructor reports the mutual-exclusion fault with the same message, so the two paths can never disagree.

---

## Session lifecycle

### `StartSession`

Validates the workspace path, resolves the `kiro-cli` binary, verifies the credential, and initializes per-session state. No subprocess is spawned.

1. Resolves the launch target via `agentcore.ResolveLaunchTarget(params, "kiro-cli")`. This validates that the workspace path is a non-empty absolute path pointing to an existing directory, and resolves `command` via `exec.LookPath`, defaulting to `kiro-cli`. In SSH mode, it resolves the local `ssh` binary instead and stores the remote command for later use.
2. **Local mode:** runs the credential preflight. Confirms `KIRO_API_KEY` is set, then runs a `kiro-cli whoami` canary. See [authentication](#authentication).
3. **SSH mode:** skips the credential preflight and injects `KIRO_API_KEY` inline into the remote command, shell-quoted. See [SSH remote execution](#ssh-remote-execution).
4. Initializes per-session state: launch target, agent config, pass-through config, logger, the `ResumeSessionID` value as `sessionID`, and a fresh per-turn stdout accumulator.
5. Constructs the `agentcore.ForkPerTurnSession` that owns the subprocess lifecycle for this session.
6. Returns a `Session` with `ID` set to the resume session ID, an empty `AgentPID`, and the opaque session state.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| Local `kiro-cli` binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |
| `KIRO_API_KEY` not set (local mode) | `response_error` |
| `kiro-cli whoami` canary times out or exits non-zero (local mode) | `response_error` |
| Canary output shows an invalid or expired key (local mode) | `response_error` |

The credential errors return `response_error` rather than `agent_not_found`, because the binary is already resolved when the canary runs. A canary failure means the present binary could not confirm the credential, not that the agent is missing, so it is classified as a retryable credential problem.

### `RunTurn`

Resets the per-turn stdout accumulator and delegates to the shared fork-per-turn session.

1. Panics if `OnEvent` is nil.
2. Recovers the session state from `Session.Internal`. Returns `response_error` if the type assertion fails.
3. Resets the per-turn stdout accumulator so each turn starts clean.
4. Calls `forkSession.RunTurn` with the rendered prompt and the `OnEvent` callback.

The fork-per-turn session builds the argument list, launches one `kiro-cli` subprocess, scans its stdout, drains stderr, waits for exit, and runs the adapter's `OnFinalize` classifier. See [headless output](#headless-output) and [error handling](#error-handling).

### `StopSession`

Terminates a running subprocess by delegating to the fork-per-turn session. Returns nil when no subprocess is active and is safe to call after a failed `RunTurn`.

### `EventStream`

Returns `nil`. The adapter delivers all events synchronously through the `OnEvent` callback in `RunTurn`.

---

## Process shutdown

The adapter inherits the shared `agentcore` fork-per-turn shutdown. Each turn runs under `exec.CommandContext`. Before start, the subprocess is placed in its own process group via the shared `procutil` package. `cmd.Cancel` is set to send a graceful signal to the process group, and `cmd.WaitDelay` is set to 5 seconds.

On Unix, graceful shutdown is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful shutdown is `CTRL_BREAK_EVENT` to the process group, and the subprocess is assigned to a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree.

Shutdown is turn-scoped, because fork-per-turn means there is no process between turns. `StopSession` performs an explicit graceful-to-force sequence: it sends `SIGTERM` to the process group, waits up to 5 seconds for the turn to complete cleanup, then sends `SIGKILL` to the process group if the grace window elapses. If the `StopSession` context is cancelled first, the adapter force-kills the process group and returns `ctx.Err()`. After `cmd.Wait` returns, the session performs a best-effort group kill to clean up any surviving children.

---

## Headless output

This is the defining section. Headless Kiro emits no structured stream. There is no JSON, no JSONL, and no machine-readable result envelope. The turn outcome is determined from process exit status and stderr, not from parsed stdout.

stdout is a human transcript. For a turn that invokes no tools, it carries the assistant answer with a colorized `> ` marker and ANSI styling. A turn that invokes tools also prints tool-progress lines. The adapter launches with `--wrap never` to disable width-based line wrapping, strips ANSI color and style escapes from each line, and accumulates the cleaned text into a per-turn buffer.

Each non-empty cleaned line is surfaced as an `EventNotification`, with the message truncated to 500 runes. The accumulated buffer is not truncated; the `OnFinalize` classifier reads its length to distinguish an empty-stdout authentication failure from a turn that produced output. The notifications exist for observability; the adapter does not derive turn outcome from them.

stderr carries the signals the adapter classifies:

| stderr content | Meaning |
|---|---|
| `▸ Credits:` trailer | The one positive proof a turn executed. The numeric credit and time values vary; the prefix is the stable contract. |
| `Authentication failed.` | The credential is present but invalid. |
| Warnings (for example, `Failed to retrieve MCP settings`) | Non-fatal diagnostics. Re-emitted at WARN level on failure paths. |

There are no per-event timestamps in the transcript. The adapter cannot reconstruct tool-call durations, so it emits no tool-result events. That is the practical difference from an adapter with a structured stream: there is nothing to correlate, so tool activity does not reach Sortie's events at all.

---

## Token accounting

The headless path reports no token counts. The closing cost line on stderr (`▸ Credits: 0.01 • Time: 1s`) carries an abstract credits figure and elapsed time, never input or output token counts. The credits figure does not map onto Sortie's normalized usage counters, which are token counts only.

The adapter emits no `token_usage` event and reports zero token counts on every path. It also reports every run as unmeasured, so those zeros are recorded as an absence of measurement rather than as a measurement of zero: the run contributes nothing to the per-issue token ceiling, advances no `sortie_tokens_total` series, is excluded from `sortie stats` token and cost figures, and is counted in that command's `tokens_unmeasured_runs`. The dashboard shows `not reported` in place of a token count for a running Kiro session. Token-based budget enforcement is inert for this adapter.

Time-based budget enforcement is the only supported mechanism. Set `agent.turn_timeout_ms` to bound wall-clock time per turn. This replaces the token accumulation, model tracking, and API timing logic of the structured-output adapters.

---

## Error handling

### Outcome classification

The turn outcome is determined from the process exit status and the two stderr signals. The adapter's own classifier reports an outcome for exactly two cases - an exit-0 turn that printed the credits trailer, and an exit-0 turn whose stdout was empty and whose stderr carried the authentication marker. Everything else is decided by the shared decision table from the exit status alone, so the messages on those rows are the shared ones rather than anything Kiro-specific.

| Kiro evidence | Exit reason | Error kind | Message | Decided by |
|---|---|---|---|---|
| Exit 0 with a `▸ Credits:` trailer on stderr | `turn_completed` | _(none)_ | _(empty)_ | The adapter's classifier. Also sets the resume flag for subsequent turns. |
| Exit 0, empty stdout, no credits trailer, `Authentication failed.` on stderr | `turn_failed` | `response_error` | `kiro authentication failed` | The adapter's classifier. |
| Exit 0, no credits trailer, any other case | `turn_failed` | `turn_failed` | `agent exited without producing output: no credits trailer on stderr` | Shared zero-work row. |
| Any other non-zero exit | `turn_failed` | `port_exit` | `non-zero exit` on the event, `exit code N` on the error | Shared non-zero-exit row. |
| Exit 127 | `turn_failed` | `agent_not_found` | `agent binary not found` | Shared skeleton, before the classifier runs. |
| Process terminated by a signal | `turn_cancelled` | `turn_cancelled` | `killed by signal` | Shared skeleton, before the classifier runs. The skeleton tests whether the process was signalled, not for a particular exit code. |
| Turn context cancelled | `turn_cancelled` | `turn_cancelled` | `context cancelled` | Shared skeleton, before the classifier runs. |
| stdout scanner error | `turn_failed` | `port_exit` | `stdout read error: <detail>` | Shared skeleton. Becomes `turn_cancelled` if the context is already cancelled. |

Because the adapter reports no per-turn work signal of its own, the shared zero-work row is what an exit-0 turn with no credits trailer falls through to; the trailer is consumed as the success signal rather than as work evidence.

### Why exit 0 is not success

A successful turn and an invalid-credential turn both exit 0. Exit code alone cannot distinguish them. The reliable success signal is the `▸ Credits:` trailer on stderr, which a turn prints only after it actually executed. The adapter never maps a bare exit 0 to `turn_completed`. It requires the credits trailer as the positive success signal and classifies an exit-0 turn with no trailer as a failure.

---

## Session resume

Continuation is cwd-scoped. The adapter does not track a session ID across turns.

| Turn | Resume flag |
|---|---|
| First turn of a session | _(none)_ |
| Subsequent turns, after the first successful turn | `--resume` |

The resume flag is gated by a per-session `resumeRequested` state that `OnFinalize` sets to true after the first turn completes with a credits trailer. From that point, `buildArgs` appends `--resume` to every turn, which attaches to the most recent conversation in the workspace directory.

The adapter passes no conversation identifier, because it has none to pass: the headless transcript carries no session ID and the adapter reads no local session store. The only identity a Kiro session carries is Sortie's own `ResumeSessionID`, which is reported back on the turn result and used for logging but never reaches the CLI. Sortie runs one conversation per workspace, so cwd-scoped continuation resolves to the right conversation without an ID.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches `kiro-cli` on a remote host via SSH instead of locally. The process model stays fork-per-turn: each turn is a separate SSH invocation wrapping one remote subprocess.

### How it works

1. `StartSession` resolves the local `ssh` binary. The agent command is stored for remote execution rather than resolved locally.
2. The credential preflight is skipped. `buildSSHRemoteCmd` prepends `KIRO_API_KEY` to the remote command and shell-quotes the value, because OpenSSH drops the orchestrator's local environment. When `KIRO_API_KEY` is empty, no prefix is added.
3. `RunTurn` builds the per-turn argument list and wraps it with `sshutil.BuildSSHArgs`.
4. The remote command is `cd -- '<workspace>' && <remoteCommand> '<arg>' ...`, with each adapter-generated argument shell-quoted.

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

The workspace path and the adapter-generated arguments are single-quoted with standard POSIX escaping before they are embedded in the remote shell command. The `KIRO_API_KEY` value is quoted with the same mechanism. The configured remote base command is treated as a pre-formed shell fragment; quoting inside `agent.command` is the operator's responsibility.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit` through the generic non-zero branch. Exit code `127` means the remote `kiro-cli` binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

The adapter consumes `KIRO_API_KEY`. Which subscription plans entitle an account to headless API-key access is Kiro's to document; see the [external references](#external-references). Sortie does not manage the credential beyond the preflight; the subprocess inherits the full parent process environment, and `kiro-cli` reads the key directly.

`StartSession` runs a credential preflight in local mode (`checkCredential`):

1. Confirms `KIRO_API_KEY` is set and non-empty. A missing key returns `response_error`.
2. Runs a `kiro-cli whoami` canary with a 5-second timeout. A timeout or non-zero exit returns `response_error`.
3. Inspects the canary output. The key is accepted only when the output contains the success marker `Authenticated with API key` and does not contain `Authentication failed.`. Otherwise the preflight returns `response_error` for an invalid or expired key.

The preflight defends against two distinct failure shapes:

| Failure | Symptom without the preflight |
|---|---|
| No credential | Headless `chat` enters an interactive device-login flow and blocks indefinitely, because `--no-interactive` does not suppress login. |
| Invalid key | Headless `chat` exits 0 with empty stdout and `Authentication failed.` on stderr, a silent failure that exit code alone cannot detect. |

The presence check defends against the hang; the `whoami` canary defends against the silent exit-0 failure. It runs once per session, before any turn; a turn that goes silent afterward is ended by stall detection, and the turn timeout is the bound that remains if stall detection is disabled.

{{< callout type="warning" >}}
**MCP is unavailable on the `KIRO_API_KEY` path.** A server-side profile check fails under API-key authentication and the CLI disables MCP. The adapter passes no MCP flag and ignores the MCP configuration path the worker generates, so a Kiro session reaches no MCP server and none of Sortie's own tools. Its first-turn prompt carries no tool advertisement either. See [MCP](#mcp).
{{< /callout >}}

**Required environment variables:**

| Variable | Required | Description |
|---|---|---|
| `KIRO_API_KEY` | Yes (local mode) | Headless credential. In SSH mode, the orchestrator injects it inline into the remote command. |

---

## MCP

MCP is inert on the `KIRO_API_KEY` path. A server-side profile check fails under API-key authentication, the CLI defaults MCP to disabled, and it writes a `Failed to retrieve MCP settings` warning to stderr on every invocation, which the adapter surfaces as an ordinary non-fatal stderr diagnostic.

With MCP disabled, a workspace `mcp.json` is not loaded and the MCP config path Sortie generates has no effect. The adapter passes no MCP flag and does not depend on MCP injection, so a Kiro session reaches no MCP server whatever the workspace holds.

Because there is no channel, Sortie withholds the first-turn tool advertisement for this kind: a Kiro session is never told about tools it could not call. The absence of an "Available Sortie tools" section from a Kiro prompt is the intended behavior, not a rendering fault. [`sortie validate`](/reference/cli/#validate) states the same thing offline, as an `agent.kind.no_tool_channel` warning; the configuration stays valid and the run proceeds.

Setting `kiro.mcp_config` therefore cannot reach the agent. The worker still reads the file it names and merges its servers into the generated copy, so an unreadable path or a file already declaring a `sortie-tools` server still fails the attempt, and what the merge produces goes nowhere. `sortie validate` reports that combination as a second warning, `agent.mcp_config`, naming the kind.

---

## Concurrency safety

The adapter is safe for concurrent use. One `KiroAdapter` instance serves all sessions. Per-session state is isolated in the opaque `Session.Internal` handle, which owns the launch target, the pass-through config, the resume flag, the per-turn stdout accumulator, and the fork-per-turn session.

`RunTurn` is safe to call concurrently for different sessions. Turns for a single session must be serialized; the orchestrator guarantees this.

---

## Adapter registration

The adapter registers itself under kind `"kiro"` via an `init` function in `internal/agent/kiro`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresCommand` | `true` |
| `ValidateAgentConfig` | the checks described in [Validate-time checks](#validate-time-checks) |
| `MCPInjection` | `unsupported` - the adapter never delivers the generated configuration to the agent process, in any form. See [MCP](#mcp). |

The orchestrator's preflight validation uses `RequiresCommand` to require a non-empty `agent.command` field for `agent.kind: kiro`. Binary lookup happens during `StartSession` via `exec.LookPath`, with `kiro-cli` as the default command.

---

## Key differences from other adapters

| Aspect | Claude Code | Copilot CLI | Codex | OpenCode | Kiro |
|---|---|---|---|---|---|
| Kind | `claude-code` | `copilot-cli` | `codex` | `opencode` | `kiro` |
| Default command | `claude` | `copilot` | `codex app-server` | `opencode` | `kiro-cli` |
| Subprocess model | New process per turn | New process per turn | Persistent process across turns | New process per turn, plus an `export` subprocess | New process per turn |
| Protocol | CLI flags + JSONL stdout | CLI flags + JSONL stdout | JSON-RPC 2.0 over stdin/stdout | CLI flags + newline-delimited stdout envelopes | CLI flags + plain-text stdout transcript |
| Headless output | Structured (`stream-json`) | Structured (`json`) | Structured (JSON-RPC notifications) | Structured (`--format json`) | Plain transcript, no structured stream |
| Output format flag | `--output-format stream-json` | `--output-format json` | JSON-RPC notifications | `--format json` | None |
| Session ID source | UUID generated by adapter | Discovered from `result` event | Thread ID from `thread/start` | Discovered from the first JSON envelope | None; carries `ResumeSessionID` only |
| Resume mechanism | `--resume <UUID>` | `--resume <sessionId>` or `--continue` | `thread/resume` or automatic within session | `--session <sessionID>` | `--resume` (cwd-scoped), after first success |
| Token accounting | Result event `modelUsage`, with top-level `usage` fallback | Session-state journal on disk, with stream output tokens as the in-turn estimate | `thread/tokenUsage/updated` notification | Separate `export` subprocess | None (credits only, not tokens); every run unmeasured |
| Model reporting | From `assistant` events | Not available | Not available | Recovered from export `providerID/modelID` | Not available |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + tool scoping | `approvalPolicy` and sandbox policy | `--dangerously-skip-permissions` plus `OPENCODE_PERMISSION` | `--trust-all-tools` or `--trust-tools=<csv>` |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None | None exposed by the adapter | None exposed by the adapter |
| Exit-code reliability | Structured result event plus exit | Structured `result.exitCode` plus exit | JSON-RPC turn status | Terminal stdout `error` can still exit `0` | Exit `0` is ambiguous; success requires the credits trailer on stderr |
| Credential preflight | None | Env vars + `gh auth status` | `account/read` over JSON-RPC | None | `kiro-cli whoami` canary at session start |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as command-line overrides, local launch only | Generated servers re-expressed as an inline configuration document, local launch only | None; the profile gate disables MCP under `KIRO_API_KEY`, and the first-turn advertisement is withheld |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth | `KIRO_API_KEY` |

---

## External references

- [Kiro CLI documentation](https://kiro.dev/docs/cli/) - official command reference
- [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/) - the `--no-interactive` path this adapter launches
- [Migrating from Amazon Q](https://kiro.dev/docs/cli/migrating-from-q/) - the `q` to `kiro-cli` rename and the configuration move to `~/.kiro`
- [Kiro CLI exit codes](https://kiro.dev/docs/cli/reference/exit-codes/) - the documented exit-code surface
- [Kiro CLI built-in tools](https://kiro.dev/docs/cli/reference/built-in-tools/) - the tool catalog scoped by `--trust-tools`
- [`aws/amazon-q-developer-cli` on GitHub](https://github.com/aws/amazon-q-developer-cli) - the CLI source of record for the rebranded binary

---

## Related pages

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full `agent` schema and `kiro` extension block
- [Environment variables reference](/reference/environment/) - `KIRO_API_KEY` and runtime environment behavior
- [Error reference](/reference/errors/#agent-errors) - all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/) - time-based budgeting and concurrency limits, which matter most for Kiro
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution setup and host pool configuration
- [How to write a prompt template](/guides/write-prompt-template/) - template variables, conditionals, and built-in functions
- [State machine reference](/reference/state-machine/) - orchestration states, turn lifecycle, and stall detection
