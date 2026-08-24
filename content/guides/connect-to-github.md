---
title: How to Connect Sortie to GitHub Issues
linkTitle: "Connect to GitHub"
description: "Configure Sortie to poll a GitHub repo: token auth, state labels, issue search filters, handoff configuration, and common error troubleshooting."
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

Sortie needs a token that can read and write issues and labels on the repository you configure. A classic token scoped to the repository works, and so does a fine-grained token granted issue read and write plus repository metadata read. GitHub documents how to create either and what each scope covers; see [managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-secure/managing-your-personal-access-tokens).

Nothing else is required for the tracker. Auto-merge and branch cleanup need a token that can also write to the repository.

Store the token in an environment variable:

```bash
export SORTIE_GITHUB_TOKEN="<your-token>"
```

No endpoint override is needed for github.com. For GitHub Enterprise Server, set `endpoint` in the `tracker` block of `WORKFLOW.md` to your instance's API base URL, or override it at deploy time with the generic tracker env var:

```bash
export SORTIE_TRACKER_ENDPOINT="https://github.yourcompany.com/api/v3"
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
  command: claude
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

**Create the `active_states` labels before you start.** An issue can only carry a label that already exists, and those labels are what make an issue eligible for dispatch. Create one label per entry in `active_states` and `terminal_states` — GitHub's own documentation covers creating labels through the web UI or the `gh` CLI: [managing labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels).

### How state derivation works

When Sortie reads an issue, it scans the issue's labels against `active_states` first, then `terminal_states`, then `handoff_state`, in config order. The first match wins. Because the handoff label is part of that scan, an issue parked in handoff keeps its own state rather than looking unlabeled. If no label matches at all, Sortie falls back: open issues default to the first entry in `active_states` (`backlog` with the defaults above), and closed issues default to the first entry in `terminal_states` (`done`). This means unlabeled open issues show up as candidates — label them explicitly if you want tighter control.

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

One tradeoff: the search endpoint is metered far more tightly than the issues endpoint, so use `query_filter` only when you need server-side filtering. Only use `query_filter` when you need server-side filtering.

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

Constraints:

- `handoff_state` must not appear in `terminal_states`. A handoff parks the issue for a person; it is not a close. Sortie rejects the configuration at load time.
- `handoff_state` must not appear in `active_states` either, or the issue would be dispatched again on the next poll. The GitHub adapter's default active list includes `review`, so once you use `review` as the handoff label, set `active_states` explicitly and leave it out, as the snippet above does.
- Sortie creates the label on demand the first time an issue transitions into it.

Closing stays a human decision. Move the issue to a terminal state once you have read the work, and Sortie cleans up its workspace on the next sweep.

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

This parses front matter, compiles the prompt template, and runs preflight checks. It catches missing fields, a malformed `endpoint`, bad `owner/repo` format, env vars that resolve to empty strings, state labels that are empty or padded with whitespace, state overlap between `active_states` and `terminal_states`, and a `handoff_state` that appears in either list. When `GITHUB_TOKEN` is set but `api_key` is empty, it hints at the available token. See [validate-time checks](/reference/adapter-github/#validate-time-checks) for the full list of GitHub-specific diagnostics.

### Test connectivity

Run a single poll cycle without dispatching agents:

```bash
sortie --dry-run ./WORKFLOW.md
```

Watch the logs. A successful run produces one `dry-run: candidate` line per matching issue, followed by a summary:

```
level=INFO msg="dry-run: complete" candidates_fetched=3 would_dispatch=2 ineligible=1 max_concurrent_agents=3
```

`candidates_fetched=3` means Sortie found 3 issues matching your active states (and `query_filter`, if set). `would_dispatch` counts how many of those it would have dispatched; dry-run mode never actually spawns an agent.

If `candidates_fetched=0` and you expected results, check that your active-state labels exist on the issues you expect Sortie to pick up.

## Troubleshoot errors

### Wrong token or expired

```
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_auth_error: GET /repos/myorg/myrepo/issues: 401"
```

Verify the token is valid:

```bash
curl -s -H "Authorization: Bearer $SORTIE_GITHUB_TOKEN" \
  "https://api.github.com/user" | head -5
```

If this returns your profile, the token works. If it returns 401, generate a new one.

### Insufficient permissions

```
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_auth_error: GET /repos/myorg/myrepo/issues: 403 insufficient permissions"
```

A 403 that isn't rate limiting means the token lacks the required scope. For a classic PAT, enable `repo`. For a fine-grained PAT, grant Issues: Read and Write.

### Rate limiting (primary)

```
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_api_error: GET /repos/myorg/myrepo/issues: 403 rate limited (primary)"
```

Happens when `x-ratelimit-remaining` hits zero. This is uncommon for small repos. If you hit it, increase `polling.interval_ms` or add a `query_filter` to reduce the number of issues fetched per tick.

### Rate limiting (search)

```
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_api_error: GET /search/issues: 429 rate limited"
```

The search endpoint is metered far more tightly than the issues endpoint. If you're using `query_filter`, consider increasing `polling.interval_ms`.

### Repository not found

```
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_not_found: GET /repos/myorg/myrepo/issues: 404"
```

Check that `project` is in `owner/repo` format and that the token has access to the repo. Private repositories require explicit token access — a fine-grained PAT must be scoped to the repo, and a classic PAT must have `repo` scope.

### Transition does not change the label

Check the token first: applying and removing labels needs write access to issues on the repository. A label named in `active_states` is the one case that still has to exist beforehand, because an issue without an active-state label never becomes a candidate for dispatch in the first place.

### Issue is a pull request

```
tracker: tracker_not_found: resource is a pull request, not an issue: 42
```

GitHub's issues API co-mingles pull requests with issues. Sortie filters them out when it polls for candidates, but naming a pull request number directly is an error rather than a silent miss.

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
  command: claude
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
