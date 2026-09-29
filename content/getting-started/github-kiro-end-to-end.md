---
title: "Run the Full Cycle with Kiro CLI"
linkTitle: "GitHub + Kiro End-to-End"
description: "Tutorial: connect Sortie to GitHub Issues and the Kiro CLI, clone a repo, let the agent write code, push to a branch, open a pull request, and watch the issue transition."
author: Sortie AI
date: 2026-05-29
weight: 90
---
In this tutorial, we will wire Sortie to GitHub Issues and Kiro CLI, then watch the full cycle run without you touching it: Sortie picks up a labeled issue from GitHub, clones your repository, Kiro CLI writes and commits the code, Sortie pushes the branch and opens a pull request, and the issue moves to its review state. This builds on the [GitHub integration tutorial](/getting-started/github-integration/) and adds three pieces: Kiro CLI as the agent, workspace hooks for git, and a prompt template. The tracker stays GitHub, exactly as it was in the [Copilot CLI tutorial](/getting-started/github-copilot-end-to-end/). Only the agent changes. If you already have a Sortie configuration for Kiro CLI that you want to update, see [how to run Kiro CLI in ACP mode](/guides/run-kiro-cli-in-acp-mode/) instead.

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

- A Kiro CLI login stored on the machine that runs Sortie. A stored login is what lets Sortie's own tools reach the agent; an API key does not (the [Kiro CLI reference](/reference/agent-client-protocol-kiro/#which-login-delivers-sorties-tools) explains why). Make sure no API key is set in your shell, then sign in:

    ```bash
    unset KIRO_API_KEY
    kiro-cli login
    ```

    Kiro CLI walks you through signing in. Then confirm which account it uses:

    ```bash
    kiro-cli whoami
    ```

    You should see how you signed in and your account, for example `Logged in with GitHub` followed by your email. If the login did not take, you see `Not logged in` and the command exits with status 1. Run `kiro-cli login` again and repeat the check before you go on.

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

```jinja {filename="WORKFLOW.md",hl_lines=["40-41"]}
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
  kind: agent-client-protocol
  command: kiro-cli acp -a
  max_turns: 5
  turn_timeout_ms: 1800000
  stall_timeout_ms: 300000
  max_concurrent_agents: 1
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

If you arrived from the Copilot tutorial, the tracker, polling, workspace, and hooks sections will look familiar. The Kiro-specific work sits in the highlighted `kind` and `command` lines.

### Agent: Kiro CLI in ACP mode

`agent.kind: agent-client-protocol` tells Sortie to launch whatever `agent.command` names, keep that process alive for the whole session, and send each turn to it. The kind has no default binary and no model or permission settings of its own, so the runtime and its options live in one string:

| Part of `agent.command` | Effect |
|---|---|
| `kiro-cli` | The Kiro CLI binary, found on your `PATH` at session start. |
| `acp` | Starts Kiro CLI in ACP mode, the protocol interface Sortie drives, instead of its interactive chat. |
| `-a` | Auto-approves every tool request. Without it, Kiro CLI asks before each tool call, and an unattended run has nobody to answer. |

The file pins no model, so Kiro CLI uses your account's default. To pin one, add `--model <id>` to the same string, as the [Kiro CLI reference](/reference/agent-client-protocol-kiro/#installation-and-configuration) describes.

`agent.turn_timeout_ms: 1800000` gives each turn 30 minutes, and `agent.stall_timeout_ms: 300000` ends a turn that goes five minutes without an event. Both are wall-clock bounds the orchestrator applies whatever the agent is doing.

### Before you run it: what `-a` allows

With `-a`, Kiro CLI runs any tool the model picks, its shell included, with your user account's permissions, and nobody reviews the call first. That is what lets an unattended run finish, so point this first run at a repository you can afford to lose, and put the agent in a hardened sandbox before you use this setup for real work. The [trust-and-posture section](/reference/agent-client-protocol-kiro/#the-trust-and-posture-switch) of the reference covers the narrower alternative.

### Authentication and budgeting

Two credentials do two jobs, and they are unrelated. `SORTIE_GITHUB_TOKEN` is the tracker token from the GitHub integration tutorial, and Sortie reads it from the shell you launch it from. The Kiro CLI login is stored on your machine, and Sortie never reads it: the `kiro-cli` process signs itself in, as it did for your `whoami` check. Before it starts work on an issue, Sortie opens a short-lived session and sends one request through it, so a login that cannot answer stops the run early with an error in the log instead of a run that completes empty.

Budgeting works differently from an agent that reports tokens. Sortie has no way to measure Kiro CLI's token use on this route, so the logs carry no token counts and the dashboard's token total stays at zero. Budget enforcement is time-based: `agent.turn_timeout_ms` is the control, not a token cap. The [Kiro CLI reference](/reference/agent-client-protocol-kiro/#token-accounting-has-no-source-on-this-route) has the details.

### Workspace and hooks

The workspace and hooks behave as they did in the Copilot tutorial. `workspace.root` gives each issue its own clone; `after_create` clones the repository, `before_run` cuts a clean branch from `origin/main`, and `after_run` commits and pushes. The one addition here is the `gh pr create` line in `after_run`: it opens the pull request after the first push and no-ops on later turns, using the `gh` CLI you authenticated earlier, with `--fill` taking the title and body from the commit. For the hook lifecycle and the environment variables hooks receive, see the [workspace and hooks section of the Copilot tutorial](/getting-started/github-copilot-end-to-end/#workspace-and-hooks).

### Prompt template

The body after the closing `---` is a Go `text/template` rendered per issue, branching on first run, continuation, and retry. It is agent-agnostic: the same template drove Copilot, Codex, and OpenCode, and it is unchanged here. The `#{{ .issue.identifier }}` prefix uses GitHub's `#7` convention. For the full walkthrough of the branches and template functions, see the [prompt template section of the Copilot tutorial](/getting-started/github-copilot-end-to-end/#prompt-template).

