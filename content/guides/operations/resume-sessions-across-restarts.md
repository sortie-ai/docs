---
title: "How to Resume Agent Sessions Across Restarts"
description: "Understand what Sortie preserves across process restarts, how in-flight sessions recover, and how to verify that no work is lost on shutdown or crash."
keywords: sortie restart, session resume, persistence, SQLite, workspace reuse, crash recovery, retry recovery, production restart
author: Sortie AI
date: 2026-03-29
weight: 10
url: /guides/resume-sessions-across-restarts/
---

# How to resume agent sessions across restarts

Keep Sortie's state intact across planned restarts and unexpected crashes — no manual intervention, no lost work, no duplicated effort.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- Sortie running against a real or file-based tracker with at least one dispatched issue
- Familiarity with your `WORKFLOW.md` configuration

## What survives a restart

Everything. Sortie stores all durable state in SQLite, not in memory. A restart is equivalent to closing and reopening the database file. Three tables hold the data that matters:

| Table | What it stores | Why it matters after restart |
|---|---|---|
| `retry_entries` | Pending retries: issue ID, attempt number, scheduled fire time | Retries resume at the correct position in the backoff sequence. Overdue retries fire immediately on startup. |
| `run_history` | Completed runs: issue ID, attempt, status, timestamps, workspace path | The `max_sessions` budget check queries this table. After restart, Sortie knows exactly how many sessions each issue has used — no counter resets. |
| `session_metadata` | Last session ID, token counters, model name, API request count | Enables agent session resume (e.g., the `--resume` flag for Claude Code). When the same issue is dispatched again, the adapter can pick up the previous session. |

The key insight: Sortie never holds state that only exists in memory. Retry attempt counts, session budgets, and token tallies all come from SQLite queries. Kill the process at any point and nothing is lost.

## What happens to in-flight sessions

When Sortie stops — whether from `Ctrl+C`, SIGTERM, or a crash — any running agent processes receive SIGTERM, then SIGKILL after a 30-second grace period. The issues those agents were working on are left in a recoverable state:

- Their tracker status hasn't changed (still "In Progress" or whatever your active state is)
- Their workspace directories remain on disk, untouched
- They may or may not have a pending retry entry in SQLite, depending on when the stop happened

Here's what the startup sequence does to pick them back up:

1. Sortie opens the database and loads all retry entries. Overdue entries (where the fire time has passed) are marked for immediate dispatch.
2. The poll loop starts and fetches candidate issues from the tracker.
3. Previously in-flight issues appear as candidates — they're still in an active tracker state.
4. Sortie dispatches them again, reusing existing workspace directories.
5. The `before_run` hook runs in the existing workspace (for example, `git pull` to bring the workspace up to date).
6. The agent starts in that workspace with all previous work preserved on disk.

No special configuration is needed for this to work. It's the default behavior.

If your `before_run` hook does a `git fetch && git reset`, the agent picks up exactly where the previous session left off. If you haven't configured hooks, the workspace contains whatever files the agent wrote before the process stopped.

## Design your hooks for restartability

Workspace paths are deterministic. Issue `PROJ-42` always maps to the same directory: `<workspace_root>/PROJ-42`. The first dispatch creates it; every subsequent dispatch reuses it — including dispatches after a restart.

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

The built-in dashboard reads directly from SQLite. Run history, active sessions, and pending retries all reflect persisted state — they survive restarts along with everything else. See the [Dashboard reference](/reference/dashboard/).

### Test it yourself

The most convincing verification is a manual test:

```bash
# Start Sortie
sortie start ./WORKFLOW.md

# Wait for it to dispatch at least one issue (watch the logs)
# Then stop it
# Ctrl+C

# Restart immediately
sortie start ./WORKFLOW.md
```

After restart, confirm in the logs that:

- The previously dispatched issue appears as a candidate on the first poll tick
- The workspace is reused (look for `workspace prepared` without `after_create` firing)
- If a retry was pending, the retry entry is loaded and the timer is reconstructed

## What we configured

Nothing, actually. Persistence and restart recovery are built into Sortie's default behavior. What you got from this guide:

- **Confidence that no work is lost.** Retry queues, session budgets, and token accounting all survive restarts because they live in SQLite.
- **Understanding of the restart sequence.** In-flight issues are re-discovered through the normal poll loop and dispatched into their existing workspaces.
- **A hook pattern for seamless restarts.** `after_create` for one-time setup, `before_run` for refresh, `after_run` for preservation.
- **Verification steps.** Database file check, startup log messages, dashboard inspection, and a manual restart test.

## Related guides

- [Configure Retry Behavior](/guides/configure-retry-behavior/) — tune backoff timing and session budgets
- [Set Up Workspace Hooks](/guides/setup-workspace-hooks/) — hook writing patterns and lifecycle details
- [Run as a systemd Service](/guides/run-as-systemd-service/) — automatic restart on failure with `Restart=on-failure`
- [Monitor with Logs](/guides/monitor-with-logs/) — filter and interpret startup recovery messages
