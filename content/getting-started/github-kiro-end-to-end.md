---
title: "Run the Full Cycle with Kiro CLI"
linkTitle: "GitHub + Kiro End-to-End"
description: "Tutorial: connect Sortie to GitHub Issues and the Kiro CLI, clone a repo, let the agent write code, push to a branch, open a pull request, and watch the issue transition."
author: Sortie AI
date: 2026-05-29
weight: 90
---
In this tutorial, we will wire Sortie to GitHub Issues and the Kiro CLI, then watch the full cycle run without you touching it: Sortie picks up a labeled issue from GitHub, clones your repository, Kiro writes and commits the code, Sortie pushes the branch and opens a pull request, and the issue moves to its review state. This builds on the [GitHub integration tutorial](/getting-started/github-integration/) and adds three pieces: the Kiro CLI agent adapter, workspace hooks for git, and a prompt template. The tracker stays GitHub, exactly as it was in the [Copilot CLI tutorial](/getting-started/github-copilot-end-to-end/). Only the agent changes.

## Prerequisites

- [GitHub integration tutorial](/getting-started/github-integration/) completed. Sortie connects to your GitHub repository, `SORTIE_GITHUB_TOKEN` is set, and the four state labels (`backlog`, `in-progress`, `review`, `done`) exist on the repository.
- Kiro CLI installed. Install it with:

    ```bash
    curl -fsSL https://cli.kiro.dev/install | bash
    ```

    Then confirm the `kiro-cli` binary is on your `PATH`:

    ```bash
    kiro-cli --version
    ```

    You should see a version string. If the command is not found, see the [Kiro CLI docs](https://kiro.dev/docs/cli/).

- A valid `KIRO_API_KEY` on a Kiro Pro, Pro+, or Power subscription. The headless path that Sortie drives requires this tier. Export the key:

    ```bash
    export KIRO_API_KEY="your-kiro-api-key"
    ```

    Confirm it works, the same check the adapter runs at session start:

    ```bash
    kiro-cli whoami
    ```

    A valid key prints confirmation that you are authenticated. Now list the models valid for your account, because the workflow pins one:

    ```bash
    kiro-cli chat --list-models --format json
    ```

    The response is a JSON object with a `models` array and a `default_model`; this tutorial uses `claude-sonnet-4.6`.

- A git repository on GitHub that you can push to. Test it:

    ```bash
    git ls-remote git@github.com:yourorg/yourrepo.git HEAD
    ```

    You should see a commit hash. If you get a permission error, fix your SSH or token setup before continuing.

{{% steps %}}

### Create a GitHub issue

Create an issue with the `backlog` label. Pick a task that is concrete and verifiable, because the agent reads the description as its primary instruction.

```bash
gh issue create --repo yourorg/yourrepo \
  --title "Create a health check endpoint" \
  --body "Add a /healthz endpoint that returns HTTP 200 with {\"status\": \"ok\"}. Create the handler file and a basic test." \
  --label backlog
```

Note the issue number in the output (for example, `#7`). We will see it in the logs later.

Vague descriptions like "improve the API" produce vague results; concrete tasks like adding a file or writing a test work best with any coding agent.

### Set up the project directory

Create a directory for this tutorial, separate from the GitHub integration work:

```bash
mkdir sortie-kiro-e2e && cd sortie-kiro-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the configuration below. Replace `yourorg/yourrepo` with your repository in the three places it appears: the tracker project, the clone URL, and the pull-request target.

```jinja {filename="WORKFLOW.md",hl_lines=["39-44","46-53"]}
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: yourorg/yourrepo
  active_states:
    - backlog
    - in-progress
  handoff_state: review
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
    git diff --cached --quiet || {
      git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
      git push origin "sortie/${SORTIE_ISSUE_IDENTIFIER}" --force-with-lease
      gh pr create \
        --repo yourorg/yourrepo \
        --head "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
        --base main \
        --fill \
        2>/dev/null || true
    }
  timeout_ms: 120000

agent:
  kind: kiro
  command: kiro-cli
  max_turns: 5
  turn_timeout_ms: 1800000
  max_concurrent_agents: 1

kiro:
  model: claude-sonnet-4.6
  trust_tools:
    - read
    - grep
    - glob
    - write
    - shell

server:
  port: 8642
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

If you arrived from the Copilot tutorial, the tracker, polling, workspace, hooks, and server sections will look familiar. The Kiro-specific work sits in the highlighted `agent` and `kiro` blocks. Three things are worth a closer look.

### Agent: Kiro CLI instead of Copilot

`agent.kind: kiro` selects the Kiro CLI adapter, registered under the `kiro` kind. `agent.command: kiro-cli` is the binary Sortie launches, resolved from `PATH` at session start. Each turn runs one `kiro-cli chat --no-interactive` subprocess to completion.

`agent.turn_timeout_ms: 1800000` gives each turn 30 minutes. For most adapters the turn timeout is a safety net; for Kiro it is the only backstop, because the CLI has no native per-turn timeout. If a turn stalls, this deadline ends it.

The `kiro:` block is the adapter-specific pass-through. If you came from the Copilot tutorial, here is the mapping:

| Setting | `copilot-cli:` block | `kiro:` block |
|---|---|---|
| Model | `model: gpt-4.1` | `model: claude-sonnet-4.6` |
| Tool permissions | on by default | `trust_tools: [read, grep, glob, write, shell]` |
| Inner step budget | `max_autopilot_continues: 50` | none; bounded by `turn_timeout_ms` |

Two Kiro specifics drive that block. The model must be pinned with `model:`, because Kiro's interactive `/model` switch does not exist in headless mode; the adapter passes `--model` on every turn. Pin one of the names `--list-models` returned earlier. The `trust_tools` list is the set of tools the agent may run without a confirmation prompt, which matters because a headless turn has no human to approve anything. A read-only set (`read`, `grep`, `glob`) is the least-privilege starting point, and this task has to create a file and run tests, so we add `write` and `shell`. The block also accepts `trust_all_tools` and a custom `agent` selector; those, and how the trust mode is serialized, live in the [Kiro adapter reference](/reference/adapter-kiro/).

### Authentication and budgeting

Two credentials do two jobs, and they are unrelated. `SORTIE_GITHUB_TOKEN` is the tracker token from the GitHub integration tutorial; `KIRO_API_KEY` authenticates the Kiro CLI to its backend. Both must be set in the shell you launch Sortie from.

| Variable | Consumed by | Purpose |
|---|---|---|
| `SORTIE_GITHUB_TOKEN` | Sortie tracker | Reads and transitions GitHub issues. Set in the GitHub integration tutorial. |
| `KIRO_API_KEY` | Kiro CLI agent | Authenticates the agent. Requires a Kiro Pro, Pro+, or Power subscription. |

Budgeting also works differently. The headless Kiro path reports no token counts, only an abstract credits figure, so Sortie emits no token-usage events and the dashboard's token total stays at zero. Budget enforcement is time-based: `agent.turn_timeout_ms` is the control, not a token cap. The [Kiro adapter reference](/reference/adapter-kiro/) covers the full accounting story.

### The credential preflight (why your first run will not hang)

Headless Kiro handles a missing credential and an invalid one differently, and neither is friendly. With no credential at all, `kiro-cli chat` does not error; it drops into an interactive device-login flow and waits, which would hang an unattended run. With an invalid key it exits fast but quietly, producing an empty turn rather than a clear failure. Sortie closes both gaps: at session start, before any turn runs, it confirms `KIRO_API_KEY` is set and validates it against your account. A missing or unusable credential stops the session immediately with a clear error in the log, so your first run fails loudly and early instead of hanging or completing empty. That is the same `kiro-cli whoami` check you ran in the prerequisites.

### Workspace and hooks

The workspace and hooks behave as they did in the Copilot tutorial. `workspace.root` gives each issue its own clone; `after_create` clones the repository, `before_run` cuts a clean branch from `origin/main`, and `after_run` commits and pushes. The one addition here is the `gh pr create` line in `after_run`: it opens the pull request after the first push and no-ops on later turns, using the `gh` CLI you authenticated earlier, with `--fill` taking the title and body from the commit. For the hook lifecycle and the environment variables hooks receive, see the [workspace and hooks section of the Copilot tutorial](/getting-started/github-copilot-end-to-end/#workspace-and-hooks).

### Prompt template

The body after the closing `---` is a Go `text/template` rendered per issue, branching on first run, continuation, and retry. It is agent-agnostic: the same template drove Copilot, Codex, and OpenCode, and it is unchanged here. The `#{{ .issue.identifier }}` prefix uses GitHub's `#7` convention. For the full walkthrough of the branches and template functions, see the [prompt template section of the Copilot tutorial](/getting-started/github-copilot-end-to-end/#prompt-template).

### Validate the configuration

Check for syntax errors and misconfigured fields before running:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors. Confirm with `echo $?`, which should print `0`.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-kiro-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-kiro-e2e/.sortie.db
level=INFO msg="http server listening" address=127.0.0.1:8642
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace created" issue_id=7 issue_identifier=7
level=INFO msg="hook started" hook=after_create issue_identifier=7
level=INFO msg="hook completed" hook=after_create issue_identifier=7
level=INFO msg="hook started" hook=before_run issue_identifier=7
level=INFO msg="hook completed" hook=before_run issue_identifier=7
level=INFO msg="workspace prepared" issue_id=7 issue_identifier=7 workspace=…/workspaces/7
level=INFO msg="agent session started" issue_id=7 issue_identifier=7 session_id=…
level=INFO msg="turn started" issue_id=7 issue_identifier=7 turn_number=1 max_turns=5
```

The agent is now working. That `agent session started` line confirms the credential preflight passed: Sortie validated `KIRO_API_KEY` before launching the first turn. A Kiro session for this task usually finishes in 3 to 10 minutes, depending on repository size and the model; the 30-minute `turn_timeout_ms` is the backstop, not the expected duration. Kiro's stdout transcript appears in the log at `debug` level as the agent reads files and writes code.

When the agent finishes a turn, you will see:

```
level=INFO msg="turn completed" issue_id=7 issue_identifier=7 turn_number=1 max_turns=5
level=INFO msg="hook started" hook=after_run issue_identifier=7
level=INFO msg="hook completed" hook=after_run issue_identifier=7
level=INFO msg="worker exiting" issue_id=7 issue_identifier=7 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=7 issue_identifier=7 handoff_state=review
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is the full lifecycle, step by step:

1. Sortie polled GitHub and found issue #7 with the `backlog` label.
2. `after_create` cloned the repository into `workspaces/7/`.
3. `before_run` created the branch `sortie/7` from `origin/main`.
4. Sortie ran the credential preflight, then launched `kiro-cli chat --no-interactive` with your pinned model and tool allowlist.
5. Kiro read the codebase, wrote the implementation, ran the test, and completed the turn.
6. `after_run` committed the change, pushed `sortie/7`, and opened the pull request.
7. Sortie removed the `backlog` label, added `review`, and left the issue open with the PR attached.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Four things should be visible now: the code in the workspace, the branch on your remote, the issue and PR on GitHub, and the session in the dashboard.

### Check the workspace

Look at the git log in the workspace directory:

```bash
cd workspaces/7
git log --oneline -5
```

You should see the agent's commit at the top:

```
a1b2c3d sortie(7): automated changes
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
git ls-remote git@github.com:yourorg/yourrepo.git "refs/heads/sortie/7"
```

You should see a commit hash. The `sortie/7` branch is on GitHub.

### Check GitHub

Open the issue, or check from the command line:

```bash
gh issue view 7 --repo yourorg/yourrepo
```

The issue is open, the `backlog` label is gone, and the `review` label is present. The handoff moved the issue to review rather than closing it, because `review` is not a terminal state. Now confirm the pull request:

```bash
gh pr list --repo yourorg/yourrepo --head "sortie/7"
```

You should see one open pull request from `sortie/7` into `main`.

If the label did not change, check the Sortie logs for the transition error. A missing `review` label is not the cause — GitHub creates one on demand when Sortie applies it. The usual culprit is a token without Issues write permission on the repository.

### Check the dashboard

Open [http://127.0.0.1:8642/](http://127.0.0.1:8642/) in a browser while Sortie is running, the port from `server.port`. You will see summary cards and a run history table with the completed session: its issue identifier, turn count, duration, and exit status. The token total reads zero, which is expected for Kiro, as the budgeting note above explains.

### Troubleshooting

**The run shows no token-usage numbers.** The logs carry no token counts and the dashboard token total stays at zero. This is not an error: the headless Kiro path reports only an abstract credits figure, never tokens, so Sortie cannot emit token usage. Budget is time-based, so tune `agent.turn_timeout_ms` rather than a token cap.

**The worker fails at session start with an authentication error.** You see `agent session start: KIRO_API_KEY is invalid or expired` (or `... is not set`), and no `agent session started` line follows. The key is missing, invalid, or the account lacks a Kiro Pro, Pro+, or Power subscription. Confirm with `kiro-cli whoami`; a good key prints your authenticated account.

**A turn hits the turn timeout.** The turn ends at the `turn_timeout_ms` backstop and the worker reports a cancelled turn. The cause is a stuck turn. The credential preflight prevents the no-credential device-login hang, so the usual culprit is a bad model name or a genuinely long task. Verify both with `kiro-cli whoami` and `kiro-cli chat --list-models --format json`.

For the full behavior matrix, including exit-code classification, output shape, and resume, see the [Kiro adapter reference](/reference/adapter-kiro/).

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the Kiro CLI on GitHub Issues, from a labeled issue to an open pull request, with no manual intervention.

- **Poll** - Sortie watched GitHub for issues labeled `backlog`.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch.
- **Code** - Kiro read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed, pushed, and opened the pull request.
- **Handoff** - Sortie moved the issue to its `review` state.

Sortie's adapter-agnostic design means swapping the agent is a config change. This is the same loop that produced the [Claude Code](/getting-started/jira-claude-end-to-end/), [Copilot CLI](/getting-started/github-copilot-end-to-end/), [Codex](/getting-started/jira-codex-end-to-end/), and [OpenCode](/getting-started/jira-opencode-end-to-end/) results, with one config change: the agent.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/) - conditionals, iteration, and template functions for production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - session counts and retry rates as time-series metrics
- [Kiro CLI adapter reference](/reference/adapter-kiro/) - configuration, headless output, the credential preflight, and time-based budgeting
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - remote execution for production workloads
