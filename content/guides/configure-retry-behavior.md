---
title: "How to Configure Retry Behavior"
linkTitle: "Configure Retry Behavior"
description: "Control how Sortie retries failed agents with session budgets, backoff tuning, stall detection, and timeout settings for production reliability."
author: Sortie AI
date: 2026-03-28
weight: 60
url: /guides/configure-retry-behavior/
---
Make Sortie's retries match your operational needs — cap runaway loops, tune backoff timing, and catch stalled sessions before they waste slots.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- A `WORKFLOW.md` with an `agent` block configured
- Familiarity with running `sortie` and reading its logs

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
level=WARN msg="effort budget exhausted, blocking re-dispatch" issue_id="PROJ-42" issue_identifier="PROJ-42" count=3 max_sessions=3
```

At that point, the issue is no longer Sortie's problem. Check the [dashboard](/reference/dashboard/) run history to see what each session accomplished.

A second ceiling guards cost rather than attempts. When [`agent.max_tokens`](/reference/workflow-config/#agent) is set, Sortie also sums the tokens consumed across the issue's completed sessions before every re-dispatch and blocks the issue once the sum reaches the budget. The effect is identical to session exhaustion: claim released, retry entry dropped, issue left for human review. The two ceilings are independent and whichever fills first wins; when one evaluation finds both exhausted, the logged reason names the token budget (`token_budget`). If the token query fails, the check fails open and dispatch proceeds. For choosing a budget and the cost math, see [how to control agent costs](/guides/control-costs/).

```yaml
agent:
  max_tokens: 1500000
```

When the token ceiling fires:

```
level=WARN msg="token budget exhausted, blocking re-dispatch" issue_id="PROJ-42" issue_identifier="PROJ-42" reason="token_budget" used_tokens=1503417 budget_tokens=1500000 used_sessions=2 budget_sessions=3
```

### Park issues stuck in a loop of empty runs

Sortie distinguishes a run that produced nothing observable in the workspace from a run that failed outright. Under [`tracker.handoff_evidence`](/reference/workflow-config/#tracker) at its default, `observed` (and under `strict`), a run whose workspace shows no evidence of work does not advance the issue. It is retried on the same exponential backoff as an error, not the 1-second continuation delay below. See the [state machine reference](/reference/state-machine/#handoff-evidence) for the full three-verdict rule this follows.

Left alone, an issue stuck in that loop would retry forever. Sortie counts consecutive runs whose handoff was withheld this way and stops once the count reaches a ceiling: [`agent.max_consecutive_absences`](/reference/workflow-config/#agent), which defaults to `3` and is a separate setting from `agent.max_sessions` - raising or lowering one does not move the other. Unlike `max_sessions`, `0` does not mean unlimited here: `0` and negative values are rejected as a configuration error, because an unbounded absence sequence is exactly what this ceiling exists to prevent. With the default, an issue that never shows evidence of work gets the initial run plus two retries, then parks on the third absence.

```yaml
agent:
  max_consecutive_absences: 5   # Park after five consecutive absences instead of three
```

Parking:

- attaches an escalation label to the issue
- stops the retry sequence
- releases Sortie's claim on the issue
- holds the issue out of dispatch until you release it

The label is [`reactions.review_comments.escalation_label`](/reference/reactions/#reactionsreview_comments), falling back to `needs-human` when that block or value is absent. Only the label's name is borrowed: `reactions.review_comments` does not need to be active for this park to use it, and that reaction's own escalation action plays no part here.

You'll see both steps in the logs:

```
level=WARN msg="handoff withheld by evidence policy" issue_id="PROJ-42" issue_identifier="PROJ-42" policy="observed" verdict="absence of work observed" reason="workspace commit and working tree match the run baseline" turns_completed=2 consecutive_absences=3
level=WARN msg="issue parked" issue_id="PROJ-42" issue_identifier="PROJ-42" reason="handoff_absence" parked_state="In Progress" label="needs-human" consecutive_absences=3 absence_ceiling=3 ceiling_setting="agent.max_consecutive_absences"
```

Release a parked issue with any one of three gestures:

1. Move the issue to a tracker state different from the one it was parked in.
2. Remove the parking label, but only once Sortie has confirmed, on a later fetch, that the label actually reached the tracker. A label you see missing before that confirmation happened releases nothing.
3. Let a later run for the same issue produce a work-observed verdict; the park lifts on its own.

If [`tracker.query_filter`](/reference/workflow-config/#tracker) excludes the parking label from the issues Sortie fetches, Sortie can never confirm the label is present, so removing it never releases the park either. Release those issues by moving them to a different state instead.

A review-comment or CI continuation retry is never stopped by this ceiling; it runs on its own retry budget. The consecutive-absence count is neither kept nor consulted when `tracker.handoff_evidence` is `off`. And a run that ends with no evidence verdict at all, such as an agent that reports itself blocked, leaves the count exactly where it stood: it neither advances it nor resets it. So does a run whose withheld verdict Sortie discarded because the issue had reached a terminal state by the time the outcome was recorded - a finished issue does not move toward the ceiling.

## Tune backoff timing

Sortie uses two different retry strategies depending on what happened, and they fire at different speeds.

### Continuation retries (1-second delay)

When an agent finishes its turns normally but the issue is still in an active tracker state, Sortie treats this as "keep going" — not an error. It waits 1 second and dispatches a new session. This also applies when a handoff transition fails, but not when the handoff is withheld by the evidence policy: that outcome takes the exponential-backoff lane below, covered under [park issues stuck in a loop of empty runs](#park-issues-stuck-in-a-loop-of-empty-runs).

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
level=ERROR msg="worker run failed, non-retryable, releasing claim" error="agent: agent_not_found: agent command \"claude\" not found: exec: \"claude\": executable file not found in $PATH"
```

