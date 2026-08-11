---
title: How to connect Sortie to GitLab
linkTitle: "Connect to GitLab"
description: "Configure Sortie to poll a GitLab project: create a scoped access token, set the endpoint for a self-managed instance, set the namespace path, map label-driven states, scope candidates with query_filter, react to merge requests with auto-merge, and verify the connection."
author: Sortie AI
date: 2026-08-06
weight: 27
url: /guides/connect-to-gitlab/
---
This guide configures Sortie to poll issues from a GitLab project, dispatch agents, and transition those issues through label-driven states, on GitLab.com or on a self-managed instance. By the end you will have a working `WORKFLOW.md` that authenticates against your instance, scopes the right issues, maps your project's labels to Sortie states, and reports status changes back.

For a guided walkthrough of this setup against a live project, see the [GitLab integration tutorial](/getting-started/gitlab-integration/).

## Prerequisites

- Sortie installed and on your `PATH`, with the quick start completed using the file adapter ([quick start](/getting-started/quick-start/))
- A GitLab project whose issues you can write to, on GitLab.com or on a self-managed instance
- A GitLab access token (creation steps below)

## Create an access token

Three token types reach the issue surface: personal, project, and group access tokens. All three travel in the same header and all three work. Sortie does not use OAuth 2.0 access tokens, because it runs headless and implements no interactive authorization flow.

Prefer a **project access token**. It is the least-privilege option, and the containment is enforced by the server rather than by convention: the token authenticates as a generated bot user confined to one project, and a request against a sibling project in the same group returns `404 Project Not Found`. Create it under the project's **Settings > Access tokens**.

One caveat decides this for you on GitLab.com: project and group access tokens there require a Premium or Ultimate subscription, so on a Free namespace a personal access token is the only option. On self-managed Community Edition, project access tokens are available at any license.

Grant the token the `api` scope and an access level that permits issue writes. Developer level covers every operation Sortie performs.

- **`api`** is the required scope for the full adapter. GitLab's classic scopes are coarse, and there is no finer-grained equivalent of a per-resource "Issues: read and write" permission at this token model.
- **`read_api`** authorizes the reads and refuses every write. A state transition, a comment, and a label attach each return `403 {"error":"insufficient_scope"}`. Choose it only for a deliberately read-only deployment.

Store the token in an environment variable to keep it out of your `WORKFLOW.md`:

```bash
export SORTIE_GITLAB_TOKEN="<your-gitlab-token>"
```

Reference the variable from the `tracker` block. Sortie expands `$VAR` when it loads the config:

```yaml
tracker:
  kind: gitlab
  api_key: $SORTIE_GITLAB_TOKEN
```

Sortie sends the token in the **`PRIVATE-TOKEN`** request header, not as `Authorization: Bearer` and not as `Authorization: token`, and passes the value through unchanged. The value in `SORTIE_GITLAB_TOKEN` must therefore be the bare token with nothing around it. A trailing newline picked up from a copy-paste or from a `cat` of a secret file becomes part of the credential and fails authentication. `sortie validate` warns when the resolved key carries surrounding whitespace, and when `api_key` is empty while `SORTIE_GITLAB_TOKEN` is set, it points you at `api_key: $SORTIE_GITLAB_TOKEN`.

The adapter runs no prefix or length check on the value. A GitLab administrator can change the access-token prefix through an application setting, so a shape check would reject valid tokens on a customized instance.

Prove the token works before you wire it in. `GET /api/v4/user` is the cheapest call that both validates the credential and returns the automation identity:

```bash
curl -s -H "PRIVATE-TOKEN: $SORTIE_GITLAB_TOKEN" \
  https://gitlab.com/api/v4/user
```

Swap the host for your instance on self-managed. A valid token returns your user record on HTTP 200. An invalid token returns `401 {"message":"401 Unauthorized"}`, a revoked one returns `401 {"error":"invalid_token"}` naming the revocation, and a valid token missing the scope returns `403 {"error":"insufficient_scope"}`.

## Point Sortie at your instance

`tracker.endpoint` is **optional** and defaults to `https://gitlab.com`. On GitLab.com you omit it entirely, and the configuration above is already complete.

**Self-managed adjustment.** Set `endpoint` to your instance's base URL, and nothing else on this page changes:

```bash
export SORTIE_GITLAB_ENDPOINT="https://gitlab.example.com"
```

