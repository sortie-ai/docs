---
title: "How to Configure Self-Review | Sortie"
linkTitle: "Configure Self-Review"
description: "Guide to configuring self-review in Sortie: run tests and linters before PR creation, let the agent review its own diff with structured feedback, tune iteration limits, and verify the review loop."
keywords: sortie self-review, code review, verification, pre-PR review, self_review, max_iterations, verification_commands, agent orchestration
author: Sortie AI
date: 2026-04-10
weight: 155
url: /guides/configure-self-review/
---
Self-review adds an orchestrator-controlled feedback loop between "agent finishes coding" and "worker exits." Before the code gets pushed and a PR opened, Sortie generates a workspace diff, runs your verification commands (tests, linters, type checkers), and feeds structured results back to the agent. The agent reviews the diff and test results, writes a verdict, and either passes or iterates. This catches regressions before they reach CI or human reviewers. The loop is bounded by a hard iteration cap, so a confused agent cannot spin forever.

## Prerequisites

- Sortie running with any tracker and agent adapter
- A workspace with git initialized (Sortie uses `git diff` for change detection)
- Verification commands available in the workspace environment (e.g. `go test`, `npm test`, `pytest`, etc.)

## Activate self-review

Self-review is disabled by default and adds zero overhead when off. Add a `self_review` block to your WORKFLOW.md front matter:

```yaml
self_review:
  enabled: true
  verification_commands:
    - "go test ./..."
    - "go vet ./..."
```

Two fields are required for activation: `enabled: true` turns on the feature, and `verification_commands` lists the commands to run. Omitting `verification_commands` when enabled produces a config error.

Once activated, Sortie enters the self-review phase after the coding turn loop completes successfully and the issue is still in an active state. The entire review loop runs inside the same worker goroutine, using the same agent session with full conversation context from the coding turns. The agent sees everything it wrote during coding and can reason about its own changes.

When `enabled` is absent or `false`, the worker skips the review phase entirely and exits as before.

## Configure verification commands

```yaml
self_review:
  enabled: true
  verification_commands:
    - "go test ./..."
    - "go vet ./..."
    - "golangci-lint run"
```

Commands run sequentially in the workspace directory, each with its own timeout. All commands run regardless of previous failures: if `go test` exits non-zero, `go vet` and `golangci-lint` still execute. The agent sees all results together, which gives it the full picture rather than a single point of failure.

If a command binary is not found on PATH, Sortie records an execution error and continues with the remaining commands. The review prompt shows the error, so the agent knows the command was not available rather than passing silently.

Commands follow the same trust model as workspace hooks: they come from WORKFLOW.md (version-controlled, operator-controlled config) and are not overridable via environment variables.

## Configure iteration limits

```yaml
self_review:
  enabled: true
  max_iterations: 3          # default 3; range 1-10
  verification_commands:
    - "go test ./..."
```

`max_iterations` sets the hard cap on review cycles. Default: 3. Range: 1 to 10.

Each iteration consists of one review turn and, if the verdict is "iterate," one fix turn. So `max_iterations: 3` means up to 5 additional agent turns in the worst case (3 review + 2 fix). Research on LLM self-debugging (Chen et al., ICLR 2024; Gou et al., ICLR 2024) shows that tool-grounded self-correction completes productively within 3 turns. Going higher costs tokens with diminishing returns.

When the cap is reached without a "pass" verdict, the worker exits normally. The review metadata records `cap_reached: true` and gets persisted in run history. This is logged as a warning, not an error, because the iteration cap is a budget guard, not a failure signal.

Setting `max_iterations: 1` is valid for a lightweight "check once, no retry" setup. The agent reviews once but gets no fix turn if it finds issues.

## Configure diff and timeout limits

```yaml
self_review:
  enabled: true
  max_diff_bytes: 102400          # default 100 KB
  verification_timeout_ms: 120000 # default 2 min per command
  verification_commands:
    - "go test ./..."
```

| Field | Default | Description |
|---|---|---|
| `max_diff_bytes` | `102400` (100 KB) | Max bytes of diff included in the review prompt. Larger diffs are truncated with a note in the prompt. Tune relative to your agent's context window. |
| `verification_timeout_ms` | `120000` (2 min) | Per-command timeout. Timed-out commands are killed (entire process group). The agent sees "TIMED OUT" in the review prompt. |

Verification command output is capped at 64 KB per stream (stdout and stderr independently). A runaway test suite that dumps megabytes of output will not blow up agent memory or prompt size.

## The `reviewer` field

```yaml
self_review:
  enabled: true
  reviewer: "same"   # default; only supported value
  verification_commands:
    - "go test ./..."
```

