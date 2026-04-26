---
title: "Architecture"
description: "Sortie architecture: single Go binary, adapter-based extensibility, SQLite persistence, and spec-first development as an agent orchestrator."
keywords: sortie architecture, design decisions, autonomous coding agent, agent orchestration, Go single binary, SQLite, adapter pattern, workspace isolation
author: Sortie AI
date: 2026-03-29
weight: 10
---
Sortie orchestrates autonomous coding agents against issue trackers. This document explains the design decisions behind it — what trade-offs were made, what alternatives were rejected, and why the system works the way it does. If you're evaluating Sortie for your team or planning to contribute, this is where you build the mental model.

## One binary, zero dependencies

The single most consequential design choice in Sortie is the deployment model: one statically-linked binary, no runtime dependencies, no external services. You copy a file to a machine and run it. That's the entire deployment story.

This drove the choice of Go over Node.js, Python, Elixir, and Rust. Go produces a static binary with cross-compilation built in. Goroutines map naturally to the orchestrator's workload — one per agent session, coordinated through channels, with `context.Context` cancellation propagating through process trees. Fast startup matters because Sortie is a daemon: you want it running in seconds, not minutes.

The alternatives had real strengths. Elixir's OTP supervision trees are arguably the best fit for this workload — OpenAI's Symphony reference implementation uses Elixir for good reason. But the Elixir ecosystem is small, and LLM code generation quality for Elixir trails Go and TypeScript significantly. That matters when coding agents write and maintain the codebase. Node.js has the strongest AI generation quality today, but its single-threaded event loop serializes all orchestration logic: heavy JSON parsing or token accounting would block stall detection and reconciliation. Rust offers superior safety guarantees but creates long iteration cycles for agent-written code. Go's uniformity — `gofmt`, one error-handling idiom, minimal stylistic variation — partially compensates for lower generation quality by reducing the space for inconsistent output.

The zero-dependency constraint extends to persistence. Sortie uses SQLite as its only storage layer — no Postgres, no Redis, no message queue. Operators should not need to provision infrastructure to run an orchestration tool. An orchestrator that requires a running database server contradicts the single-binary philosophy.

The specific SQLite library matters too. Sortie uses `modernc.org/sqlite`, a pure Go transpilation of the SQLite C source. The more popular `mattn/go-sqlite3` uses CGo, which breaks cross-compilation, complicates CI pipelines, and requires a C toolchain on the build host. The trade-off is slight performance overhead from the transpilation layer. For a single-instance orchestrator with write patterns measured in dozens of transactions per minute, that overhead is invisible.

The consequence of these choices is that multi-instance coordination is a non-goal. SQLite serializes all writes through a single connection. Sortie targets single-instance deployments where that serialization is not a bottleneck.

## Adapters all the way down

Sortie's orchestrator core knows nothing about Jira, GitHub Issues, Claude Code, or Copilot CLI. It works with two Go interfaces: `TrackerAdapter` (read issues, check states, transition tickets) and `AgentAdapter` (launch sessions, stream events, cancel runs). This is not a feature — it's a foundational design choice that shapes every package boundary in the codebase.

The reason is stability. The tracker and agent landscapes are evolving fast. If Jira-specific field names or Claude Code CLI flags lived in orchestration logic, every new integration would require modifying the scheduler, the retry system, and the reconciliation loop. Instead, adapter packages translate between native APIs and domain types at the boundary. The orchestrator sees `Issue`, `Session`, and `Turn` — never tracker-specific or agent-specific names.

This extends to a strict naming rule: no `jira_*` or `claude_*` identifiers outside adapter packages. The domain layer uses generic vocabulary. This is enforced culturally, not by a linter, but it's a hard line. Leaking integration-specific concepts into the core is how orchestrators turn into unmaintainable messes.

The alternative considered was Go's plugin system for dynamic loading. Plugins would let third parties add adapters without recompiling Sortie. It was rejected because Go plugins have fragile ABI coupling (the plugin and the host must be built with the same Go toolchain version), they complicate the single-binary deployment model, and their platform support is limited to Linux and macOS. For the expected adapter count — a handful of trackers and a handful of agents — compile-time interfaces are the right abstraction. A contributor adding a GitHub Issues tracker writes one package implementing the `TrackerAdapter` interface without modifying any existing orchestration code.

Import dependencies flow in one direction: `domain ← config ← persistence ← adapters ← workspace ← orchestrator ← cmd`. The domain layer depends on nothing. Adapters depend on domain types. The orchestrator depends on adapter interfaces but never on adapter implementations. This layering is what makes additive extensibility possible — new adapters slot in without creating dependency cycles or touching core logic.

