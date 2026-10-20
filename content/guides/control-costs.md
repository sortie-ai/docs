---
title: "How to Control Agent Costs"
linkTitle: "Control Agent Costs"
description: "Configure per-turn budgets, session limits, per-issue token and dollar budgets, a daily or monthly spend limit for the whole instance, turn caps, concurrency, and model selection to keep agent API spending predictable."
author: Sortie AI
date: 2026-04-26
weight: 110
url: /guides/control-costs/
---
Set hard spending caps, limit retries, throttle concurrency, and pick the right model so your agent API bill stays predictable, even when Sortie runs unattended.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- An agent adapter configured (examples below use Claude Code, so adapt the extension block for your adapter)

## The cost levers

Several independent controls affect API spending. The limits on sessions, tokens, dollars per issue, dollars per day or month for the whole instance, turns, and concurrency are orchestrator settings that apply to every adapter. The per-turn money cap and the model and effort level live in the extension block for your agent, and which of them exist depends on the kind. Together they determine your worst-case cost. Here they are, ordered by impact.

## Set a per-turn budget

The most effective cost control is a spending cap on each turn. Of the built-in agent kinds, only `claude-code` has one: `claude-code.max_budget_usd` tells the CLI to stop when the cumulative API cost of that turn reaches the given dollar amount. The agent exits with a `max_budget_reached` signal when the cap hits.

```yaml
# Claude Code adapter example
claude-code:
  max_budget_usd: 3
```

