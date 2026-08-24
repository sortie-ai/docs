---
title: "Agent Tools"
description: "Why Sortie segments agent tools into two tiers: local read-only state versus external dependencies, what each tier guarantees, and how the built-in tools map onto the model."
author: Sortie AI
date: 2026-06-11
weight: 55
---
Mid-session, a Sortie agent can call tools: check its turn budget, read prior run history, query the issue tracker, notify a human. These calls are not equal. Some read a local file or the orchestrator's own SQLite database and can never surprise you. Others carry credentials across the network to external services that rate-limit, time out, and fail in ways nobody on your side controls. Treating both kinds identically would be wrong on three axes at once: security posture (what can this call reach?), determinism (does the same call give the same answer?), and failure handling (what does the agent see when it breaks?).

Sortie's answer is a two-tier model. Every tool is classified by its dependency profile, and the tier determines what the tool may touch, how it can fail, and when the agent is offered it at all. This page explains the model, maps the built-in tools onto it, and gives contributors the rule for placing a new one.

## The tier model

The tier describes what a tool *needs*, not what it is *for*. A turn-budget check and a tracker query both serve the agent's planning; what separates them is that one is answered entirely from local state the orchestrator already wrote, while the other depends on a remote system, a credential, and a network path. Dependency is the right axis because everything operationally interesting follows from it: blast radius, failure modes, test strategy, registration rules. Two tiers cover the spectrum, and every future tool falls into one of them.

## Tier 1: pure orchestrator state

A Tier 1 tool reads local session state, the workspace state file or the local SQLite database, and makes zero external calls. That single constraint buys three guarantees. The tool is deterministic: its answer depends only on state the orchestrator wrote. It is fast: no network round-trip sits between question and answer. And its failure surface is one case deep: beyond internal bugs, the only runtime failure mode is a tool-error response when the local state it reads is missing or unreadable, an absent state file or a failed database query. Nothing hangs, nothing rate-limits, nothing needs a credential.

