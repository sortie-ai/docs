---
title: "Errors | Sortie"
description: "Reference for all Sortie error kinds: tracker errors, agent errors, workspace failures, worker exit types, retry behavior, and operator actions."
keywords: sortie errors, troubleshooting, retry behavior, tracker_auth_error, agent_not_found, error kinds, diagnostics
author: Sortie AI
---

# Error reference

Every error Sortie produces falls into one of six categories: startup failures, tracker errors, agent errors, workspace errors, worker exit outcomes, and HTTP API errors. This page documents each — what it means, whether Sortie retries it, and what you should do.

Error kind strings appear in logs exactly as shown below. Search this page for the string you see in your output. For step-by-step diagnosis of the most common failures, see [How to troubleshoot common failures](../guides/troubleshoot-common-failures.md).

---

## Startup and configuration errors

These errors prevent Sortie from starting. They appear immediately on launch and cause exit code `1`. None are retryable — Sortie exits. Fix the configuration and restart.

| Check | Log output | Action |
|---|---|---|
| `workflow_load` | `workflow file cannot be loaded: <details>` | Provide the correct path as argument, or create `./WORKFLOW.md`. If the file exists, fix YAML front matter syntax. |
| `tracker.kind` | `tracker.kind is required` | Add `tracker.kind` to your WORKFLOW.md front matter. |
| `tracker_adapter` | `unknown tracker kind "<kind>"` | Use a registered adapter: `jira`, `file`, or `github`. |
| `tracker.api_key` | `tracker.api_key is required for tracker kind "<kind>" (value may be empty after environment variable expansion)` | Set the environment variable referenced by `tracker.api_key` (e.g., `$SORTIE_JIRA_API_KEY`). |
| `tracker.project` | `tracker.project is required for tracker kind "<kind>"` | Add the `project` field to the `tracker` section. |
| `tracker.project.format` | `tracker.project must be in owner/repo format (e.g. "sortie-ai/sortie")` | Use `owner/repo` format with exactly one `/` and no whitespace in either segment. GitHub adapter only. |
| `agent.kind` | `agent.kind is required` | Add `agent.kind` to your WORKFLOW.md front matter. |
| `agent_adapter` | `unknown agent kind "<kind>"` | Use a registered adapter: `claude-code` or `mock`. |
| `agent.command` | `agent.command is required for agent kind "<kind>"` | Set `agent.command` or install the agent binary so it's in `PATH`. |
| `tracker.handoff_state` | `tracker.handoff_state: "<val>" collides with active/terminal state` | Use a state that doesn't appear in `active_states` or `terminal_states`. |
| `tracker.in_progress_state` | `tracker.in_progress_state: "<val>" is not in active_states` / `collides with terminal state` / `collides with handoff_state` | `in_progress_state` must be in `active_states`, must not be in `terminal_states`, and must not equal `handoff_state`. |
| `tracker.comments` | `tracker.comments: expected map, got <type>` | The `comments` value must be a YAML map, not a scalar or list. |
| `tracker.comments.on_dispatch` | `tracker.comments.on_dispatch: expected bool, got <type>` | Use `true` or `false`. Quoted strings like `"true"` are not accepted. Same applies to `on_completion` and `on_failure`. |

Preflight validation reports all failures at once in a single `dispatch preflight failed: ...` line.

