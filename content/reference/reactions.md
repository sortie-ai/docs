---
title: "Reactions"
description: "Sortie's reaction framework: the poll, deduplicate, dispatch, escalate lifecycle, and every reaction kind with its fields, defaults, and safety rules."
author: Sortie AI
date: 2026-05-27
weight: 75
url: /reference/reactions/
---
Reactions are feedback loops that respond to events on a Sortie-created pull request after the initial agent run hands off. Each reaction kind watches one external signal (failing CI, requested review changes, automated review-bot comments, a merge conflict against the PR's base branch, a mergeable approved PR, or a merged pull request) and responds in one of three ways: it dispatches a continuation turn so the agent can respond, or, for auto-merge, performs the merge directly, or, for merge-completion, transitions the linked tracker issue. Reactions are opt-in: a kind is inactive until its `provider` is set, and omitting the `reactions` block disables all of them.

See also: [workflow configuration reference](/reference/workflow-config/) for the `reactions` block and the `tracker.handoff_state` and `tracker.active_states` fields; [state machine reference](/reference/state-machine/) for claims, retries, and the reconcile tick that drives reaction processing; the [GitHub adapter reference](/reference/adapter-github/#scm-and-ci-surface), [Gitea adapter reference](/reference/adapter-gitea/#scm-and-ci-surface), and [GitLab adapter reference](/reference/adapter-gitlab/#scm-and-ci-surface) for the SCM provider, the token, and how each forge produces the normalized signals these reactions read; [how to configure CI feedback](/guides/configure-ci-feedback/) and [how to configure PR review feedback](/guides/configure-review-feedback/) for setup procedures; [label commands reference](/reference/label-commands/) for the operator-applied `sortie:review` and `sortie:fix` labels, which fire on a human gesture rather than a PR event and are documented separately from these event-driven reactions.

---

## Reaction kinds at a glance

| Kind              | Watches                                   | Action                         | Budget field (default)         | Runtime kind |
| ----------------- | ----------------------------------------- | ------------------------------ | ------------------------------ | ------------ |
| `ci_failure`      | CI status on the PR branch                | Dispatches a continuation turn | `max_retries` (`2`)            | `ci`         |
| `review_comments` | Review comments from human reviewers requesting changes | Dispatches a continuation turn | `max_continuation_turns` (`3`) | `review`     |
| `bot_review`      | Automated review-bot comments             | Dispatches a continuation turn | `max_continuation_turns` (`5`) | `bot-review` |
| `merge_conflicts` | PR mergeability against the base          | Dispatches a rebase-and-resolve continuation turn | `max_retries` (`1`) | `merge-conflict` |
| `auto_merge`      | Merge preconditions on an approved PR     | Merges the PR directly         | `max_retries` (`2`)            | `merge`      |
| `merge_completion` | Merge state of a managed PR              | Transitions the linked issue to a terminal state | `max_retries` (`2`) | `merge-completion` |

---

## Reaction lifecycle

Every reaction kind moves through the same pipeline. The orchestrator records a *pending reaction* for an issue when a worker exits normally and SCM metadata is available, and it reconstructs eligible pending reactions at startup so feedback survives a restart. On each reconcile tick, after tracker-state refresh, the orchestrator runs the pipeline for each pending reaction in a fixed order: CI failure first, then review comments, then bot review, then merge conflict, then auto-merge, and merge completion last.

1. **Poll.** The orchestrator queries the kind's provider for the current signal, throttled by the kind's `poll_interval_ms`. A transient fetch error re-enqueues the entry for the next tick.
2. **Fingerprint.** `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` hash their salient state into a SHA-256 fingerprint stored in the `reaction_fingerprints` SQLite table. The review fingerprint is the sorted set of non-outdated comment IDs; the bot-review fingerprint is the sorted set of non-outdated bot comment IDs under its own kind row; the merge-conflict fingerprint is the PR head SHA; the merge fingerprint is the PR head SHA combined with the review decision. `merge_completion` also occupies a row of its own, but stores the merge commit identifier reported by the forge verbatim rather than hashing anything. `ci_failure` occupies a row too, and like `merge_completion` stores its value verbatim rather than hashing it. What it stores is the pull request's head as resolved on that pass, never a recorded SHA and never a branch name.
3. **Deduplicate.** When the fingerprint matches the last value already marked dispatched, the tick takes no action. For the hashing kinds, a new push or a changed comment set produces a new fingerprint and clears the dispatched mark. `merge_completion` is the exception on the far side: its dispatched row is retained after the transition rather than cleared, so the same merge is never observed as new. `ci_failure` runs both mechanisms: the head fingerprint dedups a head that has already dispatched, and that fingerprint moves with the pull request, so a commit landing on the pull request re-arms the reaction. A `pending` status re-enqueues under backoff. A `passing` status clears the attempt counter, and the reaction keeps watching.
4. **Dispatch.** The reaction action runs. Where the kind carries a [`triage` block](#triage-command), an operator-owned command runs first and can close the subject or hand it to a person instead, in which case none of the actions in this step happen. For `ci_failure`, `review_comments`, `bot_review`, and `merge_conflicts` the orchestrator schedules a fix continuation turn, injecting the signal into the prompt through a continuation context variable. An issue holds at most one queued continuation at a time, so a kind that finds one already queued defers and re-checks on a later tick rather than replacing it; the queued work is never discarded, and the deferring kind takes none of the other actions in this step on that tick. For `auto_merge` the orchestrator calls `MergePR` directly, since no code change is needed. For `merge_completion` it calls the tracker transition directly, for the same reason. Each dispatch increments the per-issue, per-kind attempt counter and uses a fixed 1-second delay rather than exponential backoff.
5. **Escalate.** When the attempt counter reaches the kind's retry budget, and when a triage command answers `escalate`, the orchestrator applies the configured `escalation` action and clears that kind's pending state. `ci_failure` and `review_comments` release the claim on escalation and stop. `auto_merge`, `bot_review`, and `merge_conflicts` scope cleanup to their own kind and keep the claim.

```mermaid
flowchart TD
    EX[Normal worker exit] --> PE[Pending reaction recorded]
    PE --> PL{Poll provider}
    PL -->|signal not actionable| PL
    PL -->|actionable| FP{Fingerprint changed?}
    FP -->|no| PL
    FP -->|yes| BUD{Within retry budget?}
    BUD -->|yes| DI[Dispatch: continuation turn or merge]
    DI --> PL
    BUD -->|no| ES([Escalate])

    classDef start fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef action fill:#d1fae5,stroke:#059669,color:#064e3b,stroke-width:2px
    classDef terminal fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

    class EX,PE start
    class PL,FP,BUD decision
    class DI action
    class ES terminal
```

### Retry budgets

The attempt counter is tracked per issue and per kind. It resets when the issue leaves the running and retry maps, and `ci_failure` also resets it, while the entry keeps watching, when CI returns to `passing`. The budget field differs by kind: `ci_failure` and `auto_merge` use `max_retries` (default `2`), `review_comments` uses `max_continuation_turns` (default `3`) as its hard cap, and `bot_review` uses `max_continuation_turns` (default `5`) as its hard cap. `merge_conflicts` uses `max_retries` (default `1`), the lowest of the kinds, and its counter is episodic, resetting when the conflict clears. A budget of `0` escalates `ci_failure` and `merge_conflicts` on the first actionable signal with no fix attempt. `auto_merge` is the exception: its escalation check requires `max_retries` greater than zero, so a budget of `0` turns count-based escalation off entirely instead of making it immediate. Polling is bounded, for every kind, by `watch_window_ms`, a shared and configurable field: once it elapses, the orchestrator drops the entry and logs a warning instead of escalating, so the reaction goes silent with no tracker-visible signal. `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` default to thirty minutes, measured from the entry's creation. `ci_failure` defaults instead to twenty-four hours, measured from the last recorded head change rather than from entry creation. Every kind's value must be non-negative and must not exceed `9223372036854` (about 292 years); `0` removes the bound entirely, and where the bound does apply, the entry drops with the same silent warning and no escalation. An authentication-class or payload-class merge error still escalates `auto_merge` immediately regardless of the budget. To get near-immediate escalation on a failed merge, set `auto_merge.max_retries: 1`, the lowest budget its count-based check honors, which escalates after the first failed attempt.

A value that fails these bounds is not caught the same way for every kind. `reactions.ci_failure.watch_window_ms` is validated while `WORKFLOW.md` itself is loaded, so an out-of-range edit fails a dynamic reload outright: the previous configuration remains active, and the failure is logged. `watch_window_ms` for `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` is validated only when the orchestrator builds those reactions, which happens once at startup and is not repeated by a reload; an out-of-range edit to one of them is accepted by a reload with no error and simply has no effect, same as any other change to those blocks, until the next restart. At that restart, and in `sortie validate` run ahead of one, the same value fails construction and the process exits `1`.

`merge_completion` uses `max_retries` (default `2`) to bound retryable transition failures, and a budget of `0` escalates on the first failed transition rather than turning the count-based check off, which is what the same value does for `auto_merge`. Its pending entry carries no time-to-live at all. It is bounded instead by the issue leaving the configured handoff state, because a merge waits on human review for an unbounded time, and by a fixed 30-minute grace period that starts only once the forge reports the pull request merged without a merge commit identifier. `max_retries` does not bound that grace period.

A pending entry also keeps its issue's workspace from being swept, but only when the entry's kind carries an expiry. The five kinds that carry an expiry pin the workspace: `ci`, `review`, `bot-review`, `merge`, and `merge-conflict`. The kinds that carry no expiry do not pin: `label-review`, `label-fix`, and `merge-completion`. A kind that waits on a human gesture keeps its entry indefinitely, and an entry that never expires would exclude its workspace from every bound in the system. See the [`workspace` configuration](/reference/workflow-config/#workspace) for the age bound a pin defers.

### State eligibility

Reaction continuations dispatch even while the issue sits in the tracker's `handoff_state`, the state Sortie transitions to for human review after a successful run. This differs from fresh-work retries (stall recovery and transient agent errors), which dispatch only when the issue is in an `active_state`. An issue that has moved to any other state runs no further reactions. When the tracker reports the issue in a terminal state, that release is immediate rather than deferred to the next retry: on the reconcile tick that observes it, every pending reaction entry and every attempt counter for that issue is dropped, its pending retry is cancelled, and its claim is released. This happens whether or not a worker is still running for the issue, so the two label-command kinds, which carry no expiry, stop polling the pull request's label journal as soon as the issue closes instead of continuing for the life of the process, and the issue is available for a fresh dispatch the moment it is reopened into an active state. Fingerprint rows are not deleted by this path. See the [state machine reference](/reference/state-machine/) for the claim and retry model.

### Cross-kind isolation

Each kind owns its own pending entry, fingerprint row, and attempt counter. A successful auto-merge, or escalation of any one kind, scopes its cleanup to that kind alone and leaves the other kinds' state on the same issue intact. Because `auto_merge`, `bot_review`, and `merge_conflicts` keep the claim through that scoped cleanup, each re-arms and can escalate again if its condition recurs, while `ci_failure` and `review_comments` release the claim and stop after the first escalation. `merge_completion` scopes its cleanup the same way and keeps the claim: a transition or an escalation on it clears only its own pending entry and attempt counter, so the other kinds' state on that issue is untouched, and an escalation on any other kind leaves merge-completion tracking in place.

### Escalation actions

An escalation fires when a kind exhausts its budget, when a [triage command](#triage-command) answers `escalate`, and when `merge_completion` gives up on a merge whose commit identifier never arrives. The orchestrator applies one escalation action:

- `label` (default): adds `escalation_label` (default `needs-human`) to the tracker issue.
- `comment`: posts a plain-text tracker comment naming the PR, the attempt count, and the outstanding signal.

The action runs in a detached goroutine with a 30-second timeout. A failed escalation is logged and counted but does not block cleanup. CI escalation outcomes are recorded by the `sortie_ci_escalations_total` counter; see the [Prometheus metrics reference](/reference/prometheus-metrics/).

---

## Common fields

Every reaction kind shares these four fields.

| Field              | Type    | Default       | Description                                                                                     |
| ------------------ | ------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `provider`         | string  | _(required)_  | SCM or CI adapter kind that activates the reaction: `github`, `gitea`, or `gitlab`. Must match a registered adapter. Absent or empty disables the kind, and all other fields in the sub-object are ignored. |
| `max_retries`      | integer | `2`           | Fix continuation dispatches per issue before escalation. Must be non-negative.                  |
| `escalation`       | string  | `label`       | Action taken when the kind hands the subject to a person, either because the budget is spent or because a [triage command](#triage-command) answered `escalate`. One of `label` or `comment`. |
| `escalation_label` | string  | `needs-human` | Label applied to the tracker issue when `escalation` is `label`.                                |

Keys other than these four are kind-specific and listed under each kind below.

> [!NOTE]
> Environment variable overrides for `reactions` fields are not supported. Reaction configuration comes from `WORKFLOW.md`, and it is captured once when the orchestrator starts. A dynamic reload does not rebuild it: changing any field of any kind, or adding or removing a kind's block, takes effect only on the next restart. The one exception is `ci_failure`, which is folded into the CI feedback configuration and re-read on every tick. Two of its fields sit outside that exception and still need a restart: `max_log_lines`, because the CI provider is built once at process start, and the `triage` block, which every kind that offers it freezes at construction.

---

## Triage command

`ci_failure`, `review_comments`, `bot_review`, and `merge_conflicts` accept an optional `triage` block. It names a command that runs in the issue workspace once the reaction has found a new subject and before the reaction dispatches a continuation turn for it. The command answers `handled`, `dispatch-agent`, or `escalate`, so work with a deterministic fix can be resolved without an agent session.

`auto_merge`, `merge_completion`, and `label_commands` do not accept the block. The first two dispatch no agent, so there is nothing for a pre-dispatch gate to gate, and the label commands carry no `escalation` field, so one of the three answers would have nothing to apply. A `triage` block under any of them, or under any other key of `reactions`, is a configuration error.

| Field        | Type    | Default   | Description                                                                                     |
| ------------ | ------- | --------- | ------------------------------------------------------------------------------------------------- |
| `script`     | string  | _(required)_ | Shell script body, run the same way a workspace hook is. Must be a non-blank string.          |
| `timeout_ms` | integer | `60000`   | Bounds one run. Must be between `1` and `600000`. The ceiling sits below the shortest default `watch_window_ms`, so an entry whose command hangs still ages out. |

Both fields are read once when the orchestrator starts, `ci_failure` included, so an edit to either takes effect on the next restart rather than on a dynamic reload.

```yaml
reactions:
  merge_conflicts:
    provider: github
    max_retries: 1
    escalation: label
    escalation_label: needs-human
    triage:
      script: |
        ./scripts/merge-conflict-triage.sh
      timeout_ms: 120000
```

### Execution environment

The command runs with the per-issue workspace directory as its working directory, through the same machinery as a [workspace hook](/guides/setup-workspace-hooks/): `sh -c` on POSIX and `cmd.exe /C` on Windows, the same restricted environment, the same process-group kill on timeout, and the same 8 KiB captured output tail. It receives the variables every hook receives and three of its own. See the [hook subprocess environment](/reference/environment/#hook-subprocess-environment) for the allowlist and the [triage command variables](/reference/environment/#reaction-triage-command-variables) for the three.

Sortie never creates the workspace directory for a triage run. A directory that is absent, or a path that is not a directory, ends the run before any subprocess starts, and the reaction dispatches exactly as it would with no block.

### Input document

`SORTIE_REACTION_INPUT` names a JSON file describing the subject. Both that file and the result file live in a temporary directory created for the run and removed when it returns, outside the workspace, so a stale answer from an earlier run cannot be read as this one's and externally authored text stays out of the tree the agent reads. Review comment bodies, check names, and branch names reach the command only inside this document, never through an environment variable or a shell word.

```json
{
  "schema_version": 1,
  "reaction_kind": "merge-conflict",
  "issue": { "id": "10432", "identifier": "MT-649", "display_id": "MT-649" },
  "attempt": 3,
  "workspace": "/var/sortie/workspaces/MT-649",
  "fingerprint": "9f2c7d1a4b6e08c3f5a2d9b7e14c6083a5d2f9b1c7e340a86d5b2f9c1e7a4308",
  "attempts_used": 0,
  "max_attempts": 1,
  "subject": {
    "pr_number": 128,
    "branch": "sortie/MT-649",
    "head_sha": "5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4",
    "base": "main"
  }
}
```

| Key              | Type    | Value                                                                                                  |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `schema_version` | integer | Version of this document's shape. `1` today. |
| `reaction_kind`  | string  | Runtime kind of the reaction that armed: `ci`, `review`, `bot-review`, or `merge-conflict`. Same value as `SORTIE_REACTION_KIND`. |
| `issue`          | object  | `id`, `identifier`, and `display_id` for the tracker issue. |
| `attempt`        | integer | The issue's run attempt number, the same value as `SORTIE_ATTEMPT`. |
| `workspace`      | string  | Absolute path to the per-issue workspace, the same value as `SORTIE_WORKSPACE`. |
| `fingerprint`    | string  | The value this kind stores for the current subject, as described under that kind above. |
| `attempts_used`  | integer | The kind's attempt counter for this issue at the moment the run starts. |
| `max_attempts`   | integer | The kind's budget field: `max_continuation_turns` for `review_comments` and `bot_review`, `max_retries` for `ci_failure` and `merge_conflicts`. |
| `subject`        | object or array | The same value the continuation prompt template receives for this kind, so the command sees what the agent would have seen. |

`subject` is the `.ci_failure` map for `ci`, an array of `.review_comments` maps for `review`, an array of `.bot_review_comments` maps for `bot-review`, and the `.merge_conflict` map for `merge-conflict`. Each is described under its kind above and in the [continuation context variables](/reference/workflow-config/#ci_failure).

### Result document

The command writes one JSON object to the path in `SORTIE_REACTION_RESULT`. The file does not exist when the command starts. Unknown keys are ignored, so a later field cannot break a script written today.

```json
{ "disposition": "handled" }
```

| Disposition      | Effect                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `handled`        | The command resolved the subject. Sortie marks the reaction fingerprint dispatched and keeps watching, spending no attempt, scheduling no continuation, and writing nothing to the tracker. |
| `dispatch-agent` | The reaction proceeds to the continuation turn it would have scheduled anyway. Every counter, fingerprint, and entry is left as it would have been with no `triage` block. |
| `escalate`       | Sortie applies the kind's configured `escalation` immediately, with no attempt spent. The `comment` action posts copy naming the triage command as the reason rather than an exhausted budget. |

A `handled` answer marks the subject dispatched in the same durable row the reaction's own deduplication uses, so the reaction takes no further action on it until the fingerprint moves. Within the episode, a pass that recomputes an already-answered fingerprint replays the stored answer instead of running the command again, and a replayed `escalate` posts no second escalation.

### Fallback to `dispatch-agent`

Exit status 0 together with a result file naming one of the three dispositions is the only path to an answer other than `dispatch-agent`. Every other outcome writes one warning record naming the reason and falls back to `dispatch-agent`:

- The workspace directory is absent, or the path is not a directory.
- The subprocess fails to start.
- The command exceeds `timeout_ms`.
- The command exits non-zero. A non-zero exit is never honored, even when the result file holds a valid answer.
- The result file is missing, larger than 64 KiB, unreadable, or not valid JSON.
- `disposition` holds a value other than the three above.

A broken script therefore costs one warning record and one agent turn. It cannot strand a reaction.

### Timing and concurrency

The command runs off the reconcile pass. The pass that starts it re-enqueues its entry and makes no further provider call for that subject, and a later pass reads the answer, so a reaction carrying a `triage` block acts no sooner than one of that kind's `poll_interval_ms` after the subject is first seen. For `ci_failure`, which has no `poll_interval_ms`, the wait is the pending backoff already in force.

Runs in flight are capped at `agent.max_concurrent_agents`, and never below `1`, across every issue and kind. The cap adds to agent concurrency rather than sharing slots with it, so a host configured for four agents can run four agent processes and four triage commands at once. An entry that finds the cap reached starts nothing and is reconsidered on the next tick. Unlike the `triage` block itself, the cap follows a reloaded `agent.max_concurrent_agents`.

A run is killed, with its whole process group, when `timeout_ms` elapses, when a pass computes a different fingerprint for the subject, when the episode the run belongs to ends, and when the process shuts down. In each of those cases a fresh run follows for the next subject Sortie sees, so the same command can be invoked more than once for work it has already done. Nothing about a triage run is written to the database: a run in flight at restart is lost, and the subject is triaged again from scratch.

`review_comments` and `bot_review` test their continuation-turn cap before the command runs, so a subject arriving on a spent budget escalates without invoking it. `ci_failure` and `merge_conflicts` test their retry budget after, so the command runs first and the budget escalation follows only on a `dispatch-agent` answer.

---

## Normalized mergeability states

`merge_conflicts` and `auto_merge` both gate on a normalized mergeability classification rather than on a forge field. Each SCM adapter maps its own platform's mergeability signal onto these five values, and the reaction machinery reads only the normalized result.

| State      | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `clean`    | Every required check passes and the pull request is ready to merge.                         |
| `unstable` | The pull request is mergeable, but some non-required checks are failing.                    |
| `blocked`  | A protection rule prevents the merge, such as a missing review, a stale base, or a draft.   |
| `dirty`    | The pull request has merge conflicts against its base.                                      |
| `unknown`  | No usable classification is available yet. Every consumer defers and re-reads on the next poll. |

No adapter is obliged to produce every state, and two of them do not. Which platform signal yields which state is documented per forge: [GitHub adapter reference](/reference/adapter-github/#mergeability), [Gitea adapter reference](/reference/adapter-gitea/#mergeability), and [GitLab adapter reference](/reference/adapter-gitlab/#mergeability).

| Provider | States it can report                               |
| -------- | -------------------------------------------------- |
| `github` | `clean`, `unstable`, `blocked`, `dirty`, `unknown` |
| `gitea`  | `clean`, `blocked`, `unknown`                      |
| `gitlab` | `clean`, `blocked`, `dirty`, `unknown`             |

Two consequences follow, each restated under the kind it affects. `merge_conflicts` arms on `dirty` alone, so it never arms on `gitea`. `auto_merge` proceeds on `clean` or `unstable`, so its `unstable` arm is reachable on `github` alone and the mergeability precondition is effectively `clean` on the other two.

---

## Reaction kinds

### `reactions.ci_failure`

Polls CI status for Sortie-created branches and dispatches a continuation turn when CI fails. This kind supersedes the deprecated top-level `ci_feedback` block; when both are present, `reactions.ci_failure` takes precedence and a deprecation warning is logged.

**Fields** (beyond the common fields):

| Field              | Type    | Default      | Description                                                       |
| ------------------ | ------- | ------------ | ----------------------------------------------------------------- |
| `max_log_lines`     | integer | `50`         | Maximum CI log tail lines injected into the prompt. `0` disables log injection. |
| `watch_window_ms`   | integer | `86400000`   | Milliseconds the watch keeps following a pull request since its last recorded head change (twenty-four hours by default). Must be non-negative and must not exceed `9223372036854` (about 292 years). `0` removes the bound. |

**Activation:** active when `provider` names a registered CI status provider and an SCM adapter is also configured. `provider` must match the provider named by every other active SCM reaction; a mismatch fails startup and is reported by `sortie validate` under the `reactions.scm_provider_conflict` check. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json` in the workspace; all four are required, and a workspace whose metadata names a branch but no pull request seeds no CI watch. The orchestrator resolves the pull request's head live through the SCM adapter on every due pass rather than reading a ref once when the pending entry is recorded.

**Behavior:** the reconcile loop resolves the pull request's current head live on every due tick, through the SCM adapter, and fetches CI status for that head; no ref is captured once and held for later polls. Two check conclusions are failing, `failure` and `timed_out`; a completed check that concludes `cancelled` withholds a passing verdict without asserting a failing one, holding the aggregate at pending rather than passing or failing. A `pending` status re-enqueues under capped exponential backoff. A `passing` status clears the attempt counter and the reaction keeps watching, so a commit pushed to the pull request afterward is still observed. A `failing` status increments the attempt counter and, while within `max_retries`, dispatches a continuation turn carrying the failing checks through the `.ci_failure` template variable. The watch ends on merge, on close without merging, when the pull request is not found on the forge, when the watch window elapses, or when the tracker issue enters a `tracker.terminal_states` state; a later normal worker exit for the same issue, or [startup recovery](/guides/resume-sessions-across-restarts/#what-happens-to-handoff-stage-prs) rebuilding the entry from the workspace metadata, begins a fresh watch. See the [`.ci_failure` template variable](/reference/workflow-config/#ci_failure) for its schema.

**Example:**

```yaml
reactions:
  ci_failure:
    provider: github
    max_retries: 2
    max_log_lines: 50
    watch_window_ms: 86400000   # optional; shown at its default (24h)
    escalation: label
    escalation_label: needs-human
```

### `reactions.review_comments`

Polls review comments left by human reviewers who have requested changes on Sortie-created PRs and dispatches a continuation turn so the agent can address the feedback. Each forge spells the changes-requested state differently, and each adapter selects against its own platform's spelling. This kind reads review state only; it does not create PRs, approve reviews, or resolve comments.

Bot-authored comments are excluded when the forge marks their author as a bot account. The `gitea` provider carries no such marker, so nothing is excluded there and a bot's changes-requested review reaches this kind alongside the human ones; see the [Gitea adapter reference](/reference/adapter-gitea/#bot-classification).

**Fields** (beyond the common fields):

| Field                    | Type    | Default  | Description                                                                                |
| ------------------------ | ------- | -------- | ------------------------------------------------------------------------------------------ |
| `poll_interval_ms`       | integer | `120000` | Minimum interval between review API polls per issue. Minimum: `30000`.                     |
| `debounce_ms`            | integer | `60000`  | Wait after the newest detected comment before dispatching. Must be non-negative.           |
| `max_continuation_turns` | integer | `3`      | Hard cap on review-triggered continuations per PR. Must be positive.                       |
| `watch_window_ms`        | integer | `1800000` | Milliseconds a pending entry is kept, measured from the entry's creation (thirty minutes by default). Must be non-negative and must not exceed `9223372036854` (about 292 years). `0` removes the bound. |

**Activation:** active when `provider` names a registered SCM adapter. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, and `repo` to `.sortie/scm.json` in the workspace. When any field is missing or zero, review polling is skipped for that workspace with no error.

**Behavior:** comments newer than `debounce_ms` defer dispatch until the reviewer's batch settles. The fingerprint is the SHA-256 of the sorted non-outdated comment IDs; a changed comment set triggers a new continuation, and an unchanged set is skipped. Dispatch injects the comments through the `.review_comments` template variable (a list of maps with keys `id`, `file`, `start_line`, `end_line`, `reviewer`, `body`). Escalation fires when the attempt counter reaches `max_continuation_turns`. See the [`.review_comments` template variable](/reference/workflow-config/#review_comments) for its schema.

**Example:**

```yaml
reactions:
  review_comments:
    provider: github
    max_retries: 2
    escalation: label
    escalation_label: needs-human
    poll_interval_ms: 120000
    debounce_ms: 60000
    max_continuation_turns: 3
```

### `reactions.bot_review`

Polls comments authored by automated review tools (linters, static analyzers, security scanners, and AI reviewers) on Sortie-created PRs and dispatches a continuation turn so the agent can address them. This is the complement of `review_comments`: that kind routes comments from human reviewers requesting changes and excludes bot-authored ones, while `bot_review` routes the bot-authored ones. The runtime and persisted kind value for this reaction is `bot-review`, not `bot_review`.

**Fields** (beyond the common fields):

| Field                    | Type            | Default   | Description                                                                                                                                                  |
| ------------------------ | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `poll_interval_ms`       | integer         | `60000`   | Minimum interval between bot-comment polls per issue. Minimum: `30000`. Tighter than `review_comments` (`120000`) because bot comments arrive in bulk right after a push rather than at reviewer pace. |
| `max_continuation_turns` | integer         | `5`       | Hard cap on bot-review continuations per PR. Must be positive. Higher than `review_comments` (`3`) because bot fixes are mechanical.                          |
| `bot_usernames`          | list of strings | _(empty)_ | Allowlist of bot logins, matched case-insensitively. Extends classification to review tools that comment under a regular user account. Empty by default, so only accounts the forge marks as bots match, and on `gitea` nothing matches. |
| `watch_window_ms`        | integer         | `1800000` | Milliseconds a pending entry is kept, measured from the entry's creation (thirty minutes by default). Must be non-negative and must not exceed `9223372036854` (about 292 years). `0` removes the bound. |

**Activation:** active when `provider` names a registered SCM adapter, on its own, with no other `reactions` block required. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json` in the workspace. When any field is missing or zero, bot-review polling is skipped for that workspace with no error.

**Classification:** bot authorship is deterministic author metadata, not comment content. A comment is selected when the forge marks its author as a bot account, or when its author login matches a `bot_usernames` entry (case-insensitive). No changes-requested review state is required, because review bots commonly post comment-only reviews. The `bot_usernames` allowlist covers review tools that comment under a regular user account rather than a bot account. Sortie ships no built-in list of such logins: an account that the forge does not mark as a bot matches only when it is named here.

> [!WARNING]
> On the `gitea` provider, `bot_usernames` is the only classification signal there is. Gitea accounts carry no bot marker, so an empty allowlist selects nothing and this kind routes no comments at all. Name every bot account in `bot_usernames` to make it fire. `sortie validate` accepts the empty allowlist, because the shape is valid. See the [Gitea adapter reference](/reference/adapter-gitea/#bot-classification).

**No debounce:** bot comments dispatch on the tick they are detected. There is no `debounce_ms` field. This differs from `review_comments`, which waits out `debounce_ms` so a reviewer's batch settles; bot comments arrive in bulk on a push, so there is nothing to wait for.

**Fingerprint and dedup:** the fingerprint is the SHA-256 of the sorted non-outdated comment IDs, stored in `reaction_fingerprints` under a kind distinct from `review_comments`. A push that changes the bot comment-ID set produces a new fingerprint and re-triggers a continuation; an unchanged set that has already dispatched is skipped within the poll interval.

**Continuation context:** dispatch injects the comments through the `.bot_review_comments` template variable, a list of maps with keys `id`, `file`, `start_line`, `end_line`, `reviewer`, and `body`, where `reviewer` is the login of the bot that authored the comment. This is the same shape as `.review_comments`.

**Cross-kind isolation:** `bot_review` and `review_comments` never interfere on the same PR. Each owns its own pending entry, fingerprint row, and attempt counter.

**Escalation:** fires when the attempt counter reaches `max_continuation_turns`. The action is `label` (default) or `comment`, with `escalation_label` defaulting to `needs-human`. Cleanup is scoped to the `bot-review` kind and does not release the issue claim, so the reaction re-arms and can escalate again if bot comments recur on a long-lived PR. For that reason `escalation: comment` can accumulate repeated comments; prefer `label`. This differs from `ci_failure` and `review_comments`, whose escalation releases the claim and stops.

Bot-review checks and escalations are recorded by the `sortie_bot_review_checks_total{result}` and `sortie_bot_review_escalations_total{action}` counters when the HTTP server is enabled; see the [Prometheus metrics reference](/reference/prometheus-metrics/).

**Example:**

```yaml
reactions:
  bot_review:
    provider: github
    escalation: label
    escalation_label: needs-human
    poll_interval_ms: 60000
    max_continuation_turns: 5
    bot_usernames:            # only for review tools that comment under a user account, not a bot account
      - example-review-bot
```

### `reactions.merge_conflicts`

Polls the mergeability of open Sortie-managed PRs on every reconcile cycle. While a PR remains conflicted, the orchestrator dispatches one rebase-and-resolve continuation turn per distinct conflicting head commit, subject to the retry budget; re-observing the same head dispatches nothing further, and a return to no-conflict is not required between attempts. The turn runs on the existing workspace and carries the PR's real base branch, read live from the PR object on the tick, so the agent rebases the head branch onto the PR's current target rather than an assumed default branch. The WORKFLOW.md key is `merge_conflicts` (plural); the runtime and persisted kind value is `merge-conflict` (singular, hyphenated); and the continuation context variable is `.merge_conflict` (singular).

**Fields** (beyond the common fields):

| Field              | Type    | Default | Description                                                                |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------- |
| `poll_interval_ms` | integer | `60000` | Minimum interval between mergeability checks per issue. Minimum: `30000`.   |
| `watch_window_ms`  | integer | `1800000` | Milliseconds a pending entry is kept, measured from the entry's creation (thirty minutes by default). Must be non-negative and must not exceed `9223372036854` (about 292 years). `0` removes the bound. |

Two common fields take kind-specific defaults here. `max_retries` defaults to `1`, not the common `2`, because a conflict that survives one rebase is unlikely to clear on a retry. `max_retries: 0` does not disable the kind; it escalates on the first detected conflict with no rebase attempt. To disable merge-conflict handling, omit the `merge_conflicts` block.

**Activation:** active when `provider` names a registered SCM adapter, on its own, with no other `reactions` block required. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json` in the workspace. When any field is missing or zero, merge-conflict polling is skipped for that workspace with no error.

**Episodic retry:** the attempt counter is per episode. A resolved conflict (the PR returns to a non-conflicted state) resets the counter, so a later independent conflict opens a fresh episode and starts from zero rather than counting against the earlier budget. The default `max_retries` of `1` is the lowest of any kind for that reason.

**Detection:** conflict detection reads the [normalized mergeability state](#normalized-mergeability-states). Only `dirty` is a conflict and arms a rebase turn. `clean`, `unstable`, and `blocked` each close the episode and reset the counter, and `unknown` defers to the next tick, logging `merge conflict deferred: mergeability unknown`, while the provider finishes computing mergeability.

> [!WARNING]
> This kind never arms on the `gitea` provider. Gitea reports mergeability as a single boolean with no conflict value, so its adapter classifies a conflicted pull request as `unknown`, never `dirty`. The entry defers on every tick until `watch_window_ms` (thirty minutes by default) drops it with a warning and no escalation, so the operator gets no rebase turn and no tracker-visible signal. `sortie validate` accepts `provider: gitea` here, because the shape is valid. Resolve conflicts on Gitea manually, and see the [Gitea adapter reference](/reference/adapter-gitea/#mergeability).

**Fingerprint and dedup:** the fingerprint is the SHA-256 of the PR head SHA, stored in `reaction_fingerprints` under a kind distinct from the other reactions. One conflicted head dispatches exactly one rebase turn. After the agent rebases and pushes a new head, the new head yields a new fingerprint and re-arms a fresh attempt bounded by `max_retries`; when the conflict clears, the row is deleted, so the next conflict observation dispatches again.

**Continuation context:** dispatch injects the `.merge_conflict` template variable, a map with keys `pr_number`, `branch` (the PR head branch the agent rebases), `head_sha` (the latest commit SHA on the head), and `base` (the PR's real target branch, read live, the rebase target).

**Coexistence with auto-merge:** `merge_conflicts` and `auto_merge` run independently on the same PR. Auto-merge defers while the PR is conflicted, merge-conflict drives the resolution on a provider that reports `dirty`, and once the PR is clean and approved auto-merge proceeds.

**Cross-kind isolation:** merge-conflict detection runs independently of every other reaction kind. Each owns its own pending entry, fingerprint row, and attempt counter.

**Escalation:** fires when the episode's attempt count exceeds `max_retries`. The action is `label` (default) or `comment`, with `escalation_label` defaulting to `needs-human`. Cleanup is scoped to the `merge-conflict` kind, removing its pending entry, fingerprint, and attempt counter; it does not release the issue claim, and other reaction kinds on the same issue are preserved.

Merge-conflict checks and escalations are recorded by the `sortie_merge_conflict_checks_total{result}` and `sortie_merge_conflict_escalations_total{action}` counters when the HTTP server is enabled; see the [Prometheus metrics reference](/reference/prometheus-metrics/).

**Example:**

```yaml
reactions:
  merge_conflicts:
    provider: github
    max_retries: 1
    escalation: label
    escalation_label: needs-human
    poll_interval_ms: 60000
```

### `reactions.auto_merge`

Polls merge preconditions on Sortie-created PRs and merges directly through the SCM adapter once they hold. Auto-merge is off by default and activates only when `provider` is set. There is no separate `enabled` flag; the presence of `provider` is the activation key, matching the other reaction kinds. The runtime and persisted kind value for this reaction is `merge`, not `auto_merge`.

**Fields** (beyond the common fields):

| Field              | Type    | Default  | Description                                                                                          |
| ------------------ | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `strategy`         | string  | `squash` | Merge strategy. One of `merge`, `squash`, or `rebase`.                                               |
| `require_ci`       | boolean | `true`   | When `true`, every CI check must pass before the merge. When `false`, CI is advisory only.           |
| `delete_branch`    | boolean | `true`   | When `true`, the PR head branch is deleted after a successful merge. A delete failure does not roll back the merge. |
| `poll_interval_ms` | integer | `60000`  | Minimum interval between precondition checks per issue. Minimum: `30000`.                            |
| `watch_window_ms`  | integer | `1800000` | Milliseconds a pending entry is kept, measured from the entry's creation (thirty minutes by default). Must be non-negative and must not exceed `9223372036854` (about 292 years). `0` removes the bound. |

**Activation:** active when `provider` names a registered SCM adapter. The agent or an `after_run` hook must write `pr_number`, `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json`. `provider` must match the provider named by every other active SCM reaction; a mismatch or an unknown provider fails startup, and `sortie validate` reports the mismatch offline under the `reactions.scm_provider_conflict` check. At startup the orchestrator runs a one-shot token-scope preflight through the SCM adapter, asking whether the credential can reach the merge endpoint and, when `delete_branch` is `true`, the branch-delete endpoint. The scope names and how much an adapter can verify differ by forge; see the [GitHub adapter reference](/reference/adapter-github/), the [Gitea adapter reference](/reference/adapter-gitea/#token-scope-for-merge-and-branch-operations), and the [GitLab adapter reference](/reference/adapter-gitlab/#token-scope-for-the-write-path). An auth-class scope failure disables auto-merge for the process lifetime; a transport-class failure schedules one retry on the next tick before disabling. An adapter that cannot read the credential's scopes fails open, so auto-merge proceeds and a real gap surfaces instead as an auth failure on the first merge attempt.

**Merge preconditions:** the orchestrator merges only when all of the following hold. While any is unmet, the entry re-enqueues at the poll interval.

| Precondition   | Requirement for merge                                                              |
| -------------- | ---------------------------------------------------------------------------------- |
| Ownership      | The PR is Sortie-created, identified by `.sortie/scm.json`.                         |
| Draft state    | The PR is not a draft.                                                              |
| Mergeability   | The [normalized mergeability state](#normalized-mergeability-states) is `clean` or `unstable`. |
| Review         | The review decision is `APPROVED`, or reviews are not required (`NOT_REQUIRED`).    |
| CI             | The CI conclusion is `success` when `require_ci` is `true`; ignored when `false`.   |

The `unstable` arm of the mergeability precondition is reachable on `github` alone. Neither `gitea` nor `gitlab` ever reports `unstable`, so on those two providers this precondition is effectively `clean`. The arm also does not decide the merge on its own: the CI precondition is evaluated separately from mergeability, so `require_ci: true` can still hold a merge that `unstable` let past. An `unknown` state defers the entry rather than failing it, and on `gitea` that is where a merge conflict lands as well.

**Behavior:** the merge fingerprint is the SHA-256 of the PR head SHA combined with the review decision, so a new push or a change in review decision allows a fresh attempt. `MergePR` is called with the expected head SHA to close the time-of-check to time-of-use window between the precondition read and the merge. A rejection from the merge endpoint sends the adapter back to re-read the pull request, and only a re-read confirming the pull request merged is dispatched as success. No adapter matches the provider's rejection wording, so a reworded response does not change the outcome. Escalation fires when the attempt counter reaches `max_retries`, but only when `max_retries` is greater than zero: a `max_retries` of `0` disables the count-based check instead of making it immediate. The pending reaction still expires after `watch_window_ms` (thirty minutes by default, measured from the entry's creation, configurable up to `9223372036854` milliseconds or removed with `0`); when it does, the orchestrator drops the entry and logs a warning rather than escalating, so the reaction goes silent with no tracker-visible signal. An authentication-class or payload-class merge error still escalates immediately regardless of the budget.

**Safety:** auto-merge acts on Sortie-created PRs only and never merges a draft. The merge is performed directly rather than through an agent turn.

> [!WARNING]
> A merge is irreversible. Sortie does not roll back on tail-step failures such as branch deletion or the confirmation comment. Auto-merge stays off unless `reactions.auto_merge.provider` is set, and enabling it is a conscious opt-in.

**Example** (conservative opt-in):

```yaml
reactions:
  review_comments:
    provider: github          # SCM provider; must match auto_merge below
  auto_merge:
    provider: github          # activates auto-merge; no separate "enabled" flag
    strategy: squash          # squash | merge | rebase
    require_ci: true          # never merge on failing or pending CI
    delete_branch: true       # remove the head branch after a successful merge
    max_retries: 2            # merge attempts before escalation
    escalation: comment       # post a tracker comment when attempts are exhausted
    poll_interval_ms: 60000   # 60s between precondition checks
```

### `reactions.merge_completion`

Observes the merge state of Sortie-managed pull requests and transitions the linked tracker issue to a single configured terminal state, exactly once per merge. It is the only reaction kind whose action is a tracker write: it never calls an SCM write method, never merges or pushes anything, and never dispatches a continuation turn. It is off by default and activates on `provider` alone, so a deployment that omits the block behaves exactly as it did before. The runtime and persisted kind value for this reaction is `merge-completion`, distinct from `merge` (auto-merge) and `merge-conflict`.

**Fields** (beyond the common fields):

| Field              | Type    | Default      | Description                                                                                          |
| ------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `target_state`     | string  | _(required)_ | The single terminal state the linked issue moves to once its pull request merges. It has no default and is never inferred from `tracker.terminal_states`. |
| `poll_interval_ms` | integer | `60000`      | Minimum interval between merge-observation polls per issue. Minimum: `30000`. A lower value is rejected, not clamped. |

One common field behaves differently here. `max_retries` keeps its default of `2` and bounds retryable transition failures, but `max_retries: 0` escalates on the first failed transition rather than turning the count-based check off, which is what the same value does for `auto_merge`. `escalation` and `escalation_label` carry their usual defaults.

**Tracker prerequisites:** two `tracker` fields must be set whenever this block is active, each reported as its own configuration error when it is missing. `tracker.handoff_state` must be non-empty: it is the state a merge waits in, and the reaction stops re-enqueueing an entry once the issue leaves it. `tracker.terminal_states` must be written out in front matter rather than left to the tracker adapter's default list, because the reconcile pass reads the list exactly as configured with no fallback; a defaulted list would let the validator accept a `target_state` the runtime never treats as terminal.

**Activation:** active when `provider` names a registered SCM adapter, on its own, with no other `reactions` block required. `provider` must match the provider named by every other active SCM reaction; a mismatch is reported by `sortie validate` under the `reactions.scm_provider_conflict` check. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, and `repo` to `.sortie/scm.json` in the workspace. Unlike the checkout-bearing kinds, no `branch` is required, because this reaction performs no checkout and reads no branch.

**Any merge, by anyone:** the pass reads the pull request live from the forge on every due tick and acts on the forge's own merged flag. It consults no record of a merge Sortie performed, and it does not require `reactions.auto_merge` to be configured. A merge performed by a person in the forge UI, by a forge automation rule, or by Sortie's own auto-merge all reach the same transition. The pending entry carries only the pull request number, the owner, and the repository; the merge commit is observed live rather than taken from a value stored when the entry was created. On GitHub that identifier is read through the GraphQL API, so the configured token must be able to reach it; see the [GitHub adapter reference](/reference/adapter-github/#merge-commit-identifier).

**Target-state rule:** the issue moves to the state named by `target_state`, applied verbatim. The target is never derived from `tracker.terminal_states`, because a terminal list routinely mixes a completion state with one or more abandonment states, and neither the ordering nor the vocabulary carries a guaranteed meaning. Three rules constrain the value, all compared case-insensitively and evaluated in this order:

1. It must not equal `tracker.handoff_state`.
2. It must not be a member of `tracker.active_states`, falling back to the tracker adapter's default active list only when `tracker.active_states` is itself empty.
3. It must be a member of `tracker.terminal_states` as written, with no fallback to the adapter's default terminal list.

The order decides what you are told: a value that is both the handoff state and non-terminal is reported against the first rule, not the third. All three are configuration-shape checks that need no network access, so `sortie validate` reports them offline under the check name `reactions.merge_completion`, at `error` severity, which fails validation and exits non-zero.

No validator catches the mistake that matters most. Naming an abandonment state where a completion state was meant is valid configuration and closes finished work under the wrong label. That is a judgement about the issue rather than a configuration shape, and the orchestrator does not reverse the transition.

**Idempotency latch:** the fingerprint row for this kind, keyed by the issue and the kind `merge-completion` in the `reaction_fingerprints` table, holds the merge commit identifier reported by the provider, not the pull request number. A pull request reported as merged with no commit identifier never latches this row, and no sentinel, pull request number, or branch is written in its place; that condition is bounded on its own clock, described next. Before transitioning, the pass writes the observed commit into the row; when the stored value already equals the observed one and is marked dispatched, the transition is skipped, which dedups the same merge across repeated poll ticks and across a process restart between them. A different commit identifier, meaning the issue produced a second managed merge, re-arms the latch for exactly one further transition. On a successful transition the row is marked dispatched and retained, never deleted, because deleting it would let the next tick observe the same merge as new. That is the opposite of what the sibling kinds do with their fingerprint rows.

**Merge reported with no commit identifier:** a forge that reports the pull request merged while supplying no merge commit identifier does not latch the row above, and the entry that observes it is not polled indefinitely. The first tick that sees this condition on a given pull request starts a fixed 30-minute grace period, which is not configurable and which `max_retries` does not bound. The condition is recorded as a second row in `reaction_fingerprints`, under the kind `merge-completion-missing-sha`, holding the normalized `owner/repo#number` identity and the time that identity was first seen in this state. Re-seeing the same pull request preserves both values; a different pull request replaces them and starts a fresh observation. During the grace period the entry re-enqueues under exponential backoff floored at `poll_interval_ms`, and each tick logs a warning naming the repository, the pull request, how long it has waited, and the grace period it is waiting against. The row is persisted, so a restart does not restart the clock.

Expiry is evaluated on the first tick at or after the deadline. If a real identifier arrives before then, the normal latch and transition run unchanged, and the observation row is cleared once that transition is latched. If the identifier is still absent, the pending entry is dropped, the permanent stop is logged at `error` level, and the configured escalation is applied. No transition is attempted and no merge fingerprint is written for this condition, so the issue stays in the handoff state until a person moves it. The `comment` posture names the repository, the pull request, the elapsed wait, the reason, and the configured target state; the `label` posture adds `escalation_label` instead, and the stop log carries the same identifying and manual-action context under either posture.

Delivery is recorded only after both the tracker write and the follow-up write that marks it delivered succeed, and the two share one 30-second deadline. A failure in either leaves the observation recorded as undelivered, and neither failure reopens the stopped entry: a later pending entry for the same issue, from a subsequent worker exit or from startup recovery, retries delivery once and stops again without restarting the grace period or the polling loop. When only the marker write failed, the notification already reached the tracker, so that retry delivers a second time. `label` repeats harmlessly, because re-applying a present label is a no-op; `comment` posts a duplicate comment. Once delivery is marked, a later entry stops without repeating the signal. The observation row is also cleared whenever the issue is missing from the tracker's state response, is already terminal, or has left the handoff state, and when the pull request is gone from the forge.

**No expiry:** the pending entry carries no time-to-live. `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` each bound their entry with `watch_window_ms`, defaulting to thirty minutes, and `ci_failure` bounds its own with the same field, defaulting instead to twenty-four hours, because each waits on a signal that either arrives shortly after the agent finishes or does not arrive at all. A merge waits on human review for an unbounded time, so this kind takes the same posture as the label commands and carries no expiry. The entry is bounded another way: it stops being re-enqueued once the issue leaves the configured handoff state, and it is dropped outright when the issue is already terminal, when the issue is missing from the tracker's state response, or when the pull request is gone from the forge. One post-merge condition carries a clock of its own: a pull request reported merged with no commit identifier stops the entry after 30 minutes, as described above.

**Failure matrix:** a failed transition is routed to one of four dispositions.

| Transition outcome                                        | Posture                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Transport failure, API failure, or an unclassified error   | Retry with backoff, bounded by `max_retries`, then escalate. An unclassified error routes here, the non-destructive default. |
| Authentication failure                                     | Escalate immediately, no retry.                                                              |
| Payload failure, such as a target state the tracker will not accept | Escalate immediately, no retry.                                                     |
| Issue not found                                            | Stop. Mark the latch dispatched, drop the entry, and log a warning, with no escalation, because no issue is left for a later attempt to reach. |

The retry bound is a strict over-limit comparison against a per-issue counter scoped to this kind. The counter is incremented after every transition call regardless of outcome, so the attempt count an operator reads in a `comment` escalation is truthful even on the two paths that escalate immediately.

**Escalation:** the two postures are the ones the sibling kinds already use. `label` (default) adds `escalation_label` (default `needs-human`) to the tracker issue. `comment` posts a plain-text comment naming the number of attempts, the target state, the pull request number, and the repository. The same two postures serve the missing-identifier stop above, where the comment names the elapsed wait and the manual follow-up rather than an attempt count. Both run in a detached goroutine with a 30-second timeout, so a slow tracker does not block the reconcile tick, and an escalation that itself fails is logged without reopening the entry. On any escalation the pending entry and the attempt counter are cleared while the fingerprint row is deliberately left undispatched. That residue works in your favor: a later reconcile of the same merge commit, driven by a fresh pending entry from a subsequent worker exit, retries the transition instead of treating the escalated attempt as final.

**Restart to apply:** this block, `target_state` included, is captured once when the orchestrator is constructed and is not rebuilt on a dynamic reload. A change to any field here, or to either tracker prerequisite, takes effect only on the next restart. `sortie validate` runs the same construction path, so its offline verdict cannot diverge from what a restart would build. If `tracker.terminal_states` is edited while the process runs so that the captured `target_state` is no longer a member of it, the reaction logs one warning naming both values, suppresses repeats while the condition persists, and keeps transitioning issues to the frozen target; the terminal workspace sweep meanwhile stops collecting the workspaces of the issues this reaction closes, until the two agree again. A restart rejects that same configuration offline before the process starts.

**Request cost:** each parked issue costs one tracker issue-state read and one pull-request read per poll interval, plus one tracker write per observed merge. Tracker state is fetched for all due entries in one batched call per tick, not one call per issue. On a forge tracker the tracker and the SCM adapter share one credential against one host, so the steady-state cost approaches two requests per parked issue per poll interval. A deployment with many simultaneously parked issues should raise `poll_interval_ms` above the default rather than accept it.

> [!WARNING]
> The transition is irreversible by the orchestrator, and enabling this block grants the tracker credential write authority it did not need before: on the forges, moving an issue to a terminal state closes the native issue. Nothing checks that authority in advance. There is no startup scope preflight and no validator check for it, so an insufficient scope surfaces only at runtime, as an authentication failure on the first transition attempt, which escalates immediately.

**Example:**

```yaml
reactions:
  merge_completion:
    provider: github          # activates the kind; must match other active SCM reactions
    target_state: done        # required; a member of tracker.terminal_states
    poll_interval_ms: 60000   # 60s between merge-state polls; minimum 30000
    max_retries: 2            # retryable transition attempts before escalation
    escalation: label         # "label" or "comment"
    escalation_label: needs-human
```

**Scope boundary:** a pull request closed without merging leaves the issue in the handoff state, and an issue with no managed pull request leaves the issue in the handoff state. This reaction closes neither, and promises nothing about either.

---

## Validation rules

Rules marked **startup only** are not reachable by `sortie validate`. They are enforced when the orchestrator builds the reaction at startup, so a workflow that breaks one passes validation cleanly and the process exits `1` on the first run.

- Reaction kind keys must match `[a-z][a-z0-9_-]*`. Invalid keys are rejected with a configuration error.
- `max_retries` must be non-negative for all kinds.
- `watch_window_ms` must be non-negative and must not exceed `9223372036854` (about 292 years) for `ci_failure`, `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge`.
- `escalation` must be `label` or `comment` for all kinds.
- `poll_interval_ms` must be at least `30000` for `review_comments`. **Startup only.**
- `poll_interval_ms` must be at least `30000` for `auto_merge`.
- `debounce_ms` must be non-negative, and `max_continuation_turns` must be positive, for `review_comments`. **Startup only.**
- `poll_interval_ms` must be at least `30000` for `bot_review`.
- `max_continuation_turns` must be positive for `bot_review`.
- `bot_usernames` must be a list of strings for `bot_review`.
- `poll_interval_ms` must be at least `30000` for `merge_conflicts`. **Startup only.**
- `strategy` for `auto_merge` must be `merge`, `squash`, or `rebase`.
- `triage` is accepted only under `ci_failure`, `review_comments`, `bot_review`, and `merge_conflicts`. Under any other key of `reactions`, including `auto_merge`, `merge_completion`, and `label_commands`, it is rejected.
- `triage` must be a map, `triage.script` must be a string that is not blank after trimming, and `triage.timeout_ms` must be an integer between `1` and `600000`.
- `require_ci` and `delete_branch` for `auto_merge` must be boolean.
- Every active SCM reaction must declare the same `provider`. The set spans `ci_failure`, `review_comments`, `bot_review`, `merge_conflicts`, `auto_merge`, `merge_completion`, and the `label_commands` block, and any two of them naming different providers is reported under the `reactions.scm_provider_conflict` check.
- `poll_interval_ms` must be at least `30000` for `merge_completion`.
- `target_state` is required for `merge_completion`. Compared case-insensitively, it must not equal `tracker.handoff_state`, must not be a member of `tracker.active_states` (falling back to the tracker adapter's default active list only when `tracker.active_states` is itself empty), and must be a member of `tracker.terminal_states` as written, with no fallback to the adapter's default terminal list.
- `tracker.handoff_state` must be non-empty and `tracker.terminal_states` must be written out in front matter whenever `reactions.merge_completion.provider` is set. Each missing field is its own configuration error.

`sortie validate` reports every unmarked rule above offline, before dispatch, at `error` severity, which fails validation and exits non-zero. A startup-only rule surfaces instead as an `invalid review reaction config` or `invalid merge_conflicts reaction config` log line naming the offending field, and the process exits before its first poll. See the [CLI reference](/reference/cli/) for the `validate` subcommand.
