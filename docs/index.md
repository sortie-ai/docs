# Sortie

Sortie turns issue tracker tickets into autonomous coding agent sessions.
Engineers manage work at the ticket level. Agents handle implementation.
Single binary, zero dependencies, SQLite persistence.

## The Problem

Coding agents can handle routine engineering tasks: bug fixes, dependency updates, test
coverage, build features. But running them at scale requires infrastructure that doesn't
exist yet: isolated workspaces, retry logic, state reconciliation, tracker integration,
cost tracking. Teams build this ad-hoc, poorly, and differently each time.

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
workspace for each, and launches Claude Code with the rendered prompt. It handles
the rest: stall detection, timeout enforcement, retries with backoff, state
reconciliation with the tracker, and workspace cleanup when issues reach terminal
states. Changes to the workflow are applied without restart.

## Quick links

- [Quick Start](getting-started/quick-start.md) — dispatch your first agent session
- [GitHub repository](https://github.com/sortie-ai/sortie) — source code
- [Contributing](https://github.com/sortie-ai/sortie/blob/main/CONTRIBUTING.md) — how to contribute to Sortie
