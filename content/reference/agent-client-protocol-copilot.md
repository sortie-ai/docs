---
title: "Copilot CLI on the Agent Client Protocol"
linkTitle: "Copilot CLI on ACP"
description: "Reference for running GitHub Copilot CLI under Sortie in ACP mode: the launch command, the switches that set the model and the permission posture, naming an agent profile, the GitHub token it reads locally and over SSH, premium requests and usage limits, and what this route delivers compared with the earlier Copilot CLI adapter."
author: Sortie AI
date: 2026-11-04
weight: 148
url: /reference/agent-client-protocol-copilot/
---
[GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) runs under Sortie in ACP mode: the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind, where `agent.command` names the `copilot` binary together with `--acp`, the flag that puts it into protocol mode. The runtime stays running for the whole session, and Sortie talks to it over the protocol. To move an existing workflow onto this route, see [how to run Copilot CLI in ACP mode](/guides/run-copilot-cli-in-acp-mode/). The hand-written [`copilot-cli`](/reference/adapter-copilot/) kind is deprecated in favor of this route.

Sample workflow: [`examples/WORKFLOW.agent-client-protocol.copilot.md`](https://github.com/sortie-ai/sortie/blob/main/examples/WORKFLOW.agent-client-protocol.copilot.md).

See also: [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the transport-level mechanism this page assumes, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds.

---

## Installation and configuration

```yaml
agent:
  kind: agent-client-protocol
  command: copilot --acp --allow-all-tools --model <model id>
```

Install the CLI with `npm install -g @github/copilot` and confirm `copilot` is on the `PATH` of the machine that runs it. `--acp` is the only protocol entry point.

| Switch | Effect on this route |
|---|---|
| `--acp` | Puts the CLI into protocol mode. Required. |
| `--allow-all-tools` | Approves every tool permission request, Sortie's own tools included. The sample workflow uses it. An unattended run needs this switch or `--allow-all`, which approves the same requests and also grants path verification and URL access; see [the permission posture](#the-permission-posture). |
| `--model <id>` | Selects the model for the session. Without it the account default applies. |

The sample leaves `--model` out. Pass it as shown to pin a model. An id the runtime does not know does not fail the launch: the run executes on the account default and nothing marks it, so confirm the id against what the account offers. The `agent-client-protocol.model` key does not select a model; it only scopes a [usage-limit hold](#usage-limit-refusals).

A switch the runtime rejects, or a combination it cannot start, fails the run before its first turn with the runtime's exit status and error text. Two cases were measured: an unknown `--reasoning-effort` level exits before the handshake, and a model that has no reasoning configuration fails session creation when a level is set.

`COPILOT_HOME` is optional. Unset, the runtime keeps its configuration and session state under `~/.copilot`. Sortie reads the session-state journal to measure spend, and resolves its location from `COPILOT_HOME` as well; see [environment variables](/reference/environment/#agent-runtime-variables).

---

## The permission posture

Without `--allow-all-tools`, a tool call raises a permission request. Sortie answers it with a refusal, because an unattended run has nobody to approve. Copilot CLI then fails the call with "The user rejected this tool call.", prints "Info: Operation cancelled by user", and ends the turn without sending the model a follow-up request. A tool server that Sortie declared is delivered in that posture and is never called.

| Posture | Launch | Behavior |
|---|---|---|
| Approve every tool request | `--allow-all-tools` | The runtime asks for nothing. Its `allow_all` option stays off. |
| Approve everything the earlier kind approved | `--allow-all` | Grants tool approval, path verification and URL access, and turns the runtime's `allow_all` option on. |
| Approve the calls a rule names | `--allow-tool <rule>`, without `--allow-all` or `--allow-all-tools` | A call the rule matches runs with no request. A call it does not match asks, Sortie refuses, and the turn ends with no follow-up request. |
| Deny a tool | `--deny-tool <rule>`, beside either approval switch | The call fails with the error code `denied`, no request is raised, and the turn goes on. |

With either approval switch the agent runs shell commands and writes files unprompted, so run this agent inside a hardened sandbox.

`--trust-folder` is not a route switch: the CLI refuses it beside `--acp`, and a tool server declared over the protocol loads in an untrusted workspace without it.

The `agent-client-protocol.permissions` setting, described in the [configuration reference](/reference/workflow-config/#agent-client-protocol), was not exercised against Copilot CLI in the qualification. The measured posture is the launch switch. How Sortie answers a request that reaches it is on the [kind page](/reference/adapter-agent-client-protocol/#permission-handling).

---

## Where the earlier kind's settings go

The `copilot-cli` block has no counterpart on this route. Its settings move to one of four places. The [migration guide](/guides/run-copilot-cli-in-acp-mode/) holds the setting-by-setting table.

**Switches in `agent.command`.** Each of these was measured to take effect when passed to `copilot --acp`:

| Switch | Effect |
|---|---|
| `--model <id>` | Selects the model. |
| `--reasoning-effort <level>` | Sets the reasoning level. `low`, `medium`, `high`, `xhigh` and `max` are the values the runtime lists. |
| `--allow-tool <rule>`, `--deny-tool <rule>` | Approve or deny the calls a rule names; see [the permission posture](#the-permission-posture). |
| `--available-tools <list>`, `--excluded-tools <list>` | Scope the tools the model sees. |
| `--disable-builtin-mcps` | Turns off the runtime's built-in tool servers. |
| `--additional-mcp-config @<file>` | Carries stdio tool servers; see [tool servers](#tool-servers). |

A value that holds a space needs the list form of [`agent.command`](/reference/workflow-config/#agent). `--experimental` is accepted, and so is `experimental` in the runtime's own `settings.json`; the effect of the switch itself was measured on neither route.

An `agent.command` switch rides every launch of a session, the [credential-verification](/reference/workflow-config/#credential-verification) request included. `--available-tools` and `--no-custom-instructions` in the command change what that request carries: with either, it runs with the tools the launch configures instead of the `view` tool alone.

**Keys of the `agent-client-protocol` block.** `mcp_config` carries HTTP and SSE tool servers. `config_options` carries `agent: <name>`; see [naming an agent](#naming-an-agent). `effort` sets the reasoning level, and its measured counterpart here is the switch above. Copilot CLI lists its `reasoning_effort` option under the protocol's reasoning-level category, so the key reaches it, and a name the option does not offer draws a warning in Sortie's log and leaves the level as it was. Setting the level through the key was not observed against Copilot CLI; the switch was.

**The runtime's own configuration.** Anything Copilot CLI reads from `COPILOT_HOME`, such as `settings.json`.

**No carrier.** These `copilot-cli` settings have nothing on this route:

| Setting | What the route does instead |
|---|---|
| `max_autopilot_continues` | Nothing caps autopilot continuations. A turn ends on the stop reason the runtime reports. |
| `no_custom_instructions` | `--no-custom-instructions` is accepted and withholds nothing. The repository's instruction files (`AGENTS.md`, `.github/copilot-instructions.md`) and the directories in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` keep loading. |
| Autopilot (`--autopilot`) | Nothing carries it. A `config_options` entry can set the runtime's `mode` option, whose values include autopilot; whether that value delivers autopilot was not observed. |

The kind's `--no-ask-user` has no counterpart either, and none was needed: a prompt that asked for the user's input drew no input request with or without the switch.

---

## Naming an agent

`--agent <name>` in `agent.command` is accepted under `--acp` and selects no agent. A named agent goes in `agent-client-protocol.config_options`, as the value of the runtime's `agent` option:

```yaml
agent-client-protocol:
  config_options:
    agent: reviewer
```

Copilot CLI lists the `agent` option only when at least one agent profile exists. A workspace defines a profile in `.github/agents/<name>.agent.md`; the user's own profiles are listed beside the workspace's. The option's values are the profile names plus the empty string, which is the default Copilot agent and the value a new session holds. Sortie sets the value when each session opens, before the first turn. The profile's instructions then apply to the turn, which the qualification observed with a workspace profile that ends every reply with a marker word. Its tools and its model were measured on neither route.

| What the session offers | What happens |
|---|---|
| The name is a listed profile | The agent applies. |
| The name is not a listed profile | The session runs with the agent it holds, and Sortie's log carries the warning `session option not applied by the agent` with `option` set to `agent`, `reason` set to `not_offered` and the offered names under `offered`. |
| No profile exists at all | The runtime lists no `agent` option. The same warning carries `reason` set to `no_option`. |

The earlier kind exits with `No such agent` in the last two cases, so check the profile name before an unattended run.

A continued session keeps the agent that an earlier session set. Removing the entry does not reset it. To return to the default agent, set `agent: ""`. When a continued session holds a non-default agent that no entry names, Sortie's log records it at the Info level. The semantics of the key for every runtime are in the [configuration reference](/reference/workflow-config/#agent-client-protocol).

---

## Authentication

| Variable | Required | Description |
|---|---|---|
| `COPILOT_GITHUB_TOKEN` | Only when no login is stored | GitHub token for Copilot CLI. Highest priority of the three. |
| `GH_TOKEN` | Only when no login is stored | GitHub token. |
| `GITHUB_TOKEN` | Only when no login is stored | GitHub token. |

Sortie manages no credential for this kind. The runtime inherits the parent process environment and reads its own token from it, or uses the login it stored on the machine. Every measurement behind this page ran under a stored login with no token variable set. An invalid `GITHUB_TOKEN` beside a stored login did not stop a run: the stored login authenticated it.

Sortie reads the first of the three variables that is set in the runtime's environment to request the account's [usage limits](#usage-limits), so a token variable matters even when a stored login authenticates the run.

Whether a token alone, a refused token, or a host with no sign-in at all passes the [credential-verification step](/reference/workflow-config/#credential-verification) on this route was not observed in the qualification.

### Over SSH

An SSH launch of `copilot --acp` carries no credential on its own account. The `copilot-cli` kind carries the three variables by declaration; this route does not. To send a token to a worker host, name the variable under [`worker.ssh_pass_env`](/reference/workflow-config/#environment-variables-carried-to-a-remote-agent):

```yaml
worker:
  ssh_hosts:
    - build-01.example.com
  ssh_pass_env:
    - COPILOT_GITHUB_TOKEN
```

A name left out does not travel, and the host's own login or environment applies. This part follows from Sortie's code; no runtime launch over SSH exercised it. `agent.command` reaches the remote shell unsplit.

---

## Tool servers

| Server | Declared over the protocol | Result |
|---|---|---|
| Sortie's own tools | HTTP, on a local launch and through a reverse forward over SSH | Delivered and callable. |
| An HTTP or SSE server in `agent-client-protocol.mcp_config` | HTTP or SSE | Delivered. |
| A stdio server in `agent-client-protocol.mcp_config` | stdio | Ignored. The model is not offered the tool, the turn completes, and nothing marks the gap. |
| A stdio server passed as `--additional-mcp-config @<file>` in `agent.command` | Through the runtime's own switch | The call ran in a local launch. The file uses the `{"mcpServers": ...}` form. |

Sortie's tools need no stdio server, so only an operator's stdio server is affected. A server entry that carries a member the generic kind does not read, such as `timeout`, fails the session start from `mcp_config`. Whether the same member passes through `--additional-mcp-config @<file>` was not observed.

Copilot CLI names a tool call `<server>-<tool>`. The tool-call detail is on the [kind page](/reference/adapter-agent-client-protocol/#mcp).

---

## Spend

Sortie measures a run's tokens from the runtime's session-state journal, which holds one record per model request with the model that served it, and from the usage the runtime reports at the end of each prompt. The prompt result alone carried no token figure in the qualification capture. A live run through the orchestrator stopped at `agent.max_tokens` from the journal's figure. On a launch over SSH the journal is read on the worker host, and the scripted runs reported the figures that local runs did.

Each run also records two amounts in the runtime's own units, as the `copilot-cli` kind does:

| Unit | Source |
|---|---|
| `premium requests` | The record's multiplier, counted for a request the user initiated. A request an agent or subagent initiated counts as zero. A record with another initiator, or none, leaves the amount a lower bound. |
| `AI credits` | The record's `totalNanoAiu` divided by 10^9, whatever initiated the request. |

Neither amount converts to tokens or to dollars, and no token or dollar ceiling counts them. A cancelled turn is measured, because the route cancels in the protocol and keeps the process alive. A turn the runtime kills can end with no figure: its amount is unknown, not zero, because the runtime writes its journal late. A read of the journal that fails leaves a settled turn without its split by serving model, so that share is unpriced. [How Sortie measures spend](/concepts/spend-measurement/) explains provenance and lower bounds, and [how to control costs](/guides/control-costs/) covers the ceilings.

---

## Usage limits

When a turn that reached the runtime ends, Sortie pulls the monthly quotas of the signed-in GitHub account and reports them to the dashboard and to `rate_limits` in [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state). A cancelled turn pulls nothing, and neither does the credential-verification session. The mechanism shared with other runtimes is under [usage limits](/reference/adapter-agent-client-protocol/#usage-limits) on the kind's page.

The pull reads the first of the three token variables in the runtime's launch environment and asks GitHub. Without a token, or when GitHub answers `401`, `403` or `404`, Sortie starts a one-shot headless server of the CLI and asks it. That command is `agent.command` cut after the `copilot` word: `--acp` and every word after it are dropped, and a launcher, `env` assignments or a path before the word stay. GitHub's request leaves Sortie's host, also for an SSH session; the headless server runs on the worker host. The protocol's own channel carries no quota, so this pull is the only window source.

| Quota | Label |
|---|---|
| Premium requests | `Monthly premium request limit` |
| Chat | `Monthly chat limit` |
| Completions | `Monthly completion limit` |

A quota with no limit is not reported, and the quotas carry no status. A session with `COPILOT_PROVIDER_BASE_URL` set pulls nothing, because a custom provider spends no Copilot quota. An answer such as `Not authenticated` means the runtime holds no GitHub sign-in of its own and ends the session's pulls.

### Usage-limit refusals

A provider refusal arrives as a `session.error` event whose type is `quota` or `rate_limit`. The runtime sends the event only to a client that subscribed to it in `initialize`, and then ends the turn with a normal stop reason, which would read as success. Sortie subscribes only when `agent.command` names the `copilot` executable or the `@github/copilot` package. Behind a wrapper script that names neither, a refused turn reads as a successful one.

With the subscription in place, the turn ends as a usage-limit refusal, and the hold covers the model named by `agent-client-protocol.model` when that is set. A `quota` refusal waits for the latest reset among the exhausted windows of the pull that follows the turn; a window with no future reset leaves the refusal with no reset time, retried on the exponential backoff. A `rate_limit` refusal has no window and retries on the same backoff. Any other error type leaves the turn's outcome as it was. A refusal that the runtime follows with an automatic switch to another model was not observed, and a turn that switches and finishes would read as refused.

---

## Session behavior

A continued session loads the earlier session by its identifier in a fresh process, and the recall turn returns what the seed turn asked it to remember. The runtime's handshake advertises `close` and `list` in its session capabilities, and no `resume`. A load within the UTC minute in which the runtime created the session waits up to a minute. The runtime offers no way to delete a session, so the conversation of each credential-verification request stays in its store; the `copilot-cli` kind removes it.

| Case | What Sortie sees |
|---|---|
| A model endpoint fails, or the prompt exceeds the model's budget | The runtime renders the error as agent text beginning `Error:` and ends the turn with a normal stop reason. Nothing on the wire marks the failure, so Sortie records a completed turn. The `copilot-cli` kind sees exit status 1 instead. |
| The model declines a request | The turn ends normally and the refusal is the model's own prose. No `turn_refused` outcome was produced. |
| A model id the runtime's multiplier table does not know | The runtime prints a notice, "Warning: No token count multiplier is known", as agent text before the first usage report. |
| A tool call asks for permission | See [the permission posture](#the-permission-posture). |
| The runtime process dies | The attempt fails as a transport loss and is retried. |

Cancellation passes on this route: the turn ends as cancelled after Sortie cancels it in the protocol. Live qualification on Windows was not observed.

---

## Compared with the `copilot-cli` kind

The comparison rests on the qualification of this route and on the earlier kind's own behavior. A row marked "not observed" has no measurement behind it in either direction.

### What this route delivers that the kind does not

| Capability | This route | The `copilot-cli` kind |
|---|---|---|
| Process model | One process for the session | One process per turn |
| Spend of a cancelled turn | Measured | Can end with no figure |
| Outcome of a cancellation | Reported: the turn ends as cancelled after Sortie cancels it in the protocol | The stream writes its terminal event at exit, so it reports no cancellation |

### What the kind delivers that this route does not

| Capability | Status on this route |
|---|---|
| `max_autopilot_continues` | No carrier |
| `--autopilot` and the outcome `turn_incomplete` | No carrier. The `mode` option may offer it; not observed. |
| `no_custom_instructions` | No carrier. Instruction files load. |
| A tool call outside an `--allow-tool` rule is denied and the turn goes on | The turn ends with no follow-up model request |
| An endpoint failure ends the process with exit status 1 and an error on standard error | The runtime renders the error as agent text and ends the turn normally, so Sortie records a completed turn |
| A named agent that does not exist fails the run | The run continues on the current agent with a warning |
| Credential variables carried over SSH by declaration | Named in `worker.ssh_pass_env` |
| Verification conversation deleted | Stays in the runtime's store |
| Stdio tool servers through `mcp_config` | Through `--additional-mcp-config @<file>` in `agent.command` |
| Run history under the kind `copilot-cli` | Runs record as `agent-client-protocol`, beside every other runtime on that kind. The `copilot-cli` series ends at the move, and the by-model table continues only where both kinds record the same model name. |

### Equal on both routes

| Capability | Result |
|---|---|
| Spend by serving model, locally and over SSH, in tokens, premium requests and AI credits | The same units from the same journal records. |
| Provider usage windows | The same pull. |
| Usage-limit refusal | The same event and parser. This route needs `agent.command` to name the runtime. |
| Tool-server delivery of Sortie's own tools | Delivered locally and over SSH. |
| Session continuation | Restores the session and its memory. |
| `model`, `effort`, `denied_tools`, `available_tools`, `excluded_tools`, `disable_builtin_mcps` | A switch in `agent.command`, measured to take effect. |
| Asking the user | No asking path appeared. |

### Not observed

- A token credential, a refused credential, or a host with no sign-in on the credential-verification step of this route.
- What a turn reports when it reaches a continuation ceiling, and whether the `mode` option delivers autopilot.
- The effect of `--experimental` itself.
- The tools and the model of a named agent profile.
- Whether a tool-server member that `mcp_config` refuses reaches the runtime through `--additional-mcp-config @<file>`.
- The `agent-client-protocol.permissions` setting and the `effort` key against Copilot CLI.
- Anything on Windows.

---

## Related pages

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the runtime-neutral transport this page assumes
- [How to run Copilot CLI in ACP mode](/guides/run-copilot-cli-in-acp-mode/): converting a `copilot-cli` workflow, with the setting-by-setting table
- [Copilot CLI adapter reference](/reference/adapter-copilot/): the deprecated hand-written kind
- [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/), [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/) and [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/): the other runtimes on the same route
- [WORKFLOW.md configuration reference](/reference/workflow-config/#agent-client-protocol): the `agent-client-protocol` block
- [How Sortie measures spend](/concepts/spend-measurement/) and [how to control costs](/guides/control-costs/)
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
