---
title: "Jira Adapter"
description: "Jira tracker adapter reference: configuration, authentication, API operations, field mapping, ADF flattening, pagination, rate limits, and error mapping. Covers both Jira Cloud (REST API v3) and Jira Server / Data Center (REST API v2)."
keywords: sortie jira adapter, jira cloud, jira server, jira data center, REST API v2, REST API v3, tracker adapter, JQL, field mapping, normalization, ADF, wiki markup, pagination, error mapping, rate limiting, PAT, bearer auth
author: Sortie AI
date: 2026-03-28
weight: 120
url: /reference/adapter-jira/
---
The Jira adapter connects Sortie to Jira via the REST API. It supports two deployment modes, selected by the optional `tracker.api_version` field:

- **Cloud (default):** REST API v3, cursor-based search pagination, ADF body flattening, Basic auth with `email:token`.
- **Server / Data Center:** REST API v2, offset-based search pagination, raw wiki-markup bodies, Basic auth (`user:password`) or Bearer auth (Personal Access Token).

The adapter is registered under kind `"jira"`. Both modes implement the same `TrackerAdapter` interface and normalize responses to the same domain types.

See also: [WORKFLOW.md configuration](/reference/workflow-config/) for the full tracker schema, [how to connect Sortie to Jira Cloud](/guides/connect-to-jira/) for setup instructions, [error reference](/reference/errors/) for all tracker error kinds, [environment variables](/reference/environment/) for `$VAR` expansion behavior.

---

## Configuration

The adapter reads its configuration from the `tracker` section of the [WORKFLOW.md front matter](/reference/workflow-config/). Three fields are required; the rest have defaults.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string | Yes | - | Must be `"jira"`. |
| `endpoint` | string | Yes | - | Jira base URL (e.g., `https://yourcompany.atlassian.net` or `https://jira.internal.example.com`). |
| `api_key` | string | Yes | - | Authentication credential. See [authentication](#authentication) for format by mode. |
| `project` | string | Yes | - | Jira project key (e.g., `PLATFORM`). |
| `api_version` | string | No | `"3"` | REST API version. `"3"` for Jira Cloud; `"2"` for Jira Server / Data Center. Quote the value: `api_version: "2"`. |
| `active_states` | list of strings | No | `["Backlog", "Selected for Development", "In Progress"]` | Issue states eligible for dispatch. |
| `terminal_states` | list of strings | No | `[]` | Issue states that trigger workspace cleanup. |
| `query_filter` | string | No | `""` | Raw JQL fragment appended to candidate and state-fetch queries. |
| `handoff_state` | string | No | _(absent)_ | Target state for orchestrator-initiated transitions after a successful run. Must appear in neither `active_states` nor `terminal_states`. |
| `in_progress_state` | string | No | _(absent)_ | Target state for dispatch-time transitions at the start of each worker attempt. |

### `endpoint`

The base URL of the Jira instance, without a trailing slash and without any `/rest/api/...` path. The adapter appends API paths internally.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) via `resolveEnvRef` - the entire value must be a variable reference for expansion to apply.

```yaml
# Jira Cloud
endpoint: https://yourcompany.atlassian.net

# Jira Server or Data Center
endpoint: https://jira.internal.example.com

# Via environment variable
endpoint: $SORTIE_JIRA_ENDPOINT
```

The adapter rejects values that contain `/rest/api/` with a `tracker_payload_error`.

**Construction-time host/version guard:** A `.atlassian.net` endpoint combined with `api_version: "2"` is rejected at startup (`tracker_payload_error`). A non-`.atlassian.net` endpoint combined with `api_version: "3"` emits a warning and proceeds (the combination will produce 404s on a real Server or Data Center instance because v3 does not exist there).

### `api_version`

Selects the Jira REST API version and, by extension, the deployment target:

| Value | Deployment | Base path | Search pagination | Body format | Auth |
|---|---|---|---|---|---|
| `"3"` (default) | Jira Cloud | `/rest/api/3` | Cursor (`nextPageToken`) | ADF flattened to text | Basic `email:token` |
| `"2"` | Jira Server / Data Center | `/rest/api/2` | Offset (`startAt`/`total`) | Raw string (wiki markup) | Basic `user:password` or Bearer PAT |

The value MUST be quoted in YAML to avoid a non-fatal validation advisory:

```yaml
tracker:
  api_version: "2"   # correct
  # api_version: 2   # draws a type_mismatch advisory from sortie validate
```

When absent or empty, the adapter defaults to `"3"`. A value other than `"2"` or `"3"` is rejected at startup.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd).

### `api_key`

Authentication credential. The format depends on the API version.

**Cloud (v3):** `email:token` format. The adapter splits on the first colon to extract the email and API token, then constructs a Base64-encoded Basic Auth header. Both sides of the colon must be non-empty; a missing colon or an empty side produces a `tracker_auth_error` at construction time.

Generate a token at [Atlassian account settings: Security: API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).

```yaml
api_key: you@company.com:your-api-token-here
api_key: $SORTIE_JIRA_API_KEY
```

**Server / Data Center (v2):** Two forms are accepted, selected by the presence of a colon:

- `user:password` (contains a colon): Basic auth. The adapter splits on the first colon. Both sides must be non-empty.
- A colon-free token string: Bearer auth (Personal Access Token). The adapter sends `Authorization: Bearer <token>`.

```yaml
# Basic auth (user:password)
api_key: jira-service-user:s3cr3t

# Bearer auth (PAT - no colon in the token)
api_key: $SORTIE_JIRA_PAT
```

Generate a PAT in your Jira instance under your user profile: Profile menu > Personal Access Tokens.

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) via `resolveEnv` - variable references are expanded anywhere in the string.

### `project`

The Jira project key - the prefix on issue identifiers (e.g., `PROJ` in `PROJ-42`). Used in all JQL queries to scope results to a single project.

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

A raw JQL expression appended to the base candidate query inside `AND (...)`. The adapter does not validate or parse the fragment - it passes through to Jira unchanged.

```yaml
query_filter: "labels = 'agent-ready' AND component = 'Backend'"
```

Applies to candidate fetches (`FetchCandidateIssues`) and state-based fetches (`FetchIssuesByStates`). Does **not** apply to ID-based or key-based lookups (`FetchIssueStatesByIDs`, `FetchIssueStatesByIdentifiers`) because those issues already passed filtering at dispatch time.

### `handoff_state`

Target Jira status for orchestrator-initiated transitions after a successful worker run. The adapter fetches available transitions for the issue and matches by target status name (case-insensitive). If no matching transition exists from the issue's current status, the adapter returns a `tracker_payload_error`.

Constraints enforced at startup:

- Must not appear in `active_states` (causes immediate re-dispatch loop).
- Must not appear in `terminal_states` (handoff is not a terminal outcome).

Handoff transitions require write permissions on the credential.

### `in_progress_state`

Target Jira status for dispatch-time transitions. When configured, the worker calls `TransitionIssue` as its first step before workspace preparation. The adapter uses the same transition mechanism as `handoff_state` - it fetches available transitions and matches by target status name (case-insensitive).

Transition failure is non-fatal: the worker logs a warning and continues to workspace preparation.

Constraints enforced at startup:

- Must appear in `active_states` (otherwise reconciliation would cancel the worker after the state change).
- Must not appear in `terminal_states`.
- Must not collide with `handoff_state`.

Requires the same write permissions as `handoff_state`.

---

## Authentication

The adapter selects an authentication mode from the `(api_version, api_key)` combination at construction time.

### Cloud (v3): Basic auth

Every request includes an `Authorization` header:

```
Authorization: Basic <base64(email:token)>
```

A value without a colon, or with an empty side, is rejected at construction time with `tracker_auth_error`.

