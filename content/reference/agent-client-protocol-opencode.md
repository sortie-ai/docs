---
title: "OpenCode on the Agent Client Protocol"
description: "Reference for running OpenCode under Sortie in ACP mode: the launch command, how the model, permissions, reasoning level and agent are set, the provider credential locally and over SSH, spend and usage limits, tool delivery, and how this route compares with the hand-written OpenCode kind."
author: Sortie AI
date: 2026-11-04
weight: 149
url: /reference/agent-client-protocol-opencode/
---
[OpenCode](https://opencode.ai/docs/) runs under Sortie in ACP mode: the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind, where `agent.command` is `opencode acp`, the subcommand that puts OpenCode into protocol mode. The hand-written `opencode` kind is deprecated in favor of this route; [how to run OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/) covers the move and holds the setting-by-setting conversion table.

Sample workflow: [`examples/WORKFLOW.agent-client-protocol.opencode.md`](https://github.com/sortie-ai/sortie/blob/main/examples/WORKFLOW.agent-client-protocol.opencode.md).

See also: [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the transport-level mechanism this page assumes, [OpenCode adapter reference](/reference/adapter-opencode/) for the hand-written kind, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds.

Every measurement behind this page ran on Linux against OpenCode 2.2.5, on one pinned Google model, under the host's stored provider login. A claim that no measurement covers is stated as not observed.

---

## Installation and configuration

```yaml
agent:
  kind: agent-client-protocol
  command: opencode acp

agent-client-protocol:
  permissions: approve-all
  env:
    OPENCODE_DISABLE_AUTOUPDATE: "true"
```

The sample installs OpenCode with `npm install -g @opencode/cli`. `acp` is the only subcommand this route uses, and it takes neither a model switch nor a posture switch. The route needs no version check of its own: a command that does not answer the protocol handshake fails before the first turn. A session export or usage-limits output that does not parse drops that one read and leaves the turn unaffected.

OpenCode reads `opencode.json` and `.opencode/agents` from the workspace, so a repository's own files apply to a run. Run the agent inside a hardened sandbox.

### Where each setting goes

| What you set | Where it goes on this route |
|---|---|
| Model | The `model` member of OpenCode's configuration document, which you pass in `agent-client-protocol.env` as `OPENCODE_CONFIG_CONTENT`. Also set [`agent-client-protocol.model`](/reference/workflow-config/#agent-client-protocol) to the same id, which is the model a usage-limit hold stops. |
| Named agent | The `default_agent` member of the same document. |
| Whether a tool call that OpenCode asks about is approved | `agent-client-protocol.permissions: approve-all`. |
| Which tools are allowed or denied | The `permission` member of the same document. |
| Reasoning level | `agent-client-protocol.effort`. |
| Auto-update, session sharing, compaction | `OPENCODE_DISABLE_AUTOUPDATE` in `agent-client-protocol.env`; the `share` and `compaction` members of the document. |

A workflow that pins the model and the agent:

```yaml
agent-client-protocol:
  permissions: approve-all
  model: google/gemini-3.5-flash
  effort: high
  env:
    OPENCODE_DISABLE_AUTOUPDATE: "true"
    OPENCODE_CONFIG_CONTENT: '{"model":"google/gemini-3.5-flash","default_agent":"plan"}'
```

The generic kind page explains what [`env`, `permissions`, `effort` and `config_options`](/reference/workflow-config/#agent-client-protocol) do in general; the rest of this section gives the OpenCode value and what the measurement showed.

**Model.** A model id that OpenCode cannot resolve does not fail: the runtime selects its default model and the turn completes. A mistyped id therefore runs on a model nobody chose, with nothing in the output to mark it. A document with `{"model":"<id>"}` and no prompt made the session report that id as its current model.

**Document and Sortie.** Sortie adds its own switch that turns off OpenCode's session title generation to the document, keeping every member you set. On the credential-verification session it also adds a rule that denies every tool, as the last top-level rule. An `env` program in `agent.command` that assigns `OPENCODE_CONFIG_CONTENT` replaces both. An operator's own title switch wins over Sortie's and marks the session's figures as lower bounds.

**Named agent.** A document `{"default_agent":"plan"}` made the session offer the modes `build` and `plan` and report `plan` as current; a launch with no document reported `build`. OpenCode lists these as its `mode` session option. Setting that option through `config_options` is accepted by `sortie validate`, but no measurement set it, so it is not observed. An agent's own write guard was not exercised either: the plan agent was asked to write a file and replied with text, so whether it blocks the write on this route is not observed.

**Permissions.** OpenCode's default rules allow every tool except a read of a `.env` file, which asks. With `permissions` unset, Sortie refuses each such request and emits a notice that the run is unattended and nobody can approve it. OpenCode then ends the turn at once, without giving the model another step, and Sortie records it as `turn_failed`, a failure it retries with backoff. The measured read of `.env` ended this way, and so did a shell call under a rule that asks about every tool. With `approve-all`, the same read completed. A tool that OpenCode's own rules deny raises no request and stays denied under either value. A document `{"permission":{"*":"deny"}}` kept the shell tool from running, with no permission request raised. The deny direction was measured; the allow direction is OpenCode's own rule grammar and was not measured.

**Reasoning level.** `effort` is set on OpenCode's `effort` option, which it lists under the reasoning-level category when the model has levels. Measured on the pinned model, the option offered `minimal`, `low`, `medium`, `high` and `default`, and one setting request, sent before the first prompt, took `high`. A `#<level>` suffix on the document's model id is not read. A level the model does not offer, or a model with no levels, runs at the current level with a warning in Sortie's log. A `variant` key from the hand-written kind has no effect; `sortie validate` warns about it. `config_options` never reaches the `model` or the reasoning-level option.

### Settings of the hand-written kind without a carrier

Every `opencode` setting has a carrier on this route. Two behaviors do not:

- The hand-written kind fails a turn before any model request when the configured level is one the model lacks. On this route that failure has no carrier; the turn warns and runs, because a level never fails a session here.
- Run history and `sortie stats` key runs by kind, so runs on this route appear under `agent-client-protocol`, a series shared by every protocol runtime. The by-model table is unaffected, because both kinds record the provider and model that OpenCode's session export names.

---

## Credentials

OpenCode reads its own provider credentials: the login stored by `opencode auth login`, or the provider's environment variables, as OpenCode's documentation lists them. Sortie manages no credential for this route. A local run inherits the environment of the Sortie process.

Every graded measurement ran under a stored provider login. A provider key from the environment, a key the provider refuses, and a host with no stored login were not part of that measurement. Before the first working session, the [credential-verification step](/reference/workflow-config/#credential-verification) runs a session whose configuration denies every tool; Sortie deletes that session through the protocol afterwards. The refused-credential and absent-credential cases on this route are not observed.

### Over SSH

A runtime launched on an SSH worker has no credential on its own account. Put the login on the worker host, or name the provider variable under [`worker.ssh_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent). The `agent-client-protocol.env` entries, the configuration document included, travel to the worker on the session's standard input, never on a command line, and beat a same-named variable that `ssh_pass_env` carries. Keep a secret out of the document: OpenCode substitutes `{env:NAME}` inside its configuration, so the document can refer to a variable that `ssh_pass_env` delivers.

---

## Spend and usage

Sortie measures an OpenCode run in tokens and in US dollars per request, locally and on an SSH worker alike.

- **Live figure.** The `usage` member of a prompt result, when OpenCode sends one. No prompt response in the qualification capture carried one.
- **Settling figure.** At every turn end Sortie reads OpenCode's session export, which holds each finished request with its provider, model, tokens and dollar cost. This is the figure the measured runs settled on. Sortie reads the export through the same host-command path on a worker host, so a run on SSH is measured as a local one is. An export above 64 MiB, or one that names another session, is not used.
- **Ceilings.** A live run through the orchestrator stopped at the token ceiling from the export's figure. The qualification grades the wire-level token figure a gap, because the prompt response did not carry it.
- **Lower bounds.** A free model reports a dollar cost of `0` beside non-zero tokens, which Sortie reads as no amount, so the model's cost is a lower bound. A subagent runs in a child session whose export Sortie reads once; a child that fails, goes unnamed, or cannot be read leaves its turn a lower bound.

[How Sortie measures spend](/concepts/spend-measurement/) explains provenance and lower bounds, and [how to control costs](/guides/control-costs/) shows what to configure. The generic page's [token accounting](/reference/adapter-agent-client-protocol/#token-accounting) section covers the mechanism shared with other runtimes.

### Usage windows

After each turn that reached the runtime, Sortie runs OpenCode's own usage-limits command on the host that runs the agent, the worker host for an SSH launch. The command exists only on releases that ship the usage-limits feature. On OpenCode 2.2.5 it does not, the session logs the pull as unsupported, and no window was reported on either route; the turn is unaffected. The labels and the reset reading on a release that has the command are the ones under [usage limits](/reference/adapter-opencode/#usage-limits) on the hand-written kind's page. The mechanism shared across runtimes is under [usage limits](/reference/adapter-agent-client-protocol/#usage-limits).

### A usage-limit refusal

A prompt error whose name is `provider.free-limit`, `provider.quota`, `provider.budget-limit` or `provider.model-budget-limit` ends the turn as `usage_limit` and holds new sessions on the model set in `agent-client-protocol.model`. `provider.rate-limit` is a throttle and is not a refusal.

OpenCode reports these over the protocol as a generic internal error that carries only the error name, so the retry delay is not on the wire. Sortie recovers it from the same session export it reads for spend, and uses it only when the exported error has the same name. Without a delay, `provider.quota` retries on the exponential backoff, and the other three take the latest reset among the exhausted console windows.

The refusal fixtures come from a real OpenCode talking to a local stand-in upstream. No refusal from a real provider was captured, so whether a live refusal carries a delay is not established.

---

## Tool delivery

Sortie's tool server reaches OpenCode as an HTTP entry in the session-creation request, which OpenCode advertises it accepts (HTTP yes, SSE no). On SSH it is the address of the launch's reverse forward. The measured delivery is graded usable. If the forward is refused, the session opens without Sortie's tools and declares a gap.

OpenCode 2.x offers MCP tools to the model through one tool, `execute`, so every tool-server call is reported under that one name rather than under the tool's own name.

Operator servers from `mcp_config` follow the generic rules in the [MCP section](/reference/adapter-agent-client-protocol/#mcp): HTTP servers reach a remote launch and stdio servers do not. Delivery of an operator stdio server to OpenCode on a local launch was not measured.

Whether a delivered tool can be called depends on the permission posture. With a rule that makes OpenCode ask about every tool and no `approve-all`, OpenCode raised a permission request for Sortie's tool, Sortie refused it, and the tool did not run. The model had called the tool from inside OpenCode's `execute` code tool, which handed the refusal back to it as a result, so the model finished the turn normally. A refused call the model makes directly ends the turn as failed instead, as described under Permissions. Without such a rule OpenCode asks about no tool and the call runs. See [tool call tracking](/reference/adapter-agent-client-protocol/#tool-call-tracking).

---

## Session behavior

OpenCode's handshake reports the name `OpenCode`, advertises session loading, and lists `close`, `delete`, `fork`, `list` and `resume` as session capabilities. Where this route behaves as the generic page describes, that page is the reference; these are the behaviors the measurement recorded for OpenCode.

| Behavior | What was observed |
|---|---|
| Continued session | Continued through `session/load` in a fresh process. A recall question asking which phrase the session was told to remember returned that phrase, which shows the history came back. Graded usable. |
| Cancellation | A turn whose own context was cancelled ended as cancelled. |
| Permission request | A request that offered a refusing option was refused inside the protocol. For a tool the model called directly, OpenCode then ended the turn with the `cancelled` stop reason and Sortie recorded it as failed. For a tool called from inside OpenCode's `execute` code tool, the refusal came back to the model as that tool's result, and the turn went on and succeeded. A question OpenCode would put to a person is cancelled by OpenCode itself and the model continues; this is stated from OpenCode's source, because no launch put such a question to the model. |
| Runtime failure | A provider answering HTTP 400, set up through a stand-in upstream, ended the turn with a protocol-level error response. A bad model id cannot induce this, because it falls back to the default model. |
| Lost process | After one kill of the process group, the launch reported a lost connection. |
| Output-token limit | OpenCode continues a reply cut at its output-token limit by itself, so a prompt does not end with `max_tokens` or `max_turn_requests`. Three consecutive truncated replies end the turn with an internal error that names `output-limit`. |
| Refusal | No measurement produced a `refusal` stop reason or a runtime refusal, so both are not observed. |
| Windows | Not observed. |

---

## Compared with the hand-written kind

No measured row puts this route below the hand-written kind, and the qualification rates it eligible and conformant. Turn outcome, retry classification and permission handling are usable here, where the hand-written kind's stream has gaps: a cancellation leaves no outcome there, and the stream has no terminal for a question to a person.

| Capability | Hand-written kind | This route |
|---|---|---|
| Spend and the token and dollar ceilings, local and over SSH | Per-request counts from the stream, settled per served model from the session export | The same export, parser and amounts; equal |
| Usage windows | Pulled by OpenCode's usage-limits command | The same command and reading; equal. Not reported on the release measured, on either route |
| Usage-limit refusal | Same four names, with the delay the stream carries | Same four names, with the delay read from the session export |
| Tool-server delivery | In the launch's configuration document | Over HTTP in the session-creation request; equal |
| Session continuation | `--session`, once the export confirms the session | `session/load`; equal |
| Turn outcome, retry classification, permission handling | Gaps on the stream | Usable |
| Credential on a remote launch | Reaches the worker only through `worker.ssh_pass_env` | The same |
| Offline validation | Refuses wrong-typed `opencode` keys, `effort` with `variant`, and a tool in both lists | Checks the types of its own keys and the `permissions` value; no refusal guards a failure this route can reach |
| Model, agent, level, permissions, sharing, compaction, auto-update | Keys of the `opencode` block | The carriers under [where each setting goes](#where-each-setting-goes); a configuration edit, no capability withdrawn |
| Version check | Refuses a version it cannot read and any major other than 2 | None beyond the handshake; a launch with no version refusal is an accepted difference |
| Level the model lacks | Fails the turn before any model request | Warns and runs at the current level |
| Run history series | Runs keyed `opencode` | Runs keyed `agent-client-protocol`; the by-model table continues |

Credential verification against a refused or absent credential is not observed on this route.

---

## Related pages

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the runtime-neutral transport this page assumes
- [How to run OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/): moving off the hand-written kind, with the conversion table
- [OpenCode adapter reference](/reference/adapter-opencode/): the hand-written kind
- [Copilot CLI on the Agent Client Protocol](/reference/agent-client-protocol-copilot/): a second runtime on the same route
- [WORKFLOW.md configuration reference](/reference/workflow-config/): the full `agent` and `agent-client-protocol` schema
- [How Sortie measures spend](/concepts/spend-measurement/) and [how to control costs](/guides/control-costs/)
