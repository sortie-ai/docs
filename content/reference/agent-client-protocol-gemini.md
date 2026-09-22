---
title: "Gemini CLI on the Agent Client Protocol"
description: "Reference for running Gemini CLI on Sortie's generic agent-client-protocol kind: installation, credentials, the launch switches for workspace trust and approval, the optional configuration home, and the runtime's own limitations on token accounting, session close, and model pinning."
author: Sortie AI
date: 2026-09-09
weight: 146
url: /reference/agent-client-protocol-gemini/
---
[Gemini CLI](https://github.com/google-gemini/gemini-cli) has no dedicated Sortie adapter package, no registered kind, and no Gemini-specific code path anywhere in Sortie. It reaches Sortie through the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind: `agent.command` names the `gemini` binary together with `--acp`, the flag that puts it into protocol mode. Everything on this page is a property of this one runtime meeting the generic adapter, not a Gemini-specific branch in Sortie's code.

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

A narrower posture exists. The runtime's own policy engine reads rules from `--policy <path>`, which names a `.toml` file or a directory of them, and from `~/.gemini/policies/*.toml`, or the same path under `GEMINI_CLI_HOME` when that is set. A rule carrying `decision = "allow"` auto-approves the tools it names without opening the rest of the surface, and the runtime's own help marks `--allowed-tools` deprecated in favor of this engine. The engine spells a tool reached through a declared server as `mcp_<server>_<tool>`, which makes Sortie's own tools `mcp_sortie-tools_<tool>`, and one rule can cover a whole server through `mcpName` instead. The cost is enumeration and upkeep: the runtime's own defaults route its write and shell tools to an approval request, so a policy has to name every tool the task needs, and one it does not reach is declined rather than run. Rules placed in a workspace's own `.gemini/policies` directory are documented by the runtime as having no effect, so a policy committed to the checked-out tree is not read.

Every runtime claim on this page that rests on a measurement was taken under `--approval-mode default`, not under the auto-approving posture the sample sets. A measured run under that posture did deliver a declared tool server and call its tool.

Run this agent inside a hardened sandbox regardless: neither switch replaces container-level isolation, and the combination of a trusted workspace and an auto-approving posture is what a sandbox boundary exists to contain.

The runtime's own workspace-trust guard raises an error only in its own headless command-line mode; it treats protocol mode as interactive, so the guard that would otherwise reject an untrusted workspace never fires on this route. An untrusted workspace therefore fails closed with no signal at all: the session-creation call still reports success, the declared tool servers are silently dropped, and nothing in the response or in a later notification marks that anything went wrong. `--skip-trust` is what prevents that outcome, not a hardening option layered on top of a workspace that would otherwise be usable.

---

## Limitations

### Token accounting depends on the build, and its in-turn signal understates

This runtime never sends the protocol's standard usage notification. Sortie measures it anyway, from two files the runtime itself writes on the machine that ran it: its OpenTelemetry output, checked first, and its own session transcript (the file under `~/.gemini/tmp/<project>/chats/`, or the same layout under `GEMINI_CLI_HOME`), read only once the first hasn't caught up within several seconds, with whichever of the two then shows the larger total winning. The transcript is written before a prompt result comes back, so it still holds a figure for a turn Sortie cancels before the telemetry batch lands. To get the first file at all, Sortie sets three environment variables on the launch, `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, and `GEMINI_TELEMETRY_OUTFILE` pointing into a private directory it creates for the session and removes when the session ends. It appends those three to the environment it starts from, so they override any value already set there for the session's runtime, and nothing else on the machine sees them. A Sortie process killed rather than stopped can leave that directory behind. This combination is what makes Gemini CLI the one runtime on this kind whose local sessions are measured at all.

[The kind page](/reference/adapter-agent-client-protocol/#token-accounting) carries the general conditions and the notice that tells you which way a session went. Two of those are settled before any turn runs: a session over SSH is never measured, because both files live on the machine that ran the runtime, and the source recognizes Gemini CLI 0.59.0 only, so installing an older or newer build leaves every session on it unmeasured, with nothing else about the run changing. The third plays out per turn, bounded by [`agent.read_timeout_ms`](/reference/adapter-agent-client-protocol/#agent-section): Sortie's own wait for a turn's figure runs up to about six seconds, because the runtime batches its telemetry on a five-second tick no configuration shortens and that six seconds is the tick itself plus a margin for the write to land, not six seconds on top of it. At the default five-second `read_timeout_ms`, a turn whose telemetry hasn't caught up by then ends without a figure of its own, counted among the run's unaccounted turns rather than as a turn that spent nothing, while the source is kept for the next turn: the wait ended before the source itself answered, so nothing about the source's own standing changed. Raising `read_timeout_ms` to about six seconds or more is what lets a turn's own wait run the source to its natural conclusion instead, and only there can a turn that gets nothing back drop the source outright, under the rule the kind page states. Nothing names the individual turn that went either way, and nothing reports it while the session is still running. Once the session ends, its count of such turns joins the issue's: `used_tokens_complete` on the [`cost_budget` tool](/reference/agent-extensions/#cost_budget) then reads `false`, and the token-ceiling log records carry it as `unaccounted_turns`. The dashboard and `sortie stats` carry no per-turn accounting at all. Resuming a saved session does not recount what an earlier run already measured: both files are read starting from the position they held when this session opened, not from the beginning of the runtime's own history.

Separately, the runtime attaches its own token counts to a completed turn's result on a vendor-namespaced field, which Sortie reads as a lower bound on that turn rather than as the spend it records. That field is incomplete in two ways: a turn Sortie cancels carries no such field at all, and even a turn that does carry it reports only input and output counts, never cached or thought tokens. Sortie cancels a turn that exceeds `agent.stall_timeout_ms` or `agent.turn_timeout_ms`, so the first gap is reachable in ordinary operation, not only at the edge of a run.

### Sessions are not closed through the protocol

This runtime advertises no `sessionCapabilities` object at all in its `initialize` handshake. Sortie decides whether to send `session/close` from that capability being present, so against this runtime there is never a capability to select: a session here always ends through process termination, described in the [kind page's process shutdown section](/reference/adapter-agent-client-protocol/#process-shutdown), never through a protocol close call. The short-lived [credential-verification](/reference/workflow-config/#credential-verification) session every worker attempt opens before the working one ends the same way, and it is not exempt from what that costs: its own transcript lands in the same store described under [token accounting](#token-accounting-depends-on-the-build-and-its-in-turn-signal-understates), `~/.gemini/tmp/<project>/chats/` or the same layout under `GEMINI_CLI_HOME`, and nothing calls back to remove it.

### A normal-looking stop reason does not mean the turn ended cleanly

Of the five stop reasons the protocol defines, this runtime's own code produces four: `end_turn`, `max_turn_requests`, `max_tokens`, and `cancelled`; `refusal` is never assigned by any code path in this runtime. Loop detection reports as `max_turn_requests`. `max_tokens` is reachable only through the runtime's own pre-emptive context-overflow predictor, which fires before the model's stream is actually exhausted; the model's own genuine token-limit signal never reaches the protocol layer as `max_tokens`, because the handler that catches an invalid stream folds that signal into `end_turn` alongside the model's safety and recitation blocks. A model declining to answer on safety grounds and a turn that genuinely ran out of context therefore both surface as an ordinary, successful-looking `end_turn`, indistinguishable from a turn that completed as asked.

### Session continuation replays history, with two traps

Continuing a session is implemented and works: `session/load` rebuilds the prior conversation and streams it back as genuine replay notifications. Two things about that replay need care, and Sortie's own adapter already accounts for both, so neither is an operator action.

The response to `session/load` can reach the wire before its own replay notifications finish sending, because the runtime does not wait for the replay to complete before responding, even though the protocol expects a response only after the full replay has gone out. A `session/load` issued in the same UTC minute as the `session/new` that created the session fails and permanently destroys that session's resumability, including every later attempt to load it in a following minute; this is what the [kind page's per-process load spacing](/reference/adapter-agent-client-protocol/#session-resume-mechanism) exists to protect against, and it covers a session this Sortie process itself created.

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
