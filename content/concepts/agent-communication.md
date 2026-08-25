---
title: "Agent Communication"
description: "Why Sortie splits agent communication into two channels: MCP tool calls for data and .sortie/status files for control signals. Rationale and trade-offs."
author: Sortie AI
date: 2026-04-03
weight: 50
---
Sortie gives agents two ways to talk back to the orchestrator during a session. Not one. Two. They look redundant until you understand what each one does and why neither can do the other's job.

The first channel is **MCP tool calls** — a request-response protocol where the agent asks for data and gets a structured answer back. "What comments are on this issue?" is a tool call. "What's my remaining turn budget?" is a tool call. The agent needs the response to continue working. This is the data plane.

The second channel is the **`.sortie/status` file** — a one-line file the agent writes to disk to advise the orchestrator about task feasibility. "I'm blocked, stop retrying me" is a status file. The agent doesn't need a response. It's sending a signal, not asking a question. This is the control plane.

These two channels are independent. They use different transports, operate at different times, serve different purposes, and fail in different ways. The rest of this document explains why that independence is the point.

There is also a third path, aimed elsewhere: the **`notify_operator` tool** sends a real-time notification to a human operator through channels the operator configured, such as a Slack webhook. It is a tool call by transport, but its audience is a person, not the orchestrator. The two channels to the orchestrator are still two; this one leaves the loop entirely.

## Both channels in one session

Imagine Sortie dispatches an agent to work on PROJ-42, a bug fix. The agent calls `tracker_api` to read comments on the issue — an MCP tool call that travels over stdio to the `sortie mcp-server` sidecar, hits the tracker adapter, and returns JSON. The agent finds a comment: "Blocked on API key from the infra team — don't start until we have credentials."

The agent can't proceed. It writes one word to `.sortie/status`:

```
blocked
```

The turn completes. Sortie reads the file, sees `blocked`, and stops scheduling retries for PROJ-42. The issue sits, marked with a label, until a human resolves the dependency.

The first action was data access — the agent needed information to decide. The second was a control signal — the agent communicated a decision. Data flowed through MCP. The signal flowed through the filesystem. Different transports, different times, different purposes.

## Why not one channel?

The obvious design question: why not make `blocked` a tool call? The agent already has an MCP connection. Add a `set_status` tool, let it call `set_status("blocked")`, and eliminate the file entirely. One protocol, one transport, one thing to learn.

The answer is the agent-agnostic principle. Sortie supports any coding agent — Claude Code, GitHub Copilot, future runtimes, or a shell script that runs `grep` and `sed`. MCP tool calls require the agent runtime to have an MCP client. Shell scripts don't. Narrow-purpose agents may skip MCP entirely. An agent whose MCP server crashes mid-session loses tool access for the rest of the turn.

The control signal — "I'm blocked, stop retrying me" — is too important to gate behind MCP support. Any process that can write a file can send it:

```bash
mkdir -p .sortie && echo "blocked" > .sortie/status
```

No SDK, no protocol stack, no runtime dependency. If an agent can't do MCP, it doesn't get `tracker_api` — and that's fine. It can still write code, still signal when it's stuck. Graceful degradation, not all-or-nothing.

The [agent-to-orchestrator protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) evaluated six alternative signaling mechanisms — tracker-mediated writes, MCP sidecar calls, A2A protocol messages, Unix sockets, environment variables, and exit codes. File-based signaling was the only approach that satisfied all six design requirements simultaneously: agent-agnostic, fail-safe, advisory, zero-dependency, forward-compatible, and inspectable.

## Data plane: MCP tool calls

When Sortie dispatches an agent, the worker creates a `.sortie/mcp.json` configuration file in the workspace. This file tells the agent runtime how to spawn the MCP server: run `sortie mcp-server` as a child process, communicate over stdio, and pass environment variables for session context — issue ID, workspace path, database path, credentials.

The agent runtime reads the config, spawns the sidecar, and from that point owns the MCP server process. The worker has no direct relationship with the MCP server — it created the config file and walked away. The worker manages the agent. The agent manages its tools. Clean ownership boundaries.

Something still has to point the runtime at that configuration, and that something is the adapter. Two of them hand over the file itself: Claude Code takes the path on `--mcp-config`, Copilot CLI on `--additional-mcp-config`. Two runtimes accept no such path at all, and there the adapter delivers the servers instead of the file, translating each one into the form that runtime does parse — Codex onto its own command line as configuration overrides, OpenCode into the configuration document it reads from the environment. The sidecar that ends up running is the same in all four cases. What differs is only the shape of the sentence that asks for it.

