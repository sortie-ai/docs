---
title: "How to Use Agent Tools in Prompts"
linkTitle: "Use Agent Tools in Prompts"
description: "Use Sortie's agent tools in prompts: sortie_status for turn budget, cost_budget for token budget, workspace_history for retry context, tracker_api for issues, notify_operator for escalation, .sortie/status for blocks."
keywords: sortie agent tools, prompt template, sortie_status, workspace_history, tracker_api, cost_budget, token budget, notify_operator, escalation, blocked status, MCP tools, prompt engineering
author: Sortie AI
date: 2026-04-03
weight: 200
url: /guides/use-agent-tools-in-prompts/
---
Sortie registers tools via MCP and advertises them in the first-turn prompt — the agent already knows each tool's name, input schema, and response format. This guide shows you how to add prompt instructions that make agents use those tools at the right moments: checking their turn budget, watching the token budget, reviewing prior run history, querying the tracker, escalating to a human when a decision needs one, and signaling when they're stuck.

## Prerequisites

- Sortie running with an MCP-compatible agent (Claude Code, Copilot CLI)
- A `WORKFLOW.md` with valid front matter ([write a prompt template](/guides/write-prompt-template/))
- Familiarity with available tool schemas ([agent extensions reference](/reference/agent-extensions/))

## Guide the agent to check its own status

Add a block near the top of your prompt template that tells the agent to check `sortie_status` before diving into work:

```plaintext
Before starting, call the sortie_status tool to check your turn budget.
If turns_remaining is 3 or fewer, focus on completing the most important
change and skip nice-to-haves.
```

Without this, agents treat every turn as if the budget is unlimited. They start low-priority refactors on their second-to-last turn, then get cut off mid-change. A single status check at the start lets the agent prioritize.

## Guide the agent to watch the token budget

