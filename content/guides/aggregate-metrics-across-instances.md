---
title: "How to Aggregate Metrics Across Multiple Sortie Instances"
linkTitle: "Aggregate Across Instances"
description: "See dispatch, token, and cost figures across every Sortie process you run using Prometheus federation or the sortie stats export pipe -- no new Sortie feature required."
author: Sortie AI
date: 2026-08-08
weight: 175
url: /guides/aggregate-metrics-across-instances/
---
If you run one Sortie process per repository or per team, you do not need a new feature to see totals across them. Two mechanisms already produce that view today, and both work by reading from each instance rather than asking the orchestrator to send anything anywhere.

## Prerequisites

- Two or more Sortie instances already running ([run multiple workflows](/guides/run-multiple-workflows/), [orchestrate across repositories](/guides/orchestrate-across-repositories/))
- Prometheus and Grafana set up for at least one instance ([monitor with Prometheus](/guides/monitor-with-prometheus/)), if you want the live-dashboard path
- Shell access to each instance's host, if you want the export-pipe path

## Pull metrics through Prometheus

Every Sortie instance serves `GET /metrics` on its own port, and Prometheus attaches an `instance` label (the scraped `host:port`) and a `job` label (the `job_name` from your config) to every series it scrapes. Point one Prometheus at several instances and it already holds every `sortie_*` metric broken out per instance and ready to sum across them. Nothing in Sortie changes to make this work — it is a property of how Prometheus scrapes, not a Sortie feature you turn on.

Add every instance as a target under the same job:

```yaml
scrape_configs:
  - job_name: "sortie"
    static_configs:
      - targets:
          - "frontend.internal:7678"
          - "backend-api.internal:7678"
          - "data-service.internal:7678"
    scrape_interval: 15s
```

See [monitor with Prometheus](/guides/monitor-with-prometheus/) for the single-target basics — binding, firewall rules, and confirming the scrape is live — if you have not set that up yet.

Once Prometheus is scraping all of them, `instance` is just another label in PromQL. Keep it to compare instances side by side:

```promql
sum by (instance) (rate(sortie_tokens_total[1h]))
```

Drop it to see the fleet as one number:

```promql
sum(rate(sortie_tokens_total[1h]))
```

The same pattern works for any counter in the [Prometheus metrics reference](/reference/prometheus-metrics/) — dispatch outcomes, retries, tool calls, auto-merge results.

**The shipped dashboard was not built for this.** [`grafana-dashboard.json`](/downloads/grafana-dashboard.json) carries no instance selector. Point it at a data source scraping several instances and a panel built on a bare metric name (like the active-sessions stat panels) renders one series per instance with no way to isolate one; a panel built on an aggregating query (like the dispatch-outcome time series, which already sums by `outcome`) silently folds every instance into a single line. Neither is wrong, and neither is a view designed for the multi-instance case. Add an instance template variable and an explicit `by (instance)` to the panels you want to compare, or keep the stock dashboard per instance and build a small fleet-overview row separately.

## Export stats to your own store

`sortie stats --format json` opens the database read-only and emits one self-describing document summarizing runs over a range — counts, success rate, duration percentiles, and, on a full-schema database, token sums, cost, and self-review results. It runs against one instance's database at a time, so you choose the destination, the schedule, and the credential:

```sh
sortie stats --format json --since 2026-07-01 --until 2026-08-01 WORKFLOW.md \
  | curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- \
      https://metrics.internal.example/sortie
```

`--since` and `--until` each accept an RFC3339 timestamp, a plain date (`2026-07-01`), or a duration measured back from now (`24h`); omit both to cover every run on record. Loop the same command over every instance's workflow file to collect from a fleet:

```sh
for wf in ~/sortie/frontend/WORKFLOW.md ~/sortie/backend-api/WORKFLOW.md ~/sortie/data-service/WORKFLOW.md; do
  sortie stats --format json --since 24h "$wf" \
    | curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- \
        https://metrics.internal.example/sortie
done
```

Run it from cron, a systemd timer, or whatever already schedules jobs in your environment — there is no Sortie feature involved past emitting the document. Scheduling, retries, and authenticating to your endpoint (add a header or query parameter to the `curl` call) are entirely your responsibility, the same as any script you write yourself.

A few fields in the envelope matter to whatever receives it:

| Field | Why it matters |
|---|---|
| `schema_tier` | `"full"` or `"base"`. On `"base"`, token and cost figures are `null` because the database is missing at least one of the column groups the full report needs — not because the runs cost nothing. Check this before reading a null as a zero. |
| `summary.tokens_unmeasured_runs` | How many runs in range reported no token usage at all, so the token and cost figures exclude them rather than counting them as zero. A `"full"` report can still carry a null `tokens` when every run in range is unmeasured, which is why the tier alone does not tell a missing figure from an unmeasured one. Each breakdown row carries its own count under the same name. |
| `warnings` | Non-empty when the report is degraded, for example by a partially migrated database or a malformed `token_rates` block. Tells a clean aggregate from a degraded one. A coding agent with no rate entry does not land here; those runs are counted in `summary.cost_unpriced_runs`. |
| `workflow_path` | The workflow file this instance loaded when it produced the report. A local filesystem path, useful for identifying the source inside your own network. |
| `db_path` | The SQLite database the figures came from. The same local-path caveat as `workflow_path` applies once a document leaves the host it was generated on. |

Those five are what a receiver acts on. For the rest of the envelope, field by field, plus the flags, the range-bound grammar, and what puts a report on the `base` tier, see the [`sortie stats` CLI reference](/reference/cli/#stats).

This is the only figures document Sortie produces. Whatever emits it — this pipe today, or a built-in export feature later — carries exactly these figures and nothing divergent: the same population, the same rounding, the same meaning for a null. That is a recorded project constraint, not just today's implementation detail, so anything you build against this envelope keeps working if Sortie ever ships an exporter of its own.

The envelope names no instance beyond `workflow_path` and `db_path`. If you are collecting from several instances into one place, key your receiver off one of those two paths, or give each instance its own destination, before you lose track of which figures came from which process.

## Which one to use

Prometheus gives you a live view suited to dashboards and alerting — "is dispatch failing right now," "is token burn spiking." The `sortie stats` pipe gives you an authoritative, point-in-time accounting document for a range — suited to nightly rollups, cost reports, or feeding a system that is not Prometheus. Nothing stops you from using both: Prometheus for operational health, the stats pipe for the accounting record.

## What this does not give you

Neither mechanism turns your fleet into a managed system. Each instance still serves one workflow, one database, and one tracker project, with no knowledge that any other instance exists — see [the multi-tenant non-goal](/concepts/architecture/#what-sortie-does-not-do) for why that boundary is deliberate. The orchestrator pushes nothing to either mechanism; a scraper and a shell pipeline both read from the outside, which is why adding instances never requires touching Sortie itself.

## See also

- [Monitor with Prometheus](/guides/monitor-with-prometheus/) for single-instance scrape setup, alerting queries, and the shipped dashboard
- [Prometheus metrics reference](/reference/prometheus-metrics/) for every metric, label, and PromQL example
- [`sortie stats` CLI reference](/reference/cli/#stats) for every flag, field, and exit code of the command behind the export pipe
- [Control agent costs](/guides/control-costs/#monitor-spending) for the other places cost and token figures surface
- [Architecture](/concepts/architecture/#what-sortie-does-not-do) for why cross-instance aggregation does not conflict with the single-tenant design
- [Security model](/concepts/security/#outbound-data-posture) for what Sortie does and does not send off the host on its own initiative
