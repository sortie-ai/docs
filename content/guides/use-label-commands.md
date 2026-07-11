---
title: "How to Use PR Label Commands | Sortie"
linkTitle: "Use PR Label Commands"
description: "Request an agent code review with sortie:review or an agent fix with sortie:fix by applying the label to a Sortie-managed pull request, which Sortie consumes on acceptance."
keywords: sortie label commands, sortie:review, sortie:fix, review by label, label_commands, review_label, fix_label, PR review, request changes fix
author: Sortie AI
date: 2026-07-10
weight: 165
url: /guides/use-label-commands/
---
Apply a label to a Sortie-managed pull request and Sortie dispatches an agent session in response: `sortie:review` requests a read-only code review of the diff, and `sortie:fix` requests a session that checks out the branch and pushes fixes for the accumulated review feedback. Sortie removes the label once it accepts the command, so the label works as a one-shot button rather than a standing state. Label commands are human-triggered, which sets them apart from [reactions](/reference/reactions/), the event-driven loops that fire on their own; for the full behavioral contract, session posture, and authorization model, see the [label commands reference](/reference/label-commands/).

## Prerequisites

- A working Sortie PR flow on GitHub: your agent or an `after_run` hook opens a PR and writes `pr_number`, `owner`, and `repo` to `.sortie/scm.json` in the workspace. The review command needs no `branch`; the fix command checks out the PR head branch, so `.sortie/scm.json` must carry a non-empty `branch` for a fix command to be armed. See [Set up PR reactions](/guides/setup-pr-reactions/) and [Setup workspace hooks](/guides/setup-workspace-hooks/).
- SCM credentials in the orchestrator's process environment. A review session runs no workspace hooks, so a credential provisioned only by a setup hook (for example a git credential helper written during `after_create`) is unavailable to it. Expose the token in the environment Sortie runs in. See [Connect to GitHub](/guides/connect-to-github/).
- Write access to the repository to create the two labels.
- The triage role or higher for anyone who applies a command label. GitHub gates label application on the triage role.

## Create the command labels

Sortie never creates command labels. Create both once with the default names, or point the config at labels your team already uses. Label-name matching is case-insensitive.

```bash
gh label create sortie:review --repo myorg/myrepo \
  --description "Request a Sortie agent code review" --color "1D76DB"
gh label create sortie:fix --repo myorg/myrepo \
  --description "Request a Sortie agent fix for review feedback" --color "0E8A16"
```

To use existing labels instead, skip this step and set `review_label` and `fix_label` to their names in the next step.

## Configure the label commands block

Add a `reactions.label_commands` block to your WORKFLOW.md front matter:

```yaml
reactions:
  label_commands:
    provider: github               # SCM adapter; activates label commands
    review_label: "sortie:review"  # default; "" disables the review command
    fix_label: "sortie:fix"        # default; "" disables the fix command
    poll_interval_ms: 60000        # poll interval per PR; floor 30000
```

`provider` is the activation key; with the block absent or `provider` empty, label commands are off. Each label defaults to its namespaced name; set either to an explicit empty string to disable that command, or to a custom name to point at a team label. Every field in this block takes effect at startup, so you restart Sortie after changing it. For the field table, see the [workflow configuration reference](/reference/workflow-config/).

## Add the template branches

The review dispatch injects PR coordinates into a `.label_review` map, and the fix dispatch injects them into a `.label_fix` map (with the head branch added). Your prompt template turns those coordinates into instructions with a `{{ if .label_review }}` branch and a `{{ if .label_fix }}` branch. The shipped example workflows in `examples/` already carry both:

```gotemplate
{{ if .label_review }}

## Review This Pull Request

Produce a code review of pull request #{{ .label_review.pr_number }} in
{{ .label_review.owner }}/{{ .label_review.repo }}, requested by {{ .label_review.actor }}.

1. Fetch the diff for this PR using your SCM tooling.
2. Review the changes for correctness, clarity, and regressions.
3. Post your review comments on the PR. Do not modify the branch or push commits.
{{ end }}

{{ if .label_fix }}

## Fix This Pull Request

Check out {{ .label_fix.branch }} for pull request #{{ .label_fix.pr_number }} in
{{ .label_fix.owner }}/{{ .label_fix.repo }}, requested by {{ .label_fix.actor }}.

1. Fetch the outstanding review comments for this PR using your SCM tooling.
2. Address the feedback and push the fixes to {{ .label_fix.branch }}.
3. Post a summary comment on the PR describing the changes you made.
4. Write `needs-human-review` to `.sortie/status` to signal completion.
{{ end }}
```

The agent fetches the diff or the comments and posts to the PR through its own SCM tooling; the orchestrator injects only the coordinates and posts nothing. For the full continuation-key schema, see the [label commands reference](/reference/label-commands/).

