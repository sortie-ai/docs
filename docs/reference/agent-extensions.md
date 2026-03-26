---
title: "Agent Extensions | Sortie"
description: "Reference for tools available to agents during Sortie sessions. Covers the tracker_api tool: operations, input schema, response format, and error handling."
keywords: sortie agent tools, tracker_api, agent extensions, tool calling, issue tracker, agent capabilities
author: Sortie AI
---

# Agent extensions reference

During a Sortie session, the agent runs inside a workspace with access to the codebase and the rendered prompt. Sortie also registers **tools** — structured interfaces that define how agents can query and modify issue tracker data without needing direct API credentials. Sortie scopes all tool operations to the project set in [`tracker.project`](workflow-config.md).

!!! info
    Currently, tools are **prompt-advertised**: Sortie appends tool documentation (name, description, input schema, and response format) to the agent's prompt on the first turn. The agent sees the tool contract but cannot invoke it interactively within the session — there is no execution channel (MCP server, HTTP callback, or file-based IPC) wired yet. The tool infrastructure (interface, registry, implementation) is fully built and tested; the missing piece is the runtime bridge between agent and orchestrator. This is coming soon. Once the execution channel is connected, the agent can call tools by name and receive structured responses in turn.

---

## `tracker_api`

The built-in tool defining read and write access to the configured issue tracker (Jira, GitHub Issues, file-based). The agent does not need its own API key — Sortie uses the tracker credentials from [WORKFLOW.md](workflow-config.md). All operations are scoped to the configured `tracker.project`; the agent cannot access issues in other projects.

The sections below document the full contract: input schema, operations, response envelope, and error kinds. This is the interface the agent sees advertised in its prompt and the contract that interactive execution will honor once an execution channel is connected.

### Input schema

The tool accepts a JSON object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `operation` | string | Always | One of: `fetch_issue`, `fetch_comments`, `search_issues`, `transition_issue` |
| `issue_id` | string | `fetch_issue`, `fetch_comments`, `transition_issue` | The tracker-internal issue ID |
| `target_state` | string | `transition_issue` | The target state name (e.g., `"In Review"`) |

No additional fields are accepted. Unknown fields produce an `invalid_input` error.

---

### Operations

#### `fetch_issue`

Retrieve a single issue by its tracker-internal ID. Returns the full issue record.

**Request:**

```json
{"operation": "fetch_issue", "issue_id": "abc123"}
```

**Response data:**

```json
{
  "id": "abc123",
  "identifier": "PROJ-42",
  "title": "Add retry logic to webhook handler",
  "description": "The webhook handler currently fails silently...",
  "state": "In Progress",
  "priority": 2,
  "labels": ["backend", "reliability"],
  "assignee": "alice",
  "issue_type": "Bug",
  "url": "https://mytracker.example.com/browse/PROJ-42",
  "branch_name": "PROJ-42-retry-logic",
  "parent": {"id": "parent-1", "identifier": "PROJ-40"},
  "comments": [
    {"id": "c1", "author": "bob", "body": "Confirmed in prod.", "created_at": "2026-03-25T10:00:00Z"}
  ],
  "blocked_by": [],
  "created_at": "2026-03-20T09:00:00Z",
  "updated_at": "2026-03-25T14:30:00Z"
}
```

Fields that have no value in the tracker return `null` (for `priority`, `parent`, `comments`) or `""` (for string fields). `labels` and `blocked_by` return `[]` when empty.

---

#### `fetch_comments`

Retrieve comments for a specific issue.

**Request:**

```json
{"operation": "fetch_comments", "issue_id": "abc123"}
```

**Response data:**

```json
[
  {"id": "c1", "author": "alice", "body": "Looks good overall.", "created_at": "2026-03-25T10:00:00Z"},
  {"id": "c2", "author": "bob", "body": "Needs a test for the edge case.", "created_at": "2026-03-25T11:30:00Z"}
]
```

Each comment contains `id`, `author`, `body`, and `created_at` (ISO-8601 timestamp).

---

#### `search_issues`

List active-state issues in the configured project. No parameters beyond `operation`.

**Request:**

```json
{"operation": "search_issues"}
```

**Response data:**

