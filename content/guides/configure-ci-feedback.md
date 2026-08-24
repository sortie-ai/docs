---
title: "How to Configure CI Feedback"
linkTitle: "Configure CI Feedback"
description: "Configure CI feedback in Sortie: detect CI failures on agent branches, inject context into prompts, tune retries and log fetching, and set escalation."
author: Sortie AI
date: 2026-04-04
weight: 150
url: /guides/configure-ci-feedback/
---
CI feedback closes the loop between your CI pipeline and Sortie's agents. When a CI pipeline fails on a branch that an agent pushed, Sortie detects the failure, injects failure context into the agent's prompt, and dispatches a continuation run so the agent can fix the problem. If the agent can't fix it after repeated attempts, Sortie escalates to a human. This guide walks you through activating CI feedback, tuning its behavior, and verifying it works.

## Prerequisites

- Sortie running with the GitHub, Gitea, or GitLab tracker adapter (`tracker.kind: github`, `gitea`, or `gitlab`), see [Connect to GitHub](/guides/connect-to-github/), [Connect to Gitea](/guides/connect-to-gitea/), or [Connect to GitLab](/guides/connect-to-gitlab/)
- A branch-per-issue hook workflow that pushes commits — see [Setup workspace hooks](/guides/setup-workspace-hooks/)
- CI configured on the repository (GitHub Actions, Gitea Actions, GitLab CI/CD, or any system that reports through the forge's status API)
- An access token with the scope the CI provider needs for its status route: GitHub needs `repo`; see the [GitLab adapter reference](/reference/adapter-gitlab/#scm-and-ci-surface) and the [Gitea adapter reference](/reference/adapter-gitea/#scm-and-ci-surface) for their scopes
- A source-control adapter, resolved from `reactions.ci_failure.provider` when no other [PR reaction](/guides/setup-pr-reactions/) configures one; every active reaction's provider must then agree, or `sortie validate` reports a mismatch offline and Sortie exits at startup

## Activate CI feedback

CI feedback is disabled by default. Add a `reactions.ci_failure` block with a `provider` field to your WORKFLOW.md front matter to activate it:

```yaml
reactions:
  ci_failure:
    provider: github
```

There is no `enabled` flag. Presence of `provider` activates the feature; absence disables it.

An older `ci_feedback` top-level block (with a `kind` field instead of `provider`) still works but is deprecated: Sortie logs a startup warning and folds it into `reactions.ci_failure` internally. If both are present, `reactions.ci_failure` wins. Write new WORKFLOW.md files against `reactions.ci_failure` directly.

Once activated, Sortie hooks into the worker exit path. After each normal worker exit where the agent pushed code and the workspace's `.sortie/scm.json` carries a pull request number, an owner, a repository, and a branch, the orchestrator records a pending CI watch for that pull request. On each reconcile tick, it resolves the pull request's current head and polls CI status for that head. Three common outcomes:

- **Passing.** CI is green. The CI-fix attempt counter resets to zero, and Sortie keeps watching that pull request, so a commit pushed afterward is still observed.
- **Pending.** Checks are still running. Sortie re-checks on the next tick.
- **Failing.** At least one check failed. Sortie dispatches a continuation run with failure context injected into the prompt.

The watch is bounded by `watch_window_ms` (default twenty-four hours), measured from the pull request's last recorded commit rather than from when the watch started. Reaching that age drops the entry with a log warning and no escalation; a value of `0` removes the bound.

If you don't see CI feedback triggering, check that your `after_run` hook writes `.sortie/scm.json` with `pr_number`, `owner`, `repo`, and `branch` all present. A workspace whose metadata carries a branch but no pull request identity logs `ci watch not seeded: workspace metadata missing pull request identity` at debug level; grep your logs for it to confirm this is the cause.

## Configure retry limits

```yaml
reactions:
  ci_failure:
    provider: github
    max_retries: 2  # default 2
```

`max_retries` controls how many CI-fix continuation dispatches Sortie attempts per issue before escalating. Default: 2. Set to 0 to escalate on the first CI failure without retrying.

Each CI failure that triggers a new dispatch increments the counter. If the agent fixes the issue and CI passes, the counter resets to zero. When the counter exceeds `max_retries`, Sortie escalates via the configured strategy and releases its claim on the issue. A commit landing on the pull request afterward restores the attempt budget when Sortie can establish that the commit is not its own work, so an agent cannot extend its own budget by pushing; applying the configured fix label re-arms an escalated pull request by hand.

## Configure log fetching

```yaml
reactions:
  ci_failure:
    provider: github
    max_log_lines: 50  # default 50; 0 = disable
```

`max_log_lines` controls how many lines from the first failing check run's log Sortie fetches and includes in the failure context. Default: 50. Set to 0 to disable log fetching.

When log fetching is disabled, the agent still receives structured failure data (which checks failed, their names, statuses, and details URLs). It won't receive the raw log output. Disabling is useful when CI logs contain sensitive data you don't want entering agent prompts, or when you're operating at scale and want to reduce API calls. Each failing check costs one additional API request for log fetching.

## Choose an escalation strategy

```yaml
reactions:
  ci_failure:
    provider: github
    escalation: label              # "label" (default) or "comment"
    escalation_label: needs-human  # default "needs-human"
```

When CI-fix retries are exhausted, Sortie escalates. Two strategies are available:

| Strategy | Behavior |
|---|---|
| `label` (default) | Adds `escalation_label` (default `needs-human`) to the issue. The Gitea and GitLab adapters create the label on demand if the tracker does not already have it; on GitHub, the label must already exist. |
| `comment` | Posts a comment on the issue with failure details: how many CI-fix attempts were made, which checks failed, and links to their detail pages. |

Both strategies release the claim on the issue and cancel any pending retry. The issue won't be re-dispatched until its tracker state changes.

`escalation_label` only applies when `escalation` is `label`. If you use `comment` escalation, you don't need this field. Create the label in advance with `gh`:

```bash
gh label create needs-human --repo myorg/myrepo --color "D93F0B"
```

## How Sortie finds the repository and branch

CI feedback needs a repository to query and a ref to check. It gets these from two sources, and you don't need extra config for either.

**Repository coordinates** come from the tracker adapter. When `reactions.ci_failure.provider` matches `tracker.kind`, the `tracker` block already contains `api_key` and `project` (owner/repo for GitHub and Gitea, a namespace path or numeric ID for GitLab). CI feedback reuses these credentials. No additional configuration needed.

**The pull request identity** comes from `.sortie/scm.json` in the workspace. Your `after_run` hook writes this file after pushing code and opening the pull request. CI feedback needs `pr_number`, `owner`, and `repo` alongside `branch`; all four fields must be present for Sortie to seed a CI watch, and `branch` and `sha` alone do not qualify:

```json
{"branch": "sortie/PROJ-123", "sha": "abc123def456", "pushed_at": "2026-04-10T12:00:00Z", "pr_number": 42, "owner": "myorg", "repo": "myrepo"}
```

Once the watch is seeded, the orchestrator resolves the pull request's current head itself, through the SCM adapter, on every poll, rather than reading a ref recorded once. The `pushed_at` timestamp is used only by startup recovery for handoff-stage issues — it determines whether a previously pushed branch is still fresh enough to re-poll after a restart. If absent, recovery falls back to the agent run's `completed_at` time. See [Resume sessions across restarts](/guides/resume-sessions-across-restarts/) for the recovery model.

Here's an `after_run` hook that pushes, opens a pull request, and writes the SCM metadata:

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
    --title "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes" \
    --body "Automated PR for ${SORTIE_ISSUE_IDENTIFIER}" \
    2>/dev/null || gh pr view "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
    --repo myorg/myrepo --json url -q .url 2>/dev/null)
  PR_NUMBER=$(echo "$PR_URL" | grep -oP '\d+$')
  PUSHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  mkdir -p .sortie
  cat > .sortie/scm.json <<EOF
{"branch":"sortie/${SORTIE_ISSUE_IDENTIFIER}","sha":"${SHA}","pushed_at":"${PUSHED_AT}","pr_number":${PR_NUMBER:-0},"owner":"myorg","repo":"myrepo"}
EOF
}
```

If `.sortie/scm.json` is absent, is missing the pull request identity, or is a symlink (rejected for security), CI feedback is skipped for that run.

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
| CI failure on pushed branch | 1 second | `reactions.ci_failure.max_retries` | None |

Both `reactions.ci_failure.max_retries` and `agent.max_sessions` are evaluated independently. When either limit is exhausted, its corresponding escalation fires. CI-fix dispatches use a fixed 1-second delay, not exponential backoff, because CI failures are a signal to try fixing code, not a sign of transient infrastructure problems.

If the agent signals `blocked` via `.sortie/status` during a CI-fix run, the orchestrator respects that signal and stops running further CI checks. A CI-fix continuation runs as an ordinary agent session, so it drives the issue's state like any normal dispatch, and the issue is [parked](/concepts/agent-communication/) with the escalation label rather than merely released. For details on the agent-to-orchestrator protocol, see the [agent extensions reference](/reference/agent-extensions/).

Self-review and CI feedback address different failure classes at different points in the pipeline. Self-review runs inside the worker before exit, catching local issues (test failures, lint errors) with verification commands you configure. CI feedback runs after the worker exits and the code is pushed, catching integration failures reported through the CI provider's status API. Both features can be active simultaneously with independent counters. Self-review runs first; CI feedback runs later. If self-review passes but CI later fails, the CI feedback loop triggers normally. For self-review configuration, see [how to configure self-review](/guides/configure-self-review/).

Unattended CI recovery follows the pull request's head for as long as the watch window allows. A commit that lands on the pull request after a passing result is evaluated like any other.

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
  command: claude
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
      PUSHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      mkdir -p .sortie

      printf '{"branch":"sortie/%s","sha":"%s","pushed_at":"%s"}' \
        "${SORTIE_ISSUE_IDENTIFIER}" "${SHA}" "${PUSHED_AT}" > .sortie/scm.json
    }
  timeout_ms: 120000

db_path: .sortie.db
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
reactions:
  ci_failure:
    provider: github
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

A healthy CI feedback setup shows `sortie_ci_status_checks_total{result="passing"}` incrementing on every poll for as long as the watch continues, since a passing result keeps the pull request under watch rather than ending it. Expect occasional `failing` bumps that correlate with `sortie_retries_total{trigger="ci_fix"}` increments. Persistent `error` results on the status check metric indicate a token or permissions problem. For the full metrics catalog, see [Prometheus metrics reference](/reference/prometheus-metrics/).

## Configuration reference

For the full `reactions.ci_failure` field list, including `watch_window_ms` and its reload behavior, see the [reactions reference](/reference/reactions/#reactionsci_failure). The deprecated `ci_feedback` block (a `kind` field instead of `provider`, no `watch_window_ms`) is documented in the [workflow config reference](/reference/workflow-config/) for existing WORKFLOW.md files that have not migrated yet.

## Related guides

- [Configure retry behavior](/guides/configure-retry-behavior/) — `max_sessions`, backoff, stall detection
- [Connect to GitHub](/guides/connect-to-github/) — GitHub adapter setup, token scopes
- [Setup workspace hooks](/guides/setup-workspace-hooks/) — hook scripts, environment variables
- [Write a prompt template](/guides/write-prompt-template/) — template syntax, `{{ .ci_failure }}` variable
- [Agent extensions reference](/reference/agent-extensions/) — `.sortie/status` protocol
- [State machine reference](/reference/state-machine/) — claim lifecycle, retry states
- [Prometheus metrics reference](/reference/prometheus-metrics/) — CI-related metrics
- [Error reference](/reference/errors/) — CI error kinds
