---
title: "How to Configure PR Review Feedback | Sortie"
linkTitle: "Configure Review Feedback"
description: "Configure PR review feedback in Sortie: detect Request changes comments, route them to the agent, tune debounce and retries, and set escalation."
keywords: sortie review feedback, pr review, changes requested, code review, reactions, review_comments, agent orchestration, continuation
author: Sortie AI
date: 2026-04-10
weight: 160
url: /guides/configure-review-feedback/
---
Review feedback routing closes the outer loop of agent-driven development. When a human reviewer leaves inline comments on a Sortie-created PR and submits the review with the "Request changes" verdict (the submit button in GitHub's review UI), Sortie detects those comments, assembles structured context (file paths, line ranges, reviewer names, comment bodies), and dispatches a continuation turn so the agent can address the feedback and push fixes. Without it, review comments sit on the PR until someone manually re-assigns the issue. With it, turnaround drops from hours to minutes.

## Prerequisites

- Sortie running with the GitHub tracker adapter (`tracker.kind: github`) or a GitHub-compatible SCM provider
- An agent adapter that creates PRs and writes `pr_number`, `owner`, and `repo` to `.sortie/scm.json` (see [Setup workspace hooks](/guides/setup-workspace-hooks/))
- A GitHub personal access token with `repo` scope

## Activate review feedback

Review feedback is off by default. Add a `reactions.review_comments` block to your WORKFLOW.md front matter:

```yaml
reactions:
  review_comments:
    provider: github
```

There is no `enabled` flag. Presence of the `reactions.review_comments` block with a `provider` activates the feature; absence disables it.

Once activated, review polling kicks in after each normal worker exit where the workspace's `.sortie/scm.json` contains `pr_number`, `owner`, and `repo`. Sortie only reacts to reviews submitted with the "Request changes" verdict in GitHub's UI. Reviews submitted as "Comment" or "Approve" are ignored. All three `scm.json` fields are required. If any is missing or zero-valued, Sortie skips review polling for that workspace silently. Existing workspaces that predate the feature are unaffected.

Your `after_run` hook or agent workflow writes these fields. Here's what `.sortie/scm.json` looks like:

```json
{
  "branch": "feat/PROJ-123",
  "sha": "abc1234",
  "pushed_at": "2026-04-10T12:00:00Z",
  "pr_number": 42,
  "owner": "myorg",
  "repo": "myproject"
}
```

The `branch` and `sha` fields drive CI feedback (if configured). The `pr_number`, `owner`, and `repo` fields drive review feedback. Both features read from the same file.

## Configure retry limits and escalation

```yaml
reactions:
  review_comments:
    provider: github
    max_retries: 2
    escalation: label
    escalation_label: needs-human
```

| Field | Default | Description |
|---|---|---|
| `max_retries` | `2` | Maximum review-fix continuation turns per issue before escalation. |
| `escalation` | `"label"` | Action when retries are exhausted: `"label"` or `"comment"`. |
| `escalation_label` | `"needs-human"` | Label applied when `escalation` is `"label"`. Must exist in the repo. |

`max_retries` counts continuation turns triggered specifically by review comments, independent of the agent's `max_sessions` budget and CI feedback's retry counter. If the agent addresses all comments within this budget, the loop ends. If not, Sortie escalates and releases its claim.

With strategy `label`, Sortie adds the configured label to the issue. With `comment`, it posts a comment noting how many turns were attempted and that remaining comments need human attention. Both strategies cancel any pending retry and release the claim.

Create the label in advance if using label escalation:

```bash
gh label create needs-human --repo myorg/myrepo --color "D93F0B"
```

## Configure polling and debounce

```yaml
reactions:
  review_comments:
    provider: github
    poll_interval_ms: 120000
    debounce_ms: 60000
    max_continuation_turns: 3
```

| Field | Default | Description |
|---|---|---|
| `poll_interval_ms` | `120000` (2 min) | Minimum interval between review comment polls per issue. Minimum allowed: 30000. |
| `debounce_ms` | `60000` (60 sec) | Wait time after the newest detected comment before dispatching. |
| `max_continuation_turns` | `3` | Hard cap on review-triggered continuation turns per PR. |

Debounce prevents premature dispatch while a reviewer is still commenting. A reviewer posts 2 inline comments, Sortie detects them on the next poll, and starts a 60-second timer from the newest comment's timestamp. If the reviewer posts 2 more within that window, the timer resets. Once 60 seconds pass with no new comments, Sortie dispatches all comments in one batch.

`poll_interval_ms` throttles how often Sortie hits the GitHub Reviews API per tracked PR. The 2-minute default balances responsiveness and API rate budget. If you're tracking many PRs, consider raising it. The minimum is 30 seconds.

`max_continuation_turns` prevents infinite reviewer-agent ping-pong. When the cap is hit, Sortie escalates and a human takes over.

## How the review loop works

1. The agent completes coding and pushes a PR. The `after_run` hook writes `pr_number`, `owner`, and `repo` to `.sortie/scm.json`.
2. On normal worker exit, the orchestrator reads this metadata and creates a pending review reaction. Polling begins on the next reconcile tick.
3. A reviewer submits a "Request changes" review (GitHub API state `CHANGES_REQUESTED`) with inline comments. Reviews submitted as "Comment" or "Approve" do not trigger the loop.
4. Sortie detects the comments on its next poll after the debounce window expires.
5. Outdated comments (on lines the agent already changed) and bot comments (`user.type == "Bot"`) are filtered out.
6. Sortie builds a fingerprint from the remaining comment IDs. If this fingerprint was already dispatched, it skips (deduplication).
7. Sortie dispatches a continuation turn with the review comments as structured prompt context.
8. The agent addresses the comments, commits, and pushes fixes.
9. If the reviewer approves, polling stops on the next state change. If the reviewer requests more changes, the cycle repeats from step 3, up to `max_continuation_turns`.
10. If the turn cap is reached, Sortie escalates and releases the claim.

## What the agent sees

The agent receives review comments through the `review_comments` template variable. Add a conditional block to your prompt template:

```
{{ if .review_comments }}
## Review Comments to Address

The following review comments were left on your PR. Address each one:

{{ range .review_comments }}
### {{ .reviewer }} on {{ .file }}{{ if .start_line }} (line {{ .start_line }}{{ if .end_line }}-{{ .end_line }}{{ end }}){{ end }}

{{ .body }}

{{ end }}
{{ end }}
```

The variable is `nil` on non-review turns, so the block renders only when review comments are present. PR-level comments (not attached to a specific file) have an empty `file` and zero line numbers.

Each comment exposes:

| Field | Type | Description |
|---|---|---|
| `id` | string | SCM platform comment ID. |
| `file` | string | Relative file path. Empty for PR-level comments. |
| `start_line` | int | First line of the commented range. `0` for PR-level comments. |
| `end_line` | int | Last line of the range. `0` for single-line or PR-level comments. |
| `reviewer` | string | Username of the comment author. |
| `body` | string | The comment text. |

For template syntax details, see [Write a prompt template](/guides/write-prompt-template/).

## Interaction with CI feedback

Review feedback and CI feedback are independent reaction types. They have separate retry budgets, separate fingerprints, separate poll intervals, and separate escalation policies. Both can be active on the same issue simultaneously, and they do not interfere with each other.

CI feedback detects pipeline failures on pushed branches. Review feedback detects human reviewer comments on PRs. If both fire on the same issue (CI fails and a reviewer requests changes), each dispatches its own continuation turn with its own context. The agent receives `{{ .ci_failure }}` on CI-triggered turns and `{{ .review_comments }}` on review-triggered turns.

For CI feedback configuration, see [Configure CI feedback](/guides/configure-ci-feedback/).

## Interaction with self-review

Self-review and review feedback operate at different lifecycle phases. Self-review runs inside the worker before exit, catching local issues (test failures, lint errors) with verification commands you configure. Review feedback runs after the worker exits, during the orchestrator's reconcile loop, catching human feedback left on the PR.

They do not conflict. Self-review catches problems before the PR is opened; review feedback handles comments after. Both can be active at the same time.

For self-review configuration, see [Configure self-review](/guides/configure-self-review/).

## Complete example

A full WORKFLOW.md with review feedback, CI feedback, GitHub Issues, and a prompt template that handles both continuation types:

````yaml
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]
  handoff_state: review
  in_progress_state: in-progress
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true

