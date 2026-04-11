---
title: "Agent Extensions"
description: "Reference for agent extensions during Sortie sessions: .sortie/status file protocol, tracker_api, sortie_status, and workspace_history tools with input schemas, response formats, and error handling."
keywords: sortie agent tools, tracker_api, sortie_status, workspace_history, .sortie/status, agent extensions, MCP, tool calling
author: Sortie AI
date: 2026-03-26
weight: 90
url: /reference/agent-extensions/
---
Agents running inside a Sortie session have two extension surfaces beyond the codebase and rendered prompt: a **file-based signaling protocol** and **callable tools** delivered over MCP. The file protocol lets the agent influence orchestration flow by writing a single file. The tools give the agent structured access to tracker data, session metadata, and run history.

See also: [agent communication model](/concepts/agent-communication/) for why two channels exist, [environment variables reference](/reference/environment/#mcp-server-environment) for MCP server environment, [WORKFLOW.md configuration](/reference/workflow-config/) for the `agent` section.

---

## `.sortie/status` file protocol

The agent-to-orchestrator advisory signal. This is not a tool — it's an out-of-band file written by the agent to tell the orchestrator "stop dispatching me." No SDK, no network call, no runtime dependency. One shell command.

### Path

`.sortie/status` relative to the workspace root.

### Writing the file

```sh
mkdir -p .sortie && echo "blocked" > .sortie/status
```

### Recognized values

| Value | Meaning |
|---|---|
| `blocked` | The agent cannot proceed without human intervention. |
| `needs-human-review` | Work is complete but requires human review before merging or closing. |

Both values suppress continuation retry and release the issue claim. The difference: `needs-human-review` also triggers a handoff transition to `tracker.handoff_state` (when configured and the issue is in an active tracker state). `blocked` does not perform any tracker transition.

### Orchestrator behavior

When Sortie detects a recognized value in `.sortie/status`:

1. Completes the current turn normally.
2. Breaks the turn loop -- no further turns are attempted.
3. Exits the worker run.
4. For `needs-human-review` only: when `tracker.handoff_state` is configured and the issue is in an active tracker state, performs the handoff transition.
5. Releases the issue claim.
6. Does **not** schedule a continuation retry.

If the handoff transition in step 4 fails (network error, permission denied, nil adapter), the orchestrator logs a warning and releases the claim without retry. The agent finished its work -- retrying would be wrong.

The issue re-dispatches only when the tracker state changes (e.g., a human moves it back to an active state).

The full interaction between `.sortie/status` and `tracker.handoff_state` is documented in the [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) Section 3.6.

### Edge cases

| Condition | Behavior |
|---|---|
| File absent | Normal behavior — continue and retry as configured. |
| Unrecognized value | Ignored. Warning logged. Normal behavior continues. |
| Read error | Treated as absent. Warning logged. Never fails the worker run. |
| Symlink on `.sortie/` or `status` | Rejected via `Lstat` check. Treated as absent. Warning logged. |

### Auto-injection

Sortie appends protocol instructions to the first-turn prompt automatically (`RuntimeStatusSuffix`). The agent receives this text without any workflow author configuration:

```
If you determine that you cannot make further progress on this task without human
intervention, or if your work is complete and requires human review, signal the
orchestrator by running:

    mkdir -p .sortie && echo "blocked" > .sortie/status

Use "blocked" when you cannot proceed. Use "needs-human-review" when your work is
complete and awaiting review. Do not write this file during normal productive work.
```

Continuation turns do not repeat the instructions. You can include your own instructions in prompt templates too — duplicates are harmless.

### Cleanup and protection

Sortie deletes `.sortie/status` before each new dispatch to prevent stale signals from a previous run.

Sortie writes `.sortie/.gitignore` (containing `*`) before any session data reaches disk. This prevents credentials in `.sortie/mcp.json` from being committed and blocked by GitHub Push Protection.

### Full specification

The complete normative spec lives in [agent-to-orchestrator-protocol.md](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) in the main repo.

---

## Execution channel

Sortie delivers tools to agents via an MCP stdio server running as a sidecar process.

Before each agent session, the worker generates `.sortie/mcp.json` inside the workspace directory. This file declares the `sortie-tools` MCP server entry with the absolute path to the `sortie` binary, the workflow path, and session environment variables. The worker passes this config to the agent via `--mcp-config` (Claude Code) or `--additional-mcp-config` (Copilot CLI).

The agent runtime spawns `sortie mcp-server` as its own child process — the orchestrator worker does not manage the MCP server lifecycle. Any MCP-compatible agent can call tools without adapter-specific integration.

Session context (issue ID, workspace path, database path, credentials) flows to the MCP server via the `env` block in `.sortie/mcp.json`. Credentials (`SORTIE_*` variables from the orchestrator process) are explicitly included in this block — they do not rely on process inheritance. See [MCP server environment](/reference/environment/#mcp-server-environment) for the full variable table.

If the operator specifies a custom `mcp_config` in WORKFLOW.md, Sortie merges it with the `sortie-tools` entry. The operator's config must not use the reserved server name `sortie-tools`.

Sortie also appends tool documentation to the first-turn prompt for discoverability alongside MCP `tools/list`. If the agent calls an unrecognized tool name, the MCP server returns an error response and continues the session — it does not stall or crash.

---

## `tracker_api`

Read and write access to the configured issue tracker (Jira, GitHub Issues, file-based). The agent does not need its own API key — Sortie uses the tracker credentials from [WORKFLOW.md](/reference/workflow-config/). All operations are scoped to the configured `tracker.project`; the agent cannot access issues in other projects.

`tracker_api` is a **Tier 2** tool: it requires an external dependency (a tracker API with valid credentials and project). Sortie registers the tool only when a valid tracker configuration with credentials and project is present in WORKFLOW.md.

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

Retrieves a single issue by its tracker-internal ID. Returns the full issue record.

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
    {
      "id": "c1",
      "author": "bob",
      "body": "Confirmed in prod.",
      "created_at": "2026-03-25T10:00:00Z"
    }
  ],
  "blocked_by": [],
  "created_at": "2026-03-20T09:00:00Z",
  "updated_at": "2026-03-25T14:30:00Z"
}
```

Fields that have no value in the tracker return `null` (for `priority`, `parent`, `comments`) or `""` (for string fields). `labels` and `blocked_by` return `[]` when empty.

---

#### `fetch_comments`

Retrieves comments for a specific issue.

**Request:**

```json
{"operation": "fetch_comments", "issue_id": "abc123"}
```

**Response data:**

```json
[
  {
    "id": "c1",
    "author": "alice",
    "body": "Looks good overall.",
    "created_at": "2026-03-25T10:00:00Z"
  },
  {
    "id": "c2",
    "author": "bob",
    "body": "Needs a test for the edge case.",
    "created_at": "2026-03-25T11:30:00Z"
  }
]
```

Each comment contains `id`, `author`, `body`, and `created_at` (ISO-8601 timestamp).

---

#### `search_issues`

Lists active-state issues in the configured project. No parameters beyond `operation`.

**Request:**

```json
{"operation": "search_issues"}
```

**Response data:**

```json
[
  {
    "id": "abc123",
    "identifier": "PROJ-42",
    "title": "Add retry logic",
    "state": "To Do",
    "...": "..."
  },
  {
    "id": "def456",
    "identifier": "PROJ-43",
    "title": "Fix flaky test",
    "state": "To Do",
    "...": "..."
  }
]
```

Each entry has the same shape as a `fetch_issue` response. Only issues matching the configured `active_states` are returned — the candidates for dispatch, not every issue in the project.

---

#### `transition_issue`

Moves an issue to a new state.

**Request:**

```json
{
  "operation": "transition_issue",
  "issue_id": "abc123",
  "target_state": "In Review"
}
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

