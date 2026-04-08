---
title: "Adapter Model"
description: "How Sortie's adapter architecture makes agent and tracker integrations disposable while keeping the orchestration core stable."
keywords: sortie adapters, agent agnostic, tracker agnostic, adapter pattern, extensibility, autonomous coding agent orchestration, Go interfaces
author: Sortie AI
date: 2026-03-30
weight: 20
---

# How adapters make Sortie future-proof

The agent and tracker landscapes are churning. New autonomous coding agents ship monthly. Tracker APIs introduce breaking changes across versions. Teams switch tools — from Jira to Linear, from Claude Code to Codex — as the market evolves. An orchestrator that hardcodes integration logic into its scheduling core has a shelf life measured in months. The moment your preferred agent changes its CLI protocol or your team migrates trackers, you're refactoring orchestration internals.

Sortie's answer is two Go interfaces — `TrackerAdapter` and `AgentAdapter` — that form a hard boundary between the orchestration core and the outside world. The orchestrator works exclusively with domain types: `Issue`, `Session`, `Turn`, `AgentEvent`. It never touches a Jira field name, a GitHub REST endpoint, or a Claude Code JSONL message. Every integration-specific concept lives inside its adapter package and cannot leak out.

This is not a plugin architecture bolted on after the fact. It is a structural constraint that shaped the codebase from day one, and the distinction matters. Plugins are optional extensions. Adapter interfaces are load-bearing boundaries that the core depends on for every dispatch, every retry, and every reconciliation check. Remove the adapters and the orchestrator has no way to read issues or launch agents. The design forces every integration through the same contract, which is what makes the core stable enough to survive the integrations themselves being replaced.

The proof: when the GitHub Issues tracker adapter shipped in v1.1.0, it required zero changes to the orchestrator, the retry system, the reconciliation loop, or the persistence layer. One new package, implementing one existing interface. The scheduler didn't know anything had changed.

## What the TrackerAdapter contract looks like

Every issue tracker — Jira, GitHub Issues, Linear, GitLab — does the same five things differently. It stores issues with states and metadata. It lets you query for issues by state. It lets you transition issues between states. It lets you post comments. And it lets you check whether an issue still exists.

