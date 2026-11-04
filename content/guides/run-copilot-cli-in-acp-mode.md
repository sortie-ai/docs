---
title: "How to Run Copilot CLI in ACP Mode"
linkTitle: "Run Copilot CLI in ACP Mode"
description: "Run GitHub Copilot CLI under Sortie over the Agent Client Protocol, or convert a workflow that uses the older Copilot CLI adapter: launch command, settings, credentials, and first-run checks."
author: Sortie AI
date: 2026-11-04
weight: 157
url: /guides/run-copilot-cli-in-acp-mode/
---
ACP mode is Copilot CLI's own protocol interface. Sortie drives it as the generic `agent-client-protocol` kind, launching `copilot --acp`, and keeps one Copilot CLI process open for the whole session. The older `copilot-cli` kind is deprecated: it keeps running, and `sortie validate` warns about it until the workflow names the other kind. This guide starts a Copilot CLI workflow in ACP mode and converts one that uses `copilot-cli`.

Prerequisites: Copilot CLI installed and on `PATH` (`npm install -g @github/copilot`), and a working `WORKFLOW.md`.

## Change the kind and the command

Before, a working `copilot-cli` workflow:

```yaml
agent:
  kind: copilot-cli
  command: copilot
  max_turns: 5
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  stop_grace_ms: 5000
  max_retry_backoff_ms: 300000

copilot-cli:
  model: claude-haiku-4.5
  max_autopilot_continues: 50
```

After:

```yaml
agent:
  kind: agent-client-protocol
  command: copilot --acp --allow-all --model claude-haiku-4.5
  max_turns: 5
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  stop_grace_ms: 5000
  max_retry_backoff_ms: 300000
```

Every `agent` field other than `kind` and `command` carries over unchanged. The `copilot-cli` block is gone: its settings move as the next section describes. `agent-client-protocol` has no default command, so `agent.command` is required.

- `--acp` puts Copilot CLI on the protocol.
- `--allow-all` approves every tool request without asking and turns on the runtime's `allow_all` option. The `copilot-cli` kind passes `--allow-all` on every launch unless `allowed_tools` is set. An unattended run has nobody to answer a permission request, so keep the switch and run the agent inside a hardened sandbox. `--allow-all-tools`, the posture of the shipped sample workflow, approves tool requests only.
- `--model` pins the model. Without it the account default applies.

