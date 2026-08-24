---
title: Run the Full Cycle with Gitea and OpenCode CLI
linkTitle: "Gitea + OpenCode End-to-End"
description: "Tutorial: connect Sortie to Gitea and the OpenCode CLI, clone a repo, let the agent write code, push to a branch, and hand the issue off to a review state on a fully self-hosted stack."
author: Sortie AI
date: 2026-07-16
weight: 110
---
In this tutorial, we will connect Sortie to Gitea and the OpenCode CLI, then watch the full unattended cycle: Gitea offers a `backlog` issue, Sortie clones your repository, OpenCode writes and commits code, Sortie pushes a branch, and Gitea moves the issue to a review state. This builds on the [Gitea integration tutorial](/getting-started/gitea-integration/) and adds three pieces: the OpenCode CLI adapter, workspace hooks for git operations, and a prompt template. The agent is the same one the [Jira + OpenCode tutorial](/getting-started/jira-opencode-end-to-end/) drives; only the tracker changed, from Jira to Gitea.

The pairing is deliberate. Gitea is self-hosted, and OpenCode can run against a model you serve yourself, so the whole loop lives on infrastructure you control: a self-hosted tracker, the Sortie orchestrator, the OpenCode agent, and a local model backend, with no cloud model provider in the path. That is the stack the community asked for when they requested the Gitea adapter.

## Prerequisites

