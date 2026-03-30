---
title: Quick Start | Sortie
description: "End-to-end tutorial: poll for issues, spin up workspaces, and run mock agent sessions locally. No Jira or external APIs required."
keywords: sortie quickstart, tutorial, getting started, mock agent, file tracker, first run
author: Sortie AI
---

# Quick start

In this tutorial, we will run Sortie end-to-end on your machine. By the end,
you will have watched Sortie poll for issues, spin up workspaces, run mock
agent sessions, and record the results — all without touching Jira or any
external API.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](installation.md))
- This tutorial uses a mock agent, so no real coding agent is needed yet.
  When you move to a real agent like Claude Code, first verify it handles
  issues well in a manual terminal session — Sortie automates the scheduling,
  not the quality of the agent's output.

Confirm Sortie is ready:

```bash
sortie --version
```

You should see output like:

```
sortie v0.x.x
```

## Set up a project directory

Create a fresh directory for this tutorial:

```bash
mkdir sortie-demo && cd sortie-demo
```

We will create two files here: an issues file and a workflow file.

## Create an issues file

Create a file called `issues.json` with two sample issues:

```json
[
  {
    "id": "1",
    "identifier": "DEMO-1",
    "title": "Add input validation to signup form",
    "description": "The signup form accepts empty email addresses. Add validation before submission.",
    "state": "To Do",
    "priority": 1
  },
  {
    "id": "2",
    "identifier": "DEMO-2",
    "title": "Fix off-by-one error in pagination",
    "description": "Page 2 repeats the last item from page 1. The offset calculation is wrong.",
    "state": "To Do",
    "priority": 2
  }
]
```

This is the same shape Sortie gets from a real tracker like Jira. The file
adapter reads it directly, so we can skip all API setup for now.

## Create a workflow file

Create `WORKFLOW.md` in the same directory:

```markdown
---
tracker:
  kind: file
  project: DEMO
  active_states:
    - "To Do"
  handoff_state: "Done"

file:
  path: ./issues.json

agent:
  kind: mock
  max_turns: 2

polling:
  interval_ms: 5000
---

Fix the following issue.

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ .issue.description }}
```

This single file drives everything Sortie does. The YAML front matter between
the `---` fences configures the tracker, agent, and polling interval. The
Markdown body below is a prompt template — Sortie renders it once per issue
and sends it to the agent.

Notice a few things:

- `tracker.kind: file` tells Sortie to read issues from a local JSON file
  instead of calling an API.
- `agent.kind: mock` uses a built-in mock agent that simulates work without
  changing any files.
- `max_turns: 2` limits each agent session to two turns.
- `{{ .issue.identifier }}` and friends are Go template variables that Sortie
  fills in with data from each issue.

## Run Sortie

Start Sortie and point it at the workflow file:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to:

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-demo/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-demo/.sortie.db
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=2 dispatched=2 running=2 retrying=0
level=INFO msg="workspace prepared" issue_id=1 issue_identifier=DEMO-1 workspace=…/DEMO-1
level=INFO msg="agent session started" issue_id=1 issue_identifier=DEMO-1 session_id=mock-session-001
level=INFO msg="turn started" issue_id=1 issue_identifier=DEMO-1 turn_number=1 max_turns=2
level=INFO msg="turn completed" issue_id=1 issue_identifier=DEMO-1 turn_number=1 max_turns=2
level=INFO msg="turn started" issue_id=1 issue_identifier=DEMO-1 turn_number=2 max_turns=2
level=INFO msg="turn completed" issue_id=1 issue_identifier=DEMO-1 turn_number=2 max_turns=2
level=INFO msg="worker exiting" issue_id=1 issue_identifier=DEMO-1 exit_kind=normal turns_completed=2
level=INFO msg="worker exiting" issue_id=2 issue_identifier=DEMO-2 exit_kind=normal turns_completed=2
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=1 issue_identifier=DEMO-1 handoff_state=Done
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=2 issue_identifier=DEMO-2 handoff_state=Done
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Let's walk through what happened:

1. Sortie loaded `WORKFLOW.md` and read `issues.json`. It found two issues in
   the "To Do" state — `DEMO-1` and `DEMO-2`.
2. For each issue, it created a workspace directory and started a mock agent
   session.
3. The mock agent ran two turns per issue (the `max_turns` we set).
4. After both turns completed, Sortie transitioned each issue to "Done" (the
   `handoff_state` from our config).
5. On the next poll cycle, Sortie found zero candidates and went idle.

Notice the second `tick completed` line shows `candidates=0` — there is
nothing left to process. Press **Ctrl+C** to stop Sortie.

## Check the results

Sortie persists all run history in a local SQLite database. Look at your
project directory:

```bash
ls -a
```

You should see:

```
.sortie.db  issues.json  WORKFLOW.md
```

The `.sortie.db` file contains session metadata, turn history, and metrics for
every run. Open `issues.json` again and notice that both issues now have
`"state": "Done"` — the file tracker updated them in place.

## What we built

We ran the full Sortie lifecycle without any external services:

- **Poll** — Sortie watched `issues.json` for issues in the "To Do" state.
- **Dispatch** — Each matching issue got its own workspace and agent session.
- **Execute** — The mock agent ran two turns per issue.
- **Handoff** — Sortie transitioned completed issues to "Done."
- **Persist** — Run results were recorded in `.sortie.db`.

The mock agent doesn't modify code, but the lifecycle is identical to a real
agent session. In production, you would swap `mock` for `claude-code` and
`file` for `jira` or `github` — the orchestration works the same way. The quality of the
agent's output depends on your prompt and agent configuration, not on Sortie.


## Next steps

- [Connect a Jira tracker](jira-integration.md) to pull real issues
- [Run with Claude Code](end-to-end.md) as the agent for automated code changes
- [Workflow file reference](../reference/workflow-config.md) for all configuration options, template variables, and hook lifecycle
- [Troubleshoot common failures](../guides/troubleshoot-common-failures.md) if something goes wrong
