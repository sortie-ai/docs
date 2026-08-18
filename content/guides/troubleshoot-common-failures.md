---
title: How to Troubleshoot Common Failures
linkTitle: "Troubleshoot Common Failures"
description: "Diagnose common Sortie failures: agent won't start, tracker auth errors, template render failures, workspace permission issues, and stuck retries."
author: Sortie AI
date: 2026-03-28
weight: 230
url: /guides/troubleshoot-common-failures/
---
Each section below covers one failure — the log line you see, why it happens, and what to do. For the full error catalog with every error kind and retry formula, see the [error reference](/reference/errors/).

## Agent won't start

```
level=ERROR msg="worker run failed, non-retryable, releasing claim" error="agent: agent_not_found: claude not found in PATH"
```

The agent binary isn't installed or isn't on `PATH`.

1. Check whether the binary exists:

    ```bash
    which claude
    ```

2. If it's installed under a different name or path, set `agent.command`:

    ```yaml
    agent:
      kind: claude-code
      command: /usr/local/bin/claude-code
    ```

3. For SSH workers, the binary must exist on every remote host. Exit code `127` in logs means the remote host is missing it:

    ```bash
    ssh build01.internal "which claude && echo ok"
    ```

4. Confirm the fix: `sortie validate ./WORKFLOW.md`

## Agent crashes on authentication

```
level=ERROR msg="worker run failed, scheduling retry" error="agent: port_exit: exit status 1"
```

Workers start and immediately crash. The actual cause — a missing `ANTHROPIC_API_KEY` — lives inside the agent subprocess, not in Sortie's error output. This is the most common deployment failure.

1. Verify the variable is set:

    ```bash
    echo "${ANTHROPIC_API_KEY:-(unset)}"
    ```

2. For AWS Bedrock or Google Vertex AI, verify all required variables are set. See [environment variables reference](/reference/environment/) for the full list.

3. Run with `--log-level debug` to see the agent's stderr, which contains the actual auth error.

## Agent exits without producing output

```
level=WARN msg="agent exited without producing output, treating as failure"
level=ERROR msg="worker run failed, scheduling retry" error="agent: turn_failed: agent exited without producing output"
```

The agent subprocess exited with code 0 without reporting a turn outcome, and the adapter found no evidence the model produced anything. What counts as evidence depends on the agent: output tokens for Claude Code and Copilot CLI, assistant output on the run stream for OpenCode, a credits trailer on stderr for Kiro. When the adapter names the signal it looked for, the error line carries it after a colon. Sortie treats every one of these as `turn_failed` and retries with exponential backoff. Common causes:

1. **MCP config parsing failure.** The agent failed to parse `--additional-mcp-config` or `--mcp-config` and exited silently. Check the WARN-level log lines immediately above the error — Sortie emits the agent's stderr content, which contains the parse error.

2. **Missing or invalid model configuration.** The agent started but the configured model was unavailable, causing an immediate exit before any LLM work.

3. **Rate limiting during initialization.** The agent hit an API rate limit before producing any output.

Run with `--log-level debug` to see the full subprocess stderr. Fix the root cause (correct the config path, set the right API key, wait for rate limits to clear) and Sortie's exponential backoff retries will succeed automatically.

## Issue keeps re-running and never advances

```
level=WARN msg="handoff withheld by evidence policy" issue_id="PROJ-42" issue_identifier="PROJ-42" policy="observed" verdict="absence of work observed" reason="workspace commit and working tree match the run baseline" turns_completed=2 consecutive_absences=1
```

Sortie's default `tracker.handoff_evidence` policy withholds the handoff transition when a run leaves the workspace exactly as it found it. The issue stays in its active tracker state, and Sortie retries it on exponential backoff rather than failing silently or moving it forward on the strength of an exit code alone.

1. **Check what the agent actually did.** A withheld run names its verdict as the run's failure reason in [run history](/reference/dashboard/). If the agent reported success but changed nothing in the workspace, that is exactly the case this policy exists to catch.

2. **A dispatch whose only product is a tracker write is a known false positive.** If your agent's entire job is calling `tracker_api` to transition the issue itself, set `tracker.handoff_evidence: off`. See [workflow configuration](/reference/workflow-config/#tracker).