`reviewer` controls which agent runs the review turns. The only supported value is `"same"`, which reuses the existing session from the coding turns. The agent has full conversation context, including the task prompt and every turn it took while coding. Other values produce a config error.

## How the review loop works

Here is what happens once self-review activates, step by step:

1. The agent completes its coding turns normally.
2. Sortie runs `git add --intent-to-add .` then `git diff HEAD` in the workspace to capture all changes: modified files, new files, and deletions. The intent-to-add step ensures newly created files appear in the diff.
3. Sortie runs each verification command sequentially, capturing exit codes, stdout, and stderr per command.
4. Sortie assembles a review prompt containing the original issue description, the workspace diff, and all verification results with their exit codes and output.
5. The agent gets a review turn in the same session. It is instructed to analyze the diff and verification results, then write `.sortie/review_verdict.json` with a verdict of `"pass"` or `"iterate"`.
6. Sortie reads the verdict file. On `"pass"`, the loop ends. On `"iterate"` (or if the verdict file is missing or malformed), the agent gets a fix turn with a prompt listing the specific issues, then the cycle repeats from step 2.
7. After the loop, Sortie writes `.sortie/review_summary.md` with a human-readable summary of iterations, verdicts, and verification outcomes.

If the agent fails to write a valid verdict file on non-final iterations, Sortie treats it as "iterate" and gives the agent another chance. On the final iteration, a missing or invalid verdict terminates the loop with `final_verdict: "none"` and `cap_reached: true`. Sortie will not promote a missing verdict to "pass."

## What the agent sees

**Review turn.** The review prompt includes:

- The original task title and description
- The full workspace diff (or a truncation note if it exceeds `max_diff_bytes`)
- Per-command verification results: exit code, duration, timeout status, stdout, stderr
- On iteration 2+, a note that this is a follow-up review

The prompt instructs the agent to write a structured JSON verdict file. The verdict format:

```json
{
  "verdict": "pass",
  "summary": "All tests pass, implementation matches the task requirements.",
  "issues": []
}
```

Or, when something needs fixing:

```json
{
  "verdict": "iterate",
  "summary": "Test TestFoo/bar fails due to missing nil check.",
  "issues": [
    {
      "file": "internal/handler.go",
      "line": 42,
      "severity": "error",
      "message": "Nil pointer dereference when input is empty."
    }
  ]
}
```

**Fix turn.** Between iterations, the agent receives a brief prompt listing the specific issues from the previous verdict and instructing it to fix them. The conversation history from the review turn is preserved, so the agent has full context without needing it repeated.

## Interaction with CI feedback

Self-review and CI feedback are complementary features that catch different failure classes at different points in the pipeline.

| Phase | When | Signal source |
|---|---|---|
| Self-review | Inside worker, before exit | Local commands (tests, linters) |
| CI feedback | After worker exit, reconcile loop | Remote CI pipeline (Checks API) |

Self-review catches local issues before the code is pushed. CI feedback catches integration issues after push. Both can be active simultaneously with independent counters. If self-review passes but CI later fails, the CI feedback loop triggers normally.

For CI feedback configuration, see [Configure CI feedback](/guides/configure-ci-feedback/).

## Interaction with hooks and handoff

Self-review runs before the worker exits, which means it runs before `after_run` hooks and before handoff transitions. The sequence:

```
coding turns → self-review loop → worker exit → after_run hook → handoff
```

The `after_run` hook environment includes two self-review variables:

| Variable | Values |
|---|---|
| `SORTIE_SELF_REVIEW_STATUS` | `"disabled"`, `"passed"`, `"cap_reached"`, `"error"` |
| `SORTIE_SELF_REVIEW_SUMMARY_PATH` | Absolute path to `.sortie/review_summary.md` |

Your hook can read the summary and include it in a PR description or comment. The example below shows how.

## Complete example

A full WORKFLOW.md with self-review, CI feedback, GitHub Issues, branch-per-issue hooks, and a prompt template. Self-review runs tests and linters before exit; the `after_run` hook pushes code, creates a PR, and attaches the review summary when available.

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

self_review:
  enabled: true
  max_iterations: 3
  verification_commands:
    - "go test ./..."
    - "go vet ./..."
    - "golangci-lint run ./..."
  verification_timeout_ms: 180000   # 3 min per command
  max_diff_bytes: 102400            # 100 KB