The [`sortie validate`](cli.md#validate) subcommand runs these same checks without starting the orchestrator, and additionally emits [advisory warnings](cli.md#advisory-warnings) for front matter issues (unknown keys, sub-keys, type mismatches) and template problems (dot-context misuse in `{{ range }}`/`{{ with }}`, unknown variables, unknown sub-fields). Use it in CI pipelines or pre-commit hooks to catch configuration errors, typos, and template mistakes before deployment.

---

## Tracker errors

Errors from tracker adapter API calls. They appear in logs with the format `tracker: <kind>: <message>`.

Three are configuration errors (before any API calls). Six occur at runtime during polling, state transitions, or issue fetches.

### Configuration errors

| Error kind | Description | Retryable | Operator action |
|---|---|---|---|
| `unsupported_tracker_kind` | The `tracker.kind` value has no registered adapter. | No | Use `jira`, `file`, or `github`. |
| `missing_tracker_api_key` | The `tracker.api_key` field resolved to empty after environment variable expansion. | No | Set the environment variable (e.g., `SORTIE_JIRA_API_KEY`). |
| `missing_tracker_project` | The `tracker.project` field is absent and the adapter requires it. | No | Add `project` to the `tracker` section in WORKFLOW.md. |

### Runtime errors

| Error kind | Description | Retryable | Backoff | Operator action |
|---|---|---|---|---|
| `tracker_transport_error` | Network or connection failure (DNS, TCP timeout, TLS). | Yes | Exponential | Check network connectivity to the tracker endpoint. |
| `tracker_auth_error` | Authentication or authorization failure (HTTP 401/403). | No | — | Verify API key or token and check account permissions. |
| `tracker_api_error` | Non-200 HTTP response from the tracker, including rate limiting and 5xx server errors. | Yes | Exponential | Check tracker service status. Usually self-resolves; investigate if persistent. |
| `tracker_not_found` | The requested resource does not exist (HTTP 404). | No | — | Verify the project key and issue identifiers in your configuration. |
| `tracker_payload_error` | Malformed or unexpected response body from the tracker. | No | — | Check tracker API version compatibility. |
| `tracker_missing_end_cursor` | Pagination integrity error — expected cursor missing from response. | Yes | Exponential | Usually transient. If persistent, [report a bug](https://github.com/sortie-ai/sortie/issues). |

---

## Agent errors

Errors from agent adapter sessions. They appear in logs with the format `agent: <kind>: <message>`.

| Error kind | Description | Retryable | Backoff | Operator action |
|---|---|---|---|---|
| `agent_not_found` | Agent command or binary not found in `PATH`. Also triggered by SSH exit code `127` (remote binary missing). | No | — | Install the agent binary, or set `agent.command` in WORKFLOW.md. For SSH workers, install the agent on the remote host. |
| `invalid_workspace_cwd` | Workspace path is invalid, doesn't exist, or isn't a directory. | No | — | Check `workspace.root` permissions and available disk space. |
| `response_timeout` | Startup or synchronous communication timed out before the agent responded. | Yes | Exponential | Increase [`agent.read_timeout_ms`](workflow-config.md) if persistent. |
| `turn_timeout` | A turn exceeded the configured [`agent.turn_timeout_ms`](workflow-config.md). | Yes | Exponential | Increase the timeout, or simplify the task so the agent finishes faster. |
| `port_exit` | Agent subprocess exited unexpectedly (non-zero exit code, pipe failure, or crash). | Yes | Exponential | Check agent logs for crash details. For SSH workers, exit code `255` indicates an SSH connection failure — check connectivity and verify the host is in `worker.ssh_hosts`. |
| `response_error` | Agent returned a protocol-level error response. | Yes | Exponential | Check agent version compatibility with Sortie. |
| `turn_failed` | Agent turn completed with a failure status (the agent reported its own failure). | Yes | Exponential | Review the agent output in Sortie's logs for failure details. |
| `turn_cancelled` | Turn was cancelled (reconciliation kill, stall detection, or shutdown). | No | — | Expected during reconciliation. No action needed unless frequent outside of shutdown. |
| `turn_input_required` | Agent requested interactive user input. | No | — | Reconfigure the agent for non-interactive mode. For Claude Code, use `--allowedTools` to pre-authorize tools. |

---

## Workspace errors

Errors during workspace preparation and hook execution. Two distinct error types.

### Path errors

Format: `workspace <op>: <details>`

Occur when Sortie prepares the per-issue workspace directory.

| Operation | Meaning | Operator action |
|---|---|---|
| `sanitize` | Issue identifier contains characters invalid for a directory name. | Check that your tracker returns clean identifiers. |
| `resolve` | Workspace root path resolution failed (e.g., `~` expansion). | Verify `workspace.root` is a valid, absolute-resolvable path. |
| `containment` | The computed workspace path escapes the workspace root. This is a security violation — an identifier like `../../etc` was used. | Investigate the issue identifier in your tracker. This should not happen with legitimate data. |
| `create` | Directory creation failed (permission denied, disk full). | Check filesystem permissions and available disk space on `workspace.root`. |
| `stat` | Filesystem stat failed on the workspace path. | Check that the path exists and is accessible. |
| `conflict` | Directory already exists when Sortie expected to create a fresh workspace. | A previous run may not have cleaned up. Remove the conflicting directory manually, or check `before_remove` hook behavior. |

### Hook errors

Format: `hook <op>: <details>`

Occur when lifecycle hook scripts (`after_create`, `before_run`, `after_run`, `before_remove`) execute.

| Operation | Meaning | Operator action |
|---|---|---|
| `validate` | Empty script body or invalid timeout (non-positive `hooks.timeout_ms`). | Fix your hook script or set a valid `hooks.timeout_ms`. |
| `start` | Failed to spawn the subprocess (missing shell, permission denied). | Check that `/bin/sh` exists and is executable on the host. |
| `run` | Script exited with non-zero exit code. Hook output is captured in the log. | Read the captured output to diagnose the script failure. |
| `timeout` | Script exceeded [`hooks.timeout_ms`](workflow-config.md) or the parent context was cancelled. | Increase `hooks.timeout_ms`, or make the hook script faster. |

Hook errors in `after_create` prevent the worker from starting — the error is retryable. Hook errors in `before_remove` are logged but ignored; workspace cleanup still proceeds.

---

## Worker exit kinds

Not errors per se, but essential for understanding session outcomes. Appear in logs as `worker exiting exit_kind=<kind>`.

| Exit kind | Meaning | What happens next |
|---|---|---|
| `normal` | Turn loop completed without error. | If issue is still active and `max_turns` reached: continuation retry (1s delay). If [`handoff_state`](workflow-config.md) configured and issue still active: transition attempt, claim released on success, continuation retry on failure. If issue no longer active: claim released. |
| `error` | Fatal error during session. | If the error is retryable: exponential backoff retry. If not: claim released immediately, the issue becomes re-dispatchable on the next poll cycle. |
| `cancelled` | Context cancelled (reconciliation kill, stall detection, or shutdown). | Claim released unless reconciliation pre-scheduled a retry. No automatic retry — reconciliation handles re-dispatch. |

---

## SSH worker errors

When [`extensions.worker.ssh_hosts`](workflow-config.md) is configured, two exit codes carry special meaning.

| Exit code | Error kind | Meaning | Retryable | Operator action |
|---|---|---|---|---|
| `255` | `port_exit` | SSH connection failure (refused, timeout, host unreachable). | Yes (exponential) | Check SSH connectivity. Verify host is in `worker.ssh_hosts`. Retry prefers the same host but falls back to the least-loaded alternative. |
| `127` | `agent_not_found` | Remote agent binary not found in `PATH`. | No | Install the agent on the remote host. Verify `PATH` for the SSH user. |

---

## HTTP API errors

The JSON API returns errors in a standard envelope:

```json
{
  "error": {
    "code": "issue_not_found",
    "message": "issue identifier \"FOO-999\" not found in current state"
  }
}
```

| Code | HTTP status | Meaning |
|---|---|---|
| `issue_not_found` | `404` | Issue identifier not present in current runtime state (not running, not retrying). |
| `snapshot_unavailable` | `503` | Orchestrator state snapshot temporarily unavailable. Retry after a short delay. |
| `method_not_allowed` | `405` | Wrong HTTP method for the endpoint (e.g., `POST` to a `GET`-only route). The `Allow` header indicates the correct method. |
| `internal_error` | `500` | Server-side JSON encoding failure or unexpected error. |

For full endpoint documentation, request/response shapes, and curl examples, see [HTTP API reference](http-api.md).

---

## Retry behavior

**Exponential backoff** — retryable errors schedule the next attempt with:

```
delay = min(10000ms × 2^(attempt-1), max_retry_backoff_ms)
```

With the default `max_retry_backoff_ms` of 300,000 (5 minutes), the progression is: 10s → 20s → 40s → 80s → 160s → 300s → 300s → ...

**Non-retryable errors** release the claim immediately. The issue becomes dispatchable again on the next poll cycle if it's still in an active tracker state.

**Continuation retries** fire after a normal worker exit when `max_turns` was reached but the issue remains active. These use a fixed 1-second delay — no exponential backoff.

The backoff cap is configurable via [`agent.max_retry_backoff_ms`](workflow-config.md) in WORKFLOW.md.