agent:
  kind: claude-code
  max_turns: 5
  max_sessions: 3
  max_concurrent_agents: 2
  stall_timeout_ms: 300000

reactions:
  ci_failure:
    provider: github
    max_retries: 2
    max_log_lines: 50
    escalation: label
    escalation_label: needs-human
  review_comments:
    provider: github
    max_retries: 2
    poll_interval_ms: 120000
    debounce_ms: 60000
    max_continuation_turns: 3
    escalation: label
    escalation_label: needs-human

hooks:
  after_create: |
    git clone --depth 1 "https://${SORTIE_GITHUB_TOKEN}@github.com/myorg/myrepo.git" .
  before_run: |
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
  after_run: |
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
        2>/dev/null || gh pr view \
        --repo myorg/myrepo \
        "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
        --json url -q .url 2>/dev/null)
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
  timeout_ms: 120000

db_path: .sortie.db
server:
  port: 8642
---

You are a senior engineer working on {{ .issue.identifier }}.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ if .issue.description }}
{{ .issue.description }}
{{ end }}

{{ if .ci_failure }}
## CI Failure

CI is failing on branch {{ .ci_failure.ref }}.
{{ .ci_failure.failing_count }} check(s) failed.

{{ if .ci_failure.log_excerpt }}
Failure log excerpt:
```
{{ .ci_failure.log_excerpt }}
```
{{ end }}

