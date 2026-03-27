---
title: "How to Monitor with Logs | Sortie"
description: "Read and filter Sortie's structured key=value logs for debugging, monitoring, and operational awareness. Grep patterns, lifecycle messages, and log persistence."
keywords: sortie logs, structured logging, slog, grep, debugging, monitoring, log format, troubleshooting
author: Sortie AI
---

# How to monitor with logs

Sortie emits structured `key=value` logs via Go's `slog` package. Logs are always on — no configuration needed. They are the first place to look when something goes wrong.

## Prerequisites

- Sortie installed and running

That's it. Logs work with zero configuration.

## Understand the log format

Sortie uses `slog.TextHandler`. Every line is a flat `key=value` record:

```
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="tick completed" candidates=2 dispatched=2 running=2 retrying=0
```

Three structural fields appear on every line:

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

### Handoff transition

```
time=2026-03-26T14:35:21.500+00:00 level=INFO msg="handoff transition succeeded, releasing claim" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 handoff_state=Done
```

Sortie transitioned the issue to the configured `handoff_state` in the tracker and released its claim. The issue is done.

### Errors and retries

```
time=2026-03-26T14:35:22.000+00:00 level=WARN msg="worker run failed, scheduling retry" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 error="agent: turn_timeout: context deadline exceeded" next_attempt=2 delay_ms=20000
```

WARN with `scheduling retry` — Sortie is recovering automatically. The `next_attempt` and `delay_ms` fields tell you when the retry fires.

```
time=2026-03-26T14:35:22.500+00:00 level=ERROR msg="worker run failed, non-retryable, releasing claim" issue_id=abc123 issue_identifier=MT-649 session_id=session-abc-001 error="agent: agent_not_found: claude not found in PATH"
```

ERROR — Sortie gave up. This issue won't be retried. Fix the underlying problem (in this case, install the agent binary) and Sortie will pick the issue up on the next poll.

### Dispatch preflight failures

```
time=2026-03-26T14:30:01.300+00:00 level=ERROR msg="dispatch preflight failed" error="dispatch preflight failed: unsupported tracker kind: \"gitlab\""
```

This fires before any work is dispatched. It means your workflow configuration is invalid. Sortie can't dispatch anything until you fix the config and restart.

## Common grep patterns

These commands work against the log format shown above.

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

## Redirect logs to a file

Sortie logs to stderr by default. Redirect to a file:

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

You now know how to read Sortie's structured logs, follow specific issues through the dispatch lifecycle, distinguish between warnings (automatic recovery) and errors (needs your attention), find tool call failures, and persist logs to a file. For the complete error catalog, see the [error reference](../reference/errors.md). For metric-based monitoring with Prometheus and Grafana, see [Monitor with Prometheus](monitor-with-prometheus.md).
