---
title: "How to Run OpenCode in ACP Mode"
linkTitle: "Run OpenCode in ACP Mode"
description: "Run OpenCode under Sortie over the Agent Client Protocol, or move a workflow off the deprecated opencode kind: convert each setting, carry the provider credential to remote workers, and check the first run."
author: Sortie AI
date: 2026-11-04
weight: 158
url: /guides/run-opencode-in-acp-mode/
---
ACP mode is OpenCode's own protocol interface. Sortie drives it as the generic `agent-client-protocol` kind, launching `opencode acp` once per session and keeping that process open across turns.

This guide takes a working `opencode` workflow to a protocol one. If you start from nothing, skip the conversion table and use the result as a template. The route itself, and what it delivers that the hand-written kind does not, is described in [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/).

## Check the credential

The protocol route reads the same provider credential the `opencode` kind did: whatever OpenCode itself reads, either a stored login from `opencode auth login` or the environment variable of your provider. Nothing about the credential changes when you switch kinds.

Sortie's qualification of this route ran under a stored provider login. If your host authenticates another way, a key in the environment for instance, run the first dispatch and read the result before relying on it.

## Change the kind and the command

`agent-client-protocol` has no default command, so `agent.command` is required:

```yaml
agent:
  kind: agent-client-protocol
  command: opencode acp
```

`opencode acp` takes no switch for a model, an agent or a permission setting. OpenCode reads those from its own configuration document, which the next section writes into `agent-client-protocol.env`.

