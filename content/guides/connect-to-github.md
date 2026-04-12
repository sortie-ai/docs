---
title: How to Connect Sortie to GitHub Issues
linkTitle: "Connect to GitHub"
description: "Configure Sortie to poll a GitHub repository: set up token authentication, create state labels, scope issues with search filters, configure handoff, and troubleshoot errors."
keywords: sortie github, github issues, github adapter, pat token, label states, query filter, tracker configuration, connect github
author: Sortie AI
date: 2026-03-30
weight: 20
url: /guides/connect-to-github/
---
This guide configures Sortie to poll issues from a GitHub repository, dispatch agents, and track state through labels. By the end, you'll have a working `WORKFLOW.md` that authenticates against GitHub, maps your issue labels to Sortie states, and reports status changes back to the repo.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- Quick start completed with the file adapter ([quick start](/getting-started/quick-start/))
- A GitHub repository where you have permission to manage issues and labels
- A personal access token (classic or fine-grained) — creation steps below

## Create a personal access token

You have two options:

**Classic PAT** — broader access, faster to set up. Go to Settings → Developer settings → Personal access tokens → Tokens (classic). Select the `repo` scope, which grants read/write access to issues, labels, and repository content. Generate the token.

**Fine-grained PAT** — scoped to specific repositories. Go to Settings → Developer settings → Personal access tokens → Fine-grained tokens. Select the target repository (or all repos in your org), and grant **Issues: Read and Write** permission. This is the minimum Sortie needs — label-based transitions and comments both operate through the Issues API.

Store the token in an environment variable:

```bash
export SORTIE_GITHUB_TOKEN="ghp_abc123def456ghi789jkl012mno345pqr678"
```

No endpoint variable is needed for github.com. For GitHub Enterprise Server, also export:

```bash
export SORTIE_GITHUB_ENDPOINT="https://github.yourcompany.com/api/v3"
```

## Write the minimum configuration

Replace the `tracker` section in your `WORKFLOW.md` front matter:

```jinja {filename="WORKFLOW.md",hl_lines=[4,5,6]}
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress, review]
  terminal_states: [done]

agent:
  kind: claude-code
---

Fix #{{ .issue.identifier }}: {{ .issue.title }}
```

Three fields are required:

- **`api_key`** — a single token string. Unlike Jira, this is *not* an `email:token` pair — it's the PAT by itself. Sent as a `Bearer` token on every request.
- **`project`** — `owner/repo` format. Must contain exactly one `/` with both segments non-empty. Example: `acme-corp/platform`.
- **`kind`** — `github`.

The `$VAR` syntax expands environment variables at config load time. If you omit `endpoint`, Sortie defaults to `https://api.github.com`. If you omit `active_states`, Sortie defaults to `["backlog", "in-progress", "review"]`. If you omit `terminal_states`, Sortie defaults to `["done", "wontfix"]`.

## Map states to labels

This is the key difference from Jira. GitHub has no native workflow states beyond open and closed. Sortie derives richer states from **issue labels** — you control the workflow by defining which labels represent active and terminal states.

- **`active_states`** — label names for issues eligible for dispatch (e.g., `backlog`, `in-progress`, `review`).
- **`terminal_states`** — label names for completed issues (e.g., `done`, `wontfix`).

All comparisons are case-insensitive. Config values are lowercased at startup, so `"In-Progress"` and `"in-progress"` behave identically.

**Labels must already exist on the repository.** Sortie doesn't create them. Use the `gh` CLI to create your state labels:

```bash
gh label create backlog --repo myorg/myrepo --color "0E8A16"
gh label create in-progress --repo myorg/myrepo --color "1D76DB"
gh label create review --repo myorg/myrepo --color "FBCA04"
gh label create done --repo myorg/myrepo --color "5319E7"
gh label create wontfix --repo myorg/myrepo --color "E4E669"
```

### How state derivation works

When Sortie reads an issue, it scans the issue's labels against `active_states` first, then `terminal_states`, in config order. The first match wins. If no label matches, Sortie falls back: open issues default to the first entry in `active_states` (`backlog` with the defaults above), and closed issues default to the first entry in `terminal_states` (`done`). This means unlabeled open issues show up as candidates — label them explicitly if you want tighter control.

When Sortie transitions an issue, it removes the old state label, adds the new state label, and closes or reopens the issue as needed. Moving to a terminal state closes the issue. Moving to an active state from a closed issue reopens it. All label operations are idempotent — retrying a failed transition converges to the correct state.

## Scope issues with a query filter

By default, Sortie fetches all open issues in the repository and filters client-side by state label. This works fine for repos with up to a few hundred open issues.

For larger repos, set `query_filter` to push filtering server-side using GitHub search syntax:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  query_filter: "label:agent-ready milestone:v2.0"
```

Sortie routes this through the search endpoint with the query `repo:myorg/myrepo type:issue state:open label:agent-ready milestone:v2.0`.

Other useful filters:

```yaml
# Only issues with a specific label
query_filter: "label:agent-ready"

# Only issues in a milestone
query_filter: "milestone:v2.0"

# Only issues assigned to a user
query_filter: "assignee:octocat"

# Combination
query_filter: "label:agent-ready assignee:octocat"
```

One tradeoff: the search endpoint has a stricter rate limit (30 requests/min) compared to the issues endpoint (5,000 requests/hour). Only use `query_filter` when you need server-side filtering.

## Configure handoff state

When an agent completes its work, Sortie can transition the issue to a review state:

```yaml {hl_lines=[7]}
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  handoff_state: review
  terminal_states: [done]
