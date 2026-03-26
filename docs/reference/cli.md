---
title: CLI Reference | Sortie
description: Complete reference for the sortie command-line interface. Synopsis, flags, arguments, exit codes, signals, startup sequence, logging format, and version injection.
keywords: sortie CLI, command line, flags, arguments, exit codes, signals, graceful shutdown, logging, version
author: Sortie AI
---

# CLI reference

## Synopsis

```
sortie [flags] [workflow-path]
```

Sortie runs as a long-lived process. It loads the [workflow file](workflow-config.md), opens the SQLite database, validates configuration, and enters the poll-dispatch-reconcile event loop. The process blocks until terminated by a signal.

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
| `--port` | integer | _(unset)_ | HTTP server listen port. Enables the embedded HTTP server when provided. |
| `--version` | boolean | `false` | Print the version banner with copyright notice, then exit. |
| `-dumpversion` | boolean | `false` | Print the bare version string (e.g., `0.0.8`), then exit. |

### `--port`

Enables the embedded HTTP server on `127.0.0.1:<port>`. All observability surfaces share this port:

- `/` — HTML dashboard
- `/api/v1/state` — JSON API ([HTTP API reference](http-api.md))
- `/api/v1/<identifier>` — Per-issue detail
- `/api/v1/refresh` — Trigger immediate poll cycle
- `/livez` — Liveness probe
- `/readyz` — Readiness probe
- `/metrics` — Prometheus metrics ([Prometheus metrics reference](prometheus-metrics.md))

Valid range: `0`–`65535`. Port `0` requests an OS-assigned ephemeral port; the actual port appears in the startup log.

Overrides `server.port` from the WORKFLOW.md [`server` extension](workflow-config.md). When neither `--port` nor `server.port` is set, the HTTP server does not start.

Invalid values (negative, above 65535) produce an error and exit `1`.

### `--version`

Prints the full version banner to stdout and exits with code `0`:

```
sortie 0.0.8
Copyright (C) 2026 Serghei Iakovlev <oss@serghei.pl>

This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
```

Skips workflow loading, configuration validation, and database initialization. Ignores the `workflow-path` argument when present.

### `-dumpversion`

Prints the version string alone to stdout and exits with code `0`:

```
0.0.8
```

Uses single-dash prefix (GCC convention). Designed for scripts and programmatic version checks.

Takes precedence over `--version` when both are provided.

---

## Startup sequence

When no version flag is present, Sortie executes these steps in order:

1. **Parse flags.** Unknown flags exit with code `1` and print usage to stderr.
2. **Resolve workflow path.** Relative paths resolve to absolute against the working directory.
3. **Initialize logging.** Structured `key=value` format to stderr at `INFO` level.
4. **Load and watch workflow file.** Start a filesystem watcher for dynamic config reload.
5. **Preflight validation.** Verify `tracker.kind` is registered, `agent.kind` is registered, required API keys are present, and active/terminal state lists are non-empty. Failure exits with code `1` — no database file is created on disk.
6. **Open SQLite database.** Path from [`db_path`](workflow-config.md) config field, or `.sortie.db` adjacent to the workflow file. Relative paths resolve against the workflow file's directory, not the working directory.
7. **Run schema migrations.** Applied automatically on every startup.
8. **Load persisted retry entries.** Reconstruct timers from previous session state.
9. **Construct adapters.** Instantiate tracker and agent adapters from the registry using the configuration map.
10. **Clean terminal workspaces.** Query tracker for states of existing workspace directories; remove those in terminal states.
11. **Resolve server port.** `--port` flag overrides `server.port` from config.
12. **Start HTTP server.** Binds to `127.0.0.1:<port>` when enabled.
13. **Enter event loop.** First poll tick fires immediately. Blocks until signal.

Any step that fails prints a diagnostic to stderr and exits with code `1`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (signal received) or version output (`--version`, `-dumpversion`). |
| `1` | Startup failure: unknown flag, too many arguments, missing or unreadable workflow file, invalid configuration, preflight validation failure, or database open/migration error. |

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
time=2026-03-26T14:30:01.271+00:00 level=INFO msg="sortie starting" version=0.0.8 workflow_path=/opt/sortie/WORKFLOW.md port=8080
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
| `db_path` | Database initialization |
| `issue_id` | Dispatch, worker lifecycle, retry, reconciliation |
| `issue_identifier` | Dispatch, worker lifecycle, retry, reconciliation |
| `session_id` | Agent events, worker lifecycle |
| `error` | Error and warning lines |
| `next_attempt`, `delay_ms` | Retryable worker failures (WARN level) |
| `tool`, `duration_ms`, `result` | Tool call completions |
| `addr` | HTTP server start |

Stdout is used only for version output (`--version`, `-dumpversion`). All other output goes to stderr.

---

## Version injection

The `Version` variable defaults to `dev` when running from source. Release builds inject the version at compile time via linker flags:

```sh
go build -ldflags "-s -w -X main.Version=0.0.8" -o sortie ./cmd/sortie
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

# Combine explicit path and port
sortie --port 8080 /opt/sortie/WORKFLOW.md

# Print full version banner
sortie --version

# Print bare version string (for scripts)
sortie -dumpversion

# Help text
sortie --help
```

---

## See also

- [WORKFLOW.md configuration reference](workflow-config.md) — all config fields
- [Environment variables reference](environment.md) — agent runtime vars, `$VAR` indirection, hook env
- [HTTP API reference](http-api.md) — JSON API endpoints and response shapes
- [Prometheus metrics reference](prometheus-metrics.md) — metric names, types, labels, and PromQL examples
