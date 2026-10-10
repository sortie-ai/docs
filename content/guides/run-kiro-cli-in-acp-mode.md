---
title: "How to Run Kiro CLI in ACP Mode"
linkTitle: "Run Kiro CLI in ACP Mode"
description: "Connect Kiro CLI to Sortie over the Agent Client Protocol: choose a credential, set the launch command, and reach remote workers over SSH."
author: Sortie AI
date: 2026-09-27
weight: 156
url: /guides/run-kiro-cli-in-acp-mode/
---
ACP mode is Kiro CLI's own protocol interface. Sortie drives it as the generic `agent-client-protocol` kind, launching `kiro-cli acp`.

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

A machine with no login prints `Not logged in` and exits with code 1, and a run started there fails at start with `You are not logged in, please log in with kiro-cli login`, so run this check before an unattended run. If the check reports the wrong credential, or Sortie's tools stay silently absent after you switch, the runtime's own log carries the reason: `Failed to get governance config from API - MCP disabled, web tools disabled`. See [which login delivers Sortie's tools](/reference/agent-client-protocol-kiro/#which-login-delivers-sorties-tools) for the full mechanism.

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

`agent-client-protocol` has no default command and reads `agent.command` only as the default kind, so a [dispatch rule](/reference/workflow-config/#dispatch) cannot route to it beside a different default kind: `sortie validate` reports an `agent.command` error. Make it the default kind instead, through `agent.kind` or `dispatch.default.agent`. Reaching it through `dispatch.default.agent` rather than through the top-level `agent.kind` needs its own top-level block even with nothing to configure in it: add an empty `agent-client-protocol: {}`.

Validate before running anything else:

```bash
$ sortie validate ./WORKFLOW.md
$ echo $?
0
```

A working ACP configuration passes with no warnings.

## Reach remote workers over SSH

Skip this if every worker runs locally.

ACP mode declares no credential variable, so Sortie carries nothing from its own environment to a remote host on its own account. If your remote workers authenticate with `KIRO_API_KEY`, name it explicitly:

```yaml
extensions:
  worker:
    ssh_hosts:
      - build01.internal
    ssh_pass_env:
      - KIRO_API_KEY
```

A stored device login cannot be carried this way: only environment variable names travel to a remote host, through `ssh_pass_env` or a kind's own declared credential set, so the login has to already exist on that host. And Sortie's tools are not delivered over an SSH launch at all, whatever the credential: the protocol adapter parses the generated MCP configuration for a local launch only, the same restriction `codex` and `opencode` carry. If tool delivery is why you're using ACP mode, keep those workers local. See [environment variables carried to a remote agent](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) for the full mechanism.

## Verify the first run

Start Sortie and watch the first dispatch. The first turn of the first session logs:

```
level=INFO msg="agent credential verified" issue_identifier=PROJ-42 duration_ms=428
level=INFO msg="agent session started" issue_identifier=PROJ-42 session_id=8f3c1a9e-...
level=INFO msg="turn started" issue_identifier=PROJ-42 turn_number=1 max_turns=15
```

`agent credential verified` is the same [credential-verification step](/reference/workflow-config/#credential-verification) every kind runs; it proves the credential answers a request, not which credential answered or whether it can reach Sortie's tools. Confirm the credential itself with `kiro-cli whoami` on the host that runs the session, as above.