### Server / Data Center (v2): Basic or Bearer

The adapter inspects the `api_key` value:

| `api_key` form | Auth header produced |
|---|---|
| Contains a colon (`user:password`) | `Authorization: Basic <base64(user:password)>` |
| No colon (colon-free PAT string) | `Authorization: Bearer <token>` |

A colon with an empty user (`":password"`) or empty secret (`"user:"`) is rejected at construction time with `tracker_auth_error`.

### Common headers

All requests set:

```
User-Agent: sortie/dev
Accept: application/json
Content-Type: application/json
```

The `user_agent` config key overrides the default `User-Agent` value.

### CAPTCHA lockout

After repeated failed authentication attempts, Jira triggers a CAPTCHA challenge and returns HTTP 401 with the header `X-Seraph-LoginReason: AUTHENTICATION_DENIED`. The adapter detects this header and produces a `tracker_auth_error` with a diagnostic message indicating the CAPTCHA must be resolved via browser login.

---

## API operations

The adapter implements all seven methods of the [`TrackerAdapter` interface](/reference/workflow-config/). Each method maps to one or more Jira REST API endpoints. The base path is `/rest/api/3` (Cloud) or `/rest/api/2` (Server / Data Center).

### `FetchCandidateIssues`

Returns issues in configured active states for the configured project.

**Endpoint:**
- v3: `GET /rest/api/3/search/jql`
- v2: `GET /rest/api/2/search`

**JQL:**

```
project = "<project>" AND status IN ("<state1>", "<state2>", ...) [AND (<query_filter>)] ORDER BY priority ASC, created ASC
```

**Requested fields:** `summary`, `status`, `priority`, `labels`, `assignee`, `issuetype`, `parent`, `issuelinks`, `created`, `updated`, `description`

