---
title: Run the Full Cycle with Gitea and OpenCode CLI
linkTitle: "Gitea + OpenCode End-to-End"
description: "Tutorial: connect Sortie to Gitea and the OpenCode CLI, clone a repo, let the agent write code, push to a branch, and hand the issue off to a review state on a fully self-hosted stack."
author: Sortie AI
date: 2026-07-16
weight: 110
---
In this tutorial, we will connect Sortie to Gitea and the OpenCode CLI, then watch the full unattended cycle: Gitea offers a `backlog` issue, Sortie clones your repository, OpenCode writes and commits code, Sortie pushes a branch, and Gitea moves the issue to a review state. This builds on the [Gitea integration tutorial](/getting-started/gitea-integration/) and adds three pieces: OpenCode as the agent, run in ACP mode, workspace hooks for git operations, and a prompt template.

The agent is the same one the [Jira + OpenCode tutorial](/getting-started/jira-opencode-end-to-end/) drives; only the tracker changed, from Jira to Gitea.

If you already have a Sortie configuration for OpenCode that you want to update, see [how to run OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/) instead.

The pairing is deliberate. Gitea is self-hosted, and OpenCode can run against a model you serve yourself, so the whole loop lives on infrastructure you control: a self-hosted tracker, the Sortie orchestrator, the OpenCode agent, and a local model backend, with no cloud model provider in the path. That is the stack the community asked for when they requested the Gitea adapter.

## Prerequisites

