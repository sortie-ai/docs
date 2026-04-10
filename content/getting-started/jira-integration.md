---
title: Connect Sortie to Jira Cloud
linkTitle: "Jira Integration"
description: "Tutorial: connect Sortie to a real Jira Cloud project, poll for issues, process them with a mock agent, and see Sortie update Jira status automatically."
keywords: sortie jira tutorial, jira cloud, jira api token, mock agent, tracker integration, getting started
author: Sortie AI
date: 2026-03-23
weight: 30
---
In this tutorial, we will connect Sortie to a live Jira Cloud project, watch it discover real issues, process them through a mock agent, and verify that Jira reflects the state changes. By the end, you will have a working Jira integration that polls, dispatches, and hands off issues without touching a real coding agent.

We use the mock agent on purpose. The quick start taught you how Sortie works with local files. This tutorial isolates the next variable: a real issue tracker. Once Jira works, swapping in a real agent is a one-line change.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- [Quick start](/getting-started/quick-start/) completed
- A Jira Cloud instance with project admin or write access
- Your Jira project key (the prefix on issue identifiers, like `PROJ` in `PROJ-42`)

{{% steps %}}

### Create an API token

Sortie authenticates with Jira Cloud using Basic Auth. You need an API token from your Atlassian account.

Go to [Atlassian account settings: API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) and create a new token. Copy it somewhere safe. You cannot view it again after closing the dialog.

Sortie expects credentials in `email:token` format, where `email` is the address tied to your Atlassian account and `token` is the value you copied. Both sides of the colon must be non-empty. Sortie validates this at startup and rejects values that are missing the colon or have an empty half.

### Set environment variables

Export two variables in your shell. Replace the placeholder values with your own:

```bash
export SORTIE_JIRA_ENDPOINT="https://yourcompany.atlassian.net"
export SORTIE_JIRA_API_KEY="you@company.com:your-api-token-here"
```

The endpoint is the base URL of your Jira instance without any path suffix. Sortie rejects endpoints that include `/rest/api/` in the URL.

We reference these variables from `WORKFLOW.md` using the `$VAR` syntax. Sortie resolves `$SORTIE_JIRA_ENDPOINT` and `$SORTIE_JIRA_API_KEY` from the environment at config load time, so credentials never appear in the workflow file itself.

Verify the variables are set:

```bash
echo "$SORTIE_JIRA_ENDPOINT"
```

You should see your Jira URL printed back. If the output is blank, re-run the `export` commands.

### Prepare a test issue

Open your Jira project in a browser and create one issue:

- **Summary:** anything you like, such as "Test Sortie integration"
- **Status:** the default state for new issues (typically "To Do")
- **Label:** add the label `agent-ready`

We will use the label as a filter so Sortie only picks up this one issue. Write down your project key (e.g. `PROJ`). We need it in the next step.

### Write the workflow file

Create a new directory and a `WORKFLOW.md` file inside it:

```bash
mkdir sortie-jira && cd sortie-jira
```

Create `WORKFLOW.md` with the following content. Replace `PROJ` with your project key:

```jinja
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

- `tracker.kind: jira` tells Sortie to use the Jira Cloud adapter instead of the local file adapter from the quick start.
- `$SORTIE_JIRA_ENDPOINT` and `$SORTIE_JIRA_API_KEY` resolve from the environment variables we set earlier.
- `query_filter: "labels = 'agent-ready'"` appends an `AND (labels = 'agent-ready')` clause to the JQL query, so Sortie only fetches issues with that label.
- `active_states` lists the Jira statuses that qualify an issue for dispatch. We use `To Do` to match the issue we created. State comparison is case-insensitive, so `to do` works too.
- `handoff_state: Done` tells Sortie to transition the issue to "Done" after the agent finishes.
- `agent.kind: mock` uses the built-in mock agent. It simulates a session without launching any subprocess or modifying files.
- `max_turns: 1` limits each mock session to a single turn. Enough to prove the flow works.
- `polling.interval_ms: 30000` sets the poll interval to 30 seconds. After each cycle, Sortie waits this long before checking Jira again.

### Validate the configuration

Run the validate subcommand to check for syntax errors and misconfigured fields:

```bash
sortie validate ./WORKFLOW.md
```

If the configuration is valid, the command exits silently with code 0 and prints nothing to the terminal. No output means no problems.

You can confirm the exit code:

```bash
echo $?
```

This should print `0`.

If something is wrong, you get a diagnostic. For example, a missing colon in the API key produces:

```
config.tracker.api_key: api_key must be in email:token format
```

Fix any reported errors before continuing.

### Test with dry-run

Dry-run mode connects to Jira, runs one poll cycle, and reports what it found without dispatching agents or writing to the database:

```bash
sortie --dry-run ./WORKFLOW.md
```

You should see output similar to:

```
level=INFO msg="sortie dry-run starting" version=0.x.x workflow_path=/home/you/sortie-jira/WORKFLOW.md
level=INFO msg="dry-run: candidate" issue_id=12345 issue_identifier=PROJ-42 title="Test Sortie integration" state="To Do" would_dispatch=true global_slots_available=1 state_slots_available=1 priority=3
level=INFO msg="dry-run: complete" candidates_fetched=1 would_dispatch=1 ineligible=0 max_concurrent_agents=1
```

Look at three things:

1. **`candidates_fetched=1`** confirms that Sortie reached Jira and found your issue.
2. **`would_dispatch=true`** means the issue passes all dispatch filters.
3. **`issue_identifier=PROJ-42`** should match the issue you created.

If `candidates_fetched=0`, check that:

- The issue label is exactly `agent-ready` (lowercase, no extra spaces).
- The issue status in Jira matches one of your `active_states` values.
- The project key in `WORKFLOW.md` matches your Jira project.

If the command fails with a 401 error, your API token is invalid or expired. Test it directly:

```bash
curl -s -u "$SORTIE_JIRA_API_KEY" \
  "$SORTIE_JIRA_ENDPOINT/rest/api/3/myself" | head -5
