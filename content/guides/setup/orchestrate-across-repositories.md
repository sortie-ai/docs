---
title: "How to Orchestrate Agents Across Multiple Repositories"
description: "Run one Sortie instance per repository to handle cross-service features: configure per-repo git hooks, scope subtasks with tracker filters, and coordinate through parent issues and blockers."
keywords: sortie multi-repo, cross-service, multiple repositories, microservices, subtasks, query filter, workspace hooks, git clone, cross-repo orchestration
author: Sortie AI
date: 2026-03-30
weight: 80
url: /guides/orchestrate-across-repositories/
---

# How to orchestrate agents across multiple repositories

Run separate Sortie instances per repository so that cross-service features -- frontend, backend, data layer -- are handled in parallel, each agent working in the correct codebase, coordinated through your issue tracker.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- Multiple workflows already working ([run multiple workflows](/guides/run-multiple-workflows/))
- Workspace hooks configured ([set up workspace hooks](/guides/setup-workspace-hooks/))
- A connected tracker: [GitHub Issues](/guides/connect-to-github/) or [Jira Cloud](/guides/connect-to-jira/)
- A cross-service feature decomposed into per-repo subtasks in your tracker

## The pattern

One Sortie process per repository. One `WORKFLOW.md` per repository. Subtasks in the tracker link each piece of work to the right instance.

```
~/workspace/
├── frontend/
│   └── WORKFLOW.md   # tracker.query_filter scopes to frontend subtasks
├── backend-api/
│   └── WORKFLOW.md   # tracker.query_filter scopes to backend subtasks
├── data-service/
│   └── WORKFLOW.md   # tracker.query_filter scopes to data-service subtasks
└── start-all.sh      # launches all instances
```

Each Sortie instance is fully independent. It polls its own filtered set of issues, clones its own repo, and runs agents in isolated workspaces. No instance knows the others exist. The tracker is the coordination layer: parent issues, subtasks, labels, or epics tell Sortie which work belongs to which repo.

For isolation rules and concurrency accounting across multiple processes, see [run multiple workflows](/guides/run-multiple-workflows/).

## Set up the tracker

You need each Sortie instance to pick up only the subtasks that belong to its repository. Two patterns work well.

### Jira with subtasks

Create a parent story or epic, then subtasks per repo. Label each subtask with its target repository:

- Parent: `PLATFORM-100: Add HubSpot marketplace install flow`
- Subtask: `PLATFORM-101: Data proxy -- raw code exchange` (label: `repo:data-proxy`)
- Subtask: `PLATFORM-102: Backend -- forward marketplace params` (label: `repo:backend`)
- Subtask: `PLATFORM-103: Frontend -- marketplace install button` (label: `repo:frontend`)

Each Sortie instance filters by its repo's label:

```yaml
# frontend/WORKFLOW.md
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PLATFORM
  query_filter: 'labels = "repo:frontend"'
  active_states: [To Do, In Progress]
  terminal_states: [Done]
```

See [connect to Jira](/guides/connect-to-jira/) for full JQL filter syntax.

### GitHub Issues with labels

Two approaches depending on how your team tracks work.

**Centralized tracking** -- all subtasks live in a single orchestration repo (or a monorepo). Each issue gets a component label. Every Sortie instance points at the same repo but filters by label:

```yaml
# frontend/WORKFLOW.md
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  project: acme-corp/platform-tasks
  query_filter: "label:component:frontend"
  active_states: [todo, in-progress]
  terminal_states: [done]
```

**Distributed tracking** -- each repository has its own issues. Each Sortie instance points at its own repo:

```yaml
# frontend/WORKFLOW.md
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  project: acme-corp/frontend
  active_states: [todo, in-progress]
  terminal_states: [done]
```

Centralized tracking is easier to oversee: one backlog, one board. Distributed tracking is simpler per-instance but requires switching between repos to see the full picture. Pick the model your team already uses. See [connect to GitHub](/guides/connect-to-github/) for label and search syntax details.

## Configure per-repo hooks

Each repository needs its own clone and branch setup. This is where the multi-repo pattern diverges from [single-workflow hooks](/guides/setup-workspace-hooks/).

**frontend/WORKFLOW.md:**

```yaml
workspace:
  root: ~/workspace/frontend

hooks:
  after_create: |
    git clone git@github.com:acme-corp/frontend.git .
    npm ci
  before_run: |
    git fetch origin main
    git rebase origin/main || git rebase --abort
    npm ci
```

`after_create` runs once when the workspace directory is first created. The `.` clones into the current directory (the workspace). `npm ci` installs dependencies so the agent can run tests immediately.

`before_run` runs before every agent attempt. Rebasing on latest `main` keeps the agent working against current code. If the rebase fails due to conflicts, `--abort` rolls back cleanly and the agent works on the existing state. The `npm ci` after rebase picks up any dependency changes that landed on `main` since the last run.

**backend-api/WORKFLOW.md:**

```yaml
workspace:
  root: ~/workspace/backend-api

hooks:
  after_create: |
    git clone git@github.com:acme-corp/backend-api.git .
  before_run: |
    git fetch origin main
    git rebase origin/main || git rebase --abort
  after_run: |
    git add -A
    git diff --cached --quiet || git commit -m "sortie: $SORTIE_ISSUE_IDENTIFIER"
    git push -u origin sortie/$SORTIE_ISSUE_IDENTIFIER --force-with-lease
```

