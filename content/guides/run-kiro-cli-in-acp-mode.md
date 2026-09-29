---
title: "How to Run Kiro CLI in ACP Mode"
linkTitle: "Run Kiro CLI in ACP Mode"
description: "Connect Kiro CLI to Sortie over the Agent Client Protocol, including how to convert a config from Sortie's earlier Kiro integration."
author: Sortie AI
date: 2026-09-27
weight: 156
url: /guides/run-kiro-cli-in-acp-mode/
---
ACP mode is Kiro CLI's own protocol interface. Sortie drives it as the generic `agent-client-protocol` kind, launching `kiro-cli acp`. A `WORKFLOW.md` that says `agent.kind: kiro` is converted onto this setup when it loads; see [convert a `kiro` configuration](#convert-a-kiro-configuration).

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

## Convert a `kiro` configuration

Sortie has no `kiro` agent kind. A `WORKFLOW.md` that names it in `agent.kind`, `dispatch.default.agent`, or a dispatch rule's `agent` keeps loading: Sortie converts it in memory onto `agent-client-protocol` and warns. The file on disk is never rewritten. The conversion is temporary and a later release removes it, after which such a file fails to load. Make the edit below while the warning is all you get.

### What the conversion does

A converted workflow launches `kiro-cli acp -a`. When `kiro` is the default kind and `agent.command` names a program, that program replaces `kiro-cli`. `kiro.model` and `kiro.agent` become `--model` and `--agent` on the command. Everything else in the `kiro:` block is dropped, `kiro.mcp_config` included, so MCP servers you declared there do not reach the session. Move that path to `agent-client-protocol.mcp_config` yourself.

Under the `kiro` kind Sortie carried `KIRO_API_KEY` to SSH hosts on its own. A converted workflow does too, without a `worker.ssh_pass_env` entry; a hand-written ACP configuration needs one, as [above](#reach-remote-workers-over-ssh).

New runs are recorded under `agent-client-protocol` in run history, on the dashboard and in `sortie stats`. Runs recorded earlier keep their `kiro` label.

### The warning

`sortie validate` prints one warning per converted kind, check `agent.kind.retired`, and reports the file as valid. This is the text for a workflow with `kiro.model` and `kiro.mcp_config` set:

```
warning: agent.kind.retired: agent kind "kiro" was removed, so this configuration was converted to agent kind "agent-client-protocol" (agent.kind); its sessions launch "kiro-cli acp -a --model claude-sonnet-4.6"; not carried: kiro.mcp_config. This conversion is temporary and will be removed in a later release: name agent kind "agent-client-protocol" where the workflow names "kiro" and give it this invocation in agent.command
```

The parenthesis lists every field that named `kiro`. The quoted command is what to write in `agent.command`, and `not carried` lists the settings you have to move. When `worker.ssh_hosts` is set, the text also says a remote launch carries `KIRO_API_KEY` and asks you to list it under `worker.ssh_pass_env`. A running Sortie logs a shorter record at `WARN` level, with the message `agent kind was removed and its configuration was converted to the replacement kind; the conversion will be removed in a later release` and the attributes `agent_kind=kiro` and `replacement_kind=agent-client-protocol`. It carries no invocation, so run `sortie validate` to read it. [Advisory warnings](/reference/cli/#advisory-warnings) says how often each surfaces; the two do not share a cadence.

### What to write

Two fields change at the top of `agent`, and the `kiro:` block goes away. The warning ends once no field names `kiro`.

| `kiro` configuration | ACP mode equivalent |
|---|---|
| `agent.kind: kiro` | `agent.kind: agent-client-protocol` |
| `agent.command` (empty selected `kiro-cli`) | The same binary, followed by `acp -a` |
| `kiro.model` | `--model <id>` appended to `agent.command` |
| `kiro.agent` | `--agent <name>` appended to `agent.command` |
| `kiro.trust_all_tools: true`, or neither trust key set | `-a`, already in `agent.command` |
| `kiro.trust_tools` | Does not convert; see [configurations that do not convert](#configurations-that-do-not-convert) |
| `kiro.mcp_config` | `agent-client-protocol.mcp_config` |
| `KIRO_API_KEY` reaching SSH hosts by itself | `KIRO_API_KEY` under `worker.ssh_pass_env`, only when `worker.ssh_hosts` is set |
| The `kiro:` block itself | Deleted |

Here is a `kiro` configuration and the ACP-mode configuration built from the mapping above.

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

When `kiro` is named only by a dispatch rule, the warning tells you `agent-client-protocol` runs that invocation only as the default kind. Make it the default kind, as [described above](#configure-acp-mode).

When `agent-client-protocol` is already the default kind and a dispatch rule names `kiro`, the conversion changes no command. The warning says that rule's sessions keep `agent.command` and carry none of the `kiro:` settings, so a `kiro.model` or `kiro.agent` has no effect until you add `--model` or `--agent` to `agent.command` yourself. The edit is to name `agent-client-protocol` in that rule.

### Configurations that do not convert

The conversion trusts every tool, because `-a` does. A configuration that limits trust is refused instead of widened, so Sortie will not start on it, and a running Sortie keeps the last configuration that loaded. These fail the load:

- `kiro.trust_all_tools: false`
- a `kiro.trust_tools` list, including an empty one
- `kiro.trust_all_tools: true` together with a non-empty `kiro.trust_tools`
- a `kiro.model` or `kiro.agent` that is not a string

`sortie validate` reports the first three under the check `config.kiro.trust_tools`, and the last under `config.kiro.model` or `config.kiro.agent`. The message opens with `agent kind "kiro" was removed and this configuration cannot be converted to agent kind "agent-client-protocol"`. For a trust setting it goes on to name the two ways out: set `trust_all_tools: true` and remove `trust_tools`, or remove both, to convert; or name `agent-client-protocol` and put `kiro-cli acp --trust-tools=<names>` in `agent.command` to keep the narrower set. That switch is described in [the trust-and-posture switch](/reference/agent-client-protocol-kiro/#the-trust-and-posture-switch); read it before narrowing, because a tool missing from the list stalls an unattended run.

If you cannot move to ACP mode, Sortie 1.25.0 is the last release that includes the `kiro` agent kind. [Install it as a pinned version](/getting-started/installation/#script-options); the conversion is temporary, so plan the move to ACP mode either way.

### What ACP mode changes for a converted workflow

Converting from a `KIRO_API_KEY` deployment costs no tool access: the `kiro` kind delivered Sortie's tools under no credential. A stored device login reaches them on a local launch. Token accounting is unchanged: `kiro-cli` has no measurement source on this route, so every run is unmeasured and `agent.turn_timeout_ms` is what bounds a turn instead. See [the route reference](/reference/agent-client-protocol-kiro/) for tool delivery, credential verification, and limitations.