Translation buys reach at the cost of one boundary it will not cross. Both translated forms live in the launch itself, not in a file the remote host can be handed, so carrying them to an agent running over SSH would mean writing them into the remote command string — and that string is the local `ssh` process's own argument list, which every other user of the orchestrator host can read. The generated configuration carries the tracker credential. Sortie declines to publish it, so a Codex or OpenCode session dispatched to an SSH host reaches no tools at all.

Which raises the question the rest of this design turns on: what should the prompt say to a session in that position? The honest answer is nothing. Sortie writes the tool advertisement into the first turn only for a session whose kind and launch mode actually deliver a channel. An agent that cannot call `tracker_api` is never told `tracker_api` exists. The alternative — advertise to everyone, let the ones without a channel discover the truth by being refused — looks harmless and is not: the agent burns a turn on a call that cannot work, receives a refusal from its own runtime rather than from Sortie, and nothing in the logs or the run report explains why. A capability Sortie cannot deliver is one it does not name.

The same rule settles Kiro, for a different reason. Its runtime disables MCP outright under the unattended credential Sortie uses, so no delivery form would help; the advertisement is withheld there too. [Delivery by agent kind](/reference/agent-extensions/#delivery-by-agent-kind) lists where each kind lands.

During the session, the agent talks to the MCP server over a stdio pipe. `tools/list` returns what's available — `tracker_api`, `sortie_status`, `workspace_history`, `cost_budget`, `notify_operator`. `tools/call` executes a tool and returns a JSON result. The agent uses these responses to inform its work: reading issue comments before writing code, checking turn budget before attempting a large refactor.

Why MCP instead of a custom protocol, HTTP, or adapter-specific hooks? MCP is the standard tool protocol for coding agents. Claude Code, Copilot CLI, and others support it natively. Sortie works with any MCP-compatible agent without adapter-specific integration code in the orchestrator core. Stdio transport means no ports, no firewalls, no URL configuration — the agent and MCP server communicate through a pipe on the same host.

When the MCP server crashes, the agent runtime detects a broken pipe and gets errors on subsequent tool calls. The worker doesn't know about the crash because it didn't spawn the MCP server. Existing error paths handle the outcome: if the agent terminates abnormally, the worker sees a non-zero exit and retries per normal policy.

## Control plane: the `.sortie/status` file

The file protocol is deliberately minimal. The agent writes a single recognized token, `blocked` or `needs-human-review`, to `.sortie/status` in the workspace. Sortie reads this file after every turn, and again inside the self-review phase, not once at the end of the run. If the file says `blocked`, Sortie does not schedule another attempt. Where the dispatch drives the issue's state, Sortie parks the issue instead of merely releasing it, attaching a label so it can be told apart from an abandoned one. The park lifts when a person moves the issue to a tracker state different from the one it was parked in, when a person removes the label and Sortie has confirmed on a later fetch that the removal actually reached the tracker, or when a later run for the issue produces observable work. Where `tracker.query_filter` excludes the parking label, Sortie never confirms the label is present, so removing it releases nothing there; those issues need to be released by moving them instead. If the file says `needs-human-review`, Sortie treats the work as finished: it runs the configured self-review phase first, where self-review is enabled, and only then transitions the issue to the configured handoff state in the tracker, so the team sees completed work waiting for review. Both values stop the retry loop. The difference is what happens to the issue in the tracker on the way out.

A session dispatched by applying a [label command](/reference/label-commands/) to a pull request has no linked issue state to drive: it releases its claim on a blocked signal instead of parking, and it never enters the self-review phase.

Timing matters. Sortie reads the file *after* the agent process exits, eliminating race conditions. The read happens *before* the tracker API call, avoiding a wasted request for an issue the agent already declared blocked.

If the file is missing, empty, or contains an unrecognized value, Sortie proceeds normally — retry as configured. Every failure mode degrades to "keep going." A corrupt file, a permission error, a future agent writing a value today's Sortie doesn't recognize — all resolve to the same safe default.

Why a file and not a process signal, exit code, or environment variable?

**Files persist.** If Sortie restarts between the agent writing and the orchestrator reading, the signal is still on disk.

**Files are inspectable.** `cat .sortie/status` shows a signal Sortie has not yet acted on. No special tooling needed.

**Files are universal.** Every OS, every language, every shell can write a file. Exit codes don't work because LLM-based agents can't control their host process's exit code. Environment variables don't cross process boundaries.

The file is advisory, not authoritative. The agent can't force the orchestrator to stop or change behavior — it can only advise. This prevents a malfunctioning agent from hijacking orchestrator control flow. A compromised agent writing `blocked` to every workspace causes the orchestrator to stop retrying those issues, which is correct behavior. The remedy is to investigate, fix the agent, and re-dispatch.

Before each new dispatch, Sortie deletes any existing `.sortie/status` file. Stale signals never leak between sessions. Sortie also deletes it during a run, at each point where it acts on a recognized value, so what sits on disk is what the agent has said since rather than a signal already answered. The [agent extensions reference](/reference/agent-extensions/#cleanup-and-protection) names those points, and the one read that leaves the file in place.

## Agent to operator: notify_operator

The two channels above terminate at the orchestrator. The `notify_operator` tool is different: it rides the data plane's transport, an MCP tool call into the `sortie mcp-server` sidecar, but the destination is outside the orchestration loop. The sidecar posts the notification to channels the operator configured in WORKFLOW.md, such as a Slack incoming webhook or a generic HTTP endpoint. The audience is a human.

Orchestration does not react. A notification suppresses no retry, performs no tracker transition, releases no claim. Sortie treats it as what it is: a message to a person who may act on it. The tool also exists only when the operator configured at least one notification backend; with none configured, it is not registered and the agent never sees it.

Because it shares the MCP transport, it shares the data plane's failure mode: a crashed sidecar takes notifications down with the tools. An agent that is blocked should therefore do both, in this order: call `notify_operator` so a human hears about it now, then write `.sortie/status` so the retries actually stop. The file survives an MCP crash, and it is the only signal the orchestrator acts on. See the [agent extensions reference](/reference/agent-extensions/) for the tool schema and delivery behavior.

## Defense in depth

The independence of these two channels is a safety property, not an accident of implementation.

If the MCP server crashes, the agent loses tool access — no more `tracker_api` queries, no more `sortie_status` checks. But the agent can still write `.sortie/status` to disk. The control signal survives data plane failure.

If the workspace filesystem is read-only or the disk is full, the agent can't write `.sortie/status`. But MCP tool calls still work because they travel over a stdio pipe, not through the filesystem. Data access survives control plane failure.

Neither channel is a single point of failure for the other. This mirrors the separation in the architecture between the tool subsystem and the agent-authored workspace files. The boundary is deliberate and enforced: tool calls cannot write to `.sortie/status`, and the file protocol cannot trigger tool execution. No crosstalk, no shared failure modes.

How does this compare to other systems? Symphony, OpenAI's orchestrator for Codex, uses the Codex app-server's bidirectional JSON-RPC protocol for both data access (`linear_graphql` tool) and control flow (tracker state transitions via tool calls). Everything goes through one pipe. This works because Symphony controls both ends of the protocol — it built the agent runtime and the orchestrator, so it can guarantee the pipe is always available. Sortie can't take this approach. It doesn't control the agent runtime. It doesn't control the protocol. An agent-agnostic orchestrator can't route critical control signals through a channel that depends on the agent's protocol implementation.

## When to use which

If you're writing workflow prompts or building a custom agent, the decision framework is straightforward:

| You want to... | Use | Why |
|---|---|---|
| Query tracker data | `tracker_api` tool | You need a structured response to act on |
| Check remaining turn budget | `sortie_status` tool | You need the data during the turn to plan work |
| Review prior run outcomes | `workspace_history` tool | You need history to avoid repeating mistakes |
| Escalate a decision to a human mid-session | `notify_operator` tool | The human needs to know now; the orchestrator does not act on it |
| Report progress on a long task | `notify_operator` tool | Fire-and-forget to a configured channel |
| Signal "I'm blocked" | `.sortie/status` file | Parks the issue with a label; one-way advisory, survives MCP failure |
| Signal "ready for review" | `.sortie/status` file | Same file, but runs self-review first, then triggers [handoff transition](/reference/agent-extensions/) when configured |

The rule of thumb: if the agent needs a response, use a tool. If the agent is sending a signal about its own state, use the file. If a human needs to know, use `notify_operator`.

Both channels exist because the design optimizes for resilience over simplicity. Two channels means two things to learn — that's a real cost. It's worth paying because the alternative is a single channel where a crashed MCP server means the agent can't say "I'm stuck," or where a full disk means the agent can't read issue comments. Independent failure modes keep the system functional when pieces break. And in a system that runs autonomous agents on production codebases, pieces will break.

## Further reading

- [Agent extensions reference](/reference/agent-extensions/) for tool schemas, file protocol values, and response formats
- [Use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for practical prompt template patterns
- [Orchestration](/concepts/orchestration/) for retry strategies and reconciliation
- [Security model](/concepts/security/) for trust boundaries and prompt injection
- [Architecture overview](/concepts/architecture/) for the adapter-agnostic design principle
- [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) for the full normative spec including design rationale and alternatives analysis
- [ADR-0009: MCP stdio sidecar](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0009-mcp-stdio-sidecar-for-tool-execution.md) for the execution channel design decision
