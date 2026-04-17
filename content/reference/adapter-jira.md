---
title: "Jira Adapter"
description: "Jira Cloud tracker adapter reference: configuration, auth, API operations, field mapping, JQL generation, pagination, rate limits, and error mapping."
keywords: sortie jira adapter, jira cloud, REST API v3, tracker adapter, JQL, field mapping, normalization, ADF, pagination, error mapping, rate limiting
author: Sortie AI
date: 2026-03-28
weight: 120
url: /reference/adapter-jira/
---
The Jira adapter connects Sortie to **Jira Cloud** via REST API v3. It fetches candidate issues with JQL, normalizes responses to the domain issue model, paginates with cursor-based tokens, flattens Atlassian Document Format (ADF) to plain text, and maps HTTP errors to Sortie's normalized error categories. Registered under kind `"jira"`.

Jira Server and Jira Data Center are not supported. The adapter uses REST API v3 endpoints and cursor-based pagination, both exclusive to Jira Cloud.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [how to connect Sortie to Jira Cloud](/guides/connect-to-jira/) for setup instructions, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Three fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | — | Must be `"jira"`. |
| `endpoint` | string | Yes | — | Jira Cloud base URL (e.g., `https://yourcompany.atlassian.net`). |
| `api_key` | string | Yes | — | Authentication credential in `email:token` format. |
| `project` | string | Yes | — | Jira project key (e.g., `PLATFORM`). |
| `active_states` | list of strings | No | `["Backlog", "Selected for Development", "In Progress"]` | Issue states eligible for dispatch. |
| `terminal_states` | list of strings | No | `[]` | Issue states that trigger workspace cleanup. |
| `query_filter` | string | No | `""` | Raw JQL fragment appended to candidate and state-fetch queries. |
| `handoff_state` | string | No | _(absent)_ | Target state for orchestrator-initiated transitions after a successful run. |
| `in_progress_state` | string | No | _(absent)_ | Target state for dispatch-time transitions at the start of each worker attempt. |

### `endpoint`

The base URL of the Jira Cloud instance, without a trailing slash and without any `/rest/api/...` path. The adapter appends API paths internally.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) via `resolveEnvRef` — the entire value must be a variable reference for expansion to apply.

```yaml
endpoint: $SORTIE_JIRA_ENDPOINT
endpoint: https://yourcompany.atlassian.net
```

The adapter rejects values that contain `/rest/api/` with a `tracker_payload_error`.

### `api_key`

A string in `email:token` format. The adapter splits on the first colon to extract the email and API token, then constructs a Base64-encoded Basic Auth header sent on every request.

Both sides of the colon must be non-empty. A value without a colon or with an empty side produces a `tracker_auth_error` at adapter construction time.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) via `resolveEnv` — variable references are expanded anywhere in the string.

```yaml
api_key: $SORTIE_JIRA_API_KEY
```