### Validate the configuration

Check for syntax errors and misconfigured fields before running:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors and no warnings. Confirm with `echo $?`, which should print `0`. Anything printed with an `error:` prefix is a real problem to fix before running.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ, a few startup lines are trimmed, and the `tick completed` lines carry more fields than shown here):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-kiro-e2e/WORKFLOW.md
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="running hook" issue_id=7 issue_identifier=7 hook=after_create workspace=…/workspaces/7
level=INFO msg="running hook" issue_id=7 issue_identifier=7 hook=before_run workspace=…/workspaces/7
level=INFO msg="workspace prepared" issue_id=7 issue_identifier=7 workspace=…/workspaces/7
level=INFO msg="agent credential verified" issue_id=7 issue_identifier=7 duration_ms=…
level=INFO msg="agent session started" issue_id=7 issue_identifier=7 session_id=…
level=INFO msg="turn started" issue_id=7 issue_identifier=7 session_id=… turn_number=1 max_turns=5
```

Notice that no `WARN` line appears. The `agent credential verified` line is Sortie proving the Kiro CLI login answers a request, in a short-lived session of its own, before it starts the working session below it. The agent is now working. A session for this task usually finishes in a few minutes, depending on repository size and the model; the 30-minute `turn_timeout_ms` is the backstop, not the expected duration.

When the agent finishes, you will see:

```
level=INFO msg="turn completed" issue_id=7 issue_identifier=7 session_id=… turn_number=1 max_turns=5
level=INFO msg="agent signaled status, exiting worker" issue_id=7 issue_identifier=7 session_id=… status=needs-human-review turns_completed=1
level=INFO msg="running hook" issue_id=7 issue_identifier=7 session_id=… hook=after_run workspace=…/workspaces/7
level=INFO msg="worker exiting" issue_id=7 issue_identifier=7 session_id=… exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=7 issue_identifier=7 session_id=… handoff_state=review ...
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

The `agent signaled status` line is the agent saying it is done: Sortie's first-turn prompt asks every agent to write `.sortie/status` when its work is ready for review, so Sortie ended the session after one turn. Had the agent skipped that step, you would see `issue state refreshed` and another turn, up to five.

Here is the full lifecycle, step by step:

1. Sortie polled GitHub and found issue #7 with the `backlog` label.
2. `after_create` cloned the repository into `workspaces/7/`.
3. `before_run` created the branch `sortie/7` from `origin/main`.
4. Sortie verified the login in a session of its own, then launched `kiro-cli acp -a` in the workspace and opened a protocol session.
5. Kiro CLI read the codebase, wrote the implementation, ran the test, and completed the turn.
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

If the label did not change, check the Sortie logs for the transition error. The usual culprit is a token without Issues write permission on the repository.

### Check the dashboard

The dashboard is served only while Sortie runs, so start it again with `sortie ./WORKFLOW.md` and open `http://127.0.0.1:7678/` in a browser, on Sortie's default port. You will see summary cards and a run history table with the completed session: its issue identifier, turn count, duration, and exit status. The Total Tokens card reads `0`, which is expected for Kiro CLI, as the budgeting note above explains.

### Troubleshooting

**The run shows no token-usage numbers.** The logs carry no token counts and the dashboard's Total Tokens card stays at `0`. This is not an error. While a session is running, its expanded row on the dashboard reads `not reported yet` under Tokens until the first turn ends, then `not reported`. Budget is time-based, so tune `agent.turn_timeout_ms` rather than a token cap.

**The run fails before any turn.** No `agent credential verified` line appears, and the error ends in what Kiro CLI printed before it exited, for example that you are not signed in. Run `kiro-cli login`, confirm it with `kiro-cli whoami`, and start Sortie from that same shell. Sortie retries the issue on its own once the login works.

**A turn hits the turn timeout.** The turn ends at the `turn_timeout_ms` backstop, the worker reports a `turn_timeout` error, and the attempt is retried. The cause is usually a genuinely long task or a stuck turn. Check that `kiro-cli whoami` still answers promptly, and raise `turn_timeout_ms` for a long task.

For the full picture of what this route delivers and where it stops, see the [Kiro CLI reference](/reference/agent-client-protocol-kiro/).

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with Kiro CLI on GitHub Issues, from a labeled issue to an open pull request, with no manual intervention.

- **Poll**: Sortie watched GitHub for issues labeled `backlog`.
- **Clone**: The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch**: The `before_run` hook created a clean feature branch.
- **Code**: Kiro CLI, driven in ACP mode, read the codebase, wrote an implementation, and ran tests.
- **Push**: The `after_run` hook committed, pushed, and opened the pull request.
- **Handoff**: Sortie moved the issue to its `review` state.

Sortie's adapter-agnostic design means swapping the agent is a config change. This is the same loop that produced the [Claude Code](/getting-started/jira-claude-end-to-end/), [Copilot CLI](/getting-started/github-copilot-end-to-end/), [Codex](/getting-started/jira-codex-end-to-end/), and [OpenCode](/getting-started/jira-opencode-end-to-end/) results, with one config change: the agent.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/): conditionals, iteration, and template functions for production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/): every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/): read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/): session counts and retry rates as time-series metrics
- [Kiro CLI on the Agent Client Protocol](/reference/agent-client-protocol-kiro/): launch command, credentials, trust posture, and limitations
- [Scale agents with SSH](/guides/scale-agents-with-ssh/): remote execution for production workloads
