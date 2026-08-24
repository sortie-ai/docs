---
title: "GitHub Adapter"
description: "GitHub Issues tracker adapter reference: configuration, auth, API operations, field mapping, label-based state, pagination, rate limits, and errors."
author: Sortie AI
date: 2026-03-30
weight: 130
url: /reference/adapter-github/
---
The GitHub adapter connects Sortie to **GitHub Issues** via the GitHub REST API. It fetches candidate issues from the issues list endpoint (or the search endpoint when `query_filter` is configured), derives Sortie states from issue labels, normalizes responses to the domain issue model, paginates using `Link` header navigation, and maps HTTP errors to Sortie's normalized error categories. Registered under kind `"github"`.

GitHub Enterprise Server is supported. Set `endpoint` to your GHES base URL. The sub-issue (`parent`) and dependency (`blocked_by`) endpoints are available on all GitHub plans. A 404 on the parent endpoint degrades gracefully to `nil` - there is legitimately no parent. A 404 on the dependency endpoint is treated as a failure instead: see [blocker extraction](#blocker-extraction).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Two fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | - | Must be `"github"`. |
| `api_key` | string | Yes | - | GitHub personal access token. Plain token string - not `email:token` format. |
| `project` | string | Yes | - | Repository in `owner/repo` format. |
| `endpoint` | string | No | `https://api.github.com` | GitHub API base URL. Override for GitHub Enterprise Server. |
| `active_states` | list of strings | No | `["backlog", "in-progress", "review"]` | Issue label names that map to active Sortie states. Compared case-insensitively; stored lowercased. |
| `terminal_states` | list of strings | No | `["done", "wontfix"]` | Issue label names that map to terminal Sortie states. Stored lowercased. |
| `query_filter` | string | No | `""` | Raw GitHub search qualifier appended to the search query. When set, `FetchCandidateIssues` uses the search endpoint instead of the issues list endpoint. |
| `handoff_state` | string | No | _(absent)_ | Target label name after a successful agent run. Must appear in neither `active_states` nor `terminal_states`. Created on demand if absent from the repository - see [Pre-creating labels](#pre-creating-labels). |
| `in_progress_state` | string | No | _(absent)_ | Target label name for dispatch-time transitions. Must appear in `active_states`. |
| `user_agent` | string | No | `sortie/<version>` | `User-Agent` header sent on all requests. Sortie sets the tracker role's value to its own version string, so only the SCM and CI roles honor an override, set in a top-level `github:` block. |

### `endpoint`

The GitHub API base URL. The default value is `https://api.github.com`. For GitHub Enterprise Server, set this to your instance's API root (for example, `https://github.mycompany.com`). Surrounding whitespace and trailing slashes are trimmed.

A present value must parse as an absolute `http` or `https` URL carrying a hostname, with neither a query nor a fragment; anything else is rejected before any client is built, rather than surfacing later as a network error. A port-only value such as `http://:80` has no hostname and is rejected for the same reason. An IPv6 literal must be bracketed - `http://[fd00::1]:3000`, not `http://fd00::1:3000` - since the unbracketed form cannot be told apart from a host with a trailing port.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) when the entire value is a variable reference.

### `api_key`

A GitHub personal access token (classic or fine-grained). This field is **not** in `email:token` format - the value is the token string alone.

Minimum required scopes for classic tokens: `repo` (reads issues, posts comments, manages labels).

Minimum required permissions for fine-grained tokens: **Issues** (read and write), **Metadata** (read).

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) anywhere in the string via full `os.ExpandEnv` expansion.

```yaml
api_key: $SORTIE_GITHUB_TOKEN
api_key: $GITHUB_TOKEN
```

### `project`

Repository in `owner/repo` format - for example, `myorg/myrepo`. The adapter splits on the `/` to extract the owner and repository name. A value with zero or more than one `/`, or with empty parts, produces a `tracker_payload_error` at construction time.

```yaml
project: myorg/myrepo
project: $SORTIE_GITHUB_PROJECT
```

### `active_states`

Label names that map to active Sortie states. Issues with one of these labels are eligible for dispatch. Values are compared case-insensitively and stored lowercased at construction time.

When omitted, defaults to `["backlog", "in-progress", "review"]`. These label names must exist in the repository - GitHub has no built-in equivalents.

### `terminal_states`

Label names that map to terminal Sortie states. Issues with one of these labels trigger workspace cleanup. Stored lowercased.

When omitted, defaults to `["done", "wontfix"]`.

### `query_filter`