For retry behavior and operator actions for each tracker error kind, see the [error reference](/reference/errors/).

---

### Project scoping

The tool enforces that all operations target issues within `tracker.project` from [WORKFLOW.md](/reference/workflow-config/). If the agent passes an issue ID that resolves to a different project, the tool returns a `project_scope_violation` error before performing any mutation.

This is a defense-in-depth measure. The primary access control is the tracker adapter's own API scoping — JQL project filter for Jira, repository scope for GitHub. The tool-level check catches edge cases where the API key happens to have cross-project access.

When `tracker.project` is empty (e.g., the file-based tracker), project scoping is disabled.

---

## `sortie_status`

Read-only session metadata. The agent calls this tool to check how many turns remain, how long the session has been running, and how many tokens have been consumed. Zero external calls — reads a local file only.

`sortie_status` is a **Tier 1** tool: no external dependencies. Registered when `SORTIE_WORKSPACE` is set in the MCP server environment.

### Input schema

No parameters. The agent sends an empty JSON object:

```json
{}
```

### How it works

The tool reads `.sortie/state.json`, a file the worker goroutine writes at session start and updates at the beginning of each turn and on token usage events. The tool validates the file before reading: symlinks are rejected via `Lstat`, and files larger than 4 KiB are refused.

### Response fields

Returned as a bare JSON object (no `success`/`data` wrapper):

| Field | Type | Description |
|---|---|---|
| `turn_number` | integer | Current turn within the session. |
| `max_turns` | integer | Configured [`agent.max_turns`](/reference/workflow-config/). |
| `turns_remaining` | integer | `max_turns - turn_number`, clamped to 0. |
| `attempt` | integer or null | Retry/continuation attempt number. `null` on first run. |
| `session_duration_seconds` | float | Wall-clock time since session started (millisecond precision). |
| `tokens` | object | Token usage counters for the current session. |

Token usage fields:

| Field | Type | Description |
|---|---|---|
| `input_tokens` | integer | Total input tokens consumed. |
| `output_tokens` | integer | Total output tokens generated. |
| `total_tokens` | integer | Sum of input and output tokens. |
| `cache_read_tokens` | integer | Tokens served from prompt cache. |

### Example response

**Success:**