- The [Gitea integration tutorial](/getting-started/gitea-integration/) completed, with your local Gitea still running and `SORTIE_GITEA_ENDPOINT`, `SORTIE_GITEA_TOKEN`, and `SORTIE_GITEA_PROJECT` still set. If you removed the container at the end of that tutorial, start it again and re-provision by following [its setup steps](/getting-started/gitea-integration/).
- OpenCode CLI installed:

    ```bash
    opencode --version
    ```

    You should see a version string. Sortie resolves `opencode` from `PATH` at session start, so this confirms the binary it will launch. To install it, follow the [OpenCode CLI docs](https://opencode.ai/docs/cli/).

- A locally served, OpenAI-compatible model, exposed to OpenCode as a custom provider in your `opencode.json`. OpenCode reads provider configuration from its own config, and a custom provider carries a `baseURL` pointing at your local endpoint. The [OpenCode configuration docs](https://opencode.ai/docs/config/) cover the provider schema. This tutorial calls that provider `local` and selects it through `opencode.model`. List what OpenCode has configured with:

    ```bash
    opencode providers list
    ```

- A Gitea repository you can push to. The integration tutorial created `sortie/adapter-lab` on your local instance. A Gitea access token works as an HTTP password, so set the clone URL once and confirm you can reach it:

    ```bash
    export SORTIE_REPO_URL="http://sortie:${SORTIE_GITEA_TOKEN}@localhost:3000/sortie/adapter-lab.git"
    git ls-remote "$SORTIE_REPO_URL" HEAD
    ```

    You should see a commit hash, the `main` created when the repository was initialized. If you get an authentication error, confirm `SORTIE_GITEA_TOKEN` is still set.

{{% steps %}}

### Create a Gitea issue

Open your repository in Gitea at `http://localhost:3000/sortie/adapter-lab/issues` and create an issue a coding agent can finish without human judgment, the same scenario as the Jira + OpenCode tutorial.

- **Title:** Create a health check endpoint
- **Description:**

    > Add a `/healthz` endpoint that returns HTTP 200 with the JSON body `{"status": "ok"}`. Create the handler in its own file, register the route, and add a basic test.

- **Label:** `backlog`

The `backlog` label already exists from the integration tutorial, and it is in this workflow's `active_states`, so Sortie picks the issue up. Note the number Gitea assigns, for example `#3`. You will see it in the logs.

A concrete, verifiable task works best. A real agent reads the description as its primary instruction, so "add a `/healthz` endpoint" produces a sharper result than "improve the API."

### Set up the project directory

Create a directory for this tutorial, separate from the integration work:

```bash
mkdir sortie-gitea-opencode-e2e && cd sortie-gitea-opencode-e2e
```

### Write the workflow file

Create `WORKFLOW.md` with the full configuration:

```jinja {filename="WORKFLOW.md",hl_lines=["33-42"]}
---
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: $SORTIE_GITEA_PROJECT
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
  kind: opencode
  command: opencode
  max_turns: 3
  turn_timeout_ms: 3600000
  max_concurrent_agents: 1

opencode:
  model: local/your-model
  dangerously_skip_permissions: true
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

The tracker block is the Gitea block from the integration tutorial: kind `gitea`, the required endpoint, the token-verbatim `api_key`, an `owner/repo` project, and label-driven states. The `polling`, `workspace`, `hooks`, and prompt body keep the same shape as the Jira + OpenCode tutorial. The OpenCode-specific work is the highlighted `agent` and `opencode` blocks.

One tracker detail is worth stating where you set the states. `handoff_state: review` moves each finished issue to the `review` label, and because `review` is not one of the `terminal_states`, the issue stays open, ready for a human to open a pull request from the pushed branch. Sortie will not let `handoff_state` name a terminal state, so a handoff never closes the issue on its own. For the rest of the Gitea tracker surface, the [Gitea integration tutorial](/getting-started/gitea-integration/) is the reference.

### Workspace and hooks

Nothing about the hooks is OpenCode-specific. `workspace.root` gives each Gitea issue its own clone, and the three hooks clone the repository, cut a clean branch, commit the agent's work, and push it upstream. One detail follows from Gitea being both your tracker and your git host: `$SORTIE_REPO_URL` points at the same instance you poll, and the Gitea access token doubles as the HTTP push password. For the hook-by-hook walkthrough and the hook environment variables, read the [workspace and hooks section of the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

### Agent configuration

#### Agent: OpenCode CLI

`agent.kind: opencode` selects the OpenCode adapter, registered under the `opencode` kind. `agent.command: opencode` names the binary, which the adapter resolves from `PATH` when the session starts. The `opencode:` block is small because OpenCode folds provider selection into the model string: `local/your-model` means "use the `local` provider, then that model." There is no separate provider field to set. `dangerously_skip_permissions: true` is the unattended switch, the equivalent of Claude Code's bypass mode: it tells the CLI to approve each permissioned action itself. It is also the default. Setting it to `false` does not make the run interactive, because there is nobody to be interactive with: the runtime auto-rejects every permissioned tool call instead, and Sortie warns about that before the run. The adapter also exposes finer tool scoping through `allowed_tools` and `denied_tools`, which is reference territory. When you need it, the [OpenCode adapter reference](/reference/adapter-opencode/) covers the full surface.

#### A locally served model backend

Two credentials are in play, and they do different jobs. `SORTIE_GITEA_TOKEN` authenticates Sortie to Gitea. The model backend is separate: OpenCode resolves the model from a provider it reads from its own configuration, and the adapter runs no authentication preflight. It launches `opencode run` with the environment it inherits plus a few managed `OPENCODE_*` overrides, and lets OpenCode find the provider.

For a fully self-hosted stack, point OpenCode at a model you serve yourself. OpenCode reaches a locally served, OpenAI-compatible backend through a custom provider defined in its `opencode.json`, where the provider carries a `baseURL` for your local endpoint. The [OpenCode configuration docs](https://opencode.ai/docs/config/) cover that provider schema. Once the `local` provider exists, `opencode.model: local/your-model` selects it, and no cloud model API key is involved. The model that writes your code runs on hardware you control.

The adapter reinforces that posture. On every run it sets `OPENCODE_DISABLE_AUTOUPDATE=true` and `OPENCODE_DISABLE_LSP_DOWNLOAD=true`, so OpenCode does not reach out to update itself or download language servers mid-session. For the full provider model and every managed variable, see the [OpenCode adapter reference](/reference/adapter-opencode/).

#### Inner turn budget

`agent.max_turns: 3` is Sortie's outer budget. It tells the orchestrator how many times it may invoke OpenCode for this issue before it gives up or retries later. OpenCode exposes no inner turn field to Sortie, so each Sortie turn launches one `opencode run` process and lets it work until it exits or `turn_timeout_ms`, one hour here, elapses. For the health check task, one run is usually enough. The headroom lets the first session read the codebase, write the change, and run tests without racing a short timeout.

### Prompt template

The prompt body is the same agent-agnostic template the other end-to-end tutorials use: the first-run, continuation, and retry branches all render from one Go `text/template`. Nothing about it changes for Gitea or OpenCode, which is the point of an adapter-agnostic prompt. For the branch-by-branch walkthrough, read the [prompt template section of the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#prompt-template).

### Validate the configuration

Check the file before running it:

```bash
sortie validate ./WORKFLOW.md
```

Validation runs offline. It reports the same cleartext-HTTP advisory you saw in the integration tutorial, because the local endpoint is plain `http`; that warning is expected for a local instance, and the configuration is otherwise valid.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this. Timestamps, IDs, and paths will differ, and the `tick completed` lines carry more fields than shown here:

```text
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-gitea-opencode-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-gitea-opencode-e2e/.sortie.db
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="running hook" hook=after_create workspace=.../workspaces/3
level=INFO msg="running hook" hook=before_run workspace=.../workspaces/3
level=INFO msg="workspace prepared" issue_id=3 issue_identifier=3 workspace=.../workspaces/3
level=INFO msg="agent session started" issue_id=3 issue_identifier=3 session_id=ses_...
level=INFO msg="turn started" issue_id=3 issue_identifier=3 turn_number=1 max_turns=3
```

The agent is now working. An OpenCode session for a task like this takes a few minutes, and the wall-clock time depends on your local model's speed and your hardware more than on anything Sortie does. At `debug` level, you will see step, text, and tool events as OpenCode works through the repository.

When the agent finishes the turn, you will see:

```text
level=INFO msg="turn completed" issue_id=3 issue_identifier=3 turn_number=1 max_turns=3
level=INFO msg="running hook" hook=after_run workspace=.../workspaces/3
level=INFO msg="worker exiting" issue_id=3 issue_identifier=3 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=3 issue_identifier=3 handoff_state=review
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

Here is the full lifecycle, step by step:

1. Sortie polled Gitea and found issue `#3` carrying the `backlog` label.
2. `after_create` cloned the repository into `workspaces/3/`.
3. `before_run` created the branch `sortie/3` from `origin/main`.
4. Sortie launched OpenCode and passed it the rendered prompt for the issue.
5. OpenCode read the codebase, wrote the change, and completed the turn.
6. `after_run` committed the changes and pushed the branch.
7. Sortie transitioned the issue to `review`. Because `review` is not terminal, the issue stays open.
8. The next poll found zero candidates and went idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Three things should be visible now: the code in the workspace, the branch on your Gitea remote, and the issue state in Gitea.

Look at the git log in the workspace:

```bash
cd workspaces/3
git log --oneline -5
```

You should see the agent's commit at the top:

```text
a1b2c3d sortie(3): automated changes
f4e5d6c (origin/main) Initial commit
```

Check what the agent produced:

```bash
git diff HEAD~1 --stat
```

This shows the files the agent created or modified for the health check endpoint.

Confirm the branch reached your Gitea remote:

```bash
git ls-remote "$SORTIE_REPO_URL" "refs/heads/sortie/3"
```

You should see a commit hash. The `sortie/3` branch is on your Gitea instance, ready for a pull request.

Open the issue in Gitea. It now carries the `review` label instead of `backlog`, and it is still open, because `review` is not a terminal state. A reviewer can open a pull request from `sortie/3`, merge it, and close the issue. That last step is intentionally human: the handoff hands work to a person, it does not close it.

Open [http://127.0.0.1:7678/](http://127.0.0.1:7678/). Sortie serves the dashboard there by default, with no configuration required. You will see summary cards and a run history row for the completed session, with its issue identifier, turn count, duration, and exit status.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with the OpenCode CLI on top of the Gitea flow you configured in the integration tutorial. The tracker behavior stayed the same. The new moving parts were the agent adapter, the git hooks, and the prompt.

- **Poll** - Sortie watched Gitea for open issues in the `backlog` state.
- **Clone** - The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch** - The `before_run` hook created a clean feature branch.
- **Code** - OpenCode read the codebase, wrote an implementation, and ran tests.
- **Push** - The `after_run` hook committed and pushed the branch to Gitea.
- **Handoff** - Sortie moved the issue to `review` and released it for a human.

This is the same OpenCode loop that powers the [Jira + OpenCode tutorial](/getting-started/jira-opencode-end-to-end/). We swapped the tracker from Jira to Gitea with a config change and nothing else, which is the whole point of Sortie's adapter design. And because Gitea is self-hosted and the model backend runs locally, every part of the loop now runs on infrastructure you own.

## Where to go next

- [Write a prompt template](/guides/write-prompt-template/) - use conditionals, iteration, and template functions to build production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/) - read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/) - collect token usage, session counts, and retry rates as time-series metrics
- [Gitea adapter reference](/reference/adapter-gitea/) - the tracker field contract, label-driven state model, and error mapping
- [OpenCode adapter reference](/reference/adapter-opencode/) - provider configuration, managed environment variables, and runtime behavior
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - distribute sessions across remote machines for larger deployments
