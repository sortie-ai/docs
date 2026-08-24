---
title: "Linear Adapter"
description: "Linear tracker adapter reference: GraphQL configuration, API-key authentication, workflow-state mapping, identifiers and team scoping, query_filter, pagination, rate limits, and body-first error mapping."
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
| `endpoint` | string | No | `https://api.linear.app/graphql` | GraphQL endpoint URL. There is no self-hosted Linear; overriding serves tests and mocks. A present value must be an absolute http(s) URL with a hostname or construction fails. |
| `active_states` | list of strings | No | `["Backlog", "Todo", "In Progress"]` | Workflow-state names eligible for dispatch. |
| `terminal_states` | list of strings | No | `["Done", "Canceled", "Duplicate"]` | Workflow-state names that trigger workspace cleanup. |
| `handoff_state` | string | No | _(absent)_ | Workflow-state name set after a successful agent run. Must appear in neither `active_states` nor `terminal_states`. Absent disables handoff. |
| `query_filter` | string | No | `""` | Raw Linear `IssueFilter` JSON fragment, ANDed with the team and state constraints. See [query filter](#query-filter). |

`user_agent` is not a Linear adapter config key an operator can set. Sortie sets the tracker role's value to its own version string, and `linear` fills no SCM or CI role, so a value supplied in a top-level `linear:` block is ignored.

`tracker.in_progress_state` is validated and executed by the orchestrator the same way for every tracker kind: it drives a dispatch-time transition through the adapter's `TransitionIssue` method, gated on dispatch posture rather than on tracker kind, so it works under `kind: linear` the same way it does under Jira or GitHub. The one real difference is construction-time coverage. The Linear adapter reads `active_states`, `terminal_states`, and `handoff_state` at construction and checks each against the team's workflow states (see [canonical-casing preflight](#canonical-casing-preflight)), but it never reads `in_progress_state` itself. A misconfigured `in_progress_state` therefore surfaces only at dispatch time, as a `tracker_payload_error` from the transition call, rather than as a construction failure.

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

The adapter sends the key exactly as configured, so the value must be the bare key with no scheme and no surrounding whitespace; a `Bearer` prefix or stray whitespace becomes part of the credential and fails authentication. Personal keys carry the `lin_api_` prefix; the offline validator warns when a configured key lacks it or carries surrounding whitespace (see [adapter registration](#adapter-registration)).

Fixed headers on every request:

| Header | Value |
|---|---|
| `Authorization` | The `api_key` value, verbatim. |
| `Content-Type` | `application/json` |
| `User-Agent` | `sortie/<version>`, set by Sortie. |

The HTTP client has a 30-second per-request timeout. Context cancellation propagates; a cancelled context aborts the in-flight request.

### Construction-time validation

The constructor runs the `viewer` query to classify the key before the first poll cycle. A valid key returns the acting user on HTTP 200. An invalid, missing, or revoked key fails the `viewer` query, which the adapter routes through the same [error model](#error-model) that classifies every other call, mapping it to `tracker_auth_error` and blocking construction.

### OAuth

OAuth 2.0 is not supported. The orchestrator runs as a single headless principal with no interactive authorization flow and no user-facing callback, which an OAuth token exchange requires and a personal API key does not.

---

## State model

Every Linear workflow state carries a `type` category defined by Linear; see [external references](#external-references) for the full enumeration. States are team-scoped: two teams can each have an "In Progress" state with different UUIDs, and a team can have several states of the same `type` (for example, "In Review" and "QA").

### Name-based mapping

The adapter maps issues by configured state **name**, not by `type`. `domain.Issue.State` is `issue.state.name` with original casing preserved. The `type` category does not drive selection; it serves a startup tripwire that treats three categories, `completed`, `canceled`, and `duplicate`, as terminal. The tripwire emits a WARN when a configured `active_states` entry resolves to one of those three categories, or a `terminal_states` entry resolves to a category outside them.

### Canonical-casing preflight

Linear's `state.name.in` filter is case-sensitive. At construction the adapter fetches the team's states once, matches each configured name case-insensitively, and caches the team's exact casing. Fetch queries send the canonical names. A configured name that no state on the team matches fails construction with `tracker_payload_error` (`state "<name>" not found in team "<key>"`); an unknown team key fails the same way (`unknown team key "<key>"`).

### Default mapping

The adapter's built-in defaults, applied when `active_states` or `terminal_states` is absent or empty:

```yaml
active_states: [Backlog, Todo, In Progress]
terminal_states: [Done, Canceled, Duplicate]
```

`handoff_state` has no default; it stays absent, and dispatch-time handoff is disabled, unless configured.

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
| `BlockersUnresolved` | `issue.inverseRelations.pageInfo.hasNextPage` | `true` when the nested connection was truncated at its first-page cap, meaning `BlockedBy` may be incomplete. |
| `CreatedAt` | `issue.createdAt` | ISO-8601 timestamp string, as-is. |
| `UpdatedAt` | `issue.updatedAt` | ISO-8601 timestamp string, as-is. |

Candidates are sorted client-side by normalized priority ascending, then by creation time ascending. Issues with no priority sort last. The server sort hint is not trusted.

The nested `labels` and `inverseRelations` connections are capped at the first 25 nodes and are not paginated. An issue that exceeds the cap emits a WARN (`nested connection truncated`) and sets `BlockersUnresolved` on the returned issue; the dropped nodes remain observable rather than silent.

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

## Labels

Linear attaches labels by id, not by name, so adding a label by name is a resolve-then-attach sequence. The adapter looks up the name case-insensitively and prefers a label scoped to the configured team over a workspace-scoped label of the same name.

When no label matches, the adapter creates one, always scoped to the configured team. If that create fails with a payload-class error, the adapter re-resolves once on the assumption a concurrent request already created the label, and returns the original create error only if that second resolution also finds nothing. A create refused for the team maps to `tracker_auth_error`.

The label is attached through Linear's append-only field, so the issue's existing labels are never read or replaced. A label failure is not fatal to the run.

Label creation is also gated by a team-level permission setting that some workspaces restrict to team owners; a credential that can otherwise read and write can still be refused there. See [Linear's own documentation](https://linear.app/developers/graphql) for what that setting is currently called and how to change it.

---

## Pagination

Linear uses Relay-style cursor connections. Every connection exposes `pageInfo { hasNextPage endCursor }`. The adapter requests with `after: null`, then `after: endCursor`, until `hasNextPage` is false.

| Property | Value |
|---|---|
| Page size (top-level connections) | 50 |
| Page size (nested `labels`, `inverseRelations`) | 25, not paginated |
| Page cap (top-level connections) | 200 pages; the walk logs a WARN and returns the items accumulated so far rather than continuing past it |
| Cursor | Opaque `endCursor` token, passed back verbatim. Never parsed or constructed. |

When a connection reports `hasNextPage: true` but an empty or absent `endCursor`, the adapter returns `tracker_missing_end_cursor` rather than treating pagination as complete. Silent truncation would be a data-loss bug.

---

## Rate limiting

Linear meters both a request budget and a query-complexity budget, and scales the request budget with the size of the workspace. The current quotas are Linear's to publish, and the adapter reads the remaining allowance from the response headers rather than assuming a figure.

Sortie does not throttle client-side. When the remaining allowance reaches zero the adapter logs a `rate limit exhausted` warning. A throttled response classifies as `tracker_api_error`; the orchestrator does not retry it with backoff, it logs the failure and waits for the next poll interval. Poll cadence is the control: raise `polling.interval_ms` or narrow `query_filter`.

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
| `DefaultActiveStates` | `["Backlog", "Todo", "In Progress"]`, applied when `active_states` is absent; see [default mapping](#default-mapping). |
| `DefaultTerminalStates` | `["Done", "Canceled", "Duplicate"]`, applied when `terminal_states` is absent; see [default mapping](#default-mapping). |
| `BlockerSource` | `candidates` — a candidate fetch already carries every blocker Linear reports; see [blocker extraction](#blocker-extraction). |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages before adapter construction. `ValidateTrackerConfig` runs the Linear-specific offline checks without making network calls: endpoint shape, team-key format, the `SORTIE_LINEAR_API_KEY` hint, a key carrying surrounding whitespace or lacking the `lin_api_` prefix, empty or padded state names, and active-terminal state overlap. A present `endpoint` that does not parse as an absolute http(s) URL with a hostname is reported as `tracker.endpoint.invalid`; an empty value is not, since the adapter substitutes the default host for it. Unlike the sibling forge adapters, there is no plain-`http` warning here, because Linear has no self-hosted deployment mode to make the distinction meaningful. An empty or padded state name is an error here, not a warning as on the sibling forge adapters, because the adapter matches a configured name against the team's workflow states exactly. State collisions involving `handoff_state` or `in_progress_state` are rejected by the generic configuration layer before adapter validation runs, for every `tracker.kind`.

---

## Key differences from the Jira and GitHub adapters

| Aspect | Jira | GitHub | Linear |
|---|---|---|---|
| Protocol | REST, multiple endpoints | REST, multiple endpoints | GraphQL, single POST endpoint |
| Auth header | `Basic base64(email:token)` | `Bearer <token>` | `<api_key>` verbatim, no scheme prefix |
| Error transport | HTTP status codes | HTTP status codes | `errors[]` inside HTTP 200 bodies |
| State model | Workflow states + transition graph | open/closed + labels-as-states | Team-scoped named states + a `type` category |
| Identifier | `PROJ-123` (project key) | `299` (repo-scoped number) | `ENG-123` (team key + number), plus UUID |
| Pagination | `nextPageToken` / offset | `Link` header | Relay cursors (`pageInfo`, `endCursor`) |
| Rate-limit model | Per-tenant points quota | Separate REST and search budgets | Per-workspace request budget plus a query-complexity budget |

See the [Jira adapter reference](/reference/adapter-jira/) and the [GitHub adapter reference](/reference/adapter-github/).

---

## External references

- [Linear GraphQL API](https://linear.app/developers/graphql) - schema, authentication, and the personal API key this adapter uses
- [Pagination](https://linear.app/developers/pagination) - cursor conventions behind the adapter's page walking
- [Filtering](https://linear.app/developers/filtering) - filter syntax valid in `tracker.query_filter`
- [Rate limiting](https://linear.app/developers/rate-limiting) - current request and complexity budgets

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