ci_feedback:
  kind: github
  max_retries: 2
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

      # Include self-review summary in PR body when available.
      PR_BODY="Automated changes for ${SORTIE_ISSUE_IDENTIFIER}."
      if [ "${SORTIE_SELF_REVIEW_STATUS}" = "passed" ] && \
         [ -f "${SORTIE_SELF_REVIEW_SUMMARY_PATH}" ]; then
        REVIEW_SUMMARY=$(cat "${SORTIE_SELF_REVIEW_SUMMARY_PATH}")
        PR_BODY="${PR_BODY}

${REVIEW_SUMMARY}"
      elif [ "${SORTIE_SELF_REVIEW_STATUS}" = "cap_reached" ] && \
           [ -f "${SORTIE_SELF_REVIEW_SUMMARY_PATH}" ]; then
        REVIEW_SUMMARY=$(cat "${SORTIE_SELF_REVIEW_SUMMARY_PATH}")
        PR_BODY="${PR_BODY}

> **Warning:** Self-review hit the iteration cap without passing.

${REVIEW_SUMMARY}"
      fi

      gh pr create \
        --title "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes" \
        --body "${PR_BODY}" \
        --base main \
        --head "sortie/${SORTIE_ISSUE_IDENTIFIER}" 2>/dev/null || true
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

The `self_review` block sits alongside other top-level config. The review loop runs after coding turns and before the `after_run` hook, so by the time the hook pushes code and creates the PR, the review summary is ready to embed.

## Verify self-review

Four approaches to confirm self-review is working.

### Logs

Search for key messages that trace the review lifecycle:

```bash
# Review loop started
grep "self-review" sortie.log | grep "started"

# Review passed on an iteration
grep "self-review passed" sortie.log

# Agent requested changes
grep "self-review iterate" sortie.log

# Iteration cap reached without passing
grep "self-review cap reached" sortie.log
```

Self-review logs include `issue_id`, `issue_identifier`, and iteration-scoped context fields, so you can trace a specific issue's review history.

### Dashboard and Status API

When the HTTP server is running, running entries show `self_review_active: true` and `self_review_iteration: N` while the review loop is in progress. Once the loop completes, these fields reset.

### Prometheus metrics

Four self-review metrics are available when the HTTP server is enabled:

| Metric | Labels | Description |
|---|---|---|
| `sortie_self_review_iterations_total` | `verdict` (`pass`, `iterate`, `none`) | Count of review iterations by outcome. |
| `sortie_self_review_sessions_total` | `final_verdict` (`pass`, `iterate`, `none`) | Count of completed review sessions by final outcome. |
| `sortie_self_review_cap_reached_total` | _(none)_ | Count of sessions that hit the iteration cap without passing. |
| `sortie_self_review_verification_duration_seconds` | `command` | Per-command verification wall-clock duration. |

A healthy setup shows `sortie_self_review_sessions_total{final_verdict="pass"}` climbing steadily. If `cap_reached_total` grows faster than `sessions_total`, your verification commands or iteration budget may need tuning. For the full metrics catalog, see [Prometheus metrics reference](/reference/prometheus-metrics/).

### Run history

The `review_metadata` field in run history contains the full review audit trail: per-iteration diff size, verification results (exit codes, stdout, stderr), verdicts, and parse errors. Query it through the Status API or read it from the SQLite database directly:

```bash
sqlite3 .sortie.db "SELECT review_metadata FROM run_history WHERE review_metadata IS NOT NULL ORDER BY started_at DESC LIMIT 1" | python3 -m json.tool
```

## Configuration reference

All `self_review` fields at a glance:

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Activates the self-review loop. |
| `verification_commands` | string list | _(none)_ | Shell commands to run each iteration. Required when enabled. |
| `max_iterations` | integer | `3` | Hard cap on review cycles. Range: 1-10. |
| `verification_timeout_ms` | integer | `120000` (2 min) | Per-command timeout in milliseconds. |
| `max_diff_bytes` | integer | `102400` (100 KB) | Max diff bytes in the review prompt. |
| `reviewer` | string | `"same"` | Which agent reviews. Only `"same"` is supported. |

For the full WORKFLOW.md configuration reference, see [workflow config reference](/reference/workflow-config/).

## Related guides

- [Configure CI feedback](/guides/configure-ci-feedback/): complementary CI-level feedback
- [Configure retry behavior](/guides/configure-retry-behavior/): `max_sessions`, backoff, stall detection
- [Setup workspace hooks](/guides/setup-workspace-hooks/): hook scripts, environment variables
- [Write a prompt template](/guides/write-prompt-template/): template syntax
- [Agent extensions reference](/reference/agent-extensions/): `.sortie/status` protocol
- [Prometheus metrics reference](/reference/prometheus-metrics/): self-review metrics
- [Workflow config reference](/reference/workflow-config/): all `self_review` fields