```json
{
  "turn_number": 3,
  "max_turns": 20,
  "turns_remaining": 17,
  "attempt": null,
  "session_duration_seconds": 142.537,
  "tokens": {
    "input_tokens": 45000,
    "output_tokens": 12000,
    "total_tokens": 57000,
    "cache_read_tokens": 8000
  }
}
```

**Error** (state file not yet written):

```json
{
  "error": "state file unavailable: open .sortie/state.json: no such file or directory"
}
```

The error format is a flat `{"error": "message"}` object — different from `tracker_api`'s structured error envelope.

---

## `workspace_history`

Read-only access to prior run history for the current issue. The agent calls this tool to see what happened in previous attempts — whether they succeeded, failed, timed out, or stalled. Useful for avoiding repeated mistakes on retry.

`workspace_history` is a **Tier 1** tool: queries the local SQLite database in read-only mode, no external calls. Registered when both `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the database can be opened in read-only mode. If the database open fails, the MCP server continues without this tool (non-fatal).

### Input schema

No parameters. The agent sends an empty JSON object:

```json
{}
```

### How it works

The tool opens the Sortie SQLite database (`SORTIE_DB_PATH`) with the `?mode=ro` URI parameter and queries the `run_history` table filtered by the current issue (`SORTIE_ISSUE_ID`). Returns up to 10 entries, newest first.

### Response fields

Top-level:

| Field | Type | Description |
|---|---|---|
| `issue_id` | string | The issue ID this history belongs to. |
| `entries` | array | Up to 10 most recent completed run attempts, newest first. |

Per entry:

| Field | Type | Description |
|---|---|---|
| `attempt` | integer | Attempt number at time of run (1-based). |
| `agent_adapter` | string | Which agent adapter was used (e.g., `claude-code`). |
| `started_at` | string | ISO-8601 timestamp. |
| `completed_at` | string | ISO-8601 timestamp. |
| `status` | string | Terminal status: `succeeded`, `failed`, `timed_out`, `stalled`, `cancelled`. |
| `error` | string or null | Error message if failed; `null` on success. |

### Example response

**Success with prior runs:**

```json
{
  "issue_id": "42",
  "entries": [
    {
      "attempt": 2,
      "agent_adapter": "claude-code",
      "started_at": "2026-03-30T14:20:00Z",
      "completed_at": "2026-03-30T14:35:12Z",
      "status": "failed",
      "error": "agent turn error: turn timeout exceeded"
    },
    {
      "attempt": 1,
      "agent_adapter": "claude-code",
      "started_at": "2026-03-30T13:00:00Z",
      "completed_at": "2026-03-30T13:45:30Z",
      "status": "succeeded",
      "error": null
    }
  ]
}
```

**No prior runs:**

```json
{
  "issue_id": "42",
  "entries": []
}
```

**Error:**

```json
{
  "error": "query failed: database is locked"
}
```

The error format is a flat `{"error": "message"}` object, same as `sortie_status`.

---

## Response format summary

Different tools use different response envelopes. This table shows the shape at a glance:

| Tool | Success format | Error format |
|---|---|---|
| `tracker_api` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |
| `sortie_status` | Bare JSON object | `{"error": "message"}` |
| `workspace_history` | `{"issue_id": "...", "entries": [...]}` | `{"error": "message"}` |

The `tracker_api` envelope provides structured error kinds for programmatic handling. The Tier 1 tools use a simpler flat error string — there are fewer failure modes to categorize.

---

## Using tools in prompt templates

Sortie appends tool documentation to the first-turn prompt automatically — you don't need to reproduce schemas or describe the tools' existence. The agent discovers tools through both the prompt text and MCP `tools/list`.

You can add task-specific guidance about *when* to use tools in your prompt template. Write this in natural language:

```markdown
You have access to Sortie tools via MCP. Use them to:
- Check related issues with the tracker_api tool (search_issues operation)
- Check your remaining turns with the sortie_status tool
- Review prior run history with the workspace_history tool
- Transition the issue when done with the tracker_api tool (transition_issue operation)
```

Do not include JSON tool call syntax in prompt templates. The agent calls tools through its MCP client, not by writing JSON into the prompt. Natural language instructions are sufficient — the agent already knows the schemas.

For detailed patterns and worked examples, see [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/).

---

## See also

- [Agent communication model](/concepts/agent-communication/) — why two channels (file protocol + MCP tools) exist
- [How to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) — task-specific tool guidance for workflow authors
- [How to write a custom agent tool](/guides/write-custom-agent-tool/) — implementing the `Tool` interface
- [Environment variables reference](/reference/environment/#mcp-server-environment) — MCP server env vars
- [WORKFLOW.md configuration reference](/reference/workflow-config/) — `agent` section, `agent.max_turns`
- [Error reference](/reference/errors/) — tracker error kinds with retry behavior
- [State machine reference](/reference/state-machine/) — orchestration states, retry suppression
- [Prometheus metrics reference](/reference/prometheus-metrics/) — `sortie_tool_calls_total` counter
- [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) — full normative spec
