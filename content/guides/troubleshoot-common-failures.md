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
level=ERROR msg="worker run failed, non-retryable, releasing claim" error="agent: agent_not_found: agent command \"claude\" not found: exec: \"claude\": executable file not found in $PATH"
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
level=ERROR msg="worker run failed, scheduling retry" error="agent: port_exit: exit code 1"
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

1. **MCP config parsing failure.** The agent failed to parse `--additional-mcp-config` or `--mcp-config` and exited silently. Check the WARN-level log lines immediately above the error — Sortie emits the agent's stderr content, which contains the parse error. On `codex` and `opencode` a bad MCP configuration fails differently: those adapters read it themselves before the agent starts, so the session ends with a `response_error` naming the file rather than a silent exit.

2. **Missing or invalid model configuration.** The agent started but the configured model was unavailable, causing an immediate exit before any LLM work.

3. **Rate limiting during initialization.** The agent hit an API rate limit before producing any output.

Run with `--log-level debug` to see the full subprocess stderr. Fix the root cause (correct the config path, set the right API key, wait for rate limits to clear) and Sortie's exponential backoff retries will succeed automatically.

## A turn runs long and gets cut off

```
level=WARN msg="turn timeout exceeded" issue_id="PROJ-42" issue_identifier="PROJ-42" session_id="session-abc-001" turn_timeout_ms=1800000 turn_number=2
level=WARN msg="worker run failed, scheduling retry" issue_id="PROJ-42" issue_identifier="PROJ-42" session_id="session-abc-001" error="agent turn 2: agent: turn_timeout: turn exceeded the configured 1800000 ms bound; the adapter's own report follows: context deadline exceeded" next_attempt=1 delay_ms=10000
```

The turn ran longer than `agent.turn_timeout_ms`. The attempt fails and is retried on the usual exponential backoff; it is not abandoned.