```yaml
tracker:
  kind: gitlab
  endpoint: $SORTIE_GITLAB_ENDPOINT
  api_key: $SORTIE_GITLAB_TOKEN
```

Written through an environment variable, that line is safe to keep in a GitLab.com deployment too: an unset `SORTIE_GITLAB_ENDPOINT` resolves to an empty value, and the adapter substitutes `https://gitlab.com` for it. One workflow file covers both deployments, and the variable decides which instance it points at.

Give the instance root, not the API path. The adapter validates the value as an absolute `http` or `https` URL with a host, trims a trailing slash, and appends `/api/v4`. It tolerates a value that already ends in `/api/v4` without appending it twice, and `sortie validate` warns when it finds the suffix, since you can drop it. Use `https`: the token travels in a request header, and a plain-`http` endpoint sends it in cleartext, which `sortie validate` flags as `tracker.endpoint uses http; the access token travels in cleartext in the PRIVATE-TOKEN header, use https`.

## Set the project

`tracker.project` is the project's namespace path or its numeric project ID:

```bash
export SORTIE_GITLAB_PROJECT="platform/backend/api-gateway"
```

```yaml
tracker:
  kind: gitlab
  endpoint: $SORTIE_GITLAB_ENDPOINT
  api_key: $SORTIE_GITLAB_TOKEN
  project: $SORTIE_GITLAB_PROJECT
```

The path nests to any depth. Both `group/project` and `group/subgroup/project` are valid, unlike the single-slash `owner/repo` grammar the GitHub and Gitea adapters take, so the adapter applies no exactly-one-slash rule.

Write the plain path. The adapter percent-encodes it once for the route, and a value you encoded yourself is a validation error rather than a working shortcut.

The numeric project ID is the alternative, and GitLab shows it on the project overview page and under **Settings > General**. Prefer it when the deployment must survive a rename: moving or renaming a project changes its path and keeps its ID.

`sortie validate` rejects these shape faults offline, which are the ones an operator actually hits:

- embedded whitespace anywhere in the value
- a percent-encoded value, for example `group%2Fproject`
- a value with neither a slash nor an all-digit numeric form
- an empty path segment, a leading slash, or a trailing slash

Whether the project exists and whether your token can see it are settled at startup, not here.

## Map workflow states

`active_states`, `terminal_states`, and `handoff_state` name **project labels**, matched against the labels on each issue:

```yaml
tracker:
  kind: gitlab
  endpoint: $SORTIE_GITLAB_ENDPOINT
  api_key: $SORTIE_GITLAB_TOKEN
  project: $SORTIE_GITLAB_PROJECT
  active_states: [backlog, in-progress]
  handoff_state: review
  terminal_states: [done, wontfix]
```

- **`active_states`** selects candidates for dispatch. Omit it and the adapter carries `backlog`, `in-progress`, and `review`.
- **`terminal_states`** marks completed issues so Sortie stops tracking them. Omit it and the adapter carries `done` and `wontfix`.
- **`handoff_state`** is the label an issue moves to once an agent finishes, such as a review column. It has no default; omit it and Sortie makes no post-run transition.

Those internal fallback lists derive an issue's state from its labels when you omit a list. They do not drive dispatch. Dispatch is gated on the `active_states` you configure, so set it to the labels your project actually uses and Sortie picks up the issues carrying them.

Names match case-insensitively, so `In-Progress` and `in-progress` select the same issues. The adapter lowercases the configured names at startup but does not trim them, so a padded value such as `" review"` can never match a normalized issue label. `sortie validate` warns on a padded or empty entry in either list, and on a name shared between `active_states` and `terminal_states`, where an issue would match both sets.

A `handoff_state` that also appears in `active_states` or `terminal_states` is a blocking error rather than a warning: the issue would be dispatched again on the next poll, or the handoff would double as a close. The default active list includes `review`, so once you use `review` as your handoff label, configure `active_states` explicitly without it, as the snippet above does.

You do not pre-create these labels. GitLab creates a label named in a write when it does not exist and returns HTTP 200, so your configured state labels appear in the project the first time issues move through them. The risk that replaces the missing-label risk is **case**: label names are case-sensitive, so attaching `REVIEW` to a project that already holds `review` creates a second label and leaves the issue carrying both. The adapter defends against this by reading the project label catalog at startup and resolving the stored casing of every configured state name, so a write attaches the label the project already holds rather than a variant of it. A configured name that matches nothing in the catalog is treated as the label you intend to create.

