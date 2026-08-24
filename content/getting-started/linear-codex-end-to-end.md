---
title: Run the Full Cycle with Linear and Codex CLI
linkTitle: "Linear + Codex End-to-End"
description: "Tutorial: connect Sortie to Linear and the Codex CLI, clone a repo, let the agent write code, push to a branch, and watch the issue move to Done."
author: Sortie AI
date: 2026-06-15
weight: 100
---
In this tutorial, we will wire Sortie to a Linear team and the OpenAI Codex CLI, then watch the full automation cycle: Sortie picks up a Linear issue, clones your repository, launches Codex to write and commit code, pushes the result to a branch, and transitions the issue to Done. No manual intervention required.

The [Linear integration tutorial](/getting-started/linear-integration/) proved that Sortie can talk to your tracker. This tutorial completes the setup with three new pieces: the Codex CLI agent adapter, workspace hooks for git operations, and a prompt template that guides the agent through the task. The agent here is the same one the [Jira + Codex tutorial](/getting-started/jira-codex-end-to-end/) uses. Only the tracker changed. That is the point of Sortie's adapter design: the agent loop does not care which tracker feeds it.

## Prerequisites

- [Linear integration tutorial](/getting-started/linear-integration/) completed - Sortie connects to your Linear team, and the environment variable `SORTIE_LINEAR_API_KEY` is set
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

### Create a Linear issue

Open your Linear team and create an issue that a coding agent can complete without human judgment. We need a task with a clear, verifiable outcome.

Create the issue with these details:

- **Title:** Create a health check endpoint
- **Description:**

    > Add a `/healthz` endpoint to the project that returns HTTP 200 with the JSON body `{"status": "ok"}`. Create the file `healthz.go` (or the equivalent for the project's language) with a handler function and register the route. Include a basic test.

- **Status:** Todo
- **Label:** `agent-ready`

Write down the issue identifier (e.g., `ENG-42`). We will see it in the logs later.

The description matters. A real agent reads it as its primary instruction. Vague descriptions like "improve the API" produce vague results. Concrete, verifiable tasks work best with any coding agent.

### Set up the project directory

Create a directory for this tutorial:

```bash
mkdir sortie-linear-codex-e2e && cd sortie-linear-codex-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration. Replace `ENG` with your team key and the git clone URL with your repository:

```jinja {filename="WORKFLOW.md",hl_lines=["33-38","40-44"]}
---
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
  query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}}'
  active_states:
    - Todo
  handoff_state: Done
  terminal_states:
    - Canceled
    - Duplicate

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
2. Keep changes minimal. Implement exactly what the task requires.
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

## Retry (attempt {{ .attempt }})

