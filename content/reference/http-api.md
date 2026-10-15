---
title: "HTTP API"
description: "Complete reference for Sortie's embedded HTTP server: JSON API endpoints, request/response shapes, error codes, and curl examples."
author: Sortie AI
date: 2026-04-13
weight: 40
url: /reference/http-api/
---
Sortie embeds an HTTP server that exposes a JSON API, a stream of change signals, an HTML dashboard, health probes, and Prometheus metrics, all on a single port.

## Server configuration

The HTTP server starts by default on `127.0.0.1:7678` with no flags required.

**Override the port**: pass `--port <N>` when launching Sortie:

```sh
sortie --port 9090 WORKFLOW.md
```

**Override the bind address**: pass `--host <ADDR>` for container deployments:

```sh
sortie --host 0.0.0.0 WORKFLOW.md
```

**Workflow config**: set `server.port` and `server.host` in the WORKFLOW.md front matter extensions:

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

The HTTP server is not started in [`--dry-run`](/reference/cli/#--dry-run) mode. Changing the port or host requires a restart: there is no hot-rebind.

For the full `server` extension schema, see [WORKFLOW.md configuration reference](/reference/workflow-config/). For Prometheus metric definitions, see [Prometheus metrics reference](/reference/prometheus-metrics/).

---

## GET /: HTML dashboard

Server-rendered HTML page showing real-time system state. Auto-refreshes in the browser.

```sh
curl http://localhost:7678/
```

The dashboard displays running sessions (identifier, state, turn count, duration, last event, tokens), the retry queue (identifier, attempt, due-in, error), summary cards (running count, retrying count, available slots, total tokens), uptime, version, aggregate runtime and token totals, and a run history table of completed sessions.

Returns `text/html`. This is not a JSON endpoint.

### Run history entries

The run history table lists recently completed sessions. [`GET /api/v1/runs`](#get-apiv1runs-run-history) serves the same runs with more fields. Each entry contains:

| Field | Type | Description |
|---|---|---|
| `identifier` | string | Tracker-assigned issue identifier (e.g., `"PROJ-123"`). |
| `display_id` | string | Qualified form of `identifier` for trackers where the identifier alone is ambiguous, such as `"owner/repo#9"`. The dashboard shows it in place of `identifier` when set. Empty when `identifier` is already display-ready. |
| `attempt` | integer | One-based retry attempt number. |
| `status` | string | Terminal outcome: `"succeeded"`, `"failed"`, `"cancelled"`, `"ci_failed"`, `"needs_person"`, or `"budget_stopped"`. `"budget_stopped"` is a session the per-issue token ceiling cancelled while it was still running; `error` then carries the token figures behind the stop. |
| `workflow_file` | string | Path to the workflow definition used for this run. |
| `started_at` | string | Formatted start timestamp. |
| `completed_at` | string | Formatted completion timestamp. |
| `error` | string or null | Error message when the run did not succeed. `null` when `status` is `"succeeded"`. |
| `turns_completed` | integer | Number of agent turns completed before exit. |
| `rule_name` | string | [Dispatch rule](/reference/workflow-config/#dispatch) that routed the run. Empty when none did. |
| `chain_id` | string | [Stage chain](/reference/workflow-config/#stage-chains) the run belongs to. Empty for a run recorded before stage chains existed. |
| `stage_previous` | string | Rule whose [stage hop](/reference/state-machine/#stage-hop) led to the run. Empty when no hop did. |
| `stage_target` | string | Rule the run's own hop decision targeted. Empty when the run's exit reached no hop decision. |
| `stage_result` | string | Result of that hop decision: `"advanced"`, `"partial"`, `"failed"`, or `"ceiling"`. Empty when `stage_target` is. |

#### Model and effort of a completed run

Each completed run also stores the settings it ran with, in three text columns of `run_history`: `configured_model` and `configured_effort` (what the attempt was asked to run) and `reported_model` (what the runtime reported running). [Configured and reported model](#configured-and-reported-model) explains how to read the pair. The dashboard table does not show these columns. [`GET /api/v1/runs`](#get-apiv1runs-run-history) serves them as `configured_model`, `configured_effort`, and `model_name`, each omitted when empty:

```sh
curl -s 'http://localhost:7678/api/v1/runs?limit=5' | jq '.runs[] | {issue_identifier, configured_model, configured_effort, model_name}'
```

The columns can also be read from the database directly:

```sh
sqlite3 .sortie.db "SELECT identifier, configured_model, configured_effort, reported_model FROM run_history ORDER BY started_at DESC LIMIT 5"
```

An unset value is an empty string, not `NULL`. All three columns are empty on runs recorded before Sortie stored them and on `ci_failed` rows. [`sortie stats`](/reference/cli/#configured-model-breakdown) aggregates the configured model; it does not read `reported_model` or `configured_effort`.

---

## GET /api/v1/state: System state

Returns a full runtime snapshot: running sessions, retry queue, budget-exhausted and parked issues, pending pull request reactions, issues between stages, one entry per active issue in a stable order, the list of what needs a person, aggregate totals, rate limits, the workflow configuration in effect, the health of Sortie's own checks, the Sortie version, and the time the process started.

```sh
curl http://localhost:7678/api/v1/state
```

### Response

```json
{
  "generated_at": "2026-03-26T14:30:00Z",
  "version": "1.19.0",
  "started_at": "2026-03-26T13:28:10Z",
  "counts": {
    "running": 1,
    "retrying": 1,
    "budget_exhausted": 1,
    "parked": 1,
    "pending_reactions": 2,
    "between_stages": 1,
    "attention": 4
  },
  "running": [
    {
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "issue_title": "Fix the flaky login test",
      "issue_url": "https://tracker.example.com/browse/MT-649",
      "issue_labels": ["bug", "backend"],
      "issue_type": "Bug",
      "state": "In Progress",
      "session_id": "session-abc-001",
      "turn_count": 7,
      "self_review_active": false,
      "self_review_iteration": 0,
      "last_event": "turn_completed",
      "last_message": "",
      "started_at": "2026-03-26T14:10:12Z",
      "dispatched_at": "2026-03-26T13:41:08Z",
      "last_event_at": "2026-03-26T14:29:59Z",
      "workspace_path": "/tmp/sortie_workspaces/MT-649",
      "tokens": {
        "input_tokens": 12500,
        "output_tokens": 3200,
        "total_tokens": 15700,
        "cache_read_tokens": 8400,
        "cache_write_tokens": 1200
      },
      "model_name": "<model-id-reported-by-the-agent>",
      "rule_name": "bugfix",
      "stage_lineage": null,
      "stage_position": null,
      "configured_model": "claude-sonnet-4-5",
      "configured_effort": "medium",
      "workflow_file": "WORKFLOW.md",
      "agent_kind": "claude-code",
      "api_request_count": 12,
      "requests_by_model": {
        "<model-id-reported-by-the-agent>": 12
      },
      "tool_time_percent": 34.7,
      "api_time_percent": 51.2,
      "tokens_measured": true,
      "usage_arrival": "incremental",
      "usage_attribution": "per_model",
      "tokens_pending": false,
      "tokens_awaited": false,
      "api_requests_measured": true,
      "used_sessions": 2,
      "budget_sessions": 5,
      "issue_tokens_completed": 105000,
      "unmeasured_sessions": 0,
      "used_tokens": 120700,
      "used_tokens_complete": true,
      "budget_tokens": 500000,
      "estimated_cost_usd": 0.06372,
      "cost_status": "estimated",
      "issue_estimated_cost_usd": 0.49872,
      "issue_cost_status": "estimated",
      "status_text": "Turn 7",
      "status_text_full": "MT-649 is running, turn 7."
    }
  ],
  "retrying": [
    {
      "issue_id": "def456",
      "issue_identifier": "MT-650",
      "issue_title": "Retry the export job",
      "issue_url": "https://tracker.example.com/browse/MT-650",
      "issue_type": "Task",
      "issue_labels": ["export"],
      "state": "In Progress",
      "dispatched_at": "2026-03-26T14:02:41Z",
      "attempt": 3,
      "due_at": "2026-03-26T14:35:00Z",
      "error": "no available orchestrator slots",
      "trigger": "timer",
      "rule_name": "implement",
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "stage_lineage": {
        "chain_id": "7q2m4x9b1k5d8f3h6j0n2p4rst",
        "previous": "specify",
        "previous_outcome": "succeeded"
      },
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "paused": false,
      "status_text": "Retry 3 in 5m: no agent slot was free",
      "status_text_full": "MT-650's retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m."
    }
  ],
  "budget_exhausted": [
    {
      "issue_id": "ghi789",
      "issue_identifier": "MT-651",
      "issue_title": "Migrate the billing tables",
      "issue_url": "https://tracker.example.com/browse/MT-651",
      "issue_type": "Task",
      "issue_labels": [],
      "state": "In Progress",
      "dispatched_at": "2026-03-26T13:31:07Z",
      "reason": "session_budget",
      "used_sessions": 3,
      "budget_sessions": 3,
      "used_tokens": null,
      "budget_tokens": null,
      "unmeasured_sessions": null,
      "stopped_in_flight": null,
      "exhausted_at": "2026-03-26T14:12:00Z",
      "stage_lineage": null,
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "Held: session budget reached",
      "status_text_full": "MT-651 is held at its session budget of 3. Sessions used: 3."
    }
  ],
  "parked": [
    {
      "issue_id": "jkl012",
      "issue_identifier": "MT-652",
      "issue_title": "Rotate the signing keys",
      "issue_url": "https://tracker.example.com/browse/MT-652",
      "issue_type": "Task",
      "issue_labels": ["security"],
      "state": "In Progress",
      "dispatched_at": "2026-03-26T13:41:20Z",
      "reason": "agent_blocked",
      "parked_state": "In Progress",
      "label": "needs-human",
      "label_applied": true,
      "parked_at": "2026-03-26T14:05:00Z",
      "rule_name": "bugfix",
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "Parked: the agent needs a person",
      "status_text_full": "MT-652 is parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`."
    }
  ],
  "pending_reactions": [
    {
      "issue_id": "mno345",
      "issue_identifier": "MT-653",
      "issue_title": "Add the export button",
      "issue_url": "https://tracker.example.com/browse/MT-653",
      "issue_type": "Story",
      "issue_labels": ["export"],
      "state": "In Review",
      "kind": "ci",
      "config_key": "ci_failure",
      "pull_request": {
        "number": 931,
        "repository": "acme/web",
        "url": "https://github.com/acme/web/pull/931",
        "branch": "sortie/MT-653",
        "head_sha": "4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b"
      },
      "created_at": "2026-03-26T14:09:30Z",
      "dispatched_at": "2026-03-26T13:58:03Z",
      "next_poll_at": "2026-03-26T14:31:40Z",
      "wait": "poll_interval",
      "used_attempts": 2,
      "max_attempts": 2,
      "escalated_at": "2026-03-26T14:26:40Z",
      "escalation_trigger": "budget_exhausted",
      "watch_ends_at": null,
      "last_check": {
        "observed_at": "2026-03-26T14:26:40Z",
        "head_sha": "9b7e3d1c0a2f4e6b8d0c1a3e5f7b9d2c4e6a8f0b",
        "status": "failing",
        "failing_checks": ["Test"],
        "failing": 1,
        "pending": 0,
        "passing": 4
      },
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "CI escalated on #931",
      "status_text_full": "MT-653: Sortie escalated failing CI on PR #931; it keeps watching the pull request. CI fixes used: 2 of 2."
    },
    {
      "issue_id": "mno345",
      "issue_identifier": "MT-653",
      "issue_title": "Add the export button",
      "issue_url": "https://tracker.example.com/browse/MT-653",
      "issue_type": "Story",
      "issue_labels": ["export"],
      "state": "In Review",
      "kind": "review",
      "config_key": "review_comments",
      "pull_request": {
        "number": 931,
        "repository": "acme/web",
        "url": "https://github.com/acme/web/pull/931",
        "branch": "sortie/MT-653",
        "head_sha": "4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b"
      },
      "created_at": "2026-03-26T14:09:30Z",
      "dispatched_at": "2026-03-26T13:58:03Z",
      "next_poll_at": "2026-03-26T14:30:55Z",
      "wait": "debounce",
      "used_attempts": 1,
      "max_attempts": 3,
      "escalated_at": null,
      "watch_ends_at": "2026-03-26T14:39:30Z",
      "last_check": {
        "observed_at": "2026-03-26T14:29:58Z",
        "actionable_comments": 3,
        "new_comments": 1
      },
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "1 new review comment on #931; next check in 55s",
      "status_text_full": "MT-653 has 1 new review comment on PR #931 (3 actionable) and waits for the comments to settle; next check in 55s. Review fix runs used: 1 of 3."
    }
  ],
  "between_stages": [
    {
      "issue_id": "stu901",
      "issue_identifier": "MT-655",
      "issue_title": "Plan the export schema",
      "issue_url": "https://tracker.example.com/browse/MT-655",
      "issue_type": "Story",
      "issue_labels": ["export", "stage-implement"],
      "state": "In Progress",
      "source_rule": "specify",
      "target_rule": "implement",
      "target_label": "stage-implement",
      "hopped_at": "2026-03-26T14:28:15Z",
      "dispatched_at": "2026-03-26T14:03:41Z",
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "Between stages: specify to implement",
      "status_text_full": "MT-655 moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue."
    }
  ],
  "active": [
    {
      "issue_id": "ghi789",
      "issue_identifier": "MT-651",
      "issue_title": "Migrate the billing tables",
      "issue_url": "https://tracker.example.com/browse/MT-651",
      "status": "budget_exhausted",
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "dispatched_at": "2026-03-26T13:31:07Z",
      "status_text": "Held: session budget reached",
      "status_text_full": "MT-651 is held at its session budget of 3. Sessions used: 3."
    },
    {
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "issue_title": "Fix the flaky login test",
      "issue_url": "https://tracker.example.com/browse/MT-649",
      "status": "running",
      "rule_name": "bugfix",
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "dispatched_at": "2026-03-26T13:41:08Z",
      "status_text": "Turn 7",
      "status_text_full": "MT-649 is running, turn 7."
    },
    {
      "issue_id": "jkl012",
      "issue_identifier": "MT-652",
      "issue_title": "Rotate the signing keys",
      "issue_url": "https://tracker.example.com/browse/MT-652",
      "status": "parked",
      "rule_name": "bugfix",
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "dispatched_at": "2026-03-26T13:41:20Z",
      "status_text": "Parked: the agent needs a person",
      "status_text_full": "MT-652 is parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`."
    },
    {
      "issue_id": "mno345",
      "issue_identifier": "MT-653",
      "issue_title": "Add the export button",
      "issue_url": "https://tracker.example.com/browse/MT-653",
      "status": "pending_reactions",
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "reaction_kind": "ci",
      "dispatched_at": "2026-03-26T13:58:03Z",
      "status_text": "CI escalated on #931",
      "status_text_full": "MT-653: Sortie escalated failing CI on PR #931; it keeps watching the pull request. CI fixes used: 2 of 2."
    },
    {
      "issue_id": "def456",
      "issue_identifier": "MT-650",
      "issue_title": "Retry the export job",
      "issue_url": "https://tracker.example.com/browse/MT-650",
      "status": "retrying",
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "dispatched_at": "2026-03-26T14:02:41Z",
      "status_text": "Retry 3 in 5m: no agent slot was free",
      "status_text_full": "MT-650's retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m."
    },
    {
      "issue_id": "stu901",
      "issue_identifier": "MT-655",
      "issue_title": "Plan the export schema",
      "issue_url": "https://tracker.example.com/browse/MT-655",
      "status": "between_stages",
      "rule_name": "implement",
      "stage_position": {
        "chain": ["specify", "implement"],
        "current": "implement",
        "hop_count": 1,
        "hop_ceiling": 10
      },
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "dispatched_at": "2026-03-26T14:03:41Z",
      "status_text": "Between stages: specify to implement",
      "status_text_full": "MT-655 moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue."
    }
  ],
  "attention": [
    {
      "id": "436a04996ce8317d45cdb082d7ee656a",
      "kind": "workflow_reload_failed",
      "severity": "critical",
      "since": "2026-03-26T14:29:41Z",
      "acknowledged_at": null,
      "reason_text": "WORKFLOW.md failed to load",
      "why_text": "WORKFLOW.md failed to load (config: agent.turn_timeout_ms: must be greater than 0), so poll ticks dispatch nothing until it loads, and the configuration that last loaded stays in effect.",
      "clears_text": "Clears when WORKFLOW.md loads again, which Sortie tries each time the file is saved and on every poll tick.",
      "action": {"kind": "acknowledge"},
      "evidence": {
        "file": "WORKFLOW.md",
        "error": "config: agent.turn_timeout_ms: must be greater than 0"
      }
    },
    {
      "id": "9ee206201099385b431c9bb01911553f",
      "kind": "parked",
      "severity": "warning",
      "since": "2026-03-26T14:05:00Z",
      "acknowledged_at": null,
      "issue_id": "jkl012",
      "issue_identifier": "MT-652",
      "issue_title": "Rotate the signing keys",
      "issue_url": "https://tracker.example.com/browse/MT-652",
      "reason_text": "Parked: the agent needs a person",
      "why_text": "The agent stopped because it cannot go on without a person, so Sortie parked MT-652 under the label `needs-human`.",
      "clears_text": "Clears when a poll tick finds `needs-human` removed from MT-652, or MT-652 moved out of In Progress.",
      "action": {"kind": "open_issue", "url": "https://tracker.example.com/browse/MT-652"},
      "evidence": {
        "reason": "agent_blocked",
        "label": "needs-human"
      }
    },
    {
      "id": "464f9ff8ea54c4c6cfb43af394234d57",
      "kind": "budget_held",
      "severity": "warning",
      "since": "2026-03-26T14:12:00Z",
      "acknowledged_at": null,
      "issue_id": "ghi789",
      "issue_identifier": "MT-651",
      "issue_title": "Migrate the billing tables",
      "issue_url": "https://tracker.example.com/browse/MT-651",
      "reason_text": "Session budget reached",
      "why_text": "MT-651 has used 3 sessions of its budget of 3.",
      "clears_text": "Clears on the next poll tick after `agent.max_sessions` is raised above 3 or is removed, or after MT-651 leaves the active tracker states.",
      "action": {"kind": "acknowledge"},
      "evidence": {
        "reason": "session_budget",
        "used_sessions": 3,
        "budget_sessions": 3
      }
    },
    {
      "id": "cf5210ceffa49562e16b5c7c7a9aeb36",
      "kind": "reaction_escalated",
      "severity": "warning",
      "since": "2026-03-26T14:26:40Z",
      "acknowledged_at": null,
      "issue_id": "mno345",
      "issue_identifier": "MT-653",
      "issue_title": "Add the export button",
      "issue_url": "https://tracker.example.com/browse/MT-653",
      "reason_text": "CI escalated on #931",
      "why_text": "Sortie escalated failing CI on PR #931 after 2 of 2 CI fixes; the latest check found Test failing.",
      "clears_text": "Clears when a check of PR #931 passes, a new commit lands on it, it merges or closes, `reactions.ci_failure.max_retries` rises above 2, or MT-653 reaches a terminal tracker state or leaves In Review.",
      "action": {"kind": "open_pull_request", "url": "https://github.com/acme/web/pull/931"},
      "evidence": {
        "reaction_kind": "ci",
        "config_key": "ci_failure",
        "pull_request": {
          "number": 931,
          "repository": "acme/web",
          "url": "https://github.com/acme/web/pull/931",
          "branch": "sortie/MT-653",
          "head_sha": "4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b"
        },
        "escalation_trigger": "budget_exhausted",
        "used_attempts": 2,
        "max_attempts": 2,
        "last_check": {
          "observed_at": "2026-03-26T14:26:40Z",
          "head_sha": "9b7e3d1c0a2f4e6b8d0c1a3e5f7b9d2c4e6a8f0b",
          "status": "failing",
          "failing_checks": ["Test"],
          "failing": 1,
          "pending": 0,
          "passing": 4
        }
      }
    }
  ],
  "agent_totals": {
    "input_tokens": 45000,
    "output_tokens": 18200,
    "total_tokens": 63200,
    "cache_read_tokens": 31500,
    "cache_write_tokens": 4800,
    "seconds_running": 2847.3,
    "unmeasured_sessions": 3,
    "running_unreported": 0,
    "running_non_reporting": 0
  },
  "rate_limits": {},
  "active_estimated_cost_usd": 0.06372,
  "cost_unpriced_running": 0,
  "config": {
    "tracker": {
      "kind": "jira",
      "active_states": ["To Do", "In Progress"],
      "in_progress_state": "In Progress",
      "handoff_state": "In Review",
      "terminal_states": ["Done"]
    },
    "polling": {
      "interval_ms": 30000
    },
    "agent": {
      "kind": "claude-code",
      "usage_arrival": "incremental",
      "max_turns": 20,
      "stall_timeout_ms": 300000,
      "max_retry_backoff_ms": 300000,
      "max_sessions": 5,
      "max_tokens": 500000,
      "max_concurrent_agents": 4,
      "max_concurrent_agents_by_state": {}
    },
    "worker": {
      "ssh_hosts": [],
      "max_concurrent_agents_per_host": null
    },
    "dispatch": {
      "rules": [
        {
          "name": "specify",
          "selected_by": "match",
          "match": {"issue_type": ["Story"]},
          "next": "implement",
          "agent_kind": "claude-code",
          "usage_arrival": "incremental"
        },
        {
          "name": "implement",
          "selected_by": "stage",
          "stage": "stage-implement",
          "agent_kind": "claude-code",
          "usage_arrival": "incremental"
        },
        {
          "name": "bugfix",
          "selected_by": "match",
          "match": {"labels": ["bug"], "priority": {"op": "lte", "value": 2}},
          "agent_kind": "claude-code",
          "usage_arrival": "incremental"
        }
      ],
      "default": null,
      "chains": [["specify", "implement"]],
      "max_consecutive_hops": null,
      "hop_ceiling": 10
    },
    "reactions": {
      "ci_failure": {
        "max_retries": 2,
        "triage": false,
        "escalation": "label",
        "escalation_label": "needs-human"
      },
      "review_comments": {
        "max_continuation_turns": 3,
        "debounce_ms": 60000,
        "poll_interval_ms": 120000,
        "triage": false,
        "escalation": "label",
        "escalation_label": "needs-human"
      },
      "bot_review": {
        "max_continuation_turns": 5,
        "poll_interval_ms": 60000,
        "bot_usernames": ["review-bot"],
        "triage": false,
        "escalation": "none"
      },
      "merge_conflicts": {
        "max_retries": 1,
        "poll_interval_ms": 60000,
        "triage": false,
        "escalation": "label",
        "escalation_label": "needs-human"
      },
      "auto_merge": {
        "strategy": "squash",
        "require_ci": true,
        "delete_branch": true,
        "poll_interval_ms": 60000,
        "max_retries": null,
        "escalation": "label",
        "escalation_label": "needs-human"
      }
    },
    "token_rates": {
      "claude-code": {
        "input_per_mtok": 3,
        "output_per_mtok": 15,
        "cache_read_per_mtok": 0.3,
        "cache_write_per_mtok": null,
        "complete": true
      },
      "codex": {
        "input_per_mtok": 2.5,
        "output_per_mtok": null,
        "cache_read_per_mtok": null,
        "cache_write_per_mtok": null,
        "complete": false
      }
    }
  },
  "health": {
    "database": {"status": "pass", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:58Z", "consecutive_failures": 0, "failing_since": null},
    "preflight": {"status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 1, "failing_since": "2026-03-26T14:29:58Z", "error": "dispatch preflight failed: workflow file cannot be loaded: config: agent.turn_timeout_ms: must be greater than 0"},
    "workflow": {"file": "WORKFLOW.md", "status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 2, "failing_since": "2026-03-26T14:29:41Z", "error": "config: agent.turn_timeout_ms: must be greater than 0"},
    "poll": {"status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 1, "failing_since": "2026-03-26T14:29:58Z", "outcome": "preflight_failed", "next_poll_at": "2026-03-26T14:30:28Z"},
    "scm": {"provider": "github", "status": "pass", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:58Z", "consecutive_failures": 0, "failing_since": null}
  }
}
```

### Field notes

**`running[]` entries:**

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title` | The tracker's title of the issue, as read when the session was dispatched and unchanged for the whole run. Omitted when the tracker returned none. |
| `issue_url` | The tracker's web link to the issue, as read at dispatch. Omitted when the tracker returned none. |
| `issue_labels` | The issue's labels as read at dispatch, lowercase and in the tracker's order. Always present; `[]` when the issue has none. |
| `issue_type` | The tracker's issue type, as read at dispatch. Omitted when the tracker returned none. |
| `state` | The tracker state of the issue as Sortie last read it for the session. |
| `ssh_host` | The [SSH host](/reference/workflow-config/#worker) the session runs on. Omitted for a session that runs on the machine running Sortie. |
| `workflow_file` | Base filename of the `WORKFLOW.md` in force at dispatch. Omitted when unset. |
| `agent_kind` | The agent kind the session runs, from the configuration in force at dispatch. Omitted when unset. |
| `reaction_kind` | Present when the session continues a pull request [reaction](/reference/reactions/): `ci`, `review`, `bot-review`, `merge-conflict`, `label-review`, or `label-fix`. A session that continues none carries none of `reaction_kind`, `reaction_config_key`, `reaction_attempt`, and `pull_request`. |
| `reaction_config_key` | Present exactly when `reaction_kind` is. The `reactions` key in `WORKFLOW.md` that configures the kind, by the mapping of the `retrying[]` entries' `reaction_config_key`. |
| `reaction_attempt` | Which try of its reaction the session is, counted as `used_attempts` counts it on a pending reaction row. Present for `ci`, `review`, `bot-review`, and `merge-conflict`. Omitted for `label-review` and `label-fix`, which count nothing. |
| `pull_request` | Present exactly when `reaction_kind` is. An object with `number` and `repository` (`owner/repo`, masked), named as in a pending reaction's `pull_request`. |
| `self_review_active` | `true` while the session is in its self-review phase. |
| `self_review_iteration` | Self-review iterations completed in the current phase: `0` while the first one runs, and whenever `self_review_active` is `false`. |
| `turn_count` | Number of turns this session has run: the coding turns plus any review and fix turns from self-review. Advances by one the instant a turn starts, the same way for every agent kind, and resets to `0` at the start of each attempt. [`agent.max_turns`](/reference/workflow-config/#agent) caps only the coding turns, so this figure can run higher once self-review is active. |
| `tokens` | Nested object with `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, and `cache_write_tokens` for this session. `total_tokens` is `input_tokens + output_tokens`; both cache counters are disjoint subsets of `input_tokens`, never additions to it. Each member is an integer or `null`, and all five are `null` together exactly when `tokens_measured` is `false`. |
| `tokens_measured` | `false` until the coding agent reports token usage for this session, including before the first turn begins; that is what makes the members of `tokens` `null` rather than `0`. `true` once any usage figure has been reported. Stays `false` for the life of a session whose `usage_arrival` is `"none"`, whatever its runtime sends. |
| `workspace_path` | Absolute filesystem path to the issue's workspace directory. |
| `model_name` | LLM model the runtime reported running. Omitted when unknown, and when `usage_arrival` is `"none"`. It can differ from `configured_model`; see [configured and reported model](#configured-and-reported-model). |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) that routed this session. Omitted when no rule routed it. |
| `dispatched_at` | When Sortie dispatched the first run of the issue's current pass, in UTC. Always present and never `null` on a running row. A retry, a reaction continuation, the next stage of a hop, and a restart continue the pass, so the value stays fixed across them. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `stage_lineage` | Always present. `null` unless a [stage hop](/reference/state-machine/#stage-hop) reached the run, under the rule of the `retrying[]` entries. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `configured_model` | The `model` this attempt's resolved settings carry, the model Sortie asked the agent to run. Omitted when none is configured, which leaves the choice to the runtime's own default. |
| `configured_effort` | The `effort` this attempt's resolved settings carry. Omitted when none is configured. |
| `api_request_count` | Count of LLM API requests, one per `token_usage` event received during this session. Integer or `null`, and `null` exactly when `api_requests_measured` is `false`. |
| `requests_by_model` | Breakdown of API requests per model. Omitted when `api_requests_measured` is `false`, when `usage_attribution` is anything other than `"per_model"`, or when the breakdown is empty. |
| `tool_time_percent` | Percentage of elapsed wall-clock time spent in tool execution. `null` when not yet computed. |
| `api_time_percent` | Percentage of elapsed wall-clock time spent waiting on API calls. `null` when not yet computed. |
| `usage_arrival` | When this session's token figures arrive, frozen at dispatch from the agent kind, its configuration, and whether the session runs over SSH. `"incremental"` (one figure per LLM API request, while the turn is still running), `"turn_end"` (at most one figure per turn, after the turn's work is over), `"none"` (no figure is ever produced), or `""` when the kind declares nothing. |
| `usage_attribution` | What this session's token figures attribute to, frozen alongside `usage_arrival`. `"per_model"` (a figure names the model that produced it), `"session_total"` (figures are session-level totals with no model), `"none"` (there is no figure to attribute), or `""` when the kind declares nothing. |
| `tokens_awaited` | `true` only when the session has recorded no token figure and the moment its `usage_arrival` names for one has not passed. A session whose `usage_arrival` reports figures and whose `tokens_awaited` is `false` has recorded nothing and will record nothing. |
| `tokens_pending` | `true` only when `usage_arrival` is `"turn_end"`, `tokens_measured` is `true`, and the turn whose figure is still to settle has not ended. The counts in `tokens` then exclude the turn in progress rather than being final. |
| `api_requests_measured` | `true` exactly when `api_request_count` is non-null. It requires `usage_arrival` to be `"incremental"`, and then either a figure already counted or no turn yet begun. A `"turn_end"` session is never measured, because its counter settles at most once per turn rather than once per request; an `"incremental"` session with nothing counted is not measured either once its first turn has begun, whatever its agent kind declares. |
| `used_sessions` | Integer or `null`. The issue's completed sessions: the run-history count that [`agent.max_sessions`](/reference/workflow-config/#agent) is compared with. The running session is not counted, and a recorded CI result counts as a session, except that rechecking a head that already escalated records none. `null` when no read of the issue's run history has succeeded for this run. |
| `budget_sessions` | Integer or `null`. `agent.max_sessions` as of the latest poll tick. `null` when `agent.max_sessions` is `0`, never `0`. Dispatch stops once the completed count reaches this value, and `used_sessions` leaves out the running session, so the issue can still be dispatched `budget_sessions` minus `used_sessions` minus `1` more times after the running session ends. Undefined when either key is `null`. |
| `unmeasured_sessions` | Integer or `null`. Completed sessions whose token usage was never recorded, which `issue_tokens_completed` and `used_tokens` leave out. `null` exactly when `used_sessions` is. |
| `issue_tokens_completed` | Integer or `null`. The summed `total_tokens` of the issue's completed sessions. `null` when no read of the run history has succeeded, and when the sum is `0` while a completed session is unmeasured or recorded a turn no figure covered. |
| `used_tokens` | Integer or `null`. `issue_tokens_completed` plus this row's `tokens.total_tokens`, each counted as `0` when `null`. This is the sum [`agent.max_tokens`](/reference/workflow-config/#agent) is compared with, and it advances with each usage figure of the session. `null` when the sum is `0` and `used_tokens_complete` is `false`, so unknown spend never reads as zero. |
| `used_tokens_complete` | Boolean. `true` exactly when `used_tokens` is the issue's whole spend: the completed sessions were read, none is unmeasured, none recorded a turn no figure covered, this session is measured, and it has recorded no such turn. When `false`, `used_tokens` is a lower bound. It ignores `tokens_pending`, which separately marks the turn in progress as not yet counted. |
| `budget_tokens` | Integer or `null`. `agent.max_tokens` as of the latest poll tick. `null` when `agent.max_tokens` is `0`, never `0`. Token headroom: `budget_tokens` minus `used_tokens`, undefined when either is `null`, and negative when the session overshot the ceiling. The API serves no headroom key. |
| `estimated_cost_usd` | Number or `null`. Estimated cost of this session from `tokens` and the [`token_rates`](/reference/workflow-config/#token_rates) entry of `agent_kind`, unrounded. Non-`null` exactly when `cost_status` is `"estimated"`. |
| `cost_status` | String. `"estimated"` (a zero rate also gives this); `"unpriced"` when the session is measured and `token_rates` holds no entry with both `input_per_mtok` and `output_per_mtok` for `agent_kind`, an absent `token_rates` included; `"unmeasured"` when `tokens_measured` is `false`. |
| `issue_estimated_cost_usd` | Number or `null`. Estimated cost of the whole issue: the sum of the estimates of its priced parts, completed sessions and this one alike, at the rates Sortie started with. Unrounded. Non-`null` exactly when `issue_cost_status` is `"estimated"` or `"partial"`. |
| `issue_cost_status` | String. `"estimated"` when the estimate covers the issue's whole spend, which requires `used_tokens_complete` to be `true`. `"partial"` when it is a lower bound because a part that spent tokens is left out. `"unpriced"` when no priced part spent tokens and a part that did has no rate. `"unmeasured"` when `used_tokens` is `null`, and when no part is priced or unpriced. A session measured at zero tokens leaves nothing out, so a missing rate for its kind does not make an otherwise complete issue `"partial"`. |

The issue-level keys are always present on a running row. A limit key (`budget_tokens`, `budget_sessions`) set to `null` means no limit is configured. A usage key (`used_sessions`, `unmeasured_sessions`, `issue_tokens_completed`, `used_tokens`) set to `null` means unknown. The [`cost_budget` tool](/reference/agent-extensions/#cost_budget) reports figures under some of the same names to the agent; there a limit that is not configured reads `0`.

The same row on a session that has measured nothing, showing only the fields that differ:

```json
{
  "tokens": {
    "input_tokens": null,
    "output_tokens": null,
    "total_tokens": null,
    "cache_read_tokens": null,
    "cache_write_tokens": null
  },
  "api_request_count": null,
  "tokens_measured": false,
  "api_requests_measured": false,
  "used_tokens_complete": false,
  "estimated_cost_usd": null,
  "cost_status": "unmeasured"
}
```

`model_name` and `requests_by_model` are absent from that row rather than empty. A `null` figure is the absence of a measurement, not a measurement of zero: a consumer aggregating figures across rows must skip a `null` rather than add it as `0`.

A session that continues a CI fix adds these keys, and a session that continues no reaction has none of them:

```json
{
  "reaction_kind": "ci",
  "reaction_config_key": "ci_failure",
  "reaction_attempt": 1,
  "pull_request": {"number": 936, "repository": "acme/web"}
}
```

#### Configured and reported model

A running row carries two answers to "which model is this?". `configured_model` and `configured_effort` are what the attempt was asked to run. Sortie resolves them when the attempt starts: the agent kind's top-level block with the matching dispatch rule's block laid over it.

They stay fixed for the session, and the next attempt of the same issue resolves them again from the workflow in force at that moment, so a retry after an edit to `WORKFLOW.md` can show different values. `model_name` is what the runtime reported running, taken from its token usage events.

Nothing compares the two, and a reported model never replaces a configured one. They differ legitimately: a routing alias in `configured_model` resolves to a dated model name in `model_name`, and a runtime can fall back to another model when the configured one is unavailable. A mismatch is therefore not a fault by itself. Read `model_name` as what ran and `configured_model` as what the workflow asked for. The cost and quality of the work belong to the model that ran.

The dashboard shows the same values as **Configured model**, **Configured effort**, and **Reported model**. Completed runs keep all three; see [run history entries](#run-history-entries).

`issue_title`, `issue_url`, `issue_labels`, `issue_type`, and `state` pass through the same masking as the logs: a value Sortie knows to be a secret reads `[redacted]`. A Jira link carries no user name or password written into `tracker.endpoint`.

**`retrying[]` entries:**

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title` | The tracker's title of the issue. Omitted when empty, which on a retry means Sortie has not fetched the issue's title since the retry was restored. Masked like the running row's. |
| `issue_url` | The tracker's web link to the issue, under the same rule as `issue_title`. |
| `issue_type` | The tracker's issue type. Omitted when empty or unread. Masked like the running row's. |
| `issue_labels` | The issue's labels, lowercase and in the tracker's order. `[]` when the issue was read and carries none. Omitted while the retry holds no read of its labels, so an unread issue never reads as one without labels. Masked like the running row's. |
| `state` | The tracker state of the issue. Omitted when empty or unread. Masked like the running row's. |
| `dispatched_at` | When Sortie dispatched the first run of the pass the retry continues, in UTC. Always present; `null` when the pass cannot be dated. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `trigger` | The `sortie_retries_total` label of the schedule that created the retry: `error`, `continuation`, `timer`, `stall`, or `ci_fix`. See the [metrics reference](/reference/prometheus-metrics/#counters). Omitted for a review, bot review, merge conflict, or label command continuation, which `reaction_kind` names instead, and for a retry restored from a row stored by an earlier release until it next comes due. |
| `reaction_kind` | The reaction behind the retry: `ci`, `review`, `bot-review`, `merge`, `merge-conflict`, `label-review`, `label-fix`, or `merge-completion`. Omitted when the retry carries none. An `error` or `stall` retry of a run that a reaction dispatched carries that run's kind, and a `timer` row keeps the kind of the retry it replaced. |
| `reaction_config_key` | The key under [`reactions`](/reference/reactions/) in `WORKFLOW.md` that configures `reaction_kind`: `ci_failure`, `review_comments`, `bot_review`, `auto_merge`, `merge_conflicts`, `label_commands` (for both `label-review` and `label-fix`), or `merge_completion`. Omitted whenever `reaction_kind` is. |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) of the run the retry follows, frozen with the retry. Omitted when no rule routed that run. If the configuration in force no longer reaches that rule when the retry fires, the retry dispatches on another one. |
| `agent_kind` | The agent kind of the run the retry follows. Omitted when empty. |
| `configured_model` | The `model` that run's resolved settings carried. Omitted when none was set. |
| `stage_lineage` | Always present. `null` unless a [stage hop](/reference/state-machine/#stage-hop) reached the run the retry follows. Otherwise an object with `previous` (the rule whose hop reached the run), `previous_outcome` (`succeeded` or `no_change`), and `chain_id` (the [stage chain](/reference/workflow-config/#stage-chains) the run belongs to). Each member is omitted when empty. Running and budget-exhausted entries serve the key under the same rule. |
| `stage_position` | Always present. Where `rule_name` stands on its stage chain, or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `paused` | Always present. `true` when the retry was last put back because its issue's state does not permit dispatching it, which is when `error` is `reaction retry paused by an open blocking issue` or `reaction retry paused by issue state`. |

When a retry comes due and cannot start, Sortie puts it back with `trigger` set to `timer` and `error` set to the reason from the table below. The error of the run before it is not kept on the row; it stays in the logs and in that run's run history. A retry that has not yet come due still carries the error of the run that scheduled it.

| `error` after a reschedule | Meaning | Attempt |
|---|---|---|
| `worker still running` | The issue's previous run has not finished stopping. | Unchanged |
| `issue without a state label` | The tracker read of the issue returned no state. The first such reading waits; a second consecutive one releases the retry. | Unchanged |
| `retry issue fetch failed` | The tracker read of the issue failed. | Advances |
| `reaction retry paused by an open blocking issue` | Another issue that is not yet in a terminal state blocks this one, so its reaction retry waits. | Advances |
| `reaction retry paused by issue state` | The issue is in a state that is neither active nor the handoff state, so its reaction retry waits. | Advances |
| `no available orchestrator slots` | No concurrency slot is free for the issue's state. | Advances |
| `no available SSH hosts` | Every SSH host is at its session limit. | Advances |
| `retry agent kind unavailable` | The adapter for the retry's agent kind failed to start. | Advances |
| `retry agent settings refused` | The agent settings in force for the retry fail an error-severity check. | Advances |

A retry that is rescheduled this way and advances its attempt waits the backoff delay of the new attempt number, per the [backoff formula](/reference/state-machine/#backoff-formula). A reaction retry that stays paused is eventually dropped; see the retry timer row of the [transition triggers](/reference/state-machine/#transition-triggers).

A retry keeps the title, link, type, labels, and state it was scheduled with. Sortie stores them with the retry and restores them at startup, so a restart serves what was served before it. A retry stored by an earlier release has none of them until the next poll whose candidates include its issue, or until the retry next fires. A read never replaces a title or link the retry already holds. The retry stores `configured_model` and `dispatched_at` the same way.

**`budget_exhausted[]` entries:** Issues held out of dispatch by a per-issue budget ceiling ([`agent.max_sessions`](/reference/workflow-config/#agent) or [`agent.max_tokens`](/reference/workflow-config/#agent)).

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read by the poll that last rebuilt the held set, or by the retry the hold was found on until the next poll. Each omitted when empty. Masked like the running row's. |
| `issue_type`, `issue_labels`, `state` | The issue's type, labels, and tracker state from the same read, under the rules of the `retrying[]` entries. Masked like the running row's. |
| `reason` | `session_budget` or `token_budget`: which ceiling stopped dispatch. |
| `used_sessions`, `budget_sessions` | Completed sessions for the issue against the configured `agent.max_sessions`. `budget_sessions` is `null` when no session budget is set, as on a `running[]` entry. |
| `used_tokens`, `budget_tokens` | Measured cumulative tokens against the configured `agent.max_tokens`. `budget_tokens` is `null` when no token ceiling is set, as on a `running[]` entry. `used_tokens` is `null` only on a `session_budget` entry, in two cases: the token ceiling has not been evaluated for the issue (`agent.max_tokens` is `0`, or reading the issue's token spend failed), or the sum is `0` while a session reported no token usage or a turn went unaccounted for, so that `0` would stand for spend Sortie does not know. A non-zero sum is served as is and can still be a lower bound. |
| `unmeasured_sessions` | Count of the issue's sessions whose agent reported no token usage. `null` when the issue's token spend was not read. |
| `stopped_in_flight` | Count of the issue's sessions that the token ceiling stopped while they were running, recorded with status `budget_stopped`. `null` when the issue's token spend was not read. |
| `exhausted_at` | When the hold began. |
| `rule_name`, `agent_kind`, `configured_model` | The dispatch rule, agent kind, and model of the dispatch the hold blocks. Each omitted when empty. |
| `stage_lineage`, `stage_position` | Always present. The lineage and chain position of the blocked dispatch, under the rules of the `retrying[]` entries and [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `dispatched_at` | When the first run of the blocked dispatch's pass was dispatched, in UTC. Always present; `null` when the hold has no dispatch context or its pass cannot be dated. |

A hold found on a retry carries the retry's dispatch context, and a later poll keeps it. A hold the poll finds first takes its context from the target rule of a stage hop still waiting for its next dispatch, resolved from the configuration in force, and otherwise from the issue's latest agent run in run history, never from the tracker.

A hold without a context is one for an issue with no agent run, or one whose run history read failed; it reads `null` for `dispatched_at`, `stage_lineage`, and `stage_position` and omits the other three keys until a later poll reads again.

**`parked[]` entries:** Issues held out of dispatch until a person acts on them. The list is always present, `[]` when no issue is parked, and sorted by `issue_identifier`, then `issue_id`. `counts.parked` equals its length. An issue appears in every list that holds it, so a parked issue that also has a reaction continuation queued is in `parked` and `retrying` both. For how a park is recorded and lifted, see [agent communication](/concepts/agent-communication/).

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read when the park was recorded. A park recorded or restored without a read takes one at the first poll tick on which the tracker answers for the issue, and a read already held is never replaced. Each omitted when empty. Masked like the running row's. |
| `reason` | `agent_blocked` (the agent reported itself blocked) or `handoff_absence` (the consecutive handoff-absence ceiling was reached). |
| `issue_type` | The tracker's issue type, as read for the park. Omitted when empty or unread. Masked like the running row's. |
| `issue_labels` | The issue's labels as read for the park, lowercase and in the tracker's order, without the parking label itself. `[]` when the issue was read and carries no other label. Omitted while the park holds no read of the labels. Masked like the running row's. |
| `state` | The tracker state observed at the park. Always equal to `parked_state`, and omitted with it. |
| `parked_state` | The tracker state observed when the park was recorded, or at the first observation after a park recorded before any read. Omitted while unobserved. Masked. |
| `dispatched_at` | When Sortie dispatched the first run of the pass of the run the park follows, in UTC. It is when Sortie picked the issue up, never when the park was recorded; `parked_at` is that. Always present; `null` when the park follows no run or the pass cannot be dated. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) of the run the park follows. Omitted when no rule routed that run, and when the park follows no run. |
| `agent_kind` | The agent kind of the run the park follows. Omitted when the park follows no run. |
| `configured_model` | The `model` that run's resolved settings carried. Omitted when none was set, and when the park follows no run. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain or the park follows no run. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `label` | The parking label Sortie applied. |
| `label_applied` | `true` once a read showed the label on the issue. |
| `parked_at` | When the park was recorded, as an RFC 3339 timestamp in UTC. |

The run a park follows is the run whose exit or retry led to the park. When a poll tick parks an issue for reaching the handoff-absence ceiling, it is the issue's newest agent run. If Sortie cannot read that run, the issue is parked anyway and serves no run: `dispatched_at` and `stage_position` are `null`, and `rule_name`, `agent_kind`, and `configured_model` are omitted until the park is released.

Sortie stores the run, the issue type, and the labels with the park and restores them at startup, so a restart serves what was served before it.

A park stored by an earlier release takes its run from the issue's newest agent run that started at or before the park, when Sortie upgrades its database, and has no type or labels until a poll whose candidates include its issue supplies them. That poll makes no extra tracker call. For a park that already holds a title or link, it adds the type and labels and changes nothing else.

**`pending_reactions[]` entries:** Pull request [reactions](/reference/reactions/) that Sortie keeps watching after a run hands off, one row per issue and reaction kind. The list is always present, `[]` when no reaction is pending, and sorted by `issue_identifier`, then `issue_id`, then `kind`. `counts.pending_reactions` equals its length. An issue appears in every list that holds it, so an issue with a CI fix queued and a review check pending is in `retrying` and `pending_reactions` both. [`active`](#field-notes) lists each such issue once.

Pending reactions live in memory, except for a standing escalation, which Sortie stores. After a restart Sortie rebuilds the rows from run history and from the stored escalations, and a rebuilt row has no `wait` or `last_check`, no pull request `url` until a check reads one, and a `created_at` of the restart. A row with a standing escalation keeps its `escalated_at`, `escalation_trigger`, and `used_attempts`. It also holds the title and link only, with no `issue_type`, `issue_labels`, or `state`, because run history records none of them. Its `dispatched_at`, `rule_name`, `agent_kind`, and `configured_model` come from the run history row.

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read by the run that created the reaction, or as restored from run history after a restart. Each omitted when empty. Masked like the running row's. |
| `issue_type`, `issue_labels` | The issue's type and labels, as the run that created the reaction read them. Omitted when empty or unread; `issue_labels` is `[]` when the issue was read and carries none. Masked like the running row's. |
| `state` | The tracker state the reaction records. When the run's exit transitioned the issue, it is the state Sortie wrote, `tracker.handoff_state` or, for a run that declared no change, `tracker.no_change_state`, not the active state the agent read. After any other exit it is the state the run read. Omitted when empty or unread. Masked like the running row's. |
| `kind` | `ci`, `review`, `bot-review`, `merge`, `merge-conflict`, `label-review`, `label-fix`, or `merge-completion`. |
| `config_key` | The `reactions` key in `WORKFLOW.md` that configures the kind: `ci_failure`, `review_comments`, `bot_review`, `auto_merge`, `merge_conflicts`, `label_commands` (for both `label-review` and `label-fix`), or `merge_completion`. The kind's settings are at `config.reactions[config_key]` while the reaction is applied. |
| `pull_request` | The pull request the reaction watches. Always present; keys below. |
| `created_at` | When this process created the reaction, at the worker exit that seeded it or at the startup that rebuilt it, as an RFC 3339 timestamp in UTC. A wait for the retry slot does not change it. |
| `dispatched_at` | When Sortie dispatched the first run of the pass of the run the reaction follows, in UTC. Always present; `null` when the pass cannot be dated. After a restart it comes from the run history row the reaction is rebuilt from. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `next_poll_at` | When the next check is due, in UTC. The check runs on the first reconcile pass at or after it, so a value at or before `generated_at` means the next pass checks the reaction. |
| `wait` | Why the reaction waits for that check; see the table below. Omitted until a pass first returns the reaction to the pending set, because a reaction no pass has taken is due at once. |
| `used_attempts` | Integer or `null`. What the kind counts; see the table below. `null` for `label-review` and `label-fix`, which count nothing. |
| `max_attempts` | Integer or `null`. The budget the kind's pass applies, as of the latest poll tick. `null` when the pass applies none: for `label-review` and `label-fix`, and for `merge` when `max_retries` is `0`. |
| `escalated_at` | String or `null`. When the standing escalation of the reaction began, in UTC. Always present; `null` while none stands. Every kind that escalates stays pending while its escalation stands, and serves the time the escalation began, which a recheck does not move. The escalation survives a restart. What ends it depends on the kind; see [standing escalations](/reference/reactions/#standing-escalations). When `config.reactions[config_key].escalation` is `"label"`, the label an escalation applies is that block's `escalation_label`. |
| `escalation_trigger` | String or absent. Present exactly while `escalated_at` is non-null. Why the escalation began: `budget_exhausted` (the kind used up its tries), `triage` (the kind's triage command asked for a person), `refused` (the forge or the tracker answered a write with an authentication or payload error; on `merge` and `merge-completion`), or `missing_merge_commit` (the forge reports the pull request merged but gives no merge commit after the grace period; on `merge-completion`). |
| `watch_ends_at` | String or `null`. When the reaction stops watching the pull request unless its watch restarts first, in UTC: the kind's `watch_window_ms`, as the process applies it, added to the instant the kind measures the window from. Always present. `ci` measures from when it last recorded a new head commit, or from `created_at` while it has recorded none, so a new head moves the value. `review`, `bot-review`, and `merge-conflict` measure from their latest wait for the retry slot, which restarts the watch, or from `created_at` when they have not waited. `merge` measures from `created_at`. `null` for `merge-completion`, `label-review`, and `label-fix`, which have no watch window, when `watch_window_ms` is `0`, and while an escalation stands, because no window ages out a standing escalation. |
| `last_check` | Object or `null`. What the latest completed check observed; keys below. Always present. `null` before the first check completes, and always `null` for `merge`, `merge-completion`, `label-review`, and `label-fix`. A new result replaces the previous one. For `ci` it is cleared when the head changes. |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) of the run the reaction follows. Omitted when no rule routed that run. |
| `agent_kind` | The agent kind of the run the reaction follows. Omitted when empty. |
| `configured_model` | The `model` that run's resolved settings carried. Omitted when none was set. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |

`pull_request` keys:

| Field | Description |
|---|---|
| `number` | The pull request number. |
| `repository` | `owner/repo`, as the pull request record the run left in its workspace holds them. Masked. |
| `url` | The pull request's web page as the provider reported it on the latest read. Omitted until a read reports one. Masked. |
| `branch` | The head branch that record holds. Omitted for `label-review` and `merge-completion`, which keep none. Masked. |
| `head_sha` | The head commit that record holds. Omitted when none was recorded, and for `label-review`, `label-fix`, and `merge-completion`. Masked. A later push does not change it; `last_check.head_sha` reports the head a check read. |

`last_check` keys. The object is flat, and its members follow the kind:

| Field | Kinds | Description |
|---|---|---|
| `observed_at` | every kind that records a check | When the check completed, in UTC. |
| `head_sha` | `ci`, `merge-conflict` | The head commit the check read. Omitted when the provider reported none. Masked. |
| `status` | `ci` | The verdict the reaction acted on: `passing`, `pending`, or `failing`. |
| `failing_checks` | `ci` | Names of the check runs the verdict counts as failing, in the provider's order. `[]` when none. Masked. |
| `failing`, `pending`, `passing` | `ci` | The check runs by outcome. |
| `actionable_comments` | `review`, `bot-review` | The comments the check found actionable: not outdated and, for `review`, not authored by an account in `reactions.bot_review.bot_usernames`. A comment a run was already given counts until the forge reports it outdated. |
| `new_comments` | `review`, `bot-review` | Those of `actionable_comments` the reaction acts on next: no run was given them, the reaction has not already reported them, and the running turn does not carry them. |
| `mergeable` | `merge-conflict` | `false` when the provider reports merge conflicts, `true` when it reports none, `null` while the provider has not computed mergeability. A branch-protection block is not a conflict. |

`wait` values, set by the pass that last returned the reaction to the pending set:

| `wait` | Meaning |
|---|---|
| `poll_interval` | The check completed and the reaction keeps watching, because there was nothing to act on yet or it has already acted for this subject. The next check follows the kind's poll cadence. |
| `debounce` | `review` only. The check found actionable comments within `debounce_ms` of the newest one. `next_poll_at` ends the window. |
| `backoff` | The check could not complete: a provider, tracker, or store call failed, or the provider answered without a value the check needs. The reaction retries with backoff. |
| `retry_slot` | The pass found work to dispatch while another retry holds the issue's retry slot. For `merge-completion`, the issue is claimed. For `label-review` and `label-fix`, also while a session of another kind runs for the issue: the confirmed command waits for it to end. |
| `triage` | The reaction waits on its [triage command](/reference/reactions/#triage-command): a run for the current subject is in flight or was just started. |

`used_attempts` and `max_attempts` by kind:

| `kind` | `used_attempts` counts | `max_attempts` |
|---|---|---|
| `ci` | CI-fix continuations dispatched since a passing verdict, or a head change that Sortie establishes is not its own work, last reset the count. | `reactions.ci_failure.max_retries` |
| `review` | Review-fix continuations dispatched. | `reactions.review_comments.max_continuation_turns` |
| `bot-review` | Bot-review-fix continuations dispatched. | `reactions.bot_review.max_continuation_turns` |
| `merge-conflict` | Rebase continuations dispatched in the current conflict episode. | `reactions.merge_conflicts.max_retries` |
| `merge` | Merge calls made. | `reactions.auto_merge.max_retries`, `null` at `0` |
| `merge-completion` | Tracker transitions that failed. | `reactions.merge_completion.max_retries` |
| `label-review`, `label-fix` | `null` | `null` |

**`between_stages[]` entries:** Issues that a [stage hop](/reference/state-machine/#stage-hop) moved to their next stage and that no run has picked up yet. The list is always present, `[]` when no issue is between stages, and sorted by `issue_identifier`, then `issue_id`. `counts.between_stages` equals its length.

An issue joins the list when its hop is made. It leaves when a run of the issue is dispatched, whichever way, or when a reset of the issue's hop count drops the hop.

An issue with a running session or a queued retry is never listed, so no issue is in `between_stages` and in `running` or `retrying` at once; an issue is in every other list that holds it.

The hop is stored in the database with its type, labels, and state, so a restart serves the rows it served before. A hop stored by an earlier release serves none of the three until its next stage is dispatched.

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read by the run that made the hop. Each omitted when empty. Masked like the running row's. |
| `issue_type`, `state` | The issue's type and tracker state, as the run that made the hop read them. Each omitted when empty or unread. Masked like the running row's. |
| `issue_labels` | The issue's labels as the hop leaves them: the hopping run's read without the stage labels the hop removed, and with `target_label` added. Omitted while the hop holds no read of the labels. Masked like the running row's. |
| `source_rule` | The rule whose run made the hop. |
| `target_rule` | The rule the hop targeted. |
| `target_label` | The stage label the hop added to the issue. |
| `hopped_at` | When the hop was made, in UTC. |
| `dispatched_at` | When Sortie dispatched the first run of the pass of the run that made the hop, in UTC. The next stage's run continues that pass. Always present; `null` when the pass cannot be dated. |
| `rule_name` | The rule the issue's next run dispatches on, which is `target_rule`. |
| `agent_kind`, `configured_model` | The agent kind and `model` a dispatch of `rule_name` resolves to under the configuration as of the latest poll tick. Each omitted when the configuration no longer names a rule with a stage label under that name, and `configured_model` also when the rule sets none. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |

**`active[]` entries:** Every issue that `running`, `retrying`, `budget_exhausted`, `parked`, `pending_reactions`, or `between_stages` holds, once per issue. A client that shows one line per issue reads this list and merges, chooses, and orders nothing itself. The list is always present, `[]` when no issue is active. The six lists above and `counts` are unchanged, and `counts` has no `active` member: the length of `active` is the number of active issues.

An entry takes its values from the one row that decides the issue's `status`, as that row serves them, so a masked string stays masked. `status` is the name of that list and follows the precedence of [`GET /api/v1/{identifier}`](#get-apiv1identifier-issue-detail): `running`, else `retrying`, else `budget_exhausted`, else `parked`, else `pending_reactions`, else `between_stages`. An entry never reads `history`. For an issue in `pending_reactions` the deciding row is the first row whose `escalated_at` is not `null`, and the first row when none is. A client that needs the rest of the issue's data finds the deciding row by `issue_id` in the list `status` names, and in `pending_reactions` also by `kind` equal to `reaction_kind`.

| Field | Description |
|---|---|
| `issue_id`, `issue_identifier` | The tracker's internal issue ID and the human-readable key. Always present. |
| `display_identifier`, `issue_title`, `issue_url` | The qualified form of the key, the tracker's title, and the tracker's web link. Each omitted when the deciding row holds none. |
| `status` | The list the entry comes from, by the precedence above. Always present. |
| `rule_name`, `agent_kind`, `configured_model` | The dispatch rule, the agent kind, and the configured model of the deciding row. Each omitted when that row holds none. |
| `stage_position` | Always present. `null` when the deciding row serves `null`. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `dispatched_at` | Always present. `null` when the deciding row serves `null`. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `reaction_kind` | The `kind` of the deciding row. Present exactly when `status` is `"pending_reactions"`, and omitted on every other entry. |
| `status_text`, `status_text_full` | The deciding row's [status sentences](#status-sentences), equal to the pair `GET /api/v1/{identifier}` serves for the issue. Always present. |

The entries are ordered by the issue's place, then `issue_identifier`, then `issue_id`, each compared byte by byte. An issue's place is the earliest `dispatched_at` its rows carry when the issue enters the lists. An issue none of whose rows is dated is placed before every dated issue. The place does not change when the issue moves from one list to another, when a new pass begins while the issue is listed, or when a `dispatched_at` of `null` becomes a time. An issue that no list held and that then returns takes a new place. The order can therefore differ from the order of the entries' `dispatched_at` values.

Sortie keeps the places in memory and serves them nowhere. A restart discards them, and each issue then takes its place from the earliest `dispatched_at` of its restored rows. A client that filters the list keeps the served order.

**`attention[]` entries:** Things that need a person. Sortie derives the list on each request from the rows above and the `health` block and stores it nowhere, so an item exists exactly while its cause holds and disappears on the first request after the cause clears. The list is always present, `[]` when nothing needs a person, and `counts.attention` is the number of items whose `acknowledged_at` is `null`. A person can [acknowledge an item](#post-apiv1attentionidacknowledge-acknowledge-an-attention-item) to record that it was seen. The item stays in the list, with `acknowledged_at` set, until its cause clears, and no longer counts. A client that shows the list needs no ordering, wording, or counting rules of its own: the order, the sentences, and the action come with each item.

| Field | Type | Description |
|---|---|---|
| `id` | string | 32 lowercase hexadecimal characters. It stays the same while the cause holds, across requests and across a restart, and a recurrence of the cause gets a new one. Sortie stores an acknowledgement under it, and the acknowledge endpoint takes it in the path. See [item IDs](#attention-item-ids). |
| `kind` | string | What the item is about; see the table below. |
| `severity` | string | `critical` marks a cause under which poll ticks dispatch nothing for any issue. `warning` marks a cause about one issue. The severity belongs to the kind and does not grow with age. |
| `since` | string or `null` | When the cause began, in UTC. `null` only for a park whose stored time cannot be read. |
| `acknowledged_at` | string or `null` | When a person first acknowledged the item, in UTC. `null` while nobody has. Always present. |
| `issue_id`, `issue_identifier` | string | The tracker-internal issue ID and the human-readable key, copied from the source row. Absent on an item about the process. |
| `display_identifier`, `issue_title`, `issue_url` | string | Copied from the source row as that row serves them. Each omitted when empty, and absent on an item about the process. |
| `reason_text` | string | A short phrase that says what needs a person. It ends without a period. |
| `why_text` | string | One sentence that says why it needs a person. |
| `clears_text` | string | One sentence that says what clears the item. |
| `action` | object | The one action a client should offer. `kind` is `open_issue`, `open_pull_request`, or `acknowledge`. `url` is present exactly for `open_issue` (the issue's link) and `open_pull_request` (the pull request's link). `acknowledge` is the action of an item with nothing to open. Any current item can be acknowledged, whatever its `action.kind`. |
| `evidence` | object | The facts behind the item; members below. Always present, and `{}` when the kind carries none. |

`kind` values, with the cause that raises each:

| `kind` | Cause | `since` | `severity` | `action.kind` |
|---|---|---|---|---|
| `parked` | A row of `parked`. | `parked_at`, cut to whole seconds | `warning` | `open_issue`; `acknowledge` when the row has no `issue_url` |
| `budget_held` | A row of `budget_exhausted`. | `exhausted_at` | `warning` | `acknowledge` |
| `reaction_escalated` | A row of `pending_reactions` whose `escalated_at` is non-null, whatever its kind. | `escalated_at` | `warning` | For `merge-completion`: `open_issue`, else `acknowledge`. For every other kind: `open_pull_request`, else `open_issue`, else `acknowledge`. |
| `workflow_reload_failed` | `health.workflow.consecutive_failures` above `0`. | `health.workflow.failing_since` | `critical` | `acknowledge` |
| `preflight_failed` | `health.preflight.consecutive_failures` above `0`, unless the latest failed preflight failed because the workflow file did not load. | `health.preflight.failing_since` | `critical` | `acknowledge` |

A preflight that fails because the workflow file did not load yields no `preflight_failed` item, because the `workflow_reload_failed` item already names the cause. A `preflight_failed` item's `since` is when the preflight began failing, which can be earlier than the item's first appearance when the failing streak began on a workflow load. Both process-wide items are absent from a response that carries no `health` block.

A `reaction_escalated` item for a row rebuilt after a restart carries `open_issue` until a check reads the pull request's link, and then `open_pull_request`.

`evidence` members. A member is present exactly on the kinds named and absent on every other:

| Member | Kind | Value |
|---|---|---|
| `reason` | `parked`, `budget_held` | The row's `reason`: `agent_blocked` or `handoff_absence`; `session_budget` or `token_budget`. |
| `label` | `parked` | The row's `label`. |
| `used_sessions`, `budget_sessions` | `budget_held` with `session_budget` | The row's values. |
| `used_tokens`, `used_tokens_complete`, `budget_tokens` | `budget_held` with `token_budget` | The row's `used_tokens` (omitted when the row's is `null`) and `budget_tokens`. `used_tokens_complete` is `false` exactly when `used_tokens` is a lower bound. |
| `reaction_kind`, `config_key`, `pull_request`, `escalation_trigger` | `reaction_escalated` | The row's `kind`, `config_key`, `pull_request`, and `escalation_trigger`, in the shapes the row serves. |
| `used_attempts`, `max_attempts` | `reaction_escalated` | The row's values, each omitted when `null`. |
| `last_check` | `reaction_escalated` | The row's `last_check`, omitted when `null`. |
| `file` | `workflow_reload_failed` | `health.workflow.file`. |
| `error` | `workflow_reload_failed`, `preflight_failed` | The check's `error`, as `health` serves it. |

`reason_text`, `why_text`, and `clears_text` are English sentences that Sortie takes from the same table of wording as the [status sentences](#status-sentences), one template per park reason, per budget reason, per check, and per kind of escalating reaction. They follow the same rules: each states only a fact Sortie records, is masked like `issue_title`, and carries no cost, clock time, or date. A part that cannot be rendered reads `Status not available`, and the item stays, so the list and its count never drop a cause. The `reason_text` of each kind:

| `kind` | `reason_text` |
|---|---|
| `parked` | `Parked: the agent needs a person` for `agent_blocked`; `Parked: no evidence of work` for `handoff_absence`. |
| `budget_held` | `Token budget reached` for `token_budget`; `Session budget reached` for `session_budget`. |
| `reaction_escalated` | `CI escalated on #<number>`, `Review comments escalated on #<number>`, `Bot review escalated on #<number>`, `Merge conflict escalated on #<number>`, `Auto-merge escalated on #<number>`, or `Merge completion escalated on #<number>`, by reaction kind. |
| `workflow_reload_failed` | `<file> failed to load`. |
| `preflight_failed` | `Dispatch preflight failed`. |

What clears each cause is the source's own rule, and `clears_text` words it. A park lifts when a person removes its label after Sortie has seen it there, or moves the issue to another tracker state. A hold leaves the set when a poll tick finds the issue no longer at a ceiling or among the candidates, for example after the ceiling is raised or removed. A reaction escalation ends on the facts under [standing escalations](/reference/reactions/#standing-escalations). A reload failure ends with the next load that succeeds, and a preflight failure with the next preflight that passes.

Items are ordered by `severity` (`critical` before `warning`), then by `since` (`null` first, then ascending), then by `id` ascending. The order is total, so the same state serves the same list. The `attention` array of the example above holds the failed reload first, because it is `critical`, then the park, the hold, and the CI escalation in the order of their `since`. It holds no `preflight_failed` item, because the preflight error is the load error.

#### Attention item IDs

`id` is the lowercase hexadecimal form of the first 16 bytes of the SHA-256 hash of the JSON array `[kind, part, ...]`, written without whitespace. The parts depend on the kind, with times in UTC:

| `kind` | Parts |
|---|---|
| `parked` | The issue ID; the park time cut to whole seconds in RFC 3339, or `""` when the stored time cannot be read. |
| `budget_held` | The issue ID; the `reason`; the ceiling the reason names as a decimal number, `budget_tokens` for `token_budget` and `budget_sessions` for `session_budget`. |
| `reaction_escalated` | The issue ID; the row's `kind`; `escalated_at` in RFC 3339 with nanoseconds, trailing zeros dropped. |
| `workflow_reload_failed` | `failing_since` in RFC 3339 with nanoseconds, trailing zeros dropped. |
| `preflight_failed` | `failing_since` in RFC 3339 with nanoseconds, trailing zeros dropped. |

A park keeps its `id` and `since` across a restart, because Sortie stores the park at whole-second precision. A hold keeps its `id` across a restart, but its `since` becomes the first poll tick after the restart, because Sortie keeps the moment a hold began in memory only. A reaction escalation keeps its `id` and `since` across a restart, because the restored escalation carries its stored time. A reload or preflight failure cannot span a restart, because startup exits when the first load or the startup preflight fails.

A recurrence changes a part, so an acknowledgement, which Sortie keeps under `id`, never hides a new cause: a new park has a new time, a hold reached again after a raise or under an edited ceiling has a new ceiling, a different budget reason is a new reason, an escalation that ended and began again has a new time, and a failure after a pass has a new `failing_since`.

Sortie stores an acknowledgement, so it survives a restart for as long as the item exists. A poll tick that has read the candidate issues from the tracker deletes the acknowledgement of every item that no longer exists. A tick whose candidate read fails deletes none.

#### Status sentences

Every row of `running`, `retrying`, `budget_exhausted`, `parked`, `pending_reactions`, and `between_stages` carries a pair of sentences that say in plain English what the issue is doing, what it waits on, or how it ended. Every entry of [`active`](#field-notes) carries the pair of its deciding row. The per-issue response of [`GET /api/v1/{identifier}`](#get-apiv1identifier-issue-detail) carries the same pair on its rows and once for the issue, and every [`issue_outcome`](#issue-outcome) carries a pair too.

| Field | Type | Description |
|---|---|---|
| `status_text` | string | The short sentence, for a row or a lane. It ends without a period. |
| `status_text_full` | string | The long sentence, for an issue page. It ends with a period. |

- Both keys are always present and never empty. A sentence that cannot be rendered reads `Status not available`, and Sortie logs the failure.
- Sentences are English and are not translated. A sentence names its issue by `display_identifier` when the row has one, otherwise by `issue_identifier`.
- Sortie renders a sentence on each request from the snapshot, the `config` this response serves, and run history. It stores none.
- A relative time such as `in 55s` is measured from the time the snapshot was generated, which `generated_at` serves on `GET /api/v1/state`. A sentence carries no clock time or date, and no cost.
- A figure Sortie does not have reads as `not measured`, never as `0`, and a token figure that is only a lower bound reads as `at least`.
- A running row names its stage only when its `stage_position` is not `null`.
- A sentence is masked like `issue_title`, so a value Sortie knows to be a secret reads `[redacted]`.
- The sentences are for display. Every field a sentence is built from stays in the response, so a client that needs data reads those fields and does not parse the text.

The examples on this page show the sentences for the values they hold, with a snapshot generated at `2026-03-26T14:30:00Z`.

#### Dispatch time and stage position

`dispatched_at` is on every kind of entry, and always present. It is when Sortie dispatched the first run of the issue's current pass.

A pass is the runs of one issue that share a stage chain identifier: a dispatch that no stage hop reached starts one, and a retry, a reaction continuation, the next stage of a hop, and a restart continue it. The value therefore stays fixed across those events, where a running row's `started_at` is the start of the session in flight.

It is `null` where Sortie cannot date the pass: a retry or hop stored without a stage chain identifier, a pass with no agent run in run history, a park that follows no run, and a budget-exhausted entry with no dispatch context. Rows dispatched in one poll tick can share a value, so `issue_identifier`, then `issue_id`, order them further. The `active` list is ordered by the issue's place, not by this value alone; see [`active[]` entries](#field-notes).

`stage_position` is on every kind of entry, and always present. It is `null` exactly when the entry's rule is on no stage chain, or the entry has no rule, as a park that follows no run has none. Every entry of a workflow without stage chains serves `null`. Otherwise it is an object:

| Field | Description |
|---|---|
| `chain` | The chain's rule names in `next` order, equal to a member of `config.dispatch.chains`. When several chains hold the rule, the first one that lists `stage_lineage.previous` immediately before it, and otherwise the first that holds the rule. Parked and pending-reaction entries carry no `stage_lineage` and use the previous rule of the run they follow; a between-stages entry uses its `source_rule`. |
| `current` | The entry's `rule_name`. A chain's first rule is included, so an issue on a chain's first stage serves a `stage_position` object beside a `null` `stage_lineage`. |
| `hop_count` | The issue's consecutive automatic hops. `0` when the issue has no hop record. |
| `hop_ceiling` | The limit on consecutive hops, as `config.dispatch.hop_ceiling` reports it. |

`chain` and `hop_ceiling` follow the configuration as of the latest poll tick, as a running row's `budget_tokens` does, while `rule_name` and `stage_lineage` stay as they were when the dispatch was selected. After a reload removes the rule from every chain, the entry serves `null` and keeps its `rule_name`.

**`agent_totals`:** Cumulative across all sessions since Sortie's database was created, carried over when Sortie restarts; a session whose coding agent has reported no token usage, running or completed, adds nothing to its five token counts. `seconds_running` includes elapsed time from currently active sessions, not only completed ones. Three further fields disclose, by reason, how many sessions those counts leave out:

| Field | Description |
|---|---|
| `unmeasured_sessions` | Ended sessions whose token usage was never recorded. Persisted, so it survives a restart. An upgrade backfills it from existing run history, but only as far back as Sortie has distinguished a measured run from an unmeasured one; an older run reads as measured and is not counted, even one that actually reported nothing. |
| `running_unreported` | Currently running sessions whose agent kind reports usage, which have reported no figure yet and can still report one. |
| `running_non_reporting` | Currently running sessions that will contribute no figure: `usage_arrival` is `"none"`, or it reports figures and the moment one could have arrived has passed with nothing counted. The two counts partition the running sessions the token totals exclude, so a session moves from `running_unreported` to this one rather than staying in limbo. |

**`active_estimated_cost_usd`:** Estimated total cost across currently running sessions, computed from configured [token rates](/reference/workflow-config/#token_rates) and each running session's agent adapter kind. Sessions whose `tokens_measured` is `false` are excluded. Omitted when no running, measured session matches an entry containing both input and output rates. It equals the sum of `estimated_cost_usd` over the `running[]` entries whose `cost_status` is `"estimated"`. This is a presentation-layer estimate, not provider billing data.

**`cost_unpriced_running`:** Count of running, measured sessions that `active_estimated_cost_usd` leaves out because their agent kind has no `token_rates` entry or its entry lacks `input_per_mtok` or `output_per_mtok`. Present, zero included, whenever `token_rates` holds any agent-kind entry, complete or not; omitted when `token_rates` is absent or empty. When present, it equals the number of `running[]` entries whose `cost_status` is `"unpriced"`. Without `token_rates`, every measured `running[]` entry reads `"unpriced"` while this key is absent.

**`rate_limits`:** Reserved for future use. Currently an empty object.

**`config`:** The workflow configuration in effect, so a client can tell which stages, dispatch rules, and pull request reactions the workflow has without reading `WORKFLOW.md`. Present on this endpoint only; `GET /api/v1/{identifier}` carries no `config`. It holds no credential: no tracker endpoint, API key, or query filter, no agent command, hook, workspace path, or database path, no notification destination, and no agent settings block. The strings it does carry (state names, labels, SSH host names, bot usernames) are served as written.

A member reports the `WORKFLOW.md` key of the same name. The derived members are `selected_by`, `agent_kind`, `usage_arrival`, `chains`, `hop_ceiling`, and `complete`. A setting that imposes no ceiling reads `null`, never `0`. An optional string is omitted when unset, and a list is `[]` when empty.

Most members follow the last successful load of `WORKFLOW.md`; a reload that fails validation leaves the previous values in place. Two groups report what the running process applies instead, because Sortie captures them at startup: every reaction except `ci_failure`, and `token_rates`. Until the next restart, `config` omits a reaction a reload added, keeps listing one a reload removed, and keeps the rates the process started with. See [reactions](/reference/reactions/) and the [`token_rates` reload behavior](/reference/workflow-config/#token_rates).

| Field | Description |
|---|---|
| `tracker.kind` | The tracker adapter kind. |
| `tracker.active_states`, `tracker.terminal_states` | The [`tracker`](/reference/workflow-config/#tracker) lists as written. |
| `tracker.in_progress_state`, `tracker.handoff_state`, `tracker.no_change_state` | The state Sortie writes at dispatch, after a successful run, and after a successful run whose agent declared that nothing needed changing. Each omitted when unset. |
| `polling.interval_ms` | The poll interval in milliseconds. |
| `agent.kind` | The workflow-wide agent kind. It serves every issue that no dispatch rule and no `dispatch.default` selects. |
| `agent.usage_arrival` | When sessions on the workflow-wide agent report token usage: `"incremental"`, `"turn_end"`, `"none"`, or `""` for a kind that declares nothing or is not registered. Resolved as a session resolves it at start, including the effect of SSH hosts; see [usage reporting by agent kind](/reference/workflow-config/#usage-reporting-by-agent-kind). |
| `agent.max_turns` | The most turns a session runs: `agent.max_turns`, or `1` when it is below `1`. |
| `agent.stall_timeout_ms` | Integer, or `null` when stall detection is off. |
| `agent.max_retry_backoff_ms` | The cap on retry backoff in milliseconds. |
| `agent.max_sessions`, `agent.max_tokens` | Integer, or `null` when the key is `0` or negative, which means no session budget or no token ceiling. A running row's `budget_sessions` and `budget_tokens` are the values as of the latest poll tick, so for up to one poll interval after a reload these members can differ from them. |
| `agent.max_concurrent_agents` | The global concurrency cap. |
| `agent.max_concurrent_agents_by_state` | Per-state caps, keyed by lowercase state name, positive values only. `{}` when none. |
| `worker.ssh_hosts` | The configured SSH hosts, each listed once, in the order written. `[]` when sessions run on the machine running Sortie. |
| `worker.max_concurrent_agents_per_host` | The per-host cap when SSH hosts are configured and the cap is positive. `null` otherwise. |
| `dispatch.rules` | The [dispatch rules](/reference/workflow-config/#dispatch) in configuration order, which is the order match rules are tried. A rule selected by its stage label is chosen ahead of them. `[]` when there are none. |
| `dispatch.rules[].name` | The rule's name. Omitted when it has none. |
| `dispatch.rules[].selected_by` | `"stage"` for a rule that carries a `stage` label, `"catch_all"` for a rule without a `match` block, and `"match"` otherwise. |
| `dispatch.rules[].stage` | The stage label as written. Present only when `selected_by` is `"stage"`. |
| `dispatch.rules[].match` | Present only when `selected_by` is `"match"`. Holds each non-empty key of the rule's `match` block: `labels`, `issue_type`, `title`, `identifier`, and `assignee` as lists in the order written, and `priority` as `{"op": "<op>", "value": n}` for `eq`, `lt`, `lte`, `gt`, and `gte`, or `{"op": "in", "values": [...]}` for `in`. |
| `dispatch.rules[].next` | The rule that follows this one in a [stage chain](/reference/workflow-config/#stage-chains). Omitted when the rule has none. |
| `dispatch.rules[].agent_kind` | The agent kind dispatch resolves for the rule. |
| `dispatch.rules[].usage_arrival` | The rule's usage-reporting arrival, resolved like `agent.usage_arrival` with the rule's settings block laid over its kind's block. One kind can report under one rule and report nothing under another. |
| `dispatch.default` | `{"agent_kind", "usage_arrival"}` of the `dispatch.default` block when it names an agent or a template, otherwise `null`. A running or retry row whose `rule_name` is `default` ran on this selection. A row with no `rule_name` ran on the workflow-wide agent. A catch-all rule takes every issue that no stage rule and no earlier match rule takes, so while one is configured neither `dispatch.default` nor the workflow-wide agent selects an issue. |
| `dispatch.chains` | Each stage chain the `next` links form, as rule names in `next` order, in the order of the rules that start them. A chain starts at a rule that carries `next` and that no `next` names, and ends at a rule without `next`. Chains that share a tail list it in each. `[]` when no rule carries `next`. |
| `dispatch.max_consecutive_hops` | The value `dispatch.max_consecutive_hops` is written with, or `null` when the key is absent. |
| `dispatch.hop_ceiling` | The limit on consecutive automatic hops per issue in force: the written `dispatch.max_consecutive_hops`, or the larger of `10` and the hops in the longest chain. Always an integer, `10` in a workflow without chains. |
| `reactions` | A member per reaction kind the process applies, keyed as under [`reactions`](/reference/reactions/) in `WORKFLOW.md`. A kind is present only while the process applies it, and `{}` means it applies none. |
| `reactions.ci_failure` | Present while the CI check runs, which needs both a CI provider and a source control adapter. Holds `max_retries`, `triage`, and the escalation members. |
| `reactions.review_comments` | Holds `max_continuation_turns`, `debounce_ms`, `poll_interval_ms`, `triage`, and the escalation members. |
| `reactions.bot_review` | Holds `max_continuation_turns`, `poll_interval_ms`, `bot_usernames` (`[]` when empty), `triage`, and the escalation members. |
| `reactions.merge_conflicts` | Holds `max_retries`, `poll_interval_ms`, `triage`, and the escalation members. A `max_retries` of `0` escalates on the first detection. |
| `reactions.auto_merge` | Holds `strategy`, `require_ci`, `delete_branch`, `poll_interval_ms`, `max_retries`, and the escalation members. `max_retries` is `null` when configured as `0`, which turns count-based escalation off. |
| `reactions.merge_completion` | Holds `target_state`, `max_retries`, `poll_interval_ms`, and the escalation members. |
| `reactions.label_commands` | Present when the review command or the fix command is configured. Holds `review_label` while the review command is configured, `fix_label` while the fix command is, and the `poll_interval_ms` both share. It has no escalation members. |
| `escalation` | A member of every reaction that escalates: `"label"`, `"comment"`, or `"none"`. A reaction configured without a mode reads `"none"`. |
| `escalation_label` | Present only when `escalation` is `"label"`: the configured label, or `needs-human` when the block names none. |
| `triage` | A member of `ci_failure`, `review_comments`, `bot_review`, and `merge_conflicts`. `true` when the kind runs a [triage command](/reference/reactions/#triage-command) before it dispatches a fix. It reports the block the process started with, for `ci_failure` too. |
| `token_rates` | A member per agent kind, keyed as written in [`token_rates`](/reference/workflow-config/#token_rates), or `null` when `token_rates` is absent or empty. |
| `token_rates.<kind>.input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok` | Number, or `null` when the rate is not set or was rejected as invalid. An unset cache rate prices that token class at the input rate; `config` serves the configured `null`, not the substituted rate. |
| `token_rates.<kind>.complete` | `true` exactly when `input_per_mtok` and `output_per_mtok` are both set, which is the condition for pricing a session of the kind. |

**`version` and `started_at`:** `version` is the Sortie version, the same value `/readyz` serves. `started_at` is when the process started, in UTC, so it and the `uptime_seconds` of `/readyz` count from one instant.

**`health`:** The health of Sortie's own checks, so a client sees a failed reload, a failed preflight, or a failing tracker without reading the log. It holds a member per check: `database`, `preflight`, `workflow`, `poll`, and `scm`. Every check carries the members of the first table, and `workflow`, `poll`, and `scm` add members of their own. A time Sortie does not have is `null`.

| Field | Type | Description |
|---|---|---|
| `status` | string | `fail` exactly when `consecutive_failures` is above `0`, otherwise `pass`. A check that has not run yet reads `pass`. |
| `checked_at` | string or `null` | When the latest run ended, in UTC. `null` until the check has run. |
| `last_success_at` | string or `null` | When a run last passed, in UTC. `null` until one has. |
| `consecutive_failures` | integer | The runs that failed since `last_success_at`, the latest one included. `0` while the check passes. |
| `failing_since` | string or `null` | When the first of those runs ended, in UTC. `null` while the check passes. |
| `error` | string or absent | The latest failure's text. A value registered as a secret reads `[redacted]`, and the workflow file's full path is shortened to its base name. Absent while the check passes. |

| Check | What feeds it | Members of its own |
|---|---|---|
| `database` | A ping of the database, made once per poll tick. | None. |
| `preflight` | The dispatch preflight that each poll tick runs. `error` joins every failure found, after `dispatch preflight failed:`. Warnings neither fail the check nor appear in it. The preflight at startup is not recorded. | None. |
| `workflow` | Every load of the workflow file: the file watcher's, and the reload each poll tick forces before its preflight. `checked_at` is the latest load, successful or not. `last_success_at` is the latest load whose configuration took effect, the one `config` serves. `failing_since` is the first failed load since then, normally the edit that broke the file. | `file`: the base name of the workflow file in effect, for example `WORKFLOW.md`. |
| `poll` | One run per poll tick, whether the timer or `POST /api/v1/refresh` started it. `error` is the text of the latest failed read of candidate issues since the last successful poll. It can be present beside a `preflight_failed` outcome and absent beside a failing status. | `outcome`: `succeeded`, `tracker_failed` when the candidate read returned an error, or `preflight_failed` when the tick ended before the read because preflight failed. Omitted before the first poll. `next_poll_at`: when the poll timer fires next, in UTC, or `null` once shutdown stops it. A refresh does not move it. A value at or before `generated_at` means a poll is due or running. |
| `scm` | The reads Sortie makes of the pull request provider for [reactions](/reference/reactions/): reviews, review comments, the review decision, CI status, mergeability, label events, and the auto-merge token-scope check. It reflects the most recent read across every pull request, so a read that fails for one pull request can be followed by one that passes for another. Writes such as merging or removing a label are not recorded, and neither are reads that shutdown canceled. | `provider`: the provider kind, for example `github`. The whole member is `null` when no reaction uses a source control provider. |

A reload that fails to load changes nothing else: the previous configuration stays in effect and `config` keeps serving it. The tick's `preflight` fails with the load error after `workflow file cannot be loaded:`, and its `poll` ends as `preflight_failed`, so the tick dispatches nothing. `/readyz` keeps reporting `workflow: pass` beside a failing `health.workflow`.

A running, retry, or budget-exhausted row records its `rule_name` and its `stage_lineage.previous`, and a running or retry row its `reaction_config_key`, when the run was dispatched or the row was stored, while `config` follows the rules above. A row can therefore name a rule or reaction that `config` no longer holds: after a reload that renames or removes a rule, after a restart on an edited file for a restored retry, or, for a row whose `rule_name` is `default`, once `dispatch.default` reads `null`. Read such a row from its own fields.

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Snapshot returned. |
| `503 Service Unavailable` | Orchestrator state snapshot could not be produced. |

---

## GET /api/v1/runs: Run history

Returns finished runs from run history, newest first, one page at a time. Each filter narrows the result before the page is cut.

```sh
curl 'http://localhost:7678/api/v1/runs?issue=MT-649&limit=20'
```

### Query parameters

Every parameter is optional. An empty value is the same as an absent one. Filters combine with AND and match exactly, case included.

| Parameter | Value | Selects |
|---|---|---|
| `issue` | An issue identifier | Runs whose `issue_identifier` equals it. |
| `issue_id` | A tracker issue ID | Runs whose `issue_id` equals it. |
| `rule` | A dispatch rule name, or `<none>` | Runs whose `rule_name` equals it. `<none>` selects the runs that record no rule name, which the response serves without `rule_name`. |
| `status` | A run status | Runs whose `status` equals it. The values are those listed under [run history entries](#run-history-entries). |
| `stage` | A dispatch rule name | Runs whose exit reached a stage hop decision that targeted that rule, whatever its result. |
| `since` | An RFC 3339 timestamp | Runs completed at or after it. Any UTC offset is accepted. |
| `until` | An RFC 3339 timestamp | Runs completed before it. When both bounds are given, `since` must be before `until`. |
| `ended_since` | An RFC 3339 timestamp | Runs of issues whose [`issue_outcome`](#issue-outcome) was observed at or after it. Any UTC offset is accepted. |
| `ended_until` | An RFC 3339 timestamp | Runs of issues whose `issue_outcome` was observed before it. When both bounds are given, `ended_since` must be before `ended_until`. |
| `cursor` | A `next_cursor` value | Runs recorded before the run `cursor` names. An integer of at least `1`. |
| `limit` | An integer from `1` to `200` | The page size. Default: `50`. |

An issue with no `issue_outcome` matches neither ending bound, so a request that carries `ended_since` or `ended_until` returns no run of such an issue. The ending bounds select by the issue's ending, not by the run's completion: every run of a matching issue is returned, and the bounds combine with `since` and `until` by AND.

Sortie checks every parameter before it reads anything. A parameter outside this table, a parameter given more than once, and a value outside the ranges above answer `400`, so a misspelled filter never returns unfiltered rows.

### Response

```json
{
  "runs": [
    {
      "run_id": 42,
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "issue_title": "Fix the flaky login test",
      "issue_url": "https://tracker.example.com/browse/MT-649",
      "attempt": 2,
      "status": "succeeded",
      "error": null,
      "rule_name": "implement",
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-20250514",
      "configured_effort": "high",
      "model_name": "claude-sonnet-4-20250514",
      "workflow_file": "WORKFLOW.md",
      "started_at": "2026-03-26T14:10:12Z",
      "completed_at": "2026-03-26T14:31:47Z",
      "dispatched_at": "2026-03-26T13:48:20Z",
      "turns_completed": 9,
      "tokens": {
        "input_tokens": 52000,
        "output_tokens": 9100,
        "total_tokens": 61100,
        "cache_read_tokens": 30000,
        "cache_write_tokens": 4000
      },
      "tokens_measured": true,
      "unaccounted_turns": 0,
      "estimated_cost_usd": 0.1923,
      "cost_status": "estimated",
      "chain_id": "3c8v5n2w7r1t4y6u9i0o8p2asd",
      "stage_previous": "specify",
      "stage_previous_outcome": "succeeded",
      "stage_target": "review",
      "stage_result": "advanced",
      "self_review": {
        "final_verdict": "pass",
        "total_iterations": 2,
        "cap_reached": false
      },
      "origin_recorded": true,
      "trigger": "ci_fix",
      "reaction_kind": "ci",
      "reaction_config_key": "ci_failure",
      "session_id": "session-abc-002",
      "ssh_host": "",
      "issue_outcome": {
        "kind": "merged",
        "observed_at": "2026-03-26T15:02:09Z",
        "merge_path": "auto_merge",
        "pull_request": {"number": 311, "repository": "acme/shop"},
        "status_text": "Merged #311",
        "status_text_full": "MT-649 ended merged: auto-merge merged PR #311."
      }
    }
  ],
  "next_cursor": "42"
}
```

`runs` is `[]` when no run matches.

### Field notes

Runs are ordered by descending `run_id`, which is the order Sortie recorded them. Sortie records a run when it completes, so this is completion order. `next_cursor` is `null` on the last page. Otherwise it is the `run_id` of the page's last run, as a string; pass it back as `cursor` together with the same filters to read the next page. A run recorded between two requests never moves a served run to another page.

**Run fields:**

| Field | Type | Description |
|---|---|---|
| `run_id` | integer | The run's key in run history, and the paging key. |
| `issue_id` | string | The tracker's issue ID. |
| `issue_identifier` | string | The issue identifier the run was recorded under. |
| `display_identifier` | string | The qualified form of the identifier, as in [run history entries](#run-history-entries). Omitted when empty. |
| `issue_title` | string | The issue title recorded with the run. Omitted when empty. Masked. |
| `issue_url` | string | The tracker's web link to the issue. Omitted when empty. Masked. |
| `attempt` | integer | One-based attempt number. |
| `status` | string | Terminal outcome of the run. |
| `error` | string or `null` | The run's error message. `null` when the run recorded none. Masked. |
| `rule_name` | string | The [dispatch rule](/reference/workflow-config/#dispatch) that routed the run. Omitted when none did. |
| `agent_kind` | string | The agent adapter kind that ran the session. Omitted when empty. |
| `configured_model`, `configured_effort` | string | What the run was asked to run, as in [configured and reported model](#configured-and-reported-model). Omitted when unset. |
| `model_name` | string | The model the runtime reported running. Omitted when it reported none. |
| `workflow_file` | string | The workflow file that drove the run. Omitted when empty. |
| `started_at`, `completed_at` | string | Timestamps as recorded. |
| `dispatched_at` | string or `null` | When Sortie dispatched the first run of the pass the run belongs to, as in [dispatch time and stage position](#dispatch-time-and-stage-position). `null` when the pass cannot be dated. |
| `turns_completed` | integer | Agent turns the run completed. |
| `tokens` | object | The five token members of a running row's `tokens`. Each member is `null` when `tokens_measured` is `false`. A measured zero is `0`. |
| `tokens_measured` | boolean | `false` when the agent reported no token usage for the run. |
| `unaccounted_turns` | integer | Turns whose token usage the agent never reported. When non-zero, the figures in `tokens` are lower bounds. |
| `estimated_cost_usd` | number or `null` | Estimated USD cost from `tokens` and the [`token_rates`](/reference/workflow-config/#token_rates) entry of `agent_kind`, unrounded. Non-`null` exactly when `cost_status` is `"estimated"` or `"partial"`. |
| `cost_status` | string | `"unmeasured"` when `tokens_measured` is `false`. `"estimated"` when the run is measured and spent no tokens, or when `token_rates` prices `agent_kind` and the run has no unaccounted turns. `"partial"` when the run is priced and has unaccounted turns, so the estimate is a lower bound. `"unpriced"` when the run spent tokens and `token_rates` has no entry with both `input_per_mtok` and `output_per_mtok` for `agent_kind`. |
| `chain_id` | string | The stage chain the run belongs to. Omitted when empty. |
| `stage_previous`, `stage_previous_outcome` | string | The rule whose hop led to the run, and the outcome of the run that made it. Omitted when empty. |
| `stage_target`, `stage_result` | string | The rule the run's own hop decision targeted, and its result: `"advanced"`, `"partial"`, `"failed"`, or `"ceiling"`. Omitted when the run reached no decision. |
| `self_review` | object or `null` | `null` when the run recorded no self-review or the record cannot be read. Otherwise `final_verdict` (`"none"` when the record holds no verdict; masked), `total_iterations`, and `cap_reached`. The per-iteration audit trail is not served. |
| `origin_recorded` | boolean | `false` for a run recorded before Sortie stored its origin. The five origin members below are then `null`. |
| `trigger` | string or `null` | What started the retry whose fire dispatched the run: `"error"`, `"continuation"`, `"stall"`, or `"ci_fix"`. A CI fix retry reads `"ci_fix"`, and a retry of a run a reaction dispatched keeps that run's `reaction_kind` with its own trigger. `""` for a dispatch from the poll tick, for a retry that a review, bot review, merge conflict, or label command reaction started, and for a recorded CI result. `null` when the retry was queued before Sortie stored what started it. |
| `reaction_kind` | string or `null` | The reaction kind of the retry that dispatched the run, using the values of a retrying entry's `reaction_kind`. `""` when none. |
| `reaction_config_key` | string or `null` | The key of the `reactions` section of `WORKFLOW.md` that `reaction_kind` is configured under. `""` when `reaction_kind` is empty. |
| `session_id` | string or `null` | The agent session the run used. `""` when it started none. Not masked. |
| `ssh_host` | string or `null` | The SSH worker the run executed on. `""` for a local run. |
| `issue_outcome` | object or `null` | How the run's issue ended. The same object on every run of the issue. `null` when Sortie has not seen the issue end. See [Issue outcome](#issue-outcome). |

A `status` of `"ci_failed"` marks a recorded CI result rather than an agent session: it has no `agent_kind`, and each origin member is `""`.

### Issue outcome

`issue_outcome` records how the issue's latest work ended, with the time Sortie observed the ending. It belongs to the issue, not to a run. It is `null` while Sortie has not seen the issue end.

| Member | Type | Description |
|---|---|---|
| `kind` | string | `"handed_off"`: Sortie moved the issue to its handoff state, or to another non-terminal target, for a person to take over. `"merged"`: Sortie observed the issue's pull request merged. `"terminal"`: Sortie read the issue in a terminal tracker state, or moved it to one. |
| `observed_at` | string | When Sortie observed the ending, in UTC. This is the time Sortie saw it, not the time the tracker or forge recorded it. |
| `state` | string | The tracker state the handoff wrote, or the terminal state Sortie read. Present for `"handed_off"` and `"terminal"`. Masked. |
| `merge_path` | string | The [reaction](/reference/reactions/) that observed the merge: `"auto_merge"` or `"merge_completion"`. Present for `"merged"`. |
| `pull_request` | object | The merged pull request: `number` and `repository` (`owner/repo`, masked). Present for `"merged"`. |
| `status_text`, `status_text_full` | string | The [status sentences](#status-sentences) of how the issue ended, worded from the outcome alone. Always present. |

Sortie records the outcome when it observes the ending:

- A handoff transition succeeds. The kind is `"terminal"` when the target state is itself terminal.
- Reconciliation, a retry timer, a handoff verification read, a stage hop check, or the release of a parked issue reads the issue in a terminal state. If the issue holds a pending `auto_merge` or `merge_completion` reaction, Sortie first reads that pull request once and records `"merged"` when the read reports it merged, so a forge that closes the issue on merge does not hide the pull request. A failed read records `"terminal"`.
- `auto_merge` merges the pull request, is told it is already merged, or finds it merged on a read. `merge_completion` reads it merged.

One outcome is kept per issue. A new observation replaces the stored outcome only as follows; otherwise the stored outcome and its `observed_at` stay.

| Stored `kind` | Replaced by a new observation of kind |
|---|---|
| `"handed_off"` | Any kind. |
| `"terminal"` | `"handed_off"` or `"merged"`. |
| `"merged"` | `"handed_off"`. |

A poll tick that dispatches the issue again clears the outcome, so `issue_outcome` describes the latest ending only. A failed write is logged and does not affect the issue.

### Status codes

| Code | Error code | Meaning |
|---|---|---|
| `200 OK` | | Page returned. |
| `400 Bad Request` | `invalid_parameter` | Unknown or repeated parameter, a malformed or out-of-range value, `since` not before `until`, or `ended_since` not before `ended_until`. The message names the parameter and the rule, for example `parameter "limit" must be an integer from 1 to 200`. |
| `405 Method Not Allowed` | `method_not_allowed` | Any method other than `GET`. |
| `503 Service Unavailable` | `history_unavailable` | Run history or the issue outcomes could not be read. |

---

## GET /api/v1/stats: Run statistics

Returns the report that [`sortie stats --format json`](/reference/cli/#stats) prints: run and issue counts, success rate, duration percentiles, token sums, and estimated cost over the runs completed in a range, with breakdowns by outcome, coding agent, dispatch rule, prompt template, configured model, stage chain, retry trigger, and run origin. The route and the command share one aggregation, so for one database and absolute bounds the two bodies differ only in `generated_at`, apart from the pricing difference [described below](#pricing-and-reload).

```sh
curl 'http://localhost:7678/api/v1/stats?since=24h'
```

### Query parameters

Every parameter is optional. An empty value is the same as an absent one, and an absent bound is open, so a request without parameters covers every run on record.

| Parameter | Value | Selects |
|---|---|---|
| `since` | A range bound | Runs completed at or after it. |
| `until` | A range bound | Runs completed before it. When both bounds are given, `since` must be before `until`. |

A range bound is one of:

| Form | Example | Meaning |
|---|---|---|
| RFC 3339 timestamp, any UTC offset | `2026-07-01T00:00:00Z` | That instant. |
| Calendar date | `2026-07-01` | `00:00:00Z` on that date. |
| Positive Go duration | `24h`, `90m` | That long before the instant of the request. |

A timestamp without an offset, a zero or negative duration, a duration in days such as `7d`, and any other text are malformed. These are the values `sortie stats` takes for `--since` and `--until`; the `since` and `until` of [`GET /api/v1/runs`](#get-apiv1runs-run-history) accept RFC 3339 timestamps only.

Sortie checks every parameter before it reads anything, so a malformed request never returns an unbounded report in place of a bounded one.

### Response

The body is compact JSON with the shape of the command's `--format json` output. [Output formats](/reference/cli/#output-formats) in the CLI reference defines every field, including `summary.issues`, `by_trigger`, and `by_origin`. The example is trimmed to the `by_status` and `by_trigger` breakdowns; the other breakdowns have the same shape.

```json
{
  "generated_at": "2026-02-01T09:00:00Z",
  "workflow_path": "/srv/sortie/WORKFLOW.md",
  "db_path": "/srv/sortie/.sortie.db",
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-02-01T00:00:00Z",
  "schema_tier": "full",
  "warnings": [],
  "summary": {
    "runs": 6,
    "issues": 5,
    "succeeded": 3,
    "success_rate": 0.5,
    "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
    "mean_turns_succeeded": 4,
    "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000},
    "cost_usd": 19.52,
    "cost_per_succeeded_run_usd": 6.51,
    "zero_duration_runs": 1,
    "duration_excluded_runs": 1,
    "cost_unpriced_runs": 1,
    "tokens_unmeasured_runs": 1
  },
  "by_status": [
    {
      "name": "succeeded",
      "runs": 3,
      "succeeded": 3,
      "success_rate": 1,
      "share": 0.5,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 4,
      "tokens": {"input": 3500000, "output": 700000, "total": 4200000, "cache_read": 50000, "cache_write": 10000},
      "cost_usd": 17.87,
      "cost_per_succeeded_run_usd": 5.96,
      "tokens_unmeasured_runs": 0
    }
  ],
  "by_trigger": [
    {
      "name": "<unknown>",
      "runs": 4,
      "succeeded": 2,
      "success_rate": 0.5,
      "share": 0.6667,
      "duration_seconds": {"p50": 600, "p95": 1200, "mean": 700, "samples": 3},
      "mean_turns": 2.5,
      "tokens": {"input": 1800000, "output": 350000, "total": 2150000, "cache_read": 50000, "cache_write": 10000},
      "cost_usd": 7.52,
      "cost_per_succeeded_run_usd": 3.76,
      "tokens_unmeasured_runs": 1
    },
    {
      "name": "<none>",
      "runs": 1,
      "succeeded": 0,
      "success_rate": 0,
      "share": 0.1667,
      "duration_seconds": {"p50": 0, "p95": 0, "mean": 0, "samples": 1},
      "mean_turns": 0,
      "tokens": {"input": 100000, "output": 10000, "total": 110000, "cache_read": 0, "cache_write": 0},
      "cost_usd": null,
      "cost_per_succeeded_run_usd": null,
      "tokens_unmeasured_runs": 0
    },
    {
      "name": "ci_fix",
      "runs": 1,
      "succeeded": 1,
      "success_rate": 1,
      "share": 0.1667,
      "duration_seconds": {"p50": 1800, "p95": 1800, "mean": 1800, "samples": 1},
      "mean_turns": 5,
      "tokens": {"input": 2000000, "output": 400000, "total": 2400000, "cache_read": 0, "cache_write": 0},
      "cost_usd": 12,
      "cost_per_succeeded_run_usd": 12,
      "tokens_unmeasured_runs": 0
    }
  ]
}
```

`since` and `until` echo the resolved bounds in UTC, `null` when open. `generated_at` is the instant of the request, and a duration bound counts back from it.

### Pricing and reload

The route prices runs with the [`token_rates`](/reference/workflow-config/#token_rates) the process started with, the same rates `config.token_rates` of [`GET /api/v1/state`](#get-apiv1state-system-state) serves, and `warnings` lists the advisories of those rates. `sortie stats` reads the workflow file each time it runs. After an edit of `token_rates`, the command and the route therefore price differently until the process restarts.

Each request opens its own read-only connection to the database and closes it once the report is built. It never uses the connection the orchestrator holds, so a report over a long history does not delay the orchestrator's writes. The scan covers every run in the range, so a request without bounds on a long history takes longer than a bounded one.

### Exposure

The route applies no masking. The body holds no issue titles, error text, or agent output. It holds the host paths `workflow_path` and `db_path`, the issue identifier of each `by_chain` entry, and the rule, template, and model names your workflow defines. A template name can be a path. Anyone who can reach the port can read them.

### Status codes

| Code | Error code | Meaning |
|---|---|---|
| `200 OK` | | Report returned, including a report over a range that holds no runs. |
| `400 Bad Request` | `invalid_parameter` | A parameter other than `since` and `until`, a parameter given more than once, a value that is not a range bound, or `since` not before `until`. No run is read. |
| `405 Method Not Allowed` | `method_not_allowed` | Any method other than `GET`. |
| `503 Service Unavailable` | `history_unavailable` | The database could not be opened or read. |

The message of a `400` names the parameter and the rule:

```json
{"error": {"code": "invalid_parameter", "message": "parameter \"since\" must be an RFC 3339 timestamp, a date such as 2026-07-01, or a positive duration such as 24h"}}
```

A parameter that is not a range bound reads `parameter "<name>" is not a parameter of this route`, a repeated one `parameter "<name>" is given more than once`, and a misordered pair `parameter "since" must be before until`. The text differs from the error `sortie stats` prints for the same value. A client that disconnects during the read gets no response, and the read stops.

---

## GET /api/v1/{identifier}: Issue detail

Returns issue-specific runtime and debug details, and the issue's run history. The `{identifier}` path parameter is the issue identifier (e.g., `MT-649`), not the internal issue ID. An issue that is no longer active is answered from run history.

```sh
curl http://localhost:7678/api/v1/MT-649
```

### Lookup by identifier

The path identifier is matched against live entries first. When none carries it, Sortie reads the newest run recorded under that identifier and takes the issue ID from it. If a live entry carries that issue ID, the response is that entry's live detail, with `issue_identifier` set to the identifier the entry carries now. This finds an issue the tracker renamed. `history` always covers the issue by its ID, so runs recorded under an earlier identifier stay in it.

The fixed paths `/api/v1/state`, `/api/v1/runs`, `/api/v1/stats`, `/api/v1/events`, and `/api/v1/refresh` take precedence over this route, so an issue whose identifier is one of `state`, `runs`, `stats`, `events`, or `refresh` cannot be read here.

Every `200` response carries `history`. The running and finished examples show it in full; the other examples omit it to keep the members that differ by status in view.

### Response (running issue)

```json
{
  "issue_identifier": "MT-649",
  "issue_id": "abc123",
  "status": "running",
  "status_text": "Turn 7",
  "status_text_full": "MT-649 is running, turn 7.",
  "next_outcomes": [
    {"condition": "If the run succeeds", "text": "Sortie moves MT-649 to In Review, and a pull request the run leaves gets the CI failure, review comments, bot review, merge conflicts, and auto-merge reactions."},
    {"condition": "If the run fails", "text": "Sortie retries MT-649 with exponential backoff."},
    {"condition": "If MT-649's token use reaches 500K", "text": "Sortie stops the session and holds MT-649 at its token budget."}
  ],
  "issue": {
    "title": "Fix the flaky login test",
    "url": "https://tracker.example.com/browse/MT-649",
    "issue_type": "Bug",
    "labels": ["bug", "backend"],
    "state": "In Progress"
  },
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
    "issue_title": "Fix the flaky login test",
    "issue_url": "https://tracker.example.com/browse/MT-649",
    "issue_labels": ["bug", "backend"],
    "issue_type": "Bug",
    "state": "In Progress",
    "session_id": "session-abc-001",
    "turn_count": 7,
    "self_review_active": false,
    "self_review_iteration": 0,
    "last_event": "turn_completed",
    "last_message": "Working on tests",
    "started_at": "2026-03-26T14:10:12Z",
    "dispatched_at": "2026-03-26T13:41:08Z",
    "last_event_at": "2026-03-26T14:29:59Z",
    "workspace_path": "/tmp/sortie_workspaces/MT-649",
    "tokens": {
      "input_tokens": 12500,
      "output_tokens": 3200,
      "total_tokens": 15700,
      "cache_read_tokens": 8400,
      "cache_write_tokens": 1200
    },
    "model_name": "<model-id-reported-by-the-agent>",
    "rule_name": "bugfix",
    "stage_lineage": null,
    "stage_position": null,
    "configured_model": "claude-sonnet-4-5",
    "configured_effort": "medium",
    "workflow_file": "WORKFLOW.md",
    "agent_kind": "claude-code",
    "api_request_count": 12,
    "requests_by_model": {
      "<model-id-reported-by-the-agent>": 12
    },
    "tool_time_percent": 34.7,
    "api_time_percent": 51.2,
    "tokens_measured": true,
    "usage_arrival": "incremental",
    "usage_attribution": "per_model",
    "tokens_pending": false,
    "tokens_awaited": false,
    "api_requests_measured": true,
    "used_sessions": 2,
    "budget_sessions": 5,
    "issue_tokens_completed": 105000,
    "unmeasured_sessions": 0,
    "used_tokens": 120700,
    "used_tokens_complete": true,
    "budget_tokens": 500000,
    "estimated_cost_usd": 0.06372,
    "cost_status": "estimated",
    "issue_estimated_cost_usd": 0.49872,
    "issue_cost_status": "estimated",
    "status_text": "Turn 7",
    "status_text_full": "MT-649 is running, turn 7."
  },
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "history": {
    "runs": [
      {
        "run_id": 41,
        "issue_id": "abc123",
        "issue_identifier": "MT-649",
        "issue_title": "Fix the flaky login test",
        "issue_url": "https://tracker.example.com/browse/MT-649",
        "attempt": 2,
        "status": "succeeded",
        "error": null,
        "rule_name": "bugfix",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T13:05:00Z",
        "completed_at": "2026-03-26T13:38:20Z",
        "dispatched_at": "2026-03-26T13:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-abc-001",
        "ssh_host": ""
      },
      {
        "run_id": 38,
        "issue_id": "abc123",
        "issue_identifier": "MT-649",
        "issue_title": "Fix the flaky login test",
        "issue_url": "https://tracker.example.com/browse/MT-649",
        "attempt": 1,
        "status": "failed",
        "error": "agent turn timed out",
        "rule_name": "bugfix",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T12:00:05Z",
        "completed_at": "2026-03-26T12:40:10Z",
        "dispatched_at": "2026-03-26T12:00:05Z",
        "turns_completed": 11,
        "tokens": {
          "input_tokens": 48000,
          "output_tokens": 12000,
          "total_tokens": 60000,
          "cache_read_tokens": 30000,
          "cache_write_tokens": 3000
        },
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.261,
        "cost_status": "estimated",
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-abc-000",
        "ssh_host": ""
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 2,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 84000,
        "output_tokens": 21000,
        "total_tokens": 105000,
        "cache_read_tokens": 50000,
        "cache_write_tokens": 5000
      },
      "tokens_complete": true,
      "estimated_cost_usd": 0.435,
      "cost_status": "estimated"
    },
    "hops": []
  }
}
```

### Response (retrying issue)

When an issue is in the retry queue rather than actively running, `status` is `"retrying"`, `running` is `null`, and `retry` is populated:

```json
{
  "issue_identifier": "MT-650",
  "issue_id": "def456",
  "status": "retrying",
  "status_text": "Retry 3 in 5m: no agent slot was free",
  "status_text_full": "MT-650's retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m.",
  "next_outcomes": [
    {"condition": "When retry 3 comes due", "text": "Sortie dispatches MT-650 on stage implement in a new session if it is still in an active state."}
  ],
  "issue": {
    "title": "Retry the export job",
    "url": "https://tracker.example.com/browse/MT-650",
    "issue_type": "Task",
    "labels": ["export"],
    "state": "In Progress"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 2,
    "current_retry_attempt": 3
  },
  "running": null,
  "retry": {
    "issue_id": "def456",
    "issue_identifier": "MT-650",
    "issue_title": "Retry the export job",
    "issue_url": "https://tracker.example.com/browse/MT-650",
    "issue_type": "Task",
    "issue_labels": ["export"],
    "state": "In Progress",
    "dispatched_at": "2026-03-26T14:02:41Z",
    "attempt": 3,
    "due_at": "2026-03-26T14:35:00Z",
    "error": "no available orchestrator slots",
    "trigger": "timer",
    "rule_name": "implement",
    "agent_kind": "claude-code",
    "configured_model": "claude-sonnet-4-5",
    "stage_lineage": {
      "chain_id": "7q2m4x9b1k5d8f3h6j0n2p4rst",
      "previous": "specify",
      "previous_outcome": "succeeded"
    },
    "stage_position": {
      "chain": ["specify", "implement"],
      "current": "implement",
      "hop_count": 1,
      "hop_ceiling": 10
    },
    "paused": false,
    "status_text": "Retry 3 in 5m: no agent slot was free",
    "status_text_full": "MT-650's retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m."
  },
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": "no available orchestrator slots",
  "tracked": {}
}
```

### Response (budget-exhausted issue)

When an issue has neither a running session nor a pending retry, but is held out of dispatch by a per-issue budget ceiling, `status` is `"budget_exhausted"`, `running` and `retry` are both `null`, and `budget_exhausted` is populated:

```json
{
  "issue_identifier": "MT-651",
  "issue_id": "ghi789",
  "status": "budget_exhausted",
  "status_text": "Held: session budget reached",
  "status_text_full": "MT-651 is held at its session budget of 3. Sessions used: 3.",
  "next_outcomes": [],
  "issue": {
    "title": "Migrate the billing tables",
    "url": "https://tracker.example.com/browse/MT-651",
    "issue_type": "Task",
    "labels": [],
    "state": "In Progress"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": null,
  "retry": null,
  "budget_exhausted": {
    "issue_id": "ghi789",
    "issue_identifier": "MT-651",
    "issue_title": "Migrate the billing tables",
    "issue_url": "https://tracker.example.com/browse/MT-651",
    "issue_type": "Task",
    "issue_labels": [],
    "state": "In Progress",
    "dispatched_at": "2026-03-26T13:31:07Z",
    "reason": "session_budget",
    "used_sessions": 3,
    "budget_sessions": 3,
    "used_tokens": null,
    "budget_tokens": null,
    "unmeasured_sessions": null,
    "stopped_in_flight": null,
    "exhausted_at": "2026-03-26T14:12:00Z",
    "stage_lineage": null,
    "stage_position": null,
    "agent_kind": "claude-code",
    "configured_model": "claude-sonnet-4-5",
    "status_text": "Held: session budget reached",
    "status_text_full": "MT-651 is held at its session budget of 3. Sessions used: 3."
  },
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Response (parked issue)

When an issue has no running session, no pending retry, and no budget hold, but is parked, `status` is `"parked"`, `running`, `retry`, and `budget_exhausted` are all `null`, and `parked` is populated:

```json
{
  "issue_identifier": "MT-652",
  "issue_id": "jkl012",
  "status": "parked",
  "status_text": "Parked: the agent needs a person",
  "status_text_full": "MT-652 is parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`.",
  "next_outcomes": [],
  "issue": {
    "title": "Rotate the signing keys",
    "url": "https://tracker.example.com/browse/MT-652",
    "issue_type": "Task",
    "labels": ["security"],
    "state": "In Progress"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": null,
  "retry": null,
  "budget_exhausted": null,
  "parked": {
    "issue_id": "jkl012",
    "issue_identifier": "MT-652",
    "issue_title": "Rotate the signing keys",
    "issue_url": "https://tracker.example.com/browse/MT-652",
    "issue_type": "Task",
    "issue_labels": ["security"],
    "state": "In Progress",
    "dispatched_at": "2026-03-26T13:41:20Z",
    "reason": "agent_blocked",
    "parked_state": "In Progress",
    "label": "needs-human",
    "label_applied": true,
    "parked_at": "2026-03-26T14:05:00Z",
    "rule_name": "bugfix",
    "stage_position": null,
    "agent_kind": "claude-code",
    "configured_model": "claude-sonnet-4-5",
    "status_text": "Parked: the agent needs a person",
    "status_text_full": "MT-652 is parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`."
  },
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Response (issue waiting on a reaction)

When an issue has no running session, no pending retry, no budget hold, and is not parked, but a pull request reaction is pending for it, `status` is `"pending_reactions"`, `running`, `retry`, `budget_exhausted`, and `parked` are all `null`, and `pending_reactions` lists the issue's rows:

```json
{
  "issue_identifier": "MT-654",
  "issue_id": "pqr678",
  "status": "pending_reactions",
  "status_text": "Watching #944 for merge conflicts",
  "status_text_full": "MT-654: Sortie watches PR #944 for merge conflicts; the last check found none; next check in 1m. Rebase runs used: 0 of 1.",
  "next_outcomes": [
    {"condition": "If a check in the next 20m finds a new merge conflict on PR #944", "text": "Sortie dispatches rebase 1 of 1."}
  ],
  "issue": {
    "title": "Cache the price list",
    "url": "https://tracker.example.com/browse/MT-654",
    "issue_type": "Task",
    "labels": ["performance"],
    "state": "In Review"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": null,
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [
    {
      "issue_id": "pqr678",
      "issue_identifier": "MT-654",
      "issue_title": "Cache the price list",
      "issue_url": "https://tracker.example.com/browse/MT-654",
      "issue_type": "Task",
      "issue_labels": ["performance"],
      "state": "In Review",
      "kind": "merge-conflict",
      "config_key": "merge_conflicts",
      "pull_request": {
        "number": 944,
        "repository": "acme/web",
        "url": "https://github.com/acme/web/pull/944",
        "branch": "sortie/MT-654",
        "head_sha": "c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3"
      },
      "created_at": "2026-03-26T14:20:00Z",
      "dispatched_at": "2026-03-26T14:06:52Z",
      "next_poll_at": "2026-03-26T14:31:00Z",
      "wait": "poll_interval",
      "used_attempts": 0,
      "max_attempts": 1,
      "escalated_at": null,
      "watch_ends_at": "2026-03-26T14:50:00Z",
      "last_check": {
        "observed_at": "2026-03-26T14:30:00Z",
        "head_sha": "c0ffee1d2e3f405162738495a6b7c8d9e0f1a2b3",
        "mergeable": true
      },
      "rule_name": "bugfix",
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "Watching #944 for merge conflicts",
      "status_text_full": "MT-654: Sortie watches PR #944 for merge conflicts; the last check found none; next check in 1m. Rebase runs used: 0 of 1."
    }
  ],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Response (issue between stages)

When an issue has no running session, no pending retry, no budget hold, is not parked, and has no pending reaction, but a stage hop moved it to its next stage and no run has been dispatched since, `status` is `"between_stages"`, `running`, `retry`, `budget_exhausted`, and `parked` are all `null`, and `between_stages` is populated:

```json
{
  "issue_identifier": "MT-655",
  "issue_id": "stu901",
  "status": "between_stages",
  "status_text": "Between stages: specify to implement",
  "status_text_full": "MT-655 moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue.",
  "next_outcomes": [
    {"condition": "When a poll tick reads `stage-implement` on MT-655", "text": "Stage implement starts in a new session."}
  ],
  "issue": {
    "title": "Plan the export schema",
    "url": "https://tracker.example.com/browse/MT-655",
    "issue_type": "Story",
    "labels": ["export", "stage-implement"],
    "state": "In Progress"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": null,
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": {
    "issue_id": "stu901",
    "issue_identifier": "MT-655",
    "issue_title": "Plan the export schema",
    "issue_url": "https://tracker.example.com/browse/MT-655",
    "issue_type": "Story",
    "issue_labels": ["export", "stage-implement"],
    "state": "In Progress",
    "source_rule": "specify",
    "target_rule": "implement",
    "target_label": "stage-implement",
    "hopped_at": "2026-03-26T14:28:15Z",
    "dispatched_at": "2026-03-26T14:03:41Z",
    "rule_name": "implement",
    "stage_position": {
      "chain": ["specify", "implement"],
      "current": "implement",
      "hop_count": 1,
      "hop_ceiling": 10
    },
    "agent_kind": "claude-code",
    "configured_model": "claude-sonnet-4-5",
    "status_text": "Between stages: specify to implement",
    "status_text_full": "MT-655 moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue."
  },
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Response (finished issue)

When no live entry holds the issue but run history does, `status` is `"history"`. `running`, `retry`, `budget_exhausted`, `parked`, `between_stages`, and `workspace` are `null`, `pending_reactions` is `[]`, and `attempts` holds zeros. `issue` carries the `title` and `url` of the issue's newest run, each omitted when empty. `history` holds the issue's runs:

```json
{
  "issue_identifier": "MT-648",
  "issue_id": "def456",
  "status": "history",
  "status_text": "Handed off to Human Review",
  "status_text_full": "MT-648 was handed off: Sortie moved it to Human Review.",
  "next_outcomes": [],
  "issue": {
    "title": "Add pagination to the export endpoint",
    "url": "https://tracker.example.com/browse/MT-648"
  },
  "workspace": null,
  "attempts": {
    "restart_count": 0,
    "current_retry_attempt": 0
  },
  "running": null,
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "history": {
    "runs": [
      {
        "run_id": 57,
        "issue_id": "def456",
        "issue_identifier": "MT-648",
        "issue_title": "Add pagination to the export endpoint",
        "issue_url": "https://tracker.example.com/browse/MT-648",
        "attempt": 1,
        "status": "succeeded",
        "error": null,
        "rule_name": "implement",
        "agent_kind": "claude-code",
        "started_at": "2026-03-26T12:02:10Z",
        "completed_at": "2026-03-26T12:41:55Z",
        "dispatched_at": "2026-03-26T12:02:10Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 52000,
          "output_tokens": 9100,
          "total_tokens": 61100,
          "cache_read_tokens": 30000,
          "cache_write_tokens": 4000
        },
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.1923,
        "cost_status": "estimated",
        "chain_id": "7h2k9x4m1q8w3e5r6t0y2uiop1",
        "stage_target": "review",
        "stage_result": "advanced",
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-def-001",
        "ssh_host": "",
        "issue_outcome": {
          "kind": "handed_off",
          "observed_at": "2026-03-26T12:42:01Z",
          "state": "Human Review",
          "status_text": "Handed off to Human Review",
          "status_text_full": "MT-648 was handed off: Sortie moved it to Human Review."
        }
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 1,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 52000,
        "output_tokens": 9100,
        "total_tokens": 61100,
        "cache_read_tokens": 30000,
        "cache_write_tokens": 4000
      },
      "tokens_complete": true,
      "estimated_cost_usd": 0.1923,
      "cost_status": "estimated"
    },
    "hops": [
      {
        "run_id": 57,
        "chain_id": "7h2k9x4m1q8w3e5r6t0y2uiop1",
        "source_rule": "implement",
        "target_rule": "review",
        "result": "advanced",
        "completed_at": "2026-03-26T12:41:55Z"
      }
    ],
    "issue_outcome": {
      "kind": "handed_off",
      "observed_at": "2026-03-26T12:42:01Z",
      "state": "Human Review",
      "status_text": "Handed off to Human Review",
      "status_text_full": "MT-648 was handed off: Sortie moved it to Human Review."
    }
  }
}
```

### Field notes

| Field | Description |
|---|---|
| `status` | One of `"running"`, `"retrying"`, `"budget_exhausted"`, `"parked"`, `"pending_reactions"`, `"between_stages"`, or `"history"`. Derived from which set the issue appears in; `running` takes precedence over `retrying`, which takes precedence over `budget_exhausted`, which takes precedence over `parked`, which takes precedence over `pending_reactions`, which takes precedence over `between_stages`, which takes precedence over `history`, the status of an issue only run history knows. |
| `status_text`, `status_text_full` | The issue's [status sentences](#status-sentences). Always present. They are the pair of the entry that decides `status`. For `"pending_reactions"` they are the pair of the first row in `pending_reactions` whose `escalated_at` is not `null`, and of the first row when none is. For `"history"` they word how the issue ended from `history.issue_outcome` and the newest run's `stage_target` and `stage_result`: a handoff after a hop that was not made (`"failed"` or `"ceiling"`) names the stage it did not reach, and an issue without an outcome reads `Not active; no ending recorded`. |
| `next_outcomes` | What Sortie does next for the issue, as condition and sentence pairs. Always present; `[]` when no pair applies. See [Next outcomes](#next-outcomes). |
| `issue` | The tracker's view of the issue, taken from whichever entry decides `status`. Present on every `200` response. Its members use the names of the [`.issue` template variable](/reference/workflow-config/#issue): `title`, `url`, `issue_type`, `labels`, and `state`. Each is omitted when that entry holds none, so the object is `{}` when it holds none of them. `labels` is `[]` when the entry was read and the issue carries none, and omitted when the entry holds no read of the labels. Masked like the running row's `issue_title`. For `running`, `retrying`, and `budget_exhausted` the members come from the entry's `issue_title`, `issue_url`, `issue_type`, `issue_labels`, and `state`. For `parked` they come from the parked entry's `issue_title`, `issue_url`, `issue_type`, and `issue_labels`, with `state` from its `parked_state`. For `pending_reactions` they come from the same members of the issue's first row, and for `between_stages` from those of the issue's row. |
| `workspace` | Contains `path` when the issue has an active workspace. `null` for retrying, budget-exhausted, parked, pending-reaction, and between-stages issues, or when the workspace path is unknown. |
| `attempts.restart_count` | How many times this issue has been restarted (attempt minus one, floored at zero). |
| `attempts.current_retry_attempt` | The current attempt number. `0` for running, budget-exhausted, parked, pending-reaction, and between-stages issues that have no pending retry. |
| `running` | Full running entry (same shape as entries in `/api/v1/state`), or `null`. |
| `retry` | Full retry entry (same shape as entries in the `retrying` array on `/api/v1/state`), or `null`. |
| `budget_exhausted` | Full budget-exhausted entry (same shape as entries in the `budget_exhausted` array on `/api/v1/state`), or `null`. |
| `parked` | Full parked entry (same shape as entries in the `parked` array on `/api/v1/state`), or `null`. Always present. Populated whenever the issue is parked, whatever `status` reads. |
| `pending_reactions` | The issue's rows in the record shape and order of the `pending_reactions` array on `/api/v1/state`, `[]` when it has none. Always present, whatever `status` reads. |
| `between_stages` | Full between-stages entry (same shape as entries in the `between_stages` array on `/api/v1/state`), or `null`. Always present. Populated whenever the issue is between stages, whatever `status` reads. |
| `recent_events` | Reserved for future use. Currently an empty array. |
| `last_error` | The `error` of the issue's retry entry, or `null` when it has none. After a reschedule this is the reschedule reason. |
| `tracked` | Reserved for future use. Currently an empty object. |
| `history` | `null` when the issue has no recorded run, otherwise an object. See [History member](#history-member). |

### Next outcomes

Every `200` response carries `next_outcomes`: the branches ahead of the issue, each as the condition that leads to it and what Sortie then does. A client shows them as written and reads no Sortie state to build them.

| Member | Description |
|---|---|
| `condition` | What leads to the outcome, for example `If the run fails`. It starts with a capital letter and ends without a period. |
| `text` | What Sortie then does, in one or two sentences that each end with a period. |

The list follows the workflow in effect, in this order:

1. A running work session yields what follows if the run succeeds and if it fails, and, when `agent.max_tokens` is set and the session's agent reports token usage, what follows if the issue's token use reaches that budget. A retry queued beside the session drops the failure pair, and also the success pair when `tracker.handoff_state` is unset. A session that runs a reaction continuation or a label command yields none of these, because the issue's pending reactions say what follows it.
2. Otherwise, a retry that is not `paused` yields what happens when it comes due, and an issue between stages yields what happens when a poll tick reads its stage label.
3. Each pending reaction then yields what happens when a check finds its event, in the order `ci`, `review`, `bot-review`, `merge-conflict`, `merge`, `merge-completion`, `label-review`, `label-fix`.

An issue with none of these serves `[]`, as a `"history"` response always does.

- A pair never names a reaction that `config.reactions` of [`GET /api/v1/state`](#get-apiv1state-system-state) lacks, nor a stage the dispatch rules do not hold. A reaction whose `escalated_at` is not `null` yields no pair.
- The condition of a watched reaction carries the time left in which a check can still lead to the outcome: the time to its `watch_ends_at`, measured from the time the snapshot was generated. For `review` it also leaves out the wait a found comment still has, one `polling.interval_ms` and, unless the comments already wait to settle, `debounce_ms`. A reaction with less than one second left yields no pair.
- An outcome that would start a session names the hold instead when the session budget or the token budget would stop it. A reaction configured with a triage command says that the command runs, in place of the fix, and one whose fixes are used up says how Sortie escalates, in the order the reaction's own pass decides them.
- The list is not exhaustive. It leaves out what the configuration does not decide: a stop the agent requests, a person's tracker or pull request edit other than a label command, a failed tracker, forge, or database call, a withheld handoff and the park it leads to, and a wait for a free agent slot. A branch missing from the list can still happen.
- The wording follows the rules of the [status sentences](#status-sentences): English, rendered on each request and stored nowhere, masked, with no clock time, date, or cost, and with stage wording only when the workflow has stage chains. A pair that cannot be rendered is left out of the list, and Sortie logs the failure.

### History member

Every `200` response carries `history`. It is `null` when the issue has no recorded run, and otherwise an object. A running issue with earlier runs serves its live detail and its `history` together.

| Member | Description |
|---|---|
| `runs` | The issue's newest runs, newest first, selected by `issue_id`. Each run has the shape described under [`GET /api/v1/runs`](#get-apiv1runs-run-history). A page holds at most 50 runs. |
| `next_cursor` | `null` when `runs` holds every run. Otherwise a cursor that continues the list on `GET /api/v1/runs?issue_id=<issue_id>&cursor=<next_cursor>`. |
| `totals` | The issue's spend over all of its runs, not only those in `runs`. |
| `hops` | The stage hop decisions of the runs in `runs`, in the same order. Runs that reached no decision add no entry. |
| `issue_outcome` | How the issue ended, or `null` when Sortie has not seen it end. The object each run in `runs` carries; see [Issue outcome](#issue-outcome). |

**`totals` members:**

| Member | Description |
|---|---|
| `run_count` | Every run of the issue, a recorded CI result included. |
| `unmeasured_runs` | Runs whose agent reported no token usage. |
| `tokens` | The five token members of a running row's `tokens`. Each is `null` when its sum is `0` and `tokens_complete` is `false`, so spend Sortie does not know never reads as zero. |
| `tokens_complete` | `true` when no run is unmeasured and no run has an unaccounted turn. When `false`, the figures in `tokens` are lower bounds. |
| `estimated_cost_usd` | Number or `null`. The sum of the estimates of the issue's runs, priced by agent kind under [`token_rates`](/reference/workflow-config/#token_rates). Unrounded. |
| `cost_status` | `"estimated"`, `"partial"`, `"unpriced"`, or `"unmeasured"`, with the meaning of `issue_cost_status` in the [`GET /api/v1/state` field notes](#field-notes). |

**`hops` members:**

| Member | Description |
|---|---|
| `run_id` | The run that made the decision. |
| `chain_id` | The stage chain of that run. Omitted when empty. |
| `source_rule` | The dispatch rule of that run. |
| `target_rule` | The rule its hop decision targeted. |
| `result` | `"advanced"`, `"partial"`, `"failed"`, or `"ceiling"`. |
| `completed_at` | When the run completed. |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Issue found and returned. |
| `404 Not Found` | Neither the current state nor run history holds the identifier: it is not running, retrying, budget-exhausted, parked, waiting on a pending reaction, or between stages, and no run was recorded under it. |
| `503 Service Unavailable` | The orchestrator state snapshot could not be produced (`snapshot_unavailable`), or run history or the issue outcome could not be read (`history_unavailable`). A failed history read answers `503` for a live identifier too. |

---

## POST /api/v1/refresh: Trigger poll cycle

Queues an immediate poll and reconciliation cycle. Useful for CI integrations that push issues and want Sortie to pick them up without waiting for the next poll interval.

```sh
curl -X POST http://localhost:7678/api/v1/refresh
```

### Response (202 Accepted)

```json
{
  "queued": true,
  "coalesced": false,
  "requested_at": "2026-03-26T14:30:05Z",
  "operations": ["poll", "reconcile"],
  "outcome_text": "Tracker poll and reconciliation queued."
}
```

`coalesced: true` means a refresh was already pending when your request arrived. The request was not lost. It merged with the existing pending signal. You don't need to retry.

### Response (409 Conflict, draining)

If Sortie is shutting down, the refresh is rejected:

```json
{
  "queued": false,
  "coalesced": false,
  "requested_at": "2026-03-26T14:30:05Z",
  "operations": [],
  "outcome_text": "Nothing queued: Sortie is shutting down."
}
```

### Field notes

`outcome_text` is always present, on `202` and `409` alike. It is one sentence that states what the response confirms, and it states no effect still to come:

| Response | `outcome_text` |
|---|---|
| `202`, `coalesced` is `false` | `Tracker poll and reconciliation queued.` |
| `202`, `coalesced` is `true` | `A tracker poll and reconciliation was already queued; this request joined it.` |
| `409`, `queued` is `false` | `Nothing queued: Sortie is shutting down.` |

### Status codes

| Code | Meaning |
|---|---|
| `202 Accepted` | Refresh queued (or coalesced with a pending refresh). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Server is draining; refresh rejected. |

---

## POST /api/v1/retries/{identifier}/run: Run a scheduled retry now

Makes the scheduled retry of an issue due now, so it runs without waiting out its delay. `{identifier}` is the `issue_identifier` of an entry in the `retrying` list of [`GET /api/v1/state`](#get-apiv1state-system-state), one path segment that a client percent-encodes, matched exactly. The route ignores the request body and the query string.

```sh
curl -X POST http://localhost:7678/api/v1/retries/MT-650/run
```

The retry takes the path of a retry whose timer fired. It passes the same checks, among them the limit on agents running at once, the `agent.max_sessions` and `agent.max_tokens` budgets, and a fresh read of the issue from the tracker, and a retry that the issue's state pauses stays paused. A retry that still cannot start is put back at the attempt number and the due time it had before the request, or due at once when that time has passed, so a request never leaves a retry waiting longer or at a later attempt than before. The put-back sets the entry's `error` to its own reason.

A retry that has a stored row has the row saved with the new due time, so a restart before the retry runs does not undo the request. A retry for a pull request reaction has no stored row. A failed save is logged and does not change the response.

The response arrives once Sortie has taken the request: at once while Sortie is idle, and at the end of the work in progress otherwise. The wait has no fixed bound. A client that disconnects while it waits, or a shutdown that begins, withdraws the request and changes nothing.

Each request that makes a retry due is logged at `info` as `retry made due on request`, with the `attempt` and the `replaced_due_at_ms` the request replaced, and it triggers a [change signal](#get-apiv1events-change-signals).

Sortie's HTTP server has no authentication, so anyone who can reach it can run a retry early. A deployment that others can reach must sit behind a reverse proxy with authentication or a VPN.

### Response (202 Accepted)

```json
{
  "queued": true,
  "requested_at": "2026-03-26T14:31:10Z",
  "issue_id": "def456",
  "issue_identifier": "MT-650",
  "attempt": 3,
  "outcome_text": "Retry 3 of MT-650 is due now."
}
```

### Response (404 Not Found)

No retry is scheduled for the identifier: the issue is unknown, it has no queued retry, or its retry ran or was released before Sortie took the request.

```json
{
  "error": {
    "code": "retry_not_found",
    "message": "no retry is scheduled for issue \"MT-999\""
  }
}
```

### Response (409 Conflict, draining)

If Sortie is shutting down, or began to before it took the request, nothing changes:

```json
{
  "queued": false,
  "requested_at": "2026-03-26T14:31:10Z",
  "outcome_text": "Nothing queued: Sortie is shutting down."
}
```

### Field notes

| Field | Description |
|---|---|
| `queued` | `true` on `202`, `false` on `409`. |
| `requested_at` | When Sortie received the request, UTC. |
| `issue_id` | The tracker's internal ID of the issue. `202` only. |
| `issue_identifier` | The identifier the retry carries. `202` only. |
| `display_identifier` | The issue's display identifier. Present on `202` only when the issue has one. |
| `attempt` | The retry's attempt number, unchanged by the request. `202` only. |
| `outcome_text` | One sentence that states what the response confirms. Always present on `202` and `409`. It states no effect still to come, because whether the retry starts is decided after the response. |

`outcome_text` names the issue by `display_identifier` when present, and by `issue_identifier` otherwise:

| Response | `outcome_text` |
|---|---|
| `202` | `Retry 3 of MT-650 is due now.` |
| `409` | `Nothing queued: Sortie is shutting down.` |

### Status codes

| Code | Meaning |
|---|---|
| `202 Accepted` | The retry is due now. |
| `404 Not Found` | No retry is scheduled for the identifier (`retry_not_found`). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Sortie is shutting down; nothing changed. |

---

## POST /api/v1/attention/{id}/acknowledge: Acknowledge an attention item

Records that a person has seen an item of the `attention` list of [`GET /api/v1/state`](#get-apiv1state-system-state). `{id}` is the `id` of a current item. The route ignores the request body and the query string.

```sh
curl -X POST http://localhost:7678/api/v1/attention/9ee206201099385b431c9bb01911553f/acknowledge
```

Acknowledging changes the item and nothing else. The item stays in the list with `acknowledged_at` set, it stops counting in `counts.attention`, and the cause, the issue, and the agent are untouched. The item disappears when its cause clears, as any item does. A new cause, such as a later park of the same issue, is a different item with a different `id` and is not acknowledged.

Sortie saves the acknowledgement before it changes its state in memory, so a response of `200` means the acknowledgement survives a restart. A request for an item that is already acknowledged answers `200` with `already_acknowledged` set to `true`, keeps the first `acknowledged_at`, and saves nothing. A request for an item that does not exist, because its cause cleared or the `id` is wrong, writes nothing.

The response arrives once Sortie has taken the request: at once while Sortie is idle, and at the end of the work in progress otherwise. The wait has no fixed bound. A client that disconnects while it waits, or a shutdown that begins, withdraws the request and changes nothing.

Each request that records an acknowledgement is logged at `info` as `attention item acknowledged`, with the `item_id` and the `kind`, and it triggers a [change signal](#get-apiv1events-change-signals).

Sortie's HTTP server has no authentication, so anyone who can reach it can acknowledge an item. A deployment that others can reach must sit behind a reverse proxy with authentication or a VPN.

### Response (200 OK)

```json
{
  "acknowledged": true,
  "already_acknowledged": false,
  "requested_at": "2026-03-26T14:31:10Z",
  "id": "9ee206201099385b431c9bb01911553f",
  "kind": "parked",
  "issue_id": "jkl012",
  "issue_identifier": "MT-652",
  "acknowledged_at": "2026-03-26T14:31:10Z",
  "outcome_text": "Acknowledged MT-652 (Parked: the agent needs a person). It comes back only if a new cause appears."
}
```

### Response (404 Not Found)

No current item has the `id`:

```json
{
  "error": {
    "code": "attention_item_not_found",
    "message": "no current attention item has ID \"9ee206201099385b431c9bb01911553f\""
  }
}
```

### Response (409 Conflict, draining)

If Sortie is shutting down, or began to before it took the request, nothing changes:

```json
{
  "acknowledged": false,
  "already_acknowledged": false,
  "requested_at": "2026-03-26T14:31:10Z",
  "outcome_text": "Nothing acknowledged: Sortie is shutting down."
}
```

### Field notes

| Field | Description |
|---|---|
| `acknowledged` | `true` on `200`, `false` on `409`. |
| `already_acknowledged` | `true` when the item was acknowledged before this request. |
| `requested_at` | When Sortie received the request, UTC. |
| `id`, `kind` | The item's `id` and `kind`. `200` only. |
| `issue_id`, `issue_identifier`, `display_identifier` | The issue the item names, as the item serves them. `200` only, each omitted when the item has none, which is every item about the process. |
| `acknowledged_at` | When the item was first acknowledged, UTC. On a repeat request it is the time of the first one. `200` only. |
| `outcome_text` | One sentence that states what the response confirms. Always present on `200` and `409`. |

`outcome_text` names the issue by `display_identifier` when present, and by `issue_identifier` otherwise. An item about the process carries no key, and its sentence reads `Acknowledged: <reason_text>. ...`. The `<reason_text>` is the item's `reason_text`.

| Response | `outcome_text` |
|---|---|
| `200`, `already_acknowledged` is `false` | `Acknowledged MT-652 (Parked: the agent needs a person). It comes back only if a new cause appears.` |
| `200`, `already_acknowledged` is `true` | `Already acknowledged MT-652 (Parked: the agent needs a person). It comes back only if a new cause appears.` |
| `409` | `Nothing acknowledged: Sortie is shutting down.` |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | The item is acknowledged, now or before. |
| `404 Not Found` | No current item has the `id` (`attention_item_not_found`). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Sortie is shutting down; nothing changed. |
| `500 Internal Server Error` | Sortie could not save the acknowledgement; nothing changed (`acknowledgement_not_saved`). |
| `503 Service Unavailable` | Sortie did not take the request; nothing changed (`acknowledge_unavailable`). |

---

## GET /api/v1/events: Change signals

Streams a signal each time something the JSON API serves changes, so a client can refetch what it shows instead of polling on a timer. The response is a [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream that stays open until the client disconnects or the HTTP server shuts down. A signal carries no data: it names no issue and no agent message, and the stream shows nothing that [`GET /api/v1/state`](#get-apiv1state-system-state) does not. The route takes no parameters and ignores the query string.

```sh
curl -N http://localhost:7678/api/v1/events
```

```text
id: 1792000000000000000
event: change
data: {}

```

### Events

| Event | Data | When |
|---|---|---|
| `change` | `{}` | Something the API serves changed, or a stream just opened and the client does not hold the current `id`. |
| `heartbeat` | `{}` | Every 15 seconds on every open stream, whether or not anything changed. |

Both events carry an `id` line. The `id` is an opaque decimal number that rises with every change. A `heartbeat` repeats the `id` of the last `change` the stream sent, or the `Last-Event-ID` the stream opened with when it sent none, so a heartbeat never moves a client's cursor. Sortie starts the counter from the clock at process start, so an `id` from before a restart never matches a later one.

### When a signal arrives

A stream receives a `change` after each of these:

- A poll tick, a refresh, a worker exit, a retry, a request that makes a retry due, or a request that acknowledges an attention item.
- Every message from a running agent session, so token counts and the latest message reach a client within a second.
- The start of shutdown.
- Each time the file watcher loads `WORKFLOW.md`, whether the load succeeds or fails.

A stream carries at most one `change` per second. The first change after a quiet second arrives at once. Changes made during the following second arrive together as one signal when that second ends. Values that move with the clock alone, such as elapsed times computed from `started_at` and `agent_totals.seconds_running`, produce no signal.

### Reconnecting

A stream opens with a `200` and flushes its headers at once. Sortie then sends one `change` immediately, unless the request carries a `Last-Event-ID` header equal to the current `id`. In that case Sortie sends nothing until the next change. A missing header, a stale value, or a value from before a restart all get the immediate `change`, so a client refetches after any gap.

A browser's `EventSource` sends `Last-Event-ID` and reconnects after a dropped connection on its own. A client that is not a browser echoes back the `id` of the last `change` it saw.

### Client guidance

Sortie does not enforce the following; it is how a consumer stays correct:

- Refetch on every `change`, and ignore `heartbeat` for data. Because signals are coalesced to one per second, a `change` means "something moved since your last fetch", not "one thing moved".
- Treat a stream that has delivered no event for 45 seconds, three heartbeat intervals, as dead. Close it and open a new one. A connection can die without the client being told, for example when a laptop wakes holding a socket the server dropped while it slept.
- After a failure that closes the stream for good, such as a non-`200` answer or a proxy `502`, wait before reopening and lengthen the wait while new attempts keep failing. A browser does not retry after a non-`200` answer, so the client has to.

### Shutdown and slow clients

When the HTTP server begins to shut down, Sortie ends every open stream, so a connected client does not hold up the [shutdown sequence](/reference/cli/#signals). A stream opened during that window still answers `200` and ends at once. The route never answers `503`.

A client that stops reading is dropped once Sortie cannot write a frame to it within 2 seconds, and it delays no other client. The server's 10-second write timeout does not apply to an open stream.

### Reverse proxies and browsers

The response carries `Cache-Control: no-cache` and `X-Accel-Buffering: no`, which nginx honors to stop buffering the stream. Set the proxy's read timeout above 15 seconds, or it closes a stream that the heartbeat would have kept alive.

Over plain HTTP/1.1 a browser allows about six connections per origin across all its tabs, and every open stream holds one. Share one stream across tabs rather than opening one per tab.

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | The stream is open. Content type is `text/event-stream`. |
| `405 Method Not Allowed` | Used a method other than GET. The answer is the usual JSON error envelope with `Allow: GET`. |

---

## GET /livez: Liveness probe

Lightweight liveness check for container orchestrators. Returns `200` when the process is alive, `503` when draining.

```sh
curl http://localhost:7678/livez
```

### Response (200 OK)

```json
{
  "status": "pass"
}
```

### Response (503, draining)

```json
{
  "status": "fail"
}
```

---

## GET /readyz: Readiness probe

Deep readiness check that validates database connectivity, preflight configuration, and workflow loading. Use this for Kubernetes readiness probes or load balancer health checks.

```sh
curl http://localhost:7678/readyz
```

### Response (200 OK)

```json
{
  "status": "pass",
  "version": "1.19.0",
  "uptime_seconds": 3742.8,
  "checks": {
    "database": "pass",
    "preflight": "pass",
    "workflow": "pass"
  }
}
```

### Response (503, one or more checks failed)

```json
{
  "status": "fail",
  "version": "1.19.0",
  "uptime_seconds": 3742.8,
  "checks": {
    "database": "pass",
    "preflight": "fail",
    "workflow": "pass"
  }
}
```

Each check is independent. `status` is `"pass"` only when every individual check passes. `uptime_seconds` counts from the process start, the same instant as `started_at` in `GET /api/v1/state`.

| Check | What it validates |
|---|---|
| `database` | SQLite database is accessible and responds to a ping. |
| `preflight` | Dispatch preflight validation is passing (agent binary exists, workspace root is writable, etc.). |
| `workflow` | Workflow file has been successfully loaded at least once. It keeps passing when a later edit fails to load, because Sortie keeps running on the last configuration that loaded. `health.workflow` in `GET /api/v1/state` reports that failure. |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | All checks pass. |
| `503 Service Unavailable` | One or more checks failed, or server is draining. |

---

## GET /metrics: Prometheus metrics

Standard Prometheus text exposition format. Available on the same port as all other endpoints when the HTTP server is enabled.

```sh
curl http://localhost:7678/metrics
```

Returns `text/plain` with Prometheus metric families. For the full metric catalog (names, labels, types, PromQL examples, and cardinality model), see [Prometheus metrics reference](/reference/prometheus-metrics/).

---

## Error envelope

All JSON API errors use a consistent structure:

```json
{
  "error": {
    "code": "issue_not_found",
    "message": "issue identifier \"XYZ-999\" not found in current state or run history"
  }
}
```

### Error codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `issue_not_found` | 404 | Neither the current state nor run history holds the requested issue identifier. |
| `retry_not_found` | 404 | `POST /api/v1/retries/{identifier}/run` found no scheduled retry for the identifier. |
| `invalid_parameter` | 400 | `GET /api/v1/runs` or `GET /api/v1/stats` rejected a query parameter, or a misordered pair of bounds. The message names the parameter and the rule. |
| `snapshot_unavailable` | 503 | The orchestrator could not produce a state snapshot. |
| `history_unavailable` | 503 | Run history or the issue outcomes could not be read, or the database behind `GET /api/v1/stats` could not be opened or read. |
| `attention_item_not_found` | 404 | `POST /api/v1/attention/{id}/acknowledge` found no current attention item with the `id`. |
| `acknowledgement_not_saved` | 500 | `POST /api/v1/attention/{id}/acknowledge` could not save the acknowledgement; nothing changed. |
| `acknowledge_unavailable` | 503 | `POST /api/v1/attention/{id}/acknowledge` was not taken; nothing changed. |
| `method_not_allowed` | 405 | The HTTP method is not supported on this endpoint. |
| `internal_error` | 500 | Unexpected server error (e.g., JSON serialization failure). |

## Method enforcement

Every endpoint enforces its allowed HTTP method. Sending the wrong method returns `405 Method Not Allowed` with an `Allow` header indicating the correct method, and a JSON error envelope, not plain text.

```sh
curl -X DELETE http://localhost:7678/api/v1/state
```

```json
{
  "error": {
    "code": "method_not_allowed",
    "message": "method DELETE is not allowed on this endpoint"
  }
}
```

The response includes the header `Allow: GET` (or `Allow: POST` for the refresh, retry, and acknowledge endpoints).

## Endpoint summary

| Method | Path | Description | Content-Type |
|---|---|---|---|
| GET | `/` | HTML dashboard | `text/html` |
| GET | `/livez` | Liveness probe | `application/json` |
| GET | `/readyz` | Readiness probe | `application/json` |
| GET | `/api/v1/state` | Full system state snapshot | `application/json` |
| GET | `/api/v1/runs` | Run history, newest first, filtered and paged | `application/json` |
| GET | `/api/v1/stats` | Run statistics over a completion-time range | `application/json` |
| GET | `/api/v1/{identifier}` | Per-issue detail and run history | `application/json` |
| GET | `/api/v1/events` | Stream of change signals and heartbeats | `text/event-stream` |
| POST | `/api/v1/refresh` | Trigger immediate poll cycle | `application/json` |
| POST | `/api/v1/retries/{identifier}/run` | Make a scheduled retry due now | `application/json` |
| POST | `/api/v1/attention/{id}/acknowledge` | Acknowledge an attention item | `application/json` |
| GET | `/metrics` | Prometheus metrics | `text/plain` |
