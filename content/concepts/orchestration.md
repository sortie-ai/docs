---
title: "Orchestration"
description: "How Sortie's poll-dispatch-reconcile loop manages autonomous coding agent sessions: candidate selection, retry strategies, state reconciliation, persistence, and the turn model."
keywords: sortie orchestration, autonomous coding agent, dispatch loop, retry backoff, reconciliation, state machine, polling, agent sessions
author: Sortie AI
date: 2026-03-29
weight: 40
---
Between "issue appears in your tracker" and "autonomous coding agent finishes work," a lot happens inside Sortie. This document explains the orchestration model — the design choices that determine when agents run, what happens when they fail, and how state stays consistent across restarts. You don't need this to use Sortie, but you need it to reason about Sortie under failure, tune its behavior with confidence, or contribute to its internals.

## The poll-dispatch-reconcile loop

Every `polling.interval_ms` milliseconds, Sortie executes one tick. The tick is a fixed sequence of operations, always in the same order, always on a single goroutine. Understanding this sequence is understanding the heartbeat of the system.

**Reconcile first.** Before looking for new work, Sortie checks that everything already running is still valid. It cross-references its internal state against the tracker: are the running issues still in active states? Has a human moved a ticket to "Done" while the agent was mid-task? If so, Sortie catches it here and stops the agent. Reconciliation happens first because dispatch decisions depend on accurate slot counts. If Sortie dispatched before reconciling, it might believe three slots are occupied when one of those agents is working on an issue a human already resolved. It would allocate fewer slots than available, or worse, dispatch work on stale assumptions.

**Validate config.** If the workflow config is invalid — missing tracker credentials, a bad state name, an unparseable template — Sortie skips dispatch for this tick but keeps reconciling. The service stays alive. This matters because config errors are transient: an operator will fix them, and when they do, Sortie picks up the fix without a restart. Crashing on config errors would kill all in-flight agent sessions, which is a far worse outcome than skipping one poll cycle.

**Fetch and sort candidates.** Sortie queries the tracker for issues in active states, then filters: already claimed? already running? blocked by a non-terminal issue? What survives is the dispatch-eligible candidate list, sorted by priority ascending (priority 1 before priority 4, nulls last), then by creation date oldest first, then by identifier as a tiebreaker. The sort order encodes a policy: high-priority old issues should not starve behind low-priority new ones.

**Dispatch.** Eligible issues fill available slots. Each dispatch atomically claims the issue (preventing any other tick from dispatching it), optionally transitions it to an in-progress tracker state, posts an optional dispatch comment, [creates or reuses a workspace](/concepts/isolation/), renders the prompt, and launches an agent session. The in-progress transition and comment are both off by default — when enabled, failures are logged but do not block dispatch. Slots are bounded globally by `max_concurrent_agents` and optionally per tracker state by `max_concurrent_agents_by_state`. Per-state limits exist because different workflow stages have different resource profiles — a "Code Review" state that blocks on human feedback may need fewer concurrent agents than an "In Progress" state where agents work autonomously.

The key design choice here is simplicity. One goroutine, one tick at a time, no parallel scheduling. All state mutations are serialized through a single authority. This makes the state machine auditable: you can reason about every transition without worrying about concurrent access or distributed coordination. The trade-off is latency — dispatch speed is bounded by the poll interval, not by event speed. Sortie is a poller, not an event-driven system. This is deliberate. Trackers have unreliable or nonexistent webhook support, and polling works universally across every tracker adapter without requiring special infrastructure.

## Two kinds of state, and why they're separate

The most common source of confusion when reading Sortie's code or logs: tracker states and orchestration states are different things that serve different purposes.

**Tracker states** are what humans see in Jira, Linear, or GitHub Projects — names like "To Do," "In Progress," "Human Review," "Done." They represent workflow stages and are the human's primary control surface for managing issues.

**Orchestration states** are Sortie's internal scheduling states: `Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`. They represent dispatch decisions. A tech lead never sees these. They exist in Sortie's memory and its SQLite database.

Why separate them? The tracker is an external system with its own latency, consistency model, and failure modes. If Sortie relied on tracker state for dispatch decisions, a slow Jira API response during a tick could cause the same issue to be dispatched twice — once before the response and once after, both believing the issue was unclaimed. By maintaining its own `claimed` set, Sortie guarantees single-writer dispatch regardless of tracker speed or availability.

The separation also provides tracker-agnosticism. Jira has named statuses with workflow transitions. GitHub Projects v2 has custom single-select fields. Linear has labeled states. These models are structurally different, but the orchestration state machine works the same way regardless of what's behind the adapter. The orchestration layer never needs to know that Jira requires fetching available transitions before moving a ticket, or that Linear uses GraphQL mutations. Those details live in adapter packages.