The other kinds (`codex`, `copilot-cli`, `opencode`, and `agent-client-protocol`) have no per-turn money cap. What bounds their sessions depends on whether the kind reports token usage at all: [`agent.max_tokens`](#cap-tokens-per-issue) and [`agent.max_cost_usd`](#cap-an-issues-spend-in-dollars) count against a kind whose figures reach Sortie, and `agent.turn_timeout_ms` is the bound left for a kind whose figures never do. The [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind) states which your kind is. OpenCode, for example, exposes model selection but no budget field, so its hard limits are `agent.max_tokens`, `agent.max_sessions`, `agent.max_turns`, concurrency caps, and `turn_timeout_ms`. See the [OpenCode CLI adapter reference](/reference/adapter-opencode/) for the adapter-specific details.

The cap applies to each turn, not to the issue. A session runs up to `agent.max_turns` turns, and an issue retries across up to `agent.max_sessions` sessions, so the worst-case money spend per issue is:

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

With `max_sessions: 3`, Sortie makes three attempts. If all three fail or produce incomplete results, the issue stays in its current tracker state and Sortie moves on. You will see it in the dashboard's [History](/reference/dashboard/#history) with the outcome of each attempt.

Set this to a real number in production. A value of `0` is fine for local testing.

## Cap tokens per issue

`agent.max_tokens` is a cumulative per-issue token ceiling. The orchestrator sums the tokens reported for every completed session of an issue from its run history, and once the sum reaches the budget it stops dispatching new sessions: the claim is released, the retry entry is dropped, and the issue stays in its current tracker state. While a session is running, its own spend counts toward that same sum. The default is `0`, which means unlimited.

The count leaves out prompt-cache reads, for every agent kind, so an issue is held and a run stopped later than a count that included them would do it: each session contributes its `total_tokens` less its `cache_read_tokens`, never below zero, and cache writes still count. A long conversation re-reads its history from the cache on every request, so those reads grow with the length of the conversation rather than with the work done, and the ceiling would otherwise fill on conversation length alone. When you pick a value, take the issue's spend from a figure that uses the same count: the **Tokens** meter in the dashboard's [Budget panel](/reference/dashboard/#issue-page), `used_tokens` on a running entry of the JSON API, or `used_tokens` from the `cost_budget` tool. A total that includes cache reads, such as `tokens.total_tokens` or the `sortie_tokens_total` counter, is larger and does not match what the ceiling compares.

If you upgrade with `max_tokens` already set, the same value now lets an issue spend more before it is held. An issue already held at the ceiling runs again on the next poll tick once its count without cache reads is below the value, and the history of past runs is counted the new way as well. Re-check the value against the figures above, and lower it if you meant it as a spending limit.

```yaml
agent:
  max_tokens: 1500000
```

This cap lives in the orchestrator, not in the agent's own budget field, so it applies whether or not your agent has one. It enforces against what your agent runtime actually reports: an adapter that never reports token counts produces a sum that never reaches the ceiling, and `agent.turn_timeout_ms` is the backstop for that case. [`sortie validate`](/reference/cli/#validate) names that pairing before you run it, as an `agent.kind.no_usage_reporting` warning naming the kind, so an inert ceiling is not something to infer from a budget that never fires.

`max_sessions` bounds how many attempts an issue gets. `max_tokens` and [`max_cost_usd`](#cap-an-issues-spend-in-dollars) are the two orchestrator-level caps on what those attempts consume, in tokens and in dollars. The three ceilings are independent, and whichever is reached first wins.

The ceiling binds the session in progress, not only the next one. Each token figure your agent runtime reports goes against the issue's total as it arrives. The moment that total reaches the budget, Sortie cancels the running session.

Whether the run is then recorded `budget_stopped` depends on what that cancellation catches:

- A stall, a terminal tracker state, or shutdown that cancels the run first keeps that cancellation's own outcome, `cancelled`, not `budget_stopped`.
- A run that reaches its own conclusion before the cancellation catches it, with no self-review left to run, keeps the outcome it would have had without the ceiling.
- Otherwise, the cancellation interrupts the turn in progress, keeps a further turn from starting, or cuts self-review short or keeps it from starting; the run is recorded `budget_stopped`, and a stop landing in or around self-review also skips the handoff transition.

When the run is recorded `budget_stopped`, the run history's `error` field carries the tokens used and the ceiling, the claim is released, and no retry is scheduled.

How far past the ceiling a session gets depends on how often your adapter reports. A kind declaring `UsageArrival: incremental` reports once per model API request, so the stop lands within one request of the budget.

A kind declaring `turn_end` reports only once a turn is over, so a long turn can carry the issue well past the ceiling before anything can act on it, and `agent.max_turns` with the per-turn caps above are what bound that. Your adapter's reference page names the declaration in its Adapter registration table.

Some conditions leave a running session unbounded, and Sortie names each at the dispatch that starts it. A kind whose declaration promises no usage figure gets `token ceiling cannot bound this run`, carrying the kind and its `usage_arrival` value; `agent.turn_timeout_ms` is the only cap left for those sessions.

A failed read of the issue's already-completed spend gets `prior token spend unknown, token ceiling bounds this session only`: the new session still stops at the full budget, but what earlier sessions spent is not counted against it.

A read failure later, at the moment a stop would be decided, logs `in-flight token ceiling check failed, run continues` once per run and lets the session carry on, unless that session has spent the whole budget by itself, which takes no read to establish and stops it regardless.

A run whose agent reported no token usage is recorded unmeasured and contributes nothing to the sum. A measured sum that reaches the ceiling still blocks, unmeasured runs or not.

A run can also be measured throughout and still spend more than its figures show, when a turn reaches the model without a figure that covers it.

When the sum is below the ceiling but either gap leaves it short of the issue's real spend, Sortie dispatches and logs `token budget cannot be fully evaluated, allowing dispatch` naming the issue, the sum, the ceiling, and both counts. A failed token-sum query also allows the dispatch, under a warning of its own.

Grep your logs for `token budget` and `token ceiling` to catch every record the ceiling emits, and check `used_tokens_complete` on the `cost_budget` tool to see whether the current figure is trustworthy.

Agents can read this budget themselves. The `cost_budget` tool returns cumulative spend and remaining budget mid-session, within a couple of seconds of the figure the orchestrator enforces, so a well-prompted agent wraps up on its own terms instead of being stopped in flight. See [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/) for the prompt pattern and the [agent extensions reference](/reference/agent-extensions/) for the response schema. For field-level details (validation, env override, reload), see the [`agent` section reference](/reference/workflow-config/#agent).

### Warn before the ceiling stops a run

`agent.token_warning_percent` sets a warning threshold below `max_tokens`, as a percentage of the ceiling. It changes nothing about when the ceiling stops a run; it only warns before that happens.

```yaml
agent:
  max_tokens: 1500000
  token_warning_percent: 90
```

With this config, the threshold is 90% of 1,500,000 tokens: 1,350,000 (rounded up to the nearest whole token when the percentage doesn't divide the ceiling evenly). From the start of the session, the `cost_budget` tool's response carries `warning_tokens` at that figure and `warning_reached` at `false`.

Once the issue's live token sum reaches the threshold, Sortie logs one `token warning threshold reached` warning for the run and `warning_reached` turns `true`, giving a well-prompted agent roughly 150,000 tokens of headroom to wrap up before the ceiling cuts it off. See [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/#guide-the-agent-to-watch-the-token-budget) for the prompt pattern.

The threshold has no effect while `max_tokens` is `0`: there is no ceiling to warn ahead of. [`sortie validate`](/reference/cli/#validate) flags that combination as an `ineffective_setting` warning. `token_warning_percent` accepts `0` to `99`; `0`, the default, disables the warning. A run warns at most once: after the first warning, later usage figures from the same run never repeat it.

See [token warning threshold](/guides/monitor-with-logs/#token-warning-threshold) for the log record and the [`cost_budget` tool](/reference/agent-extensions/#cost_budget) for the response fields.

## Cap an issue's spend in dollars

`agent.max_cost_usd` is a per-issue ceiling in US dollars on the issue's estimated cost. It works like `max_tokens`: Sortie adds up the cost recorded with each of the issue's finished runs, adds the running session's live estimate, and stops once the total reaches the ceiling. The default is `0`, which means unlimited.

Use it when you budget in dollars and not in tokens. Tokens from different models are not comparable, and a token count that leaves out cache reads says little about the bill, while the estimated cost is priced per model and per token class. Set it beside `max_tokens` rather than instead of it when you also want a bound that does not depend on prices: the two ceilings are independent, and whichever is reached first wins. An issue past several ceilings at once is reported with the money budget first.

```yaml
agent:
  max_tokens: 1500000
  max_cost_usd: 25
```

The figure differs from the token count in two ways:

- **Cache reads are priced.** `max_tokens` leaves them out, but the estimated cost includes them at the cache-read rate, so a long conversation raises the cost even when it raises no token count.
- **It is an estimate.** It is Sortie's figure from its price rates, not your provider's bill, and can differ from a cost your runtime reports.

To pick a value, read the figure the ceiling compares: the **Cost** meter in the dashboard's [Budget panel](/reference/dashboard/#issue-page), `issue_estimated_cost_usd` on a running entry of the JSON API, or `used_usd` from the `cost_budget` tool. The meter appears once the ceiling is set and a rate source is available. Built-in prices cover common models with no configuration; [`token_rates`](/reference/workflow-config/#token_rates) and [`price_table`](/reference/workflow-config/#price_table) describe where prices come from and how to change them.

### What you see when the ceiling bites

The ceiling is enforced at the same points as the token ceiling. Before a dispatch, Sortie holds the issue: it releases the claim, drops the retry, posts one comment on the issue that states the estimated cost against the ceiling, and shows a "Money budget reached" item under **Needs attention** in the dashboard. The hold clears on the next poll tick after you raise `max_cost_usd` above what the issue has used, or remove it.

During a session, Sortie cancels the run as soon as a usage figure carries the issue's cost to the ceiling. The run is recorded `budget_stopped`, its `error` reads `money ceiling reached: used $X of $Y`, the claim is released, and no retry is scheduled. The log carries `run stopped by money ceiling`, and `sortie_runs_stopped_by_budget_total` counts it under reason `money_budget`. The same cancellations that can pre-empt a token stop can pre-empt this one; see [Cap tokens per issue](#cap-tokens-per-issue) for which runs end up recorded `budget_stopped`.

A session stops at the first usage figure after the spend, so a run can pass the ceiling by what the agent spends before that report. A kind whose figures arrive during each turn overshoots by about one model request; a kind whose figures arrive when a turn ends can overshoot by a whole turn. Leave headroom below the amount you cannot afford to exceed.

### When the cost cannot be fully priced

A run whose model no rate prices, a token class with no rate, or usage that was not fully reported leaves the figure incomplete. The figure is then a lower bound: the ceiling counts only what Sortie could price. While that lower bound is below the ceiling, Sortie logs `money budget cannot be fully evaluated, allowing dispatch` and dispatches anyway. Once the priced part alone reaches the ceiling, the hold applies, and the comment and the dashboard say "at least" before the amount.

The remedy is to price the model, with a [`token_rates`](/reference/workflow-config/#token_rates) entry or a price table that lists it. Runs recorded before you did so stay unpriced. To find which model and which token class lack a rate, open the session view of a finished run: its **Cost per model** panel lists each model and, under **No rate for**, the classes without a rate.

### Check the configuration

[`sortie validate`](/reference/cli/#validate) warns about two settings under which the ceiling cannot hold an issue, and the running service logs the same warnings. Neither blocks dispatch, and `validate` still exits `0`:

- `agent.max_cost_usd.no_usage_reporting`: an agent kind the workflow dispatches reports no token usage, so its sessions never produce a figure to price. `agent.turn_timeout_ms` is the only bound left for them.
- `agent.max_cost_usd.no_rate_source`: no price source is configured, so no run can be priced.

A model that the configured rates do not list draws no warning, because Sortie only learns about it when a run of that model is recorded.

Agents can read the money figures themselves: while the ceiling is set, the `cost_budget` tool also returns `used_usd`, `budget_usd`, `remaining_usd`, and `used_usd_complete`. `token_warning_percent` does not apply to the money ceiling. Grep your logs for `money budget` and `money ceiling` to find every record it emits. See the [`agent` section reference](/reference/workflow-config/#agent) for validation, the environment override, and reload behavior.

## Cap what the whole instance spends

`agent.max_daily_cost_usd` and `agent.max_monthly_cost_usd` are instance-wide ceilings in US dollars on the estimated cost of everything Sortie runs, across all issues. Use them when you budget a day or a month rather than an issue: per-issue ceilings leave the total open to however many issues arrive. Both default to `0`, which means no ceiling, and you can set either one or both.

```yaml
agent:
  max_daily_cost_usd: 100
  max_monthly_cost_usd: 1500
```

Each window is a UTC calendar day or month. It starts at 00:00 UTC and resets at the next 00:00 UTC, whatever your time zone. The dashboard's own "today" figures follow your browser's time zone instead, so they can cover a different stretch of hours than the daily window. A window's spend is the estimated cost of the runs that ended in it plus the live estimate of the sessions running now. A run counts toward the window it ended in, so a run that crosses midnight counts toward the new day. Prices come from the same sources as for [`max_cost_usd`](#cap-an-issues-spend-in-dollars), and the figure is an estimate, not your provider's bill.

### What you see when a ceiling is reached

Once a window's spend reaches its ceiling, Sortie starts no new agent session for any issue. Issues stay in their tracker states, and scheduled retries stay scheduled; they wait.

- **Candidates.** The poll tick dispatches nothing. `sortie_candidate_holds_total` counts each candidate held, with reason `daily_spend_ceiling` or `monthly_spend_ceiling`. When both windows hold, the reason names the monthly one.
- **Retries.** A retry that comes due is neither dispatched nor dropped. It keeps its attempt number and its error, and Sortie checks it again after one poll interval. The wait costs no backoff step and none of the issue's sessions. Continuations and pull request follow-ups wait the same way.
- **Running sessions.** They finish. The ceiling does not stop a session in progress, so a window's total can pass its ceiling by what the running sessions spend. Leave headroom below the amount you cannot afford to exceed, and lower `agent.max_concurrent_agents` if too many sessions can be running when the hold begins.

Sortie shows the hold in these places: a critical "Daily spend ceiling reached" or "Monthly spend ceiling reached" item under **Needs attention**, the **Spend** section of the dashboard's [Overview](/reference/dashboard/#overview), the `spend_ceiling` member of [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state), and the log records under [Instance spend ceiling](/guides/monitor-with-logs/#instance-spend-ceiling).

The hold ends on the first poll tick or retry check after the window resets, after you raise the ceiling above the window's spend, or after you remove it. An edit to WORKFLOW.md applies on the same terms. The held retries then dispatch with the attempt numbers they kept.

### When the spend cannot be fully priced

A run whose model no rate prices, a token class with no rate, or usage that was not fully reported leaves the window's figure incomplete, as it does for a single issue. A kind that reports no token usage adds nothing to it. The figure is then a lower bound: the ceiling counts only what Sortie could price or measure. While the lower bound is below the ceiling, Sortie logs `spend ceiling cannot be fully evaluated, allowing dispatch` once for the window and dispatches anyway. If the lower bound alone reaches the ceiling, the hold applies, and the dashboard, the attention item, and the API say "at least" or report `used_usd_complete` as `false`.

The remedy is to price the model, with a [`token_rates`](/reference/workflow-config/#token_rates) entry or a price table that lists it. Runs recorded before you did so stay unpriced.

### Check the configuration

[`sortie validate`](/reference/cli/#validate) warns when an instance ceiling cannot work, and the running service logs the same warnings. Neither blocks dispatch, and `validate` still exits `0`. Each warning names the ceiling it concerns, so `agent.max_daily_cost_usd` and `agent.max_monthly_cost_usd` warn separately:

- `agent.max_daily_cost_usd.no_usage_reporting`: an agent kind the workflow dispatches reports no token usage, so the ceiling counts none of that kind's spend. The monthly ceiling has the matching `agent.max_monthly_cost_usd.no_usage_reporting`.
- `agent.max_daily_cost_usd.no_rate_source`: no price source is configured, so no run can be priced. The monthly ceiling has the matching `agent.max_monthly_cost_usd.no_rate_source`.

See the [`agent` section reference](/reference/workflow-config/#agent) for validation, the environment overrides, and reload behavior.

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

Fewer concurrent agents means lower peak burn rate. These fields control this:

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

`model` and `effort` live in the extension block of your agent kind. The `claude-code`, `codex`, `copilot-cli`, and `opencode` kinds all read `effort` under that name:

```yaml
# Claude Code adapter example
claude-code:
  model: <model-id>
  effort: medium
```

A cheaper model and a lower effort setting are the two bluntest levers you have, and they cost nothing to change. Both are pass-through keys: Sortie forwards the value and does not interpret it, so which models exist, which effort levels each one accepts, and what they cost are the provider's to publish. Check the provider's own model and pricing pages before choosing, because both change often. Leave `effort` out and the agent runs at its own default level.

On `agent-client-protocol`, `effort` has no effect, and `sortie validate` warns when you set it. Put the runtime's own reasoning option in `agent.command` instead. See the [reasoning effort reference](/reference/workflow-config/#adapter-pass-through-configuration) for how each kind reads the key.

If your issues mix routine and hard work, a dispatch rule can give each group its own model and effort level; see [Route issues to a cheaper or a stronger model](/guides/configure-dispatch-rules/#route-issues-to-a-cheaper-or-a-stronger-model).

Model pricing changes frequently. Check your provider's pricing page before making model decisions.

## Putting it all together

Here's a production WORKFLOW.md snippet that combines the levers above, using the Claude Code adapter as the example:

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
  max_cost_usd: 25
  max_daily_cost_usd: 200
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

`max_tokens` adds a second, independent bound on the same issue: with `max_tokens: 1500000`, cumulative spend across all of an issue's sessions, not counting cache reads, stops at roughly 1.5M tokens. The two bounds are complementary.

`max_cost_usd` bounds the same issue in dollars: with `max_cost_usd: 25`, the estimated cost across all of an issue's sessions stops at roughly $25, below the $27 product above, and it counts cache reads, which the token budget does not. The money check, like the token check, runs inside a session as well as between them.

`max_daily_cost_usd` bounds the whole instance rather than an issue: with `max_daily_cost_usd: 200`, Sortie starts no session once the UTC day's estimated cost reaches $200. At most two sessions run when that happens, because `max_concurrent_agents` is `2`, so the day's total can pass $200 by what those two spend before they finish.

The per-turn dollar cap bounds each session from inside; the token and dollar budgets bound the issue across sessions. The token check runs inside a session as well as between them, so the overshoot is one usage report rather than one whole session; where the adapter reports only at a turn boundary, the per-turn budget and turn limit are what bound it.

These are worst cases in the sense that the system stops itself once it reaches them. Treat them as close bounds rather than hard ceilings: Claude Code checks the dollar cap at a turn boundary, not mid-turn, so an individual turn can finish slightly over its own budget. Real costs will be well below the table because most turns don't exhaust the budget, most sessions succeed early, and `max_budget_usd` is a ceiling, not a target.

## Monitor spending

These surfaces give you cost visibility without any extra infrastructure.

**Dashboard.** The session view of a running or finished session carries an **Est. cost** figure under **Usage**, and the issue page adds the cost to each run card and totals it in the **Budget and cost** panel. While an instance spend ceiling is set, **Overview** also shows each window's spend against its ceiling in its **Spend** section. A figure appears once a rate prices the session's model. Sortie ships a price table for common models, so most sessions are priced with no configuration. A model the table does not list reads "unpriced", a cost that is only a lower bound, because a token class has no rate or a turn's usage was not fully reported, reads "at least" before the amount, and a kind that reports no tokens reads "not measured". Hovering a cost shows its exact amount, and a finished session lists its cost per model in the **Cost per model** panel. **Usage reporting** in [Workflow](/reference/dashboard/#workflow) states which kinds report token figures at all, which is what tells a missing cost apart from a missing rate.

Finished runs keep their figures. [History](/reference/dashboard/#history) lists the tokens and cost of each run and each issue, and [Analytics](/reference/dashboard/#analytics) totals them over a range and breaks them down by rule, model, and agent. For spend in a script or a report, reach for [`sortie stats`](/reference/cli/#stats) below. The HTTP server runs by default on `http://localhost:7678`. See [how figures are written](/reference/dashboard/#how-figures-are-written) for the wording.

Sortie prices runs from a price table built into the binary and refreshed by a daily download, so cost estimates need no setup, even with no `token_rates` and no network access. The figure is an estimate from four rates per model, not your provider's bill. To price a model the table does not list, or to change a rate, add the rates to WORKFLOW.md. Set them before the runs you want priced: Sortie prices each run once, when it finishes, so a run that finished without a rate stays unpriced, and a later rate change leaves past costs as they were. An edit applies without a restart.

**Price a model the table does not list.** Key an entry by the model name your agent reports and set all four rates. Rates are in USD per million tokens, yours to supply and illustrative here:

```yaml
token_rates:
  my-local-model:
    input_per_mtok: 0.00
    output_per_mtok: 0.00
    cache_read_per_mtok: 0.00
    cache_write_per_mtok: 0.00
```

Leave a rate out and [`sortie validate`](/reference/cli/#validate) warns with `token_rates.model_incomplete`. The runs that spend that token class are then recorded as partial, so their cost is a lower bound.

**Override one rate of a listed model.** Set only the rate you want to change. Sortie takes the rest from the table:

```yaml
token_rates:
  claude-sonnet-4-5:
    input_per_mtok: 0.00
```

**Use your own price table.** If you negotiate prices or need figures that do not change with a release, point `price_table.replace_file` at a file in the [LiteLLM price list format](/reference/workflow-config/#price_table). It replaces the built-in and downloaded tables, so a model your file does not list stays unpriced unless a `token_rates` entry prices it. To keep the file on a server instead, set `price_table.replace_url`; use one of the two, not both. A relative path is read from the directory of WORKFLOW.md. If the file cannot be loaded, Sortie refuses to start, or keeps the previous configuration on a reload; it never falls back to the built-in table.

```yaml
price_table:
  replace_file: ./prices.json
```

**Stop the price download.** Sortie downloads the current price list at startup and once a day. On a network-restricted or audited deployment, set `price_table.fetch: false` or `SORTIE_PRICE_TABLE_FETCH=false`. The built-in table keeps pricing runs. See [the runtime download](/reference/workflow-config/#runtime-download) for the address, the refresh, and the copy kept beside the database.

**Turn the built-in table off.** Set `price_table.embedded: false` to price only what `token_rates`, the download, or your own table covers. With no `token_rates` entry and no `price_table.replace_file`, and the download off or not yet accepted, the dashboard shows token counts only.

Avoid keying an entry by an agent kind such as `claude-code` unless you want one rate for every model that kind runs. That entry turns off per-model pricing for the kind, and `sortie validate` warns about it with `token_rates.per_kind`. See the [`token_rates`](/reference/workflow-config/#token_rates) and [`price_table`](/reference/workflow-config/#price_table) references for the full schema and the reload rules.

**JSON API.** To see what one issue has spent and how much of its budget is left while a session runs, read the issue's running entry:

```sh
curl -s http://localhost:7678/api/v1/MT-649 | jq '.running | {
  used_tokens,
  tokens_left: (if .budget_tokens != null and .used_tokens != null then .budget_tokens - .used_tokens else null end),
  sessions_after_this: (if .budget_sessions != null and .used_sessions != null then .budget_sessions - .used_sessions - 1 else null end),
  used_tokens_complete,
  issue_estimated_cost_usd,
  issue_cost_status
}'
```

With `max_tokens: 500000` and `max_sessions: 5`, an issue whose third session is running (two have finished) might print:

```json
{
  "used_tokens": 112300,
  "tokens_left": 387700,
  "sessions_after_this": 2,
  "used_tokens_complete": true,
  "issue_estimated_cost_usd": 0.49872,
  "issue_cost_status": "estimated"
}
```

`used_tokens` counts the running session as it goes and leaves out cache reads, so it matches the figure the ceiling stops on. `sessions_after_this` is how many more sessions the issue can get once the running one ends: the session budget counts finished sessions only, so the running one is subtracted separately, and `0` or less means this is the last session. A limit that is not configured comes back as `null`, which the `if` turns into a `null` headroom instead of an error.

When `used_tokens_complete` is `false`, some of the issue's spend went unrecorded and `tokens_left` is an upper bound. The cost is `null` unless a rate prices the session's model, and `issue_cost_status` says why. An issue the ceiling already holds has no `running` entry; its `budget_exhausted` entry carries `used_tokens`, `budget_tokens`, and `stopped_in_flight`.

Replace `/api/v1/MT-649` with `/api/v1/state` and `.running` with `.running[]` to list every running issue. The [HTTP API reference](/reference/http-api/#get-apiv1state-system-state) defines each key and every `cost_status` value.

What the issue spent across its finished runs is under `history.totals` of the same endpoint, whether or not a session is running, and it is the only spend figure for an issue with no `running` entry:

```sh
curl -s http://localhost:7678/api/v1/MT-649 | jq '.history.totals'
```

When `tokens_complete` is `false`, some runs reported no usage or ended a turn before reporting its final usage, and the token figures are lower bounds. To see which runs cost the most, list them with `curl -s 'http://localhost:7678/api/v1/runs?issue=MT-649' | jq '.runs[] | {run_id, status, tokens: .tokens.total_tokens, estimated_cost_usd}'`. The [run history reference](/reference/http-api/#get-apiv1runs-run-history) defines the filters and every field.

**Prometheus.** The `sortie_tokens_total` counter tracks cumulative token consumption with a `type` label (`input`, `output`, `cache_read`, `cache_write`). Cache reads and writes are subsets of input, so don't sum every type. The `model` label splits the counter per model, and a run that used several models counts each model's tokens under that model. A PromQL query for hourly input token rate:

```promql
sum(rate(sortie_tokens_total{type="input"}[1h])) by (model)
```

The [metrics reference](/reference/prometheus-metrics/#the-model-label) defines which model a sample counts under. Set up alerting when token burn exceeds your budget threshold. The [Prometheus guide](/guides/monitor-with-prometheus/) walks through scrape config and alert rules.

**Logs.** Sortie's structured logs record what ran, not what it cost. The only records that carry a dollar figure are the ones the per-issue dollar ceiling writes; see [Money budget](/guides/monitor-with-logs/#money-budget).

Several carry a token count, gated on `agent.max_tokens` being set: `token budget exhausted, blocking re-dispatch` when an issue reaches the ceiling between sessions, `run stopped by token ceiling`, logged once at the run's exit when the ceiling's own cancellation is confirmed to be what ended it, and `token budget cannot be fully evaluated, allowing dispatch` when it has not but the sum is known to fall short of what the issue really spent. Each of those three carries `used_tokens`, the issue's measured cumulative tokens, and `budget_tokens`, the ceiling; the stop record adds `session_tokens`, what the session it cancelled had spent on its own.

When `agent.token_warning_percent` is also set, `token warning threshold reached` carries the same `used_tokens` and `budget_tokens` alongside `warning_tokens`, the configured threshold. Grep for `token budget`, `token ceiling`, and `token warning` to find them.

For the spend figures themselves, reach for `sortie stats` or the `sortie_tokens_total` counter above. The [logging guide](/guides/monitor-with-logs/) covers structured log access.

**`sortie stats`.** The `stats` subcommand reports what finished work actually cost, aggregated from the local database over a range you choose and broken down by outcome, coding agent, dispatch rule, and prompt template.

It is the only one of these surfaces that reports historical spend against completed runs rather than live or per-event figures, which makes it the one to reach for when the question is which dispatch rule or prompt template is burning the budget. It reads the cost recorded with each run, so runs that finished without a rate for their models show token counts and no dollars.

```sh
sortie stats --since 24h WORKFLOW.md
```

See the [`stats` subcommand reference](/reference/cli/#stats) for the flags, the range grammar, and every field it reports.

**The agent itself.** Mid-session, an agent can call the `cost_budget` tool to read cumulative spend and remaining budget for its issue. The reading trails the figure the orchestrator enforces by at most one throttled write of the running session's spend, two seconds, and never leads it, so an agent acting on it acts early rather than late. Prompt patterns live in [how to use agent tools in prompts](/guides/use-agent-tools-in-prompts/); the response schema is in the [agent extensions reference](/reference/agent-extensions/).

## What we configured

You now have these layers of cost protection:

1. A **per-turn hard cap** (adapter-specific) that stops the agent mid-session when spending exceeds the budget
2. A **session limit** that prevents infinite retries on stuck issues
3. A **per-issue token ceiling** that stops new sessions once measured cumulative spend crosses the budget
4. A **per-issue money ceiling** that does the same for the estimated cost in dollars
5. A **turn limit** that bounds orchestrator loop iterations per session
6. A **concurrency cap** that limits parallel spending
7. A **cost-efficient model and effort level** (adapter-specific) to reduce per-token spend

The per-turn cap, session limit, and turn limit are multiplicative; they set your worst-case dollar ceiling. The token ceiling is an absolute cap on top of the multiplication: an issue stops consuming new sessions at the budget no matter how the factors line up. The concurrency cap and model choice control burn rate. The hard ceilings fail safe: when one is hit, the agent stops. The token ceiling enforces against measured spend and announces, rather than hides, the sessions it could not measure. The money ceiling counts only what Sortie could price and says so when the figure is a lower bound.