1. **Tell it apart from a stall.** A turn timeout reports `turn_timeout`; a stall reports `turn_cancelled` and fires on silence rather than duration, regardless of how long the turn has been running. See the [error reference](/reference/errors/#agent-errors) for both error kinds.

2. **Set a larger value if the task is genuinely long-running.** See [how to configure retry behavior](/guides/configure-retry-behavior/#turn-timeout) for the tradeoffs between a longer turn timeout and the stall-detection ratio.

## A run stops because it needs a person

```
level=WARN msg="agent asked for a decision only a person can make, ending the attempt"
level=ERROR msg="worker run failed, non-retryable, releasing claim" error="agent turn 2: agent: turn_input_required: agent asked for a decision only a person can make: an answer to a question"
```

The agent asked for something no unattended run can supply: an answer to a question, or a permission the runtime gave Sortie no way to refuse and still continue. Sortie refuses rather than consenting on your behalf, and ends the attempt rather than waiting. The claim is released, no retry is scheduled, and the run is recorded with status `needs_person` rather than `failed`.

1. **Read the message tail, not just the error kind.** The text after `turn_input_required:` names what the agent asked for. `an answer to a question` and `wider filesystem or network access` are the two tails in use today.

2. **Do not reconfigure the agent for non-interactive mode.** It already is. Every runtime is launched in a mode that cannot ask interactively, and a pass-through setting that would undo that is refused before the run starts. This ending happens on the paths that survive that launch posture.

3. **Give the agent what it lacked, outside the run.** If it wanted wider access, widen the sandbox: for Codex, `codex.thread_sandbox` and `codex.turn_sandbox_policy`. If it asked a question, the answer belongs in the issue or in the prompt template, so the next dispatch does not need to ask. See the [Codex adapter reference](/reference/adapter-codex/#approval-policy-and-sandbox) for which requests end an attempt and which ones the agent can work around.

4. **Narrow the task if neither applies.** An issue whose resolution genuinely needs a human decision is not work an unattended agent can finish, and repeated `needs_person` runs on the same issue are the signal to take it out of the dispatch set.

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
level=ERROR msg="failed to fetch candidate issues" error="tracker: tracker_auth_error: HTTP 401: Unauthorized"
```

The API token is wrong, expired, or lacks required permissions. Sortie does not stop polling on this error — it logs it and retries on the next poll interval, so you will see it repeat until you fix the credential.

1. Verify the environment variable resolves to a non-empty value:

    ```bash
    echo "${SORTIE_JIRA_API_KEY:-(unset)}"
    ```

2. Test the token directly:

    ```bash
    curl -s -u "you@company.com:your-api-token" \
      "https://yourcompany.atlassian.net/rest/api/3/myself" | head -5
    ```

    That is the pairing Sortie sends for a key in `email:token` form. A Data Center personal access token carries no colon and goes out as a bearer credential instead.

3. If you use `handoff_state`, `in_progress_state`, or `tracker.comments`, the token needs to be able to write to issues, not only read them.

## Sortie won't start: endpoint is rejected

```
level=ERROR msg="failed to construct tracker adapter" error="tracker: tracker_payload_error: gitea: endpoint \"https://gitea.example.com:abc\" is not a valid absolute http(s) url"
```

`endpoint` failed to parse as an absolute `http` or `https` URL carrying a hostname. This is a construction-time failure on every adapter that reads an `endpoint` (GitHub, Gitea, GitLab, Linear) — Sortie refuses to start rather than letting a bad value reach the HTTP client and fail later as a network error. The same check runs offline through `sortie validate`, except for a Gitea CI or SCM endpoint set through a top-level `gitea:` override, which validate does not inspect.

Three shapes commonly trigger this:

- **A port with no host**, such as `http://:8080`. Give the hostname: `http://gitea.internal:8080`.
- **An unbracketed IPv6 address**, such as `http://fd00::1:3000` — the exact form an address prints as from `ip addr`. Add brackets around the address: `http://[fd00::1]:3000`.
- **A query string or fragment** appended to the base URL, such as `https://gitlab.example.com?insecure=1`. Remove it; the adapter appends its own API path and has nowhere to put one.

If the endpoint carries a username or password, the error message masks it before printing, so a credential never appears in the log.

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
level=INFO msg="tick completed" candidates=0 dispatched=0 ... running=0 retrying=0 ...
```

(the `tick completed` line carries more fields than shown here; see [How to monitor Sortie with logs](/guides/monitor-with-logs/) for the full field list)

Sortie is polling but finds nothing to dispatch.

1. **State names must match exactly.** Verify `tracker.active_states` matches your tracker (case-sensitive). `"To Do"` and `"to do"` are different states.

2. **Use dry-run** to see what Sortie would dispatch:

    ```bash
    sortie --dry-run ./WORKFLOW.md
    ```

    Each candidate gets a `would_dispatch` or `skip_reason` field in the log.

3. **Concurrency cap reached.** If `running` equals `agent.max_concurrent_agents`, new issues wait. Increase the cap or wait for running agents to finish.

4. **Query filter too narrow.** A typo in `tracker.query_filter` returns zero results. Use `--dry-run --log-level debug` to see the full query.

5. **A blocker hasn't cleared, or its list couldn't be read.** An issue held for this reason carries a `skip_reason` in dry-run output: `blocked_by` means a listed blocker hasn't reached a terminal state yet. `blockers_unresolved` and `blockers_not_read` mean Sortie couldn't read the blocker list this poll (a failed read, or the per-poll read budget was already spent on other candidates) and will retry on a later poll - this applies to GitHub and Gitea, which read dependencies separately from the candidate list. See [candidate eligibility](/reference/state-machine/#candidate-eligibility) for the full gate, and `sortie_candidate_holds_total` on the [Prometheus metrics reference](/reference/prometheus-metrics/#counters) to watch this over time instead of one poll at a time.

6. **A per-issue budget ceiling was reached.** An issue held by `agent.max_sessions` or `agent.max_tokens` stays in its active tracker state and is skipped on every poll. Check `GET /api/v1/{identifier}` for `status: "budget_exhausted"`, the dashboard's [Budget blocked table](/reference/dashboard/#budget-blocked-table), or grep your logs for `blocking re-dispatch`. Sortie also posts one comment on the issue naming the ceiling that stopped it. See [how to control agent costs](/guides/control-costs/).

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
