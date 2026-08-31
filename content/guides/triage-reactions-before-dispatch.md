---
title: How to Triage a Reaction Before It Dispatches an Agent
linkTitle: "Triage Reactions Before Dispatch"
description: "Run your own script when a CI failure, review comment, bot comment, or merge conflict arrives, and close it, escalate it, or hand it to the agent."
author: Sortie AI
date: 2026-08-31
weight: 148
url: /guides/triage-reactions-before-dispatch/
---
Not every signal a reaction picks up needs a coding agent. A failing job that only ever fails for reasons outside the pull request wants a person, not a fix attempt. A conflict that a plain rebase clears wants a rebase. A `triage` command lets you make that call yourself, in a script, before Sortie spends a session on it.

The command runs in the issue workspace the moment the reaction finds something new to act on, and answers one of three things: `handled` (the subject is dealt with, keep watching), `escalate` (a person is needed now), or `dispatch-agent` (proceed as usual). Anything that goes wrong falls back to `dispatch-agent`, so a broken script costs one warning and one agent turn.

## Prerequisites

- A working reaction of one of the four kinds that accept the block: `ci_failure`, `review_comments`, `bot_review`, or `merge_conflicts`. See [set up PR reactions](/guides/setup-pr-reactions/) for the shared machinery.
- A workspace that already exists for the issue. Sortie does not create one for a triage run, so the reaction must be watching a pull request an agent produced from that workspace.
- `jq`, or another way to read JSON, on the orchestrator host. Triage scripts inherit the same restricted environment as workspace hooks, so anything the script calls has to be reachable through `PATH`.

## Add the triage block

The block goes inside the reaction kind, alongside `provider` and the budget field:

```yaml
reactions:
  ci_failure:
    provider: github
    max_retries: 2
    escalation: label
    escalation_label: needs-human
    triage:
      script: |
        ./scripts/ci-triage.sh
      timeout_ms: 30000
```

`script` is a shell script body, exactly like a [workspace hook](/guides/setup-workspace-hooks/). Keeping the real logic in a file under version control, and calling it from one line here, keeps the workflow file readable and lets you test the script on its own.

The command's working directory is the per-issue workspace, so the relative path above resolves inside the checked-out repository and the script travels with the code it triages. An absolute path to a script on the orchestrator host works too, and is the better choice when the same script serves several repositories.

`timeout_ms` defaults to 60 seconds and has a ceiling of 600000 (10 minutes). Set it to what your script actually needs. A run that overruns is killed, along with everything it started, and falls back to `dispatch-agent`.

The block is read once when Sortie starts. Editing it does not reload, not even under `ci_failure`, so restart after you change it.

## Read the subject

Sortie writes a JSON file describing what the reaction found and puts its path in `SORTIE_REACTION_INPUT`. Which reaction armed is in `SORTIE_REACTION_KIND`.

```sh
#!/bin/sh
# scripts/ci-triage.sh
set -eu

kind=$(jq -r '.reaction_kind' "$SORTIE_REACTION_INPUT")
ref=$(jq -r '.subject.ref' "$SORTIE_REACTION_INPUT")

echo "triaging $kind on $ref"
```

For `ci_failure` the `subject` object carries `status`, `check_runs`, `log_excerpt`, `failing_count`, and `ref`. Every kind's `subject` is the same value its continuation prompt would have received, so the script sees what the agent would have seen. The full document is in the [triage command reference](/reference/reactions/#input-document).

## Answer with a disposition

Write one JSON object to the path in `SORTIE_REACTION_RESULT` and exit 0:

```sh
printf '{"disposition":"escalate"}\n' > "$SORTIE_REACTION_RESULT"
```

Exit 0 plus a well-formed file is the only way to reach an answer other than `dispatch-agent`. A non-zero exit is never honored, even when the file holds a valid answer, so write the file last and let a failure anywhere earlier fall through to the agent.

## Escalate a failure the agent cannot fix

Here is the whole script. It escalates when every failing check is one of the jobs that fail for reasons outside the pull request, and otherwise hands the failure to the agent:

```sh
#!/bin/sh
# scripts/ci-triage.sh
set -eu

# Jobs whose failure is never something a code change fixes.
INFRA_CHECKS='deploy-staging|license-audit'

failing=$(jq -r '
  .subject.check_runs[]
  | select(.conclusion == "failure" or .conclusion == "timed_out")
  | .name
' "$SORTIE_REACTION_INPUT")

if [ -z "$failing" ]; then
  printf '{"disposition":"dispatch-agent"}\n' > "$SORTIE_REACTION_RESULT"
  exit 0
fi

if echo "$failing" | grep -qvE "^($INFRA_CHECKS)$"; then
  # At least one failing check is ordinary. Let the agent fix it.
  printf '{"disposition":"dispatch-agent"}\n' > "$SORTIE_REACTION_RESULT"
else
  echo "only infrastructure checks failed: $failing"
  printf '{"disposition":"escalate"}\n' > "$SORTIE_REACTION_RESULT"
fi
```

An `escalate` answer applies the kind's configured `escalation` right away. With `escalation: label` the issue gets `needs-human`. With `escalation: comment` Sortie posts a comment saying the triage command asked for a person, and names the ref. Either way no retry budget is spent, so the reaction has not burned an attempt on a failure it could not have fixed.

Make the script executable, commit it, and restart Sortie so the new block is read:

```bash
chmod +x scripts/ci-triage.sh
git add scripts/ci-triage.sh && git commit -m "add CI triage script"
```

