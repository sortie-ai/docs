---
title: "Reactions"
description: "Reference for Sortie's reaction framework: the shared poll, fingerprint, deduplicate, dispatch, and escalate lifecycle, plus the ci_failure, review_comments, bot_review, merge_conflicts, auto_merge, and merge_completion kinds with every field, default, and safety rule, including post-merge issue closure to a terminal state."
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
2. **Fingerprint.** `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` hash their salient state into a SHA-256 fingerprint stored in the `reaction_fingerprints` SQLite table. The review fingerprint is the sorted set of non-outdated comment IDs; the bot-review fingerprint is the sorted set of non-outdated bot comment IDs under its own kind row; the merge-conflict fingerprint is the PR head SHA; the merge fingerprint is the PR head SHA combined with the review decision. `merge_completion` also occupies a row of its own, but stores the merge commit identifier reported by the forge verbatim rather than hashing anything. `ci_failure` occupies a row too, and like `merge_completion` stores its value verbatim rather than hashing it. What it stores is the ref it resolves for the status check: the recorded commit SHA, or the branch name when no SHA was recorded.
3. **Deduplicate.** When the fingerprint matches the last value already marked dispatched, the tick takes no action. A new push or a changed comment set produces a new fingerprint and clears the dispatched mark. `merge_completion` is the exception on the far side: its dispatched row is retained after the transition rather than cleared, so the same merge is never observed as new. `ci_failure` runs both mechanisms: the ref fingerprint decides whether an entry has already been dispatched for that exact ref, so a push produces a new ref, clears the dispatched mark, and re-arms CI feedback. The status conclusion then decides whether a due entry dispatches at all, since a `pending` or `passing` conclusion takes no action, and a later `passing` result clears the issue's attempt counter.
4. **Dispatch.** The reaction action runs. For `ci_failure`, `review_comments`, `bot_review`, and `merge_conflicts` the orchestrator schedules a fix continuation turn, injecting the signal into the prompt through a continuation context variable. An issue holds at most one queued continuation at a time, so a kind that finds one already queued defers and re-checks on a later tick rather than replacing it; the queued work is never discarded, and the deferring kind takes none of the other actions in this step on that tick. For `auto_merge` the orchestrator calls `MergePR` directly, since no code change is needed. For `merge_completion` it calls the tracker transition directly, for the same reason. Each dispatch increments the per-issue, per-kind attempt counter and uses a fixed 1-second delay rather than exponential backoff.
5. **Escalate.** When the attempt counter reaches the kind's retry budget, the orchestrator applies the configured `escalation` action and clears that kind's pending state. `ci_failure` and `review_comments` release the claim on escalation and stop. `auto_merge`, `bot_review`, and `merge_conflicts` scope cleanup to their own kind and keep the claim.

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

The attempt counter is tracked per issue and per kind. It resets when the issue leaves the running and retry maps, and `ci_failure` also resets it when CI returns to `passing`. The budget field differs by kind: `ci_failure` and `auto_merge` use `max_retries` (default `2`), `review_comments` uses `max_continuation_turns` (default `3`) as its hard cap, and `bot_review` uses `max_continuation_turns` (default `5`) as its hard cap. `merge_conflicts` uses `max_retries` (default `1`), the lowest of the kinds, and its counter is episodic, resetting when the conflict clears. A budget of `0` escalates `ci_failure` and `merge_conflicts` on the first actionable signal with no fix attempt. `auto_merge` is the exception: its escalation check requires `max_retries` greater than zero, so a budget of `0` turns count-based escalation off entirely instead of making it immediate. Polling is still bounded, for `ci_failure`, `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge`, by the pending reaction's fixed 30-minute time-to-live, which is not configurable; once it elapses, the orchestrator drops the entry and logs a warning instead of escalating, so the reaction goes silent with no tracker-visible signal. An authentication-class or payload-class merge error still escalates `auto_merge` immediately regardless of the budget. To get near-immediate escalation on a failed merge, set `auto_merge.max_retries: 1`, the lowest budget its count-based check honors, which escalates after the first failed attempt.

`merge_completion` uses `max_retries` (default `2`) to bound retryable transition failures, and a budget of `0` escalates on the first failed transition rather than turning the count-based check off, which is what the same value does for `auto_merge`. Its pending entry carries no time-to-live at all. It is bounded instead by the issue leaving the configured handoff state, because a merge waits on human review for an unbounded time.

