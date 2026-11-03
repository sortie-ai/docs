---
title: "Agent Communication"
description: "Why Sortie splits agent communication into two channels: MCP tool calls for data and .sortie/status files for control signals. Rationale and trade-offs."
author: Sortie AI
date: 2026-04-03
weight: 50
---
Sortie gives agents two ways to talk back to the orchestrator during a session. Not one. Two. They look redundant until you understand what each one does and why neither can do the other's job.

The first channel is **MCP tool calls**: a request-response protocol where the agent asks for data and gets a structured answer back. "What comments are on this issue?" is a tool call. "What's my remaining turn budget?" is a tool call. The agent needs the response to continue working. This is the data plane.

The second channel is the **`.sortie/status` file**: a one-line file the agent writes to disk to advise the orchestrator about task feasibility. "I'm blocked, stop retrying me" is a status file. The agent doesn't need a response. It's sending a signal, not asking a question. This is the control plane.

These two channels are independent. They use different transports, operate at different times, serve different purposes, and fail in different ways. The rest of this document explains why that independence is the point.

There is also a third path, aimed elsewhere: the **`notify_operator` tool** sends a real-time notification to a human operator through channels the operator configured, such as a Slack webhook. It is a tool call by transport, but its audience is a person, not the orchestrator. The two channels to the orchestrator are still two; this one leaves the loop entirely. The same `notifications` list also carries messages that come from Sortie itself, such as a failed session, but those are not the agent talking.

