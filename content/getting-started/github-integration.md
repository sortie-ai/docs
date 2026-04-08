---
title: "Connect Sortie to GitHub Issues"
description: "Tutorial: connect Sortie to GitHub Issues, poll for labeled issues, process them with a mock agent, and watch Sortie swap labels and close issues automatically."
keywords: sortie github tutorial, github issues, github integration, label states, mock agent, getting started
author: Sortie AI
date: 2026-03-30
weight: 40
---

# Connect Sortie to GitHub Issues

In this tutorial, we will connect Sortie to a GitHub repository, watch it discover issues by state labels, process them through a mock agent, and verify that GitHub reflects the state changes — a label swap and an automatic close. By the end, you will have a working GitHub integration that polls for issues, dispatches an agent, and transitions states without any manual intervention.

We use the mock agent on purpose. The quick start taught you how Sortie works with local files. This tutorial isolates the next variable: a real issue tracker. Once GitHub works, swapping in a real agent is a one-line change.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- [Quick start](/getting-started/quick-start/) completed
- A GitHub repository you control (personal or org)
- A GitHub personal access token with `repo` scope

## Create a personal access token

Sortie authenticates with the GitHub API using a Bearer token. You need a personal access token (PAT) — either a [classic token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic) or a [fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token).

For a **classic token**, select the `repo` scope. For a **fine-grained token**, grant Issues read/write and Contents read permissions on your target repository.

Copy the token. You cannot view it again after closing the page.

Unlike Jira's `email:token` format, the GitHub token is the raw string by itself — no colon, no email prefix.

## Set environment variables

Export one variable in your shell:

```bash
export SORTIE_GITHUB_TOKEN="ghp_your-token-here"
```

No endpoint variable is needed. Sortie defaults to `https://api.github.com`. If you use GitHub Enterprise Server, set `tracker.endpoint` in your workflow file to your instance URL.

We reference this variable from `WORKFLOW.md` using the `$SORTIE_GITHUB_TOKEN` syntax. Sortie resolves it from the environment at config load time, so the token never appears in the workflow file itself.

Verify the variable is set:

```bash
echo "$SORTIE_GITHUB_TOKEN"
```

You should see your token printed back. If the output is blank, re-run the `export` command.

## Prepare state labels

GitHub Issues has only two native states: open and closed. Sortie maps richer workflow states through labels. Create four labels in your repository — these are Sortie's defaults for the GitHub adapter:

| Label | Purpose |
|---|---|
| `backlog` | Issues waiting for agent pickup |
| `in-progress` | Agent is working on the issue |
| `review` | Agent finished, waiting for human review |
| `done` | Completed (terminal state) |

Create them with the `gh` CLI (replace `owner/repo` with your repository):

```bash
gh label create backlog --repo owner/repo --color "0E8A16"
gh label create in-progress --repo owner/repo --color "1D76DB"
gh label create review --repo owner/repo --color "FBCA04"
gh label create done --repo owner/repo --color "5319E7"
```

Or create them through the GitHub web UI under **Settings → Labels**.

These label names match Sortie's default `active_states` and `terminal_states` for the GitHub adapter. You can use different names — match them in `WORKFLOW.md` and Sortie will follow your naming.

## Create a test issue

Create one issue with the `backlog` label:

```bash
gh issue create --repo owner/repo --title "Test Sortie integration" --label backlog
```

Note the issue number in the output (e.g., `#1`). We will look for it in the next steps.

## Write the workflow file

Create a new directory and a `WORKFLOW.md` file inside it:

```bash
mkdir sortie-github && cd sortie-github
```

Create `WORKFLOW.md` with the following content. Replace `owner/repo` with your actual repository:

```jinja
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: owner/repo
  active_states:
    - backlog
    - in-progress
    - review
  handoff_state: done
  terminal_states:
    - done

polling:
  interval_ms: 30000

agent:
  kind: mock
  max_turns: 1
---

You are working on #{{ .issue.identifier }}: {{ .issue.title }}
{{ if .issue.description }}

{{ .issue.description }}
{{ end }}
```

A few things to notice:

- `tracker.kind: github` tells Sortie to use the GitHub adapter instead of the local file adapter from the quick start.
- `tracker.project: owner/repo` identifies your repository. The format is `owner/repo`, not a Jira project key.
- `$SORTIE_GITHUB_TOKEN` resolves from the environment variable we set earlier. The token is a single string — no `email:token` format like Jira.
- No `tracker.endpoint` is needed. Sortie defaults to `https://api.github.com`.
- `active_states` lists label names that qualify issues for dispatch. Label comparison is case-insensitive, so `Backlog` and `backlog` both match.
- `handoff_state: done` tells Sortie to move the issue to "done" after the agent finishes. Sortie removes the current state label, adds the `done` label, and closes the issue.
- `agent.kind: mock` uses the built-in mock agent. No subprocess, no file changes — it proves the tracker loop works.
- `max_turns: 1` limits each mock session to a single turn. Enough to prove the flow.
- `polling.interval_ms: 30000` polls GitHub every 30 seconds.

