---
title: Run the Full Cycle with Claude Code
linkTitle: "Jira + Claude End-to-End"
description: "Tutorial: connect Sortie to Jira and Claude Code, clone a repo, let the agent write code, push to a branch, and watch the issue move to Done."
keywords: sortie tutorial, claude code, end to end, jira, workspace hooks, git push, autonomous coding agent, agent session
author: Sortie AI
date: 2026-03-23
weight: 50
---
In this tutorial, we will wire Sortie to a real coding agent. By the end, you will have watched Sortie pick up a Jira issue, clone your repository, launch Claude Code, let it write and commit code, push the result to a branch, and transition the issue to Done — hands off.

The Jira integration tutorial proved that Sortie can talk to your tracker. This tutorial completes the Claude Code automation setup with three new pieces: a real agent, workspace hooks for git operations, and a prompt template that guides the agent through the task.

## Prerequisites

- [Jira integration tutorial](/getting-started/jira-integration/) completed — Sortie connects to your Jira project, and the environment variables `SORTIE_JIRA_ENDPOINT` and `SORTIE_JIRA_API_KEY` are set
- Claude Code installed on your machine:

    ```bash
    claude --version
    ```

    You should see a version string like `1.x.x`. If the command is not found, follow the [Claude Code installation guide](https://docs.anthropic.com/en/docs/claude-code/overview).

- `ANTHROPIC_API_KEY` set in your environment:

    ```bash
    export ANTHROPIC_API_KEY="sk-ant-..."
    ```

- A git repository on GitHub or GitLab that you can push to
- SSH key or HTTPS token configured for `git push` from your machine — test it:

    ```bash
    git ls-remote git@github.com:yourorg/yourrepo.git HEAD
    ```

    You should see a commit hash. If you get a permission error, fix your SSH or token setup before continuing.

## Create a Jira issue

Open your Jira project and create an issue that a coding agent can complete without human judgment. We need a task with a clear, verifiable outcome.

Create the issue with these details:

- **Summary:** Create a health check endpoint
- **Description:**

    > Add a `/healthz` endpoint to the project that returns HTTP 200 with the JSON body `{"status": "ok"}`. Create the file `healthz.go` (or the equivalent for the project's language) with a handler function and register the route. Include a basic test.

- **Status:** To Do
- **Label:** `agent-ready`

Write down the issue identifier (e.g., `PROJ-55`). We will see it in the logs later.

The description matters. A real agent reads it as its primary instruction. Vague descriptions like "improve the API" produce vague results. Concrete, verifiable tasks — add a file, fix a specific bug, write a test — work best.

## Set up the project directory

Create a directory for this tutorial. We will keep it separate from the Jira integration work:

```bash
mkdir sortie-e2e && cd sortie-e2e
```

## Write the workflow file

Create `WORKFLOW.md` with the full configuration. Replace `PROJ` with your Jira project key and the git clone URL with your repository:

```jinja
---
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  query_filter: "labels = 'agent-ready'"
  active_states:
    - To Do
  handoff_state: Done
  terminal_states:
    - Done

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

hooks:
  after_create: |
    git clone --depth 1 git@github.com:yourorg/yourrepo.git .
  before_run: |
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
  after_run: |
    git add -A
    git diff --cached --quiet || \
      git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
    git push origin "sortie/${SORTIE_ISSUE_IDENTIFIER}" --force-with-lease
  timeout_ms: 120000

agent:
  kind: claude-code
  command: claude
  max_turns: 3
  turn_timeout_ms: 1800000
  max_concurrent_agents: 1

claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  max_turns: 30

server:
  port: 8080
---

You are a senior engineer working in this repository.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}
{{ if .issue.description }}

### Description

{{ .issue.description }}
{{ end }}
{{ if .issue.url }}

**Ticket:** {{ .issue.url }}
{{ end }}

## Rules

1. Read existing code before writing anything new.
2. Keep changes minimal — implement exactly what the task requires.
3. Run any available lint and test commands before finishing.
{{ if not .run.is_continuation }}

## First run

Start by understanding the codebase structure. Check for existing patterns
(routing setup, test conventions) and follow them. Write the implementation,
add a test, and verify everything passes.
{{ end }}
{{ if .run.is_continuation }}

## Continuation (turn {{ .run.turn_number }}/{{ .run.max_turns }})

You are resuming. Run `git status` and check test output to understand the
current state. Continue from where the previous turn left off.
{{ end }}
{{ if and .attempt (not .run.is_continuation) }}

## Retry — attempt {{ .attempt }}

A previous attempt failed. Review workspace state and error output before
making changes. Do not repeat the same approach that failed.
{{ end }}
```

This is a lot of configuration in one file. Let's walk through the new pieces — the parts that were not in the Jira integration tutorial.

### Workspace and hooks

`workspace.root: ./workspaces` tells Sortie to create per-issue workspace directories under `./workspaces/` relative to your `WORKFLOW.md`. Each issue gets its own subdirectory named after the issue identifier (e.g., `workspaces/PROJ-55/`).

Three hooks automate git operations at different lifecycle points:

**`after_create`** runs once, when the workspace directory is first created. We clone the repository into it. The `.` at the end of `git clone` tells git to clone into the current directory — which is the workspace. `--depth 1` fetches only the latest commit for speed.

**`before_run`** runs before every agent attempt. It fetches the latest code from `main` and creates (or resets) a branch named `sortie/PROJ-55`. On the first run, this creates the branch. On a retry, it resets the branch to a clean state.

**`after_run`** runs after every agent attempt. It stages all changes, commits them if there are any, and pushes the branch. `--force-with-lease` is safe for automation — it pushes only if nobody else modified the remote branch.

Hooks receive environment variables from the orchestrator. We use `SORTIE_ISSUE_IDENTIFIER` to name the branch. The full set of hook variables:

| Variable | Example | Description |
|---|---|---|
| `SORTIE_ISSUE_ID` | `10042` | Tracker-internal ID |
| `SORTIE_ISSUE_IDENTIFIER` | `PROJ-55` | Human-readable ticket key |
| `SORTIE_WORKSPACE` | `/home/you/sortie-e2e/workspaces/PROJ-55` | Absolute workspace path |
| `SORTIE_ATTEMPT` | `0` | Current attempt number |

`timeout_ms: 120000` gives hooks two minutes to finish. The default is 60 seconds, but cloning a large repository can take longer.

### Agent configuration

Two sections control the agent, and they have different scopes:

The **`agent`** section configures the orchestrator's scheduling behavior:

- `kind: claude-code` — use the Claude Code adapter.
- `command: claude` — the CLI binary to launch.
- `max_turns: 3` — Sortie runs up to three turns per session. After each turn, Sortie re-checks the issue state in Jira. If the issue moved to a terminal state, the session ends. We use a small number here because this is a tutorial.
- `turn_timeout_ms: 1800000` — each turn has a 30-minute timeout.
- `max_concurrent_agents: 1` — one agent at a time. We have one issue, so this is fine.

The **`claude-code`** section is a pass-through to the Claude Code CLI:

- `permission_mode: bypassPermissions` — auto-approve all tool calls. Required for unattended operation. Without this, Claude Code prompts for confirmation on file edits and command execution, which stalls the session.
- `model: claude-sonnet-4-20250514` — the model Claude Code uses.
- `max_turns: 30` — Claude Code's internal turn budget. This is how many steps Claude Code takes *within a single Sortie turn*. The agent might read files, write code, run tests, and fix errors — each step counts as one Claude Code turn.

The distinction matters: `agent.max_turns` is how many times Sortie invokes the agent. `claude-code.max_turns` is how many internal steps the agent takes per invocation. Three Sortie turns with 30 internal turns each gives the agent up to 90 total steps to complete the task.

### Prompt template

The body after the closing `---` is a Go `text/template` rendered per issue. Template variables like `{{ .issue.identifier }}` are filled with data from Jira.

The prompt branches on three conditions:

- **First run** (`not .run.is_continuation`) — tells the agent to read the codebase first, then implement.
- **Continuation** (`.run.is_continuation`) — the agent is resuming in the same session. It should check workspace state and continue.
- **Retry** (`.attempt` is nonzero and not a continuation) — a previous attempt failed. The agent should diagnose before acting.

## Validate the configuration

Check for syntax errors before running:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors. Confirm with:

```bash
echo $?
```

This should print `0`.

## Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-e2e/.sortie.db
level=INFO msg="http server listening" address=127.0.0.1:8080
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace created" issue_id=10042 issue_identifier=PROJ-55
level=INFO msg="hook started" hook=after_create issue_identifier=PROJ-55
level=INFO msg="hook completed" hook=after_create issue_identifier=PROJ-55
level=INFO msg="hook started" hook=before_run issue_identifier=PROJ-55
level=INFO msg="hook completed" hook=before_run issue_identifier=PROJ-55
level=INFO msg="workspace prepared" issue_id=10042 issue_identifier=PROJ-55 workspace=…/workspaces/PROJ-55
level=INFO msg="agent session started" issue_id=10042 issue_identifier=PROJ-55 session_id=…
level=INFO msg="turn started" issue_id=10042 issue_identifier=PROJ-55 turn_number=1 max_turns=3
```

The agent is now working. This is the part where you wait. A real agent session typically takes 5–15 minutes depending on the task complexity, the model, and your internet connection. The agent reads files, writes code, runs commands, fixes errors — each action appears as events in the log at `debug` level.

When the agent finishes a turn, you will see:

```
level=INFO msg="turn completed" issue_id=10042 issue_identifier=PROJ-55 turn_number=1 max_turns=3
level=INFO msg="hook started" hook=after_run issue_identifier=PROJ-55
level=INFO msg="hook completed" hook=after_run issue_identifier=PROJ-55
level=INFO msg="worker exiting" issue_id=10042 issue_identifier=PROJ-55 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=10042 issue_identifier=PROJ-55 handoff_state=Done
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is the full lifecycle, step by step:

1. Sortie polled Jira and found `PROJ-55` in "To Do" with the `agent-ready` label.
2. `after_create` cloned the repository into `workspaces/PROJ-55/`.
3. `before_run` created the branch `sortie/PROJ-55` from `origin/main`.
4. Claude Code started a session and worked on the task.
5. The agent completed the turn and exited.
6. `after_run` committed the changes and pushed the branch.
7. Sortie transitioned the Jira issue from "To Do" to "Done."
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

## Verify the results

Three things should be visible now: the code in the workspace, the branch in your remote, and the issue state in Jira.

### Check the workspace

Look at the git log in the workspace directory:

```bash
cd workspaces/PROJ-55
git log --oneline -5
```

You should see the agent's commit at the top:

```
a1b2c3d sortie(PROJ-55): automated changes
f4e5d6c (origin/main) Initial commit
```

Check what the agent produced:

```bash
git diff HEAD~1 --stat
```

This shows the files the agent created or modified.

### Check the remote branch

Back in any directory, verify the branch exists on your remote:

```bash
git ls-remote git@github.com:yourorg/yourrepo.git "refs/heads/sortie/PROJ-55"
```

You should see a commit hash. Open your repository on GitHub or GitLab — the `sortie/PROJ-55` branch is there, ready for a pull request.

### Check Jira

Open the issue in your browser. The status should read "Done." If you use a board view, the card has moved to the Done column.

If the status did not change and you see a handoff warning in the logs, the Jira workflow does not allow a direct transition from "To Do" to "Done." Check the [Jira integration tutorial](/getting-started/jira-integration/#verify-in-jira) troubleshooting section for how to resolve this.

### Check the dashboard

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) in a browser. The workflow sets `server.port: 8080`, so the dashboard is available at that port. You will see:

- **Summary cards** at the top: running sessions, retry queue size, free slots, total tokens consumed.
- **Run history** table showing the completed session — its issue identifier, turn count, duration, exit status, and token usage.

The dashboard auto-refreshes every 5 seconds. It is useful during longer runs when you want to monitor multiple agents. For this tutorial with a single issue, the logs tell the same story.

## What we built

We ran the complete Sortie lifecycle with a real agent:

- **Poll** — Sortie watched Jira for issues matching the `agent-ready` label.
- **Clone** — The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** — The `before_run` hook created a clean feature branch.
- **Code** — Claude Code read the codebase, wrote an implementation, and ran tests.
- **Push** — The `after_run` hook committed and pushed the changes.
- **Handoff** — Sortie transitioned the Jira issue to Done.

This is the same loop that runs in production. Increase `agent.max_turns` and `max_concurrent_agents`, point at more issues, and Sortie scales the pattern across your backlog.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/) — use conditionals, iteration, and template functions to build production prompts.
- [WORKFLOW.md configuration reference](/reference/workflow-config/) — every field, every default, every constraint.
- [Monitor with logs](/guides/monitor-with-logs/) — understand the structured log output during long-running sessions.
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) — collect token usage, session counts, and retry rates as time-series metrics.
- [Use sub-agents with Sortie](/guides/use-subagents-with-sortie/) — delegate work to specialized agents within a session.
- [Claude Code adapter reference](/reference/adapter-claude-code/) — CLI flags, event stream, and pass-through configuration.
