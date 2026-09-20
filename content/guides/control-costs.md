---
title: "How to Control Agent Costs"
linkTitle: "Control Agent Costs"
description: "Configure per-session budgets, session limits, per-issue token budgets, turn caps, concurrency, and model selection to keep agent API spending predictable."
author: Sortie AI
date: 2026-04-26
weight: 110
url: /guides/control-costs/
---
Set hard spending caps, limit retries, throttle concurrency, and pick the right model so your agent API bill stays predictable, even when Sortie runs unattended.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- An agent adapter configured (examples below use Claude Code, so adapt the extension block for your adapter)

## The six cost levers

Sortie has six independent controls that affect API spending. Four are generic orchestrator settings that apply to every adapter. Two are adapter-specific and live in the extension block for your agent. Together they determine your worst-case cost. Here they are, ordered by impact.

## Set a per-session budget

The single most effective cost control is a per-invocation spending cap. The mechanism is adapter-specific: for Claude Code it's `claude-code.max_budget_usd`, which tells the CLI to stop when cumulative API cost for that invocation reaches the specified dollar amount. The agent exits with a `max_budget_reached` signal when the cap hits.

```yaml
# Claude Code adapter example
claude-code:
  max_budget_usd: 3
```

Other adapters may expose an equivalent field in their extension block. Check your adapter reference for the specific key name. For a kind without one, what bounds a session depends on whether that kind reports token usage at all: [`agent.max_tokens`](#cap-tokens-per-issue) counts against a kind whose figures reach Sortie, and `agent.turn_timeout_ms` is the bound left for a kind whose figures never do. The [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind) states which your kind is. OpenCode, for example, exposes model selection but no built-in per-turn budget field, so the main hard limits are `agent.max_tokens`, `agent.max_sessions`, `agent.max_turns`, concurrency caps, and `turn_timeout_ms`. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the adapter-specific details.

This cap applies **per `RunTurn` invocation**, not per issue. If the orchestrator calls `RunTurn` multiple times in a session (controlled by `agent.max_turns`), and the issue retries across multiple sessions (controlled by `agent.max_sessions`), the effective worst-case per-issue budget is:

$$
\text{budget\_per\_turn} \times \text{agent.max\_turns} \times \text{agent.max\_sessions}
$$

With a $3 per-turn budget, `max_turns: 3`, and `max_sessions: 3`, a single issue can spend at most **$27** before the orchestrator gives up. In practice it spends far less. Most turns don't exhaust the budget, and most issues resolve in one or two sessions.

If the per-turn budget is absent or `0`, the agent runs uncapped. Don't do this in production.

## Cap sessions per issue

`agent.max_sessions` limits how many completed worker sessions the orchestrator runs for one issue before permanently giving up. The default is `0`, which means unlimited: a stuck issue retries forever. A separate setting, `agent.max_consecutive_absences`, bounds an issue whose runs produce no observable work at all, regardless of what `max_sessions` is set to. See [park issues stuck in a loop of empty runs](/guides/configure-retry-behavior/#park-issues-stuck-in-a-loop-of-empty-runs).

```yaml
agent:
  max_sessions: 3
```

With `max_sessions: 3`, Sortie makes three attempts. If all three fail or produce incomplete results, the issue stays in its current tracker state and Sortie moves on. You will see it in the [dashboard](/reference/dashboard/) run history with the outcome of each attempt.

Set this to a real number in production. A value of `0` is fine for local testing.

## Cap tokens per issue

`agent.max_tokens` is a cumulative per-issue token ceiling. The orchestrator sums the `total_tokens` reported for every completed session of an issue from its run history, and once the sum reaches the budget it stops dispatching new sessions: the claim is released, the retry entry is dropped, and the issue stays in its current tracker state. While a session is running, its own spend counts toward that same sum. The default is `0`, which means unlimited.

```yaml
agent:
  max_tokens: 1500000
```

This cap lives in the orchestrator, not in the agent's own budget field, so it applies whether or not your agent has one. It enforces against what your agent runtime actually reports: an adapter that never reports token counts produces a sum that never reaches the ceiling, and `agent.turn_timeout_ms` is the backstop for that case. [`sortie validate`](/reference/cli/#validate) names that pairing before you run it, as an `agent.kind.no_usage_reporting` warning naming the kind, so an inert ceiling is not something to infer from a budget that never fires. It is also the only orchestrator-level cap denominated in actual consumption: `max_sessions` bounds how many attempts an issue gets, `max_tokens` bounds what those attempts may consume in total. The two ceilings are independent, and whichever fills first wins.

The ceiling binds the session in progress, not only the next one. Each token figure your agent runtime reports goes against the issue's total as it arrives, and the moment that total reaches the budget Sortie cancels the running session. The run is recorded as `budget_stopped`, with the tokens used and the ceiling in its error text, the claim is released, and no retry is scheduled.

How far past the ceiling a session gets depends on how often your adapter reports. A kind declaring `UsageArrival: incremental` reports once per model API request, so the stop lands within one request of the budget. A kind declaring `turn_end` reports only once a turn is over, so a long turn can carry the issue well past the ceiling before anything can act on it, and `agent.max_turns` with the per-turn caps above are what bound that. Your adapter's reference page names the declaration in its Adapter registration table.

Two conditions leave a running session unbounded, and Sortie names both at the dispatch that starts it. A kind whose declaration promises no usage figure gets `token ceiling cannot bound this run`, carrying the kind and its `usage_arrival` value; `agent.turn_timeout_ms` is the only cap left for those sessions. A failed read of the issue's already-completed spend gets `prior token spend unknown, token ceiling bounds this session only`: the new session still stops at the full budget, but what earlier sessions spent is not counted against it. A read failure later, at the moment a stop would be decided, logs `in-flight token ceiling check failed, run continues` once per run and lets the session carry on, unless that session has spent the whole budget by itself, which takes no read to establish and stops it regardless.

A run whose agent reported no token usage is recorded unmeasured and contributes nothing to the sum. A measured sum that reaches the ceiling still blocks, unmeasured runs or not. A run can also be measured throughout and still spend more than its figures show, when a turn reaches the model without a figure that covers it. When the sum is below the ceiling but either gap leaves it short of the issue's real spend, Sortie dispatches and logs `token budget cannot be fully evaluated, allowing dispatch` naming the issue, the sum, the ceiling, and both counts. A failed token-sum query also allows the dispatch, under a warning of its own. Grep your logs for `token budget` and `token ceiling` to catch every record the ceiling emits, and check `used_tokens_complete` on the `cost_budget` tool to see whether the current figure is trustworthy.

Agents can read this budget themselves. The `cost_budget` tool returns cumulative spend and remaining budget mid-session, within a couple of seconds of the figure the orchestrator enforces, so a well-prompted agent wraps up on its own terms instead of being stopped in flight. See [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for the prompt pattern and the [agent extensions reference](/reference/agent-extensions/) for the response schema. For field-level details (validation, env override, reload), see the [`agent` section reference](/reference/workflow-config/#agent).

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

`max_concurrent_agents` is the global ceiling. Sortie never runs more than this many workers simultaneously, no matter how many issues are queued. The default is `10`.

`max_concurrent_agents_by_state` adds per-state limits. State keys are lowercased to match your tracker states. In the example above, at most 1 "to do" issue and 2 "in progress" issues run at once, and the combined total never exceeds the global cap of 2.

A conservative starting point: set the global cap to `2`. You can always raise it after watching a few cycles. Running 2 agents in parallel burns half the tokens-per-second of running 4, and gives you time to review results before the bill compounds.

## Choose your model and effort level

If your adapter supports model selection, this is the bluntest cost lever. Cheaper models burn fewer dollars per token, and most routine code tasks (bug fixes, small features, test generation) don't need the most expensive option.

For the Claude Code adapter, `model` and `effort` live in the extension block:

```yaml
# Claude Code adapter example
claude-code:
  model: <model-id>
  effort: medium
```

A cheaper model and a lower effort setting are the two bluntest levers you have, and they cost nothing to change. Both are pass-through keys: Sortie forwards the value and does not interpret it, so which models exist, which effort levels each one accepts, and what they cost are the provider's to publish. Check the provider's own model and pricing pages before choosing, because both change often.

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
  model: <model-id>
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

`max_tokens` adds a second, independent bound on the same issue: with `max_tokens: 1500000`, cumulative spend across all of an issue's sessions stops at roughly 1.5M tokens. The two bounds are complementary. The per-turn dollar cap bounds each session from inside; the token budget bounds the issue across sessions. The token check runs inside a session as well as between them, so the overshoot is one usage report rather than one whole session; where the adapter reports only at a turn boundary, the per-turn budget and turn limit are what bound it.

These are worst cases in the sense that the system stops itself once it reaches them. Treat them as close bounds rather than hard ceilings: Claude Code checks the dollar cap at a turn boundary, not mid-turn, so an individual turn can finish slightly over its own budget. Real costs will be well below the table because most turns don't exhaust the budget, most sessions succeed early, and `max_budget_usd` is a ceiling, not a target.

## Monitor spending

Five tools give you cost visibility without any extra infrastructure.

**Dashboard.** Each running session's expandable detail panel carries an `Est. Cost` field, which holds a figure once `token_rates` is configured in WORKFLOW.md and an em dash otherwise, and an `Active Est. Cost (USD)` card aggregates across all active sessions when rates are configured. The same panel's `Usage reporting` field states whether that session's agent kind reports token figures at all, which is what tells a blank cost apart from a missing rate. The run history table is a different surface: its columns are `Identifier`, `Status`, `Started`, and `Duration`, and expanding a row adds attempt, turns, workflow, and error. No cost or token figure appears there for a completed session, because the cost figures the dashboard renders describe live and aggregate state. For spend against runs that have already finished, reach for [`sortie stats`](/reference/cli/#stats) below. The HTTP server runs by default on `http://localhost:7678`. See the [dashboard reference](/reference/dashboard/#cost-estimation) for details.

Configure token rates to see cost estimates on the dashboard:

```yaml
# Rates are yours to supply and are illustrative here.
token_rates:
  claude-code:
    input_per_mtok: 0.00
    output_per_mtok: 0.00
    cache_read_per_mtok: 0.00
```

Without `token_rates`, the dashboard shows raw token counts only. See the [`token_rates` reference](/reference/workflow-config/#token_rates) for the full schema.

**Prometheus.** The `sortie_tokens_total` counter tracks cumulative token consumption with a `type` label (`input`, `output`, `cache_read`). Pair it with model pricing to estimate dollar cost. A PromQL query for hourly input token rate:

```promql
rate(sortie_tokens_total{type="input"}[1h])
```

Set up alerting when token burn exceeds your budget threshold. The [Prometheus guide](/guides/monitor-with-prometheus/) walks through scrape config and alert rules.

**Logs.** Sortie's structured logs record what ran, not what it cost. No log line carries a dollar figure. Three carry a token count, all gated on `agent.max_tokens` being set: `token budget exhausted, blocking re-dispatch` when an issue reaches the ceiling between sessions, `run stopped by token ceiling` when it reaches the ceiling during one, and `token budget cannot be fully evaluated, allowing dispatch` when it has not but the sum is known to fall short of what the issue really spent. All three carry `used_tokens`, the issue's measured cumulative tokens, and `budget_tokens`, the ceiling; the stop record adds `session_tokens`, what the session it cancelled had spent on its own. Grep for `token budget` and `token ceiling` to find them. For the spend figures themselves, reach for `sortie stats` or the `sortie_tokens_total` counter above. The [logging guide](/guides/monitor-with-logs/) covers structured log access.

**`sortie stats`.** The `stats` subcommand reports what finished work actually cost, aggregated from the local database over a range you choose and broken down by outcome, coding agent, dispatch rule, and prompt template. It is the only one of these surfaces that reports historical spend against completed runs rather than live or per-event figures, which makes it the one to reach for when the question is which dispatch rule or prompt template is burning the budget. Cost figures need `token_rates`, exactly as the dashboard does; without it you get token counts and no dollars.

```sh
sortie stats --since 24h WORKFLOW.md
```

See the [`stats` subcommand reference](/reference/cli/#stats) for the flags, the range grammar, and every field it reports.

**The agent itself.** Mid-session, an agent can call the `cost_budget` tool to read cumulative spend and remaining budget for its issue. The reading trails the figure the orchestrator enforces by at most one throttled write of the running session's spend, two seconds, and never leads it, so an agent acting on it acts early rather than late. Prompt patterns live in [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/); the response schema is in the [agent extensions reference](/reference/agent-extensions/).

## What we configured

You now have six layers of cost protection:

1. A **per-turn hard cap** (adapter-specific) that stops the agent mid-session when spending exceeds the budget
2. A **session limit** that prevents infinite retries on stuck issues
3. A **per-issue token ceiling** that stops new sessions once measured cumulative spend crosses the budget
4. A **turn limit** that bounds orchestrator loop iterations per session
5. A **concurrency cap** that limits parallel spending
6. A **cost-efficient model and effort level** (adapter-specific) to reduce per-token spend

The per-turn cap, session limit, and turn limit are multiplicative; they set your worst-case dollar ceiling. The token ceiling is an absolute cap on top of the multiplication: an issue stops consuming new sessions at the budget no matter how the factors line up. The concurrency cap and model choice control burn rate. The five hard ceilings fail safe: when one is hit, the agent stops. The token ceiling enforces against measured spend and announces, rather than hides, the sessions it could not measure.
