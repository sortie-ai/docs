---
title: "How to Write a Custom Agent Adapter"
linkTitle: "Write a Custom Agent Adapter"
description: "Write a custom agent adapter for Sortie: implement the AgentAdapter interface, register it, handle structured or plain-transcript output, classify outcomes, test it, and ship it end to end."
author: Sortie AI
date: 2026-05-29
weight: 230
url: /guides/write-custom-agent-adapter/
---
This guide shows you how to write an agent adapter: the package that lets Sortie drive a coding-agent CLI it does not bundle. The orchestrator already drives several agents (Claude Code, Codex, Copilot CLI, OpenCode, and Kiro) through one Go interface, `domain.AgentAdapter`. A new agent is a new package behind that interface, additive only. You add code under `internal/agent/<kind>/` and register it; you change nothing in the orchestrator, the retry logic, or the state machine. By the end you will have a registered adapter, unit tests, an env-gated integration test, and a checklist for the rest of what ships with it.

{{< callout type="info" >}}
Sortie takes no position on how your adapter is produced: by hand, by a hired developer, or by an AI agent are all fine. What matters is that the person who opens the pull request owns the result and is accountable for it conforming to the project's conventions, the spec, the tests, and the quality bar. "The agent decided this" is not an answer to a reviewer's question, and `make lint` and `make test` pass because you ran them and read the output, not because a tool reported success. This is the [AI-assisted contributions](https://github.com/sortie-ai/sortie/blob/main/CONTRIBUTING.md) stance in `CONTRIBUTING.md`, stated once.
{{< /callout >}}

**Prerequisites:**

- A Go toolchain set up the project's way. See `CONTRIBUTING.md` and the `Makefile`; this guide verifies steps with `make test` and `go test`, so you do not need to memorize build flags.
- Familiarity with the repository layout: `internal/domain` holds the contract, `internal/agent/` holds adapters and the shared `agentcore` machinery, and `internal/registry` wires adapters to kind strings.
- The target agent's CLI behavior captured in a research note. Every adapter starts from one (see the `docs/*-adapter-notes.md` files, for example `docs/kiro-adapter-notes.md`): the launch command, the output shape, the exit-code and stderr semantics, the auth model, resume support, and whether it reports tokens.
- The [agent adapter model concept](/concepts/adapter-model/) for the architecture overview.

{{% steps %}}

### Understand the agent adapter contract

The contract is `domain.AgentAdapter` in `internal/domain/agent.go`. It has exactly four methods.

| Method | What it must do | When the orchestrator calls it |
|---|---|---|
| `StartSession(ctx, params) (Session, error)` | Validate the workspace, resolve the binary, build per-session state, return an opaque `Session`. For fork-per-turn agents, start no long-lived process here. | Once per issue session, before the first turn. |
| `RunTurn(ctx, session, params) (TurnResult, error)` | Execute one turn for `params.Prompt`, deliver events through `params.OnEvent`, return the outcome. | Once per turn; continuation turns reuse the same `Session`. |
| `StopSession(ctx, session) error` | Terminate cleanly and release resources. Safe to call after a failed `RunTurn`. | Exactly once per session, after the last turn. |
| `EventStream() <-chan domain.AgentEvent` | Return the async event channel, or `nil` for synchronous adapters. | Once, to learn whether the adapter pushes events asynchronously. |

There are two delivery modes, and you pick one. A synchronous adapter returns `nil` from `EventStream()` and delivers every event through the `OnEvent` callback on `RunTurnParams` during the turn. An asynchronous adapter returns a live channel and pushes events onto it. Every bundled adapter is synchronous; the channel exists for a future push-based transport. The rest of this guide builds a synchronous adapter.

The orchestrator reacts to a normalized event vocabulary, not to your CLI's native messages. These are the `AgentEventType` values you are most likely to emit.

| Event type | Constant | Meaning |
|---|---|---|
| `session_started` | `EventSessionStarted` | The session initialized. Carries `SessionID` and `AgentPID`. |
| `turn_completed` | `EventTurnCompleted` | The turn finished successfully. |
| `turn_failed` | `EventTurnFailed` | The turn finished with a failure. |
| `turn_cancelled` | `EventTurnCancelled` | The turn was cancelled (context cancellation, stall, or signal). |
| `token_usage` | `EventTokenUsage` | Normalized token counters. Drives token-based budgets. |
| `notification` | `EventNotification` | An informational message, surfaced for observability. |
| `tool_result` | `EventToolResult` | A tool call completed. Carries `ToolName` and `ToolDurationMS`. |
| `malformed` | `EventMalformed` | An unparseable line from the agent. |

The data flows like this. `StartSession` receives `StartSessionParams` (the workspace path, an `AgentConfig`, an optional `ResumeSessionID`, SSH fields, and an MCP config path) and returns a `Session` whose `Internal any` field carries your adapter state opaquely. `RunTurn` receives that `Session` plus `RunTurnParams` (the rendered `Prompt`, the `Issue`, and the `OnEvent` callback) and returns a `TurnResult` (`SessionID`, `ExitReason`, `Usage`, `UsageMeasured`). The orchestrator copies `SessionID` and token deltas out of the events and the result; it never reads `Session.Internal`. Set `UsageMeasured` only once the runtime has reported a usage figure for the session: a `false` value with zero `Usage` records the spend as unknown rather than as nothing, which is what keeps a token budget from silently treating an unmeasurable agent as free.

**Verify:** you can state, for your agent, whether it delivers events synchronously (return `nil` from `EventStream`) and which `AgentEventType` values its output maps to.

### Choose your execution model

Fork-per-turn is the default: one subprocess per turn, launched fresh, scanned to completion, then reaped. Claude Code, Copilot CLI, OpenCode, and Kiro all work this way. The shared skeleton in `internal/agent/agentcore` implements the lifecycle for you, and the rest of this guide uses it.

The exception is the persistent-subprocess model. Codex keeps one long-lived `codex app-server` process and talks to it over a JSON-RPC handshake across turns, instead of forking. Choose it only when the CLI requires a persistent server with a protocol handshake. This guide does not cover that model; read `internal/agent/codex/` and the [Codex adapter reference](/reference/adapter-codex/) if your agent needs it.

There is no sidecar or co-process pattern. Agents run as subprocesses in the per-issue workspace, with `cwd` set to the validated workspace path. If your agent is a CLI you run with a prompt, fork-per-turn fits.

**Verify:** you have decided fork-per-turn (this guide applies) or persistent-subprocess (follow the Codex reference instead).

### Scaffold the adapter package

Create a package under `internal/agent/<kind>/`. Throughout this guide the placeholder kind is `acme`; replace it with your kind string. The layout mirrors the existing adapters.

```
internal/agent/acme/
    acme.go               adapter type, init() registration, the four interface methods
    command.go            passthrough config parsing and per-turn argument construction
    parse.go              output parsing and outcome classification
    acme_test.go          session and turn behavior
    command_test.go       argument construction across config permutations
    parse_test.go         parsing and classification
    integration_test.go   env-gated end-to-end test against the real CLI
```

| File | Role |
|---|---|
| `acme.go` | Holds the adapter struct, the `init()` registration, and `StartSession` / `RunTurn` / `StopSession` / `EventStream`. Carries the package doc comment. |
| `command.go` | Holds `passthroughConfig`, `parsePassthroughConfig`, `buildArgs`, and the SSH command builder. All CLI flags live here. |
| `parse.go` | Holds the output parser (JSONL decode for structured agents, ANSI stripping and stderr classification for plain-transcript agents) and any marker constants. |

Generic naming applies everywhere in core, but this package is where the kind string and the CLI flags belong, and nowhere else. Inside `internal/agent/acme/` you may name things `acme*`; outside it, core code speaks only `agent_*` and `session_*`.

**Verify:** `go build ./internal/agent/acme/...` compiles the empty package.

### Register the adapter

Registration runs from `init()` and binds your kind string to a constructor. Use `RegisterWithMeta` so you can declare that the agent needs a launch command.

```go {filename="acme.go"}
package acme

import (
	"github.com/sortie-ai/sortie/internal/domain"
	"github.com/sortie-ai/sortie/internal/registry"
)

func init() {
	registry.Agents.RegisterWithMeta("acme", NewACMEAdapter, registry.AgentMeta{
		RequiresCommand: true,
	})
}

// Compile-time interface satisfaction check.
var _ domain.AgentAdapter = (*ACMEAdapter)(nil)

// NewACMEAdapter creates an adapter from the raw "acme" config sub-object.
func NewACMEAdapter(config map[string]any) (domain.AgentAdapter, error) {
	pt, err := parsePassthroughConfig(config)
	if err != nil {
		return nil, err
	}
	return &ACMEAdapter{passthrough: pt}, nil
}
```

The kind string `"acme"` is the exact value an operator writes in `agent.kind` in WORKFLOW.md. Registry lookup is exact-match and case-sensitive, so `acme` and `Acme` are different agents. `RequiresCommand: true` tells the orchestrator preflight to reject a workflow that selects this agent without an `agent.command`. The `var _ domain.AgentAdapter = (*ACMEAdapter)(nil)` line is a compile-time assertion: if your type stops satisfying the interface, the build fails here with a clear message. The constructor signature is fixed: `func(config map[string]any) (domain.AgentAdapter, error)`, where `config` is the raw map from your WORKFLOW.md extension block.

**Verify:** a one-line test confirms the kind resolves.

```go {filename="acme_test.go"}
func TestRegistered(t *testing.T) {
	t.Parallel()
	if _, err := registry.Agents.Get("acme"); err != nil {
		t.Fatalf("registry.Agents.Get(acme): %v", err)
	}
}
```

### Define the passthrough config

The `<kind>` block in WORKFLOW.md arrives as the raw `map[string]any` passed to your constructor. Decode it into a typed struct with the `typeutil` coercion helpers, and validate it at construction time so misconfiguration fails before any turn runs. This example is the Kiro tool-trust config: a model pin and two mutually exclusive trust modes.

```go {filename="command.go"}
type passthroughConfig struct {
	Model         string
	TrustAllTools bool
	TrustTools    []string
}

func parsePassthroughConfig(config map[string]any) (passthroughConfig, error) {
	pt := passthroughConfig{
		Model:         typeutil.StringFrom(config, "model"),
		TrustAllTools: typeutil.BoolFrom(config, "trust_all_tools", false),
		TrustTools:    slices.Clone(typeutil.ExtractStringSlice(config["trust_tools"])),
	}
	if pt.TrustAllTools && len(pt.TrustTools) > 0 {
		return passthroughConfig{}, fmt.Errorf("trust_all_tools and trust_tools are mutually exclusive")
	}
	return pt, nil
}
```

`StringFrom`, `BoolFrom`, and `ExtractStringSlice` read a key with a fallback and tolerate a missing or wrong-typed value by returning the zero value. Clone any slice you keep so a later mutation cannot reach back into the config map. Field-level validation belongs here: returning an error from the constructor surfaces through `sortie validate`, so an operator sees the problem before dispatch rather than as a failed session.

**Verify:** a table-driven test exercises the parse and the validation.

```
make test PKG=./internal/agent/acme/...
```

### Resolve the launch target and start the session

`StartSession` does setup, not execution. Resolve the launch target, run any credential preflight, build your session state, wire the hooks, and construct the fork-per-turn session. Start no subprocess.

```go {filename="acme.go"}
func (a *ACMEAdapter) StartSession(ctx context.Context, params domain.StartSessionParams) (domain.Session, error) {
	target, agentErr := agentcore.ResolveLaunchTarget(params, "acme-cli")
	if agentErr != nil {
		return domain.Session{}, agentErr
	}

	if target.RemoteCommand == "" {
		if authErr := checkCredential(ctx, target.Command); authErr != nil {
			return domain.Session{}, authErr
		}
	} else {
		target.RemoteCommand = buildSSHRemoteCmd(target.RemoteCommand, os.Getenv("ACME_API_KEY"))
	}

	state := &sessionState{target: target, agentConfig: params.AgentConfig, sessionID: params.ResumeSessionID}
	hooks := agentcore.ForkPerTurnHooks{ /* BuildArgs, ParseLine, GetUsage, GetSessionID, OnFinalize */ }
	state.forkSession = agentcore.NewForkPerTurnSession(&state.target, hooks, state.logger())

	return domain.Session{ID: state.sessionID, Internal: state}, nil
}
```

`agentcore.ResolveLaunchTarget(params, "acme-cli")` returns a validated `LaunchTarget`. It checks the workspace path (this containment check is a security boundary, not a convenience), resolves the binary from the `agent.command` or your default, splits a multi-token command into `Command` plus `Args` (so `codex app-server` becomes `Args: ["app-server"]`), and picks local or SSH mode based on `params.SSHHost`. Store the returned target in your session state and pass a pointer to it into `NewForkPerTurnSession`, so per-turn mutations (such as a resume flag) are observed on later turns.

Run a credential preflight only when a missing or invalid credential would hang or silently fail the agent. Kiro is the worked example: its headless `chat` blocks on interactive login when `KIRO_API_KEY` is absent, and exits 0 with empty output when the key is invalid, so the adapter runs a `whoami` canary in `StartSession` and returns a `domain.AgentError` before any turn. Do this preflight after `ResolveLaunchTarget` succeeds, because the binary must be resolved first. In SSH mode the local environment does not reach the remote shell, so inject the credential inline into the remote command instead of relying on a canary.

**Verify:** `StartSession` returns a `Session` with no error for a valid `t.TempDir()` workspace, and a `domain.AgentError` for a missing credential.

### Construct the command

The `BuildArgs` hook returns the per-turn argument slice that the skeleton appends to `LaunchTarget.Args`. Keep the real logic in a `buildArgs` helper and wire the hook to it, so you can test it directly. Pass the prompt after a `--` separator as a single positional argument, never interpolated into a shell string.

```go {filename="command.go"}
func buildArgs(state *sessionState, turn int, prompt string, pt passthroughConfig) []string {
	args := []string{"chat", "--no-interactive"}
	if pt.Model != "" {
		args = append(args, "--model", pt.Model)
	}
	if pt.TrustAllTools {
		args = append(args, "--trust-all-tools")
	} else {
		args = append(args, "--trust-tools="+strings.Join(pt.TrustTools, ","))
	}
	if state.resumeRequested {
		args = append(args, "--resume")
	}
	return append(args, "--", prompt)
}

func buildSSHRemoteCmd(remoteCommand, apiKey string) string {
	if apiKey == "" {
		return remoteCommand
	}
	return "ACME_API_KEY=" + sshutil.ShellQuote(apiKey) + " " + remoteCommand
}
```

The hook in `StartSession` wraps this helper:

```go
BuildArgs: func(turn int, prompt string) []string {
	return buildArgs(state, turn, prompt, a.passthrough)
},
```

Put the subcommand and flags, model selection, tool-permission flags, and the continuation flag here. For SSH mode, the credential is injected inline and shell-quoted with `sshutil.ShellQuote`, because a key containing shell metacharacters would otherwise be misparsed by the remote shell.

**Verify:** `command_test.go` asserts the argument slice across config permutations (see the testing step).

### Handle output: structured vs unstructured

This is the decision that shapes the whole adapter. Read your research note and answer one question: does the CLI emit a machine-readable event stream, or a plain human transcript? The `ParseLine` hook handles each line of stdout; what it does depends on the answer.

#### Structured output

When the CLI emits JSONL (Claude Code and OpenCode do, in addition to Codex), `ParseLine` decodes each line into native events, drives a `UsageAccumulator` to produce `EventTokenUsage`, drives a `ToolTracker` to produce `EventToolResult`, and returns the terminal result line for `OnFinalize` to consume. This sketch follows the Claude Code adapter.

```go
ParseLine: func(line []byte, emit func(domain.AgentEvent), pid string) (any, error) {
	event, err := parseEvent(line)
	if err != nil {
		return nil, err // skeleton emits EventMalformed and continues to the next line
	}
	switch event.Type {
	case "assistant":
		snapshot, ready := state.acc.AddDelta(event.InputTokens, event.OutputTokens, event.CacheReadTokens)
		if ready {
			emit(domain.AgentEvent{Type: domain.EventTokenUsage, Usage: snapshot, Model: state.lastModel})
		}
	case "tool_result":
		if name, durationMS, ok := state.inFlight.End(event.ToolUseID); ok {
			emit(domain.AgentEvent{Type: domain.EventToolResult, ToolName: name, ToolDurationMS: durationMS})
		}
	case "result":
		captured := event
		return &captured, nil // terminal line: handed to OnFinalize as lastParsed
	}
	return nil, nil
}
```

`AddDelta` returns a snapshot and a `ready` flag; emit the usage event only when `ready` is true, so the orchestrator never receives a report claiming zero output tokens for a real turn. Register tool starts with `ToolTracker.Begin(id, name)` and close them with `End(id)` to get the duration. Construct the accumulator and tracker fresh at the top of each `RunTurn` and return the terminal event reference so the next step can read its status.

#### Unstructured output

When the CLI emits a plain transcript with no event stream and no token reporting (Kiro), `ParseLine` strips ANSI, captures the text into an `EventNotification` for observability, and reports no usage. There is no terminal line on stdout, so `ParseLine` always returns `(nil, nil)` and the outcome is decided later from the exit status and stderr.

```go
ParseLine: func(line []byte, emit func(domain.AgentEvent), pid string) (any, error) {
	text := stripANSI(string(line))
	state.turnStdout.WriteString(text)
	if text != "" {
		emit(domain.AgentEvent{
			Type:     domain.EventNotification,
			Message:  typeutil.TruncateRunes(text, 500),
			AgentPID: pid,
		})
	}
	return nil, nil
},
GetUsage: func() domain.TokenUsage { return domain.TokenUsage{} },
```

Truncate captured text with `typeutil.TruncateRunes` so a long line does not bloat the event. `agentcore.EmitNotification(emit, text)` is the helper for the simpler case where you do not need to attach the PID. `GetUsage` returns the zero `TokenUsage`, which is how the orchestrator learns this agent has no token data.

In both modes, `GetSessionID` returns your current session id and `GetUsage` returns the token snapshot; the skeleton calls them when it builds the `TurnResult` on the cancellation and signal paths. `EmitSessionStartID` is the one optional hook: leave it `nil` if you emit `session_started` from inside `ParseLine` (Claude Code does this on its init line), or set it to a closure returning the session id to emit `session_started` before the scan loop (Copilot CLI does this).

**Verify:** `parse_test.go` decodes `testdata/` fixtures into the expected events for a structured agent, or asserts ANSI stripping and stderr classification for an unstructured one.

### Classify the outcome and pick the right error kind

`OnFinalize` reports what it observed; it does not decide the turn. It receives `emit`, `lastParsed` (the last non-nil value `ParseLine` returned), `exitCode`, and `stderrLines`, fills in an `agentcore.TurnEvidence`, and returns `agentcore.FinalizeTurn(emit, logger, ev, meta)`. `FinalizeTurn` applies the disposition rule every adapter shares, emits the terminal event, and builds the paired `(domain.TurnResult, *domain.AgentError)`.

That indirection is enforced, not advisory. Constructing a `domain.AgentEvent` or a `domain.AgentError` for your own turn outcome, or calling `agentcore.EmitTurnCompleted`, `EmitTurnFailed`, or `EmitTurnCancelled` directly, breaks the shared decision; a test in `agentcore` walks every adapter package and fails on it. `OnFinalize` must not call `EmitWarnLines` either: the skeleton does that for you when `FinalizeTurn` returns a non-nil error.

The skeleton handles the hard cases before `OnFinalize` ever runs. It owns context cancellation, the stdout scan-error path, exit code 127 (binary not found, mapped to `ErrAgentNotFound`), and signal kills (`SIGTERM` / `SIGKILL`, mapped to `ErrTurnCancelled`). `OnFinalize` covers only what remains: a normal process exit. Do not try to detect 127 or signals here.

Three fields carry the evidence.

| Field | What you set it to |
|---|---|
| `Terminal` | What the runtime reported: `TerminalSuccess`, `TerminalFailure`, `TerminalCancelled`, or `TerminalAbsent` when it reported nothing. Pair a failure with `TerminalErrorKind` and `TerminalMessage`. |
| `ExitObserved`, `ExitCode` | The turn's own process exit. A persistent-subprocess adapter leaves `ExitObserved` false, because its process outlives the turn. |
| `Work` | Per-turn evidence that the model produced something: `WorkPresent`, `WorkAbsent`, or `WorkUnobservable` when the runtime exposes no such signal. `WorkDetail` names the signal you looked for, and must be a compile-time constant string. |

The rule reads those fields in order and stops at the first match: a terminal report wins outright, then a missing process exit, then a non-zero exit, then the work evidence. A positive report from the runtime is never second-guessed by counting output, and exit code zero is never a success signal on its own, so an adapter with nothing positive to report gets a failed turn.

For a structured agent, read `lastParsed` and set `Terminal` from the result line. For an unstructured agent, derive it from the exit status and stderr. Kiro is the worked example, and its exit-0 case is ambiguous: the process exits 0 whether or not a turn actually ran, so the only reliable success signal is a credits trailer on stderr.

```go
OnFinalize: func(emit func(domain.AgentEvent), _ any, exitCode int, stderrLines []string) (domain.TurnResult, *domain.AgentError) {
	creditsSeen, authFailed := classifyStderr(stderrLines)

	// Headless Kiro reports no per-turn token count, so the credits
	// trailer is the success signal rather than the work evidence.
	ev := agentcore.TurnEvidence{
		ExitObserved: true,
		ExitCode:     exitCode,
		Work:         agentcore.WorkUnobservable,
		WorkDetail:   "no credits trailer on stderr",
	}

	switch {
	case exitCode == 0 && creditsSeen:
		ev.Terminal = agentcore.TerminalSuccess
		state.resumeRequested = true
	case exitCode == 0 && authFailed && state.turnStdout.Len() == 0:
		ev.Terminal = agentcore.TerminalFailure
		ev.TerminalErrorKind = domain.ErrResponseError
		ev.TerminalMessage = "kiro authentication failed"
	}

	return agentcore.FinalizeTurn(emit, state.logger(), ev,
		agentcore.TurnMeta{SessionID: state.sessionID})
},
```

The error kind is a control-flow decision, not a label. The orchestrator reads it to decide whether to retry. Here is what the rule produces for Kiro's four cases.

| Evidence | `ExitReason` | Error kind | Retry behavior |
|---|---|---|---|
| exit 0, credits trailer on stderr | `EventTurnCompleted` | none | success |
| exit 0, auth-failure marker, empty stdout | `EventTurnFailed` | `ErrResponseError` | retryable, exponential backoff |
| exit 0, no credits trailer | `EventTurnFailed` | `ErrTurnFailed` | retryable, exponential backoff |
| any non-zero exit | `EventTurnFailed` | `ErrPortExit` | retryable, exponential backoff |

Only the first two rows come from evidence Kiro sets itself. The last two are what the shared rule assigns to a zero exit with no work and to a non-zero exit, and every adapter gets them for free. All three failure kinds here are retryable. Other kinds are not: `ErrAgentNotFound`, `ErrInvalidWorkspaceCwd`, `ErrTurnInputRequired`, and `ErrTurnCancelled` are non-retryable, so the orchestrator releases the claim instead of scheduling another attempt. Choose the kind that reflects what the orchestrator should do next, and confirm its retry semantics in the [agent errors reference](/reference/errors/#agent-errors).

**Verify:** a table test feeds exit codes and stderr fixtures to your adapter and asserts both `ExitReason` and the error kind with `errors.As`. `dispositiontest.AssertDispositionContract` pins each case against the shared rule for you.

### Wire session continuity

`StartSessionParams.ResumeSessionID` carries the session id from a previous worker attempt for the same issue. An adapter that cannot resume ignores the field; the orchestrator still functions, and each turn starts fresh. If your CLI supports resume, choose the strategy that matches how it identifies sessions.

A session-id-based resume fits a CLI that owns an addressable identifier. Claude Code generates a UUID, threads it through every turn, and passes `--resume <id>` when `ResumeSessionID` is set. A cwd-scoped resume fits a CLI whose headless session id is not enumerable. Kiro cannot name its session, so it adds a bare `--resume` flag that continues the most recent conversation in the workspace directory, and it sets that flag only after the first turn has succeeded (the `resumeRequested` field flips to true in `OnFinalize`). Pick based on what your CLI exposes; both are valid.

**Verify:** a test asserts that turn two of a resumed session includes your continuation flag and turn one does not.

### Surface capabilities and budgeting

Make the agent's capabilities and limitations visible to operators, because they change how a workflow must be configured.

Token-usage emission is optional. If the CLI reports tokens, drive a `UsageAccumulator` and emit `EventTokenUsage`; this feeds token-based budgets. If it reports none, leave `TurnResult.Usage` at the zero value, emit no `EventTokenUsage`, and the agent is budgeted by time only, through `agent.turn_timeout_ms`. Kiro is the worked example: its headless path reports an abstract credits figure, never token counts, so token budgets are inert and the turn timeout is the only backstop on a stuck turn.

Tool permissions are surfaced through the passthrough config, with a least-privilege default. Kiro exposes a `trust_tools` allowlist (the read-only set of `read`, `grep`, `glob` is the safe starting point) and a mutually exclusive `trust_all_tools` switch. Expose only the flags your CLI actually has.

State these capabilities and limitations in two places so operators find them: the adapter package doc comment, and the agent's docs-site reference page. An operator who reads "this agent reports no token usage; budget it with `turn_timeout_ms`" before they deploy avoids a confusing first run.

**Verify:** the package doc comment names the token-usage support and the tool-permission model, and `sortie validate` accepts a WORKFLOW.md with your `agent` block and extension block.

### Test the adapter

Write unit tests with the project's conventions: table-driven, `t.Parallel()` at test and subtest level, assertions through `errors.As` and `errors.Is` rather than string matching, fixtures in `testdata/`, and the standard library only.

- `command_test.go` asserts `buildArgs` output across config permutations (model set or not, trust modes, resume on or off).
- `parse_test.go` asserts parsing and classification: JSONL decode against `testdata/` fixtures for a structured agent, ANSI stripping and stderr classification for an unstructured one.
- `acme_test.go` covers session and turn behavior against a stub or a fake binary on `PATH`.

```go {filename="command_test.go"}
func TestBuildArgs(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		pt   passthroughConfig
		want []string
	}{
		{"trust allowlist", passthroughConfig{TrustTools: []string{"read"}},
			[]string{"chat", "--no-interactive", "--trust-tools=read", "--", "do it"}},
		{"trust all", passthroughConfig{TrustAllTools: true},
			[]string{"chat", "--no-interactive", "--trust-all-tools", "--", "do it"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := buildArgs(&sessionState{}, 1, "do it", tt.pt)
			if !slices.Equal(got, tt.want) {
				t.Errorf("buildArgs() = %v, want %v", got, tt.want)
			}
		})
	}
}
```

The integration test runs against the real CLI and stays gated behind an environment variable. Put it in the external `acme_test` package, blank-import your adapter so `init()` registration runs, and guard it with `SORTIE_ACME_TEST=1` plus the credential. Name the test so it contains `Integration`, which is how the release pipeline selects it with `-run 'Integration'`. Use no build tag: the env guard alone makes it skip cleanly when the variable is absent, so a normal `make test` never runs or fails it.

```go {filename="integration_test.go"}
package acme_test

import (
	"os"
	"testing"

	_ "github.com/sortie-ai/sortie/internal/agent/acme" // blank import triggers registration
	"github.com/sortie-ai/sortie/internal/registry"
)

func skipIfNotEnabled(t *testing.T) {
	t.Helper()
	if os.Getenv("SORTIE_ACME_TEST") != "1" {
		t.Skip("set SORTIE_ACME_TEST=1 to run acme integration tests")
	}
	if os.Getenv("ACME_API_KEY") == "" {
		t.Skip("set ACME_API_KEY to run acme integration tests")
	}
}

func TestACMEAdapter_Integration(t *testing.T) {
	skipIfNotEnabled(t)
	_ = registry.Agents // resolve the adapter, StartSession, RunTurn, assert ExitReason.
}
```

This matches `internal/agent/kiro/integration_test.go`; read it for the full StartSession-RunTurn-assert body.

**Verify:** unit tests pass, and the integration test skips when its env var is unset.

```
make test PKG=./internal/agent/acme/...
go test -run 'Integration' ./internal/agent/acme/...   # prints SKIP without SORTIE_ACME_TEST
```

{{% /steps %}}

## Ship checklist

A finished adapter is more than the package. Split the work by who can do it: a contributor owns everything in the pull request, and a maintainer handles the few steps that need repository access.

### What you ship in the pull request

- Research note `docs/<agent>-adapter-notes.md` capturing the CLI's real behavior.
- The adapter package under `internal/agent/<kind>/` with `init()` registration.
- Unit tests: `command_test.go`, `parse_test.go`, and `<kind>_test.go`.
- The env-gated `integration_test.go` (external `<kind>_test` package, blank import, `SORTIE_<AGENT>_TEST` gate, a test name containing `Integration`, no build tag).
- An agent Dockerfile `examples/docker/<agent>.Dockerfile`, if the agent is containerized.
- A sample `examples/WORKFLOW.<agent>.md`, verified with `sortie validate`.
- In-repo docs: the agent adapter contract section under `docs/architecture/`, its entry in the `docs/architecture.md` index, and `docs/workflow-reference.md` for the kind, the extension block, and the env vars.
- Docs-site pages: `concepts/adapter-model.md`, `reference/environment.md`, `reference/workflow-config.md`, a dedicated `reference/adapter-<agent>.md`, a `getting-started/<tracker>-<agent>-end-to-end.md` tutorial, and `guides/use-sortie-in-docker.md` if you added a Dockerfile.
- A `README.md` mention.
- A release-pipeline job in `.github/workflows/release.yml` following the `test-integration-<agent>` pattern, wired into the final `release` job's `needs:` list. The job stays inert until the secret it reads is provisioned.
- `make lint` and `make test` pass locally, and the integration test skips cleanly without its env var.

### What a maintainer does (coordinate, do not attempt)

These steps need repository access an outside contributor does not have. Make the integration job correct, then ask a maintainer to provision the secret and run it. The job stays skipped in your own fork because the secret is absent.

- Provision a test account and credential for the new agent.
- Add the corresponding repository secret (for example `<AGENT>_API_KEY`) in the project's GitHub Actions settings so the integration job can authenticate.
- Trigger the release pipeline that runs the gated job.

## Avoid common mistakes

**Importing another adapter package or the orchestrator.** Adapters reach core through `internal/domain` and `internal/registry` only. `agentcore` itself imports no adapter package; neither should you import a sibling adapter.

**Putting `<agent>_*` names or CLI flags in core packages.** The kind string and the flags live in your package. Core code uses generic `agent_*` and `session_*` vocabulary.

**Adding a dependency or anything that needs CGo.** `modernc.org/sqlite` is the only SQLite driver, the binary is statically linked, and tests use the standard library. A new third-party dependency needs prior discussion.

**Retaining or calling `OnEvent` after `RunTurn` returns.** The callback is valid only during the turn. Emit while the turn runs; do not stash the function for later.

**Calling `EmitWarnLines` inside `OnFinalize`.** The skeleton calls it for you when `OnFinalize` returns a non-nil error. Calling it yourself double-logs the stderr.

**Handling cancellation, exit 127, or signal kills inside `OnFinalize`.** The skeleton owns those arms. `OnFinalize` sees only a normal process exit; trying to detect a signal there is dead code.

**Deciding the turn disposition yourself.** Report evidence through `TurnEvidence` and let `FinalizeTurn` decide. Emitting a terminal event or building a `domain.AgentError` for your own outcome fails the conformance test in `agentcore` and re-forks a rule every other adapter shares.

**Inventing a structured stream or fabricating token usage where the CLI provides neither.** If there is no token data, `GetUsage` returns the zero `TokenUsage` and you emit no `token_usage` event. Do not synthesize numbers.

**Weakening the workspace validation that `ResolveLaunchTarget` performs.** Path containment and `cwd` validation are security boundaries. Always resolve through `ResolveLaunchTarget`; never bypass it to launch in an unvalidated directory.

**Integration tests that fail instead of skipping when the gating env var is absent.** Skip with `t.Skip`. A normal `make test` must never fail because a credential is missing.

**Shipping a change you cannot explain.** You own the diff regardless of how it was produced. "The agent decided this" is not a rationale a reviewer accepts.

**Trusting a tool's claim that checks pass.** Run `make lint` and `make test` and read the output yourself before you call the work done.

**Listing maintainer-only actions as contributor steps.** A contributor cannot add a repository secret or trigger the gated release job. Write those as steps to coordinate, not steps to perform.

## Related guides and references

- [Contributing](https://github.com/sortie-ai/sortie/blob/main/CONTRIBUTING.md) - how to contribute to the project
- [Agent adapter model](/concepts/adapter-model/) - why Sortie uses adapter interfaces and how the registry wires them
- [Kiro CLI adapter reference](/reference/adapter-kiro/) - the unstructured, time-budgeted worked example
- [Claude Code adapter reference](/reference/adapter-claude-code/) - the structured-output worked example
- [Copilot CLI adapter reference](/reference/adapter-copilot/) - a fork-per-turn adapter that emits `session_started` before the scan loop
- [OpenCode adapter reference](/reference/adapter-opencode/) - a structured adapter that recovers token usage with a second command
- [Codex adapter reference](/reference/adapter-codex/) - the persistent-subprocess model this guide does not cover
- [Error reference: agent errors](/reference/errors/#agent-errors) - the error-kind taxonomy and retry classification
- [WORKFLOW.md reference](/reference/workflow-config/) - the `agent` section and adapter extension blocks
- [Environment variables reference](/reference/environment/) - credential and gating variables for adapters
- [Write a custom agent tool](/guides/write-custom-agent-tool/) - the sibling extensibility guide for tools
- [Scale agents with SSH](/guides/scale-agents-with-ssh/) - the remote-execution path your SSH branch enables
- [Control costs](/guides/control-costs/) - turn and token budgets that depend on what your adapter reports
- [Resume sessions across restarts](/guides/resume-sessions-across-restarts/) - how `ResumeSessionID` fits the recovery model
