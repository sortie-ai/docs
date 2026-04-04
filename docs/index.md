---
title: Sortie | Autonomous Coding Agent Orchestrator
description: Sortie turns issue tracker tickets into autonomous coding agent sessions. Single binary, zero dependencies, SQLite persistence.
keywords: sortie, autonomous coding agent, orchestrator, issue tracker, AI coding, agent sessions, automation
author: Sortie AI
---

# Sortie

Sortie turns issue tracker tickets into autonomous coding agent sessions. Engineers manage work at the ticket level. Agents handle implementation. Single binary, zero dependencies, SQLite persistence.

Sortie assumes your coding agent already produces useful results when you run it manually. It handles scheduling, retry, isolation, and persistence around that agent — it does not improve the agent's output.

## The Problem

Autonomous coding agents can handle routine engineering tasks — bug fixes, dependency updates, test
coverage, feature work — when they have good system prompts, appropriate tool permissions,
and have been tested on representative issues. But running validated agents at scale
requires AI agent orchestration infrastructure that doesn't exist yet: isolated workspaces, retry logic, state
reconciliation, tracker integration, cost tracking. Teams build this ad-hoc, poorly, and
differently each time.

Sortie is that infrastructure.

## How it works

1. You write a `WORKFLOW.md` that declares which tracker to poll, how to configure agent sessions, and what prompt to send.
2. Sortie polls the tracker for issues in active states, creates an isolated workspace per issue, and runs lifecycle hooks (clone, branch, commit).
3. The orchestrator dispatches coding agent sessions with bounded concurrency, rendering the prompt template with issue data.
4. Failed runs retry with exponential backoff. Stalled sessions are detected and terminated. State is reconciled with the tracker each poll cycle.
5. When an issue reaches a terminal state, Sortie cleans up the workspace. All session metadata, retry queues, and run history persist in SQLite across restarts.

## Minimal example

```yaml
# WORKFLOW.md (front matter)
---
tracker:
  kind: jira
  project: PLATFORM
  query_filter: "labels = 'agent-ready'"
  active_states: [To Do, In Progress]
  handoff_state: Human Review
  terminal_states: [Done, Won't Do]

agent:
  kind: claude-code
  max_concurrent_agents: 4
---

You are a senior engineer.

## {{ .issue.identifier }}: {{ .issue.title }}

{{ .issue.description }}
```

The YAML front matter configures the tracker and agent. Everything after the closing `---` is a Go template rendered per issue.

Sortie watches this file, polls Jira for matching issues, creates an isolated
workspace for each, and launches the configured coding agent with the rendered prompt. It handles
the rest: stall detection, timeout enforcement, retries with backoff, state
reconciliation with the tracker, and workspace cleanup when issues reach terminal
states. Changes to the workflow are applied without restart.

## Start here

**New to Sortie?**
:   [Install the binary](getting-started/installation.md), then follow the [Quick Start](getting-started/quick-start.md) to dispatch your first agent session.

**Coming from Jira?**
:   The [Jira integration guide](getting-started/jira-integration.md) connects Sortie to your existing project in under ten minutes.

**Want the full picture?**
:   The [end-to-end tutorial](getting-started/jira-claude-end-to-end.md) walks through workspace hooks, retry behavior, the dashboard, and real agent output.

## Understand

[How Sortie works](reference/state-machine.md)
:   The dispatch → run → reconcile loop, state machines, and lifecycle hooks.

[WORKFLOW.md reference](reference/workflow-config.md)
:   Every configuration field, type, default, and constraint.

[CLI reference](reference/cli.md)
:   Flags, subcommands, exit codes, and startup sequence.

[Environment variables](reference/environment.md)
:   `SORTIE_*` config overrides, `.env` file support, `$VAR` indirection, agent passthrough, and hook environments.

[Error reference](reference/errors.md)
:   Every error message, its cause, and how to fix it.

## Operate

[Control costs](guides/control-costs.md)
:   Set per-session budgets, concurrency caps, and turn limits to keep agent spend predictable.

[Run as a systemd service](guides/run-as-systemd-service.md)
:   Production deployment with automatic restarts, journal logging, and sandboxing.

[Scale with SSH workers](guides/scale-agents-with-ssh.md)
:   Distribute agent sessions across a pool of build hosts.

[Monitor with Prometheus](guides/monitor-with-prometheus.md)
:   Scrape `sortie_*` metrics and build Grafana dashboards for dispatch rate, token usage, and retry queues.

[Troubleshoot failures](guides/troubleshoot-common-failures.md)
:   Diagnose the most common startup errors, agent crashes, and tracker connectivity issues.

## Links

- [Changelog](changelog.md) — release history
- [GitHub](https://github.com/sortie-ai/sortie) — source code
- [Contributing](https://github.com/sortie-ai/sortie/blob/main/CONTRIBUTING.md) — how to contribute