`agent-client-protocol` reads `agent.command` only as the default kind, so a [dispatch rule](/reference/workflow-config/#dispatch) cannot route to it beside a different default kind. Make it the default kind through `agent.kind` or `dispatch.default.agent`. Reaching it through `dispatch.default.agent` also needs a top-level `agent-client-protocol: {}` block, even with nothing to configure.

## Convert each setting

Find each key of your `copilot-cli` block in the table. A value that holds a space needs the [list form of `agent.command`](/reference/workflow-config/#agent). Every switch in `agent.command` also rides the credential-verification launch.

| `copilot-cli` setting | Where it goes | What to know |
|---|---|---|
| `model` | `--model <id>` in `agent.command` | An unknown id runs the account default without an error. `agent-client-protocol.model` only scopes a usage-limit hold and does not select a model. |
| `effort` | `--reasoning-effort <level>` in `agent.command` | An invalid level exits Copilot CLI before the handshake, and a model that does not support reasoning effort, such as `claude-haiku-4.5`, fails the session start. Either fails the run before its first turn with the runtime's error. A key `effort` under `agent-client-protocol` also works, but the switch is the form that was measured. |
| `agent` | `agent-client-protocol.config_options` with `agent: <name>` | Copilot CLI ignores `--agent <name>` in `agent.command` under `--acp`. See the example below. |
| `allowed_tools` | `--allow-tool <rule>` in `agent.command`, instead of `--allow-all` | A call the rule does not match asks for permission, Sortie refuses it, and the turn ends. The `copilot-cli` kind denies such a call and the turn goes on. See the note below the table. |
| `denied_tools` | `--deny-tool <rule>` in `agent.command` | Takes effect as on `copilot-cli`. |
| `available_tools` | `--available-tools <list>` in `agent.command` | Takes effect as on `copilot-cli`. |
| `excluded_tools` | `--excluded-tools <list>` in `agent.command` | Takes effect as on `copilot-cli`. |
| `disable_builtin_mcps` | `--disable-builtin-mcps` in `agent.command` | Takes effect as on `copilot-cli`. |
| `experimental` | `--experimental` in `agent.command`, or `experimental` in Copilot CLI's own `settings.json` | The switch is accepted. Its effect was not observed on either route. |
| `mcp_config` | HTTP and SSE servers: `agent-client-protocol.mcp_config`, the same file path. Stdio servers: `--additional-mcp-config @<file>` in `agent.command` | A stdio server listed under the key does not reach the model, and no error says so. A server member the key does not read, such as `timeout`, fails the session start. Whether such a member reaches Copilot CLI through `--additional-mcp-config @<file>` was not observed. |
| `max_autopilot_continues` | Nowhere | No setting or switch carries it. |
| `no_custom_instructions` | Nowhere | `--no-custom-instructions` is accepted under `--acp` and withholds no instruction file: `AGENTS.md`, `.github/copilot-instructions.md` and added instruction directories keep loading. |

Three behaviors of `copilot-cli` have no counterpart in ACP mode:

- **Autopilot ceiling.** The `copilot-cli` kind passes `--autopilot` and `--max-autopilot-continues` and reports a turn that reaches the ceiling as incomplete. ACP mode carries neither. A turn ends on the runtime's stop reason, and what the runtime reports at a ceiling was not observed.
- **Denying calls outside an allow-list.** A workflow that relies on `allowed_tools` to deny every other call while the turn goes on loses that denial. Use `--deny-tool` rules over `--allow-all` to deny specific calls.
- **Withholding instruction files.** A workflow that relies on `no_custom_instructions` cannot keep the repository's instruction files from the agent in ACP mode. This is the setting that gives a reason to stay on `copilot-cli`.

If your block sets `agent`, add the entry under the generic kind's block and keep the rest of the command as above:

```yaml
agent-client-protocol:
  config_options:
    agent: reviewer
```

The name must be one the session offers: a profile defined in the workspace or in the user's Copilot CLI configuration. A name it does not offer runs the current agent and logs a warning, where `copilot-cli` exits with `No such agent`. Set `agent: ""` to select the default Copilot agent. See the [`agent-client-protocol` reference](/reference/adapter-agent-client-protocol/) for the settings of this block, and [Copilot CLI on the Agent Client Protocol](/reference/agent-client-protocol-copilot/) for what this route delivers that `copilot-cli` does not, and the reverse.

## Check the credential

Copilot CLI authenticates a run with a stored login, or with a token in `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`. The qualification of this route ran under a stored login, and a token credential, a refused credential and a host with no login were not observed on ACP mode.

A workflow that works on `copilot-cli` already has one of these in place on the host that runs the session, and it keeps working: the runtime reads it, not the kind. A token variable must be in the environment of the Sortie process.

## Reach remote workers over SSH

Skip this if every worker runs locally.

The `copilot-cli` kind carries `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` to a remote host on its own account. ACP mode declares no credential variable, so name the ones you use:

```yaml
worker:
  ssh_hosts:
    - build01.internal
  ssh_pass_env:
    - GITHUB_TOKEN
```

A stored login cannot travel this way: it has to exist on the worker host. See [environment variables carried to a remote agent](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) for the mechanism, and [let remote agents use Sortie's tools](/guides/scale-agents-with-ssh/#let-remote-agents-use-sorties-tools) for the host-side requirement of Sortie's tool delivery.

## Validate

```bash
$ sortie validate ./WORKFLOW.md
$ echo $?
0
```

While the workflow names `copilot-cli`, the command prints this warning and exits `0`:

```
warning: agent.kind.deprecated: agent kind "copilot-cli" is deprecated and will be removed in a later release; use agent kind "agent-client-protocol" instead
```

A running Sortie logs the same warning at level `WARN` as `agent kind is deprecated and will be removed in a later release`, with `agent_kind=copilot-cli` and `replacement_kind=agent-client-protocol`. Naming `agent-client-protocol` in `agent.kind`, `dispatch.default.agent` or a dispatch rule's `agent` ends it. See [advisory warnings](/reference/cli/) for the check and how often it appears.

## Verify the first run

Start Sortie and watch the first dispatch. The first turn of the first session logs:

```
level=INFO msg="agent credential verified" issue_identifier=PROJ-42 duration_ms=1204
level=INFO msg="agent session started" issue_identifier=PROJ-42
level=INFO msg="turn started" issue_identifier=PROJ-42 turn_number=1 max_turns=5
```

Then check:

- **The model.** An unknown `--model` id does not fail. Compare the model the run reports, on the dashboard or in the log, with the one you set.
- **Warnings from the session.** A `config_options` entry or an `effort` the session does not offer draws a warning and the run goes on with the current value.
- **Sortie's tools.** Ask a first issue to call one of them, and confirm the call appears in the turn.
- **Spend.** The run reports tokens and cost. How a figure is measured, and when it is a lower bound, is on [spend measurement](/concepts/spend-measurement/).
- **Run history.** New runs are recorded under the kind `agent-client-protocol`. The `copilot-cli` series in run history and `sortie stats` ends at the switch, and the `agent-client-protocol` series includes every runtime driven through that kind.

## Related pages

- [Copilot CLI on the Agent Client Protocol](/reference/agent-client-protocol-copilot/): launch switches, credentials, spend and limits, and the comparison with `copilot-cli`
- [Copilot CLI adapter](/reference/adapter-copilot/): the deprecated `copilot-cli` kind
- [Agent Client Protocol adapter](/reference/adapter-agent-client-protocol/): the generic kind's settings
- [How to scale agents with SSH](/guides/scale-agents-with-ssh/): remote workers
- [Spend measurement](/concepts/spend-measurement/): figures, provenance and lower bounds
