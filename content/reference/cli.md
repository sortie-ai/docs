---
title: CLI Reference
linkTitle: "CLI Usage"
description: "Complete reference for the sortie CLI: subcommands, flags, short aliases, dry-run mode, run statistics, MCP server, exit codes, signals, and logging format."
author: Sortie AI
date: 2026-04-26
weight: 10
url: /reference/cli/
---
## Synopsis

```
sortie [flags] [workflow-path]
sortie <command> [flags]
sortie --dry-run [--log-level level] [workflow-path]
sortie --log-format json [flags] [workflow-path]
sortie --env-file path [flags] [workflow-path]
sortie validate [--format text|json] [workflow-path]
sortie stats [--format text|json] [--since value] [--until value] [workflow-path]
sortie mcp-server --workflow <path>
sortie -h | --help
sortie -V | --version
```

Without a subcommand, Sortie runs as a long-lived process. It loads the [workflow file](/reference/workflow-config/), opens the SQLite database, validates configuration, and enters the poll-dispatch-reconcile event loop. The process blocks until terminated by a signal.

The `validate` subcommand checks the workflow file without starting the orchestrator. The `stats` subcommand summarizes past runs from the local database and exits, reading that database read-only rather than starting the orchestrator. The `mcp-server` subcommand starts an MCP stdio server for agent tool execution. See [Subcommands](#subcommands).

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
| `-h`, `--help` | boolean | `false` | Print the help message and exit. |
| `-V`, `--version` | boolean | `false` | Print the version banner, then exit. |
| `-dumpversion` | boolean | `false` | Print the bare version string (e.g., `1.14.0`), then exit. |
| `--dry-run` | boolean | `false` | Run one poll cycle without spawning agents or writing to the database, then exit. |
| `--env-file` | string | _(empty)_ | Path to a `.env` file containing `SORTIE_*` overrides. See [environment variables reference](/reference/environment/#env-file-support). |
| `--log-format` | string | `text` | Log output format. Accepted values: `text`, `json`. |
| `--log-level` | string | `info` | Log verbosity. Accepted values: `debug`, `info`, `warn`, `error`. |
| `--port` | integer | `7678` | HTTP server listen port. `0` disables the server. |
| `--host` | string | `127.0.0.1` | HTTP server bind address. Must be a parseable IP address. |

### `--dry-run`

Runs a single poll cycle in read-only mode, then exits. Sortie connects to the tracker, fetches candidate issues, computes dispatch eligibility for each candidate, and logs the results. No agents are spawned, no SQLite database is opened, and no state is written.

This fills the gap between `sortie validate` (offline config checks) and a full `sortie` run (live operation). Use it to verify tracker connectivity, query results, and concurrency slot math before going live.

The `--dry-run` flag suppresses server startup regardless of port or host settings.

`--version` (or `-V`) and `-dumpversion` take precedence over `--dry-run` when both are provided.

The startup sequence through preflight validation is identical to a normal run. The dry-run branch diverges after tracker adapter construction - see [startup sequence](#startup-sequence) step 7.

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

Takes precedence over `logging.level` from the [workflow file](/reference/workflow-config/#logging). When neither the flag nor the workflow field is set, the process logs at `info`.

An unknown value (e.g., `--log-level trace`) prints an error to stderr and exits with code `1`:

```
sortie: unknown log level "trace": accepted values are debug, info, warn, error
```

Applied before the workflow file is loaded, so all startup output - including workflow loading errors - respects the requested level.

### `--log-format`

Sets the log output format. Accepted values (case-insensitive): `text`, `json`. Default: `text`.

When `text` is active (the default), Sortie emits structured `key=value` lines via `slog.TextHandler`:

```
time=2026-04-07T14:30:00.000+00:00 level=INFO msg="sortie starting" version=1.14.0
```

When `json` is active, each log line is a single JSON object via `slog.JSONHandler`:

```json
{"time":"2026-04-07T14:30:00.000Z","level":"INFO","msg":"sortie starting","version":"1.14.0"}
```

JSON format is intended for containerized and cloud-native deployments where log aggregation systems (Loki, Datadog, CloudWatch, ELK) expect newline-delimited JSON on stdout/stderr.

Takes precedence over `logging.format` from the [workflow file](/reference/workflow-config/#logging). When neither the flag nor the workflow field is set, the process uses `text`.

An unknown value (e.g., `--log-format yaml`) prints an error to stderr and exits with code `1`:

```
sortie: unknown log format "yaml": accepted values are text, json
```

Applied before the workflow file is loaded, so all startup output uses the requested format immediately. Both `--log-format` and `--log-level` can be combined freely - any combination works.

### `--env-file`

Loads `SORTIE_*` variables from a file as [configuration overrides](/reference/environment/#configuration-overrides).

```sh
sortie --env-file /etc/sortie/prod.env WORKFLOW.md
```

Takes a file path argument. Only keys prefixed with `SORTIE_` are read from the file; all others are ignored. The file format is `KEY=VALUE` with `#` comments, optional quotes, and no variable interpolation.

Real environment variables take precedence over `.env` values. When both `--env-file` and the `SORTIE_ENV_FILE` environment variable are set, the flag wins.

When `--env-file` is provided, the CLI resolves the path to absolute and exports it as `SORTIE_ENV_FILE` in the process environment. This allows `CollectSortieEnv` to propagate the path to the MCP server via the [config env block](/reference/environment/#mcp-server-environment), so the MCP server can locate and load the `.env` file to resolve credential `$VAR` indirection. The absolute resolution is necessary because the MCP server's working directory (the per-issue workspace) differs from the orchestrator's.

The file is re-read on every WORKFLOW.md reload (file change detection). If the file does not exist at load time, a warning is logged and loading continues without it.

### `--port`

Sets the listening port for the embedded HTTP server. The server starts by default on port `7678`. All observability surfaces share this port:

- `/` - HTML dashboard ([dashboard reference](/reference/dashboard/))
- `/api/v1/state` - JSON API ([HTTP API reference](/reference/http-api/))
- `/api/v1/<identifier>` - Per-issue detail
- `/api/v1/refresh` - Trigger immediate poll cycle
- `/livez` - Liveness probe
- `/readyz` - Readiness probe
- `/metrics` - Prometheus metrics ([Prometheus metrics reference](/reference/prometheus-metrics/))

Valid range: `1`–`65535`, or `0` to disable. Port `0` disables the server entirely - no TCP listener, no Prometheus metrics. The orchestrator runs with a no-op metrics implementation.

Overrides `server.port` from the WORKFLOW.md [`server` extension](/reference/workflow-config/). When the default port (`7678`) is already occupied and the operator did not explicitly request a port, Sortie logs a warning and starts without the HTTP server. When the operator explicitly requested a port (via `--port` or `server.port`) and it is already in use, Sortie exits with code `1`.

Invalid values (negative, above 65535) produce an error and exit `1`.

### `--host`

Sets the bind address for the embedded HTTP server. Default: `127.0.0.1` (loopback only).

Must be a parseable IP address. DNS hostnames are not accepted. Container deployments that need inbound connections from the container network use `0.0.0.0`.

Overrides `server.host` from the WORKFLOW.md [`server` extension](/reference/workflow-config/). Requires a restart to take effect.

### `-h`, `--help`

Prints the help message to stdout and exits with code `0`. The short form `-h` is an alias for `--help`.

Help output is organized into sections: commands, informational flags, run options, examples, and a "Learn more" link. Subcommands have their own help text: `sortie validate -h`, `sortie stats -h`, and `sortie mcp-server -h` print subcommand-specific help.

Help is printed to **stdout**, not stderr. This follows GNU convention - help is useful content, not error diagnostics. Piping works as expected: `sortie -h | less`.

The Go `flag` package also recognizes `-help` (single-dash long form) and treats it identically to `--help`.

### `-V`, `--version`

Prints the full version banner to stdout and exits with code `0`. The short form `-V` is an alias for `--version`.

```
sortie 1.14.0 (commit: 0651d1f, built: 2026-07-11, go1.26.1, linux/amd64)
```

The banner includes the Git commit SHA (first 7 characters), build date, Go toolchain version, and target platform. Actual values vary at build time. Development builds without release tags show `dev` as the version.

Skips workflow loading, configuration validation, and database initialization. Ignores the `workflow-path` argument when present.

### `-dumpversion`

Prints the version string alone to stdout and exits with code `0`:

```
1.14.0
```

Uses single-dash prefix (GCC convention). Designed for scripts and programmatic version checks.

Takes precedence over `--version` when both are provided. `-V` is intercepted before flag parsing, so if both `-V` and `-dumpversion` appear, `-V` wins.

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
- `tracker.in_progress_state` is a member of `active_states` when present, and does not collide with `terminal_states` or `handoff_state`.
- `db_path` is a string when present.
- `agent.max_sessions` is non-negative.
- Go `text/template` syntax in the prompt body (strict mode - unknown variables and functions are errors).
- Template static analysis: dot-context misuse inside `{{ range }}` / `{{ with }}`, unknown top-level variables, and unknown sub-fields of known variables (advisory warnings).
- `tracker.kind` is present and maps to a registered adapter.
- `agent.kind` maps to a registered adapter. Defaults to `claude-code` when absent.
- Fields required by the selected adapter: `tracker.api_key`, `tracker.project`, `agent.command`.
- At least one of `tracker.active_states` or `tracker.terminal_states` is non-empty.
- Adapter-specific config validation. When the registered tracker adapter declares a `ValidateTrackerConfig` callback, the pipeline invokes it with the extracted tracker config fields. Adapter validation runs after the generic preflight checks and can produce both errors (block validity) and warnings (advisory). See [GitHub adapter validation](/reference/adapter-github/#validate-time-checks) for the checks the GitHub adapter performs.
- Workspace root directory exists (or can be created) and is writable.

The pipeline does **not** check:

- **Value ranges.** Negative values for `polling.interval_ms` or timeout fields are accepted. Zero values are replaced with built-in defaults.
- **Format constraints.** `tracker.endpoint` is not checked for valid URL syntax. Path fields are not checked for existence (except `workspace.root`).

#### Advisory warnings

Beyond the error-level checks above, `validate` runs static analysis on the front matter and the prompt template, emitting **warnings** for likely-wrong patterns. Warnings do not block validity - `valid` remains `true` and the exit code is `0` when only warnings are present. Runtime behavior is unchanged; warnings surface patterns that the orchestrator would silently accept or that would produce unexpected output.

Six warning classes across two analysis passes, plus adapter-specific warnings when the tracker adapter declares config validation (see [adapter-specific warning check values](#adapter-specific-warning-check-values)):

**Front matter analysis:**

- **Unknown top-level keys** (`unknown_key`). A top-level YAML key that is not a core section (`tracker`, `polling`, `workspace`, `hooks`, `agent`, `db_path`, `ci_feedback`, `self_review`, `reactions`, `dispatch`, `notifications`), not a recognized extension (`server`, `logging`, `worker`), and not the adapter pass-through block matching the configured `tracker.kind` or `agent.kind`. Catches typos like `trackers:` instead of `tracker:`.
- **Unknown sub-keys** (`unknown_sub_key`). A key inside a known section that does not match any defined field. For example, `tracker.typo_endpoint` or `hooks.before_launch`. Sub-objects named after the section's adapter kind are exempt (e.g., `tracker.jira` when `tracker.kind` is `jira`).
- **Type mismatches** (`type_mismatch`). A value whose YAML type does not match the expected type for a field. For example, `hooks.timeout_ms: "not-a-number"` or `tracker.kind: 123`. Also covers semantic issues: a non-positive `hooks.timeout_ms` that falls back to the default, and non-numeric or non-positive entries in `agent.max_concurrent_agents_by_state` that are silently ignored at runtime.

**Template static analysis:**

- **Dot-context misuse** (`dot_context`). A reference to a top-level data key (`.issue`, `.attempt`, `.run`) inside a `{{ range }}` or `{{ with }}` block where the dot has been redefined. Almost always a bug - use the `$` prefix (`$.issue.title`) to reach root data from inside these blocks.
- **Unknown template variable** (`unknown_var`). A top-level variable reference not in the template data contract. For example, `{{ .config }}` or `{{ $.settings }}`. Valid top-level variables are `.issue`, `.attempt`, and `.run`.
- **Unknown sub-field** (`unknown_field`). A sub-field of a known top-level variable that does not exist in the domain schema. For example, `{{ .run.foo }}` or `{{ .issue.nonexistent }}`. Also flags sub-field access on scalar variables like `{{ .attempt.something }}`.

#### Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `workflow-path` | No | `./WORKFLOW.md` | Path to the workflow file. Resolved identically to the main command. |

One positional argument is accepted. Two or more produce an error.

#### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--format` | string | `text` | Output format: `text` or `json`. |
| `-h`, `--help` | boolean | `false` | Print the validate help message and exit. |

Invalid `--format` values produce an error and exit `1`.

#### Output formats

**Text** (default) - each diagnostic is written to stderr, one per line, prefixed with its severity:

```
error: tracker.kind: tracker.kind is required
error: agent_adapter: unknown agent kind "nonexistent"
```

Format: `{severity}: {check}: {message}`

Warning-only output (exit `0`):

```
warning: unknown_key: unknown top-level key "trackers"
warning: dot_context: did you mean "$.issue.title" instead of ".issue.title"? Inside a {{ range }}/{{ with }} block (including arguments to nested range/with), dot refers to the current element, not root data
warning: unknown_var: unknown template variable ".config"; valid top-level variables are: .issue, .attempt, .run
warning: unknown_field: unknown field ".run.foo"; known fields: is_continuation, max_turns, turn_number
```

When no errors and no warnings are present, nothing is written.

When the workflow file itself cannot be loaded, a single error line is emitted:

```
error: workflow_load: workflow file not found: /path/to/WORKFLOW.md: ...
```

**JSON** (`--format json`) - a single JSON object is written to stdout on both success and failure:

```json
{"valid":true,"errors":[],"warnings":[]}
```

```json
{"valid":false,"errors":[{"severity":"error","check":"tracker.kind","message":"tracker.kind is required"}],"warnings":[]}
```

With warnings only:

```json
{"valid":true,"errors":[],"warnings":[{"severity":"warning","check":"unknown_key","message":"unknown top-level key \"trackers\""}]}
```

The `errors` and `warnings` arrays are always present (never `null`). `valid` is `true` when `errors` is empty, regardless of warnings. Each diagnostic element has three fields:

| Field | Type | Description |
|---|---|---|
| `severity` | string | `"error"` or `"warning"`. Redundant with array membership but useful when consumers flatten the arrays. |
| `check` | string | Diagnostic category. Error checks match the [startup and configuration errors](/reference/errors/#startup-and-configuration-errors) table. Warning checks are listed under [advisory warning check values](#advisory-warning-check-values). |
| `message` | string | Human-readable description. |

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Workflow is valid (warnings may be present), or `-h`/`--help` was requested. |
| `1` | One or more errors, invalid flag, or too many arguments. |

#### Diagnostic check values

The `check` field in JSON output and the prefix in text output use these values:

| Check | Source |
|---|---|
| `workflow_load` | Workflow file missing, unreadable, or unparseable YAML. |
| `workflow_front_matter` | Front matter is not a YAML map. |
| `config.<field>` | Configuration field type or value error (e.g., `config.polling.interval_ms`, `config.tracker.handoff_state`). |
| `config.workspace.retention_days` | Workspace retention window is not an integer, is negative, or is non-zero but below the accepted minimum. |
| `reactions.merge_completion` | Invalid `reactions.merge_completion` block: a missing or colliding `target_state`, a required `tracker` field left unset, or a `poll_interval_ms` below the floor. |
| `reactions.scm_provider_conflict` | The `reactions.merge_completion` provider disagrees with the provider of another active SCM reaction. |
| `template_parse` | Go template syntax error in the prompt body. |
| `tracker.kind` | Missing `tracker.kind` field. |
| `tracker.api_key` | Missing or empty API key after environment variable expansion. |
| `tracker.project` | Missing `tracker.project` when required by the adapter. |
| `tracker_adapter` | Unknown tracker adapter kind. |
| `agent.kind` | Missing `agent.kind` field. |
| `agent.command` | Missing `agent.command` when required by the adapter. |
| `agent_adapter` | Unknown agent adapter kind. |
| `tracker.project.format` | `tracker.project` is non-empty but not in `owner/repo` format (GitHub adapter). |
| `workspace.root_writable` | Workspace root directory does not exist and cannot be created, or is not writable. |
| `args` | Invalid command-line arguments (too many positional args). |

Check values from preflight validation match the [startup and configuration errors](/reference/errors/#startup-and-configuration-errors) table. Adapter-specific error checks (e.g., `tracker.project.format`) are produced by the registered adapter's validation callback.

#### Advisory warning check values

Warning diagnostics use a separate set of check values. They appear only in the `warnings` array (JSON) or with the `warning:` prefix (text). They do not affect `valid` or the exit code.

| Check | Meaning |
|---|---|
| `unknown_key` | Unrecognized top-level YAML key. Likely a typo (e.g., `trackers` instead of `tracker`). |
| `unknown_sub_key` | Unrecognized key inside a known section (e.g., `tracker.typo_endpoint`). Adapter pass-through sub-objects matching the configured `kind` are exempt. |
| `type_mismatch` | Value type does not match the expected type for the field (e.g., string where integer is expected). Also covers semantic issues: non-positive `hooks.timeout_ms`, non-numeric or non-positive values in `agent.max_concurrent_agents_by_state`. |
| `dot_context` | Reference to a top-level data key (`.issue`, `.attempt`, `.run`) inside a `{{ range }}` or `{{ with }}` block where dot is the current element, not root data. Use `$` prefix to fix. |
| `unknown_var` | Top-level template variable not in the data contract. Valid variables: `.issue`, `.attempt`, `.run`. |
| `unknown_field` | Sub-field of a known top-level variable that does not exist in the domain schema (e.g., `.issue.nonexistent`, `.run.foo`). |

#### Adapter-specific warning check values

When the tracker adapter declares a config validation callback, it can produce additional warnings. These appear alongside the advisory warnings above and follow the same rules: they do not affect `valid` or the exit code.

The GitHub adapter (`tracker.kind: github`) produces these warning checks:

| Check | Meaning |
|---|---|
| `tracker.api_key.github_token_hint` | `tracker.api_key` is empty but the `GITHUB_TOKEN` environment variable is set. Consider using `api_key: $GITHUB_TOKEN`. |
| `tracker.api_key.github_token_missing` | `tracker.api_key` is empty and `GITHUB_TOKEN` is not set. |
| `tracker.active_states.empty_element` | An element in `active_states` is empty or whitespace-only. |
| `tracker.terminal_states.empty_element` | An element in `terminal_states` is empty or whitespace-only. |
| `tracker.states.overlap` | A label appears in both `active_states` and `terminal_states` (case-insensitive). |

State collisions involving `handoff_state` or `in_progress_state` are not warnings. The generic configuration layer rejects them for every `tracker.kind` before adapter validation runs, and they are reported under the `config.tracker.handoff_state` and `config.tracker.in_progress_state` check values with exit code `1`.

For details on each check, see [GitHub adapter validate-time checks](/reference/adapter-github/#validate-time-checks).

### `stats`

Reports how past runs went and what they cost. Sortie appends one row to `run_history` each time an agent session finishes; `stats` reads that history back over a time range and aggregates it into run counts, success rate, duration percentiles, turns, token sums, and derived cost, broken down by outcome, by coding agent, by dispatch rule, and by prompt template. The database is opened read-only, so the command is safe to run while the orchestrator is working, and it makes no network call.

```
sortie stats [--format text|json] [--since value] [--until value] [workflow-path]
```

The workflow file supplies two things: `db_path`, which locates the database, and [`token_rates`](/reference/workflow-config/#token_rates), which prices the recorded token counts. The command reads those, opens the database read-only, writes the report, and exits. It does not start the orchestrator, apply migrations, spawn agents, or write anything.

#### Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `workflow-path` | No | `./WORKFLOW.md` | Path to the workflow file. Resolved identically to the main command. |

One positional argument is accepted. Two or more produce an error: `sortie stats: too many arguments`.

#### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--format` | string | `text` | Output format: `text` or `json`. |
| `--since` | string | _(no limit)_ | Count only runs that finished at or after this point. |
| `--until` | string | _(no limit)_ | Count only runs that finished before this point. |
| `-h`, `--help` | boolean | `false` | Print the stats help message and exit. |

An invalid `--format` value produces an error and exit `1`:

```
sortie stats: invalid --format value "xml": must be "text" or "json"
```

##### Range bounds

`--since` and `--until` each accept one of three forms:

| Form | Example | Meaning |
|---|---|---|
| RFC3339 timestamp | `2026-07-01T00:00:00Z` | That exact instant. |
| Calendar date | `2026-07-01` | `00:00:00Z` on that date. |
| Positive Go duration | `24h`, `90m`, `45s` | That much time before now. |

Both bounds normalize to UTC. The filter is on **completion** time, not start time, and the range is half-open: `--since` is inclusive, `--until` is exclusive. A run that finished at exactly the `--since` instant is counted; a run that finished at exactly the `--until` instant is not. Omitting both covers every run on record.

`--since` must be strictly before `--until`:

```
sortie stats: --since must be strictly before --until
```

A zero or negative duration is a usage error, as is any value that matches none of the three forms:

```
sortie stats: --since: invalid range bound "nonsense": accepts an RFC3339 timestamp (2026-07-01T00:00:00Z), a date (2026-07-01), or a positive duration (24h)
```

Both messages exit `1`.

#### Schema tiers

Which figures a report can carry depends on the database it reads, not on the version of the binary reading it. The command inspects the live `run_history` column set and reports the result as `schema_tier`. There are exactly two values.

**`full`** - the table carries all four optional column groups:

| Group | Columns | Figures it supplies |
|---|---|---|
| Turns | `turns_completed` | Mean turns, in the summary and in every breakdown row |
| Self-review | `review_metadata` | The self-review section |
| Dispatch-rule routing | `rule_name`, `template_id` | The dispatch-rule and prompt-template breakdowns |
| Tokens | `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens` | Token sums and every derived cost figure |

**`base`** - at least one group is missing. The report falls back to run counts, the outcome breakdown, the coding-agent breakdown, and durations. Turns, tokens, cost, the dispatch-rule breakdown, the prompt-template breakdown, and the self-review section are all left out.

The tier is all-or-nothing by design. A database carrying three of the four groups still reports `base`, and the report then drops the groups it does carry along with the ones it never recorded. The warning names both lists so the two are not confused:

```
warning: this database was written before sortie recorded dispatch-rule routing, tokens and cost. The report falls back to run counts and durations, so it also leaves out turns, self-review results, which this database does carry. Run sortie once with this workflow to get the full report.
```

A degraded report is still a report: the warning goes to stderr in text mode and into `warnings` in JSON, and the exit code is `0`. In JSON, `by_rule` and `by_template` are empty arrays, `self_review` is `null`, and every figure the tier cannot supply is `null` rather than `0`. A null means the database never recorded that figure, not that the figure measured zero.

The remedy is to run the orchestrator once with this workflow. Startup applies the pending migrations, and runs recorded from then on carry the full set. `stats` cannot do this itself; its read-only connection cannot apply a migration.

When `run_history` is absent altogether, or missing any of `status`, `agent_adapter`, `started_at`, or `completed_at`, the file is not a Sortie database and the command exits `1`:

```
sortie stats: run_history table not found or missing base columns
```

#### Output formats

Both formats carry the same figures. Breakdown rows are sorted by descending run count, with ties broken by ascending name. A run that recorded no dispatch rule or prompt template appears under the sentinel name `<none>`, which also covers an empty agent adapter. Rounding is fixed so repeated runs over the same data produce identical output: rates and shares to four decimals, cost and mean turns to two, mean duration to one.

The summary's duration and mean-turn figures cover **succeeded runs only**, so they describe the work that landed rather than the volume attempted. Token sums cover all runs in the range. A run counts as succeeded when its status is exactly `succeeded`. Cost is never stored; it is derived at report time from the token counts and the configured rates. See [control agent costs](/guides/control-costs/#monitor-spending) for where this fits among the other cost surfaces.

**Text** (default) - the report is written to stdout. Warnings are written to stderr, after a blank line, one per line, each prefixed `warning: `. The two streams can be redirected independently.

The report opens with four header lines (`workflow:`, `database:`, `covering:`, `generated:`), then the summary block, then one table per breakdown, then any footnotes. Column headers are upper-cased, rows are indented two spaces, and a nullable figure with no value renders as `-`.

```
workflow:  /srv/sortie/WORKFLOW.md
database:  /srv/sortie/.sortie.db
covering:  2026-07-01T00:00:00Z until 2026-08-01T00:00:00Z
generated: 2026-08-09T07:51:43Z

runs 9   succeeded 7 (77.8%)
duration (succeeded)    p50 2m 49s   p95 7m 12s   mean 3m 34s   samples 7
turns (succeeded)       3.3
tokens (all runs)       input 502,900   output 96,000   total 598,900   cache read 12,638,000
cost (all runs)         $6.49   per succeeded run $0.93

by outcome
  OUTCOME    RUNS  SHARE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  succeeded  7     77.8%  2m 49s  7m 12s  3m 34s  3.3    408,900       $4.59
  failed     2     22.2%  6m 0s   9m 40s  7m 50s  5.5    190,000       $1.90

by coding agent
  AGENT        RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  claude-code  6     5          83.3%         2m 41s  9m 40s  4m 32s  3.3    388,400       $5.72
  codex        3     2          66.7%         4m 10s  6m 0s   4m 30s  4.7    210,500       $0.77

by dispatch rule
  RULE     RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  bugfix   4     4          100.0%        2m 30s  2m 49s  2m 35s  2.5    172,800       $2.54
  <none>   3     2          66.7%         4m 10s  6m 0s   4m 30s  4.7    210,500       $0.77
  feature  2     1          50.0%         7m 12s  9m 40s  8m 26s  5.0    215,600       $3.18

by prompt template
  TEMPLATE           RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  <none>             5     3          60.0%         6m 0s   9m 40s  6m 4s   4.8    426,100       $3.95
  prompts/bugfix.md  4     4          100.0%        2m 30s  2m 49s  2m 35s  2.5    172,800       $2.54

self review
  runs reviewed 6   iterate 1   pass 5   hit iteration cap 1   mean iterations 1.50
```

The outcome table shows `SHARE`, a group's runs over total runs. Every other breakdown shows `SUCCEEDED` and `SUCCESS RATE`, a group's succeeded runs over its own. On the `base` tier the `TURNS`, `TOTAL TOKENS`, and `COST` columns are absent entirely, and the dispatch-rule, prompt-template, and self-review sections do not appear.

The `covering:` line is prose rather than a sentinel. It reads `every run on record` when neither bound was given, `<since> onward` with only `--since`, `the start of the record until <until>` with only `--until`, and `<since> until <until>` with both.

When the workflow sets no `token_rates`, token counts are still reported and the cost line is replaced:

```
cost                    not estimated; set token_rates in the workflow to price these runs
```

Three disclosure counters each add a footnote below the tables when they are not zero:

```
note: 2 of these runs took no measurable time. A run that a CI result closed out carries the same start and finish time.
note: the duration figures skip 1 of these runs, whose recorded start and finish times were unusable.
note: the cost figures skip 3 of these runs, because token_rates has no price for the coding agent behind them.
```

A range that matches no runs is a success, not a failure. The header still prints, one of two lines follows, and the exit code is `0`:

```
No runs on record yet. sortie adds one each time an agent session finishes.
```

```
No runs finished in this range.
```

The first appears when neither bound was given, the second when at least one was.

**JSON** (`--format json`) - a single document is written to stdout, compact and on one line, terminated by a newline. Every array field is always present and never `null`. Every scalar figure the report cannot supply is `null`. For piping the document into your own metrics store, see [aggregate metrics across instances](/guides/aggregate-metrics-across-instances/).

Envelope:

| Field | Type | Description |
|---|---|---|
| `generated_at` | string | RFC3339 UTC timestamp of when the report was produced. |
| `workflow_path` | string | Absolute path to the workflow file that was read. |
| `db_path` | string | Absolute path to the database the figures came from. |
| `since` | string or null | The `--since` bound, RFC3339 UTC. `null` when the flag was omitted, meaning the range is open at the start. |
| `until` | string or null | The `--until` bound, RFC3339 UTC. `null` when the flag was omitted, meaning the range is open at the end. |
| `schema_tier` | string | `"full"` or `"base"`. See [schema tiers](#schema-tiers). |
| `warnings` | array of string | Advisory messages: a degraded schema, or a malformed `token_rates` block. Empty when there is nothing to report, never `null`. The `warning: ` prefix belongs to text rendering and is not part of these strings. |
| `summary` | object | Report-wide figures. Always present. |
| `by_status` | array of object | Breakdown by outcome. |
| `by_adapter` | array of object | Breakdown by coding agent. |
| `by_rule` | array of object | Breakdown by dispatch rule. Empty array on the `base` tier. |
| `by_template` | array of object | Breakdown by prompt template. Empty array on the `base` tier. |
| `self_review` | object or null | Self-review aggregation. `null` on the `base` tier, meaning the results were not read, not that no review ran. |

`summary`:

| Field | Type | Description |
|---|---|---|
| `runs` | integer | Runs that finished in the range. |
| `succeeded` | integer | Runs whose status is exactly `succeeded`. |
| `success_rate` | number | `succeeded` over `runs`, between 0 and 1. `0` when `runs` is `0`. |
| `duration_seconds` | object | Duration figures over succeeded runs only. |
| `mean_turns_succeeded` | number or null | Mean turns completed over succeeded runs. `null` on the `base` tier and when no run succeeded, never `0` in either case. |
| `tokens` | object or null | Token sums over all runs in the range. `null` on the `base` tier. |
| `cost_usd` | number or null | Estimated cost over every priced run in the range. `null` on the `base` tier and when no run could be priced, never `0` in either case. |
| `cost_per_succeeded_run_usd` | number or null | `cost_usd` divided by `succeeded`. `null` whenever `cost_usd` is `null`, and when no run succeeded. |
| `zero_duration_runs` | integer | Runs that took no measurable time. A run that a CI result closed out carries the same start and finish time. |
| `duration_excluded_runs` | integer | Runs left out of every duration figure because their stored timestamps could not be parsed or ran backwards. |
| `cost_unpriced_runs` | integer | Runs left out of the cost figures because `token_rates` has no entry for their coding agent. |

Each element of `by_status`, `by_adapter`, `by_rule`, and `by_template`:

| Field | Type | Description |
|---|---|---|
| `name` | string | The group: an outcome, an agent adapter kind, a dispatch rule name, or a template identifier. A run that recorded none carries the sentinel `<none>`. |
| `runs` | integer | Runs in this group. |
| `succeeded` | integer | Succeeded runs in this group. In `by_status` this is structural rather than informative: the `succeeded` row necessarily reports it equal to `runs`. |
| `success_rate` | number | `succeeded` over this group's `runs`. |
| `share` | number | This group's `runs` over the report's total `runs`. |
| `duration_seconds` | object | Duration figures over all of this group's runs, not only the succeeded ones. |
| `mean_turns` | number or null | Mean turns completed over this group's runs. `null` on the `base` tier. |
| `tokens` | object or null | Token sums over this group's runs. `null` on the `base` tier. |
| `cost_usd` | number or null | Estimated cost over this group's priced runs. `null` on the `base` tier and when the group holds no priced run. |
| `cost_per_succeeded_run_usd` | number or null | `cost_usd` divided by this group's `succeeded`. `null` whenever `cost_usd` is `null`, and when the group has no succeeded run. |

`duration_seconds`, in both `summary` and every breakdown element:

| Field | Type | Description |
|---|---|---|
| `p50` | number or null | Median duration in seconds, nearest rank with no interpolation. `null` when `samples` is `0`. |
| `p95` | number or null | 95th percentile in seconds, nearest rank with no interpolation. `null` when `samples` is `0`. |
| `mean` | number or null | Arithmetic mean duration in seconds. `null` when `samples` is `0`. |
| `samples` | integer | Runs contributing to the three figures above. |

Durations are seconds here. Text mode renders the same values as `2m 49s`.

`tokens`, in both `summary` and every breakdown element:

| Field | Type | Description |
|---|---|---|
| `input` | integer | Sum of recorded input tokens. |
| `output` | integer | Sum of recorded output tokens. |
| `total` | integer | Sum of the recorded totals, taken as stored rather than recomputed from `input` and `output`. |
| `cache_read` | integer | Sum of recorded cache-read tokens. |

`self_review`:

| Field | Type | Description |
|---|---|---|
| `runs_with_metadata` | integer | Runs whose recorded review metadata was present and parsed. |
| `by_final_verdict` | array of object | One entry per distinct final verdict, sorted by verdict name. |
| `cap_reached_runs` | integer | Runs that reached the review iteration cap. |
| `mean_iterations` | number or null | Mean review iterations over `runs_with_metadata`. `null` when `runs_with_metadata` is `0`. |
| `unparsed_runs` | integer | Runs whose recorded review metadata failed to parse. They count here and contribute to nothing else in this object. |

Each element of `by_final_verdict`:

| Field | Type | Description |
|---|---|---|
| `verdict` | string | The final verdict. A run whose recorded verdict is empty is grouped under the literal `none`, which is distinct from the `<none>` group sentinel. |
| `runs` | integer | Runs carrying this verdict. |

A worked example, expanded for readability and trimmed to one row per breakdown. The command emits it as a single compact line:

```json
{
  "generated_at": "2026-08-09T07:51:57Z",
  "workflow_path": "/srv/sortie/WORKFLOW.md",
  "db_path": "/srv/sortie/.sortie.db",
  "since": "2026-07-01T00:00:00Z",
  "until": "2026-08-01T00:00:00Z",
  "schema_tier": "full",
  "warnings": [],
  "summary": {
    "runs": 9,
    "succeeded": 7,
    "success_rate": 0.7778,
    "duration_seconds": {"p50": 169, "p95": 432, "mean": 214.6, "samples": 7},
    "mean_turns_succeeded": 3.29,
    "tokens": {"input": 502900, "output": 96000, "total": 598900, "cache_read": 12638000},
    "cost_usd": 6.49,
    "cost_per_succeeded_run_usd": 0.93,
    "zero_duration_runs": 0,
    "duration_excluded_runs": 0,
    "cost_unpriced_runs": 0
  },
  "by_status": [
    {
      "name": "succeeded",
      "runs": 7,
      "succeeded": 7,
      "success_rate": 1,
      "share": 0.7778,
      "duration_seconds": {"p50": 169, "p95": 432, "mean": 214.6, "samples": 7},
      "mean_turns": 3.29,
      "tokens": {"input": 341900, "output": 67000, "total": 408900, "cache_read": 9038000},
      "cost_usd": 4.59,
      "cost_per_succeeded_run_usd": 0.66
    }
  ],
  "by_adapter": [
    {
      "name": "claude-code",
      "runs": 6,
      "succeeded": 5,
      "success_rate": 0.8333,
      "share": 0.6667,
      "duration_seconds": {"p50": 161, "p95": 580, "mean": 272, "samples": 6},
      "mean_turns": 3.33,
      "tokens": {"input": 324500, "output": 63900, "total": 388400, "cache_read": 12638000},
      "cost_usd": 5.72,
      "cost_per_succeeded_run_usd": 1.14
    }
  ],
  "by_rule": [
    {
      "name": "bugfix",
      "runs": 4,
      "succeeded": 4,
      "success_rate": 1,
      "share": 0.4444,
      "duration_seconds": {"p50": 150, "p95": 169, "mean": 155, "samples": 4},
      "mean_turns": 2.5,
      "tokens": {"input": 145100, "output": 27700, "total": 172800, "cache_read": 5636000},
      "cost_usd": 2.54,
      "cost_per_succeeded_run_usd": 0.64
    }
  ],
  "by_template": [
    {
      "name": "prompts/bugfix.md",
      "runs": 4,
      "succeeded": 4,
      "success_rate": 1,
      "share": 0.4444,
      "duration_seconds": {"p50": 150, "p95": 169, "mean": 155, "samples": 4},
      "mean_turns": 2.5,
      "tokens": {"input": 145100, "output": 27700, "total": 172800, "cache_read": 5636000},
      "cost_usd": 2.54,
      "cost_per_succeeded_run_usd": 0.64
    }
  ],
  "self_review": {
    "runs_with_metadata": 6,
    "by_final_verdict": [{"verdict": "iterate", "runs": 1}, {"verdict": "pass", "runs": 5}],
    "cap_reached_runs": 1,
    "mean_iterations": 1.5,
    "unparsed_runs": 0
  }
}
```

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | A report was produced. Includes a range that matched no runs and a reduced report on the `base` tier, both of which are successes, and `-h`/`--help`. |
| `1` | Usage error (invalid `--format`, an unparseable or inverted range bound, too many arguments) or load error (workflow file missing or invalid, database unopenable, `run_history` unreadable). |

### `mcp-server`

Starts an MCP stdio server that exposes registered agent tools over JSON-RPC on stdin/stdout. Intended to be launched by an MCP-compatible agent runtime via `.sortie/mcp.json`, *not run manually*.

```
sortie mcp-server --workflow <path>
```

The subcommand loads the workflow file, constructs the tracker adapter from its configuration, builds a tool registry, and serves MCP requests until stdin closes or the process receives a signal. No SQLite database is opened, no agents are spawned, and no HTTP server starts.

#### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--workflow` | string | _(none)_ | Absolute path to the WORKFLOW.md file. Required. |
| `-h`, `--help` | boolean | `false` | Print the mcp-server help message and exit. |

No other flags beyond `--workflow` and `-h`/`--help`. All behavior derives from the workflow file and environment variables.

#### Startup sequence

1. Parse `--workflow` flag. Exit `1` if missing.
2. Load and parse the workflow file.
3. Construct `ServiceConfig` from the raw config.
4. Set up `slog` logger to stderr at `info` level.
5. Resolve tracker adapter from the registry (when the tracker section is present). Build the tracker config map, merge extensions, and construct the adapter.
6. Build the tool registry. When the tracker section is present and `tracker.project` is non-empty, register the `tracker_api` tool. Otherwise the registry is empty.
7. Construct the MCP server with the registry and stdin/stdout.
8. Serve requests until stdin closes or the context is cancelled.

Errors at steps 1–6 log to stderr and return exit code `1`.

#### Environment variables

The MCP server receives its environment exclusively from the `env` field in `.sortie/mcp.json`. The worker writes all `SORTIE_*`-prefixed variables from the orchestrator's process environment into this block, plus five per-session variables that override any same-named process variable. See [MCP server environment](/reference/environment/#mcp-server-environment) for the full composition model.

Per-session variables written by the worker:

| Variable | Purpose |
|---|---|
| `SORTIE_ISSUE_ID` | Scopes tool calls to the current issue. |
| `SORTIE_ISSUE_IDENTIFIER` | Human-readable issue key. |
| `SORTIE_WORKSPACE` | Workspace root path. |
| `SORTIE_DB_PATH` | SQLite database path. |
| `SORTIE_SESSION_ID` | Session identifier. |

Tracker credentials (e.g., `SORTIE_TRACKER_API_KEY`) reach the server through the same `env` block via the `SORTIE_*` prefix scan. The MCP server's config parser resolves `$VAR` indirection in the workflow file against these variables.

The MCP server does not validate environment variable presence at startup. Validation failures surface at tool execution time when a tool requires a variable that is absent.

#### Graceful shutdown

The MCP server exits cleanly when either:

- **stdin closes** - the agent runtime terminates the stdio pipe. The JSON-RPC reader detects EOF and returns.
- **Context cancellation** - the signal handler cancels the context.

No explicit shutdown handshake. The server's lifetime is bound to the agent runtime's stdio pipe.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (stdin closed or signal received), or `-h`/`--help` requested. |
| `1` | Startup failure: missing `--workflow`, unreadable workflow file, invalid config, tracker adapter construction failure, or a server error during operation. |

---

## Startup sequence

When no version or help flag is present, Sortie executes these steps in order:

1. **Intercept short flags and parse.** Short aliases (`-h`, `-V`) are intercepted before subcommand dispatch or flag parsing, because the Go `flag` package does not recognize single-dash aliases for long flags. If `-h` is found, help is printed to stdout and the process exits `0`. If `-V` is found, the version banner is printed to stdout and the process exits `0`. Subcommand tokens (`validate`, `stats`, `mcp-server`) and the POSIX `--` terminator stop the scan - `-h` after a subcommand is handled by the subcommand itself. After interception, remaining flags are parsed normally. Unknown flags exit with code `1` and print a one-line error to stderr (the full help text is not printed on errors). `--env-file` path (when provided) is stored for later use.
2. **Resolve workflow path.** Relative paths resolve to absolute against the working directory.
3. **Initialize logging.** Structured output to stderr. Uses `--log-level` and `--log-format` flags when set; otherwise defaults to `INFO` level with `text` format for the duration of startup.
4. **Load and watch workflow file.** Start a filesystem watcher for dynamic config reload. During config parsing, [`SORTIE_*` overrides](/reference/environment/#configuration-overrides) are applied - including `.env` file loading when enabled.
5. **Preflight validation.** Verify `tracker.kind` is registered, `agent.kind` is registered, required API keys are present, active/terminal state lists are non-empty, adapter-specific config validation passes (when declared), and the workspace root is writable. Failure exits with code `1` - no database file is created on disk.
6. **Resolve log level and format.** When `--log-level` was not set, check `logging.level` from the workflow config. When `--log-format` was not set, check `logging.format` from the workflow config. If either differs from the startup default, re-initialize the logger before emitting the startup message.
7. **Construct tracker adapter.** Instantiate the tracker adapter from the registry using the configuration map.
8. **Open SQLite database.** Path from [`db_path`](/reference/workflow-config/) config field, or `.sortie.db` adjacent to the workflow file. Relative paths resolve against the workflow file's directory, not the working directory.
9. **Run schema migrations.** Applied automatically on every startup.
10. **Load persisted retry entries.** Reconstruct timers from previous session state.
11. **Construct agent adapter.** Instantiate the agent adapter from the registry.
12. **Clean terminal workspaces.** Query tracker for states of existing workspace directories; remove those in terminal states. Only directories whose state comes back known and terminal are removed, and if the directory listing or the tracker read fails, Sortie logs a warning and cleans nothing on this pass. No age-based removal runs here: the [`workspace.retention_days`](/reference/workflow-config/#workspace) bound belongs to the periodic sweep, whose first pass falls 60 poll ticks after step 15.
13. **Resolve server port.** `--port` flag overrides `server.port` from config.
14. **Start HTTP server.** Binds to `127.0.0.1:<port>` when enabled.
15. **Enter event loop.** First poll tick fires immediately. Blocks until signal.

When `--dry-run` is set, execution diverges after step 7. Steps 8–15 are skipped entirely. Instead, Sortie fetches candidate issues from the tracker, evaluates dispatch eligibility, logs the results, and exits. No database file is created, no agent adapter is constructed, and no HTTP server starts.

Any step that fails prints a diagnostic to stderr and exits with code `1`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (signal received), help output (`-h`, `--help`), version output (`-V`, `--version`, `-dumpversion`), successful `validate`, successful `--dry-run`, a `stats` report (including one whose range matched no runs), or clean `mcp-server` shutdown. |
| `1` | Startup failure: unknown flag, too many arguments, missing or unreadable workflow file, invalid configuration, preflight validation failure, or database open/migration error. Also used by `validate` for any validation failure, by `--dry-run` when the tracker fetch fails, by `stats` for usage and load errors, and by `mcp-server` for startup or runtime errors. |

Sortie does not define exit codes above `1`. Agent subprocess failures, tracker errors, and runtime exceptions are handled internally through the retry and reconciliation mechanisms - they do not affect the process exit code.

---

## Signals

| Signal | Behavior |
|---|---|
| `SIGINT` | Initiates graceful shutdown. |
| `SIGTERM` | Initiates graceful shutdown. |

Both signals trigger the same sequence:

1. Stop accepting new dispatches.
2. Cancel all running worker contexts.
3. Wait up to 30 seconds for workers to exit (drain timeout). Worker results are processed through the normal exit handler during drain - run history is persisted and retry entries are recorded.
4. Cancel pending retry timers.
5. Shut down the HTTP server with a 5-second timeout for in-flight responses.
6. Close the SQLite database.
7. Exit with code `0`.

During drain, `/livez` and `/readyz` return `503`, and `POST /api/v1/refresh` returns a rejection instead of `202 Accepted`.

A second signal during drain is not intercepted - the OS terminates the process immediately.

---

## Logging

All log output goes to **stderr**. The default format is structured `key=value` text:

```
time=2026-03-26T14:30:01.271+00:00 level=INFO msg="sortie starting" version=1.14.0 workflow_path=/opt/sortie/WORKFLOW.md port=8080
time=2026-03-26T14:30:01.298+00:00 level=INFO msg="database path resolved" db_path=/opt/sortie/.sortie.db
time=2026-03-26T14:30:01.304+00:00 level=INFO msg="sortie started"
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="http server listening" addr=127.0.0.1:8080
```

When `--log-format json` is active (or `logging.format: json` in the workflow file), each line is a JSON object:

```json
{"time":"2026-03-26T14:30:01.271+00:00","level":"INFO","msg":"sortie starting","version":"1.14.0","workflow_path":"/opt/sortie/WORKFLOW.md","port":8080}
{"time":"2026-03-26T14:30:01.298+00:00","level":"INFO","msg":"database path resolved","db_path":"/opt/sortie/.sortie.db"}
{"time":"2026-03-26T14:30:01.304+00:00","level":"INFO","msg":"sortie started"}
{"time":"2026-03-26T14:30:01.305+00:00","level":"INFO","msg":"http server listening","addr":"127.0.0.1:8080"}
```

JSON output uses RFC 3339 timestamps, uppercase level strings, and emits all structured attributes as top-level keys. Each record is a single line terminated by `\n`.

### Context fields

Different log lines carry different context fields depending on scope:

| Field | Present on |
|---|---|
| `version` | Startup |
| `workflow_path` | Startup |
| `port` | Startup (only when `--port` is provided) |
| `log_level` | Startup (only when the effective level is not `INFO`) |
| `log_format` | Startup (only when the effective format is not `text`) |
| `db_path` | Database initialization |
| `issue_id` | Dispatch, worker lifecycle, retry, reconciliation |
| `issue_identifier` | Dispatch, worker lifecycle, retry, reconciliation |
| `session_id` | Agent events, worker lifecycle |
| `error` | Error and warning lines |
| `next_attempt`, `delay_ms` | Retryable worker failures (WARN level) |
| `tool`, `duration_ms`, `result` | Tool call completions |
| `addr` | HTTP server start |

Stdout is used for help output (`-h`, `--help`), version output (`-V`, `--version`, `-dumpversion`), `validate --format json` diagnostics, and `mcp-server` JSON-RPC responses. All other output goes to stderr.

---

## Version injection

The `Version` variable defaults to `dev` when running from source. Release builds inject the version at compile time via linker flags:

```sh
go build -ldflags "-s -w -X main.Version=1.14.0" -o sortie ./cmd/sortie
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
| SQLite database | [`db_path`](/reference/workflow-config/) or `.sortie.db` next to the workflow file | Run history, retry entries, aggregate metrics, session metadata. Created automatically if absent. |

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

# Emit JSON-formatted logs (for log aggregation systems)
sortie --log-format json

# Combine path, port, log level, and log format
sortie --log-level debug --log-format json --port 8080 /opt/sortie/WORKFLOW.md

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

# Summarize every recorded run
sortie stats

# Summarize a bounded range (inclusive start, exclusive end)
sortie stats --since 2026-07-01 --until 2026-08-01 /opt/sortie/WORKFLOW.md

# Summarize the last 24 hours as JSON (for your own metrics store)
sortie stats --since 24h --format json ./WORKFLOW.md

# Dry-run: verify tracker connectivity and dispatch math without starting agents
sortie --dry-run

# Dry-run with explicit workflow path
sortie --dry-run /opt/sortie/WORKFLOW.md

# Dry-run with debug output for full candidate detail
sortie --dry-run --log-level debug

# Load config overrides from a .env file
sortie --env-file /etc/sortie/prod.env

# Combine .env file with explicit workflow path and port
sortie --env-file /etc/sortie/prod.env --port 8080 /opt/sortie/WORKFLOW.md

# Help text
sortie --help
sortie -h

# Short version alias
sortie -V

# Subcommand help
sortie validate -h
sortie mcp-server --help

# Start MCP stdio server (launched by agent runtime, not run manually)
sortie mcp-server --workflow /opt/sortie/WORKFLOW.md
```

---

## See also

- [WORKFLOW.md configuration reference](/reference/workflow-config/) - all config fields
- [Environment variables reference](/reference/environment/) - `SORTIE_*` config overrides, agent runtime vars, `$VAR` indirection, hook env
- [HTTP API reference](/reference/http-api/) - JSON API endpoints and response shapes
- [Dashboard reference](/reference/dashboard/) - built-in HTML monitoring dashboard
- [Prometheus metrics reference](/reference/prometheus-metrics/) - metric names, types, labels, and PromQL examples