One caveat sits outside that defense: auto-creation always creates a *project* label. If you want your state labels to live at group level, shared across several projects, create them in the group first.

A transition is a single request that swaps the state label and reconciles the issue's native open or closed status at the same time. Moving an issue to a terminal state (`done` or `wontfix`) closes it, moving a closed issue back to an active state reopens it, and a handoff to `review` moves the labels while leaving the issue open, because `review` is neither terminal nor active.

For the full `tracker.*` field contract, types, and validation rules, see the [GitLab adapter reference](/reference/adapter-gitlab/) and the [WORKFLOW.md reference](/reference/workflow-config/).

## Scope which issues Sortie picks up

By default Sortie fetches every open issue in your active states for the project. `tracker.query_filter` narrows that set. It is a URL query fragment, and the adapter merges it into the project's issue-list request, where a merged key replaces the adapter's own value for that key.

Read the strictness before the syntax, because it is the reason this field behaves differently here than on Gitea. **GitLab silently ignores a query parameter it does not recognize.** A misspelled key does not error; it disables the filter and the route returns an unfiltered result set with HTTP 200. Writing `assignee=` in place of `assignee_username=` would hand every open issue to the dispatcher with no visible signal anywhere in the response. So the adapter validates your fragment at construction against a **closed allowlist** and refuses to start on a key outside it. The Gitea adapter warns and forwards an unknown key; the GitLab adapter fails. That failure is the protection: a typo stops the process instead of quietly widening what your agents pick up.

Scope candidates to the work assigned to your automation account:

```yaml
query_filter: "scope=assigned_to_me"
```

`scope=assigned_to_me` resolves against the token's own identity and needs no username. That matters with a project or group access token, whose identity is a generated bot username of the form `project_<id>_bot_<hex>` that you would otherwise have to look up. When you want to name an identity explicitly, `assignee_username` takes it:

```yaml
query_filter: "assignee_username=hermes-bot"
```

Filter by label, or combine constraints with `&`:

```yaml
query_filter: "labels=agent-ready&not[labels]=needs-triage"
```

Eight keys are reserved. The adapter sets `state`, `issue_type`, `order_by`, `sort`, `page`, `per_page`, `pagination`, and `with_labels_details` itself, and a fragment naming any of them is rejected at construction, because overriding one changes correctness rather than scope:

```
gitlab: tracker.query_filter key "state" is owned by the adapter and cannot be overridden
```

Everything else must be one of the eighteen keys the issue-list route honors, with GitLab's `not[...]` negation hash accepted for the subset it actually applies to. The [GitLab adapter reference](/reference/adapter-gitlab/#query-filter) lists the complete allowlist, the negatable subset, and the remaining construction-time rejections.

The `labels` parameter carries edges worth knowing before you rely on it. It is AND across comma-separated names, so an issue must carry every name you list. It is case-sensitive, unlike the state matching above. A name that resolves to no label returns an **empty** set rather than dropping the filter, so a misspelling shows up as "no candidates" instead of "every candidate". `None` and `Any` are wildcards on the non-negated form, matching issues with no labels and with any label; under `not[labels]` GitLab reads them as literal names. Sortie warns at construction, once per distinct name, when a `labels` value names a label absent from the project catalog, without blocking startup, since you may be referencing a label you have not created yet.

One cardinality difference bites on self-managed instances: Community Edition accepts exactly **one** `assignee_username` value and returns HTTP 400 for two, where GitLab.com accepts several.

## Putting it all together

A complete `WORKFLOW.md` that polls a GitLab project, scopes candidates to the automation identity, marks issues in progress at dispatch, and hands finished work to a review label:

```jinja {filename="WORKFLOW.md"}
---
tracker:
  kind: gitlab
  endpoint: $SORTIE_GITLAB_ENDPOINT   # unset on GitLab.com; the adapter uses https://gitlab.com
  api_key: $SORTIE_GITLAB_TOKEN
  project: $SORTIE_GITLAB_PROJECT
  query_filter: "scope=assigned_to_me"
  active_states:
    - backlog
    - in-progress
  in_progress_state: in-progress
  handoff_state: review
  terminal_states:
    - done
    - wontfix

polling:
  interval_ms: 45000

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

This configuration polls every 45 seconds, picks up issues assigned to the token's identity in `backlog` or `in-progress`, runs up to 3 agent turns per issue, and moves completed issues to the `review` label. Issues reaching `done` or `wontfix` are closed automatically.

`in_progress_state` is an orchestrator-level field rather than a GitLab one: the adapter never reads it, and the orchestrator uses it to transition an issue at the start of each worker attempt. That move runs through the same label transition as any other, so `in-progress` must be a label your project uses and must appear in `active_states`.

For every tracker field and its validation rules, see the [GitLab adapter reference](/reference/adapter-gitlab/) and the [WORKFLOW.md reference](/reference/workflow-config/). For prompt template syntax, see [How to write a prompt template](/guides/write-prompt-template/).

## React to merge requests

Once your agents open merge requests, the same `gitlab` kind reacts to them: a reviewer requesting changes or a failing pipeline dispatches a fix continuation turn, review-bot comments route back to the agent, a conflicted merge request gets a rebase turn, and an approved, mergeable, green merge request merges with its source branch cleaned up. The mechanics are provider-agnostic and live elsewhere: [how to set up PR reactions](/guides/setup-pr-reactions/) covers the shared machinery, including the `.sortie/scm.json` metadata your hook writes, and the [reactions reference](/reference/reactions/) documents every kind, field, and default. This section is the GitLab-specific wiring.

Activate a reaction kind by giving it `provider: gitlab`. Every active SCM reaction in one workflow must name the same provider. Because the tracker is already `kind: gitlab`, the reactions reuse the tracker's `endpoint`, `api_key`, and `project`, so you repeat no credentials; to point them at a different instance or project, set overrides in a top-level `gitlab:` block ([adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration)).

```yaml
reactions:
  review_comments:
    provider: gitlab
  bot_review:
    provider: gitlab
    bot_usernames:          # optional; adds accounts GitLab does not flag as bots
      - reviewdog
  ci_failure:
    provider: gitlab
    max_log_lines: 50       # tail of the first failing job's trace
  merge_conflicts:
    provider: gitlab
  auto_merge:
    provider: gitlab
    strategy: squash        # squash (default) | merge | rebase
    require_ci: true        # never merge on failing or pending CI
    delete_branch: true     # remove the source branch after the merge
