---
title: "How to Configure CI Feedback"
linkTitle: "Configure CI Feedback"
description: "Configure CI feedback in Sortie: detect CI failures on agent branches, inject context into prompts, tune retries and log fetching, and set escalation."
keywords: sortie ci feedback, ci failure, github actions, ci retry, agent orchestration, ci_feedback, max_retries, escalation, log fetching
author: Sortie AI
date: 2026-04-04
weight: 150
url: /guides/configure-ci-feedback/
---
CI feedback closes the loop between your CI pipeline and Sortie's agents. When a CI pipeline fails on a branch that an agent pushed, Sortie detects the failure, injects failure context into the agent's prompt, and dispatches a continuation run so the agent can fix the problem. If the agent can't fix it after repeated attempts, Sortie escalates to a human. This guide walks you through activating CI feedback, tuning its behavior, and verifying it works.

## Prerequisites

- Sortie running with the GitHub tracker adapter (`tracker.kind: github`) — see [Connect to GitHub](/guides/connect-to-github/)
- A branch-per-issue hook workflow that pushes commits — see [Setup workspace hooks](/guides/setup-workspace-hooks/)
- CI configured on the repository (GitHub Actions, or any system that reports via the Checks API)
- A GitHub personal access token with `repo` scope (needed for the Checks API)

## Activate CI feedback

CI feedback is disabled by default. Add a `ci_feedback` block with a `kind` field to your WORKFLOW.md front matter to activate it:

```yaml
ci_feedback:
  kind: github
```

There is no `enabled` flag. Presence of `kind` activates the feature; absence disables it.

Once activated, Sortie hooks into the worker exit path. After each normal worker exit where the agent pushed code, the orchestrator reads `.sortie/scm.json` from the workspace to discover the branch and commit SHA. On the next reconcile tick, it polls CI status on that ref. Three outcomes are possible:

- **Passing.** CI is green. No action taken. The CI-fix attempt counter resets to zero.
- **Pending.** Checks are still running. Sortie re-checks on the next tick.
- **Failing.** At least one check failed. Sortie dispatches a continuation run with failure context injected into the prompt.

If you don't see CI feedback triggering, check that your `after_run` hook writes `.sortie/scm.json`. Without it, Sortie has no ref to poll and skips the feature silently for that run.

## Configure retry limits

```yaml
ci_feedback:
  kind: github
  max_retries: 2  # default 2
```

`max_retries` controls how many CI-fix continuation dispatches Sortie attempts per issue before escalating. Default: 2. Set to 0 to escalate on the first CI failure without retrying.

Each CI failure that triggers a new dispatch increments the counter. If the agent fixes the issue and CI passes, the counter resets to zero. When the counter exceeds `max_retries`, Sortie escalates via the configured strategy and releases its claim on the issue.

## Configure log fetching

```yaml
ci_feedback:
  kind: github
  max_log_lines: 50  # default 50; 0 = disable
```

`max_log_lines` controls how many lines from the first failing check run's log Sortie fetches and includes in the failure context. Default: 50. Set to 0 to disable log fetching.

When log fetching is disabled, the agent still receives structured failure data (which checks failed, their names, statuses, and details URLs). It won't receive the raw log output. Disabling is useful when CI logs contain sensitive data you don't want entering agent prompts, or when you're operating at scale and want to reduce API calls. Each failing check costs one additional API request for log fetching.

## Choose an escalation strategy

```yaml
ci_feedback:
  kind: github
  escalation: label              # "label" (default) or "comment"
  escalation_label: needs-human  # default "needs-human"
```

When CI-fix retries are exhausted, Sortie escalates. Two strategies are available:

| Strategy | Behavior |
|---|---|
| `label` (default) | Adds `escalation_label` (default `needs-human`) to the issue. The label must already exist in the repository. |
| `comment` | Posts a comment on the issue with failure details: how many CI-fix attempts were made, which checks failed, and links to their detail pages. |

Both strategies release the claim on the issue and cancel any pending retry. The issue won't be re-dispatched until its tracker state changes.

`escalation_label` only applies when `escalation` is `label`. If you use `comment` escalation, you don't need this field. Create the label in advance with `gh`:

```bash
gh label create needs-human --repo myorg/myrepo --color "D93F0B"
```

## How Sortie finds the repository and branch

CI feedback needs a repository to query and a ref to check. It gets these from two sources, and you don't need extra config for either.

**Repository coordinates** come from the tracker adapter. When `tracker.kind: github`, the `tracker` block already contains `api_key` and `project` (owner/repo). CI feedback reuses these credentials. No additional configuration needed.

**Branch and SHA** come from `.sortie/scm.json` in the workspace. Your `after_run` hook writes this file after pushing code. It contains at minimum a `branch` field and optionally a `sha` field:

```json
{"branch": "sortie/PROJ-123", "sha": "abc123def456"}
```

When both `branch` and `sha` are present, Sortie uses the SHA as the ref for more deterministic results. When only `branch` is present, Sortie queries CI status by branch name.

Here's an `after_run` hook that pushes and writes the SCM metadata:

```bash
git add -A
git diff --cached --quiet || {
  git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
  git push origin "sortie/${SORTIE_ISSUE_IDENTIFIER}" --force-with-lease

  # Write SCM metadata for CI feedback
  SHA=$(git rev-parse HEAD)
  mkdir -p .sortie
  printf '{"branch":"sortie/%s","sha":"%s"}' \
    "${SORTIE_ISSUE_IDENTIFIER}" "${SHA}" > .sortie/scm.json
}
```

If `.sortie/scm.json` is absent, has an empty `branch` field, or is a symlink (rejected for security), CI feedback is skipped for that run.

## What the agent sees

On a CI-fix continuation dispatch, Sortie injects failure context into the first-turn prompt via the `{{ .ci_failure }}` template variable. This variable is `nil` on normal dispatches and non-CI retries, so your template can conditionally render it.

The `ci_failure` object contains:

| Field | Type | Description |
|---|---|---|
| `status` | string | Always `"failing"` in this context. |
| `check_runs` | list | Individual check runs with `name`, `status`, `conclusion`, `details_url`. |
| `log_excerpt` | string | Truncated log from the first failing check. Empty when log fetching is disabled. |
| `failing_count` | integer | Number of failing checks. |
| `ref` | string | The git ref (branch or SHA) that was checked. |

Add a conditional block to your prompt template:

````jinja
{{ if .ci_failure }}
## CI Failure

CI is failing on {{ .ci_failure.ref }}.
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

Diagnose the failure, fix the code, and push.
Do not modify CI configuration.
{{ end }}
````

The failure context is injected on the first turn of the CI-fix dispatch only. It persists in the agent's conversation history from turn 1, so subsequent turns within the same session don't need it repeated.

For more on template syntax, see [Write a prompt template](/guides/write-prompt-template/).

## Interaction with existing retry logic

CI-fix dispatches are distinct from error retries and continuation retries. They use a separate counter and apply independently.

| Trigger | Delay | Counter | Backoff |
|---|---|---|---|
| Agent error (crash, timeout) | Exponential backoff | `agent.max_sessions` | `agent.max_retry_backoff_ms` |
| Agent success, issue still active | 1 second | `agent.max_sessions` | None |
| CI failure on pushed branch | 1 second | `ci_feedback.max_retries` | None |

Both `ci_feedback.max_retries` and `agent.max_sessions` are evaluated independently. When either limit is exhausted, its corresponding escalation fires. CI-fix dispatches use a fixed 1-second delay, not exponential backoff, because CI failures are a signal to try fixing code, not a sign of transient infrastructure problems.

If the agent signals `blocked` via `.sortie/status` during a CI-fix run, the orchestrator respects that signal and releases the claim without further CI checks. For details on the agent-to-orchestrator protocol, see the [agent extensions reference](/reference/agent-extensions/).

Self-review and CI feedback address different failure classes at different points in the pipeline. Self-review runs inside the worker before exit, catching local issues (test failures, lint errors) with verification commands you configure. CI feedback runs after the worker exits and the code is pushed, catching integration failures reported through the CI provider's Checks API. Both features can be active simultaneously with independent counters. Self-review runs first; CI feedback runs later. If self-review passes but CI later fails, the CI feedback loop triggers normally. For self-review configuration, see [how to configure self-review](/guides/configure-self-review/).

