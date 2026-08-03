---
title: How to connect Sortie to Linear
linkTitle: "Connect to Linear"
description: "Configure Sortie to poll a Linear team: set up API-key authentication, map workflow states, scope candidates with an IssueFilter, and verify the connection."
keywords: sortie linear, linear api key, team key, workflow states, query_filter, IssueFilter, tracker configuration, connect linear
author: Sortie AI
date: 2026-06-15
weight: 25
url: /guides/connect-to-linear/
---
This guide configures Sortie to poll issues from a Linear team, dispatch agents, and move issues through your team's workflow. By the end you will have a working `WORKFLOW.md` that authenticates against Linear with a personal API key, fetches the right issues, maps your team's states, and reports status changes back.

## Prerequisites

- Sortie installed and on your `PATH`, with the quick start completed using the file adapter ([quick start](/getting-started/quick-start/))
- A Linear workspace with a team whose issues you can write to
- A Linear personal API key (creation steps below)

## Authenticate with a personal API key

Create a personal API key in Linear under **Settings > Account > Security & Access**. Restrict it to the team you plan to point Sortie at, with Read and Write access, so the key can read issues and transition them.

Store the key in an environment variable so it stays out of your `WORKFLOW.md`:

```bash
export SORTIE_LINEAR_API_KEY="lin_api_..."
```

Reference the variable from the `tracker` block. Sortie expands `$VAR` at config load time:

```yaml
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
```

`kind` and `api_key` are the only fields needed to authenticate. The `endpoint` field defaults to `https://api.linear.app/graphql`, so you omit it for hosted Linear.

Linear reads the key from the `Authorization` header **verbatim, with no `Bearer` prefix**. This is the most common Linear integration mistake. A `Bearer`-prefixed key is rejected with an HTTP 400 whose body tells you to remove the prefix. Sortie passes the key through unchanged, so the value in `SORTIE_LINEAR_API_KEY` must be the bare key, no scheme and no surrounding whitespace. `sortie validate` warns when the resolved key carries leading or trailing whitespace, or when it lacks the `lin_api_` prefix that personal keys start with.

Prove the key works before you wire it in. The `viewer` query is the cheapest call that identifies the acting user:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $SORTIE_LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```

A valid key returns your user record on HTTP 200:

```json
{"data":{"viewer":{"id":"...","name":"...","email":"..."}}}
```

A missing, invalid, or revoked key returns HTTP 401 with `Authentication required, not authenticated` in the body. Note the `Authorization` header in that command: it carries the key and nothing else.

## Set the team key

`tracker.project` is the Linear **team key**, not a Linear project:

```yaml
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
```

The team key is the uppercase prefix Linear puts on every issue in the team, the `ENG` in `ENG-123`. It also appears in the team's settings in Linear.

A Linear project is a cross-team container with its own lifecycle, and it does not own workflow states or identifiers, so it cannot anchor the state mapping that the rest of this guide builds. The team can, which is why `tracker.project` selects a team and mirrors the Jira adapter, where `project` is also the issue-key prefix. The value must be a single team key with no whitespace. `sortie validate` flags a value that contains a `/`, which usually means a GitHub-style `owner/repo` slipped in.

## Map workflow states

`active_states`, `terminal_states`, and `handoff_state` all take workflow-state **names**, and Linear scopes its states to each team. Set them to names that exist on the team you put in `tracker.project`:

```yaml
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
  active_states: [Backlog, Todo, In Progress]
  handoff_state: In Review
  terminal_states: [Done, Canceled, Duplicate]
