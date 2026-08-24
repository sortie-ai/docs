---
title: "Label commands"
description: "Reference for Sortie's PR label commands: the one-shot sortie:review and sortie:fix labels an operator applies to a Sortie-managed pull request to dispatch a read-only review session or a read-write fix session."
author: Sortie AI
date: 2026-07-10
weight: 76
url: /reference/label-commands/
---
Label commands turn a label on a Sortie-managed pull request into a one-shot instruction: an operator applies a configured label, Sortie dispatches an agent session in response, and Sortie removes the label once it accepts the command. Two commands share one configuration block. The review command (`sortie:review` by default) dispatches a read-only, no-clone session that reads the PR diff and posts review comments. The fix command (`sortie:fix` by default) dispatches a full session that checks out the PR head branch, addresses the accumulated review feedback, and pushes fixes.

Where [reactions](/reference/reactions/) watch an external signal and fire on their own when it changes, label commands fire only on a human gesture. A command label is consumed rather than standing: applying it requests one action, and Sortie removes it on acceptance, unlike a label that stays on the PR to describe a desired steady state. The configuration block lives under `reactions` in `WORKFLOW.md`, but a label command is not a reaction kind: the block parses through a dedicated path, carries no escalation fields, and never appears in the generic reactions map.

See also: [reactions reference](/reference/reactions/) for the event-driven feedback loops that share the reconcile tick; [workflow configuration reference](/reference/workflow-config/) for the `reactions` block and the `agent.max_turns` ceiling; [GitHub adapter reference](/reference/adapter-github/) for the SCM provider and token; [agent extensions reference](/reference/agent-extensions/) for the `.sortie/status` completion signal.

---

## Names

Three names denote three distinct planes and are not interchangeable. Each command has its own runtime kind and its own prompt continuation key; both commands share one configuration block.

| Plane                       | Review command | Fix command  | Where it appears                                         |
| --------------------------- | -------------- | ------------ | -------------------------------------------------------- |
| Configuration block         | `label_commands` | `label_commands` | `WORKFLOW.md` front matter, under `reactions`         |
| Runtime and persisted kind  | `label-review` | `label-fix`  | logs and the `reaction_fingerprints.kind` column         |
| Prompt continuation key     | `label_review` | `label_fix`  | the prompt template data map                             |

The runtime kinds are hyphenated (`label-review`, `label-fix`); the continuation keys are underscored (`label_review`, `label_fix`). This is the same YAML-versus-runtime asymmetry the [reactions reference](/reference/reactions/) documents for `merge_conflicts` and `auto_merge`.

---

## Configuration

Label commands are configured in a single `reactions.label_commands` block in `WORKFLOW.md` front matter.

| Field              | Type    | Default         | Description                                                                                                                                                     |
| ------------------ | ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`         | string  | _(required)_    | SCM adapter kind that activates label commands: `github`, `gitea`, or `gitlab`. Must match a registered adapter. Absent or empty disables the feature, and no journal read happens for either command. |
| `review_label`     | string  | `sortie:review` | Label that triggers the read-only review command. An explicit empty string disables the review command.                                                         |
| `fix_label`        | string  | `sortie:fix`    | Label that triggers the fix command. An explicit empty string disables the fix command.                                                                         |
| `poll_interval_ms` | integer | `60000`         | Interval between label-journal polls per PR. A value below `30000` is clamped up to `30000` with a logged warning, not rejected.                                 |

**Activation.** The feature activates when `provider` is present and non-empty. With the block absent or `provider` empty, the feature is off and no journal read happens for either command. Activation considers `fix_label` exactly as it considers `review_label`: a fix-only configuration (empty `review_label`, non-empty `fix_label`) activates the block and constructs the SCM adapter the same way a review-only configuration does. The two commands share one activation gate and one adapter.

**Per-command disable.** Each label is disabled individually by setting it to an explicit empty string. An absent key defaults to the namespaced name; an explicit empty string is a deliberate disable and is preserved.

**Poll-interval floor.** `poll_interval_ms` defaults to `60000` and is clamped up to a floor of `30000`, with a warning logged at load. A value below the floor is corrected, not rejected. This differs from the other reaction kinds, which reject a low `poll_interval_ms` as a configuration error.

**No escalation machinery.** The block carries no `max_retries`, `escalation`, or `escalation_label`, and detection has no retry budget. A human is in the loop; when nothing visibly happens, the operator re-applies the label.

**Validation.** Setting `provider` while both `review_label` and `fix_label` are empty strings is a configuration error, a loud misconfiguration rather than a silently inert block. Because this is a config-shape check, it surfaces offline through `sortie validate`. A `provider` naming an unregistered SCM adapter is also a validate error, reported under the check name `scm_adapter`. When more than one SCM reaction kind is active (label commands, `ci_failure`, `review_comments`, `bot_review`, `merge_conflicts`, `auto_merge`, or `merge_completion`), every active kind must name the same `provider`; a mismatch is fatal at startup and `sortie validate` reports it offline under `reactions.scm_provider_conflict`.

**Example** (defaults):

```yaml
reactions:
  label_commands:
    provider: github               # required to activate; absent or empty = feature off
    review_label: "sortie:review"  # default; "" disables the review command
    fix_label: "sortie:fix"        # default; "" disables the fix command
    poll_interval_ms: 60000        # default; a value below 30000 is clamped up
