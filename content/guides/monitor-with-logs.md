---
title: "How to Monitor with Logs"
linkTitle: "Monitor with Logs"
description: "Read, filter, and aggregate Sortie's structured logs in text or JSON format. Grep and jq patterns, lifecycle messages, log verbosity, and log persistence."
author: Sortie AI
date: 2026-03-26
weight: 160
url: /guides/monitor-with-logs/
---
Sortie emits structured logs to stderr. The default format is `key=value` text; an optional `json` mode produces newline-delimited JSON for log aggregation systems. Logs are always on — no configuration needed. They are the first place to look when something goes wrong.

> [!NOTE]
> Sortie has no built-in log file or rotation option. Logs go to stderr only — file retention and rotation are the responsibility of your runtime environment. Use journald on systemd hosts, a Docker logging driver in containers, or a process supervisor such as supervisord elsewhere.

## Prerequisites

- Sortie installed and running

That's it. Logs work with zero configuration.

## Understand the log format

Sortie supports two log formats: **text** (default) and **JSON**.

### Text format (default)

Sortie uses `slog.TextHandler`. Every line is a flat `key=value` record:

```
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="tick completed" candidates=2 dispatched=2 running=2 retrying=0
```

### JSON format

When `--log-format json` is active (or `logging.format: json` in the workflow file), each line is a self-contained JSON object:

```json
{"time":"2026-03-26T14:30:01.305+00:00","level":"INFO","msg":"tick completed","candidates":2,"dispatched":2,"running":2,"retrying":0}
```

