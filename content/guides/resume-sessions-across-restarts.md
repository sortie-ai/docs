---
title: "How to Recover Work Across Restarts"
linkTitle: "Recover Work Across Restarts"
description: "Understand what Sortie preserves across process restarts, how interrupted issues are picked up again, and how to verify that its state survives a shutdown or crash."
author: Sortie AI
date: 2026-03-29
weight: 100
url: /guides/resume-sessions-across-restarts/
---
Keep Sortie's state intact across planned restarts and unexpected crashes, with no manual intervention.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- Sortie running against a real or file-based tracker with at least one dispatched issue
- Familiarity with your `WORKFLOW.md` configuration

## What survives a restart

Retries, session budgets, token totals, parked issues, escalations, and acknowledged attention items. Sortie stores them in SQLite, so a restart is equivalent to closing and reopening the database file. These tables hold the data that matters:

| Table | What it stores | Why it matters after restart |
|---|---|---|
| `retry_entries` | Pending retries: issue ID, attempt number, scheduled fire time, issue title, link, type, labels, and state | Retries resume at the correct position in the backoff sequence. Overdue retries fire immediately on startup. The [state API](/reference/http-api/#get-apiv1state-system-state) names a restored retry's issue right away; a retry stored by an earlier release gets them from the next poll or when it fires. |
| `run_history` | Completed runs: issue ID, attempt, status, timestamps, workspace path | The `max_sessions` budget check queries this table. After restart, Sortie knows exactly how many sessions each issue has used, with no counter resets. |
| `session_metadata` | Last session ID, token counters, model name, API request count | The latest figures for each issue's most recent session. Resuming a session does not read this table: a continuation carries its session in its retry entry. |
| `attention_acknowledgements` | One row per acknowledged attention item: the item's ID and the time of the acknowledgement | An item that a person acknowledged stays acknowledged after a restart. Sortie deletes the row when the item no longer exists. See [acknowledge an attention item](/reference/http-api/#post-apiv1attentionidacknowledge-acknowledge-an-attention-item). |
| `reaction_escalations` | One row per issue and reaction kind: the escalation's trigger, start time, attempt counter, and pull request | A pull request reaction that escalated to a person stays escalated after a restart. Sortie runs no second round of fixes and applies no second label. |

The key insight: the state that decides whether work happens again lives in SQLite. Retry attempt counts, session budgets, and token tallies all come from SQLite queries, so killing the process at any point loses none of them. What stays in memory is bookkeeping that rebuilds itself, such as the fix counters of pull request reactions that have not escalated: they start again after a restart. See [retry budgets](/reference/reactions/#retry-budgets).

## What happens to in-flight sessions

When Sortie stops (whether from `Ctrl+C`, a termination signal, or a crash), any running agent processes receive a graceful shutdown signal, then are force-terminated once [`agent.stop_grace_ms`](/reference/workflow-config/#agent) elapses, five seconds by default. Collecting each agent's output and draining the workers outlasts that period by a fixed margin, so budget the stop timeout you give Sortie against the whole [shutdown sequence](/reference/cli/#signals) rather than against the grace period alone. The issues those agents were working on are left in a recoverable state:

- Their tracker status hasn't changed (still "In Progress" or whatever your active state is)
- Their workspace directories remain on disk, untouched
- A run stopped mid-work leaves no pending retry entry in SQLite. An issue whose retry was already queued when Sortie stopped keeps that entry
- Their interrupted run is recorded in run history with the status `cancelled`. The dashboard shows it as Cancelled. That status belongs to the one run that was stopped, not to the issue

Here's what the startup sequence does to pick them back up:

1. Sortie opens the database and loads all retry entries. Overdue entries (where the fire time has passed) are marked for immediate dispatch.
2. The poll loop starts and fetches candidate issues from the tracker.
3. Previously in-flight issues appear as candidates: they're still in an active tracker state.
4. Sortie dispatches them again, reusing existing workspace directories.
5. The `before_run` hook runs in the existing workspace (for example, `git pull` to bring the workspace up to date).
6. The agent starts in that workspace with all previous work preserved on disk.

The agent's conversation does not survive. A run that was stopped mid-work leaves no retry entry, so its issue is dispatched as a fresh attempt: a new agent session that receives the prompt again and knows only what the previous session wrote to the workspace. Only a continuation that was already queued when Sortie stopped resumes its earlier session.

No special configuration is needed for this to work. It's the default behavior.

The workspace contains whatever files the agent wrote before the process stopped, unless a hook removes them. A `before_run` hook that runs `git reset --hard` discards every uncommitted change the previous session made.

## What happens to handoff-stage PRs

The poll-based recovery in the previous section finds in-flight issues because they're still in an active tracker state. Handoff-stage issues are different: the agent has finished, the PR is open, and the tracker issue has moved to your `tracker.handoff_state` (for example, "In Review"). The dispatch loop no longer sees these issues as candidates, so a restart used to leave them with no pending CI or review polling until the reviewer manually pushed them back to an active state.

On startup, Sortie now reconstructs review and CI pending entries for handoff-stage issues from three persisted sources:

- The latest successful run per issue in SQLite `run_history`.
- The current tracker state for those issues (one batched `FetchIssueStatesByIDs` call).
- The workspace's existing `.sortie/scm.json` (PR coordinates for both review and CI).

After the recovery summary line, normal review and CI polling resumes against those entries on the next reconcile tick. Sortie then restores the escalations that stood when the process stopped, for every reaction kind, onto those entries. An escalated issue that recovery did not reach, because its last successful run is older than the lookback, it fell outside the candidate cap, or the issue left the handoff state, is rebuilt from its stored escalation and its newest successful run. A stored escalation whose reaction kind is no longer configured, or whose issue has no successful run, ends. A restored escalation keeps its start time and the tries it used, and the first poll tick still ends it if a person has since moved the issue out of the handoff state. Reviewer comments left while the process was down are picked up within one review poll interval. No operator action is required.

Recovery is bounded so startup stays cheap:

- The candidate set is the most recent 200 unique issues with a successful run in the last 30 days.
- An issue ages out when the SCM activity is older than 30 days. Sortie reads the `pushed_at` field from `.sortie/scm.json` for this check; if it's missing, it falls back to the run's `completed_at` timestamp.
- If a successful run is older than 30 days and the PR has had no fresh push, recovery skips it. Move the issue back to an active tracker state to re-engage it.

Write `pushed_at` from the `after_run` hook that pushes the PR so handoffs age out on the most recent push instead of the agent's completion time. See [Configure review feedback](/guides/configure-review-feedback/) and [Configure CI feedback](/guides/configure-ci-feedback/) for the hook examples.

Check the startup log line to confirm recovery ran:

```
time=2026-05-14T10:00:01.500+00:00 level=INFO msg="pending reaction recovery completed" candidates=3 cap_skipped=0 state_checked=3 review_recovered=2 ci_recovered=2 stale_skipped=0 skipped=1
```

`review_recovered` and `ci_recovered` show what was reinstated. `stale_skipped` counts handoff candidates that aged out. `skipped` counts candidates excluded for any other reason (terminal state, claim conflict, missing PR coordinates, malformed metadata).

The escalation restore logs its own line:

```
time=2026-05-14T10:00:01.502+00:00 level=INFO msg="reaction escalation restore completed" applied=1 rebuilt=0 ended=0
```

`applied` counts stored escalations given to entries that recovery rebuilt. `rebuilt` counts entries built from a stored escalation alone. `ended` counts stored escalations that no configured reaction kind or successful run could watch. A failure to read the stored escalations logs `reaction escalation restore failed` at `ERROR` with the error, and startup continues without restoring any.

## Design your hooks for restartability

Workspace paths are deterministic. Issue `PROJ-42` always maps to the same directory: `<workspace_root>/PROJ-42`. The first dispatch creates it; every subsequent dispatch reuses it, including dispatches after a restart.

This means your hooks need to handle both cases:

- **`after_create`** runs once, when the workspace directory is brand new. Use it for one-time setup like cloning a repository.
- **`before_run`** runs before every agent attempt, including post-restart dispatches. Use it to refresh the workspace.
- **`after_run`** runs after every agent attempt. Use it to preserve work.

Here's a hook configuration that makes restarts seamless:

```yaml
# WORKFLOW.md
workspace:
  root: /var/lib/sortie/workspaces
  hooks:
    after_create: |
      git clone git@github.com:acme/backend.git .
    before_run: |
      git fetch origin main && git reset --hard origin/main
    after_run: |
      git add -A && git commit -m "sortie: {{.issue.identifier}}" --allow-empty && git push
```

The pattern: `after_create` clones fresh. `before_run` pulls latest. `after_run` commits and pushes. After a restart, the workspace already exists, so `after_create` is skipped. `before_run` refreshes the checkout, and the agent starts with a clean working tree on top of any previously pushed commits.

For deeper coverage of hook patterns, see [Set Up Workspace Hooks](/guides/setup-workspace-hooks/).

## Verify persistence is working

### Check the database file

Sortie creates a `.sortie.db` file in the same directory as your `WORKFLOW.md`. Confirm it exists after your first run:

```bash
ls -la /etc/sortie/.sortie.db
```

```
-rw-r--r-- 1 sortie sortie 32768 Mar 29 10:15 /etc/sortie/.sortie.db
```

If you've configured a custom `db_path` in your workflow file, check that path instead.

### Read the startup logs

On startup, Sortie logs the database path and retry recovery. Look for these lines:

```
time=2026-03-29T10:00:01.100+00:00 level=INFO msg="database path resolved" db_path=/etc/sortie/.sortie.db
```

If there were pending retries from the previous run, you'll see the orchestrator reconstruct them before entering the main loop. Issues with overdue retries fire immediately on the first tick.

For more on reading Sortie's logs, see [Monitor with Logs](/guides/monitor-with-logs/).

### Use the dashboard

The built-in dashboard reads directly from SQLite. Run history, active sessions, and pending retries all reflect persisted state. They survive restarts. See the [Dashboard reference](/reference/dashboard/).

### Test it yourself

The most convincing verification is a manual test:

```bash
# Start Sortie
sortie ./WORKFLOW.md

# Wait for it to dispatch at least one issue (watch the logs)
# Then stop it
# Ctrl+C

# Restart immediately
sortie ./WORKFLOW.md
```

After restart, confirm in the logs that:

- The previously dispatched issue appears as a candidate on the first poll tick
- The workspace is reused (look for `workspace prepared` without `after_create` firing)
- If a retry was pending, the retry entry is loaded and the timer is reconstructed

## What we configured

Nothing, actually. Persistence and restart recovery are built into Sortie's default behavior. What you got from this guide:

- **Confidence that Sortie's state survives.** Retry queues, session budgets, and token accounting all survive restarts because they live in SQLite. An interrupted agent's conversation does not: its issue starts a new session over the same workspace.
- **Understanding of the restart sequence.** In-flight issues are re-discovered through the normal poll loop and dispatched into their existing workspaces.
- **A hook pattern for seamless restarts.** `after_create` for one-time setup, `before_run` for refresh, `after_run` for preservation.
- **Verification steps.** Database file check, startup log messages, dashboard inspection, and a manual restart test.

## Related guides

- [Configure Retry Behavior](/guides/configure-retry-behavior/): tune backoff timing and session budgets
- [Set Up Workspace Hooks](/guides/setup-workspace-hooks/): hook writing patterns and lifecycle details
- [Run as a systemd Service](/guides/run-as-systemd-service/): automatic restart on failure with `Restart=on-failure`
- [Monitor with Logs](/guides/monitor-with-logs/): filter and interpret startup recovery messages