All of this is the agent talking to Sortie or to a person. People talk to the agent too, by commenting on the issue, and that direction has its own path: Sortie reads the comments and puts the ones the agent has not been given into its next prompt. [Comments reach the agent in its prompt](#comments-reach-the-agent-in-its-prompt) explains how that path relates to the `tracker_api` tool.

## Both channels in one session

Imagine Sortie dispatches an agent to work on PROJ-42, a bug fix. The agent calls `tracker_api` to read the discussion on the issue, an MCP tool call that travels to the `sortie mcp-server` process, hits the tracker adapter, and returns JSON. The agent finds a comment: "Blocked on API key from the infra team. Don't start until we have credentials."

The agent can't proceed. It writes one word to `.sortie/status`:

```
blocked
```

The turn completes. Sortie reads the file, sees `blocked`, and stops scheduling retries for PROJ-42. The issue sits, marked with a label, until a human resolves the dependency.

The agent can also say why. Lines after the first one in the file are a stop statement, and Sortie can publish it with the stop: in a comment on the issue, in Slack, or to a webhook, depending on which events the operator routed where. A bare `blocked` tells the orchestrator what to do. The statement tells the person who finds the parked issue what they need to do.

The first action was data access: the agent needed information to decide. The second was a control signal: the agent communicated a decision. Data flowed through MCP. The signal flowed through the filesystem. Different transports, different times, different purposes.

## Why not one channel?

The obvious design question: why not make `blocked` a tool call? The agent already has an MCP connection. Add a `set_status` tool, let it call `set_status("blocked")`, and eliminate the file entirely. One protocol, one transport, one thing to learn.

The answer is the agent-agnostic principle. Sortie supports any coding agent: Claude Code, GitHub Copilot, future runtimes, or a shell script that runs `grep` and `sed`. MCP tool calls require the agent runtime to have an MCP client. Shell scripts don't. Narrow-purpose agents may skip MCP entirely. An agent whose MCP server crashes mid-session loses tool access for the rest of the turn.

The control signal, "I'm blocked, stop retrying me," is too important to gate behind MCP support. Any process that can write a file can send it:

```bash
mkdir -p .sortie && echo "blocked" > .sortie/status
```

No SDK, no protocol stack, no runtime dependency. If an agent can't do MCP, it doesn't get `tracker_api`, and that's fine. It can still write code, still signal when it's stuck. Graceful degradation, not all-or-nothing.

The [agent-to-orchestrator protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) evaluated six alternative signaling mechanisms: tracker-mediated writes, MCP sidecar calls, A2A protocol messages, Unix sockets, environment variables, and exit codes. File-based signaling was the only approach that satisfied all six design requirements simultaneously: agent-agnostic, fail-safe, advisory, zero-dependency, forward-compatible, and inspectable.

## Data plane: MCP tool calls

When Sortie dispatches an agent, the worker creates a `.sortie/mcp.json` configuration file in the workspace. This file declares the tool server: run `sortie mcp-server`, and pass environment variables for session context (issue ID, workspace path, database path, credentials).

What happens next depends on where the agent runs. On the orchestrator host the agent runtime reads the config, spawns the server as a child process, speaks MCP to it over stdio, and from that point owns the process. The worker has no direct relationship with the server: it created the config file and walked away. The worker manages the agent. The agent manages its tools.

An agent on an SSH worker host cannot run that server without receiving the tracker credential in the environment block, and Sortie does not copy the tracker credential to worker hosts. So the ownership flips. Sortie starts the server on the orchestrator host, speaking MCP over HTTP on a loopback port, and asks the SSH connection that launches the agent for a reverse forward: a port on the worker host's loopback interface that tunnels back to that server. The agent connects to its own `127.0.0.1` and reaches the tool server through the tunnel, presenting a bearer token generated for the session. The tracker credential stays where it was, and what reaches the worker host is a URL and a token that stop working when the session ends.

Something still has to point the runtime at the server, and that something is the adapter. Claude Code takes a configuration on `--mcp-config`, Copilot CLI on `--additional-mcp-config`. Two runtimes accept no such path at all, and there the adapter delivers the servers instead of the file, translating each one into the form that runtime does parse: Codex onto its own command line as configuration overrides, OpenCode into the configuration document it reads from the environment. The Agent Client Protocol adapter declares them in the session-creation request. Over SSH, the forward's port is known only after `sshd` allocates it, so the Claude Code, Copilot CLI, Codex, and OpenCode adapters place their configuration late, on the SSH connection's standard input, instead of in a file or on the `ssh` command line where any other user of the orchestrator host could read it.

The tunnel is a dependency the stdio path does not have. The worker host's `sshd` can refuse it, and an operator's tool server that runs as a local program has nothing to run on over there. Sortie treats both as a declared gap and not as a failure: a refused forward leaves the session working without Sortie's tools, and an `mcp_config` server of the stdio kind is left out while its HTTP siblings go through.

Which raises the question the rest of this design turns on: what should the prompt say to a session in that position? The honest answer is nothing. Sortie writes the tool advertisement into the first turn only for a session whose kind and launch mode actually deliver a channel. An agent that cannot call `tracker_api` is never told `tracker_api` exists.

The alternative (advertise to everyone, let the ones without a channel discover the truth by being refused) looks harmless and is not: the agent burns a turn on a call that cannot work, receives a refusal from its own runtime rather than from Sortie, and nothing in the logs or the run report explains why. A capability Sortie cannot deliver is one it does not name.

The rule has one limit: Sortie can withhold only what it knows it cannot deliver. It knows a refused forward, a runtime that accepts no HTTP server, and a runtime that never connects within `read_timeout_ms`. It cannot know about a runtime that connects and then declines to call a tool, which is the runtime's own approval policy at work. Kiro CLI in ACP mode shows the first case: under a stored device login its tools arrive; under an API key the runtime drops every declared tool server, and Sortie finds out only by the connection that never comes.

[Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/) covers which credential to use. [Delivery by agent kind](/reference/agent-extensions/#delivery-by-agent-kind) lists where each kind lands.

During the session, the agent talks to the MCP server over a stdio pipe. `tools/list` returns what's available: `tracker_api`, `sortie_status`, `workspace_history`, `cost_budget`, `notify_operator`. `tools/call` executes a tool and returns a JSON result. The agent uses these responses to inform its work: reading issue comments before writing code, checking turn budget before attempting a large refactor.

Why MCP instead of a custom protocol, HTTP, or adapter-specific hooks? MCP is the standard tool protocol for coding agents. Claude Code, Copilot CLI, and others support it natively. Sortie works with any MCP-compatible agent without adapter-specific integration code in the orchestrator core. Stdio transport means no ports, no firewalls, no URL configuration. The agent and MCP server communicate through a pipe on the same host.

When the MCP server crashes, the agent runtime detects a broken pipe and gets errors on subsequent tool calls. The worker doesn't know about the crash because it didn't spawn the MCP server. Existing error paths handle the outcome: if the agent terminates abnormally, the worker sees a non-zero exit and retries per normal policy.

## Comments reach the agent in its prompt

The data plane lets the agent pull: it asks `tracker_api` for the comments on its issue and reads whatever comes back. That works only if the agent thinks to ask. A person who writes "stop, use the v2 endpoint" on the issue while the agent is working has no way to know whether the agent will look.

So Sortie also pushes. At the start of every turn it reads the issue's comments and puts the ones the agent's conversation has not been given into the prompt. This covers the first turn of any run, every continuation turn, and every self-review turn, so a correction written during a run arrives with the next turn and does not wait for a later run. The comments need no template change: a prompt template that never mentions them still delivers them, because Sortie appends a block when the template did not place them. The feed is on by default, and [the `comment_feed` reference](/reference/workflow-config/#comment_feed) lists its keys. [Steer a running agent with issue comments](/guides/steer-agents-with-issue-comments/) is the task-oriented path.

Pull and push do different jobs. The push carries what changed since the agent last looked, so the agent does not poll for it and does not spend a turn on a call it forgot to make. The pull remains for everything else: the full thread, comments the agent wants to re-read, and any other tracker data. An agent whose runtime has no MCP client still receives comments, because the prompt is the one channel every agent has.

### Why at prompt boundaries

The prompt is the one input every agent runtime accepts from Sortie, and a turn is the unit in which the agent reads it. Inside a running turn the agent owns the conversation, and Sortie has no portable way to add text to it. Sortie does not interrupt the turn to inject a comment, since that would discard the work in progress and depend on what each runtime tolerates. A comment written mid-turn waits for the next prompt, so the delay is at most the length of the turn under way. In return, a delivered comment is always part of an ordinary prompt, handled by the same path as the rest of the prompt.

### Why once per conversation

Sortie records which comment, at which text, it handed to which conversation. A comment the conversation already holds is not sent again, also after a restart, because repeating it would make the agent answer the same instruction twice and would grow every prompt by the whole thread. The unit is the conversation and not the run: a retry that resumes the agent's session continues the same conversation, so the agent already has everything it was given. A comment whose text changes is delivered again in full and marked as replacing the earlier version, since the agent holds the old words and needs the correction. A deleted comment is ignored, because the agent cannot unlearn it and Sortie has no retraction to send; a person who withdraws an instruction says so in a new comment.

### Why a new session receives earlier comments again

A new session starts with no memory. That happens when no session was resumed, when the runtime had no session under the saved identifier, or when the agent kind cannot continue one. Whatever earlier sessions on the issue were told is gone from the agent's point of view, and the instructions people wrote as comments are part of what the work was asked to do. Sortie therefore hands such a session the comments earlier sessions were given, in a group of their own, at their current text, ahead of the new ones. The agent can tell what it is reading: comments an earlier session already acted on, and comments it has not seen. Whether a session carries its history is established from the runtime's own answer to the resume request, which is why a resume the runtime refused counts as a new session.

### Why Sortie leaves its own comments out

Sortie posts comments to the tracker, such as the stop comment of a parked issue. Sortie records the identifier of each comment it posts and never feeds those back. Matching on author or text would also drop a person's comment that quotes one. A comment the agent posts with its own tracker tool is a different case: Sortie did not write it and cannot tell it from a person's comment when both come from the same account, so it is delivered like any other.

### Who is allowed to steer

A delivered comment becomes part of a prompt for an agent that holds the operator's credentials, so the feed does not accept text from everyone by default. On a public project any account can comment. [Security model](/concepts/security/) explains the trust boundary a comment crosses and why the default delivers only people with write access.

A comment can also fail to arrive for a mundane reason: the tracker read failed, so the turn went out without comments and the next turn reads again. The feed never fails a turn.

## Control plane: the `.sortie/status` file

The file protocol is deliberately minimal. The agent writes a single recognized token to `.sortie/status` in the workspace: `blocked`, `needs-human-review`, or `no-change-needed`. Sortie reads this file after every turn, and again inside the self-review phase, not once at the end of the run.

If the file says `blocked`, Sortie does not schedule another attempt. Where the dispatch drives the issue's state, Sortie parks the issue instead of merely releasing it, attaching a label so it can be told apart from an abandoned one.

The park lifts when a person moves the issue to a tracker state different from the one it was parked in, when a person removes the label and Sortie has confirmed on a later fetch that the removal actually reached the tracker, or when a later run for the issue produces observable work. A `tracker.query_filter` that hides issues carrying the label does not change this: Sortie reads every parked issue the candidate query leaves out directly, state and labels both, so it confirms the label and sees its removal the same way.

When a person releases the park by moving the issue or removing the label, their answer reaches the agent on the issue's next run. Sortie reads the issue's comments first, and a failed read holds the issue for a later poll, so a run never starts with half the picture. The run then picks up the agent's earlier session when the agent supports resuming, the run the park follows ended normally, and the issue is dispatched to the same agent kind and template, so the agent still has its own conversation; otherwise it starts a fresh session and the hand-over is all it has. Either way its first prompt can render the [`park` variable](/reference/workflow-config/#park): the statement the agent gave when it stopped, how the person released the issue, and the comments the agent has yet to see. The person answers in a comment, and Sortie needs no special format. The stop comment Sortie itself posted is never among them, because the statement already arrives on its own and the agent should not read it twice. A park that lifts because a later run produced observable work had no person answering, so it hands nothing over. For a template that uses the answer, see [hand the agent a person's answer after a park](/guides/write-prompt-template/#hand-the-agent-a-persons-answer-after-a-park).

The answer does not depend on the template. With the [comment feed](/reference/workflow-config/#comment_feed) on, which is the default, a template that never mentions the `park` variable still delivers the person's comment in the first prompt, through the same block that carries every other comment. See [Comments reach the agent in its prompt](#comments-reach-the-agent-in-its-prompt).

If the file says `needs-human-review`, Sortie treats the work as finished: it runs the configured self-review phase first, where self-review is enabled, and only then transitions the issue to the configured handoff state in the tracker, so the team sees completed work waiting for review.

If the file says `no-change-needed`, the agent is stating that the outcome the issue asked for already held and it changed nothing to reach it. That runs through the same self-review phase, which is what can falsify the claim, and it moves the issue to a `tracker.no_change_state` if one is configured, rather than the ordinary handoff state, so a run with no pull request and no diff need not put an issue in front of a reviewer with nothing to look at.

All three values stop the retry loop. The difference is what happens to the issue in the tracker on the way out.

A session dispatched by applying a [label command](/reference/label-commands/) to a pull request has no linked issue state to drive: it releases its claim on a blocked signal instead of parking, and it never enters the self-review phase.

Timing matters. Sortie reads the file *after* the agent process exits, eliminating race conditions. The read happens *before* the tracker API call, avoiding a wasted request for an issue the agent already declared blocked.

If the file is missing, empty, or contains an unrecognized value, Sortie proceeds normally: retry as configured. Every failure mode degrades to "keep going." The same safe default catches a corrupt file, a permission error, and a future agent writing a value today's Sortie doesn't recognize.

Why a file and not a process signal, exit code, or environment variable?

**Files persist.** If Sortie restarts between the agent writing and the orchestrator reading, the signal is still on disk.

**Files are inspectable.** `cat .sortie/status` shows a signal Sortie has not yet acted on. No special tooling needed.

**Files are universal.** Every OS, every language, every shell can write a file. Exit codes don't work because LLM-based agents can't control their host process's exit code. Environment variables don't cross process boundaries.

The file is advisory, not authoritative. The agent can't force the orchestrator to stop or change behavior. It can only advise. This prevents a malfunctioning agent from hijacking orchestrator control flow. A compromised agent writing `blocked` to every workspace causes the orchestrator to stop retrying those issues, which is correct behavior. The remedy is to investigate, fix the agent, and re-dispatch.

Before each new dispatch, Sortie deletes any existing `.sortie/status` file. Stale signals never leak between sessions. Sortie also deletes it during a run, at each point where it acts on a recognized value, so what sits on disk is what the agent has said since rather than a signal already answered. The [agent extensions reference](/reference/agent-extensions/#cleanup-and-protection) names those points, and the one read that leaves the file in place.

## Agent to operator: notify_operator

The two channels above terminate at the orchestrator. The `notify_operator` tool is different: it rides the data plane's transport, an MCP tool call into the `sortie mcp-server` process, but the destination is outside the orchestration loop. The sidecar posts the notification to channels the operator configured in WORKFLOW.md, such as a Slack incoming webhook or a generic HTTP endpoint. The audience is a human.

Orchestration does not react. A notification suppresses no retry, performs no tracker transition, releases no claim. Sortie treats it as what it is: a message to a person who may act on it.

The agent supplies the content and never chooses where it goes: the operator's configuration decides which destinations receive agent messages, and none of them is the tracker issue. The tool exists only when at least one notifications entry receives agent messages; otherwise it is not registered and the agent never sees it.

Because it shares the MCP transport, it shares the data plane's failure mode: a crashed tool server takes notifications down with the tools. An agent that is blocked should therefore do both, in this order: call `notify_operator` so a human hears about it now, then write `.sortie/status` so the retries actually stop. The file survives an MCP crash, and it is the only signal the orchestrator acts on.

See the [agent extensions reference](/reference/agent-extensions/) for the tool schema and delivery behavior, and [how to route Sortie's events](/guides/route-notifications/) for choosing what each destination receives.

## Defense in depth

The independence of these two channels is a safety property, not an accident of implementation.

If the MCP server crashes, the agent loses tool access: no more `tracker_api` queries, no more `sortie_status` checks. But the agent can still write `.sortie/status` to disk. The control signal survives data plane failure.

If the workspace filesystem is read-only or the disk is full, the agent can't write `.sortie/status`. But MCP tool calls still work because they travel over a stdio pipe, not through the filesystem. Data access survives control plane failure.

Neither channel is a single point of failure for the other. This mirrors the separation in the architecture between the tool subsystem and the agent-authored workspace files. The boundary is deliberate and enforced: tool calls cannot write to `.sortie/status`, and the file protocol cannot trigger tool execution. No crosstalk, no shared failure modes.

How does this compare to other systems? Symphony, OpenAI's orchestrator for Codex, uses the Codex app-server's bidirectional JSON-RPC protocol for both data access (`linear_graphql` tool) and control flow (tracker state transitions via tool calls). Everything goes through one pipe. This works because Symphony controls both ends of the protocol: it built the agent runtime and the orchestrator, so it can guarantee the pipe is always available.

Sortie can't take this approach. It doesn't control the agent runtime. It doesn't control the protocol. An agent-agnostic orchestrator can't route critical control signals through a channel that depends on the agent's protocol implementation.

## When to use which

If you're writing workflow prompts or building a custom agent, the decision framework is straightforward:

| You want to... | Use | Why |
|---|---|---|
| Query tracker data | `tracker_api` tool | You need a structured response to act on |
| Learn what people commented since the agent last looked | Nothing to call: Sortie puts the comments in the prompt | The [comment feed](/reference/workflow-config/#comment_feed) pushes them at each turn, with no template change |
| Check remaining turn budget | `sortie_status` tool | You need the data during the turn to plan work |
| Review prior run outcomes | `workspace_history` tool | You need history to avoid repeating mistakes |
| Escalate a decision to a human mid-session | `notify_operator` tool | The human needs to know now; the orchestrator does not act on it |
| Report progress on a long task | `notify_operator` tool | Fire-and-forget to a configured channel |
| Signal "I'm blocked" | `.sortie/status` file | Parks the issue with a label; one-way advisory, survives MCP failure. Lines after the value can say why |
| Signal "ready for review" | `.sortie/status` file | Same file, but runs self-review first, then triggers [handoff transition](/reference/agent-extensions/) when configured, or moves the issue to the next [stage](/concepts/stage-chains/) when its rule has one |
| Signal "nothing needed changing" | `.sortie/status` file | Same file, runs self-review first (which can retract the claim), then targets `tracker.no_change_state` where configured instead of the ordinary handoff state, or moves the issue to the next stage like "ready for review" |

The rule of thumb: if the agent needs a response, use a tool. If the agent is sending a signal about its own state, use the file. If a human needs to know, use `notify_operator`.

Both channels exist because the design optimizes for resilience over simplicity. Two channels means two things to learn. That's a real cost. It's worth paying because the alternative is a single channel where a crashed MCP server means the agent can't say "I'm stuck," or where a full disk means the agent can't query its tracker. Independent failure modes keep the system functional when pieces break. And in a system that runs autonomous agents on production codebases, pieces will break.

## Further reading

- [Agent extensions reference](/reference/agent-extensions/) for tool schemas, file protocol values, and response formats
- [Use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for practical prompt template patterns
- [Steer a running agent with issue comments](/guides/steer-agents-with-issue-comments/) for talking to the agent through the issue
- [Orchestration](/concepts/orchestration/) for retry strategies and reconciliation
- [Security model](/concepts/security/) for trust boundaries and prompt injection
- [Architecture overview](/concepts/architecture/) for the adapter-agnostic design principle
- [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) for the full normative spec including design rationale and alternatives analysis
- [ADR-0009: MCP stdio sidecar](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0009-mcp-stdio-sidecar-for-tool-execution.md) for the execution channel design decision