{{ range .ci_failure.check_runs }}{{ if eq .conclusion "failure" }}
- {{ .name }}: FAILED{{ if .details_url }} ({{ .details_url }}){{ end }}
{{ end }}{{ end }}

Diagnose the CI failure and fix the code. Do not modify CI workflow files.
{{ end }}

{{ if .review_comments }}
## Review Comments to Address

A human reviewer left feedback on your PR. Address each comment:

{{ range .review_comments }}
### {{ .reviewer }} on {{ .file }}{{ if .start_line }} (line {{ .start_line }}{{ if .end_line }}-{{ .end_line }}{{ end }}){{ end }}

{{ .body }}

{{ end }}

After addressing all comments, commit and push your changes.
{{ end }}

{{ if .run.is_continuation }}
Resuming turn {{ .run.turn_number }}/{{ .run.max_turns }}.
{{ end }}
````

The `after_run` hook creates a PR (or finds the existing one), extracts the PR number, and writes all required fields to `.sortie/scm.json`. This populates the data that both CI feedback and review feedback need.

## Verify review feedback

Four approaches to confirm the feature is working.

### Logs

Search for key messages that trace the review feedback lifecycle:

```bash
# Review comments detected and dispatch scheduled
grep "review comments detected" sortie.log

# Debounce active: comments within the window
grep "review comments within debounce window" sortie.log

# Fingerprint already dispatched: deduplication working
grep "review comments already dispatched for this fingerprint" sortie.log

# Turn cap exhausted, escalation triggered
grep "review fix continuation turns exhausted" sortie.log
```

### Dashboard and status API

When the HTTP server is running, the runtime snapshot shows `PendingReactions` entries with kind `review`. Issues with active review polling appear with their current debounce state and attempt count.

### Prometheus metrics

Two review-specific metrics are available when the HTTP server is enabled:

| Metric | Labels | Description |
|---|---|---|
| `sortie_review_checks_total` | `result` (`dispatched`, `error`, `skipped`) | Review comment poll outcomes. |
| `sortie_review_escalations_total` | `action` (`label`, `comment`, `error`) | Escalation events. |

A healthy setup shows `sortie_review_checks_total{result="dispatched"}` incrementing when review comments arrive, with `error` counts staying flat. Persistent errors on the poll metric indicate a token or permissions problem. For the full metrics catalog, see [Prometheus metrics reference](/reference/prometheus-metrics/).

### SQLite fingerprints

The `reaction_fingerprints` table tracks which comment sets have been dispatched. This is what prevents duplicate dispatches across reconcile ticks and process restarts:

```bash
sqlite3 sortie.db "SELECT * FROM reaction_fingerprints WHERE kind='review'"
```

Each row shows the issue ID, the `review` kind, the SHA-256 fingerprint of comment IDs, and whether it has been dispatched.

## Configuration reference

All `reactions.review_comments` fields in one place:

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | string | _(required)_ | SCM adapter kind. Currently `"github"`. Presence activates the feature. |
| `max_retries` | integer | `2` | Max review-fix dispatches per issue before escalation. |
| `escalation` | string | `"label"` | Escalation strategy: `"label"` or `"comment"`. |
| `escalation_label` | string | `"needs-human"` | Label applied when `escalation` is `"label"`. Must exist in the repo. |
| `poll_interval_ms` | integer | `120000` | Minimum ms between review polls per issue. Min: `30000`. |
| `debounce_ms` | integer | `60000` | Ms to wait after newest comment before dispatching. |
| `max_continuation_turns` | integer | `3` | Hard cap on review-triggered continuation turns. |

For the full WORKFLOW.md configuration reference including all sections, see [workflow config reference](/reference/workflow-config/).

## Related guides

- [Configure CI feedback](/guides/configure-ci-feedback/): CI pipeline failure detection and agent retry loop
- [Configure self-review](/guides/configure-self-review/): pre-PR agent review with verification commands
- [Configure retry behavior](/guides/configure-retry-behavior/): `max_sessions`, backoff, stall detection
- [Setup workspace hooks](/guides/setup-workspace-hooks/): hook scripts, `scm.json` population, environment variables
- [Write a prompt template](/guides/write-prompt-template/): template syntax, continuation context keys
- [Connect to GitHub](/guides/connect-to-github/): GitHub adapter setup, token scopes
- [Prometheus metrics reference](/reference/prometheus-metrics/): review and escalation metrics
- [Workflow config reference](/reference/workflow-config/): `reactions.review_comments` field reference
