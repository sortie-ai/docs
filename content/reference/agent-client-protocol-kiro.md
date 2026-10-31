---
title: "Kiro CLI on the Agent Client Protocol"
description: "Reference for running Kiro CLI under Sortie in ACP mode: the launch command, which login delivers Sortie's tools, the single trust-and-posture switch, model pinning, how a run's spend is recorded in credits, and the runtime's limits on token accounting and session close."
author: Sortie AI
date: 2026-09-09
weight: 147
url: /reference/agent-client-protocol-kiro/
---
[Kiro CLI](https://kiro.dev/docs/cli/) runs under Sortie in ACP mode: the generic [`agent-client-protocol`](/reference/adapter-agent-client-protocol/) kind, where `agent.command` names the `kiro-cli` binary together with `acp`, the subcommand that puts it into protocol mode. To connect Kiro CLI step by step, see [how to run Kiro CLI in ACP mode](/guides/run-kiro-cli-in-acp-mode/).

Sample workflow: [`examples/WORKFLOW.agent-client-protocol.kiro.md`](https://github.com/sortie-ai/sortie/blob/main/examples/WORKFLOW.agent-client-protocol.kiro.md).

See also: [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/) for the transport-level mechanism this page assumes, [environment variables](/reference/environment/#agent-runtime-variables) for how a runtime's credential reaches its subprocess, [error reference](/reference/errors/#agent-errors) for all agent error kinds.

---

## Installation and configuration

```yaml
agent:
  kind: agent-client-protocol
  command: kiro-cli acp -a
```

The `acp` subcommand does not appear in `kiro-cli --help`. It is listed under `kiro-cli --help-all` only, which is worth knowing before concluding a build does not carry it.

This kind has no model configuration key. The sample pins no model, so an unpinned run resolves whatever the credential defaults to, and a qualification measurement taken against one pinned model does not transfer to another.

`--model <id>` on the `acp` entry point takes effect, setting the model for the session the run starts. To pin one, add `--model <id>` to `agent.command`, and read the account's own model set off `kiro-cli chat --list-models -f json`, which the runtime serves from the account's own backend rather than from the binary. A pinned model also lets the [credential-verification request](/reference/adapter-agent-client-protocol/#the-credential-verification-request) run under an agent with no tools; without `--model`, that request carries Kiro CLI's full context.

---

## Which login delivers Sortie's tools

This is the single most important fact on this page. Authenticating with `KIRO_API_KEY` starts sessions, runs turns, and continues sessions correctly, and silently carries none of Sortie's tools.

The runtime asks its own backend for a governance profile before enabling MCP at all; that request fails for the one API key this route was measured with, so a session authenticated that way starts and runs normally while every declared tool server is dropped with no signal anywhere Sortie can see, on the wire or in Sortie's own output.

Whether it fails for every API key, or only for keys on some plans, is unestablished. A stored device login does not hit that check: under a device login, the same request, model, and posture deliver and call the tool.

A deployment that needs Sortie's own tools has to authenticate with a stored device login, on the machine that runs Sortie, rather than with `KIRO_API_KEY`.

| Credential | Sessions and turns | Sortie's tools |
|---|---|---|
| `KIRO_API_KEY` | Work correctly | Absent; every declared server is dropped before any tool is offered, and Sortie declares a gap after `read_timeout_ms` |
| Stored device login | Work correctly | Delivered and callable, subject to the trust-and-posture switch below |

The runtime's own log is the only place that states the cause when tools go missing: it records `Failed to get governance config from API - MCP disabled, web tools disabled`, and a vendor-namespaced `governance_disabled` notification also reaches the wire. The runtime advertises HTTP MCP support, so Sortie sees only that it never connects to its tool server. Session start waits [`agent.read_timeout_ms`](/reference/workflow-config/#agent) (default `5000`) for that first connection, then declares the `no_connection` gap: the log line `declared tool server gap for session` appears, the session emits the capability-gap notice, and the first-turn prompt carries no tool advertisement. Neither the log nor the notice names the credential as the cause.

### Confirming which credential a run will actually use

The [credential-verification step](/reference/workflow-config/#credential-verification) before a working session proves the credential answers a request at all, but it says nothing about which credential answered or whether that credential can reach Sortie's tools; see [authentication](/reference/adapter-agent-client-protocol/#authentication). Confirm the credential yourself before an unattended run, not after one silently loses its tools:

```sh
kiro-cli whoami
```

This reports the authenticated account. On a machine carrying no credential at all it prints `Not logged in` and exits with status 1, and a launch of `kiro-cli acp` there exits with status 1 before the handshake completes, printing `error: You are not logged in, please log in with kiro-cli login` on standard error. Checking ahead of time catches a missing credential before an unattended run.

---

## The trust-and-posture switch

Where some runtimes on this route spell workspace trust and tool-approval posture as two separate launch switches, Kiro CLI spells both with one: `-a` (`--trust-all-tools`). It auto-approves every tool permission request, so dropping it restores asking for every tool, Sortie's and the runtime's own, and an unattended run has nobody to answer that ask.

`-a` is required for a working unattended run, not optional hardening, and it is not separable into a trust-only or a posture-only grant the way a runtime with two distinct switches allows.

`--trust-tools=<names>` narrows that all-or-nothing grant to an explicit set. A tool a declared server offers is named there as `@<server>/<tool>`, the runtime's own qualified form, which is also what the runtime prints in a tool-call's own title. Sortie does not manage this list: a set that omits a tool the prompt will actually attempt puts the run back into an approval wait an unattended run cannot answer.

Run this agent inside a hardened sandbox regardless of which posture you choose. Neither switch replaces container-level isolation.

---

## Usage limits

When each turn ends, Sortie asks Kiro CLI for the credits used against the account's plan, and reports them to the dashboard and to `rate_limits` in [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state). The request goes over the session's own connection with no agent text, and Sortie contacts no host for it. The mechanism shared with other runtimes is under [usage limits](/reference/adapter-agent-client-protocol/#usage-limits) on the kind's page.

Each usage entry that has a limit is one limit, labelled `Monthly` followed by the entry's display name and `limit`. The amount is reported in `credits`, used against the limit, and the share used is derived from it. The reset time is the start of the billing-cycle reset date, in UTC, because Kiro CLI states a date with no time. An entry without a limit is not reported, and the limits carry no status. The pulls stop for the session when Kiro CLI answers neither of the two usage requests it is asked.

## Spend in credits

Kiro CLI reports what a turn spent only in credits, the unit its vendor bills in, and Sortie records that amount with the run in the unit `credits`. Sortie reads each turn's credits from the report Kiro CLI sends as the turn completes, on the default engine and under `--agent-engine v3` alike, and holds them on the run as a whole rather than on a model. Local launches and launches on SSH worker hosts are recorded the same way.

Sortie counts only a credit report that arrives during a turn. The reports of earlier turns that a continued session replays when it loads therefore add nothing, and neither do credits reported between turns, such as for a context compaction. A cancelled or failed turn reports no credits, so when such a turn reached the model, the run's credits are a lower bound. So are credits whose report carries an amount Sortie cannot read.

Sortie never converts credits into tokens or US dollars. A Kiro CLI run therefore has no token figure and no dollar cost: it is recorded unmeasured, with `unmeasured_cause` set to `amounts_only` and `unmeasured_units` listing `credits`, and a token or cost total that includes it is a lower bound. [How Sortie measures spend](/concepts/spend-measurement/) explains provenance and lower bounds.

| Surface | What a Kiro CLI run shows |
|---|---|
| [`GET /api/v1/runs`](/reference/http-api/#get-apiv1runs-run-history) | A `vendor_amounts` entry with `unit` `credits`, an empty `model`, the `amount`, and `lower_bound`. |
| [`GET /api/v1/runs/issues`](/reference/http-api/#get-apiv1runsissues-run-history-by-issue) | The issue's credits over all of its runs in `totals.vendor_amounts`. |
| [Dashboard session view](/reference/dashboard/#session-view) | For a finished run, the credits on the **Agent reported** row, and **Tokens** as "N/A", whose hover says the agent reports its spend only in credits. |
| [Dashboard history](/reference/dashboard/#history) | The credits in the run's **Est. cost** cell, shortened to `cr`, with the full amount on hover. The column is shown only while a rate source is available: a price table is in force, which is the default, or [`token_rates`](/reference/workflow-config/#token_rates) holds an entry. |
| [`sortie stats`](/reference/cli/#stats) | No credit amount. The run counts among the runs whose token and cost figures are skipped, and `--format json` sets `unmeasured_cause` to `amounts_only` with `credits` in `unmeasured_units`. |

These credits are separate from the plan's credits under [usage limits](#usage-limits): the limit is the account's use against its plan, and the run's credits are what that run's own turns spent.

No token or dollar ceiling counts credits, so `agent.max_tokens` and the dollar caps never reach a Kiro CLI run's spend. Which ceilings still bound such a run is set out in [How Sortie measures spend](/concepts/spend-measurement/), and what to configure in [how to control costs](/guides/control-costs/).

---

## Limitations

### Token accounting has no source on this route

No per-turn token count reaches Sortie on this route: the prompt result carries no token usage, and the token counts in the runtime's own session file hold zero whatever the turn cost, so Sortie reads neither. A run is recorded with its [credits](#spend-in-credits) and no token figure. `agent.max_tokens` therefore never takes effect on this route, and `agent.turn_timeout_ms` and `agent.stall_timeout_ms` are what bound a turn instead.

### Sessions are not closed through the protocol

This runtime's `initialize` handshake advertises an empty `sessionCapabilities` object, so `session/close` is never selected against it: a session here always ends through process termination, described in the [kind page's process shutdown section](/reference/adapter-agent-client-protocol/#process-shutdown). The short-lived [credential-verification](/reference/workflow-config/#credential-verification) session a worker attempt opens before the working one ends the same way, with nothing to call back and remove it; see [the kind page's session close section](/reference/adapter-agent-client-protocol/#session-close) for what that leaves behind on a runtime, this one included, that advertises neither method.

### The debug log records the tool server's bearer

Sortie hands this runtime its tool server as an HTTP entry whose `Authorization` header carries a per-session bearer. At its debug log level the runtime writes that header to its own log under its runtime directory. The bearer stops working when the session ends, so a log read later holds nothing usable, but treat the log of a running session as sensitive.

### A large vendor-namespaced surface exists and is safely ignored

The runtime announces available commands, subagent lists, MCP server initialization, and per-turn metadata under its own method prefix. These arrive as notifications rather than requests, so nothing answers them and nothing depends on them; Sortie records them as unrecognized and moves on. An unfamiliar line naming one of these methods in a debug log is expected, not a sign that something needs handling.

### A refusal disposition is unobserved

Sortie maps the protocol's `refusal` stop reason to a failed turn under the `turn_refused` error kind, as [the kind page's turn disposition table](/reference/adapter-agent-client-protocol/#turn-disposition) states. Whether this runtime produces that stop reason at all is unestablished: the measurement behind this page did not observe one.

### Live qualification on Windows is unobserved

Every measurement behind this page's claims was taken on a non-Windows host. Whether this runtime's behavior on this route differs on Windows is unestablished.

---

## Related pages

- [Agent Client Protocol adapter reference](/reference/adapter-agent-client-protocol/): the runtime-neutral transport this page assumes
- [How to run Kiro CLI in ACP mode](/guides/run-kiro-cli-in-acp-mode/): connecting Kiro CLI, choosing the login, reaching remote workers over SSH, and verifying the first run
- [Gemini CLI on the Agent Client Protocol](/reference/agent-client-protocol-gemini/): a second runtime on the same route, with a different credential trade-off
- [WORKFLOW.md configuration reference](/reference/workflow-config/): full `agent` schema
- [Environment variables reference](/reference/environment/): how a runtime's own credential reaches its subprocess
- [Error reference](/reference/errors/#agent-errors): all agent error kinds with retry behavior