A previous attempt failed. Review workspace state and error output before
making changes. Do not repeat the same approach that failed.
{{ end }}
```

This is a lot of configuration in one file. Let's walk through the pieces, starting with the tracker block and then the sections that are new compared to the Linear integration tutorial.

### The Linear tracker block

The `tracker` block is the Linear configuration from the [Linear integration tutorial](/getting-started/linear-integration/). `kind: linear` selects the Linear adapter. `api_key: $SORTIE_LINEAR_API_KEY` resolves the key you exported, which Linear takes verbatim with no `Bearer` prefix. `project: ENG` is your Linear team key, the prefix on issue identifiers, not a Linear project. `active_states` and `terminal_states` are team-scoped workflow-state names, matched against your team's states at startup. `query_filter` keeps Sortie to the `agent-ready` issue you created.

The one change for this tutorial is `handoff_state: Done`. When the agent finishes, Sortie moves the issue to `Done`, a state every Linear team has. We keep `Done` out of `terminal_states` so the handoff target and the cleanup set stay distinct. For the full Linear `tracker` field set, see the [Linear adapter reference](/reference/adapter-linear/).

### Workspace and hooks

`workspace.root: ./workspaces` creates a per-issue workspace directory named after the issue identifier, such as `workspaces/ENG-42/`. Three git hooks run at lifecycle points: `after_create` clones the repository into the fresh workspace, `before_run` fetches `main` and creates the branch `sortie/ENG-42`, and `after_run` commits any changes and pushes the branch with `--force-with-lease`. The hooks read `SORTIE_ISSUE_IDENTIFIER` to name the branch, and `timeout_ms: 120000` gives each hook two minutes. This is the same hook setup as the Jira + Codex tutorial. See its [Workspace and hooks](/getting-started/jira-codex-end-to-end/#workspace-and-hooks) section for the per-hook walk-through, and [how to use hook environment variables](/guides/setup-workspace-hooks/#use-hook-environment-variables) for the complete variable set.

### Agent configuration

The `agent` section configures the orchestrator's scheduling behavior, and every field is Codex CLI behavior, not tracker behavior:

- `kind: codex` selects the Codex CLI adapter.
- `command: codex app-server` launches the Codex app-server, a persistent subprocess that communicates over JSON-RPC 2.0 on stdin and stdout. The subprocess starts once when the session begins and stays alive across all turns, holding the full conversation thread in memory. This differs from the Claude Code and Copilot adapters, which spawn a new subprocess per turn.
- `max_turns: 3` controls how many times Sortie invokes the agent per session. After each turn, Sortie re-checks the issue state in Linear. If the issue reached a terminal state, the session ends.
- `turn_timeout_ms: 3600000` gives each turn up to one hour.
- `max_concurrent_agents: 1` runs one agent at a time, which is enough for this tutorial.

### The `codex` extension block

The `codex:` section is adapter-specific pass-through configuration forwarded to the app-server. We set `model: o3` (replace with your preferred model), `effort: medium` (the reasoning level; `low`, `medium`, or `high`), `approval_policy: never` (the default, under which the app-server asks for nothing before running a command or applying an edit, which unattended operation requires), and `thread_sandbox: workspaceWrite` (restricts writes to the workspace and disables network by default). These four fields are the same ones the Jira + Codex tutorial sets. For the full list of `codex.*` fields, see the [Codex adapter reference](/reference/adapter-codex/), and for the field-by-field explanation see the Jira + Codex tutorial's [codex extension block](/getting-started/jira-codex-end-to-end/#the-codex-extension-block).

### Inner turn budget

Notice that the `codex:` section has no inner turn budget field. Other adapters expose a field that caps how many internal steps the agent takes within a single Sortie turn. The Codex app-server manages its own step execution, working until it completes the task, hits an error, or reaches the turn timeout. With `agent.max_turns: 3` and a one-hour turn timeout, the agent gets up to three invocations of unrestricted length. For a task like adding a health check endpoint, one turn is usually enough.

### Authentication: Codex and Linear

Two credentials are involved, and they serve different systems. `SORTIE_LINEAR_API_KEY` authenticates Sortie to the Linear GraphQL API, the key you set up in the [Linear integration tutorial](/getting-started/linear-integration/). `CODEX_API_KEY` authenticates the Codex CLI to the OpenAI API, a separate credential with separate billing. The two tokens have no relationship, and you need both set in your environment for the full cycle to work.

### Prompt template

The body after the closing `---` is a Go `text/template` rendered per issue, identical to the one in the Jira + Codex tutorial. Variables like `{{ .issue.identifier }}` fill from Linear, and the template branches on first run, continuation, and retry. It is agent-agnostic and tracker-agnostic: the same prompt works with any adapter and any tracker. For the branch-by-branch explanation see the Jira + Codex tutorial's [Prompt template](/getting-started/jira-codex-end-to-end/#prompt-template) section, and for advanced templating see [Write a prompt template](/guides/write-prompt-template/).

### Validate the configuration

Check for errors before running:

```bash
sortie validate ./WORKFLOW.md
```

It reports no errors and exits 0. Confirm with:

```bash
echo $?
```

This should print `0`.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ, and the `tick completed` lines carry more fields than shown here):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-linear-codex-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-linear-codex-e2e/.sortie.db
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="workspace created" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42
level=INFO msg="hook started" hook=after_create issue_identifier=ENG-42
level=INFO msg="hook completed" hook=after_create issue_identifier=ENG-42
level=INFO msg="hook started" hook=before_run issue_identifier=ENG-42
level=INFO msg="hook completed" hook=before_run issue_identifier=ENG-42
level=INFO msg="workspace prepared" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 workspace=…/workspaces/ENG-42
level=INFO msg="agent session started" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 session_id=…
level=INFO msg="turn started" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 turn_number=1 max_turns=3
```

