---
title: "Jira Adapter"
description: "Jira tracker adapter reference: configuration, authentication, API operations, field mapping, ADF flattening, pagination, rate limits, and error mapping. Covers both Jira Cloud (REST API v3) and Jira Server / Data Center (REST API v2)."
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

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) in its targeted form: the entire value must be a variable reference for expansion to apply.

```yaml
# Jira Cloud
endpoint: https://yourcompany.atlassian.net

# Jira Server or Data Center
endpoint: https://jira.internal.example.com

# Via environment variable
endpoint: $SORTIE_JIRA_ENDPOINT
```

The adapter rejects values that contain `/rest/api/` with a `tracker_payload_error`.

**Construction-time host/version guard:** A `.atlassian.net` endpoint combined with `api_version: "2"` is rejected at startup (`tracker_payload_error`), and [`sortie validate`](#offline-validation) reports the same rejection offline. A non-`.atlassian.net` endpoint combined with `api_version: "3"` emits a warning and proceeds (the combination will produce 404s on a real Server or Data Center instance because v3 does not exist there).

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

When absent or empty, the adapter defaults to `"3"`. Surrounding whitespace is trimmed before the value is read. A value other than `"2"` or `"3"` is rejected at startup, and [`sortie validate`](#offline-validation) reports the same rejection offline.

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

Accepts [`$VAR` indirection](/reference/environment/#var-indirection-in-workflowmd) in its full form: variable references are expanded anywhere in the string.

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

## Offline validation

`sortie validate` runs the Jira-specific checks below without constructing an adapter or making network calls. Each reuses the rule the constructor enforces, so the offline verdict does not drift from the startup verdict.

### Errors

| Check | Condition |
|---|---|
| `tracker.endpoint.missing` | `endpoint` is empty. |
| `tracker.endpoint.api_suffix` | `endpoint` carries a `/rest/api/` path. |
| `tracker.endpoint.invalid` | `endpoint` does not parse as a URL with a scheme and a host. |
| `tracker.api_version.invalid` | `api_version`, after trimming, is neither `"2"` nor `"3"`. |
| `tracker.api_version.cloud_conflict` | `api_version` is `"2"` and `endpoint` is an `.atlassian.net` host, which serves v3 only. |
| `tracker.api_key.jira_format` | `api_key` carries a colon at its first or last character, which can never form a `user:secret` pair. |
| `tracker.api_key.jira_cloud_format` | `api_key` has no colon and `endpoint` is an `.atlassian.net` host, which requires an `email:token` key. |
| `tracker.api_key.jira_v3_format` | `api_key` has no colon, `endpoint` is a classifiable non-Cloud host, and `api_version` resolves to `"3"` - the default when the field is unset. A Server or Data Center personal access token needs either an `email:token` key or `api_version: "2"`. |

The three endpoint checks are evaluated in that order and report the first fault that applies. An invalid `api_version` suppresses the Cloud-conflict check, because the constructor never reaches the host/version guard for a version it rejects. On a Cloud host, `tracker.api_key.jira_cloud_format` reports instead of `tracker.api_key.jira_v3_format`.

An empty `api_key` draws no adapter diagnostic: the generic preflight already reports it as a missing required field.

### Warnings

| Check | Condition |
|---|---|
| `tracker.active_states.empty_element`, `tracker.terminal_states.empty_element` | A state list element is empty or whitespace only. |
| `tracker.active_states.untrimmed_element`, `tracker.terminal_states.untrimmed_element` | A state list element has leading or trailing whitespace. |
| `tracker.states.overlap` | A name appears in both `active_states` and `terminal_states`, compared case-insensitively. |

State collisions involving `handoff_state` or `in_progress_state` are not adapter diagnostics. The generic configuration layer rejects them before adapter validation runs, for every `tracker.kind`. See [startup and configuration errors](/reference/errors/#startup-and-configuration-errors).

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
User-Agent: sortie/<version>
Accept: application/json
Content-Type: application/json
```

`user_agent` is not a Jira adapter config key an operator can set. Sortie sets the tracker role's value to its own version string (`sortie/<version>`), and `jira` fills no SCM or CI role, so a value supplied in a top-level `jira:` block is ignored.

### CAPTCHA lockout

After repeated failed authentication attempts, Jira triggers a CAPTCHA challenge and returns HTTP 401 with the header `X-Seraph-LoginReason: AUTHENTICATION_DENIED`. The adapter detects this header and produces a `tracker_auth_error` with a diagnostic message indicating the CAPTCHA must be resolved via browser login.

---

## API operations

The adapter implements every method of the tracker contract against Jira's search, issue, transition, and comment surfaces, composing JQL for the queries it runs. Which route serves which call, and what JQL each deployment accepts, is Atlassian's to document; see [external references](#external-references). Cloud and Data Center expose that surface differently, and `api_version` selects which of the two the adapter targets. What follows is the behaviour those calls produce.

### Candidate polling

The adapter composes a JQL query from the configured project, the active states, and `query_filter` when set, and asks for the fields it needs rather than the whole issue. Ordering is server-side, so the orchestrator receives candidates in a stable order and does no client-side re-sort.

### Batched state reads

Reconciling many issues at once is batched rather than sequential: IDs are grouped into batches of 40 to keep the request URI inside a safe length, and one query serves each batch. Two consequences are worth knowing. `query_filter` is deliberately not applied to these reads, because reconciliation asks what became of an issue Sortie already claimed, not whether it still matches the filter. And an ID that is not a Jira numeric ID is skipped without an error, so a malformed ID disappears from the result rather than failing the batch.

An issue that has been deleted or moved out of the project is omitted from the result map rather than reported as an error.

### Writes

A transition resolves the available transitions for the issue and then applies the matching one, so a target state the workflow does not offer from the issue's current state fails as a payload error rather than silently doing nothing.

Comment bodies differ by API version: the newer surface takes a structured document, which the adapter builds around the orchestrator's text, while the older one takes the text verbatim. Reading works in the other direction, flattening a structured body back to plain text so a prompt template sees the same shape whichever deployment is behind it.

A comment failure is not fatal to the run. The orchestrator logs a warning and continues, so a token that can read but not comment degrades the run rather than ending it.

Adding a label sends a single `PUT` to the issue resource with an `update.labels` add operation naming the label. The adapter never reads or replaces the issue's existing label list, so no label already on the issue is touched. A label failure is not fatal to the run, the same as a comment failure.

Writes need a token that can update issues, add comments, and label issues; see [authentication](#authentication).

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

Atlassian meters the API per tenant, and the current quotas are Atlassian's to publish; see [external references](#external-references).

What decides how much Sortie spends is the poll interval and the page size: each poll reads one page of candidates, and each candidate that reaches dispatch costs a further read. With the default poll interval and page size, a project with a few hundred open issues stays well inside a normal tenant's budget; a short interval across many projects does not.

Sortie does not throttle client-side. A throttled request fails as `tracker_api_error` and Sortie waits for the next poll. Raise `polling.interval_ms` or narrow `query_filter`.

## Network configuration

| Setting | Value |
|---|---|
| HTTP client timeout | 30 seconds |
| Error body read limit | 512 bytes |
| Transport | `net/http` default transport (`http.DefaultTransport.Clone()`), connection pooling |

Context cancellation propagates through all HTTP calls. When the orchestrator cancels a poll cycle or worker, in-flight Jira requests are aborted.

---

## Metrics

When the HTTP server is [enabled](/reference/workflow-config/), the adapter increments the `sortie_tracker_requests_total` Prometheus counter for each API call.

| Label | Values |
|---|---|
| `operation` | `fetch_candidates`, `fetch_issue`, `fetch_by_states`, `fetch_states_by_ids`, `fetch_states_by_identifiers`, `fetch_comments`, `transition`, `comment`, `add_label` |
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
| `ValidateTrackerConfig` | Offline config diagnostics for `sortie validate`. |
| `DefaultActiveStates` | `["Backlog", "Selected for Development", "In Progress"]`, applied when `active_states` is absent; see [`active_states`](#active_states). |
| `DefaultTerminalStates` | Not declared; an absent `terminal_states` resolves to an empty list. |
| `BlockerSource` | `candidates` — a candidate fetch already carries every blocker Jira reports; see [blocker extraction](#blocker-extraction). |

The orchestrator's preflight validation uses `RequiresProject` and `RequiresAPIKey` to produce specific error messages (`tracker.project is required for tracker kind "jira"`) before attempting adapter construction. `ValidateTrackerConfig` runs the [offline validation](#offline-validation) checks without making network calls.

---

## Jira permissions

The credential needs read access to the configured project for polling, and write access on top of that if the workflow transitions issues, posts comments, or adds labels. Which scope or permission grants each of those differs between Cloud and Data Center, and both are Atlassian's to document; see [external references](#external-references).

A credential that can read but not write does not fail at startup. It fails at the moment of the write: a transition returns `tracker_auth_error`, and so does a comment or a label. A failed comment or label is not fatal to the run, so a read-only credential produces a run that works and stays silent on the issue, which is the shape this misconfiguration usually takes.

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
