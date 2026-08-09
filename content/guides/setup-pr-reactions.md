---
title: "How to Set Up PR Reactions | Sortie"
linkTitle: "Set Up PR Reactions"
description: "Set up Sortie's PR reaction framework: enable the reactions block, share PR metadata via .sortie/scm.json, configure auto-merge safely, and verify the loop."
author: Sortie AI
date: 2026-05-27
weight: 145
url: /guides/setup-pr-reactions/
---
Reactions are feedback loops that act on a Sortie-created pull request after the agent's first run hands off for human review. Each reaction kind watches one signal on the PR and responds: a CI failure or a "Request changes" review dispatches a fix continuation turn, and an approved, mergeable, green PR can be merged automatically. This guide sets up the shared machinery every reaction needs (the `reactions` block, PR metadata, and a GitHub token), then walks through `auto_merge` in full, since it's the one kind that performs an irreversible action. For the two fix-dispatch kinds, it points you to their dedicated guides.

## Prerequisites

- Sortie running with the GitHub tracker adapter (`tracker.kind: github`) or a GitHub-compatible SCM provider, see [Connect to GitHub](/guides/connect-to-github/)
- A `handoff_state` configured on the tracker, so issues wait in a human-review state after the first run instead of going straight to terminal
- An agent or `after_run` hook that opens a PR and writes PR coordinates to `.sortie/scm.json`, see [Setup workspace hooks](/guides/setup-workspace-hooks/)
- A GitHub personal access token with `repo` scope (auto-merge needs more, covered below)

## Choose which reactions to enable

Reactions are opt-in. A kind stays inactive until you give it a `provider`, and omitting the `reactions` block disables every kind. Pick the kinds that match your workflow:

| Kind | Watches for | What Sortie does | Setup |
|---|---|---|---|
| `ci_failure` | A failing CI check on the pushed branch | Dispatches a fix continuation turn with the failure context | [Configure CI feedback](/guides/configure-ci-feedback/) |
| `review_comments` | A human "Request changes" review on the PR | Dispatches a fix continuation turn with the review comments | [Configure review feedback](/guides/configure-review-feedback/) |
| `auto_merge` | An approved, mergeable, CI-green PR | Merges the PR directly through the SCM adapter | This guide, below |
| `merge_completion` | A managed PR that has merged, whoever merged it | Transitions the linked tracker issue to a terminal state. The one kind that writes to the tracker | This guide, below |

The kinds are independent. You can enable one, two, or all of them, each with its own retry budget, escalation policy, and state. The rest of this guide covers the setup common to all kinds, then the `auto_merge` specifics.

## Enable the reactions block

Add a `reactions` block to your WORKFLOW.md front matter and give each kind you want a `provider`:

```yaml
reactions:
  ci_failure:
    provider: github
  review_comments:
    provider: github
  auto_merge:
    provider: github
```

The `provider` value names a registered adapter and is the activation key. There is no separate `enabled` flag. When `reactions.review_comments` and `reactions.auto_merge` are both present, they must name the same `provider`, otherwise startup fails.

Every kind shares four fields:

| Field | Default | Description |
|---|---|---|
| `provider` | _(required)_ | SCM or CI adapter that activates the kind. Absent or empty disables it. |
| `max_retries` | `2` | Fix or merge attempts per issue before escalation. Must be non-negative. |
| `escalation` | `"label"` | Action on budget exhaustion: `"label"` or `"comment"`. |
| `escalation_label` | `"needs-human"` | Label applied to the issue when `escalation` is `"label"`. Created on demand if the tracker does not already have it. |

When a kind exhausts its budget, Sortie applies the escalation action and releases its claim on the issue. With `label`, it adds `escalation_label` to the tracker issue. With `comment`, it posts a plain-text comment naming the PR, the attempt count, and the outstanding signal. Create the label in advance if you use label escalation:

```bash
gh label create needs-human --repo myorg/myrepo --color "D93F0B"
```

Reaction configuration comes from WORKFLOW.md only. Environment variable overrides for `reactions` fields are not supported. The whole block is read once at startup: changing a field, or adding or removing a kind, takes effect on the next restart, not on a dynamic reload. The one exception is `ci_failure`, whose fields are re-read on every tick. For the full field tables and validation rules, see the [reactions reference](/reference/reactions/).

