---
title: "How to Control Agent Costs"
description: "Configure per-session budgets, session limits, turn caps, concurrency, and model selection to keep agent API spending predictable."
keywords: sortie costs, cost control, token budget, autonomous coding agent, concurrency limits, agent spending, max_sessions, max_turns, max_concurrent_agents
author: Sortie AI
date: 2026-03-28
weight: 20
url: /guides/control-costs/
---

# How to control agent costs

Set hard spending caps, limit retries, throttle concurrency, and pick the right model so your agent API bill stays predictable — even when Sortie runs unattended.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- An agent adapter configured (examples below use Claude Code — adapt the extension block for your adapter)

## The five cost levers

Sortie has five independent controls that affect API spending. Three are generic orchestrator settings that apply to every adapter. Two are adapter-specific and live in the extension block for your agent. Together they multiply to determine your worst-case cost. Here they are, ordered by impact.

## Set a per-session budget

The single most effective cost control is a per-invocation spending cap. The mechanism is adapter-specific — for Claude Code it's `claude-code.max_budget_usd`, which tells the CLI to stop when cumulative API cost for that invocation reaches the specified dollar amount. The agent exits with a `max_budget_reached` signal when the cap hits.

```yaml
# Claude Code adapter example
claude-code:
  max_budget_usd: 3
```

Other adapters may expose an equivalent field in their extension block. Check your adapter's [reference docs](/reference/workflow-config/) for the specific key name.

This cap applies **per `RunTurn` invocation**, not per issue. If the orchestrator calls `RunTurn` multiple times in a session (controlled by `agent.max_turns`), and the issue retries across multiple sessions (controlled by `agent.max_sessions`), the effective worst-case per-issue budget is:

$$
\text{budget\_per\_turn} \times \text{agent.max\_turns} \times \text{agent.max\_sessions}
$$

With a $3 per-turn budget, `max_turns: 3`, and `max_sessions: 3`, a single issue can spend at most **$27** before the orchestrator gives up. In practice it spends far less — most turns don't exhaust the budget, and most issues resolve in one or two sessions.

If the per-turn budget is absent or `0`, the agent runs uncapped. Don't do this in production.

## Cap sessions per issue

`agent.max_sessions` limits how many completed worker sessions the orchestrator runs for one issue before permanently giving up. The default is `0`, which means unlimited — a stuck issue retries forever.

```yaml
agent:
  max_sessions: 3
```

With `max_sessions: 3`, Sortie makes three attempts. If all three fail or produce incomplete results, the issue stays in its current tracker state and Sortie moves on. You will see it in the [dashboard](/reference/dashboard/) run history with the outcome of each attempt.

Set this to a real number in production. A value of `0` is fine for local testing, but an issue that defeats the agent on the first attempt will probably defeat it on the twentieth too — and you'll pay for all twenty.

## Limit turns per session

Each worker session runs a loop: invoke `RunTurn`, check the result, decide whether to continue. `agent.max_turns` caps how many iterations that loop gets.

```yaml
agent:
  max_turns: 3
```

The default is `20`. For cost-conscious setups, `3`–`5` is a good starting point. Most well-scoped issues resolve in one or two turns. Higher values help with complex multi-step work but increase the spending ceiling.

Some adapters expose a second turn control. Claude Code, for example, has `claude-code.max_turns` which caps agentic steps *within* a single `RunTurn` invocation. When both are set, they multiply:

$$
\text{agent.max\_turns} \times \text{adapter\_max\_turns} = \text{total agentic step budget}
$$

With `agent.max_turns: 3` and `claude-code.max_turns: 50`, the agent gets up to 150 agentic steps per session. Setting the adapter's turn limit too low causes the agent to exit mid-task; too high gives it room to explore tangents. The per-turn budget cap acts as the financial backstop regardless of how many steps run.

## Throttle concurrency

Fewer concurrent agents means lower peak burn rate. Two fields control this:

```yaml
agent:
  max_concurrent_agents: 2
  max_concurrent_agents_by_state:
    to do: 1
    in progress: 2
```

`max_concurrent_agents` is the global ceiling — Sortie never runs more than this many workers simultaneously, no matter how many issues are queued. The default is `10`.

`max_concurrent_agents_by_state` adds per-state limits. State keys are lowercased to match your tracker states. In the example above, at most 1 "to do" issue and 2 "in progress" issues run at once, and the combined total never exceeds the global cap of 2.