Generate a token at [Atlassian account settings → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

### `project`

The Jira project key — the prefix on issue identifiers (e.g., `PROJ` in `PROJ-42`). Used in all JQL queries to scope results to a single project.

Must be non-empty. A missing or empty value produces a `missing_tracker_project` error.

### `active_states`

List of Jira workflow status names that make issues eligible for dispatch. State names are compared case-insensitively against the Jira status. When omitted, defaults to:

```yaml
active_states:
  - Backlog
  - Selected for Development
  - In Progress
```

These defaults match the default Jira Software board. Projects with custom workflows require explicit state names matching the project's workflow scheme.

### `query_filter`

A raw JQL expression appended to the base candidate query inside `AND (...)`. The adapter does not validate or parse the fragment — it passes through to Jira unchanged.

```yaml
query_filter: "labels = 'agent-ready' AND component = 'Backend'"
```

Applies to candidate fetches (`FetchCandidateIssues`) and state-based fetches (`FetchIssuesByStates`). Does **not** apply to ID-based or key-based lookups (`FetchIssueStatesByIDs`, `FetchIssueStatesByIdentifiers`) because those issues already passed filtering at dispatch time.

### `handoff_state`

Target Jira status for orchestrator-initiated transitions after a successful worker run. The adapter fetches available transitions for the issue and matches by target status name (case-insensitive). If no matching transition exists from the issue's current status, the adapter returns a `tracker_payload_error`.

Constraints enforced at startup:

- Must not appear in `active_states` (causes immediate re-dispatch loop).
- Must not appear in `terminal_states` (handoff is not a terminal outcome).

Handoff transitions require write permissions on the API token: `write:jira-work` (classic scopes) or `write:issue:jira` (granular scopes).

See [ADR-0007](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0007-handoff-state-and-tracker-writes.md) for the design rationale behind handoff transitions.

### `in_progress_state`

Target Jira status for dispatch-time transitions. When configured, the worker calls `TransitionIssue` as its first step before workspace preparation. The adapter uses the same transition mechanism as `handoff_state` — it fetches available transitions and matches by target status name (case-insensitive).

Transition failure is non-fatal: the worker logs a warning and continues to workspace preparation.

Constraints enforced at startup:

- Must appear in `active_states` (otherwise reconciliation would cancel the worker after the state change).
- Must not appear in `terminal_states`.
- Must not collide with `handoff_state`.

Requires the same write permissions as `handoff_state`.

---

## Authentication

The adapter uses HTTP Basic Auth. Every request includes an `Authorization` header:

```
Authorization: Basic <base64(email:token)>
```

A `User-Agent` header is set on all requests. The default value is `sortie/dev`; the adapter accepts a `user_agent` key in config to override it.

All requests also set `Accept: application/json` and `Content-Type: application/json`.

### CAPTCHA lockout

After repeated failed authentication attempts, Jira triggers a CAPTCHA challenge and returns HTTP 401 with the header `X-Seraph-LoginReason: AUTHENTICATION_DENIED`. The adapter detects this header and produces a `tracker_auth_error` with a diagnostic message indicating the CAPTCHA must be resolved via browser login.

---

## API operations

The adapter implements all seven methods of the [`TrackerAdapter` interface](/reference/workflow-config/). Each method maps to one or more Jira REST API v3 endpoints.

### `FetchCandidateIssues`

Returns issues in configured active states for the configured project.

**Endpoint:** `GET /rest/api/3/search/jql`

**JQL:**

```
project = "<project>" AND status IN ("<state1>", "<state2>", ...) [AND (<query_filter>)] ORDER BY priority ASC, created ASC
```

**Requested fields:** `summary`, `status`, `priority`, `labels`, `assignee`, `issuetype`, `parent`, `issuelinks`, `created`, `updated`, `description`

**Pagination:** Cursor-based via `nextPageToken`. Page size: 50.

**Comments:** Set to `nil` on returned issues. Callers requiring comments must use `FetchIssueByID` or `FetchIssueComments`.

### `FetchIssueByID`

Returns a single fully-populated issue including comments.

**Endpoint:** `GET /rest/api/3/issue/{issueIdOrKey}` + `GET /rest/api/3/issue/{issueIdOrKey}/comment`

**Requested fields:** Same as candidate search.

The adapter fetches the issue detail first, then fetches all comments via paginated offset-based requests. Both are normalized and merged into the returned domain issue.

Returns `tracker_not_found` when the issue does not exist (HTTP 404).

### `FetchIssuesByStates`

Returns issues in specified states. Used for startup terminal cleanup.

**Endpoint:** `GET /rest/api/3/search/jql`

**JQL:**

```
project = "<project>" AND status IN ("<state1>", ...) [AND (<query_filter>)] ORDER BY created ASC
```

**Pagination:** Cursor-based. Page size: 50.

Returns an empty slice when `states` is empty (short-circuits without API call).

### `FetchIssueStatesByIDs`

Returns the current state for each requested issue ID (Jira internal numeric ID).

**Endpoint:** `GET /rest/api/3/search/jql`

**JQL:**

```
id IN (<id1>, <id2>, ...) ORDER BY key ASC
```

**Requested fields:** `status` only.

**Batching:** IDs are grouped into batches of 40 to keep GET URLs within safe URI length limits. Non-numeric IDs are silently skipped (returns empty for that ID rather than querying the wrong issue).

The `query_filter` is not applied. Issues not found in the tracker are omitted from the result map.

### `FetchIssueStatesByIdentifiers`

Returns the current state for each requested issue identifier (human-readable key like `PROJ-123`).

**Endpoint:** `GET /rest/api/3/search/jql`

**JQL:**

```
key IN ("<key1>", "<key2>", ...) ORDER BY key ASC
```

**Requested fields:** `status` only.

**Batching:** Identifiers are grouped into batches of 40. Issues not found are omitted from the result map. The `query_filter` is not applied.

### `FetchIssueComments`

Returns comments for an issue. Used for continuation runs and the agent workpad pattern.

**Endpoint:** `GET /rest/api/3/issue/{issueIdOrKey}/comment`

**Pagination:** Offset-based (`startAt`, `maxResults`). Page size: 50. Ordered by creation date.

Returns an empty non-nil slice when no comments exist. Returns `tracker_not_found` when the issue does not exist.

### `TransitionIssue`

Moves an issue to a target state by finding and executing a Jira workflow transition.

**Step 1:** `GET /rest/api/3/issue/{issueIdOrKey}/transitions` — fetch available transitions.

**Step 2:** Match a transition whose `to.name` equals the target state (case-insensitive, first match).

**Step 3:** `POST /rest/api/3/issue/{issueIdOrKey}/transitions` — execute the matched transition.

**Request body:**

```json
{"transition": {"id": "<matched_transition_id>"}}
```

Returns `nil` on success (Jira returns 204 No Content). Returns `tracker_payload_error` when no available transition leads to the target state from the issue's current status.

### `CommentIssue`

Posts a plain-text comment on an issue. Used by the orchestrator to record session lifecycle events (dispatch, completion, failure) as visible audit entries.

**Endpoint:** `POST /rest/api/3/issue/{issueIdOrKey}/comment`

**Request body:** Atlassian Document Format (ADF). The adapter splits the plain-text input by newlines and wraps each line in a separate `paragraph` node. Empty lines produce empty paragraphs for visual spacing.

```json
{
  "body": {
    "version": 1,
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "Sortie session started."
          }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "Agent: claude-code"
          }
        ]
      }
    ]
  }
}
```

Returns `nil` on success (Jira returns 201 Created). Error responses are classified by the standard [error mapping](#error-mapping) rules.

The orchestrator builds the comment text; the adapter is responsible only for ADF wrapping and delivery. Comment failures are non-fatal — the orchestrator logs WARN and continues.

Requires write permissions: `write:jira-work` (classic) or `write:issue:jira` (granular) — the same scopes as `TransitionIssue`.

---

## Field mapping

The adapter normalizes Jira API responses to [`domain.Issue`](/reference/workflow-config/) fields. This table shows the exact mapping.

| Domain field | Jira source | Normalization |
|---|---|---|
| `ID` | `id` | String, as-is. Jira's internal numeric ID. |
| `Identifier` | `key` | String, as-is (e.g., `PROJ-123`). |
| `Title` | `fields.summary` | String, as-is. |
| `Description` | `fields.description` | ADF JSON → plain text via [ADF flattening](#adf-flattening). |
| `Priority` | `fields.priority.id` | Parsed as integer. `nil` when absent, empty, or non-numeric. |
| `State` | `fields.status.name` | String with original casing preserved. |
| `BranchName` | _(not available)_ | Empty string. Jira Cloud does not expose branch metadata via REST API v3. |
| `URL` | _(constructed)_ | `{endpoint}/browse/{key}` |
| `Labels` | `fields.labels` | Each label lowercased. Empty non-nil slice when no labels exist. |
| `Assignee` | `fields.assignee.displayName` | Empty string when assignee is absent. |
| `IssueType` | `fields.issuetype.name` | String, as-is (e.g., `Bug`, `Story`, `Task`). |
| `Parent` | `fields.parent` | `{id, key}` → `{ID, Identifier}`. `nil` when absent. |
| `Comments` | `/rest/api/3/issue/{id}/comment` | Fetched via separate endpoint. ADF bodies flattened. `nil` on search results; populated on `FetchIssueByID`. |
| `BlockedBy` | `fields.issuelinks[]` | Filtered for `type.name == "Blocks"` with non-nil `inwardIssue`. See [blocker extraction](#blocker-extraction). |
| `CreatedAt` | `fields.created` | ISO-8601 timestamp string, as-is. |
| `UpdatedAt` | `fields.updated` | ISO-8601 timestamp string, as-is. |

### Comment normalization

Each comment maps to a `domain.Comment`:

| Domain field | Jira source | Normalization |
|---|---|---|
| `ID` | `id` | String, as-is. |
| `Author` | `author.displayName` | Empty string when author is absent. |
| `Body` | `body` | ADF JSON → plain text via [ADF flattening](#adf-flattening). |
| `CreatedAt` | `created` | ISO-8601 timestamp string, as-is. |

---

## ADF flattening

Jira REST API v3 returns `description` and comment `body` fields in Atlassian Document Format (ADF) — a JSON document tree. The adapter recursively walks the tree and extracts all `text` node values. Block-level nodes (`paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `blockquote`, `codeBlock`, `rule`, `table`, `tableRow`, `tableCell`, `tableHeader`, `panel`, `decisionList`, `decisionItem`, `taskList`, `taskItem`, `mediaSingle`, `mediaGroup`) receive a trailing newline. Trailing whitespace is trimmed from the final output.

**Input (ADF):**

```json
{
  "type": "doc",
  "version": 1,
  "content": [
    {
      "type": "paragraph",
      "content": [{"type": "text", "text": "Hello world"}]
    },
    {
      "type": "paragraph",
      "content": [{"type": "text", "text": "Second paragraph"}]
    }
  ]
}
```

**Output (plain text):**

```
Hello world
Second paragraph
```

`nil` or non-object input returns an empty string. Malformed JSON returns an empty string.

---

## Blocker extraction

Blocker relationships are derived from Jira issue links with `type.name == "Blocks"`. The adapter inspects the `inwardIssue` side of each link — this is the issue that blocks the current one.

For each qualifying link, a `BlockerRef` is produced:

| Field | Source |
|---|---|
| `ID` | `inwardIssue.id` |
| `Identifier` | `inwardIssue.key` |
| `State` | `inwardIssue.fields.status.name` (empty when the linked issue's status is not included) |

When the blocker's state is empty, the orchestrator treats it as non-terminal (conservative assumption — the blocker may still be active).

The link type name `"Blocks"` is a constant in the adapter. Jira administrators can rename link types; if your instance uses a different name, the adapter does not detect blockers.

---

## JQL generation

The adapter constructs JQL queries for each operation. String values are sanitized by removing double-quote characters (JQL does not support backslash-escaping inside string literals).

### Candidate query

```
project = "<project>" AND status IN ("<state1>", "<state2>") AND (<query_filter>) ORDER BY priority ASC, created ASC
```

The `AND (<query_filter>)` clause is omitted when `query_filter` is empty.

### State fetch query

```
project = "<project>" AND status IN ("<state1>", ...) AND (<query_filter>) ORDER BY created ASC
```

Used by `FetchIssuesByStates` for startup terminal cleanup.

### Key-based query

```
key IN ("<key1>", "<key2>", ...) ORDER BY key ASC
```

Used by `FetchIssueStatesByIdentifiers`. The `query_filter` is not applied.

### ID-based query

```
id IN (<id1>, <id2>, ...) ORDER BY key ASC
```

Used by `FetchIssueStatesByIDs`. Non-numeric IDs are excluded. Returns an empty string when no valid IDs remain, causing the caller to skip the API call. The `query_filter` is not applied.

---

## Pagination

Two pagination strategies are used, depending on the endpoint.

### Search: cursor-based

The `GET /rest/api/3/search/jql` endpoint uses cursor-based pagination.

| Parameter | Value |
|---|---|
| `maxResults` | `50` (fixed page size) |
| `nextPageToken` | Omitted on first request; set to the value from the previous response on subsequent requests. |

Pagination stops when the response contains no `nextPageToken`. All pages are accumulated into a single result slice before returning.

### Comments: offset-based

The `GET /rest/api/3/issue/{id}/comment` endpoint uses offset-based pagination.

| Parameter | Value |
|---|---|
| `maxResults` | `50` (fixed page size) |
| `startAt` | `0` on first request; incremented by the number of comments received. |
| `orderBy` | `created` |

Pagination stops when `startAt + len(comments) >= total` or the response returns zero comments.

---

## Error mapping

The adapter maps Jira HTTP responses and network conditions to normalized `TrackerError` categories. The orchestrator uses these categories to decide retry, skip, or fail behavior.

| HTTP status | Condition | Error kind | Retryable |
|---|---|---|---|
| 200–299 | Success | _(none)_ | — |
| 400 | Bad request (invalid JQL, malformed parameters) | `tracker_payload_error` | No |
| 401 | Invalid or expired API token | `tracker_auth_error` | No |
| 401 | CAPTCHA challenge (`X-Seraph-LoginReason: AUTHENTICATION_DENIED` header present) | `tracker_auth_error` | No |
| 403 | Insufficient permissions | `tracker_auth_error` | No |
| 404 | Issue or resource not found | `tracker_not_found` | No |
| 429 | Rate limited | `tracker_api_error` | Yes |
| 5xx | Jira server error | `tracker_transport_error` | Yes |
| — | Network unreachable or TCP/DNS timeout | `tracker_transport_error` | Yes |
| 200 | JSON decode failure on success response | `tracker_payload_error` | No |
| Other | Unexpected status code | `tracker_api_error` | Depends |

The `Retry-After` header value from 429 responses is included in the error message for diagnostics. Sortie does not implement client-side rate limiting — it logs the error and waits for the next poll interval.

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

### Error message format

All errors are wrapped in `TrackerError` with the format:

```
tracker: <kind>: <method> <path>: <detail>
```

Example:

```
tracker: tracker_auth_error: GET /rest/api/3/search/jql: 401 (CAPTCHA challenge triggered — log in via browser to resolve)
```

Non-200 response bodies are read up to 512 bytes for diagnostic detail.

---

## Rate limits

Jira Cloud enforces three independent rate limiting systems.

| System | Scope | Limits |
|---|---|---|
| Points-based quota | Per hour, per tenant | 65,000 points/hour. GET operations cost 1–2 points. Resets at the top of each UTC hour. |
| Burst rate limits | Per second, per endpoint | `GET /rest/api/3/search/jql`: 100 req/s. `GET /rest/api/3/issue/{id}`: 150 req/s. |
| Per-issue write limits | Per issue | 20 writes/2s, 100 writes/30s. Relevant only for `TransitionIssue`. |

All rate limit violations return HTTP 429 with a `Retry-After` header (seconds). The adapter maps 429 to `tracker_api_error`.

With the default poll interval of 30 seconds and page size of 50, a project with fewer than 500 active issues generates 10–20 API calls per poll cycle — well within rate limits. Increase `polling.interval_ms` or narrow `query_filter` if you encounter rate limiting.

---

## Network configuration

| Setting | Value |
|---|---|
| HTTP client timeout | 30 seconds |
| Error body read limit | 512 bytes |
| Transport | `net/http` default (HTTP/1.1, connection pooling) |

Context cancellation propagates through all HTTP calls. When the orchestrator cancels a poll cycle or worker, in-flight Jira requests are aborted.

---

## Metrics

When the HTTP server is [enabled](/reference/workflow-config/), the adapter increments the `sortie_tracker_requests_total` Prometheus counter for each API call.

| Label | Values |
|---|---|
| `operation` | `fetch_candidates`, `fetch_issue`, `fetch_by_states`, `fetch_states_by_ids`, `fetch_states_by_identifiers`, `fetch_comments`, `transition`, `comment` |
| `result` | `success`, `error` |

When the HTTP server is disabled, metrics calls are no-ops. See [Prometheus metrics reference](/reference/prometheus-metrics/) for query examples.

---

## Concurrency safety

The adapter is safe for concurrent use. The orchestrator's poll loop and reconciliation goroutine may call adapter methods simultaneously. The underlying `net/http.Client` handles connection pooling and concurrent requests.

No adapter-level locking is required — each method operates on immutable configuration and produces independent HTTP requests.

---

## Adapter registration

The adapter registers itself under kind `"jira"` via an `init` function in `internal/tracker/jira`. Registration metadata declares:

| Property | Value |
|---|---|
| `RequiresProject` | `true` |
| `RequiresAPIKey` | `true` |

The orchestrator's preflight validation uses these declarations to produce specific error messages (`tracker.project is required for tracker kind "jira"`) before attempting adapter construction.

---

## Jira permissions

### Read-only operations

All fetch operations require read access to the Jira project:

- **Classic scopes:** `read:jira-work`
- **Granular scopes:** `read:issue:jira`, `read:issue.property:jira`

### Write operations

`TransitionIssue` (used by `handoff_state` and `in_progress_state`) and `CommentIssue` (used by `tracker.comments.*`) require write access:

- **Classic scopes:** `write:jira-work`
- **Granular scopes:** `write:issue:jira`

If the API token lacks write permissions, transitions fail with `tracker_auth_error` (HTTP 403) and comments fail with `tracker_auth_error`. The orchestrator treats both as non-fatal.

---

## Related pages

- [How to connect Sortie to Jira Cloud](/guides/connect-to-jira/) — setup instructions with authentication, state mapping, and troubleshooting
- [WORKFLOW.md configuration reference](/reference/workflow-config/) — full schema for the `tracker` section and all other configuration
- [Error reference](/reference/errors/#tracker-errors) — all tracker error kinds with retry behavior and operator actions
- [Environment variables reference](/reference/environment/) — `$VAR` expansion modes and agent passthrough variables
- [Prometheus metrics reference](/reference/prometheus-metrics/) — `sortie_tracker_requests_total` and related counters
- [How to write a prompt template](/guides/write-prompt-template/) — using `.issue` fields (populated by this adapter) in templates
- [Agent extensions reference](/reference/agent-extensions/) — `tracker_api` tool that agents use to call back into the tracker
- [How to use the file adapter for local testing](/guides/use-file-adapter-for-testing/) — test prompts and hooks without Jira API credentials
- [State machine reference](/reference/state-machine/) — orchestration states, candidate eligibility, and how tracker state drives dispatch
- [Dashboard reference](/reference/dashboard/) — live monitoring of issues fetched by this adapter
