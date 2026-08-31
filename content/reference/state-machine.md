---
title: "State Machine"
description: "Reference for Sortie's internal orchestration states, run attempt phases, transition triggers, retry backoff, and reconciliation behavior."
author: Sortie AI
date: 2026-03-28
weight: 70
url: /reference/state-machine/
---
Sortie maintains two layers of state for every issue it processes. The **orchestration state** tracks whether the orchestrator has claimed the issue and what it is doing with it. The **run attempt phase** tracks where a single agent invocation stands within its lifecycle. These are independent from tracker states (`To Do`, `In Progress`) - they are Sortie's internal bookkeeping.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for `active_states`, `terminal_states`, `handoff_state`, and `in_progress_state`; [error reference](/reference/errors/) for error kinds that trigger retries; [CLI reference](/reference/cli/) for `--dry-run` mode that simulates dispatch without launching agents; [dashboard reference](/reference/dashboard/) for real-time visibility into orchestration state.

---

## Orchestration states

Every issue known to the orchestrator is in exactly one of five states. The orchestrator is the single authority for these transitions - no other component mutates scheduling state.

| State | Description |
|---|---|
| `Unclaimed` | The issue is not running and has no retry scheduled. Eligible for dispatch if it meets [candidate selection rules](#candidate-eligibility). An unclaimed issue can still be held out of dispatch by a park record or an exhausted effort budget; both are dispatch gates rather than claim states. |
| `Claimed` | The orchestrator has reserved the issue to prevent duplicate dispatch. A claimed issue is always either `Running` or `RetryQueued`. |
| `Running` | A worker goroutine exists for this issue. The issue is tracked in the `running` map with a live `RunningEntry`. |
| `RetryQueued` | No worker is running, but a retry timer exists. The issue remains claimed until the timer fires and either re-dispatches or releases. |
| `Released` | The claim has been removed. The issue is no longer tracked. This happens when the issue reaches a terminal tracker state, leaves the active state set, is missing from the tracker, or exhausts its retry path. |

```mermaid
flowchart TD
    UC([Unclaimed]) --> RN

    subgraph Claimed
        RN[Running] --> RQ[RetryQueued]
        RQ --> RN
    end

    Claimed --> RL([Released])
    RL --> UC

    classDef idle fill:#f0f0f4,stroke:#8b8fa3,color:#3a3d4a
    classDef active fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f,stroke-width:2px
    classDef waiting fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef released fill:#f0f0f4,stroke:#8b8fa3,color:#3a3d4a,stroke-dasharray:5 5

    class UC idle
    class RN active
    class RQ waiting
    class RL released

    style Claimed fill:none,stroke:#3b82f6,stroke-width:2px,rx:8,color:#3b82f6
```

### Transition details

**Unclaimed → Claimed.** Occurs during the dispatch phase of a poll tick. The issue must pass all [candidate eligibility](#candidate-eligibility) checks and a global or per-state concurrency slot must be available. Dispatch claims and launches in one step, so this path never leaves an issue claimed without a worker; `RetryQueued` and the retry entries rehydrated at startup are the two ways an issue is claimed with no worker running.

**Running → RetryQueued.** Five worker exit outcomes lead here (the first two do not apply when a soft-stop signal is active; see [Claimed → Released](#transition-details) below):

- *Normal exit, issue still active, no soft-stop:* continuation retry after 1 000 ms fixed delay.
- *Normal exit, handoff fails, no soft-stop:* continuation retry after 1 000 ms.
- *Normal exit, handoff withheld by the [evidence policy](#handoff-evidence), no soft-stop, and the issue not found terminal by the read that outcome performs:* exponential backoff retry (see [backoff formula](#backoff-formula)) - the only one of these five outcomes that takes exponential backoff from a normal exit rather than the fixed continuation delay.
- *Error exit, retryable:* exponential backoff retry (see [backoff formula](#backoff-formula)).
- *Stall timeout:* worker is killed; exponential backoff retry is scheduled.

A worker exit is not the only way an entry gets queued: a [reaction reconcile pass](#transition-triggers) writes one directly for an issue whose session has already ended, which is how a CI fix, a review response, or a rebase reaches the dispatch path.

An issue holds at most one queued retry. When any of these outcomes finds one already queued — a reaction continuation scheduled while the session was still running, for example — the queued entry is left in place and the claim is kept, rather than the queued work being replaced. The queued entry runs on its own timer, and the outcome that deferred to it takes no further action.

**RetryQueued → Running.** The retry timer fires. The orchestrator reads that one issue from the tracker by ID - not the candidate list - confirms it is still eligible, acquires a slot, and launches a new worker. If no slot is available, the entry is rescheduled at the next attempt number, so its delay grows by one backoff step rather than repeating.

**Claimed → Released.** The claim is removed and no retry is scheduled:

- Reconciliation detects the tracker state is terminal or no longer in `active_states`.
- The retry timer fires and the per-issue tracker read reports the issue missing, terminal, or no longer in an active state. A reaction-kind entry is rescheduled instead of released.
- The `max_sessions` budget is reached.
- The `max_tokens` token budget is reached.
- The worker error is classified as non-retryable.
- A `handoff_state` transition succeeds (the tracker now owns the issue). A run that declared no change was needed targets `tracker.no_change_state` instead where that field is configured; see [handoff evidence](#handoff-evidence).
- Soft-stop `blocked`: worker exits normally, claim released. No handoff transition, no continuation retry. Where the dispatch drives issue state, the issue is also parked with the escalation label and held out of dispatch until a release gesture. See [the parked-issue release rules](/concepts/agent-communication/).
- Soft-stop `needs-human-review`, handoff succeeds: worker exits normally, handoff transition performed, claim released.
- Soft-stop `needs-human-review`, handoff fails: worker exits normally, handoff fails, claim released without retry.
- The consecutive handoff-absence ceiling is reached: the claim is released and the issue is held out of dispatch until a release gesture. See [park issues stuck in a loop of empty runs](/guides/configure-retry-behavior/#park-issues-stuck-in-a-loop-of-empty-runs) for the ceiling and the three release gestures.

Two of these release only when the issue has no retry already queued: a successful `handoff_state` transition, and a normal exit on an issue that has since left the active states. A queued retry keeps the claim in both cases, so work queued while the session was running is not stranded.

**Released → Unclaimed.** A released issue can be re-dispatched on a future poll tick if its tracker state returns to an active state. The orchestrator does not remember previous releases - each poll tick evaluates eligibility from scratch.

---

## Run attempt phases

Each worker attempt progresses through a linear sequence of phases. Terminal phases end the attempt and produce a `WorkerResult` delivered to the orchestrator.

| Phase | Description |
|---|---|
| `DispatchTransition` | Optional. When [`tracker.in_progress_state`](/reference/workflow-config/) is configured and the dispatch drives issue state, the worker calls `TransitionIssue` before workspace preparation. If the issue is already in the target state, the call is skipped (debug log only). Failure is non-fatal - the worker logs a warning and continues. A dispatch that does not drive issue state, such as a label-command session, skips the phase entirely. |
| `DispatchComment` | Optional. When [`tracker.comments.on_dispatch`](/reference/workflow-config/) is `true` and the dispatch drives issue state, the worker posts a tracker comment acknowledging that Sortie has claimed the issue. Fires after the dispatch transition and before workspace preparation. Failure is non-fatal - the worker logs a warning and continues. |
| `PreparingWorkspace` | Workspace directory is created or reused. `after_create` and `before_run` hooks execute. |
| `BuildingPrompt` | The `text/template` prompt body is rendered with issue data, attempt number, and turn context. |
| `LaunchingAgentProcess` | The agent adapter starts a session (subprocess or API call). |
| `InitializingSession` | Waiting for the `session_started` event from the agent adapter. |
| `StreamingTurn` | The agent is actively working. Token usage, tool calls, and status events stream in. |
| `SelfReviewing` | Optional. Entered only when [`self_review.enabled`](/reference/workflow-config/#self_review) is true and the coding turn loop finished successfully, not on turn failure. Runs review iterations until the turn budget is exhausted or the agent signals completion. |
| `Finishing` | The turn ended. `after_run` hooks execute. The worker checks whether to loop for another turn. |
| `Succeeded` | Terminal. The worker completed all turns without error. |
| `Failed` | Terminal. An error occurred during any earlier phase. |
| `TimedOut` | Terminal. The turn exceeded `agent.turn_timeout_ms`. |
| `Stalled` | Terminal. No agent event arrived within `agent.stall_timeout_ms`. Detected by reconciliation. |
| `CanceledByReconciliation` | Terminal. The worker's context was cancelled because the issue's tracker state became terminal or left the active set. |

```mermaid
flowchart TD
    DT[DispatchTransition] --> DC[DispatchComment]
    DC --> PW[PreparingWorkspace]
    PW --> BP[BuildingPrompt]
    BP --> LA[LaunchingAgent]
    LA --> IS[InitializingSession]
    IS --> ST[StreamingTurn]
    ST --> FN[Finishing]
    ST --> SR[SelfReviewing]
    SR --> FN

    FN --> ST
    FN --> OK([Succeeded])

    ST --> TO([TimedOut])
    SR --> TO
    ST --> SL([Stalled])
    ST --> CR([Canceled])

    classDef phase fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    classDef active fill:#bfdbfe,stroke:#2563eb,color:#1e3a5f,stroke-width:2px
    classDef success fill:#d1fae5,stroke:#059669,color:#064e3b,stroke-width:2px
    classDef failure fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

    class DT,DC,PW,BP,LA,IS,SR,FN phase
    class ST active
    class OK success
    class TO,SL,CR failure
```

Any phase from `PreparingWorkspace` through `StreamingTurn` can also transition to **Failed** on error; `SelfReviewing` can also transition to **TimedOut**, but only when a review or fix turn exceeds `agent.turn_timeout_ms`.

### Multi-turn behavior

A single worker attempt can execute multiple agent turns. After each turn:

1. The worker checks the tracker for the issue's current state.
2. If the state is still active and the turn count has not reached [`agent.max_turns`](/reference/workflow-config/), the worker loops back to `StreamingTurn`.
3. The first turn uses the full rendered prompt. Continuation turns send only continuation guidance to the existing agent thread.

---

## Tracker states the orchestrator writes

The orchestrator writes tracker state at exactly three points in an issue's life, each one a single named state drawn from configuration.

| Write | Trigger | Configured by |
|---|---|---|
| In-progress state | At dispatch, before workspace preparation. | `tracker.in_progress_state` |
| Handoff state | On a normal worker exit, with the issue still in an active state, the dispatch driving issue state, not a blocked soft stop, not already reported terminal, and not withheld by the [handoff-evidence verdict](#handoff-evidence). | `tracker.handoff_state`, or `tracker.no_change_state` for a run that declared no change was needed |
| Terminal state | When a Sortie-managed pull request merges while the linked issue is still parked in the handoff state. | `reactions.merge_completion.target_state` |

There are no other orchestrator-initiated tracker writes. What the orchestrator does besides these three carries no state semantics: the dispatch comment, the completion and failure comments, the auto-merge success comment, and a reaction's escalation label or comment are not transitions. The governing boundary is not between reading and writing, it is between a write that reports an event the orchestrator observed and a write that expresses a judgment about the work; the orchestrator makes only the first kind, so a case that turns on judgment, such as choosing between a completion state and an abandonment state for a pull request closed unmerged, is left to you or to the coding agent.

The coding agent has a path of its own, separate from these three: the [`tracker_api` tool](/reference/agent-extensions/#tracker_api) performs a `transition_issue` the agent asked for, within the configured project scope.

Each write stays off until its field is configured. The third is the newest and needs `reactions.merge_completion.provider` on top of its target state; a deployment that does not configure it sees no terminal write from the orchestrator at all.

The handoff write carries one extra guard, because it is the write most likely to race a person. If you close or cancel an issue while its final turn is still finishing, the handoff write would otherwise overwrite your decision with `handoff_state`. So the exit path tests the issue against `terminal_states` using the freshest observation it has, preferring one made by reconciliation, then one made by the worker's own per-turn refresh, then the state recorded at dispatch. A terminal observation suppresses the write, releases the claim, and cancels any pending retry. Because that observation can itself go stale while the worker tears down, Sortie performs one more state read immediately before the write and applies the same test. If that read fails, the write proceeds: an unreachable tracker is not evidence that the issue is closed. The read is skipped entirely when `terminal_states` is empty, since with no terminal state configured no value could classify as one and the call would cost a tracker request without ever suppressing anything. Only a terminal state suppresses. Any other state, including `handoff_state` itself when the agent already applied it through the `tracker_api` tool, leaves the write and everything downstream of it unchanged.

### Handoff evidence

The handoff write is subject to one further condition beyond the four in the table above: the run's handoff-evidence verdict, governed by [`tracker.handoff_evidence`](/reference/workflow-config/#tracker) (default `observed`). Sortie inspects the workspace the run used and returns one of three verdicts: work was observed, absence of work was observed, or evidence was not determinable. Work observed never withholds the write. Absence observed always withholds it, unless the policy is `off`. Not determinable withholds it only under `strict`.

| Policy | Work observed | Absence observed | Not determinable |
|---|---|---|---|
| `observed` (default) | Handoff proceeds | Withheld | Handoff proceeds |
| `strict` | Handoff proceeds | Withheld | Withheld |
| `off` | No verdict is computed; the four conditions above stand | n/a | n/a |

The default withholds only on a positively observed absence and abstains everywhere it cannot measure the workspace, the case a workspace that is not a Git work tree produces. A deployment whose workspaces are never version-controlled trees sees no behavioral change under the default and configures nothing. `strict` has no partial form: in such a deployment it withholds every transition and stops the pipeline, which is the operator's own choice to make.

One legitimate configuration is misread by the default. A primary dispatch whose entire product is a write to the tracker presents a measurable workspace and no movement in it, so it reads as an absence. A write made through the [`tracker_api` tool](/reference/agent-extensions/#tracker_api) goes straight to the tracker, not to the workspace, so it is invisible to the inspection above and cannot rescue the case. That is the case `off` exists for.

The verdict describes what survived the run, not whether the agent acted: it can withhold a handoff write and it can never cause one, and it cannot see work that was produced and then reverted.

A verdict that withholds the handoff is checked against the tracker once before it takes effect, the same guard the handoff write itself carries. Immediately before recording anything, Sortie reads the issue's state and tests it against `terminal_states`. A terminal result discards the verdict and routes the exit into the terminal disposition instead: the claim is released, any pending retry is cancelled, no failed run is recorded, no failure comment is posted, no retry is scheduled, and the consecutive-absence count does not advance. Any other state leaves the withheld outcome exactly as it was, and so does a read that fails, because an unreachable tracker is not evidence that the issue is closed. Like the write path's read, this one is skipped entirely when `terminal_states` is empty, since no value could then classify as terminal. It is what keeps Sortie from reporting a failure and promising a retry on an issue that finished during the run - through the agent's own [`tracker_api` tool](/reference/agent-extensions/#tracker_api), through an `after_run` hook, or through a person moving it.

A withheld handoff that survives that check records the run as failed, naming the verdict as the reason, even though the agent process exited normally.

This bears on what a recorded run status of `succeeded` asserts on the handoff path. It means the worker exited without error and the evidence policy did not withhold the transition, or withheld it and the read above then found the issue terminal. It does not assert that work was positively observed: an undeterminable verdict under `observed`, every normal exit under `off`, and a withheld verdict discarded by that read all record `succeeded` - and so does a [no-change declaration](#declaring-that-nothing-needed-changing) that stood, which asserts a claim the agent made and self-review checked where enabled, not a positive workspace observation. Rows written before the evidence policy took effect keep the older exit-kind-only meaning and are not rewritten, so a success rate computed across the whole history spans three definitions of `succeeded` rather than one.

### Declaring that nothing needed changing

A run can also state the verdict directly instead of leaving it to the workspace inspection above. Writing `no-change-needed` to [`.sortie/status`](/reference/agent-extensions/#sortiestatus-file-protocol) declares that the requested outcome already held and the agent changed nothing. The declaration is admitted to the [self-review phase](/guides/configure-self-review/) on the same terms as `needs-human-review`. If that phase does not confirm it - anything other than exactly one iteration ending on a `pass` verdict, with no failing verification result - the declaration is retracted and the run falls back to the ordinary evidence-based verdict above, as if it had made no declaration. On a deployment with self-review disabled, no such check runs and the declaration stands unverified.

A declaration that stands always yields work observed, ahead of and bypassing the workspace inspection above entirely: it cannot be withheld and cannot be undeterminable. Under `observed` and `strict`, it resets the consecutive-absence count and releases a park held for consecutive absences. Under `off`, no verdict is computed and neither the reset nor the park release happens; resolving the transition target is the declaration's only effect there. In every case, including `off`, the target is `tracker.no_change_state` where that field is configured, falling back to `tracker.handoff_state` otherwise; see [the `tracker.no_change_state` field](/reference/workflow-config/#tracker). Where no handoff path applies - the dispatch does not drive issue state, or `tracker.handoff_state` is unset - the declaration changes no issue state.

A run that produces nothing and declares nothing keeps the ordinary absence outcome above in full: handoff withheld, failure recorded, consecutive-absence count advanced. An undeterminable run that declares nothing keeps its policy-dependent outcome: proceeds under `observed`, withheld under `strict`. A terminal state observed at exit is not a declaration and is tested first, so a declaration on an already-terminal issue changes nothing.

A continuation turn dispatched by a reaction runs as an ordinary agent session and so performs the same in-progress and handoff writes, while a session dispatched by a label command performs neither.

---

## Transition triggers

These events drive state transitions. Each is handled by the orchestrator's single-writer event loop, which serves exactly one at a time.

| Trigger | What happens |
|---|---|
| **Poll tick** | In this order: run preflight validation, which forces a defensive workflow reload, and apply the resulting config to runtime state whether or not it passed; [reconcile](#reconciliation) running issues; run the periodic workspace sweep when it is due. Dispatch is the only step gated on preflight success - a failed preflight returns here. Then fetch candidates, sort them, rebuild the budget-exhausted and parked sets from the candidate list, and dispatch eligible issues until slots are exhausted. Dispatched workers perform the optional in-progress transition (via `tracker.in_progress_state`) and optional dispatch comment (via `tracker.comments.on_dispatch`) as their first steps. |
| **Worker exit (normal)** | Remove `running` entry. Persist run history to SQLite (a withheld handoff is recorded as `failed`, naming the verdict, unless its own verification read routed the exit into path 4 below). Update token totals. Six outcome paths: (1) no soft-stop, issue active, dispatch drives issue state -- schedule continuation retry or perform handoff transition (retry on handoff failure); (2) soft-stop `blocked` -- release claim, no handoff, no retry, and park the issue with the escalation label where the dispatch drives issue state; (3) soft-stop `needs-human-review`, or a `no-change-needed` declaration that stood through self-review -- perform handoff transition (if configured, issue active, and the dispatch drives issue state) to `tracker.handoff_state`, or to `tracker.no_change_state` for the declared case where that field is set, release claim (no retry on handoff failure); (4) issue already reported terminal -- no handoff, release claim, no retry, no reactions enqueued; (5) handoff eligible but withheld by the [evidence policy](#handoff-evidence), with the read that outcome performs finding no terminal state -- no handoff transition, exponential backoff retry, or the issue is parked once the consecutive-absence ceiling is reached; (6) none of the above, meaning the issue is no longer in an active state -- cancel any pending retry and release the claim. Path 4 is tested ahead of paths 1, 3, and 5 and overrides them, and a withheld verdict whose own verification read reports a terminal state is routed into path 4 as well; path 5 is tested ahead of paths 1 and 3 and overrides them, except a `no-change-needed` declaration that stood, whose verdict is always work observed and so is never diverted into path 5; path 2 is tested first of all; path 6 is the fallthrough and is tested last. Post completion comment if [`tracker.comments.on_completion`](/reference/workflow-config/) is enabled (detached goroutine, non-blocking). |
| **Worker exit (error)** | Remove `running` entry. Persist run history. Classify error. If retryable, schedule exponential backoff retry, or defer to the queued entry when one already holds the retry slot. If not retryable, release claim. Post failure comment if [`tracker.comments.on_failure`](/reference/workflow-config/) is enabled (detached goroutine, non-blocking). |
| **Worker exit (cancelled)** | The worker's context was cancelled - by reconciliation, by stall detection, or by shutdown. Remove `running` entry. Persist run history. Release the claim only when no retry is already queued: a retry pre-scheduled by stall detection keeps the claim so nothing else can dispatch the issue. No handoff transition, no new retry. |
| **Agent update event** | Update live session fields: token counters, session ID, thread ID, agent PID, rate limits, last activity timestamp. |
| **Retry timer fired** | Read that one issue from the tracker by ID. If it is still eligible and slots are available, dispatch. If no slots, or the read fails, reschedule at the next attempt number. If the tracker reports the issue missing, terminal, or no longer active, release the claim and delete the persisted entry - except for a reaction-kind entry, which is rescheduled instead of released. Enforce the `agent.max_sessions` and `agent.max_tokens` budgets here: an exhausted budget releases the claim rather than dispatching. |
| **Reconciliation: tracker state refresh** | For each running issue: terminal state → cancel worker, clean workspace. Still active → update snapshot. Neither active nor terminal → cancel worker, no cleanup here; the [periodic sweep](#reconciliation) may still remove that workspace later on age. |
| **Reaction reconcile passes** | Part of the same poll tick, after the tracker state refresh. Eight reaction kinds each get one pass in a fixed order: CI failure, review comments, bot review, merge conflicts, auto-merge, review label command, fix label command, merge completion. A pass can dispatch a continuation session for the issue, which claims it exactly as a primary dispatch does. See the [reactions reference](/reference/reactions/) for what each pass observes. |
| **Reaction: managed PR observed as merged** | The merge-completion pass. When [`reactions.merge_completion`](/reference/workflow-config/#reactionsmerge_completion) is configured, transition the linked issue to the configured terminal state, once per merge commit. No workspace or source-control side effect. |
| **Refresh request** | `POST /api/v1/refresh` runs a full poll tick out of band, identical to a tick the timer fired. Discarded during shutdown drain. |
| **Self-review progress** | Marks the running entry as self-reviewing and records the iteration number, or clears both when the review loop ends. Live session bookkeeping only; no claim or retry transition. |

---

## Candidate eligibility

An issue is eligible for dispatch when all conditions are true:

| Condition | Details |
|---|---|
| Required fields present | `id`, `identifier`, `title`, and `state` must be non-empty. |
| State is active | `state` is in `tracker.active_states` (case-insensitive). |
| State is not terminal | `state` is not in `tracker.terminal_states`. |
| Not running | `id` is not in the `running` map. |
| Not claimed | `id` is not in the `claimed` set. |
| Not budget-exhausted | `id` is not in the budget-exhausted set, which the poll tick rebuilds from run history for `agent.max_sessions` and `agent.max_tokens`. |
| Not parked | `id` is not in the parked set. A park holds the issue until a later poll tick observes a release gesture. |
| Global slots available | `running_count < agent.max_concurrent_agents`. |
| Per-state slots available | Running count for this state < `agent.max_concurrent_agents_by_state[state]` (if configured). |
| No blocker is still active | Every entry in `blocked_by` has a non-empty state that is in `tracker.terminal_states`. An entry with an empty state, or a state outside `terminal_states`, holds the issue. |
| Blocker list is authoritative | The issue's `blocked_by` must be resolved, not merely absent of active blockers. On a tracker whose candidate fetch cannot carry blockers (currently GitHub and Gitea), each candidate's list is read separately, bounded by a small budget shared across the whole poll (see [blocker resolution](#blocker-resolution) below). A candidate whose read hasn't happened yet this poll, or whose read failed, is held rather than dispatched on an unread list. |

Issues are sorted for dispatch: priority ascending (nil last), `created_at` oldest first, `identifier` lexicographic tiebreaker.

### Blocker resolution

Jira and Linear return each issue's blockers together with the candidate list, so nothing extra is read. GitHub and Gitea do not: a candidate from either tracker is held until a separate per-issue read resolves its blocker list, and that read is bounded to four per poll, shared across every candidate that needs one. GitHub's candidate payload can prove an issue has zero dependencies without spending a read; Gitea's cannot, so every Gitea candidate needing resolution costs one. GitLab declares that it has no blocking relation to read at all, so its issues carry an authoritative empty list from the candidate fetch and are never held for this reason. See the [GitHub](/reference/adapter-github/#blocker-extraction) and [Gitea](/reference/adapter-gitea/#blocker-extraction) adapter references for the read cost and how a failed read is handled.

A held candidate is not silent: it logs one record and increments the `sortie_candidate_holds_total` counter with a `reason` label, one of:

| Reason | Meaning |
|---|---|
| `blocked_by` | At least one blocker has a non-terminal or unknown state. |
| `blockers_unresolved` | The blocker read for this candidate was attempted and failed, or this poll already gave up on further reads after an earlier failure. Retried on a later poll. |
| `blockers_not_read` | This poll's read budget was already spent on other candidates before reaching this one. Retried on a later poll. |
| `blockers_incomplete` | The candidate's producer marked the list unresolved and nothing was available to complete it. |

`sortie --dry-run` reports the same reason per candidate as `skip_reason` (see the [CLI reference](/reference/cli/#-dry-run)), and the [Prometheus metrics reference](/reference/prometheus-metrics/#counters) documents the counter in full.

---

## Backoff formula

Sortie uses two retry delay strategies depending on the exit type.

**Continuation retry** (normal worker exit, issue still active):

$$delay = 1000 \text{ ms}$$

**Error retry** (worker failure, stall timeout):

$$delay = \min(10000 \times 2^{(attempt - 1)},\ \text{max\_retry\_backoff\_ms})$$

Default `max_retry_backoff_ms`: 300 000 (5 minutes). Configurable via [`agent.max_retry_backoff_ms`](/reference/workflow-config/).

| Attempt | Delay |
|---|---|
| 1 | 10 s |
| 2 | 20 s |
| 3 | 40 s |
| 4 | 80 s |
| 5 | 160 s |
| 6+ | 300 s (cap) |

When a retry fires but no concurrency slot is available, the entry is rescheduled at the next attempt number - one backoff step longer, not a repeat of the same delay - with error `no available orchestrator slots`. A failed tracker read for the issue reschedules the same way.

---

## Reconciliation

Reconciliation runs at the start of every poll tick, before dispatch, as one fixed sequence.

**Part A - Overdue retry re-arm.** A retry timer event can be dropped when the retry timer channel is full. An entry whose `due_at` lags the current tick by more than 60 seconds is re-armed with a zero delay, so an undeliverable entry cannot hold the retry slot for the life of the process.

**Part B - Stall detection.** For each running issue, compute elapsed time since the last agent event (or `started_at` if no event has arrived). If elapsed exceeds [`agent.stall_timeout_ms`](/reference/workflow-config/), the worker is killed and an exponential backoff retry is scheduled. Disabled when `stall_timeout_ms` is zero or negative.

**Part C - Tracker state refresh.** Fetch current tracker states for all running issue IDs, and for every issue carrying a pending reaction.

| Tracker reports | Action |
|---|---|
| Terminal state | Cancel worker. Mark workspace for cleanup after worker exits. |
| Still active | Update the in-memory issue snapshot. Worker continues. |
| Neither active nor terminal | Cancel worker. No workspace cleanup here; the periodic sweep may remove that workspace later on age. |
| Fetch fails | Keep all workers running. Retry on next tick. |

**Part D - Reaction passes.** The eight reaction kinds each get one pass, in this order: CI failure, review comments, bot review, merge conflicts, auto-merge, review label command, fix label command, merge completion. The order is load-bearing in two places: merge-conflict detection runs before auto-merge so a fresh conflict is acted on before auto-merge re-confirms its deferral, and merge completion runs last so a merge performed earlier in the same tick is observed on the same pass. See the [reactions reference](/reference/reactions/) for what each pass does.

**Periodic workspace sweep.** Separately from the per-tick reconciliation above, a sweep runs once every 60 poll ticks and applies two grounds in one pass. The terminal check runs first: it asks the tracker for the state of every workspace key on disk that does not belong to in-flight work, and removes those reported terminal. Whatever it leaves is then evaluated against [`workspace.retention_days`](/reference/workflow-config/#workspace), an opt-in age bound that is off by default and needs no answer from the tracker, so it still removes on a pass where the tracker read failed.

---

## Recovery at startup

When Sortie starts (or restarts after a crash), it reconstructs orchestration state from SQLite and the tracker.

1. Open SQLite database and apply schema migrations.
2. Load persisted retry entries. Reconstruct retry timers from stored `due_at` timestamps. Each rehydrated entry marks its issue claimed, so the first poll tick cannot dispatch it a second time.
3. Load the cumulative token and runtime totals, and the park records that hold issues out of dispatch. A read failure for either is logged as a warning and startup continues with none.
4. Enumerate workspace directories on disk and map directory names to issue identifiers.
5. Query the tracker for the states of those identifiers and remove the workspace directories of issues reported terminal. Only keys whose state is both known and terminal are removed, so a workspace whose issue is missing from the response or sits in a non-active, non-terminal state survives the pass. No age-based removal runs at startup.
6. Rebuild the pending reaction set from recent run history, so a watch that was in flight when the process stopped is not lost. Runs whose recorded activity is older than the recovery lookback are skipped. A failure here is logged as a warning and startup continues.
7. Begin the normal poll loop. The first tick fires immediately, and it is that tick - not a separate recovery step - that reads the tracker's active issues and reconciles them with the restored state.

If the workspace listing or the terminal-state query fails at startup, Sortie logs a warning, cleans nothing on that pass, and continues. For an issue with no running worker, terminal cleanup then waits for the [periodic sweep](#reconciliation), which is also where the opt-in age bound in [`workspace.retention_days`](/reference/workflow-config/#workspace) applies.