A pending entry also keeps its issue's workspace from being swept, but only when the entry's kind carries an expiry. The five kinds bounded by the 30-minute time-to-live pin the workspace: `ci`, `review`, `bot-review`, `merge`, and `merge-conflict`. The kinds that carry no expiry do not pin: `label-review`, `label-fix`, and `merge-completion`. A kind that waits on a human gesture keeps its entry indefinitely, and an entry that never expires would exclude its workspace from every bound in the system. See the [`workspace` configuration](/reference/workflow-config/#workspace) for the age bound a pin defers.

### State eligibility

Reaction continuations dispatch even while the issue sits in the tracker's `handoff_state`, the state Sortie transitions to for human review after a successful run. This differs from fresh-work retries (stall recovery and transient agent errors), which dispatch only when the issue is in an `active_state`. An issue that has moved to any other state runs no further reactions. When the tracker reports the issue in a terminal state, that release is immediate rather than deferred to the next retry: on the reconcile tick that observes it, every pending reaction entry and every attempt counter for that issue is dropped, its pending retry is cancelled, and its claim is released. This happens whether or not a worker is still running for the issue, so the two label-command kinds, which carry no expiry, stop polling the pull request's label journal as soon as the issue closes instead of continuing for the life of the process, and the issue is available for a fresh dispatch the moment it is reopened into an active state. Fingerprint rows are not deleted by this path. See the [state machine reference](/reference/state-machine/) for the claim and retry model.

### Cross-kind isolation

Each kind owns its own pending entry, fingerprint row, and attempt counter. A successful auto-merge, or escalation of any one kind, scopes its cleanup to that kind alone and leaves the other kinds' state on the same issue intact. Because `auto_merge`, `bot_review`, and `merge_conflicts` keep the claim through that scoped cleanup, each re-arms and can escalate again if its condition recurs, while `ci_failure` and `review_comments` release the claim and stop after the first escalation. `merge_completion` scopes its cleanup the same way and keeps the claim: a transition or an escalation on it clears only its own pending entry and attempt counter, so the other kinds' state on that issue is untouched, and an escalation on any other kind leaves merge-completion tracking in place.

### Escalation actions

When a kind exhausts its budget, the orchestrator applies one escalation action:

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
| `escalation`       | string  | `label`       | Action on budget exhaustion. One of `label` or `comment`.                                       |
| `escalation_label` | string  | `needs-human` | Label applied to the tracker issue when `escalation` is `label`.                                |

Keys other than these four are kind-specific and listed under each kind below.

> [!NOTE]
> Environment variable overrides for `reactions` fields are not supported. Reaction configuration comes from `WORKFLOW.md`, and it is captured once when the orchestrator starts. A dynamic reload does not rebuild it: changing any field of any kind, or adding or removing a kind's block, takes effect only on the next restart. The one exception is `ci_failure`, which is folded into the CI feedback configuration and re-read on every tick, so its fields do reload.

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

| Field           | Type    | Default | Description                                                       |
| --------------- | ------- | ------- | ----------------------------------------------------------------- |
| `max_log_lines` | integer | `50`    | Maximum CI log tail lines injected into the prompt. `0` disables log injection. |

**Activation:** active when `provider` names a registered CI status provider. The orchestrator reads the CI ref from `.sortie/scm.json` (SHA preferred, branch as fallback).

**Behavior:** the reconcile loop fetches CI status each tick. A `pending` or `passing` status re-enqueues with no dispatch; a `passing` status also clears the attempt counter. A `failing` status increments the attempt counter and, while within `max_retries`, dispatches a continuation turn carrying the failing checks through the `.ci_failure` template variable. See the [`.ci_failure` template variable](/reference/workflow-config/#ci_failure) for its schema.

**Example:**

```yaml
reactions:
  ci_failure:
    provider: github
    max_retries: 2
    max_log_lines: 50
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

Polls comments authored by automated review tools (linters, static analyzers, security scanners, and AI reviewers such as GitHub Copilot and CodeRabbit) on Sortie-created PRs and dispatches a continuation turn so the agent can address them. This is the complement of `review_comments`: that kind routes comments from human reviewers requesting changes and excludes bot-authored ones, while `bot_review` routes the bot-authored ones. The runtime and persisted kind value for this reaction is `bot-review`, not `bot_review`.

**Fields** (beyond the common fields):

| Field                    | Type            | Default   | Description                                                                                                                                                  |
| ------------------------ | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `poll_interval_ms`       | integer         | `60000`   | Minimum interval between bot-comment polls per issue. Minimum: `30000`. Tighter than `review_comments` (`120000`) because bot comments arrive in bulk right after a push rather than at reviewer pace. |
| `max_continuation_turns` | integer         | `5`       | Hard cap on bot-review continuations per PR. Must be positive. Higher than `review_comments` (`3`) because bot fixes are mechanical.                          |
| `bot_usernames`          | list of strings | _(empty)_ | Allowlist of bot logins, matched case-insensitively. Extends classification to review tools that comment under a regular user account. Empty by default, so only accounts the forge marks as bots match, and on `gitea` nothing matches. |

**Activation:** active when `provider` names a registered SCM adapter, on its own, with no other `reactions` block required. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json` in the workspace. When any field is missing or zero, bot-review polling is skipped for that workspace with no error.

**Classification:** bot authorship is deterministic author metadata, not comment content. A comment is selected when the forge marks its author as a bot account, or when its author login matches a `bot_usernames` entry (case-insensitive). No changes-requested review state is required, because review bots commonly post comment-only reviews. The `bot_usernames` allowlist covers review tools that comment under a regular user account rather than a bot account; Hound (`houndci-bot`) is the canonical example.

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
      - houndci-bot
```

### `reactions.merge_conflicts`

Polls the mergeability of open Sortie-managed PRs on every reconcile cycle and dispatches one rebase-and-resolve continuation turn when a PR transitions from no-conflict to conflict. The turn runs on the existing workspace and carries the PR's real base branch, read live from the PR object on the tick, so the agent rebases the head branch onto the PR's current target rather than an assumed default branch. The WORKFLOW.md key is `merge_conflicts` (plural); the runtime and persisted kind value is `merge-conflict` (singular, hyphenated); and the continuation context variable is `.merge_conflict` (singular).

**Fields** (beyond the common fields):

| Field              | Type    | Default | Description                                                                |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------- |
| `poll_interval_ms` | integer | `60000` | Minimum interval between mergeability checks per issue. Minimum: `30000`.   |

Two common fields take kind-specific defaults here. `max_retries` defaults to `1`, not the common `2`, because a conflict that survives one rebase is unlikely to clear on a retry. `max_retries: 0` does not disable the kind; it escalates on the first detected conflict with no rebase attempt. To disable merge-conflict handling, omit the `merge_conflicts` block.

**Activation:** active when `provider` names a registered SCM adapter, on its own, with no other `reactions` block required. The agent or an `after_run` hook must write `pr_number` (positive integer), `owner`, `repo`, and `branch` (all non-empty) to `.sortie/scm.json` in the workspace. When any field is missing or zero, merge-conflict polling is skipped for that workspace with no error.

**Episodic retry:** the attempt counter is per episode. A resolved conflict (the PR returns to a non-conflicted state) resets the counter, so a later independent conflict opens a fresh episode and starts from zero rather than counting against the earlier budget. The default `max_retries` of `1` is the lowest of any kind for that reason.

**Detection:** conflict detection reads the [normalized mergeability state](#normalized-mergeability-states). Only `dirty` is a conflict and arms a rebase turn. `clean`, `unstable`, and `blocked` each close the episode and reset the counter, and `unknown` defers to the next tick, logging `merge conflict deferred: mergeability unknown`, while the provider finishes computing mergeability.

> [!WARNING]
> This kind never arms on the `gitea` provider. Gitea reports mergeability as a single boolean with no conflict value, so its adapter classifies a conflicted pull request as `unknown`, never `dirty`. The entry defers on every tick until the 30-minute time-to-live drops it with a warning and no escalation, so the operator gets no rebase turn and no tracker-visible signal. `sortie validate` accepts `provider: gitea` here, because the shape is valid. Resolve conflicts on Gitea manually, and see the [Gitea adapter reference](/reference/adapter-gitea/#mergeability).

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

**Behavior:** the merge fingerprint is the SHA-256 of the PR head SHA combined with the review decision, so a new push or a change in review decision allows a fresh attempt. `MergePR` is called with the expected head SHA to close the time-of-check to time-of-use window between the precondition read and the merge. A rejection from the merge endpoint sends the adapter back to re-read the pull request, and only a re-read confirming the pull request merged is dispatched as success. No adapter matches the provider's rejection wording, so a reworded response does not change the outcome. Escalation fires when the attempt counter reaches `max_retries`, but only when `max_retries` is greater than zero: a `max_retries` of `0` disables the count-based check instead of making it immediate. The pending reaction still expires after a fixed 30-minute time-to-live, not configurable; when it does, the orchestrator drops the entry and logs a warning rather than escalating, so the reaction goes silent with no tracker-visible signal. An authentication-class or payload-class merge error still escalates immediately regardless of the budget.

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

**Idempotency latch:** the fingerprint row for this kind, keyed by the issue and the kind `merge-completion` in the `reaction_fingerprints` table, holds the merge commit identifier reported by the provider, not the pull request number. A pull request reported as merged with no commit identifier is treated as no observation at all: the entry re-enqueues at the poll interval and logs a warning rather than latching on an empty value. Before transitioning, the pass writes the observed commit into the row; when the stored value already equals the observed one and is marked dispatched, the transition is skipped, which dedups the same merge across repeated poll ticks and across a process restart between them. A different commit identifier, meaning the issue produced a second managed merge, re-arms the latch for exactly one further transition. On a successful transition the row is marked dispatched and retained, never deleted, because deleting it would let the next tick observe the same merge as new. That is the opposite of what the sibling kinds do with their fingerprint rows.

**No expiry:** the pending entry carries no time-to-live. `ci_failure`, `review_comments`, `bot_review`, `merge_conflicts`, and `auto_merge` each bound their entry at 30 minutes, because each waits on a signal that either arrives shortly after the agent finishes or does not arrive at all. A merge waits on human review for an unbounded time, so this kind takes the same posture as the label commands and carries no expiry. The entry is bounded another way: it stops being re-enqueued once the issue leaves the configured handoff state, and it is dropped outright when the issue is already terminal, when the issue is missing from the tracker's state response, or when the pull request is gone from the forge.

**Failure matrix:** a failed transition is routed to one of four dispositions.

| Transition outcome                                        | Posture                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Transport failure, API failure, or an unclassified error   | Retry with backoff, bounded by `max_retries`, then escalate. An unclassified error routes here, the non-destructive default. |
| Authentication failure                                     | Escalate immediately, no retry.                                                              |
| Payload failure, such as a target state the tracker will not accept | Escalate immediately, no retry.                                                     |
| Issue not found                                            | Stop. Mark the latch dispatched, drop the entry, and log a warning, with no escalation, because no issue is left for a later attempt to reach. |

The retry bound is a strict over-limit comparison against a per-issue counter scoped to this kind. The counter is incremented after every transition call regardless of outcome, so the attempt count an operator reads in a `comment` escalation is truthful even on the two paths that escalate immediately.

**Escalation:** the two postures are the ones the sibling kinds already use. `label` (default) adds `escalation_label` (default `needs-human`) to the tracker issue. `comment` posts a plain-text comment naming the number of attempts, the target state, the pull request number, and the repository. Both run in a detached goroutine with a 30-second timeout, so a slow tracker does not block the reconcile tick, and an escalation that itself fails is logged without reopening the entry. On any escalation the pending entry and the attempt counter are cleared while the fingerprint row is deliberately left undispatched. That residue works in your favor: a later reconcile of the same merge commit, driven by a fresh pending entry from a subsequent worker exit, retries the transition instead of treating the escalated attempt as final.

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
- `escalation` must be `label` or `comment` for all kinds.
- `poll_interval_ms` must be at least `30000` for `review_comments`. **Startup only.**
- `poll_interval_ms` must be at least `30000` for `auto_merge`.
- `debounce_ms` must be non-negative, and `max_continuation_turns` must be positive, for `review_comments`. **Startup only.**
- `poll_interval_ms` must be at least `30000` for `bot_review`.
- `max_continuation_turns` must be positive for `bot_review`.
- `bot_usernames` must be a list of strings for `bot_review`.
- `poll_interval_ms` must be at least `30000` for `merge_conflicts`. **Startup only.**
- `strategy` for `auto_merge` must be `merge`, `squash`, or `rebase`.
- `require_ci` and `delete_branch` for `auto_merge` must be boolean.
- Every active SCM reaction must declare the same `provider`. The set spans `review_comments`, `bot_review`, `merge_conflicts`, `auto_merge`, `merge_completion`, and the `label_commands` block, and any two of them naming different providers is reported under the `reactions.scm_provider_conflict` check.
- `poll_interval_ms` must be at least `30000` for `merge_completion`.
- `target_state` is required for `merge_completion`. Compared case-insensitively, it must not equal `tracker.handoff_state`, must not be a member of `tracker.active_states` (falling back to the tracker adapter's default active list only when `tracker.active_states` is itself empty), and must be a member of `tracker.terminal_states` as written, with no fallback to the adapter's default terminal list.
- `tracker.handoff_state` must be non-empty and `tracker.terminal_states` must be written out in front matter whenever `reactions.merge_completion.provider` is set. Each missing field is its own configuration error.

`sortie validate` reports every unmarked rule above offline, before dispatch, at `error` severity, which fails validation and exits non-zero. A startup-only rule surfaces instead as an `invalid review reaction config` or `invalid merge_conflicts reaction config` log line naming the offending field, and the process exits before its first poll. See the [CLI reference](/reference/cli/) for the `validate` subcommand.
