---
title: How to connect Sortie to Gitea
linkTitle: "Connect to Gitea"
description: "Configure Sortie to poll a self-hosted Gitea repository: create a scoped access token, set the instance endpoint and owner/repo, map label-driven states, scope candidates, enable pull-request reactions with auto-merge, and verify the connection."
author: Sortie AI
date: 2026-07-16
weight: 26
url: /guides/connect-to-gitea/
---
This guide configures Sortie to poll issues from a self-hosted Gitea repository, dispatch agents, and transition issues through label-driven states. By the end you will have a working `WORKFLOW.md` that authenticates against your Gitea instance, scopes the right issues, maps your repository's labels to Sortie states, and reports status changes back.

For a guided walkthrough of this setup against a disposable local instance, see the [Gitea integration tutorial](/getting-started/gitea-integration/).

## Prerequisites

- Sortie installed and on your `PATH`, with the quick start completed using the file adapter ([quick start](/getting-started/quick-start/))
- A self-hosted Gitea instance and a repository whose issues you can write to
- A Gitea access token (creation steps below)

## Create an access token

Create the token in Gitea under **Settings > Applications > Generate New Token**. Name it (`sortie` works), and grant the three scopes Sortie needs:

- `write:issue` covers every issue operation: reading issues, posting comments, and reading, creating, and applying labels. On Gitea a write scope implies its read, so this one scope carries the whole tracker surface.
- `read:user` backs the credential check Sortie runs at startup against `GET /user`, which also identifies the automation account.
- `read:repository` backs the repository preflight against `GET /repos/{owner}/{repo}`.

