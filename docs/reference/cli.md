---
title: CLI Reference | Sortie
description: Complete reference for the sortie command-line interface. Synopsis, subcommands, flags, dry-run mode, arguments, exit codes, signals, startup sequence, logging format, and version injection.
keywords: sortie CLI, command line, subcommands, validate, dry-run, flags, arguments, exit codes, signals, graceful shutdown, logging, version
author: Sortie AI
---

# CLI reference

## Synopsis

```
sortie [flags] [workflow-path]
sortie --dry-run [--log-level level] [workflow-path]
sortie validate [--format text|json] [workflow-path]
```

Without a subcommand, Sortie runs as a long-lived process. It loads the [workflow file](workflow-config.md), opens the SQLite database, validates configuration, and enters the poll-dispatch-reconcile event loop. The process blocks until terminated by a signal.

The `validate` subcommand checks the workflow file without starting the orchestrator. See [Subcommands](#subcommands).

---

## Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `workflow-path` | No | `./WORKFLOW.md` | Path to the workflow file. Relative paths resolve to absolute against the working directory at startup. |

One positional argument is accepted. Providing two or more produces an error:

```
sortie: too many arguments
```

---

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--dry-run` | boolean | `false` | Run one poll cycle without spawning agents or writing to the database, then exit. |
| `--log-level` | string | `info` | Log verbosity. Accepted values: `debug`, `info`, `warn`, `error`. |
| `--port` | integer | _(unset)_ | HTTP server listen port. Enables the embedded HTTP server when provided. |
| `--version` | boolean | `false` | Print the version banner with copyright notice, then exit. |
| `-dumpversion` | boolean | `false` | Print the bare version string (e.g., `0.0.9`), then exit. |

### `--dry-run` { #dry-run }

Runs a single poll cycle in read-only mode, then exits. Sortie connects to the tracker, fetches candidate issues, computes dispatch eligibility for each candidate, and logs the results. No agents are spawned, no SQLite database is opened, and no state is written.

This fills the gap between `sortie validate` (offline config checks) and a full `sortie` run (live operation). Use it to verify tracker connectivity, query results, and concurrency slot math before going live.

When `--port` is also provided, the port flag is ignored and the HTTP server does not start. A debug-level log line notes the flag was ignored.

`--version` and `-dumpversion` take precedence over `--dry-run` when both are provided.

The startup sequence through preflight validation is identical to a normal run. The dry-run branch diverges after tracker adapter construction — see [startup sequence](#startup-sequence) step 7.

#### Dry-run output

Each candidate issue produces an `INFO`-level log line:

```
level=INFO msg="dry-run: candidate" issue_id=abc123 identifier=MT-649 title="Fix pagination bug" state="To Do" would_dispatch=true global_slots_available=4 state_slots_available=2 priority=1
```

Key fields:

| Field | Description |
|---|---|
| `would_dispatch` | `true` if the issue would be dispatched under current config. `false` with a `skip_reason` when ineligible. |
| `global_slots_available` | Remaining global agent slots at this point in the simulation. |
| `state_slots_available` | Remaining per-state slots for this issue's tracker state. |
| `priority` | Issue priority (present only when the tracker provides it). |
| `ssh_host` | Assigned SSH host (present only when SSH worker mode is configured). |
| `skip_reason` | Reason for ineligibility (present only when `would_dispatch` is `false`). |

A summary line follows all candidates:

```
level=INFO msg="dry-run: complete" candidates_fetched=5 would_dispatch=3 ineligible=2 max_concurrent_agents=4
```

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Dry-run completed. Candidates fetched and evaluated. |
| `1` | Startup failure (same as normal run) or tracker fetch failure. |

### `--log-level`

Sets the minimum log severity emitted to stderr. Accepted values (case-insensitive): `debug`, `info`, `warn`, `error`.

Takes precedence over `logging.level` from the [workflow file](workflow-config.md#logging). When neither the flag nor the workflow field is set, the process logs at `info`.

An unknown value (e.g., `--log-level trace`) prints an error to stderr and exits with code `1`:

```
sortie: unknown log level "trace": accepted values are debug, info, warn, error
```

Applied before the workflow file is loaded, so all startup output — including workflow loading errors — respects the requested level.

### `--port`

Enables the embedded HTTP server on `127.0.0.1:<port>`. All observability surfaces share this port:

- `/` — HTML dashboard ([dashboard reference](dashboard.md))
- `/api/v1/state` — JSON API ([HTTP API reference](http-api.md))
- `/api/v1/<identifier>` — Per-issue detail
- `/api/v1/refresh` — Trigger immediate poll cycle
- `/livez` — Liveness probe
- `/readyz` — Readiness probe
- `/metrics` — Prometheus metrics ([Prometheus metrics reference](prometheus-metrics.md))

Valid range: `0`–`65535`. Port `0` requests an OS-assigned ephemeral port; the actual port appears in the startup log.

Overrides `server.port` from the WORKFLOW.md [`server` extension](workflow-config.md). When neither `--port` nor `server.port` is set, the HTTP server does not start and Prometheus metrics are not collected. The orchestrator runs with a no-op metrics implementation — counters, gauges, and histograms are never recorded.

Invalid values (negative, above 65535) produce an error and exit `1`.

### `--version`

Prints the full version banner to stdout and exits with code `0`:

```
sortie 0.0.9
Copyright (C) 2026 Serghei Iakovlev <oss@serghei.pl>

This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
```

Skips workflow loading, configuration validation, and database initialization. Ignores the `workflow-path` argument when present.

### `-dumpversion`

Prints the version string alone to stdout and exits with code `0`:

```
0.0.9
```

Uses single-dash prefix (GCC convention). Designed for scripts and programmatic version checks.

Takes precedence over `--version` when both are provided.

---

## Subcommands

### `validate`

Checks that a workflow file is loadable, its configuration parses without type errors, required adapter fields are present, and the workspace root is writable. Does not start the orchestrator, open the database, or spawn a filesystem watcher.

```
sortie validate [--format text|json] [workflow-path]
```

The validation pipeline runs the same checks as the main startup path through preflight validation (steps 1–5 of the [startup sequence](#startup-sequence)), then exits. No `.sortie.db` file is created.

#### Validation scope

The pipeline checks:

- Workflow file existence, readability, and YAML syntax.
- Front matter is a YAML map (not a scalar, list, or null).
- Integer-typed fields accept valid integers (type coercion from string and float). Affected fields: `polling.interval_ms`, `agent.turn_timeout_ms`, `agent.read_timeout_ms`, `agent.stall_timeout_ms`, `agent.max_concurrent_agents`, `agent.max_turns`, `agent.max_retry_backoff_ms`, `agent.max_sessions`, `hooks.timeout_ms`.
- `tracker.handoff_state` is a string, is non-empty when present, and does not collide with `active_states` or `terminal_states`.
- `db_path` is a string when present.
- `agent.max_sessions` is non-negative.
- Go `text/template` syntax in the prompt body (strict mode — unknown variables and functions are errors).
- `tracker.kind` is present and maps to a registered adapter.
- `agent.kind` maps to a registered adapter. Defaults to `claude-code` when absent.
- Fields required by the selected adapter: `tracker.api_key`, `tracker.project`, `agent.command`.
- At least one of `tracker.active_states` or `tracker.terminal_states` is non-empty.
- Workspace root directory exists (or can be created) and is writable.

The pipeline does **not** check:

- **Unknown keys.** Unrecognised keys at any level are silently accepted. A misspelled key (e.g., `max_concurent_agents`) is ignored and the default value applies. Top-level keys outside the core schema (`tracker`, `polling`, `workspace`, `hooks`, `agent`, `db_path`) are collected into the extensions map without warning.
- **String field types.** A non-string value for a string-typed field (e.g., `tracker.endpoint: 123`) silently resolves to empty string.
- **List field types.** A non-list value for `active_states` or `terminal_states` silently resolves to an empty list.
- **Sub-section types.** A scalar or list where a map is expected (e.g., `tracker: true`) is treated as an absent section.
- **Value ranges.** Negative values for `polling.interval_ms` or timeout fields are accepted. Zero values are replaced with built-in defaults.
- **Format constraints.** `tracker.endpoint` is not checked for valid URL syntax. Path fields are not checked for existence (except `workspace.root`).

#### Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `workflow-path` | No | `./WORKFLOW.md` | Path to the workflow file. Resolved identically to the main command. |

One positional argument is accepted. Two or more produce an error.

#### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--format` | string | `text` | Output format: `text` or `json`. |

Invalid `--format` values produce an error and exit `1`.

#### Output formats

**Text** (default) — on success, nothing is written and the process exits `0`. On failure, each diagnostic is written to stderr, one per line:

```
tracker.kind: tracker.kind is required
agent_adapter: unknown agent kind "nonexistent"
```

Format: `{check}: {message}`

When the workflow file itself cannot be loaded, a single line is emitted:

```
workflow_load: workflow file not found: /path/to/WORKFLOW.md: ...
```

**JSON** (`--format json`) — a single JSON object is written to stdout on both success and failure:

```json
{"valid":true,"errors":[]}
```

```json
{"valid":false,"errors":[{"check":"tracker.kind","message":"tracker.kind is required"}]}
```

The `errors` array is always present (never `null`). Each element has two fields:

| Field | Type | Description |
|---|---|---|
| `check` | string | Diagnostic category. Matches the check names in [startup and configuration errors](errors.md#startup-and-configuration-errors). |
| `message` | string | Human-readable description. |

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Workflow is valid, or `--help` was requested. |
| `1` | Validation failure, invalid flag, or too many arguments. |

#### Diagnostic check values

The `check` field in JSON output and the prefix in text output use these values:

| Check | Source |
|---|---|
| `workflow_load` | Workflow file missing, unreadable, or unparseable YAML. |
| `workflow_front_matter` | Front matter is not a YAML map. |
| `config.<field>` | Configuration field type or value error (e.g., `config.polling.interval_ms`, `config.tracker.handoff_state`). |
| `template_parse` | Go template syntax error in the prompt body. |
| `tracker.kind` | Missing `tracker.kind` field. |
| `tracker.api_key` | Missing or empty API key after environment variable expansion. |
| `tracker.project` | Missing `tracker.project` when required by the adapter. |
| `tracker_adapter` | Unknown tracker adapter kind. |
| `agent.kind` | Missing `agent.kind` field. |
| `agent.command` | Missing `agent.command` when required by the adapter. |
| `agent_adapter` | Unknown agent adapter kind. |
| `workspace.root_writable` | Workspace root directory does not exist and cannot be created, or is not writable. |
| `args` | Invalid command-line arguments (too many positional args). |

Check values from preflight validation match the [startup and configuration errors](errors.md#startup-and-configuration-errors) table.

---

## Startup sequence

When no version flag is present, Sortie executes these steps in order:

1. **Parse flags.** Unknown flags exit with code `1` and print usage to stderr.
2. **Resolve workflow path.** Relative paths resolve to absolute against the working directory.
3. **Initialize logging.** Structured `key=value` format to stderr. Uses the `--log-level` flag when set; otherwise defaults to `INFO` for the duration of startup.
4. **Load and watch workflow file.** Start a filesystem watcher for dynamic config reload.
5. **Preflight validation.** Verify `tracker.kind` is registered, `agent.kind` is registered, required API keys are present, active/terminal state lists are non-empty, and the workspace root is writable. Failure exits with code `1` — no database file is created on disk.
6. **Resolve log level.** When `--log-level` was not set, check `logging.level` from the workflow config. If the workflow sets a non-default level, re-initialize the logger before emitting the startup message.
7. **Construct tracker adapter.** Instantiate the tracker adapter from the registry using the configuration map.
8. **Open SQLite database.** Path from [`db_path`](workflow-config.md) config field, or `.sortie.db` adjacent to the workflow file. Relative paths resolve against the workflow file's directory, not the working directory.
9. **Run schema migrations.** Applied automatically on every startup.
10. **Load persisted retry entries.** Reconstruct timers from previous session state.
11. **Construct agent adapter.** Instantiate the agent adapter from the registry.
12. **Clean terminal workspaces.** Query tracker for states of existing workspace directories; remove those in terminal states.
13. **Resolve server port.** `--port` flag overrides `server.port` from config.
14. **Start HTTP server.** Binds to `127.0.0.1:<port>` when enabled.
15. **Enter event loop.** First poll tick fires immediately. Blocks until signal.

When `--dry-run` is set, execution diverges after step 7. Steps 8–15 are skipped entirely. Instead, Sortie fetches candidate issues from the tracker, evaluates dispatch eligibility, logs the results, and exits. No database file is created, no agent adapter is constructed, and no HTTP server starts.

Any step that fails prints a diagnostic to stderr and exits with code `1`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (signal received), version output (`--version`, `-dumpversion`), successful `validate`, or successful `--dry-run`. |
| `1` | Startup failure: unknown flag, too many arguments, missing or unreadable workflow file, invalid configuration, preflight validation failure, or database open/migration error. Also used by `validate` for any validation failure and by `--dry-run` when the tracker fetch fails. |

Sortie does not define exit codes above `1`. Agent subprocess failures, tracker errors, and runtime exceptions are handled internally through the retry and reconciliation mechanisms — they do not affect the process exit code.

---

## Signals

| Signal | Behavior |
|---|---|
| `SIGINT` | Initiates graceful shutdown. |
| `SIGTERM` | Initiates graceful shutdown. |

Both signals trigger the same sequence:

1. Stop accepting new dispatches.
2. Cancel all running worker contexts.
3. Wait up to 30 seconds for workers to exit (drain timeout). Worker results are processed through the normal exit handler during drain — run history is persisted and retry entries are recorded.
4. Cancel pending retry timers.
5. Shut down the HTTP server with a 5-second timeout for in-flight responses.
6. Close the SQLite database.
7. Exit with code `0`.

During drain, `/livez` and `/readyz` return `503`, and `POST /api/v1/refresh` returns a rejection instead of `202 Accepted`.

A second signal during drain is not intercepted — the OS terminates the process immediately.

---

## Logging

All log output goes to **stderr** in structured `key=value` format:

```
time=2026-03-26T14:30:01.271+00:00 level=INFO msg="sortie starting" version=0.0.9 workflow_path=/opt/sortie/WORKFLOW.md port=8080
time=2026-03-26T14:30:01.298+00:00 level=INFO msg="database path resolved" db_path=/opt/sortie/.sortie.db
time=2026-03-26T14:30:01.304+00:00 level=INFO msg="sortie started"
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="http server listening" addr=127.0.0.1:8080
```

### Context fields

Different log lines carry different context fields depending on scope:

| Field | Present on |
|---|---|
| `version` | Startup |
| `workflow_path` | Startup |
| `port` | Startup (only when `--port` is provided) |
| `log_level` | Startup (only when the effective level is not `INFO`) |
| `db_path` | Database initialization |
| `issue_id` | Dispatch, worker lifecycle, retry, reconciliation |
| `issue_identifier` | Dispatch, worker lifecycle, retry, reconciliation |
| `session_id` | Agent events, worker lifecycle |
| `error` | Error and warning lines |
| `next_attempt`, `delay_ms` | Retryable worker failures (WARN level) |
| `tool`, `duration_ms`, `result` | Tool call completions |
| `addr` | HTTP server start |

Stdout is used for version output (`--version`, `-dumpversion`) and `validate --format json` diagnostics. All other output goes to stderr.

---

## Version injection

The `Version` variable defaults to `dev` when running from source. Release builds inject the version at compile time via linker flags:

```sh
go build -ldflags "-s -w -X main.Version=0.0.9" -o sortie ./cmd/sortie
```

The Makefile sets this automatically from `git describe --tags`:

```sh
make build    # injects $(git describe --tags --always --dirty)
```

The injected version appears in:

- `--version` and `-dumpversion` output
- The `version` field in startup log lines
- The `sortie_build_info{version="..."}` Prometheus metric
- The HTTP dashboard and `/readyz` response

---

## Files

| File | Location | Purpose |
|---|---|---|
| Workflow file | `workflow-path` argument or `./WORKFLOW.md` | Configuration and prompt template. Watched for changes after startup. |
| SQLite database | [`db_path`](workflow-config.md) or `.sortie.db` next to the workflow file | Run history, retry entries, aggregate metrics, session metadata. Created automatically if absent. |

The database path resolves against the **workflow file's directory**, not the process working directory. A workflow file at `/opt/sortie/WORKFLOW.md` with no `db_path` configured creates `/opt/sortie/.sortie.db` regardless of where `sortie` was launched.

---

## Usage

```sh
# Default workflow file in working directory
sortie

# Explicit workflow path
sortie /opt/sortie/WORKFLOW.md

# Enable HTTP server on port 8080
sortie --port 8080

# Run with verbose debug output
sortie --log-level debug

# Combine path, port, and log level
sortie --log-level debug --port 8080 /opt/sortie/WORKFLOW.md

# Print full version banner
sortie --version

# Print bare version string (for scripts)
sortie -dumpversion

# Validate the default workflow file
sortie validate

# Validate a specific file
sortie validate /opt/sortie/WORKFLOW.md

# Validate with JSON output (for CI pipelines)
sortie validate --format json ./WORKFLOW.md

# Dry-run: verify tracker connectivity and dispatch math without starting agents
sortie --dry-run

# Dry-run with explicit workflow path
sortie --dry-run /opt/sortie/WORKFLOW.md

# Dry-run with debug output for full candidate detail
sortie --dry-run --log-level debug

# Help text
sortie --help
```

---

## See also

- [WORKFLOW.md configuration reference](workflow-config.md) — all config fields
- [Environment variables reference](environment.md) — agent runtime vars, `$VAR` indirection, hook env
- [HTTP API reference](http-api.md) — JSON API endpoints and response shapes
- [Dashboard reference](dashboard.md) — built-in HTML monitoring dashboard
- [Prometheus metrics reference](prometheus-metrics.md) — metric names, types, labels, and PromQL examples
