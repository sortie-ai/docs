---
title: "Prometheus Metrics | Sortie"
description: "Complete reference for all Prometheus metrics exposed by Sortie: gauges, counters, histograms, labels, PromQL examples, and Grafana dashboard."
keywords: sortie prometheus, metrics reference, PromQL, grafana dashboard, observability, monitoring
author: Sortie AI
---

# Prometheus metrics reference

Sortie exposes a `/metrics` endpoint in Prometheus text exposition format on the same port as the JSON API and HTML dashboard. The HTTP server starts by default on port `7678`. See [CLI reference](cli.md#-port) for port and host configuration.

!!! note
    When the HTTP server is disabled (`--port 0`), the orchestrator uses a no-op metrics implementation. Metrics are not collected internally — they are discarded, not buffered.

## Gauges

Point-in-time values. Sortie updates these after every state mutation — dispatch, worker exit, retry, reconciliation.

| Name | Labels | Description | Producing layer |
|---|---|---|---|
| `sortie_sessions_running` | — | Currently running agent sessions. | Coordination |
| `sortie_sessions_retrying` | — | Issues awaiting retry. Includes error retries, continuation retries, and stall retries sitting in the timer queue. | Coordination |
| `sortie_slots_available` | — | Remaining dispatch slots: `max_concurrent_agents - running - claimed`. Reaches 0 when the orchestrator is at capacity. | Coordination |
| `sortie_active_sessions_elapsed_seconds` | — | Sum of wall-clock elapsed seconds across all running sessions. Recomputed from each session's `started_at` timestamp on every poll cycle. Use this to detect active work even when no sessions have recently completed (the runtime counter only increments on session end). | Coordination |
| `sortie_ssh_host_usage` | `host` | Active workers on a given SSH host. Only populated when [`extensions.worker.ssh_hosts`](workflow-config.md) is configured. | Coordination |

The `host` label on `sortie_ssh_host_usage` matches the values in your `ssh_hosts` list exactly (e.g., `host="build01.internal"`).

## Counters

Monotonically increasing. Apply `rate()` or `increase()` to extract per-second or per-interval throughput.

| Name | Labels | Description | Producing layer |
|---|---|---|---|
| `sortie_tokens_total` | `type` | Cumulative LLM tokens consumed. `type` is `input`, `output`, or `cache_read`. | Coordination |
| `sortie_agent_runtime_seconds_total` | — | Cumulative agent runtime. Incremented when a session ends, not while it runs. For live elapsed time, use the `sortie_active_sessions_elapsed_seconds` gauge. | Coordination |
| `sortie_dispatches_total` | `outcome` | Dispatch attempts. `outcome` is `success` (worker spawned) or `error` (spawn failed). | Coordination |
| `sortie_worker_exits_total` | `exit_type` | Worker session completions. `exit_type` is `normal` (agent finished), `error` (agent or infrastructure failure), or `cancelled` (reconciliation or shutdown). | Coordination |
| `sortie_retries_total` | `trigger` | Retry scheduling events. `trigger` is `error` (failed attempt), `continuation` (successful turn, more work remains), `timer` (retry timer fired), or `stall` (stall timeout detected). | Coordination |
| `sortie_reconciliation_actions_total` | `action` | Reconciliation outcomes per issue checked. `action` is `stop` (issue state no longer active), `cleanup` (terminal state, workspace removed), or `keep` (still active, no action). | Coordination |
| `sortie_poll_cycles_total` | `result` | Poll tick outcomes. `result` is `success` (fetched and dispatched), `error` (tracker fetch failed), or `skipped` (preflight validation failed, dispatch skipped). | Coordination |
| `sortie_tracker_requests_total` | `operation`, `result` | Tracker adapter API calls. Each adapter method increments this independently — the orchestrator never touches it. `operation` is `fetch_candidates`, `fetch_issue`, `fetch_comments`, `transition`, or `comment`. `result` is `success` or `error`. | Integration |
| `sortie_handoff_transitions_total` | `result` | Handoff state transition outcomes. `result` is `success` (issue transitioned), `error` (transition API failed, retry scheduled as fallback), or `skipped` (no `handoff_state` configured). | Coordination |
| `sortie_dispatch_transitions_total` | `result` | Dispatch-time in-progress transition outcomes. `result` is `success` (issue transitioned at dispatch), `error` (transition API failed; worker continues to workspace preparation), or `skipped` (issue was already in the target state). Only recorded when [`tracker.in_progress_state`](workflow-config.md) is configured. | Coordination |
| `sortie_tracker_comments_total` | `lifecycle`, `result` | Tracker comment attempts. `lifecycle` is `dispatch`, `completion`, or `failure`. `result` is `success` or `error`. Only recorded when [`tracker.comments.*`](workflow-config.md) flags are enabled. Comment failures are non-fatal — they increment the `error` result but never block the orchestrator. | Coordination |
| `sortie_tool_calls_total` | `tool`, `result` | Agent tool call completions. `tool` is the tool name (e.g., `Bash`, `tracker_api`). `result` is `success` or `error`. | Coordination |
| `sortie_ci_status_checks_total` | `result` | CI status check outcomes. `result` is `passing`, `pending`, `failing`, or `error`. Only recorded when the CI reconciliation loop runs. | Coordination |
| `sortie_ci_escalations_total` | `action` | CI escalation actions taken when checks remain non-passing beyond the configured threshold. `action` is `label`, `comment`, or `error`. | Coordination |

## Histograms

Distribution summaries with pre-defined buckets. Query percentiles with `histogram_quantile()`. Each histogram produces `_bucket`, `_sum`, and `_count` time series automatically.

| Name | Labels | Description | Buckets | Producing layer |
|---|---|---|---|---|
| `sortie_poll_duration_seconds` | — | Wall-clock time per complete poll cycle (tracker fetch through dispatch). | Exponential from 0.1s, factor 2, 10 buckets (0.1s → 51.2s) | Coordination |
| `sortie_worker_duration_seconds` | `exit_type` | Wall-clock time per worker session, from spawn to exit. `exit_type` is `normal`, `error`, or `cancelled`. | Exponential from 10s, factor 2, 12 buckets (10s → ~5.7h) | Coordination |

The poll duration histogram is tuned for O(seconds) cycles — tracker API latency plus dispatch overhead. The worker duration histogram covers the full range from quick failures (tens of seconds) to long-running agent sessions (hours).

Bucket boundaries for `sortie_poll_duration_seconds`: 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2 seconds.

Bucket boundaries for `sortie_worker_duration_seconds`: 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480 seconds (~10s to ~5.7h).

## Info

Static metadata exposed as a gauge with constant value 1.

| Name | Labels | Description | Producing layer |
|---|---|---|---|
| `sortie_build_info` | `version`, `go_version` | Build metadata. Use to verify which Sortie version is running and to join with other metrics in Grafana dashboards. | Observability |

```promql
sortie_build_info
# => sortie_build_info{go_version="go1.24.1",version="0.5.0"} 1
```

## Cardinality model

You will not find `issue_id` or `issue_identifier` as Prometheus labels. This is deliberate.

Sortie's concurrency is O(10) agents, not O(10,000) microservice endpoints — but issue identifiers are unbounded over time. Adding them as labels would create an ever-growing number of time series that degrades Prometheus storage and query performance for no operational benefit.

Prometheus answers aggregate questions: "How many sessions are running?", "What is the token burn rate?", "Are dispatches failing?" The [JSON API](http-api.md) answers per-issue questions: "What is PROJ-42 doing right now?", "How many tokens has this session consumed?" Use both.

## PromQL examples

These queries assume the default 15-second scrape interval. Adjust `rate()` windows if your interval differs — the window should span at least 4 scrape intervals.

### Token burn rate

```promql
sum(rate(sortie_tokens_total[5m])) by (type) * 60
```

Tokens per minute, broken down by `input` and `output`. Multiply by your provider's per-token pricing to get cost per minute.

### Dispatch throughput and error rate

```promql
sum(rate(sortie_dispatches_total[5m])) by (outcome)
```

Dispatches per second by outcome. A sustained non-zero `outcome="error"` rate means workspace preparation or agent spawn is failing — check structured logs for the root cause.

To get the error ratio as a percentage:

```promql
rate(sortie_dispatches_total{outcome="error"}[5m])
/ on() sum(rate(sortie_dispatches_total[5m]))
* 100
```

### Active sessions

```promql
sortie_sessions_running
```

Current running sessions. For capacity headroom:

```promql
sortie_slots_available / (sortie_sessions_running + sortie_slots_available) * 100
```

Percentage of dispatch capacity remaining. Alert when this stays below 10% — you are running near your concurrency ceiling.

### Worker duration percentiles

```promql
histogram_quantile(0.50, rate(sortie_worker_duration_seconds_bucket[30m]))
histogram_quantile(0.95, rate(sortie_worker_duration_seconds_bucket[30m]))
histogram_quantile(0.99, rate(sortie_worker_duration_seconds_bucket[30m]))
```

p50, p95, and p99 worker session duration over the last 30 minutes. Use a wider window (30m+) because worker sessions are long-lived — a 5-minute window may not contain enough completed sessions for meaningful percentiles.

### Retry rate by trigger

```promql
sum(rate(sortie_retries_total[5m])) by (trigger)
```

Retries per second by trigger type. A spike in `trigger="error"` retries signals systemic agent failures. A spike in `trigger="stall"` retries means agents are hanging — check `agent.stall_timeout_ms` in your workflow config.

### Poll cycle duration trend

```promql
rate(sortie_poll_duration_seconds_sum[5m]) / rate(sortie_poll_duration_seconds_count[5m])
```

Average poll cycle duration over 5 minutes. This is dominated by tracker API latency. If it climbs steadily, your tracker is slowing down or returning larger result sets.

### Tool call error rate

```promql
sum(rate(sortie_tool_calls_total{result="error"}[5m])) by (tool)
/ on(tool) sum(rate(sortie_tool_calls_total[5m])) by (tool)
* 100
```

Error percentage per tool. A high error rate on `tracker_api` suggests credential or connectivity issues with your tracker. High error rates on other tools (e.g., `Bash`) are usually agent-side problems, not Sortie infrastructure issues.

## Grafana dashboard

A reference Grafana dashboard JSON is available for import at [`grafana-dashboard.json`](/downloads/grafana-dashboard.json). It is tested against Grafana 10+ and uses the `sortie_` metrics documented on this page.

The dashboard organizes panels into seven collapsible rows. Each panel maps to one or more metrics from the tables above.

| Row | Panel | Metric(s) | Visualization |
|---|---|---|---|
| Overview | Build info | `sortie_build_info` | Stat (`version`, `go_version`) |
| Overview | Active sessions | `sortie_sessions_running`, `sortie_sessions_retrying`, `sortie_slots_available` | Stat + time series |
| Overview | Active sessions elapsed | `sortie_active_sessions_elapsed_seconds` | Stat |
| Throughput | Token consumption | `sortie_tokens_total` | Time series (rate) by `type` |
| Throughput | Dispatch outcomes | `sortie_dispatches_total` | Time series (rate), `success` vs `error` |
| Throughput | Agent runtime | `sortie_agent_runtime_seconds_total` | Time series (rate) |
| Workers | Worker exits | `sortie_worker_exits_total` | Time series (rate) by `exit_type` |
| Workers | Worker duration | `sortie_worker_duration_seconds` | Heatmap + p50/p95/p99 percentile lines |
| Reliability | Retry activity | `sortie_retries_total` | Time series (rate) by `trigger` |
| Reliability | Poll cycle health | `sortie_poll_cycles_total`, `sortie_poll_duration_seconds` | Count + duration overlay |
| Reliability | Reconciliation actions | `sortie_reconciliation_actions_total` | Time series (rate) by `action` |
| Integration | Tracker API | `sortie_tracker_requests_total` | Time series (rate) by `operation` × `result` |
| Integration | Handoff transitions | `sortie_handoff_transitions_total` | Stat counters by `result` |
| Integration | Dispatch transitions | `sortie_dispatch_transitions_total` | Stat counters by `result` |
| Integration | Tracker comments | `sortie_tracker_comments_total` | Time series (rate) by `lifecycle` × `result` |
| CI Feedback | CI status checks | `sortie_ci_status_checks_total` | Time series (rate) by `result` |
| CI Feedback | CI escalations | `sortie_ci_escalations_total` | Time series (rate) by `action` |
| Agent | Tool calls | `sortie_tool_calls_total` | Time series (rate) by `tool` |
| Agent | SSH host utilization | `sortie_ssh_host_usage` | Bar gauge per `host` (hidden when no SSH hosts configured) |

Import the JSON file in Grafana via **Dashboards → Import → Upload JSON file**. Set your Prometheus data source when prompted.

## Scrape configuration

Add Sortie as a scrape target in `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: sortie
    static_configs:
      - targets: ["localhost:7678"]
```

Replace `localhost:7678` with the host and port where Sortie's HTTP server is running. Sortie binds to `127.0.0.1` by default — if Prometheus runs on a different machine, pass `--host 0.0.0.0` to Sortie or configure a reverse proxy to make the port reachable.

The endpoint also serves `promhttp_metric_handler_requests_total` and `promhttp_metric_handler_errors_total` for scrape self-instrumentation, plus Go runtime metrics (`go_goroutines`, `go_memstats_*`, `process_*`) from the standard process and Go collectors.

For a complete setup walkthrough covering installation, alerting rules, and remote host discovery, see [Monitor with Prometheus](../guides/monitor-with-prometheus.md).