## The orchestrator owns the truth

Trackers have their own state models — Jira has workflow transitions, GitHub has project columns, Linear has statuses. These models differ in semantics, latency, consistency guarantees, and API behavior. Relying on tracker state for dispatch decisions would create race conditions and coupling. So the orchestrator maintains its own internal state: five orchestration states (`Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`) that are completely independent of whatever the tracker calls its statuses.

![Orchestration state machine](/img/orchestration-state-machine.svg)

The diagram above shows every path an issue can take through the orchestrator. Each transition is driven by a combination of an event and a condition evaluated at that moment:

| Event | Condition | Next state | Effect |
|---|---|---|---|
| Normal exit | Issue is active, `handoff_state` configured, transition succeeds | Released | Claim removed |
| Normal exit | Issue is active, `handoff_state` configured, transition fails | RetryQueued | Continuation retry after 1 s |
| Normal exit | Issue is active, no `handoff_state` configured | RetryQueued | Continuation retry after 1 s |
| Normal exit | Issue is not active | Released | Claim removed |
| Error exit | Error is retryable | RetryQueued | Exponential backoff |
| Error exit | Error is non-retryable | Released | Claim removed |
| Cancelled | No pre-scheduled retry exists | Released | Claim removed |
| Cancelled | Stall retry exists | RetryQueued | Claim preserved |
| Retry timer fires | Issue not found, terminal, or blocked | Released | Claim removed |
| Retry timer fires | No slots available | RetryQueued | Rescheduled for later |
| Retry timer fires | Effort budget exhausted (`max_sessions`) | Released | Claim removed |
| Retry timer fires | Issue is eligible | Running | Re-dispatched to agent |

The table captures a key design property: the orchestrator never silently drops work. Every exit path either explicitly releases the claim (removing the issue from orchestrator ownership) or queues a retry with a well-defined delay. There is no state where an issue is "lost" — stuck between active and released with no timer to resolve it.

When the orchestrator decides whether to dispatch an issue, it checks its own claim state and slot availability — not the tracker. The tracker is a read source for candidate issues, not a state store for scheduling decisions.

All state mutations flow through a single goroutine — no concurrent map access, no distributed locks. The orchestrator serializes every claim, dispatch, retry, and release through one authority. SQLite makes this state durable: retry queues, session metadata, and run history survive process restarts. When Sortie starts, it reconstructs timers from persisted timestamps and reconciles against the tracker before accepting new work. This is a key differentiator from Symphony, where all state lives in memory and a restart means a cold start from scratch.

The orchestrator reconciles its state against the tracker on every poll tick and handles failures with bounded retry strategies. See [Orchestration](/concepts/orchestration/) for the full model.

## Workspace isolation as a safety boundary

Every issue gets its own workspace directory: `<workspace_root>/<sanitized_identifier>/`. The agent process runs with its working directory set to this path. Before launching any agent, Sortie validates that the current working directory matches the workspace path. This is not a suggestion — it's a hard invariant enforced at the code level.

The safety model has three invariants. First, the agent's working directory must equal the workspace path. Second, the workspace path must be a child of the workspace root (absolute path normalization, prefix check). Third, the workspace directory name uses only `[A-Za-z0-9._-]` characters — everything else is replaced with underscore. Together, these prevent path traversal attacks and directory injection. An issue identifier crafted to include `../` or shell metacharacters cannot escape the workspace root.

