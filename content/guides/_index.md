---
title: Guides
linkTitle: Guides
weight: 2
---

Step-by-step instructions for configuring, operating, and extending Sortie.

## Setup & configuration

{{< cards >}}
  {{< card link="connect-to-jira" title="Connect to Jira" subtitle="API authentication, state mapping, and JQL filters." >}}
  {{< card link="connect-to-github" title="Connect to GitHub" subtitle="Token setup, label filters, and state mapping." >}}
  {{< card link="use-file-adapter-for-testing" title="File Adapter for Testing" subtitle="Test workflows without a real tracker." >}}
  {{< card link="write-prompt-template" title="Write a Prompt Template" subtitle="Go text/template with issue fields and helpers." >}}
  {{< card link="setup-workspace-hooks" title="Workspace Hooks" subtitle="Run scripts before and after agent sessions." >}}
  {{< card link="configure-retry-behavior" title="Configure Retry" subtitle="Session budgets, backoff, and skip rules." >}}
  {{< card link="integrate-security-scanning" title="Security Scanning" subtitle="Run gitleaks, semgrep, and govulncheck." >}}
  {{< card link="run-multiple-workflows" title="Multiple Workflows" subtitle="Separate processes for different projects." >}}
  {{< card link="orchestrate-across-repositories" title="Multi-Repo Orchestration" subtitle="One Sortie instance per repository." >}}
{{< /cards >}}

## Operations

{{< cards >}}
  {{< card link="resume-sessions-across-restarts" title="Resume Sessions" subtitle="What survives restarts and how recovery works." >}}
  {{< card link="control-costs" title="Control Costs" subtitle="Per-session budgets, turn caps, and concurrency." >}}
  {{< card link="run-as-systemd-service" title="Systemd Service" subtitle="Run as a persistent service on Linux." >}}
  {{< card link="run-as-launchctl-service" title="Launchctl Service" subtitle="Run as a persistent service on macOS." >}}
  {{< card link="scale-agents-with-ssh" title="Scale with SSH" subtitle="Distribute sessions across remote machines." >}}
  {{< card link="configure-ci-feedback" title="CI Feedback" subtitle="Detect CI failures and retry automatically." >}}
{{< /cards >}}

## Observability

{{< cards >}}
  {{< card link="monitor-with-logs" title="Structured Logs" subtitle="Read, filter, and aggregate text or JSON logs." >}}
  {{< card link="monitor-with-prometheus" title="Prometheus & Grafana" subtitle="Scrape metrics and import the dashboard." >}}
{{< /cards >}}

## Deployment

{{< cards >}}
  {{< card link="use-sortie-in-docker" title="Docker" subtitle="Build and run the distroless container image." >}}
  {{< card link="deploy-sortie-to-kubernetes" title="Kubernetes" subtitle="Deploy with Deployment, PVC, ConfigMap, and Service." >}}
{{< /cards >}}

## Advanced

{{< cards >}}
  {{< card link="use-agent-tools-in-prompts" title="Agent Tools in Prompts" subtitle="Use sortie_status and other tools in templates." >}}
  {{< card link="use-subagents-with-sortie" title="Sub-Agents" subtitle="Run coding agent sub-agents with zero config." >}}
  {{< card link="write-custom-agent-tool" title="Custom Agent Tool" subtitle="Implement the AgentTool interface step by step." >}}
{{< /cards >}}

## Troubleshooting

{{< cards >}}
  {{< card link="troubleshoot-common-failures" title="Common Failures" subtitle="Agent won't start, tracker errors, and more." >}}
{{< /cards >}}
