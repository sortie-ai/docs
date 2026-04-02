---
title: "Agent Communication | Sortie"
description: "Why Sortie uses two independent channels for agent-orchestrator communication: MCP tool calls for data access and .sortie/status files for control-flow signals. Design rationale, failure modes, and the agent-agnostic principle."
keywords: sortie agent communication, MCP tools, .sortie/status, agent-to-orchestrator protocol, data plane, control plane, agent-agnostic, defense in depth
author: Sortie AI
---

# How agents communicate with the orchestrator

Sortie gives agents two ways to talk back to the orchestrator during a session. Not one. Two. They look redundant until you understand what each one does and why neither can do the other's job.

The first channel is **MCP tool calls** — a request-response protocol where the agent asks for data and gets a structured answer back. "What comments are on this issue?" is a tool call. "What's my remaining turn budget?" is a tool call. The agent needs the response to continue working. This is the data plane.

The second channel is the **`.sortie/status` file** — a one-line file the agent writes to disk to advise the orchestrator about task feasibility. "I'm blocked, stop retrying me" is a status file. The agent doesn't need a response. It's sending a signal, not asking a question. This is the control plane.

These two channels are independent. They use different transports, operate at different times, serve different purposes, and fail in different ways. The rest of this document explains why that independence is the point.

## Both channels in one session

Imagine Sortie dispatches an agent to work on PROJ-42, a bug fix. The agent calls `tracker_api` to read comments on the issue — an MCP tool call that travels over stdio to the `sortie mcp-server` sidecar, hits the tracker adapter, and returns JSON. The agent finds a comment: "Blocked on API key from the infra team — don't start until we have credentials."

The agent can't proceed. It writes one word to `.sortie/status`:

```
blocked
```

The turn completes. Sortie reads the file, sees `blocked`, and stops scheduling retries for PROJ-42. The issue sits until a human resolves the dependency.

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

During the session, the agent talks to the MCP server over a stdio pipe. `tools/list` returns what's available — `tracker_api`, `sortie_status`, `workspace_history`. `tools/call` executes a tool and returns a JSON result. The agent uses these responses to inform its work: reading issue comments before writing code, checking turn budget before attempting a large refactor.

Why MCP instead of a custom protocol, HTTP, or adapter-specific hooks? MCP is the standard tool protocol for coding agents. Claude Code, Copilot CLI, and others support it natively. Sortie works with any MCP-compatible agent without adapter-specific integration code in the orchestrator core. Stdio transport means no ports, no firewalls, no URL configuration — the agent and MCP server communicate through a pipe on the same host.

When the MCP server crashes, the agent runtime detects a broken pipe and gets errors on subsequent tool calls. The worker doesn't know about the crash because it didn't spawn the MCP server. Existing error paths handle the outcome: if the agent terminates abnormally, the worker sees a non-zero exit and retries per normal policy.

## Control plane: the `.sortie/status` file

The file protocol is deliberately minimal. The agent writes a single recognized token — `blocked` or `needs-human-review` — to `.sortie/status` in the workspace. Sortie reads this file once, after the turn completes and before the retry decision. If the file says `blocked`, Sortie does not schedule another attempt. The issue sits until a human changes its tracker state.

Timing matters. Sortie reads the file *after* the agent process exits, eliminating race conditions. The read happens *before* the tracker API call, avoiding a wasted request for an issue the agent already declared blocked.

If the file is missing, empty, or contains an unrecognized value, Sortie proceeds normally — retry as configured. Every failure mode degrades to "keep going." A corrupt file, a permission error, a future agent writing a value today's Sortie doesn't recognize — all resolve to the same safe default.

Why a file and not a process signal, exit code, or environment variable?

**Files persist.** If Sortie restarts between the agent writing and the orchestrator reading, the signal is still on disk.

**Files are inspectable.** `cat .sortie/status` shows what the agent reported. No special tooling needed.

**Files are universal.** Every OS, every language, every shell can write a file. Exit codes don't work because LLM-based agents can't control their host process's exit code. Environment variables don't cross process boundaries.

The file is advisory, not authoritative. The agent can't force the orchestrator to stop or change behavior — it can only advise. This prevents a malfunctioning agent from hijacking orchestrator control flow. A compromised agent writing `blocked` to every workspace causes the orchestrator to stop retrying those issues, which is correct behavior. The remedy is to investigate, fix the agent, and re-dispatch.

Before each new dispatch, Sortie deletes any existing `.sortie/status` file. Stale signals never leak between sessions.

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
| Signal "I'm blocked" | `.sortie/status` file | One-way advisory, survives MCP failure |
| Signal "ready for review" | `.sortie/status` file | Same mechanism, different semantic value |

The rule of thumb: if the agent needs a response, use a tool. If the agent is sending a signal about its own state, use the file.

Both channels exist because the design optimizes for resilience over simplicity. Two channels means two things to learn — that's a real cost. It's worth paying because the alternative is a single channel where a crashed MCP server means the agent can't say "I'm stuck," or where a full disk means the agent can't read issue comments. Independent failure modes keep the system functional when pieces break. And in a system that runs autonomous agents on production codebases, pieces will break.

## Further reading

- [Agent extensions reference](../reference/agent-extensions.md) for tool schemas, file protocol values, and response formats
- [Use agent tools in prompts](../guides/use-agent-tools-in-prompts.md) for practical prompt template patterns
- [Orchestration](orchestration.md) for retry strategies and reconciliation
- [Security model](security.md) for trust boundaries and prompt injection
- [Architecture overview](architecture.md) for the adapter-agnostic design principle
- [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) for the full normative spec including design rationale and alternatives analysis
- [ADR-0009: MCP stdio sidecar](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0009-mcp-stdio-sidecar-for-tool-execution.md) for the execution channel design decision
