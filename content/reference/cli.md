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

Without a subcommand, Sortie runs as a long-lived process. It loads the [workflow file](/reference/workflow-config/), opens the SQLite database, validates configuration, and enters the poll-dispatch-reconcile loop. The process blocks until terminated by a signal.

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
| `-dumpversion` | boolean | `false` | Print the bare version string, then exit. |
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

The startup sequence through preflight validation is identical to a normal run. The dry-run branch diverges after the tracker adapter is built (see [startup sequence](#startup-sequence) step 8).

#### Dry-run output

Each candidate issue produces an `INFO`-level log line:

```
level=INFO msg="dry-run: candidate" issue_id=abc123 issue_identifier=MT-649 title="Fix pagination bug" state="To Do" would_dispatch=true global_slots_available=4 state_slots_available=2 priority=1
```

Key fields:

| Field | Description |
|---|---|
| `would_dispatch` | `true` if the issue would be dispatched under current config. `false` with a `skip_reason` when ineligible. |
| `global_slots_available` | Remaining global agent slots at this point in the simulation. |
| `state_slots_available` | Remaining per-state slots for this issue's tracker state. |
| `priority` | Issue priority (present only when the tracker provides it). |
| `ssh_host` | Assigned SSH host (present only when SSH worker mode is configured). |
| `skip_reason` | Present only when a blocker or an SSH host limit is why `would_dispatch` is `false`. Absent for any other ineligibility, such as a full concurrency slot or a basic eligibility check. The candidate log line still reports `would_dispatch=false` in those cases, with no `skip_reason`. |

`skip_reason` takes one of these values:

| Value | Meaning |
|---|---|
| `blocked_by` | At least one blocker has a non-terminal or unknown state. |
| `blockers_unresolved` | The blocker read for this candidate failed, or this simulated poll already gave up on further reads after an earlier failure. |
| `blockers_not_read` | This simulated poll's read budget was already spent on other candidates before reaching this one. |
| `blockers_incomplete` | The candidate's blocker list was not authoritative and nothing was available to complete it. |
| `ssh_hosts_at_capacity` | Every configured SSH host is at its concurrency limit. |

See [candidate eligibility](/reference/state-machine/#candidate-eligibility) for how the first four are decided, and the [Prometheus metrics reference](/reference/prometheus-metrics/#counters) for the `sortie_candidate_holds_total` counter a live run increments for the same four reasons.

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

Applied before the workflow file is loaded, so all startup output, including workflow loading errors, respects the requested level.

### `--log-format`

Sets the log output format. Accepted values (case-insensitive): `text`, `json`. Default: `text`.

When `text` is active (the default), Sortie emits structured `key=value` lines:

```
time=2026-04-07T14:30:00.000+00:00 level=INFO msg="sortie starting" version=<version> workflow_path=/opt/sortie/WORKFLOW.md
```

When `json` is active, each log line is a single JSON object:

```json
{"time":"2026-04-07T14:30:00.000Z","level":"INFO","msg":"sortie starting","version":"<version>","workflow_path":"/opt/sortie/WORKFLOW.md"}
```

JSON format is intended for containerized and cloud-native deployments where log aggregation systems (Loki, Datadog, CloudWatch, ELK) expect newline-delimited JSON on stdout/stderr.

Takes precedence over `logging.format` from the [workflow file](/reference/workflow-config/#logging). When neither the flag nor the workflow field is set, the process uses `text`.

An unknown value (e.g., `--log-format yaml`) prints an error to stderr and exits with code `1`:

```
sortie: unknown log format "yaml": accepted values are text, json
```

Applied before the workflow file is loaded, so all startup output uses the requested format immediately. Both `--log-format` and `--log-level` can be combined freely. Any combination works.

### `--env-file`

Loads `SORTIE_*` variables from a file as [configuration overrides](/reference/environment/#configuration-overrides).

```sh
sortie --env-file /etc/sortie/prod.env WORKFLOW.md
```

Takes a file path argument. Only keys prefixed with `SORTIE_` are read from the file; all others are ignored. The file format is `KEY=VALUE` with `#` comments, optional quotes, and no variable interpolation.

Real environment variables take precedence over `.env` values. When both `--env-file` and the `SORTIE_ENV_FILE` environment variable are set, the flag wins.

When `--env-file` is provided, the CLI resolves the path to absolute and exports it as `SORTIE_ENV_FILE` in the process environment. This makes the value available to the MCP server through the [config env block](/reference/environment/#mcp-server-environment), so the MCP server can locate and load the `.env` file to resolve credential `$VAR` indirection. The absolute resolution is necessary because the MCP server's working directory (the per-issue workspace) differs from the orchestrator's.

The file is re-read on every WORKFLOW.md reload (file change detection). If the file does not exist, loading continues without it, and Sortie records an `env_file.missing` [advisory warning](#advisory-warnings). The run log prints it once and again only after the file has existed and gone missing again; `sortie validate` reports it fresh on every run.

### `--port`

Sets the listening port for the embedded HTTP server. The server starts by default on port `7678`. All observability surfaces share this port:

- `/`: redirects to `/ui/`
- `/ui/`: web dashboard ([dashboard reference](/reference/dashboard/))
- `/favicon.ico`: dashboard icon
- `/api/v1/state`: JSON API ([HTTP API reference](/reference/http-api/))
- `/api/v1/runs`: run history
- `/api/v1/runs/issues`: run history grouped by issue
- `/api/v1/runs/<dispatch_id>/events`: agent events of one run
- `/api/v1/stats`: run statistics
- `/api/v1/prices`: rates in force and the state of every price source
- `/api/v1/events`: change signals and agent events
- `/api/v1/<identifier>`: per-issue detail and run history
- `/api/v1/refresh`: trigger an immediate poll cycle
- `/api/v1/retries/<identifier>/run`: make a scheduled retry due now
- `/api/v1/attention/<id>/acknowledge`: acknowledge an attention item
- `/api/v1/reactions/<identifier>/<kind>/check`: make a pending pull request reaction's next check due now
- `/livez`: liveness probe
- `/readyz`: readiness probe
- `/metrics`: Prometheus metrics ([Prometheus metrics reference](/reference/prometheus-metrics/))

Valid range: `1`–`65535`, or `0` to disable. Port `0` disables the server entirely: no TCP listener, no Prometheus metrics. The orchestrator runs with a no-op metrics implementation.

Overrides `server.port` from the WORKFLOW.md [`server` extension](/reference/workflow-config/). When the default port (`7678`) is already occupied and the operator did not explicitly request a port, Sortie logs a warning and starts without the HTTP server. When the operator explicitly requested a port (via `--port` or `server.port`) and it is already in use, Sortie exits with code `1`.

Invalid values (negative, above 65535) produce an error and exit `1`.

### `--host`

Sets the bind address for the embedded HTTP server. Default: `127.0.0.1` (loopback only).

Must be a parseable IP address. DNS hostnames are not accepted. Container deployments that need inbound connections from the container network use `0.0.0.0`.

Overrides `server.host` from the WORKFLOW.md [`server` extension](/reference/workflow-config/). Requires a restart to take effect.

### `-h`, `--help`

Prints the help message to stdout and exits with code `0`. `-h` and `-help` are aliases for `--help`, recognized by the same interception pass.

```
Turn issue tracker tickets into autonomous coding agent sessions.

Usage:
  sortie [flags] [workflow-path]
  sortie <command> [flags]

Commands:
  validate                  Validate a workflow file without running it
  stats                     Summarize past runs: outcomes, duration, and cost
  mcp-server                Start the MCP stdio server for agent-to-orchestrator communication

Flags:
  -h, --help                Print this help message and quit
  -V, --version             Print program's version information and quit
  -dumpversion              Print the version of the program and don't do anything else

Run options:
  --dry-run                 Run one poll cycle without spawning agents, then exit
  --env-file PATH           Path to .env file for config overrides
  --log-level LEVEL         Log verbosity: debug, info, warn, error (default: info)
  --log-format FORMAT       Log output format: text, json (default: text)
  --host ADDRESS            HTTP server bind address (default: 127.0.0.1)
  --port PORT               HTTP server port, 0 to disable (default: 7678)

Examples:
  sortie WORKFLOW.md                     Run orchestrator with a workflow
  sortie --dry-run WORKFLOW.md           Validate config and poll once without writing state
  sortie validate --format json w.md     Check workflow syntax, output as JSON
  sortie stats --since 24h               Summarize the last 24 hours of runs

Learn more:
  https://docs.sortie-ai.com
```

Each subcommand carries its own help text, printed by `sortie validate -h`, `sortie stats -h`, and `sortie mcp-server -h`.

### `-V`, `--version`

Prints the full version banner to stdout and exits with code `0`. The short form `-V` is an alias for `--version`.

```
sortie <version> (commit: <short-sha>, built: <date>, <go-toolchain>, <goos>/<goarch>)
```

The banner includes the Git commit SHA (first 7 characters), build date, Go toolchain version, and target platform. Every field is filled at build time; a build from source with no injected values reports version `dev`, commit `unknown`, and date `unknown`.

Skips workflow loading, configuration validation, and database initialization. Ignores the `workflow-path` argument when present.

### `-dumpversion`

Prints the version string alone to stdout and exits with code `0`:

```
<version>
```

The flag is registered as `dumpversion` on the flag set, so `--dumpversion` parses identically.

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
- Integer-typed fields validated under the `config.<field>` check accept a whole-number float or a numeric string in addition to a literal integer (type coercion). A value outside the range an integer setting accepts (`-9223372036854775808` to `9223372036854775807`) is rejected as a configuration error under that check. Other coercion failures are too, except for [`hooks.timeout_ms`](/reference/workflow-config/#hooks) and [`agent.max_concurrent_agents_by_state`](/reference/workflow-config/#agent). A field inside a block the workflow leaves disabled or unconfigured is not checked this way at all.
- A reaction's own `poll_interval_ms`, `debounce_ms`, `watch_window_ms`, or `max_continuation_turns` is checked for that same range too, under the `reactions.<kind>` check instead, with a differently worded message; see the [errors reference](/reference/errors/#startup-and-configuration-errors) for both message forms.
- `server.port` is never checked by `validate`.
- `tracker.handoff_state` is a string, is non-empty when present, and does not collide with `active_states` or `terminal_states`.
- `tracker.no_change_state`, when present, requires `tracker.handoff_state` to be set, and must equal `handoff_state` or name a member of `terminal_states` as written.
- `tracker.handoff_evidence` is one of `observed`, `strict`, or `off`. The check is a closed-set comparison and runs offline with no network access.
- `tracker.in_progress_state` is a member of `active_states` when present, and does not collide with `terminal_states` or `handoff_state`.
- `db_path` is a string when present.
- `agent.max_sessions` is non-negative.
- `agent.turn_timeout_ms` is positive.
- Go `text/template` syntax in the prompt body, the default template, every rule template, and the [partials](/reference/workflow-config/#partials) they share (strict mode: unknown variables and functions are errors). A call to a template that nothing defines is an error too, in a branch no issue takes as well.
- Template static analysis, run on the prompt body, the default template, and every rule template (advisory warnings): dot-context misuse inside `{{ range }}` / `{{ with }}`, unknown top-level variables, unknown sub-fields of known variables, and shared blocks that no template calls. The analysis follows a call into a shared block, so a fault inside a partial is reported too.
- `tracker.kind` is present and maps to a registered adapter.
- `agent.kind` maps to a registered adapter. Defaults to `claude-code` when absent.
- Fields required by the selected adapters: `tracker.api_key`, `tracker.project`, and `agent.command` for an agent kind that has no default command, such as `agent-client-protocol`.
- At least one of `tracker.active_states` or `tracker.terminal_states` is non-empty, and no entry of either list is empty or only white space (`config.tracker.active_states[<i>]`, `config.tracker.terminal_states[<i>]`). For `github`, `gitea`, and `gitlab`, `tracker.terminal_states` is non-empty too (`config.tracker.terminal_states`).
- Adapter-specific config validation. When the registered tracker adapter declares its own config validation, the pipeline invokes it with the extracted tracker config fields. Adapter validation runs after the generic preflight checks and can produce both errors (block validity) and warnings (advisory). The Jira, GitHub, GitLab, Gitea, and Linear adapters each declare one; the `file` adapter does not. Each adapter reference page lists that adapter's checks, for example [GitHub adapter validation](/reference/adapter-github/#validate-time-checks).
- `notifications` entries: the shape of the section, the `events` names, and the `tracker_comment` rules (one entry, a configured tracker, `events` written, no `agent.message`). For each entry that receives an event Sortie produces, `validate` also builds the backend, which reports an unknown `kind` and a required secret that resolved to the empty string, as `config.notifications[<i>].kind` or `config.notifications[<i>]`. An entry that receives only `agent.message` is not built. The `reactions.<kind>.escalation` value is checked too.
- Settings block presence (`dispatch.agent.missing_block`), for every agent kind a `dispatch.default.agent` or a `dispatch.rules[i].agent` names, when that kind is registered and differs from the top-level `agent.kind`. The kind must carry its own top-level block in the front matter, or the workflow is refused, naming the selector that introduced the kind and the block it expects. An empty block (`codex: {}` or a bare `codex:` key) is enough. A kind whose every selector is a rule that carries the kind's own settings block needs no top-level block, so the check does not fire for it. Skipped for a kind Sortie does not recognize as a registered adapter, since that is already reported separately as `agent_adapter`.
- Session-resume refusal (`agent.kind.session_resume`), for every agent kind the configuration can reach. An adapter declares which of its own pass-through keys stops it resuming a session across separate agent launches; when the configuration sets that key to the blocking value, the workflow is refused. Sortie hands an issue its earlier session back on a continuation, including one still queued when Sortie restarts, and on the retry after a stall while Sortie keeps running, so every resumed turn would fail. The check reads the adapter's declaration and that adapter's own pass-through block, and no core setting; it runs offline with no network access and no subprocess launch. `claude-code.session_persistence` set to `false` is the only key any built-in adapter declares.
- Dispatch rule settings blocks: the structural checks on `dispatch.rules` that fail the load (a block for a kind the rule does not run, a block that is not a mapping or writes `command` or a timeout, a missing or reserved rule `name`) and the [`match.title`](/reference/workflow-config/#title-phrases) checks, reported as `config.dispatch.rules[<i>]...` fields.
- Stage labels and `next` links on [dispatch rules](/reference/workflow-config/#stage-chains), reported as `config.dispatch.rules[<i>].stage`, `config.dispatch.rules[<i>].next`, or `config.dispatch.rules[<i>]`. A `stage` is a string with at least one character other than white space and repeats no other rule's stage label, compared without regard to case. A rule that carries `stage` or `next` has a `name`, and a rule that carries `stage` has no `match` block. A `next` names another rule, that rule carries a `stage`, and the `next` links form no cycle. Any `next` requires `tracker.handoff_state`. Both keys belong to rules only: under `dispatch.default` either one is rejected as `config.dispatch.default.<key>` with the message `unknown key`.
- `dispatch.max_consecutive_hops`, when written, is an integer greater than `0` and at least the number of hops in the longest stage chain, reported as `config.dispatch.max_consecutive_hops`.
- Stage label collisions (`dispatch.stage.collision`). Each rule's stage label is compared, without regard to case, against the active and terminal states, `tracker.handoff_state`, `tracker.in_progress_state`, `tracker.no_change_state`, every reaction's `escalation_label`, and the parking label (`needs-human` unless `reactions.review_comments.escalation_label` names another). Each match is one error, which names the rule and the value it collides with. The check reads configuration only and makes no tracker call.
- Agent-adapter config validation, for every agent kind the configuration can reach: the default `agent.kind`, the kind a [dispatch default](/reference/workflow-config/#dispatch) names, and the kind each dispatch rule selects. Every rule that carries a settings block is also checked on its resolved block, the top-level block of its kind with the rule's block laid over it, and each message opens with `dispatch rule "<name>" (dispatch.rules[<i>].<kind>): `. A rule's block therefore draws the same errors and warnings a top-level block would. A registered kind the configuration never names is skipped, because reporting a fault in a block no run reads would be noise. These checks cover the pass-through values that would let the agent stop and wait for a person, and they run offline with no network access and no subprocess launch. The Codex, Claude Code, Copilot CLI, and OpenCode adapters each declare them: see [Codex](/reference/adapter-codex/#validate-time-checks), [Claude Code](/reference/adapter-claude-code/#validate-time-checks), [Copilot CLI](/reference/adapter-copilot/#validate-time-checks), and [OpenCode](/reference/adapter-opencode/#validate-time-checks).
- [`price_table`](/reference/workflow-config/#price_table) is a map, `price_table.embedded` and `price_table.fetch` are booleans, and `price_table.fetch_url` and `price_table.replace_url` are strings that do not resolve to an empty string through a `$VAR` (`price_table.fetch_url`, `price_table.replace_url`). `price_table.replace_file`, when set, is a string that resolves to a non-empty path naming a readable price table (`price_table.replace_file`), and it is not set together with `price_table.replace_url` (`price_table.replace_conflict`). The check reads the file and makes no request. A table that fails to load never falls back to another table.
- Workspace root directory exists (or can be created) and is writable.

The pipeline does **not** check:

- **Value ranges**, for most fields. `agent.max_sessions`, `agent.max_tokens`, `agent.max_cost_usd`, `agent.max_daily_cost_usd`, `agent.max_monthly_cost_usd`, `agent.token_warning_percent`, `agent.max_consecutive_absences`, `agent.turn_timeout_ms`, `agent.stop_grace_ms`, `workspace.retention_days`, the `self_review` integer fields, `reactions.*.max_retries`, the `reactions.ci_failure` integer fields, and `dispatch.max_consecutive_hops` are checked and reject an out-of-range value as a configuration error. Negative values for `polling.interval_ms` or other timeout fields are accepted. Zero replaces with a built-in default for `polling.interval_ms` and `agent.read_timeout_ms`; for `agent.stall_timeout_ms` zero is kept and disables stall detection. `agent.turn_timeout_ms` and `agent.stop_grace_ms` must be positive; any other value is rejected rather than replaced.
- **Format constraints.** `tracker.endpoint` is not checked for valid URL syntax. Path fields are not checked for existence (except `workspace.root`).

#### Advisory warnings

Beyond the error-level checks above, `validate` runs static analysis on the front matter and the prompt templates, checks the resolved configuration for likely-wrong patterns, and reports the advisories recorded while that configuration was built or loaded, emitting **warnings** in every case.

Warnings do not block validity: `valid` remains `true` and the exit code is `0` when only warnings are present. Runtime behavior is unchanged; warnings surface patterns that the orchestrator would silently accept, that would produce unexpected output, or that it would otherwise only report through the run log.

`validate` groups these warnings by what produced them: static analysis of the front matter, static analysis of the prompt templates, checks on the resolved configuration, and advisories recorded while the configuration was built or loaded, plus adapter-specific warnings when the tracker adapter declares config validation (see [adapter-specific warning check values](#adapter-specific-warning-check-values)):

**Front matter analysis:**

- **Unknown top-level keys** (`unknown_key`). A top-level YAML key that is not a core section (`tracker`, `polling`, `workspace`, `hooks`, `agent`, `db_path`, `self_review`, `reactions`, `dispatch`, `notifications`), not a recognized extension (`server`, `logging`, `worker`), and not the adapter pass-through block matching the configured `tracker.kind` or `agent.kind`. Catches typos like `trackers:` instead of `tracker:`.
- **Unknown sub-keys** (`unknown_sub_key`). A key inside a known section that does not match any defined field. For example, `tracker.typo_endpoint` or `hooks.before_launch`. Sub-objects named after the section's adapter kind are exempt (e.g., `tracker.jira` when `tracker.kind` is `jira`).
- **Type mismatches** (`type_mismatch`). A value whose YAML type does not match the expected type for a field. For example, `hooks.timeout_ms: "not-a-number"` or `tracker.kind: 123`. Also covers semantic issues: a non-positive `hooks.timeout_ms` that falls back to the default, and non-numeric or non-positive entries in `agent.max_concurrent_agents_by_state` that are silently ignored at runtime.
- **Ineffective token warning threshold** (`ineffective_setting`). `agent.token_warning_percent` is set above `0` while `agent.max_tokens` is `0`, so the threshold derives from a ceiling that is not in force and never fires. Raise `agent.max_tokens` above `0`, or leave `token_warning_percent` unset.
- **Unresolved extension variable** (`unresolved_extension_var`). A `$VAR` or `${VAR}` reference inside a top-level key outside the core schema, such as an adapter pass-through block or `server`, `logging`, or `worker` (for example `github.api_key` or `worker.ssh_hosts[0]`), whose named environment variable is unset or empty at the time the workflow loads. Fires once per field, naming every unset variable the field references; a field where only some of several variables are set still warns about the ones that are not.

**Template static analysis:**

Each template warning starts with the file and the line that hold the fault, in the form `<file> (line <n>): <message>`. The file is an absolute path. For the prompt body, the line counts from the top of `WORKFLOW.md`, front matter included. A fault inside a shared block is reported at its line in the partial, and the same fault reached from several templates is reported once.

Dot-context, unknown-variable, and unknown-field warnings cover the body, the default template, and every rule template, and a call that passes the root data (`{{ template "name" . }}` outside a `{{ range }}` or `{{ with }}` body) carries the check into the shared block. A call that passes anything else does not. A template that fails to load produces the load error and no template warnings.

- **Dot-context misuse** (`dot_context`). A reference to a top-level data key (such as `.issue`, `.run`, or `.stage`) inside a `{{ range }}` or `{{ with }}` block where the dot has been redefined. Almost always a bug. Use the `$` prefix (`$.issue.title`) to reach root data from inside these blocks.
- **Unknown template variable** (`unknown_var`). A top-level variable reference not in the template data contract. For example, `{{ .config }}` or `{{ $.settings }}`. Valid top-level variables are `.issue`, `.attempt`, `.run`, `.stage`, and the variables reactions add, such as `.ci_failure`; the message lists them all.
- **Unknown sub-field** (`unknown_field`). A sub-field of a known top-level variable that does not exist in the domain schema. For example, `{{ .run.foo }}` or `{{ .issue.nonexistent }}`. Also flags sub-field access on scalar variables like `{{ .attempt.something }}`.
- **Unused shared block** (`unused_partial`). A `{{ define }}` block in a file listed under [`dispatch.partials`](/reference/workflow-config/#partials) that no prompt template calls, directly or through another block. The warning names the block and its line in the partial, and reads `template "<name>" is defined but no prompt template calls it`. One warning per block, in the order the partials load. Call the block from a template with `{{ template "<name>" . }}`, or delete it, to end the warning.

**Configuration checks:**

- **Unreachable `mcp_config`** (`agent.mcp_config`). An agent kind's pass-through block sets `mcp_config` (`mock.mcp_config`, for example; the `agent:` section carries no such key) for a kind whose adapter delivers the generated MCP configuration to the agent process in no form at all, so the value cannot reach the agent. `mock` is one such built-in kind, and any custom adapter declaring the same disposition draws the warning too. `claude-code` and `copilot-cli` deliver the generated file itself, so the check never fires for them. `codex`, `opencode`, and `agent-client-protocol` deliver that file's servers re-expressed rather than the file, and only on a local launch; the check does not fire for them either, because validation reads the workflow file offline and cannot know which sessions will be dispatched to an SSH host. Set `mcp_config` in one of those three blocks and dispatch the session over SSH, and you get neither the warning nor the effect.
- **No tool execution channel** (`agent.kind.no_tool_channel`). The agent kind delivers no channel for Sortie's tools even on a local launch, so the session can neither call them nor be told about them. It fires for every kind whose adapter declares that it never delivers the generated MCP configuration, `mock` being one such built-in kind, and for any adapter that declares no MCP disposition at all. It does not fire for `codex`, `opencode`, or `agent-client-protocol`, whose channel exists locally; validation reads the workflow file offline and cannot know which sessions will be dispatched to an SSH host.
- **Token ceiling on a kind that reports no usage** (`agent.kind.no_usage_reporting`). `agent.max_tokens` is set against an agent kind whose declared usage reporting yields no figure for the sessions this configuration produces, so the per-issue token ceiling has nothing to count against. Budget those sessions by time instead, through `agent.turn_timeout_ms`.
- **Money ceiling on a kind that reports no usage** (`agent.max_cost_usd.no_usage_reporting`). `agent.max_cost_usd` is set above `0` against an agent kind whose declared usage reporting yields no figure for the sessions this configuration produces, so there is nothing to price and the per-issue money ceiling can never be reached for that kind. Budget those sessions by time instead, through `agent.turn_timeout_ms`.
- **Money ceiling with no rate source** (`agent.max_cost_usd.no_rate_source`). `agent.max_cost_usd` is set above `0` while no price source is configured: `price_table.embedded` and `price_table.fetch` are off, and neither a `token_rates` entry nor a price table you supply is set. No run can be priced, so the ceiling holds no issue. The check reads configuration only, so `validate` and the running service agree. A model that the configured rates do not list draws no warning. See [`token_rates`](/reference/workflow-config/#token_rates) and [`price_table`](/reference/workflow-config/#price_table) for the sources.
- **Instance spend ceiling on a kind that reports no usage** (`agent.max_daily_cost_usd.no_usage_reporting`, `agent.max_monthly_cost_usd.no_usage_reporting`). The named setting is above `0` against an agent kind whose declared usage reporting yields no figure for the sessions this configuration produces, so the ceiling counts none of that kind's spend.
- **Instance spend ceiling with no rate source** (`agent.max_daily_cost_usd.no_rate_source`, `agent.max_monthly_cost_usd.no_rate_source`). The named setting is above `0` while no price source is configured, on the same terms as `agent.max_cost_usd.no_rate_source`, so no run can be priced and the ceiling counts no spend.
- **Rates priced for a kind that reports no usage** (`agent.kind.no_cost_estimate`). A [`token_rates`](/reference/workflow-config/#token_rates) entry prices an agent kind that reports no token usage for the sessions this configuration produces, so no cost can be estimated for it and the dashboard reads "not measured" for its cost. Remove the entry or move the workload to a kind that reports usage.

Unlike the checks above them, the usage checks (`agent.kind.no_usage_reporting`, `agent.max_cost_usd.no_usage_reporting`, the two instance spend ceiling variants, and `agent.kind.no_cost_estimate`) read [`worker.ssh_hosts`](/reference/workflow-config/#worker) and resolve the disposition for a remote launch when the pool is non-empty. `copilot-cli` reports usage on a local launch and none over SSH, so a workflow that adds a host pool draws these warnings where the same file without one drew none.

Every check in this group runs for every agent kind the configuration can reach, including one named only by a [dispatch rule](/reference/workflow-config/#dispatch), and each kind reports its own warning.

**Recorded advisories:**

- **Label-commands poll interval clamped** (`reactions.label_commands.poll_interval_ms.clamped`). [`reactions.label_commands.poll_interval_ms`](/reference/workflow-config/#reactionslabel_commands) is set below its floor of `30000`; the floor is used instead.
- **Env file missing** (`env_file.missing`). The file named by [`--env-file`](#--env-file) or `SORTIE_ENV_FILE` does not exist; no values are read from it.
- **Env override replaced a non-mapping section** (`env_override.section_replaced`). A [`SORTIE_*` override](/reference/environment/#configuration-overrides) targets a section that is not a YAML mapping; the section is replaced with one holding only the overridden settings.
- **Deprecated agent kind** (`agent.kind.deprecated`). A reachable agent kind is registered as deprecated: it still runs unchanged, and the message names the kind that replaces it and says a later release removes it. One warning per deprecated kind, for every kind named by `agent.kind`, `dispatch.default.agent`, or a `dispatch.rules[i].agent`. Move the workflow to the replacement kind to end it.
- **Effort on a kind that passes none** (`agent.effort.not_forwarded`). A reachable agent kind whose adapter passes no reasoning level to its agent, such as `agent-client-protocol` or `mock`, has a non-empty `effort`, or an `effort` of another type, in its settings block, so the setting has no effect. One warning per such kind, for every kind named by `agent.kind`, `dispatch.default.agent`, or a `dispatch.rules[i].agent`, and one more per dispatch rule of such a kind whose resolved block carries an `effort`, written in the rule or inherited, with the message opening `dispatch rule "<name>" (dispatch.rules[<i>].<kind>): `. For `agent-client-protocol`, write the runtime's own reasoning option in `agent.command`; see [reasoning effort](/reference/workflow-config/#adapter-pass-through-configuration).
- **Rule changes the model and keeps an inherited effort** (`agent.effort.inherited`). A [dispatch rule](/reference/workflow-config/#rule-settings-blocks) writes `model` in its settings block, does not write `effort`, and inherits a non-empty `effort` from the top-level block of its kind. Level names depend on the model, so the inherited level may not exist for the rule's model. The message reads `dispatch rule "<name>" (dispatch.rules[<i>].<kind>) sets model and inherits effort "<level>" from the top-level <kind> block; level names depend on the model, so write effort in the rule to choose the level for its model, or effort: null to clear it`. One warning per such rule.
- **Deprecated tracker comment flag** (`tracker.comments.on_dispatch.deprecated`, `tracker.comments.on_completion.deprecated`, `tracker.comments.on_failure.deprecated`). The flag resolves to `true`, from the workflow file or from its `SORTIE_TRACKER_COMMENTS_*` variable. The flag keeps posting, and the message names the events to list in a `tracker_comment` entry of [`notifications`](/reference/workflow-config/#notifications). One warning per flag.
- **Deprecated comment escalation** (`reactions.<kind>.escalation.deprecated`). A reaction with a provider sets `escalation: comment`. The message names `escalation: none` and the `escalation.<kind>` event to list in a `tracker_comment` entry. One warning per reaction.
- **Implicit tracker comment** (`notifications.tracker_comment.implicit_auto_merge`, `notifications.tracker_comment.implicit_budget_hold`). A tracker is configured, no `tracker_comment` entry exists, and the workflow relies on the auto-merge success comment (the auto-merge reaction has a provider) or the budget-hold comment (`agent.max_sessions`, `agent.max_tokens`, or `agent.max_cost_usd` is above `0`). The comment keeps posting. Adding an entry that lists `auto_merge.merged` or `budget.held` ends the warning, and an entry that omits the event ends the comment.
- **Notification entry without `events`** (`notifications[<i>].events.missing`). A `webhook` or `slack` entry omits `events` and so receives `agent.message` only. The message suggests `events: [agent.message]`. One warning per entry.
- **Invalid token rate entry** (`token_rates`). The block or an entry has the wrong type, an entry uses an empty key or unknown key, a rate is invalid, or a kind entry lacks `input_per_mtok` or `output_per_mtok`. The warning names the rejected value or incomplete entry; the workflow remains valid.
- **Kind entry turns off per-model pricing** (`token_rates.per_kind`). A [`token_rates`](/reference/workflow-config/#kind-entries) entry is keyed by an agent kind, so it prices every model of that kind alike. One warning per such entry. Key the entry by a model name to price that model alone.
- **Incomplete entry for an unlisted model** (`token_rates.model_incomplete`). A [`token_rates`](/reference/workflow-config/#model-entries) entry is keyed by a model that the price table the configuration selects does not list, and it leaves one of its four rates unset. That table is your [`price_table.replace_file`](/reference/workflow-config/#price_table) when set, else the built-in table. The warning names the unset rates. The entry still prices the classes it sets, and a run that spends an unset class is recorded as partial.
- **Session budget shorter than a stage chain** (`dispatch.next.max_sessions`). `agent.max_sessions` is above `0` and smaller than the number of runs the longest stage chain needs, one per rule on it, so an issue on that chain exhausts its session budget before the chain ends. The message reads `agent.max_sessions <n> is smaller than the <runs> runs the longest stage chain needs (<path>); an issue on it exhausts its session budget before the chain ends`, where `<path>` lists the chain's rule names, as in `specify -> implement`. One warning, for the longest chain.

Each of these is recomputed fresh every time the configuration is built. `sortie validate` and `sortie` [`--dry-run`](#--dry-run) report every currently-applicable advisory on every invocation, with no memory of an earlier run. The long-running process is the exception: its run log records an advisory once and again only after the condition has cleared and returned, kept in memory for the life of the process, so a restart logs it again immediately if the condition still holds. None of them affect `valid` or the exit code.

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

**Text** (default): each diagnostic is written to stderr, one per line, prefixed with its severity:

```
error: tracker.kind: tracker.kind is required
error: agent_adapter: unknown agent kind "nonexistent"
```

Format: `{severity}: {check}: {message}`

Warning-only output (exit `0`):

```
warning: unknown_key: trackers: unknown top-level key "trackers"
warning: dot_context: /srv/sortie/WORKFLOW.md (line 24): did you mean "$.issue.identifier" instead of ".issue.identifier"? Inside a {{ range }}/{{ with }} block (including arguments to nested range/with), dot refers to the current element, not root data
warning: unknown_var: /srv/sortie/partials/shared.md (line 1): unknown template variable ".config"; valid top-level variables are: .issue, .attempt, .run, .stage, .ci_failure, .review_comments, .bot_review_comments, .merge_conflict, .label_review, .label_fix
warning: unknown_field: /srv/sortie/rules/bug.md (line 1): unknown field ".run.foo"; known fields: is_continuation, max_turns, turn_number
warning: unused_partial: /srv/sortie/partials/shared.md (line 2): template "footer" is defined but no prompt template calls it
```

When no errors and no warnings are present, nothing is written.

When the workflow file itself cannot be loaded, a single error line is emitted:

```
error: workflow_load: workflow file not found: /path/to/WORKFLOW.md: ...
```

**JSON** (`--format json`): a single JSON object is written to stdout on both success and failure:

```json
{"valid":true,"errors":[],"warnings":[]}
```

```json
{"valid":false,"errors":[{"severity":"error","check":"tracker.kind","message":"tracker.kind is required"}],"warnings":[]}
```

With warnings only:

```json
{"valid":true,"errors":[],"warnings":[{"severity":"warning","check":"unknown_key","message":"trackers: unknown top-level key \"trackers\""}]}
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
| `config.<field>` | Configuration field type or value error (e.g., `config.polling.interval_ms`, `config.tracker.handoff_state`, `config.tracker.handoff_evidence`, `config.dispatch.rules[0].match.title`, `config.dispatch.rules[0].opencode`, `config.dispatch.partials[0]`). |
| `config.workspace.retention_days` | Workspace retention window is not an integer, is negative, or is non-zero but below the accepted minimum. |
| `config.agent.turn_timeout_ms` | The per-turn timeout is not a positive integer. |
| `reactions.review_comments` | Invalid `reactions.review_comments` block. |
| `reactions.bot_review` | Invalid `reactions.bot_review` block. |
| `reactions.auto_merge` | Invalid `reactions.auto_merge` block. |
| `reactions.merge_conflicts` | Invalid `reactions.merge_conflicts` block. |
| `reactions.merge_completion` | Invalid `reactions.merge_completion` block: a missing or colliding `target_state`, a required `tracker` field left unset, or a `poll_interval_ms` below the floor. |
| `reactions.scm_provider_conflict` | Two active SCM reactions name different providers. |
| `scm_adapter` | The single provider named by the active SCM reactions has no registered SCM adapter. |
| `ci_provider` | `reactions.ci_failure.provider` names a provider that has no CI status support registered. |
| `template_parse` | A template or partial that cannot load: a Go template syntax error in the prompt body, the default template, a rule template, or a partial; a define name that two files both define; text outside the `define` blocks of a partial; or a call to a template that nothing defines. The message names the file and line. |
| `tracker.kind` | Missing `tracker.kind` field. |
| `tracker.api_key` | Missing or empty API key after environment variable expansion. |
| `tracker.project` | Missing `tracker.project` when required by the adapter. |
| `tracker_adapter` | Unknown tracker adapter kind. |
| `agent.kind` | Missing `agent.kind` field. |
| `agent.command` | A reachable agent kind launches a process but would run nothing: the default kind has no `agent.command` and no default command, or a `dispatch` rule routes to a kind with no default command that is not the default kind. The message names the selector. |
| `agent_adapter` | Unknown agent adapter kind. |
| `price_table.replace_file` | `price_table.replace_file` is not a string, resolves to an empty string through a `$VAR`, names a file that cannot be read, or names a file that is not a valid price table. |
| `price_table.fetch_url` | `price_table.fetch_url` resolves to an empty string through a `$VAR`. |
| `price_table.replace_url` | `price_table.replace_url` resolves to an empty string through a `$VAR`. |
| `price_table.replace_conflict` | `price_table.replace_file` and `price_table.replace_url` are both set. |
| `tracker.project.format` | `tracker.project` is non-empty but not in `owner/repo` format (GitHub adapter). |
| `dispatch.agent.missing_block` | A `dispatch.default.agent` or `dispatch.rules[i].agent` names a registered kind, other than `agent.kind`, with no top-level settings block in the front matter, and at least one selector of that kind is not a rule carrying its own settings block. |
| `config.dispatch.rules[<i>].stage` | A rule's `stage` is not a string, has no character other than white space, or repeats an earlier rule's stage label regardless of case. |
| `config.dispatch.rules[<i>].next` | A rule's `next` is not a string or is blank, names no rule, names the rule that carries it, names a rule without a stage label, or closes a cycle of `next` links; or `next` is written while `tracker.handoff_state` is unset. |
| `config.dispatch.max_consecutive_hops` | Not an integer, not greater than `0`, or smaller than the number of hops in the longest stage chain. |
| `dispatch.stage.collision` | A rule's stage label equals, regardless of case, an active or terminal state, `tracker.handoff_state`, `tracker.in_progress_state`, `tracker.no_change_state`, a reaction's `escalation_label`, or the parking label. |
| `agent.kind.session_resume` | An agent kind's pass-through block sets a key the adapter declares as blocking session resume across separate agent launches. |
| `workspace.root_writable` | Workspace root directory does not exist and cannot be created, or is not writable. |
| `args` | Invalid command-line arguments (too many positional args). |

Check values from preflight validation match the [startup and configuration errors](/reference/errors/#startup-and-configuration-errors) table. Adapter-specific error checks (e.g., `tracker.project.format`) are produced by the registered adapter's own validation.

#### Advisory warning check values

Warning diagnostics use a separate set of check values. They appear only in the `warnings` array (JSON) or with the `warning:` prefix (text). They do not affect `valid` or the exit code.

| Check | Meaning |
|---|---|
| `unknown_key` | Unrecognized top-level YAML key. Likely a typo (e.g., `trackers` instead of `tracker`). |
| `unknown_sub_key` | Unrecognized key inside a known section (e.g., `tracker.typo_endpoint`). Adapter pass-through sub-objects matching the configured `kind` are exempt. |
| `type_mismatch` | Value type does not match the expected type for the field (e.g., string where integer is expected). Also covers semantic issues: non-positive `hooks.timeout_ms`, non-numeric or non-positive values in `agent.max_concurrent_agents_by_state`. An out-of-range integer never produces this warning; see [Validation scope](#validation-scope) for what checks it instead. |
| `ineffective_setting` | `agent.token_warning_percent` is set above `0` while `agent.max_tokens` is `0`, so the token warning threshold derives from a ceiling that is not in force. |
| `unresolved_extension_var` | A `$VAR` or `${VAR}` reference inside an extension field (an adapter pass-through block, a dispatch rule's settings block, or `server`, `logging`, `worker`) whose named environment variable is unset or empty. |
| `dot_context` | Reference to a top-level data key (such as `.issue`, `.run`, or `.stage`) inside a `{{ range }}` or `{{ with }}` block where dot is the current element, not root data. Use `$` prefix to fix. |
| `unknown_var` | Top-level template variable not in the data contract. Valid variables: `.issue`, `.attempt`, `.run`, `.stage`, and the variables reactions add. |
| `unknown_field` | Sub-field of a known top-level variable that does not exist in the domain schema (e.g., `.issue.nonexistent`, `.run.foo`). |
| `unused_partial` | A `define` block in a [`dispatch.partials`](/reference/workflow-config/#partials) file that no prompt template calls. |
| `agent.mcp_config` | An agent kind's pass-through block sets `mcp_config` for a kind whose adapter delivers the generated MCP configuration to the agent process in no form at all, so the value cannot reach the agent. |
| `agent.kind.no_tool_channel` | The agent kind has no tool execution channel, so Sortie's tools are neither advertised in the first-turn prompt nor callable during the session. |
| `agent.kind.no_usage_reporting` | `agent.max_tokens` is set against an agent kind that reports no token usage for the sessions this configuration produces, so the per-issue token ceiling has nothing to count against. |
| `agent.max_cost_usd.no_usage_reporting` | `agent.max_cost_usd` is set above `0` against an agent kind that reports no token usage for the sessions this configuration produces, so the per-issue money ceiling can never be reached for it. |
| `agent.max_cost_usd.no_rate_source` | `agent.max_cost_usd` is set above `0` while no price source is configured, so no run can be priced and the ceiling holds no issue. |
| `agent.max_daily_cost_usd.no_usage_reporting`, `agent.max_monthly_cost_usd.no_usage_reporting` | The named setting is above `0` against an agent kind that reports no token usage for the sessions this configuration produces, so the instance spend ceiling counts none of its spend. |
| `agent.max_daily_cost_usd.no_rate_source`, `agent.max_monthly_cost_usd.no_rate_source` | The named setting is above `0` while no price source is configured, so no run can be priced and the ceiling counts no spend. |
| `agent.kind.no_cost_estimate` | `token_rates` prices an agent kind that reports no token usage for the sessions this configuration produces, so no cost can be estimated for it. |
| `reactions.label_commands.poll_interval_ms.clamped` | `reactions.label_commands.poll_interval_ms` is set below its floor of `30000`; the floor is used instead. |
| `env_file.missing` | The file named by [`--env-file`](#--env-file) or `SORTIE_ENV_FILE` does not exist; no values are read from it. |
| `env_override.section_replaced` | A `SORTIE_*` override targets a section that is not a YAML mapping; the section is replaced with one holding only the overridden settings. |
| `agent.kind.deprecated` | A reachable agent kind is deprecated: it still runs, and the message names its replacement. |
| `agent.effort.not_forwarded` | A reachable agent kind that passes no reasoning level to its agent has `effort` set in its settings block, or a dispatch rule of that kind resolves one, so the setting has no effect. |
| `agent.effort.inherited` | A dispatch rule writes `model`, does not write `effort`, and inherits a non-empty `effort` from the top-level block of its kind. |
| `tracker.comments.on_dispatch.deprecated`, `tracker.comments.on_completion.deprecated`, `tracker.comments.on_failure.deprecated` | The flag resolves to `true`. It still posts, and the message names the replacement events. |
| `reactions.<kind>.escalation.deprecated` | A reaction sets `escalation: comment`. It still posts, and the message names `escalation: none` and the event to subscribe. |
| `notifications.tracker_comment.implicit_auto_merge`, `notifications.tracker_comment.implicit_budget_hold` | The workflow relies on the auto-merge success comment or the budget-hold comment while no `tracker_comment` entry exists. |
| `notifications[<i>].events.missing` | A `webhook` or `slack` entry omits `events`. |
| `token_rates` | A `token_rates` value is malformed, incomplete, or contains an unrecognized key. The invalid part is ignored or the incomplete entry prices nothing. |
| `token_rates.per_kind` | A `token_rates` entry is keyed by an agent kind, so it prices every model of that kind alike and turns off per-model pricing for it. |
| `token_rates.model_incomplete` | A `token_rates` entry for a model that no price table in force lists leaves a rate unset. It prices only the classes it sets. |
| `tracker.active_states.empty` | `tracker.active_states` is empty, so no issue is dispatched. The check does not block startup. |
| `dispatch.next.max_sessions` | `agent.max_sessions` is above `0` and smaller than the number of runs the longest stage chain needs, so an issue on that chain exhausts its session budget before the chain ends. |

#### Adapter-specific warning check values

When the tracker adapter declares its own config validation, it can produce additional warnings. These appear alongside the advisory warnings above and follow the same rules: they do not affect `valid` or the exit code.

The GitHub adapter (`tracker.kind: github`) produces these warning checks:

| Check | Meaning |
|---|---|
| `tracker.api_key.github_token_hint` | `tracker.api_key` is empty but the `GITHUB_TOKEN` environment variable is set. Consider using `api_key: $GITHUB_TOKEN`. |
| `tracker.api_key.github_token_missing` | `tracker.api_key` is empty and `GITHUB_TOKEN` is not set. |
| `tracker.states.overlap` | A label appears in both `active_states` and `terminal_states` (case-insensitive). |

State collisions involving `handoff_state` or `in_progress_state` are not warnings. The generic configuration layer rejects them for every `tracker.kind` before adapter validation runs, and they are reported under the `config.tracker.handoff_state` and `config.tracker.in_progress_state` check values with exit code `1`.

For details on each check, see [GitHub adapter validate-time checks](/reference/adapter-github/#validate-time-checks). The [Jira](/reference/adapter-jira/), [GitLab](/reference/adapter-gitlab/), [Gitea](/reference/adapter-gitea/), and [Linear](/reference/adapter-linear/) adapter references list the checks those adapters declare.

### `stats`

Reports how past runs went and what they cost. Sortie appends one row to `run_history` each time an agent session finishes; `stats` reads that history back over a time range and aggregates it into run counts, the number of issues those runs belong to, success rate, duration percentiles, turns, token sums, and the estimated cost recorded with each run, that cost per UTC day or month in JSON, broken down by outcome, by coding agent, by dispatch rule, by prompt template, by model, by stage chain, by retry trigger, and by run origin, plus a funnel for each stage chain. The database is opened read-only, so the command is safe to run while the orchestrator is working, and it makes no network call. A running Sortie serves the same report over HTTP at [`GET /api/v1/stats`](/reference/http-api/#get-apiv1stats-run-statistics).

```
sortie stats [--format text|json] [--since value] [--until value] [workflow-path]
```

The workflow file supplies two things: `db_path`, which locates the database, and the [`dispatch`](/reference/workflow-config/#dispatch) section, whose stage chains define the [stage funnels](#stage-funnels). The command reads those, opens the database read-only, writes the report, and exits. It does not start the orchestrator, apply migrations, spawn agents, or write anything. It prices nothing either: it reads the cost Sortie recorded with each run when the run finished, so the [`token_rates`](/reference/workflow-config/#token_rates) the file holds now plays no part in the report.

The command loads the `dispatch` section on every run, whether or not it defines a stage chain. A section that does not load, such as a rule whose prompt template file is missing, stops the command with the error on stderr, in the form `sortie validate` prints it, and exit code `1`. No report is written.

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

**`full`**: the table carries all five optional column groups:

| Group | Columns | Figures it supplies |
|---|---|---|
| Turns | `turns_completed` | Mean turns, in the summary and in every breakdown row |
| Self-review | `review_metadata` | The self-review section |
| Dispatch-rule routing | `rule_name`, `template_id` | The dispatch-rule and prompt-template breakdowns |
| Tokens | `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens` | Token sums and every derived cost figure. `cache_write_tokens`, when present, adds the cache-write sum without changing the tier. |
| Token measurement | `tokens_measured` | Which runs the coding agent could measure, and so which ones the token and cost figures cover |

A sixth group sits outside the tier: `configured_model`, `configured_effort`, and `reported_model`. Only the model breakdown depends on it, so a database without it is still `full`. See [model breakdown](#model-breakdown). A seventh, `chain_id`, `stage_target`, and `stage_result`, sits outside the tier too and supplies only the stage chain breakdown. See [stage chain breakdown](#stage-chain-breakdown). The `trigger` and `reaction_kind` columns sit outside the tier as well and supply the retry trigger breakdown. See [retry trigger breakdown](#retry-trigger-breakdown). The run origin breakdown needs them and `first_after_hop`, which sits outside the tier too. See [run origin breakdown](#run-origin-breakdown). The stage funnels need every column named above and `agent_blocked`, which sits outside the tier as well. See [stage funnels](#stage-funnels).

**`base`**: at least one group is missing. The report falls back to run counts, the outcome breakdown, the coding-agent breakdown, and durations. Turns, tokens, cost, the dispatch-rule breakdown, the prompt-template breakdown, the configured-model breakdown, the stage chain breakdown, the retry trigger breakdown, the run origin breakdown, the stage funnels, and the self-review section are all left out.

The tier is all-or-nothing by design. A database carrying four of the five groups still reports `base`, and the report then drops the groups it does carry along with the ones it never recorded. The warning names both lists so the two are not confused:

```
warning: this database was written before sortie recorded dispatch-rule routing, tokens and cost, which runs the coding agent could measure, the model each run was configured with, stage chains, what started each run, the first run after each stage hop, which runs stopped to wait for a person. The report falls back to run counts and durations, so it also leaves out turns, self-review results, which this database does carry. Run sortie once with this workflow to get the full report.
```

A degraded report is still a report: the warning goes to stderr in text mode and into `warnings` in JSON, and the exit code is `0`. In JSON, `by_rule`, `by_template`, `by_model`, `by_chain`, `chain_funnels`, `by_trigger`, and `by_origin` are empty arrays, `self_review` is `null`, and every figure the tier cannot supply is `null` rather than `0`. A null means the database never recorded that figure, not that the figure measured zero.

The remedy is to run the orchestrator once with this workflow. Startup applies the pending migrations, and runs recorded from then on carry the full set. `stats` cannot do this itself; its read-only connection cannot apply a migration.

A full-tier database that predates `cache_write_tokens` remains full. The command reports `cache_write` as `0` for those runs, whose input tokens were priced at `input_per_mtok`, matching how they were recorded before the cache-write counter existed.

On a `full` database written before Sortie recorded the cost of each run, the report leaves out cost: every cost figure is `null` (`-` in text), `cost_unpriced_runs` is `0`, and `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded the cost of each run, so the report leaves out cost. Run sortie once with this workflow to add it.
```

The start that adds the cost columns also prices the runs recorded before them, once, under the rates in force at that start. When the database also predates the column of a breakdown, such as the [model](#model-breakdown), the report carries that breakdown's warning instead, ending with `The report also leaves out cost until then.`

When `run_history` is absent altogether, or missing any of `status`, `agent_adapter`, `started_at`, or `completed_at`, the file is not a Sortie database and the command exits `1`:

```
sortie stats: run_history table not found or missing base columns
```

#### Model breakdown

The `by model` table (`by_model` in JSON) groups runs by the model they spent tokens on.

- A run that spent tokens on more than one model counts once in the group of every model it spent tokens on. The group carries that model's tokens and recorded cost, and the run's outcome, turns, and duration, so a group's success rate, mean turns, duration, and cost per succeeded run cover the runs that used the model. The `runs` of the groups can add up to more than `summary.runs`, and their `share` values to more than `1`. No run-level token or cost total reaches a group, and a group takes each model's recorded cost as it is, without reconciling it with the run's cost.
- A run that recorded no spend by model counts once, under the model the runtime reported running, else the `model` its resolved settings carried (the value a [dispatch rule](/reference/workflow-config/#dispatch) can set per issue), else `<none>`. This covers a run whose agent reported its spend only as a total, a run recorded before Sortie stored spend by model, and every `ci_failed` run. On a database that records no cost, every run counts this way. [How the reported and the configured model differ](/reference/http-api/#configured-and-reported-model) is explained with the running session fields.
- Each model's cost is the one recorded when the run finished, as in every other breakdown. Sortie prices a run per model, so two models of one agent kind are priced at their own rates, unless a [`token_rates` kind entry](/reference/workflow-config/#kind-entries) prices that kind alike.
- `tokens_unmeasured_runs`, `cost_unpriced_runs`, and `cost_partial_runs` count a model's share of a run rather than the whole run. A share counts as partial when its recorded cost status is `partial`, or when it is `estimated` and the run recorded turns no token figure covered, because the spend those turns leave out belongs to no model. Such a run counts as partial in every group that carries a recorded cost for it.
- The table follows the prompt-template table in text output.

On a `full` database written before Sortie recorded the model of each run, the report carries no breakdown: `by_model` is `[]`, never `null`, the text report omits the table, and `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded the model of each run, so the report leaves out the breakdown by model. Run sortie once with this workflow to add it.
```

Running the orchestrator once applies the migration. Runs recorded before it stay under `<none>`.

On a `base` database the group is named in the degraded-schema warning shown under [schema tiers](#schema-tiers) instead, and `by_model` is `[]` as well.

#### Stage chain breakdown

The `by stage chain` table (`by_chain` in JSON) groups runs by stage chain: one pass of one issue through the [stage chains](/reference/workflow-config/#stage-chains) the workflow configures, retries included. Each chain is named by a generated 26-character identifier, the one `GET /api/v1/runs` returns as [`chain_id`](/reference/http-api/#get-apiv1runs-run-history).

- Only chains where a hop was due or made are listed: at least one of the chain's runs in the range followed a hop or ended in a hop decision. Every run carries a chain identifier, including one that never takes part in a stage chain, so `by_chain` is a listing rather than a partition, and its run counts need not add up to the report's total.
- A run recorded before Sortie stored chains carries none and is left out.
- `issue` is the issue's display identifier, or its tracker identifier when it has none, as the chain's latest run recorded it.
- `stages` lists the rules the chain's runs followed, in the order they ran, with consecutive runs of one rule, such as a retry, counted once. Only runs inside the range contribute.
- `last_hop` is the latest hop decision among the chain's runs in the range. It is empty in JSON, and `-` in text, when no run in the range reached one. A run on the last stage of a chain reaches no hop decision, so a chain that ran to its end keeps the result of its last hop.

| `last_hop` | Meaning |
|---|---|
| `advanced` | The hop was made: the next stage's label was added and the other stage labels were removed. |
| `partial` | The hop was made, but at least one other stage label could not be removed from the issue. |
| `failed` | The hop was not made: the next stage's label could not be added. |
| `ceiling` | The hop was not made: the issue had reached [`dispatch.max_consecutive_hops`](/reference/workflow-config/#stage-chains). |

The figures cover every run of the chain in the range, as in the other non-outcome breakdowns, and entries are sorted the same way. The text table puts four columns ahead of the figures and prints the 20 chains with the most runs:

```
by stage chain
  CHAIN                       ISSUE          STAGES                LAST HOP  RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  H7RD2KXW5NQM3TBZ6CJPLV4YSE  owner/repo#57  specify -> implement  advanced  3     2          66.7%         7m 0s   8m 30s  6m 16s  4.3    250,000       $1.25
  Q4ZK7MNB2XWRT5HDJ3LCPEVS6A  owner/repo#42  specify -> implement  advanced  2     2          100.0%        4m 10s  9m 40s  6m 55s  4.5    167,000       $0.86
  M2TQ6VXH4RKZ7BNWD3JCLP5YSA  owner/repo#61  specify               failed    1     1          100.0%        3m 50s  3m 50s  3m 50s  2.0    43,000        $0.21
```

The table follows the model table and is omitted when no chain qualifies. When more than 20 chains qualify, a footnote names the total, and `--format json` carries every entry:

```
note: the breakdown by stage chain shows the 20 stage chains with the most runs; --format json lists all 37.
```

On a `full` database written before Sortie recorded stage chains, `by_chain` is `[]`, the text report omits the table, and `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded stage chains, so the report leaves out the breakdown by stage chain. Run sortie once with this workflow to add it.
```

When the database also predates the configured-model columns, only the model warning appears, and running the orchestrator once adds both breakdowns. On a `base` database stage chains are named in the degraded-schema warning instead, and `by_chain` is `[]` as well.

#### Stage funnels

The stage funnels (`chain_funnels` in JSON, one table per funnel in text) count the passes through each stage of the [stage chains](/reference/workflow-config/#stage-chains) the workflow configures: how many reached a stage, how each one left it, and how long it spent there. The [stage chain breakdown](#stage-chain-breakdown) lists individual passes; a funnel counts them per stage.

- A pass is the set of runs that share a chain identifier. It counts once on a stage, however many runs it makes there, retries and pull request fixes included.
- A funnel is one chain definition. Chains of the `dispatch` section that share a stage merge into one funnel, so a stage that two chains reach has one row. Funnels follow the order of the chains in the workflow. A chain that joins another contributes its stages ahead of the stage where it joins, and its first stage is marked as an entry.
- A funnel lists every stage of its chain, with zero counts when no pass reached it, and a range that holds no runs included. It never grows with the number of passes.
- Only runs that finished in the range count. A pass that is running, queued for a retry, or held by a budget when the report is made counts as well, under the rules below.

The text report prints one table per funnel after the stage chain table, on the `full` tier only. It lists every stage and is not truncated.

```
chain from specify
  #  STAGE            RUNS  ENTERED  BY LABEL  ADVANCED      CEILING  HOP FAILED  NO HOP            IN STAGE  MEDIAN
  1  specify (entry)  14    12       4         10            0        0           2 needs a person  0         7m 0s
  2  implement        21    10       0         6             1        1           1 failed run      1         21m 0s
  3  review           8     7        1         5 handed off  0        0           1 budget held     1         9m 0s
```

The title names the entry stages, joined by `or`. The columns:

| Column | Meaning |
|---|---|
| `#` | The position of the stage in the funnel. |
| `STAGE` | The dispatch rule of the stage, followed by `(entry)` on a stage where a chain starts. |
| `RUNS` | `runs`. |
| `ENTERED` | `entered`. |
| `BY LABEL` | `arrivals.label`. The other arrivals are in JSON only. |
| `ADVANCED` | `outcomes.advanced`. On the last stage, `outcomes.handed_off` followed by `handed off`. |
| `CEILING` | `outcomes.ceiling`. |
| `HOP FAILED` | `outcomes.hop_failed`. |
| `NO HOP` | `outcomes.no_hop`. When it is above zero, the reason with the most passes follows, worded `failed run`, `needs a person`, `budget held`, `stopped by an operator`, or `verdict withheld`. The other reasons are in JSON only. |
| `IN STAGE` | `outcomes.in_stage`. |
| `MEDIAN` | `median_seconds`, `-` when it is `null`. |

Each element of `chain_funnels` is `{"stages": [...]}`, with one element per stage in funnel order. The fields of a stage:

| Field | Type | Description |
|---|---|---|
| `rule` | string | The dispatch rule of the stage. |
| `entry` | boolean | `true` when a chain starts at the stage. |
| `last` | boolean | `true` on the final stage of the funnel, the stage whose finished pass is handed off. |
| `runs` | integer | The finished runs of the rule in the range, as the `by_rule` group of the rule counts them. |
| `entered` | integer | The passes that reached the stage in the range, plus the passes held there now. |
| `arrivals` | object | `entered` split by how the pass reached the stage, below. |
| `outcomes` | object | `entered` split by how the pass left the stage, below. |
| `no_hop_reasons` | array of object | The passes counted in `outcomes.no_hop`, as `{"reason", "passes"}` pairs, the largest first. A reason without passes is absent. |
| `median_seconds` | number or null | The median, over the passes, of the seconds a pass spent on the stage, summing its finished runs there, nearest rank. `null` when no pass has a finished run with a readable duration. |

Every pass counts in exactly one `arrivals` member and exactly one `outcomes` member, so each set of members adds up to `entered`.

| `arrivals` member | The pass |
|---|---|
| `hop` | Came from the previous stage by a hop. |
| `label` | Reached the stage with no hop, and the rule selects issues by stage label. |
| `match` | Reached the stage with no hop, and the rule matches the issue by its other conditions. |

The latest finished run of a pass on the stage decides its outcome. The first row of this table that fits the pass applies:

| Member | Reason | The pass |
|---|---|---|
| `in_stage` | | Has a session running or a retry queued now. |
| `advanced` | | Hopped to the next stage, with the hop result `advanced` or `partial`. On the last stage the pass counts in `handed_off` instead. |
| `ceiling` | | Reached [`dispatch.max_consecutive_hops`](/reference/workflow-config/#stage-chains), so the hop was refused. |
| `hop_failed` | | Failed to hop, with the hop result `failed`. |
| `no_hop` | `needs_person` | Succeeded, but the agent reported itself blocked and waiting for a person. |
| `handed_off` | | Succeeded on the last stage. Always `0` on any other stage. |
| `no_hop` | `budget_held` | Is held by a budget now. |
| `no_hop` | `operator_stopped` | Succeeded on a stage that is not the last without a hop, as when the issue left the active states. |
| `no_hop` | `verdict_withheld` | Failed because the [handoff evidence](/reference/state-machine/#handoff-evidence) verdict withheld its handoff. |
| `no_hop` | `needs_person` | Ended with the status `needs_person`. |
| `no_hop` | `budget_held` | Ended with the status `budget_stopped`. |
| `no_hop` | `operator_stopped` | Ended with the status `cancelled`. |
| `no_hop` | `run_failed` | Ended any other way. |

A pass that is running, queued for a retry, or held by a budget is read from the database, where Sortie keeps a record of each running session and budget hold, and from the retry queue. It counts only when the range is open at its end or ends after `generated_at`. For an earlier end, each pass is decided by its runs in the range alone. Sortie empties these records when it starts and restores nothing from them.

`chain_funnels` is `[]` when the workflow defines no stage chain, whatever the database holds. A `full` database written before Sortie recorded which runs stopped to wait for a person also reports `[]`, and while the workflow defines a chain, `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded which runs stopped to wait for a person, so the report leaves out the funnel of each stage chain. Run sortie once with this workflow to add it.
```

When the database predates any other breakdown column, that breakdown's warning appears instead, as the [retry trigger breakdown](#retry-trigger-breakdown) describes, and running the orchestrator once adds every breakdown. On a `base` database the degraded-schema warning names the missing column group, and `chain_funnels` is `[]` as well.

Adding the column does not backfill it. A run recorded before the upgrade in which the agent reported itself blocked was stored as a plain success, so its pass counts in `handed_off` on the last stage and in `no_hop` with the reason `operator_stopped` on any other stage, unless a session, a retry, or a budget holds the pass now. A run recorded with the status `needs_person` is classified as such at any age.

#### Retry trigger breakdown

The `by retry trigger` table (`by_trigger` in JSON) groups runs by what started the retry whose fire dispatched them, the value [`GET /api/v1/runs`](/reference/http-api/#get-apiv1runs-run-history) serves as `trigger`. Cost is priced as in every other breakdown.

| Group name | Runs it collects |
|---|---|
| `error`, `continuation`, `stall`, `ci_fix` | Runs dispatched by a retry that one of those triggers started. |
| `<none>` | Runs recorded with an empty trigger: a dispatch from the poll tick, a retry that a review, bot review, merge conflict, or label command reaction started, and a recorded CI result. |
| `<unknown>` | Runs whose row records no trigger: runs recorded before Sortie stored the trigger, and runs dispatched by a retry queued before it did. |

The sentinel `<none>` here means an empty recorded trigger, which is a fact about the run. `<unknown>` means the trigger was never recorded. Every run in the range falls in exactly one group, so the groups' `runs` add up to `summary.runs`, unlike `by_chain`. A database that predates the trigger column still reports its older runs under `<unknown>` once the column exists.

The text table follows the stage chain table, has the columns of the prompt-template table, and lists every group:

```
by retry trigger
  TRIGGER    RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN     TURNS  TOTAL TOKENS  COST
  <unknown>  4     2          50.0%         10m 0s  20m 0s  11m 40s  2.5    2,150,000     $7.52
  <none>     1     0          0.0%          0s      0s      0s       0.0    110,000       -
  ci_fix     1     1          100.0%        30m 0s  30m 0s  30m 0s   5.0    2,400,000     $12.00
```

On a `full` database written before Sortie recorded what started each run, `by_trigger` and `by_origin` are `[]`, the text report omits both tables, and `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded what started each run, so the report leaves out the breakdowns by retry trigger and by run origin. Run sortie once with this workflow to add them.
```

The report carries at most one such breakdown warning. When the database predates several of the breakdown columns, the model warning takes precedence over the stage chain one, that over this one, this one over the [run origin](#run-origin-breakdown) one, and that one over the [stage funnel](#stage-funnels) one; running the orchestrator once adds every breakdown. On a `base` database what started each run is named in the degraded-schema warning instead, and `by_trigger` is `[]` as well.

#### Run origin breakdown

The `by run origin` table (`by_origin` in JSON) groups runs by what started them. It splits the retry trigger breakdown's `<none>` group by origin: a dispatch from the poll tick, the first run after a [stage hop](/reference/workflow-config/#stage-chains), a pull request reaction, or a recorded CI result. Cost is priced as in every other breakdown.

A run belongs to the first group in this table that matches it:

| Group name | Runs it collects |
|---|---|
| `<unknown>` | Runs whose row records no trigger: runs recorded before Sortie stored what started a run, and runs dispatched by a retry queued before it did. |
| `error`, `continuation`, `stall`, `ci_fix` | Runs dispatched by a retry that one of those triggers started, including a retry of a run a reaction dispatched. |
| `review`, `bot-review`, `merge-conflict`, `label-review`, `label-fix` | Runs a pull request reaction dispatched, named by the reaction kind, the value [`GET /api/v1/runs`](/reference/http-api/#get-apiv1runs-run-history) serves as `reaction_kind`. |
| `<none>` | Recorded CI results (`ci_failed` runs), which no dispatch started. |
| `stage_hop` | The first run the poll tick dispatched after a stage hop, into the stage the hop led to. |
| `poll_tick` | Every other run the poll tick dispatched, including a later run in a stage a hop led to. |

Here `<none>` holds recorded CI results only, unlike in `by_trigger`. The `<unknown>` group and each group named by a retry trigger hold the same runs as the `by_trigger` group of that name. Every run in the range falls in exactly one group, so the groups' `runs` add up to `summary.runs`.

The text table, titled `by run origin` with an `ORIGIN` column, follows the retry trigger table, has the columns of the prompt-template table, and lists every group.

The migration that adds `first_after_hop` marks the earliest recorded run of each stage hop already in the history, so runs recorded before it still reach `stage_hop`. A later run in that stage stays unmarked.

On a `full` database that records what started each run but predates `first_after_hop`, `by_origin` is `[]`, the text report omits the table while keeping the retry trigger table, and `warnings` carries this message. The exit code is `0`.

```
warning: this database was written before sortie recorded the first run after each stage hop, so the report leaves out the breakdown by run origin. Run sortie once with this workflow to add it.
```

This warning comes second to last in the precedence of breakdown warnings, ahead of the [stage funnel](#stage-funnels) one. A database that also predates the trigger columns carries the [retry trigger](#retry-trigger-breakdown) warning instead, which names both breakdowns. On a `base` database the first run after each stage hop is named in the degraded-schema warning, and `by_origin` is `[]` as well.

#### Spend by period

The `spend` member of the JSON report sums the recorded cost of the runs in the range per UTC calendar period. The dashboard draws it as the spend chart in [Analytics](/reference/dashboard/#analytics). The text report has no such table. `spend` is `null` on the `base` tier and on a database that records no cost.

| Field | Type | Description |
|---|---|---|
| `period` | string | `day` when the range has a `since` that lies no more than 2160 hours before the end of the range, which is `until` or else `generated_at`. `month` otherwise, so a range of 90 days or less gets days and an open `since` gets months. |
| `buckets` | array of object | One element per period, ascending by `start`. Never `null`; `[]` when no run in the range has a parseable completion time. |

The buckets list every period from the one that holds `since` (the one that holds the earliest run when `since` is open) through the later of the one that holds the end of the range and the one that holds the latest run. A period without runs appears with `runs` `0` and `cost_usd` `null`. A run counts in the bucket whose period holds its completion time, so the buckets partition the runs they count. A run whose completion time is not an RFC 3339 timestamp counts in the summary and the breakdowns and in no bucket. The first bucket of a range whose `since` lies inside a period holds only the runs at or after `since`.

Each element of `buckets`:

| Field | Type | Description |
|---|---|---|
| `start` | string | The first instant of the period, RFC 3339 in UTC. |
| `runs` | integer | Runs that completed in the period. |
| `cost_usd` | number or null | The sum of the recorded costs of the period's priced runs, rounded to nine decimals. `null` when none is priced. It is the whole spend only while `cost_unpriced_runs`, `cost_partial_runs`, and `tokens_unmeasured_runs` are all `0`. |
| `tokens_unmeasured_runs` | integer | The period's runs counted as in `summary.tokens_unmeasured_runs`. |
| `cost_unpriced_runs` | integer | The period's runs counted as in `summary.cost_unpriced_runs`. |
| `cost_partial_runs` | integer | The period's runs counted as in `summary.cost_partial_runs`. |

The days and months are the periods that `agent.max_daily_cost_usd` and `agent.max_monthly_cost_usd` count, so a bucket compares directly with those ceilings.

#### Output formats

Both formats carry the same figures. Breakdown rows are sorted by descending run count, with ties broken by ascending name. A run that recorded no dispatch rule, prompt template, or model appears under the sentinel name `<none>`, which also covers an empty agent adapter. Rounding is fixed so repeated runs over the same data produce identical output: rates and shares to four decimals, mean turns to two, mean duration to one, and costs to cents in text and to nine decimals in JSON.

The summary's duration and mean-turn figures cover **succeeded runs only**, so they describe the work that landed rather than the volume attempted. Token sums and cost figures cover **measured runs only**: a run whose coding agent reported no token usage records that fact and is left out of those figures instead of counting as a run that spent nothing.

A run counts as succeeded when its status is exactly `succeeded`. Cost is the estimate Sortie recorded when each run finished, under the rates in force then, and is never priced again; a run that spent no tokens adds to no cost figure. See [control agent costs](/guides/control-costs/#monitor-spending) for where this fits among the other cost surfaces.

**Text** (default): the report is written to stdout. Warnings are written to stderr, after a blank line, one per line, each prefixed `warning: `. The two streams can be redirected independently.

The report opens with four header lines (`workflow:`, `database:`, `covering:`, `generated:`), then the summary block, then one table per breakdown, then any footnotes. Column headers are upper-cased, rows are indented two spaces, and a nullable figure with no value renders as `-`.

```
workflow:  /srv/sortie/WORKFLOW.md
database:  /srv/sortie/.sortie.db
covering:  2026-07-01T00:00:00Z until 2026-08-01T00:00:00Z
generated: 2026-08-09T07:51:43Z

runs 9   issues 8   succeeded 7 (77.8%)
duration (succeeded)    p50 2m 49s   p95 7m 12s   mean 3m 34s   samples 7
turns (succeeded)       3.3
tokens (measured runs)  input 502,900   output 96,000   total 598,900   cache read 126,380   cache write 18,200
cost (measured runs)    $6.49   per succeeded run $0.93

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

by model
  MODEL              RUNS  SUCCEEDED  SUCCESS RATE  P50     P95     MEAN    TURNS  TOTAL TOKENS  COST
  claude-sonnet-4-5  4     4          100.0%        2m 30s  2m 49s  2m 35s  2.5    172,800       $2.54
  claude-opus-4-5    2     1          50.0%         7m 12s  9m 40s  8m 26s  5.0    215,600       $3.18
  gpt-5-codex        2     2          100.0%        3m 20s  4m 10s  3m 45s  4.0    150,500       $0.55
  <none>             1     0          0.0%          6m 0s   6m 0s   6m 0s   6.0    60,000        $0.22

self review
  runs reviewed 6   iterate 1   pass 5   hit iteration cap 1   mean iterations 1.50
```

The outcome table shows `SHARE`, a group's runs over total runs. Every other breakdown shows `SUCCEEDED` and `SUCCESS RATE`, a group's succeeded runs over its own. On the `base` tier the `TURNS`, `TOTAL TOKENS`, and `COST` columns are absent entirely, and the dispatch-rule, prompt-template, model, stage-chain, retry-trigger, run-origin, and self-review sections do not appear.

The `covering:` line is prose rather than a sentinel. It reads `every run on record` when neither bound was given, `<since> onward` with only `--since`, `the start of the record until <until>` with only `--until`, and `<since> until <until>` with both.

When no run in the range that spent tokens was priced, token counts are still reported and the cost line reads:

```
cost (measured runs)    -   per succeeded run -
```

Four disclosure counters each add a footnote below the tables when they are not zero:

```
note: 2 of these runs took no measurable time. A run that a CI result closed out carries the same start and finish time.
note: the duration figures skip 1 of these runs, whose recorded start and finish times were unusable.
note: the token and cost figures skip 4 of these runs, because the coding agent behind them reported no token usage.
note: the cost figures skip 3 of these runs, because Sortie had no price for the models they used when they were recorded.
```

A range that matches no runs is a success, not a failure. The header still prints, one of two lines follows, and the exit code is `0`:

```
No runs on record yet. sortie adds one each time an agent session finishes.
```

```
No runs finished in this range.
```

The first appears when neither bound was given, the second when at least one was.

**JSON** (`--format json`): a single document is written to stdout, compact and on one line, terminated by a newline. Every array field is always present and never `null`. Every scalar figure the report cannot supply is `null`. For piping the document into your own metrics store, see [aggregate metrics across instances](/guides/aggregate-metrics-across-instances/).

Envelope:

| Field | Type | Description |
|---|---|---|
| `generated_at` | string | RFC3339 UTC timestamp of when the report was produced. |
| `workflow_path` | string | Absolute path to the workflow file that was read. |
| `db_path` | string | Absolute path to the database the figures came from. |
| `since` | string or null | The `--since` bound, RFC3339 UTC. `null` when the flag was omitted, meaning the range is open at the start. |
| `until` | string or null | The `--until` bound, RFC3339 UTC. `null` when the flag was omitted, meaning the range is open at the end. |
| `schema_tier` | string | `"full"` or `"base"`. See [schema tiers](#schema-tiers). |
| `warnings` | array of string | Advisory messages: a degraded schema, a missing breakdown, or a missing recorded cost. `token_rates` advisories are not listed; `sortie validate` reports them. Empty when there is nothing to report, never `null`. The `warning: ` prefix belongs to text rendering and is not part of these strings. |
| `summary` | object | Report-wide figures. Always present. |
| `spend` | object or null | The recorded cost per UTC day or month. `null` on the `base` tier and on a database that records no cost. See [spend by period](#spend-by-period). |
| `by_status` | array of object | Breakdown by outcome. |
| `by_adapter` | array of object | Breakdown by coding agent. |
| `by_rule` | array of object | Breakdown by dispatch rule. Empty array on the `base` tier. |
| `by_template` | array of object | Breakdown by prompt template. Empty array on the `base` tier. |
| `by_model` | array of object | Breakdown by model. Empty array on the `base` tier and on a `full` database that predates the configured-model columns. See [model breakdown](#model-breakdown). |
| `by_chain` | array of object | Breakdown by stage chain, listing only chains where a hop was due or made. Empty array on the `base` tier and on a `full` database that predates the configured-model or stage-chain columns. See [stage chain breakdown](#stage-chain-breakdown). |
| `chain_funnels` | array of object | One funnel per stage chain definition of the workflow. Empty array when the workflow defines no stage chain, on the `base` tier, and on a `full` database that predates the configured-model, stage-chain, trigger, `first_after_hop`, or `agent_blocked` columns. See [stage funnels](#stage-funnels). |
| `by_trigger` | array of object | Breakdown by retry trigger. Empty array on the `base` tier and on a `full` database that predates the configured-model, stage-chain, or trigger columns. See [retry trigger breakdown](#retry-trigger-breakdown). |
| `by_origin` | array of object | Breakdown by run origin. Empty array on the `base` tier and on a `full` database that predates the configured-model, stage-chain, trigger, or `first_after_hop` columns. See [run origin breakdown](#run-origin-breakdown). |
| `self_review` | object or null | Self-review aggregation. `null` on the `base` tier, meaning the results were not read, not that no review ran. |

`summary`:

| Field | Type | Description |
|---|---|---|
| `runs` | integer | Runs that finished in the range. |
| `issues` | integer | Distinct issues, by tracker issue ID, that those runs belong to. `0` when `runs` is `0`. A recorded CI result counts its issue like any other run. Present on every tier. |
| `succeeded` | integer | Runs whose status is exactly `succeeded`. |
| `success_rate` | number | `succeeded` over `runs`, between 0 and 1. `0` when `runs` is `0`. |
| `duration_seconds` | object | Duration figures over succeeded runs only. |
| `mean_turns_succeeded` | number or null | Mean turns completed over succeeded runs. `null` on the `base` tier and when no run succeeded, never `0` in either case. |
| `tokens` | object or null | Token sums over the measured runs in the range. `null` on the `base` tier and when no run in the range was measured. |
| `cost_usd` | number or null | Estimated cost over every priced run in the range, not rounded to cents, so a total under one cent never reads as zero. A run recorded `partial` counts at its lower bound, so the figure is the whole spend only while `cost_unpriced_runs`, `cost_partial_runs`, and `tokens_unmeasured_runs` are all `0`. `null` on the `base` tier, on a database that records no cost, and when no run that spent tokens was priced, never `0` in those cases. |
| `cost_per_succeeded_run_usd` | number or null | `cost_usd` divided by the succeeded runs that were measured, not rounded to cents. `null` whenever `cost_usd` is `null`, and when no measured run succeeded. |
| `zero_duration_runs` | integer | Runs that took no measurable time. A run that a CI result closed out carries the same start and finish time. |
| `duration_excluded_runs` | integer | Runs left out of every duration figure because their stored timestamps could not be parsed or ran backwards. |
| `cost_unpriced_runs` | integer | Measured runs that spent tokens and were recorded without a cost, left out of the cost figures: Sortie had no price for the models they used when they finished, they reported their spend only as a total, or they were recorded before Sortie stored costs and no start has priced them yet. It counts these runs whatever the workflow sets now. `0` on a database that records no cost. A `ci_failed` run records a CI verdict and no coding agent, so it is never counted here. |
| `cost_partial_runs` | integer | Measured runs recorded `partial`, whose recorded cost is a lower bound that `cost_usd` includes: a token class the run spent had no rate, or the run has unaccounted turns. A run counts in at most one of `cost_unpriced_runs` and `cost_partial_runs`. `0` on the `base` tier and on a database that records no cost. A `ci_failed` run is never counted. |
| `tokens_unmeasured_runs` | integer | Runs left out of the token and cost figures because the coding agent behind them reported no token usage. `0` on the `base` tier, where the distinction was never recorded. |

Each element of `by_status`, `by_adapter`, `by_rule`, `by_template`, `by_model`, `by_chain`, `by_trigger`, and `by_origin`:

| Field | Type | Description |
|---|---|---|
| `name` | string | The group: an outcome, an agent adapter kind, a dispatch rule name, a template identifier, a model, a chain identifier, a retry trigger, or a run origin. A run that recorded none carries the sentinel `<none>`, except in `by_chain`, which leaves such a run out. In `by_trigger`, `<none>` is an empty recorded trigger and `<unknown>` a trigger never recorded. In `by_origin`, `<none>` is a recorded CI result and `<unknown>` a run whose trigger was never recorded. Runs keep the agent kind they were recorded under, so a removed kind stays a group of its own next to the kind that replaced it. |
| `runs` | integer | Runs in this group. |
| `succeeded` | integer | Succeeded runs in this group. In `by_status` this is structural rather than informative: the `succeeded` row necessarily reports it equal to `runs`. |
| `success_rate` | number | `succeeded` over this group's `runs`. |
| `share` | number | This group's `runs` over the report's total `runs`. |
| `duration_seconds` | object | Duration figures over all of this group's runs, not only the succeeded ones. |
| `mean_turns` | number or null | Mean turns completed over this group's runs. `null` on the `base` tier. |
| `tokens` | object or null | Token sums over this group's measured runs. `null` on the `base` tier and when the group holds no measured run. |
| `cost_usd` | number or null | Estimated cost over this group's priced runs, not rounded to cents and counting a `partial` run at its lower bound. `null` on the `base` tier and when the group holds no priced run. |
| `cost_per_succeeded_run_usd` | number or null | `cost_usd` divided by this group's succeeded runs that were measured, not rounded to cents. `null` whenever `cost_usd` is `null`, and when the group has no measured succeeded run. |
| `tokens_unmeasured_runs` | integer | This group's runs left out of the token and cost figures because the coding agent behind them reported no token usage. `0` on the `base` tier. |
| `cost_unpriced_runs` | integer | This group's runs counted as in `summary.cost_unpriced_runs`. `0` on the `base` tier and on a database that records no cost. A `ci_failed` run is never counted. |
| `cost_partial_runs` | integer | This group's runs counted as in `summary.cost_partial_runs`. `0` on the `base` tier and on a database that records no cost. A `ci_failed` run is never counted. |

Each element of `by_chain` adds three fields after these:

| Field | Type | Description |
|---|---|---|
| `issue` | string | The issue's display identifier, or its tracker identifier when it has none. |
| `stages` | array of string | The rules the chain's runs in the range followed, in order, with consecutive runs of one rule counted once. |
| `last_hop` | string | The latest hop decision among the chain's runs in the range: `advanced`, `partial`, `failed`, or `ceiling`. Empty when none was reached. |

The fields of a `chain_funnels` element are listed under [stage funnels](#stage-funnels).

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
| `input` | integer | Sum of recorded input tokens over the measured runs. |
| `output` | integer | Sum of recorded output tokens over the measured runs. |
| `total` | integer | Sum of the recorded totals, taken as stored rather than recomputed from `input` and `output`. |
| `cache_read` | integer | Sum of recorded cache-read tokens over the measured runs. |
| `cache_write` | integer | Sum of recorded cache-write tokens over the measured runs. |

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
    "issues": 8,
    "succeeded": 7,
    "success_rate": 0.7778,
    "duration_seconds": {"p50": 169, "p95": 432, "mean": 214.6, "samples": 7},
    "mean_turns_succeeded": 3.29,
    "tokens": {"input": 502900, "output": 96000, "total": 598900, "cache_read": 126380, "cache_write": 18200},
    "cost_usd": 6.49,
    "cost_per_succeeded_run_usd": 0.93,
    "zero_duration_runs": 0,
    "duration_excluded_runs": 0,
    "cost_unpriced_runs": 0,
    "cost_partial_runs": 0,
    "tokens_unmeasured_runs": 0
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
      "tokens": {"input": 341900, "output": 67000, "total": 408900, "cache_read": 90380, "cache_write": 12100},
      "cost_usd": 4.59,
      "cost_per_succeeded_run_usd": 0.66,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
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
      "tokens": {"input": 324500, "output": 63900, "total": 388400, "cache_read": 126380, "cache_write": 18200},
      "cost_usd": 5.72,
      "cost_per_succeeded_run_usd": 1.14,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
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
      "tokens": {"input": 145100, "output": 27700, "total": 172800, "cache_read": 56360, "cache_write": 8100},
      "cost_usd": 2.54,
      "cost_per_succeeded_run_usd": 0.64,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
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
      "tokens": {"input": 145100, "output": 27700, "total": 172800, "cache_read": 56360, "cache_write": 8100},
      "cost_usd": 2.54,
      "cost_per_succeeded_run_usd": 0.64,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
    }
  ],
  "by_model": [
    {
      "name": "claude-sonnet-4-5",
      "runs": 4,
      "succeeded": 4,
      "success_rate": 1,
      "share": 0.4444,
      "duration_seconds": {"p50": 150, "p95": 169, "mean": 155, "samples": 4},
      "mean_turns": 2.5,
      "tokens": {"input": 145100, "output": 27700, "total": 172800, "cache_read": 56360, "cache_write": 8100},
      "cost_usd": 2.54,
      "cost_per_succeeded_run_usd": 0.64,
      "tokens_unmeasured_runs": 0,
      "cost_unpriced_runs": 0,
      "cost_partial_runs": 0
    }
  ],
  "by_chain": [],
  "chain_funnels": [],
  "by_trigger": [],
  "by_origin": [],
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
| `1` | Usage error (invalid `--format`, an unparseable or inverted range bound, too many arguments) or load error (workflow file missing or invalid, `dispatch` section that does not load, database unopenable, `run_history` unreadable). |

### `mcp-server`

Starts an MCP stdio server that exposes registered agent tools over JSON-RPC on stdin/stdout. Intended to be launched by an MCP-compatible agent runtime via `.sortie/mcp.json`, *not run manually*.

```
sortie mcp-server --workflow <path>
```

The subcommand loads the workflow file, builds the tracker adapter from its configuration, assembles the tools available to the session, and serves MCP requests until stdin closes or the process receives a signal. No agents are spawned and no HTTP server starts. The database is opened read-only, and only when both `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are present in the environment; no migration is applied and nothing is written.

#### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--workflow` | string | _(none)_ | Path to the WORKFLOW.md file. Required, and must be absolute; a relative path is rejected. |
| `-h`, `--help` | boolean | `false` | Print the mcp-server help message and exit. |

No other flags beyond `--workflow` and `-h`/`--help`. All behavior derives from the workflow file and environment variables.

#### Startup sequence

1. Parse the `--workflow` flag. Exit `1` when it is missing or not an absolute path.
2. Log to stderr, `text` format at `info` level. Neither `--log-level` nor `--log-format` exists on this subcommand.
3. Load and parse the workflow file.
4. Build the resolved configuration from the parsed workflow file.
5. Resolve the tracker adapter for `tracker.kind` (when non-empty). Gather the tracker configuration, set `user_agent` to `sortie-mcp/<version>`, merge extensions, and build the adapter.
6. Assemble the session's tools. Each tool is included only when its inputs are present: `tracker_api` when the tracker adapter was built and `tracker.project` is non-empty; `sortie_status` when `SORTIE_WORKSPACE` is set; `workspace_history` and `cost_budget` together when both `SORTIE_DB_PATH` and `SORTIE_ISSUE_ID` are set and the read-only database opens; `notify_operator` when at least one `notifications` entry receives `agent.message`. A read-only open that fails logs a warning and skips the two database-backed tools; an unresolvable backend among the entries that receive `agent.message` is fatal. With none of the inputs present, the session has no tools.
7. Build the MCP server with the assembled tools, reading from stdin and writing to stdout.
8. Serve requests until stdin closes or a shutdown signal arrives.

Failures at steps 1–6 write to stderr and return exit code `1`.

#### Environment variables

The MCP server receives its environment exclusively from the `env` field in `.sortie/mcp.json`. The worker writes all `SORTIE_*`-prefixed variables from the orchestrator's process environment into this block, plus the per-session variables below, which override any same-named process variable. See [MCP server environment](/reference/environment/#mcp-server-environment) for the full composition model.

Per-session variables written by the worker. Every row but `SORTIE_ATTEMPT` is written on every dispatch; `SORTIE_ATTEMPT` is written only when the orchestrator has an attempt number:

| Variable | Purpose |
|---|---|
| `SORTIE_ISSUE_ID` | Scopes tool calls to the current issue. |
| `SORTIE_ISSUE_IDENTIFIER` | Human-readable issue key. |
| `SORTIE_WORKSPACE` | Workspace root path. |
| `SORTIE_DB_PATH` | SQLite database path. Gates the `workspace_history` and `cost_budget` tools. |
| `SORTIE_DISPATCH_ID` | Identifies the current dispatch to the `cost_budget` tool, fences the session id `notify_operator` reads from `.sortie/dispatch.json`, and scopes the notification cap `notify_operator` enforces. |
| `SORTIE_SESSION_AGENT_KIND` | Dispatch-frozen agent kind for the session. May be empty. |
| `SORTIE_ATTEMPT` | Attempt number as a decimal integer. Absent on the first dispatch. |

There is no `SORTIE_SESSION_ID` variable: the agent's session id is not known when the worker writes this environment. `notify_operator` reads it separately, live, from a workspace-held record; see [`notify_operator`](/reference/agent-extensions/#notify_operator).

Without `SORTIE_WORKSPACE` and `SORTIE_DISPATCH_ID` in its environment, `notify_operator` returns `state_unavailable` for every call. This is one consequence of running `mcp-server` manually rather than letting an agent runtime launch it from `.sortie/mcp.json`.

Tracker credentials (e.g., `SORTIE_TRACKER_API_KEY`) reach the server through the same `env` block via the `SORTIE_*` prefix scan. The MCP server resolves `$VAR` indirection in the workflow file against these variables.

The MCP server does not validate environment variable presence at startup. Validation failures surface at tool execution time when a tool requires a variable that is absent.

#### Graceful shutdown

The MCP server exits cleanly when either:

- **stdin closes**: the agent runtime terminates the stdio pipe, and the server detects EOF.
- **A shutdown signal arrives**: `SIGINT` or `SIGTERM` stops the server.

No explicit shutdown handshake. The server's lifetime is bound to the agent runtime's stdio pipe.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (stdin closed or signal received), or `-h`/`--help` requested. |
| `1` | Startup failure: missing or relative `--workflow`, an unparseable flag, unreadable workflow file, invalid config, failure to build the tracker adapter, a notification backend that cannot be resolved, or a server error during operation. |

---

## Startup sequence

When no version or help flag is present, Sortie executes these steps in order:

1. **Intercept short flags and parse.** Short aliases (`-h`, `-V`) are intercepted before subcommand dispatch and before flag parsing. If `-h` (or `-help`) is found, help is printed to stdout and the process exits `0`. If `-V` is found, the version banner is printed to stdout and the process exits `0`. Subcommand tokens (`validate`, `stats`, `mcp-server`) and the POSIX `--` terminator stop the scan: `-h` after a subcommand is handled by the subcommand itself. After interception, remaining flags are parsed normally. Unknown flags exit with code `1` and print a one-line error to stderr (the full help text is not printed on errors). `--env-file` path (when provided) is resolved to absolute and exported as `SORTIE_ENV_FILE`.
2. **Resolve workflow path.** Relative paths resolve to absolute against the working directory.
3. **Initialize logging.** Structured output to stderr. Uses `--log-level` and `--log-format` flags when set; otherwise defaults to `INFO` level with `text` format for the duration of startup.
4. **Load and watch workflow file.** Start a filesystem watcher for dynamic config reload. During config parsing, [`SORTIE_*` overrides](/reference/environment/#configuration-overrides) are applied, including `.env` file loading when enabled.
5. **Preflight validation.** Verify `tracker.kind` is registered, `agent.kind` is registered, required API keys are present, active/terminal state lists are non-empty, adapter-specific config validation passes (when declared), and the workspace root is writable. Failure exits with code `1`. No database file is created on disk.
6. **Resolve log level and format.** When `--log-level` was not set, check `logging.level` from the workflow config. When `--log-format` was not set, check `logging.format` from the workflow config. If either differs from the startup default, re-initialize the logger before emitting the startup message.
7. **Resolve server port and host.** The `--port` and `--host` flags override `server.port` and `server.host` from config. An invalid value exits `1`. No socket is bound yet.
8. **Build tracker adapter.** Resolve and build the tracker adapter for `tracker.kind`, gathering its configuration, with `user_agent` set to `sortie/<version>`.
9. **Open SQLite database.** Path from [`db_path`](/reference/workflow-config/) config field, or `.sortie.db` adjacent to the workflow file. Relative paths resolve against the workflow file's directory, not the working directory.
10. **Run schema migrations.** Applied automatically on every startup.
11. **Restore persisted state.** Load pending retry entries and rebuild their timers from the stored `due_at`, load the cumulative token and runtime totals, load the park records that hold issues out of dispatch, and load each issue's stage hop record, which carries its count of consecutive hops (see [stage chains](/reference/workflow-config/#stage-chains)). A failure to read the totals, the park records, or the stage hop records is logged as a warning and startup continues with none.
12. **Build agent adapters.** Build the adapter for the default `agent.kind`, then eagerly build every other registered kind so dispatch-rule routing resolves without building one per issue. A non-default kind that fails to build is logged at warn level and skipped.
13. **Clean terminal workspaces.** Query tracker for states of existing workspace directories; remove those in terminal states. Only directories whose state comes back known and terminal are removed, and if the directory listing or the tracker read fails, Sortie logs a warning and cleans nothing on this pass. No age-based removal runs here: the [`workspace.retention_days`](/reference/workflow-config/#workspace) bound belongs to the periodic sweep, whose first pass falls 60 poll ticks after step 16.
14. **Recover pending reactions.** Rebuild the pending reaction set from recent run history so a restart does not lose a watch that was in flight. A failure here is logged as a warning and startup continues. Then restore the escalations that stood when the process stopped onto the rebuilt entries, logging `reaction escalation restore completed` with the counts `applied`, `rebuilt`, and `ended`. A failure here is logged as `reaction escalation restore failed` at error level and startup continues.
15. **Bind the HTTP listener.** Binds to the host and port resolved in step 7 when the server is enabled. A conflict on an implicitly defaulted port degrades to running without the server; a conflict on an explicitly requested port exits `1`.
16. **Enter poll-dispatch-reconcile loop.** First poll tick fires immediately. Blocks until signal.

When `--dry-run` is set, execution diverges after step 8. Steps 9–16 are skipped entirely. Instead, Sortie fetches candidate issues from the tracker, evaluates dispatch eligibility, logs the results, and exits. No database file is created, no agent adapter is built, and no HTTP server starts.

Any step that fails prints a diagnostic to stderr and exits with code `1`.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown (signal received), help output (`-h`, `--help`), version output (`-V`, `--version`, `-dumpversion`), successful `validate`, successful `--dry-run`, a `stats` report (including one whose range matched no runs), or clean `mcp-server` shutdown. |
| `1` | Startup failure: unknown flag, too many arguments, missing or unreadable workflow file, invalid configuration, preflight validation failure, or database open/migration error. Also used by `validate` for any validation failure, by `--dry-run` when the tracker fetch fails, by `stats` for usage and load errors, and by `mcp-server` for startup or runtime errors. |

Sortie does not define exit codes above `1`. Agent subprocess failures, tracker errors, and runtime exceptions are handled internally through the retry and reconciliation mechanisms. They do not affect the process exit code.

---

## Signals

| Signal | Behavior |
|---|---|
| `SIGINT` | Initiates graceful shutdown. |
| `SIGTERM` | Initiates graceful shutdown. |

Both signals trigger the same sequence:

1. Stop accepting new dispatches.
2. Cancel all running worker contexts.
3. Wait for workers to exit. The ceiling derives from [`agent.stop_grace_ms`](/reference/workflow-config/#agent): 50 seconds at the default `5000`, and one second longer for each extra second of stop grace. Worker results are processed the same way as a normal exit during drain: run history is persisted and retry entries are recorded. Refresh signals arriving during this window are discarded.
4. Wait up to 35 seconds for the reaction triage runs still in flight. Cancellation has already terminated their process groups, so this wait returns promptly in practice.
5. Wait up to 35 seconds for the detached tracker calls (comments, labels) still in flight.
6. Cancel pending retry timers.
7. Shut down the HTTP server with a 5-second timeout for in-flight responses.
8. Close the SQLite database.
9. Exit with code `0`.

During drain, `/livez` and `/readyz` return `503`, and `POST /api/v1/refresh`, `POST /api/v1/retries/{identifier}/run`, and `POST /api/v1/reactions/{identifier}/{kind}/check` return `409 Conflict` with `queued: false` instead of `202 Accepted`.

A second `SIGINT` or `SIGTERM` during shutdown ends every drain still waiting at once, and shutdown continues from the step after it. Each abandoned drain logs a warning naming what was given up. Later signals do nothing.

---

## Logging

All log output goes to **stderr**. The default format is structured `key=value` text:

```
time=2026-03-26T14:30:01.271+00:00 level=INFO msg="sortie starting" version=<version> workflow_path=/opt/sortie/WORKFLOW.md server_addr=127.0.0.1:7678
time=2026-03-26T14:30:01.298+00:00 level=INFO msg="database path resolved" db_path=/opt/sortie/.sortie.db
time=2026-03-26T14:30:01.304+00:00 level=INFO msg="sortie started"
time=2026-03-26T14:30:01.305+00:00 level=INFO msg="pending reaction recovery completed" enabled=false candidates=0 skipped=0 success=true
time=2026-03-26T14:30:01.307+00:00 level=INFO msg="http server listening" addr=127.0.0.1:7678
```

When `--log-format json` is active (or `logging.format: json` in the workflow file), each line is a JSON object:

```json
{"time":"2026-03-26T14:30:01.271843915+00:00","level":"INFO","msg":"sortie starting","version":"<version>","workflow_path":"/opt/sortie/WORKFLOW.md","server_addr":"127.0.0.1:7678","log_format":"json"}
{"time":"2026-03-26T14:30:01.298104220+00:00","level":"INFO","msg":"database path resolved","db_path":"/opt/sortie/.sortie.db"}
{"time":"2026-03-26T14:30:01.304552031+00:00","level":"INFO","msg":"sortie started"}
{"time":"2026-03-26T14:30:01.307918664+00:00","level":"INFO","msg":"http server listening","addr":"127.0.0.1:7678"}
```

JSON output uses RFC 3339 timestamps with nanosecond precision, uppercase level strings, and emits all structured attributes as top-level keys. Each record is a single line terminated by `\n`.

### Context fields

Different log lines carry different context fields depending on scope:

| Field | Present on |
|---|---|
| `version` | Startup |
| `workflow_path` | Startup |
| `server_addr` | Startup (only when the HTTP server is enabled and this is not a dry run). Carries `host:port`, not the port alone. |
| `log_level` | Startup (only when the effective level is not `INFO`) |
| `log_format` | Startup (only when the effective format is not `text`) |
| `db_path` | Database initialization |
| `issue_id` | Dispatch, worker lifecycle, retry, reconciliation |
| `issue_identifier` | Dispatch, worker lifecycle, retry, reconciliation |
| `session_id` | Agent events, worker lifecycle |
| `error` | Error and warning lines |
| `next_attempt`, `delay_ms` | Retryable worker failures (WARN level) |
| `tool`, `duration_ms`, `outcome` | Tool call completions, logged at `DEBUG`. A failed call adds `tool_error`, the first line of its error. |
| `addr` | HTTP server start |

Stdout is used for help output (`-h`, `--help`), version output (`-V`, `--version`, `-dumpversion`), `validate --format json` diagnostics, the `stats` report in both formats, and `mcp-server` JSON-RPC responses. All other output goes to stderr, including the `validate` text diagnostics and the `stats` warnings.

---

## Version injection

Three variables carry build identity: `Version`, `Commit`, and `Date`. They default to `dev`, `unknown`, and `unknown` when the binary is built without linker flags. Builds inject them at compile time:

```sh
go build -ldflags "-s -w -X main.Version=<version> -X main.Commit=<sha> -X main.Date=<date>" -o sortie ./cmd/sortie
```

The Makefile sets all three: `Version` from `git describe --tags --always --dirty` with any leading `v` stripped, `Commit` from `git rev-parse HEAD`, and `Date` from the current UTC date.

```sh
make build
```

The injected version appears in:

- `--version` and `-dumpversion` output
- The `version` field in startup log lines
- The `sortie_build_info{version="..."}` Prometheus metric
- The HTTP dashboard and `/readyz` response
- The `User-Agent` the tracker adapter sends, as `sortie/<version>` from the orchestrator and `sortie-mcp/<version>` from the MCP server

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

- [WORKFLOW.md configuration reference](/reference/workflow-config/): all config fields
- [Environment variables reference](/reference/environment/): `SORTIE_*` config overrides, agent runtime vars, `$VAR` indirection, hook env
- [HTTP API reference](/reference/http-api/): JSON API endpoints and response shapes
- [Dashboard reference](/reference/dashboard/): built-in web dashboard
- [Prometheus metrics reference](/reference/prometheus-metrics/): metric names, types, labels, and PromQL examples
