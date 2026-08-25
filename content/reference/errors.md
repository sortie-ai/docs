---
title: "Errors"
description: "Reference for all Sortie error kinds: tracker errors, agent errors, workspace failures, worker exit types, retry behavior, and operator actions."
author: Sortie AI
date: 2026-03-26
weight: 80
url: /reference/errors/
---
Every error Sortie produces falls into one of six categories: startup failures, tracker errors, agent errors, workspace errors, worker exit outcomes, and HTTP API errors. This page documents each - what it means, whether Sortie retries it, and what you should do.

Error kind strings appear in logs exactly as shown below. Search this page for the string you see in your output. For step-by-step diagnosis of the most common failures, see [How to troubleshoot common failures](/guides/troubleshoot-common-failures/).

---

## Startup and configuration errors

These errors prevent Sortie from starting. They appear immediately on launch and cause exit code `1`. None are retryable - Sortie exits. Fix the configuration and restart.

| Check | Log output | Action |
|---|---|---|
| `workflow_load` | `workflow file cannot be loaded: <details>` | Provide the correct path as argument, or create `./WORKFLOW.md`. If the file exists, fix YAML front matter syntax. |
| `tracker.kind` | `tracker.kind is required` | Add `tracker.kind` to your WORKFLOW.md front matter. |
| `tracker_adapter` | `unknown tracker adapter kind "<kind>"; registered: [<list>]` | Set `tracker.kind` to one of the kinds the message lists. |
| `tracker.api_key` | `tracker.api_key is required for tracker kind "<kind>" (value may be empty after environment variable expansion)` | Set the environment variable referenced by `tracker.api_key` (e.g., `$SORTIE_JIRA_API_KEY`). |
| `tracker.project` | `tracker.project is required for tracker kind "<kind>"` | Add the `project` field to the `tracker` section. |
| `tracker.project.format` | `tracker.project must be in owner/repo format (e.g. "sortie-ai/sortie")` | Use `owner/repo` format with exactly one `/` and no whitespace in either segment. Raised by the `github` and `gitea` adapters; `gitlab` validates its project field separately. |
| `agent.kind` | `agent.kind is required` | Add `agent.kind` to your WORKFLOW.md front matter. |
| `agent_adapter` | `unknown agent adapter kind "<kind>"; registered: [<list>]` | Set `agent.kind` to one of the kinds the message lists. |
| `agent.command` | `agent.command is required for agent kind "<kind>"` | Set `agent.command` or install the agent binary so it's in `PATH`. |
| `agent.turn_timeout_ms` | `config: agent.turn_timeout_ms: must be greater than 0` | Set `agent.turn_timeout_ms` to a positive number of milliseconds, or remove the field to use the default. |
| `tracker.handoff_state` | `tracker.handoff_state: "<val>" collides with active state "<state>"` / `collides with terminal state "<state>"` | Use a state that appears in neither `active_states` nor `terminal_states`. A handoff parks the issue for a person, so it is neither dispatchable nor terminal. Applies to every `tracker.kind`. |
| `tracker.handoff_evidence` | `tracker.handoff_evidence: must be one of observed, strict, or off` | Set the field to `observed`, `strict`, or `off`, or leave it unset for the default `observed`. |
| `tracker.in_progress_state` | `tracker.in_progress_state: "<val>" is not in active_states` / `collides with terminal state` / `collides with handoff_state` | `in_progress_state` must be in `active_states`, must not be in `terminal_states`, and must not equal `handoff_state`. |
| `tracker.comments` | `tracker.comments: expected map, got <type>` | The `comments` value must be a YAML map, not a scalar or list. |
| `tracker.comments.on_dispatch` | `tracker.comments.on_dispatch: expected bool, got <type>` | Use `true` or `false`. Quoted strings like `"true"` are not accepted. Same applies to `on_completion` and `on_failure`. |
| `codex.approval_policy.interactive` | `codex.approval_policy is set to a value that lets the agent stop and ask for approval, and an unattended run has no one to answer; only "never" is supported` | Set `codex.approval_policy: never`, or remove the field. See [Codex validate-time checks](/reference/adapter-codex/#validate-time-checks). |
| `claude-code.permission_mode.interactive` | `claude-code.permission_mode is set to a value that lets the agent stop and ask for approval, and an unattended run has no one to answer; only "bypassPermissions" is supported` | Set `claude-code.permission_mode: bypassPermissions`, or remove the field. See [Claude Code validate-time checks](/reference/adapter-claude-code/#validate-time-checks). |
| `agent.kind.session_resume` | `<kind>.<key> stops this agent kind from resuming a session across separate agent launches, but Sortie re-dispatches an issue with its earlier session after a retry, a continuation, a stall, or a restart, and every such turn fails. Change <kind>.<key>, or use an agent kind that can resume a session.` | Change the named key, or select an agent kind that resumes sessions. `claude-code.session_persistence: false` is the only value any built-in adapter declares this way; remove it or set it to `true`. See [Claude Code validate-time checks](/reference/adapter-claude-code/#validate-time-checks). |
| `kiro.trust_tools.untrusted` | `trust_all_tools does not resolve to true, ...` | Set `kiro.trust_all_tools: true`, or leave both `trust_all_tools` and `trust_tools` unset, and run the agent inside a hardened sandbox. See [Kiro validate-time checks](/reference/adapter-kiro/#validate-time-checks). |

Preflight validation reports all failures at once in a single `dispatch preflight failed: ...` line.

The [`sortie validate`](/reference/cli/#validate) subcommand runs these same checks without starting the orchestrator, and additionally emits [advisory warnings](/reference/cli/#advisory-warnings) for front matter issues (unknown keys, sub-keys, type mismatches), template problems (dot-context misuse in `{{ range }}`/`{{ with }}`, unknown variables, unknown sub-fields), and a configuration value that cannot reach the agent it is written for. Use it in CI pipelines or pre-commit hooks to catch configuration errors, typos, and template mistakes before deployment.

---

## Tracker errors

Errors from tracker adapter API calls. They appear in logs with the format `tracker: <kind>: <message>`.

Three are configuration errors (before any API calls). Six occur at runtime during polling, state transitions, or issue fetches.

### Configuration errors

| Error kind | Description | Retryable | Operator action |
|---|---|---|---|
| `unsupported_tracker_kind` | The `tracker.kind` value has no registered adapter. | No | Set `tracker.kind` to a registered kind. The startup error names every kind the binary registers. |
| `missing_tracker_api_key` | The `tracker.api_key` field resolved to empty after environment variable expansion. | No | Set the environment variable (e.g., `SORTIE_JIRA_API_KEY`). |
| `missing_tracker_project` | The `tracker.project` field is absent and the adapter requires it. | No | Add `project` to the `tracker` section in WORKFLOW.md. |

### Runtime errors

| Error kind | Description | Retryable | Backoff | Operator action |
|---|---|---|---|---|
| `tracker_transport_error` | Network or connection failure (DNS, TCP timeout, TLS). | Yes | Exponential | Check network connectivity to the tracker endpoint. |
| `tracker_auth_error` | Authentication or authorization failure (HTTP 401/403). | No | - | Verify API key or token and check account permissions. |
| `tracker_api_error` | Non-200 HTTP response from the tracker, including rate limiting and 5xx server errors. | Yes | Exponential | Check tracker service status. Usually self-resolves; investigate if persistent. |
| `tracker_not_found` | The requested resource does not exist (HTTP 404). | No | - | Verify the project key and issue identifiers in your configuration. |
| `tracker_payload_error` | Malformed or unexpected response body from the tracker. | No | - | Check tracker API version compatibility. |
| `tracker_missing_end_cursor` | Pagination integrity error - expected cursor missing from response. | Yes | Exponential | Usually transient. If persistent, [report a bug](https://github.com/sortie-ai/sortie/issues). |

---

## Agent errors

Errors from agent adapter sessions. They appear in logs with the format `agent: <kind>: <message>`.

| Error kind | Description | Retryable | Backoff | Operator action |
|---|---|---|---|---|
| `agent_not_found` | Agent command or binary not found in `PATH`. Also triggered by SSH exit code `127` (remote binary missing). | No | - | Install the agent binary, or set `agent.command` in WORKFLOW.md. For SSH workers, install the agent on the remote host. |
| `invalid_workspace_cwd` | Workspace path is invalid, doesn't exist, or isn't a directory. | No | - | Check `workspace.root` permissions and available disk space. |
| `response_timeout` | Startup or synchronous communication timed out before the agent responded. | Yes | Exponential | Increase [`agent.read_timeout_ms`](/reference/workflow-config/) if persistent. |
| `turn_timeout` | A turn, including a self-review turn, exceeded the configured [`agent.turn_timeout_ms`](/reference/workflow-config/). | Yes | Exponential | Increase the timeout, or simplify the task so the agent finishes faster. |
| `port_exit` | Agent subprocess exited unexpectedly (non-zero exit code, pipe failure, or crash), or the runtime reported no turn outcome and the adapter had no per-turn process exit to observe. | Yes | Exponential | Check agent logs for crash details. For SSH workers, exit code `255` indicates an SSH connection failure - check connectivity and verify the host is in `worker.ssh_hosts`. |
| `response_error` | Agent returned a protocol-level error response. | Yes | Exponential | Check agent version compatibility with Sortie. |
| `turn_failed` | Agent turn completed with a failure status (the agent reported its own failure), or the agent exited with code `0` without reporting a turn outcome and without producing evidence that the model did any work this turn. | Yes | Exponential | Review the agent output in Sortie's logs for failure details. For no-output failures, check WARN-level logs for the agent's stderr content - common causes include MCP config parse errors and missing model configuration. |
| `turn_cancelled` | Turn was cancelled (reconciliation kill, stall detection, or shutdown). | No | - | Expected during reconciliation. No action needed unless frequent outside of shutdown. |
| `turn_input_required` | The agent asked for a decision only a person could give: a genuine question, or a permission the adapter had no way to refuse and let the turn continue. Sortie refuses rather than answering on a person's behalf, and ends the attempt instead of waiting. The claim is released, and the run is recorded with status `needs_person` rather than `failed`. | No | - | Read the `notification` event that precedes it: it names what the agent asked for. Then either satisfy the request outside the run (widen the sandbox, supply the missing decision in the issue or the prompt template) or narrow the task so the agent does not need it. Reconfiguring the agent does not remove this ending; every runtime is already launched non-interactively. |

Failure text is uniform across coding agents. A turn that exits `0` having produced nothing reports `agent exited without producing output`, followed by the signal the adapter looked for when it names one (for example `agent exited without producing output: no assistant output on the run stream`). A non-zero exit reports `exit code N`. A runtime that reported no turn outcome and gave the adapter no process exit to observe reports `runtime reported no turn outcome`.

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
| `containment` | The computed workspace path escapes the workspace root. This is a security violation - an identifier like `../../etc` was used. | Investigate the issue identifier in your tracker. This should not happen with legitimate data. |
| `create` | Directory creation failed (permission denied, disk full). | Check filesystem permissions and available disk space on `workspace.root`. |
| `stat` | Filesystem stat failed on the workspace path. | Check that the path exists and is accessible. |
| `conflict` | Directory already exists when Sortie expected to create a fresh workspace. | A previous run may not have cleaned up. Remove the conflicting directory manually, or check `before_remove` hook behavior. |

### Hook errors

Format: `hook <op>: <details>`

Occur when lifecycle hook scripts (`after_create`, `before_run`, `after_run`, `before_remove`) execute.

| Operation | Meaning | Operator action |
|---|---|---|
| `validate` | Empty script body or invalid timeout (non-positive `hooks.timeout_ms`). | Fix your hook script or set a valid `hooks.timeout_ms`. |
| `start` | Failed to spawn the hook subprocess (missing shell, permission denied). | On POSIX, check that `/bin/sh` exists and is executable. On Windows, check that `cmd.exe` is available. |
| `run` | Script exited with non-zero exit code. The failure WARN record carries the script's combined stdout and stderr under `hook_output` (the last 8 KiB). | Read `hook_output` on the WARN record to diagnose the script failure. |
| `timeout` | Script exceeded [`hooks.timeout_ms`](/reference/workflow-config/) or the parent context was cancelled. | Increase `hooks.timeout_ms`, or make the hook script faster. |

Hook errors in `after_create` prevent the worker from starting - the error is retryable. Hook errors in `before_remove` are logged but ignored; workspace cleanup still proceeds.

---

## Worker exit kinds

Not errors per se, but essential for understanding session outcomes. Appear in logs as `worker exiting exit_kind=<kind>`.

| Exit kind | Meaning | What happens next |
|---|---|---|
| `normal` | Turn loop completed without error. | If the tracker reports the issue in a terminal state: handoff suppressed, claim released. If [`handoff_state`](/reference/workflow-config/) configured and issue still active: transition attempt, claim released on success, continuation retry on failure. If issue still active with no handoff state configured: continuation retry (1s delay). If issue no longer active: claim released. A [`.sortie/status`](/reference/agent-extensions/) soft stop suppresses the continuation retry in every case; `blocked` also suppresses the handoff transition and, where the dispatch drives issue state, parks the issue with the escalation label and holds it out of dispatch. A run whose [handoff-evidence verdict](/reference/state-machine/#handoff-evidence) withholds the handoff makes no tracker write; Sortie reads the issue state once more before recording that outcome, and unless that read reports a terminal state the run is recorded as failed rather than succeeded and takes exponential backoff instead of the one-second continuation retry. A terminal result there gives the terminal outcome above instead: handoff suppressed, claim released, no failure record and no retry. |
| `error` | Fatal error during session. | If the error is retryable: exponential backoff retry. If not: claim released immediately, the issue becomes re-dispatchable on the next poll cycle. |
| `cancelled` | Context cancelled (reconciliation kill, stall detection, or shutdown). | Claim released unless reconciliation pre-scheduled a retry. No automatic retry - reconciliation handles re-dispatch. |

---

## SSH worker errors

When [`extensions.worker.ssh_hosts`](/reference/workflow-config/) is configured, two exit codes carry special meaning.

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
| `issue_not_found` | `404` | Issue identifier not present in current runtime state (not running, not retrying, not budget-exhausted). |
| `snapshot_unavailable` | `503` | Orchestrator state snapshot temporarily unavailable. Retry after a short delay. |
| `method_not_allowed` | `405` | Wrong HTTP method for the endpoint (e.g., `POST` to a `GET`-only route). The `Allow` header indicates the correct method. |
| `internal_error` | `500` | Server-side JSON encoding failure or unexpected error. |

For full endpoint documentation, request/response shapes, and curl examples, see [HTTP API reference](/reference/http-api/).

---

## Retry behavior

**Exponential backoff** - retryable errors schedule the next attempt with:

```
delay = min(10000ms × 2^(attempt-1), max_retry_backoff_ms)
```

With the default `max_retry_backoff_ms` of 300,000 (5 minutes), the progression is: 10s → 20s → 40s → 80s → 160s → 300s → 300s → ...

**Non-retryable errors** release the claim immediately. The issue becomes dispatchable again on the next poll cycle if it's still in an active tracker state.

**Continuation retries** fire after a normal worker exit when `max_turns` was reached but the issue remains active. These use a fixed 1-second delay - no exponential backoff.

The backoff cap is configurable via [`agent.max_retry_backoff_ms`](/reference/workflow-config/) in WORKFLOW.md.