**Pagination:** Cursor-based (v3) or offset-based (v2). Page size: 50. See [pagination](#pagination).

**Comments:** Set to `nil` on returned issues. Callers requiring comments must use `FetchIssueByID` or `FetchIssueComments`.

### `FetchIssueByID`

Returns a single fully-populated issue including comments.

**Endpoint:**
- v3: `GET /rest/api/3/issue/{issueIdOrKey}` + `GET /rest/api/3/issue/{issueIdOrKey}/comment`
- v2: `GET /rest/api/2/issue/{issueIdOrKey}` + `GET /rest/api/2/issue/{issueIdOrKey}/comment`

**Requested fields:** Same as candidate search.

The adapter fetches the issue detail first, then fetches all comments via paginated offset-based requests. Both are normalized and merged into the returned domain issue.

Returns `tracker_not_found` when the issue does not exist (HTTP 404).

### `FetchIssuesByStates`

Returns issues in specified states. Used for startup terminal cleanup.

**Endpoint:**
- v3: `GET /rest/api/3/search/jql`
- v2: `GET /rest/api/2/search`

**JQL:**

```
project = "<project>" AND status IN ("<state1>", ...) [AND (<query_filter>)] ORDER BY created ASC
```

**Pagination:** Cursor-based (v3) or offset-based (v2). Page size: 50.

Returns an empty slice when `states` is empty (short-circuits without API call).

### `FetchIssueStatesByIDs`

Returns the current state for each requested issue ID (Jira internal numeric ID).

**Endpoint:**
- v3: `GET /rest/api/3/search/jql`
- v2: `GET /rest/api/2/search`

**JQL:**

```
id IN (<id1>, <id2>, ...) ORDER BY key ASC
```

**Requested fields:** `status` only.

**Batching:** IDs are grouped into batches of 40 to keep GET URLs within safe URI length limits. Non-numeric IDs are silently skipped.

The `query_filter` is not applied. Issues not found in the tracker are omitted from the result map.

### `FetchIssueStatesByIdentifiers`

Returns the current state for each requested issue identifier (human-readable key like `PROJ-123`).

**Endpoint:**
- v3: `GET /rest/api/3/search/jql`
- v2: `GET /rest/api/2/search`

**JQL:**

```
key IN ("<key1>", "<key2>", ...) ORDER BY key ASC
```

**Requested fields:** `status` only.

**Batching:** Identifiers are grouped into batches of 40. Issues not found are omitted from the result map. The `query_filter` is not applied.

### `FetchIssueComments`

Returns comments for an issue. Used for continuation runs and the agent workpad pattern.

**Endpoint:**
- v3: `GET /rest/api/3/issue/{issueIdOrKey}/comment`
- v2: `GET /rest/api/2/issue/{issueIdOrKey}/comment`

**Pagination:** Offset-based (`startAt`, `maxResults`) for both versions. Page size: 50. Ordered by creation date.

Returns an empty non-nil slice when no comments exist. Returns `tracker_not_found` when the issue does not exist.

### `TransitionIssue`

Moves an issue to a target state by finding and executing a Jira workflow transition.

**Step 1:** Fetch available transitions.
- v3: `GET /rest/api/3/issue/{issueIdOrKey}/transitions`
- v2: `GET /rest/api/2/issue/{issueIdOrKey}/transitions`

**Step 2:** Match a transition whose `to.name` equals the target state (case-insensitive, first match).

**Step 3:** Execute the matched transition.
- v3: `POST /rest/api/3/issue/{issueIdOrKey}/transitions`
- v2: `POST /rest/api/2/issue/{issueIdOrKey}/transitions`

**Request body:**

```json
{"transition": {"id": "<matched_transition_id>"}}
```

Returns `nil` on success. Returns `tracker_payload_error` when no available transition leads to the target state from the issue's current status.

### `CommentIssue`

Posts a comment on an issue. Used by the orchestrator to record session lifecycle events as visible audit entries.

**Endpoint:**
- v3: `POST /rest/api/3/issue/{issueIdOrKey}/comment`
- v2: `POST /rest/api/2/issue/{issueIdOrKey}/comment`

**Request body (v3):** Atlassian Document Format (ADF). The adapter splits the plain-text input by newlines and wraps each line in a separate `paragraph` node.

```json
{
  "body": {
    "version": 1,
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [{"type": "text", "text": "Sortie session started."}]
      }
    ]
  }
}
```

**Request body (v2):** A raw string body. The orchestrator-supplied text is sent verbatim.

```json
{"body": "Sortie session started."}
```

Returns `nil` on success (HTTP 201 Created). Error responses are classified by the standard [error mapping](#error-mapping) rules.

Comment failures are non-fatal - the orchestrator logs WARN and continues.

Requires write permissions: `write:jira-work` (classic) or `write:issue:jira` (granular) on Cloud; project-level write access on Server / Data Center.

---

## Field mapping

The adapter normalizes Jira API responses to [`domain.Issue`](/reference/workflow-config/) fields. This table shows the exact mapping.

| Domain field | Jira source | Normalization |
|---|---|---|
| `ID` | `id` | String, as-is. Jira's internal numeric ID. |
| `Identifier` | `key` | String, as-is (e.g., `PROJ-123`). |
| `Title` | `fields.summary` | String, as-is. |
| `Description` | `fields.description` | v3: ADF JSON flattened to text. v2: raw string in wiki markup, preserved verbatim. |
| `Priority` | `fields.priority.id` | Parsed as integer. `nil` when absent, empty, or non-numeric. |
| `State` | `fields.status.name` | String with original casing preserved. |
| `BranchName` | _(not available)_ | Empty string. Not exposed via the REST API. |
| `URL` | _(constructed)_ | `{endpoint}/browse/{key}` |
| `Labels` | `fields.labels` | Each label lowercased. Empty non-nil slice when no labels exist. |
| `Assignee` | `fields.assignee.displayName` | Empty string when assignee is absent. |
| `IssueType` | `fields.issuetype.name` | String, as-is (e.g., `Bug`, `Story`, `Task`). |
| `Parent` | `fields.parent` | `{id, key}` -> `{ID, Identifier}`. `nil` when absent. |
| `Comments` | Separate comment endpoint | v3: ADF bodies flattened to text. v2: raw wiki-markup bodies preserved verbatim. `nil` on search results; populated on `FetchIssueByID`. |
| `BlockedBy` | `fields.issuelinks[]` | Filtered for `type.name == "Blocks"` with non-nil `inwardIssue`. See [blocker extraction](#blocker-extraction). |
| `CreatedAt` | `fields.created` | ISO-8601 timestamp string, as-is. |
| `UpdatedAt` | `fields.updated` | ISO-8601 timestamp string, as-is. |

### Comment normalization

Each comment maps to a `domain.Comment`:

| Domain field | Jira source | Normalization |
|---|---|---|
| `ID` | `id` | String, as-is. |
| `Author` | `author.displayName` | Empty string when author is absent. |
| `Body` | `body` | v3: ADF JSON flattened to text. v2: raw string in wiki markup, preserved verbatim. |
| `CreatedAt` | `created` | ISO-8601 timestamp string, as-is. |

### v2 wiki-markup bodies

When `api_version: "2"`, `Description` and comment `Body` fields carry Jira wiki markup exactly as Jira returns it. The adapter reads these as raw JSON strings; it does not strip, translate, or flatten markup tokens. As a result, prompt templates and dispatched agents receive wiki markup (for example `h2. Heading`, `*bold text*`, `{code:java}...{code}`) rather than clean prose. This is expected behavior for v2 deployments. The adapter does not request `expand=renderedBody` and does not parse rendered HTML.

---

## ADF flattening

Applies to v3 only. Jira REST API v3 returns `description` and comment `body` fields in Atlassian Document Format (ADF) - a JSON document tree. The adapter recursively walks the tree and extracts all `text` node values. Block-level nodes (`paragraph`, `heading`, `bulletList`, `orderedList`, `listItem`, `blockquote`, `codeBlock`, `rule`, `table`, `tableRow`, `tableCell`, `tableHeader`, `panel`, `decisionList`, `decisionItem`, `taskList`, `taskItem`, `mediaSingle`, `mediaGroup`) receive a trailing newline. Trailing whitespace is trimmed from the final output.

**Input (ADF, v3):**

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

**Output (text):**

```
Hello world
Second paragraph
```

`nil` or non-object input returns an empty string. Malformed JSON returns an empty string.

When `api_version: "2"`, ADF flattening does not run. The raw string body is decoded directly from the JSON string field and used as-is.

---

## Blocker extraction

Blocker relationships are derived from Jira issue links with `type.name == "Blocks"`. The adapter inspects the `inwardIssue` side of each link - this is the issue that blocks the current one.

For each qualifying link, a `BlockerRef` is produced:

| Field | Source |
|---|---|
| `ID` | `inwardIssue.id` |
| `Identifier` | `inwardIssue.key` |
| `State` | `inwardIssue.fields.status.name` (empty when the linked issue's status is not included) |

When the blocker's state is empty, the orchestrator treats it as non-terminal (conservative assumption - the blocker may still be active).

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

Two pagination strategies are used, depending on the API version and endpoint.

### v3 search: cursor-based

The `GET /rest/api/3/search/jql` endpoint uses cursor-based pagination.

| Parameter | Value |
|---|---|
| `maxResults` | `50` (fixed page size) |
| `nextPageToken` | Omitted on first request; set to the value from the previous response on subsequent requests. |

Pagination stops when the response contains no `nextPageToken`. All pages are accumulated into a single result slice before returning.

### v2 search: offset-based

The `GET /rest/api/2/search` endpoint uses offset-based pagination.

| Parameter | Value |
|---|---|
| `maxResults` | `50` (fixed page size) |
| `startAt` | `0` on first request; incremented by the number of issues received per page. |

Pagination stops when `startAt + len(issues) >= total` or the response returns zero issues.

### Comments: offset-based (both versions)

The comment endpoint uses offset-based pagination for both v3 and v2.

| Parameter | Value |
|---|---|
| `maxResults` | `50` (fixed page size) |
| `startAt` | `0` on first request; incremented by the number of comments received. |
| `orderBy` | `created` |

Pagination stops when `startAt + len(comments) >= total` or the response returns zero comments.

---

## Error mapping

The adapter maps Jira HTTP responses and network conditions to normalized `TrackerError` categories. The orchestrator uses these categories to decide retry, skip, or fail behavior. The mapping applies to both v3 and v2.

| HTTP status | Condition | Error kind | Retryable |
|---|---|---|---|
| 200-299 | Success | _(none)_ | - |
| 400 | Bad request (invalid JQL, malformed parameters) | `tracker_payload_error` | No |
| 401 | Invalid or expired credential | `tracker_auth_error` | No |
| 401 | CAPTCHA challenge (`X-Seraph-LoginReason: AUTHENTICATION_DENIED` header present) | `tracker_auth_error` | No |
| 403 | Insufficient permissions | `tracker_auth_error` | No |
| 404 | Issue or resource not found | `tracker_not_found` | No |
| 429 | Rate limited | `tracker_api_error` | Yes |
| 5xx | Jira server error | `tracker_transport_error` | Yes |
| - | Network unreachable or TCP/DNS timeout | `tracker_transport_error` | Yes |
| - | TLS handshake failure (e.g., untrusted certificate) | `tracker_transport_error` | Yes |
| 200 | JSON decode failure on success response | `tracker_payload_error` | No |
| Other | Unexpected status code | `tracker_api_error` | Depends |

The `Retry-After` header value from 429 responses is included in the error message for diagnostics. Sortie does not implement client-side rate limiting - it logs the error and waits for the next poll interval.

For the full error taxonomy and operator guidance, see the [error reference](/reference/errors/#tracker-errors).

### Error message format

All errors are wrapped in `TrackerError` with the format:

```
tracker: <kind>: <method> <path>: <detail>
```

Example:

```
tracker: tracker_auth_error: GET /rest/api/2/search: 401
```

Non-200 response bodies are read up to 512 bytes for diagnostic detail.

### TLS trust for Server / Data Center

Self-hosted Jira instances frequently use an internal CA or a self-signed certificate. A TLS handshake failure surfaces as `tracker_transport_error`. The adapter uses the system trust store; install your internal CA certificate at the OS level to resolve this. Sortie does not provide a TLS-skip option.

---

## Rate limits

Rate limiting behavior differs by deployment:

**Jira Cloud** enforces three independent rate limiting systems:

| System | Scope | Limits |
|---|---|---|
| Points-based quota | Per hour, per tenant | 65,000 points/hour. GET operations cost 1-2 points. Resets at the top of each UTC hour. |
| Burst rate limits | Per second, per endpoint | `GET /rest/api/3/search/jql`: 100 req/s. `GET /rest/api/3/issue/{id}`: 150 req/s. |
| Per-issue write limits | Per issue | 20 writes/2s, 100 writes/30s. Relevant only for `TransitionIssue`. |

**Jira Server / Data Center:** Rate limiting policies vary by instance configuration. The 429 error mapping applies regardless.

All rate limit violations return HTTP 429 with a `Retry-After` header (seconds). The adapter maps 429 to `tracker_api_error`.

With the default poll interval of 30 seconds and page size of 50, a project with fewer than 500 active issues generates 10-20 API calls per poll cycle - well within Cloud rate limits. Increase `polling.interval_ms` or narrow `query_filter` if you encounter rate limiting.

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

No adapter-level locking is required - each method operates on immutable configuration and produces independent HTTP requests.

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

All fetch operations require read access to the Jira project.

**Cloud (v3):**
- Classic scopes: `read:jira-work`
- Granular scopes: `read:issue:jira`, `read:issue.property:jira`

**Server / Data Center (v2):** The authenticated user (Basic) or the PAT owner (Bearer) must have Browse Projects permission on the project.

### Write operations

`TransitionIssue` (used by `handoff_state` and `in_progress_state`) and `CommentIssue` (used by `tracker.comments.*`) require write access.

**Cloud (v3):**
- Classic scopes: `write:jira-work`
- Granular scopes: `write:issue:jira`

**Server / Data Center (v2):** The authenticated user or PAT owner must have the relevant project-level permissions (Work on Issues for transitions, Add Comments for comments).

If the credential lacks write permissions, transitions fail with `tracker_auth_error` (HTTP 403) and comments fail with `tracker_auth_error`. The orchestrator treats both as non-fatal.

---

## Example configuration

### Jira Cloud (v3, default)

```yaml
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PLATFORM
  active_states:
    - To Do
    - In Progress
  terminal_states:
    - Done
```

`endpoint` points to `https://yourcompany.atlassian.net`; `api_key` is `you@company.com:your-api-token`.

### Jira Server or Data Center (v2, Bearer/PAT)

```yaml
tracker:
  kind: jira
  endpoint: https://jira.internal.example.com
  api_key: $SORTIE_JIRA_PAT
  api_version: "2"
  project: PLATFORM
  active_states:
    - To Do
    - In Progress
  terminal_states:
    - Done
```

`api_key` is a colon-free Personal Access Token; the adapter sends `Authorization: Bearer <token>`.

### Jira Server or Data Center (v2, Basic auth)

```yaml
tracker:
  kind: jira
  endpoint: https://jira.internal.example.com
  api_key: $SORTIE_JIRA_CREDENTIALS
  api_version: "2"
  project: PLATFORM
```

`api_key` is `username:password`; the adapter sends `Authorization: Basic <base64(username:password)>`.

---

## External references

- [Jira Cloud REST API v3 introduction](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) - base URL, authentication, and global request conventions
- [Jira Server REST API v2 reference](https://developer.atlassian.com/server/jira/platform/rest/v10000/) - Server / Data Center API surface
- [Issue search and JQL endpoint (v3)](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) - the search API used for Cloud deployments
- [Jira personal access tokens (Server / DC)](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html) - generate and manage PATs
- [Atlassian API tokens (Cloud)](https://id.atlassian.com/manage-profile/security/api-tokens) - generate the token used in `email:token` format
- [JQL field reference](https://support.atlassian.com/jira-software-cloud/docs/jql-fields/) - fields and operators valid in `tracker.query_filter`
- [Jira OAuth 2.0 scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/) - classic and granular scope definitions referenced above

---

## Related pages

- [How to connect Sortie to Jira](/guides/connect-to-jira/) - setup instructions with authentication, state mapping, and troubleshooting
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - full schema for the `tracker` section and all other configuration
- [Error reference](/reference/errors/#tracker-errors) - all tracker error kinds with retry behavior and operator actions
- [Environment variables reference](/reference/environment/) - `$VAR` expansion modes and agent passthrough variables
- [Prometheus metrics reference](/reference/prometheus-metrics/) - `sortie_tracker_requests_total` and related counters
- [How to write a prompt template](/guides/write-prompt-template/) - using `.issue` fields (populated by this adapter) in templates
- [Agent extensions reference](/reference/agent-extensions/) - `tracker_api` tool that agents use to call back into the tracker
- [How to use the file adapter for local testing](/guides/use-file-adapter-for-testing/) - test prompts and hooks without Jira API credentials
- [State machine reference](/reference/state-machine/) - orchestration states, candidate eligibility, and how tracker state drives dispatch
- [Dashboard reference](/reference/dashboard/) - live monitoring of issues fetched by this adapter
