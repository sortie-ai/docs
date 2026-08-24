---
title: Connect Sortie to Linear
linkTitle: "Linear Integration"
description: "Tutorial: connect Sortie to a live Linear team, poll for issues, process them with a mock agent, and watch Sortie update the workflow state automatically."
author: Sortie AI
date: 2026-06-15
weight: 45
---
In this tutorial, we will connect Sortie to a live Linear team, watch it discover an issue in one of the active states, process it through a mock agent, and verify that Linear reflects the state change. By the end, you will have a working Linear integration that polls, dispatches, and hands off, without touching a real coding agent.

We use the mock agent on purpose. The quick start taught you how Sortie works with local files. This tutorial isolates the next variable, a real issue tracker. Once Linear works, swapping in a real agent is a one-line change.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- [Quick start](/getting-started/quick-start/) completed
- A Linear workspace with a team you can write to
- Your Linear team key (the prefix on issue identifiers, like `ENG` in `ENG-123`)

{{% steps %}}

### Create a Linear API key

Sortie authenticates with a personal API key. Create one in Linear, scoped to the team you will point Sortie at, with read and write access, so it can read issues and transition them. Copy the key. It starts with `lin_api_`. See Linear's own [API and webhooks docs](https://linear.app/docs/api-and-webhooks) for where personal API keys are created and scoped.

Export it as the environment variable the adapter reads:

```bash
export SORTIE_LINEAR_API_KEY="lin_api_..."
```

Linear sends this key in the `Authorization` header verbatim, with no `Bearer` prefix. Sortie passes it through unchanged, so the value must be the bare key with no scheme and no surrounding whitespace. We reference it from `WORKFLOW.md` with the `$SORTIE_LINEAR_API_KEY` syntax, so the key never appears in the file itself.

Verify the variable is set:

```bash
echo "$SORTIE_LINEAR_API_KEY"
```

You should see your key printed back. If the output is blank, re-run the `export` command.

### Find your team key

The team key is the uppercase prefix Linear puts on every issue in the team, the `ENG` in `ENG-123`. Open any issue in your team and read the prefix off its identifier. This is the value for `tracker.project`. Write it down; we need it when we write the workflow file.

### Create a test issue

So that Sortie picks up exactly one issue, create a single test issue in your team. Give it any title, leave its status as `Todo`, and add a label named `agent-ready`. We will filter on that label so Sortie ignores everything else in the team.

### Write the workflow file

Create a new directory and a `WORKFLOW.md` file inside it:

```bash
mkdir sortie-linear && cd sortie-linear
```

Create `WORKFLOW.md` with the following content. Replace `ENG` with your team key:

```jinja {filename="WORKFLOW.md",hl_lines=[3,4,5,6,11]}
---
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
  query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}}'
  active_states:
    - Backlog
    - Todo
    - In Progress
  handoff_state: In Review
  terminal_states:
    - Done
    - Canceled
    - Duplicate

polling:
  interval_ms: 30000

agent:
  kind: mock
  max_turns: 1
---

You are working on {{ .issue.identifier }}: {{ .issue.title }}
{{ if .issue.description }}

{{ .issue.description }}
{{ end }}
```

A few things to notice:

- `tracker.kind: linear` tells Sortie to use the Linear adapter instead of the local file adapter from the quick start.
- `$SORTIE_LINEAR_API_KEY` resolves from the environment variable we set earlier. Linear takes the key verbatim, with no `Bearer` prefix.
- `tracker.project: ENG` is your Linear team key, the identifier prefix, not a Linear project.
- `query_filter` is a raw Linear `IssueFilter` fragment. This one keeps Sortie to issues carrying the `agent-ready` label, ANDed with the team and state constraints.
- `active_states` and `terminal_states` are team-scoped workflow-state names. Sortie matches them against your team's states case-insensitively at startup, so `todo` and `Todo` both resolve. The values here are the states a new Linear team ships with.
- `handoff_state: In Review` moves the issue to your team's `In Review` state after the mock agent finishes. Your team needs an `In Review` state for this. Most teams have one; if yours does not, add it in your team's workflow settings in Linear.
- `agent.kind: mock` uses the built-in mock agent. It simulates a session without launching any subprocess or modifying files.
- `max_turns: 1` limits each mock session to a single turn, enough to prove the flow works.
- `polling.interval_ms: 30000` polls Linear every 30 seconds.

### Validate the configuration

Check the workflow file before connecting to Linear:

```bash
sortie validate ./WORKFLOW.md
```

