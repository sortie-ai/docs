---
title: Run the Full Cycle with GitLab and Claude Code
linkTitle: "GitLab + Claude Code End-to-End"
description: "Tutorial: connect Sortie to GitLab and the Claude Code CLI, clone a repository, let the agent write code, push a branch, and watch the issue move to a done state."
author: Sortie AI
date: 2026-08-06
weight: 120
---
In this tutorial, we will connect Sortie to GitLab and the Claude Code CLI, then watch the whole unattended cycle: GitLab offers a `backlog` issue, Sortie clones your repository, Claude Code writes and commits code, Sortie pushes a branch, and the issue moves to the state you configured for finished work. This builds on the [GitLab integration tutorial](/getting-started/gitlab-integration/) and adds three pieces: the Claude Code adapter, workspace hooks for git operations, and a prompt template. The agent is the same one the [Jira + Claude Code tutorial](/getting-started/jira-claude-end-to-end/) drives; only the tracker changed, from Jira to GitLab. One boundary is worth setting before you start: Sortie's GitLab support is a tracker, so the automated cycle ends at a pushed branch and a transitioned issue. Opening the merge request is yours to do in the GitLab UI afterward.

## Prerequisites

- The [GitLab integration tutorial](/getting-started/gitlab-integration/) completed, with `SORTIE_GITLAB_TOKEN` and `SORTIE_GITLAB_PROJECT` still set. If you took the self-managed path, `SORTIE_GITLAB_ENDPOINT` should still be set too, and your container still running.
- Claude Code installed:

    ```bash
    claude --version
    ```

    You should see a version string like `2.1.223 (Claude Code)`. `agent.command` names this binary, so this confirms the executable Sortie will launch. If the command is not found, follow the [Claude Code installation guide](https://docs.anthropic.com/en/docs/claude-code/overview).

- `ANTHROPIC_API_KEY` set in your environment:

    ```bash
    export ANTHROPIC_API_KEY="sk-ant-..."
    ```

    The adapter never handles this key itself. It launches Claude Code with the environment Sortie inherited, and Claude Code authenticates on its own.

- A GitLab repository you can push to. Set the clone URL once and confirm you can reach it:

    ```bash
    export SORTIE_REPO_URL="git@gitlab.com:your-username/adapter-lab.git"
    git ls-remote "$SORTIE_REPO_URL" HEAD
    ```

    You should see a commit hash. If you get a permission error, fix your SSH key or HTTPS token before continuing, because the `after_run` hook pushes with the same credentials.

{{% steps %}}

### Create a GitLab issue

Open your project's issue list in GitLab and create an issue a coding agent can finish without human judgment, the same scenario as the Jira + Claude Code tutorial.

- **Title:** Create a health check endpoint
- **Description:**

    > Add a `/healthz` endpoint that returns HTTP 200 with the JSON body `{"status": "ok"}`. Create the handler in its own file, register the route, and add a basic test.

- **Label:** `backlog`

The `backlog` label already exists from the integration tutorial, and it is in this workflow's `active_states`, so Sortie picks the issue up on its next poll. Note the number GitLab assigns, for example `#2`. You will see it in the logs.

A concrete, verifiable task works best. A real agent reads the description as its primary instruction, so "add a `/healthz` endpoint" produces a sharper result than "improve the API."

### Set up the project directory

Create a directory for this tutorial, separate from the integration work:

```bash
mkdir sortie-gitlab-claude-e2e && cd sortie-gitlab-claude-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration:

```jinja {filename="WORKFLOW.md",hl_lines=["32-37","39-43"]}
---
tracker:
  kind: gitlab
  api_key: $SORTIE_GITLAB_TOKEN
  project: $SORTIE_GITLAB_PROJECT
  active_states:
    - backlog
  handoff_state: review
  terminal_states:
    - done
    - wontfix

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

hooks:
  after_create: |
    git clone --depth 1 "$SORTIE_REPO_URL" .
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
  model: claude-sonnet-4-6
  max_turns: 30
  max_budget_usd: 5

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
2. Keep changes minimal, implement exactly what the task requires.
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

## Retry, attempt {{ .attempt }}

A previous attempt failed. Review workspace state and error output before
making changes. Do not repeat the same approach that failed.
{{ end }}
```

The tracker block is the GitLab block from the integration tutorial: kind `gitlab`, no `endpoint` line because the adapter defaults to `https://gitlab.com`, the token-verbatim `api_key` that travels in the `PRIVATE-TOKEN` header, an unencoded namespace-path project, and label-driven states. On the self-managed path, add `endpoint: $SORTIE_GITLAB_ENDPOINT` and give the instance root. The `polling`, `workspace`, `hooks`, `server`, and prompt body keep the same shape as the Jira + Claude Code tutorial. The Claude Code work is the highlighted `agent` and `claude-code` blocks.

One tracker detail is worth stating where you set the states. `handoff_state: review` moves each finished issue to the `review` label, and because `review` is not one of the `terminal_states`, the issue stays open. Sortie will not let `handoff_state` name a terminal state, so a handoff never closes the issue on its own. That is what leaves the merge request in your hands. For the rest of the GitLab tracker surface, the [GitLab integration tutorial](/getting-started/gitlab-integration/) is the reference.

### Workspace and hooks

Nothing about the hooks is Claude-Code-specific. `workspace.root` gives each GitLab issue its own clone under `./workspaces/`, and the three hooks clone the repository, cut a clean branch, commit the agent's work, and push it upstream. For the hook-by-hook walkthrough and the full table of hook environment variables, read the [workspace and hooks section of the Jira + Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

One GitLab detail surfaces right where `before_run` names the branch. `SORTIE_ISSUE_IDENTIFIER` for GitLab is the project-scoped `iid`, a bare number, so the branch comes out as `sortie/2` rather than `sortie/PROJ-55` as it would on Jira. That is the same number GitLab shows as `#2` inside the project. GitLab's fully qualified display form for the same issue is `group/project#2`, but the identifier Sortie stores, logs, and hands to your hooks is the `iid` alone.

### Agent configuration

Two blocks control the agent, and they have different scopes.

The **`agent`** block configures the orchestrator's scheduling behavior. `kind: claude-code` selects the Claude Code adapter, registered under the `claude-code` kind, and `command: claude` names the binary it launches. `max_turns: 3` lets Sortie invoke the agent up to three times for this issue; after each turn Sortie re-checks the issue state in GitLab, and a move to a terminal state ends the session. `turn_timeout_ms: 1800000` gives each turn 30 minutes. `max_concurrent_agents: 1` runs one agent at a time, which is all a single issue needs.

The **`claude-code`** block is a pass-through to the CLI. Sortie translates each field into a flag on the `claude` invocation and leaves anything you omit off the command line entirely.

#### Authentication

The adapter runs no authentication preflight and never touches your API key. It launches Claude Code with the environment Sortie inherited, so `ANTHROPIC_API_KEY` has to be exported in the shell you start Sortie from. Claude Code also accepts AWS Bedrock and Google Vertex AI credentials through their own environment variables, and the [Claude Code adapter reference](/reference/adapter-claude-code/) covers those. Two credentials are in play here and they do different jobs: `SORTIE_GITLAB_TOKEN` authenticates Sortie to GitLab, and `ANTHROPIC_API_KEY` authenticates Claude Code to Anthropic. Neither one substitutes for the other.

#### Permission mode

`permission_mode: bypassPermissions` auto-approves all tool calls, and it is the value to use for unattended operation. Leaving the field out does not make the session interactive: the adapter falls back to the deprecated `--dangerously-skip-permissions`, which bypasses the same checks. What does stall the session is setting `permission_mode: default`, because Claude Code then prompts for confirmation on file edits and command execution and waits until the stall timeout kills it.

#### Turn and budget limits

`claude-code.max_turns: 30` is Claude Code's internal turn budget, the number of steps it takes *within a single Sortie turn*. Reading a file, writing code, running a test, and fixing an error are four of those steps. The distinction matters: `agent.max_turns` is how many times Sortie invokes the agent, and `claude-code.max_turns` is how many internal steps the agent takes per invocation. Three Sortie turns at 30 internal turns each gives the agent up to 90 steps.

`max_budget_usd: 5` caps cumulative API cost per invocation. Claude Code stops when it reaches the cap and reports the reason, which Sortie surfaces as a failed turn rather than a silent truncation. Treat it as a close bound rather than a hard ceiling, because the cap is checked at a turn boundary and a single turn can finish slightly over. For production tuning across a whole backlog, [control agent costs](/guides/control-costs/) works through the arithmetic.

### Prompt template

The prompt body is the same agent-agnostic template the other end-to-end tutorials use: the first-run, continuation, and retry branches all render from one Go `text/template`. Nothing about it changes for GitLab or Claude Code, which is the point of an adapter-agnostic prompt. For the branch-by-branch walkthrough, read the [prompt template section of the Jira + Claude Code tutorial](/getting-started/jira-claude-end-to-end/#prompt-template).

### Validate the configuration

Check the file before you run it:

```bash
sortie validate ./WORKFLOW.md
```

Validation runs entirely offline. On the configuration above it prints nothing and exits 0.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this. Timestamps, IDs, and paths will differ:

```text
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-gitlab-claude-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-gitlab-claude-e2e/.sortie.db
level=INFO msg="http server listening" address=127.0.0.1:8080
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="running hook" hook=after_create workspace=.../workspaces/2
level=INFO msg="running hook" hook=before_run workspace=.../workspaces/2
level=INFO msg="workspace prepared" issue_id=2 issue_identifier=2 workspace=.../workspaces/2
level=INFO msg="agent session started" issue_id=2 issue_identifier=2 session_id=...
level=INFO msg="turn started" issue_id=2 issue_identifier=2 turn_number=1 max_turns=3
```

The agent is now working, and this is the part where you wait. A Claude Code session for a task like this typically takes 5 to 15 minutes, depending on the size of the repository, the model, and your connection. The agent reads files, writes code, runs commands, and fixes what breaks. At `debug` level each of those actions appears as an event in the log.

When the agent finishes the turn, you will see:

```text
level=INFO msg="turn completed" issue_id=2 issue_identifier=2 turn_number=1 max_turns=3
level=INFO msg="running hook" hook=after_run workspace=.../workspaces/2
level=INFO msg="worker exiting" issue_id=2 issue_identifier=2 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=2 issue_identifier=2 handoff_state=review
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is the full lifecycle, step by step:

1. Sortie polled GitLab and found issue `#2` carrying the `backlog` label.
2. `after_create` cloned the repository into `workspaces/2/`.
3. `before_run` created the branch `sortie/2` from `origin/main`.
4. Sortie launched Claude Code and passed it the rendered prompt for the issue.
5. Claude Code read the codebase, wrote the change, ran the tests, and completed the turn.
6. `after_run` committed the changes and pushed the branch to GitLab.
7. Sortie removed the `backlog` label and added `review` in a single request. Because `review` is not terminal, the issue stays open.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Three things should be visible now: the code in the workspace, the branch on your GitLab remote, and the issue state in GitLab.

Look at the git log in the workspace:

```bash
cd workspaces/2
git log --oneline -5
```

You should see the agent's commit at the top:

```text
a1b2c3d sortie(2): automated changes
f4e5d6c (origin/main) Initial commit
```

Check what the agent produced:

```bash
git diff HEAD~1 --stat
```

This shows the files the agent created or modified for the health check endpoint.

Confirm the branch reached your GitLab remote:

```bash
git ls-remote "$SORTIE_REPO_URL" "refs/heads/sortie/2"
```

You should see a commit hash.

Now open the issue in GitLab. It carries the `review` label, the `backlog` label is gone, and the issue is still open, because `review` is not a terminal state. Had the transition targeted `done` or `wontfix`, Sortie would have closed the issue in the same request that swapped the label.

Neither change shows up as a comment on the issue. GitLab records a label swap and a state change as system notes in the activity feed, and Sortie filters system notes out when it reads an issue's comments, so nothing Sortie did here pollutes the thread an agent would later read.

Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/). The workflow sets `server.port: 8080`, so the dashboard is served there. You will see summary cards and a run history row for the completed session, with its issue identifier, turn count, duration, exit status, and token usage.

The loop is closed, and the last step is honestly yours. The `sortie/2` branch is pushed and ready, the issue is sitting in `review` with a link to the work, and opening the merge request from that branch is one click in GitLab.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the Claude Code CLI on top of the GitLab flow you configured in the integration tutorial. The tracker behavior stayed the same. The new moving parts were the agent adapter, the git hooks, and the prompt.

- **Poll** - Sortie watched GitLab for open issues carrying the `backlog` label.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch named from the issue's `iid`.
- **Code** - Claude Code read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed and pushed the branch to GitLab.
- **Handoff** - Sortie moved the issue to `review` and released it for a human.

This is the same Claude Code loop that powers the [Jira + Claude Code tutorial](/getting-started/jira-claude-end-to-end/). We swapped the tracker from Jira to GitLab with a config change and nothing else. The agent block, the extension block, the hooks, and the prompt template are the ones you would write for any tracker, which is the whole point of Sortie's adapter design.

## Where to go next

- [Write a prompt template](/guides/write-prompt-template/) - use conditionals, iteration, and template functions to build production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - collect token usage, session counts, and retry rates as time-series metrics
- [GitLab adapter reference](/reference/adapter-gitlab/) - the tracker field contract, label-driven state model, and error mapping
- [Claude Code adapter reference](/reference/adapter-claude-code/) - CLI flags, event stream, and pass-through configuration
- [Control agent costs](/guides/control-costs/) - budget caps, turn limits, and the arithmetic behind them
