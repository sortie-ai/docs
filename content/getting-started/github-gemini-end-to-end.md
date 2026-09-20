---
title: "Run the Full Cycle with Gemini CLI"
linkTitle: "GitHub + Gemini CLI End-to-End"
description: "Tutorial: connect Sortie to GitHub Issues and Gemini CLI over the Agent Client Protocol, clone a repo, let the agent write code, push to a branch, and watch the issue move to review."
author: Sortie AI
date: 2026-09-11
weight: 130
---
In this tutorial, we will wire Sortie to GitHub Issues and Gemini CLI, then watch the full cycle run on its own: Sortie picks up a labeled issue, clones your repository, Gemini CLI writes the code, Sortie's hooks commit it and push a branch, and the issue moves to review. What sets this walkthrough apart is how Sortie reaches the agent: through the [Agent Client Protocol kind](/reference/adapter-agent-client-protocol/), a runtime-neutral kind any protocol-speaking runtime can sit behind. Only the command line makes this run Gemini.

## Prerequisites

- [GitHub integration tutorial](/getting-started/github-integration/) completed: `SORTIE_GITHUB_TOKEN` is set, and the four state labels (`backlog`, `in-progress`, `review`, `done`) exist on your repository.
- Node.js 20 or later, and Gemini CLI installed from npm:

    ```bash
    npm install -g @google/gemini-cli
    gemini --version
    ```

    You should see a version string. If the command is not found, see the [Gemini CLI installation guide](https://geminicli.com/docs/get-started/installation/).

- A Gemini credential. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey) and export it (a login you already stored by signing in to Gemini CLI works too):

    ```bash
    export GEMINI_API_KEY="your-gemini-api-key"
    ```

    Confirm it works before Sortie is involved:

    ```bash
    gemini --skip-trust -p "reply with ok"
    ```

    Gemini answers `ok`. Keep `--skip-trust`, which the workflow passes too: without it, Gemini refuses a one-shot prompt in a folder it does not trust. With no credential, it prints `Please set an Auth method` instead.

- A git repository on GitHub that you can push to:

    ```bash
    git ls-remote git@github.com:yourorg/yourrepo.git HEAD
    ```

    You should see a commit hash. Make it a throwaway repository, for a reason the workflow section explains. The scratch repository from the GitHub integration tutorial fits: it has the labels, and your token reaches it.