Workspaces persist across sessions. If an agent fails and Sortie retries the issue, the retry runs in the same directory. This lets agents build on previous work — partial commits, cached dependencies, compilation artifacts — without starting from scratch. Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`) let operators customize the setup without modifying Sortie's code. The common pattern is `after_create` cloning a repository and `before_run` pulling the latest changes.

Sortie does not sandbox the agent. This is a deliberate design choice, not an oversight. Prescribing a single sandbox model — containers, VMs, restricted users, seccomp profiles — would limit the environments where Sortie can run. A developer's laptop has different constraints than a locked-down CI server. Sortie provides [workspace isolation](/concepts/isolation/) and path validation as baseline controls. Stronger sandboxing is deployment-specific, left to the operator who understands their threat model. The [security model](/concepts/security/) covers hardening guidance for operators who need stronger guarantees.

## The spec is the product

Sortie is developed spec-first. The architecture document defines every entity, state machine, algorithm, and validation rule. Any code that drifts from the spec is a bug, not a creative interpretation.

This is unusual for open-source projects but essential for an orchestrator. State machine correctness in Sortie is a safety concern, not an aesthetic preference. A bug in the retry logic could mean an agent retrying the same destructive operation indefinitely. A flaw in reconciliation could mean agents running against issues that humans already resolved. When you manage autonomous agents touching production codebases, you need the kind of rigor that comes from writing the spec first and coding against it, rather than evolving behavior through ad-hoc commits.

Every non-trivial design change goes through a formal Architecture Decision Record. The ADR documents context, decision, alternatives considered, and consequences. Eight ADRs cover the major decisions: Go as the runtime, SQLite for persistence, adapter interfaces for extensibility, YAML front matter for workflow files, Go `text/template` for prompt rendering, `fsnotify` for file watching, orchestrator-initiated handoff transitions, and the observability model. Each ADR names the rejected alternatives and explains why. This transparency is the project's institutional memory — when a future contributor asks "why not just use Postgres?", the answer is written down with full reasoning, not buried in a Slack thread.

The trade-off is speed. Spec-first development is slower for shipping features. You write the behavior down before you write the code, then you verify the code matches the behavior. For a CRUD app, that's overkill. For a system that dispatches autonomous agents with retry logic and concurrent state management, it's the cost of correctness.

## What Sortie does not do

The clearest way to understand a system's architecture is to understand its boundaries. Sortie has explicit non-goals that shape every design decision.

**Not an agent quality tool.** The quality of an agent's output — whether it writes correct code, follows style conventions, produces meaningful commit messages — is a function of the agent's system prompt, tool permissions, model capabilities, and the repository-level configuration files (`CLAUDE.md`, `AGENTS.md`, agent skills) that the team maintains. Sortie renders the WORKFLOW.md prompt template and passes it to the agent verbatim. It does not inject hidden instructions, filter agent output, or evaluate code quality. If your agent produces poor results when you run it manually in a terminal, Sortie will automate that poor result at scale. The right sequence is to validate that your agent produces satisfactory work on representative issues first, then let Sortie handle scheduling and lifecycle. This is the same separation of concerns as every other infrastructure tool: a CI system does not fix your tests, a container orchestrator does not fix your application, and Sortie does not fix your agent.

**Not a multi-tenant control plane.** One Sortie instance manages one workflow against one project. There's no user management, no tenant isolation, no shared database. If you need multiple workflows, you run multiple instances. This keeps the core simple and avoids the accidental complexity of multi-tenancy.

**Not a general workflow engine.** Sortie orchestrates coding agents against issue trackers. It does not run arbitrary DAGs, fan-out/fan-in pipelines, or approval chains. If you need Temporal or Airflow, use Temporal or Airflow. Sortie solves one problem well rather than solving many problems poorly.

**The orchestrator owns lifecycle transitions.** A common alternative — used by OpenAI's Symphony — is to ask the agent to transition issues itself via a prompt instruction like "move this to In Review when done." This is fragile. The agent might misinterpret the instruction, lack API access, ignore it under token pressure, or target a status that doesn't exist in the tracker's workflow. When that fails, the issue stays in an active state and gets dispatched again indefinitely. Sortie avoids this by making lifecycle transitions the orchestrator's responsibility. The orchestrator calls the tracker API directly to move issues to in-progress on dispatch and to a handoff state (like "Human Review") on completion. It can also post brief comments at dispatch, completion, or failure. All of these are off by default and controlled through configuration. This keeps tracker transport on one side of the boundary — the orchestrator reads from and writes to the tracker; the agent works inside the workspace.

**No built-in sandbox.** Sortie provides [workspace isolation](/concepts/isolation/) and path containment. It does not provide process sandboxing, network filtering, or resource limits. Those are deployment-specific concerns that the operator controls.

These boundaries are load-bearing. Every feature request that conflicts with them gets evaluated against the core design — a single binary, adapter-based, spec-first orchestrator for coding agents. If the answer is "that requires a database server" or "that puts Jira field names in the scheduler," it doesn't belong in core.

## Further reading

- [State machine reference](/reference/state-machine/) for the full state diagram and transition table
- [Workflow file reference](/reference/workflow-config/) for all configuration fields and defaults
- [Jira adapter reference](/reference/adapter-jira/) for Jira tracker integration details
- [GitHub adapter reference](/reference/adapter-github/) for GitHub Issues integration details
- [Claude Code adapter reference](/reference/adapter-claude-code/) for agent integration details
- [Copilot CLI adapter reference](/reference/adapter-copilot/) for agent integration details
- [Codex adapter reference](/reference/adapter-codex/) for agent integration details
- [OpenCode CLI adapter reference](/reference/adapter-opencode/) for agent integration details
- [Security and operational safety](/concepts/security/) for hardening guidance
- [Architecture Decision Records](https://github.com/sortie-ai/sortie/tree/main/docs/decisions) for detailed rationale behind each major design choice
