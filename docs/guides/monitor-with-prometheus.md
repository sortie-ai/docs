---
title: "How to Monitor with Prometheus | Sortie"
description: "Configure Prometheus to scrape Sortie metrics, import the Grafana dashboard, and set up alerting queries for operational monitoring."
keywords: sortie prometheus, grafana dashboard, monitoring, PromQL, alerting, scrape config, observability
author: Sortie AI
---

# How to monitor with Prometheus

Wire Sortie into your Prometheus and Grafana stack so you can track agent sessions, token burn, dispatch health, and retry queues from a single dashboard.

## Prerequisites

- Sortie installed and running ([installation guide](../getting-started/installation.md))
- Prometheus installed and scraping targets
- Grafana installed (optional — needed for the dashboard step)

## Verify the HTTP server is running

Sortie starts the HTTP server by default on `127.0.0.1:7678`. The `/metrics` endpoint shares the same port as the JSON API and HTML dashboard. Confirm it is live:

```bash
curl -s http://localhost:7678/metrics | head -20
```

You should see Prometheus text exposition format:

```
# HELP sortie_sessions_running Number of currently running agent sessions.
# TYPE sortie_sessions_running gauge
sortie_sessions_running 2
# HELP sortie_dispatches_total Dispatch attempts and their outcomes.
# TYPE sortie_dispatches_total counter
sortie_dispatches_total{outcome="success"} 47
sortie_dispatches_total{outcome="error"} 1
# HELP sortie_tokens_total Cumulative LLM tokens consumed.
# TYPE sortie_tokens_total counter
sortie_tokens_total{type="input"} 284500
```

If you get `connection refused`, Sortie isn't running or the server was disabled with `--port 0`. Check the startup logs — Sortie prints the listen address at boot. To use a different port, pass `--port <N>` or set `server.port` in your WORKFLOW.md front matter.

## Add Sortie as a Prometheus scrape target

Open your `prometheus.yml` and add Sortie under `scrape_configs`:

```yaml
scrape_configs:
  - job_name: "sortie"
    static_configs:
      - targets: ["localhost:7678"]
    scrape_interval: 15s
```

If Sortie runs on a different machine from Prometheus, replace the target:

```yaml
      - targets: ["build01.internal:7678"]
```

Sortie binds to `127.0.0.1` by default. When Prometheus runs on a separate host, pass `--host 0.0.0.0` to Sortie to listen on all interfaces, or configure a reverse proxy or SSH tunnel to make the port reachable.

Reload Prometheus to pick up the new config:

```bash
curl -X POST http://localhost:9090/-/reload
```

Open the Prometheus UI at `http://localhost:9090/targets` (or Status > Targets). The `sortie` job should appear with state **UP**. If it shows **DOWN**, Prometheus can't reach the Sortie host — check network connectivity and firewall rules.

## Verify metrics are flowing

Paste these queries into the Prometheus expression browser to confirm data is arriving.

**`sortie_sessions_running`** — returns the number of active agent sessions right now. If Sortie is idle, this is 0. If agents are working, you'll see a positive integer.

**`rate(sortie_dispatches_total[5m])`** — dispatch rate per second over the last 5 minutes. Two series appear: `outcome="success"` and `outcome="error"`. Both at zero is normal when Sortie has no work queued.

**`sortie_build_info`** — returns a single series with value 1 and labels `version` and `go_version`. This confirms Sortie's version metadata is reaching Prometheus:

```
sortie_build_info{version="0.5.0", go_version="go1.24.1"} 1
```

If all three queries return data, your scrape pipeline is working.

## Import the Grafana dashboard

Sortie ships a reference Grafana dashboard that visualizes the full metric set.

1. Open Grafana and navigate to **Dashboards > Import**.
2. Upload [`grafana-dashboard.json`](/downloads/grafana-dashboard.json) or paste its contents.
3. Select your Prometheus data source when prompted.
4. Click **Import**.

The dashboard includes these panels, grouped into collapsible rows:

| Panel | What it shows |
|---|---|
| Active sessions | Running, retrying, and available slots as stat panels, elapsed time, and a time series |
| Token consumption | Input and output token rates over time |
| Dispatch outcomes | Success vs. error dispatch rate |
| Agent runtime | Cumulative agent runtime rate |
| Worker exits | Worker completion rate by exit type |
| Worker duration | Heatmap of session durations with p50, p95, p99 overlay lines |
| Retry activity | Retry rate broken down by trigger (error, continuation, stall) |
| Poll cycle health | Poll success/error/skip counts with duration overlay |
| Reconciliation actions | Reconciliation outcome rate by action |
| Tracker API | Tracker adapter call rate by operation and result |
| Handoff transitions | Handoff transition outcome counters |
| Dispatch transitions | Dispatch-time transition outcome counters |
| Tracker comments | Tracker comment rate by lifecycle and result |
| CI status checks | CI check outcome rate |
| CI escalations | CI escalation action rate |
| Tool calls | Agent tool call rate by tool |
| SSH host utilization | Per-host session gauge (hidden when no SSH hosts are configured) |
| Build info | Version and Go version |

The dashboard is tested against Grafana 10+. Panels auto-adapt to your scrape interval.

## Alerting queries

These PromQL expressions catch the operational problems you care about most. Each one is ready to drop into an Alertmanager rule or Grafana alert — you know how to wire that part up, so here are the expressions.

**No successful dispatches in 30 minutes.** Sortie may be stalled, misconfigured, or the tracker has no work:

```promql
rate(sortie_dispatches_total{outcome="success"}[30m]) == 0
```

**High dispatch error rate.** More than 10% of dispatches are failing — workspace preparation or agent spawn is broken:

```promql
  rate(sortie_dispatches_total{outcome="error"}[5m])
/ rate(sortie_dispatches_total[5m])
> 0.1
```

**Token burn rate exceeding budget.** Adjust the threshold to match your cost appetite — this example fires above 100k tokens per hour:

```promql
sum(rate(sortie_tokens_total[1h])) > 100000
```

**All slots full for over 15 minutes.** Agents may be stalled or your concurrency limit is too low for the workload:

```promql
sortie_slots_available == 0
```

Set this with a `for: 15m` duration in your alert rule. Brief saturation is normal during batch dispatches — sustained saturation is a problem.

## What we configured

Sortie metrics are now flowing into Prometheus, you have a Grafana dashboard for at-a-glance monitoring, and you have alerting queries for the failure modes that matter. For the complete list of every metric, label, and bucket boundary, see the [Prometheus metrics reference](../reference/prometheus-metrics.md). For per-issue debugging through the JSON API, see the [HTTP API reference](../reference/http-api.md). For the built-in HTML dashboard, see the [dashboard reference](../reference/dashboard.md).