The agent is now working. Sortie launched the Codex app-server, completed the JSON-RPC initialization handshake, authenticated with your `CODEX_API_KEY`, started a thread, and sent the first turn with the rendered prompt. A Codex session typically takes 3 to 15 minutes depending on the task, the model, and your connection. Each agent action (reading files, writing code, running commands) appears in the log at `debug` level.

When the agent finishes a turn, you will see:

```
level=INFO msg="turn completed" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 turn_number=1 max_turns=3
level=INFO msg="hook started" hook=after_run issue_identifier=ENG-42
level=INFO msg="hook completed" hook=after_run issue_identifier=ENG-42
level=INFO msg="worker exiting" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 handoff_state=Done
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

Here is the full lifecycle, step by step:

1. Sortie polled Linear and found `ENG-42` in `Todo` with the `agent-ready` label.
2. `after_create` cloned the repository into `workspaces/ENG-42/`.
3. `before_run` created the branch `sortie/ENG-42` from `origin/main`.
4. Sortie launched `codex app-server`, initialized the JSON-RPC session, and started a thread.
5. The Codex agent read the codebase, wrote an implementation, ran tests, and completed the turn.
6. `after_run` committed the changes and pushed the branch.
7. Sortie transitioned the Linear issue from `Todo` to `Done`.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Three things should be visible now: the code in the workspace, the branch on your remote, and the issue state in Linear.

Look at the git log in the workspace directory:

```bash
cd workspaces/ENG-42
git log --oneline -5
```

You should see the agent's commit at the top:

```
a1b2c3d sortie(ENG-42): automated changes
f4e5d6c (origin/main) Initial commit
```

Check what the agent produced:

```bash
git diff HEAD~1 --stat
```

This shows the files the agent created or modified. Back in any directory, verify the branch exists on your remote:

```bash
git ls-remote git@github.com:yourorg/yourrepo.git "refs/heads/sortie/ENG-42"
```

You should see a commit hash. The `sortie/ENG-42` branch is on your remote, ready for a pull request.

Open the issue in Linear in your browser. The status reads `Done`. On a board view, the card has moved to the Done column. Then open the dashboard at [http://127.0.0.1:7678/](http://127.0.0.1:7678/). You will see summary cards (running sessions, retry queue, free slots, total tokens consumed) and a run history table showing the completed session with its issue identifier, turn count, duration, and exit status.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the Codex CLI against a live Linear team:

- **Poll** - Sortie watched Linear for issues matching the `agent-ready` filter.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch.
- **Code** - Codex read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed and pushed the changes.
- **Handoff** - Sortie transitioned the Linear issue to Done.

This is the same Codex loop as the [Jira + Codex tutorial](/getting-started/jira-codex-end-to-end/). The hooks, the prompt template, the `agent` block, and the `codex` extension are identical. Only the `tracker` block changed, from Jira to Linear, by configuration. Sortie's adapter-agnostic design means the agent never knows which tracker it is serving.

## Where to go next

- [Write a prompt template](/guides/write-prompt-template/) - conditionals, iteration, and template functions for production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - token usage, session counts, and retry rates as time-series metrics
- [Linear adapter reference](/reference/adapter-linear/) - the GraphQL config surface, state model, and error handling
- [Codex adapter reference](/reference/adapter-codex/) - pass-through configuration, event stream, and error handling
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution for production workloads