```

- **`active_states`** selects candidates for dispatch. Omit it and Sortie uses `Backlog`, `Todo`, and `In Progress`.
- **`terminal_states`** marks completed issues so Sortie can stop tracking them. Omit it and Sortie uses `Done`, `Canceled`, and `Duplicate`.
- **`handoff_state`** is the state an issue moves to once an agent finishes, such as a review column. It has no default. Omit it and Sortie makes no post-run transition.

The active and terminal defaults match the states a new Linear team ships with, so on a stock team you can leave both out.

The names you write do not have to match Linear's casing. At startup Sortie reads the team's states once, matches each configured name case-insensitively, and caches the team's exact spelling for the queries it sends, because Linear's state filter itself is case-sensitive. So `todo` and `Todo` both resolve to your team's `Todo`.

What Sortie does not tolerate is a name no state on the team carries. That fails when the adapter is built, not silently as an empty candidate list:

```
level=ERROR msg="failed to construct tracker adapter" error="state \"In Review\" not found in team \"ENG\""
```

`In Review` is not one of a new team's default states, so add it to the team in Linear before you reference it here. Two more rules hold for `handoff_state`: it must not also appear in `active_states`, or the issue would be picked up again on the next poll, and it must not appear in `terminal_states`, because a handoff is not a close. Neither rule is advisory: `sortie validate` reports either collision as an error and Sortie refuses to start.

For the full `tracker.*` field contract, types, and validation rules, see the [Linear adapter reference](/reference/adapter-linear/) and the [WORKFLOW.md reference](/reference/workflow-config/).

## Scope which issues Sortie picks up

By default Sortie fetches every issue in your active states for the team. `tracker.query_filter` narrows that set. It takes a raw Linear `IssueFilter` written as a JSON object, and Sortie ANDs it with the team and state constraints it already applies.

Select issues that carry a specific label:

```yaml
query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}}'
```

Select issues assigned to the key's own user:

```yaml
query_filter: '{"assignee": {"isMe": {"eq": true}}}'
```

Combine constraints by adding sibling keys. Linear ANDs sibling `IssueFilter` fields, so this selects issues that are both labeled and assigned:

```yaml
query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}, "assignee": {"isMe": {"eq": true}}}'
```

`team` and `state` are reserved keys. Sortie sets them from `tracker.project` and your state lists, and a fragment that contains either one is rejected at load:

```
linear: tracker.query_filter must not contain a reserved key "team"
```

Sortie checks that the fragment is a JSON object but leaves the field names to Linear. A misspelled filter field passes the load check and surfaces only on the first poll, as a Linear argument-validation error.

The filter applies to candidate fetches and to terminal-state cleanup. It does not apply to the ID and identifier lookups Sortie uses to reconcile issues it already dispatched, because those issues passed the filter when they were first picked up.

## Putting it all together

A complete `WORKFLOW.md` that polls a Linear team, scopes candidates to a label, and hands finished work to a review state:

```jinja {filename="WORKFLOW.md"}
---
tracker:
  kind: linear
  api_key: $SORTIE_LINEAR_API_KEY
  project: ENG
  query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}}'
  active_states:
    - Backlog
    - Todo
    - In Progress
  handoff_state: In Review
  terminal_states:
    - Done
    - Canceled
    - Duplicate

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

**{{ .issue.identifier }}**: {{ .issue.title }}
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

This configuration polls every 60 seconds, picks up issues labeled `agent-ready` in `Backlog`, `Todo`, or `In Progress`, runs up to 3 agent turns per issue, and moves completed issues to `In Review`. For every tracker field and its validation rules, see the [Linear adapter reference](/reference/adapter-linear/) and the [WORKFLOW.md reference](/reference/workflow-config/). For prompt template syntax, see [How to write a prompt template](/guides/write-prompt-template/).

## Verify the connection

### Validate the configuration offline

```bash
sortie validate ./WORKFLOW.md
```

`sortie validate` parses the front matter, compiles the prompt template, and runs the offline Linear checks: an `api_key` is present, `project` has no whitespace or stray `/`, state names are neither empty nor padded with whitespace, `active_states` and `terminal_states` do not overlap, and `handoff_state` collides with neither list. That last one is an error rather than a warning: Sortie will not start on it. It does not contact Linear. It cannot tell you whether the key works or whether the team and state names exist, because those are construction-time checks.

### Run one read-only poll

```bash
sortie --dry-run ./WORKFLOW.md
```

Building the adapter runs the online preflight: the credential check, the team-key lookup, and the resolution of every configured state name against the team. Misconfiguration surfaces here, before any agent runs:

```
level=ERROR msg="failed to construct tracker adapter" error="unknown team key \"ENG\""
level=ERROR msg="failed to construct tracker adapter" error="state \"In Review\" not found in team \"ENG\""
```

An invalid key fails at the same point, carrying Linear's `Authentication required, not authenticated`. Once the adapter builds, `--dry-run` fetches one page of candidates and reports them without dispatching:

```
level=INFO msg="dry-run: candidate" issue_identifier=ENG-42 state=Todo would_dispatch=true
level=INFO msg="dry-run: complete" candidates_fetched=3 would_dispatch=3 ineligible=0
```

`candidates_fetched=3` means Sortie found three issues in your active states that also match your `query_filter`. If the count is zero when you expect issues, confirm the issues sit in a state you listed in `active_states` and that your `query_filter` is not excluding them. A `query_filter` field Linear rejects stops the poll itself, before the count:

```
level=ERROR msg="dry-run: failed to fetch candidate issues" error="..."
```

### Run Sortie

```bash
sortie ./WORKFLOW.md
```

A real run dispatches an eligible candidate, and when the agent finishes Sortie transitions the issue to your `handoff_state`. Watch one issue move to `In Review` in Linear, and watch the same session appear in the dashboard. Unlike credential, team, and state-name errors, which all stop startup, a rejected `query_filter` field or a rate-limit response surfaces during polling, because it depends on the live query.

## What we configured

1. **Authenticated against Linear** with a personal API key, sent verbatim in the `Authorization` header with no `Bearer` prefix.
2. **Scoped Sortie to one team** by setting `tracker.project` to the team key, the prefix on every issue identifier.
3. **Mapped the workflow** with `active_states`, `terminal_states`, and `handoff_state`, all team-scoped names that must exist on the team or startup fails.
4. **Filtered candidates** with a `query_filter` IssueFilter fragment, ANDed with the team and state constraints.
5. **Verified the connection** offline with `sortie validate`, then against the live API with `sortie --dry-run`, watching candidates fetch and an issue transition.