The `claimed` set is the invariant that holds everything together. Once an issue is claimed, no other tick will dispatch it, even if the tracker still shows it as an active candidate. Claims are released when the issue reaches a terminal tracker state, the retry budget is exhausted, or the issue disappears from the tracker entirely.

## What happens when agents fail

Agents fail. Networks drop, APIs rate-limit, coding sessions stall, subprocesses hang. The orchestration design treats failure as a normal operating condition, not an exception.

Sortie uses two retry strategies because there are two fundamentally different failure scenarios.

**Continuation retry** handles the case where the agent finished its work normally, but the issue is still in an active tracker state. Maybe the agent made a partial fix and needs another session. Maybe it finished but nobody transitioned the ticket yet. Continuation retry uses a fixed 1-second delay — it's not really backing off, it's checking again almost immediately. This is not an error recovery mechanism. It's the normal multi-session workflow: agent exits, orchestrator re-checks, and either dispatches again or releases the claim.

**Error retry** handles crashes, timeouts, and failures. The formula is `min(10s × 2^(attempt-1), max_retry_backoff_ms)`: attempt 1 waits 10 seconds, attempt 2 waits 20, attempt 3 waits 40, doubling up to the configured cap (5 minutes by default). Exponential backoff exists because transient failures — API rate limits, network blips, temporary resource exhaustion — often resolve themselves if you wait. Hammering the retry immediately makes the problem worse, especially for rate-limited APIs where aggressive retrying extends the throttling window.

Some errors stop retries immediately: agent binary not found, invalid workspace path, tracker authentication failure. These are non-retryable because they require operator intervention. No amount of waiting will make a missing binary appear.

**The handoff problem.** Without a feedback channel, continuation retry creates a loop: agent finishes → issue still active → retry → agent finds no work → exits normally → retry again, indefinitely. Sortie solves this with `tracker.handoff_state`: on normal exit, if the issue is still active, the orchestrator transitions it to a non-active state like "Human Review." The issue leaves the active set, and the continuation loop breaks. If the transition fails — permissions, network error, misconfigured state name — Sortie degrades gracefully to continuation retry. On completion or failure, Sortie can also post a brief comment to the issue summarizing the session outcome — duration, turns completed, whether a retry is scheduled. These comments are off by default and configured independently for success and failure exits. And `agent.max_sessions` provides a hard ceiling as defense-in-depth: after N completed sessions for the same issue, the orchestrator releases the claim regardless of what the tracker says.

The design philosophy: every failure path has a bounded resolution. No failure mode leads to infinite resource consumption.

## Reconciliation: trust but verify

Reconciliation is not a convenience feature. It's a correctness requirement.

Two checks run every tick, before any dispatch happens.

**Stall detection.** For each running agent, Sortie computes how long it's been since the last event — any event: a tool call, a token usage update, a turn completion. If that elapsed time exceeds `stall_timeout_ms`, Sortie kills the agent and queues a retry. Without stall detection, a hung agent — waiting for user input that will never come, stuck in a deadlocked subprocess, leaked as a zombie process — holds a concurrency slot forever. One stuck agent per day means zero available slots within a week.

**Tracker state refresh.** Sortie fetches current tracker states for all running issues, then evaluates three possible outcomes:

- Issue is still active: keep the agent running.
- Issue moved to a terminal state (like "Done" or "Won't Fix"): stop the agent, clean up the workspace.
- Issue moved to a non-active, non-terminal state (like "On Hold"): stop the agent, but keep the workspace intact for potential future work.

This matters because the tracker is the human's control surface. When a tech lead moves a ticket to "Won't Fix," that decision must stop the agent immediately — on the current tick, not on the next retry cycle. Reconciliation closes the feedback loop between human decisions and agent execution.

What happens when the tracker API call itself fails? Sortie keeps all running agents alive and tries again next tick. This is a deliberate choice: false positives — stopping agents because you couldn't reach the tracker — are worse than running with stale state for one poll interval. A ten-second delay in recognizing a human's state change is acceptable. Killing a running agent session because Jira returned a 503 is not.

## Persistence: surviving restarts

Without persistence, a restart means losing everything: retry queues, backoff timers, session metadata, run history. The orchestrator would need to rediscover all state from the tracker on the next poll — possible, but lossy. Retry attempt counts vanish, so backoff timers reset to zero. `max_sessions` budget checks break because completed session counts were in memory. An operator investigating a failure after restart has no record of what happened.

Sortie's SQLite database stores the state that must survive process boundaries. Retry entries with their `due_at` timestamps persist, so on restart Sortie reconstructs timers from stored times and resumes retries where they left off — not from scratch, but from the correct position in the backoff sequence. Run history persists, so `max_sessions` budget checks work across restarts because completed sessions are in the database. Session metadata persists for debugging: an operator investigating a failure can see the last agent session's token counts, model name, and timing.

