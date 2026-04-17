---
title: Reference
linkTitle: Reference
description: "Reference for every Sortie CLI flag, WORKFLOW.md field, environment variable, HTTP endpoint, Prometheus metric, and agent or tracker adapter."
weight: 4
---

Comprehensive reference for every CLI flag, configuration field, API endpoint, and adapter.

## Core

{{< cards >}}
  {{< card link="cli" title="CLI" subtitle="Subcommands, flags, exit codes, and signals." >}}
  {{< card link="workflow-config" title="Workflow File" subtitle="Every WORKFLOW.md configuration field." >}}
  {{< card link="environment" title="Environment Variables" subtitle="Every variable Sortie reads, injects, or filters." >}}
  {{< card link="http-api" title="HTTP API" subtitle="JSON endpoints, request/response schemas." >}}
  {{< card link="dashboard" title="Dashboard" subtitle="Embedded HTML dashboard for session monitoring." >}}
  {{< card link="prometheus-metrics" title="Prometheus Metrics" subtitle="Gauges, counters, and histograms." >}}
  {{< card link="state-machine" title="State Machine" subtitle="Orchestration states, phases, and transitions." >}}
  {{< card link="errors" title="Errors" subtitle="All error kinds and their resolution." >}}
  {{< card link="agent-extensions" title="Agent Extensions" subtitle=".sortie/status file protocol and tool contracts." >}}
{{< /cards >}}

## Agent adapters

{{< cards >}}
  {{< card link="adapter-claude-code" title="Claude Code" subtitle="Configuration, JSONL events, token accounting, SSH." >}}
  {{< card link="adapter-copilot" title="Copilot CLI" subtitle="Configuration, session lifecycle, and output parsing." >}}
  {{< card link="adapter-codex" title="Codex" subtitle="Configuration, JSON-RPC protocol, persistent subprocess, SSH." >}}
{{< /cards >}}

## Tracker adapters

{{< cards >}}
  {{< card link="adapter-jira" title="Jira Cloud" subtitle="Authentication, field mapping, JQL, and transitions." >}}
  {{< card link="adapter-github" title="GitHub Issues" subtitle="Token auth, label filters, state mapping, and webhooks." >}}
{{< /cards >}}
