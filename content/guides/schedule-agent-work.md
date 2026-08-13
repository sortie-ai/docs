---
title: "How to Schedule Recurring Agent Work"
linkTitle: "Schedule Agent Work"
description: "Create recurring Sortie work with GitHub Actions or Jira Automation, prevent duplicate issues, and cap unattended agent costs."
author: Sortie AI
date: 2026-08-13
weight: 24
url: /guides/schedule-agent-work/
---
Sortie starts work from tracker issues, not from an internal clock. To run a
weekly audit, daily documentation refresh, or other recurring task, let your
tracker's scheduler create an ordinary issue. The issue then follows the same
dispatch, retry, budget, handoff, and reaction path as work created by a person.
There is no scheduler to enable in Sortie and no separate kind of agent run.

This guide builds that pattern for GitHub Issues and Jira Cloud.

This is different from running Sortie itself in a GitHub Actions job. Sortie is
already running; the workflow below only creates the tracker issue it will
process.

## Prerequisites

- A running Sortie workflow that already processes one issue end to end
- Either the [GitHub Issues](/guides/connect-to-github/) or
  [Jira](/guides/connect-to-jira/) tracker adapter
- Permission to create issues and labels in GitHub, or to create and enable
  automation rules in Jira
- A recurring task narrow enough to run unattended

The examples use three stable labels:

- `agent-ready` selects issues through `tracker.query_filter`.
- `scheduled-work` identifies all recurring work and can select a dispatch
  rule.
- A label such as `schedule/dependency-report` on GitHub or
  `scheduled-dependency-report` in Jira identifies one schedule. Give every
  recurring task its own label so their duplicate guards do not interfere.

These are selector labels, not workflow states. Keep them on the issue as Sortie
moves it from backlog to in progress and then to review.

## Match the issues your workflow already selects

The scheduler must create an issue that satisfies both
`tracker.query_filter` and `tracker.active_states`.

For GitHub, this workflow searches for `agent-ready` and uses labels for
states:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme/platform
  query_filter: "label:agent-ready"
  active_states: [backlog, in-progress]
  in_progress_state: in-progress
  handoff_state: review
  terminal_states: [done, wontfix]
```

The Actions recipe below adds `backlog` after it creates the issue. Create
`agent-ready`, `scheduled-work`, `schedule/dependency-report`, and
`backlog` in the repository before testing the workflow. Also create the
`wontfix` terminal label used when one scheduled issue replaces another. The
first three labels remain stable; `backlog` is a state label that Sortie can
replace.

For Jira, use the same candidate label and make sure the created work item's
initial status appears in `active_states`:

```yaml
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  query_filter: "labels = 'agent-ready'"
  active_states: [To Do, In Progress]
  in_progress_state: In Progress
  handoff_state: In Review
  terminal_states: [Done]
```

The Jira recipe creates a Task in `To Do`. If that is not the initial status
for Tasks in your project, choose a work type whose initial status is active or
adjust `active_states` to match your workflow.

Run `sortie validate WORKFLOW.md` after changing either configuration.

## Create scheduled issues with GitHub Actions

GitHub Actions supports POSIX cron schedules. Add
`.github/workflows/scheduled-agent-work.yml` to the repository that Sortie
tracks:

```yaml
name: Create scheduled Sortie work

on:
  schedule:
    # Every Monday at 09:17 UTC. Avoid the high-load start of the hour.
    - cron: "17 9 * * 1"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

concurrency:
  group: scheduled-sortie-dependency-report
  cancel-in-progress: false