## Verify it ran

Watch the log. Every run writes a start record and a completion record, both carrying the issue and the fingerprint of the subject:

```
level=INFO msg="reaction triage started" issue_id=10432 issue_identifier=MT-649 reaction_kind=ci fingerprint=5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4 timeout_ms=30000
level=INFO msg="reaction triage completed" issue_id=10432 issue_identifier=MT-649 reaction_kind=ci fingerprint=5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4 disposition=escalate elapsed_ms=412
level=INFO msg="reaction triage applied" issue_id=10432 issue_identifier=MT-649 reaction_kind=ci fingerprint=5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4 disposition=escalate
```

`completed` is written when the command returns. `applied` is written when a later reconcile pass acts on the answer, which is the point at which the escalation fires or the agent is dispatched. Seeing `completed` without `applied` means the answer is waiting for the next pass, or the subject changed underneath it and the answer was thrown away.

When something goes wrong, `completed` is a WARN instead, and carries the reason under `fallback` plus the last 8 KiB of the script's combined output under `hook_output`:

```
level=WARN msg="reaction triage completed" issue_id=10432 issue_identifier=MT-649 reaction_kind=ci fingerprint=5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4 disposition=dispatch-agent elapsed_ms=30004 fallback=timeout hook_output="triaging ci on 5c1f0b7a9d3e46281af7c40b9e2d6538ca10b7f4"
```

Grep for `reaction triage` to see all of it at once:

```bash
sortie ./WORKFLOW.md 2>&1 | grep "reaction triage"
```

## Answer `handled` only when you mean it

`handled` tells Sortie the subject is dealt with. Nothing re-checks that claim. The reaction marks the fingerprint dispatched and keeps watching, so until the fingerprint moves, neither an agent turn nor an escalation will happen for that subject.

That makes `handled` the right answer for a script that actually did the work:

```sh
#!/bin/sh
# scripts/conflict-triage.sh
set -eu

# A rebase interrupted by a timeout leaves the tree mid-rebase. Clear it
# before starting, so a killed run never blocks the next one.
git rebase --abort 2>/dev/null || true

base=$(jq -r '.subject.base' "$SORTIE_REACTION_INPUT")
git fetch origin "$base"

if git rebase "origin/$base"; then
  git push --force-with-lease origin HEAD
  printf '{"disposition":"handled"}\n' > "$SORTIE_REACTION_RESULT"
else
  git rebase --abort
  printf '{"disposition":"dispatch-agent"}\n' > "$SORTIE_REACTION_RESULT"
fi
```

Two properties make this safe, and both are worth copying into any script that writes:

**It survives being killed at any instruction.** Sortie kills the command and everything it started when `timeout_ms` elapses, when a new commit changes the subject underneath it, when the episode ends, and at shutdown. The `git rebase --abort` on entry means a run killed mid-rebase leaves nothing for the next one to trip over.

**It can be run twice for the same work.** A killed run, a run whose subject moved, and any run that was in flight when the process restarted are each followed by a fresh run. Triage state is never written to the database, so a restart re-triages the subject from scratch. A rebase that finds nothing to rebase is a no-op, which is what makes repetition harmless here.

> [!WARNING]
> A `ci_failure` script that pushes needs a stopping condition of its own. That kind's watch window is measured from the last recorded head, and pushing records a new one, so a script that answers `handled` on head after head it pushed itself resets the clock every time: no agent turn, no escalation, and no expiry. Count your own attempts, in a file in the workspace or in a commit trailer, and answer `dispatch-agent` or `escalate` once you have had enough.

## Troubleshooting

**Every run reports `fallback=workspace_missing`.** The per-issue workspace directory is gone. Sortie never creates one for a triage run, on purpose: creating it would make the next dispatch treat an empty tree as an existing workspace and skip the `after_create` hook. Check `workspace.retention_days` and whether the periodic sweep removed the directory.

**`fallback=no_result`.** The script exited 0 without writing to `SORTIE_REACTION_RESULT`. A common cause is writing to a path the script computed itself rather than to the variable, or redirecting output into a file inside the workspace.

**`fallback=unknown_disposition`.** The file parsed but `disposition` was not `handled`, `dispatch-agent`, or `escalate`. Check for a typo, and note that the value is compared after trimming whitespace but is otherwise exact and lowercase.

**`fallback=exit_status` on a script that seems to work.** `set -e` plus a command that legitimately returns non-zero, such as a `grep` that matches nothing, ends the script before it writes. Guard those calls with `|| true`.

**The command never runs at all.** Check that the block is under one of the four kinds that accept it, and that Sortie was restarted after the edit. [`sortie validate`](/reference/cli/#validate) rejects a `triage` block under any other reaction kind before dispatch.

**The reaction escalated on a spent budget without running the script.** `review_comments` and `bot_review` check their continuation-turn cap before triage, so a subject that arrives with the budget already gone escalates without invoking the command. `ci_failure` and `merge_conflicts` run the command first.

## Related guides

- [Reactions reference](/reference/reactions/#triage-command): every field, both document schemas, and the full list of fallback reasons
- [Environment variables reference](/reference/environment/#reaction-triage-command-variables): the three variables the command receives and the restricted environment it runs in
- [Set up PR reactions](/guides/setup-pr-reactions/): the `reactions` block, PR metadata, and forge tokens
- [Configure CI feedback](/guides/configure-ci-feedback/): the `ci_failure` kind in full
- [Set up workspace hooks](/guides/setup-workspace-hooks/): the same execution model, for the workspace lifecycle