```

The `owner` and `repo` your hook writes to `.sortie/scm.json` are joined with a slash and encoded once, so together they must reconstruct the project's full namespace path. For a project nested in subgroups, either `owner: platform/backend` with `repo: api-gateway` or `owner: platform` with `repo: backend/api-gateway` resolves; `owner: platform` with `repo: api-gateway` does not, and returns 404. Write both halves unencoded.

`bot_usernames` is optional here, unlike on Gitea. GitLab carries a bot marker on a user's own record, and Sortie resolves it once per comment author and caches the answer, so an account the platform marks as a bot routes to `bot_review` without appearing in any list. Name a review tool in the list when it comments under a regular user account.

Auto-merge, branch deletion, and label removal need no scope beyond the `api` you already granted: GitLab has one coarse write scope rather than a split between contents and merge requests. At startup Sortie reads the token's own introspection route once. A classic token whose scopes omit `api` fails that check and auto-merge stays off for the life of the process. A fine-grained token reports no permission detail there, so the check cannot classify it and auto-merge proceeds; confirm such a token's permissions yourself.

Two GitLab behaviors are worth knowing before you turn auto-merge on. `strategy: rebase` is not a per-call option on GitLab, so it merges the same way as `merge` and logs a warning; the project's own **Merge method** setting under **Settings > Merge requests** governs whether a merge rebases. And branch protection refuses a merge with `401` rather than the `403` the rest of the API uses for a permission failure, so an auth error from the merge route means either an invalid token or a token identity that may not merge into the target branch. Sortie's message names both.

For the routes behind these operations, the mergeability mapping, and the full token detail, see the [GitLab adapter reference](/reference/adapter-gitlab/#scm-and-ci-surface).

## Verify the connection

### Validate the configuration offline

```bash
sortie validate ./WORKFLOW.md
```

`sortie validate` parses the front matter, compiles the prompt template, and runs the GitLab checks **without contacting GitLab**. It catches the endpoint and project shape faults described above, the state-list advisories (an empty or padded entry, an `active_states` and `terminal_states` overlap), and any `query_filter` allowlist violation, reported by the same parser the constructor uses so the offline verdict cannot drift from the startup one. It also warns on an `http` endpoint, on an endpoint already ending in `/api/v4`, on an `api_key` with surrounding whitespace, and, when `api_key` is empty, points you at `$SORTIE_GITLAB_TOKEN`.

With a `reactions` block present, validation also covers the forge configuration offline: an `auto_merge` `strategy` outside `merge`, `squash`, and `rebase`, a `bot_usernames` value that is not a list of strings, and a reaction `provider` that names no registered adapter or differs across the active reactions.

Being offline is the limit worth holding on to: validation does not resolve your project, your token, or your labels. Those are construction-time checks, and the token's scope is checked later still, when the auto-merge preflight runs at startup.

### Run one read-only poll

```bash
sortie --dry-run ./WORKFLOW.md
```

Building the adapter runs three calls before any issue is fetched:

1. **Token introspection** against `GET /personal_access_tokens/self` is advisory. It reports the credential's scopes, activity, and expiry, warns when the token is revoked or inactive, and never blocks construction.
2. **The project read** against `GET /projects/{project}` is the authoritative gate. A failure here fails startup.
3. **The label catalog read** resolves the stored casing of every configured state label, so the first transition attaches the label your project already holds rather than a case variant of it.

A wrong project or an unauthorized token fails at startup, not on the first poll:

```
level=ERROR msg="failed to construct tracker adapter" error="tracker: tracker_not_found: gitlab: project not found or not accessible with the configured credential (token authenticated: true)"
```

That message names both possibilities because GitLab cannot tell them apart for you. A project-scoped 404 is byte-identical whether the project does not exist or your token's identity is not a member of it: GitLab masks the existence of private resources rather than returning 403, so an unauthorized caller cannot enumerate them. The asymmetry to hold on to is that a bad *token* returns 401, so a 401 is a credential problem and a 404 is one of those two. The `token authenticated` value in the message tells you which introspection saw, which usually resolves it: a `true` alongside a 404 points at the project path or at the token's membership, not at the token itself.

Once the adapter builds, `--dry-run` fetches one page of candidates and reports them without dispatching:

```
level=INFO msg="dry-run: candidate" issue_identifier=42 state=backlog would_dispatch=true
level=INFO msg="dry-run: complete" candidates_fetched=3 would_dispatch=3 ineligible=0
```

`candidates_fetched=3` means Sortie found three open issues in your active states that also match your `query_filter`. If the count is zero when you expect issues, confirm the issues carry a label you listed in `active_states`, and remember that a `labels` filter naming a label that does not resolve returns an empty set rather than an error.

### Run Sortie

```bash
sortie ./WORKFLOW.md
```

A real run dispatches an eligible candidate, and when the agent finishes Sortie transitions the issue to your `handoff_state`. Watch one issue move to the `review` label in GitLab, which GitLab creates if the project does not carry it yet, and watch the same session appear in the dashboard.

## What we configured

1. **Created a scoped token**, preferring a project access token for its server-enforced single-project containment, with the `api` scope and an access level that permits issue writes, sent verbatim in the `PRIVATE-TOKEN` header.
2. **Pointed Sortie at the instance** by setting `tracker.endpoint` for a self-managed deployment, and omitting it on GitLab.com, where it defaults to `https://gitlab.com`.
3. **Set the project** with `tracker.project` as a plain namespace path of any depth, or as the numeric project ID when the deployment must survive a rename.
4. **Mapped the label-driven states** with `active_states`, `terminal_states`, and `handoff_state`, project labels GitLab creates on demand, with the adapter resolving stored casing so a variant does not become a duplicate. A terminal target closes the issue, an active target reopens it, and a handoff target leaves it open for a reviewer.
5. **Scoped candidates** with a `query_filter` URL fragment, using `scope=assigned_to_me` to select the automation identity's work, checked against a closed allowlist so a typo fails at startup instead of widening the candidate set.
6. **Reacted to merge requests** with `provider: gitlab` on each reaction kind, reusing the tracker's credentials, and relying on the `api` scope you already granted for auto-merge, branch deletion, and label removal.
7. **Verified the connection** offline with `sortie validate`, then online with `sortie --dry-run`, watching candidates fetch before running Sortie for real.