```json
[
  {"id": "abc123", "identifier": "PROJ-42", "title": "Add retry logic", "state": "To Do", "...": "..."},
  {"id": "def456", "identifier": "PROJ-43", "title": "Fix flaky test", "state": "To Do", "...": "..."}
]
```

Each entry has the same shape as a `fetch_issue` response. Only issues matching the configured `active_states` are returned — these are the issues that would be candidates for dispatch, not every issue in the project.

---

#### `transition_issue`

Move an issue to a new state.

**Request:**

```json
{"operation": "transition_issue", "issue_id": "abc123", "target_state": "In Review"}
```

**Response data:**

```json
{"transitioned": true}
```

The `target_state` value must match a valid state name in the tracker. If the transition is not allowed by the tracker's workflow rules, the tool returns a `tracker_payload_error`.

---

### Response envelope

All `tracker_api` responses use a consistent JSON envelope.

**Success:**

```json
{
  "success": true,
  "data": { "..." : "..." }
}
```

The `data` field contains the operation-specific payload shown in each operation section above.

**Failure:**

```json
{
  "success": false,
  "error": {
    "kind": "tracker_auth_error",
    "message": "authentication failed: invalid API key"
  }
}
```

The `kind` field is a machine-readable category. The `message` field is a human-readable description.

---

### Error kinds

These error kinds can appear in `tracker_api` tool responses:

| Kind | Meaning |
|---|---|
| `invalid_input` | Malformed request — missing required field, unknown field, or unparseable JSON. |
| `unsupported_operation` | The `operation` value is not one of the four recognized operations. |
| `project_scope_violation` | The requested issue belongs to a different project than the configured `tracker.project`. |
| `tracker_transport_error` | Network or connection failure reaching the tracker API. Also returned on request cancellation or deadline exceeded. |
| `tracker_auth_error` | Authentication failure (HTTP 401/403). The tracker API key is invalid or lacks permissions. |
| `tracker_api_error` | Tracker API error — rate limiting, 5xx server errors, or other non-200 responses. |
| `tracker_not_found` | The requested issue does not exist (HTTP 404). |
| `tracker_payload_error` | Malformed response from the tracker, or an invalid state transition. |
| `internal_error` | Unexpected internal failure. If you see this, [report a bug](https://github.com/sortie-ai/sortie/issues). |

For retry behavior and operator actions for each tracker error kind, see the [error reference](errors.md).

---

### Project scoping

The tool enforces that all operations target issues within `tracker.project` from [WORKFLOW.md](workflow-config.md). If the agent passes an issue ID that resolves to a different project, the tool returns a `project_scope_violation` error before performing any mutation.

This is a defense-in-depth measure. The primary access control is the tracker adapter's own API scoping — JQL project filter for Jira, repository scope for GitHub. The tool-level check catches edge cases where the API key happens to have cross-project access.

When `tracker.project` is empty (e.g., the file-based tracker), project scoping is disabled.

---

### Tool advertising

Sortie advertises `tracker_api` to the agent automatically. On the first turn of each session, Sortie appends a tool documentation section to the rendered prompt. This section includes the tool name, description, input schema, project scope, and response envelope format. You don't need to describe the tool in your prompt template — the agent already knows it exists.

This is currently **prompt-only advertisement** — the agent receives the tool contract as text in its prompt context. There is no interactive execution channel yet. The agent cannot call the tool and receive a response within the session. The `TrackerAPITool` implementation is fully built and tested against mock trackers; what remains is wiring the runtime communication bridge (MCP stdio server or equivalent) so the agent can invoke it.

If the agent calls an unrecognized tool name through a connected execution channel, Sortie returns a failure response and continues the session. It does not stall or crash.

---

## Using `tracker_api` in prompt templates

Sortie appends the tool description and schema to the prompt automatically — you don't need to reproduce the schema. You can add task-specific guidance about *when* the agent should use the tool once interactive execution is available:

```markdown
You have access to the `tracker_api` tool. Use it to:
- Check related issues before starting work: `{"operation": "search_issues"}`
- Read comments for context: `{"operation": "fetch_comments", "issue_id": "..."}`
- Transition the issue when done: `{"operation": "transition_issue", "issue_id": "...", "target_state": "In Review"}`
```

Today, the agent sees this contract in the prompt but cannot act on it. Including guidance like the above is harmless now and will become functional once the execution channel is connected.
