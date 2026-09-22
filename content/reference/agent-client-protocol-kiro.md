---
title: "Kiro CLI on the Agent Client Protocol"
description: "Reference for running Kiro CLI on Sortie's generic agent-client-protocol kind: installation, the credential caveat that decides whether the route delivers Sortie's tools at all, the single trust-and-posture switch, and the runtime's own limitations on token accounting and session close."
author: Sortie AI
date: 2026-09-09
weight: 147
url: /reference/agent-client-protocol-kiro/
---
[Kiro CLI](https://kiro.dev/docs/cli/) reaches Sortie two ways. This page covers the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind, where `agent.command` names the `kiro-cli` binary together with `acp`, the subcommand that puts it into protocol mode. The other route is the native `kiro` kind, described on the [Kiro CLI adapter reference](/reference/adapter-kiro/#two-routes-to-this-runtime); that page also states what each route delivers and does not deliver relative to this one. Both kinds stay supported, and picking one over the other is a per-deployment decision, not a migration.

Sample workflow: [`examples/WORKFLOW.agent-client-protocol.kiro.md`](https://github.com/sortie-ai/sortie/blob/main/examples/WORKFLOW.agent-client-protocol.kiro.md).

See also: [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the transport-level mechanism this page assumes, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds.

---

## Installation and configuration

```yaml
agent:
  kind: agent-client-protocol
  command: kiro-cli acp -a
```

The `acp` subcommand does not appear in `kiro-cli --help`. It is listed under `kiro-cli --help-all` only, which is worth knowing before concluding a build does not carry it.

This kind has no model configuration key. The sample pins no model, so an unpinned run resolves whatever the credential defaults to, and a qualification measurement taken against one pinned model does not transfer to another. Unlike the runtime's native `chat` entry point under `--output-format stream-json`, where the same flag can fail silently and warn on standard error while the turn still runs on the default, `--model <id>` on the `acp` entry point does take effect, setting the model for the session the run starts. To pin one, add `--model <id>` to `agent.command`, and read the account's own model set off `kiro-cli chat --list-models -f json`, which the runtime serves from the account's own backend rather than from the binary.

---

## The credential caveat, and why it decides whether this route is worth taking

This is the single most important fact on this page. Authenticating with `KIRO_API_KEY` starts sessions, runs turns, and continues sessions correctly, and silently carries none of Sortie's tools. The runtime asks its own backend for a governance profile before enabling MCP at all; that request fails for the one API key this route was measured with, so a session authenticated that way starts and runs normally while every declared tool server is dropped with no signal anywhere Sortie can see, on the wire or in Sortie's own output. Whether it fails for every API key, or only for keys on some plans, is unestablished. A stored device login does not hit that check: under a device login, the same request, model, and posture deliver and call the tool.

Since reaching Sortie's own tools is the reason to prefer this route over the native `kiro` kind at all, a deployment that wants that has to authenticate with a stored device login, on the machine that runs Sortie, rather than with `KIRO_API_KEY`.

| Credential | Sessions and turns | Sortie's tools |
|---|---|---|
| `KIRO_API_KEY` | Work correctly | Silently absent; every declared server is dropped before any tool is offered |
| Stored device login | Work correctly | Delivered and callable, subject to the trust-and-posture switch below |

The runtime's own log is the only place that states the cause when tools go missing: it records `Failed to get governance config from API - MCP disabled, web tools disabled`, and a vendor-namespaced `governance_disabled` notification also reaches the wire. Nothing on Sortie's own event stream marks this session as degraded.

### Confirming which credential a run will actually use

The [credential-verification step](/reference/workflow-config/#credential-verification) every worker attempt opens before its working session proves the credential answers a request at all, but it says nothing about which credential answered or whether that credential can reach Sortie's tools; see [authentication](/reference/adapter-agent-client-protocol/#authentication). Confirm the credential yourself before an unattended run, not after one silently loses its tools or hangs:

```sh
kiro-cli whoami
```

This reports the authenticated account. A machine carrying no credential at all does not fail here: a headless invocation instead blocks on an interactive device-authorization flow, so checking this ahead of time catches a missing credential before an unattended run hangs on it rather than after.

---

## The trust-and-posture switch

Where some runtimes on this route spell workspace trust and tool-approval posture as two separate launch switches, Kiro CLI spells both with one: `-a` (`--trust-all-tools`). It auto-approves every tool permission request, so dropping it restores asking for every tool, Sortie's and the runtime's own, and an unattended run has nobody to answer that ask. `-a` is required for a working unattended run, not optional hardening, and it is not separable into a trust-only or a posture-only grant the way a runtime with two distinct switches allows.

`--trust-tools=<names>` narrows that all-or-nothing grant to an explicit set. A tool a declared server offers is named there as `@<server>/<tool>`, the runtime's own qualified form, which is also what the runtime prints in a tool-call's own title. Sortie does not manage this list: a set that omits a tool the prompt will actually attempt puts the run back into an approval wait an unattended run cannot answer.

Run this agent inside a hardened sandbox regardless of which posture you choose. Neither switch replaces container-level isolation.

---

## Limitations

### Token accounting has no source on this route

No per-turn token count reaches Sortie on this route, and Sortie ships no measurement source for this runtime, so every run over it is recorded unmeasured, as [the kind page](/reference/adapter-agent-client-protocol/#token-accounting) describes for a runtime it cannot measure. `agent.max_tokens` therefore never takes effect on this route, and `agent.turn_timeout_ms` and `agent.stall_timeout_ms` are what bound a turn instead. The runtime's own unit of account is credits rather than tokens, which is a cost reading, not a token count, and nothing converts one into the other.

### Sessions are not closed through the protocol

This runtime's `initialize` handshake advertises an empty `sessionCapabilities` object, so `session/close` is never selected against it: a session here always ends through process termination, described in the [kind page's process shutdown section](/reference/adapter-agent-client-protocol/#process-shutdown). The short-lived [credential-verification](/reference/workflow-config/#credential-verification) session every worker attempt opens before the working one ends the same way, with nothing to call back and remove it; see [the kind page's session close section](/reference/adapter-agent-client-protocol/#session-close) for what that leaves behind on a runtime, this one included, that advertises neither method.

### A large vendor-namespaced surface exists and is safely ignored

The runtime announces available commands, subagent lists, MCP server initialization, and per-turn metadata under its own method prefix. These arrive as notifications rather than requests, so nothing answers them and nothing depends on them; Sortie records them as unrecognized and moves on. An unfamiliar line naming one of these methods in a debug log is expected, not a sign that something needs handling.

### A refusal disposition is unobserved

Sortie maps the protocol's `refusal` stop reason to a failed turn under the `turn_refused` error kind, as [the kind page's turn disposition table](/reference/adapter-agent-client-protocol/#turn-disposition) states. Whether this runtime produces that stop reason at all is unestablished: the measurement behind this page did not observe one.

### Live qualification on Windows is unobserved

Every measurement behind this page's claims was taken on a non-Windows host. Whether this runtime's behavior on this route differs on Windows is unestablished.

---

## Related pages

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the runtime-neutral transport this page assumes
- [Kiro CLI adapter reference](/reference/adapter-kiro/): the native `kiro` kind reaching the same runtime, and what each of the two routes delivers
- [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/): a second runtime on the same route, with a different credential trade-off
- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema
- [Environment variables reference](/reference/environment/): how a runtime's own credential reaches its subprocess
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