- A Linux or macOS machine. Gemini CLI on this route has [not been qualified on Windows](/reference/agent-client-protocol-gemini/#live-qualification-on-windows-is-unobserved).

{{% steps %}}

### Create a GitHub issue

Create an issue with the `backlog` label and a concrete description, which the agent reads as its instruction. This one sticks to Node.js built-in modules, so no `npm install` puts `node_modules` into the commit:

```bash
gh issue create --repo yourorg/yourrepo \
  --title "Create a health check endpoint" \
  --body "Add a /healthz endpoint that returns HTTP 200 with {\"status\": \"ok\"}. Use only Node.js built-in modules: serve it from server.js with node:http and test it in server.test.js with node:test. Add no npm dependencies." \
  --label backlog
```

Note the issue number in the output (for example, `#8`). We will see it in the logs later.

### Set up the project directory

Create a directory for this tutorial:

```bash
mkdir sortie-gemini-e2e && cd sortie-gemini-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the configuration below. Replace `yourorg/yourrepo` in both places it appears: the tracker project and the clone URL.

```jinja {filename="WORKFLOW.md",hl_lines=["33-34",37]}
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
    git diff --cached --quiet || \
      git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
    git push origin "sortie/${SORTIE_ISSUE_IDENTIFIER}" --force-with-lease
  timeout_ms: 120000

agent:
  kind: agent-client-protocol
  command: gemini --acp --skip-trust --approval-mode yolo
  max_turns: 3
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

Everything above `agent:` matches the Copilot walkthrough. The highlighted lines are where this route differs, and no extension block follows them: a first run on this kind needs none.

### Agent: a protocol kind and a command line

`agent.kind: agent-client-protocol` tells Sortie to launch whatever `agent.command` names, keep that process alive for the whole session, and send each turn to it as a `session/prompt` request. The kind has no default binary, no model key, and no permission settings, so the runtime and all its options live in one string:

| Part of `agent.command` | Effect |
|---|---|
| `gemini` | The Gemini CLI binary, found on your `PATH` at session start. |
| `--acp` | Starts Gemini in Agent Client Protocol mode instead of its interactive interface. |
| `--skip-trust` | Trusts the checked-out workspace for this session. In a folder it does not trust, Gemini silently drops Sortie's tool servers and stops auto-approving tools. |
| `--approval-mode yolo` | Auto-approves every tool Gemini runs, its shell included. Without it, Sortie declines each approval request and the call never runs. |

The file pins no model, so Gemini uses its own default. There is no `model:` field on this kind; you would pin one by adding `--model <id>` to the same string, as the [Gemini CLI runtime reference](/reference/agent-client-protocol-gemini/#installation-and-configuration) describes.

### Before you run it: what `--approval-mode yolo` allows

With this flag, Gemini runs any command the model decides to run, with your user account's permissions, and nobody reviews it first. That lets an unattended run finish, and it is why this run points at a throwaway repository. The `gemini` process also inherits every variable in the shell that starts Sortie, `SORTIE_GITHUB_TOKEN` included, so scope that token to the throwaway repository alone. Past this first run, put the agent in a container or another hardened sandbox; the Gemini reference's [approval posture section](/reference/agent-client-protocol-gemini/#workspace-trust-and-approval-posture) describes a narrower posture.

### Authentication and budgeting

`SORTIE_GITHUB_TOKEN` lets Sortie read issues and swap their labels; `GEMINI_API_KEY`, or your stored login, authenticates Gemini CLI. Sortie never reads or checks the Gemini credential. The `gemini` process signs itself in from the environment it inherits, as it did for your `reply with ok` check, so start Sortie from that same shell.

Budgeting follows the runtime and where it runs, not the kind on its own. Sortie measures a local Gemini session by reading the runtime's own telemetry, so a token ceiling has something to count here, provided the build you installed is one Sortie's source recognizes; the [Gemini CLI reference's token accounting section](/reference/agent-client-protocol-gemini/#token-accounting-depends-on-the-build-and-its-in-turn-signal-understates) names the build and the conditions that decide which way a session went. The limits that bound this run sit in the file either way: `max_turns: 3` caps the turns per session, `turn_timeout_ms` stops any turn at 30 minutes, `stall_timeout_ms` stops one that goes five minutes without an event, and `max_concurrent_agents: 1` runs one Gemini process at a time. See [How to Control Agent Costs](/guides/control-costs/#limit-turns-per-session) for the limits that apply.

### Workspace and hooks

The hooks are the Copilot walkthrough's, unchanged: `after_create` clones the repository, `before_run` cuts a `sortie/<issue>` branch from `origin/main`, and `after_run` commits what the agent left and pushes the branch. Nothing in this file opens a pull request. The [workspace and hooks section of the Copilot walkthrough](/getting-started/github-copilot-end-to-end/#workspace-and-hooks) covers the hook lifecycle and the variables hooks receive.

### Prompt template

The body after the closing `---` is the Copilot walkthrough's template, unchanged and with nothing specific to Gemini. Its [prompt template section](/getting-started/github-copilot-end-to-end/#prompt-template) explains how it renders.

### Validate the configuration

Check the file before running it:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors and no warnings; `echo $?` should print `0`. The mock agent's `agent.kind.no_tool_channel` warning is gone, because this kind hands Sortie's tools to a local Gemini session.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this (timestamps and IDs will differ, a few startup lines are trimmed, and the `tick completed` lines carry more fields than shown):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-gemini-e2e/WORKFLOW.md server_addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="running hook" issue_id=8 issue_identifier=8 hook=after_create workspace=…/workspaces/8
level=INFO msg="running hook" issue_id=8 issue_identifier=8 hook=before_run workspace=…/workspaces/8
level=INFO msg="workspace prepared" issue_id=8 issue_identifier=8 workspace=…/workspaces/8
level=INFO msg="agent session started" issue_id=8 issue_identifier=8 session_id=dae20664-…
level=INFO msg="agent implementation" component=clientprotocol-adapter session_id=dae20664-… name=gemini-cli version=0.x.x
level=INFO msg="turn started" issue_id=8 issue_identifier=8 session_id=dae20664-… turn_number=1 max_turns=3
level=INFO msg="tool call completed" issue_id=8 issue_identifier=8 session_id=dae20664-… tool=read duration_ms=2 outcome=success
level=INFO msg="tool call completed" issue_id=8 issue_identifier=8 session_id=dae20664-… tool=edit duration_ms=3 outcome=success
```

Notice the `agent implementation` line: it names the runtime and version that answered Sortie's protocol handshake. Each `tool call completed` line is one Gemini action finishing; `tool` names the kind of action, such as `read`, `edit`, or `execute`.

This task took one to two minutes in our runs. A larger repository takes longer; the 30-minute `turn_timeout_ms` is the backstop, not the expected duration.

When Gemini finishes, you will see:

```
level=INFO msg="turn completed" issue_id=8 issue_identifier=8 session_id=dae20664-… turn_number=1 max_turns=3
level=INFO msg="agent signaled status, exiting worker" issue_id=8 issue_identifier=8 session_id=dae20664-… status=needs-human-review turns_completed=1
level=INFO msg="running hook" issue_id=8 issue_identifier=8 session_id=dae20664-… hook=after_run workspace=…/workspaces/8
level=INFO msg="worker exiting" issue_id=8 issue_identifier=8 session_id=dae20664-… exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=8 issue_identifier=8 session_id=dae20664-… handoff_state=review target_state=review no_change_declared=false
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

The `agent signaled status` line is Gemini saying it is done: Sortie's first-turn prompt asks every agent to write `.sortie/status` once its work is ready for review, so Sortie ended the session after one turn. Had Gemini skipped that step, you would see `issue state refreshed` and another turn, up to three. No line marks the Gemini process ending; Sortie stops it after the last turn, silently at the default log level.

Here is the full lifecycle, step by step:

1. Sortie polled GitHub and found issue #8 with the `backlog` label.
2. `after_create` cloned the repository into `workspaces/8/`.
3. `before_run` created the branch `sortie/8` from `origin/main`.
4. Sortie launched `gemini --acp --skip-trust --approval-mode yolo` in the workspace and opened a protocol session.
5. Gemini wrote the endpoint and its test, ran its checks, and signaled that the work was ready.
6. Sortie stopped Gemini, and `after_run` committed the change and pushed `sortie/8`.
7. Sortie removed the `backlog` label and added `review`, leaving the issue open for a human.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Check four places: the workspace, your remote, the issue on GitHub, and the dashboard.

### Check the workspace

Look at the workspace's git log:

```bash
cd workspaces/8
git log --oneline -5
```

You should see the agent's commit at the top (`grafted` marks the edge of the shallow clone):

```
f979781 (HEAD -> sortie/8) sortie(8): automated changes
20cbd65 (grafted, origin/main, origin/HEAD, main) Initial commit
```

Check what the agent produced:

```bash
git diff HEAD~1 --stat
```

You should see the two files the issue asked for, similar to:

```
 server.js      | 20 ++++++++++++++++++++
 server.test.js | 51 +++++++++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 71 insertions(+)
```

### Check the remote branch

Verify the branch exists on your remote:

```bash
git ls-remote git@github.com:yourorg/yourrepo.git "refs/heads/sortie/8"
```

You should see a commit hash. The `sortie/8` branch is on GitHub, ready for a pull request you open yourself.

### Check GitHub

Check the issue from the command line:

```bash
gh issue view 8 --repo yourorg/yourrepo
```

The issue is open, `backlog` is gone, and `review` is present. If the label did not change, check the Sortie log for the transition error; the usual culprit is a token without Issues write permission.

### Check the dashboard

The dashboard is served only while Sortie runs, so start it again with `sortie ./WORKFLOW.md` and open `http://127.0.0.1:7678/`. Run History lists issue `8` as `succeeded`, with `Attempt 1` and `Turns 1` in its expanded row. The Total Tokens card reads `0`, and runs on this kind never add to it. While Gemini works on your next issue, its expanded Running Sessions row says why: Usage reporting reads `this session reports no token usage`, and Model, API Requests, and Tokens show a dash.

### Troubleshooting

**`sortie validate` prints `error: agent.command: agent.command is required for agent kind "agent-client-protocol"`.** The `command:` line is missing or empty, and this kind has no default. Restore `command: gemini --acp --skip-trust --approval-mode yolo`.

**The session never starts, and the log repeats `worker run failed, scheduling retry`.** The error ends in Gemini's own message, for example `Gemini API key is missing or not configured.`, after a burst of `agent stderr` warnings. Gemini found no credential in the environment Sortie started with. Stop Sortie, export `GEMINI_API_KEY` in that shell, rerun the `reply with ok` check, and start Sortie again.

**Gemini's edits fail and the log warns `a tool call was gated by consent in a session that delivered tool servers`.** `--skip-trust` is missing from `agent.command`, so Gemini asks before each edit and Sortie declines every ask. Put the flag back.

**A turn ends with `turn timeout exceeded` or `stall detected, cancelling worker`.** Gemini ran past `turn_timeout_ms` or went quiet for `stall_timeout_ms`, and Sortie schedules a retry. Confirm the `reply with ok` check still answers promptly; for a long task, raise `turn_timeout_ms`.

**A re-dispatched issue runs in a different Gemini session.** A first run never meets this, because every turn of a session goes to one Gemini process. When Sortie re-dispatches an issue, for example after a stall, it asks Gemini to reload the earlier session. A confirmed reload keeps the earlier `session_id` on `agent session started`; otherwise Sortie opens a fresh session in the same workspace, sometimes after a `continuation call failed` or `continuation call timed out` warning, and the run carries on. Nothing needs fixing; the [session resume mechanism](/reference/adapter-agent-client-protocol/#session-resume-mechanism) and Gemini's [continuation notes](/reference/agent-client-protocol-gemini/#session-continuation-replays-history-with-two-traps) explain both outcomes.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with Gemini CLI on GitHub Issues, from a labeled issue to a pushed branch and an issue in review, with no manual step.

- **Poll**: Sortie watched GitHub for issues labeled `backlog`.
- **Clone**: The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch**: The `before_run` hook created a clean feature branch.
- **Code**: Gemini CLI, driven over the Agent Client Protocol, wrote the endpoint and its test.
- **Push**: The `after_run` hook committed the change and pushed the branch.
- **Handoff**: Sortie moved the issue to its `review` state.

What carries over is the shape of the `agent` block: another runtime that speaks the Agent Client Protocol runs on this same kind, with `agent.kind` unchanged and a different `agent.command`.

Where to go next:

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): session lifecycle, capabilities, and token accounting on this kind
- [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/): launch switches, approval posture, and Gemini's limits on this route
- [WORKFLOW.md configuration reference](/reference/workflow-config/): every field and default
- [Write a prompt template](/guides/write-prompt-template/): conditionals and template functions for production prompts
- [Control agent costs](/guides/control-costs/): turn, time, and concurrency limits
- [Monitor with logs](/guides/monitor-with-logs/): read structured logs during long sessions
