---
title: "Agent Extensions"
description: "Reference for Sortie agent extensions: .sortie/status file protocol, tracker_api, sortie_status, workspace_history, cost_budget, and notify_operator tools with schemas and errors."
author: Sortie AI
date: 2026-03-26
weight: 90
url: /reference/agent-extensions/
---
Agents running inside a Sortie session have two extension surfaces beyond the codebase and rendered prompt: a **file-based signaling protocol** and **callable tools** delivered over MCP. The file protocol lets the agent influence orchestration flow by writing a single file. The tools give the agent structured access to tracker data, session metadata, run history, and the issue's token budget, plus an outbound notification path to a human operator.

See also: [agent communication model](/concepts/agent-communication/) for why two channels exist, [environment variables reference](/reference/environment/#mcp-server-environment) for MCP server environment, [WORKFLOW.md configuration](/reference/workflow-config/) for the `agent` section.

---

## `.sortie/status` file protocol

The agent-to-orchestrator advisory signal. This is not a tool - it's an out-of-band file written by the agent to tell the orchestrator "stop dispatching me." No SDK, no network call, no runtime dependency. One shell command.

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

Both values suppress continuation retry and eventually release the issue claim, but they diverge at three points in the run: whether the self-review phase runs (`blocked` never enters it; `needs-human-review` does, when self-review is enabled and the issue is still active), what the two values mean if written again inside that phase, and what happens to the issue on exit. `blocked` parks the issue where the dispatch drives issue state, or releases the claim otherwise; it performs no tracker transition. `needs-human-review` triggers a handoff transition to `tracker.handoff_state` when configured, the issue is still active, the dispatch drives issue state, and the [handoff-evidence verdict](/reference/state-machine/#handoff-evidence) permits it.

### Orchestrator behavior

When Sortie detects a recognized value in `.sortie/status`, both signals complete the current turn normally and break the turn loop -- no further turns are attempted. From there they diverge.

**`blocked`:**

1. Exits the worker run. The signal is excluded from the self-review phase by name, whatever `self_review.enabled` says.
2. Performs no tracker transition.
3. Where the dispatch drives issue state, parks the issue and holds it out of dispatch. See [the parked-issue release rules](/concepts/agent-communication/) for how a park lifts. Where the dispatch does not drive issue state (a session started by a [label command](/reference/label-commands/)), releases the claim instead.
4. Does **not** schedule a continuation retry.

**`needs-human-review`:**

1. Where `self_review.enabled` and the issue is still active, enters the [self-review phase](/guides/configure-self-review/) before exiting. A pending completion signal is consumed on entry; the phase reports its own outcome there and can still convert the exit to the `blocked` disposition.
2. Exits the worker run.
3. When `tracker.handoff_state` is configured, the issue is still active, the dispatch drives issue state, no terminal observation intervenes, and the [handoff-evidence verdict](/reference/state-machine/#handoff-evidence) permits it, performs the handoff transition.
4. Releases the issue claim.
5. Does **not** schedule a continuation retry.

If the handoff transition in step 3 fails (network error, permission denied, nil adapter), the orchestrator logs a warning and releases the claim without retry. The agent finished its work -- retrying would be wrong.

A parked issue is released by one of three gestures: the tracker state changes to something other than the one it was parked in, the parking label is removed and confirmed gone, or a later run for the issue produces observable work. See [the release rules](/concepts/agent-communication/) for the confirmation guard and the query-filter caveat. A `needs-human-review` exit with no `tracker.handoff_state` configured performs no tracker write at all, so the issue is immediately eligible for re-dispatch on the next poll.

The full interaction between `.sortie/status` and `tracker.handoff_state` is documented in the [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md).

### Edge cases

| Condition | Behavior |
|---|---|
| File absent | Normal behavior - continue and retry as configured. |
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

Continuation turns do not repeat the instructions. You can include your own instructions in prompt templates too - duplicates are harmless.

During the self-review phase, a second injected instruction supersedes this one for the duration of the phase: it tells the agent to report through `.sortie/review_verdict.json` instead, that writing `needs-human-review` to `.sortie/status` there neither ends the phase nor substitutes for a verdict, and that `blocked` still ends the phase.

### Cleanup and protection

Sortie deletes `.sortie/status` before each new dispatch, so a stale signal from a previous run cannot affect the new one.

Sortie deletes it again at each point in a run where it acts on a recognized value: when a completion signal admits the run to the [self-review phase](/guides/configure-self-review/), and after every review turn and every fix turn inside that phase. Which value was read makes no difference at those points; `blocked` and `needs-human-review` are both removed. The read after a coding turn deletes nothing, so a recognized value written there stays on disk through teardown on a run that never enters the phase. Every deletion is best-effort and applies the same `Lstat` symlink rejection as the read; a deletion that fails is logged and changes nothing else about the run.

An absent or empty file therefore carries two meanings: the agent has written nothing, or Sortie has already acted on what it wrote. What an `after_run` hook or a later `cat` finds is a value Sortie has not acted on.

Sortie writes `.sortie/.gitignore` (containing `*`) before any session data reaches disk. This prevents credentials in `.sortie/mcp.json` from being committed and blocked by GitHub Push Protection.

### Full specification

The complete normative spec lives in [agent-to-orchestrator-protocol.md](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) in the main repo.

---

## Execution channel

Sortie delivers tools to agents via an MCP stdio server running as a sidecar process. Whether a given session reaches it depends on the agent kind and on where the session runs.

Before each agent session, the worker generates `.sortie/mcp.json` inside the workspace directory. This file declares the `sortie-tools` MCP server entry with the absolute path to the `sortie` binary, the workflow path, and session environment variables. What each adapter does with it differs; see [delivery by agent kind](#delivery-by-agent-kind).

The agent runtime spawns `sortie mcp-server` as its own child process - the orchestrator worker does not manage the MCP server lifecycle. Any MCP-compatible agent can call tools without adapter-specific integration.

Session context (issue ID, workspace path, database path, credentials) flows to the MCP server via the `env` block in `.sortie/mcp.json`. Credentials (`SORTIE_*` variables from the orchestrator process) are explicitly included in this block - they do not rely on process inheritance. See [MCP server environment](/reference/environment/#mcp-server-environment) for the full variable table.

If the agent block belonging to the session's own agent kind specifies `mcp_config`, Sortie merges the file it names with the `sortie-tools` entry. The operator's config must not use the reserved server name `sortie-tools`. The merge happens before the session starts, so an unreadable path or a config declaring `sortie-tools` fails the attempt whether or not the adapter goes on to forward the result.

Sortie also appends tool documentation to the first-turn prompt for discoverability alongside MCP `tools/list`. That advertisement is written only for a session that has a channel; a session without one is told nothing about tools. If the agent calls an unrecognized tool name, the MCP server returns an error response and continues the session - it does not stall or crash.

### Delivery by agent kind

The worker writes `.sortie/mcp.json` for every agent kind. Getting its servers to the runtime is the adapter's part, and there are three outcomes.

| Agent kind | Session reaches the tools | How the servers are delivered |
|---|---|---|
| `claude-code` | Local and SSH | The generated file's path on `--mcp-config`. See [Claude Code adapter reference](/reference/adapter-claude-code/#sorties-own-tools-and-the-mcp_config-field). |
| `copilot-cli` | Local and SSH | The generated file's path on `--additional-mcp-config` as `@<path>`. See [Copilot CLI adapter reference](/reference/adapter-copilot/#sorties-own-tools-and-the-mcp_config-field). |
| `codex` | Local launch only | The runtime accepts no config path, so the generated servers are re-expressed as configuration overrides on the app-server command line. See [Codex adapter reference](/reference/adapter-codex/#mcp). |
| `opencode` | Local launch only | The runtime accepts no config path, so the generated servers are re-expressed as the runtime's own configuration document, delivered in the turn's environment. See [OpenCode adapter reference](/reference/adapter-opencode/#mcp). |
| `kiro` | Never | The backend profile gate disables MCP under API-key authentication, so there is nothing to deliver to. See [Kiro adapter reference](/reference/adapter-kiro/#mcp). |

The two `local launch only` kinds withhold delivery on an SSH launch deliberately: every route to a remote agent passes through the local `ssh` command line, so delivering there would put the configuration's credential values on an argument list any other user of the orchestrator host can read. A remote `codex` or `opencode` session therefore reaches no tool, and its first-turn prompt names none.

A session that reaches no tools receives no advertisement either, whichever row it falls in. That is what keeps the prompt and the channel consistent: Sortie does not name a tool it cannot deliver.

For a kind whose adapter delivers the configuration in no form at all, an `mcp_config` value in that kind's own block cannot reach the agent. The worker still reads that file and merges its servers into the generated copy, so an unreadable path or a file declaring a `sortie-tools` server still fails the attempt, and what the merge produces goes nowhere. [`sortie validate`](/reference/cli/#validate) reports that combination as an `agent.mcp_config` warning naming the kind. Separately, it reports any kind with no channel as an `agent.kind.no_tool_channel` warning. Both leave the configuration valid, and the run proceeds.

---

## `tracker_api`

Read and write access to the configured issue tracker (Jira, GitHub Issues, file-based). The agent does not need its own API key - Sortie uses the tracker credentials from [WORKFLOW.md](/reference/workflow-config/). All operations are scoped to the configured `tracker.project`; the agent cannot access issues in other projects.

`tracker_api` is a **[Tier 2](/concepts/agent-tools/)** tool: it requires an external dependency (a tracker API with valid credentials and project). Sortie registers the tool only when a valid tracker configuration with credentials and project is present in WORKFLOW.md.

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

Each entry has the same shape as a `fetch_issue` response, with one exception: `blocked_by` can be `null` instead of `[]`. This operation lists tracker candidates directly and does not run the per-issue blocker read the dispatch loop performs before starting a session, so on a tracker that cannot carry blockers with its candidate list, an issue whose dependencies have not been read yet reports `null` rather than an empty list. On Gitea, every `search_issues` entry reports `blocked_by: null`, because that read never happens on this path. On GitHub, an entry reports `[]` when the tracker's own dependency count already proves the issue has no dependencies, and `null` otherwise. `fetch_issue` on the same issue always reads the dependencies route directly and returns `[]` or a populated array, never `null`. Jira, Linear, and the file adapter are unaffected: their candidate lists already carry a resolved `blocked_by`. Only issues matching the configured `active_states` are returned - the candidates for dispatch, not every issue in the project.

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

All `tracker_api` responses use a consistent JSON envelope. This is the same envelope every built-in tool returns; the per-tool sections below show each tool's `data` payload and its error kinds.

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
| `invalid_input` | Malformed request - missing required field, unknown field, or unparseable JSON. |
| `unsupported_operation` | The `operation` value is not one of the four recognized operations. |
| `project_scope_violation` | The requested issue belongs to a different project than the configured `tracker.project`. |
| `tracker_transport_error` | Network or connection failure reaching the tracker API. Also returned on request cancellation or deadline exceeded. |
| `tracker_auth_error` | Authentication failure (HTTP 401/403). The tracker API key is invalid or lacks permissions. |
| `tracker_api_error` | Tracker API error - rate limiting, 5xx server errors, or other non-200 responses. |
| `tracker_not_found` | The requested issue does not exist (HTTP 404). |
| `tracker_payload_error` | Malformed response from the tracker, or an invalid state transition. |
| `internal_error` | Unexpected internal failure. If you see this, [report a bug](https://github.com/sortie-ai/sortie/issues). |

For retry behavior and operator actions for each tracker error kind, see the [error reference](/reference/errors/).

---

### Project scoping

The tool enforces that all operations target issues within `tracker.project` from [WORKFLOW.md](/reference/workflow-config/). If the agent passes an issue ID that resolves to a different project, the tool returns a `project_scope_violation` error before performing any mutation.

This is a defense-in-depth measure. The primary access control is the tracker adapter's own API scoping - JQL project filter for Jira, repository scope for GitHub. The tool-level check catches edge cases where the API key happens to have cross-project access.

When `tracker.project` is empty (e.g., the file-based tracker), project scoping is disabled.

---

## `sortie_status`

Read-only session metadata. The agent calls this tool to check how many turns remain, how long the session has been running, and how many tokens have been consumed. Zero external calls - reads a local file only.

`sortie_status` is a **Tier 1** tool: no external dependencies. Registered when `SORTIE_WORKSPACE` is set in the MCP server environment.

### Input schema

No parameters. The agent sends an empty JSON object:

```json
{}
```

### How it works

The tool reads `.sortie/state.json`, a file the worker goroutine writes at session start and updates at the beginning of each turn and on token usage events. The tool validates the file before reading: symlinks are rejected via `Lstat`, and files larger than 4 KiB are refused.

### Response fields

The fields below are returned under `data` in the standard success envelope:

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
  "success": true,
  "data": {
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
}
```

**Error** (state file not yet written):

```json
{
  "success": false,
  "error": {
    "kind": "state_unavailable",
    "message": "state file unavailable: open .sortie/state.json: no such file or directory"
  }
}
```

The failure shape is the same structured envelope every built-in tool uses.

### Error kinds

| Kind | Meaning |
|---|---|
| `state_unavailable` | The state file is absent, a symlink, oversized, or unreadable. |
| `state_malformed` | The state file is present but unparseable - malformed JSON or an invalid `started_at`. |

---

## `workspace_history`

Read-only access to prior run history for the current issue. The agent calls this tool to see what happened in previous attempts - whether they succeeded, failed, were cancelled, or failed CI. Useful for avoiding repeated mistakes on retry.

`workspace_history` is a **Tier 1** tool: queries the local SQLite database in read-only mode, no external calls. Registered when both `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the database can be opened in read-only mode. If the database open fails, the MCP server continues without this tool (non-fatal).

### Input schema

No parameters. The agent sends an empty JSON object:

```json
{}
```

### How it works

The tool opens the Sortie SQLite database (`SORTIE_DB_PATH`) with the `?mode=ro` URI parameter and queries the `run_history` table filtered by the current issue (`SORTIE_ISSUE_ID`). Returns up to 10 entries, newest first.

### Response fields

Returned under `data` in the standard success envelope:

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
| `status` | string | Terminal status: `succeeded`, `failed`, `cancelled`, `ci_failed`, or `needs_person`. `needs_person` marks a run that stopped because the agent asked for a decision only a person could give; it is distinct from `failed` and takes no retry. |
| `error` | string or null | Error message if failed; `null` on success. |

### Example response

**Success with prior runs:**

```json
{
  "success": true,
  "data": {
    "issue_id": "42",
    "entries": [
      {
        "attempt": 2,
        "agent_adapter": "claude-code",
        "started_at": "2026-03-30T14:20:00Z",
        "completed_at": "2026-03-30T14:35:12Z",
        "status": "failed",
        "error": "agent turn 3: agent: turn_timeout: turn exceeded the configured 3600000 ms bound; the adapter's own report follows: context deadline exceeded"
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
}
```

**No prior runs:**

```json
{
  "success": true,
  "data": {
    "issue_id": "42",
    "entries": []
  }
}
```

**Error:**

```json
{
  "success": false,
  "error": {
    "kind": "query_failed",
    "message": "query failed: database is locked"
  }
}
```

The failure shape is the same structured envelope every built-in tool uses.

### Error kinds

| Kind | Meaning |
|---|---|
| `query_failed` | The history query failed. |

---

## `cost_budget`

Read-only token accounting for the current issue. The agent calls this tool to check cumulative token spend across all of the issue's sessions and the remaining budget, then decide whether to skip an expensive step, return partial work, or hand off before the orchestrator's token ceiling blocks the next session. Where `sortie_status` reports token usage for the current session (read from `.sortie/state.json`), `cost_budget` reports cumulative spend across every session for the issue (read from SQLite) and compares it against the configured budget.

`cost_budget` is a **Tier 1** tool: queries the local SQLite database in read-only mode, no external calls. Registered when both `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the database can be opened in read-only mode - the same condition as `workspace_history`, sharing the same read-only connection. If the database open fails, the MCP server continues without both tools (non-fatal). When `SORTIE_SESSION_ID` is also set, the reading includes the running session's recorded spend; without it, only completed sessions count.

### Input schema

No parameters. The agent sends an empty JSON object:

```json
{}
```

### How it works

The tool sums `total_tokens` across the issue's `run_history` rows (one per completed session) and adds the running session's recorded total from `session_metadata`. The orchestrator updates `session_metadata` incrementally during the session, throttled to at most one write per issue every two seconds and driven by token usage events, so the running number stays current. That total is added only when the stored session ID matches `SORTIE_SESSION_ID`, so a stale row from an earlier session is never counted. Nothing is counted twice: a running session reaches `run_history` only when it ends.

A session whose coding agent reported no token usage is recorded as unmeasured: its token figures are zero, that zero carries no information, and the session is counted in `unmeasured_sessions` instead of contributing to `used_tokens`.

Run-history rows written before the token columns existed (migration 011) read as zero, so spend recorded before the upgrade is invisible to the budget. Rows written before the measurement flag existed (migration 012) count as measured, because their provenance is not recoverable.

### Response fields

The fields below are returned under `data` in the standard success envelope:

| Field | Type | Description |
|---|---|---|
| `used_tokens` | integer | Cumulative `total_tokens` across the issue's completed sessions, plus the running session's recorded spend. |
| `budget_tokens` | integer | The configured [`agent.max_tokens`](/reference/workflow-config/#agent). `0` means unlimited. |
| `remaining_tokens` | integer or null | `budget_tokens - used_tokens`, floored at 0. `null` when the budget is unlimited, so the agent can tell "no limit" from "nothing left". |
| `used_sessions` | integer | Completed sessions for the issue. The running session is not counted. Unmeasured sessions still count here, because [`agent.max_sessions`](/reference/workflow-config/#agent) counts sessions rather than spend. |
| `budget_sessions` | integer | The configured [`agent.max_sessions`](/reference/workflow-config/#agent). `0` means unlimited. |
| `unmeasured_sessions` | integer | Completed sessions whose coding agent reported no token usage. `used_tokens` excludes them rather than counting them as zero spend. |
| `used_tokens_complete` | boolean | `false` when `unmeasured_sessions` is above `0`, or when a running session ID was supplied and no matching session record was found for it. `true` otherwise. On `false`, treat `used_tokens` as a lower bound and `remaining_tokens` as an upper bound. |

`used_tokens` includes the running session while `used_sessions` excludes it. The asymmetry is deliberate: a session is either finished or not, tokens accrue continuously, and a reading that ignored in-flight spend would be useless at exactly the moment the agent consults it.

The orchestrator enforces the same numbers. When `used_tokens` reaches a non-zero `budget_tokens`, the next re-dispatch for the issue is blocked. See [how to control agent costs](/guides/control-costs/) for the enforcement behavior and budget strategy.

### Example response

**Success with a configured budget:**

```json
{
  "success": true,
  "data": {
    "used_tokens": 384000,
    "budget_tokens": 1000000,
    "remaining_tokens": 616000,
    "used_sessions": 2,
    "budget_sessions": 5,
    "unmeasured_sessions": 0,
    "used_tokens_complete": true
  }
}
```

**Success with an unlimited budget:**

```json
{
  "success": true,
  "data": {
    "used_tokens": 384000,
    "budget_tokens": 0,
    "remaining_tokens": null,
    "used_sessions": 2,
    "budget_sessions": 5,
    "unmeasured_sessions": 0,
    "used_tokens_complete": true
  }
}
```

**Success with an incomplete reading:**

```json
{
  "success": true,
  "data": {
    "used_tokens": 384000,
    "budget_tokens": 1000000,
    "remaining_tokens": 616000,
    "used_sessions": 3,
    "budget_sessions": 5,
    "unmeasured_sessions": 1,
    "used_tokens_complete": false
  }
}
```

**Error:**

```json
{
  "success": false,
  "error": {
    "kind": "query_failed",
    "message": "query failed: database is locked"
  }
}
```

The failure shape is the same structured envelope every built-in tool uses.

### Error kinds

| Kind | Meaning |
|---|---|
| `query_failed` | The budget query failed. |

---

## `notify_operator`

Real-time notification to the operator's configured channels. The agent calls this tool to escalate a decision it should not make alone, report progress on a long task, or flag a blocker, without terminating the session. Sending a notification changes nothing in orchestration: no retry suppression, no tracker transition, no claim release. To tell the orchestrator to stop, the agent writes `.sortie/status`; see the [agent communication model](/concepts/agent-communication/) for how the two surfaces relate.

`notify_operator` is a **Tier 2** tool: it makes outbound HTTP POST calls to operator-configured endpoints. Sortie registers the tool only when the `notifications` list in [WORKFLOW.md](/reference/workflow-config/#notifications) configures at least one backend (`webhook` or `slack`); an empty or absent list leaves the tool unregistered, so the agent is never offered a tool it cannot use. An invalid backend (unknown kind, missing endpoint URL, a secret that resolved to the empty string) is a fatal MCP server startup error, never a partial registration.

### Input schema

The tool accepts a JSON object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `severity` | string | Yes | One of: `info`, `warning`, `critical` |
| `title` | string | Yes | Non-empty short summary |
| `body` | string | Yes | Non-empty notification detail |
| `category` | string | No | One of: `decision_needed`, `progress`, `blocked`, `completed`, `other` |

No additional fields are accepted. Unknown fields, trailing content, out-of-enum values, and an empty `title` or `body` all produce an `invalid_input` error. The agent supplies only the message; every envelope field below is system-owned and absent from the schema.

### How it works

Each accepted call produces one notification with two layers. The agent supplies the message (`severity`, `title`, `body`, optional `category`). The tool fills the envelope from session context the agent cannot set or forge: a generated UUID `notification_id`, an RFC3339 UTC `timestamp`, a `source` identifying the Sortie instance (the hostname), the `issue_id` and `identifier`, the `session_id`, the `attempt` (`null` on the first run), and the dispatch-frozen `agent` kind from `SORTIE_SESSION_AGENT_KIND`.

Delivery goes to every configured backend in configuration order and stops at the first backend that fails, which yields a `send_failed` error. Partial delivery across backends is not reported in this version. Each backend call carries a 10-second timeout, so a slow endpoint cannot stall the turn indefinitely.

Calls are capped per session. The effective cap is the highest non-zero `max_per_session` across the configured backends, falling back to 20 when every entry is `0` or unset; `0` selects the default, never unlimited. A call past the cap returns `rate_limited` and sends nothing. The counter counts accepted tool calls, not per-backend sends, and increments only after every backend succeeded, so a failed call does not consume the cap.

The backends never log or echo the endpoint URL, the request body, or the response body. Delivery failures surface as fixed categories (`timeout`, `connection failure`, `unauthorized (HTTP <code>)`, `rate limited (HTTP 429)`, `server error (HTTP <code>)`, `unexpected response (HTTP <code>)`) in the `send_failed` message, so a secret-bearing webhook URL never reaches a log or the agent.

### What each backend delivers

The `webhook` backend posts the notification as a single JSON object with generic field names. Any 2xx response counts as success:

```json
{
  "notification_id": "3f8a2c1d-9b4e-4f6a-8c2d-1e7b5a9d0c3f",
  "timestamp": "2026-06-11T14:03:05Z",
  "source": "build-host-01",
  "issue_id": "abc123",
  "identifier": "PROJ-42",
  "session_id": "b4c0e7d2-5a19-4e8b-9f3c-6d2a8e1b7c4d",
  "attempt": 2,
  "agent": "claude-code",
  "severity": "critical",
  "title": "Decision needed: breaking schema change",
  "body": "Fixing this bug requires dropping a column other services may read. Need a human decision before proceeding.",
  "category": "decision_needed"
}
```

`attempt` is `null` on the first run and a number afterwards. `category` is omitted when the agent did not set one. This outbound webhook backend is unrelated to tracker webhooks: Sortie has no inbound webhook receiver and discovers tracker state only by polling, so the word describes an outbound POST here and nothing else.

The `slack` backend posts a Slack incoming-webhook body whose `text` field renders the message with the severity uppercased:

```json
{"text": "[CRITICAL] Decision needed: breaking schema change\nFixing this bug requires dropping a column other services may read. Need a human decision before proceeding."}
```

The Slack rendering carries only the message. The envelope (issue key, session ID) does not appear in the Slack text.

### Response envelope

**Success:**

```json
{
  "success": true,
  "data": {
    "delivered": 2,
    "notification_id": "3f8a2c1d-9b4e-4f6a-8c2d-1e7b5a9d0c3f"
  }
}
```

`data.delivered` is the number of backends that accepted the notification; on success it equals the number of configured backends.

**Failure:**

```json
{
  "success": false,
  "error": {
    "kind": "send_failed",
    "message": "notification delivery failed: timeout"
  }
}
```

### Error kinds

| Kind | Meaning |
|---|---|
| `invalid_input` | Malformed request: unknown or trailing fields, an out-of-enum `severity` or `category`, or an empty `title` or `body`. |
| `rate_limited` | The per-session notification cap is reached. Nothing was sent. |
| `send_failed` | A backend returned a transport failure, a non-2xx response, or an unparseable response. The message is a redacted category and never echoes the URL, request body, or response body. |
| `backend_unavailable` | No backend could be resolved at execution time. Defensive: normal operation registers the tool only when a backend is configured. |

---

## Response format summary

Every tool uses the same response envelope; each tool's section above documents what goes in `data`. This table shows the shape at a glance:

| Tool | Success format | Error format |
|---|---|---|
| `tracker_api` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |
| `sortie_status` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |
| `workspace_history` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |
| `cost_budget` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |
| `notify_operator` | `{"success": true, "data": {...}}` | `{"success": false, "error": {"kind": "...", "message": "..."}}` |

All tools provide structured `error.kind` values for programmatic handling. The Tier 1 tools (`sortie_status`, `workspace_history`, `cost_budget`) share a small closed set (`state_unavailable`, `state_malformed`, `query_failed`) because their only failure mode is local state that is missing or unreadable; the Tier 2 tools (`tracker_api`, `notify_operator`) carry broader kind sets covering transport, auth, rate-limit, and input failures.

---

## Using tools in prompt templates

Sortie appends tool documentation to the first-turn prompt automatically - you don't need to reproduce schemas or describe the tools' existence. Both the prompt text and MCP `tools/list` reach a session that has an execution channel, and neither reaches one that does not (see [delivery by agent kind](#delivery-by-agent-kind)). Task-specific guidance you write yourself is not gated that way: it renders into the prompt whatever kind the session runs, so phrase it conditionally if a workflow can dispatch to a kind with no channel.

You can add task-specific guidance about *when* to use tools in your prompt template. Write this in natural language:

```markdown
You have access to Sortie tools via MCP. Use them to:
- Check related issues with the tracker_api tool (search_issues operation)
- Check your remaining turns with the sortie_status tool
- Review prior run history with the workspace_history tool
- Check cumulative token spend and remaining budget with the cost_budget tool
- Escalate a decision to a human or report progress with the notify_operator tool (when notifications are configured)
- Transition the issue when done with the tracker_api tool (transition_issue operation)
```

Do not include JSON tool call syntax in prompt templates. An agent with an MCP client calls tools through it, not by writing JSON into the prompt. Natural language instructions are sufficient - the schemas travel with the advertisement.

For detailed patterns and worked examples, see [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/).

---

## See also

- [Agent communication model](/concepts/agent-communication/) - why two channels (file protocol + MCP tools) exist
- [Agent tools concept](/concepts/agent-tools/) - the tier model: what each tier guarantees and when each tool registers
- [Security model](/concepts/security/) - trust boundaries for outbound notifications and agent-generated content
- [How to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) - task-specific tool guidance for workflow authors
- [How to write a custom agent tool](/guides/write-custom-agent-tool/) - implementing the `Tool` interface
- [Environment variables reference](/reference/environment/#mcp-server-environment) - MCP server env vars
- [WORKFLOW.md configuration reference](/reference/workflow-config/) - `agent` section, `agent.max_turns`
- [Error reference](/reference/errors/) - tracker error kinds with retry behavior
- [State machine reference](/reference/state-machine/) - orchestration states, retry suppression
- [Prometheus metrics reference](/reference/prometheus-metrics/) - `sortie_tool_calls_total` counter
- [A2O protocol specification](https://github.com/sortie-ai/sortie/blob/main/docs/agent-to-orchestrator-protocol.md) - full normative spec
