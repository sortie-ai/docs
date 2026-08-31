---
title: "Prometheus Metrics"
description: "Complete reference for all Prometheus metrics exposed by Sortie: gauges, counters, histograms, labels, PromQL examples, and Grafana dashboard."
author: Sortie AI
date: 2026-03-26
weight: 60
url: /reference/prometheus-metrics/
---
Sortie exposes a `/metrics` endpoint in Prometheus text exposition format on the same port as the JSON API and HTML dashboard. The HTTP server starts by default on port `7678`. See [CLI reference](/reference/cli/#-port) for port and host configuration.

> [!NOTE]
> When the HTTP server is disabled (`--port 0`), the orchestrator uses a no-op metrics implementation. Metrics are not collected internally - they are discarded, not buffered.

## Gauges

Point-in-time values. Sortie updates these after every state mutation - dispatch, worker exit, retry, reconciliation.

| Name | Labels | Description | Producing layer |
|---|---|---|---|
| `sortie_sessions_running` | - | Currently running agent sessions. | Coordination |
| `sortie_sessions_retrying` | - | Issues awaiting retry. Includes error retries, continuation retries, and stall retries sitting in the timer queue. | Coordination |
| `sortie_slots_available` | - | Remaining dispatch slots: `max_concurrent_agents - running`. Reaches 0 when the orchestrator is at capacity. | Coordination |
| `sortie_active_sessions_elapsed_seconds` | - | Sum of wall-clock elapsed seconds across all running sessions. Recomputed from each session's `started_at` timestamp on every poll cycle. Use this to detect active work even when no sessions have recently completed (the runtime counter only increments on session end). | Coordination |
| `sortie_ssh_host_usage` | `host` | Active workers on a given SSH host. Only populated when [`extensions.worker.ssh_hosts`](/reference/workflow-config/) is configured. | Coordination |
| `sortie_budget_exhausted_issues` | `reason` | Issues currently held out of dispatch by a per-issue budget ceiling. `reason` is `session_budget` or `token_budget`. Recomputed on every poll tick; a reason that no longer holds any issue reports `0` rather than keeping its last value. | Coordination |

The `host` label on `sortie_ssh_host_usage` matches the values in your `ssh_hosts` list exactly (e.g., `host="build01.internal"`).

## Counters

Monotonically increasing. Apply `rate()` or `increase()` to extract per-second or per-interval throughput.

| Name | Labels | Description | Producing layer |
|---|---|---|---|
| `sortie_tokens_total` | `type` | Cumulative LLM tokens consumed. `type` is `input`, `output`, or `cache_read`. `cache_read` is the subset of `input` served from a prompt cache, so summing across all three label values double-counts it. A `type` appears only once a non-zero amount has been recorded for it, and a session whose coding agent reported no token usage advances no series at all. | Coordination |
| `sortie_agent_runtime_seconds_total` | - | Cumulative agent runtime. Incremented when a session ends, not while it runs. For live elapsed time, use the `sortie_active_sessions_elapsed_seconds` gauge. | Coordination |
| `sortie_dispatches_total` | `outcome` | Dispatch attempts. `outcome` is `success` (worker spawned) or `error` (spawn failed). | Coordination |
| `sortie_worker_exits_total` | `exit_type` | Worker session completions. `exit_type` is `normal` (agent finished), `error` (agent or infrastructure failure), `cancelled` (reconciliation or shutdown), or `soft_stop` (the agent wrote a recognized control-file signal; see the [agent extensions reference](/reference/agent-extensions/)). | Coordination |
| `sortie_retries_total` | `trigger` | Retry scheduling events. `trigger` is `error` (failed attempt), `continuation` (successful turn, more work remains), `timer` (retry timer fired), or `stall` (stall timeout detected). | Coordination |
| `sortie_reconciliation_actions_total` | `action` | Reconciliation outcomes per issue checked. `action` is `stop` (issue state no longer active), `cleanup` (terminal state, workspace removed), `keep` (still active, no action), `sweep_cleanup` (terminal state, workspace removed by the periodic sweep), or `sweep_expired` (workspace removed by the sweep's age-based retention bound). | Coordination |
| `sortie_poll_cycles_total` | `result` | Poll tick outcomes. `result` is `success` (fetched and dispatched), `error` (tracker fetch failed), or `skipped` (preflight validation failed, dispatch skipped). | Coordination |
| `sortie_tracker_requests_total` | `operation`, `result` | Tracker adapter API calls. Each adapter method increments this independently - the orchestrator never touches it. `operation` includes `fetch_candidates`, `fetch_issue`, `fetch_comments`, `fetch_blockers` (the per-candidate blocker read on GitHub and Gitea), `transition`, and `comment`. `result` is `success` or `error`. | Integration |
| `sortie_handoff_transitions_total` | `result` | Handoff state transition outcomes. `result` is `success` (issue transitioned), `error` (transition API failed, retry scheduled as fallback), `skipped` (a handoff state is configured but no transition was performed, for one of three reasons this label does not distinguish: the issue had already reached a terminal state, it had left the active set, or the run's evidence verdict withheld the handoff and the verification read taken before recording that outcome reported the issue terminal), or `withheld` (the evidence verdict withheld the handoff and that verification read did not report a terminal state, so the run is recorded as failed). Never recorded when `handoff_state` is unset. | Coordination |
| `sortie_issue_parks_total` | `reason` | Issue park events. `reason` is `handoff_absence` (the consecutive handoff-absence ceiling was reached) or `agent_blocked` (the agent reported itself blocked). | Coordination |
| `sortie_budget_exhaustions_total` | `reason` | Issues entering the per-issue budget-exhausted set. `reason` is `session_budget` or `token_budget`. Incremented once per hold, by whichever lane - the poll-tick rebuild or the retry timer - discovers it. | Coordination |
| `sortie_dispatch_transitions_total` | `result` | Dispatch-time in-progress transition outcomes. `result` is `success` (issue transitioned at dispatch), `error` (transition API failed; worker continues to workspace preparation), or `skipped` (issue was already in the target state). Only recorded when [`tracker.in_progress_state`](/reference/workflow-config/) is configured. | Coordination |
| `sortie_tracker_comments_total` | `lifecycle`, `result` | Tracker comment attempts. `lifecycle` is `dispatch`, `completion`, or `failure` (gated on [`tracker.comments.*`](/reference/workflow-config/) flags), or `budget_hold` (the notice posted when a per-issue budget ceiling is reached, independent of those flags and paced to at most ten notices per thirty-second window). `result` is `success` or `error`. Comment failures are non-fatal - they increment the `error` result but never block the orchestrator. | Coordination |
| `sortie_tool_calls_total` | `tool`, `result` | Agent tool call completions. `tool` is the tool name (e.g., `Bash`, `tracker_api`). `result` is `success` or `error`. | Coordination |
| `sortie_ci_status_checks_total` | `result` | CI status check outcomes. `result` is `passing`, `pending`, `failing`, or `error`. Only recorded when the CI reconciliation loop runs. | Coordination |
| `sortie_ci_escalations_total` | `action` | CI escalation actions, taken when checks remain non-passing beyond the configured threshold and when a [`triage` command](/reference/reactions/#triage-command) answers `escalate`. `action` is `label`, `comment`, or `error`. | Coordination |
| `sortie_reactions_auto_merge_total` | `result` | Auto-merge reaction outcomes. `result` is `merged` (PR merged), `escalated` (retry budget exhausted, issue labeled or commented for a human), or `error` (a merge precondition or API call failed and the attempt is retried). Precondition-fail re-enqueues are not counted. Only recorded when [`reactions.auto_merge`](/reference/reactions/#reactionsauto_merge) is configured. | Coordination |
| `sortie_review_checks_total` | `result` | Review-comment check outcomes, one per reconciliation pass that acts. `result` is `dispatched` (actionable reviewer comments found, continuation turn dispatched) or `error` (the SCM review fetch failed and is retried with backoff). Passes with no actionable comments, a duplicate fingerprint, or an active debounce window do not increment this counter. Only recorded when [`reactions.review_comments`](/reference/reactions/#reactionsreview_comments) is configured. | Coordination |
| `sortie_review_escalations_total` | `action` | Review escalation actions, taken when review-fix continuation turns are exhausted and when a `triage` command answers `escalate`. `action` is `label`, `comment`, or `error`. Only recorded when `reactions.review_comments` is configured. | Coordination |
| `sortie_bot_review_checks_total` | `result` | Bot-review check outcomes. `result` is `dispatched` (actionable bot comments found, continuation turn dispatched) or `error` (the SCM comment fetch failed and is retried). Only recorded when [`reactions.bot_review`](/reference/reactions/#reactionsbot_review) is configured. | Coordination |
| `sortie_bot_review_escalations_total` | `action` | Bot-review escalation actions, taken when bot-review continuation turns are exhausted and when a `triage` command answers `escalate`. `action` is `label`, `comment`, or `error`. Only recorded when `reactions.bot_review` is configured. | Coordination |
| `sortie_merge_conflict_checks_total` | `result` | Merge-conflict reaction check outcomes. `result` is `dispatched` (a rebase continuation turn was dispatched), `clear` (the PR returned to a non-conflicted state), `unknown` (mergeability not yet computed; the entry defers), or `error` (the mergeability fetch failed). Only recorded when [`reactions.merge_conflicts`](/reference/reactions/#reactionsmerge_conflicts) is configured. | Coordination |
| `sortie_merge_conflict_escalations_total` | `action` | Merge-conflict escalation actions, taken when the episode's retry budget is exhausted and when a `triage` command answers `escalate`. `action` is `label`, `comment`, or `error`. Only recorded when `reactions.merge_conflicts` is configured. | Coordination |
| `sortie_dispatch_rule_match_total` | `layer`, `rule` | Dispatch routing resolutions, one per dispatched issue. `layer` is `rule` (a named dispatch rule matched), `default` (the dispatch `default` block supplied the selection), or `fallback` (neither matched; the workflow-wide agent and body template were used). `rule` is the matched rule name, `default` when the default block fired, or `<none>` for the fallback layer. | Coordination |
| `sortie_candidate_holds_total` | `reason` | Candidates the dispatch loop held instead of starting. `reason` is `blocked_by` (a blocker has not reached a terminal state), `blockers_unresolved` (the blocker read for this candidate failed, or this poll had already given up on further reads after an earlier failure), `blockers_not_read` (this poll's per-candidate blocker-read budget was already spent), or `blockers_incomplete` (the blocker list was not authoritative and nothing was available to complete it). Incremented once per held candidate; never incremented for a candidate rejected by a basic eligibility or capacity check. See [candidate eligibility](/reference/state-machine/#candidate-eligibility). | Coordination |
| `sortie_self_review_iterations_total` | `verdict` | Self-review iterations by outcome. `verdict` is `pass` (verification succeeded), `iterate` (agent re-prompted for another attempt), or `none` (no verdict produced). Only recorded when [`self_review.enabled: true`](/reference/workflow-config/) is set. When self-review is disabled, this counter remains at zero. | Coordination |
| `sortie_self_review_sessions_total` | `final_verdict` | Self-review sessions by final outcome. `final_verdict` is `pass`, `iterate`, or `none`. One increment per completed self-review session. Only recorded when self-review is enabled. | Coordination |
| `sortie_self_review_cap_reached_total` | - | Self-review sessions that hit the iteration cap without passing. A sustained non-zero rate means verification commands are consistently failing - check your `self_review.verify_commands` configuration. Only recorded when self-review is enabled. | Coordination |

## Histograms

Distribution summaries with pre-defined buckets. Query percentiles with `histogram_quantile()`. Each histogram produces `_bucket`, `_sum`, and `_count` time series automatically.

| Name | Labels | Description | Buckets | Producing layer |
|---|---|---|---|---|
| `sortie_poll_duration_seconds` | - | Wall-clock time per complete poll cycle (tracker fetch through dispatch). | Exponential from 0.1s, factor 2, 10 buckets (0.1s → 51.2s) | Coordination |
| `sortie_worker_duration_seconds` | `exit_type` | Wall-clock time per worker session, from spawn to exit. `exit_type` takes the same values as `sortie_worker_exits_total`: `normal`, `error`, `cancelled`, or `soft_stop`. | Exponential from 10s, factor 2, 12 buckets (10s → ~5.7h) | Coordination |
| `sortie_self_review_verification_duration_seconds` | `command` | Wall-clock time per verification command execution during self-review. `command` is the first 64 characters of the shell command. Only recorded when self-review is enabled. | Exponential from 10s, factor 2, 12 buckets (10s → ~5.7h) | Coordination |

The poll duration histogram is tuned for O(seconds) cycles - tracker API latency plus dispatch overhead. The worker duration histogram covers the full range from quick failures (tens of seconds) to long-running agent sessions (hours).

Bucket boundaries for `sortie_poll_duration_seconds`: 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2 seconds.

Bucket boundaries for `sortie_worker_duration_seconds`: 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480 seconds (~10s to ~5.7h).

The verification duration histogram shares the worker duration bucket boundaries. Verification commands range from fast linters (seconds) to full test suites (minutes).

Bucket boundaries for `sortie_self_review_verification_duration_seconds`: 10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480 seconds (~10s to ~5.7h).

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

Sortie's concurrency is O(10) agents, not O(10,000) microservice endpoints - but issue identifiers are unbounded over time. Adding them as labels would create an ever-growing number of time series that degrades Prometheus storage and query performance for no operational benefit.

Prometheus answers aggregate questions: "How many sessions are running?", "What is the token burn rate?", "Are dispatches failing?" The [JSON API](/reference/http-api/) answers per-issue questions: "What is PROJ-42 doing right now?", "How many tokens has this session consumed?" Use both.

None of the labels above name the Sortie instance itself, because Sortie's metrics registry has no concept of one. Prometheus supplies that separation on the scrape side instead: every series gets an `instance` label (the scraped `host:port`) and a `job` label (the `job_name` from `scrape_configs`), regardless of what the exporter emits. Point one Prometheus at several Sortie processes and those two labels are what let you view each instance separately or sum across all of them — see [how to aggregate metrics across instances](/guides/aggregate-metrics-across-instances/).

## PromQL examples

These queries assume the default 15-second scrape interval. Adjust `rate()` windows if your interval differs - the window should span at least 4 scrape intervals.

### Token burn rate

```promql
sum(rate(sortie_tokens_total[5m])) by (type) * 60
```

Tokens per minute, broken down by `input`, `output`, and `cache_read`. Multiply by your provider's per-token pricing to get cost per minute, keeping in mind that `cache_read` is part of `input` rather than an addition to it.

### Dispatch throughput and error rate

```promql
sum(rate(sortie_dispatches_total[5m])) by (outcome)
```

Dispatches per second by outcome. A sustained non-zero `outcome="error"` rate means workspace preparation or agent spawn is failing - check structured logs for the root cause.

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

Percentage of dispatch capacity remaining. Alert when this stays below 10% - you are running near your concurrency ceiling.

### Worker duration percentiles

```promql
histogram_quantile(0.50, rate(sortie_worker_duration_seconds_bucket[30m]))
histogram_quantile(0.95, rate(sortie_worker_duration_seconds_bucket[30m]))
histogram_quantile(0.99, rate(sortie_worker_duration_seconds_bucket[30m]))
```

p50, p95, and p99 worker session duration over the last 30 minutes. Use a wider window (30m+) because worker sessions are long-lived - a 5-minute window may not contain enough completed sessions for meaningful percentiles.

### Retry rate by trigger

```promql
sum(rate(sortie_retries_total[5m])) by (trigger)
```

Retries per second by trigger type. A spike in `trigger="error"` retries signals systemic agent failures. A spike in `trigger="stall"` retries means agents are hanging - check `agent.stall_timeout_ms` in your workflow config.

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

### Self-review pass rate

```promql
rate(sortie_self_review_sessions_total{final_verdict="pass"}[30m])
/ on() sum(rate(sortie_self_review_sessions_total[30m]))
* 100
```

Percentage of self-review sessions that ended with a passing verdict over the last 30 minutes. A declining pass rate means agents are producing code that fails verification commands more often - review your prompt templates and verify commands. Use a wider window (30m+) because self-review sessions complete infrequently.

For cap-hit monitoring:

```promql
rate(sortie_self_review_cap_reached_total[1h])
```

Sessions per second that exhausted all iterations without passing. Any sustained non-zero value warrants investigation. See [Configure self-review](/guides/configure-self-review/) for tuning iteration caps and verify commands.

### Auto-merge outcomes

```promql
sum(rate(sortie_reactions_auto_merge_total[30m])) by (result)
```

Auto-merge reactions per second by result over the last 30 minutes. A rising `escalated` series means PRs exhaust the merge retry budget and fall back to a human often enough to matter, usually because CI is failing, the branch has conflicts, or branch protection blocks the merge. A non-zero `error` rate points at SCM API or permission problems. Use a wide window because merges are infrequent.

### Dispatch rule fallback rate

```promql
sum(rate(sortie_dispatch_rule_match_total{layer="fallback"}[1h]))
/ on() sum(rate(sortie_dispatch_rule_match_total[1h]))
* 100
```

Percentage of dispatches that matched neither a named rule nor the `default` block. A high value means most issues bypass your dispatch rules and run on the workflow-wide agent and body template. To see which named rules are firing, keep both labels:

```promql
sum(rate(sortie_dispatch_rule_match_total[1h])) by (layer, rule)
```

### Candidate holds by reason

```promql
sum(rate(sortie_candidate_holds_total[1h])) by (reason)
```

Candidates held per second, broken down by reason. A sustained `blocked_by` rate reflects real open dependencies in the tracker. A sustained `blockers_unresolved` or `blockers_not_read` rate on GitHub or Gitea points at a read problem instead - a token missing the dependency scope, a rate limit, or a candidate volume that regularly exceeds the four-request-per-poll budget - and is worth checking against `sortie_tracker_requests_total{operation="fetch_blockers"}`.

## Grafana dashboard

A reference Grafana dashboard JSON is available for import at [`grafana-dashboard.json`](/downloads/grafana-dashboard.json). It is tested against Grafana 10+ and uses the `sortie_` metrics documented on this page.

The dashboard organizes panels into nine collapsible rows. Each panel maps to one or more metrics from the tables above.

| Row | Panel | Metric(s) | Visualization |
|---|---|---|---|
| Overview | Build info | `sortie_build_info` | Stat (`version`, `go_version`) |
| Overview | Active sessions | `sortie_sessions_running`, `sortie_sessions_retrying`, `sortie_slots_available` | Stat + time series |
| Overview | Active sessions elapsed | `sortie_active_sessions_elapsed_seconds` | Stat |
| Overview | Budget Blocked | `sortie_budget_exhausted_issues` | Stat by `reason` |
| Throughput | Token consumption | `sortie_tokens_total` | Time series (rate) by `type` |
| Throughput | Dispatch outcomes | `sortie_dispatches_total` | Time series (rate), `success` vs `error` |
| Throughput | Agent runtime | `sortie_agent_runtime_seconds_total` | Time series (rate) |
| Workers | Worker exits | `sortie_worker_exits_total` | Time series (rate) by `exit_type` |
| Workers | Worker duration | `sortie_worker_duration_seconds` | Heatmap + p50/p95/p99 percentile lines |
| Reliability | Retry activity | `sortie_retries_total` | Time series (rate) by `trigger` |
| Reliability | Poll cycle health | `sortie_poll_cycles_total`, `sortie_poll_duration_seconds` | Count + duration overlay |
| Reliability | Reconciliation actions | `sortie_reconciliation_actions_total` | Time series (rate) by `action` |
| Reliability | Budget Exhaustions | `sortie_budget_exhaustions_total` | Stat (1h increase) by `reason` |
| Integration | Tracker API | `sortie_tracker_requests_total` | Time series (rate) by `operation` × `result` |
| Integration | Handoff transitions | `sortie_handoff_transitions_total` | Stat counters by `result` |
| Integration | Dispatch transitions | `sortie_dispatch_transitions_total` | Stat counters by `result` |
| Integration | Tracker comments | `sortie_tracker_comments_total` | Time series (rate) by `lifecycle` × `result` |
| CI Feedback | CI status checks | `sortie_ci_status_checks_total` | Time series (rate) by `result` |
| CI Feedback | CI escalations | `sortie_ci_escalations_total` | Time series (rate) by `action` |
| Agent | Tool calls | `sortie_tool_calls_total` | Time series (rate) by `tool` |
| Agent | SSH host utilization | `sortie_ssh_host_usage` | Bar gauge per `host` (hidden when no SSH hosts configured) |
| Self-Review | Self-Review Sessions | `sortie_self_review_sessions_total` | Time series (rate) by `final_verdict` |
| Self-Review | Self-Review Iterations | `sortie_self_review_iterations_total` | Time series (rate) by `verdict` |
| Self-Review | Self-Review Verification Duration | `sortie_self_review_verification_duration_seconds` | Time series, p95 by `command` |
| Self-Review | Self-Review Cap Reached | `sortie_self_review_cap_reached_total` | Time series (rate) |
| Reactions & Routing | Auto-merge reactions | `sortie_reactions_auto_merge_total` | Time series (rate) by `result` |
| Reactions & Routing | Review checks | `sortie_review_checks_total` | Time series (rate) by `result` |
| Reactions & Routing | Review escalations | `sortie_review_escalations_total` | Time series (rate) by `action` |
| Reactions & Routing | Dispatch rule matches | `sortie_dispatch_rule_match_total` | Time series (rate) by `layer` |
| Reactions & Routing | Candidate holds | `sortie_candidate_holds_total` | Time series (rate) by `reason` |

Import the JSON file in Grafana via **Dashboards → Import → Upload JSON file**. Set your Prometheus data source when prompted.

## Scrape configuration

Add Sortie as a scrape target in `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: sortie
    static_configs:
      - targets: ["localhost:7678"]
```

Replace `localhost:7678` with the host and port where Sortie's HTTP server is running. Sortie binds to `127.0.0.1` by default - if Prometheus runs on a different machine, pass `--host 0.0.0.0` to Sortie or configure a reverse proxy to make the port reachable.

To scrape more than one Sortie instance, add more entries to `targets`. See [how to aggregate metrics across instances](/guides/aggregate-metrics-across-instances/) for the full multi-instance pattern and its limits.

The endpoint also serves `promhttp_metric_handler_requests_total` and `promhttp_metric_handler_errors_total` for scrape self-instrumentation, plus Go runtime metrics (`go_goroutines`, `go_memstats_*`, `process_*`) from the standard process and Go collectors.

For a complete setup walkthrough covering installation, alerting rules, and remote host discovery, see [Monitor with Prometheus](/guides/monitor-with-prometheus/).