A raw GitHub search qualifier string. When this field is non-empty, `FetchCandidateIssues` switches from the issues list endpoint to the search endpoint and appends this value to the base query `repo:{owner}/{repo} type:issue state:open`.

```yaml
query_filter: "label:agent-ready"
query_filter: "label:agent-ready milestone:v2"
```

Do not include `repo:` or `type:issue` in the value - they are added automatically.

### Pre-creating labels

The adapter never issues an explicit label-creation call. It does not need to: `TransitionIssue` adds the target label through GitHub's add-labels-to-an-issue endpoint, and that endpoint creates a label it does not recognize instead of rejecting it, returning `200` with the label applied. A transition to a label that does not exist yet therefore succeeds rather than producing a `tracker_payload_error`. GitHub does not document this behavior, so treat it as convenient rather than guaranteed.

Pre-creating the labels is still worth doing, for two reasons. An implicitly created label comes out in GitHub's default gray with no description, whereas a label you create yourself carries the color and wording you chose. More importantly, the labels in `active_states` gate dispatch: an issue can only carry a label that already exists, so a `query_filter` such as `label:agent-ready` matches nothing until someone has created `agent-ready` and applied it.

---

## Validate-time checks

When `tracker.kind` is `github`, the [`sortie validate`](/reference/cli/#validate) pipeline runs GitHub-specific config checks in addition to the generic preflight validation. These checks run without constructing an adapter instance or making network calls.

### Errors

| Check | Condition | Message |
|---|---|---|
| `tracker.endpoint.invalid` | A non-empty `tracker.endpoint` does not parse as an absolute http(s) URL with a hostname, or carries a query or a fragment | `tracker.endpoint must be an absolute http(s) URL with a host (e.g. "https://github.example.com/api/v3")` |
| `tracker.project.format` | `tracker.project` is non-empty but does not contain exactly one `/`, or either segment is empty after trimming | `tracker.project must be in owner/repo format (e.g. "sortie-ai/sortie")` |
| `tracker.project.format` | `owner` or `repo` segment contains whitespace | `tracker.project owner and repo must not contain whitespace` |

Empty `tracker.project` is caught by the generic preflight check (`tracker.project is required`) before adapter validation runs.

### Warnings

| Check | Condition | Message |
|---|---|---|
| `tracker.api_key.github_token_hint` | `tracker.api_key` is empty after env expansion, but `GITHUB_TOKEN` env var is set | `tracker.api_key is empty but GITHUB_TOKEN environment variable is set; consider using api_key: $GITHUB_TOKEN` |
| `tracker.api_key.github_token_missing` | `tracker.api_key` is empty and `GITHUB_TOKEN` is not set | `tracker.api_key is empty and GITHUB_TOKEN environment variable is not set` |
| `tracker.active_states.empty_element` | An element in `active_states` is empty or whitespace-only | `tracker.active_states[{i}]: empty state value never matches an issue state` |
| `tracker.terminal_states.empty_element` | An element in `terminal_states` is empty or whitespace-only | `tracker.terminal_states[{i}]: empty state value never matches an issue state` |
| `tracker.active_states.untrimmed_element` | An element in `active_states` has leading or trailing whitespace | `tracker.active_states[{i}]: state value has leading or trailing whitespace and never matches an issue state` |
| `tracker.terminal_states.untrimmed_element` | An element in `terminal_states` has leading or trailing whitespace | `tracker.terminal_states[{i}]: state value has leading or trailing whitespace and never matches an issue state` |
| `tracker.states.overlap` | A label appears in both `active_states` and `terminal_states` (case-insensitive) | `tracker.active_states and tracker.terminal_states overlap on "{label}"; an issue in state "{label}" would match both sets` |

The `api_key` warnings are supplementary hints. The generic preflight check already reports an **error** when `tracker.api_key` is empty - the adapter-specific warnings provide actionable remediation guidance alongside that error.

State collisions are not adapter diagnostics. A `handoff_state` that appears in `active_states` or `terminal_states`, and an `in_progress_state` that appears in `terminal_states`, is absent from `active_states`, or equals `handoff_state`, are all rejected by the generic configuration layer before adapter validation runs. They surface as errors under the `config.tracker.handoff_state` and `config.tracker.in_progress_state` fields, and they apply to every `tracker.kind`. See [startup and configuration errors](/reference/errors/#startup-and-configuration-errors).

---

## Authentication

Every request sets a `Bearer` authorization header:

```
Authorization: Bearer <token>
```

Additional fixed headers on all requests:

| Header | Value |
|---|---|
| `Accept` | `application/vnd.github+json` |
| `X-GitHub-Api-Version` | A REST API version the adapter pins. Sortie is therefore insulated from a newer API version's changes until the pin moves. |
| `User-Agent` | `sortie/<version>` on tracker requests; the configured `user_agent` value on SCM and CI requests, defaulting to `sortie/dev` |

The HTTP client has a 30-second per-request timeout. Context cancellation is propagated - a cancelled context causes the in-flight request to return immediately with `context.Canceled`.

---

## State derivation

GitHub issues have two native states: `open` and `closed`. Sortie states are derived from issue labels using a five-priority algorithm.

### Priority order

1. **Active states, config order.** Issue labels are scanned against `active_states` in configuration order. The first match is returned.
2. **Terminal states, config order.** If no active state matched, labels are scanned against `terminal_states` in configuration order. The first match is returned.
3. **Handoff state.** If neither list matched and `handoff_state` is configured, the labels are scanned for it. A match returns `handoff_state`.
4. **Native-state fallback.** If no label matched any of the above:
   - `open` issue → `active_states[0]` (first configured active state, e.g., `"backlog"`).
   - `closed` issue → `terminal_states[0]` (first configured terminal state, e.g., `"done"`).
5. **Native state passthrough.** When both `active_states` and `terminal_states` are empty (not recommended), returns `"open"` or `"closed"` directly.

### Multi-label conflicts

When an issue carries multiple state labels, the first configured active state wins (priority 1). Configuration order is deterministic; label display order on the issue is irrelevant.

### Handoff-labeled issues

An open issue carrying the `handoff_state` label resolves to `handoff_state`, not to `active_states[0]`. `handoff_state` is rejected at load time when it appears in `active_states` or `terminal_states`, so priority 3 is the only rule that matches the label.

### Unlabeled issues

An open issue with no state label resolves to `active_states[0]`. A closed issue resolves to `terminal_states[0]`. This prevents unlabeled issues from appearing as an unknown state in the orchestrator.

### Case handling

All comparisons are case-insensitive. A label named `"In-Progress"` matches the configured value `"in-progress"`. All stored and compared values are lowercased at construction time.

---

## API operations

The adapter implements every method of the tracker contract against GitHub's issues, search, and comments surfaces. Which route serves which call is GitHub's to document; see [external references](#external-references). What follows is the behaviour those calls produce, which is Sortie's.

### Candidate polling

Without `query_filter`, the adapter reads open issues and filters them by state label on the client. With `query_filter` set, it moves to the search surface and lets GitHub apply the filter, composing your expression with a repository and open-issue constraint. That choice is the one with operational consequences: search is metered far more tightly, so a filter plus a short poll interval is what exhausts a budget. See [rate limits](#rate-limits).

Pull requests are removed from every response. GitHub's issues surface returns both, and Sortie drops the pull-request entries rather than dispatching an agent against one.

Paging is bounded. The adapter reads 50 records per page and stops at 200 pages, so a single poll sees at most 10,000 issues. On reaching that ceiling it logs a warning and returns what it has rather than failing, which means a repository larger than the ceiling is silently truncated at the tail. A search response that reports incomplete results also logs a warning and is used rather than discarded.

Comments are not fetched during candidate polling. They are `nil` on those issues and are read on demand.

### Single-issue reads

Fetching one issue by ID issues several requests, because state, labels, and blocker relationships live on different surfaces. Naming a pull request number directly is an error rather than a silent miss.

Fetching the states of many issues is sequential rather than batched: there is no bulk state endpoint, so the cost grows linearly with the number of issues in flight. An issue that has been deleted or moved is omitted from the result rather than failing the batch.

### Terminal-state reconciliation

At startup the adapter resolves terminal states through the search surface, one query per terminal-state label. Each of those queries draws on the search budget, so a workflow with many terminal states pays for them at every reconciliation.

### Writes

A transition sets the state label and removes the ones it replaces. A comment is appended rather than edited. Both require a token that can write to issues; see [authentication](#authentication).

## Field mapping

| Domain field | GitHub source | Normalization |
|---|---|---|
| `ID` | `number` | The issue number as a string. Same value as `Identifier`. |
| `Identifier` | `number` | The issue number as a string, for example `"42"`. |
| `Title` | `title` | String, as-is. |
| `Description` | `body` | Pointer dereferenced. `nil` → `""`. Markdown pass-through. |
| `Priority` | _(not available)_ | Always `nil`. GitHub issues have no native priority field. |
| `State` | `labels` + `state` | Derived via [state derivation algorithm](#state-derivation). |
| `BranchName` | _(not available)_ | Always `""`. Issues API does not expose branch metadata. |
| `URL` | `html_url` | String, as-is. |
| `Labels` | `labels[].name` | Each label lowercased. Non-nil empty slice when no labels. |
| `Assignee` | `assignees[0].login` | First assignee's login. Empty string when no assignees. |
| `IssueType` | `type.name` | String, as-is. Empty string when `type` is null (organization-level issue types not configured). |
| `Parent` | `/issues/{id}/parent` | `nil` in list normalization; populated by `FetchIssueByID`. `nil` on 404. |
| `Comments` | `/issues/{id}/comments` | `nil` in list normalization; populated by `FetchIssueByID` and `FetchIssueComments`. |
| `BlockedBy` | `/issues/{id}/dependencies/blocked_by` | Empty `[]BlockerRef{}` in list normalization; populated by `FetchIssueByID` or, for a candidate, by the shared blocker resolver. See [blocker extraction](#blocker-extraction). |
| `CreatedAt` | `created_at` | ISO-8601 string, as-is. |
| `UpdatedAt` | `updated_at` | ISO-8601 string, as-is. |

### ID and Identifier

Both `ID` and `Identifier` map to the GitHub issue number. The global integer `id` field returned by the API is not used as the adapter's ID - it cannot be used to look up issues via the REST API. As a result, `FetchIssueStatesByIDs` and `FetchIssueStatesByIdentifiers` are structurally equivalent for this adapter.

### Comment normalization

| Domain field | GitHub source | Normalization |
|---|---|---|
| `ID` | `id` | The numeric ID as a string. |
| `Author` | `user.login` | String, as-is. |
| `Body` | `body` | Markdown pass-through. |
| `CreatedAt` | `created_at` | ISO-8601 string, as-is. |

### Blocker extraction

`FetchCandidateIssues` does not call the dependencies route. Every candidate is marked unresolved by default, and a shared resolution layer between the registry and the orchestrator reads `FetchIssueBlockers` per candidate once the cheaper dispatch checks pass, bounded by a per-poll budget shared across every candidate that needs a read. `FetchIssueByID` still reads the route directly and resolves the candidate's list immediately.

Each candidate list response carries a per-issue dependency summary:

```json
{
  "issue_dependencies_summary": {
    "blocked_by": 0,
    "blocking": 0,
    "total_blocked_by": 2,
    "total_blocking": 0
  }
}
```

A candidate whose summary reports `total_blocked_by: 0` is resolved from that field alone, at no extra request. Every other shape, including a missing or null summary, needs the separate read. `blocked_by` in the summary counts only dependencies GitHub still considers open, which is not the question dispatch asks (a closed dependency can still sit in an active Sortie state), so the adapter reads `total_blocked_by` instead.

`GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` returns a JSON array of full issue objects blocking the queried one. Each becomes a `BlockerRef` with `ID` and `Identifier` set to the blocker's issue number, `DisplayID` set to the qualified `owner/repo#N` form, and `State` derived from the blocker's own labels the same way the adapter derives any issue's state.

A 404, or any other non-2xx response, is a failure rather than an empty list: the route answers a genuinely empty blocker list with `200` and `[]`, so a 404 means the issue or the route itself is gone, which the adapter is not entitled to read as "no blockers." A candidate whose read fails this way is held out of dispatch and retried on a later poll. See [candidate eligibility](/reference/state-machine/#candidate-eligibility) for the dispatch-side effect and the [Prometheus metrics reference](/reference/prometheus-metrics/#counters) for the `sortie_candidate_holds_total` counter this produces.

---

## Error mapping

| HTTP status | Condition | Error kind |
|---|---|---|
| 200–299 | Success | _(none)_ |
| 400 | Bad request | `tracker_payload_error` |
| 401 | Invalid or expired token | `tracker_auth_error` |
| 403 | Rate limited (primary) - `x-ratelimit-remaining: 0` | `tracker_api_error` |
| 403 | Rate limited (secondary) - body contains `"rate limit"` | `tracker_api_error` |
| 403 | Insufficient permissions | `tracker_auth_error` |
| 404 | Resource not found | `tracker_not_found` |
| 405 | Method not allowed | `tracker_api_error` |
| 409 | Conflict | `tracker_api_error` |
| 410 | Gone (for example, deleted repository) | `tracker_api_error` |
| 422 | Validation failed | `tracker_payload_error` |
| 429 | Rate limited | `tracker_api_error` |
| 5xx | GitHub server error | `tracker_transport_error` |
| - | Network or DNS failure | `tracker_transport_error` |
| - | JSON decode failure on success response | `tracker_payload_error` |
| other | Unexpected status code | `tracker_api_error` |

### 403 disambiguation

GitHub uses HTTP 403 for both permission errors and secondary rate limits. The adapter applies a three-step check in order:

1. If the `x-ratelimit-remaining` header equals `"0"` → `tracker_api_error` (primary rate limit).
2. If the response body (up to 512 bytes) contains `"rate limit"` (case-insensitive) → `tracker_api_error` (secondary rate limit).
3. Otherwise → `tracker_auth_error` (insufficient permissions).

The `Retry-After` header value from 429 responses is included in the error message for diagnostics.

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

---

## Pagination

All list endpoints use Link header-based pagination.

| Parameter | Value |
|---|---|
| `per_page` | `50` (fixed page size) |
| Next page URL | Extracted from the `Link: <url>; rel="next"` response header. Absent when on the last page. |

The adapter follows `rel="next"` links directly - it does not construct URLs manually. A maximum of 200 pages are fetched per operation. When the limit is reached, accumulated results are returned with a WARN log.

---

## Rate limits

GitHub meters the REST API and its search endpoint on separate budgets, and search is the tighter of the two. The current quotas are GitHub's to publish; see [external references](#external-references).

What decides how much of either budget Sortie spends is the poll interval and whether `query_filter` is set. Without a filter, candidate polling uses the issues endpoint. With one, it uses search, which is metered far more tightly, so a short `polling.interval_ms` combined with a filter is the configuration most likely to exhaust a budget. Terminal-state reconciliation at startup also uses search.

Sortie does not throttle client-side. When a budget is exhausted the request fails as `tracker_api_error` and Sortie waits for the next poll. Raise `polling.interval_ms` or drop the filter.

## SCM and CI surface

The `github` kind also provides an SCM adapter and a CI status provider, so a GitHub-backed deployment drives the pull-request reactions: review-comment feedback, CI-failure escalation, auto-merge, branch cleanup, and post-merge issue closure. The reaction kinds and their lifecycle are provider-agnostic and documented in the [reactions reference](/reference/reactions/); `provider: github` on a reaction block activates this adapter, and [how to set up PR reactions](/guides/setup-pr-reactions/) covers the operator procedure. This section documents only the GitHub-specific behavior.

Both surfaces read `endpoint` from a top-level `github:` block first, the same [adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration) mechanism the [`user_agent` field](#configuration) uses, and fall back to `tracker.endpoint` when the block omits it and `tracker.kind` is also `github`. Either way the resolved value is validated exactly like `tracker.endpoint`: a value that is not an absolute http(s) URL with a hostname is rejected at construction, before either adapter builds a client. `sortie validate` only inspects `tracker.endpoint`, so a `github:` block override that would fail this check is not caught offline.

### Mergeability

The pull request read supplies the draft flag, the head SHA (the CI ref), the head branch, the base branch, and the merged flag. Its `mergeable_state` string maps onto the [normalized mergeability states](/reference/reactions/#normalized-mergeability-states). The comparison ignores case and surrounding whitespace.

| `mergeable_state` | Mergeability |
|---|---|
| `clean` | `clean` |
| `unstable` | `unstable` |
| `blocked`, `behind`, `draft` | `blocked` |
| `dirty` | `dirty` |
| Any other value | `unknown` |

### Merge commit identifier

The merge commit identifier comes from a second read, `PullRequest.mergeCommit.oid` on the GraphQL API. The pinned REST API version no longer carries `merge_commit_sha` on the pull request payload. The GraphQL read is issued only for a pull request the REST payload reports as merged, and a pull request GitHub reports with no merge commit yields an empty identifier rather than an error.

The GraphQL endpoint is `/graphql` on the configured host, or `/api/graphql` when `endpoint` ends in the GitHub Enterprise Server `/api/v3` suffix. A deployment that configures the [`merge_completion` reaction](/reference/reactions/#reactionsmerge_completion) needs a credential that can reach it, since that kind latches on the merge commit identifier. A failed GraphQL read surfaces as an error, and the reaction retries it with backoff. A successful read that reports no merge commit yields an empty identifier instead, which the reaction tolerates for 30 minutes before it stops polling and escalates rather than transitioning the issue.

### CI status provider

The package registers a CI status provider under kind `github`, the role that drives the [`ci_failure` reaction](/reference/reactions/#reactionsci_failure). `FetchCIStatus` reads the ref's check runs (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, paginated) and reduces them through the same aggregate rule every forge provider shares; neither the route's own `total_count` nor a platform-computed verdict is trusted.

Two of the conclusion mappings are Sortie's own policy rather than a pass-through of GitHub's check-run conclusion: a run reporting `action_required` maps to failing, because the agent cannot perform the manual UI action a check like this is waiting on, and a run reporting `stale` maps to pending, because the check run that superseded it carries the conclusion that actually matters. Every other recognized conclusion maps to its direct domain equivalent; an unrecognized value maps to pending.

On a failing verdict, the provider fetches a log excerpt only for a failing run whose `app.slug` is `github-actions` - a failing run from a third-party GitHub App check has no log to fetch through this route. GitHub Actions creates one check run per workflow job, so the check run ID doubles as the job ID for the Actions job-logs route. The excerpt is the sanitized tail of that job's log, stripped of ANSI escapes and per-line timestamps and capped by the `max_log_lines` budget; a `max_log_lines` of zero omits it.

### SCM write operations

The write surface is `MergePR`, `DeleteBranch`, and `RemoveLabel`. The supported merge strategies are `merge`, `squash`, and `rebase`, the same set the auto-merge [`strategy` field](/reference/reactions/#reactionsauto_merge) accepts; the value is sent as-is as the merge method.

`MergePR` sends `PUT /repos/{owner}/{repo}/pulls/{number}/merge` carrying the commit title, the commit message, the merge method, and the expected head SHA as a stale-merge precondition.

| Merge outcome | GitHub response | Mapping |
|---|---|---|
| Merged | HTTP 200, `merged: true` | Success, carrying the merge commit SHA. |
| HTTP 200, `merged: false` | n/a | Conflict error directly, with no "already merged" marker. |
| Already merged, or the expected head SHA is stale | HTTP 405 or 409 | Conflict error. The caller re-reads the pull request and attaches the "already merged" marker only when that re-read confirms it merged. |

The already-merged marker is never read from GitHub's rejection text: the adapter re-reads the pull request after any 405 or 409 and attaches the marker only when the re-read shows the merge landed.

`DeleteBranch` calls `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`. An already-gone branch (HTTP 404) is returned as a not-found error, which the caller treats as a successful no-op.

`RemoveLabel` calls `DELETE /repos/{owner}/{repo}/issues/{number}/labels/{label}`. An already-absent label (HTTP 404) is a no-op; any other failure surfaces as an error.

### Token scope for auto-merge

`VerifyAutoMergeScopes` calls `GET /rate_limit` and reads the `X-OAuth-Scopes` response header. Classic personal access tokens populate that header; fine-grained tokens and GitHub App installation tokens do not, and an absent or empty header is the "unable to verify" result - the caller fails open and lets auto-merge proceed. When the header is present, the legacy `repo` scope satisfies every requirement by itself; otherwise the check looks for `pull_requests:write` (required for `MergePR`) and, when the workflow's auto-merge configuration also deletes the branch, `contents:write` (required for `DeleteBranch`).

---

## Adapter registration

The combined tracker-and-SCM package `internal/scm/github` registers three kinds under `"github"` via `init` functions: the tracker adapter, the SCM adapter, and the CI status provider. Tracker registration metadata declares:

| Property | Value |
|---|---|
| `RequiresProject` | `true` |
| `RequiresAPIKey` | `true` |
| `ValidateTrackerConfig` | Offline config diagnostics for `sortie validate`. |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages before adapter construction, and resolves the adapter through the registry rather than by importing the package. The SCM adapter and CI status provider carry no equivalent metadata and no offline validate hook; a misconfiguration on either surfaces only when Sortie starts or on the first request.

---

## External references

- [GitHub REST API documentation](https://docs.github.com/en/rest) - entry point for all endpoints called by this adapter
- [Issues REST API](https://docs.github.com/en/rest/issues/issues) - fetch, list, and comment endpoints used by `FetchIssuesByStates`, `FetchCandidateIssues`, and `CommentIssue`
- [Search issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests) - the search API used when `query_filter` is configured
- [Using pagination in the REST API](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) - Link header semantics this adapter follows for `rel="next"`
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) - primary and search bucket limits referenced above
- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) - generate the token used in `GITHUB_TOKEN`