The generic kind reads `agent.command` only when it is the default kind, so a [dispatch rule](/reference/workflow-config/#dispatch) cannot route to it beside a different default kind. Make it the default through `agent.kind` or `dispatch.default.agent`.

## Convert the settings

Here is a working `opencode` workflow, trimmed to its agent configuration:

```yaml
agent:
  kind: opencode
  command: opencode
  max_turns: 15

opencode:
  model: anthropic/claude-sonnet-4-6
  effort: high
  dangerously_skip_permissions: true
  disable_autocompact: true
  allowed_tools:
    - read
    - glob
    - grep
    - edit
    - bash
```

And the same behavior on the protocol route:

```yaml
agent:
  kind: agent-client-protocol
  command: opencode acp
  max_turns: 15

agent-client-protocol:
  model: anthropic/claude-sonnet-4-6
  effort: high
  permissions: approve-all
  env:
    OPENCODE_DISABLE_AUTOUPDATE: "true"
    OPENCODE_CONFIG_CONTENT: |-
      {
        "model": "anthropic/claude-sonnet-4-6",
        "share": "disabled",
        "compaction": { "auto": false },
        "permission": {
          "read": "allow", "glob": "allow", "grep": "allow", "edit": "allow", "bash": "allow",
          "codesearch": "deny", "doom_loop": "deny", "external_directory": "deny",
          "list": "deny", "lsp": "deny", "question": "deny", "skill": "deny",
          "task": "deny", "todowrite": "deny", "webfetch": "deny", "websearch": "deny",
          "opencode_list_mcp_resources": "deny", "opencode_models": "deny",
          "opencode_read_mcp_resource": "deny", "opencode_session_move": "deny",
          "opencode_session_rename": "deny"
        }
      }
```

`OPENCODE_CONFIG_CONTENT` carries OpenCode's own configuration document as a JSON string. Sortie keeps every member you write there and adds its own switch that turns off OpenCode's session-title request. The `opencode` block disappears; every setting in it lands in one of the places below.

| `opencode` setting | Where it goes on the protocol route |
|---|---|
| `model` | The document's `model` member, and the same id in `agent-client-protocol.model`, which scopes a usage-limit hold to that model. OpenCode runs its default model when it cannot resolve an id, on both routes, and prints nothing to say so. |
| `agent` | The document's `default_agent` member, for example `"default_agent": "plan"`. The session reported the named agent as current. That agent's own guards were not observed on either route. |
| `effort`, `variant` | `agent-client-protocol.effort`, set on the model's reasoning option when each session opens. Drop any `#level` suffix from the document's `model`: this route does not read it. A `variant` key in the block has no effect and draws the validate warning `agent-client-protocol.variant.not_read`. |
| `thinking` | Nothing to set. OpenCode streams its reasoning on this route whatever any setting says. |
| `dangerously_skip_permissions: true` | `agent-client-protocol.permissions: approve-all`. |
| `dangerously_skip_permissions: false` | A `"*": "deny"` rule in the document's `permission` member, with `permissions` left unset. This denied the shell tool in the qualification run. |
| `allowed_tools`, `denied_tools` | The document's `permission` member. The `opencode` kind wrote the allowlist as `allow` for each listed key and `deny` for each other key it knows; the example above spells that policy out. Denial was observed on this route. Allowing a tool is OpenCode's own rule grammar and was not observed here. |
| `disable_autocompact` | The document's `compaction` member with `auto` set to `false`. The `opencode` kind defaulted this setting to `true`, so write the member even when your block never mentioned it. Its effect was observed on neither route. |
| `mcp_config` | `agent-client-protocol.mcp_config`, same file and same meaning. The qualification observed Sortie's own tool server reaching OpenCode; it did not observe an operator's servers, so check that yours appear in the first run. |

Three behaviors of the `opencode` kind came without a setting, and the protocol route needs each one written:

| What the `opencode` kind did on every launch | Where it goes on the protocol route |
|---|---|
| Approved every permission request, because `dangerously_skip_permissions` defaults to `true` | `agent-client-protocol.permissions: approve-all`. Without it, a request OpenCode asks about is refused, OpenCode ends the turn, and Sortie records it as failed. |
| Turned session sharing off | The document's `"share": "disabled"` member. |
| Set `OPENCODE_DISABLE_AUTOUPDATE=true` | The `agent-client-protocol.env` entry `OPENCODE_DISABLE_AUTOUPDATE: "true"`. |

Every setting of the `opencode` block has a carrier. The things with none are consequences of the move: a reasoning level the model does not offer runs at the model's current level with a warning, where the `opencode` kind failed the turn before any model request; and run history starts a new series, as the first-run checklist describes.

A dispatch rule that sets `env` replaces the top-level map whole, so it restates every entry it keeps, `OPENCODE_CONFIG_CONTENT` included. See [the generic kind's settings](/reference/adapter-agent-client-protocol/) for what each `agent-client-protocol` key does and which validate checks guard it.

Keep provider keys out of the workflow file. OpenCode reads them from its own login or from Sortie's environment, and substitutes `{env:NAME}` references inside its configuration document.

Validate the converted file:

```bash
$ sortie validate ./WORKFLOW.md
$ echo $?
0
```

## Reach remote workers over SSH

Skip this if every worker runs locally.

The protocol route declares no credential variable, and neither did the `opencode` kind, so a provider key reaches an SSH worker only when `worker.ssh_pass_env` names it:

```yaml
worker:
  ssh_hosts:
    - build01.internal
  ssh_pass_env:
    - ANTHROPIC_API_KEY
```

Name the variable your provider reads. A stored login cannot travel this way, because only variable names do: run `opencode auth login` on the worker host instead. The `agent-client-protocol.env` entries, the configuration document included, travel to the worker on their own and need no listing. See [environment variables carried to a remote agent](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent) for the full mechanism, and [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/) for how the route handles the credential.

## The deprecation warning

A workflow that names `opencode` keeps running. `sortie validate` prints this warning:

```
warning: agent.kind.deprecated: agent kind "opencode" is deprecated and will be removed in a later release; use agent kind "agent-client-protocol" instead
```

A running Sortie logs a warning with the message `agent kind is deprecated and will be removed in a later release`, carrying the kind and its replacement as attributes. Both name `agent-client-protocol`, and the conversion above ends them. See the [CLI reference](/reference/cli/) for the check value and how often the warning repeats.

## Verify the first run

Start Sortie and watch the first dispatch. The first session logs:

```
level=INFO msg="agent session started" issue_identifier=PROJ-42
level=INFO msg="turn started" issue_identifier=PROJ-42 turn_number=1 max_turns=15
```

Then check these:

- **The model.** Read the model name in the by-model table of `sortie stats`. It must be the model you wrote. A mistyped id runs OpenCode's default model, and nothing in the output marks it.
- **Permissions.** A tool call OpenCode asks about completes. If a turn fails with `agent reported a cancelled stop reason without a cancellation on either side` right after a notice that a permission request was refused, `permissions: approve-all` is missing.
- **Reasoning level.** If you set `effort` and the log carries a `reasoning level not applied by the agent` warning, the model does not offer that level and the session runs at the current one. Pick a name the model lists.
- **Your tool policy.** A tool you denied does not run. A tool you allowed does.
- **Your own MCP servers.** If you set `mcp_config`, confirm the agent can call them.
- **History.** Runs on this route are recorded under `agent-client-protocol`, beside every other runtime that kind drives, so the `opencode` series in run history and `sortie stats` ends at the move. The by-model figures continue, because both kinds record the model OpenCode reports.

Spend, its provenance and its lower bounds are measured the same way on both routes; see [spend measurement](/concepts/spend-measurement/).