Without the `label_review` branch, a review dispatch renders your normal work prompt and posts nothing. Sortie cannot detect the missing branch when it renders the template, so the workflow loader logs an advisory warning at load. Grep your logs for it:

```
label_commands active but prompt template has no label_review branch
```

The fix command has the parallel warning, `label_commands active but prompt template has no label_fix branch`. Both are advisory and never fail the load.

## Validate and restart

Validate the configuration offline, then restart Sortie so the `label_commands` block takes effect:

```bash
sortie validate
```

`sortie validate` catches the one label-commands configuration error offline: a `provider` set while both `review_label` and `fix_label` are empty strings. Because the defaults are non-empty, you reach this error only by explicitly emptying both. The prompt template reloads on its own, but the `label_commands` fields do not, so restart the process after editing the block.

## Request a review

Apply the `sortie:review` label to a Sortie-managed PR from the PR page or with the CLI:

```bash
gh pr edit 42 --repo myorg/myrepo --add-label sortie:review
```

Detection is polling only; there are no webhooks. Within one `poll_interval_ms` (one minute with the default), this happens in order:

1. The label disappears from the PR. Its removal is Sortie's acknowledgment that it accepted the command.
2. A read-only session starts. It reuses the per-issue workspace directory with no clone and no workspace hooks.
3. Review comments appear on the PR under the agent's own identity.

To confirm from the orchestrator side, grep the logs for the dispatch record:

```bash
grep "label-review dispatched" sortie.log
```

## Request fixes

After a review lands on the PR (from a label command, a human reviewer, or a review bot), apply the `sortie:fix` label to route the accumulated feedback back to an agent:

```bash
gh pr edit 42 --repo myorg/myrepo --add-label sortie:fix
```

The fix command dispatches a full session, not a read-only one. Within one poll interval:

1. The label disappears, acknowledging the command.
2. A session starts, runs your workspace hooks, and checks out the PR head branch named in `.sortie/scm.json`.
3. The agent addresses the outstanding review comments, pushes the fixes to the PR branch, and posts a summary comment describing what it changed.

Because the fix command pushes commits, its token needs the content-write scope: the classic `repo` scope, or `contents:write` and `pull_requests:write` on a fine-grained token. The `{{ if .label_fix }}` branch above ends by writing `needs-human-review` to `.sortie/status`, the agent's completion signal. Confirm the dispatch in the logs:

```bash
grep "label-fix dispatched" sortie.log
```

## Cancel, repeat, and batch

- **Cancel before acceptance.** To take back a command, remove the label before Sortie's next poll. When Sortie polls and finds the label already gone, it treats the gesture as retracted and dispatches nothing. The cancellation window is one poll interval.
- **No cancel after acceptance.** Once the label has disappeared, Sortie has accepted the command and the session is queued or running. Removing anything at that point cancels nothing.
- **Repeat.** Re-apply the label after a command completes to issue the next one. Each fresh application is a new command.
- **Batch.** Applying the label several times between two polls collapses into a single command.

## Troubleshooting

**Nothing happens after you apply the label.** Check, in order: the `label_commands` block is present and its `provider` is non-empty; the applied label name matches `review_label` or `fix_label` (matching is case-insensitive); the PR is Sortie-managed, with `.sortie/scm.json` carrying `pr_number`, `owner`, and `repo`; and the linked issue has not reached a terminal state, after which commands on its PR are ignored.

**The session runs but no review or fix appears.** The prompt template is missing the `{{ if .label_review }}` (or `{{ if .label_fix }}`) branch, so the dispatch rendered your normal work prompt. Look for the load-time warning `label_commands active but prompt template has no label_review branch`, add the branch from the shipped example, and reload.

**The label never disappears after the session starts.** The label-removal write failed (a missing scope or a transport error). Sortie logs a warning and proceeds, because acceptance rests on its own record rather than on the removal. Remove the stale label manually before you issue the next command.

**`gh` returns 403 when you apply the label.** The user lacks the triage role. Grant triage or higher on the repository.

**`sortie validate` fails on the block.** You set `provider` while both `review_label` and `fix_label` are empty strings. Give at least one label a non-empty name, or remove the block.

## Related guides

- [Label commands reference](/reference/label-commands/): the full lifecycle, session posture, and authorization model
- [Reactions reference](/reference/reactions/): the event-driven feedback loops that share the reconcile tick
- [Workflow configuration reference](/reference/workflow-config/): the `reactions.label_commands` field table
- [Set up PR reactions](/guides/setup-pr-reactions/): the shared PR flow and `.sortie/scm.json` metadata
- [Setup workspace hooks](/guides/setup-workspace-hooks/): hook scripts and `.sortie/scm.json` population
- [Connect to GitHub](/guides/connect-to-github/): adapter setup and token scopes
