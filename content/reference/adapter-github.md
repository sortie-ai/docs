---
title: "GitHub Adapter"
description: "GitHub Issues tracker adapter reference: configuration, auth, API operations, field mapping, label-based state, pagination, rate limits, and errors."
author: Sortie AI
date: 2026-03-30
weight: 130
url: /reference/adapter-github/
---
The GitHub adapter connects Sortie to **GitHub Issues** via the GitHub REST API (version `2026-03-10`). It fetches candidate issues from the issues list endpoint (or the search endpoint when `query_filter` is configured), derives Sortie states from issue labels, normalizes responses to the domain issue model, paginates using `Link` header navigation, and maps HTTP errors to Sortie's normalized error categories. Registered under kind `"github"`.

GitHub Enterprise Server is supported. Set `endpoint` to your GHES base URL. The sub-issue (`parent`) and dependency (`blocked_by`) endpoints are available on all GitHub plans; the adapter degrades gracefully to `nil` and `[]` respectively when the endpoints return 404.

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

The GitHub API base URL. The default value is `https://api.github.com`. For GitHub Enterprise Server, set this to your instance's API root (for example, `https://github.mycompany.com`). Trailing slashes are stripped.

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
| `X-GitHub-Api-Version` | `2026-03-10` |
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

The adapter implements all eight methods of the `TrackerAdapter` interface.

### `FetchCandidateIssues`

Returns issues in configured active states.

**When `query_filter` is empty (default - issues endpoint):**

- **Endpoint:** `GET /repos/{owner}/{repo}/issues`
- **Parameters:** `state=open`, `sort=created`, `direction=asc`, `per_page=50`
- All open issues are fetched and filtered client-side by state label. Pull requests are filtered out via the `pull_request` field marker.

**When `query_filter` is set (search endpoint):**

- **Endpoint:** `GET /search/issues`
- **Query (`q`):** `repo:{owner}/{repo} type:issue state:open {query_filter}`
- **Parameters:** `sort=created`, `order=asc`, `per_page=50`
- `incomplete_results: true` in the response body produces a WARN log but does not abort the request.

**Pagination:** Link header-based (`rel="next"`). Page size: 50. Maximum 200 pages (10,000 issues). When the page limit is reached, a WARN is logged and accumulated results are returned without error.

**Comments:** Set to `nil` on returned issues.

**Pull request filtering:** Applied to all responses. The `pull_request` field on a list entry is non-nil for pull requests; those entries are skipped.

### `FetchIssueByID`

Returns a single fully-populated issue. The `issueID` parameter is the issue number as a string, equal to the `Identifier` field.

**Four requests:**

1. `GET /repos/{owner}/{repo}/issues/{issueID}` - issue body and labels.
2. `GET /repos/{owner}/{repo}/issues/{issueID}/dependencies/blocked_by` - blocker list. Returns `[]` on 404.
3. `GET /repos/{owner}/{repo}/issues/{issueID}/parent` - parent issue. Returns `nil` on 404.
4. `GET /repos/{owner}/{repo}/issues/{issueID}/comments` - comments, Link-header paginated.

Returns `tracker_not_found` when the issue does not exist (HTTP 404) or when the resolved entity is a pull request.

### `FetchIssuesByStates`

Returns issues in specified Sortie states. Used for startup terminal cleanup.

**Active states:** Issues endpoint with `state=open`, client-side label filtering.

**Terminal states:** Search endpoint, one query per terminal-state label: `repo:{owner}/{repo} type:issue state:closed label:{terminal_label}`. Server-side filtering avoids scanning all closed issues in the repository.

Returns an empty slice when `states` is empty.

### `FetchIssueStatesByIDs`

Returns the current state for each requested issue ID. Since `ID == Identifier == issue number` for this adapter, the IDs are used directly as issue numbers in individual API calls.

**Endpoint (per issue):** `GET /repos/{owner}/{repo}/issues/{number}`

**Batching:** None. Sequential individual requests. 404 responses are omitted from the result map without error.

### `FetchIssueStatesByIdentifiers`

Structurally identical to `FetchIssueStatesByIDs`. Since `ID == Identifier` for this adapter, both methods share the same internal implementation.

### `FetchIssueComments`

Returns all comments for an issue.

**Endpoint:** `GET /repos/{owner}/{repo}/issues/{issueID}/comments`

**Pagination:** Link header-based. Page size: 50. Maximum 200 pages.

Returns `tracker_not_found` when the issue does not exist.

### `TransitionIssue`

Applies a state transition by manipulating issue labels and the open/closed native state.

**Steps:**

1. `GET /repos/{owner}/{repo}/issues/{issueID}` - read current labels and native state.
2. `DELETE /repos/{owner}/{repo}/issues/{issueID}/labels/{old_label}` - remove the current state label, if present and different from the target. Label names are URL path-escaped. A 404 here is treated as a no-op (label already absent).
3. `POST /repos/{owner}/{repo}/issues/{issueID}/labels` - add the target state label.
4. If the target is a terminal state and the issue is open: `PATCH /repos/{owner}/{repo}/issues/{issueID}` with `{"state": "closed", "state_reason": "completed"}`.
5. If the target is an active state and the issue is closed: `PATCH /repos/{owner}/{repo}/issues/{issueID}` with `{"state": "open"}`.

