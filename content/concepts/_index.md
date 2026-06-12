---
title: Concepts
linkTitle: Concepts
description: "Design decisions and mental models behind Sortie: architecture, adapter model, persistence, orchestration, agent communication, agent tools, security, and isolation."
weight: 3
---

Understand the design decisions and mental models behind Sortie.

{{< cards >}}
  {{< card link="architecture" title="Architecture" subtitle="Single binary, poll-dispatch-reconcile loop, and adapter model." >}}
  {{< card link="adapter-model" title="Adapter Model" subtitle="How agent and tracker integrations stay disposable and testable." >}}
  {{< card link="persistence" title="Persistence" subtitle="What SQLite stores, what survives restarts, and why it matters." >}}
  {{< card link="orchestration" title="Orchestration" subtitle="The poll-dispatch-reconcile loop that manages all sessions." >}}
  {{< card link="agent-communication" title="Agent Communication" subtitle="Two channels: MCP tools for data, the status file for control." >}}
  {{< card link="agent-tools" title="Agent Tools" subtitle="Two tool tiers: local state versus external dependencies." >}}
  {{< card link="security" title="Security Model" subtitle="Workspace isolation, prompt injection surface, and trust boundaries." >}}
  {{< card link="isolation" title="Workspace Isolation" subtitle="Per-issue directories, path containment, and symlink checks." >}}
{{< /cards >}}
