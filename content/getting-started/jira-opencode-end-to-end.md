---
title: Run the Full Cycle with OpenCode CLI
linkTitle: "Jira + OpenCode End-to-End"
description: "Tutorial: connect Sortie to Jira and the OpenCode CLI, clone a repo, let the agent write code, push to a branch, and watch the issue move to Done."
keywords: sortie tutorial, opencode cli, end to end, jira, workspace hooks, git push, autonomous coding agent, agent session, sst opencode, opencode-ai
author: Sortie AI
date: 2026-04-26
weight: 80
---
In this tutorial, we will connect Sortie to Jira and the OpenCode CLI, then watch the full unattended cycle: Jira offers an `agent-ready` issue, Sortie clones your repository, OpenCode writes and commits code, Sortie pushes a branch, and Jira moves the issue to Done. This builds on the [Jira integration tutorial](/getting-started/jira-integration/) and adds three pieces: the OpenCode CLI adapter, workspace hooks for git operations, and a prompt template. The tracker stays the same as in the [Claude Code tutorial](/getting-started/jira-claude-end-to-end/) and the [Codex tutorial](/getting-started/jira-codex-end-to-end/). Only the agent changes.

## Prerequisites

- [Jira integration tutorial](/getting-started/jira-integration/) completed - Sortie connects to your Jira project, and the environment variables `SORTIE_JIRA_ENDPOINT` and `SORTIE_JIRA_API_KEY` are set
- OpenCode CLI installed on your machine:

    ```bash
    npm install -g opencode-ai
    opencode --version
    ```

    You should see a version string. Sortie resolves `opencode` from `PATH` at session start, so this confirms the binary it will launch. If the command is not found, follow the [OpenCode CLI docs](https://opencode.ai/docs/cli/).

- `ANTHROPIC_API_KEY` set in your environment:

    ```bash
    export ANTHROPIC_API_KEY="sk-ant-..."
    ```

    We use Anthropic direct in this tutorial because the workflow selects an `anthropic/...` model, and readers coming from the Claude Code tutorial often already have this key set.

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

Write down the issue identifier (for example, `PROJ-55`). We will see it in the logs later.

The description matters. A real agent reads it as its primary instruction. Vague descriptions like "improve the API" produce vague results. Concrete, verifiable tasks like adding a file, fixing a specific bug, or writing a test work best.

### Set up the project directory

Create a directory for this tutorial. We will keep it separate from the Jira integration work:

```bash
mkdir sortie-opencode-e2e && cd sortie-opencode-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration. Replace `PROJ` with your Jira project key and the git clone URL with your repository:

```jinja {filename="WORKFLOW.md",hl_lines=["33-48"]}
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
  kind: opencode
  command: opencode
  max_turns: 3
  turn_timeout_ms: 3600000
  max_concurrent_agents: 1

opencode:
  model: anthropic/claude-sonnet-4-5
  dangerously_skip_permissions: true

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
2. Keep changes minimal - implement exactly what the task requires.
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

## Retry - attempt {{ .attempt }}

A previous attempt failed. Review workspace state and error output before
making changes. Do not repeat the same approach that failed.
{{ end }}
```

This file should feel familiar if you finished the Claude tutorial. The tracker, polling, workspace, hooks, server, and prompt body stay in the same shape. The OpenCode-specific work is concentrated in the `agent` block and the `opencode` block.

If you compare this tutorial workflow with the repository sample, you will notice that the sample adds production-oriented settings like `in_progress_state`, `before_remove`, `disable_autocompact`, and an explicit `allowed_tools` policy. We leave those out here so the first run stays focused and easy to verify.

### Workspace and hooks

Nothing changes here. `workspace.root` still gives each Jira issue its own clone, and the three hooks still clone the repository, create a clean branch, commit the agent's work, and push it upstream. If you want the full hook-by-hook walkthrough and the hook environment variable table, read the [workspace and hooks section in the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

### Agent configuration

#### Agent: OpenCode CLI instead of Claude Code

`agent.kind: opencode` selects the OpenCode adapter registered in Sortie under the `opencode` kind. `agent.command: opencode` tells Sortie which binary to launch, and the adapter resolves that command from `PATH` when the session starts. The `opencode:` block is smaller than the `claude-code:` block from the Claude tutorial because OpenCode rolls provider selection into the model string itself: `anthropic/claude-sonnet-4-5` means "use Anthropic, then use that model." There is no separate `provider:` field to set.

The other OpenCode-specific field here is `dangerously_skip_permissions: true`. This is the unattended equivalent of Claude Code's `permission_mode: bypassPermissions`: it tells the CLI to keep moving instead of waiting for someone to approve each action. The adapter also supports deeper tool-scoping controls, but that is reference territory. When you need it, the [OpenCode adapter reference](/reference/adapter-opencode/) covers the full surface.

#### Authentication: OpenCode multi-provider model

Two credentials are involved in this run, and they do different jobs. `SORTIE_JIRA_API_KEY` authenticates Sortie to Jira. `ANTHROPIC_API_KEY` authenticates OpenCode to the model provider we chose in `opencode.model`. Keep those roles separate in your head and in your shell: Jira talks to Jira, OpenCode talks to Anthropic.

OpenCode can target multiple providers through the same CLI, including Anthropic and OpenAI, but this tutorial takes one path on purpose. We use Anthropic direct because the workflow already names an `anthropic/...` model, the environment variable is explicit, and it lines up with the existing Jira + Claude walkthrough. OpenCode also supports interactive login with `opencode providers login`; the [providers docs](https://opencode.ai/docs/providers/) cover that path, but we keep this tutorial headless and use `ANTHROPIC_API_KEY`. For the full provider matrix and every supported environment variable family, see the [OpenCode adapter reference](/reference/adapter-opencode/).

#### Inner turn budget

`agent.max_turns: 3` is still Sortie's outer budget. It tells the orchestrator how many times it may invoke OpenCode for this issue before it gives up or retries later. What changes from Claude Code is the inner budget story: the OpenCode adapter does not expose a second `opencode.max_turns` style field. Each Sortie turn launches one `opencode run` process and lets that process work until it exits or until `turn_timeout_ms` expires.

With this workflow, Sortie can give the issue up to three OpenCode runs, and each run can last up to one hour. For the health check task in this tutorial, one run is usually enough. The extra headroom is there so the first session can read the codebase, write the change, and run tests without racing a short timeout.

### Prompt template

The prompt body is the same template shape from the Claude tutorial: first run, continuation, and retry all render from the same Go `text/template` branches. That is deliberate. The prompt is agent-agnostic, so we do not need a special OpenCode version. If you want the full walkthrough of those branches, read the [prompt template section in the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#prompt-template), then come back here to run it with a different agent.

### Validate the configuration

Check for syntax errors before running:

```bash
sortie validate ./WORKFLOW.md
```

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this. Timestamps, IDs, and paths will differ:

```text
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-opencode-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-opencode-e2e/.sortie.db
level=INFO msg="http server listening" address=127.0.0.1:8080
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace created" issue_id=10042 issue_identifier=PROJ-55
level=INFO msg="hook started" hook=after_create issue_identifier=PROJ-55
level=INFO msg="hook completed" hook=after_create issue_identifier=PROJ-55
level=INFO msg="hook started" hook=before_run issue_identifier=PROJ-55
level=INFO msg="hook completed" hook=before_run issue_identifier=PROJ-55
level=INFO msg="workspace prepared" issue_id=10042 issue_identifier=PROJ-55 workspace=.../workspaces/PROJ-55
level=INFO msg="agent session started" issue_id=10042 issue_identifier=PROJ-55 session_id=...
level=INFO msg="turn started" issue_id=10042 issue_identifier=PROJ-55 turn_number=1 max_turns=3
```

The agent is now working. An OpenCode session for this task usually takes 3 to 15 minutes, depending on repository size, provider latency, and how much code the agent needs to inspect before it writes anything. At `debug` level, you will see step, text, and tool events as OpenCode works through the repository.

When the agent finishes a turn, you will see:

```text
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
4. Sortie launched OpenCode and passed it the rendered prompt for the Jira issue.
5. OpenCode read the codebase, wrote the change, and completed the turn.
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

```text
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

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) in a browser. The workflow sets `server.port: 8080`, so the dashboard is available at that port. You will see summary cards at the top, plus a run history table showing the completed session with its issue identifier, turn count, duration, exit status, and token usage.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the OpenCode CLI on top of the same Jira flow you already configured earlier. The tracker behavior stayed the same. The only new moving part was the agent adapter.

- **Poll** - Sortie watched Jira for issues matching the `agent-ready` label.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch.
- **Code** - OpenCode read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed and pushed the changes.
- **Handoff** - Sortie transitioned the Jira issue to Done.

This is the same loop that powers the [Claude Code tutorial](/getting-started/jira-claude-end-to-end/), the [Copilot CLI tutorial](/getting-started/github-copilot-end-to-end/), and the [Codex tutorial](/getting-started/jira-codex-end-to-end/), with one config change.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/) - use conditionals, iteration, and template functions to build production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - understand the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - collect token usage, session counts, and retry rates as time-series metrics
- [OpenCode adapter reference](/reference/adapter-opencode/) - provider support, pass-through configuration, and runtime behavior
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution for larger deployments