jobs:
  create-issue:
    runs-on: ubuntu-latest
    steps:
      - name: Create the next dependency report issue
        id: create
        uses: imjohnbo/issue-bot@v3
        with:
          title: "Scheduled: refresh the dependency report"
          body: |-
            Review production dependencies for outdated or vulnerable versions.

            Update the dependency report, make safe patch-level updates, and
            include the validation results in the final response.
          labels: "agent-ready, scheduled-work, schedule/dependency-report"
          close-previous: true

      - name: Mark the replaced issue terminal
        if: steps.create.outputs.previous-issue-number != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PREVIOUS_ISSUE_NUMBER: ${{ steps.create.outputs.previous-issue-number }}
        run: |
          set -euo pipefail

          current_labels=$(gh issue view "$PREVIOUS_ISSUE_NUMBER" \
            --repo "$GITHUB_REPOSITORY" \
            --json labels \
            --jq '.labels[].name')

          for state_label in backlog in-progress review; do
            if grep -Fxq "$state_label" <<<"$current_labels"; then
              gh issue edit "$PREVIOUS_ISSUE_NUMBER" \
                --repo "$GITHUB_REPOSITORY" \
                --remove-label "$state_label"
            fi
          done

          gh issue edit "$PREVIOUS_ISSUE_NUMBER" \
            --repo "$GITHUB_REPOSITORY" \
            --add-label wontfix

      - name: Add the initial Sortie state
        env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ steps.create.outputs.issue-number }}
        run: >-
          gh issue edit "$ISSUE_NUMBER"
          --repo "$GITHUB_REPOSITORY"
          --add-label backlog
```

The workflow's built-in `GITHUB_TOKEN` needs only `issues: write`. The
third-party [Issue Bot action](https://github.com/imjohnbo/issue-bot) creates
the issue and, because `close-previous` is enabled, closes the most recent
open issue that has all three stable labels before it creates the next one. The
next step removes any non-terminal Sortie state label from that issue and adds
`wontfix`, ensuring the GitHub adapter observes a terminal state during
reconciliation. Change the loop and terminal label if your workflow uses
different state names.

`backlog` is deliberately added in a separate step. Issue Bot uses every
label in its `labels` input to find the previous issue. If `backlog` were
included there, the lookup would stop finding an in-flight issue after Sortie
replaced `backlog` with `in-progress`.

Use a unique `schedule/...` label and concurrency group for each recurring
task. Otherwise one schedule can close another schedule's issue.

{{< callout type="warning" >}}
`close-previous` replaces, rather than skips, unfinished work. If the prior
issue is still running, the terminal label causes Sortie to stop that run
during state reconciliation. Set the schedule interval long enough for the
task to finish under normal conditions.
{{< /callout >}}

### Test the GitHub workflow

1. Commit the workflow to the repository's default branch. Scheduled workflows
   run only from that branch.
2. Open **Actions → Create scheduled Sortie work → Run workflow**.
3. Confirm the new issue has the three stable labels and `backlog`.
4. Watch Sortie fetch it, add `in-progress`, dispatch the agent, and move the
   issue to the configured handoff state.
5. Run the workflow again while the issue is open. The old issue should close
   with `wontfix` and no `backlog`, `in-progress`, or `review` label;
   one new issue should remain open in `backlog`.

The `schedule` event is not an exact timer. GitHub documents that runs can be
delayed during high load, especially at the start of an hour, and sufficiently
busy queues can drop jobs. It also disables scheduled workflows in public
repositories after 60 days with no repository activity. Check the Actions run
history and re-enable the workflow if the repository has been inactive.

The example uses UTC. On GitHub versions that support timezone-aware schedules,
you can add an IANA `timezone` value next to `cron`; check your GitHub or
GitHub Enterprise documentation before relying on it.

See GitHub's [`schedule` event
reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
for the current timing and default-branch behavior.

## Create scheduled work items with Jira Automation

Create a Jira Automation rule from **Project settings → Automation → Create
rule**. The rule should have four components in this order:

1. **Scheduled trigger**
2. **Lookup work items**
3. **Smart values condition**
4. **Create work item**

### 1. Configure the schedule

Choose the **Scheduled** trigger and either:

- set a fixed schedule, such as every week on Monday at 09:17; or
- use the cron expression `0 17 9 ? * MON *` for the same weekly schedule.

Select the intended timezone explicitly in the trigger. Leave **Run a JQL
search and execute actions for each work item in the query** disabled. That
option repeats the following actions for every result; it is not an
"only create when none exist" guard.

### 2. Look for an unfinished issue from this schedule

Add a **Lookup work items** action with this JQL:

```jql
project = "PROJ"
AND labels = "scheduled-dependency-report"
AND statusCategory != Done
```

The schedule-specific label makes this lookup independent from other recurring
tasks.

### 3. Stop when a prior issue is unfinished

Add a **Smart values condition**:

| Field | Value |
|---|---|
| First value | `{{lookupIssues.size}}` |
| Condition | equals |
| Second value | `0` |

When the lookup finds an unfinished work item, the condition fails and the rule
ends without creating a duplicate.

### 4. Create the work item

Add a **Create work item** action with values that match your Sortie workflow:

| Field | Example |
|---|---|
| Project | `PROJ` |
| Work type | `Task` |
| Summary | `Scheduled: refresh the dependency report` |
| Labels | `agent-ready`, `scheduled-work`, `scheduled-dependency-report` |
| Description | The task scope, acceptance criteria, and required validation |

Confirm that a newly created Task starts in `To Do`, or another status listed
in `tracker.active_states`. The rule actor needs permission to browse the
project and create this work type.

Turn on the rule, let it run once, and inspect the automation audit log. The
created work item should match Sortie's `query_filter`, enter an active state,
and dispatch normally. Run the rule again before marking the first item Done;
the lookup should find one item and the condition should report that no actions
were performed. After the item reaches a status in the Done category, the next
scheduled run can create a new one.

Jira evaluates the trigger in the timezone selected in the Scheduled component,
but date smart values such as `{{now}}` are UTC by default. If you add
date-based conditions, convert them explicitly, for example
`{{now.convertToTimeZone("America/New_York")}}`. Also monitor the audit log:
Jira disables a scheduled rule after ten consecutive failed executions.

See Atlassian's [Scheduled trigger
reference](https://support.atlassian.com/cloud-automation/docs/jira-automation-triggers/)
and [automation actions
reference](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/)
for the current UI and field names. Its [date and time smart values
reference](https://support.atlassian.com/cloud-automation/docs/jira-smart-values-date-and-time/)
documents time zone conversion.

## Put limits on unattended runs

A duplicate guard limits issue count, not agent spend. Set finite budgets before
turning on a recurring task:

```yaml
agent:
  max_turns: 3
  max_sessions: 2
  max_tokens: 500000
  max_concurrent_agents: 1
