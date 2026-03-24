# Quick start

In this tutorial, we will run Sortie end-to-end on your machine. By the end, you will have watched Sortie poll for issues, spin up workspaces, run mock agent sessions, and record the results, all without touching Jira or any external API.

## Prerequisites

- [Go](https://go.dev/dl/) 1.26 or later installed

## Install Sortie

```bash
go install github.com/sortie-ai/sortie/cmd/sortie@latest
```

Verify the binary is on your `PATH`:

```bash
sortie --version
```

You should see output like:

```
sortie v0.x.x
```

## Create an issues file

Create a file called `issues.json` in an empty directory:

```bash
mkdir sortie-demo && cd sortie-demo
```

```json title="issues.json"
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

This is the same shape Sortie gets from Jira. The file adapter reads it directly so we can skip all API setup.

## Create a workflow file

Create `WORKFLOW.md` in the same directory:

```markdown title="WORKFLOW.md"
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

The front matter configures Sortie. The body below the `---` is the prompt template sent to the agent for each issue.

## Run Sortie

```bash
sortie ./WORKFLOW.md
```

You should see output similar to:

```
level=INFO msg="sortie starting" workflow_path=/home/you/sortie-demo/WORKFLOW.md
level=INFO msg="sortie started"
level=INFO msg="fetched candidate issues" count=2
level=INFO msg="dispatching issue" issue_identifier=DEMO-1 attempt=1
level=INFO msg="dispatching issue" issue_identifier=DEMO-2 attempt=1
level=INFO msg="session started" issue_identifier=DEMO-1
level=INFO msg="session started" issue_identifier=DEMO-2
level=INFO msg="turn completed" issue_identifier=DEMO-1 turn_number=1
level=INFO msg="turn completed" issue_identifier=DEMO-2 turn_number=1
level=INFO msg="turn completed" issue_identifier=DEMO-1 turn_number=2
level=INFO msg="turn completed" issue_identifier=DEMO-2 turn_number=2
level=INFO msg="worker exited" issue_identifier=DEMO-1 status=succeeded
level=INFO msg="worker exited" issue_identifier=DEMO-2 status=succeeded
level=INFO msg="handoff transition" issue_identifier=DEMO-1 target_state="Done"
level=INFO msg="handoff transition" issue_identifier=DEMO-2 target_state="Done"
```

After both issues complete, Sortie keeps polling but finds no active issues. Press `Ctrl+C` to stop.

## What happened

Sortie read `issues.json` and found two issues in the "To Do" state. For each one, it created a workspace directory, started a mock agent session, and ran two turns of the prompt template. When both turns completed, Sortie transitioned each issue to "Done" (the `handoff_state`). Run results are stored in `.sortie.db` in your current directory.

The mock agent doesn't modify any files, but the lifecycle is identical to a real agent session: poll, dispatch, workspace, agent turns, completion, state transition.

<!-- ## Next steps

- [Connect a Jira tracker](jira-integration.md) to pull real issues
- [Run with Claude Code](end-to-end.md) as the agent for automated code changes
- [Workflow file reference](../reference/workflow-config.md) for all configuration options -->
