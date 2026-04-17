---
title: Run the Full Cycle with Codex CLI
linkTitle: "Jira + Codex End-to-End"
description: "Tutorial: connect Sortie to Jira and the Codex CLI, clone a repo, let the agent write code, push to a branch, and watch the issue move to Done."
keywords: sortie tutorial, codex cli, end to end, jira, workspace hooks, git push, autonomous coding agent, agent session, openai codex
author: Sortie AI
date: 2026-04-17
weight: 70
---
In this tutorial, we will wire Sortie to a Jira project and the OpenAI Codex CLI, then watch the full automation cycle: Sortie picks up a Jira issue, clones your repository, launches Codex to write and commit code, pushes the result to a branch, and transitions the issue to Done. No manual intervention required.

The [Jira integration tutorial](/getting-started/jira-integration/) proved that Sortie can talk to your tracker. This tutorial completes the setup with three new pieces: the Codex CLI agent adapter, workspace hooks for git operations, and a prompt template that guides the agent through the task.

## Prerequisites

- [Jira integration tutorial](/getting-started/jira-integration/) completed - Sortie connects to your Jira project, and the environment variables `SORTIE_JIRA_ENDPOINT` and `SORTIE_JIRA_API_KEY` are set
- Codex CLI installed on your machine:

    ```bash
    codex --version
    ```

    You should see a version string like `0.121.0`. If the command is not found, install the [Codex CLI](https://github.com/openai/codex). The binary is a statically linked Rust executable with no runtime dependencies.

- `CODEX_API_KEY` set in your environment:

    ```bash
    export CODEX_API_KEY="sk-..."
    ```

    This is a standard OpenAI API key. Codex CLI uses it to authenticate with the OpenAI API, billed at API rates. The adapter checks for this variable when spawning the app-server subprocess and passes it through to the child process.

- A git repository on GitHub or GitLab that you can push to
- SSH key or HTTPS token configured for `git push` from your machine - test it:

    ```bash
    git ls-remote git@github.com:yourorg/yourrepo.git HEAD
    ```

    You should see a commit hash. If you get a permission error, fix your SSH or token setup before continuing.

{{% steps %}}

### Create a Jira issue

Open your Jira project and create an issue that a coding agent can complete without human judgment. We need a task with a clear, verifiable outcome.

Create the issue with these details:

- **Summary:** Create a health check endpoint
- **Description:**

    > Add a `/healthz` endpoint to the project that returns HTTP 200 with the JSON body `{"status": "ok"}`. Create the file `healthz.go` (or the equivalent for the project's language) with a handler function and register the route. Include a basic test.

- **Status:** To Do
- **Label:** `agent-ready`

Write down the issue identifier (e.g., `PROJ-55`). We will see it in the logs later.

The description matters. A real agent reads it as its primary instruction. Vague descriptions like "improve the API" produce vague results. Concrete, verifiable tasks work best with any coding agent.

### Set up the project directory

Create a directory for this tutorial:

```bash
mkdir sortie-codex-e2e && cd sortie-codex-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration. Replace `PROJ` with your Jira project key and the git clone URL with your repository:

```jinja {filename="WORKFLOW.md",hl_lines=["33-38","40-44"]}
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
  kind: codex
  command: codex app-server
  max_turns: 3
  turn_timeout_ms: 3600000
  max_concurrent_agents: 1

codex:
  model: o3
  effort: medium
  approval_policy: never
  thread_sandbox: workspaceWrite

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

This is a lot of configuration in one file. Let's walk through the pieces, starting with the sections that are new compared to the Jira integration tutorial.

### Workspace and hooks

`workspace.root: ./workspaces` tells Sortie to create per-issue workspace directories under `./workspaces/` relative to your `WORKFLOW.md`. Each issue gets its own subdirectory named after the issue identifier (e.g., `workspaces/PROJ-55/`).

Three hooks automate git operations at different lifecycle points:

**`after_create`** runs once, when the workspace directory is first created. We clone the repository into it. The `.` at the end of `git clone` tells git to clone into the current directory, which is the workspace. `--depth 1` fetches only the latest commit for speed.

**`before_run`** runs before every agent attempt. It fetches the latest code from `main` and creates (or resets) a branch named `sortie/PROJ-55`. On the first run, this creates the branch. On a retry, it resets the branch to a clean state.

**`after_run`** runs after every agent attempt. It stages all changes, commits them if there are any, and pushes the branch. `--force-with-lease` is safe for automation: it pushes only if nobody else modified the remote branch.

Hooks receive environment variables from the orchestrator. We use `SORTIE_ISSUE_IDENTIFIER` to name the branch. The full set of hook variables:

| Variable | Example | Description |
|---|---|---|
| `SORTIE_ISSUE_ID` | `10042` | Tracker-internal ID |
| `SORTIE_ISSUE_IDENTIFIER` | `PROJ-55` | Human-readable ticket key |
| `SORTIE_WORKSPACE` | `/home/you/sortie-codex-e2e/workspaces/PROJ-55` | Absolute workspace path |
| `SORTIE_ATTEMPT` | `0` | Current attempt number |

`timeout_ms: 120000` gives hooks two minutes to finish. The default is 60 seconds, but cloning a large repository can take longer.

### Agent configuration

Two sections control the agent, and they have different scopes.

The **`agent`** section configures the orchestrator's scheduling behavior:

- `kind: codex` selects the Codex CLI adapter.
- `command: codex app-server` tells the adapter to launch the Codex app-server, a persistent subprocess that communicates via JSON-RPC 2.0 over stdin and stdout. The subprocess is launched once when the session starts and stays alive across all turns, maintaining full conversation history in memory.
- `max_turns: 3` controls how many times Sortie invokes the agent per session. After each turn, Sortie re-checks the issue state in Jira. If the issue moved to a terminal state, the session ends.
- `turn_timeout_ms: 3600000` gives each turn up to one hour.
- `max_concurrent_agents: 1` runs one agent at a time, which is enough for this tutorial.

### The `codex` extension block

The `codex:` section is adapter-specific pass-through configuration forwarded to the app-server. Four fields are set here:

- `model: o3` selects the OpenAI model. Replace this with your preferred model.
- `effort: medium` controls the reasoning effort level. Options are `low`, `medium`, and `high`. Higher effort produces more thorough work at the cost of more tokens and time.
- `approval_policy: never` auto-approves all tool calls, file edits, and command execution. Required for unattended operation. Without this, the app-server sends approval requests to the client, which stalls the session in headless mode.
- `thread_sandbox: workspaceWrite` restricts file writes to the workspace directory and disables network access by default. The adapter sets `writableRoots` to the workspace path automatically.

For the full list of `codex.*` fields, see the [Codex adapter reference](/reference/adapter-codex/).

Notice that the `codex:` section has no inner turn budget field. Other adapters (Claude Code, Copilot CLI) have a field that limits how many internal steps the agent takes within a single Sortie turn. The Codex app-server manages its own step execution, working until it completes the task, encounters an error, or hits the turn timeout. With `agent.max_turns: 3` and a one-hour turn timeout, the agent has up to three invocations of unrestricted length to finish the job. For a tutorial task like adding a health check endpoint, one turn is usually enough.

### Authentication: Codex and Jira

Two credentials are involved, and they serve different systems:

- `SORTIE_JIRA_API_KEY` authenticates Sortie to the Jira API. This is the Jira token you set up in the [Jira integration tutorial](/getting-started/jira-integration/).
- `CODEX_API_KEY` authenticates the Codex CLI to the OpenAI API. This is a separate credential with separate billing.

The two tokens have no relationship. You need both set in your environment for the full cycle to work.

### Prompt template

The body after the closing `---` is a Go `text/template` rendered per issue. Template variables like `{{ .issue.identifier }}` are filled with data from Jira.

The prompt branches on three conditions:

- **First run** (`not .run.is_continuation`) tells the agent to read the codebase first, then implement.
- **Continuation** (`.run.is_continuation`) means the agent is resuming in the same session. It should check workspace state and continue.
- **Retry** (`.attempt` is nonzero and not a continuation) means a previous attempt failed. The agent should diagnose before acting.

The template is agent-agnostic. The same prompt works with Claude Code, Copilot CLI, or Codex. For more advanced templating (conditionals, iteration, custom functions), see [Write a prompt template](/guides/write-prompt-template/).

### Validate the configuration

Check for syntax errors before running:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors. Confirm with:

```bash
echo $?
```

This should print `0`.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-codex-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-codex-e2e/.sortie.db
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

The agent is now working. Sortie launched the Codex app-server subprocess, completed the JSON-RPC initialization handshake, authenticated with your `CODEX_API_KEY`, started a thread, and sent the first turn with the rendered prompt. A Codex session typically takes 3 to 15 minutes depending on the task complexity, the model, and your connection speed. Each agent action (reading files, writing code, running commands) appears as events in the log at `debug` level.

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
4. Sortie launched `codex app-server`, initialized the JSON-RPC session, and started a thread.
5. The Codex agent read the codebase, wrote an implementation, ran tests, and completed the turn.
6. `after_run` committed the changes and pushed the branch.
7. Sortie transitioned the Jira issue from "To Do" to "Done."
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Three things should be visible now: the code in the workspace, the branch on your remote, and the issue state in Jira.

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

You should see a commit hash. The `sortie/PROJ-55` branch is on your remote, ready for a pull request.

### Check Jira

Open the issue in your browser. The status should read "Done." If you use a board view, the card has moved to the Done column.

If the status did not change and you see a handoff warning in the logs, the Jira workflow does not allow a direct transition from "To Do" to "Done." Check the [Jira integration tutorial](/getting-started/jira-integration/#verify-in-jira) troubleshooting section for how to resolve this.

### Check the dashboard

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) in a browser. You will see summary cards (running sessions, retry queue, free slots, total tokens consumed) and a run history table showing the completed session with its issue identifier, turn count, duration, exit status, and token usage.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the Codex CLI:

- **Poll** - Sortie watched Jira for issues matching the `agent-ready` label.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch.
- **Code** - Codex read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed and pushed the changes.
- **Handoff** - Sortie transitioned the Jira issue to Done.

Sortie's adapter-agnostic design means swapping the agent is a config change. The same hooks, prompt template, and orchestration flow work with any supported adapter. To see this same loop with a different agent, try the [Claude Code tutorial](/getting-started/jira-claude-end-to-end/) or the [Copilot CLI tutorial](/getting-started/github-copilot-end-to-end/).

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/) - conditionals, iteration, and template functions for production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - understand the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - token usage, session counts, and retry rates as time-series metrics
- [Codex adapter reference](/reference/adapter-codex/) - pass-through configuration, event stream, and error handling
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution for production workloads
