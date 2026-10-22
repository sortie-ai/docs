---
title: "HTTP API"
description: "Complete reference for Sortie's embedded HTTP server: JSON API endpoints, request/response shapes, error codes, and curl examples."
author: Sortie AI
date: 2026-04-13
weight: 40
url: /reference/http-api/
---
Sortie embeds an HTTP server that exposes a JSON API, a stream of change signals and agent events, a [browser dashboard](/reference/dashboard/), health probes, and Prometheus metrics, all on a single port.

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

## Cross-origin requests

The server refuses a state-changing request that a browser sends from a page on another origin. This keeps a web page you happen to have open from driving Sortie's POST endpoints, even when Sortie listens only on `127.0.0.1`.

A request that is refused gets `403 Forbidden` with the error code `cross_origin_request_rejected` and the usual [error envelope](#error-envelope). Nothing changes. Sortie also logs a `WARN` line, `cross-origin request rejected`, with the attributes `method`, `path`, `origin`, `sec_fetch_site`, and `host`.

The check runs before routing, on every path. A refused request therefore gets `403` where the route would have answered `404` or `405`, and `POST /livez` gets `403` rather than its usual `405`.

Sortie decides in this order, using the first rule that applies:

| Order | Condition | Result |
|---|---|---|
| 1 | The method is `GET`, `HEAD`, or `OPTIONS`. | Served. |
| 2 | `Sec-Fetch-Site` is `same-origin` or `none`. | Served. |
| 3 | `Sec-Fetch-Site` has any other value. | Refused, whatever `Origin` says. |
| 4 | There is no `Sec-Fetch-Site` header and no `Origin` header. | Served. |
| 5 | There is no `Sec-Fetch-Site` header, and the host and port of `Origin` equal the `Host` header. | Served. |
| 6 | There is no `Sec-Fetch-Site` header, and `Origin` differs from `Host`. | Refused. |

Requests from `curl`, scripts, and other tools that send neither `Origin` nor `Sec-Fetch-Site` are served as before. So are Prometheus scrapes and health probes, which use `GET`.

Sortie compares `Origin` with `Host` only for a browser that sends no `Sec-Fetch-Site` header. That comparison ignores the scheme and includes the port, so a reverse proxy in front of Sortie must pass on the `Host` header the browser sent, unchanged, port included. A proxy that rewrites it makes Sortie refuse the dashboard actions of such a browser.

The check separates browser pages from other clients; it does not authenticate anyone. The server still [has no authentication](/reference/dashboard/#security), and the check does not cover DNS rebinding.

---

## GET /: Dashboard redirect

Redirects to the [dashboard](/reference/dashboard/).

```sh
curl -i http://localhost:7678/
```

Returns `302 Found` with `Location: /ui/` and no body. The redirect is temporary, so browsers do not cache it.

## GET /ui/: Dashboard

Serves the dashboard, a single-page application compiled into the Sortie binary. The [dashboard reference](/reference/dashboard/) describes what it shows.

```sh
curl -i http://localhost:7678/ui/
```

Every path under `/ui/` that is not a script or stylesheet returns the same HTML document, so a screen address such as `/ui/issues/MT-649` can be opened directly or bookmarked. The application reads its data from the JSON routes on this page and from the [event stream](#get-apiv1events-change-signals-and-agent-events).

| Path | Response |
|---|---|
| `/ui/` and any other path below it | `200 OK`, `text/html; charset=utf-8`, `Cache-Control: no-cache`, with an `ETag`. A request carrying a matching `If-None-Match` gets `304 Not Modified`. |
| `/ui/assets/<name>.js` and `/ui/assets/<name>.css` | `200 OK`, `text/javascript; charset=utf-8` or `text/css; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable`. File names carry a content hash. |
| `/ui/assets/` with any other extension or an unknown name | `404 Not Found`. |

Every response carries `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that allows only same-origin scripts, styles, and connections, and forbids framing.

The route accepts `GET` and `HEAD`. Sortie's HTTP server has no authentication, so anyone who can reach the port can open the dashboard and use its actions. A deployment that others can reach must sit behind a reverse proxy with authentication or a VPN.

---

## GET /api/v1/state: System state

Returns a full runtime snapshot: running sessions, retry queue, budget-exhausted and parked issues, pending pull request reactions, issues between stages, one entry per active issue in a stable order, the list of what needs a person, aggregate totals, rate limits, the workflow configuration in effect, which names the tracker kind and project, the health of Sortie's own checks, the Sortie version, and the time the process started.

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
      "uncached_tokens": 7300,
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
      "skills": [{"skill": "ce-plan"}, {"skill": "ce-work", "tool_error": true}],
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
      "used_tokens": 112300,
      "used_tokens_complete": true,
      "budget_tokens": 500000,
      "budget_usd": 25,
      "estimated_cost_usd": 0.06372,
      "cost_status": "estimated",
      "issue_estimated_cost_usd": 0.49872,
      "issue_cost_status": "estimated",
      "status_text": "Turn 7",
      "status_text_full": "Running, turn 7.",
      "dispatch_id": "RLQFSIOFERWGDW2HZY45W55VXK",
      "quiet_at": "2026-03-26T14:32:29Z",
      "stall_at": "2026-03-26T14:34:59Z",
      "stall_text": null,
      "stall_text_full": null,
      "stall_off_text": null
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
      "status_text_full": "The retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m."
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
      "used_usd": null,
      "used_usd_complete": null,
      "budget_usd": null,
      "unmeasured_sessions": null,
      "stopped_in_flight": null,
      "exhausted_at": "2026-03-26T14:12:00Z",
      "stage_lineage": null,
      "stage_position": null,
      "agent_kind": "claude-code",
      "configured_model": "claude-sonnet-4-5",
      "status_text": "Held: session budget reached",
      "status_text_full": "Held at the session budget of 3. Sessions used: 3."
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
      "status_text_full": "Parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`."
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
      "status_text_full": "Sortie escalated failing CI on PR #931; it keeps watching the pull request. CI fixes used: 2 of 2."
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
      "status_text_full": "Waiting for 1 new review comment on PR #931 (3 actionable) to settle; next check in 55s. Review fix runs used: 1 of 3."
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
      "status_text_full": "Moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue."
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
      "status_text_full": "Held at the session budget of 3. Sessions used: 3.",
      "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "status_text_full": "Running, turn 7.",
      "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "status_text_full": "Parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`.",
      "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "status_text_full": "Sortie escalated failing CI on PR #931; it keeps watching the pull request. CI fixes used: 2 of 2.",
      "pr_loop": {"ci_failure": {"result": "escalated", "continuations": 2}, "review_comments": {"result": "acted", "continuations": 1}, "bot_review": {"result": "quiet", "continuations": 0}, "merge_conflicts": {"result": "quiet", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "status_text_full": "The retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m.",
      "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "status_text_full": "Moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue.",
      "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}}
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
      "why_text": "The agent stopped because it cannot go on without a person, so Sortie parked the issue under the label `needs-human`.",
      "clears_text": "Clears when a poll tick finds `needs-human` removed from the issue, or the issue moved out of In Progress.",
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
      "why_text": "The issue has used 3 sessions of its budget of 3.",
      "clears_text": "Clears on the next poll tick after `agent.max_sessions` is raised above 3 or is removed, or after the issue leaves the active tracker states.",
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
      "clears_text": "Clears when a check of PR #931 passes, a new commit lands on it, it merges or closes, `reactions.ci_failure.max_retries` rises above 2, or the issue reaches a terminal tracker state or leaves In Review.",
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
  "spend_ceiling": {
    "daily": {
      "budget_usd": 100,
      "used_usd": 41.27,
      "used_usd_complete": true,
      "holds_dispatch": false,
      "resets_at": "2026-03-27T00:00:00Z"
    },
    "monthly": null
  },
  "config": {
    "tracker": {
      "kind": "jira",
      "project": "PROJ",
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
      "max_cost_usd": 25,
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
        "complete": true,
        "per_kind": true
      },
      "codex": {
        "input_per_mtok": 2.5,
        "output_per_mtok": null,
        "cache_read_per_mtok": null,
        "cache_write_per_mtok": null,
        "complete": false,
        "per_kind": true
      }
    }
  },
  "health": {
    "database": {"status": "pass", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:58Z", "consecutive_failures": 0, "failing_since": null},
    "preflight": {"status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 1, "failing_since": "2026-03-26T14:29:58Z", "error": "dispatch preflight failed: workflow file cannot be loaded: config: agent.turn_timeout_ms: must be greater than 0"},
    "workflow": {"file": "WORKFLOW.md", "status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 2, "failing_since": "2026-03-26T14:29:41Z", "error": "config: agent.turn_timeout_ms: must be greater than 0"},
    "poll": {"status": "fail", "checked_at": "2026-03-26T14:29:58Z", "last_success_at": "2026-03-26T14:29:28Z", "consecutive_failures": 1, "failing_since": "2026-03-26T14:29:58Z", "outcome": "preflight_failed", "next_poll_at": "2026-03-26T14:30:28Z", "summary_text": "The latest poll stopped at the dispatch preflight before reading the tracker; the last successful poll was 32s ago."},
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
| `issue_labels` | The issue's labels as Sortie last read them for the session, from the same read as `state`, lowercase and in the tracker's order. Always present; `[]` when the issue has none. |
| `issue_type` | The tracker's issue type, as read at dispatch. Omitted when the tracker returned none. |
| `state` | The tracker state of the issue as Sortie last read it for the session. The dispatch read sets `state` and `issue_labels`. Two later reads replace them: the one Sortie takes right after it moves the issue to `tracker.in_progress_state`, and the one on every poll tick. A read that would stop the run is never recorded here, and an older read never replaces a newer one. A failed read leaves both unchanged. |
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
| `uncached_tokens` | Integer or `null`. This session's tokens without cache reads: `tokens.total_tokens` less `tokens.cache_read_tokens`, floored at zero, so cache writes stay in it. It is the session's share of `used_tokens`. A sibling of `tokens`, not a member of it. `null` exactly when `tokens_measured` is `false`. |
| `tokens_measured` | `false` until the coding agent reports token usage for this session, including before the first turn begins; that is what makes the members of `tokens` `null` rather than `0`. `true` once any usage figure has been reported. Stays `false` for the life of a session whose `usage_arrival` is `"none"`, whatever its runtime sends. |
| `workspace_path` | Absolute filesystem path to the issue's workspace directory. |
| `model_name` | LLM model the runtime reported running. Omitted when unknown, and when `usage_arrival` is `"none"`. It can differ from `configured_model`; see [configured and reported model](#configured-and-reported-model). |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) that routed this session. Omitted when no rule routed it. |
| `dispatched_at` | When Sortie dispatched the first run of the issue's current pass, in UTC. Always present and never `null` on a running row. A retry, a reaction continuation, the next stage of a hop, and a restart continue the pass, so the value stays fixed across them. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `dispatch_id` | The ID Sortie gave this run when it dispatched it. Each run gets its own, never reused, across restarts too. Pass it to [`GET /api/v1/runs/{dispatch_id}/events`](#get-apiv1runsdispatch_idevents-run-events) to read the run's agent events, or in the `run` parameter of [`GET /api/v1/events`](#get-apiv1events-change-signals-and-agent-events) to receive them as the agent works. Always present, never empty. |
| `last_event` | The type of the session's latest agent event. |
| `last_message` | The message of the latest agent event that carried one, masked, `""` before any did. Events with no message leave it unchanged, so it holds the last thing the agent said, never a protocol marker. |
| `last_event_at` | When the session's latest agent event arrived, in UTC. Every event counts, those the run does not keep included. `null` before the first event. |
| `quiet_at` | Half of [`agent.stall_timeout_ms`](/reference/workflow-config/#agent) after `last_event_at`, or after `started_at` before the first event, in UTC. `null` when stall detection is off. |
| `stall_at` | All of `agent.stall_timeout_ms` after the same instant, in UTC. The first poll tick after it stops the session as stalled. `null` when stall detection is off. |
| `stall_text`, `stall_text_full` | A short and a long sentence that state how long the agent has been silent and when Sortie stops it, for example `No events for 2m; Sortie stops it after 5m`. The silence is rounded down, so the sentence stays true until the next event. `null` until `generated_at` reaches `quiet_at`, and while stall detection is off. A client that shows the sentence refetches at `quiet_at` to get it. |
| `stall_off_text` | While stall detection is off, the sentence ``Stall detection is off; Sortie will not stop this session as stalled (`agent.stall_timeout_ms`).`` `null` while it is on, so it is a string exactly when `quiet_at` is `null`. |
| `stage_lineage` | Always present. `null` unless a [stage hop](/reference/state-machine/#stage-hop) reached the run, under the rule of the `retrying[]` entries. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |
| `configured_model` | The `model` this attempt's resolved settings carry, the model Sortie asked the agent to run. Omitted when none is configured, which leaves the choice to the runtime's own default. |
| `configured_effort` | The `effort` this attempt's resolved settings carry. Omitted when none is configured. |
| `api_request_count` | Count of LLM API requests, one per `token_usage` event received during this session. Integer or `null`, and `null` exactly when `api_requests_measured` is `false`. |
| `requests_by_model` | Breakdown of API requests per model. Omitted when `api_requests_measured` is `false`, when `usage_attribution` is anything other than `"per_model"`, or when the breakdown is empty. |
| `skills` | The session's skill calls so far, in completion order, as the elements of `skills` on a [run](#get-apiv1runs-run-history) are. Omitted until the run has completed a skill call, and for an agent that reports none. |
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
| `issue_tokens_completed` | Integer or `null`. The summed tokens without cache reads of the issue's completed sessions (`total_tokens` less `cache_read_tokens`, floored at zero for each session). `null` when no read of the run history has succeeded, and when the sum is `0` while a completed session is unmeasured or recorded a turn no figure covered. |
| `used_tokens` | Integer or `null`. `issue_tokens_completed` plus this row's `tokens.total_tokens` less its `tokens.cache_read_tokens` (floored at zero), each counted as `0` when `null`. This is the sum [`agent.max_tokens`](/reference/workflow-config/#agent) is compared with, so it leaves out cache reads, and it advances with each usage figure of the session. `null` when the sum is `0` and `used_tokens_complete` is `false`, so unknown spend never reads as zero. |
| `used_tokens_complete` | Boolean. `true` exactly when `used_tokens` is the issue's whole spend: the completed sessions were read, none is unmeasured, none recorded a turn no figure covered, this session is measured, and it has recorded no such turn. When `false`, `used_tokens` is a lower bound. It ignores `tokens_pending`, which separately marks the turn in progress as not yet counted. |
| `budget_tokens` | Integer or `null`. `agent.max_tokens` as of the latest poll tick. `null` when `agent.max_tokens` is `0`, never `0`. Token headroom: `budget_tokens` minus `used_tokens`, undefined when either is `null`, and negative when the session overshot the ceiling. The API serves no headroom key. |
| `budget_usd` | Number or `null`. `agent.max_cost_usd` as of the latest poll tick. `null` when `agent.max_cost_usd` is `0`, never `0`. The ceiling compares it with the issue's estimated cost, the figure `issue_estimated_cost_usd` serves, which is a lower bound unless `issue_cost_status` is `"estimated"`. The API serves no money headroom key. |
| `estimated_cost_usd` | Number or `null`. Estimated cost of this session so far, from `tokens` and the rates in force for the session's models, unrounded: a [`token_rates`](/reference/workflow-config/#token_rates) entry, else the [price table](/reference/workflow-config/#price_table). Non-`null` exactly when `cost_status` is `"estimated"` or `"partial"`. |
| `cost_status` | String. `"estimated"` (a zero rate also gives this); `"partial"` when the estimate is a lower bound because a token class the session spent has no rate; `"unpriced"` when the session is measured and no rate prices its model (no price table lists it and no `token_rates` entry prices it), when a [kind entry](/reference/workflow-config/#kind-entries) of `agent_kind` lacks `input_per_mtok` or `output_per_mtok`, when no rate source is available, or when its spend so far arrived as a total with no split by token class; `"unmeasured"` when `tokens_measured` is `false`. |
| `issue_estimated_cost_usd` | Number or `null`. Estimated cost of the whole issue: the sum of the costs recorded with its completed sessions and the estimate of this one, over the parts that are priced. Unrounded. Non-`null` exactly when `issue_cost_status` is `"estimated"` or `"partial"`. |
| `issue_cost_status` | String. `"estimated"` when the estimate covers the issue's whole spend, which requires `used_tokens_complete` to be `true`. `"partial"` when it is a lower bound because a part that spent tokens is left out. `"unpriced"` when no priced part spent tokens and a part that did has no rate. `"unmeasured"` when `used_tokens` is `null`, and when no part is priced or unpriced. A session measured at zero tokens leaves nothing out, so a missing rate for its model does not make an otherwise complete issue `"partial"`. |

The issue-level keys are always present on a running row. A limit key (`budget_tokens`, `budget_usd`, `budget_sessions`) set to `null` means no limit is configured. A usage key (`used_sessions`, `unmeasured_sessions`, `issue_tokens_completed`, `used_tokens`) set to `null` means unknown. The [`cost_budget` tool](/reference/agent-extensions/#cost_budget) reports figures under some of the same names to the agent; there a limit that is not configured reads `0`.

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
  "uncached_tokens": null,
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

The dashboard shows both values. Completed runs keep all three; see [model and effort of a completed run](#model-and-effort-of-a-completed-run).

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
| `due_at` | When the retry comes due, in UTC. Always present. A [request to run the retry now](#post-apiv1retriesidentifierrun-run-a-scheduled-retry-now) replaces a later value with the time Sortie takes the request. |
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

When a retry comes due and cannot start, Sortie puts it back with `trigger` set to `timer` and `error` set to the reason from the table below. The error of the run before it is not kept on the row; it stays in the logs and in that run's run history. A retry that has not yet come due still carries the error of the run that scheduled it. That error, and `last_error` on the per-issue response, read as the plain sentence a run row's [`error`](#get-apiv1runs-run-history) carries for the same failure, not the text Sortie stored. The reschedule reasons below are served as written.

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

**`budget_exhausted[]` entries:** Issues held out of dispatch by a per-issue budget ceiling ([`agent.max_sessions`](/reference/workflow-config/#agent), [`agent.max_tokens`](/reference/workflow-config/#agent), or [`agent.max_cost_usd`](/reference/workflow-config/#agent)).

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `status_text`, `status_text_full` | The row's [status sentences](#status-sentences). Always present. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read by the poll that last rebuilt the held set, or by the retry the hold was found on until the next poll. Each omitted when empty. Masked like the running row's. |
| `issue_type`, `issue_labels`, `state` | The issue's type, labels, and tracker state from the same read, under the rules of the `retrying[]` entries. Masked like the running row's. |
| `reason` | `session_budget`, `token_budget`, or `money_budget`: which ceiling stopped dispatch. An issue past several ceilings carries `money_budget` first, then `token_budget`, then `session_budget`. |
| `used_sessions`, `budget_sessions` | Completed sessions for the issue against the configured `agent.max_sessions`. `budget_sessions` is `null` when no session budget is set, as on a `running[]` entry. |
| `used_tokens`, `budget_tokens` | Measured cumulative tokens without cache reads against the configured `agent.max_tokens`. `budget_tokens` is `null` when no token ceiling is set, as on a `running[]` entry. `used_tokens` is `null` only on a `session_budget` entry, in two cases: the token ceiling has not been evaluated for the issue (`agent.max_tokens` is `0`, or reading the issue's token spend failed), or the sum is `0` while a session reported no token usage or a turn went unaccounted for, so that `0` would stand for spend Sortie does not know. A non-zero sum is served as is and can still be a lower bound. |
| `used_usd`, `used_usd_complete`, `budget_usd` | The issue's estimated cost in US dollars against the configured `agent.max_cost_usd`. `used_usd_complete` is `false` exactly when `used_usd` is a lower bound, because a run is recorded unpriced or partial or part of the spend was not measured. `used_usd` and `used_usd_complete` are `null` while the money ceiling has not been evaluated for the issue (`agent.max_cost_usd` is `0`, or reading the issue's run history failed). `budget_usd` is `null` when no money ceiling is set, as `budget_tokens` is. |
| `unmeasured_sessions` | Count of the issue's sessions whose agent reported no token usage. `null` when the issue's spend was not read. |
| `stopped_in_flight` | Count of the issue's sessions that a budget ceiling stopped while they were running, recorded with status `budget_stopped`. `null` when the issue's spend was not read. |
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
| `next_poll_at` | When the next check is due, in UTC. The check runs on the first reconcile pass at or after it, so a value at or before `generated_at` means the next pass checks the reaction. A [request to check the reaction now](#post-apiv1reactionsidentifierkindcheck-check-a-pending-reaction-now) moves a later value to the time Sortie takes the request, and the check it brings forward gives the replaced value back when the reaction stays pending. |
| `wait` | Why the reaction waits for that check; see the table below. Omitted until a pass first returns the reaction to the pending set, because a reaction no pass has taken is due at once. |
| `used_attempts` | Integer or `null`. What the kind counts; see the table below. `null` for `label-review` and `label-fix`, which count nothing. |
| `max_attempts` | Integer or `null`. The budget the kind's pass applies, as of the latest poll tick. `null` when the pass applies none: for `label-review` and `label-fix`, and for `merge` when `max_retries` is `0`. |
| `escalated_at` | String or `null`. When the standing escalation of the reaction began, in UTC. Always present; `null` while none stands. Every kind that escalates stays pending while its escalation stands, and serves the time the escalation began, which a recheck does not move. The escalation survives a restart. What ends it depends on the kind; see [standing escalations](/reference/reactions/#standing-escalations). When `config.reactions[config_key].escalation` is `"label"`, the label an escalation applies is that block's `escalation_label`. |
| `escalation_trigger` | String or absent. Present exactly while `escalated_at` is non-null. Why the escalation began: `budget_exhausted` (the kind used up its tries), `triage` (the kind's triage command asked for a person), `refused` (the forge or the tracker answered a write with an authentication or payload error; on `merge` and `merge-completion`), or `missing_merge_commit` (the forge reports the pull request merged but gives no merge commit after the grace period; on `merge-completion`). |
| `watch_ends_at` | String or `null`. When the reaction stops watching the pull request unless its watch restarts first, in UTC: the kind's `watch_window_ms`, as the process applies it, added to the instant the kind measures the window from. Always present. `ci` measures from when it last recorded a new head commit, or from `created_at` while it has recorded none, so a new head moves the value. `review`, `bot-review`, and `merge-conflict` measure from their latest wait for the retry slot, which restarts the watch, or from `created_at` when they have not waited. `merge` measures from `created_at`. `null` for `merge-completion`, `label-review`, and `label-fix`, which have no watch window, when `watch_window_ms` is `0`, while an escalation stands, because no window ages out a standing escalation, and for a `review` reaction whose latest check has `awaiting_approval`, because Sortie holds that watch past its window. |
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
| `url` | The pull request's web page as the provider reported it on the latest read. Omitted until a read reports one. A `review` reaction that is awaiting approval reads the pull request on every due check, so the link follows the pull request for as long as the hold lasts. Masked. |
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
| `handled` | `bot-review` | `true` while the newest [triage](/reference/reactions/#triage-command) answer Sortie recorded for the comment set the check found is `handled`, so Sortie starts no session for it. Omitted otherwise, never `false`. A comment set that differs from the answered one carries no `handled`. The answer survives a restart and returns with the first completed check. The row's `status_text` reads `Bot review of #<number> handled`. |
| `awaiting_approval` | `review` | `true` when the check found no comment to answer and the forge reports that a required approval is still missing. Omitted otherwise, never `false`, and never present on `bot-review`. A request for changes does not set it. A check that cannot read the review decision keeps the previous value, and each completed check replaces it. While it is `true`, Sortie holds the watch past `reactions.review_comments.watch_window_ms` and `watch_ends_at` is `null`. The row's `status_text` reads `Waiting on approval of #<number>`. |
| `mergeable` | `merge-conflict` | `false` when the provider reports merge conflicts, `true` when it reports none, `null` while the provider has not computed mergeability. A branch-protection block is not a conflict. |

A `review` row that waits on a required approval, showing only the fields that differ from the `review` row above:

```json
{
  "wait": "poll_interval",
  "watch_ends_at": null,
  "last_check": {
    "observed_at": "2026-03-26T14:29:58Z",
    "actionable_comments": 0,
    "new_comments": 0,
    "awaiting_approval": true
  },
  "status_text": "Waiting on approval of #931",
  "status_text_full": "Waiting on approval of PR #931; next check in 55s. Review fix runs used: 1 of 3."
}
```

`wait` values, set by the pass that last returned the reaction to the pending set:

| `wait` | Meaning |
|---|---|
| `poll_interval` | The check completed and the reaction keeps watching, because there was nothing to act on yet or it has already acted for this subject. The next check follows the kind's poll cadence. |
| `debounce` | `review` only. The check found actionable comments within `debounce_ms` of the newest one. `next_poll_at` ends the window, unless a request to check the reaction now moved it. |
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
| `issue_labels` | The issue's labels as the hop leaves them: the labels read when the hopping run was dispatched, without the stage labels the hop removed, and with `target_label` added. A label added to the issue during the run is not in this list. Omitted while the hop holds no read of the labels. Masked like the running row's. |
| `source_rule` | The rule whose run made the hop. |
| `target_rule` | The rule the hop targeted. |
| `target_label` | The stage label the hop added to the issue. |
| `hopped_at` | When the hop was made, in UTC. |
| `dispatched_at` | When Sortie dispatched the first run of the pass of the run that made the hop, in UTC. The next stage's run continues that pass. Always present; `null` when the pass cannot be dated. |
| `rule_name` | The rule the issue's next run dispatches on, which is `target_rule`. |
| `agent_kind`, `configured_model` | The agent kind and `model` a dispatch of `rule_name` resolves to under the configuration as of the latest poll tick. Each omitted when the configuration no longer names a rule with a stage label under that name, and `configured_model` also when the rule sets none. |
| `stage_position` | Always present. Where `rule_name` stands on its [stage chain](/reference/workflow-config/#stage-chains), or `null` when the rule is on no chain. See [dispatch time and stage position](#dispatch-time-and-stage-position). |

**`active[]` entries:** Every issue that `running`, `retrying`, `budget_exhausted`, `parked`, `pending_reactions`, or `between_stages` holds, once per issue. A client that shows one line per issue reads this list and merges, chooses, and orders nothing itself. The list is always present, `[]` when no issue is active. The six lists above and `counts` are unchanged, and `counts` has no `active` member: the length of `active` is the number of active issues.

An entry takes its values from the one row that decides the issue's `status`, as that row serves them, so a masked string stays masked. `status` is the name of that list and follows the precedence of [`GET /api/v1/{identifier}`](#get-apiv1identifier-issue-detail): `running`, else `retrying`, else `budget_exhausted`, else `parked`, else `pending_reactions`, else `between_stages`. An entry never reads `history`. For an issue in `pending_reactions` the deciding row is the first row whose `escalated_at` is not `null`; otherwise the `review` row whose `last_check.awaiting_approval` is `true`, when every other row reports nothing outstanding; otherwise the first row. A `ci` row reports nothing outstanding when its `last_check.status` is `passing`. A `bot-review` row does when its `last_check` holds no actionable comment or has `handled`. A `merge-conflict` row does when its `last_check.mergeable` is `true`. A `merge`, `merge-completion`, `label-review`, or `label-fix` row always does. A client that needs the rest of the issue's data finds the deciding row by `issue_id` in the list `status` names, and in `pending_reactions` also by `kind` equal to `reaction_kind`.

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
| `pr_loop` | Object or `null`. What each configured pull request reaction recorded in the entry's pass; see [pull request reaction history](#pull-request-reaction-history). Always present, and `null` when Sortie could not read reaction activity. |

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
| `spend_ceiling_reached` | A `spend_ceiling` window whose `holds_dispatch` is `true`; one item per holding window. | When the hold began, as the first poll tick or retry check that found it; a restart resets it | `critical` | `acknowledge` |
| `workflow_reload_failed` | `health.workflow.consecutive_failures` above `0`. | `health.workflow.failing_since` | `critical` | `acknowledge` |
| `preflight_failed` | `health.preflight.consecutive_failures` above `0`, unless the latest failed preflight failed because the workflow file did not load. | `health.preflight.failing_since` | `critical` | `acknowledge` |

A preflight that fails because the workflow file did not load yields no `preflight_failed` item, because the `workflow_reload_failed` item already names the cause. A `preflight_failed` item's `since` is when the preflight began failing, which can be earlier than the item's first appearance when the failing streak began on a workflow load. Both process-wide items are absent from a response that carries no `health` block.

A `reaction_escalated` item for a row rebuilt after a restart carries `open_issue` until a check reads the pull request's link, and then `open_pull_request`.

`evidence` members. A member is present exactly on the kinds named and absent on every other:

| Member | Kind | Value |
|---|---|---|
| `reason` | `parked`, `budget_held`, `spend_ceiling_reached` | The row's `reason`: `agent_blocked` or `handoff_absence`; `session_budget`, `token_budget`, or `money_budget`. For `spend_ceiling_reached`, `daily_spend_ceiling` or `monthly_spend_ceiling`. |
| `label` | `parked` | The row's `label`. |
| `used_sessions`, `budget_sessions` | `budget_held` with `session_budget` | The row's values. |
| `used_tokens`, `used_tokens_complete`, `budget_tokens` | `budget_held` with `token_budget` | The row's `used_tokens` (omitted when the row's is `null`) and `budget_tokens`. `used_tokens_complete` is `false` exactly when `used_tokens` is a lower bound. |
| `used_usd`, `used_usd_complete`, `budget_usd` | `budget_held` with `money_budget`, `spend_ceiling_reached` | For `money_budget`, the row's `used_usd` (omitted when the row's is `null`), `used_usd_complete`, and `budget_usd`. For `spend_ceiling_reached`, the window's values from `spend_ceiling`, always present. `used_usd_complete` is `false` exactly when `used_usd` is a lower bound. |
| `resets_at` | `spend_ceiling_reached` | The window's `resets_at`. |
| `reaction_kind`, `pull_request`, `escalation_trigger` | `reaction_escalated` | The row's `kind`, `pull_request`, and `escalation_trigger`, in the shapes the row serves. |
| `config_key` | `reaction_escalated`, `spend_ceiling_reached` | For `reaction_escalated`, the row's `config_key`. For `spend_ceiling_reached`, `agent.max_daily_cost_usd` or `agent.max_monthly_cost_usd`, the setting that raises the ceiling. |
| `used_attempts`, `max_attempts` | `reaction_escalated` | The row's values, each omitted when `null`. |
| `last_check` | `reaction_escalated` | The row's `last_check`, omitted when `null`. |
| `file` | `workflow_reload_failed` | `health.workflow.file`. |
| `error` | `workflow_reload_failed`, `preflight_failed` | The check's `error`, as `health` serves it. |

`reason_text`, `why_text`, and `clears_text` are English sentences that Sortie takes from the same table of wording as the [status sentences](#status-sentences), one template per park reason, per budget reason, per check, and per kind of escalating reaction. They follow the same rules: each states only a fact Sortie records, is masked like `issue_title`, and carries no clock time or date. It carries no cost either, except that the `why_text` of a `money_budget` hold states the issue's estimated cost against its ceiling, and the `why_text` of a spend ceiling item states the window's estimated cost against its ceiling, each prefixed `at least` when the cost is a lower bound. A part that cannot be rendered reads `Status not available`, and the item stays, so the list and its count never drop a cause. The `reason_text` of each kind:

| `kind` | `reason_text` |
|---|---|
| `parked` | `Parked: the agent needs a person` for `agent_blocked`; `Parked: no evidence of work` for `handoff_absence`. |
| `budget_held` | `Money budget reached` for `money_budget`; `Token budget reached` for `token_budget`; `Session budget reached` for `session_budget`. |
| `reaction_escalated` | `CI escalated on #<number>`, `Review comments escalated on #<number>`, `Bot review escalated on #<number>`, `Merge conflict escalated on #<number>`, `Auto-merge escalated on #<number>`, or `Merge completion escalated on #<number>`, by reaction kind. |
| `workflow_reload_failed` | `<file> failed to load`. |
| `spend_ceiling_reached` | `Daily spend ceiling reached` or `Monthly spend ceiling reached`, by window. |
| `preflight_failed` | `Dispatch preflight failed`. |

What clears each cause is the source's own rule, and `clears_text` words it. A park lifts when a person removes its label after Sortie has seen it there, or moves the issue to another tracker state. A hold leaves the set when a poll tick finds the issue no longer at a ceiling or among the candidates, for example after the ceiling is raised or removed. A reaction escalation ends on the facts under [standing escalations](/reference/reactions/#standing-escalations). A reload failure ends with the next load that succeeds, and a preflight failure with the next preflight that passes.

Items are ordered by `severity` (`critical` before `warning`), then by `since` (`null` first, then ascending), then by `id` ascending. The order is total, so the same state serves the same list. The `attention` array of the example above holds the failed reload first, because it is `critical`, then the park, the hold, and the CI escalation in the order of their `since`. It holds no `preflight_failed` item, because the preflight error is the load error.

#### Attention item IDs

`id` is the lowercase hexadecimal form of the first 16 bytes of the SHA-256 hash of the JSON array `[kind, part, ...]`, written without whitespace. The parts depend on the kind, with times in UTC:

| `kind` | Parts |
|---|---|
| `parked` | The issue ID; the park time cut to whole seconds in RFC 3339, or `""` when the stored time cannot be read. |
| `budget_held` | The issue ID; the `reason`; the ceiling the reason names as a decimal number, `budget_usd` for `money_budget`, `budget_tokens` for `token_budget`, and `budget_sessions` for `session_budget`. |
| `reaction_escalated` | The issue ID; the row's `kind`; `escalated_at` in RFC 3339 with nanoseconds, trailing zeros dropped. |
| `workflow_reload_failed` | `failing_since` in RFC 3339 with nanoseconds, trailing zeros dropped. |
| `preflight_failed` | `failing_since` in RFC 3339 with nanoseconds, trailing zeros dropped. |
| `spend_ceiling_reached` | The window, `daily` or `monthly`; the window's start in RFC 3339 UTC; the ceiling as a decimal number. |

A park keeps its `id` and `since` across a restart, because Sortie stores the park at whole-second precision. A hold, a spend ceiling hold included, keeps its `id` across a restart, but its `since` becomes the first poll tick after the restart, because Sortie keeps the moment a hold began in memory only. A reaction escalation keeps its `id` and `since` across a restart, because the restored escalation carries its stored time. A reload or preflight failure cannot span a restart, because startup exits when the first load or the startup preflight fails.

A recurrence changes a part, so an acknowledgement, which Sortie keeps under `id`, never hides a new cause: a new park has a new time, a hold reached again after a raise or under an edited ceiling has a new ceiling, a spend ceiling reached in a new window has a new window start, a different budget reason is a new reason, an escalation that ended and began again has a new time, and a failure after a pass has a new `failing_since`.

Sortie stores an acknowledgement, so it survives a restart for as long as the item exists. A poll tick that has read the candidate issues from the tracker deletes the acknowledgement of every item that no longer exists. A tick whose candidate read fails deletes none.

#### Pull request reaction history

`pr_loop` says what each configured pull request reaction recorded in one pass of an issue, so a client can show a reaction that is no longer pending, or never was. The pass is the issue's work under one `chain_id`. `pr_loop` is on each `active` entry, on `GET /api/v1/{identifier}`, and on each run of `GET /api/v1/runs`.

- On an `active` entry, and on the per-issue response of an issue that is live, it is the pass of the row that `status` names. For `pending_reactions` that is the first row whose `escalated_at` is not `null`, else the first row.
- On the per-issue response of an issue that only run history knows, it is the pass of the issue's newest run.
- On a run of `GET /api/v1/runs`, it is the pass the run's own `chain_id` names.

The value is an object with one member for each key of `config.reactions`, named as in `WORKFLOW.md`, and `{}` when `config.reactions` is empty. The `label_commands` member covers the review and fix label commands together. Each member holds two keys:

| Field | Type | Description |
|---|---|---|
| `result` | string | `escalated` when a kind of the reaction began an escalation in the pass, one that has since ended included. Otherwise `acted` when Sortie applied a triage verdict, merged the pull request, moved the issue after the merge, or scheduled a run for the reaction in the pass. Otherwise `quiet` when Sortie watched the pull request for the reaction and had nothing to act on. Otherwise `unrecorded`. |
| `continuations` | integer | The runs Sortie scheduled for the reaction in the pass, `0` when none. A run that a budget hold kept from starting still counts. |

`unrecorded` means Sortie has no record, which differs from `quiet`, where Sortie watched and found nothing to act on. Every member reads `unrecorded` for a pass with no `chain_id` or no `dispatched_at`, and for a pass that began before Sortie recorded reaction activity.

`pr_loop` is `null` when the server holds no run history or no workflow shape. The runs inside the groups of `GET /api/v1/runs/issues` and inside `history.runs` always serve `null`. When the read of reaction activity fails, `GET /api/v1/state` answers `200` with a `null` `pr_loop` on every entry, and `GET /api/v1/{identifier}` and `GET /api/v1/runs` answer `503` with `history_unavailable`.

#### Status sentences

Every row of `running`, `retrying`, `budget_exhausted`, `parked`, `pending_reactions`, and `between_stages` carries a pair of sentences that say in plain English what the issue is doing, what it waits on, or how it ended. Every entry of [`active`](#field-notes) carries the pair of its deciding row. The `poll` check of [`health`](#field-notes) carries one further sentence, `summary_text`, that follows the rules below. The per-issue response of [`GET /api/v1/{identifier}`](#get-apiv1identifier-issue-detail) carries the same pair on its rows and once for the issue, and every [`issue_outcome`](#issue-outcome) carries a pair too.

| Field | Type | Description |
|---|---|---|
| `status_text` | string | The short sentence, for a row or a lane. It ends without a period. |
| `status_text_full` | string | The long sentence, for an issue page. It ends with a period. |

- Both keys are always present and never empty. A sentence that cannot be rendered reads `Status not available`, and Sortie logs the failure.
- Sentences are English and are not translated.
- A sentence does not repeat what the response around it already shows. `status_text_full`, a [next outcome](#next-outcomes), and an attention item's `why_text` and `clears_text` never name the issue key: they say "the issue" or leave it implied. Only an operator action's `outcome_text`, which a client shows on its own, names the issue.
- Sortie renders a sentence on each request from the snapshot, the `config` this response serves, and run history. It stores none.
- A relative time such as `in 55s` is measured from the time the snapshot was generated, which `generated_at` serves on `GET /api/v1/state`. A sentence carries no clock time or date, and no cost.
- A figure Sortie does not have reads as `not measured`, never as `0`, and a token figure that is only a lower bound reads as `at least`.
- A running row names its stage only when its `stage_position` is not `null`.
- A sentence is masked like `issue_title`, so a value Sortie knows to be a secret reads `[redacted]`.
- A retry sentence that quotes the error of the run before it quotes the plain sentence the retry's `error` serves, not the stored text.
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

**`active_estimated_cost_usd`:** Estimated total cost across currently running sessions, computed from the rates in force: [`token_rates`](/reference/workflow-config/#token_rates) entries over the [price table](/reference/workflow-config/#price_table). Sessions whose `tokens_measured` is `false` are excluded. Omitted when no rate source is available, and when no running, measured session is priced. It equals the sum of `estimated_cost_usd` over the `running[]` entries whose `cost_status` is `"estimated"` or `"partial"`. This is a presentation-layer estimate, not provider billing data.

**`cost_unpriced_running`:** Count of running, measured sessions that `active_estimated_cost_usd` leaves out because no rate prices them. Present, zero included, whenever a rate source is available: a price table is in force, which is the default, or `token_rates` holds an entry. Omitted when no price table is in force and `token_rates` holds no entry (see [`price_table`](/reference/workflow-config/#price_table)); every measured `running[]` entry then reads `"unpriced"` while this key is absent. When present, it equals the number of `running[]` entries whose `cost_status` is `"unpriced"`. The dashboard shows cost exactly when this key is present.

**`spend_ceiling`:** The instance's spend against `agent.max_daily_cost_usd` and `agent.max_monthly_cost_usd`, as of the latest poll tick or retry check. Omitted while neither setting is above `0`. Otherwise an object with a `daily` and a `monthly` member, each `null` while its own setting is `0` and an object with these members while it is set:

| Member | Value |
|---|---|
| `budget_usd` | The ceiling, in US dollars. |
| `used_usd` | The window's estimated cost in US dollars: the cost recorded with every run that ended in the window plus the live estimate of the sessions running now. |
| `used_usd_complete` | `false` exactly when `used_usd` is a lower bound, because a run was not fully priced or its usage was not fully reported. |
| `holds_dispatch` | `true` while the window's spend has reached `budget_usd`, so Sortie starts no new agent session. |
| `resets_at` | The end of the window: the next 00:00 UTC, in RFC 3339 UTC. |

The windows are the current UTC calendar day and month, not the browser's local day. See [how to control agent costs](/guides/control-costs/#cap-what-the-whole-instance-spends).

**`rate_limits`:** Reserved for future use. Currently an empty object.

**`config`:** The workflow configuration in effect, so a client can tell which stages, dispatch rules, and pull request reactions the workflow has without reading `WORKFLOW.md`. Present on this endpoint only; `GET /api/v1/{identifier}` carries no `config`. It holds no credential: no tracker endpoint, API key, or query filter, no agent command, hook, workspace path, or database path, no notification destination, and no agent settings block. The strings it does carry (state names, labels, SSH host names, bot usernames) are served as written.

A member reports the `WORKFLOW.md` key of the same name. The derived members are `selected_by`, `agent_kind`, `usage_arrival`, `chains`, `hop_ceiling`, and `complete`. A setting that imposes no ceiling reads `null`, never `0`. An optional string is omitted when unset, and a list is `[]` when empty.

Most members follow the last successful load of `WORKFLOW.md`; a reload that fails validation leaves the previous values in place. Some members report what the running process applies instead. Sortie captures every reaction except `ci_failure` at startup, so until the next restart `config` omits a reaction a reload added and keeps listing one a reload removed; see [reactions](/reference/reactions/). The tracker adapter reads `tracker.kind` and `tracker.project` once at startup, so `config` keeps their startup values until the next restart. `token_rates` serves the rates in force, which a reload replaces from the next poll tick, keeping the previous rates of an entry the reload gives an invalid value; see the [`token_rates` reload behavior](/reference/workflow-config/#token_rates).

| Field | Description |
|---|---|
| `tracker.kind` | The tracker adapter kind the process started with. |
| `tracker.project` | The `tracker.project` the tracker adapter was built with, after environment resolution and unmasked: a Jira project key, a GitHub or Gitea `owner/repo`, a GitLab namespace path or numeric project ID, or a Linear team key. Omitted when unset. |
| `tracker.active_states`, `tracker.terminal_states` | The [`tracker`](/reference/workflow-config/#tracker) lists as written. |
| `tracker.in_progress_state`, `tracker.handoff_state`, `tracker.no_change_state` | The state Sortie writes at dispatch, after a successful run, and after a successful run whose agent declared that nothing needed changing. Each omitted when unset. |
| `polling.interval_ms` | The poll interval in milliseconds. |
| `agent.kind` | The workflow-wide agent kind. It serves every issue that no dispatch rule and no `dispatch.default` selects. |
| `agent.usage_arrival` | When sessions on the workflow-wide agent report token usage: `"incremental"`, `"turn_end"`, `"none"`, or `""` for a kind that declares nothing or is not registered. Resolved as a session resolves it at start, including the effect of SSH hosts; see [usage reporting by agent kind](/reference/workflow-config/#usage-reporting-by-agent-kind). |
| `agent.max_turns` | The most turns a session runs: `agent.max_turns`, or `1` when it is below `1`. |
| `agent.stall_timeout_ms` | Integer, or `null` when stall detection is off. |
| `agent.max_retry_backoff_ms` | The cap on retry backoff in milliseconds. |
| `agent.max_sessions`, `agent.max_tokens` | Integer, or `null` when the key is `0` or negative, which means no session budget or no token ceiling. A running row's `budget_sessions` and `budget_tokens` are the values as of the latest poll tick, so for up to one poll interval after a reload these members can differ from them. |
| `agent.max_cost_usd` | Number, or `null` when the key is `0`, which means no money ceiling. A running row's `budget_usd` is the value as of the latest poll tick, so for up to one poll interval after a reload this member can differ from it. |
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
| `token_rates` | A member per entry, keyed as written in [`token_rates`](/reference/workflow-config/#token_rates) by agent kind or model name, or `null` when `token_rates` is absent or empty. `null` does not mean nothing is priced: the price table can still price runs. |
| `token_rates.<key>.input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok` | Number, or `null` when the rate is not set or was rejected as invalid. An unset cache rate of a kind entry prices that token class at the input rate, and an unset rate of a model entry comes from the price table that lists the model; `config` serves the configured `null`, not the substituted rate. |
| `token_rates.<key>.complete` | `true` exactly when the entry prices on its own: `input_per_mtok` and `output_per_mtok` are both set for a kind entry, all four rates are set for a model entry. |
| `token_rates.<key>.per_kind` | `true` exactly when the key names a registered agent kind, so the entry prices every model of that kind alike. `false` for a model entry. |

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
| `poll` | One run per poll tick, whether the timer or `POST /api/v1/refresh` started it. `error` is the text of the latest failed read of candidate issues since the last successful poll. It can be present beside a `preflight_failed` outcome and absent beside a failing status. | `outcome`: `succeeded`, `tracker_failed` when the candidate read returned an error, or `preflight_failed` when the tick ended before the read because preflight failed. Omitted before the first poll. `next_poll_at`: when the poll timer fires next, in UTC, or `null` once shutdown stops it. A refresh does not move it. A value at or before `generated_at` means a poll is due or running. `summary_text`: the check in one English [status sentence](#status-sentences), always present. It reads `Sortie has not polled the tracker yet.` before the first poll and `The latest poll read the tracker without an error.` while the check passes. While it fails, it says that the latest poll stopped at the dispatch preflight or could not read the tracker, adds how many polls in a row failed when more than one did, and ends with how long ago the last successful poll was, or that none has succeeded since Sortie started. It carries no error text; that stays in `error`. |
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
| `status` | A run status | Runs whose `status` equals it: one of `"succeeded"`, `"failed"`, `"cancelled"`, `"ci_failed"`, `"needs_person"`, or `"budget_stopped"`. |
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
      "declared_outcome": null,
      "agent_text": null,
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
      "uncached_tokens": 31100,
      "tokens_measured": true,
      "unaccounted_turns": 0,
      "estimated_cost_usd": 0.1923,
      "cost_status": "estimated",
      "model_usage": [
        {
          "model": "claude-sonnet-4-20250514",
          "tokens": {
            "input_tokens": 52000,
            "output_tokens": 9100,
            "total_tokens": 61100,
            "cache_read_tokens": 30000,
            "cache_write_tokens": 4000
          },
          "uncached_tokens": 31100,
          "estimated_cost_usd": 0.1923,
          "cost_status": "estimated",
          "unrated_classes": []
        }
      ],
      "chain_id": "3c8v5n2w7r1t4y6u9i0o8p2asd",
      "stage_previous": "specify",
      "stage_previous_outcome": "succeeded",
      "stage_target": "review",
      "stage_result": "advanced",
      "stage_chain": ["specify", "implement"],
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
      "dispatch_id": "K2VD7QXN4MZB5TLH6RYC3PWJ2F",
      "skills": [{"skill": "ce-plan"}, {"skill": "ce-work", "tool_error": true}],
      "pr_loop": {"ci_failure": {"result": "acted", "continuations": 1}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
      "issue_outcome": {
        "kind": "merged",
        "observed_at": "2026-03-26T15:02:09Z",
        "merge_path": "auto_merge",
        "pull_request": {"number": 311, "repository": "acme/shop"},
        "status_text": "Merged #311",
        "status_text_full": "Ended merged: auto-merge merged PR #311."
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
| `display_identifier` | string | The qualified form of the identifier for trackers where the identifier alone is ambiguous, such as `"owner/repo#9"`. Omitted when empty. |
| `issue_title` | string | The issue title recorded with the run. Omitted when empty. Masked. |
| `issue_url` | string | The tracker's web link to the issue. Omitted when empty. Masked. |
| `attempt` | integer | One-based attempt number. |
| `status` | string | Terminal outcome of the run: `"succeeded"`, `"failed"`, `"cancelled"`, `"ci_failed"`, `"needs_person"`, or `"budget_stopped"`. `"budget_stopped"` is a session the per-issue token or money ceiling cancelled while it was still running; `error` then carries the figures behind the stop: the tokens used and the ceiling, or `money ceiling reached: used $X of $Y`. |
| `error` | string or `null` | The run's error message. `null` when the run recorded none. Masked. A withheld handoff, an agent error, and a worker stage error read as a plain sentence, such as `Sortie stopped the session before the agent finished turn 1.`, with any message the agent supplied kept after a colon; every other error is served as stored. |
| `declared_outcome` | string or `null` | The status the agent ended the run on: `"blocked"`, `"needs-human-review"`, or `"no-change-needed"`. It states what the agent declared, and `status` stays the disposition Sortie recorded, so a `needs-human-review` run whose handoff Sortie withheld reads `"failed"` with its declaration. `null` when the run ended on no recognized status, and for a run recorded before Sortie stored it. Never `""`. |
| `agent_text` | string or `null` | The agent's statement that came with the status in `declared_outcome`, after the cleanup described under [stop statement](/reference/agent-extensions/#stop-statement). `null` when the agent wrote none and whenever `declared_outcome` is `null`. Never `""`. Masked when Sortie serves it, so a value registered as a secret after the run is replaced too. |
| `rule_name` | string | The [dispatch rule](/reference/workflow-config/#dispatch) that routed the run. Omitted when none did. |
| `agent_kind` | string | The agent adapter kind that ran the session. Omitted when empty. |
| `configured_model`, `configured_effort` | string | What the run was asked to run, as in [configured and reported model](#configured-and-reported-model). Omitted when unset. |
| `model_name` | string | The model the runtime reported running. Omitted when it reported none. |
| `workflow_file` | string | The workflow file that drove the run. Omitted when empty. |
| `started_at`, `completed_at` | string | Timestamps as recorded. |
| `dispatched_at` | string or `null` | When Sortie dispatched the first run of the pass the run belongs to, as in [dispatch time and stage position](#dispatch-time-and-stage-position). `null` when the pass cannot be dated. |
| `turns_completed` | integer | Agent turns the run completed. |
| `tokens` | object | The five token members of a running row's `tokens`. Each member is `null` when `tokens_measured` is `false`. A measured zero is `0`. |
| `uncached_tokens` | integer or `null` | The run's tokens without cache reads: `tokens.total_tokens` less `tokens.cache_read_tokens`, floored at zero, so cache writes stay in it. A sibling of `tokens`, not a member of it. `null` exactly when `tokens_measured` is `false`. |
| `tokens_measured` | boolean | `false` when the agent reported no token usage for the run. |
| `unaccounted_turns` | integer | Turns of the run that reached the model without a token figure proven to cover the whole turn: the agent ended the turn before reporting its final usage, the report could not be read, or the figure rests on an estimated starting point after a resume. A turn that ended normally is left out when a later turn of the same run and session reports the session's running total, which includes it, unless a turn between them was stopped or failed after producing output, or rests on an estimated starting point. When non-zero, the figures in `tokens` are lower bounds. |
| `estimated_cost_usd` | number or `null` | The estimated USD cost recorded when the run finished, from `tokens` and the rates in force then for the run's models ([`token_rates`](/reference/workflow-config/#token_rates) entries over the [price table](/reference/workflow-config/#price_table)), unrounded. Never priced again, so a later edit of the rates does not change it. Non-`null` exactly when `cost_status` is `"estimated"` or `"partial"`. |
| `cost_status` | string | The status recorded with the cost. `"unmeasured"` when `tokens_measured` is `false`. `"estimated"` when the run has no unaccounted turns and either spent no tokens or every token class it spent was priced. `"partial"` when the estimate is a lower bound: the run has unaccounted turns and was priced or spent no tokens, or a token class it spent had no rate. `"unpriced"` when the run spent tokens and no rate priced any of them when it finished, or the run reported its spend only as a total. |
| `model_usage` | array | The run's spend split by model, one element per model the run spent tokens on, ordered by `model`. Always present, never `null`. `[]` when the run recorded no per-model spend: an unmeasured run, a run that spent nothing, and a run that reported only a total with no split by token class. See [`model_usage` elements](#model_usage-elements). |
| `chain_id` | string | The stage chain the run belongs to. Omitted when empty. |
| `stage_previous`, `stage_previous_outcome` | string | The rule whose hop led to the run, and the outcome of the run that made it. Omitted when empty. |
| `stage_target`, `stage_result` | string | The rule the run's own hop decision targeted, and its result: `"advanced"`, `"partial"`, `"failed"`, or `"ceiling"`. Omitted when the run reached no decision. |
| `stage_chain` | array of string or `null` | The stage chain the run's rule stands on, as the rule names of the chain in `next` order: the chain `stage_position.chain` serves for the run's `rule_name` and `stage_previous`. It follows the configuration in effect, so a reload that edits the chains changes it for runs recorded before the reload. Always present. `null` when the run has no `rule_name`, when its rule is on no chain, and when the server holds no workflow shape. Not masked. |
| `self_review` | object or `null` | `null` when the run recorded no self-review or the record cannot be read. Otherwise `final_verdict` (`"none"` when the record holds no verdict; masked), `total_iterations`, and `cap_reached`. The per-iteration audit trail is not served. |
| `origin_recorded` | boolean | `false` for a run recorded before Sortie stored its origin. The five origin members below are then `null`. |
| `trigger` | string or `null` | What started the retry whose fire dispatched the run: `"error"`, `"continuation"`, `"stall"`, or `"ci_fix"`. A CI fix retry reads `"ci_fix"`, and a retry of a run a reaction dispatched keeps that run's `reaction_kind` with its own trigger. `""` for a dispatch from the poll tick, for a retry that a review, bot review, merge conflict, or label command reaction started, and for a recorded CI result. `null` when the retry was queued before Sortie stored what started it. |
| `reaction_kind` | string or `null` | The reaction kind of the retry that dispatched the run, using the values of a retrying entry's `reaction_kind`. `""` when none. |
| `reaction_config_key` | string or `null` | The key of the `reactions` section of `WORKFLOW.md` that `reaction_kind` is configured under. `""` when `reaction_kind` is empty. |
| `session_id` | string or `null` | The agent session the run used. `""` when it started none. Not masked. |
| `ssh_host` | string or `null` | The SSH worker the run executed on. `""` for a local run. |
| `dispatch_id` | string or `null` | The run's dispatch ID, the `dispatch_id` its running row carried. Pass it to [`GET /api/v1/runs/{dispatch_id}/events`](#get-apiv1runsdispatch_idevents-run-events) to read the run's agent events. `""` on a recorded CI result, and `null` on a run recorded before Sortie stored dispatch IDs. A run with either has no agent events. |
| `pr_loop` | object or `null` | What each configured pull request reaction recorded in the pass the run's `chain_id` names; see [pull request reaction history](#pull-request-reaction-history). Always present, and `null` on a run inside an issue group or `history.runs`. |
| `skills` | array of object | Every skill call of the run, in completion order, repeats included and with no limit. Each element holds `skill`, the skill name, and `tool_error` as `true` when the call failed. Omitted when the run made no skill call, when its agent reports none, and for a run recorded before Sortie kept the list. The list stays complete when the run's oldest events are no longer kept. |
| `issue_outcome` | object or `null` | How the run's issue ended. The same object on every run of the issue. `null` when Sortie has not seen the issue end. See [Issue outcome](#issue-outcome). |

A run whose agent ended it with a status carries both members, shown here as the fields that differ. Such a run keeps the disposition Sortie recorded in `status`:

```json
{
  "status": "succeeded",
  "error": null,
  "declared_outcome": "blocked",
  "agent_text": "The ticket asks for both soft and hard delete of invoices.\nWhich one should the API expose?"
}
```

#### `model_usage` elements

Each element is one model's part of the run's spend. It carries no price source and no price table version.

| Field | Type | Description |
|---|---|---|
| `model` | string | The model the tokens were spent on, as the runtime named it. `""` when it named none. Not masked. |
| `tokens` | object | The five token members of a running row's `tokens`, for this model. No member is `null`, and `total_tokens` is `input_tokens` plus `output_tokens`. |
| `uncached_tokens` | integer | `tokens.total_tokens` less `tokens.cache_read_tokens`, floored at zero. |
| `estimated_cost_usd` | number or `null` | The USD cost recorded for this model's part, unrounded and never priced again. Non-`null` exactly when `cost_status` is `"estimated"` or `"partial"`. |
| `cost_status` | string | `"estimated"`, `"partial"` when a token class the model spent has no rate, or `"unpriced"`. A part recorded without a price reads `"unpriced"` with a `null` cost. |
| `unrated_classes` | array or `null` | The token classes whose missing rate left the part `"partial"` or `"unpriced"`, from `input`, `output`, `cache_read`, and `cache_write`, in that order. `[]` when the part names none. `null` when the part records no classes, because it has no recorded price or was priced before the classes were kept; `null` never means `[]`. |

A `status` of `"ci_failed"` marks a recorded CI result rather than an agent session: it has no `agent_kind`, and each origin member and `dispatch_id` is `""`.

#### Model and effort of a completed run

Each completed run also stores the settings it ran with, in three text columns of `run_history`: `configured_model` and `configured_effort` (what the attempt was asked to run) and `reported_model` (what the runtime reported running). [Configured and reported model](#configured-and-reported-model) explains how to read the pair. This route serves them as `configured_model`, `configured_effort`, and `model_name`, each omitted when empty:

```sh
curl -s 'http://localhost:7678/api/v1/runs?limit=5' | jq '.runs[] | {issue_identifier, configured_model, configured_effort, model_name}'
```

The columns can also be read from the database directly:

```sh
sqlite3 .sortie.db "SELECT identifier, configured_model, configured_effort, reported_model FROM run_history ORDER BY started_at DESC LIMIT 5"
```

An unset value is an empty string, not `NULL`. All three columns are empty on runs recorded before Sortie stored them and on `ci_failed` rows. [`sortie stats`](/reference/cli/#model-breakdown) groups runs by the model they spent tokens on and, for a run with no spend by model, by the reported model, else the configured one; it does not read `configured_effort`.

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

## GET /api/v1/runs/issues: Run history by issue

Returns run history grouped by issue, one page of issues at a time. The issue with the newest matching run comes first, and each issue carries its newest runs, its totals, and the sentence that says what it is doing now or how it ended. [`GET /api/v1/runs`](#get-apiv1runs-run-history) lists runs, so one busy issue can fill a page; this route lists issues.

```sh
curl 'http://localhost:7678/api/v1/runs/issues?status=failed&limit=10'
```

### Query parameters

Every parameter is optional. An empty value is the same as an absent one. Filters combine with AND and match exactly, case included. An issue is selected when at least one of its runs matches every filter.

| Parameter | Value | Selects |
|---|---|---|
| `issue` | An issue key | Issues with a run whose `issue_identifier` or `display_identifier` equals it, so `MT-649` and the qualified form `owner/repo#9` both work. |
| `rule` | A dispatch rule name, or `<none>` | Issues with a run whose `rule_name` equals it. `<none>` selects the runs that record no rule name. |
| `status` | A run status | Issues with a run whose `status` equals it: one of `"succeeded"`, `"failed"`, `"cancelled"`, `"ci_failed"`, `"needs_person"`, or `"budget_stopped"`. |
| `stage` | A dispatch rule name | Issues with a run whose exit reached a stage hop decision that targeted that rule, whatever its result. |
| `cursor` | A `next_cursor` value | Issues whose newest matching run was recorded before the run `cursor` names, and which have no matching run at or after it. An integer of at least `1`. |
| `limit` | An integer from `1` to `50` | The page size, in issues. Default: `20`. |

The parameters of `GET /api/v1/runs` that select by run id, completion time, or issue ending (`issue_id`, `since`, `until`, `ended_since`, `ended_until`) are not accepted here.

Sortie checks every parameter before it reads anything. A parameter outside this table, a parameter given more than once, and a value outside the ranges above answer `400`, so a misspelled filter never returns unfiltered issues.

### Response

```json
{
  "groups": [
    {
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "issue_title": "Fix the flaky login test",
      "issue_url": "https://tracker.example.com/browse/MT-649",
      "status": "history",
      "status_text": "Merged #311",
      "status_text_full": "Ended merged: auto-merge merged PR #311.",
      "issue_outcome": {
        "kind": "merged",
        "observed_at": "2026-03-26T15:02:09Z",
        "merge_path": "auto_merge",
        "pull_request": {"number": 311, "repository": "acme/shop"},
        "status_text": "Merged #311",
        "status_text_full": "Ended merged: auto-merge merged PR #311."
      },
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
          "declared_outcome": null,
          "agent_text": null,
          "rule_name": "implement",
          "agent_kind": "claude-code",
          "configured_model": "claude-sonnet-4-5",
          "started_at": "2026-03-26T14:10:12Z",
          "completed_at": "2026-03-26T14:31:47Z",
          "dispatched_at": "2026-03-26T13:48:20Z",
          "turns_completed": 8,
          "tokens": {
            "input_tokens": 52000,
            "output_tokens": 9100,
            "total_tokens": 61100,
            "cache_read_tokens": 30000,
            "cache_write_tokens": 4000
          },
          "uncached_tokens": 31100,
          "tokens_measured": true,
          "unaccounted_turns": 0,
          "estimated_cost_usd": 0.1923,
          "cost_status": "estimated",
          "model_usage": [
            {
              "model": "claude-sonnet-4-5",
              "tokens": {
                "input_tokens": 52000,
                "output_tokens": 9100,
                "total_tokens": 61100,
                "cache_read_tokens": 30000,
                "cache_write_tokens": 4000
              },
              "uncached_tokens": 31100,
              "estimated_cost_usd": 0.1923,
              "cost_status": "estimated",
              "unrated_classes": []
            }
          ],
          "self_review": null,
          "origin_recorded": true,
          "trigger": "",
          "reaction_kind": "",
          "reaction_config_key": "",
          "session_id": "session-abc-002",
          "ssh_host": "",
          "dispatch_id": "K2VD7QXN4MZB5TLH6RYC3PWJ2F",
          "stage_chain": ["specify", "implement"],
          "pr_loop": null,
          "issue_outcome": {
            "kind": "merged",
            "observed_at": "2026-03-26T15:02:09Z",
            "merge_path": "auto_merge",
            "pull_request": {"number": 311, "repository": "acme/shop"},
            "status_text": "Merged #311",
            "status_text_full": "Ended merged: auto-merge merged PR #311."
          },
          "chain_id": "3c8v5n2w7r1t4y6u9i0o8p2asd",
          "stage_previous": "specify",
          "stage_previous_outcome": "succeeded",
          "stage_target": "review",
          "stage_result": "advanced"
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
        "uncached_tokens": 31100,
        "tokens_complete": true,
        "estimated_cost_usd": 0.1923,
        "cost_status": "estimated"
      }
    }
  ],
  "next_cursor": "42"
}
```

`groups` is `[]` when no issue matches.

### Field notes

Groups are ordered by the `run_id` of each issue's newest matching run, descending. `next_cursor` is `null` on the last page. Otherwise it is that `run_id` for the page's last group, as a string; pass it back as `cursor` together with the same filters to read the next page. Every issue appears once in a traversal, and a run recorded between two requests never moves a served issue to another page.

**Group fields:**

| Field | Type | Description |
|---|---|---|
| `issue_id` | string | The tracker's issue ID. |
| `issue_identifier` | string | The issue identifier of the issue's newest run. |
| `display_identifier` | string | The qualified form of the identifier for trackers where the identifier alone is ambiguous, such as `"owner/repo#9"`. Omitted when empty. |
| `issue_title` | string | The issue title recorded with the issue's newest run. Omitted when empty. Masked. |
| `issue_url` | string | The tracker's web link to the issue, from the same run. Omitted when empty. Masked. |
| `status` | string | What the issue is doing now: one of the live values of `status` in [`GET /api/v1/{identifier}`](#get-apiv1identifier-issue-detail), or `"history"` when the issue is not active and only run history knows it. |
| `status_text`, `status_text_full` | string | The issue's [status sentences](#status-sentences), the pair `GET /api/v1/{identifier}` serves for it. For `"history"` they word how the issue ended. |
| `issue_outcome` | object or `null` | How the issue ended, or `null` when Sortie has not seen it end. See [Issue outcome](#issue-outcome). |
| `runs` | array of object | The issue's newest matching runs, newest first, at most 5. Each has the shape of a run under [`GET /api/v1/runs`](#get-apiv1runs-run-history). None is newer than the issue's newest matching run. |
| `next_cursor` | string or `null` | `null` when `runs` holds every matching run of the issue. Otherwise the `run_id` of the last run in `runs`, as a string; pass it as `cursor` to `GET /api/v1/runs` with `issue_id` set to this group's `issue_id` and the same `rule`, `status`, and `stage` to read the rest. |
| `totals` | object | The issue's spend over all of its runs, whatever the filters select. It has the members of `totals` in the [history member](#history-member). |

The filters narrow `runs` to the matching runs, but `issue_identifier`, the title, the link, and `totals` describe the issue as a whole.

### Status codes

| Code | Error code | Meaning |
|---|---|---|
| `200 OK` | | Page returned. |
| `400 Bad Request` | `invalid_parameter` | Unknown or repeated parameter, or a malformed or out-of-range value. The message names the parameter and the rule, for example `parameter "limit" must be an integer from 1 to 50`. |
| `405 Method Not Allowed` | `method_not_allowed` | Any method other than `GET`. |
| `503 Service Unavailable` | `snapshot_unavailable` | The orchestrator state snapshot could not be produced. |
| `503 Service Unavailable` | `history_unavailable` | Run history or the issue outcomes could not be read. |

---

## GET /api/v1/runs/{dispatch_id}/events: Run events

Returns the agent events Sortie kept for one run, oldest first, each with a plain English sentence. `{dispatch_id}` is the `dispatch_id` of a [running row](#field-notes) or of a [run](#get-apiv1runs-run-history), as one path segment. The route takes no parameters and ignores the query string. To receive the same events as they arrive, name the run in the `run` parameter of [`GET /api/v1/events`](#get-apiv1events-change-signals-and-agent-events).

```sh
curl http://localhost:7678/api/v1/runs/RLQFSIOFERWGDW2HZY45W55VXK/events
```

### Response

```json
{
  "dispatch_id": "RLQFSIOFERWGDW2HZY45W55VXK",
  "first_seq": 1,
  "events": [
    {
      "seq": 1,
      "at": "2026-03-26T14:10:14Z",
      "event": "session_started",
      "message": "",
      "session_id": "session-abc-001",
      "text": "Session started."
    },
    {
      "seq": 41,
      "at": "2026-03-26T14:29:31Z",
      "event": "tool_result",
      "message": "",
      "tool_name": "Bash",
      "tool_kind": "shell",
      "tool_argument": "go test ./...",
      "duration_ms": 2400,
      "tool_error": false,
      "text": "Ran go test ./... in 2.4s.",
      "tool_line": "go test ./..."
    },
    {
      "seq": 42,
      "at": "2026-03-26T14:29:59Z",
      "event": "turn_completed",
      "message": "Working on tests",
      "usage": {
        "input_tokens": 12500,
        "output_tokens": 3200,
        "total_tokens": 15700,
        "cache_read_tokens": 8400,
        "cache_write_tokens": 1200
      },
      "text": "Turn completed: Working on tests."
    }
  ]
}
```

The example leaves out events 2 to 40.

### Field notes

| Field | Type | Description |
|---|---|---|
| `dispatch_id` | string | The dispatch ID from the path. |
| `first_seq` | integer or `null` | The `seq` of the first event served. A value above `1` means the run's earlier events were dropped while it ran. `null` when `events` is `[]`, which only a running run that has kept no event yet serves. |
| `events` | array of object | The events, oldest first. |

**Event members:**

| Member | Present on | Description |
|---|---|---|
| `seq` | Every event | The event's number within the run, from `1`, rising by one per kept event. Dropping old events never renumbers the rest. |
| `at` | Every event | When the event arrived, in UTC. |
| `event` | Every event | The event type, one of the types every agent adapter maps its output to, such as `session_started`, `tool_result`, or `turn_completed`. |
| `message` | Every event | The event's message, `""` when it carries none. A message longer than 999 characters is cut to its first 999 followed by `…`. Masked when Sortie keeps it and again when it serves it, so a value registered as a secret after the event was kept also reads `[redacted]`. |
| `text` | Every event | One sentence that says what happened, worded by Sortie when it serves the event and never stored. The `text` of a `notification` or an `other_message` is the message itself. The `text` of a `tool_result` is `Ran` followed by its `tool_line`, then `in` and the duration when the event has one, and `; it returned an error` when the call failed. A `startup_failed` event reads `The session failed to start: <error>.` |
| `session_id` | `session_started` | The agent session the run started. `""` when the event carries none. |
| `tool_name` | `tool_result` | The name the agent runtime gives the tool, or `{server}.{tool}` for an MCP or dynamic tool, such as `github.get_issue`. Omitted when the runtime names none. It is never a command. Masked. |
| `tool_kind` | `tool_result` | `shell`, `read`, `edit`, or `skill`. Omitted for any other tool and for an event kept before Sortie recorded it. |
| `tool_argument` | `tool_result` | The call's one main argument: a shell call's command without its `bash -lc`, `sh -c`, or `zsh -c` wrapper, a read or edit call's path relative to the workspace (several paths joined by `, `), a skill call's skill name. Control characters become spaces, a value registered as a secret reads `[redacted]` also when it was registered after Sortie kept the event, and a value longer than 999 characters is cut to its first 999 followed by `…`. No other argument of a call is served. Omitted when the call has none, when `tool_kind` is omitted, and for an event kept before Sortie recorded it. |
| `tool_line` | `tool_result` | The call as one line of text: a shell call's command; otherwise the tool's name followed by its main argument, such as `Read internal/foo.go`; otherwise the name alone. When the runtime names no tool, `Command`, `Read`, `Edit`, `Skill`, or `Tool` stands in for the name, by `tool_kind`. Built from the masked `tool_name` and `tool_argument`. Omitted on every other event. |
| `duration_ms` | `tool_result` | How long the tool call took, in milliseconds. Omitted when the adapter reported none. |
| `tool_error` | `tool_result` | Whether the tool call returned an error. |
| `usage` | `turn_completed`, `turn_failed`, `turn_cancelled`, `turn_ended_with_error`, `turn_input_required` | The run's token totals after the event, with the members of a running row's `tokens`. `null` while the run has measured no usage, so unmeasured spend never reads as zero. |

### What Sortie keeps

Sortie keeps every agent event of a run except these:

- a `notification` or `other_message` whose message is blank, which is how an agent shows it is alive and how an adapter reports a frame that has no text for a person;
- `token_usage`, whose totals appear in `usage` on the turn-ending events instead;
- a `notification`, `other_message`, or `malformed` event whose type and message equal those of the newest event Sortie kept for the run.

An event Sortie does not keep still moves the running row's `last_event_at`.

When a session fails to start and its agent reported no `startup_failed` event, Sortie adds one whose message is the start error. A start that Sortie itself stopped gets none.

| While | Where the events live | Limit |
|---|---|---|
| The run is running | Memory | The newest 1,000 events, within 256 KiB. The oldest are dropped first, which raises `first_seq`. |
| The run has ended | The database, written once with the run's run history record | At least 365 days after the run completed, and 2 GiB across all runs. |

Sortie prunes stored events only when it writes a later run's events. Each write first removes the events of at most four runs that completed more than 365 days before the run being written, then removes whole runs, oldest first, until the stored events of every run fit in 2 GiB. It never removes the run it is writing. Events older than 365 days can therefore stay until later writes reach them. For what this means for the size of the database file, see [what Sortie persists](/concepts/persistence/#what-sortie-persists-and-why).

If the events of a finished run cannot be written, its run history record is stored without them. Sortie keeps the events in memory, at most 4 MiB across all such runs, dropping the oldest run's events first, and retries the write up to five times, waiting 4, 8, 16, 32, and 64 seconds before the successive tries. Events that the last try fails to write, or that are still waiting when Sortie stops, are lost, and Sortie logs `dropped run events` at `warn`. A crash loses the events of every run in flight, together with their run history records.

### Status codes

| Code | Error code | Meaning |
|---|---|---|
| `200 OK` | | Events returned. |
| `404 Not Found` | `run_events_not_retained` | Sortie has no events for the dispatch ID: no run carries it, the run kept no event, its events were pruned, not yet written or lost, or the run was recorded before Sortie stored dispatch IDs. |
| `405 Method Not Allowed` | `method_not_allowed` | Any method other than `GET`. |
| `503 Service Unavailable` | `history_unavailable` | The run is not running, and run history could not be read. |

---

## GET /api/v1/stats: Run statistics

Returns the report that [`sortie stats --format json`](/reference/cli/#stats) prints: run and issue counts, success rate, duration percentiles, token sums, and estimated cost over the runs completed in a range, with that cost per UTC day or month and breakdowns by outcome, coding agent, dispatch rule, prompt template, model, stage chain, retry trigger, and run origin, with the skill calls of the runs, and a funnel for each stage chain. The [stage funnels](/reference/cli/#stage-funnels) hold the passes running, queued for a retry, or held by a budget at the time of the request. The route and the command share one aggregation, so for one database and absolute bounds the two bodies differ only in `generated_at`, apart from the dispatch-rule difference [described below](#pricing-and-reload).

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

The body is compact JSON with the shape of the command's `--format json` output. [Output formats](/reference/cli/#output-formats) in the CLI reference defines every field, including `summary.issues`, `spend`, `by_model`, `by_trigger`, and `by_origin`. The example is for a workflow that defines no stage chain, so `by_chain` and `chain_funnels` are `[]`, and it lists one group in each breakdown that is not split by outcome or trigger. `summary` also holds `failed`, `stopped`, and `cancelled`, the runs by outcome, which add up to `runs` with `succeeded`. Every `tokens` object carries `uncached`, `total` less `cache_read`, so `uncached` plus `cache_read` equals `total`.

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
    "failed": 2,
    "stopped": 0,
    "cancelled": 1,
    "success_rate": 0.5,
    "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
    "mean_turns_succeeded": 4,
    "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
    "cost_usd": 19.52,
    "cost_per_succeeded_run_usd": 6.506666667,
    "zero_duration_runs": 1,
    "duration_excluded_runs": 1,
    "cost_unpriced_runs": 1,
    "cost_partial_runs": 1,
    "tokens_unmeasured_runs": 1
  },
  "spend": {
    "period": "day",
    "buckets": [
      {"start": "2026-02-23T00:00:00Z", "runs": 2, "cost_usd": 7.27, "tokens_unmeasured_runs": 1, "cost_unpriced_runs": 0, "cost_partial_runs": 0},
      {"start": "2026-02-24T00:00:00Z", "runs": 4, "cost_usd": 12.25, "tokens_unmeasured_runs": 0, "cost_unpriced_runs": 1, "cost_partial_runs": 1}
    ]
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
      "tokens": {"input": 3500000, "output": 700000, "total": 4200000, "cache_read": 50000, "cache_write": 10000, "uncached": 4150000},
      "cost_usd": 17.87,
      "cost_per_succeeded_run_usd": 5.956666667,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
    },
    {
      "name": "failed",
      "runs": 2,
      "succeeded": 0,
      "success_rate": 0,
      "share": 0.3333,
      "duration_seconds": {"p50": 600, "p95": 900, "mean": 750, "samples": 2},
      "mean_turns": 3,
      "tokens": {"input": 300000, "output": 50000, "total": 350000, "cache_read": 0, "cache_write": 0, "uncached": 350000},
      "cost_usd": 1.65,
      "cost_per_succeeded_run_usd": null,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
    },
    {
      "name": "cancelled",
      "runs": 1,
      "succeeded": 0,
      "success_rate": 0,
      "share": 0.1667,
      "duration_seconds": {"p50": 0, "p95": 0, "mean": 0, "samples": 1},
      "mean_turns": 0,
      "tokens": {"input": 100000, "output": 10000, "total": 110000, "cache_read": 0, "cache_write": 0, "uncached": 110000},
      "cost_usd": null,
      "cost_per_succeeded_run_usd": null,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 0
    }
  ],
  "by_adapter": [
    {
      "name": "claude-code",
      "runs": 6,
      "succeeded": 3,
      "success_rate": 0.5,
      "share": 1,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 3.5,
      "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
      "cost_usd": 19.52,
      "cost_per_succeeded_run_usd": 6.506666667,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 1
    }
  ],
  "by_rule": [
    {
      "name": "implement",
      "runs": 6,
      "succeeded": 3,
      "success_rate": 0.5,
      "share": 1,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 3.5,
      "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
      "cost_usd": 19.52,
      "cost_per_succeeded_run_usd": 6.506666667,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 1
    }
  ],
  "by_template": [
    {
      "name": "default",
      "runs": 6,
      "succeeded": 3,
      "success_rate": 0.5,
      "share": 1,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 3.5,
      "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
      "cost_usd": 19.52,
      "cost_per_succeeded_run_usd": 6.506666667,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 1
    }
  ],
  "by_model": [
    {
      "name": "claude-sonnet-4-5",
      "runs": 6,
      "succeeded": 3,
      "success_rate": 0.5,
      "share": 1,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 3.5,
      "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
      "cost_usd": 19.52,
      "cost_per_succeeded_run_usd": 6.506666667,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 1
    }
  ],
  "by_chain": [],
  "chain_funnels": [],
  "by_trigger": [
    {
      "name": "<unknown>",
      "runs": 4,
      "succeeded": 2,
      "success_rate": 0.5,
      "share": 0.6667,
      "duration_seconds": {"p50": 600, "p95": 1200, "mean": 700, "samples": 3},
      "mean_turns": 2.5,
      "tokens": {"input": 1800000, "output": 350000, "total": 2150000, "cache_read": 50000, "cache_write": 10000, "uncached": 2100000},
      "cost_usd": 7.52,
      "cost_per_succeeded_run_usd": 3.76,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 1
    },
    {
      "name": "<none>",
      "runs": 1,
      "succeeded": 0,
      "success_rate": 0,
      "share": 0.1667,
      "duration_seconds": {"p50": 0, "p95": 0, "mean": 0, "samples": 1},
      "mean_turns": 0,
      "tokens": {"input": 100000, "output": 10000, "total": 110000, "cache_read": 0, "cache_write": 0, "uncached": 110000},
      "cost_usd": null,
      "cost_per_succeeded_run_usd": null,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 0
    },
    {
      "name": "ci_fix",
      "runs": 1,
      "succeeded": 1,
      "success_rate": 1,
      "share": 0.1667,
      "duration_seconds": {"p50": 1800, "p95": 1800, "mean": 1800, "samples": 1},
      "mean_turns": 5,
      "tokens": {"input": 2000000, "output": 400000, "total": 2400000, "cache_read": 0, "cache_write": 0, "uncached": 2400000},
      "cost_usd": 12,
      "cost_per_succeeded_run_usd": 12,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
    }
  ],
  "by_origin": [
    {
      "name": "poll_tick",
      "runs": 6,
      "succeeded": 3,
      "success_rate": 0.5,
      "share": 1,
      "duration_seconds": {"p50": 1200, "p95": 1800, "mean": 1200, "samples": 3},
      "mean_turns": 3.5,
      "tokens": {"input": 3900000, "output": 760000, "total": 4660000, "cache_read": 50000, "cache_write": 10000, "uncached": 4610000},
      "cost_usd": 19.52,
      "cost_per_succeeded_run_usd": 6.506666667,
      "tokens_unmeasured_runs": 1,
      "cost_unpriced_runs": 1,
      "cost_partial_runs": 1
    }
  ],
  "self_review": {
    "runs_with_metadata": 0,
    "by_final_verdict": [],
    "cap_reached_runs": 0,
    "mean_iterations": null,
    "unparsed_runs": 0
  }
}
```

`since` and `until` echo the resolved bounds in UTC, `null` when open. `generated_at` is the instant of the request, and a duration bound counts back from it.

### Pricing and reload

The route prices nothing. It reads the cost recorded with each run, as `sortie stats` does, so the two report the same cost for the same range whatever the [rates](/reference/workflow-config/#token_rates) are now. `warnings` carries no `token_rates` advisory; `sortie validate` and the service log report those.

The route builds the funnels from the `dispatch` rules in force at the time of the request, so it follows a reload of the workflow. `sortie stats` reads the workflow file each time it runs, so after an edit of the `dispatch` section the command shows the new chains before the process has reloaded it.

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

## GET /api/v1/prices: Prices in force

Returns the rates in force when the request is served, per agent kind and model, with the layer each rate comes from and the state of every price source. It is the data behind the [dashboard's Prices screen](/reference/dashboard/#prices). The route states rates and prices no run: a run keeps the cost recorded when it finished. See [`price_table`](/reference/workflow-config/#price_table) and [`token_rates`](/reference/workflow-config/#token_rates) for the layers.

```sh
curl http://localhost:7678/api/v1/prices
```

The route ignores query parameters and writes nothing.

### Response

The body is compact JSON. The example is trimmed to one model priced from two layers and one model no layer prices.

```json
{
  "generated_at": "2026-02-24T20:15:30Z",
  "table_in_force": {"layer": "fetched", "as_of": "2026-02-24T04:00:12Z", "age_days": 0},
  "token_rates": {"kind_entries": 0, "model_entries": 1, "version": "sha256:3b1f0c8d5a7e2f94b6c1d8e0a3f5b7c9d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a1"},
  "operator": null,
  "fetched": {
    "status": "loaded",
    "in_force": true,
    "off_by": null,
    "file": null,
    "address": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    "version": "sha256:8d2a6c4e0b1f3a5c7e9d1b3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c1e3b5d7f9a0c",
    "as_of": "2026-02-24T04:00:12Z",
    "models": 2315,
    "next_try_at": "2026-02-25T04:00:12Z",
    "failures": 0,
    "failed_at": null,
    "error": null
  },
  "embedded": {
    "status": "loaded",
    "in_force": true,
    "off_by": null,
    "file": null,
    "address": null,
    "version": "9f3c2e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e",
    "as_of": "2026-02-20T11:42:07Z",
    "models": 2290,
    "next_try_at": null,
    "failures": 0,
    "failed_at": null,
    "error": null
  },
  "models": [
    {
      "agent_kind": "claude-code",
      "model": "claude-sonnet-4-5",
      "table_key": "claude-sonnet-4-5",
      "layer": "model_entry",
      "entry_key": "claude-sonnet-4-5",
      "input": {"per_mtok": 2.7, "layer": "model_entry", "from_input": false},
      "output": {"per_mtok": 15, "layer": "fetched", "from_input": false},
      "cache_read": {"per_mtok": 0.3, "layer": "fetched", "from_input": false},
      "cache_write": {"per_mtok": 3.75, "layer": "fetched", "from_input": false},
      "cost_status": "estimated",
      "unrated_classes": [],
      "last_used_at": "2026-02-24T19:58:41Z",
      "runs": 12
    },
    {
      "agent_kind": "codex",
      "model": "acme-1",
      "table_key": null,
      "layer": null,
      "entry_key": null,
      "input": {"per_mtok": null, "layer": null, "from_input": false},
      "output": {"per_mtok": null, "layer": null, "from_input": false},
      "cache_read": {"per_mtok": null, "layer": null, "from_input": false},
      "cache_write": {"per_mtok": null, "layer": null, "from_input": false},
      "cost_status": "unpriced",
      "unrated_classes": ["input", "output", "cache_read", "cache_write"],
      "last_used_at": null,
      "runs": 0
    }
  ]
}
```

### Field notes

Times are RFC 3339 in UTC. A time that is unknown, a string that is empty, and the model count of a source that holds no table are `null`.

**Top-level members:**

| Field | Type | Description |
|---|---|---|
| `generated_at` | string | The instant of the request. |
| `table_in_force` | object or `null` | The highest-precedence price table in force: `layer` (`operator_table`, `fetched`, or `embedded`), `as_of` (the date of its prices), and `age_days` (whole days from `as_of` to `generated_at`, never below `0`). `null` while no price table is in force. A model takes its rates from the first table that lists it, so a lower table can price a name this one lacks. |
| `token_rates` | object | `kind_entries` and `model_entries`, the number of [`token_rates`](/reference/workflow-config/#token_rates) entries in force by kind and by model, and `version`, the digest of those entries, `null` when there are none. |
| `operator` | object or `null` | The state of your own table, in the source shape below. `null` unless `price_table.replace_file` or `price_table.replace_url` is set. |
| `fetched` | object | The state of the shared table downloaded from `price_table.fetch_url`. |
| `embedded` | object | The state of the table built into the binary. |
| `models` | array of object | One row per agent kind and model, below. `[]` when there are none. |

**A price source** (`operator`, `fetched`, and `embedded`):

| Field | Type | Description |
|---|---|---|
| `status` | string | `off`, `not_loaded`, `loaded`, or `failing`. `off` is the shared download turned off or `price_table.embedded` set to `false`, decided from the settings before any download state is read, so an `off` source is never `failing`. Otherwise `failing` while the source has failed download tries, or while the latest workflow load failed on `price_table.replace_file`; else `loaded` once it holds a table; else `not_loaded`. |
| `in_force` | boolean | The table is one of the tables that price runs. A `price_table.replace_file` table replaces the downloaded and built-in tables. A `price_table.replace_url` table replaces them once a download of it has passed validation, and they price until then. |
| `off_by` | string or `null` | On `fetched` while `off`: `SORTIE_PRICE_TABLE_FETCH` when the environment variable turned the download off, else `price_table.fetch`. `null` otherwise. |
| `file` | string or `null` | On `operator` for `price_table.replace_file`: the setting as written, after `$VAR` resolution and before `~` expansion and path joining. It is never a path Sortie resolved. |
| `address` | string or `null` | The download address as scheme, host, and path only, so a credential or query in the setting never leaves Sortie. `null` when the source has no address or the setting does not parse; a download whose address does not parse is `failing` with the error `invalid address`. |
| `version` | string or `null` | The version of the table the source holds: the pinned upstream revision of the built-in table, a content digest of any other table. `null` when it holds none. |
| `as_of` | string or `null` | The date of the table's prices. For the built-in table, the commit date of its upstream revision. For a downloaded table, the time of the download; a kept copy returns after a restart with its original download time. For a `price_table.replace_file` table, when this process first loaded the file's current content; a reload that reads unchanged content keeps it. |
| `models` | integer or `null` | The number of models the table lists. |
| `next_try_at` | string or `null` | When the next download try is due. `null` while a try is due or running, and for a source that is not downloaded. |
| `failures` | integer | The consecutive failed download tries since the last accepted one; `0` otherwise. |
| `failed_at` | string or `null` | When the latest failed try or failed load ended. `null` unless the source is `failing`. |
| `error` | string or `null` | The error of the latest failed try or failed load. `null` unless the source is `failing`. |

While `fetched` is `off` it carries no table facts, because a kept copy never prices while the download is off. `embedded` carries the binary's revision, its date, and its model count whether it is on or off. Download state is kept in memory: a restart keeps the copy of a table that passed validation, with its download time and version, and starts `failures` again at `0`. A failure of `price_table.replace_file` shows only while the configuration in effect names that setting; a workflow load that fails for another reason shows on the Health and Workflow screens and in [`GET /api/v1/state`](#get-apiv1state-system-state), not here.

**A model row.** A pair is listed when run history records a run that spent tokens on the model under the agent kind, or when the workflow in effect configures the model for the agent kind: in the top-level `agent` settings, the dispatch default, or the settings of a dispatch rule. Rows with a recorded run come first, latest use first; rows that only the workflow names follow, with `last_used_at` `null` and `runs` `0`. Ties break by `agent_kind`, then `model`, in byte order.

| Field | Type | Description |
|---|---|---|
| `agent_kind` | string | The agent kind. The same model name under two kinds is two rows, because a `token_rates` entry keyed by the kind prices that kind's models first. |
| `model` | string | The model name, empty for a run that reported none. |
| `table_key` | string or `null` | The key the model name maps to in the first price table that lists it. `null` when none does. |
| `layer` | string or `null` | The layer that prices the model: `kind_entry`, `model_entry`, `operator_table`, `fetched`, or `embedded`. `null` when none does. A model entry that takes some rates from a table is `model_entry`, and each class names its own layer. The layer is for display: a run keeps the price source recorded with it, which does not tell your `token_rates` from your own table. |
| `entry_key` | string or `null` | The `token_rates` key of the kind entry or model entry that applies. `null` otherwise. |
| `input`, `output`, `cache_read`, `cache_write` | object | `per_mtok`, the rate in USD per million tokens; `layer`, the layer that supplies it; and `from_input`. `per_mtok` and `layer` are `null` when no layer rates the class, so an unset rate never reads as zero, and `per_mtok` is `0` when a layer sets a rate of zero. A table rate is served to 10 significant digits. `from_input` is `true` for the cache rate of a kind entry that leaves it unset and so prices it at its input rate. |
| `cost_status` | string | What a run of the model records under these rates: `estimated` when every token class is priced, `partial` when a class has no rate beside priced ones, `unpriced` when no class is priced. |
| `unrated_classes` | array of string | The classes with no rate, from `input`, `output`, `cache_read`, and `cache_write`. `[]` when none. |
| `last_used_at` | string or `null` | The completion time of the latest recorded run. `null` for a model that only the workflow names. |
| `runs` | integer | The recorded runs that spent tokens on the model under the agent kind. |

### Reload and exposure

The route reads the rates the workflow loader holds when the request is served and caches nothing, so a successful workflow load, a `token_rates` edit, a table that has just landed, and a failed download try show on the next request, without a restart.

The route serves an address as scheme, host, and path only and `file` as written, and it masks every `error` as the Health screen masks the error of the workflow check: the workflow file's path is cut to its file name and a held secret is replaced. The body holds no credential and no path Sortie resolved. It does hold the model names your runs and workflow use, the rates in force, and the digest of your `token_rates` entries. Anyone who can reach the port can read them.

### Status codes

| Code | Error code | Meaning |
|---|---|---|
| `200 OK` | | Rates and sources returned, including a body whose `models` is `[]`. |
| `405 Method Not Allowed` | `method_not_allowed` | Any method other than `GET`. |
| `503 Service Unavailable` | `history_unavailable` | Run history could not be read. |

A client that disconnects during the read gets no response.

---

## GET /api/v1/{identifier}: Issue detail

Returns issue-specific runtime and debug details, and the issue's run history. The `{identifier}` path parameter is the issue identifier (e.g., `MT-649`), not the internal issue ID. An issue that is no longer active is answered from run history.

```sh
curl http://localhost:7678/api/v1/MT-649
```

### Lookup by identifier

The path identifier is matched against live entries first. When none carries it, Sortie reads the newest run recorded under that identifier and takes the issue ID from it. If a live entry carries that issue ID, the response is that entry's live detail, with `issue_identifier` set to the identifier the entry carries now. This finds an issue the tracker renamed. `history` always covers the issue by its ID, so runs recorded under an earlier identifier stay in it.

The fixed paths `/api/v1/state`, `/api/v1/runs`, `/api/v1/stats`, `/api/v1/prices`, `/api/v1/events`, and `/api/v1/refresh` take precedence over this route, so an issue whose identifier is one of `state`, `runs`, `stats`, `prices`, `events`, or `refresh` cannot be read here.

Every `200` response carries `history`. The running and finished examples show it in full; the other examples omit it to keep the members that differ by status in view.

### Response (running issue)

```json
{
  "issue_identifier": "MT-649",
  "issue_id": "abc123",
  "status": "running",
  "status_text": "Turn 7",
  "status_text_full": "Running, turn 7.",
  "next_outcomes": [
    {"condition": "If the run succeeds", "text": "Sortie moves the issue to In Review, and a pull request the run leaves gets the CI failure, review comments, bot review, merge conflicts, and auto-merge reactions."},
    {"condition": "If the run fails", "text": "Sortie retries with exponential backoff."},
    {"condition": "If the money budget is reached", "text": "Sortie stops the session and holds the issue at its money budget."},
    {"condition": "If tokens reach 500K", "text": "Sortie stops the session and holds the issue at its token budget."}
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
    "uncached_tokens": 7300,
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
    "skills": [{"skill": "ce-plan"}, {"skill": "ce-work", "tool_error": true}],
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
    "used_tokens": 112300,
    "used_tokens_complete": true,
    "budget_tokens": 500000,
    "budget_usd": 25,
    "estimated_cost_usd": 0.06372,
    "cost_status": "estimated",
    "issue_estimated_cost_usd": 0.49872,
    "issue_cost_status": "estimated",
    "status_text": "Turn 7",
    "status_text_full": "Running, turn 7.",
    "dispatch_id": "RLQFSIOFERWGDW2HZY45W55VXK",
    "quiet_at": "2026-03-26T14:32:29Z",
    "stall_at": "2026-03-26T14:34:59Z",
    "stall_text": null,
    "stall_text_full": null,
    "stall_off_text": null
  },
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [
    {
      "seq": 41,
      "at": "2026-03-26T14:29:31Z",
      "event": "tool_result",
      "message": "",
      "tool_name": "Bash",
      "tool_kind": "shell",
      "tool_argument": "go test ./...",
      "duration_ms": 2400,
      "tool_error": false,
      "text": "Ran go test ./... in 2.4s.",
      "tool_line": "go test ./..."
    },
    {
      "seq": 42,
      "at": "2026-03-26T14:29:59Z",
      "event": "turn_completed",
      "message": "Working on tests",
      "usage": {
        "input_tokens": 12500,
        "output_tokens": 3200,
        "total_tokens": 15700,
        "cache_read_tokens": 8400,
        "cache_write_tokens": 1200
      },
      "text": "Turn completed: Working on tests."
    }
  ],
  "last_error": null,
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
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
        "declared_outcome": null,
        "agent_text": null,
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
        "uncached_tokens": 25000,
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
        "ssh_host": "",
        "dispatch_id": "MZ3TQ7KXV2PL4NWB6YHC5RJ2DA",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "stage_chain": null,
        "pr_loop": null,
        "issue_outcome": null
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
        "declared_outcome": null,
        "agent_text": null,
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
        "uncached_tokens": 30000,
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
        "ssh_host": "",
        "dispatch_id": "B4XKQ2NW7TZH5LMC3VRY6PJD2E",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 48000,
              "output_tokens": 12000,
              "total_tokens": 60000,
              "cache_read_tokens": 30000,
              "cache_write_tokens": 3000
            },
            "uncached_tokens": 30000,
            "estimated_cost_usd": 0.261,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "stage_chain": null,
        "pr_loop": null,
        "issue_outcome": null
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
      "uncached_tokens": 55000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.435,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": null,
    "issue_outcome": null
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
  "status_text_full": "The retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m.",
  "next_outcomes": [
    {"condition": "When retry 3 comes due", "text": "Sortie dispatches a new session on stage implement if the issue is still in an active state."}
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
    "status_text_full": "The retry came due and was not dispatched: no agent slot was free. Retry 3 in 5m."
  },
  "budget_exhausted": null,
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": "no available orchestrator slots",
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
  "history": {
    "runs": [
      {
        "run_id": 62,
        "issue_id": "def456",
        "issue_identifier": "MT-650",
        "issue_title": "Retry the export job",
        "issue_url": "https://tracker.example.com/browse/MT-650",
        "attempt": 2,
        "status": "failed",
        "error": "agent turn timed out",
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "implement",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T12:05:00Z",
        "completed_at": "2026-03-26T12:38:20Z",
        "dispatched_at": "2026-03-26T12:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-def456-002",
        "ssh_host": "",
        "dispatch_id": "QH4N7TXD2KBW5MZC3RVY6JPL2A",
        "stage_chain": ["specify", "implement"],
        "pr_loop": null,
        "issue_outcome": null
      },
      {
        "run_id": 61,
        "issue_id": "def456",
        "issue_identifier": "MT-650",
        "issue_title": "Retry the export job",
        "issue_url": "https://tracker.example.com/browse/MT-650",
        "attempt": 1,
        "status": "failed",
        "error": "agent turn timed out",
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "implement",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T11:05:00Z",
        "completed_at": "2026-03-26T11:38:20Z",
        "dispatched_at": "2026-03-26T11:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-def456-001",
        "ssh_host": "",
        "dispatch_id": "TR6W3LKD7XNQ4HBC2YMZ5VJP7E",
        "stage_chain": ["specify", "implement"],
        "pr_loop": null,
        "issue_outcome": null
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 2,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 72000,
        "output_tokens": 18000,
        "total_tokens": 90000,
        "cache_read_tokens": 40000,
        "cache_write_tokens": 4000
      },
      "uncached_tokens": 50000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.348,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": {
      "chain": ["specify", "implement"],
      "rule": "implement"
    },
    "issue_outcome": null
  }
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
  "status_text_full": "Held at the session budget of 3. Sessions used: 3.",
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
    "used_usd": null,
    "used_usd_complete": null,
    "budget_usd": null,
    "unmeasured_sessions": null,
    "stopped_in_flight": null,
    "exhausted_at": "2026-03-26T14:12:00Z",
    "stage_lineage": null,
    "stage_position": null,
    "agent_kind": "claude-code",
    "configured_model": "claude-sonnet-4-5",
    "status_text": "Held: session budget reached",
    "status_text_full": "Held at the session budget of 3. Sessions used: 3."
  },
  "parked": null,
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
  "history": {
    "runs": [
      {
        "run_id": 61,
        "issue_id": "ghi789",
        "issue_identifier": "MT-651",
        "issue_title": "Migrate the billing tables",
        "issue_url": "https://tracker.example.com/browse/MT-651",
        "attempt": 1,
        "status": "failed",
        "error": "agent turn timed out",
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "implement",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T11:05:00Z",
        "completed_at": "2026-03-26T11:38:20Z",
        "dispatched_at": "2026-03-26T11:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-ghi789-001",
        "ssh_host": "",
        "dispatch_id": "W2KX5RNQ7DTH3LMC6YBZ4VPJ2F",
        "stage_chain": ["specify", "implement"],
        "pr_loop": null,
        "issue_outcome": null
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 1,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 36000,
        "output_tokens": 9000,
        "total_tokens": 45000,
        "cache_read_tokens": 20000,
        "cache_write_tokens": 2000
      },
      "uncached_tokens": 25000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.174,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": {
      "chain": ["specify", "implement"],
      "rule": "implement"
    },
    "issue_outcome": null
  }
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
  "status_text_full": "Parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`.",
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
    "status_text_full": "Parked: the agent stopped because it cannot go on without a person. Parking label: `needs-human`."
  },
  "pending_reactions": [],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
  "history": {
    "runs": [
      {
        "run_id": 61,
        "issue_id": "jkl012",
        "issue_identifier": "MT-652",
        "issue_title": "Rotate the signing keys",
        "issue_url": "https://tracker.example.com/browse/MT-652",
        "attempt": 1,
        "status": "failed",
        "error": "agent turn timed out",
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "bugfix",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T11:05:00Z",
        "completed_at": "2026-03-26T11:38:20Z",
        "dispatched_at": "2026-03-26T11:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-jkl012-001",
        "ssh_host": "",
        "dispatch_id": "N7DQ3XKT5WLH2MBC4YRZ6VJP3G",
        "stage_chain": null,
        "pr_loop": null,
        "issue_outcome": null
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 1,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 36000,
        "output_tokens": 9000,
        "total_tokens": 45000,
        "cache_read_tokens": 20000,
        "cache_write_tokens": 2000
      },
      "uncached_tokens": 25000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.174,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": null,
    "issue_outcome": null
  }
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
  "status_text_full": "Sortie watches PR #944 for merge conflicts; the last check found none; next check in 1m. Rebase runs used: 0 of 1.",
  "next_outcomes": [
    {"condition": "If a check in the next 20m finds a new merge conflict on the pull request", "text": "Sortie dispatches rebase 1 of 1."}
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
      "status_text_full": "Sortie watches PR #944 for merge conflicts; the last check found none; next check in 1m. Rebase runs used: 0 of 1."
    }
  ],
  "between_stages": null,
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "quiet", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
  "history": {
    "runs": [
      {
        "run_id": 61,
        "issue_id": "pqr678",
        "issue_identifier": "MT-654",
        "issue_title": "Cache the price list",
        "issue_url": "https://tracker.example.com/browse/MT-654",
        "attempt": 1,
        "status": "succeeded",
        "error": null,
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "bugfix",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T11:05:00Z",
        "completed_at": "2026-03-26T11:38:20Z",
        "dispatched_at": "2026-03-26T11:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-pqr678-001",
        "ssh_host": "",
        "dispatch_id": "Z5LH2TWX7NQD4KMB3CRY6VJP2H",
        "stage_chain": null,
        "pr_loop": null,
        "issue_outcome": null
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 1,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 36000,
        "output_tokens": 9000,
        "total_tokens": 45000,
        "cache_read_tokens": 20000,
        "cache_write_tokens": 2000
      },
      "uncached_tokens": 25000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.174,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": null,
    "issue_outcome": null
  }
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
  "status_text_full": "Moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue.",
  "next_outcomes": [
    {"condition": "When a poll tick reads `stage-implement` on the issue", "text": "Stage implement starts in a new session."}
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
    "status_text_full": "Moved from stage specify to stage implement, and Sortie added `stage-implement`; implement starts when a poll tick reads that label on the issue."
  },
  "recent_events": [],
  "last_error": null,
  "tracked": {},
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "unrecorded", "continuations": 0}},
  "history": {
    "runs": [
      {
        "run_id": 61,
        "issue_id": "stu901",
        "issue_identifier": "MT-655",
        "issue_title": "Plan the export schema",
        "issue_url": "https://tracker.example.com/browse/MT-655",
        "attempt": 1,
        "status": "succeeded",
        "error": null,
        "declared_outcome": null,
        "agent_text": null,
        "rule_name": "implement",
        "agent_kind": "claude-code",
        "configured_model": "claude-sonnet-4-5",
        "started_at": "2026-03-26T11:05:00Z",
        "completed_at": "2026-03-26T11:38:20Z",
        "dispatched_at": "2026-03-26T11:05:00Z",
        "turns_completed": 8,
        "tokens": {
          "input_tokens": 36000,
          "output_tokens": 9000,
          "total_tokens": 45000,
          "cache_read_tokens": 20000,
          "cache_write_tokens": 2000
        },
        "uncached_tokens": 25000,
        "tokens_measured": true,
        "unaccounted_turns": 0,
        "estimated_cost_usd": 0.174,
        "cost_status": "estimated",
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 36000,
              "output_tokens": 9000,
              "total_tokens": 45000,
              "cache_read_tokens": 20000,
              "cache_write_tokens": 2000
            },
            "uncached_tokens": 25000,
            "estimated_cost_usd": 0.174,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "self_review": null,
        "origin_recorded": true,
        "trigger": "",
        "reaction_kind": "",
        "reaction_config_key": "",
        "session_id": "session-stu901-001",
        "ssh_host": "",
        "dispatch_id": "P3XN6QWT2KDH7LMB5CZY4RVJ7K",
        "stage_chain": ["specify", "implement"],
        "pr_loop": null,
        "issue_outcome": null
      }
    ],
    "next_cursor": null,
    "totals": {
      "run_count": 1,
      "unmeasured_runs": 0,
      "tokens": {
        "input_tokens": 36000,
        "output_tokens": 9000,
        "total_tokens": 45000,
        "cache_read_tokens": 20000,
        "cache_write_tokens": 2000
      },
      "uncached_tokens": 25000,
      "tokens_complete": true,
      "estimated_cost_usd": 0.174,
      "cost_status": "estimated"
    },
    "hops": [],
    "last_stage": {
      "chain": ["specify", "implement"],
      "rule": "implement"
    },
    "issue_outcome": null
  }
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
  "status_text_full": "Handed off: Sortie moved the issue to Human Review.",
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
  "pr_loop": {"ci_failure": {"result": "unrecorded", "continuations": 0}, "review_comments": {"result": "unrecorded", "continuations": 0}, "bot_review": {"result": "unrecorded", "continuations": 0}, "merge_conflicts": {"result": "unrecorded", "continuations": 0}, "auto_merge": {"result": "acted", "continuations": 1}},
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
        "declared_outcome": null,
        "agent_text": null,
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
        "uncached_tokens": 31100,
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
        "dispatch_id": null,
        "model_usage": [
          {
            "model": "claude-sonnet-4-5",
            "tokens": {
              "input_tokens": 52000,
              "output_tokens": 9100,
              "total_tokens": 61100,
              "cache_read_tokens": 30000,
              "cache_write_tokens": 4000
            },
            "uncached_tokens": 31100,
            "estimated_cost_usd": 0.1923,
            "cost_status": "estimated",
            "unrated_classes": []
          }
        ],
        "stage_chain": ["specify", "implement"],
        "pr_loop": null,
        "issue_outcome": {
          "kind": "handed_off",
          "observed_at": "2026-03-26T12:42:01Z",
          "state": "Human Review",
          "status_text": "Handed off to Human Review",
          "status_text_full": "Handed off: Sortie moved the issue to Human Review."
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
      "uncached_tokens": 31100,
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
    "last_stage": {"chain": ["specify", "implement"], "rule": "implement"},
    "issue_outcome": {
      "kind": "handed_off",
      "observed_at": "2026-03-26T12:42:01Z",
      "state": "Human Review",
      "status_text": "Handed off to Human Review",
      "status_text_full": "Handed off: Sortie moved the issue to Human Review."
    }
  }
}
```

### Field notes

| Field | Description |
|---|---|
| `status` | One of `"running"`, `"retrying"`, `"budget_exhausted"`, `"parked"`, `"pending_reactions"`, `"between_stages"`, or `"history"`. Derived from which set the issue appears in; `running` takes precedence over `retrying`, which takes precedence over `budget_exhausted`, which takes precedence over `parked`, which takes precedence over `pending_reactions`, which takes precedence over `between_stages`, which takes precedence over `history`, the status of an issue only run history knows. |
| `status_text`, `status_text_full` | The issue's [status sentences](#status-sentences). Always present. They are the pair of the entry that decides `status`. For `"pending_reactions"` they are the pair of the deciding row described under [`active` entries](#field-notes). For `"history"` they word how the issue ended from `history.issue_outcome` and the newest run's `stage_target` and `stage_result`: a handoff after a hop that was not made (`"failed"` or `"ceiling"`) names the stage it did not reach, and an issue without an outcome reads `Not active; no ending recorded`. |
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
| `recent_events` | The newest 50 agent events of one run, oldest first, in the event shape of [`GET /api/v1/runs/{dispatch_id}/events`](#get-apiv1runsdispatch_idevents-run-events). The run is the one `running.dispatch_id` names while the issue runs, and otherwise the issue's newest recorded run with a non-empty `dispatch_id`, so a recorded CI result is passed over. Always present; `[]` when the issue has no such run or Sortie kept no events for it. |
| `last_error` | The `error` of the issue's retry entry, or `null` when it has none, worded as the retry's `error` is. After a reschedule this is the reschedule reason. |
| `pr_loop` | What each configured pull request reaction recorded in the pass of the entry that decides `status`; see [pull request reaction history](#pull-request-reaction-history). Always present. |
| `tracked` | Reserved for future use. Currently an empty object. It is not the tracker project, which `config.tracker.project` of [`GET /api/v1/state`](#get-apiv1state-system-state) serves. |
| `history` | `null` when the issue has no recorded run, otherwise an object. See [History member](#history-member). |

### Next outcomes

Every `200` response carries `next_outcomes`: the branches ahead of the issue, each as the condition that leads to it and what Sortie then does. A client shows them as written and reads no Sortie state to build them.

| Member | Description |
|---|---|
| `condition` | What leads to the outcome, for example `If the run fails`. It starts with a capital letter and ends without a period. |
| `text` | What Sortie then does, in one or two sentences that each end with a period. |

The list follows the workflow in effect, in this order:

1. A running work session yields what follows if the run succeeds and if it fails, and, when `agent.max_tokens` or `agent.max_cost_usd` is set and the session's agent reports token usage, what follows if the issue's token use reaches the token budget or its estimated cost reaches the money budget, the money pair first. A retry queued beside the session drops the failure pair, and also the success pair when `tracker.handoff_state` is unset. A session that runs a reaction continuation or a label command yields none of these, because the issue's pending reactions say what follows it.
2. Otherwise, a retry that is not `paused` yields what happens when it comes due, and an issue between stages yields what happens when a poll tick reads its stage label.
3. Each pending reaction then yields what happens when a check finds its event, in the order `ci`, `review`, `bot-review`, `merge-conflict`, `merge`, `merge-completion`, `label-review`, `label-fix`.

An issue with none of these serves `[]`, as a `"history"` response always does.

- A pair never names a reaction that `config.reactions` of [`GET /api/v1/state`](#get-apiv1state-system-state) lacks, nor a stage the dispatch rules do not hold. A reaction whose `escalated_at` is not `null` yields no pair.
- A pair calls the pull request it watches "the pull request", and names it by number, as in `PR #944`, only when the issue's pending reactions watch more than one pull request.
- The condition of a watched reaction carries the time left in which a check can still lead to the outcome: the time to its `watch_ends_at`, measured from the time the snapshot was generated. For `review` it also leaves out the wait a found comment still has, one `polling.interval_ms` and, unless the comments already wait to settle, `debounce_ms`. A reaction with less than one second left yields no pair.
- An outcome that would start a session names the hold instead when the money budget, the token budget, or the session budget would stop it, in that precedence, and names the money budget by its setting, never by an amount. A reaction configured with a triage command says that the command runs, in place of the fix, and one whose fixes are used up says how Sortie escalates, in the order the reaction's own pass decides them.
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
| `last_stage` | `null`, or an object with `chain`, the rule names of the stage chain in `next` order, and `rule`, the rule of the deciding run. The deciding run is the newest run in `runs` that no pull request reaction started and whose `rule_name` is set, so a reaction run and a recorded CI result never decide. `chain` is the chain `stage_position.chain` serves for that rule and the run's `stage_previous`, so it equals the deciding run's `stage_chain`. Always present. `null` when no run in `runs` decides, when the deciding rule is on no chain, and when the server holds no workflow shape. |
| `issue_outcome` | How the issue ended, or `null` when Sortie has not seen it end. The object each run in `runs` carries; see [Issue outcome](#issue-outcome). |

**`totals` members:**

| Member | Description |
|---|---|
| `run_count` | Every run of the issue, a recorded CI result included. |
| `unmeasured_runs` | Runs whose agent reported no token usage. |
| `tokens` | The five token members of a running row's `tokens`. Each is `null` when its sum is `0` and `tokens_complete` is `false`, so spend Sortie does not know never reads as zero. |
| `uncached_tokens` | Integer or `null`. The issue's tokens without cache reads over all of its runs: for each run, `total_tokens` less `cache_read_tokens`, floored at zero, summed. This is the count [`agent.max_tokens`](/reference/workflow-config/#agent) is compared with. `null` under the rule of the members of `tokens`. |
| `tokens_complete` | `true` when no run is unmeasured and no run has an unaccounted turn. When `false`, the figures in `tokens` and `uncached_tokens` are lower bounds. |
| `estimated_cost_usd` | Number or `null`. The sum of the costs recorded with the issue's runs, each priced under the rates in force when it finished. Unrounded. |
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

`operations` lists what the request queued: `["poll", "reconcile"]` on `202`, whether or not it coalesced, and `[]` on `409`.

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
| `403 Forbidden` | A browser sent the request from a page on another origin; nothing changed (`cross_origin_request_rejected`). See [cross-origin requests](#cross-origin-requests). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Server is draining; refresh rejected. |

---

## POST /api/v1/retries/{identifier}/run: Run a scheduled retry now

Makes the scheduled retry of an issue due now, so it runs without waiting out its delay. `{identifier}` is the `issue_identifier` of an entry in the `retrying` list of [`GET /api/v1/state`](#get-apiv1state-system-state), one path segment that a client percent-encodes, matched exactly. The route ignores the request body and the query string.

```sh
curl -X POST http://localhost:7678/api/v1/retries/MT-650/run
```

The retry takes the path of a retry whose timer fired. It passes the same checks, among them the limit on agents running at once, the `agent.max_sessions`, `agent.max_tokens`, and `agent.max_cost_usd` budgets, and a fresh read of the issue from the tracker, and a retry that the issue's state pauses stays paused. A retry that still cannot start is put back at the attempt number and the due time it had before the request, or due at once when that time has passed, so a request never leaves a retry waiting longer or at a later attempt than before. The put-back sets the entry's `error` to its own reason.

A retry that has a stored row has the row saved with the new due time, so a restart before the retry runs does not undo the request. A retry for a pull request reaction has no stored row. A failed save is logged and does not change the response.

The response arrives once Sortie has taken the request: at once while Sortie is idle, and at the end of the work in progress otherwise. The wait has no fixed bound. A client that disconnects while it waits, or a shutdown that begins, withdraws the request and changes nothing.

Each request that makes a retry due is logged at `info` as `retry made due on request`, with the `attempt` and the `replaced_due_at_ms` the request replaced, and it triggers a [change signal](#get-apiv1events-change-signals-and-agent-events).

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
| `403 Forbidden` | A browser sent the request from a page on another origin; nothing changed (`cross_origin_request_rejected`). See [cross-origin requests](#cross-origin-requests). |
| `404 Not Found` | No retry is scheduled for the identifier (`retry_not_found`). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Sortie is shutting down; nothing changed. |
| `503 Service Unavailable` | Sortie did not take the request; nothing changed (`retry_now_unavailable`). |

---

## POST /api/v1/reactions/{identifier}/{kind}/check: Check a pending reaction now

Makes the next check of a pending pull request reaction due now, so the reaction checks its pull request on the next poll tick instead of at its scheduled time. `{identifier}` is the `issue_identifier` and `{kind}` is the `kind` of a row of `pending_reactions` in [`GET /api/v1/state`](#get-apiv1state-system-state), each one path segment that a client percent-encodes, matched exactly. The route takes `kind`, not `config_key`, because `label-review` and `label-fix` share one key. The route ignores the request body and the query string.

```sh
curl -X POST http://localhost:7678/api/v1/reactions/MT-653/ci/check
```

The request moves `next_poll_at` of the row to the time Sortie takes the request when that time is later, and changes nothing else about the reaction. A reaction that is already due is left as it is, and the request still answers `202`. The request starts no agent and writes nothing to the tracker or the pull request. It stores nothing, because pending reactions are kept in memory.

The check runs on the next poll tick, or on a refresh before it. The route runs no tick and dispatches no new issues. The check follows every rule of the reaction's kind, among them the review debounce, the retry slot, the triage command, the limit on tries and the escalation at it, and the watch window. What the check finds is handled as it is at the reaction's due time.

When the check keeps the reaction pending and starts before the time the request replaced, `next_poll_at` goes back to that time, and the backoff count goes back to the lower of the count the check leaves and the count before the request. A check that starts at or after the replaced time is one the reaction had without the request, so its own schedule stands. A request never leaves the next check later, or the backoff count higher, than without the request.

The response arrives once Sortie has taken the request: at once while Sortie is idle, and at the end of the work in progress otherwise. The wait has no fixed bound. A client that disconnects while it waits, or a shutdown that begins, withdraws the request and changes nothing. The answer is `202 Accepted` and not `200 OK`, because the check runs after the response is written.

Each request that moves a check forward is logged at `info` as `reaction check made due on request`, with the `reaction_kind` and the `replaced_next_poll_at` the request replaced, and it triggers a [change signal](#get-apiv1events-change-signals-and-agent-events). A request for a reaction that is already due logs nothing and triggers no signal.

Sortie's HTTP server has no authentication, so anyone who can reach it can make a reaction check early. A deployment that others can reach must sit behind a reverse proxy with authentication or a VPN.

### Response (202 Accepted)

```json
{
  "queued": true,
  "requested_at": "2026-03-26T14:31:10Z",
  "issue_id": "mno345",
  "issue_identifier": "MT-653",
  "kind": "ci",
  "pull_request": {"number": 931, "repository": "acme/web"},
  "outcome_text": "MT-653: a check of PR #931 for CI is queued for the next poll tick."
}
```

### Response (404 Not Found)

No pending reaction of that kind exists for the identifier: the issue is unknown, `{kind}` is not a reaction kind, the issue has no reaction of that kind, or the reaction left the pending set before Sortie took the request. [`GET /api/v1/state`](#get-apiv1state-system-state) shows what became of it.

```json
{
  "error": {
    "code": "reaction_not_found",
    "message": "no pending \"bot-review\" reaction for issue \"MT-653\""
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
| `issue_identifier` | The identifier the reaction carries. `202` only. |
| `display_identifier` | The issue's display identifier. Present on `202` only when the issue has one. |
| `kind` | The reaction's `kind`. `202` only. |
| `pull_request` | The pull request the reaction watches, with `number` and `repository` (`owner/repo`, masked as in `pending_reactions`). `202` only. |
| `outcome_text` | One sentence that states what the response confirms. Always present on `202` and `409`. It states no effect still to come, because what the check finds is decided after the response. |

`outcome_text` names the issue by `display_identifier` when present, and by `issue_identifier` otherwise. It names the kind in words: `CI`, `review comments`, `bot review`, `auto-merge`, `the merge conflict`, `merge completion`, `the review label command`, or `the fix label command`.

| Response | `outcome_text` |
|---|---|
| `202` | `MT-653: a check of PR #931 for CI is queued for the next poll tick.` |
| `409` | `Nothing queued: Sortie is shutting down.` |

### Status codes

| Code | Meaning |
|---|---|
| `202 Accepted` | The reaction's next check is due now. |
| `403 Forbidden` | A browser sent the request from a page on another origin; nothing changed (`cross_origin_request_rejected`). See [cross-origin requests](#cross-origin-requests). |
| `404 Not Found` | No pending reaction of that kind exists for the identifier (`reaction_not_found`). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Sortie is shutting down; nothing changed. |
| `503 Service Unavailable` | Sortie did not take the request; nothing changed (`check_now_unavailable`). |

---

## POST /api/v1/attention/{id}/acknowledge: Acknowledge an attention item

Records that a person has seen an item of the `attention` list of [`GET /api/v1/state`](#get-apiv1state-system-state). `{id}` is the `id` of a current item. The route ignores the request body and the query string.

```sh
curl -X POST http://localhost:7678/api/v1/attention/9ee206201099385b431c9bb01911553f/acknowledge
```

Acknowledging changes the item and nothing else. The item stays in the list with `acknowledged_at` set, it stops counting in `counts.attention`, and the cause, the issue, and the agent are untouched. The item disappears when its cause clears, as any item does. A new cause, such as a later park of the same issue, is a different item with a different `id` and is not acknowledged.

Sortie saves the acknowledgement before it changes its state in memory, so a response of `200` means the acknowledgement survives a restart. A request for an item that is already acknowledged answers `200` with `already_acknowledged` set to `true`, keeps the first `acknowledged_at`, and saves nothing. A request for an item that does not exist, because its cause cleared or the `id` is wrong, writes nothing.

The response arrives once Sortie has taken the request: at once while Sortie is idle, and at the end of the work in progress otherwise. The wait has no fixed bound. A client that disconnects while it waits, or a shutdown that begins, withdraws the request and changes nothing.

Each request that records an acknowledgement is logged at `info` as `attention item acknowledged`, with the `item_id` and the `kind`, and it triggers a [change signal](#get-apiv1events-change-signals-and-agent-events).

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
| `403 Forbidden` | A browser sent the request from a page on another origin; nothing changed (`cross_origin_request_rejected`). See [cross-origin requests](#cross-origin-requests). |
| `404 Not Found` | No current item has the `id` (`attention_item_not_found`). |
| `405 Method Not Allowed` | Used a method other than POST. |
| `409 Conflict` | Sortie is shutting down; nothing changed. |
| `500 Internal Server Error` | Sortie could not save the acknowledgement; nothing changed (`acknowledgement_not_saved`). |
| `503 Service Unavailable` | Sortie did not take the request; nothing changed (`acknowledge_unavailable`). |

---

## GET /api/v1/events: Change signals and agent events

Streams a signal each time something the JSON API serves changes, so a client can refetch what it shows instead of polling on a timer, and streams the agent events of each run the client names with `run`. The response is a [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream that stays open until the client disconnects or the HTTP server shuts down. A change signal carries no data: it names no issue and no agent message. An agent event carries what [`GET /api/v1/runs/{dispatch_id}/events`](#get-apiv1runsdispatch_idevents-run-events) serves for the same event.

Sortie's HTTP server has no authentication, so anyone who can reach it can read the agent events of every retained run. A deployment that others can reach must sit behind a reverse proxy with authentication or a VPN.

```sh
curl -N 'http://localhost:7678/api/v1/events?run=RLQFSIOFERWGDW2HZY45W55VXK:40'
```

```text
id: 1792000000000000000;RLQFSIOFERWGDW2HZY45W55VXK:40
event: change
data: {}

id: 1792000000000000000;RLQFSIOFERWGDW2HZY45W55VXK:41
event: agent_event
data: {"dispatch_id":"RLQFSIOFERWGDW2HZY45W55VXK","seq":41,"at":"2026-03-26T14:29:31Z","event":"tool_result","message":"","tool_name":"Bash","tool_kind":"shell","tool_argument":"go test ./...","duration_ms":2400,"tool_error":false,"text":"Ran go test ./... in 2.4s.","tool_line":"go test ./..."}

id: 1792000000000000000;RLQFSIOFERWGDW2HZY45W55VXK:42
event: agent_event
data: {"dispatch_id":"RLQFSIOFERWGDW2HZY45W55VXK","seq":42,"at":"2026-03-26T14:29:59Z","event":"turn_completed","message":"Working on tests","usage":{"input_tokens":12500,"output_tokens":3200,"total_tokens":15700,"cache_read_tokens":8400,"cache_write_tokens":1200},"text":"Turn completed: Working on tests."}

id: 1792000000000000000;RLQFSIOFERWGDW2HZY45W55VXK:42
event: run_ended
data: {"dispatch_id":"RLQFSIOFERWGDW2HZY45W55VXK","last_seq":42}

id: 1792000000000000004;RLQFSIOFERWGDW2HZY45W55VXK:42
event: change
data: {}

```

The stream opens with a `change`, then writes the retained events after `seq` 40, then each new one. When the run ends, `run_ended` follows its last event. Without `run`, the stream carries change signals and heartbeats only.

### Query parameters

| Parameter | Value | Selects |
|---|---|---|
| `run` | `<dispatch_id>` or `<dispatch_id>:<seq>` | A run whose agent events the stream carries. The `dispatch_id` is the one a [running row](#field-notes) or a [run](#get-apiv1runs-run-history) carries. Without `<seq>` the stream starts with every retained event of the run; with it, the stream starts after that `seq`. A `seq` above the run's newest `seq` reads as the newest. Repeat the parameter once per run, up to 16 times. |

A dispatch ID has 1 to 64 characters, each from `A` to `Z` or `2` to `7`. A `seq` has 1 to 19 decimal digits and fits a signed 64-bit integer. An empty `run` value, a value in any other form, a dispatch ID named twice, and more than 16 `run` parameters answer `400` with `invalid_parameter` and open no stream. The message names the broken rule. Every other query parameter is ignored.

### Events

| Event | Data | When |
|---|---|---|
| `change` | `{}` | Something the API serves changed, or a stream just opened and the client does not hold the current revision. |
| `heartbeat` | `{}` | Every 15 seconds on every open stream, whether or not anything changed. |
| `agent_event` | `dispatch_id` followed by the members of an [event](#get-apiv1runsdispatch_idevents-run-events) | One for each retained event of a subscribed run after its cursor, then one for each new event as Sortie keeps it, in `seq` order. |
| `run_ended` | `dispatch_id` and `last_seq`, the `seq` of the run's newest retained event | The run has ended and the stream has written every retained event after the cursor. |
| `reset` | `dispatch_id`, `reason` `cursor_expired`, and `first_seq` | The events between the cursor and `first_seq` are no longer retained. |
| `reset` | `dispatch_id` and `reason` `not_retained` | Sortie has no events for the run. |

Every frame carries an `id`: a revision, followed by `;<dispatch_id>:<seq>` for each run the stream carries, in the order of the `run` parameters. The revision is an opaque decimal number that rises with every change. Only a `change` moves it forward on a stream: every other frame, run frames and heartbeats alike, carries the revision of the last `change` the stream sent, or of the `Last-Event-ID` the stream opened with when it sent none. Sortie starts the revision from the clock at process start, so a revision from before a restart never matches a later one. The `<seq>` is the `seq` of the run's last `agent_event` on the stream, or the cursor the subscription started from while the stream has written none.

### Agent events

Agent event frames are not coalesced and are not held to one per second. Sortie writes a run's new events as soon as the stream wakes, which it does with the `change` that every agent event produces. A running run that has kept no event yet gets no frame until its first one.

After `run_ended` the run stays in the `id` with `last_seq` as its cursor, so a reconnect with that `id` and the same `run` parameters replays no event and gets `run_ended` again.

A `cursor_expired` reset is followed on the same stream by every retained event of the run, from `first_seq`, and its `id` carries `first_seq` minus one as the run's cursor. A subscription without a cursor to a run whose oldest retained event is above `seq` 1 starts with this reset. A stream that reads too slowly to keep up with a running run's [retention limit](#what-sortie-keeps) gets it too. Sortie no longer has the missing events.

```text
id: 1792000000000000000;RLQFSIOFERWGDW2HZY45W55VXK:200
event: reset
data: {"dispatch_id":"RLQFSIOFERWGDW2HZY45W55VXK","reason":"cursor_expired","first_seq":201}

```

A `not_retained` reset follows the rule of the [run events route's](#get-apiv1runsdispatch_idevents-run-events) `404`: no run carries the dispatch ID, the run kept no event, or its events were pruned, are still waiting to be written, or were lost. The run leaves the `id` and no other frame of it follows on that stream.

```text
id: 1792000000000000000
event: reset
data: {"dispatch_id":"RLQFSIOFERWGDW2HZY45W55VXK","reason":"not_retained"}

```

When the stored events of an ended run cannot be read, the stream writes nothing for that run, keeps its cursor in the `id`, and reads them again at the next heartbeat. The other runs and the change signals continue meanwhile. The run events route answers the same run `503`.

### When a signal arrives

A stream receives a `change` after each of these:

- A poll tick, a refresh, a worker exit, a retry, a request that makes a retry due, a request that makes a reaction check due, or a request that acknowledges an attention item.
- Every message from a running agent session, so token counts and the latest message reach a client within a second.
- The start of shutdown.
- Each time the file watcher loads `WORKFLOW.md`, whether the load succeeds or fails.

A stream carries at most one `change` per second. The first change after a quiet second arrives at once. Changes made during the following second arrive together as one signal when that second ends. Values that move with the clock alone, such as elapsed times computed from `started_at` and `agent_totals.seconds_running`, produce no signal.

### Reconnecting

A stream opens with a `200` and flushes its headers at once. Sortie then sends one `change` immediately, unless the request carries a `Last-Event-ID` header whose text before the first `;` equals the current revision. In that case Sortie sends no `change` until the next change. A missing header, a stale value, or a value from before a restart all get the immediate `change`, so a client refetches after any gap.

For each run the `run` parameters name, a cursor that `Last-Event-ID` carries replaces the cursor of the query, so the stream resumes after the last event the client received. The query alone decides which runs the stream carries: a cursor in the header for a run the query does not name is ignored. A header part that is not `<dispatch_id>:<seq>` is ignored, the first part for a run counts, and the header never causes a `400`.

```sh
curl -N \
  -H 'Last-Event-ID: 1792000000000000004;RLQFSIOFERWGDW2HZY45W55VXK:42' \
  'http://localhost:7678/api/v1/events?run=RLQFSIOFERWGDW2HZY45W55VXK'
```

A browser's `EventSource` sends `Last-Event-ID` and reconnects after a dropped connection on its own. A client that is not a browser echoes back the `id` of the last frame it received.

### Client guidance

Sortie does not enforce the following; it is how a consumer stays correct:

- Refetch on every `change`, and ignore `heartbeat` for data. Because signals are coalesced to one per second, a `change` means "something moved since your last fetch", not "one thing moved".
- Treat a stream that has delivered no event for 45 seconds, three heartbeat intervals, as dead. Close it and open a new one. A connection can die without the client being told, for example when a laptop wakes holding a socket the server dropped while it slept.
- After a failure that closes the stream for good, such as a non-`200` answer or a proxy `502`, wait before reopening and lengthen the wait while new attempts keep failing. A browser does not retry after a non-`200` answer, so the client has to.
- A new stream opened after such a failure carries no `Last-Event-ID`. Write the last `seq` the client holds for each run into that run's `run` parameter, so no event arrives twice or goes missing.
- After a `cursor_expired` reset, keep the events already held and show the gap before `first_seq`.

### Shutdown and slow clients

When the HTTP server begins to shut down, Sortie ends every open stream, including one in the middle of writing agent events, before its next frame, so a connected client does not hold up the [shutdown sequence](/reference/cli/#signals). A stream opened during that window still answers `200` and ends at once. The route never answers `503`.

Each frame has its own write deadline of 2 seconds. A client that stops reading is dropped once Sortie cannot write to it within 2 seconds, and it delays no other client and no agent. A client that keeps reading is never dropped, however long the retained events of its runs take to send. The server's 10-second write timeout does not apply to an open stream.

### Reverse proxies and browsers

The response carries `Cache-Control: no-cache` and `X-Accel-Buffering: no`, which nginx honors to stop buffering the stream. Set the proxy's read timeout above 15 seconds, or it closes a stream that the heartbeat would have kept alive.

Over plain HTTP/1.1 a browser allows about six connections per origin across all its tabs, and every open stream holds one. Share one stream across tabs rather than opening one per tab.

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | The stream is open. Content type is `text/event-stream`. |
| `400 Bad Request` | A `run` parameter broke the rules for its value (`invalid_parameter`). No stream opens. |
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
| `reaction_not_found` | 404 | `POST /api/v1/reactions/{identifier}/{kind}/check` found no pending reaction of that kind for the identifier. |
| `retry_now_unavailable` | 503 | `POST /api/v1/retries/{identifier}/run` was not taken; nothing changed. |
| `check_now_unavailable` | 503 | `POST /api/v1/reactions/{identifier}/{kind}/check` was not taken; nothing changed. |
| `invalid_parameter` | 400 | `GET /api/v1/runs`, `GET /api/v1/runs/issues`, `GET /api/v1/stats`, or `GET /api/v1/events` rejected a query parameter, or a misordered pair of bounds. The message names the parameter and the rule. |
| `snapshot_unavailable` | 503 | The orchestrator could not produce a state snapshot. |
| `history_unavailable` | 503 | Run history or the issue outcomes could not be read, the database behind `GET /api/v1/stats` could not be opened or read, or `GET /api/v1/prices` could not read the models run history records. |
| `attention_item_not_found` | 404 | `POST /api/v1/attention/{id}/acknowledge` found no current attention item with the `id`. |
| `run_events_not_retained` | 404 | `GET /api/v1/runs/{dispatch_id}/events` has no events for the dispatch ID. |
| `acknowledgement_not_saved` | 500 | `POST /api/v1/attention/{id}/acknowledge` could not save the acknowledgement; nothing changed. |
| `acknowledge_unavailable` | 503 | `POST /api/v1/attention/{id}/acknowledge` was not taken; nothing changed. |
| `cross_origin_request_rejected` | 403 | A browser sent a state-changing request from a page on another origin, or one Sortie could not confirm came from its own origin; nothing changed. See [cross-origin requests](#cross-origin-requests). |
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

The response includes the header `Allow: GET` (or `Allow: POST` for the refresh, retry, reaction check, and acknowledge endpoints).

A state-changing request that is refused as [cross-origin](#cross-origin-requests) answers `403` before method enforcement applies.

## Endpoint summary

| Method | Path | Description | Content-Type |
|---|---|---|---|
| GET | `/` | Redirect to the dashboard (`302` to `/ui/`) | none |
| GET | `/ui/` | Dashboard application and its assets | `text/html`, `text/javascript`, `text/css` |
| GET | `/favicon.ico` | Icon for browsers that request it by default | `image/x-icon` |
| GET | `/livez` | Liveness probe | `application/json` |
| GET | `/readyz` | Readiness probe | `application/json` |
| GET | `/api/v1/state` | Full system state snapshot | `application/json` |
| GET | `/api/v1/runs` | Run history, newest first, filtered and paged | `application/json` |
| GET | `/api/v1/runs/issues` | Run history grouped by issue, newest first, filtered and paged | `application/json` |
| GET | `/api/v1/runs/{dispatch_id}/events` | The agent events Sortie kept for one run | `application/json` |
| GET | `/api/v1/stats` | Run statistics over a completion-time range | `application/json` |
| GET | `/api/v1/prices` | Rates in force per agent kind and model, and the state of every price source | `application/json` |
| GET | `/api/v1/{identifier}` | Per-issue detail and run history | `application/json` |
| GET | `/api/v1/events` | Stream of change signals, heartbeats, and the agent events of the runs named with `run` | `text/event-stream` |
| POST | `/api/v1/refresh` | Trigger immediate poll cycle | `application/json` |
| POST | `/api/v1/retries/{identifier}/run` | Make a scheduled retry due now | `application/json` |
| POST | `/api/v1/reactions/{identifier}/{kind}/check` | Make a pending reaction's next check due now | `application/json` |
| POST | `/api/v1/attention/{id}/acknowledge` | Acknowledge an attention item | `application/json` |
| GET | `/metrics` | Prometheus metrics | `text/plain` |
