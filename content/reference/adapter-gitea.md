---
title: "Gitea Adapter"
description: "Gitea tracker adapter reference: self-hosted REST v1 configuration, token authentication, label-driven state, owner/repo scoping, query_filter, Link pagination, error mapping, and Forgejo compatibility."
keywords: sortie gitea adapter, gitea rest api, self-hosted tracker, tracker adapter, label-driven states, owner/repo, query_filter, link pagination, error mapping, access token, forgejo, codeberg
author: Sortie AI
date: 2026-07-16
weight: 150
url: /reference/adapter-gitea/
---
The Gitea adapter connects Sortie to a self-hosted Gitea instance over the Gitea REST API v1. It is registered under kind `"gitea"`, fetches issues from the repository issue-list route, derives Sortie states from repository labels, follows `Link` header pagination, and normalizes responses to the domain `Issue` and `Comment` types. Two facts shape the rest of this page. Gitea is self-hosted, so `tracker.endpoint` is required and there is no default host. Gitea exposes no GraphQL API, so the REST surface under `/api/v1` is the whole contract. The canonical API documentation is at [docs.gitea.com](https://docs.gitea.com), and each instance also serves its own OpenAPI description at `{endpoint}/api/swagger`.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [how to connect Sortie to Gitea](/guides/connect-to-gitea/) for setup instructions, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Three fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | - | Must be `"gitea"`. |
| `endpoint` | string | Yes | - | Instance base URL, for example `https://gitea.example.com`. No default host. See [endpoint](#endpoint). |
| `api_key` | string | Yes | - | Gitea access token. Sent verbatim as `Authorization: token <key>`. See [authentication](#authentication). |
| `project` | string | Yes | - | Repository in `owner/repo` form. See [identifiers and project scoping](#identifiers-and-project-scoping). |
| `active_states` | list of strings | No | `["backlog", "in-progress", "review"]` | Repository label names whose issues are eligible for dispatch. Stored lowercased. |
| `terminal_states` | list of strings | No | `["done", "wontfix"]` | Repository label names that mark completed issues. Stored lowercased. |
| `handoff_state` | string | No | _(absent)_ | Repository label name set after a successful agent run. Absent disables handoff. |
| `in_progress_state` | string | No | _(absent)_ | Repository label set at dispatch, before the agent runs. Must appear in `active_states`. Absent disables the dispatch-time transition. |
| `query_filter` | string | No | `""` | URL query fragment merged into the repository issue-list request. See [query filter](#query-filter). |
| `user_agent` | string | No | `"sortie/dev"` | `User-Agent` header sent on all requests. |

`in_progress_state` is a generic tracker field, not a Gitea-specific one. When set, the orchestrator transitions the issue into that label at dispatch through the same label swap `TransitionIssue` performs. Its collision rules (must appear in `active_states`, must not collide with `terminal_states` or `handoff_state`) are enforced by the generic config validation, so the Gitea validate hook carries no `in_progress_state` arm of its own.

```yaml
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: sortie-ai/sortie
  active_states:
    - backlog
    - in-progress
  handoff_state: review
  terminal_states:
    - done
    - wontfix
  query_filter: "assigned_by=hermes-bot"
```

`endpoint`, `api_key`, and `project` accept [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd).

### `endpoint`

The instance base URL, for example `https://gitea.example.com`. Required: Gitea is self-hosted, so there is no default host, and an empty value is a construction error. Trailing slashes are stripped. The adapter appends `/api/v1`, and tolerates a value that already ends in `/api/v1` without appending it twice. Plain-`http` endpoints send the token in cleartext; `sortie validate` warns on an `http` endpoint and on a value already ending in `/api/v1`.

### `project`

Repository in `owner/repo` form, for example `sortie-ai/sortie`. The adapter splits the value on its single slash at construction and rejects anything that is not exactly one slash with a non-empty owner and repository.

### State defaults

`defaultActiveStates` is `["backlog", "in-progress", "review"]`; `defaultTerminalStates` is `["done", "wontfix"]`. When `active_states` or `terminal_states` is omitted, the adapter substitutes the corresponding default to derive an issue's state from its labels; an open issue with no state label derives to the first active state. These defaults feed state derivation only. The orchestrator gates dispatch on the workflow's configured `active_states`, not on the adapter's substituted defaults, so an omitted `active_states` dispatches nothing. Set both lists to the repository's actual labels rather than relying on the defaults.

---

## Authentication

The adapter authenticates with a Gitea access token. The token is sent in the `Authorization` header with the lowercase `token` scheme, the canonical Gitea scheme:

```
Authorization: token <api_key>
```

Gitea also accepts the `Bearer` scheme, but the adapter sends `token`. The token is sent **verbatim**, so the configured value must be the bare token with no surrounding whitespace; a leading or trailing space becomes part of the credential and fails authentication. `sortie validate` warns when the resolved key carries surrounding whitespace.

A Gitea token is a 40-character hex string with **no identifying prefix**, unlike a GitHub `ghp_` or a Linear `lin_api_` key. Secret scanners cannot recognize a leaked Gitea token by shape.

Gitea also accepts an `?access_token=<key>` query parameter, but the adapter never uses it: a query parameter leaks the secret into URLs and server logs. The token travels only in the `Authorization` header.

### Scopes

The minimal verified scope set is `write:issue`, `read:user`, and `read:repository`. A write scope implies its read, so `write:issue` covers every issue, comment, and label operation; `read:user` covers the credential and identity check; `read:repository` covers the project check.

### Fixed headers

| Header | Value |
|---|---|
| `Authorization` | `token <api_key>`, verbatim. |
| `Accept` | `application/json` |
| `User-Agent` | Configured `user_agent` value. |
| `Content-Type` | `application/json`, on requests with a body. |

The HTTP client has a 30-second per-request timeout. Context cancellation propagates; a cancelled context aborts the in-flight request.

### Construction-time preflight

The constructor runs two calls before the first poll, and a failure blocks construction:

| Call | Purpose |
|---|---|
| `GET /user` | Validates the token and reads the automation identity. |
| `GET /repos/{owner}/{repo}` | Confirms the configured repository. |

An invalid token fails the first call (`tracker_auth_error`); a mistyped repository fails the second (`tracker_not_found`). Transient 5xx or transport failures are retried with a bounded backoff before construction fails.

---

## State model

Gitea issues natively carry only `open` and `closed`. There is no workflow engine, no transition graph, and no `state_reason` field. The adapter derives Sortie state from repository **labels**. `active_states`, `terminal_states`, and `handoff_state` name labels, lowercased at construction.

### Derivation

The adapter scans an issue's labels against the configured lists and returns the first match.

1. `active_states`, in configuration order.
2. `terminal_states`, in configuration order.
3. `handoff_state`, if set.

When more than one configured label is present, the adapter logs a WARN naming the issue and the matched labels, and keeps the first. When no configured label is present, an `open` issue maps to the first `active_states` entry and a `closed` issue maps to the first `terminal_states` entry. When both lists are empty, the native `open` or `closed` value passes through. All comparisons are case-insensitive.

### Transitions

`TransitionIssue` composes the move from label and state edits, because Gitea has no transition API. It removes the current state label by id, attaches the target state label by id, and reconciles the native state: a terminal-state target closes an open issue, and an active-state target reopens a closed one. A target that is not a configured active, terminal, or handoff state is rejected with `tracker_payload_error` before any write.

### Create-on-missing labels

A configured state label absent from the repository is created on demand with a fixed default color (`#cccccc`) the first time an issue transitions into it. Gitea silently ignores an attach of an unknown label name and returns HTTP 200, which removes the fail-loudly option that pre-created labels give on GitHub. The adapter resolves every label name to an id and attaches by id, creating the label first when the name does not resolve, so a transition to a not-yet-existing state label lands instead of no-oping.

---

## Identifiers and project scoping

A Gitea issue carries two numbers. The `number` (the index) is repo-scoped, human-visible, and the value every per-issue route consumes (`/repos/{owner}/{repo}/issues/{index}`). The `id` is an instance-global integer that no issue route accepts as input.

The adapter maps both `domain.Issue.ID` and `domain.Issue.Identifier` to the index as a string and never uses the global `id`. Because ID and Identifier are the same value, `FetchIssueStatesByIDs` and `FetchIssueStatesByIdentifiers` share one implementation.

`tracker.project` is `owner/repo`, split once at construction into the owner and repository parts. Every route the adapter builds derives from those parts.

---

## API operations

The adapter implements the nine methods of the `TrackerAdapter` interface. Every per-issue route uses the index, not the global `id`.

| Method | Gitea route(s) |
|---|---|
| `FetchCandidateIssues` | `GET /repos/{owner}/{repo}/issues?state=open&type=issues&limit=50` |
| `FetchIssueByID` | `GET .../issues/{index}`, `GET .../issues/{index}/comments`, `GET .../issues/{index}/dependencies` |
| `FetchIssuesByStates` | `GET .../issues?state=open&type=issues` and `GET .../issues?state=closed&type=issues` |
| `FetchIssueStatesByIDs` | `GET .../issues/{index}` per id |
| `FetchIssueStatesByIdentifiers` | Same as `FetchIssueStatesByIDs` |
| `FetchIssueComments` | `GET .../issues/{index}/comments` |
| `TransitionIssue` | `GET .../issues/{index}`, `GET .../labels`, `DELETE .../issues/{index}/labels/{id}`, `POST .../issues/{index}/labels`, `PATCH .../issues/{index}` |
| `CommentIssue` | `POST .../issues/{index}/comments` |
| `AddLabel` | `GET .../labels`, optional `POST .../labels`, `POST .../issues/{index}/labels` |

`type=issues` excludes pull requests server-side. The adapter keeps a `pull_request`-field guard as a second line of defense, and returns `tracker_not_found` when a per-issue route resolves to a pull request. Candidates arrive newest-first from Gitea and are re-sorted client-side by creation time ascending. `Comments` is nil on issues returned by list operations.

---

## Field mapping

The adapter normalizes Gitea issue responses to [`domain.Issue`](/reference/workflow-config/) fields.

| Domain field | Gitea source | Normalization |
|---|---|---|
| `ID` | `number` | Index as a string. Same value as `Identifier`. |
| `Identifier` | `number` | Index as a string (for example, `"42"`). |
| `Title` | `title` | String, as-is. |
| `Description` | `body` | Markdown pass-through. Empty string when null. |
| `Priority` | _(not available)_ | Always `nil`. Gitea issues have no priority field. |
| `State` | `labels` + native `state` | Derived via the [state model](#state-model). |
| `BranchName` | `ref` | Opaque string, as-is. Empty maps to null. Never parsed. |
| `URL` | `html_url` | String, as-is. |
| `Labels` | `labels[].name` | Each label lowercased. Non-nil empty slice when no labels. |
| `Assignee` | `assignees[0].login` | First assignee's login. Empty string when no assignees. |
| `IssueType` | _(not available)_ | Always empty. Gitea has no native issue-type field. |
| `Parent` | _(not available)_ | Always `nil`. Gitea has no parent or sub-issue concept. |
| `Comments` | separate route | `nil` on candidate fetch. Populated by `FetchIssueByID` and `FetchIssueComments`. Markdown. |
| `BlockedBy` | `.../issues/{index}/dependencies` | Each blocker to a `BlockerRef` with `ID` and `Identifier` set to its index and `State` label-derived. Non-nil empty slice on 404. |
| `CreatedAt` | `created_at` | RFC 3339 string, as-is. |
| `UpdatedAt` | `updated_at` | String, as-is. |

### Comment normalization

| Domain field | Gitea source | Normalization |
|---|---|---|
| `ID` | `id` | Integer formatted as a string. |
| `Author` | `user.login` | String, as-is. |
| `Body` | `body` | Markdown pass-through. |
| `CreatedAt` | `created_at` | RFC 3339 string, as-is. |

Comments arrive oldest-first from Gitea and need no client-side re-sort.

---

## Query filter

`tracker.query_filter` is a URL query fragment, parsed with `url.ParseQuery` and merged into the repository issue-list request. A value that is not a valid URL query is rejected at construction with `tracker_payload_error`.

```yaml
# Issues assigned to the automation account
query_filter: "assigned_by=hermes-bot"

# Issues carrying a label named "agent-ready"
query_filter: "labels=agent-ready"

# Combined
query_filter: "assigned_by=hermes-bot&labels=agent-ready"
```

The adapter owns four keys and rejects a fragment that names any of them at construction with `tracker_payload_error`. They are checked in this order: `state`, `type`, `page`, `limit`. Every other key passes through. Gitea silently ignores an unrecognized parameter and returns every open issue, so a key outside Gitea's known issue-list parameters (`labels`, `q`, `milestones`, `since`, `before`, `created_by`, `assigned_by`, `mentioned_by`) widens rather than narrows the result; the adapter warns at construction on such a key.

The `labels` parameter carries three edges. It is server-side AND across comma-separated names, so an issue must carry every name listed. It is case-sensitive. An unresolvable name silently drops the whole filter and returns every open issue. The adapter warns at construction when a `query_filter` label does not resolve against the repository's labels.

The filter merges into `FetchCandidateIssues` and the open-state half of `FetchIssuesByStates`. It does not merge into the closed-state half of `FetchIssuesByStates`, nor into the per-id and per-identifier reconciliation lookups, which fetch each issue directly.

---

## Pagination

List routes take `page` (1-based) and `limit`. The page-size parameter is `limit`, not `per_page`. The adapter sends `limit=50` and follows the RFC 8288 `Link` header (`rel="next"`, `rel="last"`) through the shared paginator, up to a 200-page guard.

The server clamps `limit` to the instance's `MAX_RESPONSE_ITEMS` (default 50), so the adapter iterates by the `Link` header rather than assuming a page size; an operator who lowers the cap in `app.ini` does not break pagination. An absent `Link` header is the normal end-of-results signal.

The per-issue comments route is the exception: it is unpaginated and returns the complete comment list in one response. There are no cursors, so the missing-end-cursor guard does not apply.

---

## Rate limiting

Gitea ships no built-in API rate limiting. There is no `/rate_limit` endpoint, no `x-ratelimit-*` response headers, and no `ETag` header, so there is no conditional-request cache. The budget is the self-hosted instance's capacity, and poll cadence is the only pressure control.

A reverse proxy in front of the instance may inject HTTP 429. The adapter maps 429 to `tracker_api_error` and honors a `Retry-After` header when present, but expects never to see one from Gitea itself.

---

## Error model

Every Gitea API error carries one uniform JSON body:

```json
{"message": "<diagnostic>", "url": "https://<instance>/api/swagger"}
```

The adapter maps the HTTP status to a `domain.TrackerErrorKind`.

| HTTP status | Condition | Error kind |
|---|---|---|
| 200, 201, 204 | Success | _(none)_ |
| 400 | Bad request | `tracker_payload_error` |
| 401 | Invalid credentials | `tracker_auth_error` |
| 403 | Insufficient permissions or missing scope | `tracker_auth_error` |
| 404 | Missing issue, repository, or label | `tracker_not_found` |
| 412 | Precondition failed, including an unknown `state` value on an edit | `tracker_payload_error` |
| 422 | Validation failed, including a missing required field | `tracker_payload_error` |
| 423 | Locked, including a write to an archived repository | `tracker_api_error` |
| 429 | Rate limited by a fronting proxy; honors `Retry-After` | `tracker_api_error` |
| 5xx | Server error | `tracker_transport_error` |
| - | Network, DNS, TCP, or TLS failure | `tracker_transport_error` |
| - | JSON decode failure on a 2xx response | `tracker_payload_error` |

### Silent success traps

Two Gitea behaviors return HTTP 200 with a wrong-shaped success, so no status mapping catches them. Attaching an unknown label name no-ops. A `labels` filter with an unresolvable name drops the filter and returns every open issue. The adapter's own resolve-before-write steps are the mitigation: it attaches labels by id after resolving or creating them, and it warns on an unresolved `query_filter` label rather than trusting the server to reject it.

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

---

## Adapter registration

The adapter registers itself under kind `"gitea"` via an `init` function in `internal/scm/gitea`, the combined tracker-and-SCM package. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresProject` | `true` |
| `RequiresAPIKey` | `true` |
| `ValidateTrackerConfig` | Offline config diagnostics for `sortie validate`. |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages before adapter construction. `ValidateTrackerConfig` runs the Gitea-specific offline checks (endpoint presence and shape, `owner/repo` format, empty state labels, active-terminal state overlap, and the `$SORTIE_GITEA_TOKEN` hint) without making network calls.

---

## Forgejo and Codeberg

Forgejo is the 2024 hard fork of Gitea; Codeberg is the flagship hosted Forgejo instance. Both are expected to work behind the same `kind: gitea` configuration, because the adapter targets the portable subset the two forges share: the issue and comment routes, id-based label operations, and `Link` header pagination. This compatibility is claimed by design, not tested. Testing against a pinned Forgejo image or against Codeberg is out of scope for this milestone.

One verified route divergence sits inside the portable subset. Forgejo's label-remove route accepts a name or an id, where Gitea accepts an id only; the adapter removes labels by id, which is valid on both. Operators pointing Sortie at codeberg.org must respect Codeberg's terms of service for automation; self-hosted instances are the primary target.

---

## Key differences from the GitHub adapter

Gitea and GitHub are both forge platforms with label-driven state and `owner/repo` scoping, but their APIs diverge in ways the adapter handles differently.

| Aspect | GitHub | Gitea |
|---|---|---|
| Default host | `https://api.github.com` | None; `endpoint` is required |
| Auth header | `Authorization: Bearer <token>` | `Authorization: token <key>` (Bearer also accepted; adapter sends `token`) |
| Token shape | Prefixed (`ghp_`, `github_pat_`) | 40 hex characters, no prefix |
| Permissions | Fine-grained PAT permissions | `read:`/`write:` scopes; `write:issue` covers the tracker surface |
| `labels` filter | AND across names, case-insensitive | AND across names, case-sensitive, and an unresolvable name drops the filter |
| Label removal | By name | By numeric id |
| Unknown label on attach | HTTP 422, visible | HTTP 200, silently ignored |
| Label auto-creation | Pre-created labels required | Create-on-missing |
| Sort control on lists | `sort` + `direction` | None; fixed newest-first, client-side re-sort |
| Page-size parameter | `per_page` | `limit`, clamped to `MAX_RESPONSE_ITEMS` |
| Comments route | Paginated | Unpaginated, complete in one response |
| Conditional requests | `ETag` / 304 | No `ETag` support |
| Rate limits | 5,000/hr core plus 30/min search | None built-in; instance capacity is the budget |
| Close reason | `state_reason` field | No equivalent |
| Error body | Varied shapes | Uniform `{"message", "url"}` |
| GraphQL | Available | Not available |

See the [GitHub adapter reference](/reference/adapter-github/).

---

## Related pages

- [How to connect Sortie to Gitea](/guides/connect-to-gitea/) - setup instructions with token creation, state mapping, and verification
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full schema for the `tracker` section and all other configuration
- [Error reference](/reference/errors/#tracker-errors) - all tracker error kinds with retry behavior and operator actions
- [Environment variables reference](/reference/environment/) - `$VAR` expansion modes and agent passthrough variables
- [GitHub adapter reference](/reference/adapter-github/) - the closest sibling forge adapter
- [State machine reference](/reference/state-machine/) - orchestration states, candidate eligibility, and how tracker state drives dispatch
- [How to write a prompt template](/guides/write-prompt-template/) - using `.issue` fields populated by this adapter in templates