The `after_run` hook auto-commits and pushes after each agent run. `--force-with-lease` is safer than `--force` because it refuses to overwrite remote changes made outside Sortie. This hook is optional. Some teams prefer the agent to handle git operations through its own tools. The hook approach is more predictable because it runs regardless of whether the agent remembered to commit.

The branch name `sortie/$SORTIE_ISSUE_IDENTIFIER` gives each issue its own branch (`sortie/PLATFORM-102`, `sortie/frontend-47`). The variable is set by Sortie before every hook invocation.

If cloning large repositories is slow, increase the hook timeout from the default 60 seconds:

```yaml
hooks:
  timeout_ms: 180000
  after_create: |
    git clone --depth 1 git@github.com:acme-corp/data-service.git .
```

## Wire the prompt to the subtask

Each workflow's prompt template should tell the agent which repository it's in and what constraints apply. Here's a complete frontend example:

```jinja
---
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  project: acme-corp/platform-tasks
  query_filter: "label:component:frontend"
  active_states: [todo, in-progress]
  terminal_states: [done]

agent:
  kind: claude-code
  max_turns: 5

workspace:
  root: ~/workspace/frontend

hooks:
  after_create: |
    git clone git@github.com:acme-corp/frontend.git .
    npm ci
  before_run: |
    git fetch origin main
    git rebase origin/main || git rebase --abort
    npm ci

server:
  port: 8641
---

You are a senior engineer working on the **frontend** repository.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ .issue.description }}

## Repository context

This is a Next.js application. Key directories:
- `src/pages/` -- page routes
- `src/components/` -- shared components
- `src/lib/` -- API clients and utilities

## Constraints

- Do not modify files outside the `src/` directory.
- Run `npm test` before considering the task complete.
- If you need changes in another repository (backend, data service),
  note them in a comment on the issue but do not attempt cross-repo changes.
```

That last constraint matters. Each agent works in one repo. Cross-repo coordination happens through the tracker (comments, linked issues, blocker states), not through the agent reaching into other codebases.

## Launch all instances

Create `start-all.sh` in your `~/workspace/` directory:

```bash
#!/bin/bash
set -euo pipefail

BASE=~/workspace

echo "Starting Sortie instances..."

sortie "$BASE/frontend/WORKFLOW.md" 2>"$BASE/frontend/sortie.log" &
echo "  frontend (PID $!)"

sortie "$BASE/backend-api/WORKFLOW.md" 2>"$BASE/backend-api/sortie.log" &
echo "  backend-api (PID $!)"

sortie "$BASE/data-service/WORKFLOW.md" 2>"$BASE/data-service/sortie.log" &
echo "  data-service (PID $!)"

echo "All instances running. Logs in $BASE/*/sortie.log"
echo "Stop all: pkill -f 'sortie.*workspace'"
```

```bash
chmod +x ~/workspace/start-all.sh
~/workspace/start-all.sh
```

Expected output:

```
Starting Sortie instances...
  frontend (PID 48201)
  backend-api (PID 48215)
  data-service (PID 48229)
All instances running. Logs in /home/you/workspace/*/sortie.log
Stop all: pkill -f 'sortie.*workspace'
```

To stop everything:

```bash
pkill -f 'sortie.*workspace' && echo "stopped" || echo "No instances running"
```

For production, use systemd units instead of background processes. See [run as a systemd service](/guides/run-as-systemd-service/) for the unit file template.

## Manage deployment order

Sortie dispatches work as soon as subtasks appear in active states. If your feature has deployment dependencies (backend must deploy before frontend), control ordering through the tracker, not through Sortie.

Three approaches:

- **Create subtasks in dependency order.** Only move downstream subtasks to an active state after their dependencies finish. The simplest option if a human manages the board.
- **Use blocker links.** Jira "is blocked by" links and GitHub sub-issues act as gates. Sortie does not dispatch issues that have non-terminal blockers in any active state.
- **Use states as gates.** Keep downstream subtasks in a non-active state (like "blocked" or "waiting") until upstream work is merged. Move them to an active state to trigger dispatch.

The blocker approach is the most automated: link `PLATFORM-103` (frontend) as blocked by `PLATFORM-102` (backend), and Sortie holds the frontend subtask until the backend subtask reaches a terminal state.

## Monitor all instances

Each Sortie instance starts the HTTP server by default on port 7678. When running multiple instances, assign different `server.port` values. Check status across instances:

```bash
for port in 8641 8642 8643; do
  echo "=== Port $port ==="
  curl -s "http://localhost:$port/api/v1/state" | \
    python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d['counts']
print(f'Running: {c[\"running\"]}, Retrying: {c[\"retrying\"]}')
"
done
```

All instances expose `/metrics` on their respective ports. A single Prometheus scrape config with multiple targets collects from all of them. See [monitor with Prometheus](/guides/monitor-with-prometheus/) for the multi-target configuration.

Logs are per-instance. Tail all of them at once during initial setup:

```bash
tail -f ~/workspace/*/sortie.log
```

## What we configured

Three independent Sortie instances, each with its own workflow file, tracker filter, git hooks, workspace root, and database. The tracker connects them: parent issues link the subtasks, blocker relationships enforce ordering, and labels route each subtask to the correct Sortie instance. Each agent works in one repository. Cross-repo coordination happens at the ticket level, not in the code.

The same pattern works for 2 repos or 10. Add a directory, write a `WORKFLOW.md`, add a line to the launch script.