```

- `max_sessions` prevents a failing issue from retrying forever.
- `max_tokens` caps measured cumulative token usage across that issue's
  sessions. Sortie checks it between sessions, so one running session can pass
  the threshold before the next dispatch is blocked.
- `max_turns` and `max_concurrent_agents` bound how much work can run at
  once.

These values are a conservative starting point, not a universal budget. Start
with a weekly or daily schedule, measure normal completion time and token use,
then adjust. Keep the interval longer than a normal run so one scheduled issue
usually finishes before the next trigger.

Agent budgets are workflow-wide. Dispatch rules can choose an agent and prompt
template, but they do not override `agent.max_sessions` or
`agent.max_tokens`. Use a separate Sortie workflow if recurring work needs
different hard limits from interactive issues. See [How to control agent
costs](/guides/control-costs/) for adapter-specific spending caps and monitoring.

## Route recurring work to its own prompt

Both recipes add the stable `scheduled-work` label. Use it to select a prompt
designed for unattended runs:

```yaml
dispatch:
  rules:
    - name: scheduled-work
      match:
        labels: ["scheduled-work"]
      template: ./prompts/scheduled-work.md
```

Place this rule before any catch-all rule. Then create
`prompts/scheduled-work.md`:

```text
You are completing recurring unattended work for {{ .issue.identifier }}.

{{ .issue.title }}
{{ .issue.description }}

Stay within the requested scope. Reuse the existing project conventions, run
the relevant validation, and report any step that could not be completed.
```

The rule is selected once at first dispatch and reused for retries and
continuations. See [How to configure dispatch
rules](/guides/configure-dispatch-rules/) for matching and fallback behavior.

## Verify the complete path

For either tracker:

1. Run `sortie validate WORKFLOW.md`.
2. Trigger the scheduler once and confirm exactly one issue is created.
3. Confirm the issue matches `query_filter` and has an active state.
4. Confirm Sortie logs the candidate, dispatches the agent, and applies the
   configured in-progress and handoff transitions.
5. Trigger the scheduler again while the first issue is unfinished and confirm
   the platform-specific duplicate behavior.
6. Review run history and token usage before enabling the final schedule.

The scheduler's job ends when it creates the tracker issue. From that point on,
it is ordinary Sortie work, so retries, budgets, handoff, CI and review
reactions, and workspace cleanup need no scheduler-specific configuration.