```

Sortie removes the current state label (e.g., `in-progress`), adds the `review` label, and keeps the issue open — because `review` is not in `terminal_states`.

If `handoff_state` is a terminal state (e.g., `done`), Sortie also closes the issue.

Constraints:

- `handoff_state` must not collide with any value in `terminal_states` if you want the issue to stay open after handoff.
- The label must exist on the repository.

## Configure dispatch-time transitions

Sortie can transition an issue when the agent picks it up, moving it to an "in progress" column so your team sees work has started:

```yaml {hl_lines=[7]}
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  in_progress_state: in-progress
  handoff_state: review
  terminal_states: [done]
```

`in_progress_state` must appear in `active_states`. If the issue is already in that state at dispatch time, the transition is skipped. If it fails for other reasons, Sortie logs a warning and continues — the agent session proceeds regardless.

## Enable tracker comments

Sortie can post comments on issues at session lifecycle points:

```yaml
tracker:
  # ... existing fields ...
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true
```

Each flag is independent. All default to `false`. Comments are posted as Markdown — no conversion needed, unlike Jira's Atlassian Document Format.

Comment failures are non-fatal. Sortie logs a warning and continues.

## Verify the connection

### Validate syntax

Check your configuration without making API calls:

```bash
sortie validate ./WORKFLOW.md
```

This parses front matter, compiles the prompt template, and runs preflight checks. It catches missing fields, bad `owner/repo` format, env vars that resolve to empty strings, empty state labels, and state overlap between `active_states` and `terminal_states`. When `GITHUB_TOKEN` is set but `api_key` is empty, it hints at the available token. See [validate-time checks](/reference/adapter-github/#validate-time-checks) for the full list of GitHub-specific diagnostics.

### Test connectivity

Run a single poll cycle without dispatching agents:

```bash
sortie --dry-run ./WORKFLOW.md
```

Watch the logs. A successful poll produces:

```
level=INFO msg="tick completed" candidates=3 dispatched=0 running=0 retrying=0
```

`candidates=3` means Sortie found 3 issues matching your active states (and `query_filter`, if set). `dispatched=0` is expected in dry-run mode.

If `candidates=0` and you expected results, check that your active-state labels exist on the issues you expect Sortie to pick up.

## Troubleshoot errors

### Wrong token or expired

```
level=ERROR msg="poll failed" error="tracker: tracker_auth_error: GET /repos/myorg/myrepo/issues: 401"
```

Verify the token is valid:

```bash
curl -s -H "Authorization: Bearer $SORTIE_GITHUB_TOKEN" \
  "https://api.github.com/user" | head -5
```

If this returns your profile, the token works. If it returns 401, generate a new one.

### Insufficient permissions

```
level=ERROR msg="poll failed" error="tracker: tracker_auth_error: GET /repos/myorg/myrepo/issues: 403 insufficient permissions"
```

A 403 that isn't rate limiting means the token lacks the required scope. For a classic PAT, enable `repo`. For a fine-grained PAT, grant Issues: Read and Write.

### Rate limiting (primary)

```
level=ERROR msg="poll failed" error="tracker: tracker_api: GET /repos/myorg/myrepo/issues: 403 rate limited (primary)"
```

Happens when `x-ratelimit-remaining` hits zero. At 5,000 requests/hour, this is uncommon for small repos. If you hit it, increase `polling.interval_ms` or add a `query_filter` to reduce the number of issues fetched per tick.

### Rate limiting (search)

```
level=ERROR msg="poll failed" error="tracker: tracker_api: GET /search/issues: 429 rate limited"
```

The search endpoint allows 30 requests/min. If you're using `query_filter`, consider increasing `polling.interval_ms`.

### Repository not found

```
level=ERROR msg="poll failed" error="tracker: tracker_not_found: GET /repos/myorg/myrepo/issues: 404"
```

Check that `project` is in `owner/repo` format and that the token has access to the repo. Private repositories require explicit token access — a fine-grained PAT must be scoped to the repo, and a classic PAT must have `repo` scope.

### Label does not exist

`TransitionIssue` fails when the target label doesn't exist on the repository. Sortie doesn't auto-create labels. Create them with `gh label create` or through the GitHub UI.

### Issue is a pull request

```
level=ERROR msg="fetch failed" error="tracker: tracker_not_found: resource is a pull request, not an issue: 42"
```

GitHub's issues API co-mingles pull requests. Sortie filters PRs automatically in list operations, but returns an error if you explicitly reference a PR number via `FetchIssueByID`.

## Full production example

```jinja
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme-corp/platform
  query_filter: "label:agent-ready"
  active_states:
    - backlog
    - in-progress
    - review
  in_progress_state: in-progress
  handoff_state: review
  terminal_states:
    - done
    - wontfix

polling:
  interval_ms: 60000

workspace:
  root: ~/workspace/sortie

agent:
  kind: claude-code
  max_turns: 3
---

You are a senior engineer. Your work is tracked by Sortie.

## Task

**#{{ .issue.identifier }}**: {{ .issue.title }}
{{ if .issue.description }}

### Description

{{ .issue.description }}
{{ end }}
{{ if .issue.labels }}
**Labels:** {{ .issue.labels | join ", " }}
{{ end }}
{{ if .issue.url }}
**Issue:** {{ .issue.url }}
{{ end }}
```

This configuration polls every 60 seconds, picks up issues labeled `agent-ready` in `backlog`, `in-progress`, or `review`, runs up to 3 agent turns per issue, and moves completed issues to the `review` label. Issues reaching `done` or `wontfix` are closed automatically. For the full set of configuration options, see the [WORKFLOW.md reference](/reference/workflow-config/). For prompt template syntax, see [How to write a prompt template](/guides/write-prompt-template/).
