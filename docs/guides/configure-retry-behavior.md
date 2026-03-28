---
title: "How to Configure Retry Behavior | Sortie"
description: "Control how Sortie retries failed agents with session budgets, backoff tuning, stall detection, and timeout settings for production reliability."
keywords: sortie retry, max_sessions, backoff, stall detection, turn timeout, retry configuration, agent failure, max_retry_backoff_ms
author: Sortie AI
---

# How to configure retry behavior

Make Sortie's retries match your operational needs — cap runaway loops, tune backoff timing, and catch stalled sessions before they waste slots.

## Prerequisites

- A working Sortie setup ([quick start](../getting-started/quick-start.md))
- A `WORKFLOW.md` with an `agent` block configured
- Familiarity with running `sortie start` and reading its logs

## Stop runaway retries on stuck issues

The most common retry problem: an agent fails on the same issue over and over, burning tokens and slots indefinitely. This happens because `agent.max_sessions` defaults to `0`, which means unlimited.

Set it to a real number:

```yaml
agent:
  kind: claude-code
  max_sessions: 3
```

With `max_sessions: 3`, Sortie runs up to three completed worker sessions for each issue. After the third session finishes without resolving the issue, Sortie releases the claim and the issue stays in its current tracker state for human review.

The distinction between sessions and turns matters here. `max_sessions` counts completed worker sessions — full invocations of the worker loop. `max_turns` (default: `20`) counts turns *within* a single session. A session that fails on turn 2 of 5 still counts as one completed session toward the budget. The two settings multiply to bound worst-case effort:

$$
\text{max\_sessions} \times \text{max\_turns} = \text{maximum total turns per issue}
$$

When the budget is exhausted, you'll see this in the logs:

```
level=WARN msg="effort budget exhausted, releasing claim" issue_id="PROJ-42" identifier="PROJ-42" completed_sessions=3 max_sessions=3
```

At that point, the issue is no longer Sortie's problem. Check the [dashboard](../reference/dashboard.md) run history to see what each session accomplished.

## Tune backoff timing

Sortie uses two different retry strategies depending on what happened, and they fire at different speeds.

### Continuation retries (1-second delay)

When an agent finishes its turns normally but the issue is still in an active tracker state, Sortie treats this as "keep going" — not an error. It waits 1 second and dispatches a new session. This also applies when a handoff transition fails.

You don't configure this delay. It's fixed at 1,000 ms because the agent succeeded; there's no reason to wait.

### Error retries (exponential backoff)

When an agent crashes, times out, or stalls, Sortie backs off exponentially:

| Attempt | Delay | Formula |
|---------|-------|---------|
| 1 | 10 s | `min(10000 × 2⁰, cap)` |
| 2 | 20 s | `min(10000 × 2¹, cap)` |
| 3 | 40 s | `min(10000 × 2², cap)` |
| 4 | 80 s | `min(10000 × 2³, cap)` |
| 5 | 160 s | `min(10000 × 2⁴, cap)` |
| 6+ | capped | `cap` |

The cap is `agent.max_retry_backoff_ms`. Default: `300000` (5 minutes). Lower it if your failures are typically transient and you want faster recovery. Raise it if your tracker rate-limits you or you're paying per API call:

```yaml
agent:
  max_retry_backoff_ms: 120000  # 2 min cap for faster recovery
```

### Non-retryable errors skip the queue entirely

Some failures indicate a configuration problem that retrying won't fix. Sortie releases the claim immediately:

| Error | Meaning |
|-------|---------|
| `agent_not_found` | Agent binary missing from PATH |
| `invalid_workspace_cwd` | Workspace directory doesn't exist or isn't accessible |
| `turn_cancelled` | Turn was killed (e.g., stall detection) |
| `turn_input_required` | Agent asked for human input |
| Tracker auth errors | 401/403 from your tracker |
| `tracker_not_found` | 404 — issue or resource doesn't exist |
| `tracker_payload_error` | Malformed tracker response |

When you see these, the fix is operational — install the binary, fix the workspace path, rotate the API key. The log line is explicit:

```
level=ERROR msg="worker run failed, non-retryable, releasing claim" error="agent: agent_not_found: claude not found in PATH"
```

For the full error catalog with every error kind and its retry classification, see the [error reference](../reference/errors.md).

## Catch stalled sessions

A stalled session produces no events but holds a concurrency slot. Two timeouts address this.

### Stall detection

`agent.stall_timeout_ms` controls how long Sortie waits before killing a session that has gone silent. Default: `300000` (5 minutes). Set to `0` to disable stall detection entirely.

```yaml
agent:
  stall_timeout_ms: 300000  # 5 min — kill silent sessions
```

Sortie checks for stalls every poll tick. It measures time since the last agent event (or session start, whichever is more recent). If that exceeds `stall_timeout_ms`, the worker is cancelled and an exponential-backoff retry is scheduled. You'll see:

```
level=WARN msg="stall detected, cancelling worker" issue_id="PROJ-42" elapsed_ms=301000 stall_timeout_ms=300000
```

### Turn timeout

`agent.turn_timeout_ms` is the hard cap on total time for a single `RunTurn` call. Default: `3600000` (1 hour). This fires regardless of agent activity — even a chatty agent gets killed when time's up.

```yaml
agent:
  turn_timeout_ms: 1800000  # 30 min hard cap
```

Keep `stall_timeout_ms` shorter than `turn_timeout_ms`. Stall detection catches silent failures early; the turn timeout is the backstop for everything else. A practical ratio: 5-minute stall timeout, 30-minute turn timeout.

## Example: production retry config

Here's a conservative configuration that balances reliability with resource efficiency:

```yaml
# WORKFLOW.md — agent block
agent:
  kind: claude-code
  max_turns: 3
  max_sessions: 3
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000      # 30 min per turn
  stall_timeout_ms: 300000       # 5 min stall detection
  max_retry_backoff_ms: 120000   # 2 min max backoff
```

What this means in practice: each issue gets up to 3 sessions. Each session runs up to 3 turns. Stalled sessions are killed after 5 minutes of silence. Error retries cap at 2 minutes between attempts.

Worst case for a single issue: 3 sessions × 3 turns × 30 minutes = 4.5 hours of compute time, plus retry delays between sessions. In reality, most issues resolve in one session, and failed turns trigger backoff well before hitting the turn timeout.

If an error retry fires but no concurrency slot is available, the retry is rescheduled at the same backoff interval — it doesn't lose its place in the queue or reset its attempt counter.

## Verify retry behavior

Three ways to confirm your retry settings are working.

**Dashboard.** The web dashboard shows entries in `Retrying` state with their attempt count and time until the next retry fires. Issues that exhausted their session budget appear in the run history with all session outcomes. See the [dashboard reference](../reference/dashboard.md).

**Logs.** Search for these key messages:

```bash
# Retry scheduled after error
grep "scheduling retry" sortie.log

# Retry timer fired and dispatched
grep "retried issue dispatched" sortie.log

# Session budget exhausted
grep "effort budget exhausted" sortie.log

# Stall killed a session
grep "stall detected" sortie.log
```

**Dry run.** `sortie start --dry-run` runs a single poll tick and shows which issues are eligible for dispatch. It doesn't test retry behavior directly (retries happen over multiple ticks), but it confirms your config parses correctly and issues are visible.

## What we configured

You now have control over all four dimensions of Sortie's retry behavior: how many times it retries (`max_sessions`), how long it waits between retries (`max_retry_backoff_ms`), how it detects stuck sessions (`stall_timeout_ms`), and when it gives up on a single turn (`turn_timeout_ms`). The continuation retry for successful-but-incomplete work runs at a fixed 1-second interval and needs no configuration.

For the full state machine and backoff formulas, see the [state machine reference](../reference/state-machine.md). For all config field defaults in one place, see the [workflow config reference](../reference/workflow-config.md). For budget and cost controls that complement retry settings, see [how to control agent costs](control-costs.md).