```

---

## How detection works

A snapshot of the current labels cannot see a label applied and removed between two ticks, cannot tell a removed-and-reapplied label from an unchanged one, and names no actor. Sortie polls the PR's label-event journal instead. On GitHub the journal is the per-issue events API (pull requests are issues for that API family), whose `labeled` and `unlabeled` entries each carry a unique id, the label name, the acting user, and a timestamp. Gitea serves the same journal from the issue timeline route and GitLab from the merge request's resource label-event route; each adapter normalizes its own shape into the same entry. Each labeling gesture is a durable journal record, so a missed tick loses nothing: the record is re-readable on the next poll. Label names compare lowercased.

Deduplication is a persisted per-PR position, a high-water mark over the journal, stored in the `reaction_fingerprints` table under the command's kind (`label-review` or `label-fix`). Each due tick reads the journal and considers only events that sort strictly after the stored mark, then advances the mark past every examined event, including foreign labels and `unlabeled` entries. The mark tracks journal position, not command history.

Detection latency is one `poll_interval_ms`.

The command semantics follow from that model:

- **Burst collapse.** All matching `labeled` events read in one batch collapse to at most one command. Applying the label twice between two polls is one command, not two.
- **Retraction window.** A command is confirmed only if its label is still present on the PR at detection time. When new matching `labeled` events exist but the label is absent, the gesture was retracted: the mark advances and nothing dispatches. Removing the label within one poll interval cancels the gesture.
- **Depth one per kind.** A gesture arriving while a command of the same kind is queued or its session is running collapses into the outstanding command; no second command of that kind is created.
- **At-most-once across restarts.** The mark is persisted before the dispatch is scheduled. A crash in the narrow window between persisting the mark and scheduling loses the command rather than duplicating it, because the advanced mark is already stored and the processed event never again sorts after it. When a command is lost this way, the operator re-applies the label.
- **Acknowledgment by removal.** After scheduling a dispatch, Sortie removes the command label. Present means queued and not yet picked up; disappearance means accepted (or retracted by you); re-applying is the single gesture for the next command. A failed removal (a missing write scope or a transport error) is a logged warning only: correctness rests on the journal position, so deduplication is already committed, but the stale label lingers and must be removed manually before the next command.
- **No cancel after dispatch.** Once a dispatch is scheduled, removing the label does not cancel the running session. The retraction window closes at detection time.

The journal read is bounded, but the bound and the traversal direction are provider-specific because each provider's journal endpoint paginates differently. GitHub's issue-events endpoint has no since-filter and returns oldest-first, so the adapter walks from the newest page backward and stops after a fixed number of pages, keeping the tail where a command and its retraction signal live. Gitea's issue timeline and GitLab's resource-label-event route page forward from the oldest entry instead, each under its own page ceiling. Every adapter logs a warning identifying the pull request when a fetch hits its cap, so a real command is never silently dropped on an event-heavy PR.

A journal entry the adapter retains but cannot read fails the whole poll. An entry whose timestamp is absent or is not a valid RFC 3339 value is never assigned a substituted time, because the timestamp is half of the stored position and a substituted value would sort the entry behind the mark and drop the command it carries. Sortie logs a warning naming the PR and the error, backs the PR off, and re-reads on the next due tick; no command on that PR dispatches while the forge keeps serving that entry. The retry carries no budget and escalates nothing. It ends when the forge serves a parseable value, or when the linked issue reaches a terminal state and the pending entry is discarded.

---

## The review command

A confirmed review command dispatches a fresh, read-only, no-clone session. The session obtains a minimal per-issue scratch directory, containment-validated under the workspace root as a normal dispatch is, but takes no clone, no build, no branch, and no checkout. Because the directory is the reused per-issue workspace, a stale `.sortie/status` from a prior session is cleared after creation so it cannot end the review on turn one. The session starts with no resume identifier.

The read-only path runs no operator hooks (`after_create`, `before_run`, `after_run`), and it suppresses every issue-work side effect a normal dispatch performs, because a review claims no work and changes no issue state:

- the dispatch-time transition of the linked issue to the in-progress tracker state;
- the dispatch comment on the linked issue;
- the per-turn tracker-state refresh, and with it the issue-state termination gate that ends a normal turn loop when the issue leaves an active state;
- the self-review loop, which has no local checkout to verify;
- the `after_run` teardown hook, on every exit path including panic recovery, because no operator setup hook ran on the scratch workspace;
- the worker-exit handoff transition and the active-issue continuation retry, so a clean review exit neither hands off nor re-dispatches. A `blocked` signal releases the claim rather than parking the issue, because the read-only posture does not drive issue state.

Because the read-only turn loop is not gated on issue state, its turn budget rests on the `agent.max_turns` ceiling plus the agent's own completion signal (the [`.sortie/status`](/reference/agent-extensions/) control-plane file), and every turn also carries the [`agent.turn_timeout_ms`](/reference/workflow-config/#agent) wall-clock bound regardless of posture. A review is naturally a single turn (fetch the diff, post the review, stop), and `agent.max_turns` is the backstop for a session that does not self-signal.

### The `label_review` continuation key

The dispatch injects the PR coordinates on turn one through the `label_review` continuation key. Its value is a map on a review dispatch and nil on every other dispatch.

| Field          | Type    | Meaning                                                       |
| -------------- | ------- | ------------------------------------------------------------- |
| `pr_number`    | integer | PR to review                                                  |
| `owner`        | string  | repository owner                                              |
| `repo`         | string  | repository name                                               |
| `actor`        | string  | login that applied the review label                          |
| `requested_at` | string  | RFC 3339 timestamp of the confirmed labeling gesture          |

**Template contract.** The prompt template must contain a `{{ if .label_review }}` branch instructing the agent to fetch the diff and post its review. Without that branch, a review dispatch renders the normal work prompt against the scratch directory and posts no review. Go templates give no signal of which keys a template referenced, so the missing branch cannot be detected at render time. The workflow loader logs an advisory warning at load when `label_commands` is active with a non-empty review label but the template text does not reference `label_review`. The warning never fails the load.

**Credentials.** The reviewing agent inherits the orchestrator's process environment, so SCM credentials present there (the standard token or CLI-auth deployment) reach a no-clone session even with the setup hooks skipped. Auth provisioned solely by a workspace setup hook (for example a checkout-scoped git credential helper written during `after_create`) does not exist in a review session, because no such hook runs. An operator relying on hook-local auth must also expose the credential in the orchestrator's environment for review sessions.

**Boundary.** The agent fetches the diff and posts review comments through its own SCM tooling and credentials. The orchestrator injects only the coordinates above and posts nothing itself.

---

## The fix command

A confirmed fix command dispatches a fresh session that checks out the PR head branch and pushes review-feedback fixes to it. Unlike the review posture, the fix session pushes commits, so it takes the same workspace path a normal dispatch takes: the operator `after_create` and `before_run` setup hooks run, cloning the per-issue directory when it is absent and reusing the existing checkout when it is present, and the `after_run` teardown hook runs on every exit path, including panic recovery. Sortie never checks out a branch itself; the agent checks out the PR head branch with its own git tooling, told the branch through the `label_fix` continuation key. A stale `.sortie/status` in the reused directory is cleared before the first turn. The session starts with no resume identifier.

The fix command requires the content-write scope. At startup the orchestrator runs a one-shot scope preflight for the fix command: the push needs `contents:write` and `pull_requests:write`. The preflight is advisory. A missing scope or a transport failure is a logged warning, not an error, because the fix command is on by default; a provider that returns no scope information passes the preflight, and a genuine gap surfaces later as the fix session's push failure and a label-removal warning.

The fix path suppresses the same issue-work side effects the review path suppresses (the linked issue of a PR under review is typically not in an active work state, and the fix session must not re-drive it):

- the dispatch-time transition of the linked issue to the in-progress tracker state;
- the dispatch comment on the linked issue;
- the per-turn tracker-state refresh, and with it the issue-state termination gate;
- the self-review loop;
- the worker-exit handoff transition and the active-issue continuation retry, so a clean fix exit neither hands off nor re-dispatches. A `blocked` signal releases the claim rather than parking the issue, for the same reason.

The `after_run` teardown hook does run on a fix exit, because the setup hooks ran; this is the one dispatch-lifecycle difference from the review posture, which runs no hooks at all. Because the fix turn loop is not gated on issue state, its turn budget rests on `agent.max_turns` plus the agent's completion signal, and every turn also carries the [`agent.turn_timeout_ms`](/reference/workflow-config/#agent) wall-clock bound regardless of posture. A fix is naturally multi-turn (fetch the comments, apply changes, push, post the summary), so the completion signal matters more here than for a review: without it a completed fix session runs to `agent.max_turns`.

### The `label_fix` continuation key

The dispatch injects the PR coordinates and the head branch through the `label_fix` continuation key. Its value is a map on a fix dispatch and nil on every other dispatch, mirroring `label_review` with the added `branch` field.

| Field          | Type    | Meaning                                                       |
| -------------- | ------- | ------------------------------------------------------------- |
| `pr_number`    | integer | PR to fix                                                     |
| `owner`        | string  | repository owner                                              |
| `repo`         | string  | repository name                                               |
| `branch`       | string  | PR head branch to check out and push to                       |
| `actor`        | string  | login that applied the fix label                             |
| `requested_at` | string  | RFC 3339 timestamp of the confirmed labeling gesture          |

**Template contract.** The prompt template must contain a `{{ if .label_fix }}` branch instructing the agent to check out the branch, address the review comments, push fixes, and post a summary comment. The workflow loader logs an advisory warning at load when `label_commands` is active with a non-empty fix label but the template text does not reference `label_fix`. Unlike a misfired review dispatch, which runs against a scratch directory and structurally pushes and posts nothing, a misfired fix dispatch runs the normal work prompt against a real checkout with push capability, so it cannot be assumed to be inert. The warning stays advisory (it never fails the load), because a text scan over template source is a heuristic.

**Credentials.** The fix agent inherits the orchestrator's process environment and any checkout-scoped credential the operator setup hooks provision during `after_create`. Because the fix session runs those hooks, it has more credential paths available than a review session, not fewer.

**Boundary.** The agent fetches the review comments, applies changes, pushes commits, and posts the summary comment through its own SCM tooling and credentials. The orchestrator injects only the coordinates and the head branch above, and performs none of that work itself.

---

## Authorization

The platform's own label permission is the authorization gate, and Sortie adds none of its own: any account the forge permits to apply the label can issue the command. On every supported forge that permission is separable from push access, so a user who cannot push code can command an agent session that pushes to the PR head branch through the fix command. Consult the forge's permission documentation for which roles carry it. The risk is bounded: the branch lands only through the ordinary review and merge gates, and the per-issue session and token ceilings cap the compute a PR can be commanded into. Sortie records the acting user, read from the journal, in the dispatch context and the informational dispatch log.

> [!WARNING]
> Because a fix command dispatches a session that pushes to the PR branch, a user with only the label permission can direct code changes onto a PR they cannot push to directly. Confirm that the review and merge protections on Sortie-managed PRs match the trust level of everyone who can apply the `fix_label`.

---

## Scope and prerequisites

Detection covers Sortie-managed PRs only, identified by the workspace `.sortie/scm.json` metadata reporting `pr_number` greater than zero with non-empty `owner` and `repo`. The review command needs no `branch`, because it has no checkout. The fix command needs a non-empty head branch: a PR record without one has nothing to check out, so no fix command is armed for it.

When the linked issue reaches a terminal state, the issue-wide reaction cleanup removes the pending entries and fingerprint rows for that issue across every kind. Commands on such PRs are ignored thereafter.

Sortie never creates command labels. The operator creates both labels on the forge or points the configuration at existing ones. The defaults are namespaced with the `sortie:` prefix to stay clear of team label vocabularies.

---

## See also

- [Reactions reference](/reference/reactions/) for the event-driven feedback loops (CI failure, review comments, bot review, merge conflicts, and auto-merge) that share the reconcile tick.
- [Workflow configuration reference](/reference/workflow-config/) for the `reactions` block, the `agent.max_turns` ceiling, and the prompt template.
- [GitHub adapter reference](/reference/adapter-github/) for the SCM provider, token, and authentication.
- [Agent extensions reference](/reference/agent-extensions/) for the `.sortie/status` completion signal that bounds a command session's turn loop.
