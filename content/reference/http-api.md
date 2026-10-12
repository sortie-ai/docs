---
title: "HTTP API"
description: "Complete reference for Sortie's embedded HTTP server: JSON API endpoints, request/response shapes, error codes, and curl examples."
author: Sortie AI
date: 2026-04-13
weight: 40
url: /reference/http-api/
---
Sortie embeds an HTTP server that exposes a JSON API, an HTML dashboard, health probes, and Prometheus metrics, all on a single port.

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

The run history table lists recently completed sessions. Each entry contains:

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

Each completed run also stores the settings it ran with, in three text columns of `run_history`: `configured_model` and `configured_effort` (what the attempt was asked to run) and `reported_model` (what the runtime reported running). [Configured and reported model](#configured-and-reported-model) explains how to read the pair. The dashboard table and the JSON endpoints do not show these columns, so query them directly:

```sh
sqlite3 .sortie.db "SELECT identifier, configured_model, configured_effort, reported_model FROM run_history ORDER BY started_at DESC LIMIT 5"
```

An unset value is an empty string, not `NULL`. All three columns are empty on runs recorded before Sortie stored them and on `ci_failed` rows. [`sortie stats`](/reference/cli/#configured-model-breakdown) aggregates the configured model; it does not read `reported_model` or `configured_effort`.

---

## GET /api/v1/state: System state

Returns a full runtime snapshot: running sessions, retry queue, budget-exhausted and parked issues, aggregate totals, and rate limits.

```sh
curl http://localhost:7678/api/v1/state
```

### Response

```json
{
  "generated_at": "2026-03-26T14:30:00Z",
  "counts": {
    "running": 1,
    "retrying": 1,
    "budget_exhausted": 1,
    "parked": 1
  },
  "running": [
    {
      "issue_id": "abc123",
      "issue_identifier": "MT-649",
      "issue_title": "Fix the flaky login test",
      "issue_url": "https://tracker.example.com/browse/MT-649",
      "issue_labels": ["bug", "backend"],
      "state": "In Progress",
      "session_id": "session-abc-001",
      "turn_count": 7,
      "self_review_active": false,
      "self_review_iteration": 0,
      "last_event": "turn_completed",
      "last_message": "",
      "started_at": "2026-03-26T14:10:12Z",
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
      "issue_cost_status": "estimated"
    }
  ],
  "retrying": [
    {
      "issue_id": "def456",
      "issue_identifier": "MT-650",
      "issue_title": "Retry the export job",
      "issue_url": "https://tracker.example.com/browse/MT-650",
      "attempt": 3,
      "due_at": "2026-03-26T14:35:00Z",
      "error": "no available orchestrator slots",
      "trigger": "timer",
      "rule_name": "bugfix",
      "stage_lineage": null,
      "paused": false
    }
  ],
  "budget_exhausted": [
    {
      "issue_id": "ghi789",
      "issue_identifier": "MT-651",
      "issue_title": "Migrate the billing tables",
      "issue_url": "https://tracker.example.com/browse/MT-651",
      "reason": "session_budget",
      "used_sessions": 3,
      "budget_sessions": 3,
      "used_tokens": null,
      "budget_tokens": 0,
      "unmeasured_sessions": null,
      "stopped_in_flight": null,
      "exhausted_at": "2026-03-26T14:12:00Z"
    }
  ],
  "parked": [
    {
      "issue_id": "jkl012",
      "issue_identifier": "MT-652",
      "issue_title": "Rotate the signing keys",
      "issue_url": "https://tracker.example.com/browse/MT-652",
      "reason": "agent_blocked",
      "parked_state": "In Progress",
      "label": "needs-human",
      "label_applied": true,
      "parked_at": "2026-03-26T14:05:00Z"
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
  "cost_unpriced_running": 0
}
```

### Field notes

**`running[]` entries:**

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `issue_title` | The tracker's title of the issue, as read when the session was dispatched and unchanged for the whole run. Omitted when the tracker returned none. |
| `issue_url` | The tracker's web link to the issue, as read at dispatch. Omitted when the tracker returned none. |
| `issue_labels` | The issue's labels as read at dispatch, lowercase and in the tracker's order. Always present; `[]` when the issue has none. |
| `ssh_host` | The [SSH host](/reference/workflow-config/#worker) the session runs on. Omitted for a session that runs on the machine running Sortie. |
| `workflow_file` | Base filename of the `WORKFLOW.md` in force at dispatch. Omitted when unset. |
| `agent_kind` | The agent kind the session runs, from the configuration in force at dispatch. Omitted when unset. |
| `self_review_active` | `true` while the session is in its self-review phase. |
| `self_review_iteration` | Self-review iterations completed in the current phase: `0` while the first one runs, and whenever `self_review_active` is `false`. |
| `turn_count` | Number of turns this session has run: the coding turns plus any review and fix turns from self-review. Advances by one the instant a turn starts, the same way for every agent kind, and resets to `0` at the start of each attempt. [`agent.max_turns`](/reference/workflow-config/#agent) caps only the coding turns, so this figure can run higher once self-review is active. |
| `tokens` | Nested object with `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, and `cache_write_tokens` for this session. `total_tokens` is `input_tokens + output_tokens`; both cache counters are disjoint subsets of `input_tokens`, never additions to it. Each member is an integer or `null`, and all five are `null` together exactly when `tokens_measured` is `false`. |
| `tokens_measured` | `false` until the coding agent reports token usage for this session, including before the first turn begins; that is what makes the members of `tokens` `null` rather than `0`. `true` once any usage figure has been reported. Stays `false` for the life of a session whose `usage_arrival` is `"none"`, whatever its runtime sends. |
| `workspace_path` | Absolute filesystem path to the issue's workspace directory. |
| `model_name` | LLM model the runtime reported running. Omitted when unknown, and when `usage_arrival` is `"none"`. It can differ from `configured_model`; see [configured and reported model](#configured-and-reported-model). |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) that routed this session. Omitted when no rule routed it. |
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
| `used_sessions` | Integer or `null`. The issue's completed sessions: the run-history count that [`agent.max_sessions`](/reference/workflow-config/#agent) is compared with. The running session is not counted, and a recorded CI result counts as a session. `null` when no read of the issue's run history has succeeded for this run. |
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

#### Configured and reported model

A running row carries two answers to "which model is this?". `configured_model` and `configured_effort` are what the attempt was asked to run. Sortie resolves them when the attempt starts: the agent kind's top-level block with the matching dispatch rule's block laid over it. They stay fixed for the session, and the next attempt of the same issue resolves them again from the workflow in force at that moment, so a retry after an edit to `WORKFLOW.md` can show different values. `model_name` is what the runtime reported running, taken from its token usage events.

Nothing compares the two, and a reported model never replaces a configured one. They differ legitimately: a routing alias in `configured_model` resolves to a dated model name in `model_name`, and a runtime can fall back to another model when the configured one is unavailable. A mismatch is therefore not a fault by itself. Read `model_name` as what ran and `configured_model` as what the workflow asked for. The cost and quality of the work belong to the model that ran.

The dashboard shows the same values as **Configured model**, **Configured effort**, and **Reported model**. Completed runs keep all three; see [run history entries](#run-history-entries).

`issue_title`, `issue_url`, and `issue_labels` pass through the same masking as the logs: a value Sortie knows to be a secret reads `[redacted]`. A Jira link carries no user name or password written into `tracker.endpoint`.

**`retrying[]` entries:**

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `issue_title` | The tracker's title of the issue. Omitted when empty, which on a retry means Sortie has not fetched the issue's title since the retry was restored. Masked like the running row's. |
| `issue_url` | The tracker's web link to the issue, under the same rule as `issue_title`. |
| `trigger` | The `sortie_retries_total` label of the schedule that created the retry: `error`, `continuation`, `timer`, `stall`, or `ci_fix`. See the [metrics reference](/reference/prometheus-metrics/#counters). Omitted for a review, bot review, merge conflict, or label command continuation, which `reaction_kind` names instead, and for a retry restored from a row stored by an earlier release until it next comes due. |
| `reaction_kind` | The reaction behind the retry: `ci`, `review`, `bot-review`, `merge`, `merge-conflict`, `label-review`, `label-fix`, or `merge-completion`. Omitted when the retry carries none. An `error` or `stall` retry of a run that a reaction dispatched carries that run's kind, and a `timer` row keeps the kind of the retry it replaced. |
| `reaction_config_key` | The key under [`reactions`](/reference/reactions/) in `WORKFLOW.md` that configures `reaction_kind`: `ci_failure`, `review_comments`, `bot_review`, `auto_merge`, `merge_conflicts`, `label_commands` (for both `label-review` and `label-fix`), or `merge_completion`. Omitted whenever `reaction_kind` is. |
| `rule_name` | Name of the [dispatch rule](/reference/workflow-config/#dispatch) of the run the retry follows, frozen with the retry. Omitted when no rule routed that run. If the configuration in force no longer reaches that rule when the retry fires, the retry dispatches on another one. |
| `stage_lineage` | Always present. `null` unless a [stage hop](/reference/state-machine/#stage-hop) reached the run the retry follows. Otherwise an object with `previous` (the rule whose hop reached the run), `previous_outcome` (`succeeded` or `no_change`), and `chain_id` (the [stage chain](/reference/workflow-config/#stage-chains) the run belongs to). Each member is omitted when empty. |
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

A retry keeps the title and link it was scheduled with. Sortie stores them with the retry and restores them at startup, so a restart serves what was served before it. A retry stored by an earlier release has neither until the next poll whose candidates include its issue, or until the retry next fires. Neither replaces a title and link the retry already holds.

**`budget_exhausted[]` entries:** Issues held out of dispatch by a per-issue budget ceiling ([`agent.max_sessions`](/reference/workflow-config/#agent) or [`agent.max_tokens`](/reference/workflow-config/#agent)).

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read by the poll that last rebuilt the held set, or by the retry the hold was found on until the next poll. Each omitted when empty. Masked like the running row's. |
| `reason` | `session_budget` or `token_budget`: which ceiling stopped dispatch. |
| `used_sessions`, `budget_sessions` | Completed sessions for the issue against the configured `agent.max_sessions`. `budget_sessions` is `0` when no session budget is set, unlike the same key on a `running[]` entry, where it is `null`. |
| `used_tokens`, `budget_tokens` | Measured cumulative tokens against the configured `agent.max_tokens`. `budget_tokens` is `0` when no token ceiling is set, unlike the same key on a `running[]` entry, where it is `null`. `used_tokens` is `null` only on a `session_budget` entry, and there only when the token ceiling has not been evaluated for the issue: `agent.max_tokens` is `0`, or reading the issue's token spend failed. |
| `unmeasured_sessions` | Count of the issue's sessions whose agent reported no token usage. `null` exactly when `used_tokens` is `null`. |
| `stopped_in_flight` | Count of the issue's sessions that the token ceiling stopped while they were running, recorded with status `budget_stopped`. `null` exactly when `used_tokens` is `null`. |
| `exhausted_at` | When the hold began. |

**`parked[]` entries:** Issues held out of dispatch until a person acts on them. The list is always present, `[]` when no issue is parked, and sorted by `issue_identifier`, then `issue_id`. `counts.parked` equals its length. An issue appears in every list that holds it, so a parked issue that also has a reaction continuation queued is in `parked` and `retrying` both. For how a park is recorded and lifted, see [agent communication](/concepts/agent-communication/).

| Field | Description |
|---|---|
| `display_identifier` | Human-facing identifier when the tracker distinguishes it from `issue_identifier`. Omitted when empty. |
| `issue_title`, `issue_url` | The tracker's title and web link, as read when the park was recorded. A park recorded or restored without a read takes one at the first poll tick on which the tracker answers for the issue, and a read already held is never replaced. Each omitted when empty. Masked like the running row's. |
| `reason` | `agent_blocked` (the agent reported itself blocked) or `handoff_absence` (the consecutive handoff-absence ceiling was reached). |
| `parked_state` | The tracker state observed when the park was recorded, or at the first observation after a park recorded before any read. Omitted while unobserved. Masked. |
| `label` | The parking label Sortie applied. |
| `label_applied` | `true` once a read showed the label on the issue. |
| `parked_at` | When the park was recorded, as an RFC 3339 timestamp in UTC. |

**`agent_totals`:** Cumulative across all sessions since Sortie's database was created, carried over when Sortie restarts; a session whose coding agent has reported no token usage, running or completed, adds nothing to its five token counts. `seconds_running` includes elapsed time from currently active sessions, not only completed ones. Three further fields disclose, by reason, how many sessions those counts leave out:

| Field | Description |
|---|---|
| `unmeasured_sessions` | Ended sessions whose token usage was never recorded. Persisted, so it survives a restart. An upgrade backfills it from existing run history, but only as far back as Sortie has distinguished a measured run from an unmeasured one; an older run reads as measured and is not counted, even one that actually reported nothing. |
| `running_unreported` | Currently running sessions whose agent kind reports usage, which have reported no figure yet and can still report one. |
| `running_non_reporting` | Currently running sessions that will contribute no figure: `usage_arrival` is `"none"`, or it reports figures and the moment one could have arrived has passed with nothing counted. The two counts partition the running sessions the token totals exclude, so a session moves from `running_unreported` to this one rather than staying in limbo. |

**`active_estimated_cost_usd`:** Estimated total cost across currently running sessions, computed from configured [token rates](/reference/workflow-config/#token_rates) and each running session's agent adapter kind. Sessions whose `tokens_measured` is `false` are excluded. Omitted when no running, measured session matches an entry containing both input and output rates. It equals the sum of `estimated_cost_usd` over the `running[]` entries whose `cost_status` is `"estimated"`. This is a presentation-layer estimate, not provider billing data.

**`cost_unpriced_running`:** Count of running, measured sessions that `active_estimated_cost_usd` leaves out because their agent kind has no `token_rates` entry or its entry lacks `input_per_mtok` or `output_per_mtok`. Present, zero included, whenever `token_rates` holds any agent-kind entry, complete or not; omitted when `token_rates` is absent or empty. When present, it equals the number of `running[]` entries whose `cost_status` is `"unpriced"`. Without `token_rates`, every measured `running[]` entry reads `"unpriced"` while this key is absent.

**`rate_limits`:** Reserved for future use. Currently an empty object.

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Snapshot returned. |
| `503 Service Unavailable` | Orchestrator state snapshot could not be produced. |

---

## GET /api/v1/{identifier}: Issue detail

Returns issue-specific runtime and debug details. The `{identifier}` path parameter is the issue identifier (e.g., `MT-649`), not the internal issue ID.

```sh
curl http://localhost:7678/api/v1/MT-649
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
    "issue_title": "Fix the flaky login test",
    "issue_url": "https://tracker.example.com/browse/MT-649",
    "issue_labels": ["bug", "backend"],
    "state": "In Progress",
    "session_id": "session-abc-001",
    "turn_count": 7,
    "self_review_active": false,
    "self_review_iteration": 0,
    "last_event": "turn_completed",
    "last_message": "Working on tests",
    "started_at": "2026-03-26T14:10:12Z",
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
    "issue_cost_status": "estimated"
  },
  "retry": null,
  "budget_exhausted": null,
  "parked": null,
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
    "issue_title": "Retry the export job",
    "issue_url": "https://tracker.example.com/browse/MT-650",
    "attempt": 3,
    "due_at": "2026-03-26T14:35:00Z",
    "error": "no available orchestrator slots",
    "trigger": "timer",
    "rule_name": "bugfix",
    "stage_lineage": null,
    "paused": false
  },
  "budget_exhausted": null,
  "parked": null,
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
    "reason": "session_budget",
    "used_sessions": 3,
    "budget_sessions": 3,
    "used_tokens": null,
    "budget_tokens": 0,
    "unmeasured_sessions": null,
    "stopped_in_flight": null,
    "exhausted_at": "2026-03-26T14:12:00Z"
  },
  "parked": null,
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
    "reason": "agent_blocked",
    "parked_state": "In Progress",
    "label": "needs-human",
    "label_applied": true,
    "parked_at": "2026-03-26T14:05:00Z"
  },
  "recent_events": [],
  "last_error": null,
  "tracked": {}
}
```

### Field notes

| Field | Description |
|---|---|
| `status` | One of `"running"`, `"retrying"`, `"budget_exhausted"`, or `"parked"`. Derived from which set the issue appears in; `running` takes precedence over `retrying`, which takes precedence over `budget_exhausted`, which takes precedence over `parked`. |
| `workspace` | Contains `path` when the issue has an active workspace. `null` for retrying, budget-exhausted, and parked issues, or when the workspace path is unknown. |
| `attempts.restart_count` | How many times this issue has been restarted (attempt minus one, floored at zero). |
| `attempts.current_retry_attempt` | The current attempt number. `0` for running, budget-exhausted, and parked issues that have no pending retry. |
| `running` | Full running entry (same shape as entries in `/api/v1/state`), or `null`. |
| `retry` | Full retry entry (same shape as entries in the `retrying` array on `/api/v1/state`), or `null`. |
| `budget_exhausted` | Full budget-exhausted entry (same shape as entries in the `budget_exhausted` array on `/api/v1/state`), or `null`. |
| `parked` | Full parked entry (same shape as entries in the `parked` array on `/api/v1/state`), or `null`. Always present. Populated whenever the issue is parked, whatever `status` reads. |
| `recent_events` | Reserved for future use. Currently an empty array. |
| `last_error` | The `error` of the issue's retry entry, or `null` when it has none. After a reschedule this is the reschedule reason. |
| `tracked` | Reserved for future use. Currently an empty object. |

### Status codes

| Code | Meaning |
|---|---|
| `200 OK` | Issue found and returned. |
| `404 Not Found` | Identifier not present in the running set, the retry queue, the budget-exhausted set, or the parked set. The issue may have completed, or it may not exist. |
| `503 Service Unavailable` | Orchestrator state snapshot could not be produced. |

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
  "operations": ["poll", "reconcile"]
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
    "message": "issue identifier \"XYZ-999\" not found in current state"
  }
}
```

### Error codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `issue_not_found` | 404 | The requested issue identifier is not running, retrying, budget-exhausted, or parked. |
| `snapshot_unavailable` | 503 | The orchestrator could not produce a state snapshot. |
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