What does *not* survive restart: running agent processes. Agent subprocesses are OS processes — they die when the parent dies. On restart, Sortie rediscovers these issues through normal polling and re-dispatches them. The workspace persists on disk, so the agent picks up where the previous session left off. Prior commits, cached dependencies, partial work — all still there.

This is where Sortie diverges most sharply from stateless orchestrators like Symphony, where all state lives in Erlang process memory. A Symphony restart is a cold start. A Sortie restart is a warm start: retry state is durable, scheduling history is intact, and the only thing lost is the agent processes themselves — which get re-launched automatically.

## The turn loop: sessions within sessions

The relationship between orchestrator turns and agent turns is the second most common source of confusion, after the two-state-model question.

An **orchestrator turn** is one call to `RunTurn` on the agent adapter. The orchestrator decides when to stop calling. The `agent.max_turns` config controls this — it's the coarse-grained knob.

An **agent turn** is internal to a single `RunTurn` invocation. For Claude Code, this might be dozens of tool calls, file reads, code edits, and shell commands — all within one orchestrator turn. The agent runtime decides when to stop executing. Agent-specific config (like Claude Code's `--max-turns` flag) controls this.

A worker session runs up to `max_turns` orchestrator turns. After each turn, the worker checks the tracker: is the issue still active? If yes and turns remain, it starts another turn in the same session. When turns are exhausted or the issue leaves active state, the worker exits. The orchestrator then decides: schedule a continuation retry (new session), schedule an error retry, or release the claim.

Why two levels? The orchestrator needs a control point for "how many times do I invoke the agent?" while the agent runtime needs a separate control point for "how many tool calls or LLM round-trips per invocation?" Conflating them would force the orchestrator to understand agent-internal behavior — how many tool calls Claude Code makes, how Copilot CLI structures its loops — and that breaks the adapter abstraction. The orchestrator manages sessions. The agent manages what happens inside them.

**First turns vs. continuation turns.** The first turn in a session sends the full rendered prompt: issue description, context, instructions, tool advertisements. Continuation turns within the same session send only a short continuation signal — the agent already has the full context in its conversation thread. This avoids wasting tokens by re-sending the entire task description every turn. The prompt template has access to `run.is_continuation` and `run.turn_number`, so workflow authors can customize what continuation prompts say.

## Why one process per workflow file

Sortie dispatches exactly one workflow per process. Running multiple workflows means running multiple processes — this is intentional, not a limitation waiting to be lifted.

The root cause is state keying. Every running issue is tracked by its internal tracker ID: the claimed set, the retry queue, and the SQLite persistence layer all key on this identifier. A Jira issue has an internal ID like `10042`. If two workflows target different tracker projects — or different trackers — their internal issue IDs can collide. When they do, dispatch for one issue silently suppresses dispatch for another, retry accounting crosses between unrelated tickets, and workspace cleanup can target the wrong directory. Preventing this correctly would require a composite key at every point where issue IDs appear: orchestration state, persistence, workspace names, prompt rendering, snapshot API. That is a full data model rewrite, not an incremental extension.

Concurrency limits compound the problem. `max_concurrent_agents: 5` has clear meaning within one process — one slot pool, one scheduler, one resource budget. In a shared process hosting multiple workflows it becomes ambiguous: does each workflow get 5 slots, or is 5 the total? Per-workflow limits let one workflow starve another. A shared total can't be expressed by each workflow's own configuration file. Neither answer is right without introducing a new global configuration surface — a cap separate from any workflow's own settings — that does not exist today.

Configuration divergence closes the argument. Each workflow defines its own `active_states`, `terminal_states`, and `poll_interval_ms`. Reconciliation works by evaluating each running issue against these definitions to decide whether to keep the agent alive, stop it, or release the claim. In a shared process, reconciliation must associate every running issue with the workflow that claimed it and apply that workflow's definitions — not any other. The failure mode when this goes wrong is silent: an issue evaluated against the wrong terminal states either keeps an agent running when it should have been stopped, or stops one that should be running. This class of bug does not surface in testing. It surfaces at 3 AM.

The multiple-process model sidesteps all of this. Process boundaries provide state, configuration, and concurrency isolation for free. Adding a workflow means starting a process — not reconfiguring a shared scheduler. For the practical setup, see [run multiple workflows](/guides/run-multiple-workflows/).

## Further reading

- [State machine reference](/reference/state-machine/) for the full state diagram and transition rules
- [Workflow file reference](/reference/workflow-config/) for all orchestration-related config fields
- [Configure retry behavior](/guides/configure-retry-behavior/) for practical retry tuning
- [Control agent costs](/guides/control-costs/) for budget-related settings
- [Architecture overview](/concepts/architecture/) for why Sortie is a single binary with adapters and SQLite
- [Errors reference](/reference/errors/) for retryable vs. non-retryable error classification
