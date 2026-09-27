---
title: "How to Run Kiro CLI in ACP Mode"
linkTitle: "Run Kiro CLI in ACP Mode"
description: "Connect Kiro CLI to Sortie over the Agent Client Protocol, including how to convert a config from Sortie's earlier Kiro integration."
author: Sortie AI
date: 2026-09-27
weight: 156
url: /guides/run-kiro-cli-in-acp-mode/
---
ACP mode is Kiro CLI's own protocol interface. Sortie drives it as the generic `agent-client-protocol` kind, launching `kiro-cli acp`, the same binary a `WORKFLOW.md` naming `agent.kind: kiro` already runs. Such a config converts to ACP mode in a few lines; see [convert a `kiro` configuration](#convert-a-kiro-configuration) below.

## Choose a credential

Which credential authenticates the session decides whether Sortie's own tools reach the agent. Confirm this before touching `agent.command`.

| Credential (local launch) | Sortie's tools |
|---|---|
| Stored device login | Delivered and callable, subject to the trust posture below |
| `KIRO_API_KEY` | Silently dropped: a governance-profile check against the runtime's own backend fails under this credential (whether that holds for every key or only some plans is unestablished), with no signal on the wire or in Sortie's own output |

A stored device login is the only way to reach that tool channel.

Check which credential a run will actually use before switching:

```sh
kiro-cli whoami
```

A machine with no credential at all does not fail here. It blocks on an interactive device-authorization flow instead, so run this check before an unattended run, not after one hangs on it. If the check reports the wrong credential, or Sortie's tools stay silently absent after you switch, the runtime's own log carries the reason: `Failed to get governance config from API - MCP disabled, web tools disabled`. See [the credential caveat](/reference/agent-client-protocol-kiro/#the-credential-caveat-and-why-it-decides-whether-this-route-is-worth-taking) for the full mechanism.

## Configure ACP mode

```yaml
agent:
  kind: agent-client-protocol
  command: kiro-cli acp -a
  max_turns: 15
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  stop_grace_ms: 5000
  max_retry_backoff_ms: 300000
```

`acp` is listed under `kiro-cli --help-all` only, not `kiro-cli --help`, which is worth knowing before concluding a build does not carry it. `-a` (`--trust-all-tools`) auto-approves every tool permission request; it is required for a working unattended run, not optional hardening, because dropping it restores asking for every tool and an unattended run has nobody to answer. Run the agent inside a hardened sandbox regardless. To pin a model, append `--model <id>` to `agent.command`, reading the account's live model set off `kiro-cli chat --list-models -f json`.

Reaching `agent-client-protocol` only through a [dispatch rule](/reference/workflow-config/#dispatch) rather than through the top-level `agent.kind` needs its own top-level block even with nothing to configure in it: add an empty `agent-client-protocol: {}`.

Validate before running anything else:

```bash
$ sortie validate ./WORKFLOW.md
$ echo $?
0
```

A working ACP configuration passes with no warnings.

## Convert a `kiro` configuration

Two fields change at the top of `agent`, and the `kiro:` block goes away.

| `kiro` configuration | ACP mode equivalent |
|---|---|
| `agent.kind: kiro` | `agent.kind: agent-client-protocol` |
| `agent.command` (empty selected `kiro-cli`) | The same binary, followed by `acp -a` |
| `kiro.model` | `--model <id>` appended to `agent.command` |
| `kiro.agent` | `--agent <name>` appended to `agent.command` |
| `kiro.trust_all_tools: true` (the only posture the kind accepted) | `-a`, already in `agent.command` |
| `kiro.trust_tools` | `--trust-tools=<names>` appended to `agent.command`, an allowlist ACP mode can accept where the `kiro` kind refused it; see [the trust-and-posture switch](/reference/agent-client-protocol-kiro/#the-trust-and-posture-switch) before narrowing it |
| `kiro.mcp_config` | `agent-client-protocol.mcp_config` |
| The `kiro:` block itself | Deleted |

Here is a `kiro` configuration, taken from `examples/WORKFLOW.kiro.md`, and the ACP-mode configuration built from the mapping above.

Before:

```yaml
agent:
  kind: kiro
  command: kiro-cli
  max_turns: 5
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  stop_grace_ms: 5000
  max_retry_backoff_ms: 300000

kiro:
  model: claude-sonnet-4.6
```

After:

```yaml
agent:
  kind: agent-client-protocol
  command: kiro-cli acp -a --model claude-sonnet-4.6
  max_turns: 5
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  stop_grace_ms: 5000
  max_retry_backoff_ms: 300000
```

Every field below `command` is untouched. Nothing else in `WORKFLOW.md`, the tracker, hooks, or prompt template needs to change.

Sortie versions that still include the `kiro` kind warn about a workflow naming it: `sortie validate` reports it every time it runs, and the run log logs it once per running process, again only after it clears and returns. Both name `agent-client-protocol` as the replacement:

```
warning: agent.kind.deprecated: agent kind "kiro" is deprecated and will be removed in a later release; use agent kind "agent-client-protocol" instead
```

See [advisory warnings](/reference/cli/#advisory-warnings) for exactly how often each surfaces; the two do not share a cadence. A later release removes the `kiro` kind; nothing pins which one.

Converting from a `KIRO_API_KEY` deployment costs no tool access: the `kiro` kind never delivered Sortie's tools under that credential either. Session continuation across a fresh agent launch is what a converted config gains: the `kiro` kind always started turn one over after a stall, a retry, or a restart, while ACP mode continues the same session, confirmed by observed replay from a second process. Token accounting stays the same: `kiro-cli` has no measurement source on either route, so every run is unmeasured and `agent.turn_timeout_ms` is what bounds a turn instead, exactly as it did under the `kiro` kind. See [the full comparison](/reference/adapter-kiro/#two-routes-to-this-runtime) for tool delivery, credential verification, and the offline checks each route runs.

## Reach remote workers over SSH

Skip this if every worker runs locally.

The `kiro` kind declared `KIRO_API_KEY` as its own credential variable, so Sortie carried it from its own environment to a remote host automatically. ACP mode declares no credential variable, so nothing is carried on its own account.

If your remote workers authenticate with `KIRO_API_KEY`, name it explicitly:

```yaml
extensions:
  worker:
    ssh_hosts:
      - build01.internal
    ssh_pass_env:
      - KIRO_API_KEY
```

A stored device login cannot be carried this way: only environment variable names travel to a remote host, through `ssh_pass_env` or a kind's own declared credential set, so the login has to already exist on that host. And neither route delivers Sortie's tools over an SSH launch at all, whatever the credential: the protocol adapter parses the generated MCP configuration for a local launch only, the same restriction `codex` and `opencode` carry. If tool delivery is why you're moving to ACP mode, keep those workers local. See [environment variables carried to a remote agent](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) for the full mechanism.

## Verify the first run

Start Sortie and watch the first dispatch. The first turn of the first session logs:

```
level=INFO msg="agent credential verified" issue_identifier=PROJ-42 duration_ms=428
level=INFO msg="agent session started" issue_identifier=PROJ-42 session_id=8f3c1a9e-...
level=INFO msg="turn started" issue_identifier=PROJ-42 turn_number=1 max_turns=15
```

`agent credential verified` is the same [credential-verification step](/reference/workflow-config/#credential-verification) every kind runs; it proves the credential answers a request, not which credential answered or whether it can reach Sortie's tools. Confirm the credential itself with `kiro-cli whoami` on the host that runs the session, as above.
