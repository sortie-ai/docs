---
title: "Run the Full Cycle with Copilot CLI"
linkTitle: "GitHub + Copilot End-to-End"
description: "Tutorial: connect Sortie to GitHub Issues and Copilot CLI, clone a repo, let the agent write code, push to a branch, and watch the issue transition to Done."
keywords: sortie tutorial, copilot cli, end to end, github issues, workspace hooks, git push, autonomous coding agent, agent session, github native
author: Sortie AI
date: 2026-03-31
weight: 60
---
In this tutorial, we will wire Sortie to GitHub Issues and the Copilot CLI, clone a repository, let the agent write and commit code, push the result to a branch, and transition the issue to Done. The entire stack is GitHub-native. No Jira, no Claude Code, no Anthropic API key.

The GitHub integration tutorial proved that Sortie can talk to your issue tracker. This tutorial adds three new pieces: a real agent (Copilot CLI), workspace hooks for git operations, and a prompt template that guides the agent through the task.

## Prerequisites

- [GitHub integration tutorial](/getting-started/github-integration/) completed — Sortie connects to your GitHub repository and `SORTIE_GITHUB_TOKEN` is set
- Copilot CLI installed on your machine:

    ```bash
    copilot --version
    ```

    You should see a version string. If the command is not found, install the [Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line). Node.js 22+ is required.

- GitHub authentication for Copilot CLI — the adapter checks for tokens in this order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`. If none are set, it falls back to `gh auth status`. The fastest path is to reuse the token you already have:

    ```bash
    export GITHUB_TOKEN="$SORTIE_GITHUB_TOKEN"
    ```

- A git repository on GitHub that you can push to, with SSH or HTTPS credentials configured:

    ```bash
    git ls-remote git@github.com:yourorg/yourrepo.git HEAD
    ```

    You should see a commit hash. If you get a permission error, fix your SSH or token setup before continuing.

No `ANTHROPIC_API_KEY` needed. That is the key difference from the [Claude Code end-to-end tutorial](/getting-started/jira-claude-end-to-end/): Copilot CLI authenticates through GitHub tokens, and a single token can serve both the tracker and the agent.

{{% steps %}}

### Create a GitHub issue

Create an issue with the `backlog` label. Pick a task that is concrete and verifiable — the agent reads the description as its primary instruction.

```bash
gh issue create --repo yourorg/yourrepo \
  --title "Create a health check endpoint" \
  --body "Add a /healthz endpoint that returns HTTP 200 with {\"status\": \"ok\"}. Create the handler file and a basic test." \
  --label backlog
```

Note the issue number in the output (e.g., `#5`). We will see it in the logs later.

Vague descriptions like "improve the API" produce vague results. Concrete tasks — add a file, fix a specific bug, write a test — work best with any coding agent.

### Set up the project directory

Create a directory for this tutorial, separate from the GitHub integration work:

```bash
mkdir sortie-github-e2e && cd sortie-github-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration. Replace `yourorg/yourrepo` with your actual repository:

```jinja {filename="WORKFLOW.md",hl_lines=[3,4,"34-35","40-42"]}
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: yourorg/yourrepo
  active_states:
    - backlog
    - in-progress
    - review
  handoff_state: done
  terminal_states:
    - done

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
  kind: copilot-cli
  command: copilot
  max_turns: 3
  turn_timeout_ms: 1800000
  max_concurrent_agents: 1

copilot-cli:
  model: gpt-4.1
  max_autopilot_continues: 50

server:
  port: 8888
---

You are a senior engineer working in this repository.

## Task

**#{{ .issue.identifier }}**: {{ .issue.title }}
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

If you followed the [Claude Code end-to-end tutorial](/getting-started/jira-claude-end-to-end/), this file will look familiar. The hooks and prompt template are nearly identical. The differences are in the tracker and agent configuration.

### Tracker: GitHub instead of Jira

`tracker.kind: github` uses the GitHub adapter. The project field takes `owner/repo` format, and `api_key: $SORTIE_GITHUB_TOKEN` is a single Bearer token — no `email:token` format like Jira. State is managed through labels: when Sortie transitions an issue, it removes the old state label, adds the new one, and closes the issue if the target state is terminal. No Jira workflow configuration required.

### Agent: Copilot CLI instead of Claude Code

`agent.kind: copilot-cli` uses the Copilot CLI adapter. Where the Claude Code tutorial sets `permission_mode: bypassPermissions`, Copilot CLI runs with `--autopilot`, `--no-ask-user`, and `--allow-all` by default — no extra permission field needed.

The `copilot-cli` section is a pass-through to the Copilot CLI binary. `max_autopilot_continues: 50` is the inner turn budget, analogous to `claude-code.max_turns`. With three Sortie turns and 50 autopilot continues each, the agent gets up to 150 total steps to finish the task. `model: gpt-4.1` selects the LLM model. Replace it with your preferred model.

### Authentication: one token, two jobs