Those three scopes cover the tracker surface. To enable [pull-request reactions](#react-to-pull-requests) with auto-merge or branch cleanup, also grant `write:repository`; it is Gitea's one coarse scope covering both the merge and the branch-delete routes, and the token's user needs write access to the repository on top of it. A write scope implies its read on Gitea, so the complete set for an auto-merge deployment is `write:issue`, `read:user`, and `write:repository`, with `read:repository` subsumed by its write counterpart.

Generate the token. Gitea shows it once: a 40-character hex string with no identifying prefix (unlike a GitHub `ghp_` or a Linear `lin_api_` key), so copy it right away.

Store it in an environment variable to keep it out of your `WORKFLOW.md`:

```bash
export SORTIE_GITEA_TOKEN="<your-gitea-token>"
```

Reference the variable from the `tracker` block. Sortie expands `$VAR` when it loads the config:

```yaml
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
```

`endpoint` is your instance's base URL (for example `https://gitea.example.com`), set in the next section. Sortie sends the token in the `Authorization` header as `token <key>`, with a lowercase `token` scheme rather than `Bearer`, and passes the value through unchanged. The value in `SORTIE_GITEA_TOKEN` must therefore be the bare token with no surrounding whitespace: a leading or trailing space becomes part of the credential and fails authentication. `sortie validate` warns when the resolved key carries surrounding whitespace, and when `api_key` is empty while `SORTIE_GITEA_TOKEN` is set, it points you at `api_key: $SORTIE_GITEA_TOKEN`.

Prove the token works before you wire it in. `GET /api/v1/user` is the cheapest call that both validates the token and returns the automation identity, and it is the same call the adapter runs at startup:

```bash
curl -s -H "Authorization: token $SORTIE_GITEA_TOKEN" \
  https://gitea.example.com/api/v1/user
```

A valid token returns your user record on HTTP 200. A missing or invalid token returns 401 `invalid username, password or token`, and a valid token that lacks a scope returns 403 naming the scope it wants. The header in that command carries the word `token`, one space, and the key, and nothing else.

## Point Sortie at your instance

`tracker.endpoint` is the base URL of your Gitea instance, for example `https://gitea.example.com`. It is required. Gitea is self-hosted, so there is no default host to fall back on, and an empty `endpoint` is a blocking error. Set it with the same environment-variable pattern:

```bash
export SORTIE_GITEA_ENDPOINT="https://gitea.example.com"
```

```yaml
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
```

Give the instance root, not the API path. The adapter appends `/api/v1` for you, and it tolerates a value that already ends in `/api/v1` without appending it twice (`sortie validate` warns when it finds the suffix, since you can drop it). Use `https`: the token travels in a request header, and a plain-`http` endpoint sends it in cleartext, which `sortie validate` flags with a warning.

## Set the repository

`tracker.project` names the repository as `owner/repo`, for example `sortie-ai/sortie`:

```bash
export SORTIE_GITEA_PROJECT="sortie-ai/sortie"
```

```yaml
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: $SORTIE_GITEA_PROJECT
```

The adapter splits the value on its single slash at construction and rejects anything that is not exactly one slash with a non-empty owner and a non-empty repository. `sortie validate` catches a malformed value offline, whether it is a missing slash, an extra slash, or whitespace in either half. Whether the repository actually exists is checked at startup by the repository preflight, not by `sortie validate`.

## Map workflow states

`active_states`, `terminal_states`, and `handoff_state` name **repository labels**, matched against the labels on each issue:

```yaml
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: $SORTIE_GITEA_PROJECT
  active_states: [backlog, in-progress]
  handoff_state: review
  terminal_states: [done, wontfix]
```

- **`active_states`** selects candidates for dispatch. Omit it and Sortie applies `backlog`, `in-progress`, and `review`.
- **`terminal_states`** marks completed issues so Sortie stops tracking them. Omit it and Sortie applies `done` and `wontfix`.
- **`handoff_state`** is the label an issue moves to once an agent finishes, such as a review column. It has no default; omit it and Sortie makes no post-run transition.

Names match case-insensitively, so `In-Progress` and `in-progress` behave identically. Sortie lowercases the configured names at startup.

When you omit `active_states`, Sortie falls back to `backlog`, `in-progress`, and `review` to derive an issue's state from its labels: an open issue carrying one of them takes that state, and an open issue with no state label derives to `backlog`. These fallbacks derive state only; they do not drive dispatch. Dispatch is gated on the `active_states` you configure, so set it to the labels your repository actually uses and Sortie picks up the issues carrying them.

You do not have to pre-create these labels. When Sortie transitions an issue into a state whose label does not yet exist in the repository, it creates the label on demand with a neutral gray color and then applies it, so expect your configured state labels to appear in the repository the first time issues move through them. This is deliberate: Gitea silently ignores a request to attach a label that does not exist and still returns success, so there is no fail-loud path to lean on, and creating the label first is what makes the transition actually take effect.

A transition also reconciles the issue's open or closed status. Moving an issue to a terminal state (`done` or `wontfix`) closes it, and moving a closed issue back to an active state reopens it. A handoff to `review` leaves the issue open, because `review` is not a terminal state.

Two rules constrain `handoff_state`: it must not appear in `active_states`, or the issue would be dispatched again on the next poll, and it must not appear in `terminal_states`, because a handoff is not a close. The default active list includes `review`, so once you use `review` as your handoff label, drop it from `active_states` as the snippet above does. Neither rule is advisory: `sortie validate` reports either collision as an error and Sortie refuses to start. A label shared between `active_states` and `terminal_states` is a warning by contrast, and startup continues.

For the full `tracker.*` field contract, types, and validation rules, see the [Gitea adapter reference](/reference/adapter-gitea/) and the [WORKFLOW.md reference](/reference/workflow-config/).

## Scope which issues Sortie picks up

By default Sortie fetches every open issue in your active states for the repository. `tracker.query_filter` narrows that set. It is a URL query fragment, and the adapter merges it into the repository's issue-list request.

Scope candidates to the work assigned to your automation account:

```yaml
query_filter: "assigned_by=hermes-bot"
```

Here `hermes-bot` is that account's Gitea username. The `assigned_by`, `created_by`, and `mentioned_by` filters each take a username and run on the repository issue list directly, which makes them the clean way to select issues meant for the agent.

You can also filter by label:

```yaml
query_filter: "labels=agent-ready"
```

The `labels` parameter carries three sharp edges on Gitea. It is AND across names, so an issue must carry every name you list. It is case-sensitive, unlike the state matching above. And a name that does not resolve to a real repository label silently disables the whole filter and returns every open issue instead of none. Sortie warns at construction when a `query_filter` label does not resolve against the repository's labels, turning that silent trap into a visible diagnostic.

Combine constraints with `&`:

```yaml
query_filter: "assigned_by=hermes-bot&labels=agent-ready"
```

Four keys are reserved. The adapter sets `state`, `type`, `page`, and `limit` itself, so a fragment naming any of them is rejected at construction:

```
gitea: tracker.query_filter must not contain a reserved key "state"
```

A key outside Gitea's known issue-list parameters (`labels`, `q`, `milestones`, `since`, `before`, `created_by`, `assigned_by`, and `mentioned_by`) is not rejected but warned about, because Gitea ignores an unrecognized parameter and returns every open issue, widening the candidate set rather than narrowing it. A typo in a key name is a warning worth reading.

## React to pull requests

Once your agents open pull requests, the same `gitea` kind reacts to them: a "Request changes" review or a failing CI check dispatches a fix continuation turn, review-bot comments route back to the agent, and an approved, mergeable, CI-green PR merges automatically with its branch cleaned up. The mechanics are provider-agnostic and live elsewhere: [how to set up PR reactions](/guides/setup-pr-reactions/) covers the shared machinery, including the `.sortie/scm.json` PR metadata your hook writes, and the [reactions reference](/reference/reactions/) documents every kind, field, and default. This section is the Gitea-specific wiring.

Activate a reaction kind by giving it `provider: gitea`. Every active SCM reaction in one workflow must name the same provider. Because the tracker is already `kind: gitea`, the reactions reuse the tracker's `endpoint`, `api_key`, and `project`, so you repeat no credentials; to point them at a different instance or repository, set overrides in a top-level `gitea:` block ([adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration)).

```yaml
reactions:
  review_comments:
    provider: gitea
  bot_review:
    provider: gitea
    bot_usernames:          # required on Gitea; an empty list matches nothing
      - reviewdog
  auto_merge:
    provider: gitea
    strategy: squash        # squash (default) | merge | rebase
    require_ci: true        # never merge on failing or pending CI
    delete_branch: true     # remove the head branch after the merge
```

`bot_usernames` is what makes `bot_review` work on Gitea. Gitea users carry no platform bot marker, so the allowlist is the only bot signal: a comment is routed only when its author's login matches an entry, case-insensitively, and an empty or absent list selects nothing. On GitHub, platform-typed bots match without an allowlist; on Gitea, list every review bot's login.

Auto-merge and branch deletion are the two operations the tracker scopes do not cover: grant the token `write:repository` and give the token's user write access to the repository, as described in [Create an access token](#create-an-access-token). The startup preflight checks the user's repository role, not the token's scopes, because Gitea offers no scope introspection. It disables auto-merge when the token's user lacks write access; a wrongly scoped token whose user has write access passes startup and fails on the first merge or branch delete with a 403 that Sortie rewrites to name `write:repository`.

For the routes behind these operations and the full token-scope detail, see the [Gitea adapter reference](/reference/adapter-gitea/#scm-and-ci-surface).

## Putting it all together

A complete `WORKFLOW.md` that polls a Gitea repository, scopes candidates to the automation account, hands finished work to a review label, and reacts to the agent's pull requests:

```jinja {filename="WORKFLOW.md"}
---
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: $SORTIE_GITEA_PROJECT
  query_filter: "assigned_by=hermes-bot"
  active_states:
    - backlog
    - in-progress
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

reactions:
  review_comments:
    provider: gitea
  bot_review:
    provider: gitea
    bot_usernames:
      - reviewdog
  auto_merge:
    provider: gitea
    strategy: squash
    require_ci: true
    delete_branch: true
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

This configuration polls every 60 seconds, picks up issues assigned to `hermes-bot` in `backlog` or `in-progress`, runs up to 3 agent turns per issue, and moves completed issues to the `review` label. Once a run opens a PR and records its coordinates, review feedback routes back to the agent and an approved, CI-green PR is squash-merged with its branch deleted. Issues reaching `done` or `wontfix` are closed automatically. For every tracker field and its validation rules, see the [Gitea adapter reference](/reference/adapter-gitea/) and the [WORKFLOW.md reference](/reference/workflow-config/). For prompt template syntax, see [How to write a prompt template](/guides/write-prompt-template/).

## Verify the connection

### Validate the configuration offline

```bash
sortie validate ./WORKFLOW.md
```

`sortie validate` parses the front matter, compiles the prompt template, and runs the offline Gitea checks: `endpoint` is present and shaped like an absolute `http(s)` URL, `project` is `owner/repo` with non-empty halves, no state label is empty, `active_states` and `terminal_states` do not overlap, and `handoff_state` collides with neither list. That last one is an error rather than a warning: Sortie will not start on it. It also warns on an `http` endpoint, on an `endpoint` that already ends in `/api/v1`, and, when `api_key` is empty, points you at `SORTIE_GITEA_TOKEN`. It does not contact Gitea, so it cannot tell you whether the token works or whether the repository exists. Those are construction-time checks.

With the `reactions` block present, validation also covers the forge configuration offline: an `auto_merge` `strategy` outside `merge`, `squash`, and `rebase`, a `bot_usernames` value that is not a list of strings, and a reaction `provider` that names no registered adapter or differs across the active reactions.

### Run one read-only poll

```bash
sortie --dry-run ./WORKFLOW.md
```

Building the adapter runs the online preflight before any issue is fetched: `GET /user` validates the token and reads the automation identity, and `GET /repos/{owner}/{repo}` confirms the repository. An invalid token or a mistyped repository fails here, at startup, not on the first poll:

```
level=ERROR msg="failed to construct tracker adapter" error="tracker: tracker_auth_error: GET /user: invalid credentials"
level=ERROR msg="failed to construct tracker adapter" error="tracker: tracker_not_found: GET /repos/sortie-ai/sortie: not found"
```

Once the adapter builds, `--dry-run` fetches one page of candidates and reports them without dispatching:

```
level=INFO msg="dry-run: candidate" issue_identifier=42 state=backlog would_dispatch=true
level=INFO msg="dry-run: complete" candidates_fetched=3 would_dispatch=3 ineligible=0
```

`candidates_fetched=3` means Sortie found three open issues in your active states that also match your `query_filter`. If the count is zero when you expect issues, confirm the issues sit in a state you listed in `active_states` and that your `query_filter` is not excluding them.

### Run Sortie

```bash
sortie ./WORKFLOW.md
```

A real run dispatches an eligible candidate, and when the agent finishes Sortie transitions the issue to your `handoff_state`. Watch one issue move to the `review` label in Gitea, which Sortie creates if the repository does not carry it yet, and watch the same session appear in the dashboard.

With auto-merge enabled, startup also runs the role preflight. When the token's user lacks repository write access, Sortie logs `auto_merge preflight failed: insufficient token scope` naming `write:repository` and disables auto-merge for the process. A user with write access but a token missing the scope passes that gate and surfaces later, on the first merge or branch delete, as a 403 rewritten to `gitea token missing required scope write:repository`.

## What we configured

1. **Created a scoped token** with `write:issue`, `read:user`, and `read:repository`, sent verbatim in the `Authorization: token` header.
2. **Pointed Sortie at the instance and repository** by setting `tracker.endpoint` to the instance base URL, which has no default, and `tracker.project` to `owner/repo`.
3. **Mapped the label-driven states** with `active_states`, `terminal_states`, and `handoff_state`, repository labels that Sortie creates on demand. A terminal target closes the issue, an active target reopens it, and a handoff target leaves it open for a reviewer.
4. **Scoped candidates** with a `query_filter` URL fragment, using `assigned_by` to select the automation account's work.
5. **Enabled the pull-request reactions** with `provider: gitea` on each kind, reusing the tracker's credentials, listing review bots in `bot_usernames`, and granting the token `write:repository` for auto-merge and branch cleanup.
6. **Verified the connection** offline with `sortie validate`, then online with `sortie --dry-run`, watching candidates fetch before running Sortie for real.
