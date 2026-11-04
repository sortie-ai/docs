---
title: Run the Full Cycle with OpenCode CLI
linkTitle: "Jira + OpenCode End-to-End"
description: "Tutorial: connect Sortie to Jira and the OpenCode CLI, clone a repo, let the agent write code, push to a branch, and watch the issue move to In Review."
author: Sortie AI
date: 2026-04-26
weight: 80
---
In this tutorial, we will connect Sortie to Jira and OpenCode, then watch the full unattended cycle: Jira offers an `agent-ready` issue, Sortie clones your repository, OpenCode writes and commits code, Sortie pushes a branch, and Jira moves the issue to In Review. This builds on the [Jira integration tutorial](/getting-started/jira-integration/) and adds three pieces: OpenCode in ACP mode as the agent, workspace hooks for git operations, and a prompt template.

The tracker stays the same as in the [Claude Code tutorial](/getting-started/jira-claude-end-to-end/) and the [Codex tutorial](/getting-started/jira-codex-end-to-end/). Only the agent changes.

> **Jira Server and Data Center:** This tutorial uses Jira Cloud. If you are connecting to a self-hosted Jira Server or Data Center instance, see the [Jira adapter reference](/reference/adapter-jira/#api_version) for the `api_version: "2"` field and Server / Data Center configuration before continuing.

## Prerequisites

- [Jira integration tutorial](/getting-started/jira-integration/) completed: Sortie connects to your Jira project, and the environment variables `SORTIE_JIRA_ENDPOINT` and `SORTIE_JIRA_API_KEY` are set
- OpenCode installed on your machine. If `opencode-ai` is already installed, run `npm uninstall -g opencode-ai` first. Both packages provide the `opencode` command, so keep only one of them installed.

    ```bash
    npm install -g @opencode/cli
    opencode --version
    ```

    You should see a version string. Sortie resolves `opencode` from `PATH` at session start, so this confirms the binary it will launch. If the command is not found, follow the [OpenCode CLI docs](https://opencode.ai/docs/cli/).

- `ANTHROPIC_API_KEY` set in your environment:

    ```bash
    export ANTHROPIC_API_KEY="sk-ant-..."
    ```

    We use Anthropic direct in this tutorial because the workflow selects an `anthropic/...` model, and readers coming from the Claude Code tutorial often already have this key set. A login stored with `opencode auth login` works as well.

- A git repository on GitHub or GitLab that you can push to
- SSH key or HTTPS token configured for `git push` from your machine. Test it:

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

```jinja {filename="WORKFLOW.md",hl_lines=["33-45"]}
---
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  query_filter: "labels = 'agent-ready'"
  active_states:
    - To Do
  handoff_state: In Review
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
  kind: agent-client-protocol
  command: opencode acp
  max_turns: 3
  turn_timeout_ms: 3600000
  max_concurrent_agents: 1

agent-client-protocol:
  model: anthropic/claude-sonnet-4-5
  permissions: approve-all
  env:
    OPENCODE_DISABLE_AUTOUPDATE: "true"
    OPENCODE_CONFIG_CONTENT: '{"model":"anthropic/claude-sonnet-4-5","share":"disabled"}'
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

This file should feel familiar if you finished the Claude tutorial. The tracker, polling, workspace, hooks, and prompt body stay in the same shape. The OpenCode-specific work is concentrated in the `agent` block and the `agent-client-protocol` block.

> [!WARNING]
> The `tracker` section is the one you already validated, so `In Review` should exist in your workflow and be reachable from `To Do`. If you changed projects since then, check **Project settings → Workflows** again. A handoff target that Jira cannot reach leaves the issue where it is and Sortie retries the transition on every poll cycle.

If you compare this tutorial workflow with the repository sample, you will notice that the sample adds production-oriented settings like `in_progress_state`, `before_remove`, `disable_autocompact`, and an explicit `allowed_tools` policy. We leave those out here so the first run stays focused and easy to verify.

### Workspace and hooks

Nothing changes here. `workspace.root` still gives each Jira issue its own clone, and the three hooks still clone the repository, create a clean branch, commit the agent's work, and push it upstream. If you want the full hook-by-hook walkthrough and the hook environment variable table, read the [workspace and hooks section in the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#workspace-and-hooks).

### Agent configuration

#### Agent: OpenCode in ACP mode

`agent.kind: agent-client-protocol` tells Sortie to launch whatever `agent.command` names, keep that process alive for the whole session, and send each turn to it. The kind has no default binary, so `agent.command: opencode acp` names it: `opencode` is found on your `PATH` at session start, and `acp` starts OpenCode in ACP mode, the protocol interface Sortie drives. The `acp` subcommand takes no switch for a model or for permissions, so those live in the `agent-client-protocol` block.

The block carries these settings:

- `permissions: approve-all` approves every tool call OpenCode asks about. Without it, Sortie refuses the request, because nobody is there to answer, and the turn fails. A tool that OpenCode's own rules deny stays denied.
- `env` hands OpenCode its environment. `OPENCODE_DISABLE_AUTOUPDATE` stops it from updating itself in the middle of a run. `OPENCODE_CONFIG_CONTENT` is OpenCode's own configuration document as a JSON string: its `model` member selects the model, and `"share":"disabled"` keeps sessions private.
- `model` repeats the model id for Sortie, which uses it to scope a usage-limit hold. Keep the two ids identical.

OpenCode rolls provider selection into the model string: `anthropic/claude-sonnet-4-5` means "use Anthropic, then use that model." Swap in any provider and model pair OpenCode lists in its [provider docs](https://opencode.ai/docs/providers/), and check the id for typos. OpenCode runs its default model when it cannot resolve an id, and prints nothing to say so.

The block holds more: a reasoning level, named agents, tool allow and deny rules. That is reference territory, covered under [where each setting goes](/reference/agent-client-protocol-opencode/#where-each-setting-goes) in the OpenCode reference.

### Before you run it: what `approve-all` allows

With `approve-all`, OpenCode runs any tool the model picks, its shell included, with your user account's permissions, and nobody reviews the call first. That is what lets an unattended run finish, so point this first run at a repository you can afford to lose, and put the agent in a hardened sandbox before you use this setup for real work.

#### Authentication: OpenCode multi-provider model

Two credentials are involved in this run, and they do different jobs. `SORTIE_JIRA_API_KEY` authenticates Sortie to Jira. `ANTHROPIC_API_KEY` authenticates OpenCode to the model provider we chose in the model id. Keep those roles separate in your head and in your shell: Jira talks to Jira, OpenCode talks to Anthropic.

Sortie never reads `ANTHROPIC_API_KEY`. The `opencode` process reads it itself, and a local run inherits the environment of the Sortie process, so export the key in the shell you start Sortie from. Before it starts work on an issue, Sortie opens a short-lived session in which every tool is denied, so a credential that cannot answer stops the run early with an error in the log instead of a run that completes empty.

OpenCode can target multiple providers through the same CLI, including Anthropic and OpenAI, but this tutorial takes one path on purpose. For the other ways OpenCode finds a provider credential, including a stored login, see [Credentials](/reference/agent-client-protocol-opencode/#credentials) in the OpenCode reference.

#### Inner turn budget

`agent.max_turns: 3` is Sortie's outer budget. It tells the orchestrator how many turns it may send to OpenCode for this issue before it gives up or retries later. There is no second, inner turn limit in the `agent-client-protocol` block. Sortie launches one `opencode acp` process per session, sends each turn to it, and ends a turn when OpenCode reports it finished or when `turn_timeout_ms` expires.

With this workflow, Sortie can give the issue up to three turns, and each turn can last up to one hour. For the health check task in this tutorial, one turn is usually enough. The extra headroom is there so the first turn can read the codebase, write the change, and run tests without racing a short timeout.

### Prompt template

The prompt body is the same template shape from the Claude tutorial: first run, continuation, and retry all render from the same Go `text/template` branches. That is deliberate. The prompt is agent-agnostic, so we do not need a special OpenCode version. If you want the full walkthrough of those branches, read the [prompt template section in the Claude Code tutorial](/getting-started/jira-claude-end-to-end/#prompt-template), then come back here to run it with a different agent.

### Validate the configuration

Check for syntax errors before running:

```bash
sortie validate ./WORKFLOW.md
```

No output means no errors and no warnings. Confirm with `echo $?`, which should print `0`. Anything printed with an `error:` prefix is a real problem to fix before running.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output similar to this. Timestamps, IDs, and paths will differ, and the `tick completed` lines carry more fields than shown here:

```text
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-opencode-e2e/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-opencode-e2e/.sortie.db
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="running hook" issue_id=10042 issue_identifier=PROJ-55 hook=after_create workspace=…/workspaces/PROJ-55
level=INFO msg="running hook" issue_id=10042 issue_identifier=PROJ-55 hook=before_run workspace=…/workspaces/PROJ-55
level=INFO msg="workspace prepared" issue_id=10042 issue_identifier=PROJ-55 workspace=…/workspaces/PROJ-55
level=INFO msg="agent credential verified" issue_id=10042 issue_identifier=PROJ-55 duration_ms=…
level=INFO msg="agent session started" issue_id=10042 issue_identifier=PROJ-55 session_id=…
level=INFO msg="turn started" issue_id=10042 issue_identifier=PROJ-55 turn_number=1 max_turns=3
```

The agent is now working. An OpenCode session for this task usually takes 3 to 15 minutes, depending on repository size, provider latency, and how much code the agent needs to inspect before it writes anything. At `debug` level, you will see the events OpenCode reports as it works through the repository.

When the agent finishes a turn, you will see:

```text
level=INFO msg="turn completed" issue_id=10042 issue_identifier=PROJ-55 turn_number=1 max_turns=3
level=INFO msg="running hook" issue_id=10042 issue_identifier=PROJ-55 hook=after_run workspace=…/workspaces/PROJ-55
level=INFO msg="worker exiting" issue_id=10042 issue_identifier=PROJ-55 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=10042 issue_identifier=PROJ-55 handoff_state="In Review"
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

Here is the full lifecycle, step by step:

1. Sortie polled Jira and found `PROJ-55` in "To Do" with the `agent-ready` label.
2. `after_create` cloned the repository into `workspaces/PROJ-55/`.
3. `before_run` created the branch `sortie/PROJ-55` from `origin/main`.
4. Sortie verified the credential in a session of its own, then launched `opencode acp` in the workspace, opened a protocol session, and passed it the rendered prompt for the Jira issue.
5. OpenCode read the codebase, wrote the change, and completed the turn.
6. `after_run` committed the changes and pushed the branch.
7. Sortie transitioned the Jira issue from "To Do" to "In Review."
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

Open the issue in your browser. The status should read "In Review." If you use a board view, the card has moved to the In Review column. The issue stays open, waiting for you to read the branch and decide what happens next.

If the status did not change and you see a handoff warning in the logs, the Jira workflow does not allow a direct transition from "To Do" to "In Review." Check the [Jira integration tutorial](/getting-started/jira-integration/#verify-in-jira) troubleshooting section for how to resolve this.

### Check the dashboard

Open `http://127.0.0.1:7678/` in a browser. Sortie serves the dashboard there by default, with no configuration required. The address opens [Overview](/reference/dashboard/#overview), and its **Ended today** block lists `PROJ-55` with the ending "In Review". Select the row and choose **Open page** to read the run on the issue page, with its status, turns, and duration.

{{% /steps %}}

## What we built

We ran the complete Sortie lifecycle with OpenCode, driven in ACP mode, on top of the same Jira flow you already configured earlier. The tracker behavior stayed the same. The only new moving part was the agent.

- **Poll**: Sortie watched Jira for issues matching the `agent-ready` label.
- **Clone**: The `after_create` hook cloned the repository into a per-issue workspace.
- **Branch**: The `before_run` hook created a clean feature branch.
- **Code**: OpenCode, driven in ACP mode, read the codebase, wrote an implementation, and ran tests.
- **Push**: The `after_run` hook committed and pushed the changes.
- **Handoff**: Sortie transitioned the Jira issue to In Review.

This is the same loop that powers the [Claude Code tutorial](/getting-started/jira-claude-end-to-end/), the [Copilot CLI tutorial](/getting-started/github-copilot-end-to-end/), and the [Codex tutorial](/getting-started/jira-codex-end-to-end/), with one config change.

Where to go next:

- [Write a prompt template](/guides/write-prompt-template/): use conditionals, iteration, and template functions to build production prompts
- [WORKFLOW.md configuration reference](/reference/workflow-config/): every field, every default, every constraint
- [Monitor with logs](/guides/monitor-with-logs/): understand the structured log output during long-running sessions
- [Monitor with Prometheus](/guides/monitor-with-prometheus/): collect token usage, session counts, and retry rates as time-series metrics
- [OpenCode on the Agent Client Protocol](/reference/agent-client-protocol-opencode/): launch command, where each setting goes, credentials, and limitations
- [How to run OpenCode in ACP mode](/guides/run-opencode-in-acp-mode/): convert an existing OpenCode workflow, and carry the credential to remote workers
- [Scale agents with SSH](/guides/scale-agents-with-ssh/): remote execution for larger deployments