`SORTIE_GITHUB_TOKEN` authenticates Sortie to the GitHub API. `GITHUB_TOKEN` (or `GH_TOKEN`, or `COPILOT_GITHUB_TOKEN`) authenticates Copilot CLI to GitHub's AI backend. They can be the same token. If you ran the `export GITHUB_TOKEN="$SORTIE_GITHUB_TOKEN"` command from the prerequisites, both are already set.

### Workspace and hooks

The hooks work the same way as in the Claude Code tutorial: `after_create` clones the repo, `before_run` creates a branch from `origin/main`, and `after_run` commits and pushes. For a detailed walkthrough of the hook lifecycle and environment variables, see the [hooks section in the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

### Prompt template

The template body is a Go `text/template` rendered per issue. It branches on three conditions: first run, continuation, and retry. The `#{{ .issue.identifier }}` prefix uses the `#` convention because GitHub Issues are referenced as `#5`, not `PROJ-55`.

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
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-github-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-github-e2e/.sortie.db
level=INFO msg="http server listening" address=127.0.0.1:8888
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace created" issue_id=5 issue_identifier=5
level=INFO msg="hook started" hook=after_create issue_identifier=5
level=INFO msg="hook completed" hook=after_create issue_identifier=5
level=INFO msg="hook started" hook=before_run issue_identifier=5
level=INFO msg="hook completed" hook=before_run issue_identifier=5
level=INFO msg="workspace prepared" issue_id=5 issue_identifier=5 workspace=…/workspaces/5
level=INFO msg="agent session started" issue_id=5 issue_identifier=5 session_id=…
level=INFO msg="turn started" issue_id=5 issue_identifier=5 turn_number=1 max_turns=3
```

The agent is now working. A Copilot CLI session typically takes 3–10 minutes depending on the task complexity and model. The agent reads files, writes code, runs tests — each action appears as events in the log at `debug` level.

Notice that issue identifiers are bare numbers (`5`, not `#5` or `PROJ-55`). Both `Issue.ID` and `Issue.Identifier` are the issue number for the GitHub adapter.

When the agent finishes, you will see:

```
level=INFO msg="turn completed" issue_id=5 issue_identifier=5 turn_number=1 max_turns=3
level=INFO msg="hook started" hook=after_run issue_identifier=5
level=INFO msg="hook completed" hook=after_run issue_identifier=5
level=INFO msg="worker exiting" issue_id=5 issue_identifier=5 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=5 issue_identifier=5 handoff_state=done
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is the full lifecycle, step by step:

1. Sortie polled GitHub and found issue #5 with a `backlog` label.
2. `after_create` cloned the repository into `workspaces/5/`.
3. `before_run` created the branch `sortie/5` from `origin/main`.
4. Copilot CLI started a session and worked on the task.
5. The agent completed the turn and exited.
6. `after_run` committed the changes and pushed the branch.
7. Sortie removed the `backlog` label, added `done`, and closed the issue.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Three things should be visible now: the code in the workspace, the branch on the remote, and the issue state in GitHub.

### Check the workspace

Look at the git log in the workspace directory:

```bash
cd workspaces/5
git log --oneline -5
```

You should see the agent's commit at the top:

```
a1b2c3d sortie(5): automated changes
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
git ls-remote git@github.com:yourorg/yourrepo.git "refs/heads/sortie/5"
```

You should see a commit hash. The `sortie/5` branch is on GitHub, ready for a pull request.

### Check GitHub

Open the issue in the browser, or check from the command line:

```bash
gh issue view 5 --repo yourorg/yourrepo
```

Verify three things: the issue is closed, the `backlog` label is gone, and the `done` label is present.

If the label did not change: check that the labels exist on the repository (Sortie does not create them automatically), review the Sortie logs for error messages, and confirm your token has `repo` scope.

### Check the dashboard

Open `http://127.0.0.1:8888/` in a browser while Sortie is running. You will see summary cards (running sessions, retry queue, free slots, total tokens) and a run history table showing the completed session with its issue identifier, turn count, duration, and exit status.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with Copilot CLI on GitHub Issues — entirely GitHub-native. One token authenticates both the tracker and the agent. Sortie polled GitHub, cloned the repository, launched the Copilot CLI, let it write and test code, pushed the result to a branch, and closed the issue.

The same orchestration loop powers the [Claude Code end-to-end tutorial](/getting-started/jira-claude-end-to-end/) with a different agent and tracker. Sortie's adapter-agnostic design means swapping `copilot-cli` for `claude-code` (or vice versa) is a config change — the prompt template, hooks, and overall flow carry over.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/) — conditionals, iteration, and template functions for production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) — every field, every default, every constraint
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) — token usage, session counts, and retry rates as time-series metrics
- [Copilot CLI adapter reference](/reference/adapter-copilot/) — CLI flags, event stream, and pass-through configuration
- [GitHub adapter reference](/reference/adapter-github/) — field mapping, state derivation, and rate limiting
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) — remote execution for production workloads