For the full error catalog with every error kind and its retry classification, see the [error reference](/reference/errors/).

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

`agent.turn_timeout_ms` is the hard cap on total time for a single agent turn. Default: `3600000` (1 hour). This fires regardless of agent activity — even a chatty agent gets killed when time's up.

Unlike `stall_timeout_ms`, this bound cannot be turned off. The value must be positive; a non-positive `turn_timeout_ms` stops the workflow from loading.

```yaml
agent:
  turn_timeout_ms: 1800000  # 30 min hard cap
```

Keep `stall_timeout_ms` shorter than `turn_timeout_ms`. Stall detection catches silent failures early; the turn timeout is the backstop for everything else. A practical ratio: 5-minute stall timeout, 30-minute turn timeout.

## Example: production retry config

Here's a conservative configuration that balances reliability with resource efficiency:

```yaml {hl_lines=["4-6","8-10"]}
# WORKFLOW.md — agent block
agent:
  kind: claude-code
  max_turns: 3
  max_sessions: 3
  max_tokens: 1500000
  max_concurrent_agents: 4
  turn_timeout_ms: 1800000      # 30 min per turn
  stall_timeout_ms: 300000       # 5 min stall detection
  max_retry_backoff_ms: 120000   # 2 min max backoff
```

What this means in practice: each issue gets up to 3 sessions. Each session runs up to 3 turns. An issue stops getting new sessions once its sessions have consumed 1.5M tokens in total. Stalled sessions are killed after 5 minutes of silence. Error retries cap at 2 minutes between attempts.

Worst case for a single issue: 3 sessions × 3 turns × 30 minutes = 4.5 hours of compute time, plus retry delays between sessions. In reality, most issues resolve in one session, and failed turns trigger backoff well before hitting the turn timeout.

If an error retry fires but no concurrency slot is available, the retry is rescheduled at the same backoff interval — it doesn't lose its place in the queue or reset its attempt counter.

## Verify retry behavior

Three ways to confirm your retry settings are working.

**Dashboard.** The web dashboard shows entries in `Retrying` state with their attempt count and time until the next retry fires. Issues that exhausted their session budget appear in the run history with all session outcomes. See the [dashboard reference](/reference/dashboard/).

**Logs.** Search for these key messages:

```bash
# Retry scheduled after error
grep "scheduling retry" sortie.log

# Retry timer fired and dispatched
grep "retried issue dispatched" sortie.log

# Session budget exhausted
grep "effort budget exhausted" sortie.log

# Token budget exhausted
grep "token budget exhausted" sortie.log

# Stall killed a session
grep "stall detected" sortie.log

# Handoff withheld because no work was observed
grep "handoff withheld by evidence policy" sortie.log

# Issue parked after repeated absence of work
grep "issue parked" sortie.log
```

**Dry run.** `sortie --dry-run` runs a single poll tick and shows which issues are eligible for dispatch. It doesn't test retry behavior directly (retries happen over multiple ticks), but it confirms your config parses correctly and issues are visible.

## What we configured

You now have control over Sortie's retry behavior: how many times it retries (`max_sessions`), how much an issue may spend across those attempts (`max_tokens`), how long it waits between retries (`max_retry_backoff_ms`), how it detects stuck sessions (`stall_timeout_ms`), when it gives up on a single turn (`turn_timeout_ms`), and how many consecutive absences of observable work it tolerates before parking an issue (`max_consecutive_absences`). The continuation retry for successful-but-incomplete work runs at a fixed 1-second interval and needs no configuration.

For the full state machine and backoff formulas, see the [state machine reference](/reference/state-machine/). For all config field defaults in one place, see the [workflow config reference](/reference/workflow-config/). For budget and cost controls that complement retry settings, see [how to control agent costs](/guides/control-costs/).