## Validate the configuration

Run the validate subcommand to check for syntax errors and misconfigured fields:

```bash
sortie validate ./WORKFLOW.md
```

If the configuration is valid, the command exits silently with code 0 and prints nothing. No output means no problems.

Confirm the exit code:

```bash
echo $?
```

This should print `0`.

If something is wrong, you get a diagnostic. For example, a missing slash in the project value produces:

```
error: tracker.project.format: tracker.project must be in owner/repo format (e.g. "sortie-ai/sortie")
```

Fix any reported errors before continuing.

## Test with dry-run

Dry-run mode connects to GitHub, runs one poll cycle, and reports what it found without dispatching agents or writing to the database:

```bash
sortie --dry-run ./WORKFLOW.md
```

You should see output similar to:

```
level=INFO msg="sortie dry-run starting" version=0.x.x workflow_path=/home/you/sortie-github/WORKFLOW.md
level=INFO msg="dry-run: candidate" issue_id=1 issue_identifier=1 title="Test Sortie integration" state=backlog would_dispatch=true global_slots_available=1 state_slots_available=1
level=INFO msg="dry-run: complete" candidates_fetched=1 would_dispatch=1 ineligible=0 max_concurrent_agents=1
```

Look at three things:

1. **`candidates_fetched=1`** confirms that Sortie reached GitHub and found your issue.
2. **`would_dispatch=true`** means the issue passes all dispatch filters.
3. **`issue_identifier=1`** should match the issue number you created.

If `candidates_fetched=0`, check that:

- The issue has the `backlog` label (case-insensitive, but must exist on the repo).
- The issue is open.
- The `project` value in `WORKFLOW.md` is the correct `owner/repo`.

If the command fails with a 401 error, your token is invalid or expired. Test it directly:

```bash
curl -s -H "Authorization: Bearer $SORTIE_GITHUB_TOKEN" \
  "https://api.github.com/user" | head -5
```

A successful response shows your GitHub username. A 401 means the token needs to be regenerated.

## Run for real

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output like this:

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-github/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-github/.sortie.db
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=1 dispatched=1 running=1 retrying=0
level=INFO msg="workspace prepared" issue_id=1 issue_identifier=1 workspace=…/1
level=INFO msg="agent session started" issue_id=1 issue_identifier=1 session_id=mock-session-001
level=INFO msg="turn started" issue_id=1 issue_identifier=1 turn_number=1 max_turns=1
level=INFO msg="turn completed" issue_id=1 issue_identifier=1 turn_number=1 max_turns=1
level=INFO msg="worker exiting" issue_id=1 issue_identifier=1 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=1 issue_identifier=1 handoff_state=done
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Here is what happened, step by step:

1. Sortie loaded `WORKFLOW.md`, resolved the environment variable, and connected to GitHub.
2. The first poll fetched open issues, found one with a `backlog` label, and dispatched it.
3. Sortie created a workspace directory and started a mock agent session.
4. The mock agent ran one turn and exited normally.
5. Sortie removed the `backlog` label, added the `done` label, and closed the issue via the GitHub API.
6. The next poll found zero candidates — the issue is closed and no longer matches any active state.

Notice the second `tick completed` line: `candidates=0`. Sortie has nothing left to process.

Press **Ctrl+C** to stop Sortie.

## Verify in GitHub

Open the issue in the browser, or check from the command line:

```bash
gh issue view 1 --repo owner/repo
```

Verify three things:

- The issue is **closed**.
- The `backlog` label is **gone**.
- The `done` label is **present**.

If the label did not change: check that the labels exist on the repository (Sortie does not create them automatically), review the Sortie logs for error messages, and confirm your token has `repo` scope.

## What we built

We connected Sortie to a live GitHub repository and ran the full orchestration cycle against a real issue. Sortie polled GitHub for open issues, matched one by its `backlog` label, dispatched a mock agent session, and transitioned the issue to "done" — removing the old label, adding the new one, and closing the issue.

The key difference from Jira: GitHub has no native workflow states beyond open and closed, so Sortie manages state entirely through labels. More flexible (no workflow configuration in the tracker), but it means you need to pre-create the labels. If the target label does not exist on the repository, the transition fails — by design, not silent fallback.

The workflow file you wrote here is nearly complete for production. To move from testing to real automation, replace `agent.kind: mock` with `agent.kind: claude-code` and configure the agent section. The tracker configuration stays the same.

What happens next:

- [Run the full cycle with Claude Code](/getting-started/jira-claude-end-to-end/) to swap in a real agent, set up workspace hooks, and push code to a branch.
- [Write a prompt template](/guides/write-prompt-template/) to give the agent detailed instructions using issue fields, conditionals, and template functions.
- Consult the [GitHub connection guide](/guides/connect-to-github/) for query filters, Enterprise Server setup, and advanced state configuration.
- Browse the [WORKFLOW.md configuration reference](/reference/workflow-config/) for every available field and its default value.
- Read the [GitHub adapter reference](/reference/adapter-github/) for field mapping, state derivation, and rate limiting details.