A conservative starting point: set the global cap to `2`. You can always raise it after watching a few cycles. Running 2 agents in parallel burns half the tokens-per-second of running 4, and gives you time to review results before the bill compounds.

## Choose your model and effort level

If your adapter supports model selection, this is the bluntest cost lever. Cheaper models burn fewer dollars per token, and most routine code tasks — bug fixes, small features, test generation — don't need the most expensive option.

For the Claude Code adapter, `model` and `effort` live in the extension block:

```yaml
# Claude Code adapter example
claude-code:
  model: claude-sonnet-4-20250514
  effort: medium
```

Sonnet is significantly cheaper than Opus per token. The `effort` field controls how much reasoning work the agent invests per response. `low` reduces token usage and latency. `medium` is a good default. `high` is for tasks that need deep analysis. Each step up increases token consumption.

Model pricing changes frequently. Check your provider's pricing page before making model decisions.

## Putting it all together

Here's a production WORKFLOW.md snippet that combines all five levers, using the Claude Code adapter as the example:

```yaml
# WORKFLOW.md (cost-conscious production config)
---
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PLATFORM
  active_states: [To Do, In Progress]
  terminal_states: [Done, Won't Do]
  handoff_state: Human Review

agent:
  kind: claude-code
  command: claude
  max_turns: 3
  max_sessions: 3
  max_concurrent_agents: 2
  max_concurrent_agents_by_state:
    to do: 1
    in progress: 2

claude-code:
  permission_mode: bypassPermissions
  model: claude-sonnet-4-20250514
  effort: medium
  max_turns: 50
  max_budget_usd: 3

polling:
  interval_ms: 60000

workspace:
  root: /var/sortie/workspaces
---
```

## Calculate your worst case

With the config above, the maximum possible spend per issue:

| Factor | Value | Source |
|---|---|---|
| Per-turn budget | $3.00 | `claude-code.max_budget_usd` |
| Turns per session | 3 | `agent.max_turns` |
| Sessions per issue | 3 | `agent.max_sessions` |
| **Worst case per issue** | **$27.00** | $3 × 3 × 3 |

The maximum spend per poll cycle (all concurrent agents hitting their budget simultaneously):

| Factor | Value | Source |
|---|---|---|
| Worst case per issue | $27.00 | Calculated above |
| Concurrent agents | 2 | `agent.max_concurrent_agents` |
| **Worst case per cycle** | **$54.00** | $27 × 2 |

These are true worst cases — the maximum the system can spend before it stops itself. Real costs will be lower because most turns don't exhaust the budget, most sessions succeed early, and `max_budget_usd` is a ceiling, not a target.

## Monitor spending

Three tools give you cost visibility without any extra infrastructure.

**Dashboard.** The run history table shows `total_cost_usd` for each completed session. The HTTP server runs by default on `http://localhost:7678`. See the [dashboard reference](/reference/dashboard/) for details.

**Prometheus.** The `sortie_tokens_total` counter tracks cumulative token consumption with a `type` label (`input`, `output`, `cache_read`). Pair it with model pricing to estimate dollar cost. A PromQL query for hourly input token rate:

```promql
rate(sortie_tokens_total{type="input"}[1h])
```

Set up alerting when token burn exceeds your budget threshold. The [Prometheus guide](/guides/monitor-with-prometheus/) walks through scrape config and alert rules.

**Logs.** Every completed turn emits a `result` event containing `total_cost_usd`, `duration_ms`, `num_turns`, and a `usage` object with `input_tokens`, `output_tokens`, and `cache_read_input_tokens`. Grep for these to build a cost audit trail. The [logging guide](/guides/monitor-with-logs/) covers structured log access.

## What we configured

You now have five layers of cost protection:

1. A **per-turn hard cap** (adapter-specific) that stops the agent mid-session when spending exceeds the budget
2. A **session limit** that prevents infinite retries on stuck issues
3. A **turn limit** that bounds orchestrator loop iterations per session
4. A **concurrency cap** that limits parallel spending
5. A **cost-efficient model and effort level** (adapter-specific) to reduce per-token spend

The first three are multiplicative — they set your worst-case ceiling. The last two control burn rate. All five fail safe: when a cap is hit, the agent stops. No silent overruns.