## Provide PR metadata in `.sortie/scm.json`

Both `review_comments` and `auto_merge` act on a specific PR, so they need its coordinates. Sortie reads these from `.sortie/scm.json` in the workspace, written by your agent or `after_run` hook after it opens the PR:

```json
{
  "branch": "sortie/PROJ-123",
  "sha": "abc1234",
  "pushed_at": "2026-05-27T12:00:00Z",
  "pr_number": 42,
  "owner": "myorg",
  "repo": "myproject"
}
```

Which fields each kind reads:

- `ci_failure` uses `branch` and `sha` to poll CI status. The SHA is preferred; the branch is the fallback.
- `review_comments` uses `pr_number`, `owner`, and `repo`. When any is missing or zero, review polling is skipped for that workspace with no error.
- `auto_merge` uses `pr_number`, `owner`, `repo`, and `branch`. The `branch` field is required because branch deletion after merge needs it.
- `merge_completion` uses `pr_number`, `owner`, and `repo`. It needs no `branch`, because it performs no checkout.

The optional `pushed_at` timestamp (RFC 3339 UTC) lets Sortie reconstruct pending reactions for an open PR after a restart, so feedback survives a process bounce instead of waiting for the next push. Write it from the same hook that pushes. See [Resume sessions across restarts](/guides/resume-sessions-across-restarts/) for the recovery model.

Here's an `after_run` hook that pushes, opens a PR, and writes every field:

```bash
git add -A
git diff --cached --quiet || {
  git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
  git push origin "sortie/${SORTIE_ISSUE_IDENTIFIER}" --force-with-lease

  SHA=$(git rev-parse HEAD)
  PR_URL=$(gh pr create \
    --repo myorg/myrepo \
    --head "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
    --base main \
    --title "${SORTIE_ISSUE_IDENTIFIER}: ${SORTIE_ISSUE_TITLE}" \
    --body "Automated PR for ${SORTIE_ISSUE_IDENTIFIER}" \
    2>/dev/null || gh pr view "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
    --repo myorg/myrepo --json url -q .url 2>/dev/null)
  PR_NUMBER=$(echo "$PR_URL" | grep -oP '\d+$')

  mkdir -p .sortie
  cat > .sortie/scm.json <<EOF
{
  "branch": "sortie/${SORTIE_ISSUE_IDENTIFIER}",
  "sha": "${SHA}",
  "pushed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pr_number": ${PR_NUMBER:-0},
  "owner": "myorg",
  "repo": "myrepo"
}
EOF
}
```

If `.sortie/scm.json` is absent, has empty required fields, or is a symlink (rejected for security), the PR-scoped reactions skip that workspace silently.

## Set up auto-merge

Auto-merge polls a Sortie-created PR and merges it directly once a stable set of preconditions holds. It performs the merge through the SCM adapter, not through an agent turn, because no code change is needed.

> [!WARNING]
> A merge is irreversible. Sortie does not roll back on a tail-step failure such as branch deletion. Auto-merge stays off unless `reactions.auto_merge.provider` is set, and turning it on is a conscious opt-in. Read the precondition and branch-protection sections below before you enable it in a repository that matters.

### When a merge fires

Auto-merge merges only when all of these hold at the same time. While any one is unmet, Sortie re-checks at the poll interval and takes no action:

- **Ownership.** The PR is Sortie-created, identified by `.sortie/scm.json`.
- **Not a draft.** Draft PRs are never merged.
- **Mergeable.** GitHub reports the PR as `clean` or `unstable` (no conflicts).
- **Review.** The review decision is `APPROVED`, or reviews are not required (`NOT_REQUIRED`).
- **CI.** The CI conclusion is `success` when `require_ci` is `true`. CI is ignored when `require_ci` is `false`.

### Require a human approval with branch protection

The review precondition has a sharp edge. Sortie reports the review decision as `NOT_REQUIRED` when the repository has no branch-protection rule requiring review. In that case auto-merge proceeds on mergeability and CI alone, with no human approval. That's the right behavior for a repo whose policy genuinely needs no review, and a surprise for one that assumed a human would always click merge.

