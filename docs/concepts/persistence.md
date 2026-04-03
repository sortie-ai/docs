---
title: "Persistence | Sortie"
description: "Why SQLite persistence is a defining characteristic of Sortie: what survives restarts, warm start vs cold start, and what durable state enables."
keywords: sortie persistence, SQLite, warm start, retry state, run history, autonomous coding agent, agent orchestration, stateful orchestrator
author: Sortie AI
---

# Why persistence changes everything for agent orchestration

An orchestrator managing autonomous coding agents will restart. Process crashes, OS updates, host reboots, deploys — the only question is how often. When it does, there are two versions of what happens next: one where the system picks up where it left off, and one where it doesn't. The gap between those two versions is the gap between a production tool and a prototype.

## The restart problem

Consider a Sortie instance managing ten concurrent agents across a project backlog. Three issues are in retry backoff — one at 40 seconds, one at 160 seconds, one at the five-minute cap. Two issues have already consumed four of their five allowed sessions. The orchestrator has accumulated eight hours of token usage data that feeds the Prometheus metrics powering your Grafana dashboards.

Now kill the process.

A stateless orchestrator loses all of this. Retry queues disappear. Backoff positions reset to zero, so the system immediately hammers the same failing issues at the base interval — creating a thundering herd on the tracker API right when you need stability. Session budget counters revert to zero, so a stuck issue that already burned four of its five `max_sessions` gets five more. Token counters reset, and your Grafana dashboards show a cliff at 3 AM that has nothing to do with actual workload. Run history — what the agent did, how many turns it took, which model it used — is gone. When a developer asks "what happened to PROJ-42 overnight?", the answer is "we don't know."

None of this matters for a cron job that runs one agent against one issue. It matters enormously for a daemon that manages concurrent agents with retry logic, budget limits, and operational observability. For that use case, losing state on restart is a production incident, not an inconvenience.

## Warm start vs cold start

The difference between stateful and stateless orchestration is clearest at startup time.

**Cold start** is what stateless orchestrators do. On restart, the system has zero memory of what happened. It polls the tracker, discovers issues, and starts dispatching from scratch. This works — the tracker is the durable record of what needs doing. But the tracker doesn't store retry attempt counts, backoff timers, session budgets, or run history. Those lived in process memory and died with the process. If the orchestrator was mid-retry on five issues with varying backoff delays, a cold start collapses all of them to immediate dispatch. Every pending retry fires at once. The tracker API gets hit with five simultaneous requests instead of five staggered ones. And for issues that were already approaching their `max_sessions` limit, the budget counter starts over.

**Warm start** is what Sortie does. On restart, Sortie opens its SQLite database and reconstructs state. Retry entries carry `due_at` timestamps — absolute points in time, not relative delays. Entries whose `due_at` has passed fire immediately (they were overdue anyway). Entries whose `due_at` is in the future get timers set for the correct remaining duration. The system recovers the exact backoff position for every pending retry, not an approximation.

Session budget checks query the `run_history` table. Completed sessions are rows in a database, so `max_sessions` enforcement works the same way before and after a restart. An issue that used four of its five sessions still has one left, not five.

Aggregate metrics — total tokens consumed, total dispatches, total worker exits by type — load from the database and resume accumulating. Your Prometheus counters don't reset. Your dashboards don't lie.

After loading persisted state, Sortie reconciles against the tracker. Are any persisted issues now in terminal states? A human might have closed a ticket while the orchestrator was down. Those get cleaned up. Then normal polling begins.

The only thing lost: running agent processes. Agent subprocesses are OS processes — they die when the parent dies. Sortie rediscovers these issues through normal polling and re-dispatches them. The [workspace directory](isolation.md) is still on disk, so the agent picks up where the previous session left off. Prior commits, cached dependencies, partial work — all intact.

## What Sortie persists and why

Four categories of durable data, each solving a specific problem that in-memory state cannot.

**Retry entries.** Each entry stores the issue ID, human-readable identifier, attempt number, a `due_at` timestamp in epoch milliseconds, and the last error message. Without this, exponential backoff is a fiction — it only works within a single process lifetime. Kill the process, and every issue resets to attempt one. With persistence, a process restart at minute three of a five-minute backoff means the timer fires two minutes later.

