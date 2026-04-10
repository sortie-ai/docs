---
title: "HTTP API"
description: "Complete reference for Sortie's embedded HTTP server: JSON API endpoints, request/response shapes, error codes, and curl examples."
keywords: sortie HTTP API, REST API, JSON API, dashboard, endpoints, curl, observability
author: Sortie AI
date: 2026-03-26
weight: 40
url: /reference/http-api/
---
Sortie embeds an HTTP server that exposes a JSON API, an HTML dashboard, health probes, and Prometheus metrics — all on a single port.

## Server configuration

The HTTP server starts by default on `127.0.0.1:7678` with no flags required.

**Override the port** — pass `--port <N>` when launching Sortie:

```sh
sortie --port 9090 WORKFLOW.md
```

**Override the bind address** — pass `--host <ADDR>` for container deployments:

```sh
sortie --host 0.0.0.0 WORKFLOW.md
```

**Workflow config** — set `server.port` and `server.host` in the WORKFLOW.md front matter extensions:

```yaml
---
server:
  port: 9090
  host: "0.0.0.0"
# ... rest of config
---
```

CLI flags take precedence over extension keys. Port `0` disables the server entirely (no TCP listener, no Prometheus metrics). `--host` must be a parseable IP address; DNS hostnames are not accepted.

When the default port (7678) is already occupied and no port was explicitly requested, Sortie logs a warning and starts without the HTTP server. When an explicit port is in use, Sortie exits with code `1`.