JSON format is designed for log aggregation systems (Loki, Datadog, CloudWatch, ELK) that ingest newline-delimited JSON. See [switch to JSON format](#switch-to-json-format) below.

### Common fields

Three structural fields appear on every line in both formats:

- `time` — UTC timestamp
- `level` — `INFO`, `WARN`, `ERROR`, or `DEBUG`
- `msg` — human-readable message

Context fields appear on all issue-related lines, added automatically by the logging subsystem:

- `issue_id` — tracker-internal ID (e.g., `abc123`)
- `issue_identifier` — human-readable ticket key (e.g., `MT-649`)
- `session_id` — agent session identifier (present once a session starts)

The one rule you need to remember: **WARN means Sortie is handling it. ERROR means you need to.**

WARN lines indicate automatic recovery — a retry is scheduled, a transient failure is being worked around. ERROR lines mean Sortie gave up and needs operator attention. If you grep for nothing else, grep for `level=ERROR`.

## Control log verbosity

By default Sortie logs at `INFO` level. Use the `--log-level` flag to change it:

```bash
# See debug-level detail: poll decisions, state transitions, adapter calls
sortie --log-level debug ./WORKFLOW.md

# Reduce noise in production — only warnings and errors
sortie --log-level warn ./WORKFLOW.md
```

Accepted values: `debug`, `info`, `warn`, `error`. The flag applies before the workflow file is loaded, so startup messages reflect the requested level immediately.

Alternatively, set the level in the workflow file:

```yaml
logging:
  level: debug
```

The CLI flag takes precedence when both are set. Changing `logging.level` in the workflow file requires a restart — it is not picked up by dynamic reload.

## Key log messages to watch

Here are the log messages that matter most, grouped by lifecycle phase.

### Poll cycle

```
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="tick completed" candidates=2 dispatched=2 running=2 retrying=0
```

This is the heartbeat. It fires every poll interval and tells you how many issues were found (`candidates`), how many were dispatched this tick (`dispatched`), how many agents are active (`running`), and how many issues are awaiting retry (`retrying`). When `candidates=0 dispatched=0`, Sortie is idle.

### Workspace preparation

```
time=2026-03-26T14:30:02.150+00:00 level=INFO msg="workspace prepared" issue_id=abc123 issue_identifier=MT-649 workspace=/tmp/sortie_workspaces/MT-649
```

Sortie created (or reused) a workspace directory and ran any configured hooks. The `workspace` field shows the absolute path.

### Agent session

```
time=2026-03-26T14:30:03.420+00:00 level=INFO msg="agent session started" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001
time=2026-03-26T14:30:03.500+00:00 level=INFO msg="turn started" issue_id=abc123 issue_identifier=MT-649 turn_number=1 max_turns=5
time=2026-03-26T14:31:45.800+00:00 level=INFO msg="turn completed" issue_id=abc123 issue_identifier=MT-649 turn_number=1 max_turns=5
```

Each issue gets a session with one or more turns. `turn_number` and `max_turns` show where the agent is in its work budget.

### Tool calls

```
time=2026-03-26T14:31:12.300+00:00 level=INFO msg="tool call completed" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 tool=tracker_api duration_ms=145 result=success
time=2026-03-26T14:31:13.100+00:00 level=INFO msg="tool call completed" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 tool=tracker_api duration_ms=89 result=error error="tracker_auth_error: invalid API key"
```

Every tool invocation gets a log line with the tool name, wall-clock duration, and outcome. The `error` field only appears when `result=error`.

### Worker exit

```
time=2026-03-26T14:35:20.100+00:00 level=INFO msg="worker exiting" issue_id=abc123 issue_identifier=MT-649 exit_kind=normal turns_completed=5
```

The worker finished its loop. `exit_kind=normal` means the agent completed its turns without error.

### Workspace sweep

```
time=2026-03-26T14:30:02.100+00:00 level=INFO msg="sweep: removed expired workspace" workspace_key=MT-512 last_activity=2026-02-14T09:12:44Z age_days=40
time=2026-03-26T14:30:02.140+00:00 level=INFO msg="sweep: pass complete" candidates=7 excluded_running=1 excluded_retry=0 excluded_reaction=1 removed_terminal=2 removed_age=1 retained_in_window=1 retained_no_activity=1 retained_not_evaluated=0 failed=0 retention_days=30 age_pass=on tracker_read=ok
```

`sweep: pass complete` is emitted once per sweep pass, whether or not anything was removed. That is the point of it: a bound that removes nothing looks identical to a bound that is switched off, so the record reports why every candidate survived rather than only what it deleted.

Read it as three questions.

**Is the age bound on at all?** `age_pass` and `retention_days` answer that. `age_pass=on` means the window shown in `retention_days` was evaluated. `age_pass=off` means `retention_days` is unset or below the floor of 30, so no age evaluation ran. `age_pass=unavailable` means the pass could not run: the persistence store was absent, or the run-history query failed.

**Did the tracker answer this pass?** `tracker_read=ok` or `tracker_read=failed`. On a failed read nothing is removed as terminal, but the age pass still evaluates, because it reads no tracker state.

**Why did each candidate survive?** The `excluded_*` and `retained_*` counters, one reason each:

- `excluded_running`: a worker is processing that issue. Not a fault.
- `excluded_retry`: a retry is scheduled for that issue. Not a fault.
- `excluded_reaction`: a pending reaction whose kind carries an expiry pins the workspace. It resolves itself within 30 minutes. Not a fault.
- `retained_in_window`: the workspace's latest recorded activity is newer than `retention_days`. Not a fault; the bound is working as configured.
- `retained_no_activity`: no run completion and no recorded push exist for that key, so there is no anchor to measure age from and the workspace is kept. This is the reason operators are least likely to guess. It covers a run that never completed and any directory Sortie did not create.
- `retained_not_evaluated`: the age pass did not evaluate these candidates. Read `age_pass` for the reason.
- `failed`: a removal or a path resolution failed, under either mechanism. Look for the adjacent WARN line naming the key.

The nine counters after `candidates` partition the candidate set, so they always sum to `candidates`. In the pass above, `1 + 0 + 1 + 2 + 1 + 1 + 1 + 0 + 0 = 7`. `removed_terminal` counts the other mechanism, workspaces removed because the tracker reported their issues in a terminal state; it runs first on the same pass, so `removed_age` never counts a workspace the terminal check would have taken.

Each age removal also emits `sweep: removed expired workspace`, carrying the `workspace_key` that was removed, `last_activity` (the RFC3339 anchor that was measured), and `age_days`. Configure the window itself through [`workspace.retention_days`](/reference/workflow-config/#workspace).

### Handoff transition

```
time=2026-03-26T14:35:21.500+00:00 level=INFO msg="handoff transition succeeded, releasing claim" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 handoff_state="In Review"
```

Sortie transitioned the issue to the configured `handoff_state` in the tracker and released its claim. Sortie is done with the issue; the issue itself is now waiting on a person.

If the issue had already reached a terminal state by the time the worker exited, you get this instead and no transition happens:

```
time=2026-03-26T14:35:21.480+00:00 level=INFO msg="handoff suppressed for terminal issue" issue_id=abc123 issue_identifier=MT-649 state=Done state_source=verified handoff_state="In Review"
```

This is the line to look for when an issue you closed mid-run did not get overwritten, and the line to look for when you expected a handoff and did not get one. `state` is the state Sortie saw, and `state_source` tells you where it saw it: `reconcile` from a reconciliation pass, `worker` from the worker's own per-turn refresh, `snapshot` from the state recorded at dispatch, or `verified` from the extra read Sortie performs immediately before the write. The claim is released and no retry is scheduled. Each of these also increments `sortie_handoff_transitions_total` with `result="skipped"`.

That extra read can fail on its own, and Sortie proceeds with the handoff rather than assuming the issue is closed:

```
time=2026-03-26T14:35:21.470+00:00 level=WARN msg="handoff verification read failed, proceeding with handoff" issue_id=abc123 issue_identifier=MT-649 error="tracker request timeout" state_source=worker
```

### Tracker comments

```
time=2026-03-26T14:32:00.200+00:00 level=INFO msg="dispatch comment posted" issue_id=abc123 issue_identifier=MT-649
time=2026-03-26T14:35:21.600+00:00 level=INFO msg="tracker comment posted" issue_id=abc123 issue_identifier=MT-649 lifecycle=completion
```

When [`tracker.comments`](/reference/workflow-config/) flags are enabled, Sortie posts audit comments on the tracker issue at dispatch, completion, or failure. INFO means the comment was delivered. If the comment API call fails:

```
time=2026-03-26T14:35:21.600+00:00 level=WARN msg="tracker comment failed" issue_id=abc123 issue_identifier=MT-649 lifecycle=completion error="tracker: tracker_auth_error: POST /rest/api/3/issue/abc123/comment: 403"
```

WARN — the comment failed but the session lifecycle is unaffected. Check API token permissions if persistent.

### Errors and retries

```
time=2026-03-26T14:35:22.000+00:00 level=WARN msg="worker run failed, scheduling retry" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 error="agent: turn_timeout: context deadline exceeded" next_attempt=2 delay_ms=20000
```

WARN with `scheduling retry` — Sortie is recovering automatically. The `next_attempt` and `delay_ms` fields tell you when the retry fires.

```
time=2026-03-26T14:35:22.500+00:00 level=ERROR msg="worker run failed, non-retryable, releasing claim" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 error="agent: agent_not_found: claude not found in PATH"
```

ERROR — Sortie gave up. This issue won't be retried. Fix the underlying problem (in this case, install the agent binary) and Sortie will pick the issue up on the next poll.

### Token budget exhaustion

```
time=2026-03-26T14:35:22.000+00:00 level=WARN msg="token budget exhausted, blocking re-dispatch" issue_id=abc123 issue_identifier=MT-649 reason=token_budget used_tokens=52000 budget_tokens=50000 used_sessions=3 budget_sessions=5
```

This fires when `agent.max_tokens` is set and an issue's cumulative tokens across every completed session reach the configured ceiling. The check runs on the pre-dispatch path, before a scheduled retry fires, so it blocks the next dispatch rather than interrupting a session already running. `used_tokens` is the issue's running total; `budget_tokens` is the ceiling it hit. `used_sessions` and `budget_sessions` report the same comparison for the session-count budget, in case the issue is close to both ceilings at once.

A session whose coding agent reported no token usage at all is recorded as unmeasured and contributes nothing to `used_tokens`. When an issue is still under the ceiling but some of its sessions went unmeasured, Sortie says so and dispatches anyway:

```
time=2026-03-26T14:35:22.000+00:00 level=WARN msg="token budget cannot be fully evaluated, allowing dispatch" issue_id=abc123 issue_identifier=MT-649 used_tokens=31000 budget_tokens=50000 unmeasured_sessions=2
```

`unmeasured_sessions` is how many of the issue's recorded sessions carry no spend figure, so `used_tokens` is a lower bound rather than the whole story. The ceiling message above takes precedence: an issue whose measured total already reaches the ceiling is blocked and logs that instead.

If Sortie can't read the token total at all, it fails open rather than blocking a retry on a persistence error:

```
time=2026-03-26T14:35:21.900+00:00 level=WARN msg="token budget check failed, proceeding with dispatch" issue_id=abc123 issue_identifier=MT-649 error="database is locked"
```

WARN in all three cases, but the outcome differs: dispatch proceeds for the latter two, where the ceiling message blocks it.

### Dispatch preflight failures

```
time=2026-03-26T14:30:01.300+00:00 level=ERROR msg="dispatch preflight failed" error="dispatch preflight failed: unknown tracker adapter kind \"jra\"; registered: [file, gitea, github, gitlab, jira, linear]"
```

This fires before any work is dispatched. It means your workflow configuration is invalid. Sortie can't dispatch anything until you fix the config and restart. Here a typo in `tracker.kind` is the cause, and the bracketed list is every kind the binary actually has registered, so it names the correction. Your own list grows as adapters are added.

## Common grep patterns

These commands work against the text log format. For JSON logs, see [JSON log filtering with jq](#json-log-filtering-with-jq) below.

Follow a specific issue across its entire lifecycle:

```bash
grep 'issue_identifier=MT-649' sortie.log
```

Find all errors that need your attention:

```bash
grep 'level=ERROR' sortie.log
```

Find retries (to see which issues are struggling):

```bash
grep 'scheduling retry' sortie.log
```

Find issues blocked by a token budget:

```bash
grep 'token budget exhausted' sortie.log
```

Watch dispatches in real time:

```bash
tail -f sortie.log | grep 'tick completed'
```

Find tool call failures:

```bash
grep 'tool call completed.*result=error' sortie.log
```

Follow a specific agent session across turns and tool calls:

```bash
grep 'session_id=session-abc-001' sortie.log
```

Review every workspace sweep pass, including the ones that removed nothing:

```bash
grep 'sweep: pass complete' sortie.log
```

Find workspaces removed by the age bound:

```bash
grep 'sweep: removed expired workspace' sortie.log
```

## Switch to JSON format

For deployments that route logs to an aggregation system, switch to JSON output:

```bash
sortie --log-format json ./WORKFLOW.md
```

Or set it in the workflow file and leave the CLI unchanged:

```yaml
logging:
  format: json
```

The CLI flag takes precedence when both are set. Both formats carry the same structured fields — only the serialization differs.

## JSON log filtering with jq

When running with `--log-format json`, use `jq` instead of `grep` for precise field-level filtering.

Follow a specific issue:

```bash
jq 'select(.issue_identifier == "MT-649")' sortie.log
```

Find all errors:

```bash
jq 'select(.level == "ERROR")' sortie.log
```

Find retries with their delay:

```bash
jq 'select(.msg | contains("scheduling retry")) | {issue: .issue_identifier, next_attempt, delay_ms}' sortie.log
```

Find issues blocked by a token budget:

```bash
jq 'select(.msg | contains("token budget exhausted")) | {issue: .issue_identifier, used_tokens, budget_tokens}' sortie.log
```

Watch dispatches in real time:

```bash
tail -f sortie.log | jq 'select(.msg == "tick completed")'
```

Find tool call failures with duration:

```bash
jq 'select(.msg == "tool call completed" and .result == "error") | {tool, error, duration_ms}' sortie.log
```

Extract a timeline for a specific session:

```bash
jq 'select(.session_id == "session-abc-001") | {time, msg, level}' sortie.log
```

Find sweep passes that removed at least one workspace on age:

```bash
jq 'select(.msg == "sweep: pass complete" and .removed_age > 0)' sortie.log
```

## Redirect logs to a file

Sortie logs to stderr by default. Redirect to a file with shell redirection:

```bash
sortie ./WORKFLOW.md 2>sortie.log
```

Or use `tee` to keep both console and file output:

```bash
sortie ./WORKFLOW.md 2>&1 | tee sortie.log
```

For systemd services, logs go to journald automatically. Watch them in real time with:

```bash
journalctl -u sortie -f
```

Or filter for errors only:

```bash
journalctl -u sortie -p err
```

## What we covered

You now know how to read Sortie's structured logs in both text and JSON formats, follow specific issues through the dispatch lifecycle, distinguish between warnings (automatic recovery) and errors (needs your attention), switch to JSON for log aggregation, filter JSON logs with `jq`, find tool call failures, and persist logs to a file. For the complete error catalog, see the [error reference](/reference/errors/). For metric-based monitoring with Prometheus and Grafana, see [Monitor with Prometheus](/guides/monitor-with-prometheus/). For real-time visual monitoring, see the [dashboard reference](/reference/dashboard/).