Three built-in tools live here. `sortie_status` reads the worker-maintained `.sortie/state.json` and reports the session's turn and token state; Sortie registers it when `SORTIE_WORKSPACE` is set. `workspace_history` reads the `run_history` table over a read-only database connection and reports the issue's prior attempts; Sortie registers it when `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the database opens read-only. `cost_budget` reads the same database over the same shared read-only connection and reports cumulative token spend against the configured budget; it registers under the same gate, and when `SORTIE_SESSION_ID` is also set it folds the running session's spend into the reading. When the database open fails, the MCP server logs a warning and continues without the two SQLite-backed tools; the session proceeds with whatever else is registered.

Note what the definition does not say. The SQLite database is not an external dependency: it is the orchestrator's own local state, and the sidecar opens it read-only at the driver level. Locality is the boundary, not storage technology.

## Tier 2: external dependencies

A Tier 2 tool reaches an external service over the network using credentials the orchestrator manages. The moment a call leaves the host, the failure universe expands: transport failures, authentication errors, rate limits. Sortie answers with per-tool timeouts, so a slow endpoint cannot stall a turn indefinitely. The structured error envelope with machine-readable error kinds is not a Tier 2 feature; every tool returns it. What grows with Tier 2 is the failure universe the envelope must describe: its kind sets cover transport, auth, rate-limit, and input failures, where Tier 1's single failure family (local state missing or unreadable) needs only a small closed set.

Two built-in tools live here. `tracker_api` reads and writes the configured issue tracker with the orchestrator's credentials, scoped to the configured project; Sortie registers it only when a valid tracker configuration with credentials and a project is present. `notify_operator` posts real-time notifications to operator-configured channels; Sortie registers it only when the `notifications` list configures at least one backend. The exact schemas and error kinds live in the [agent extensions reference](/reference/agent-extensions/).

## The design philosophy

Six decisions shape the tool subsystem, and the tiers make each one legible.

**Least privilege, read-only by default.** Tier 1 is read-only by construction: the database connection is opened read-only at the driver level, and the state file is only ever read. The tools that can change the world, a tracker transition or a notification to a human, are exactly the ones gated behind explicit operator configuration. An agent in a minimal session can inspect its own situation and nothing else.

**A tool is registered only when its dependencies are present.** No workspace path, no `sortie_status`; no tracker project, no `tracker_api`; no notification backend, no `notify_operator`. The sidecar derives this decision from the same workflow file and session environment the main process uses, so its `tools/list` and the orchestrator's prompt advertisement are built from one decision rather than two.

**Absence degrades, invalidity fails fast.** These are different situations and Sortie treats them differently. An *absent* dependency degrades silently: the tool is not registered, and the session runs with a smaller tool set. An *invalid* configuration of a present dependency fails fast: a notification backend with an unknown kind, or a secret that resolves to the empty string, is a fatal MCP server startup error, never a partial registration. The split keeps registration honest at both ends: a dependency that is missing yields no tool, and a dependency that is present but misconfigured yields no session.

**Failures are answers, not hangs.** Inside a session, a tool problem becomes a structured error response the agent can read and act on. A call to a name that is not registered returns an error response and the session continues. A Tier 2 timeout returns an error rather than blocking the turn. The agent always gets to decide what to do next, which is the property an autonomous system actually needs from its tools.

**One delivery channel, statically composed.** Tools reach an agent through a per-session MCP stdio sidecar (`sortie mcp-server`) that the agent runtime spawns and feeds from environment variables, chosen in [ADR-0009](https://github.com/sortie-ai/sortie/blob/main/docs/decisions/0009-mcp-stdio-sidecar-for-tool-execution.md) so any MCP-capable agent gets the same tools with no adapter-specific glue. What varies is how a runtime gets pointed at it: some CLIs take the generated config file directly, others accept no config path and have the same servers translated into the form they do read. The sidecar is the same either way. The registry behind the channel does not vary either. It is static: tools register during startup, there is no dynamic plugin loading, and a duplicate name panics. A new tool is new code behind the same interface, reviewed and compiled in, which is the same trade Sortie makes for [adapters](/concepts/adapter-model/).

**A capability is named only where it can be delivered.** Some runtimes reach the sidecar and some cannot, and one that can locally cannot when the session is dispatched over SSH, because carrying the configuration there would expose the credential it holds on a command line other users of the host can read. Sortie treats that as deciding the prompt too: the first-turn tool advertisement is written only for a session whose channel actually exists. An agent that could not call `tracker_api` is never told about `tracker_api`. Telling it anyway costs a turn spent on a call the runtime refuses, and the refusal comes from the runtime rather than from Sortie, so nothing in the logs explains it. [Delivery by agent kind](/reference/agent-extensions/#delivery-by-agent-kind) says where each kind lands.

Tools are one half of a larger model. They form the request-response data plane between agent and orchestrator; the `.sortie/status` file forms the one-way control plane. The tiers segment the data plane by dependency, not by purpose: a Tier 1 tool and a Tier 2 tool can serve the same goal while needing entirely different guarantees. For the two-channel model itself, see [agent communication](/concepts/agent-communication/).

## Built-in tools by tier

| Tool | Tier | What it does | Sortie registers it when |
|---|---|---|---|
| `sortie_status` | 1 | Reports the current session's turn and token state from `.sortie/state.json`. | `SORTIE_WORKSPACE` is set. |
| `workspace_history` | 1 | Reports the issue's prior run attempts from the `run_history` table. | `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the database opens read-only. |
| `cost_budget` | 1 | Reports cumulative per-issue token spend against the configured budget. | Same gate as `workspace_history`; `SORTIE_SESSION_ID` adds the running session's spend. |
| `tracker_api` | 2 | Reads and writes the configured issue tracker, scoped to the configured project. | A valid tracker configuration with credentials and a project is present. |
| `notify_operator` | 2 | Posts a real-time notification to operator-configured channels, which are an [adapter family](/concepts/adapter-model/) of their own. | The `notifications` list configures at least one backend. |

Input schemas, response formats, and error kinds for each tool live in the [agent extensions reference](/reference/agent-extensions/).

## Choosing a tier for a new tool

The decision rule is the dependency test, not the response shape: every tool returns the same uniform envelope with a machine-readable `kind`. If your tool makes external network calls or needs credentials, it is Tier 2: register it conditionally on its dependency being configured, and bound every call with a timeout so it degrades instead of hanging. If it reads only local session state, it is Tier 1: register it whenever its session inputs are present, and let a missing input mean the tool is not offered rather than a tool that fails. The implementation mechanics, the interface, the registration block, and the test patterns live in [how to write a custom agent tool](/guides/write-custom-agent-tool/).

## Further reading

- [Agent communication](/concepts/agent-communication/) for the two-channel model the tools sit inside
- [Adapter model](/concepts/adapter-model/) for the registry-and-interface pattern the tool subsystem shares
- [Agent extensions reference](/reference/agent-extensions/) for every tool's schema, response format, and error kinds
- [How to write a custom agent tool](/guides/write-custom-agent-tool/) for the implementation and registration mechanics
- [How to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for prompt patterns that put the tools to work