Branch protection is the security boundary, not Sortie. If you want a person to approve before auto-merge acts, add a branch-protection rule on the base branch that requires at least one pull request review:

```bash
gh api -X PUT "repos/myorg/myrepo/branches/main/protection" \
  --input - <<'EOF'
{
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "required_status_checks": null,
  "enforce_admins": true,
  "restrictions": null
}
EOF
```

With that rule in place, the review decision stays `REVIEW_REQUIRED` until a human approves, and auto-merge waits. The same rule blocks the bot account from approving its own PR, which GitHub enforces with an HTTP 405 that Sortie treats as "keep waiting."

### Choose a merge strategy and cleanup

```yaml
reactions:
  auto_merge:
    provider: github
    strategy: squash        # squash (default) | merge | rebase
    require_ci: true         # never merge on failing or pending CI
    delete_branch: true      # remove the head branch after a successful merge
```

`strategy` controls how GitHub combines the commits. `require_ci: true` is the safe default: it holds the merge until every CI check passes. Set it to `false` only when CI is advisory for that repo. `delete_branch: true` removes the head branch after the merge; a delete failure is logged but does not roll back the merge. For the full field table and defaults, see the [auto-merge reference](/reference/reactions/#reactionsauto_merge).

### Grant the token the right scopes

Auto-merge needs more than read access. At startup Sortie runs a one-shot preflight against the token:

| Operation | Classic scope | Fine-grained permission |
|---|---|---|
| Merge the PR | `repo` | `pull_requests:write` |
| Delete the branch (`delete_branch: true`) | `repo` | `contents:write` |

A classic `repo` token covers both. If the preflight finds the token is missing a required scope (an auth-class failure), Sortie disables auto-merge for the lifetime of the process and logs the reason. A transport-class failure (network or rate limit) schedules one retry on the next tick before disabling. Some fine-grained tokens don't report their scopes through the API; Sortie logs that it skipped the scope check and proceeds, so confirm the token's permissions yourself in that case. For token creation, see [Connect to GitHub](/guides/connect-to-github/).

### A conservative opt-in

Pair `auto_merge` with `review_comments` so reviewer feedback routes back to the agent before the PR is eligible to merge, and use `comment` escalation so a stuck merge leaves a visible trail on the issue:

```yaml
reactions:
  review_comments:
    provider: github          # must match auto_merge below
  auto_merge:
    provider: github          # activates auto-merge
    strategy: squash
    require_ci: true          # hold until CI is green
    delete_branch: true
    max_retries: 2            # merge attempts before escalation
    escalation: comment       # post a tracker comment when exhausted
    poll_interval_ms: 60000   # 60s between precondition checks
```

This relies on a branch-protection rule (above) to supply the human approval gate. With the rule in place, the sequence is: agent opens the PR, a reviewer requests changes (routed back through `review_comments`), the reviewer approves, CI goes green, and auto-merge merges and deletes the branch.

## Close the issue after merge

Auto-merge lands the PR but leaves the tracker issue sitting in `handoff_state`. The `merge_completion` kind closes that loop: it watches the merge state of a managed PR and, once the PR merges, transitions the linked issue to one terminal state you name. It is opt-in and off by default, and a deployment that omits the block is unaffected.

It fires for a merge by anyone. A person clicking merge in the GitHub UI, a forge automation rule, and Sortie's own auto-merge all reach the same transition, because the reaction reads the PR's merge state live rather than remembering a merge Sortie performed. That makes it useful in a deployment that never enables `auto_merge`.

### Configure the transition

The kind needs a provider, a target state, and two `tracker` fields it depends on:

```yaml
tracker:
  handoff_state: review        # required: the state a merge waits in
  terminal_states:             # required: written out, not left to the adapter default
    - done
    - wontfix

reactions:
  merge_completion:
    provider: github
    target_state: done         # required: no default, never inferred
```

Both tracker fields are enforced offline, and each missing one is its own configuration error.

### Choose the target state carefully

`target_state` is applied verbatim. Sortie never picks it out of `terminal_states` for you, because a terminal list usually mixes a completion state with one or more abandonment states, as `done` and `wontfix` do above, and nothing in the ordering or the wording says which is which.

`sortie validate` checks that your value is not the handoff state, is not an active state, and is a member of `terminal_states`, all case-insensitively. It cannot check that you picked the right one. Naming `wontfix` where you meant `done` is valid configuration that closes finished work under the wrong label, and the orchestrator does not reverse the transition. Read the value back against your tracker's own vocabulary before you enable the block.

### Grant the tracker credential write authority

Enabling this block asks the tracker credential to do something it did not do before: move an issue to a terminal state. On the forges, that closes the native issue. A credential that was sufficient for reading issues and adding labels may not be sufficient for this.

Nothing checks it in advance. There is no startup preflight and no validator check for the tracker credential's scope, unlike the SCM token preflight auto-merge runs. An insufficient scope surfaces on the first real merge, as an authentication failure that escalates immediately with no earlier warning. If your first merged PR escalates instead of closing its issue, check the credential before anything else.

### Restart to apply

This block is read once at startup. A change to `provider`, `target_state`, `poll_interval_ms`, or either tracker prerequisite takes effect only after you restart Sortie; a dynamic reload does not pick it up.

### Confirm it worked

Merge a managed PR and look for two things. The transition log line names the target state and the merge commit:

```bash
grep "merge_completion transitioned issue to terminal state" sortie.log
```

And the latch row appears under the `merge-completion` kind:

```bash
sqlite3 sortie.db "SELECT issue_id, kind, dispatched FROM reaction_fingerprints WHERE kind='merge-completion'"
```

A row with `dispatched` set means that merge has already been acted on. The row stays after a successful transition, which is what stops the next tick from treating the same merge as new. For the full field table, the failure matrix, and the idempotency rules, see the [merge-completion reference](/reference/reactions/#reactionsmerge_completion).

## Reactions run during handoff

Reactions are useful precisely because they fire while the issue waits for a human. After a successful first run, Sortie transitions the issue to your `handoff_state` (for example, `review`) and releases the worker. Reaction continuations dispatch even while the issue sits in `handoff_state`.

This differs from fresh-work retries (stall recovery and transient agent errors), which dispatch only when the issue is in an `active_state`. Once the issue leaves `handoff_state`, for example when auto-merge moves it toward a terminal state or a human moves it elsewhere, Sortie releases the claim on the next tick and runs no further reactions for it. See the [state machine reference](/reference/state-machine/) for the claim and retry model, and the [reactions reference](/reference/reactions/#state-eligibility) for the eligibility rule.

Each kind keeps its own pending entry, fingerprint, and attempt counter. A successful auto-merge, or escalation of any single kind, cleans up only that kind's state and leaves the others on the same issue intact.

## Verify the setup

Confirm reactions are wired correctly before trusting them in production.

### Validate the configuration

Catch configuration errors before dispatch:

```bash
sortie validate
```

This reports invalid reaction keys, a negative `max_retries`, a bad `escalation` value, a `poll_interval_ms` below `30000`, an invalid `strategy`, or a `provider` mismatch between `review_comments` and `auto_merge`. With `merge_completion` configured, it also reports a missing `target_state`, a `target_state` that is the handoff state, an active state, or absent from `terminal_states`, and a missing `tracker.handoff_state` or `tracker.terminal_states`. See the [CLI reference](/reference/cli/) for the `validate` subcommand.

### Logs

Search for the stable lifecycle messages. Auto-merge messages all carry the `auto_merge` prefix:

```bash
# Auto-merge completed a merge
grep "auto_merge merged PR" sortie.log

# Preconditions not yet met (raise log level to debug to see these)
grep "auto_merge deferred" sortie.log

# Preflight failed: token scope problem, auto-merge disabled
grep "auto_merge skipped: preflight failed" sortie.log

# Merge attempts exhausted, escalation fired
grep "auto_merge" sortie.log | grep -i "escalat"
```

The `auto_merge deferred:` messages name the unmet precondition (`review decision not approved`, `CI not green`, `CI pending`, `PR not mergeable`, `PR is draft`). Raise the log level to `debug` to see them.

### Dashboard and status API

Pending reactions are runtime state and are not published. The dashboard and the status API expose running sessions, the retry queue, agent totals, rate limits, and budget exhaustion; neither surfaces a reaction entry, its kind, or its attempt count. Do not expect to watch a reaction poll from either.

What you do see is the result. When a reaction dispatches a continuation turn, the issue reappears as a running session for the duration of that turn, exactly like any other dispatch. Auto-merge and post-merge closure dispatch no turn at all, so they leave no trace on either surface; for those, read the logs, the fingerprint rows below, or the counters above. See the [dashboard reference](/reference/dashboard/) for what each surface does carry.

### Prometheus metrics

Auto-merge outcomes are recorded by one counter, available when the HTTP server is enabled:

| Metric | Labels | Description |
|---|---|---|
| `sortie_reactions_auto_merge_total` | `result` (`merged`, `error`, `escalated`) | Auto-merge reaction outcomes by result. |

A healthy setup shows `result="merged"` climbing as PRs land, with `error` flat. A rising `error` count points to a token, permission, or mergeability problem. CI and review reactions expose their own metrics; see the [Prometheus metrics reference](/reference/prometheus-metrics/) for the full catalog.

### SQLite fingerprints

Every reaction kind stores a fingerprint so it doesn't act twice on the same state across ticks or restarts. Each row is keyed by issue and kind, and what the fingerprint holds differs per kind. Inspect the merge fingerprints:

```bash
sqlite3 sortie.db "SELECT issue_id, kind, dispatched FROM reaction_fingerprints WHERE kind='merge'"
```

The merge fingerprint combines the PR head SHA and the review decision, so a new push or a change in review decision allows a fresh attempt.

`merge_completion` writes a row too, under kind `merge-completion`, holding the merge commit identifier. That row is retained after a successful transition rather than deleted, so do not expect it to disappear once the issue closes: keeping it is what prevents the same merge from being observed again on the next tick.

## Troubleshooting

**Auto-merge never merges, even with an approved green PR.** Check the preflight. A token missing `pull_requests:write` (or `contents:write` when `delete_branch` is on) disables auto-merge for the process; look for `auto_merge skipped: preflight failed`. A classic `repo` token covers both scopes. If you use a fine-grained token, confirm its permissions directly, since some don't report scopes for the preflight to check.

**The PR merged without anyone approving it.** The repository has no branch-protection rule requiring review, so Sortie reported the review decision as `NOT_REQUIRED` and merged on CI and mergeability alone. Add a branch-protection rule requiring at least one approval (see [Require a human approval with branch protection](#require-a-human-approval-with-branch-protection)). The decision then stays `REVIEW_REQUIRED` until a human approves.

**Auto-merge is deferred forever.** Raise the log level to `debug` and read the `auto_merge deferred:` messages. They name the unmet precondition: CI is still pending or red, the review decision isn't `APPROVED`, GitHub reports a conflict, or the PR is a draft. Resolve the named condition and the next tick proceeds.

**Startup fails with a provider mismatch.** When both `review_comments` and `auto_merge` are present, they must declare the same `provider`. Align them, or remove one.

**Review or merge reactions never start.** Confirm `.sortie/scm.json` carries the fields each kind needs: `pr_number`, `owner`, and `repo` for both, plus `branch` for auto-merge. A missing or zero-valued field skips the kind silently. Verify your `after_run` hook writes the file after opening the PR.

## Related guides

- [Configure CI feedback](/guides/configure-ci-feedback/): the `ci_failure` kind in full, with log fetching and prompt context
- [Configure review feedback](/guides/configure-review-feedback/): the `review_comments` kind, debounce, and the complete WORKFLOW.md example
- [Configure self-review](/guides/configure-self-review/): pre-PR verification that runs before any reaction
- [Connect to GitHub](/guides/connect-to-github/): adapter setup and token scopes
- [Setup workspace hooks](/guides/setup-workspace-hooks/): hook scripts and `.sortie/scm.json` population
- [Resume sessions across restarts](/guides/resume-sessions-across-restarts/): how pending reactions survive a restart
- [Reactions reference](/reference/reactions/): the shared lifecycle and every field, default, and safety rule
- [State machine reference](/reference/state-machine/): claims, retries, and the reconcile tick
- [Prometheus metrics reference](/reference/prometheus-metrics/): reaction and escalation metrics