When [`agent.max_tokens`](/reference/workflow-config/#agent) is set, the orchestrator stops dispatching new sessions for an issue once cumulative token spend reaches the budget. The `cost_budget` tool lets the agent see that ceiling coming:

```plaintext
Before starting expensive work, call the cost_budget tool.
If remaining_tokens is null, there is no token budget; proceed normally.
If remaining_tokens is less than 100000, finish the most important
change, commit what works, and summarize what remains instead of
starting anything new.
```

Tune the threshold to your budget; 100,000 tokens is a sensible reserve when `max_tokens` is in the low millions. Unlike `sortie_status`, which covers the current session only, `cost_budget` reports spend across all of the issue's sessions, including the one in flight.

The `null` case earns its line in the prompt. `remaining_tokens: null` means the budget is unlimited, not exhausted; an instruction that says "stop when remaining_tokens is low" without it makes the agent wind down on issues that have no token budget at all.

## Guide the agent to review prior history

On continuation and retry runs, the agent has no memory of what happened before. Tell it to check:

```jinja
{{if .run.is_continuation}}
Call the workspace_history tool to review prior run outcomes. If the last
run failed, read the error message before retrying the same approach.
Do not repeat a failed strategy without a different plan.
{{end}}
```

The `{{if .run.is_continuation}}` guard keeps this out of first runs, where there is no history to review. Without it, the agent wastes a tool call that returns empty results.

On retry runs (`.attempt >= 1`), you can add a stronger instruction:

```jinja
{{if and .attempt (not .run.is_continuation)}}
This is retry attempt {{ .attempt }}. Call workspace_history to understand
what went wrong. The previous approach failed — changing your strategy is
mandatory, not optional.
{{end}}
```

Agents on retry runs that skip history tend to repeat the exact same failing approach. Forcing a history check before any code changes breaks that loop.

## Guide the agent to use tracker_api

The `tracker_api` tool gives the agent read and write access to your issue tracker. Three scenarios come up most often.

### Check related issues before starting

```plaintext
Call the tracker_api tool with the search_issues operation to find
other active issues. Note any that are related to your task — avoid
duplicating work or introducing conflicts with in-progress changes.
```

This is useful in projects with many concurrent issues. The agent sees what else is in flight and can avoid, for example, refactoring a module that another issue is actively rewriting.

### Read comments for human feedback

```plaintext
Call the tracker_api tool with fetch_comments to check for human
feedback or clarifications added since the last run.
```

Pair this with the continuation guard when feedback arrives between runs:

```jinja
{{if .run.is_continuation}}
Call the tracker_api tool with fetch_comments to check for new
reviewer feedback. If a human left comments, address them before
continuing with the original plan.
{{end}}
```

### Transition the issue when done

```plaintext
When your changes are committed and pushed, call the tracker_api
tool with the transition_issue operation to move the issue to
"In Review". Do not transition until the CI checks pass.
```

This closes the loop — the agent moves the issue forward without human intervention. The target state must match a valid state in your tracker's workflow. For the full list of `tracker_api` operations and their input schemas, see the [agent extensions reference](/reference/agent-extensions/).

## Guide the agent to escalate and report progress

When a `notifications` backend is configured in WORKFLOW.md, agents can call `notify_operator` to reach a human on a real-time channel without ending the session:

```plaintext
If the notify_operator tool is available: when you hit a decision you
should not make alone (architecture changes, destructive migrations,
ambiguous requirements), call it with severity "warning" and category
"decision_needed" before proceeding. On long tasks, send a short update
with severity "info" and category "progress" at meaningful milestones.
Do not notify on every turn.
```

The conditional phrasing matters: the tool is registered only when the operator configured a notification backend, so an unconditional instruction confuses agents in setups without one. The cap matters too: notifications are limited per session (default 20), and calls past the cap return `rate_limited` errors, so instruct meaningful moments rather than a running commentary.

A notification does not stop the session or the retry loop. An agent that is genuinely blocked must still write `.sortie/status`. The right order is notify first, then write the file, so the human hears about the blocker and the orchestrator stops retrying.

## Guide the agent to signal blocked status

When an agent can't complete a task — missing credentials, ambiguous requirements, a dependency on another issue — it should tell the orchestrator to stop retrying. The `.sortie/status` file is the mechanism:

```plaintext
If you determine you cannot complete this task because of missing
credentials, ambiguous requirements, or a dependency on another
issue, signal the orchestrator:

    mkdir -p .sortie && echo "blocked" > .sortie/status

If the work is complete but needs human review before merging:

    mkdir -p .sortie && echo "needs-human-review" > .sortie/status

DO NOT write this file during normal productive work.
```

Sortie auto-injects similar instructions on the first turn, so including your own version is harmless. Custom instructions are useful when you want to be more specific — for example, listing the exact conditions that count as "blocked" in your project.

The orchestrator reads `.sortie/status` after each turn. Unrecognized values are silently ignored, so only `blocked` and `needs-human-review` have any effect. For background on why this is a file rather than a tool call, see [agent communication model](/concepts/orchestration/).

## Combine tools in a complete workflow

Here is a full `WORKFLOW.md` prompt body that ties all four patterns together:

```jinja
---
tracker:
  kind: jira
  project: PROJ
  active_states: [To Do, In Progress]
  terminal_states: [Done]
agent:
  kind: claude-code
  max_turns: 10
notifications:
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
---

You are a senior engineer. Your work is tracked by Sortie.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}
{{ if .issue.description }}

### Description

{{ .issue.description }}
{{ end }}

## Budget

Call the sortie_status tool to check your turn budget. If turns_remaining
is 3 or fewer, focus on the most critical change and skip cleanup tasks.

Call the cost_budget tool to check your token budget. If remaining_tokens
is null, there is no token budget. If it is below 100000, wrap up: commit
what works and summarize what remains.

{{ if not .run.is_continuation }}
## First Run

Check for related issues: call tracker_api with search_issues. Note any
that overlap with your task.

Read the specification and existing code before writing anything.
Write tests first, then implement.
{{ end }}
{{ if .run.is_continuation }}
## Continuation (Turn {{ .run.turn_number }}/{{ .run.max_turns }})

Call workspace_history to review what happened in prior turns.
Call tracker_api with fetch_comments to check for new reviewer feedback.

If the previous turn failed, do not repeat the same approach. Diagnose
the root cause before making changes.
{{ end }}
{{ if and .attempt (not .run.is_continuation) }}
## Retry — Attempt {{ .attempt }}

Call workspace_history to understand what the previous attempt did wrong.
A different strategy is required — do not retry the same approach.
{{ end }}

## When You Finish

1. Run `make lint && make test` — all checks must pass.
2. Commit and push your changes.
3. Call tracker_api with transition_issue to move {{ .issue.identifier }}
   to "In Review".

## If You Get Stuck

If you cannot complete this task because of missing credentials,
ambiguous requirements, or a dependency on another issue:

1. Call notify_operator with severity "critical" and category "blocked",
   describing what you need.
2. Write the status file:

    mkdir -p .sortie && echo "blocked" > .sortie/status

Do not write this file during normal productive work.
```

The flow: the agent checks its budget, gathers context (related issues on first run, history and comments on continuations), does the work, transitions the issue, and signals if stuck. Each tool call happens at the moment its output is most useful.

## Common mistakes

**Calling `sortie_status` on every turn.** Once at the start is enough. Calling it every turn wastes tokens on redundant information — the budget changes by one each turn, and the agent can track that from the first response.

**Treating `remaining_tokens: null` as zero.** `null` means no token budget is configured; `0` means the budget is spent. A prompt that tells the agent to stop when `remaining_tokens` is low, without naming the null case, makes it wind down on issues with unlimited budget. Spell out both cases in the prompt.

**Including tool schemas or JSON call syntax in the prompt.** Sortie already advertises tools via MCP and the first-turn prompt injection. Repeating the schema wastes context window, and writing `{"operation": "search_issues"}` in the prompt is not how agents invoke MCP tools. Use natural language: "Call `tracker_api` with the `search_issues` operation."

**Forgetting `{{if .run.is_continuation}}` guards.** A `workspace_history` call on the first run returns nothing — there is no prior history. Wrap history-related instructions in a continuation or retry guard so the agent skips them when they're useless.

**Treating `notify_operator` as a stop signal.** It notifies a human and changes nothing in orchestration: retries continue, the tracker state stays put, the claim stays held. Only `.sortie/status` stops the retry loop. Pair them: notify, then write the file.

**Notifying on every turn.** Notifications are capped per session (default 20); past the cap, calls return `rate_limited` errors. Reserve `notify_operator` for decisions, blockers, and meaningful milestones, not a running commentary.

**Writing `.sortie/status` with unrecognized values.** Only `blocked` and `needs-human-review` are recognized. Values like `done`, `error`, or `waiting` are silently ignored. The agent writes the file thinking it communicated something, but the orchestrator sees nothing.

## Related guides

- [Agent extensions reference](/reference/agent-extensions/) — tool schemas and response formats
- [Write a prompt template](/guides/write-prompt-template/) — template syntax, variables, conditionals
- [WORKFLOW.md reference](/reference/workflow-config/) — `agent.max_turns`, `agent.max_sessions`
- [Configure retry behavior](/guides/configure-retry-behavior/) — retry semantics
- [Control agent costs](/guides/control-costs/) — budget management