The HTTP server is not started in [`--dry-run`](/reference/cli/#-dry-run) mode. Changing the port or host requires a restart — there is no hot-rebind.

For the full `server` extension schema, see [WORKFLOW.md configuration reference](/reference/workflow-config/). For Prometheus metric definitions, see [Prometheus metrics reference](/reference/prometheus-metrics/).

---

## GET / — HTML dashboard

Server-rendered HTML page showing real-time system state. Auto-refreshes in the browser.

```sh
curl http://localhost:8080/
```

The dashboard displays running sessions (identifier, state, turn count, duration, last event, tokens), the retry queue (identifier, attempt, due-in, error), summary cards (running count, retrying count, available slots, total tokens), uptime, version, aggregate runtime and token totals, and a run history table of completed sessions.

Returns `text/html`. This is not a JSON endpoint.

### Run history entries

The run history table lists recently completed sessions. Each entry contains:

| Field | Type | Description |
|---|---|---|
| `identifier` | string | Tracker-assigned issue identifier (e.g., `"PROJ-123"`). |
| `attempt` | integer | One-based retry attempt number. |
| `status` | string | Terminal outcome: `"success"` or `"failure"`. |
| `workflow_file` | string | Path to the workflow definition used for this run. |
| `started_at` | string | Formatted start timestamp. |
| `completed_at` | string | Formatted completion timestamp. |
| `error` | string or null | Error message when `status` is `"failure"`. `null` on success. |
| `turns_completed` | integer | Number of agent turns completed before exit. |
| `review_metadata` | object or null | Self-review outcome. `null` when self-review was not configured or did not run. |

#### `review_metadata` structure

When [self-review](/guides/configure-self-review/) is enabled and runs, `review_metadata` captures the full audit trail:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | `true` when self-review was configured and ran. |
| `total_iterations` | integer | Number of review iterations completed. |
| `final_verdict` | string | Last verdict: `"pass"`, `"iterate"`, or `"none"`. |
| `cap_reached` | boolean | `true` when the iteration cap was reached without a `"pass"` verdict. |
| `iterations` | array | Per-iteration records (see below). |

Each element in `iterations`:

| Field | Type | Description |
|---|---|---|
| `iteration` | integer | 1-based iteration number. |
| `diff_size_bytes` | integer | Size of the diff in bytes before truncation. |
| `diff_truncated` | boolean | `true` when the diff was truncated to `max_diff_bytes`. |
| `verification_results` | array | Outcome of each verification command: `command`, `exit_code`, `duration_ms`, `timed_out`. |
| `verdict` | string | Parsed verdict from the agent: `"pass"`, `"iterate"`, or empty when unparseable. |

Example `review_metadata` for a session that passed on the second iteration:

```json
{
  "enabled": true,
  "iterations": [
    {
      "iteration": 1,
      "diff_size_bytes": 4520,
      "diff_truncated": false,
      "verification_results": [
        {
          "command": "go test ./...",
          "exit_code": 1,
          "duration_ms": 3400,
          "timed_out": false
        },
        {
          "command": "go vet ./...",
          "exit_code": 0,
          "duration_ms": 820,
          "timed_out": false
        }
      ],
      "verdict": "iterate"
    },
    {
      "iteration": 2,
      "diff_size_bytes": 4800,
      "diff_truncated": false,
      "verification_results": [
        {
          "command": "go test ./...",
          "exit_code": 0,
          "duration_ms": 3100,
          "timed_out": false
        },
        {
          "command": "go vet ./...",
          "exit_code": 0,
          "duration_ms": 790,
          "timed_out": false
        }
      ],
      "verdict": "pass"
    }
  ],
  "total_iterations": 2,
  "final_verdict": "pass",
  "cap_reached": false
}
```

`review_metadata` is persisted as JSON in the `review_metadata` column of the `run_history` SQLite table. Query it directly when the dashboard view is insufficient:

```sh
sqlite3 .sortie.db "SELECT review_metadata FROM run_history WHERE review_metadata IS NOT NULL ORDER BY started_at DESC LIMIT 1" | python3 -m json.tool
```

---

## GET /api/v1/state — System state

Returns a full runtime snapshot: running sessions, retry queue, aggregate totals, and rate limits.

```sh
curl http://localhost:8080/api/v1/state
```

### Response

```json
{
  "generated_at": "2026-03-26T14:30:00Z",
  "counts": {
    "running": 2,
    "retrying": 1
  },
  "running": [
    {
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "state": "In Progress",
      "session_id": "session-abc-001",
      "turn_count": 7,
      "last_event": "turn_completed",
      "last_message": "",
      "started_at": "2026-03-26T14:10:12Z",
      "last_event_at": "2026-03-26T14:29:59Z",
      "workspace_path": "/tmp/sortie_workspaces/MT-649",
      "tokens": {
        "input_tokens": 12500,
        "output_tokens": 3200,
        "total_tokens": 15700,
        "cache_read_tokens": 8400
      },
      "model_name": "claude-sonnet-4-20250514",
      "api_request_count": 12,
      "requests_by_model": {
        "claude-sonnet-4-20250514": 12
      },
      "tool_time_percent": 34.7,
      "api_time_percent": 51.2,
      "self_review_active": true,
      "self_review_iteration": 2
    }
  ],
  "retrying": [
    {
      "issue_id": "def456",
      "issue_identifier": "MT-650",
      "attempt": 3,
      "due_at": "2026-03-26T14:35:00Z",
      "error": "agent exited with code 1"
    }
  ],
  "agent_totals": {
    "input_tokens": 45000,
    "output_tokens": 18200,
    "total_tokens": 63200,
    "cache_read_tokens": 31500,
    "seconds_running": 2847.3
  },
  "rate_limits": {}
}
```

### Field notes

**`running[]` entries:**

| Field | Description |
|---|---|
| `tokens` | Nested object with `input_tokens`, `output_tokens`, `total_tokens`, and `cache_read_tokens` for this session. |
| `workspace_path` | Absolute filesystem path to the issue's workspace directory. |
| `model_name` | LLM model in use. Omitted when unknown. |
| `api_request_count` | Total API requests made by the agent in this session. |
| `requests_by_model` | Breakdown of API requests per model. Omitted when empty. |
| `tool_time_percent` | Percentage of elapsed wall-clock time spent in tool execution. `null` when not yet computed. |
| `api_time_percent` | Percentage of elapsed wall-clock time spent waiting on API calls. `null` when not yet computed. |
| `self_review_active` | `true` when the worker is in the self-review phase. Omitted when `false`. |
| `self_review_iteration` | Current review iteration (1-based). Omitted when `0`. See [self-review configuration](/guides/configure-self-review/). |

**`agent_totals`:** Cumulative across all sessions since Sortie started. `seconds_running` includes elapsed time from currently active sessions, not only completed ones.

**`rate_limits`:** Reserved for future use. Currently an empty object.

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Snapshot returned. |
| `503 Service Unavailable` | Orchestrator state snapshot could not be produced. |

---

## GET /api/v1/{identifier} — Issue detail

Returns issue-specific runtime and debug details. The `{identifier}` path parameter is the issue identifier (e.g., `MT-649`), not the internal issue ID.

```sh
curl http://localhost:8080/api/v1/MT-649
```

### Response (running issue)

```json
{
  "issue_identifier": "MT-649",
  "issue_id": "abc123",
  "status": "running",
  "workspace": {
    "path": "/tmp/sortie_workspaces/MT-649"
  },
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": {
    "issue_id": "abc123",
    "issue_identifier": "MT-649",
    "state": "In Progress",
    "session_id": "session-abc-001",
    "turn_count": 7,
    "last_event": "turn_completed",
    "last_message": "Working on tests",
    "started_at": "2026-03-26T14:10:12Z",
    "last_event_at": "2026-03-26T14:29:59Z",
    "workspace_path": "/tmp/sortie_workspaces/MT-649",
    "tokens": {
      "input_tokens": 12500,
      "output_tokens": 3200,
      "total_tokens": 15700,
      "cache_read_tokens": 8400
    },
    "model_name": "claude-sonnet-4-20250514",
    "api_request_count": 12,
    "requests_by_model": {
      "claude-sonnet-4-20250514": 12
    },
    "tool_time_percent": 34.7,
    "api_time_percent": 51.2,
    "self_review_active": true,
    "self_review_iteration": 2
  },
  "retry": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Response (retrying issue)

When an issue is in the retry queue rather than actively running, `status` is `"retrying"`, `running` is `null`, and `retry` is populated:

```json
{
  "issue_identifier": "MT-650",
  "issue_id": "def456",
  "status": "retrying",
  "workspace": null,
  "attempts": {
    "restart_count": 2,
    "current_retry_attempt": 3
  },
  "running": null,
  "retry": {
    "issue_id": "def456",
    "issue_identifier": "MT-650",
    "attempt": 3,
    "due_at": "2026-03-26T14:35:00Z",
    "error": "agent exited with code 1"
  },
  "recent_events": [],
  "last_error": "agent exited with code 1",
  "tracked": {}
}
```

### Field notes

| Field | Description |
|---|---|
| `status` | One of `"running"` or `"retrying"`. Derived from which queue the issue appears in. |
| `workspace` | Contains `path` when the issue has an active workspace. `null` for retrying issues or when the workspace path is unknown. |
| `attempts.restart_count` | How many times this issue has been restarted (attempt minus one, floored at zero). |
| `attempts.current_retry_attempt` | The current attempt number. `0` for running issues that haven't retried. |
| `running` | Full running entry (same shape as entries in `/api/v1/state`), or `null`. |
| `retry` | Full retry entry, or `null`. |
| `recent_events` | Reserved for future use. Currently an empty array. |
| `last_error` | Most recent error message from the retry queue, or `null`. |
| `tracked` | Reserved for future use. Currently an empty object. |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Issue found and returned. |
| `404 Not Found` | Identifier not present in any active queue. The issue may have completed, or it may not exist. |
| `503 Service Unavailable` | Orchestrator state snapshot could not be produced. |

---

## POST /api/v1/refresh — Trigger poll cycle

Queues an immediate poll and reconciliation cycle. Useful for CI integrations that push issues and want Sortie to pick them up without waiting for the next poll interval.

```sh
curl -X POST http://localhost:8080/api/v1/refresh
```

### Response (202 Accepted)

```json
{
  "queued": true,
  "coalesced": false,
  "requested_at": "2026-03-26T14:30:05Z",
  "operations": ["poll", "reconcile"]
}
```

`coalesced: true` means a refresh was already pending when your request arrived. The request was not lost — it merged with the existing pending signal. You don't need to retry.

### Response (409 Conflict — draining)

If Sortie is shutting down, the refresh is rejected:

```json
{
  "queued": false,
  "coalesced": false,
  "requested_at": "2026-03-26T14:30:05Z",
  "operations": []
}
```

### Status codes

| Code | Meaning |
|---|---|
| `202 Accepted` | Refresh queued (or coalesced with a pending refresh). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Server is draining; refresh rejected. |

---

## GET /livez — Liveness probe

Lightweight liveness check for container orchestrators. Returns `200` when the process is alive, `503` when draining.

```sh
curl http://localhost:8080/livez
```

### Response (200 OK)

```json
{
  "status": "pass"
}
```

### Response (503 — draining)

```json
{
  "status": "fail"
}
```

---

## GET /readyz — Readiness probe

Deep readiness check that validates database connectivity, preflight configuration, and workflow loading. Use this for Kubernetes readiness probes or load balancer health checks.

```sh
curl http://localhost:8080/readyz
```

### Response (200 OK)

```json
{
  "status": "pass",
  "version": "0.5.0",
  "uptime_seconds": 3742.8,
  "checks": {
    "database": "pass",
    "preflight": "pass",
    "workflow": "pass"
  }
}
```

### Response (503 — one or more checks failed)

```json
{
  "status": "fail",
  "version": "0.5.0",
  "uptime_seconds": 3742.8,
  "checks": {
    "database": "pass",
    "preflight": "fail",
    "workflow": "pass"
  }
}
```

Each check is independent. `status` is `"pass"` only when every individual check passes.

| Check | What it validates |
|---|---|
| `database` | SQLite database is accessible and responds to a ping. |
| `preflight` | Dispatch preflight validation is passing (agent binary exists, workspace root is writable, etc.). |
| `workflow` | Workflow file has been successfully loaded at least once. |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | All checks pass. |
| `503 Service Unavailable` | One or more checks failed, or server is draining. |

---

## GET /metrics — Prometheus metrics

Standard Prometheus text exposition format. Available on the same port as all other endpoints when the HTTP server is enabled.

```sh
curl http://localhost:8080/metrics
```

Returns `text/plain` with Prometheus metric families. For the full metric catalog — names, labels, types, PromQL examples, and cardinality model — see [Prometheus metrics reference](/reference/prometheus-metrics/).

---

## Error envelope

All JSON API errors use a consistent structure:

```json
{
  "error": {
    "code": "issue_not_found",
    "message": "issue identifier \"XYZ-999\" not found in current state"
  }
}
```

### Error codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `issue_not_found` | 404 | The requested issue identifier is not in any active queue. |
| `snapshot_unavailable` | 503 | The orchestrator could not produce a state snapshot. |
| `method_not_allowed` | 405 | The HTTP method is not supported on this endpoint. |
| `internal_error` | 500 | Unexpected server error (e.g., JSON serialization failure). |

## Method enforcement

Every endpoint enforces its allowed HTTP method. Sending the wrong method returns `405 Method Not Allowed` with an `Allow` header indicating the correct method, and a JSON error envelope — not plain text.

```sh
curl -X DELETE http://localhost:8080/api/v1/state
```

```json
{
  "error": {
    "code": "method_not_allowed",
    "message": "method DELETE is not allowed on this endpoint"
  }
}
```

The response includes the header `Allow: GET` (or `Allow: POST` for the refresh endpoint).

## Endpoint summary

| Method | Path | Description | Content-Type |
|---|---|---|---|
| GET | `/` | HTML dashboard | `text/html` |
| GET | `/livez` | Liveness probe | `application/json` |
| GET | `/readyz` | Readiness probe | `application/json` |
| GET | `/api/v1/state` | Full system state snapshot | `application/json` |
| GET | `/api/v1/{identifier}` | Per-issue detail | `application/json` |
| POST | `/api/v1/refresh` | Trigger immediate poll cycle | `application/json` |
| GET | `/metrics` | Prometheus metrics | `text/plain` |
