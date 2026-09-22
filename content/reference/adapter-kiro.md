---
title: "Kiro CLI Adapter"
description: "Complete reference for the native kiro adapter: configuration, session lifecycle, plain-transcript headless output, credential verification, time-based budgeting, error handling, within-session cwd-scoped resume, SSH remote execution, and how this route compares to Kiro CLI on the Agent Client Protocol."
author: Sortie AI
date: 2026-05-29
weight: 140
url: /reference/adapter-kiro/
---
The Kiro CLI adapter connects Sortie to the [Kiro CLI](https://kiro.dev/docs/cli/), the rebranded Amazon Q Developer CLI, via subprocess management. It launches `kiro-cli chat --no-interactive`, reads a plain human transcript from stdout, and classifies the turn outcome from the process exit status and stderr. Headless Kiro emits no structured event stream, so the adapter parses no JSON. Registered under kind `"kiro"`.

Each turn spawns a fresh subprocess (fork-per-turn); session start itself starts no long-lived process. Events arrive through the turn as it runs. Whether the credential actually works is settled separately, once per worker attempt, by the [credential-verification step](/reference/workflow-config/#credential-verification) every agent kind runs before its first working turn; see [authentication](#authentication).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full `agent` schema, [environment variables](/reference/environment/) for `KIRO_API_KEY`, [error reference](/reference/errors/#agent-errors) for all agent error kinds, [how to write a prompt template](/guides/write-prompt-template/) for template authoring.

---

## Two routes to this runtime

Kiro CLI is reachable from Sortie two ways, and they are not equivalent. This page covers the kind above, `kiro`, which drives `kiro-cli chat` and parses its plain-text transcript. The generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind reaches the same binary through its `acp` subcommand instead; see [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/) for that route in full, including the credential caveat that decides whether it is worth taking.

| | This kind (`kiro`) | The protocol route (`agent-client-protocol`) |
|---|---|---|
| Sortie's own tools | Never; MCP is inert on this route regardless of credential. See [MCP](#mcp). | Delivered and callable under a stored device login; silently dropped under `KIRO_API_KEY` |
| Session continuation across a separate agent launch | Never; see [session resume](#session-resume) below | Delivered, confirmed by observed replay from a second process |
| Token accounting | Credits only; every run unmeasured | Credits only; every run unmeasured |

Both kinds stay supported, and neither retires the other. Choosing between them is a per-deployment decision, not a migration: this kind fits a deployment authenticating with `KIRO_API_KEY` that does not need Sortie's own tools reaching the agent; the protocol route, under a stored device login, is the one that delivers them.

---

## Configuration

The adapter reads from two configuration sections in [WORKFLOW.md front matter](/reference/workflow-config/): the generic `agent` block (shared by all adapters) and the `kiro` extension block (pass-through to the Kiro CLI).

### `agent` section

These fields control the orchestrator's scheduling behavior. They are not passed to the Kiro CLI.

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | - | Must be `"kiro"` to select this adapter. |
| `command` | string | `kiro-cli` | Path or name of the Kiro CLI binary. Resolved from `PATH` at session start. |
| `max_turns` | integer | `20` | Maximum Sortie turns per worker session. The orchestrator runs a turn up to this many times, re-checking tracker state after each turn. |
| `max_sessions` | integer | `0` (unlimited) | Maximum completed worker sessions per issue before the orchestrator stops retrying. `0` disables the budget. |
| `max_concurrent_agents` | integer | `10` | Global concurrency limit across all issues. |
| `max_concurrent_agents_by_state` | map | `{}` | Per-state concurrency limits. Keys are state names, lowercased for matching. See [`agent.max_concurrent_agents_by_state`](/reference/workflow-config/#agent) for how an invalid entry is handled. |
| `turn_timeout_ms` | integer | `3600000` (1 hour) | Total timeout for a single turn. The orchestrator cancels the turn when exceeded. See `stall_timeout_ms` below for the bound on a turn that stops producing output. |
| `read_timeout_ms` | integer | `5000` (5 seconds) | Timeout for startup and synchronous operations. |
| `stall_timeout_ms` | integer | `300000` (5 minutes) | Maximum time between consecutive events before the orchestrator treats the turn as stalled. `0` or negative disables stall detection. |
| `stop_grace_ms` | integer | `5000` (5 seconds) | How long the adapter waits for the subprocess to exit on its own after a graceful termination signal, before it force-terminates the process group. Must be positive. |
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

When `agent.kind` is `kiro`, the [`sortie validate`](/reference/cli/#validate) pipeline runs Kiro-specific config checks in addition to the generic preflight validation. They build no adapter and launch no subprocess, and the same checks run at startup and on every workflow reload, so the verdict is identical in all three places.

### Errors

| Check | Condition | Message |
|---|---|---|
| `kiro.trust_tools.conflict` | `trust_all_tools` is true and `trust_tools` is also non-empty | `trust_all_tools and trust_tools are mutually exclusive` |
| `kiro.trust_tools.untrusted` | The resolved trust posture is anything short of full trust | `trust_all_tools does not resolve to true, and kiro-cli's behavior on an untrusted tool under --no-interactive is unestablished; the conservative assumption is that it waits for an approval this unattended run cannot give, so trust_all_tools: true (or leaving trust_all_tools and trust_tools both unset) is required` |

Building the adapter reports the mutual-exclusion fault with the same message, so the two paths can never disagree.

---

## Session lifecycle

### Session start

Validates the workspace path, resolves the `kiro-cli` binary, and initializes per-session state. No subprocess is spawned for an ordinary working session; a [credential-verification session](#authentication) additionally runs a `whoami` guard and lists the workspace's existing conversations here.

1. Resolves the launch target. This validates that the workspace path is a non-empty absolute path pointing to an existing directory, and resolves `command` from `PATH`, defaulting to `kiro-cli`. In SSH mode, it resolves the local `ssh` binary instead and stores the remote command for later use.
2. The session carries no agent process ID at the start, taking the session ID saved from a previous run as its own when continuation is requested.

**Errors:**

| Condition | Error kind |
|---|---|
| Empty or non-existent workspace path | `invalid_workspace_cwd` |
| Workspace path is not a directory | `invalid_workspace_cwd` |
| Agent command is empty or whitespace-only | `agent_not_found` |
| Local `kiro-cli` binary not found in `PATH` | `agent_not_found` |
| SSH binary not found (SSH mode) | `agent_not_found` |

Session start for a working session runs no credential check of its own: its credential-verification session already proved the credential moments before. See [authentication](#authentication) for that guard's own errors.

### Turn

Each turn starts with an empty stdout buffer, so one turn's transcript never carries into the next. It builds the argument list, launches one `kiro-cli` subprocess, reads its stdout, waits for it to exit, and then collects the stderr the adapter's outcome classifier reads. That collection runs after the process is reaped and killed, and is bounded at a fixed five seconds. See [headless output](#headless-output) and [error handling](#error-handling).

### Session stop

Terminates a running subprocess. Safe to call when no subprocess is active, including after a failed turn.

---

## Process shutdown

Before start, the subprocess is isolated in its own process group. A graceful process-group signal is armed for cancellation, bounded by `stop_grace_ms`.

On Unix, graceful shutdown is `SIGTERM` and force kill is `SIGKILL` to the process group. On Windows, graceful shutdown is `CTRL_BREAK_EVENT` to the process group, and the subprocess is assigned to a Job Object with `KILL_ON_JOB_CLOSE` so force termination kills the full descendant tree. The subprocess starts suspended and is resumed only after that assignment succeeds, so nothing it spawns can run before the job takes effect. The `kiro-cli whoami` credential canary below is launched the same way. A failed assignment logs WARN `process group assignment failed` and the launch runs without a job; a failed resume logs WARN `process resume failed`, reporting `response_error` for the canary and `port_exit` for a turn.

Shutdown is turn-scoped, because fork-per-turn means there is no process between turns. Session stop performs an explicit graceful-to-force sequence: it sends `SIGTERM` to the process group, waits up to `stop_grace_ms` for the turn to complete cleanup, then sends `SIGKILL` to the process group if the grace window elapses. If the orchestrator's own deadline expires first, the adapter force-kills the process group and reports that deadline's error instead of a clean stop. After the subprocess exits, the session performs a best-effort group kill to clean up any surviving children.

---

## Headless output

This is the defining section. Headless Kiro emits no structured stream. There is no JSON, no JSONL, and no machine-readable result envelope. The turn outcome is determined from process exit status and stderr, not from parsed stdout.

stdout is a human transcript. For a turn that invokes no tools, it carries the assistant answer with a colorized `> ` marker and ANSI styling. A turn that invokes tools also prints tool-progress lines. The adapter launches with `--wrap never` to disable width-based line wrapping, strips ANSI color and style escapes from each line, and accumulates the cleaned text into a per-turn buffer.

Each non-empty cleaned line is surfaced as a `notification` event, with the message truncated to 500 runes. The accumulated buffer is not truncated; the adapter's outcome classifier reads its length to tell a turn that produced nothing from a turn that produced output. The notifications exist for observability; the adapter does not derive turn outcome from them.

stderr carries one signal the working-session adapter classifies, and one it does not:

| stderr content | Meaning |
|---|---|
| `▸ Credits:` trailer | The one positive proof a turn executed, and only when the collection it came from finished. The numeric credit and time values vary; the prefix is the stable contract. |
| `Authentication failed.` | The credential is present but invalid. Neither the working-session adapter nor the credential-verification guard (see [authentication](#authentication)) reads this marker: the guard decides from `whoami`'s own exit status, and a working turn under a rejected credential is left to the shared zero-work outcome. It is documented here because it is what you see in raw stderr while diagnosing one. |
| Warnings (for example, `Failed to retrieve MCP settings`) | Non-fatal diagnostics. Re-emitted at WARN level on failure paths. |

There are no per-event timestamps in the transcript. The adapter cannot reconstruct tool-call durations, so it emits no tool-result events. That is the practical difference from an adapter with a structured stream: there is nothing to correlate, so tool activity does not reach Sortie's events at all.

---

## Token accounting

A session on this kind reports no token usage: no figure arrives at any point in a turn, on a local launch or over SSH alike, and there is none to attribute to a model. Time is what bounds such a session instead. Set `agent.turn_timeout_ms` to cap wall-clock time per turn; it stands in for the token accumulation, model tracking, and API timing logic of the structured-output adapters. For this kind's declaration beside every other kind's, see the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind).

The headless path reports no token counts. The closing cost line on stderr (`▸ Credits: 0.01 • Time: 1s`) carries an abstract credits figure and elapsed time, never input or output token counts. The credits figure does not map onto Sortie's normalized usage counters, which are token counts only.

The adapter emits no `token_usage` event and reports zero token counts on every path. It also reports every run as unmeasured, so those zeros are recorded as an absence of measurement rather than as a measurement of zero: the run contributes nothing to the per-issue token ceiling, advances no `sortie_tokens_total` series, is excluded from `sortie stats` token and cost figures, and is counted in that command's `tokens_unmeasured_runs`. The dashboard states this directly for a running Kiro session: its Usage reporting field reads `this session reports no token usage`, and the Model, API Requests, Tokens, and Est. Cost fields below it show an em dash rather than a zero. Token-based budget enforcement is inert for this adapter, and [`sortie validate`](/reference/cli/#validate) says so offline when a workflow sets `agent.max_tokens` or prices this kind in `token_rates`, as an `agent.kind.no_usage_reporting` or `agent.kind.no_cost_estimate` warning.

No model name is reported either, and not as an incidental side effect of the missing token counts: model reporting rides on the `token_usage` event, and this adapter never emits one, so there is no carrier through which the runtime's effective model could reach Sortie. `kiro.model` (see [Configuration](#configuration)) selects which model the CLI uses for the turn, but the headless runtime never echoes it back, so it is not knowable from anything Sortie surfaces.

---

## Error handling

### Outcome classification

The turn outcome is determined from the process exit status, the credits trailer, and the stdout transcript. The adapter's own classifier reports an outcome for exactly one case, an exit-0 turn that printed the credits trailer; everything else, including an exit-0 turn a rejected credential left with empty stdout, is decided by the shared decision table from the exit status and the stdout evidence, so the messages on those rows are the shared ones rather than anything Kiro-specific. A working session runs no credential guard of its own (see [authentication](#authentication)), so a credential rejected outright surfaces through this same shared zero-work row rather than through anything naming the credential.

| Kiro evidence | Exit reason | Error kind | Message | Decided by |
|---|---|---|---|---|
| Exit 0 with a `▸ Credits:` trailer on a stderr collection that finished | `turn_completed` | _(none)_ | _(empty)_ | The adapter's classifier. Also sets the resume flag for subsequent turns. |
| Exit 0, no credits trailer, at least one non-blank stdout line | `turn_completed` | _(none)_ | _(empty)_ | Shared work-present row. Does not set the resume flag. |
| Exit 0, no credits trailer, no non-blank stdout line (this is also the shape a rejected credential takes on a working turn) | `turn_failed` | `turn_failed` | `agent exited without producing output: no message from the agent` | Shared zero-work row. |
| Any other non-zero exit | `turn_failed` | `port_exit` | `non-zero exit` on the event, `exit code N` on the error | Shared non-zero-exit row. |
| Exit 127 | `turn_failed` | `agent_not_found` | `agent binary not found` | Shared skeleton, before the classifier runs. |
| Process terminated by a signal | `turn_cancelled` | `turn_cancelled` | `killed by signal` | Shared skeleton, before the classifier runs. The skeleton tests whether the process was signalled, not for a particular exit code. |
| Turn cancelled | `turn_cancelled` | `turn_cancelled` | `context cancelled` | Shared skeleton, before the classifier runs. |
| Stdout read failure | `turn_failed` | `port_exit` | `stdout read error: <detail>` | Shared skeleton. Becomes `turn_cancelled` if the turn is already cancelled. |

The work evidence this adapter declares is the stdout transcript alone: a line that is not blank once ANSI escapes are stripped is a message from the agent. It declares no tool signal, because the transcript reports no tool activity, so the zero-work message names only the one signal looked for. The credits trailer stays the runtime's own success report and outranks that evidence, which is why a turn printing the trailer reports the same outcome whatever its stdout held.

That ranking holds only for a trailer read from a stderr collection that finished. The trailer is the last thing headless Kiro writes, so one read from a collection cut short by the five-second bound described under [Turn](#turn) may belong to a transcript whose rest never arrived, and the adapter stops treating it as the success report. The turn falls to the rows below: a non-blank stdout line still completes it, and a turn with nothing on stdout fails. The stderr Sortie re-emits from a cut-short collection ends with a marker of its own, saying later output may be missing.

### Why exit 0 is not success

A successful turn and an invalid-credential turn both exit 0 on the headless path. Exit code alone cannot distinguish them; that is one reason the [credential-verification step](/reference/workflow-config/#credential-verification) exists, to catch a rejected credential before any working turn runs at all. On a working turn itself, two signals distinguish the two outcomes: the `▸ Credits:` trailer on stderr, which a turn prints only after it actually executed, and a non-blank line on stdout, which a rejected credential never produces. The adapter never maps a bare exit 0 to `turn_completed`. It requires one of those two and classifies an exit-0 turn carrying neither as a failure.

---

## Session resume

This mechanism continues turns only within one running worker session; it does not resume a session across a separate agent launch, whatever triggers that launch (a stall, a retry, or a restart). A freshly launched session always starts its first turn without `--resume`, even when Sortie is asking it to continue an earlier one: the earlier session's identifier is kept only for Sortie's own logging and for what gets reported back on the turn result, and it never reaches the CLI or changes that first turn's own arguments. A workspace directory that already holds an earlier conversation on disk is not consulted either: `kiro-cli chat` always starts a new conversation on this path, whatever history that directory holds. Cross-launch continuation is what the protocol route delivers instead; see [two routes to this runtime](#two-routes-to-this-runtime).

| Turn | Resume flag |
|---|---|
| First turn of a freshly launched session | _(none)_, even when Sortie is continuing an earlier session |
| Every later turn of that same session, once a turn has printed the credits trailer | `--resume` |

Once a turn of a session prints the credits trailer described under [why exit 0 is not success](#why-exit-0-is-not-success), every later turn of that same session carries `--resume`. The trailer is the only signal that flips the flag: a turn reported `turn_completed` on its stdout transcript alone leaves it off. The flag asks the CLI for its own most recently opened conversation in the workspace directory, which is the conversation that turn started. The runtime is what actually remembers this conversation; Sortie holds no handle on it and cannot ask for a specifically named one across a fresh launch.

The adapter passes no conversation identifier, because it has none to pass: the headless transcript carries no session ID and the adapter reads no local session store.

---

## SSH remote execution

When the worker configuration includes `ssh_hosts`, the adapter launches `kiro-cli` on a remote host via SSH instead of locally. The process model stays fork-per-turn: each turn is a separate SSH invocation wrapping one remote subprocess.

### How it works

1. Session start resolves the local `ssh` binary. The agent command is stored for remote execution rather than resolved locally.
2. This kind declares `KIRO_API_KEY` as its credential variable, so the launch carries that name from Sortie's own environment into the remote agent's environment, delivered on the SSH session's standard input rather than in any argument. A value that is unset, empty, or only whitespace is not carried, leaving whatever the host holds in place. See [environment variables carried to a remote agent](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent). The [credential-verification guard](#authentication) runs against the remote host the same way it runs locally; it is not skipped in SSH mode.
3. Each turn builds the per-turn argument list, then builds the SSH connection arguments to wrap it.
4. The remote shell enters the workspace, exports the variables the launch carries, and only then runs the configured command with that turn's arguments, each step chained on the success of the one before it. The workspace path and each adapter-generated argument are shell-quoted.

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

The workspace path and the adapter-generated arguments are single-quoted with standard POSIX escaping before they are embedded in the remote shell command. The configured remote base command is treated as a pre-formed shell fragment; quoting inside `agent.command` is the operator's responsibility. The `KIRO_API_KEY` value is not part of that string.

### Exit codes

SSH exit code `255` indicates a connection failure (refused, timeout, unreachable) and maps to `port_exit` through the generic non-zero branch. Exit code `127` means the remote `kiro-cli` binary is not in `PATH` and maps to `agent_not_found`.

---

## Authentication

The adapter consumes `KIRO_API_KEY`, unless a `kiro-cli` login is already stored on the machine that runs the session. Which subscription plans entitle an account to headless API-key access, and which commands establish a stored login, are Kiro's to document; see the [external references](#external-references). Sortie does not manage the credential itself: the subprocess inherits the full parent process environment, and `kiro-cli` reads whichever credential it finds directly.

Before any working turn runs, once per worker attempt, the [credential-verification step](/reference/workflow-config/#credential-verification) opens a session of its own and runs a guard at session start:

1. Runs a `kiro-cli whoami` canary, bounded at 60 seconds, generous enough to cover a stored login refreshing its token over the network.
2. Decides on the exit status alone: exit `0` proceeds, anything else (a non-zero exit, a timeout, or a failure to start the canary at all) fails the run with `credential_unverified`.

The guard reads no output text: whether `KIRO_API_KEY` is set, or a stored login answers instead, `whoami` is what actually proves the credential, not a marker string in its stdout. This is what defends against the two failure shapes headless `chat` has:

| Failure | Symptom without the guard |
|---|---|
| No credential at all | Headless `chat` enters an interactive device-login flow and blocks indefinitely, because `--no-interactive` does not suppress login. |
| Invalid key | Headless `chat` exits 0 with empty stdout and `Authentication failed.` on stderr, a silent failure that exit code alone cannot detect. |

A working session runs no guard of its own: its own verification session already proved the credential moments before, and a working turn's outcome is decided purely from the shared evidence described under [outcome classification](#outcome-classification). The verification session's own conversation is not left behind: session start lists the workspace's existing conversations before the guard runs, and session stop lists them again afterward, deleting whichever single new `classic` conversation the comparison finds with `kiro-cli chat --delete-session <id> --session-source v1`. A failed delete, or a comparison that cannot identify exactly one new conversation, is only logged; it never fails the run and never deletes the wrong conversation.

{{< callout type="warning" >}}
**MCP is unavailable on the `KIRO_API_KEY` path.** A server-side profile check fails under API-key authentication and the CLI disables MCP. The adapter passes no MCP flag and ignores the MCP configuration path the worker generates, so a Kiro session reaches no MCP server and none of Sortie's own tools. Its first-turn prompt carries no tool advertisement either. See [MCP](#mcp).
{{< /callout >}}

**Required environment variables:**

| Variable | Required | Description |
|---|---|---|
| `KIRO_API_KEY` | Required, unless a `kiro-cli` login is already stored where the agent runs | Headless credential. Either this key or a stored login satisfies the credential-verification guard above. A remote session receives the variable in the agent's own environment, carried from Sortie's environment because this kind declares it, and it overrides any value the host already holds. |

---

## MCP

MCP is inert on the `KIRO_API_KEY` path. A server-side profile check fails under API-key authentication, the CLI defaults MCP to disabled, and it writes a `Failed to retrieve MCP settings` warning to stderr on every invocation, which the adapter surfaces as an ordinary non-fatal stderr diagnostic.

With MCP disabled, a workspace `mcp.json` is not loaded and the MCP config path Sortie generates has no effect. The adapter passes no MCP flag and does not depend on MCP injection, so a Kiro session reaches no MCP server whatever the workspace holds.

Because there is no channel, Sortie withholds the first-turn tool advertisement for this kind: a Kiro session is never told about tools it could not call. The absence of an "Available Sortie tools" section from a Kiro prompt is the intended behavior, not a rendering fault. [`sortie validate`](/reference/cli/#validate) states the same thing offline, as an `agent.kind.no_tool_channel` warning; the configuration stays valid and the run proceeds.

Setting `kiro.mcp_config` therefore cannot reach the agent. The worker still reads the file it names and merges its servers into the generated copy, so an unreadable path or a file already declaring a `sortie-tools` server still fails the attempt, and what the merge produces goes nowhere. `sortie validate` reports that combination as a second warning, `agent.mcp_config`, naming the kind.

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
| Session ID source | UUID generated by adapter | UUID generated by adapter | Thread ID from `thread/start` | Discovered from the first JSON envelope | None; carries the session ID saved from a previous run only |
| Resume mechanism | `--resume <UUID>` | `--session-id <uuid>` on the first turn, `--resume <uuid>` after; never `--continue` | `thread/resume` or automatic within session | `--session <sessionID>` | `--resume` (cwd-scoped), after first success |
| Token accounting | Result event `modelUsage`, with top-level `usage` fallback | Session-state journal on disk, with stream output tokens as the in-turn estimate | `thread/tokenUsage/updated` notification | Separate `export` subprocess | None (credits only, not tokens); every run unmeasured |
| Model reporting | From `assistant` events | From `assistant.message`/`model.message` records | From the thread-open response, updated on reroute | Recovered from export `providerID/modelID` | Not available |
| Permission control | `--permission-mode` or `--dangerously-skip-permissions` | `--autopilot` + `--no-ask-user` + tool scoping | `approvalPolicy` and sandbox policy | `--dangerously-skip-permissions` plus `OPENCODE_PERMISSION` | `--trust-all-tools` or `--trust-tools=<csv>` |
| Inner turn limit | `claude-code.max_turns` | `copilot-cli.max_autopilot_continues` | None | None exposed by the adapter | None exposed by the adapter |
| Exit-code reliability | Structured result event plus exit | Structured `result.exitCode` plus exit | JSON-RPC turn status | Terminal stdout `error` can still exit `0` | Exit `0` is ambiguous; success requires the credits trailer on stderr or a non-blank stdout line |
| Adapter-specific credential check, beyond the [shared verification step](/reference/workflow-config/#credential-verification) every kind runs | None | None | `account/read` and, when needed, a login over JSON-RPC; this is the runtime's actual sign-in, not only a check | None | `kiro-cli whoami` guard, run only on the verification session |
| Sortie's tools | Generated config path on `--mcp-config` | Generated config path on `--additional-mcp-config` | Generated servers re-expressed as command-line overrides, local launch only | Generated servers re-expressed as an inline configuration document, local launch only | None; the profile gate disables MCP under `KIRO_API_KEY`, and the first-turn advertisement is withheld |
| Authentication | `ANTHROPIC_API_KEY` (+ Bedrock, Vertex) | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth` | `CODEX_API_KEY` or cached Codex auth | OpenCode-managed provider auth | `KIRO_API_KEY` |

---

## External references

- [Kiro CLI documentation](https://kiro.dev/docs/cli/): official command reference
- [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/): the `--no-interactive` path this adapter launches
- [Migrating from Amazon Q](https://kiro.dev/docs/cli/migrating-from-q/): the `q` to `kiro-cli` rename and the configuration move to `~/.kiro`
- [Kiro CLI exit codes](https://kiro.dev/docs/cli/reference/exit-codes/): the documented exit-code surface
- [Kiro CLI built-in tools](https://kiro.dev/docs/cli/reference/built-in-tools/): the tool catalog scoped by `--trust-tools`
- [`aws/amazon-q-developer-cli` on GitHub](https://github.com/aws/amazon-q-developer-cli): the CLI source of record for the rebranded binary

---

## Related pages

- [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/): the other route to this runtime, and what it delivers that this one does not
- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the generic kind that route runs on
- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema and `kiro` extension block
- [Environment variables reference](/reference/environment/): `KIRO_API_KEY` and runtime environment behavior
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
- [How to control agent costs](/guides/control-costs/): time-based budgeting and concurrency limits, which matter most for Kiro
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/): remote execution setup and host pool configuration
- [How to write a prompt template](/guides/write-prompt-template/): template variables, conditionals, and built-in functions
- [State machine reference](/reference/state-machine/): orchestration states, turn lifecycle, and stall detection
