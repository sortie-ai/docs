---
title: "Linear Adapter"
description: "Linear tracker adapter reference: GraphQL configuration, API-key authentication, workflow-state mapping, identifiers and team scoping, query_filter, pagination, rate limits, and body-first error mapping."
keywords: sortie linear adapter, linear graphql api, tracker adapter, workflow states, team key, query_filter, IssueFilter, pagination, rate limiting, error mapping, personal api key
author: Sortie AI
date: 2026-06-15
weight: 140
url: /reference/adapter-linear/
---
The Linear adapter connects Sortie to Linear over a single GraphQL endpoint, `POST https://api.linear.app/graphql`. It is registered under kind `"linear"`, fetches issues with Relay cursor pagination, and normalizes responses to the domain `Issue` and `Comment` types. Linear is a GraphQL API and reports application errors inside HTTP 200 bodies, so the adapter classifies a response by its top-level `errors` array before the HTTP status, unlike the REST trackers. The canonical API documentation is [Linear Developers: GraphQL](https://linear.app/developers/graphql).

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [how to connect Sortie to Linear](/guides/connect-to-linear/) for setup instructions, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Two fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | - | Must be `"linear"`. |
| `api_key` | string | Yes | - | Linear personal API key. Sent verbatim in the `Authorization` header, no `Bearer` prefix. See [authentication](#authentication). |
| `project` | string | Yes | - | Linear **team key** (e.g., `ENG`), the prefix on issue identifiers. Not a Linear project. See [identifiers and team scoping](#identifiers-and-team-scoping). |
| `endpoint` | string | No | `https://api.linear.app/graphql` | GraphQL endpoint URL. There is no self-hosted Linear; overriding serves tests and mocks. |
| `active_states` | list of strings | No | `["Backlog", "Todo", "In Progress"]` | Workflow-state names eligible for dispatch. |
| `terminal_states` | list of strings | No | `["Done", "Canceled", "Duplicate"]` | Workflow-state names that trigger workspace cleanup. |
| `handoff_state` | string | No | _(absent)_ | Workflow-state name set after a successful agent run. Must appear in neither `active_states` nor `terminal_states`. Absent disables handoff. |
| `query_filter` | string | No | `""` | Raw Linear `IssueFilter` JSON fragment, ANDed with the team and state constraints. See [query filter](#query-filter). |
| `user_agent` | string | No | `"sortie/dev"` | `User-Agent` header sent on all requests. |

The adapter does not define an `in_progress_state` key. Dispatch-time transitions are a Jira and GitHub feature; the Linear config validation has no `in_progress_state` arm.

State names are compared case-insensitively at startup and resolved to the team's canonical casing. `active_states` and `terminal_states` must not overlap, and `handoff_state` must appear in neither list. See [state model](#state-model).

```yaml
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
```

`api_key` accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd).

---

## Authentication

The adapter authenticates with a Linear personal API key. The key is sent **verbatim** in the `Authorization` header with **no `Bearer` prefix**:

```
Authorization: <api_key>
```

The missing-prefix detail is the most common Linear integration bug. A `Bearer`-prefixed key returns HTTP 400 with a body message instructing the caller to remove the prefix. The adapter sends the key exactly as configured, so the value must be the bare key with no scheme and no surrounding whitespace.

Personal keys carry the `lin_api_` prefix. Linear participates in GitHub secret scanning: a key committed to a public GitHub repository is detected and automatically revoked. A leaked key is dead.

Fixed headers on every request:

| Header | Value |
|---|---|
| `Authorization` | The `api_key` value, verbatim. |
| `Content-Type` | `application/json` |
| `User-Agent` | Configured `user_agent` value. |

The HTTP client has a 30-second per-request timeout. Context cancellation propagates; a cancelled context aborts the in-flight request.

### Construction-time validation

The constructor runs the `viewer` query to classify the key before the first poll cycle. A valid key returns the acting user on HTTP 200. An invalid, missing, or revoked key returns HTTP 401 with the body message `Authentication required, not authenticated`, mapped to `tracker_auth_error`, which blocks construction.

### OAuth

OAuth 2.0 is not supported. The orchestrator runs as a single headless principal, and the 24-hour OAuth access-token expiry would require a token-refresh subsystem that personal API keys make unnecessary.

---

## State model

Every Linear workflow state carries a workspace-immutable `type` category. There are seven values.

| `type` | Meaning | Suggested bucket |
|---|---|---|
| `triage` | Intake queue awaiting acceptance (optional feature). | Neither (excluded by default). |
| `backlog` | Accepted, not planned. | `active_states` |
| `unstarted` | Planned, not begun (e.g., "Todo"). | `active_states` |
| `started` | Work in progress (e.g., "In Progress", "In Review"). | `active_states` / `handoff_state` |
| `completed` | Done. | `terminal_states` |
| `canceled` | Abandoned. | `terminal_states` |
| `duplicate` | Closed as a duplicate. | `terminal_states` |

States are team-scoped. Two teams can each have an "In Progress" state with different UUIDs. A team can have several states of the same `type` (for example, "In Review" and "QA" are both `started`).

### Name-based mapping

The adapter maps issues by configured state **name**, not by `type`. `domain.Issue.State` is `issue.state.name` with original casing preserved. The `type` category does not drive selection; it serves a startup tripwire that emits a WARN when a configured `active_states` entry resolves to a `completed`, `canceled`, or `duplicate` state, or a `terminal_states` entry resolves to a non-terminal state.

### Canonical-casing preflight

Linear's `state.name.in` filter is case-sensitive. At construction the adapter fetches the team's states once, matches each configured name case-insensitively, and caches the team's exact casing. Fetch queries send the canonical names. A configured name that no state on the team matches fails construction with `tracker_payload_error` (`state "<name>" not found in team "<key>"`); an unknown team key fails the same way (`unknown team key "<key>"`).

### Default mapping

A new Linear team ships with six states and no `triage`. The verified default mapping for that layout:

```yaml
active_states: [Backlog, Todo, In Progress]
terminal_states: [Done, Canceled, Duplicate]
handoff_state: In Review   # operator-added started state; not a default
```

---

## Identifiers and team scoping

Linear exposes three identifier-like values per issue.

| Value | Example | Properties |
|---|---|---|
| `issue.id` | `a7c4f8e2-1b9d-4e3a-8f2c-6d5e4a3b2c1f` | UUID. Stable, globally unique. |
| `issue.identifier` | `ENG-123` | Human-readable. Team key plus issue number. |
| `issue.number` | `123` | Numeric part. Unique only within a team. |

The domain `ID` maps to `issue.id`; the domain `Identifier` maps to `issue.identifier`. The `issue(id:)` query accepts either the UUID or the human identifier. The adapter passes the form it holds and never constructs one form from the other.

`tracker.project` selects the Linear **team key**, not a Linear project. Workflow states are team-scoped, so the state model is well-defined only relative to one team. The team key is also the identifier prefix, which mirrors the Jira adapter where `project` is the issue-key prefix. Linear projects are cross-team containers that do not own states or identifiers. The team filter is `team: { key: { eq: "<key>" } }`; no team UUID resolution is needed for reads.

---

## Field mapping

The adapter normalizes Linear GraphQL responses to [`domain.Issue`](/reference/workflow-config/) fields.

| Domain field | Linear source | Normalization |
|---|---|---|
| `ID` | `issue.id` | UUID string, as-is. |
| `Identifier` | `issue.identifier` | String, as-is (e.g., `ENG-123`). |
| `Title` | `issue.title` | String, as-is. |
| `Description` | `issue.description` | Markdown. Null maps to empty string. |
| `Priority` | `issue.priority` | `0` (No priority) maps to `nil`. `1` (Urgent), `2` (High), `3` (Medium), `4` (Low) map to a non-nil `*int`. |
| `State` | `issue.state.name` | String with original casing preserved. |
| `BranchName` | `issue.branchName` | Opaque string, as-is. The prefix is workspace-configurable; it is never parsed. |
| `URL` | `issue.url` | String, as-is. Provided directly, not constructed. |
| `Labels` | `issue.labels.nodes[].name` | Each label lowercased. Non-nil empty slice when no labels. |
| `Assignee` | `assignee.displayName` | Fallback to `name`, then `email`. Null assignee maps to empty string. |
| `IssueType` | _(not available)_ | Always empty. Linear has no native issue-type field. |
| `Parent` | `issue.parent` | `{id, identifier}` to `{ID, Identifier}`. `nil` when absent. |
| `Comments` | Separate connection | `nil` on candidate fetch. Populated by `FetchIssueByID`. |
| `BlockedBy` | `issue.inverseRelations.nodes` | Nodes where `type == "blocks"`. See [blocker extraction](#blocker-extraction). |
| `CreatedAt` | `issue.createdAt` | ISO-8601 timestamp string, as-is. |
| `UpdatedAt` | `issue.updatedAt` | ISO-8601 timestamp string, as-is. |

Candidates are sorted client-side by normalized priority ascending, then by creation time ascending. Issues with no priority sort last. The server sort hint is not trusted.

The nested `labels` and `inverseRelations` connections are capped at the first 25 nodes and are not paginated. An issue that exceeds the cap emits a WARN (`nested connection truncated`); the dropped nodes remain observable rather than silent.

### Comment normalization

| Domain field | Linear source | Normalization |
|---|---|---|
| `ID` | `comment.id` | String, as-is. |
| `Author` | `comment.user.displayName` | Fallback to `user.name`, then `botActor.name`, else empty string. |
| `Body` | `comment.body` | Markdown pass-through. |
| `CreatedAt` | `comment.createdAt` | ISO-8601 timestamp string, as-is. |

Linear returns comments newest-first. The adapter re-sorts them ascending by creation time before returning.

### Blocker extraction

`BlockedBy` is derived from the issue's `inverseRelations`. When issue A blocks issue B, the relation appears in B's `inverseRelations` as `{ type: "blocks", issue: A }`. For each node whose `type` equals `"blocks"` (compared case-insensitively after trimming), a `BlockerRef` is produced:

| Field | Source |
|---|---|
| `ID` | `node.issue.id` |
| `Identifier` | `node.issue.identifier` |
| `State` | `node.issue.state.name` |

---

## Query filter

`tracker.query_filter` is a raw Linear `IssueFilter` written as a JSON object. The adapter merges it with the team and state constraints it sets internally; Linear ANDs sibling `IssueFilter` fields, so the result selects issues in the configured team, in the configured states, and matching the fragment.

```yaml
# Issues carrying a label named "agent-ready"
query_filter: '{"labels": {"some": {"name": {"eq": "agent-ready"}}}}'

# Issues assigned to the API key's own user
query_filter: '{"assignee": {"isMe": {"eq": true}}}'
```

`team` and `state` are reserved keys. The adapter sets them from `tracker.project` and the configured state lists. A fragment containing either top-level key is rejected at construction with `tracker_payload_error` (`tracker.query_filter must not contain a reserved key "team"`; `team` is checked before `state`). A fragment that is not valid JSON, or is not a JSON object, is rejected the same way. The adapter does not validate field names; an unknown `IssueFilter` field surfaces on the first poll as a Linear argument-validation error.

The filter applies to `FetchCandidateIssues` and `FetchIssuesByStates`. It does not apply to the ID-based and identifier-based state lookups (`FetchIssueStatesByIDs`, `FetchIssueStatesByIdentifiers`), which use `id` and `number` connection filters; those issues already passed filtering at dispatch time.

---

## Pagination

Linear uses Relay-style cursor connections. Every connection exposes `pageInfo { hasNextPage endCursor }`. The adapter requests with `after: null`, then `after: endCursor`, until `hasNextPage` is false.

| Property | Value |
|---|---|
| Page size (top-level connections) | 50 |
| Page size (nested `labels`, `inverseRelations`) | 25, not paginated |
| `first` range | 1 to 250, both bounds enforced by Linear |
| Cursor | Opaque `endCursor` token, passed back verbatim. Never parsed or constructed. |

When a connection reports `hasNextPage: true` but an empty or absent `endCursor`, the adapter returns `tracker_missing_end_cursor` rather than treating pagination as complete. Silent truncation would be a data-loss bug.

---

## Rate limiting

Linear enforces a request budget and a complexity budget per API key.

- **Request budget:** dynamic. Linear scales it by the number of paid seats in the workspace, so it is read from response headers and never hardcoded. A live single-seat workspace returned a limit of 2,500 against a documented 5,000.
- **Complexity budget:** 3,000,000 points per hour, with a 10,000-point single-query cap. The production candidate query measures about 95 points.

Linear returns these headers on every response. Reset values are epoch **milliseconds**.

| Header | Meaning |
|---|---|
| `x-ratelimit-requests-limit` | Request quota (dynamic). |
| `x-ratelimit-requests-remaining` | Requests left in the window. |
| `x-ratelimit-requests-reset` | Window reset time, epoch milliseconds. |
| `x-complexity` | Complexity score of the query. |
| `x-ratelimit-complexity-limit` | Complexity quota. |
| `x-ratelimit-complexity-remaining` | Complexity left in the window. |
| `x-ratelimit-complexity-reset` | Window reset time, epoch milliseconds. |
| `Retry-After` | Seconds to wait, present on rate-limit errors. |

The adapter inspects `x-ratelimit-requests-remaining`, `x-ratelimit-requests-reset`, and `Retry-After`. It emits a WARN (`rate limit exhausted`) naming the reset time when `x-ratelimit-requests-remaining` reaches 0. It does not throttle client-side. A rate-limited response arrives as HTTP 400 (or 429) with the body code `RATELIMITED`, mapped to `tracker_api_error` and retried with exponential backoff.

---

## Error model

A Linear response is an error when its body carries a non-empty top-level `errors` array, even on HTTP 200, or when the HTTP layer itself fails. The adapter parses the body `errors` array first and falls back to the HTTP status only when no `errors` array is present. Classification keys on `extensions.type`; `extensions.code` is diagnostic only, with one exception for the rate-limit signal.

There is no dedicated not-found type or code. An error whose `message` begins with `entity not found` (case-insensitive) maps to `tracker_not_found`. This check runs first, before any type-based rule, because a missing entity arrives under the generic `invalid input` type.

### Body-level classification

| Signal | Error kind | Retryable |
|---|---|---|
| `message` begins with `entity not found` | `tracker_not_found` | No |
| `extensions.code == "RATELIMITED"` or `extensions.type == "ratelimited"` | `tracker_api_error` | Yes |
| `extensions.type == "authentication error"` | `tracker_auth_error` | No |
| `extensions.type == "forbidden"` or `"feature not accessible"` | `tracker_auth_error` | No |
| `extensions.type` in `"invalid input"`, `"user error"`, `"graphql error"`, or `userError: true` | `tracker_payload_error` | No |
| `extensions.type` in `"internal error"`, `"network error"`, `"lock timeout"`, `"bootstrap error"` | `tracker_transport_error` | Yes |
| Any other `errors` entry | `tracker_api_error` | Depends |

### HTTP-status fallback

Applied when a non-2xx response carries no `errors` array.

| HTTP status | Error kind | Retryable |
|---|---|---|
| 400 | `tracker_payload_error` | No |
| 401, 403 | `tracker_auth_error` | No |
| 429 | `tracker_api_error` | Yes |
| 5xx | `tracker_transport_error` | Yes |
| Other | `tracker_api_error` | Depends |

A transport failure (DNS, TCP, TLS, timeout, or body-read failure) maps to `tracker_transport_error`. The error message carries the first error's `userPresentableMessage`, falling back to its `message`, so operators see Linear's own wording.

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

---

## Adapter registration

The adapter registers itself under kind `"linear"` via an `init` function in `internal/tracker/linear`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresProject` | `true` |
| `RequiresAPIKey` | `true` |
| `ValidateTrackerConfig` | Offline config diagnostics for `sortie validate`. |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages before adapter construction. `ValidateTrackerConfig` runs the Linear-specific offline checks (team-key format, `SORTIE_LINEAR_API_KEY` hint, empty or whitespace state names, state overlap, and `handoff_state` collisions) without making network calls.

---

## Key differences from the Jira and GitHub adapters

| Aspect | Jira | GitHub | Linear |
|---|---|---|---|
| Protocol | REST, multiple endpoints | REST, multiple endpoints | GraphQL, single POST endpoint |
| Auth header | `Basic base64(email:token)` | `Bearer <token>` | `<api_key>` verbatim, no scheme prefix |
| Error transport | HTTP status codes | HTTP status codes | `errors[]` inside HTTP 200 bodies |
| State model | Workflow states + transition graph | open/closed + labels-as-states | Team-scoped named states + 7 type categories |
| Identifier | `PROJ-123` (project key) | `299` (repo-scoped number) | `ENG-123` (team key + number), plus UUID |
| Pagination | `nextPageToken` / offset | `Link` header | Relay cursors (`pageInfo`, `endCursor`) |
| Rate-limit model | Points quota (65K/hr) | Requests (5K/hr) + search (30/min) | Requests (dynamic) + complexity (3M/hr, 10K/query) |

See the [Jira adapter reference](/reference/adapter-jira/) and the [GitHub adapter reference](/reference/adapter-github/).

---

## Related pages

- [How to connect Sortie to Linear](/guides/connect-to-linear/) - setup instructions with authentication, state mapping, and verification
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full schema for the `tracker` section and all other configuration
- [Error reference](/reference/errors/#tracker-errors) - all tracker error kinds with retry behavior and operator actions
- [Environment variables reference](/reference/environment/) - `$VAR` expansion modes and agent passthrough variables
- [Prometheus metrics reference](/reference/prometheus-metrics/) - `sortie_tracker_requests_total` and related counters
- [How to write a prompt template](/guides/write-prompt-template/) - using `.issue` fields (populated by this adapter) in templates
- [State machine reference](/reference/state-machine/) - orchestration states, candidate eligibility, and how tracker state drives dispatch
- [How to use the file adapter for local testing](/guides/use-file-adapter-for-testing/) - test prompts and hooks without Linear API credentials
- [Dashboard reference](/reference/dashboard/) - live monitoring of issues fetched by this adapter
