---
title: "How to Control Agent Costs"
linkTitle: "Control Agent Costs"
description: "Configure per-session budgets, session limits, per-issue token budgets, turn caps, concurrency, and model selection to keep agent API spending predictable."
author: Sortie AI
date: 2026-04-26
weight: 110
url: /guides/control-costs/
---
Set hard spending caps, limit retries, throttle concurrency, and pick the right model so your agent API bill stays predictable — even when Sortie runs unattended.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- An agent adapter configured (examples below use Claude Code — adapt the extension block for your adapter)

## The six cost levers

Sortie has six independent controls that affect API spending. Four are generic orchestrator settings that apply to every adapter. Two are adapter-specific and live in the extension block for your agent. Together they determine your worst-case cost. Here they are, ordered by impact.

## Set a per-session budget

The single most effective cost control is a per-invocation spending cap. The mechanism is adapter-specific — for Claude Code it's `claude-code.max_budget_usd`, which tells the CLI to stop when cumulative API cost for that invocation reaches the specified dollar amount. The agent exits with a `max_budget_reached` signal when the cap hits.

```yaml
# Claude Code adapter example
claude-code:
  max_budget_usd: 3
```

Other adapters may expose an equivalent field in their extension block. Check your adapter reference for the specific key name. For adapters without one, the orchestrator-level token budget fills the gap: [`agent.max_tokens`](#cap-tokens-per-issue) caps cumulative per-issue spend regardless of adapter. OpenCode, for example, exposes model selection but no built-in per-turn budget field, so the main hard limits are `agent.max_tokens`, `agent.max_sessions`, `agent.max_turns`, concurrency caps, and `turn_timeout_ms`. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the adapter-specific details.

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

## Cap tokens per issue

`agent.max_tokens` is a cumulative per-issue token ceiling. The orchestrator sums the `total_tokens` reported for every session of an issue from its run history, and once the sum reaches the budget it stops dispatching new sessions: the claim is released, the retry entry is dropped, and the issue stays in its current tracker state. The default is `0`, which means unlimited.

```yaml
agent:
  max_tokens: 1500000
```

This cap is adapter-independent. It reads the token counts every adapter already reports, so it works whether or not your agent has a native budget field. It is also the only orchestrator-level cap denominated in actual consumption: `max_sessions` bounds how many attempts an issue gets, `max_tokens` bounds what those attempts may consume in total. The two ceilings are independent, and whichever fills first wins.

The check runs before re-dispatch, not during a session. A running session is never killed by the token budget, so cumulative spend can overshoot the ceiling by at most one session's worth, which is exactly what the per-session and per-turn caps bound.

Agents can read this budget themselves. The `cost_budget` tool returns cumulative spend and remaining budget mid-session, the same numbers the orchestrator enforces, so a well-prompted agent wraps up before the ceiling lands. See [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for the prompt pattern and the [agent extensions reference](/reference/agent-extensions/) for the response schema. For field-level details (validation, env override, reload), see the [`agent` section reference](/reference/workflow-config/#agent).

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

OpenCode and Codex do not expose a second inner-turn cap in Sortie. One `RunTurn` runs until the CLI exits or `turn_timeout_ms` fires, so orchestrator-level turn, session, and concurrency limits matter more. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the OpenCode turn model.

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

Here's a production WORKFLOW.md snippet that combines all six levers, using the Claude Code adapter as the example:

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
  max_tokens: 1500000
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

`max_tokens` adds a second, independent bound on the same issue: with `max_tokens: 1500000`, cumulative spend across all of an issue's sessions stops at roughly 1.5M tokens. The two bounds are complementary. The per-turn dollar cap bounds each session from inside; the token budget bounds the issue across sessions. Because the token check runs between sessions, the final session can overshoot the ceiling, and the per-turn budget and turn limit bound that overshoot.

These are worst cases in the sense that the system stops itself once it reaches them. Treat them as close bounds rather than hard ceilings: Claude Code checks the dollar cap at a turn boundary, not mid-turn, so an individual turn can finish slightly over its own budget. Real costs will be well below the table because most turns don't exhaust the budget, most sessions succeed early, and `max_budget_usd` is a ceiling, not a target.

## Monitor spending

Five tools give you cost visibility without any extra infrastructure.

**Dashboard.** When `token_rates` is configured in WORKFLOW.md, each running session gets an `Est. Cost` field in its expandable detail panel, and an `Active Est. Cost (USD)` card aggregates across all active sessions. The run history table is a different surface: its columns are `Identifier`, `Status`, `Started`, and `Duration`, and expanding a row adds attempt, turns, workflow, and error. No cost or token figure appears there for a completed session, because the cost figures the dashboard renders describe live and aggregate state. For spend against runs that have already finished, reach for [`sortie stats`](/reference/cli/#stats) below. The HTTP server runs by default on `http://localhost:7678`. See the [dashboard reference](/reference/dashboard/#cost-estimation) for details.

Configure token rates to see cost estimates on the dashboard:

```yaml
token_rates:
  claude-code:
    input_per_mtok: 3.00
    output_per_mtok: 15.00
    cache_read_per_mtok: 0.30
```

Without `token_rates`, the dashboard shows raw token counts only. See the [`token_rates` reference](/reference/workflow-config/#token_rates) for the full schema.

**Prometheus.** The `sortie_tokens_total` counter tracks cumulative token consumption with a `type` label (`input`, `output`, `cache_read`). Pair it with model pricing to estimate dollar cost. A PromQL query for hourly input token rate:

```promql
rate(sortie_tokens_total{type="input"}[1h])
```

Set up alerting when token burn exceeds your budget threshold. The [Prometheus guide](/guides/monitor-with-prometheus/) walks through scrape config and alert rules.

**Logs.** Sortie's structured logs record what ran, not what it cost. No log line carries a dollar figure. One carries a token count: when `agent.max_tokens` is set and an issue exhausts it, Sortie logs `token budget exhausted, blocking re-dispatch` with `used_tokens`, the issue's cumulative tokens across every session, and `budget_tokens`, the ceiling it hit. Grep for that message to find the issues that reached the ceiling. For the spend figures themselves, reach for `sortie stats` or the `sortie_tokens_total` counter above. The [logging guide](/guides/monitor-with-logs/) covers structured log access.

**`sortie stats`.** The `stats` subcommand reports what finished work actually cost, aggregated from the local database over a range you choose and broken down by outcome, coding agent, dispatch rule, and prompt template. It is the only one of these surfaces that reports historical spend against completed runs rather than live or per-event figures, which makes it the one to reach for when the question is which dispatch rule or prompt template is burning the budget. Cost figures need `token_rates`, exactly as the dashboard does; without it you get token counts and no dollars.

```sh
sortie stats --since 24h WORKFLOW.md
```

See the [`stats` subcommand reference](/reference/cli/#stats) for the flags, the range grammar, and every field it reports.

**The agent itself.** Mid-session, an agent can call the `cost_budget` tool to read cumulative spend and remaining budget for its issue, the same numbers the orchestrator enforces at the ceiling. Prompt patterns live in [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/); the response schema is in the [agent extensions reference](/reference/agent-extensions/).

## What we configured

You now have six layers of cost protection:

1. A **per-turn hard cap** (adapter-specific) that stops the agent mid-session when spending exceeds the budget
2. A **session limit** that prevents infinite retries on stuck issues
3. A **per-issue token ceiling** that stops new sessions once cumulative spend crosses the budget
4. A **turn limit** that bounds orchestrator loop iterations per session
5. A **concurrency cap** that limits parallel spending
6. A **cost-efficient model and effort level** (adapter-specific) to reduce per-token spend

The per-turn cap, session limit, and turn limit are multiplicative; they set your worst-case dollar ceiling. The token ceiling is an absolute cap on top of the multiplication: an issue stops consuming new sessions at the budget no matter how the factors line up. The concurrency cap and model choice control burn rate. All six fail safe: when a cap is hit, the agent stops. No silent overruns.