- The [Gitea integration tutorial](/getting-started/gitea-integration/) completed, with your local Gitea still running and `SORTIE_GITEA_ENDPOINT`, `SORTIE_GITEA_TOKEN`, and `SORTIE_GITEA_PROJECT` still set. If you removed the container at the end of that tutorial, start it again and re-provision by following [its setup steps](/getting-started/gitea-integration/).
- OpenCode CLI installed:

    ```bash
    opencode --version
    ```

    You should see a version string. Sortie resolves `opencode` from `PATH` when a session starts, so this confirms the binary it will launch. OpenCode is published on npm as `@opencode/cli`. To install it, follow the [OpenCode CLI docs](https://opencode.ai/docs/cli/).

- A locally served, OpenAI-compatible model. OpenCode reaches it through a custom provider whose `baseURL` points at your local endpoint, and the workflow below declares that provider. This tutorial calls it `local`, assumes the server listens on `http://localhost:8000/v1`, and names the model `your-model`. Replace both with your own. Confirm the server answers and lists the model:

    ```bash
    curl http://localhost:8000/v1/models
    ```

    You should see a JSON list that includes your model's id. The workflow must use that id exactly.

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

```jinja {filename="WORKFLOW.md",hl_lines=["33-57"]}
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
  kind: agent-client-protocol
  command: opencode acp
  max_turns: 3
  turn_timeout_ms: 3600000
  max_concurrent_agents: 1

agent-client-protocol:
  model: local/your-model
  permissions: approve-all
  env:
    OPENCODE_DISABLE_AUTOUPDATE: "true"
    OPENCODE_CONFIG_CONTENT: |-
      {
        "model": "local/your-model",
        "share": "disabled",
        "provider": {
          "local": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Local model",
            "options": { "baseURL": "http://localhost:8000/v1" },
            "models": { "your-model": { "name": "Your model" } }
          }
        }
      }
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

The tracker block is the Gitea block from the integration tutorial: kind `gitea`, the required endpoint, the token-verbatim `api_key`, an `owner/repo` project, and label-driven states. The `polling`, `workspace`, `hooks`, and prompt body keep the same shape as the Jira + OpenCode tutorial. The OpenCode-specific work is the highlighted `agent` and `agent-client-protocol` blocks.

One tracker detail is worth stating where you set the states. `handoff_state: review` moves each finished issue to the `review` label, and because `review` is not one of the `terminal_states`, the issue stays open, ready for a human to open a pull request from the pushed branch. Sortie will not let `handoff_state` name a terminal state, so a handoff never closes the issue on its own. For the rest of the Gitea tracker surface, the [Gitea integration tutorial](/getting-started/gitea-integration/) is the reference.

### Workspace and hooks

Nothing about the hooks is OpenCode-specific. `workspace.root` gives each Gitea issue its own clone, and the three hooks clone the repository, cut a clean branch, commit the agent's work, and push it upstream.

One detail follows from Gitea being both your tracker and your git host: `$SORTIE_REPO_URL` points at the same instance you poll, and the Gitea access token doubles as the HTTP push password. For the hook-by-hook walkthrough and the hook environment variables, read the [workspace and hooks section of the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

### Agent configuration

#### Agent: OpenCode in ACP mode

`agent.kind: agent-client-protocol` tells Sortie to launch whatever `agent.command` names, keep that process alive for the whole session, and send each turn to it. `opencode acp` starts OpenCode in ACP mode, the protocol interface Sortie drives, and Sortie resolves `opencode` from `PATH` when the session starts. The command takes no switch for a model or for permissions, so those live in the `agent-client-protocol:` block.

`permissions: approve-all` is the unattended switch, the equivalent of Claude Code's bypass mode: Sortie approves each tool request OpenCode asks about. Leave it out and Sortie refuses the request instead, because nobody is there to answer it, and the turn fails.

That setting turns off every prompt, so OpenCode runs any tool the model picks, its shell included, with your user account's permissions. Point this first run at a repository you can afford to lose, and put the agent in a hardened sandbox before you use this setup for real work.

Which tools OpenCode may use at all is reference territory, set through the `permission` member of OpenCode's configuration document. The [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/) reference covers it, and the generic kind's settings are on the [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/).

#### A locally served model backend

Two credentials are in play, and they do different jobs. `SORTIE_GITEA_TOKEN` authenticates Sortie to Gitea. The model backend is separate, and Sortie manages no credential for it: OpenCode resolves the model from the provider it finds in its own configuration.

OpenCode takes that configuration as a JSON document, and `OPENCODE_CONFIG_CONTENT` in `agent-client-protocol.env` is how the workflow hands it over. For a fully self-hosted stack, the document declares a custom provider named `local` that carries the `baseURL` of your local endpoint, and a `model` member that selects `local/your-model`, meaning "the `local` provider, then that model". The [OpenCode provider docs](https://opencode.ai/docs/providers/) cover the provider schema. No cloud model API key is involved, and the model that writes your code runs on hardware you control.

`agent-client-protocol.model` repeats the same id. Sortie does not pass it to OpenCode; it names the model that a usage-limit hold applies to. Check that the id in both places matches the one your server lists, because OpenCode runs its default model when it cannot resolve an id, and prints nothing to say so.

The other two entries keep the run self-contained. `OPENCODE_DISABLE_AUTOUPDATE` stops OpenCode from updating itself mid-session, and `"share": "disabled"` turns off OpenCode's session sharing. For every setting and how each maps from older configurations, see the [guide to running OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/).

#### Inner turn budget

`agent.max_turns: 3` is Sortie's outer budget. It tells the orchestrator how many turns it may send OpenCode for this issue before it gives up or retries later. OpenCode exposes no inner turn field to Sortie, so each Sortie turn lets OpenCode work until it finishes the turn or `turn_timeout_ms`, one hour here, elapses. The same `opencode acp` process serves every turn of the session.

For the health check task, one run is usually enough. The headroom lets the first session read the codebase, write the change, and run tests without racing a short timeout.

### Prompt template

The prompt body is the same agent-agnostic template the other end-to-end tutorials use: the first-run, continuation, and retry branches all render from one Go `text/template`. Nothing about it changes for Gitea or OpenCode, which is the point of an adapter-agnostic prompt. For the branch-by-branch walkthrough, read the [prompt template section of the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#prompt-template).

### Validate the configuration

Check the file before running it:

```bash
sortie validate ./WORKFLOW.md
```

Validation runs offline. It reports the same cleartext-HTTP advisory you saw in the integration tutorial, because the local endpoint is plain `http`; that warning is expected for a local instance. It prints no warning about the agent, and the configuration is otherwise valid.

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
level=INFO msg="running hook" issue_id=3 issue_identifier=3 hook=after_create workspace=…/workspaces/3
level=INFO msg="running hook" issue_id=3 issue_identifier=3 hook=before_run workspace=…/workspaces/3
level=INFO msg="workspace prepared" issue_id=3 issue_identifier=3 workspace=…/workspaces/3
level=INFO msg="agent credential verified" issue_id=3 issue_identifier=3 duration_ms=…
level=INFO msg="agent session started" issue_id=3 issue_identifier=3 session_id=ses_...
level=INFO msg="turn started" issue_id=3 issue_identifier=3 turn_number=1 max_turns=3
```

The agent is now working. An OpenCode session for a task like this takes a few minutes, and the wall-clock time depends on your local model's speed and your hardware more than on anything Sortie does. At `debug` level, you will see OpenCode's events as it works through the repository.

When the agent finishes the turn, you will see:

```text
level=INFO msg="turn completed" issue_id=3 issue_identifier=3 turn_number=1 max_turns=3
level=INFO msg="running hook" issue_id=3 issue_identifier=3 hook=after_run workspace=…/workspaces/3
level=INFO msg="worker exiting" issue_id=3 issue_identifier=3 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=3 issue_identifier=3 handoff_state=review
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

Here is the full lifecycle, step by step:

1. Sortie polled Gitea and found issue `#3` carrying the `backlog` label.
2. `after_create` cloned the repository into `workspaces/3/`.
3. `before_run` created the branch `sortie/3` from `origin/main`.
4. Sortie launched `opencode acp` in the workspace, opened a protocol session, and passed it the rendered prompt for the issue.
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

Open `http://127.0.0.1:7678/`. Sortie serves the dashboard there by default, with no configuration required. Sortie sends you to [Overview](/reference/dashboard/#overview), where issue `3` waits under **Ended today** with the ending "review", the handoff to a person described above. Select the row and choose **Open page** for the completed run with its status, turns, and duration.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with OpenCode, driven in ACP mode, on top of the Gitea flow you configured in the integration tutorial. The tracker behavior stayed the same. The new moving parts were the agent, the git hooks, and the prompt.

- **Poll**: Sortie watched Gitea for open issues in the `backlog` state.
- **Clone**: The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch**: The `before_run` hook created a clean feature branch.
- **Code**: OpenCode read the codebase, wrote an implementation, and ran tests.
- **Push**: The `after_run` hook committed and pushed the branch to Gitea.
- **Handoff**: Sortie moved the issue to `review` and released it for a human.

This is the same OpenCode loop that powers the [Jira + OpenCode tutorial](/getting-started/jira-opencode-end-to-end/). We swapped the tracker from Jira to Gitea with a config change and nothing else, which is the whole point of Sortie's adapter design. And because Gitea is self-hosted and the model backend runs locally, every part of the loop runs on infrastructure you own.

## Where to go next

- [Write a prompt template](/guides/write-prompt-template/): use conditionals, iteration, and template functions to build production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/): every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/): read the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/): collect token usage, session counts, and retry rates as time-series metrics
- [Gitea adapter reference](/reference/adapter-gitea/): the tracker field contract, label-driven state model, and error mapping
- [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/): launch command, where each setting goes, credentials, and limitations
- [How to run OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/): every setting of the route and how to convert an older configuration
- [Scale agents with SSH](/guides/scale-agents-with-ssh/): distribute sessions across remote machines for larger deployments