```

A successful response shows your user profile. A 401 means the token needs to be regenerated.

### Run for real

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output like this:

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-jira/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-jira/.sortie.db
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace prepared" issue_id=12345 issue_identifier=PROJ-42 workspace=…/PROJ-42
level=INFO msg="agent session started" issue_id=12345 issue_identifier=PROJ-42 session_id=mock-session-001
level=INFO msg="turn started" issue_id=12345 issue_identifier=PROJ-42 turn_number=1 max_turns=1
level=INFO msg="turn completed" issue_id=12345 issue_identifier=PROJ-42 turn_number=1 max_turns=1
level=INFO msg="worker exiting" issue_id=12345 issue_identifier=PROJ-42 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=12345 issue_identifier=PROJ-42 handoff_state=Done
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is what happened, step by step:

1. Sortie loaded `WORKFLOW.md`, resolved the environment variables, and connected to Jira.
2. The first poll found one candidate: your labeled issue in "To Do" state.
3. Sortie created a workspace directory and started a mock agent session.
4. The mock agent ran one turn and exited normally.
5. Sortie called the Jira transitions API to move the issue from "To Do" to "Done."
6. The next poll found zero candidates (the issue is no longer in an active state) and Sortie went idle.

Notice the second `tick completed` line: `candidates=0`. The issue moved to "Done" and no longer matches our `active_states`, so Sortie has nothing left to process.

Press **Ctrl+C** to stop Sortie.

### Verify in Jira

Open your issue in the browser. The status should now read "Done." If you use a project board, the issue card will have moved to the Done column.

If the status did not change and you see this in the logs:

```
level=WARN msg="handoff transition failed, scheduling continuation retry" handoff_state=Done error="tracker: tracker_payload: no transition to state \"Done\" available for issue PROJ-42"
```

This means the Jira workflow does not allow a direct transition from the issue's current status to "Done." Sortie uses the Jira transitions API, which respects your project's workflow rules. The target status must be reachable from the issue's current position in the workflow.

To fix this:

1. Open your Jira project settings and check the workflow diagram.
2. Confirm that a transition exists from "To Do" (or your issue's current status) to "Done."
3. If the transition path requires an intermediate status (e.g., "To Do" to "In Progress" to "Done"), set `handoff_state` to a status that is directly reachable, such as "In Progress," or add a direct transition in the Jira workflow editor.

{{% /steps %}}

## What we built

We connected Sortie to a live Jira Cloud instance and ran the full orchestration cycle against a real issue. Sortie polled Jira for issues matching our label filter, dispatched a mock agent session, and transitioned the issue to "Done" via the Jira API. The mock agent stood in for a real coding agent so we could verify the tracker integration in isolation.

The production workflow file you wrote here is nearly complete. To move from testing to real automation, replace `agent.kind: mock` with `agent.kind: claude-code` and configure the agent section for your environment. The tracker configuration stays the same.

What happens next:

- [Run the full cycle with Claude Code](/getting-started/jira-claude-end-to-end/) to swap in a real agent, set up workspace hooks, and push code to a branch automatically.
- [Write a prompt template](/guides/write-prompt-template/) to give the agent detailed instructions using issue fields, conditionals, and template functions.
- Consult the [Jira connection guide](/guides/connect-to-jira/) for advanced query filters, handoff patterns, and authentication troubleshooting.
- Browse the [WORKFLOW.md configuration reference](/reference/workflow-config/) for every available field and its default value.
- Read the [Jira adapter reference](/reference/adapter-jira/) for field mapping, rate limiting, and error details.