**Run history.** One row per completed worker session: issue ID, identifier, exit type, start and completion timestamps, agent adapter used, workspace path, and — since migration 2 — token counts (input, output, cache read), model name, and API timing. This solves three problems. First, `max_sessions` budget enforcement: the count of rows for an issue is the count of sessions spent, durable across any number of restarts. Second, debugging: when an agent fails at 2 AM, the run history tells you what happened without digging through logs. Third, this is the raw material for cost attribution — every session records how many tokens it consumed and which model consumed them.

**Session metadata.** The latest session details for each issue: session ID, token counts, model, agent PID, timestamps, exit type. This is the data the dashboard and API serve when you ask "what's happening with PROJ-42 right now?" If the agent finished and the process restarted, the answer is still available because it's in the database, not in a goroutine's local variables.

**Aggregate metrics.** Cumulative counters — total input tokens, total output tokens, total dispatches, cumulative runtime — stored under a single key and updated on every worker exit. When Sortie exposes these via Prometheus, a restart doesn't create a false cliff in your time-series data. The counters pick up from their last persisted values.

## SQLite as the right tool for this job

The choice of SQLite over alternatives like Postgres, Redis, or flat files is not incidental — it follows directly from the single-binary deployment model.

**Zero ops.** Sortie targets single-instance deployments on developer machines, CI servers, and small fleet nodes. Requiring a database server contradicts the philosophy that got you here: copy a file, run it, done. SQLite is an embedded library, not a server. The database is one file, stored in the same directory as your workflow file. There's no connection string, no credentials, no network port.

**Concurrent reads with single-writer semantics.** SQLite's Write-Ahead Logging (WAL) mode lets the dashboard query run history while the orchestrator writes a new retry entry. The orchestrator enforces single-writer access through one database connection — all writes serialize through that connection, matching the orchestrator's own single-goroutine state mutation model. For write throughput measured in tens of transactions per minute, WAL mode is more than sufficient.

**Forward-only migrations.** Schema changes are numbered SQL files embedded in the binary. On startup, Sortie applies any unapplied migrations automatically, inside transactions. No migration tool, no manual steps. If the database has a schema version newer than the binary expects, startup fails — this prevents running an old binary against a database that a newer binary modified. Currently at migration three: core tables, extended token metrics, workflow file tracking.

**Operational simplicity.** Backup the database by copying the file. Inspect it with `sqlite3`. Move to another host by copying the file. Stream continuous backups to S3 with Litestream. The operational model is as simple as the deployment model.

**The trade-off is real.** SQLite serializes all writes through a single connection. Two Sortie instances cannot safely share one database file. Multi-instance coordination is a non-goal — and this constraint is why. For the single-instance deployment target, write serialization is not a bottleneck. If multi-instance becomes necessary in an enterprise context, it would use a different persistence backend or a coordination layer above SQLite, not force SQLite into a role it wasn't designed for.

The full decision rationale, including why Postgres, in-memory-only, and embedded key-value stores were rejected, is documented in [ADR-0002](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0002-sqlite-persistence.md).

## What persistence enables next

The data Sortie collects today is the foundation for capabilities that haven't shipped yet — but the schema is already in place.

**Agents reading their own history.** The planned `workspace_history` tool will let agents query their previous run results directly from the database. "What error did the last attempt hit on this issue?" becomes a question the agent can answer itself, not something that requires prompt engineering or manual context injection. This is only possible because run history is durable — a tool that queries in-memory state would return nothing after a restart.

**Cost attribution.** Run history already stores per-session token counts and model names. Enterprise cost dashboards, per-issue cost reports, and budget alerts can all read from the same table. The data collection happens today in the free core; the reporting surfaces come in future milestones.

**Audit trail.** Every completed run records who (issue ID), what (exit type, turns, tokens), when (timestamps), and how (model, workflow file hash). This is the raw material for compliance evidence — SOC 2 audits, change logs, agent activity reports. The enterprise tier will add export formats and retention policies on top of data the free tier already collects.

The design philosophy: collect the data in the free core, build governance surfaces in the enterprise tier. Persistence makes both possible.

## Further reading

- [Architecture overview](architecture.md) for the single-binary, zero-dependency design rationale
- [Orchestration](orchestration.md) for retry strategies, reconciliation, and the turn model
- [Workflow file reference](../reference/workflow-config.md) for database path and retry-related config fields
- [Resume sessions across restarts](../guides/resume-sessions-across-restarts.md) for the practical how-to
- [HTTP API reference](../reference/http-api.md) for querying run history and session data