## Complete example

A full WORKFLOW.md with CI feedback, GitHub Issues, branch-per-issue hooks, and a prompt template that renders CI failure context:

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

ci_feedback:
  kind: github
  max_retries: 2
  max_log_lines: 50
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
      mkdir -p .sortie

printf '{"branch":"sortie/%s","sha":"%s"}' \
        "${SORTIE_ISSUE_IDENTIFIER}" "${SHA}" > .sortie/scm.json
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

{{ if .run.is_continuation }}
Resuming turn {{ .run.turn_number }}/{{ .run.max_turns }}.
{{ end }}
````

## Disable log fetching for API cost control

Set `max_log_lines: 0` to skip log fetching entirely:

```yaml
ci_feedback:
  kind: github
  max_log_lines: 0
```

The agent still receives check run names, conclusions, and details URLs. Log fetching requires one additional API call per failing check; disabling it saves those requests. Useful when operating under rate limits or when your CI logs are too verbose to be helpful in a prompt.

## Verify CI feedback

Three approaches to confirm everything is wired correctly.

### Logs

Search for key messages that trace the CI feedback lifecycle:

```bash
# CI status polled and passing
grep "CI passing" sortie.log

# CI failure detected, fix dispatch scheduled
grep "CI failure detected" sortie.log

# CI fix dispatch queued
grep "scheduling CI fix dispatch" sortie.log

# Retries exhausted, escalation triggered
grep "CI fix retries exhausted" sortie.log
```

### Dashboard

When the HTTP server is running (default on port 7678), the web dashboard shows entries in `Retrying` state with a `ci_fix` trigger label. Run history entries with status `ci_failed` indicate CI failures that were detected. See the [dashboard reference](/reference/dashboard/).

### Prometheus metrics

Three CI-related metrics are available when the HTTP server is running (default on port 7678):

| Metric | Labels | Description |
|---|---|---|
| `sortie_ci_status_checks_total` | `result` (`passing`, `pending`, `failing`, `error`) | CI status poll outcomes. |
| `sortie_ci_escalations_total` | `action` (`label`, `comment`, `error`) | Escalation actions taken. |
| `sortie_retries_total` | `trigger` (`ci_fix`) | CI-fix dispatches scheduled. |

A healthy CI feedback setup shows `sortie_ci_status_checks_total{result="passing"}` climbing steadily, with occasional `failing` bumps that correlate with `sortie_retries_total{trigger="ci_fix"}` increments. Persistent `error` results on the status check metric indicate a token or permissions problem. For the full metrics catalog, see [Prometheus metrics reference](/reference/prometheus-metrics/).

## Configuration reference

All `ci_feedback` fields in one place:

| Field | Type | Default | Description |
|---|---|---|---|
| `kind` | string | _(absent)_ | CI provider adapter. Currently `"github"`. Presence activates the feature. |
| `max_retries` | integer | `2` | Max CI-fix dispatches per issue before escalation. `0` = escalate immediately. |
| `max_log_lines` | integer | `50` | Lines to fetch from the first failing check's log. `0` = disable log fetching. |
| `escalation` | string | `"label"` | Escalation strategy: `"label"` or `"comment"`. |
| `escalation_label` | string | `"needs-human"` | Label to apply when `escalation` is `"label"`. Must exist in the repo. |

For the full WORKFLOW.md configuration reference including all sections, see [workflow config reference](/reference/workflow-config/).

## Related guides

- [Configure retry behavior](/guides/configure-retry-behavior/) — `max_sessions`, backoff, stall detection
- [Connect to GitHub](/guides/connect-to-github/) — GitHub adapter setup, token scopes
- [Setup workspace hooks](/guides/setup-workspace-hooks/) — hook scripts, environment variables
- [Write a prompt template](/guides/write-prompt-template/) — template syntax, `{{ .ci_failure }}` variable
- [Agent extensions reference](/reference/agent-extensions/) — `.sortie/status` protocol
- [State machine reference](/reference/state-machine/) — claim lifecycle, retry states
- [Prometheus metrics reference](/reference/prometheus-metrics/) — CI-related metrics
- [Error reference](/reference/errors/) — CI error kinds
