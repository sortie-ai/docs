---
title: "Gemini CLI on the Agent Client Protocol"
description: "Reference for running Gemini CLI on Sortie's generic agent-client-protocol kind: installation, credentials, the launch switches for workspace trust and approval, the optional configuration home, and the runtime's own limitations on token accounting, session close, and model pinning."
author: Sortie AI
date: 2026-09-09
weight: 146
url: /reference/agent-client-protocol-gemini/
---
[Gemini CLI](https://github.com/google-gemini/gemini-cli) has no dedicated Sortie adapter package, no registered kind, and no Gemini-specific handling beyond [token accounting](#token-accounting-reads-local-files-and-its-in-turn-signal-understates), [usage limits](#usage-limits), and the system prompt Sortie hands a local [credential-verification](/reference/workflow-config/#credential-verification) session. It reaches Sortie through the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind: `agent.command` names the `gemini` binary together with `--acp`, the flag that puts it into protocol mode. Apart from those, everything on this page is a property of this one runtime meeting the generic adapter.

Sample workflow: [`examples/WORKFLOW.agent-client-protocol.md`](https://github.com/sortie-ai/sortie/blob/main/examples/WORKFLOW.agent-client-protocol.md).

See also: [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the transport-level mechanism this page assumes, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds.

---

## Installation and configuration

```yaml
agent:
  kind: agent-client-protocol
  command: gemini --acp --skip-trust --approval-mode yolo
```

Installed with `npm install -g @google/gemini-cli`, which requires Node.js 20 or later. An older `--experimental-acp` spelling of the protocol flag also exists and is deprecated in favor of `--acp`.

`GEMINI_CLI_HOME` is an optional configuration home for the runtime. Unset, Gemini reads and writes `~/.gemini`, which is why a login already established there works with no further configuration. Setting `GEMINI_CLI_HOME` replaces the home directory the runtime resolves that path against, so it reads and writes `$GEMINI_CLI_HOME/.gemini` instead, at the cost that a login established under one home is invisible under another; it narrows what a run can touch inside that directory, and it is not a substitute for either launch switch below.

The sample pins no model: this kind has no model configuration key, so an unpinned run resolves whatever the credential defaults to. To pin one, add `--model <id>` to `agent.command`. Read the flag surface off `gemini --help` on the binary you are targeting for the accepted values, and Google's model-listing endpoint for the account's actual model set, since that depends on the credential's own subscription.

---

## Authentication

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Only when no login is already stored | API key for Gemini CLI. Not required when a login is already stored under the configuration home the runtime reads (`~/.gemini`, or `GEMINI_CLI_HOME` when set). |

Sortie manages no credential for this kind; the subprocess inherits the full parent process environment and the runtime reads its own credential from it, exactly as it would run outside Sortie. Confirm the credential works under the same variables Sortie will run under before pointing a workflow at this route, for example as below, with `--skip-trust` because `-p` is the headless mode in which the [workspace-trust guard](#workspace-trust-and-approval-posture) rejects an untrusted workspace:

```sh
gemini --skip-trust -p "reply with ok"
```

---

## Workspace trust and approval posture

`--skip-trust` is required for a working unattended run, not optional hardening. The approval posture is a choice, and `--approval-mode yolo` is the widest one available: each switch widens what the agent may do inside the checked-out tree. A tool call the runtime gates rather than auto-approves does not leave an unattended run waiting, because the adapter answers every permission request itself by declining it; see [permission handling](/reference/adapter-agent-client-protocol/#permission-handling).

| Switch | What it grants | What it costs |
|---|---|---|
| `--skip-trust` | Grants the checked-out workspace the trust Gemini needs before it will load any declared tool server at all. It sets the runtime's own workspace-trust environment variable, which the trust check reads ahead of the folder-trust setting, the editor state, and the trusted-folder list. | The exposure it opens is bounded by who can place a file in the checked-out tree: a workflow that builds only the default branch is exposed far less than one that checks out contributor-supplied refs. |
| `--approval-mode yolo` | Auto-approves every tool the runtime runs inside that now-trusted checkout, its own shell tool included. | It grants the whole tool surface in one step, so anything the model is steered into running inside the checkout runs unreviewed. Dropping it leaves the run working but narrower: each gated call is declined and never invoked. |

A narrower posture exists. The runtime's own policy engine reads rules from `--policy <path>`, which names a `.toml` file or a directory of them, and from `~/.gemini/policies/*.toml`, or the same path under `GEMINI_CLI_HOME` when that is set.

A rule carrying `decision = "allow"` auto-approves the tools it names without opening the rest of the surface, and the runtime's own help marks `--allowed-tools` deprecated in favor of this engine. The engine spells a tool reached through a declared server as `mcp_<server>_<tool>`, which makes Sortie's own tools `mcp_sortie-tools_<tool>`, and one rule can cover a whole server through `mcpName` instead.

The cost is enumeration and upkeep: the runtime's own defaults route its write and shell tools to an approval request, so a policy has to name every tool the task needs, and one it does not reach is declined rather than run. Rules placed in a workspace's own `.gemini/policies` directory are documented by the runtime as having no effect, so a policy committed to the checked-out tree is not read.

Every runtime claim on this page that rests on a measurement was taken under `--approval-mode default`, not under the auto-approving posture the sample sets. A measured run under that posture did deliver a declared tool server and call its tool.

Run this agent inside a hardened sandbox regardless: neither switch replaces container-level isolation, and the combination of a trusted workspace and an auto-approving posture is what a sandbox boundary exists to contain.

The runtime's own workspace-trust guard raises an error only in its own headless command-line mode; it treats protocol mode as interactive, so the guard that would otherwise reject an untrusted workspace never fires on this route. An untrusted workspace therefore fails closed with no signal at all: the session-creation call still reports success, the declared tool servers are silently dropped, and nothing in the response or in a later notification marks that anything went wrong. The one exception is a runtime that advertises HTTP MCP support: Sortie waits `read_timeout_ms` for it to connect to Sortie's tool server and declares the tool-server gap when it never does; see [MCP](/reference/adapter-agent-client-protocol/#mcp).

`--skip-trust` is what prevents that outcome, not a hardening option layered on top of a workspace that would otherwise be usable.

---

## Usage limits

When each turn ends, Sortie asks Google for the remaining quota of the signed-in account and reports it to the dashboard and to `rate_limits` in [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state). Limits are reported only for Gemini CLI signed in with Google. A Gemini CLI on an API key or on Vertex AI reports none, and the pulls stop for the session. The mechanism shared with other runtimes is under [usage limits](/reference/adapter-agent-client-protocol/#usage-limits) on the kind's page.

Sortie reads the sign-in where Gemini CLI itself keeps it, on the machine that runs the agent, in this order:

| Condition in the agent's environment | Sign-in read |
|---|---|
| `GOOGLE_GENAI_USE_GCA` and `GOOGLE_CLOUD_ACCESS_TOKEN` both set | The access token in `GOOGLE_CLOUD_ACCESS_TOKEN`, which is treated as never expiring. |
| `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` is not `true` | The file `.gemini/oauth_creds.json`. |
| `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` is `true` | The operating system keychain, then the encrypted file `.gemini/gemini-credentials.json`, then `.gemini/oauth_creds.json`. The keychain is skipped when `GEMINI_FORCE_FILE_STORAGE` is `true` or a WSL variable (`WSL_DISTRO_NAME`, `WSLENV`, `WSL_INTEROP`) is set. |

The files are under `GEMINI_CLI_HOME`, or under the home directory when that is not set. A stored access token that has expired is skipped and nothing is reported, because only Gemini CLI refreshes it.

Sortie's host sends the access token to `cloudcode-pa.googleapis.com`, or to the endpoint `CODE_ASSIST_ENDPOINT` names in the agent's environment, including when the agent runs on an SSH worker. The project comes from `GOOGLE_CLOUD_PROJECT` in the agent's environment, then from `GOOGLE_CLOUD_PROJECT_ID`, and otherwise from the project Google assigns to the account. Sortie never stores or logs the token.

Each model's quota is one limit, labelled with the model identifier followed by `limit`. The share used is 100 less the percentage that remains, and the reset time is the one Google states. The limits carry no status.

---

## Limitations

### Token accounting reads the prompt result and the chat journal {#token-accounting-reads-local-files-and-its-in-turn-signal-understates}

Sortie measures this runtime from what it reports without any switch: the `usage` member of each `session/prompt` result, and the chat journal the runtime writes on the machine that runs it. Sortie sets no telemetry variable and adds nothing to the launch for this. Both sources are read on a local launch and on an [SSH worker](/reference/adapter-agent-client-protocol/#ssh-remote-execution), where the journal is read on the worker host.

The session is measured this way when the `initialize` handshake reports `gemini-cli` in `agentInfo.name`. When the handshake reports no name, `agent.command` decides, and it names the runtime when the program or any argument is one of:

- The `gemini` executable, bare or as a path, in any letter case, optionally ending in `.cmd`, `.ps1`, `.exe`, or `.js`. A bare `gemini` that is the value of a preceding option flag, as in `--profile gemini`, does not count. A path does.
- The `@google/gemini-cli` package, bare, followed by `@` and a version, or as a path element such as one under `node_modules`.

On an SSH worker the words checked are those of the remote command. A handshake that names a different runtime than `agent.command` does decides the measurement, and the session logs `agent runtime differs from its configured command` at `Warn` with `configured_runtime`, `handshake_runtime`, and `usage_declaration`. The runtime starts once either way.

| Count | Prompt result `usage` | Chat journal record |
|---|---|---|
| Input | `inputTokens`, which already holds cache reads | `input` plus `tool` |
| Output | `outputTokens` plus `thoughtTokens` | `output` plus `thoughts` |
| Cache read | `cachedReadTokens` | `cached` |
| Cache write | `cachedWriteTokens` | Always 0 |
| Model | None | The record's `model` |

The prompt result covers the turn alone. The runtime leaves out a counter that is zero, so an absent `thoughtTokens`, `cachedReadTokens`, or `cachedWriteTokens` reads as 0. An absent `inputTokens` or `outputTokens`, or any member that is null or not an integer, leaves the result without a figure. `totalTokens` is never read, because it leaves thought tokens out. A `_meta.quota` token count above zero on the result marks the turn as one that reached a model and adds nothing to the figure.

The chat journal is a JSON Lines file under `.gemini/tmp/<project>/chats/` in `GEMINI_CLI_HOME`, else in the home directory, as the runtime's host resolves it. Its name holds the session's start minute and the first 8 characters of the session ID, so Sortie finds it by the pattern `session-*-<first 8 characters>.jsonl` and counts a matched file only when its first line names the session's own `sessionId`. A session ID whose first 8 characters are not ASCII letters, digits, or `-` leaves the journal unread. Each `gemini` line that carries `tokens` is one completed model request, keyed by its `id`:

- A repeated `id` counts once.
- `$rewindTo` and `$patch` lines take nothing back, because a rewound or compressed request was still billed.
- A line Sortie cannot decode, such as one a kill tore, is a reading of unknown size, never zero.
- A journal larger than 64 MiB, or a line longer than 10 MiB, is a failed read.

The runtime appends a request's line only when the request completes, so the request still streaming when a turn is cancelled or the runtime is killed has no line.

| How the turn ends | What Sortie records |
|---|---|
| The prompt result carries a figure | The result's figure. The journal splits it by the model that served each request; when the journal cannot be read, the figure is kept with no model. |
| The prompt result carries no figure | The journal's requests that no earlier turn counted. |
| Cancelled, or the runtime killed, after the turn reached a model | The journal's requests that no earlier turn counted, as a lower bound, because the request in flight is missing. |
| The journal cannot be read and the result has no figure | Spend that occurred with the amount unknown, counted among the run's unaccounted turns. |

Sortie cancels a turn that exceeds `agent.stall_timeout_ms` or `agent.turn_timeout_ms`, so a cancelled turn's lower bound is reachable in ordinary operation.

The session's current model, from the `models.currentModelId` member of the `session/new` or `session/load` result, decides whether a turn's figure can be complete. When it is `auto`, begins with `auto-`, or is absent, every turn of the session is a lower bound, because the request that picks the model is in neither source. That covers a run whose `agent.command` pins no model, such as the sample's. A session on a concrete model, such as one `--model <id>` pins, reports complete figures.

These model requests are in neither source and leave a turn that reads complete, so its figure understates the spend without saying so:

- Web search and web fetch.
- The runtime's loop check.
- History compression.
- Invalid streams.
- Subagents.
- Routing through a model definition with `tier: "auto"` under a name that does not begin with `auto`.

Resuming a saved session does not recount what an earlier run measured: Sortie reads the journal when the continued session opens, and the requests already in it count as that session's history.

What a lower bound means for a run's totals, its ceilings, and each surface is under [spend measurement](/concepts/spend-measurement/). The rules the kind applies to every runtime are under [token accounting](/reference/adapter-agent-client-protocol/#token-accounting) on the kind's page.

### Sessions are not closed through the protocol

This runtime advertises no `sessionCapabilities` object at all in its `initialize` handshake. Sortie decides whether to send `session/close` from that capability being present, so against this runtime there is never a capability to select: a session here always ends through process termination, described in the [kind page's process shutdown section](/reference/adapter-agent-client-protocol/#process-shutdown), never through a protocol close call.

The short-lived [credential-verification](/reference/workflow-config/#credential-verification) session a worker attempt opens before the working one, unless Sortie proved the same setup recently, ends the same way, and it is not exempt from what that costs: its own chat journal lands in the store described under [token accounting](#token-accounting-reads-local-files-and-its-in-turn-signal-understates), `~/.gemini/tmp/<project>/chats/` or the same layout under `GEMINI_CLI_HOME`, and nothing calls back to remove it.

### A normal-looking stop reason does not mean the turn ended cleanly

Of the five stop reasons the protocol defines, this runtime's own code produces four: `end_turn`, `max_turn_requests`, `max_tokens`, and `cancelled`; `refusal` is never assigned by any code path in this runtime. Loop detection reports as `max_turn_requests`.

`max_tokens` is reachable only through the runtime's own pre-emptive context-overflow predictor, which fires before the model's stream is actually exhausted; the model's own genuine token-limit signal never reaches the protocol layer as `max_tokens`, because the handler that catches an invalid stream folds that signal into `end_turn` alongside the model's safety and recitation blocks.

A model declining to answer on safety grounds and a turn that genuinely ran out of context therefore both surface as an ordinary, successful-looking `end_turn`, indistinguishable from a turn that completed as asked.

### Session continuation replays history, with two traps

Continuing a session is implemented and works: `session/load` rebuilds the prior conversation and streams it back as genuine replay notifications. Two things about that replay need care, and Sortie's own adapter already accounts for both, so neither is an operator action.

The response to `session/load` can reach the wire before its own replay notifications finish sending, because the runtime does not wait for the replay to complete before responding, even though the protocol expects a response only after the full replay has gone out.

A `session/load` issued in the same UTC minute as the `session/new` that created the session fails and permanently destroys that session's resumability, including every later attempt to load it in a following minute; this is what the [kind page's per-process load spacing](/reference/adapter-agent-client-protocol/#session-resume-mechanism) exists to protect against, and it covers a session this Sortie process itself created.

### The sample pins no model, and qualification does not transfer across one

A qualification measurement is taken against one pinned model and does not transfer to a different one. An unpinned run resolves whatever the credential defaults to, which can change independently of a Sortie upgrade.

### Live qualification on Windows is unobserved

Every measurement behind this page's claims was taken on a non-Windows host. Whether this runtime's behavior on this route differs on Windows is unestablished.

---

## Related pages

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the runtime-neutral transport this page assumes
- [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/): a second runtime on the same route, with a different credential trade-off
- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema
- [Environment variables reference](/reference/environment/): how a runtime's own credential reaches its subprocess
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
- [Run the full cycle with Gemini CLI](/getting-started/github-gemini-end-to-end/): a first run of this route end to end, from a GitHub issue to a pushed branch
