---
title: "How to Configure Retry Behavior"
linkTitle: "Configure Retry Behavior"
description: "Control how Sortie retries failed agents with session budgets, backoff tuning, stall detection, and timeout settings for production reliability."
author: Sortie AI
date: 2026-03-28
weight: 60
url: /guides/configure-retry-behavior/
---
Make Sortie's retries match your operational needs: cap runaway loops, tune backoff timing, and catch stalled sessions before they waste slots.

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

The distinction between sessions and turns matters here. `max_sessions` counts completed worker sessions (full invocations of the worker loop). `max_turns` (default: `20`) counts turns *within* a single session. A session that fails on turn 2 of 5 still counts as one completed session toward the budget. The two settings multiply to bound worst-case effort:

$$
\text{max\_sessions} \times \text{max\_turns} = \text{maximum total turns per issue}
$$

When the budget is exhausted, you'll see this in the logs:

```
level=WARN msg="effort budget exhausted, blocking re-dispatch" issue_id="PROJ-42" issue_identifier="PROJ-42" count=3 max_sessions=3
```

At that point, the issue is no longer Sortie's problem. Check the issue's [page on the dashboard](/reference/dashboard/#issue-page) to see what each session accomplished.

A second ceiling guards cost rather than attempts. When [`agent.max_tokens`](/reference/workflow-config/#agent) is set, Sortie also sums the tokens consumed across the issue's completed sessions before every re-dispatch and blocks the issue once the sum reaches the budget. The effect at that point is identical to session exhaustion: claim released, retry entry dropped, issue left for human review.

It differs in one way that matters here: this ceiling does not wait for a session boundary. Reaching it during a session cancels that session, and when that cancellation is what ends the attempt, it is recorded `budget_stopped` with no retry scheduled.

The two ceilings are independent and whichever fills first wins; when one evaluation finds both exhausted, the logged reason names the token budget (`token_budget`). If the token query fails, the pre-dispatch check fails open and dispatch proceeds. For choosing a budget and the cost math, see [how to control agent costs](/guides/control-costs/).

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

Left alone, an issue stuck in that loop would retry forever. Sortie counts consecutive runs whose handoff was withheld this way and stops once the count reaches a ceiling: [`agent.max_consecutive_absences`](/reference/workflow-config/#agent), which defaults to `3` and is a separate setting from `agent.max_sessions`. Raising or lowering one does not move the other.

Unlike `max_sessions`, `0` does not mean unlimited here: `0` and negative values are rejected as a configuration error, because an unbounded absence sequence is exactly what this ceiling exists to prevent. With the default, an issue that never shows evidence of work gets the initial run plus two retries, then parks on the third absence.

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

To find out which issues are parked right now, read the `parked` list of `GET /api/v1/state`, or ask for one issue with `GET /api/v1/{identifier}`, which answers with `status` `parked`. Each entry gives the title, link, reason, and parking label, plus the dispatch rule, agent, and model of the run that led to the park, so you can tell which stage got stuck. See the [HTTP API reference](/reference/http-api/#get-apiv1state-system-state).

A review-comment or CI continuation retry is never stopped by this ceiling; it runs on its own retry budget. The consecutive-absence count is neither kept nor consulted when `tracker.handoff_evidence` is `off`.

And a run that ends with no evidence verdict at all, such as an agent that reports itself blocked, leaves the count exactly where it stood: it neither advances it nor resets it. So does a run whose withheld verdict Sortie discarded because the issue had reached a terminal state by the time the outcome was recorded. A finished issue does not move toward the ceiling.

## Tune backoff timing

Sortie uses two different retry strategies depending on what happened, and they fire at different speeds.

### Continuation retries (1-second delay)

When an agent finishes its turns normally but the issue is still in an active tracker state, Sortie treats this as "keep going," not an error. It waits 1 second and dispatches the issue again, resuming the same agent session. This also applies when a handoff transition fails, but not when the handoff is withheld by the evidence policy: that outcome takes the exponential-backoff lane below, covered under [park issues stuck in a loop of empty runs](#park-issues-stuck-in-a-loop-of-empty-runs).

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
| `tracker_not_found` | 404: issue or resource doesn't exist |
| `tracker_payload_error` | Malformed tracker response |

When you see these, the fix is operational: install the binary, fix the workspace path, rotate the API key. The log line is explicit:

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
  stall_timeout_ms: 300000  # kill silent sessions after 5 min
```

Sortie checks for stalls every poll tick. It measures time since the last agent event (or session start, whichever is more recent). If that exceeds `stall_timeout_ms`, the worker is cancelled and an exponential-backoff retry is scheduled. You'll see:

```
level=WARN msg="stall detected, cancelling worker" issue_id="PROJ-42" elapsed_ms=301000 stall_timeout_ms=300000
```

A changed `stall_timeout_ms` takes effect at the next poll tick without a restart, including for sessions already running. Lowering it stops any running session that is already silent for longer than the new value. See the [dynamic reload table](/reference/workflow-config/#dynamic-reload-1).

### Turn timeout

`agent.turn_timeout_ms` is the hard cap on total time for a single agent turn. Default: `3600000` (1 hour). This fires regardless of agent activity. Even a chatty agent gets killed when time's up.

Unlike `stall_timeout_ms`, this bound cannot be turned off. The value must be positive; a non-positive `turn_timeout_ms` stops the workflow from loading.

```yaml
agent:
  turn_timeout_ms: 1800000  # 30 min hard cap
```

Keep `stall_timeout_ms` shorter than `turn_timeout_ms`. Stall detection catches silent failures early; the turn timeout is the backstop for everything else. A practical ratio: 5-minute stall timeout, 30-minute turn timeout.

## Example: production retry config

Here's a conservative configuration that balances reliability with resource efficiency:

```yaml {hl_lines=["4-6","8-10"]}
# WORKFLOW.md: agent block
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

If a retry fires but no concurrency slot is available, it stays in the retry queue and keeps the issue's claim. It moves to the next attempt number, so its delay grows by one backoff step, and its error reads `no available orchestrator slots`.

## Run a waiting retry now

A retry waits out its delay, up to `max_retry_backoff_ms`. When the cause is gone before then, for example a rate limit has reset or a tracker outage is over, make the retry due now instead of waiting. Restarting Sortie is not needed.

1. List the waiting retries and pick the issue:

   ```bash
   curl -s http://localhost:7678/api/v1/state | jq '.retrying[] | {issue_identifier, attempt, due_at, error}'
   ```

2. Make its retry due now:

   ```bash
   curl -X POST http://localhost:7678/api/v1/retries/MT-650/run
   ```

   The `202` response says what happened, for example `Retry 3 of MT-650 is due now.`

3. Confirm that the retry fired:

   ```bash
   grep -e "retry made due on request" -e "retried issue dispatched" sortie.log
   ```

The request does not skip any check. The retry still needs a free agent slot and room in the session and token budgets, and the issue must still be in an active tracker state. A retry that cannot start goes back to waiting at the same attempt number and the due time it had before your request, and its `error` in the list from step 1 says why. A retry the issue's state pauses stays paused.

If the response is `404` with `retry_not_found`, the issue has no waiting retry: it already ran, or Sortie released it. The server has no authentication, so keep it behind a reverse proxy with authentication or a VPN when others can reach it. For the response fields and every status code, see the [HTTP API reference](/reference/http-api/#post-apiv1retriesidentifierrun-run-a-scheduled-retry-now).

## Verify retry behavior

Three ways to confirm your retry settings are working.

**Dashboard.** The web dashboard lists issues waiting on a retry under the **Retry scheduled** chip with a countdown to the due time, and the **Retry** panel of the issue page gives the attempt and the error. An issue that exhausted its session budget appears as an [attention item](/reference/dashboard/#attention-items), with all its session outcomes on the issue page and in [History](/reference/dashboard/#history).

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