3. **Repeated absences park the issue.** After a bounded number of consecutive withheld runs, Sortie stops retrying and applies an escalation label instead of looping forever. See [park issues stuck in a loop of empty runs](/guides/configure-retry-behavior/#park-issues-stuck-in-a-loop-of-empty-runs).

4. **Not every workspace can be measured.** A workspace that is not a Git work tree changes nothing under the default policy. Only `strict` withholds there, and it withholds every transition. See the [state machine reference](/reference/state-machine/#handoff-evidence).

## Tracker returns 401 or 403

```
level=ERROR msg="poll failed" error="tracker: tracker_auth_error: HTTP 401: Unauthorized"
```

The API token is wrong, expired, or lacks required permissions. This error is non-retryable — Sortie stops polling until you fix it.

1. Verify the environment variable resolves to a non-empty value:

    ```bash
    echo "${SORTIE_JIRA_API_KEY:-(unset)}"
    ```

2. Test the token directly:

    ```bash
    curl -s -H "Authorization: Bearer $SORTIE_JIRA_API_KEY" \
      "https://yourcompany.atlassian.net/rest/api/3/myself" | head -5
    ```

3. If you use `handoff_state`, `in_progress_state`, or `tracker.comments`, the token needs write permissions: `write:jira-work` (classic) or `write:issue:jira` (granular).

## Template render fails

```
level=ERROR msg="template render error in WORKFLOW.md (line 24): can't evaluate field titel in type map[string]any"
```

Sortie runs templates in strict mode — unknown variables are hard errors. Three common causes:

- **Typo in a field name.** Check the name against the [variable table](/guides/write-prompt-template/#use-all-available-issue-fields). The error message names the exact field and line.

- **Unguarded nil field.** `.issue.parent` is `nil` when no parent exists. Wrap it: `{{ if .issue.parent }}{{ .issue.parent.identifier }}{{ end }}`

- **Dot rebinding inside `range`.** Inside `{{ range .issue.labels }}`, `.` is the current element. Use `{{ $.issue.identifier }}` to reach the root.

Run `sortie validate ./WORKFLOW.md` after every template edit to catch these before runtime.

## Workspace won't create

```
level=ERROR msg="workspace create: permission denied: /opt/sortie_workspaces/PROJ-42"
```

Three variants:

- **Permission denied.** The process user can't write to `workspace.root`. Fix permissions or change the root to a writable path like `~/sortie-workspaces`.

- **Containment violation** (`path escapes root`). An issue identifier produced a path outside the workspace root — a security boundary. Investigate the identifiers in your tracker.

- **Disk full.** Check with `df -h /opt/sortie_workspaces`.

## Hook script fails

```
level=WARN msg="after_create hook failed, rolling back workspace" issue_id=abc123 issue_identifier=PROJ-42 workspace=/opt/sortie_workspaces/PROJ-42 error="hook run: exit_code=128: exit status 128" hook_output="Cloning into '.'...\nfatal: Could not read from remote repository."
```

A hook exited non-zero. `after_create` and `before_run` failures are fatal for the attempt; `after_run` and `before_remove` are logged but ignored. For a fatal hook the orchestrator follows up with a `worker run failed, scheduling retry` line carrying the same error.

1. Read the `hook_output` attribute on the WARN record. It holds the hook's combined stdout and stderr at every log level; no debug flag is needed. The value keeps the last 8 KiB of output and starts with a truncation marker when earlier output was dropped. A hook that printed nothing produces no `hook_output` attribute. Output of successful hooks appears only at `--log-level debug`, on `hook completed` records.

2. Test the hook manually:

    ```bash
    mkdir /tmp/test-ws && cd /tmp/test-ws
    git clone --depth 1 git@github.com:acme/backend.git .
    ```

    Common causes: SSH key not forwarded, wrong repo URL, missing dependencies. Hooks run with a restricted environment that strips variables like `GIT_SSH_COMMAND`; see the [environment reference](/reference/environment/#hook-subprocess-environment).

3. For timeout errors, increase `hooks.timeout_ms` in WORKFLOW.md.

## Issues not being dispatched

```
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

Sortie is polling but finds nothing to dispatch.

1. **State names must match exactly.** Verify `tracker.active_states` matches your tracker (case-sensitive). `"To Do"` and `"to do"` are different states.

2. **Use dry-run** to see what Sortie would dispatch:

    ```bash
    sortie --dry-run ./WORKFLOW.md
    ```

    Each candidate gets a `would_dispatch` or `skip_reason` field in the log.

3. **Concurrency cap reached.** If `running` equals `agent.max_concurrent_agents`, new issues wait. Increase the cap or wait for running agents to finish.

4. **Query filter too narrow.** A typo in `tracker.query_filter` returns zero results. Use `--dry-run --log-level debug` to see the full query.

## Sortie won't start at all

```
dispatch preflight failed: tracker.kind is required
```

Sortie validates the config at startup and reports all failures at once. Run `sortie validate ./WORKFLOW.md` to see every problem — including advisory warnings for typos in YAML keys and type mismatches that would silently fall back to defaults at runtime. The most common missing fields:

| Field | Required by |
|---|---|
| `tracker.kind` | Always |
| `tracker.project` | Jira adapter |
| `tracker.api_key` | Jira adapter (after `$VAR` expansion) |
| `active_states` or `terminal_states` | At least one non-empty |

If `$VAR` references aren't resolving, verify the variables are exported in the shell that runs Sortie:

```bash
env | grep SORTIE
```

See the [workflow configuration reference](/reference/workflow-config/) for every field, default, and constraint.
