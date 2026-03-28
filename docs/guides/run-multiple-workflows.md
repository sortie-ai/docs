---
title: "How to Run Multiple Workflows | Sortie"
description: "Run separate Sortie processes for different projects, teams, or issue types using isolated workflow files, databases, and workspace roots."
keywords: sortie multiple workflows, multiple processes, parallel workflows, multi-project, workflow isolation, db_path, workspace root
author: Sortie AI
---

# How to run multiple workflows

Run independent Sortie instances — each with its own tracker, agent config, and database — so you can orchestrate multiple projects or teams from a single machine.

## Prerequisites

- A working Sortie setup ([quick start](../getting-started/quick-start.md))
- At least one `WORKFLOW.md` you've already tested

## Why multiple workflows

Different projects need different configurations. Your billing team tracks issues in one Jira project with a $2 per-session budget. Your platform team pulls from a different project, runs a different prompt, and allows 6 concurrent agents. A single `WORKFLOW.md` can't express both.

Sortie accepts exactly one workflow file per process. To run multiple workflows, run multiple Sortie processes. Each process operates a completely independent poll-dispatch-reconcile loop with its own state.

## Name your workflow files

The default filename is `WORKFLOW.md`, but Sortie accepts any path. When you run multiple instances, give each file a descriptive name. The [dashboard](../reference/dashboard.md) displays the base filename in its **Workflow** column — if every file is called `WORKFLOW.md`, you can't tell which session belongs to which project.

Create a directory per workflow with a named file:

```bash
mkdir -p ~/sortie/{billing,platform}
touch ~/sortie/billing/billing.WORKFLOW.md
touch ~/sortie/platform/platform.WORKFLOW.md
```

The resulting layout:

```
~/sortie/
├── billing/
│   └── billing.WORKFLOW.md
└── platform/
    └── platform.WORKFLOW.md
```

## Configure each workflow

Each workflow file sets its own tracker, workspace root, database, and server port. The critical isolation points: `workspace.root` must differ between instances, `db_path` must not overlap, and `server.port` must be unique.

**billing/billing.WORKFLOW.md:**

```yaml
---
tracker:
  kind: jira
  project: BILLING
  active_states:
    - "To Do"
    - "In Progress"
  handoff_state: "Human Review"

agent:
  kind: claude-code
  max_concurrent_agents: 2
  max_turns: 3

workspace:
  root: ~/workspace/billing

server:
  port: 8642

polling:
  interval_ms: 30000
---

Fix the following issue.

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ .issue.description }}
```

**platform/platform.WORKFLOW.md:**

```yaml
---
tracker:
  kind: jira
  project: PLATFORM
  active_states:
    - "To Do"
    - "In Progress"
  handoff_state: "Human Review"

agent:
  kind: claude-code
  max_concurrent_agents: 6
  max_turns: 5

workspace:
  root: ~/workspace/platform

server:
  port: 8643

polling:
  interval_ms: 30000
---

Fix the following issue.

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ .issue.description }}
```

The dashboard will now show `billing.WORKFLOW.md` and `platform.WORKFLOW.md` in the Workflow column — immediately obvious which process owns each session.

`db_path` is omitted in both files. It defaults to `.sortie.db` in the same directory as the workflow file, so billing gets `~/sortie/billing/.sortie.db` and platform gets `~/sortie/platform/.sortie.db`. No collision. If you prefer explicit paths:

```yaml
db_path: /var/lib/sortie/billing.db
```

See the [`db_path` reference](../reference/workflow-config.md#db_path) for path expansion details.

## Launch both instances

Start each process pointing at its workflow file:

```bash
sortie ~/sortie/billing/billing.WORKFLOW.md &
sortie ~/sortie/platform/platform.WORKFLOW.md &
```

Each process logs to stderr independently. In a terminal, the interleaved output gets noisy. For anything beyond quick testing, redirect logs to files:

```bash
sortie ~/sortie/billing/billing.WORKFLOW.md 2>~/sortie/billing/sortie.log &
sortie ~/sortie/platform/platform.WORKFLOW.md 2>~/sortie/platform/sortie.log &
```

## Verify both are running

Check that both processes are alive:

```bash
pgrep -af sortie
```

Expected output (PIDs will differ):

```
48201 sortie /home/you/sortie/billing/billing.WORKFLOW.md
48215 sortie /home/you/sortie/platform/platform.WORKFLOW.md
```

If you configured server ports, query each dashboard:

```bash
curl -s http://localhost:8642/api/status | head -1
curl -s http://localhost:8643/api/status | head -1
```

Each responds with a JSON status object showing its own running workers, candidates, and config.

## Isolation rules

Four resources must stay separate. If two instances share any of these, you'll get data corruption or startup failures.

| Resource | What happens on collision | How to prevent it |
|---|---|---|
| **Database file** | SQLite lock contention, corrupted state | Keep workflows in separate directories (default `db_path` resolves per-directory) or set explicit non-overlapping `db_path` values |
| **Workspace root** | Agents stomp on each other's working directories | Set different `workspace.root` values per workflow |
| **Server port** | Second instance fails to bind on startup | Assign different `server.port` values, or omit ports you don't need |
| **Log files** | Interleaved, unreadable logs | Redirect stderr to separate files per process |

Everything else is safely shared. Environment variables like `ANTHROPIC_API_KEY` and `SORTIE_JIRA_API_KEY` work across all instances in the same shell. If different workflows need different credentials — different Jira instances, different API keys — set them per-process:

```bash
SORTIE_JIRA_API_KEY="$BILLING_JIRA_KEY" sortie ~/sortie/billing/billing.WORKFLOW.md &
SORTIE_JIRA_API_KEY="$PLATFORM_JIRA_KEY" sortie ~/sortie/platform/platform.WORKFLOW.md &
```

You can also use `$VAR` expansion in `WORKFLOW.md` fields to reference per-workflow environment variables. See the [environment reference](../reference/environment.md) for supported expansion syntax.

## Concurrency accounting

`agent.max_concurrent_agents` is per-process. Two instances with `max_concurrent_agents: 4` each can spawn up to 8 agents simultaneously. There is no global cap across processes.

Plan machine capacity accordingly. Each agent session consumes CPU, memory, and disk I/O proportional to the work it does. A machine running 2 instances × 4 agents each needs to handle 8 concurrent coding agent sessions. Monitor system resources during initial rollout and adjust per-workflow limits if the machine saturates.

## Production pattern: systemd

For production, run each workflow as a separate systemd service. This gives you automatic restarts, log rotation via journald, and per-service resource controls:

```bash
# Each workflow → one systemd unit
# sortie-billing.service  → sortie /etc/sortie/billing/billing.WORKFLOW.md
# sortie-platform.service → sortie /etc/sortie/platform/platform.WORKFLOW.md
```

The pattern is one `sortie-<name>.service` file per workflow, each with its own `ExecStart`, `WorkingDirectory`, and optional environment overrides. See [How to run as a systemd service](run-as-systemd-service.md) for the full unit file template.

## What we configured

Two independent Sortie instances, each with:

- Its own workflow file with project-specific tracker, agent, and polling config
- Its own SQLite database (isolated by directory)
- Its own workspace root (no agent collisions)
- Its own HTTP dashboard port (independent monitoring)

Add more workflows by creating more directories and launching more processes. The pattern scales to as many workflows as your machine can handle.
