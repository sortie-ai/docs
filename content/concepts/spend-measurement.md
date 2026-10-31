---
title: "Spend Measurement"
description: "How Sortie measures what each coding agent run spent, where the figure comes from, when it is a lower bound, and which token and cost limits each run is held to."
author: Sortie AI
date: 2026-10-31
weight: 35
---
You set `agent.max_tokens` to 2,000,000 and `agent.max_cost_usd` to 25, and a week later the dashboard shows an issue at $18.40, marked as a lower bound. That number raises questions. Did the limits you set actually watch every run of that issue? And what does the mark say the figure leaves out? The answers depend on how the figure reached Sortie, and that differs by agent and by host. This page explains how Sortie measures a run's spend, what it records about the figure's origin, and which limits each kind of figure can trip.

Sortie never asks your provider for a bill. Every spend figure it shows is built from what the coding agent itself reports, on the host where the agent runs. That choice keeps Sortie a single binary with no billing credentials, but it means the figure is only as good as the agent's own reports, and Sortie has to say so whenever a report is missing or incomplete.

## Where a figure comes from

An agent reports spend through a live source, a records source, or both, and Sortie reads them into one ledger per session.

The **live source** is what the agent says while it works: the usage lines in its output stream, or the usage member of a protocol response. Claude Code and Codex report usage after each model request while the turn is still running. Copilot CLI, OpenCode, and every runtime on the `agent-client-protocol` kind report once, when the turn ends. That difference decides how quickly a limit can react, which the [limits section](#which-limits-reach-which-runs) below returns to.

The **records source** is what the agent writes to disk about itself: Claude Code's session journal, Codex's rollout file, Copilot CLI's session-state journal, OpenCode's session export, Gemini CLI's chat journal. The live stream is cheap and immediate, but it says nothing when a turn is cancelled, killed, or cut off before its usage line. The records survive that. Sortie reads them at the end of a turn the live source left unsettled, and at the start of a resumed session, so the requests that session already holds count as history and never as this run's spend. When the live source settled a turn but named no model, as on the `agent-client-protocol` kind, the records only split that settled amount by the model that served each request. That split is what lets a run under a model selector such as `auto` be priced per model.

Each model request counts once, whichever source reported it. The sources check each other rather than add up.

### Runs on SSH worker hosts

A run on a [worker host](/guides/scale-agents-with-ssh/) reports its live source over the same standard streams the session already uses, so nothing changes there. The records live on the worker, not on the orchestrator host. Sortie reads them on the worker through a read-only command built from the session's own SSH launch, with the runtime's home directory resolved by the worker's shell rather than copied from the orchestrator's environment. The same size and line limits apply as on a local read.

The consequence is that a runtime is measured over SSH exactly when it is measured locally. When the remote read fails, the connection drops, or the read outlasts the agent read timeout, the turn keeps whatever the live source settled and is marked a lower bound. It never reads as zero.

## Completeness and provenance

Every finished run records how far its token figure reaches:

- `complete`: every turn that reached the model is covered by a figure.
- `lower_bound`: a figure arrived, but at least one turn spent tokens that no source counted. The true spend is at least this much and possibly more.
- `unmeasured`: no token figure arrived at all. The run may have spent a great deal or nothing; Sortie cannot tell, and it never writes zero for it.

The run also records its **provenance**: the sources and strategies that settled its figure, written as pairs such as `output:live` (the agent's own output stream), `protocol:live` (protocol messages), and `journal:records` (records read from disk). A Claude Code run whose last turn was killed reads `output:live,journal:records`: the stream settled the early turns and the journal settled the one the stream missed. An unmeasured run carries a reason instead: it reported amounts but no tokens, it ended before any usage report, or it succeeded without sending any usage.

A lower bound is the honest answer to a common situation, not a defect. A turn killed by `agent.turn_timeout_ms` while a request is streaming has spent tokens on that request, and if the agent writes its record only when the request completes, no source ever saw it. Sortie can say "this much, and more" or it can guess. It says "this much, and more".

## From tokens to dollars

A token figure becomes a cost through Sortie's price layers: your `token_rates` entries first, then the price table Sortie downloads, then the table compiled into the binary (see [`token_rates`](/reference/workflow-config/#token_rates)). Each model's share of a run is priced on its own, so a run that switched models mid-session is priced at each model's rate.

Some models appear in no table: a fresh release, a private deployment, a router alias. When a model's share has no rate at all and the agent itself reported a US dollar amount for that model, Sortie uses the agent's amount for that share and records that it did. Claude Code reports such an amount every turn, and OpenCode writes one per request in its session export. A model a table does price always keeps the table's price, even when the agent also reported a dollar amount, so the figure stays comparable across agents. A share with neither a rate nor a reported amount stays unpriced, and the cost becomes a lower bound.

The fallback needs tokens. A run that reported a dollar amount and no token figure is unmeasured, and its dollar amount is kept with the run but never becomes its cost.

### Why credits stay credits

Some agents count spend in a unit of their own. Copilot CLI records premium requests and AI credits for each request. Kiro CLI reports credits for each turn. A runtime on the `agent-client-protocol` kind can report a running session cost in whatever unit it names.

Sortie records these **vendor amounts** with the run in the unit the agent named and never converts them to dollars or tokens. A credit is worth whatever your plan says it is this month, and a premium request is weighted by a multiplier the vendor sets per model and can change at will. Any exchange rate Sortie applied would be a guess presented as a measurement, and a money limit enforced on a guess is worse than one that says it cannot see the run. The same holds for a currency other than US dollars: a session cost reported in euros stays in euros. The dashboard and the JSON API show vendor amounts summed per unit, and no token or money limit counts them.

## What each agent reports

The table below states, for each agent kind and each runtime on the `agent-client-protocol` kind, what a run carries locally and on an SSH worker host. The protocol kind picks the runtime from the name the agent gives at startup, or from the configured command when the agent gives none. A runtime it does not recognize is measured by the protocol's standard usage fields.

| Agent kind or runtime | Token figure | When it arrives | Records read on disk | On an SSH worker | Also recorded |
|---|---|---|---|---|---|
| `claude-code` | Measured | During each turn | Session journal | Measured, journal read on the worker | US dollar amount per turn |
| `codex` | Measured, prompt-cache writes included | During each turn | Rollout file | Measured, rollout file read on the worker | |
| `copilot-cli` | Measured | When a turn ends | Session-state journal | Measured, journal read on the worker | Premium requests and AI credits |
| `opencode` | Measured, subagent requests included | When a turn ends | Session export | Measured, export run on the worker | US dollar amount per request |
| `agent-client-protocol` with Copilot CLI | Measured | When a turn ends | Session-state journal | Measured, journal read on the worker | Premium requests and AI credits |
| `agent-client-protocol` with OpenCode | Measured, subagent requests included | When a turn ends | Session export | Measured, export run on the worker | US dollar amount per request |
| `agent-client-protocol` with Gemini CLI | Measured on a model you name; a lower bound when Gemini CLI picks the model | When a turn ends | Chat journal | Measured, journal read on the worker | |
| `agent-client-protocol` with Kiro CLI | Unmeasured | | | Unmeasured | Credits per turn |
| `agent-client-protocol` with any other runtime | Always a lower bound | When a turn ends | | Same as locally | The session cost a runtime reports, in its own unit |

Some rows need more than a table cell gives them.

Copilot CLI writes its journal late, so a turn killed outright can end with no record of a request that already completed. That turn ends unmeasured or a lower bound, never zero.

Gemini CLI, when its model is `auto` or left unset, makes a request to choose the model that no source records, so every turn of such a session is a lower bound. Requests it makes outside the conversation, such as web search, web fetch, history compression, and subagents, are in no source either, and a turn that made them still reads `complete`. If a Gemini CLI run looks cheap for the work it did, this is the first place to look.

The figure for an unrecognized runtime is always a lower bound because the protocol has not settled whether its usage counts are per turn or cumulative. Sortie reads them the way that can only undercount.

The per-runtime mechanics live on the reference pages: [Claude Code](/reference/adapter-claude-code/), [Codex](/reference/adapter-codex/), [Copilot CLI](/reference/adapter-copilot/), [OpenCode](/reference/adapter-opencode/), the [Agent Client Protocol kind](/reference/adapter-agent-client-protocol/), [Gemini CLI on it](/reference/agent-client-protocol-gemini/), and [Kiro CLI on it](/reference/agent-client-protocol-kiro/).

## Which limits reach which runs

Sortie's spend limits all read the same figures, so what a limit can do for a run follows from which kind of figure that run carries.

| The run carries | `agent.max_tokens` | `agent.max_cost_usd` | `agent.max_daily_cost_usd`, `agent.max_weekly_cost_usd`, `agent.max_monthly_cost_usd` | What else bounds it |
|---|---|---|---|---|
| A token figure, complete or a lower bound | Counts it, cache reads left out, and stops the run in flight at the first figure at or past the limit | Counts its cost from the price layers or the agent's dollar amount; a share nothing prices is left out and makes the issue's cost a lower bound | Count its cost in the window it ended in, and the live estimate while it runs; hold further dispatch once reached, without stopping running sessions | `agent.max_sessions`, `agent.max_turns`, `agent.turn_timeout_ms` |
| Vendor amounts only, such as Kiro CLI credits | Counts nothing; the run logs `run reported no token usage, token ceiling could not bound it` when it ends | Counts nothing; the issue's cost becomes a lower bound and dispatch continues with a warning | Count nothing; the window's spend becomes a lower bound and dispatch continues with a warning | The agent's own plan limit, which Sortie shows and waits out; `agent.max_sessions`, `agent.max_turns`, `agent.turn_timeout_ms` |
| No figure at all | Same as vendor amounts only | Same as vendor amounts only | Same as vendor amounts only | `agent.max_sessions`, `agent.max_turns`, `agent.turn_timeout_ms` |

A limit cannot react faster than figures arrive. For Claude Code and Codex, a run passes a limit by at most about one model request. For every other row of the agent table, a run can pass it by a whole turn, because the figure that crosses the limit is the one the turn ends with. Leave headroom below the amount you cannot afford to exceed.

A run with vendor amounts or no figure does not count as zero against the money limits. It makes them a lower bound, and Sortie keeps dispatching while that lower bound sits below the limit, with a warning in the log, rather than hold work on an amount it cannot see. A limit that held every issue touched by an unmeasured run would stop all Kiro CLI work on the first run; one that let such runs through silently would look enforced when it is not. The warning is the middle path.

For Kiro CLI the bound that works is the account's credit limit itself. Sortie reads the account's credit usage after each turn, shows it beside the other plan limits on the dashboard, and when the account runs out, waits for the limit to reset instead of retrying. [Control costs](/guides/control-costs/) walks through setting each limit, including for runs your token and money limits cannot reach.

## Reading a total marked as a lower bound

A total over many runs inherits the weakest of them. Add one unmeasured Kiro CLI run, or one Gemini CLI run on `auto`, to a day of complete Claude Code runs, and the day's tokens and cost become lower bounds. Sortie marks such a total instead of presenting it as whole, and states which runs it leaves out.

Read a lower bound as a floor. If an issue shows $18.40, marked as a lower bound, against a $25 limit, the issue has spent $18.40 or more, the limit has not stopped it, and the gap is whatever its unmeasured runs and uncounted turns spent. The vendor amounts listed next to the total, and the count of runs not measured, tell you how large that gap can plausibly be. A total with no mark is complete for every run it covers.

Each surface carries the same information in its own form:

- The [dashboard](/reference/dashboard/#how-figures-are-written) marks a lower-bound figure, writes N/A with the reason where a run has no figure, and shows a run's vendor amounts where it has no dollar cost.
- The [JSON API](/reference/http-api/#get-apiv1runs-run-history) serves each run's completeness, provenance, and vendor amounts, the part of a total's cost taken from the agent's own dollar amount, and lower-bound marks on the totals in [run statistics](/reference/http-api/#get-apiv1stats-run-statistics).
- [`sortie stats`](/reference/cli/#stats) labels a lower-bound tokens or cost line, names which figures of each group are lower bounds, and groups runs by usage provenance.

For what Sortie keeps on disk about each run and why it survives a restart, see [Persistence](/concepts/persistence/).