**Atomicity:** The steps are not atomic. A failure at any step causes the adapter to return an error; the orchestrator retries on the next tick. Label operations are idempotent - retries converge to the correct state without creating duplicates.

**Label case:** Target labels are sent as configured (lowercased). GitHub label matching is case-insensitive.

### `CommentIssue`

Posts a plain-text comment on an issue.

**Endpoint:** `POST /repos/{owner}/{repo}/issues/{issueID}/comments`

**Request body:** `{"body": "<text>"}`. No ADF conversion - GitHub natively accepts Markdown.

Returns `nil` on success (HTTP 201).

---

## Field mapping

| Domain field | GitHub source | Normalization |
|---|---|---|
| `ID` | `number` | `strconv.Itoa(number)`. Same value as `Identifier`. |
| `Identifier` | `number` | `strconv.Itoa(number)`. Human-readable issue number (e.g., `"42"`). |
| `Title` | `title` | String, as-is. |
| `Description` | `body` | Pointer dereferenced. `nil` → `""`. Markdown pass-through - no ADF conversion. |
| `Priority` | _(not available)_ | Always `nil`. GitHub issues have no native priority field. |
| `State` | `labels` + `state` | Derived via [state derivation algorithm](#state-derivation). |
| `BranchName` | _(not available)_ | Always `""`. Issues API does not expose branch metadata. |
| `URL` | `html_url` | String, as-is. |
| `Labels` | `labels[].name` | Each label lowercased. Non-nil empty slice when no labels. |
| `Assignee` | `assignees[0].login` | First assignee's login. Empty string when no assignees. |
| `IssueType` | `type.name` | String, as-is. Empty string when `type` is null (organization-level issue types not configured). |
| `Parent` | `/issues/{id}/parent` | `nil` in list normalization; populated by `FetchIssueByID`. `nil` on 404. |
| `Comments` | `/issues/{id}/comments` | `nil` in list normalization; populated by `FetchIssueByID` and `FetchIssueComments`. |
| `BlockedBy` | `/issues/{id}/dependencies/blocked_by` | Empty `[]BlockerRef{}` in list normalization; populated by `FetchIssueByID`. Empty on 404. |
| `CreatedAt` | `created_at` | ISO-8601 string, as-is. |
| `UpdatedAt` | `updated_at` | ISO-8601 string, as-is. |

### ID and Identifier

Both `ID` and `Identifier` map to the GitHub issue number. The global integer `id` field returned by the API is not used as the adapter's ID - it cannot be used to look up issues via the REST API. As a result, `FetchIssueStatesByIDs` and `FetchIssueStatesByIdentifiers` are structurally equivalent for this adapter.

### Comment normalization

| Domain field | GitHub source | Normalization |
|---|---|---|
| `ID` | `id` | `strconv.FormatInt(id, 10)`. |
| `Author` | `user.login` | String, as-is. |
| `Body` | `body` | Markdown pass-through. |
| `CreatedAt` | `created_at` | ISO-8601 string, as-is. |

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

GitHub enforces two independent rate limit buckets.

| Bucket | Limit | Used by this adapter |
|---|---|---|
| Primary (REST) | 5,000 requests/hour per token | All operations except search |
| Search | 30 requests/minute per token | `FetchCandidateIssues` when `query_filter` is set; `FetchIssuesByStates` terminal-state queries (startup only) |

At the default 30-second poll interval with `max_concurrent_agents: 10`, typical usage is well within the primary rate limit. The search budget applies only when `query_filter` is configured or during the one-time startup terminal-state cleanup.

Rate limit violations return HTTP 429 or HTTP 403. Both are mapped to `tracker_api_error`. The orchestrator logs the error and waits for the next poll interval.

---

## SCM and CI surface

The `github` kind also provides an SCM adapter and a CI status provider, so a GitHub-backed deployment drives the pull-request reactions: review-comment feedback, CI-failure escalation, auto-merge, branch cleanup, and post-merge issue closure. The reaction kinds and their lifecycle are provider-agnostic and documented in the [reactions reference](/reference/reactions/); `provider: github` on a reaction block activates this adapter, and [how to set up PR reactions](/guides/setup-pr-reactions/) covers the operator procedure. This section documents only the GitHub-specific behavior.

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

---

## External references

- [GitHub REST API documentation](https://docs.github.com/en/rest) - entry point for all endpoints called by this adapter
- [Issues REST API](https://docs.github.com/en/rest/issues/issues) - fetch, list, and comment endpoints used by `FetchIssuesByStates`, `FetchCandidateIssues`, and `CommentIssue`
- [Search issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests) - the search API used when `query_filter` is configured
- [Using pagination in the REST API](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) - Link header semantics this adapter follows for `rel="next"`
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) - primary and search bucket limits referenced above
- [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) - generate the token used in `GITHUB_TOKEN`
