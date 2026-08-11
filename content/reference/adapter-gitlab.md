---
title: "GitLab Adapter"
description: "GitLab tracker, SCM, and CI adapter reference: REST v4 configuration, PRIVATE-TOKEN authentication, label-driven state, namespace-path or numeric project scoping, the query_filter allowlist, Link pagination, error mapping, merge request reviews, review decision, mergeability, auto-merge, branch cleanup, CI status, the api write scope, and Community Edition compatibility."
author: Sortie AI
date: 2026-08-06
weight: 160
url: /reference/adapter-gitlab/
---
The GitLab adapter connects Sortie to GitLab over the GitLab REST API v4. It is registered under kind `"gitlab"`, fetches issues from the project issue-list route, derives Sortie states from project labels, follows `Link` header pagination, and normalizes responses to the domain `Issue` and `Comment` types. Two facts shape the rest of this page. GitLab ships both as SaaS and as a self-managed install, so `tracker.endpoint` is **optional** and defaults to `https://gitlab.com`; it is required only to reach a self-managed instance. And the adapter targets the **Community Edition** surface, so no Premium or Ultimate feature is on the contract. The canonical API documentation is [GitLab REST API](https://docs.gitlab.com/api/rest/).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Two fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | - | Must be `"gitlab"`. |
| `api_key` | string | Yes | - | GitLab access token. Sent verbatim in the `PRIVATE-TOKEN` header. See [authentication](#authentication). |
| `project` | string | Yes | - | Namespace path or numeric project ID. See [identifiers and project scoping](#identifiers-and-project-scoping). |
| `endpoint` | string | No | `https://gitlab.com` | Instance base URL. Required only for a self-managed instance. See [endpoint](#endpoint). |
| `active_states` | list of strings | No | `["backlog", "in-progress", "review"]` | Project or group label names. Stored lowercased. See [state defaults](#state-defaults). |
| `terminal_states` | list of strings | No | `["done", "wontfix"]` | Project or group label names that mark completed issues. Stored lowercased. |
| `handoff_state` | string | No | _(absent)_ | Label name set after a successful agent run. Must appear in neither `active_states` nor `terminal_states`. Absent disables handoff. |
| `query_filter` | string | No | `""` | URL query fragment merged into the issue-list request. Validated against a closed allowlist at construction. See [query filter](#query-filter). |
| `user_agent` | string | No | `sortie/<version>` | `User-Agent` header sent on all requests. Sortie sets the tracker role's value to its own version string, so only the SCM and CI roles honor an override, set in a top-level `gitlab:` block. |

`in_progress_state` is **not** a GitLab adapter config key. The adapter never reads it. The orchestrator consumes it and routes the resulting move through the same [transition](#transitions) path, so its collision rules (must appear in `active_states`, must not collide with `terminal_states` or `handoff_state`) are enforced by the generic config validation and the GitLab validate hook carries no arm for it.

```yaml
tracker:
  kind: gitlab
  endpoint: https://gitlab.example.com # omit for GitLab.com
  api_key: $SORTIE_GITLAB_TOKEN
  project: group/subgroup/project
  active_states:
    - backlog
    - in-progress
  handoff_state: review
  terminal_states:
    - done
    - wontfix
  query_filter: "scope=assigned_to_me&not[labels]=needs-triage"
```

`endpoint`, `api_key`, and `project` accept [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd).

### `endpoint`

The instance base URL, for example `https://gitlab.example.com`. Optional: an empty or whitespace-only value becomes `https://gitlab.com`, so a GitLab.com workflow omits the field entirely. The adapter validates the value as an absolute `http` or `https` URL with a host, trims trailing slashes, and appends `/api/v4`, tolerating a value that already ends in `/api/v4` without appending it twice. A value that fails the URL check fails construction with `tracker_payload_error` before any network call.

Plain-`http` endpoints send the token in cleartext in the `PRIVATE-TOKEN` header. `sortie validate` warns on an `http` endpoint and on a value already ending in `/api/v4`.

### `project`

Either a numeric project ID or the project's full namespace path. GitLab nests subgroups to any depth, so `group/project` and `group/subgroup/project` are both valid and there is **no one-slash rule** of the kind the GitHub and Gitea adapters enforce. Write the path unencoded: the adapter percent-encodes the whole value exactly once for the API path, and a pre-encoded value is a validation error.

A project can be renamed or moved, which changes the path but not the numeric ID. A deployment that expects to survive a rename configures the numeric ID.

### State defaults

`defaultActiveStates` is `["backlog", "in-progress", "review"]`; `defaultTerminalStates` is `["done", "wontfix"]`. When `active_states` or `terminal_states` is omitted or empty, the adapter substitutes the corresponding default so it can derive an issue's state from its labels. These defaults feed state derivation. The orchestrator gates dispatch on the workflow's configured `active_states`, not on the adapter's substituted defaults, so an omitted `active_states` dispatches nothing. Set both lists to the project's actual labels rather than relying on the defaults.

---

## Authentication

The adapter authenticates with a GitLab access token sent in the `PRIVATE-TOKEN` request header:

```
PRIVATE-TOKEN: <api_key>
```

GitLab also accepts `Authorization: Bearer <token>` and a `?private_token=<token>` query parameter. The adapter uses neither. The `Authorization` header is shared with OAuth flows and is therefore ambiguous, and the query-parameter form leaks the secret into URLs, proxy logs, and server logs.

The token is sent **verbatim**, so the configured value must be the bare token with no surrounding whitespace; a leading or trailing space becomes part of the credential and fails authentication. `sortie validate` warns when the resolved key carries surrounding whitespace.

The adapter performs **no** token prefix check and no token length check, because GitLab's access-token prefix is an administrator-writable application setting rather than a fixed shape.

### Scopes

Classic GitLab access tokens carry coarse scopes, and there is no finer-grained scope for issue writes.

| Scope | Reads | Writes |
|---|---|---|
| `api` | Yes | Yes |
| `read_api` | Yes | No. Every write returns `403 {"error":"insufficient_scope"}` |

**Required scope: `api`** for the full adapter. `read_api` is enough only for a read-only deployment that never transitions an issue, posts a comment, or attaches a label.

### Token types

| Token type | Identity | Access scope | Notes |
|---|---|---|---|
| Personal access token | The owning human user | Everything that user can reach | Works. Couples automation to a person's account and their whole project set. |
| **Project access token** | A generated bot user | Exactly one project, enforced by the server | **Least privilege.** A sibling project in the same group returns 404. Available at any license on self-managed; on GitLab.com it requires a Premium or Ultimate subscription. |
| Group access token | A generated bot user | Every project in the group | Appropriate when one workflow spans a group. Same GitLab.com paid-tier requirement as the project access token. |
| OAuth 2.0 access token | The authorizing user | The granted scopes | Not used. Sortie runs headless and implements no interactive authorization-code flow. |

Project and group access tokens are created with an `access_level` that must permit issue writes. Their generated bot usernames take the form `project_<id>_bot_<hex>` and `group_<id>_bot_<hex>`, which is the identity a `query_filter` naming `assignee_username` must use.

### Fixed headers

| Header | Value |
|---|---|
| `PRIVATE-TOKEN` | `<api_key>`, verbatim. |
| `Accept` | `application/json` |
| `User-Agent` | `sortie/<version>` on tracker requests; the configured `user_agent` value on SCM and CI requests, defaulting to `sortie/dev`. |
| `Content-Type` | `application/json`, on requests with a body. |

The HTTP client has a 30-second per-request timeout. Context cancellation propagates; a cancelled context aborts the in-flight request. There is no API version header: behavior is pinned by the instance version.

---

## Construction preflight

The constructor runs three calls before the first poll. They differ in authority.

| Call | When | Authority |
|---|---|---|
| `GET /personal_access_tokens/self` | Always, once, with no retry | **Advisory. Never blocks.** |
| `GET /projects/{project}` | Always | **Authoritative gate.** A failure blocks construction. |
| `GET /projects/{project}/labels` | Only when any state label is configured | A read failure blocks construction; a missing label does not. |

**Token introspection** reads `scopes`, `active`, `revoked`, and `expires_at`. A token reporting revoked or inactive logs a WARN. An unavailable or undecodable response degrades to a debug line and construction continues; its only lasting effect is that the project-check failure message reports whether the token authenticated. The token value never appears in a log record.

**The project check** is the gate. On a 404 the constructor fails with `tracker_not_found` and a message naming both possibilities, because a project that does not exist and a project the credential cannot see are indistinguishable at the API. See [the 404 ambiguity](#the-404-ambiguity).

**The label catalog read** pages `GET /projects/{project}/labels` and resolves the canonical stored casing of every configured state label, so a later write never attaches a case variant of a label the project already holds. A configured label absent from the catalog is not an error: it is the operator's intended new label, logged as a debug line and created by the first `add_labels` write.

The project check and the catalog read retry a **retryable** failure on a bounded backoff of 1, 2, and 4 seconds; a configuration error returns immediately with no retry. A context cancellation during a backoff returns at once.

When `tracker.query_filter` names `labels`, the constructor makes one further catalog read after the preflight. It is non-blocking, and its only output is a WARN for each distinct label name absent from the catalog.

---

## State model

GitLab issues natively carry only `opened` and `closed`. There is no workflow engine and no transition graph. The adapter derives Sortie state from project **labels**. `active_states`, `terminal_states`, and `handoff_state` name labels, lowercased at construction.

### Derivation

The adapter collects every configured label present on the issue, scanning in this order:

1. `active_states`, in configuration order.
2. `terminal_states`, in configuration order.
3. `handoff_state`, if set.

When more than one matches, the adapter logs a WARN naming every matched label, carrying the issue's `iid` in the `issue_identifier` log attribute, then keeps the first. When none matches, a natively `opened` issue maps to the first `active_states` entry and a natively `closed` issue maps to the first `terminal_states` entry. With the corresponding list empty, the native `opened` or `closed` value passes through unchanged. All comparisons are case-insensitive.

### Transitions

`TransitionIssue` reads the issue, then applies the whole move in **one** `PUT` request carrying `state_event`, `add_labels`, and `remove_labels` together. GitLab applies all three in one transaction, so there is no window in which an issue carries a terminal label while still open.

| Target | Request contents |
|---|---|
| Terminal state, issue open | `state_event=close`, plus the label swap. |
| Active state, issue closed | `state_event=reopen`, plus the label swap. |
| Handoff state | Label swap only. The native state is untouched. |
| Already converged | No request is issued. |
| Not a configured active, terminal, or handoff state | Rejected with `tracker_payload_error` before any request. |

`state_event` accepts exactly `close` and `reopen`; the past-tense and GitHub-style spellings `closed` and `open` return HTTP 400. Re-sending `state_event=close` to an already-closed issue returns 200 and is a no-op, so a partial failure converges on retry.

The label swap attaches the target label under its canonical stored casing and removes every case variant of both the outgoing and the incoming label in the same request, so a project already holding a case-duplicate does not accumulate state labels on every transition. When `add_labels` and `remove_labels` name the same label, remove wins.

### Label creation is server-side

GitLab **itself** creates a label named in `add_labels` that does not yet exist, returns 200, and attaches it as a project label. The adapter therefore needs no create-on-missing policy, no name-to-id resolution, and no default label color, and there is no silent no-op on an unknown name. A `remove_labels` naming a nonexistent label likewise returns 200 and changes nothing, so removal is idempotent.

The hazard that follows is **duplication by case variant**, not a failed write. Label names are case-sensitive, so attaching `REVIEW` to an issue already carrying `review` leaves the issue with both labels and creates a second project label. Domain labels are lowercased, so both arrive as `review` and the derived state looks correct while the project has grown a phantom label. Nothing in the API reports this. The canonical-casing resolution performed by the [construction preflight](#construction-preflight) is the mitigation for configured state labels, and `AddLabel` performs the same resolution per call for escalation labels.

GitLab's `key::value` scoped labels do not enforce mutual exclusivity on Community Edition: a single request attaching `workflow::a` and `workflow::b` leaves the issue carrying both. The adapter never relies on scoped-label exclusivity and always removes the previous state label explicitly.

Labels exist at project and group level. A group label attaches to a project issue and filters exactly like a project label, and the adapter's catalog read returns both. Auto-creation always creates a *project* label, so a group-level state label must be pre-created by the operator.

---

## Identifiers and project scoping

A GitLab issue carries two integers. The `iid` is **project-scoped**, human-visible, and the value every per-issue route consumes. The `id` is an **instance-global** integer that the project-scoped routes do not accept; its own route is administrator-only in practice, and the adapter never decodes the field.

The adapter maps both `domain.Issue.ID` and `domain.Issue.Identifier` to the `iid` as a string. Because the two are the same value, `FetchIssueStatesByIDs` and `FetchIssueStatesByIdentifiers` share one implementation.

`domain.Issue.DisplayID` comes from the server-computed `references.full`, for example `group/project#2`, falling back to the configured project, `#`, and the `iid` when that field is empty.

### The identifier guard

Before building any per-issue request path, the adapter parses the supplied identifier and rejects it with `tracker_not_found` when it is not a plain positive decimal integer. Rejected without a request:

| Input | Reason |
|---|---|
| `""` or whitespace only | Empty. |
| `"007"` | Zero-padded. |
| `"12a"`, `"1.5"`, `"+42"` | Non-numeric. |
| `"0"` | Not positive. No issue has `iid` 0. |

### Project scoping

`tracker.project` is a numeric project ID or a namespace path of any depth. The adapter percent-encodes the value once, so `group/subgroup/project` reaches GitLab as `group%2Fsubgroup%2Fproject`. An unencoded slash would not match the route and returns 404.

---

## API operations

The adapter implements the nine methods of the `TrackerAdapter` interface. Every per-issue route uses the `iid`.

| Method | GitLab route(s) |
|---|---|
| `FetchCandidateIssues` | `GET /projects/{project}/issues?state=opened&issue_type=issue&scope=all&per_page=100&order_by=created_at&sort=asc` |
| `FetchIssueByID` | `GET .../issues/{iid}`, then the notes route below |
| `FetchIssuesByStates` | `GET .../issues?state=opened&...` and `GET .../issues?state=closed&...` |
| `FetchIssueStatesByIDs` | `GET .../issues?iids[]=N&iids[]=M&state=all&scope=all&per_page=100`, one request per batch |
| `FetchIssueStatesByIdentifiers` | Same as `FetchIssueStatesByIDs` |
| `FetchIssueComments` | `GET .../issues/{iid}/notes?activity_filter=only_comments&sort=asc&per_page=100` |
| `TransitionIssue` | `GET .../issues/{iid}`, then one `PUT .../issues/{iid}` |
| `CommentIssue` | `POST .../issues/{iid}/notes` |
| `AddLabel` | `GET .../labels`, then `PUT .../issues/{iid}` with `add_labels` |

Preflight routes: `GET /personal_access_tokens/self`, `GET /projects/{project}`, and `GET /projects/{project}/labels?per_page=100`.

### Candidate polling parameters

Each parameter the adapter sets on the candidate query earns its place.

| Parameter | Reason |
|---|---|
| `state=opened` | The list route's default state is **all**, not open. Omitting it would put terminal issues in the candidate set. The value is `opened`, not `open`; `state=open` returns HTTP 400. |
| `issue_type=issue` | GitLab's issue list also returns tasks, incidents, and test cases. Omitting it would dispatch agents against checklist items. |
| `scope=all` | Removes any dependence on the route's default scope. |
| `per_page=100` | The server maximum. See [pagination](#pagination). |
| `order_by=created_at`, `sort=asc` | Hands the orchestrator oldest-first candidates, so no client-side re-sort is needed. The server default is `sort=desc`. |

State filtering stays client-side. The configured state labels are never pushed into the `labels` parameter: that filter is AND across names, and candidate selection needs OR across several active states, which the route does not offer.

The adapter keeps a client-side `issue_type` guard on every read path in addition to the server-side filter, and returns `tracker_not_found` when a per-issue route resolves to a non-issue work item. `Comments` is nil on issues returned by list operations.

---

## Field mapping

The adapter normalizes GitLab issue responses to [`domain.Issue`](/reference/workflow-config/) fields.

| Domain field | GitLab source | Normalization |
|---|---|---|
| `ID` | `iid` | Project-scoped `iid` as a string. Same value as `Identifier`. The global `id` is never read. |
| `Identifier` | `iid` | Same value as `ID` (for example, `"42"`). |
| `DisplayID` | `references.full` | For example `group/project#2`. Falls back to `<project>#<iid>`. |
| `Title` | `title` | String, as-is. |
| `Description` | `description` | Markdown pass-through. Empty string when null. |
| `Priority` | _(not available)_ | Always `nil`. GitLab issues carry no priority field. |
| `State` | `labels` + native `state` | Derived via the [state model](#state-model). Native `state` is `opened` or `closed`. |
| `BranchName` | _(not available)_ | Always empty. GitLab issues carry no branch reference field. |
| `URL` | `web_url` | Stored opaque and never parsed. Points at the work-item path at the researched version; both that form and the issue path resolve. |
| `Labels` | `labels[]` | Each label lowercased. Non-nil empty slice when no labels. |
| `Assignee` | `assignees[0].username` | First assignee's username. The deprecated singular `assignee` field is never read. Empty string when unassigned. |
| `IssueType` | `issue_type` | Lowercase (`issue`, `incident`, `task`, `test_case`). The parallel uppercase `type` field is never read. |
| `Parent` | _(not available)_ | Always `nil`. The issue route exposes no parent reference. |
| `Comments` | separate route | `nil` on list operations. Populated by `FetchIssueByID` and `FetchIssueComments`. Markdown. |
| `BlockedBy` | _(not available)_ | Always a non-nil **empty** slice. See [Community Edition](#community-edition-enterprise-edition-and-gitlabcom). No links request is issued. |
| `CreatedAt` | `created_at` | ISO-8601 with zone offset, as-is. |
| `UpdatedAt` | `updated_at` | String, as-is. |

### Comment normalization

| Domain field | GitLab source | Normalization |
|---|---|---|
| `ID` | `id` | Integer formatted as a string. |
| `Author` | `author.username` | String, as-is. |
| `Body` | `body` | Markdown pass-through, no flattening. |
| `CreatedAt` | `created_at` | ISO-8601 string, as-is. |

GitLab's notes route mixes system notes into the human comment stream. Notes carrying `system: true` are **dropped**, both server-side by `activity_filter=only_comments` and again client-side, so state changes and label changes never reach an agent as human feedback. A note carrying `internal: true` passes through: it is a genuine human comment, visible to project members at Reporter level and above.

The notes route returns newest-first by default. The adapter requests `sort=asc`, so comments arrive oldest-first and need no client-side re-sort. An issue with no comments yields a non-nil empty slice.

---

## Query filter

`tracker.query_filter` is a URL query fragment, parsed with `url.ParseQuery` and merged into the issue-list request. A merged key **replaces** the adapter's own value for that key rather than appending to it, which is how a filter narrows polling to, for example, `scope=assigned_to_me`.

This adapter validates the fragment against a **closed allowlist** at construction and fails on anything outside it. That strictness is required by GitLab's behavior: an unrecognized query parameter is **silently ignored** and the route returns an unfiltered result set with HTTP 200. A typo such as `assignee=` in place of `assignee_username=` would return every open issue and widen the candidate set with no visible signal. Invalid *values* on *recognized* keys behave in the opposite, safe way and return HTTP 400, so the danger is confined to key names.

Every rejection below happens at construction, before the first poll, with `tracker_payload_error`. `sortie validate` reports the same verdict offline by running the same parser.

### Reserved keys

The adapter owns these eight and rejects a fragment naming any of them, because overriding one changes correctness rather than scope.

| | | | |
|---|---|---|---|
| `state` | `issue_type` | `order_by` | `sort` |
| `page` | `per_page` | `pagination` | `with_labels_details` |

### Allowed keys

Every other key must be one the project issue-list route honors. The complete set is:

| | | |
|---|---|---|
| `assignee_id` | `assignee_username` | `author_id` |
| `author_username` | `confidential` | `created_after` |
| `created_before` | `due_date` | `iids` |
| `in` | `labels` | `milestone` |
| `milestone_id` | `my_reaction_emoji` | `scope` |
| `search` | `updated_after` | `updated_before` |

### Negatable keys

GitLab's `not[...]` hash is accepted for the subset it honors there. The other allowed keys parse without error inside `not[...]` and then have no effect, so the adapter rejects them in that position.

| | | | |
|---|---|---|---|
| `not[assignee_id]` | `not[assignee_username]` | `not[author_id]` | `not[author_username]` |
| `not[iids]` | `not[labels]` | `not[milestone]` | `not[milestone_id]` |

`labels` and `not[labels]` are different parameters and may both appear.

### Other construction-time rejections

| Fault | Example |
|---|---|
| The fragment does not parse as a URL query. | `labels=%zz` |
| A value carries an empty comma-separated segment. | `labels=ready,,urgent` |
| A non-array key repeats. | `labels=a&labels=b` |
| Two spellings name the same parameter. | `labels=a&labels[]=b` |

Repeat an array parameter with the `[]` suffix (`iids[]=3&iids[]=4`). A key without the suffix must carry exactly one value, because repeat semantics are not portable across GitLab versions.

### Merge scope

The filter merges into candidate polling and into the `state=opened` half of `FetchIssuesByStates`. It never merges into the `state=closed` half, and never into the batched state lookup, which addresses issues by `iid` and carries no filter. A running issue therefore stays visible to reconciliation even after an edit moves it outside the filter.

### Server-side semantics

| Behavior | Detail |
|---|---|
| `labels` combination | AND across comma-separated names. An issue must carry every name listed. |
| `labels` case | Case-sensitive. `labels=BACKLOG` and `labels=backlog` are different filters. |
| Unresolvable `labels` name | Returns an **empty** set rather than dropping the filter, so a misspelling shows up as "no candidates" instead of "every candidate". |
| `None` and `Any` | Wildcards on the non-negated `labels` parameter. Under `not[labels]` GitLab treats them as literal names. |
| `assignee_username` cardinality | Community Edition accepts exactly **one** value and returns HTTP 400 for two. GitLab.com accepts several. |

At construction the adapter warns once per distinct `labels` name that no project or group label matches by exact, case-sensitive comparison. The warning does not block construction, because an operator may reference a label that does not exist yet. `None` and `Any` are skipped on the non-negated form. A catalog read failure at this point logs a WARN and construction continues.

---

## Pagination

List routes take `page` (1-based) and `per_page`. The adapter never sends `page`. It sends `per_page=100`, the server maximum, and follows the RFC 8288 `Link` header's `rel="next"` absolute URL through the shared paginator, up to a **200-page** guard that logs a WARN naming the endpoint when reached. The server default page size is 20.

The batched state lookup chunks requests at **50** distinct `iids` each. The chunk size sits far below any plausible front-end request-line limit rather than close to a measured one, which is how the adapter avoids provoking a 414.

An absent `Link` header, or a final page carrying no `rel="next"`, is the normal end of results and never an error. The adapter drives from `rel="next"` rather than from the offset-header family for a documented reason: above 10,000 records GitLab omits `X-Total`, `X-Total-Pages`, and the `rel="last"` link, so counting up to a page total would silently truncate on exactly the large projects where it matters. That omission is documented by GitLab and was not verified against a live instance during adapter research.

GitLab also supports keyset pagination (`pagination=keyset`), which advertises its next page in the same `Link` header with an opaque embedded cursor. The adapter does not use it. Because GitLab exposes no cursor the adapter must carry itself, the missing-end-cursor error kind has no analogue here.

Unlike Gitea's comments route, the GitLab notes route **is** paginated, and the adapter routes it through the same paginator.

---

## Rate limiting

Two products, two answers, and the self-managed default is the opposite of what the SaaS behavior suggests.

| | Self-managed Community Edition | GitLab.com |
|---|---|---|
| General API throttling | **Disabled by default** | Enabled |
| Documented budget | 7,200 requests per hour per user, once enabled | 2,000 authenticated API requests per minute |
| `RateLimit-*` headers | Absent while throttling is off | Present |
| Note-creation limit | 300 per minute | **60 per minute** |
| Search API limit | 30 per minute | 10 per minute per IP |

The hosted product is the **stricter** one on note creation, so a deployment tuned against a self-managed instance can hit the comment limit on GitLab.com.

GitLab.com returns the IETF-style headers `RateLimit-Limit`, `RateLimit-Name`, `RateLimit-Observed`, `RateLimit-Remaining`, and `RateLimit-Reset`. GitLab documents two more on a 429, `RateLimit-ResetTime` and `Retry-After`. These are **not** GitHub's `X-RateLimit-*` names; header names copied from the GitHub adapter match nothing here.

The adapter parses **no** `RateLimit-*` header and applies no preemptive throttling. On a 429 it reads `Retry-After` only to log a WARN, maps the status to `tracker_api_error`, and leaves backoff to the orchestrator's retry classification. Poll cadence is the pressure control.

A self-managed 429 body is not guaranteed to be JSON: the response text is an operator-configurable instance setting. The adapter never requires a parseable body to classify a 429.

---

## Error model

The adapter maps the HTTP status to a `domain.TrackerErrorKind`.

| HTTP status | Condition | Error kind |
|---|---|---|
| 2xx | Success | _(none)_ |
| 400 | Parameter or model validation, including a parameter enum missing an Enterprise Edition value | `tracker_payload_error` |
| 401 | Missing, invalid, revoked, or expired token | `tracker_auth_error` |
| 403 | Insufficient token scope, a license-gated feature, or a route requiring administrator | `tracker_auth_error` |
| 404 | Missing issue, missing project, or a project the credential cannot see | `tracker_not_found` |
| 409 | Conflict | `tracker_api_error`. Not exercised: no 409 was provoked on any adapter route during research. |
| 414 | Request URI too large, from an over-long `iids[]` batch | `tracker_payload_error`. Documented by GitLab, not observed; the adapter prevents it by chunking. |
| 422 | Unprocessable entity | `tracker_payload_error`. Not exercised: validation failures arrived as 400 on the issue surface. |
| 429 | Rate limited. Logs `Retry-After` when present | `tracker_api_error` |
| 5xx | Server error | `tracker_transport_error` |
| Any other status | Unexpected status | `tracker_api_error` |
| - | Network, DNS, TCP, or TLS failure | `tracker_transport_error` |
| - | JSON decode failure on a 2xx response | `tracker_payload_error` |

The 414 arm extends the set the GitHub and Gitea adapters classify, because the batched `iids[]` lookup is the one adapter request whose URL length grows with input.

### Error body

GitLab has no single error envelope. Four shapes occur:

| Shape | Origin |
|---|---|
| `{"message": "<string>"}` | Application-level errors. |
| `{"error": "<string>"}` | Parameter validation and unmatched routes. |
| `{"error": "...", "error_description": "..."}` | Token authorization, OAuth-style. |
| `{"message": "<string with embedded model errors>"}` | Model validation surfaced through a message. |

Detail extraction prefers `message`, tolerating a non-string value there by compacting it rather than failing the whole response. It falls back to `error`, appends `error_description` when present, and falls back again to a bounded raw snippet when the body does not decode as JSON at all. The error message carries the request method and path and never the token, which travels only in the `PRIVATE-TOKEN` header.

### The 404 ambiguity

A 404 on a project-scoped route has three causes the response cannot distinguish, and one of them is an authorization failure:

| Cause | Response |
|---|---|
| The project does not exist | `404 {"message":"404 Project Not Found"}` |
| The project exists and the token's identity is not a member | Byte-identical |
| No token at all, private project | Byte-identical |

This is deliberate. GitLab masks the existence of private resources rather than returning 403, so an unauthorized caller cannot enumerate them. Note the asymmetry: a bad *token* returns 401, while a valid token lacking *access* returns 404. A 404 can therefore never be ruled out as an authorization problem. The [construction preflight](#construction-preflight) is the mitigation: a wrong project or an unauthorized token fails at startup with a message naming both possibilities, rather than producing a permanent stream of not-found results at poll time.

### Silent success traps

The dangerous failures on this API are the **200s**. Four behaviors return success with the wrong result and no status to key on.

| Trap | Effect |
|---|---|
| An unrecognized query parameter | Silently disables the filter and returns an unfiltered set. |
| A case-variant label attach | Silently creates a duplicate project label instead of matching the existing one. |
| `remove_labels` naming a nonexistent label | Returns 200 and changes nothing. |
| No concurrency control on issue updates | Two simultaneous opposing writes both return 200, with no 409 and no conflict signal, and their label deltas interleave. |

The first two are prevented by the adapter's own validation: the [`query_filter` allowlist](#query-filter) and the [canonical-casing resolution](#label-creation-is-server-side).

### Write-path guards

| Guard | Behavior |
|---|---|
| Comment created with no returned ID | Treated as a failure with `tracker_payload_error`. GitLab returns no note when the body was consumed entirely as quick actions, and reporting that as success would lose the comment silently. |
| Comment body that triggered quick actions | Logs a WARN naming the executed command keys. The note text itself is never logged. |
| Empty or whitespace-only label on `AddLabel` | Attaches nothing, issues no request, returns nil, and logs a WARN, so a caller reading nil as a successful escalation is not the only record. |
| Label catalog unavailable during `AddLabel` | Logs a WARN and attaches the configured spelling, because a missed escalation is worse than a cosmetic duplicate. |

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

---

## SCM and CI surface

The `gitlab` kind also provides an SCM adapter and a CI status provider, so a GitLab-backed deployment drives the same pull-request reactions as a GitHub-backed one: review-comment feedback, CI-failure escalation, auto-merge, and branch cleanup. The reaction kinds and their lifecycle are provider-agnostic and documented in the [reactions reference](/reference/reactions/); `provider: gitlab` on a reaction block activates this adapter, and [how to set up PR reactions](/guides/setup-pr-reactions/) covers the operator procedure. This section documents only the GitLab-specific behavior.

Both roles take `api_key` and `endpoint` from a top-level `gitlab:` block ([adapter pass-through configuration](/reference/workflow-config/#adapter-pass-through-configuration)), falling back to the `tracker` block's values for any key that block omits when `tracker.kind` is also `gitlab`. `endpoint` behaves exactly as it does for the tracker, defaulting to `https://gitlab.com` and taking the instance root rather than the API path. The CI status provider also requires `project`; the SCM adapter ignores it, because owner and repo arrive with each call. Neither role makes a network call at construction.

### SCM read operations

The adapter implements the six read methods of the `SCMAdapter` interface, plus `VerifyAutoMergeScopes`. Every merge-request route addresses the same project-scoped `iid` the tracker adapter uses.

| Method | GitLab route(s) |
|---|---|
| `GetReviewDecision` | `GET /projects/{project}/merge_requests/{iid}/reviewers`, then `GET .../merge_requests/{iid}/approvals` |
| `GetMergeability` | `GET /projects/{project}/merge_requests/{iid}` |
| `GetCIStatus` | `GET /projects/{project}/merge_requests/{iid}`; reads the embedded `head_pipeline`, no second request |
| `FetchPendingReviews` | `GET .../merge_requests/{iid}/reviewers`, `GET .../merge_requests/{iid}/notes`, and `GET /users/{id}` per unresolved reviewer |
| `FetchBotReviewComments` | `GET .../merge_requests/{iid}/notes`, and `GET /users/{id}` per unresolved author |
| `ListLabelEvents` | `GET .../merge_requests/{iid}/resource_label_events` |
| `VerifyAutoMergeScopes` | `GET /personal_access_tokens/self` |

The project half of every route above is built from the caller's `owner` and `repo`, joined with a slash and percent-encoded once. The two values together must reconstruct the project's full namespace path, and a project nested in subgroups may carry its intermediate groups on either side of the split. A half that arrives already percent-encoded reaches GitLab double-encoded and returns 404.

The reviewers, notes, and label-event routes all paginate through the same `Link` header walk the tracker adapter uses, requesting `per_page=100` and stopping at a 200-page guard. When a returned comment carries a diff position, normalizing it into a review comment costs one further `GET /projects/{project}/merge_requests/{iid}` read, to compare the comment's recorded head SHA against the merge request's current head and set the outdated flag; a general, non-diff comment costs no extra read.

### Mergeability

GitLab exposes mergeability as a single `detailed_merge_status` string rather than GitHub's `mergeable_state` enum. The adapter maps four arms and treats everything else as blocked:

| `detailed_merge_status` | Mergeability |
|---|---|
| `mergeable` | Clean |
| `conflict` | Dirty |
| `unchecked`, `checking`, `preparing`, `approvals_syncing` | Unknown |
| Any other value, including one the adapter does not recognize | Blocked, logged at WARN when unrecognized |

The adapter never reports [`unstable`](/reference/reactions/#normalized-mergeability-states). A pipeline whose only failing job carries `allow_failure: true` reports `success`, so its merge request reports `mergeable` and maps to clean; the warning survives only in the pipeline's own detailed status, which no merge read consults.

`detailed_merge_status` recomputes: approving a merge request has been observed to flip the value from `mergeable` to `checking` and back within the same second. A single read can land mid-recompute, so the auto-merge precondition check treats that window as unknown rather than clean, and the reconcile loop re-enqueues for the next poll instead of merging on a stale computation. Expect the check to cost an extra poll tick right after an approval or a push, not a stuck state.

### Review decision

Community Edition carries no `approvals_required` and no `approvals_left` on the merge request object, and the richer `approval_state` route that would answer "is review required" is Enterprise Edition only, returning 404 on Community Edition. The approvals payload alone can say only whether a merge request has been approved, never whether approval is required, so `GetReviewDecision` folds the decision from two reads, the per-reviewer states and the approvals payload, evaluated in this order:

1. Any reviewer's state is `requested_changes` → `CHANGES_REQUESTED`, decided before the approvals read.
2. The approvals payload reports `approved: true` → `APPROVED`.
3. The merge request has at least one reviewer → `REVIEW_REQUIRED`.
4. No reviewers and no approval → `NOT_REQUIRED`.

The changes-requested arm is checked first and returns unconditionally, so a later approval from a second reviewer can never clear an outstanding change request. The last arm is the one Community Edition operators should read closely: Community Edition has no approval rules, so it can never *require* an approval, and a merge request with no reviewer assigned is genuinely unreviewed rather than pending. `NOT_REQUIRED` lets auto-merge proceed on such a merge request. An operator who wants review enforced on Community Edition must assign a reviewer; the platform offers no server-side alternative.

### Bot classification

A note's embedded author carries no platform bot marker on GitLab; only `GET /users/{id}` reports one. `FetchBotReviewComments` selects a comment when its author matches the [`bot_usernames`](/reference/reactions/#reactionsbot_review) allowlist with no lookup, and otherwise resolves the platform marker through that route; a lookup failure aborts the whole read, because the lookup only ever widens the selected comment set, and silently dropping a bot's comments there is worse than failing the call. `FetchPendingReviews` excludes a `requested_changes` reviewer whose account resolves as a platform bot, but applies no `bot_usernames` allowlist of its own: a review tool that comments under a regular user identity still counts as a blocking reviewer there. A lookup failure in `FetchPendingReviews` logs a WARN and treats the reviewer as not a bot rather than aborting.

Resolved bot flags are cached for the adapter's lifetime, so a given author costs one `GET /users/{id}` call at most once per process. This differs from GitHub, whose embedded comment author carries its own account-type marker with no extra request, and from Gitea, which exposes no platform marker at all and relies solely on the `bot_usernames` allowlist.

### Label events

`ListLabelEvents` reads the merge request's resource label-event journal and normalizes add and remove events to the same `domain.LabelEvent` shape the [label commands](/reference/label-commands/) reactions consume, sorted ascending by event time and then by event id. An event whose label was later deleted from the project carries no name and is skipped.

### Pipeline status

`GetCIStatus` maps the merge request's `head_pipeline.status` onto the merge-gate conclusion the [auto-merge CI precondition](/reference/reactions/#reactionsauto_merge) reads. The platform folds an externally reported commit status into the head pipeline, so the pipeline's own status already accounts for one and no second request is issued.

| `head_pipeline.status` | CI conclusion |
|---|---|
| `head_pipeline` absent | Empty, meaning no checks exist on the head |
| `success`, `skipped` | `success` |
| `failed`, `canceled` | `failing` |
| `created`, `waiting_for_resource`, `preparing`, `waiting_for_callback`, `pending`, `running`, `canceling`, `scheduled`, `manual` | `pending` |
| Any other value | `pending`, logged at WARN naming the observed value |

A `skipped` pipeline is merge-eligible. GitLab reports that status only for a pipeline whose every job is skipped or an untriggered manual job, so its job set cannot carry a failing conclusion.

A `manual` pipeline holds at `pending` even though it has settled, because GitLab also reports `manual` for a pipeline carrying a blocking manual job alongside a job that failed. With `require_ci: true`, an auto-merge entry on such a head defers on every tick rather than merging.

### CI status provider

The package registers a CI status provider under kind `gitlab`, the role that drives the [`ci_failure` reaction](/reference/reactions/#reactionsci_failure). `FetchCIStatus` resolves the given ref to a commit SHA and the pipeline GitLab reports as that commit's current one, then reads that pipeline's commit-status list to exhaustion and normalizes each entry to a check run. A commit with no pipeline yields an empty, non-nil check-run list and a pending result, the same convention the GitHub and Gitea providers use.

The commit-status read scopes to one pipeline twice: on the wire, through the `pipeline_id` query parameter, and again after decoding, by discarding any entry whose own `pipeline_id` differs, across every page the read walks. The second check is what keeps the scope correct against a deployment that ignores the query parameter, whether the mismatched entries land on the first page or a later one.

Each status entry's `status` and `allow_failure` fields decide its check conclusion and run status:

| Entry `status` | Conclusion | Run status |
|---|---|---|
| `success` | `success` | Completed |
| `failed` with `allow_failure: false` | `failure` | Completed |
| `failed` with `allow_failure: true` | `neutral` | Completed |
| `canceled` | `cancelled` | Completed |
| `skipped` | `skipped` | Completed |
| `manual` | `neutral` | Completed |
| `created`, `pending`, `waiting_for_resource`, `waiting_for_callback`, `preparing`, `scheduled` | `pending` | Queued |
| `running`, `canceling` | `pending` | In progress |
| Any other value | `pending` | In progress, logged at WARN naming the observed value and the count |

An allowed-to-fail job therefore never turns the aggregate red and is never counted as failing. The aggregate status and failing count come from the same shared rule the GitHub and Gitea providers use. A pipeline reporting `manual` is the one shape on which the two CI readers differ: every untriggered manual job is a completed, non-failing run here, so the aggregate is passing, while the [merge gate](#pipeline-status) holds at `pending`.

On a failing verdict, the log excerpt is the sanitized tail of the first failing job's trace, capped by the `max_log_lines` budget; a `max_log_lines` of zero or less disables it. GitLab ignores the `Range` header on the trace route, so a trace larger than 1 MiB yields the tail of that first megabyte rather than the true tail. `Ref` in the returned result always echoes the caller's input ref, never the resolved SHA.

### The write surface

The write methods are `MergePR`, `DeleteBranch`, and `RemoveLabel`. The supported merge strategies are `merge`, `squash`, and `rebase`, the same set the auto-merge [`strategy` field](/reference/reactions/#reactionsauto_merge) accepts.

`MergePR` calls `PUT /projects/{project}/merge_requests/{iid}/merge` and always sends the expected head SHA as a stale-head precondition; a call with no expected SHA is rejected before any request. GitLab expresses rebase-on-merge as the target project's own merge-method setting rather than a per-call parameter, so a `rebase` request issues the same call as `merge` and logs one WARN naming that governance.

| Merge outcome | GitLab response | Mapping |
|---|---|---|
| Merged | HTTP 200, decoded state `merged` | Success, carrying the merge commit SHA. |
| Already merged, draft, or conflicting | HTTP 405, a constant body naming no reason | Conflict error. A re-read of the merge request confirms whether it landed; only then does the error carry the "already merged" marker. |
| Stale expected head SHA | HTTP 409 | Conflict error, same re-read disposition as the 405 case. |
| Branch protection refuses the merge, or the credential is invalid | HTTP 401 or 403 | Auth error, rewritten to name both possible causes, since GitLab answers a branch-protection refusal on this route with 401 rather than the 403 a plain permission failure returns elsewhere in the API. |
| HTTP 200 with a decoded state other than `merged` | n/a | Conflict error directly, with no "already merged" marker. |

The already-merged marker is never read from GitLab's rejection text: the 405 body is byte-identical across the already-merged, draft, and conflicting cases, so the adapter re-reads the merge request after any 405 or 409 and attaches the marker only when that re-read shows the merge landed.

`DeleteBranch` calls `DELETE /projects/{project}/repository/branches/{branch}`, with the branch name percent-encoded. An already-gone branch, HTTP 404, is returned as a not-found error, which the caller treats as a successful no-op.

`RemoveLabel` reads the merge request's own labels, matches the target name case-insensitively, and sends every matching case variant in one `PUT /projects/{project}/merge_requests/{iid}` carrying `remove_labels`, because GitLab matches label names case-sensitively and a project can accumulate case-duplicate labels (see [label creation is server-side](#label-creation-is-server-side)). No match is a no-op; a 404 reading or writing the merge request maps to a no-op too, since on GitLab that status can only mean the merge request or the project is gone, never an absent label.

### Token scope for the write path

`api` is the only classic scope that can perform `MergePR`, `DeleteBranch`, or `RemoveLabel`; `read_api` performs every read this section documents and is refused on every write with `403 {"error":"insufficient_scope"}`. This is the same [scopes](#scopes) table the tracker surface uses; GitLab has one coarse write scope covering both surfaces, not a separate contents-and-pull-request split.

The startup auto-merge preflight calls `GET /personal_access_tokens/self` once. A classic token reporting `api` in its scopes passes; one that omits it fails closed, blocking auto-merge for the process lifetime. A token whose scopes report as the opaque `["granular"]` value, an empty scopes array, an unreadable introspection response, or an instance whose introspection route answers 404, all fail open instead: the preflight cannot verify anything from them, so it lets auto-merge proceed rather than blocking a credential it cannot classify. A fine-grained ("granular") GitLab token is the practical case this covers, because its scopes carry no permission detail for the preflight to read; confirm a granular token's permissions directly rather than relying on this check.

### Key differences from the GitHub adapter

| Aspect | GitHub | GitLab |
|---|---|---|
| Mergeability signal | `mergeable_state` enum with several concrete blocking states | Single `detailed_merge_status` value that recomputes and can mask a second blocker |
| Review decision | GraphQL aggregate field, read directly | No aggregate on Community Edition; folded from per-reviewer states plus the approvals payload |
| Bot classification | Account-type marker on the embedded comment author, no extra request | No marker on the embedded author; resolved per user through a separate, cached request |
| Merge and branch token scope | `pull_requests:write` plus `contents:write`, or classic `repo` | One coarse `api` scope covers merge, branch delete, and label removal |
| Rebase-on-merge | A per-call merge strategy | The target project's own merge-method setting; a per-call rebase request logs a WARN and merges the same way as `merge` |

See the [GitHub adapter reference](/reference/adapter-github/).

---

## Adapter registration

The adapter registers itself under kind `"gitlab"` via an `init` function in `internal/scm/gitlab`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresProject` | `true` |
| `RequiresAPIKey` | `true` |
| `DefaultActiveStates` | `["backlog", "in-progress", "review"]` |
| `DefaultTerminalStates` | `["done", "wontfix"]` |
| `ValidateTrackerConfig` | Offline config diagnostics for `sortie validate`. |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages before adapter construction, and resolves the adapter through the registry rather than by importing the package.

The package sits under the source-control adapter family rather than in a tracker-only package, because forge integrations live in one package per forge and GitLab's issue and merge-request halves share their authentication, project addressing, pagination, error envelopes, and comment entity. This package also registers the **source-control** and **CI status provider** roles, documented in [SCM and CI surface](#scm-and-ci-surface).

---

## Offline validation

`sortie validate` runs the GitLab-specific checks below without making network calls.

### Errors

| Check | Condition |
|---|---|
| `tracker.endpoint.invalid` | A present `endpoint` that does not parse to an absolute `http` or `https` URL with a host. |
| `tracker.project.format` | `tracker.project` is whitespace only. |
| `tracker.project.format` | `tracker.project` contains embedded whitespace. |
| `tracker.project.format` | `tracker.project` is percent-encoded. |
| `tracker.project.format` | `tracker.project` contains no slash and is not all digits. |
| `tracker.project.format` | `tracker.project` has an empty path segment, a leading slash, or a trailing slash. |
| `tracker.query_filter.invalid` | The fragment fails the same parser the constructor uses. |

The project checks are evaluated in that order and report the first fault that applies. A value of all ASCII digits is accepted as a numeric project ID and skips the remaining checks.

### Warnings

| Check | Condition |
|---|---|
| `tracker.endpoint.insecure` | `endpoint` uses `http`; the token travels in cleartext in the `PRIVATE-TOKEN` header. |
| `tracker.endpoint.api_suffix` | `endpoint` already ends in `/api/v4`; the adapter appends it automatically. |
| `tracker.api_key.sortie_gitlab_token_hint` | `api_key` is empty and `SORTIE_GITLAB_TOKEN` is set in the environment. |
| `tracker.api_key.sortie_gitlab_token_missing` | `api_key` is empty and `SORTIE_GITLAB_TOKEN` is not set. |
| `tracker.api_key.gitlab_whitespace` | `api_key` has leading or trailing whitespace. |
| `tracker.active_states.empty_element`, `tracker.terminal_states.empty_element` | A state list element is empty or whitespace only. |
| `tracker.active_states.untrimmed_element`, `tracker.terminal_states.untrimmed_element` | A state list element has leading or trailing whitespace. |
| `tracker.states.overlap` | A name appears in both `active_states` and `terminal_states`, compared case-insensitively. |

`SORTIE_GITLAB_TOKEN` is the conventional variable name this advisory suggests, not a separate config path; the key resolves through the standard `tracker.api_key` field.

### Deliberate non-checks

| Not checked | Reason |
|---|---|
| An empty `endpoint` | No diagnostic. The constructor substitutes `https://gitlab.com`. |
| A one-slash rule on `project` | GitLab subgroups nest to any depth. |
| Token prefix or length | The prefix is an administrator-writable application setting. |

---

## Community Edition, Enterprise Edition, and GitLab.com

**Every `TrackerAdapter` operation is available on self-managed Community Edition 19.2.1, verified live, with exactly one degradation in the normalized issue model and none in behavior.** That degradation is `BlockedBy`. GitLab's blocking issue-link types are a paid feature, so the relation is structurally unavailable on Community Edition and `domain.Issue.BlockedBy` normalizes to a non-nil empty slice. The adapter does not populate it from `relates_to` links: a "relates to" edge carries no direction and no blocking semantics, and inventing blockers would suppress dispatch for merely cross-referenced issues.

Community Edition is the compatibility floor. The adapter depends only on what it provides. No minimum GitLab version is claimed; the facts on this page hold for the pinned version's defaults.

Two caveats belong with that verdict. **No self-managed Enterprise Edition instance was available during adapter research**, so every Enterprise Edition claim rests on documentation and upstream source reading rather than observation. And GitLab.com, though built from the Enterprise Edition codebase, is not a self-managed Enterprise Edition deployment; the two are not interchangeable. GitLab.com on the Free plan is likewise **not** Community Edition: it gates features by namespace subscription plan rather than by which code is loaded, so the same gap surfaces as a different error.

| Product | Codebase | Feature gating |
|---|---|---|
| Self-managed Community Edition | Community Edition only | Nothing to gate. Enterprise routes and parameters are absent from the running API. |
| Self-managed Enterprise Edition | Community Edition plus the Enterprise tree | License tier gates features at the service layer. |
| GitLab.com | Enterprise Edition | Namespace subscription plan gates features. |

### Surface the adapter avoids

| Feature | Community Edition behavior |
|---|---|
| Blocking issue links (`link_type=blocks`, `is_blocked_by`) | HTTP 400: the value is not in the enum. On GitLab.com Free the same request returns 403 naming the license. |
| Issue `weight`, write and filter | Not an accepted update parameter; silently ignored as a filter. |
| `epic_id`, `epic_iid` | Absent from the accepted parameter set. |
| Multiple assignees | HTTP 400 for a second `assignee_username` value. |
| Scoped-label mutual exclusion | Not enforced; both labels coexist. |
| `iteration_id`, `iteration_title`, `health_status` | Declared only in the Enterprise tree. |
| `blocking_issues_count` issue field | Absent from the issue object. |

---

## Key differences from the Gitea and GitHub adapters

All three are forge platforms with label-driven state, but nearly every value a reader looks up differs.

| Aspect | GitHub | Gitea | GitLab |
|---|---|---|---|
| Default host | `https://api.github.com` | None; `endpoint` is required | `https://gitlab.com`; `endpoint` is optional |
| Auth header | `Authorization: Bearer <token>` | `Authorization: token <key>` | `PRIVATE-TOKEN: <key>` (Bearer also accepted; adapter sends `PRIVATE-TOKEN`) |
| Token shape | Prefixed (`ghp_`, `github_pat_`) | 40 hex characters, no prefix | Prefixed, but the prefix is an instance setting, so no shape check |
| Least-privilege token | Fine-grained PAT, per-repository | Scopes only | **Project access token**, single project enforced by the server |
| Permission model | Per-resource permissions | `read:` / `write:` scopes | Coarse `api` / `read_api` only |
| Token introspection | n/a | Scopes visible only inside a 403 body | `GET /personal_access_tokens/self`: scopes, active, revoked, expiry |
| Issue identifier | Repo-scoped number | Repo-scoped index | Project-scoped `iid`; a global `id` exists and is inaccessible |
| Project scoping | `owner/repo`, one slash | `owner/repo`, one slash | Numeric ID or percent-encoded path, **any number of slashes** |
| Non-issue items in the list | Pull requests, excluded by a key check | Pull requests, excluded by `type=issues` | Tasks, incidents, test cases, excluded by `issue_type=issue` |
| Default list state | Open | Open | **All**; must be set explicitly |
| `labels` filter | AND, case-insensitive | AND, case-sensitive, unresolvable name **drops the filter** | AND, case-sensitive, unresolvable name returns an **empty** set |
| Unknown query parameter | Error | Ignored; adapter warns and forwards | **Silently ignored**; adapter rejects at construction against an allowlist |
| Unknown label on attach | HTTP 200, label created by the endpoint | HTTP 200, silently ignored | **HTTP 200, label created by the server** |
| Label case handling | Case-insensitive | Case-sensitive | Case-sensitive **and** auto-creating, so a case variant creates a duplicate |
| Transition cost | Several requests | Up to five requests | One read plus **one** `PUT` |
| Batch state lookup | Per-issue or search | Per-issue loop | **One request** per 50 `iids` |
| Comments route | Paginated | Unpaginated | Paginated, **and system notes must be filtered** |
| Comment default order | n/a | Oldest-first | **Newest-first**; `sort=asc` requested |
| Page-size maximum | 100 (`per_page`) | 50 (`limit`) | 100 (`per_page`) |
| Rate limits | 5,000/hr core plus 30/min search | None built-in | **Off by default self-managed**; 2,000/min on GitLab.com with a stricter 60/min note-creation limit |
| Rate-limit header names | `X-RateLimit-*` | None | `RateLimit-*` (IETF style), absent when throttling is off |
| `BlockedBy` | Dependencies endpoint | Dependencies endpoint | **Unavailable on Community Edition**; always empty |
| Error envelope | Varied shapes | Uniform `{"message", "url"}` | **Four shapes**; `message` and `error` both read |
| Unauthorized resource | 404 | 404 | 404, byte-identical to a missing project |
| GraphQL | Available, used for review decisions | Not available | Available, **not needed** for the tracker |

See the [GitHub adapter reference](/reference/adapter-github/) and the [Gitea adapter reference](/reference/adapter-gitea/).

---

## Related pages

- [How to connect Sortie to GitLab](/guides/connect-to-gitlab/) - setup instructions with token creation, state mapping, and verification
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full schema for the `tracker` section and all other configuration
- [Error reference](/reference/errors/#tracker-errors) - all tracker error kinds with retry behavior and operator actions
- [Environment variables reference](/reference/environment/) - `$VAR` expansion modes and agent passthrough variables
- [GitHub adapter reference](/reference/adapter-github/) - the closest sibling forge adapter
- [Gitea adapter reference](/reference/adapter-gitea/) - the other self-hostable forge adapter
- [State machine reference](/reference/state-machine/) - orchestration states, candidate eligibility, and how tracker state drives dispatch
- [Prometheus metrics reference](/reference/prometheus-metrics/) - `sortie_tracker_requests_total` and related counters
- [How to write a prompt template](/guides/write-prompt-template/) - using `.issue` fields populated by this adapter in templates