This runs offline. It parses the front matter, compiles the prompt template, and checks the config shape: that `api_key` resolves, that `project` is a plausible team key, that no state name is empty, and that your state lists do not overlap. The tracker half of your file is clean, so the one line it prints is about the agent:

```
warning: agent.kind.no_tool_channel: agent kind "mock" has no tool execution channel: Sortie's tools are neither advertised nor callable for it
```

That is the mock agent being honest: it launches no process, so Sortie's own agent tools cannot reach it, and the first-turn prompt does not offer them. A warning leaves the configuration valid and the exit code `0`; it disappears once you swap in a real coding agent.

```bash
echo $?
```

This should print `0`. The checks that need Linear itself, that your key works, that the team exists, and that every state name is a real state on the team, run when you start Sortie in the next step and stop startup before the first poll if anything is wrong.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output like this (the `tick completed` lines carry more fields than shown here):

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-linear/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-linear/.sortie.db
level=INFO msg="http server listening" addr=127.0.0.1:7678
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 ... running=1 retrying=0 ...
level=INFO msg="workspace prepared" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 workspace=…/ENG-42
level=INFO msg="agent session started" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 session_id=mock-session-001
level=INFO msg="turn started" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 turn_number=1 max_turns=1
level=INFO msg="turn completed" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 turn_number=1 max_turns=1
level=INFO msg="worker exiting" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f issue_identifier=ENG-42 handoff_state="In Review"
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

Here is what happened, step by step:

1. Sortie loaded `WORKFLOW.md`, resolved the environment variable, and connected to Linear. The construction preflight checked the key, the team key, and every state name against your team.
2. The first poll found one candidate, your `agent-ready` issue in `Todo`, and dispatched it.
3. Sortie created a workspace directory and started a mock agent session.
4. The mock agent ran one turn and exited normally.
5. Sortie resolved the `In Review` state to its team-scoped id and moved the issue there through the Linear API.
6. The next poll found zero candidates. The issue is in `In Review`, which is not an active state, so Sortie went idle.

Notice the second `tick completed` line: `candidates=0`. The issue left the active states, so Sortie has nothing left to process.

Your `issue_id` is the Linear UUID and `issue_identifier` is the `ENG-` key. If your team does not have an `In Review` state, Sortie stops at startup before polling:

```
level=ERROR msg="failed to construct tracker adapter" error="state \"In Review\" not found in team \"ENG\""
```

Add an `In Review` state to your team's workflow in Linear, then run again.

Press **Ctrl+C** to stop Sortie.

### Verify the results

While Sortie is running, open the dashboard at [http://127.0.0.1:7678](http://127.0.0.1:7678) to watch the session live. Sortie serves it there by default, with no configuration required.

Now open your team in Linear in the browser. The test issue has moved to the `In Review` column. On a board view, the card sits under `In Review`; on a list view, its status reads `In Review`.

The full lifecycle you watched:

1. **Poll.** Sortie queried Linear for issues in the active states that match the `agent-ready` filter and found your test issue.
2. **Dispatch.** Sortie claimed the issue and ran a mock agent session for one turn.
3. **Handoff.** Sortie transitioned the issue to `In Review`, the next poll saw no active candidates, and the loop went idle.

If the issue did not move, check the logs. A `candidates=0` on the first tick means the test issue is not in an active state or is missing the `agent-ready` label. A `failed to construct tracker adapter` error names the exact problem: an invalid key, an unknown team key, or a state name absent from the team.

{{% /steps %}}

## What we built

We connected Sortie to a live Linear team and ran the full orchestration cycle against a real issue. Sortie polled Linear for issues matching our label filter, dispatched a mock agent session, and transitioned the issue to `In Review` through Linear's GraphQL API. The mock agent stood in for a real coding agent so we could verify the tracker integration on its own.

The workflow file you wrote here is the tracker half of a production setup. To move from this tutorial to real automation, you change one thing: replace `agent.kind: mock` with a real coding agent and configure its section. The tracker configuration stays the same. The [Linear and Codex end-to-end tutorial](/getting-started/linear-codex-end-to-end/) walks through that change, adds workspace hooks, and pushes code to a branch.

## Where to go next

- Run the [Linear and Codex end-to-end tutorial](/getting-started/linear-codex-end-to-end/) to swap the mock agent for the Codex CLI, add workspace hooks, and push code to a branch.
- Consult the [connect-to-Linear guide](/guides/connect-to-linear/) for query filters, handoff patterns, and authentication details.
- Read the [Linear adapter reference](/reference/adapter-linear/) for field mapping, the state model, pagination, and error behavior.
- Browse the [WORKFLOW.md configuration reference](/reference/workflow-config/) for every available field and its default value.
