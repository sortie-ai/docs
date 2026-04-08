---
title: How to Troubleshoot Common Failures
description: "Diagnose and fix the failures you'll hit most often: agent won't start, tracker auth errors, template render failures, workspace permission problems, and stuck retries."
keywords: sortie troubleshooting, agent not starting, tracker auth error, template error, workspace permission, retry loop, debugging, common errors
author: Sortie AI
date: 2026-03-28
weight: 10
url: /guides/troubleshoot-common-failures/
---

# How to troubleshoot common failures

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
level=WARN msg="worker run failed, scheduling retry" error="hook after_create: run: exit status 128"
```

A hook exited non-zero. `after_create` and `before_run` failures are fatal for the attempt; `after_run` and `before_remove` are logged but ignored.

1. Run with `--log-level debug` — Sortie captures the hook's stdout and stderr.

2. Test the hook manually:

    ```bash
    mkdir /tmp/test-ws && cd /tmp/test-ws
    git clone --depth 1 git@github.com:acme/backend.git .
    ```

    Common causes: SSH key not forwarded, wrong repo URL, missing dependencies.

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