The `TrackerAdapter` interface captures these five capabilities in eight methods. Conceptually, they split into two groups: read operations (fetch candidates by state, fetch a single issue with comments, batch-fetch states for reconciliation) and write operations (transition an issue's state, post a comment). The interface does not prescribe how these operations happen internally — an adapter can use REST, GraphQL, a local filesystem, or carrier pigeons. The orchestrator sees the same `Issue` struct regardless.

The concrete differences between trackers are substantial. Jira uses JQL for querying and requires you to fetch available workflow transitions before moving a ticket — you can't transition to "In Review" without first asking Jira which transitions the issue's current state allows. GitHub Issues has only two native states (`open` and `closed`), so the GitHub adapter maps Sortie's orchestration states through labels: `sortie:active`, `sortie:done`, and their peers. Linear uses GraphQL and native named states. Each tracker has its own pagination model, its own error format, its own authentication scheme.

The adapter translates all of this into a common vocabulary. The orchestrator never needs to know that Jira's transition API is a two-step dance, or that GitHub state management works through label add/remove rather than workflow transitions. It calls `TransitionIssue`, gets back either success or a typed error, and moves on.

The error contract is the part that makes the retry system tracker-agnostic. Every adapter wraps failures in `TrackerError` with a typed `Kind`: `Transport`, `Auth`, `API`, `NotFound`, `Payload`. The orchestrator's retry logic handles each category uniformly — retry on transport failures, skip on auth, degrade gracefully on not-found — without inspecting error messages or HTTP status codes from specific tracker APIs. A network timeout from Jira's cloud API and a rate-limit response from GitHub's REST API both arrive as the same error shape. The retry system doesn't care which tracker produced them.

## What the AgentAdapter contract looks like

Agent adapters follow the same principle but face a different challenge. Trackers vary in their APIs; agents vary in their protocols and lifecycle models.

The `AgentAdapter` interface has four methods, organized around session lifecycle: `StartSession` launches or connects to an agent process in a workspace directory. `RunTurn` executes one prompt turn with event streaming. `StopSession` terminates the process cleanly. `EventStream` supports adapters that push events asynchronously (synchronous adapters return nil).

The harder problem is event normalization. Claude Code streams JSONL with dozens of message types — tool calls, approvals, errors, token usage, system notifications — each with its own structure. A future HTTP-based agent adapter might use Server-Sent Events with a completely different schema. The adapter normalizes everything into `AgentEvent`, a single type with an `EventType`, `TokenUsage`, `ToolName`, `Message`, and a handful of other fields. The orchestrator reacts to `turn_completed`, `turn_failed`, `token_usage` without knowing which agent produced them or what the native event format looked like.

There are roughly fourteen normalized event types — from `session_started` through `tool_result` to `malformed` — covering the full range of things an agent can do during a session. The adapter maps its native protocol onto this vocabulary. Events that don't fit any category land as `other_message` rather than being silently dropped.

Session state is deliberately opaque. The `Session` struct has an `Internal` field typed as `any`. The orchestrator carries it between `StartSession`, `RunTurn`, and `StopSession` but never reads it. The Claude Code adapter stores its subprocess PID and stdio pipes there. A future HTTP-based adapter might store a WebSocket connection handle. The orchestrator doesn't care, and this is the point — the `Internal` field is a pressure valve that lets adapters carry arbitrary state through the orchestrator's pipeline without the pipeline needing to understand it.

The practical consequence: when the Copilot CLI adapter shipped, the orchestrator launched, monitored, and retried Copilot sessions using the exact same code paths it uses for Claude Code. No new retry logic. No new stall detection. No new reconciliation rules. The stall detector checks "time since last `AgentEvent`" — it doesn't know or care whether that event came from a Claude Code JSONL stream or a Copilot CLI JSONL stream.

## The naming rule and why it prevents rot

The strictest convention in the codebase: no `jira_*`, `github_*`, `claude_*`, or `copilot_*` identifiers outside their respective adapter packages. The domain layer uses generic vocabulary — `Issue`, `Session`, `Turn`, `Comment`. The config layer uses `tracker.kind` and `agent.kind`, not `jira.project_key` or `claude_code.model`.

This is enforced culturally rather than by a linter, which might sound fragile. But the convention has teeth because it sits on top of a strict import dependency direction: `domain ← config ← persistence ← adapters ← workspace ← orchestrator ← cmd`. The domain layer depends on nothing. Adapters depend on domain types. The orchestrator depends on adapter interfaces but never on adapter implementations. A new adapter package cannot create a dependency cycle — Go's compiler enforces that.

The naming rule matters because integration-specific concepts leaking into the core is how orchestrators become unmaintainable. Once the scheduler knows about Jira workflow transitions, every new tracker must somehow map to Jira's model. Once the retry logic checks for Claude Code-specific error messages, every new agent must produce those same strings. The contamination is subtle — it starts with one convenience constant, then a special case in the dispatcher, then a conditional branch in the reconciler — and by the time you notice, the core has implicit assumptions about specific integrations baked into its logic. The naming rule is a firewall against that progression.

The consequence is that reading the orchestrator's source code tells you nothing about Jira or Claude Code. You see `Issue.State`, `TrackerAdapter.TransitionIssue`, `AgentAdapter.RunTurn`. The domain types carry the information the orchestrator needs to schedule, retry, and reconcile — nothing more. If you want to know how GitHub labels map to orchestration states, you look in `internal/tracker/github/`. If you want to know how Claude Code JSONL gets parsed, you look in `internal/agent/claude/`. The orchestrator package never contains that knowledge.

## Why not plugins

Go has a plugin system: `plugin.Open` loads shared objects at runtime. It was considered and rejected in ADR-0003. The reasons come down to the deployment model and the expected scale.

**ABI fragility.** A Go plugin and its host binary must be built with the exact same Go toolchain version. A mismatch — even a patch-level difference — crashes at load time. In practice, this means every plugin release must be coordinated with the host release, eliminating most of the flexibility that plugins are supposed to provide.

**Breaks the single-binary model.** Plugins are separate `.so` files. You go from "copy one file to a server" to "manage a directory of files with version compatibility requirements." The zero-dependency deployment story — Sortie's most distinctive operational property — would be lost.

**Platform limitations.** Go plugins work on Linux and macOS. No Windows, no other targets. Sortie's pure-Go, CGo-free build compiles for any platform Go targets.

**Overkill for the scale.** Sortie will never have hundreds of adapters. The realistic count is a handful of trackers (Jira, GitHub Issues, Linear, maybe GitLab and a file-based adapter for testing) and a handful of agents (Claude Code, Copilot, Codex, Gemini, a mock for testing). For that count, compile-time interfaces with additive packages are the right level of abstraction — type-safe, simple to test, zero operational overhead.

The trade-off is real: adding an adapter requires recompiling Sortie. For an open-source project where adapters are merged upstream, this works naturally — contributors submit pull requests, CI builds, releases include the new adapter. For organizations that want private adapters, the architecture supports forking with minimal merge conflict risk because adapter packages are isolated. Your internal `internal/tracker/yourtracker/` package touches nothing outside its directory.

An RPC-based plugin model (think HashiCorp's `go-plugin` over gRPC) was also considered. It would allow out-of-process adapters written in any language. It was rejected because it adds network overhead, serialization complexity, and new failure modes — all for a single-process orchestrator where in-process function calls are the natural integration model. If the adapter count or the language diversity requirement ever changes, this decision can be revisited. For now, the simpler option wins.

## The registry: wiring adapters at startup

The bridge between configuration and adapter instances is the registry — a typed map from `kind` strings to constructor functions. Each adapter package registers itself, and the startup code in `cmd/` resolves the configured `tracker.kind` and `agent.kind` to concrete adapter instances every time the workflow config is loaded.

This means adapter selection is a configuration decision, not a code decision. Your WORKFLOW.md says `tracker.kind: github` and Sortie instantiates the GitHub Issues adapter. Change it to `tracker.kind: jira` and the next reload instantiates Jira without a restart. The orchestrator's behavior — scheduling, retry, reconciliation — stays identical because it only interacts with the interface.

## What this means for your adoption decision

The question behind this document: if you adopt Sortie today, does that investment survive the next twelve months of agent and tracker churn?

Today, Sortie ships with three tracker adapters (Jira, GitHub Issues, and a file-based adapter for testing) and three agent adapters (Claude Code, Copilot CLI, and a mock for testing). The roadmap includes Linear, Codex, and Gemini — each a new package implementing an existing interface.

Consider two scenarios that play out regularly in engineering organizations:

Your team switches from Jira to Linear. In a hardcoded orchestrator, this is a migration — rip out Jira API calls, replace them with Linear's GraphQL, re-test scheduling logic, hope nothing breaks. In Sortie, you change `tracker.kind: linear` in WORKFLOW.md. The orchestrator, the persistence layer, the retry system, and the reconciliation loop don't know the difference. They work with `Issue` and `TrackerAdapter`, same as before.

Your bet on Claude Code doesn't pan out and you move to Codex. Same story: change `agent.kind: codex` in WORKFLOW.md. The same workflow definitions, the same lifecycle hooks, the same budget controls, the same stall detection apply. The orchestrator's relationship with the agent hasn't changed — only the adapter behind the interface.

For contributors, the barrier is correspondingly low. Adding a tracker adapter for an internal issue system means implementing eight methods in one package. You don't need to understand the orchestrator's state machine, the retry backoff formula, or the reconciliation algorithm. The interface tells you what the orchestrator needs; the existing adapters show you the pattern. The adapter tests verify you satisfy the contract.

The design bet underlying all of this: the agent and tracker landscape will keep churning. New tools will appear. Existing tools will change their APIs. Teams will switch providers. Sortie's response is to make adapters disposable and the orchestration core stable. You adopt the orchestrator once. Adapters come and go.

## Further reading

- [Architecture overview](/concepts/architecture/) — the single-binary design, layer model, and spec-first philosophy
- [Orchestration](/concepts/orchestration/) — how the dispatch-retry-reconcile loop uses adapter interfaces
- [Jira adapter reference](/reference/adapter-jira/) — Jira-specific configuration and setup
- [GitHub adapter reference](/reference/adapter-github/) — GitHub Issues configuration and label mapping
- [Claude Code adapter reference](/reference/adapter-claude-code/) — agent integration details
- [Copilot CLI adapter reference](/reference/adapter-copilot/) — agent integration details
- [Workflow file reference](/reference/workflow-config/) — `tracker.kind` and `agent.kind` configuration
- [ADR-0003: Adapter-Based Integration](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0003-adapter-based-integration.md) — the full decision rationale
