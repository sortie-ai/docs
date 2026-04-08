---
title: How to Use Sub-Agents with Sortie
description: "Run coding agent sub-agents in Sortie workflows with zero configuration. Clone a repo with agent files, reference them in your WORKFLOW.md prompt, and the agent runtime handles discovery and routing."
keywords: sortie sub-agents, claude code agents, copilot agents, gemini agents, agent files, WORKFLOW.md, agent orchestration, sub-agent delegation
author: Sortie AI
date: 2026-03-28
weight: 20
url: /guides/use-subagents-with-sortie/
---

# How to use sub-agents with Sortie

Sub-agents work with Sortie out of the box. If your repository contains agent definition files, Sortie clones the repo into the workspace, the agent runtime discovers the files automatically, and delegation happens without any Sortie-side configuration.

This guide shows you how to reference sub-agents in your `WORKFLOW.md` prompt so the primary agent knows they exist and when to invoke them.

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- A repository containing agent definition files (`.claude/agents/`, `.github/agents/`, or `.gemini/agents/`)
- A `WORKFLOW.md` with hooks that clone the repo into the workspace ([workspace hooks guide](/guides/setup-workspace-hooks/))

## How it works

Sortie creates an isolated workspace directory for each issue, then runs the `after_create` hook — which typically clones your repository. Once the clone finishes, every file in the repo is present in the workspace, including agent definition directories. The agent binary launches with its working directory set to the workspace root. Agent runtimes discover sub-agent files relative to that working directory and make them available for delegation.

Sortie doesn't parse, validate, or route between agent files. The agent runtime owns all of that. Your only job is to tell the primary agent — through the prompt — which sub-agents are available and when to use them.

## Reference sub-agents in your prompt

The `WORKFLOW.md` prompt body is where you tell the agent about available sub-agents. This is plain text that Sortie passes through to the agent — Sortie doesn't interpret sub-agent references.

Each agent runtime discovers sub-agents differently. The safest approach is natural language: describe the agent by name and tell the primary agent when to use it. All three runtimes support automatic delegation when the prompt names an agent that matches a loaded definition.

Here's a complete `WORKFLOW.md` that delegates code review to a reviewer sub-agent and planning to a planner sub-agent:

```jinja
---
tracker:
  kind: jira
  project: ACME
  active_states: [To Do, In Progress]
  terminal_states: [Done]
agent:
  kind: claude-code
  max_turns: 3
hooks:
  after_create: |
    git clone --depth 1 git@github.com:acme/backend.git .
  before_run: |
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
---

You are a senior engineer working on task:
"{{ .issue.identifier }}: {{ .issue.title }}"

{{ if .issue.description }}

## Description

{{ .issue.description }}
{{ end }}

## Available agents

You have two sub-agents. Use them:

- **reviewer** — Reviews code for correctness, style, and test coverage.
  After you finish implementation, use the reviewer agent to check your
  changes before marking the task complete.
- **planner** — Breaks down tasks into implementation steps. When the
  task is ambiguous or large, use the planner agent to produce a plan
  before writing code.

## Workflow

1. If the task scope is unclear, delegate to the planner agent.
2. Implement the solution.
3. Run `make lint && make test` — all checks must pass.
4. Delegate to the reviewer agent to review your changes.
5. Address any review feedback.
{{ if .run.is_continuation }}

## Continuation (Turn {{ .run.turn_number }}/{{ .run.max_turns }})

Check `git status` and test output.
Continue from where the previous turn left off.
{{ end }}
```

The key section is "Available agents." It names each sub-agent, describes what it does, and tells the primary agent when to use it. The agent runtime matches the name to the corresponding agent definition file and handles delegation.

### Invocation syntax by runtime

How the primary agent invokes a sub-agent depends on the runtime:

| Runtime | Invocation method | Example in prompt text |
|---|---|---|
| Claude Code | Natural language or `@name` mention | "Use the reviewer agent" or "@reviewer check my changes" |
| Copilot CLI | Natural language description | "Use the reviewer agent to review the changes" |
| Gemini CLI | Natural language or `@name` at prompt start | "Use the reviewer agent" or "@reviewer check my changes" |

Claude Code delegates via its [Task tool](https://code.claude.com/docs/en/sub-agents) — when the prompt mentions an agent by name, Claude matches it to a loaded definition and spawns a sub-agent with its own context window and tool permissions.

Copilot CLI [infers the agent from context](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli). When the prompt describes a task that aligns with a custom agent's description, Copilot selects it automatically. You can also define trigger words in the agent profile to improve matching.

Gemini CLI supports both [automatic delegation and explicit `@name` invocation](https://geminicli.com/docs/core/subagents.md). Note that Gemini subagents are experimental and require `"experimental": {"enableAgents": true}` in your Gemini CLI `settings.json`.

Natural language works across all three runtimes, which makes it the safest default for prompts that might run on different agent backends.

## Write agent definition files

Each agent runtime expects files in a specific directory:

| Agent runtime | Directory | Extension | Docs |
|---|---|---|---|
| Claude Code | `.claude/agents/` | `.md` | [Sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Copilot CLI | `.github/agents/` | `.agent.md` | [Custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli) |
| Gemini CLI | `.gemini/agents/` | `.md` | [Subagents](https://geminicli.com/docs/core/subagents.md) |

All three use the same general structure: YAML frontmatter defining the agent's role, followed by a Markdown body that serves as the sub-agent's system prompt. The frontmatter fields differ slightly between runtimes.

### Claude Code

`.claude/agents/reviewer.md` — the `tools` field is a comma-separated string:

```jinja
---
name: reviewer
description: Reviews code changes for correctness and style
tools: Read, Grep, Glob, Bash
model: sonnet
---

You are a code reviewer. Examine the staged changes and report:

1. Correctness issues — bugs, edge cases, missing error handling.
2. Style violations — naming, formatting, idiomatic patterns.
3. Test coverage — are the changes tested? Are edge cases covered?

Run the project's lint and test suite. Report results.
Do not make changes yourself — only report findings.
```

`.claude/agents/planner.md`:

```jinja
---
name: planner
description: Breaks down tasks into implementation steps
tools: Read, Grep, Glob
---

You are a technical planner. Given a task description:

1. Read relevant source files to understand the current architecture.
2. Break the task into ordered implementation steps.
3. Identify files that need changes.
4. Flag risks or ambiguities.

Output a numbered plan. Do not write code.
```

### Copilot CLI

`.github/agents/reviewer.agent.md` — note the `.agent.md` extension and the `tools` field as a JSON array:

```jinja
---
name: reviewer
description: Reviews code changes for correctness and style
tools: ["bash", "edit", "view"]
---

You are a code reviewer. Examine the staged changes and report:

1. Correctness issues — bugs, edge cases, missing error handling.
2. Style violations — naming, formatting, idiomatic patterns.
3. Test coverage — are the changes tested? Are edge cases covered?

Run the project's lint and test suite. Report results.
Do not make changes yourself — only report findings.
```

Copilot agents can also be stored in `~/.copilot/agents/` for user-level agents that apply across repositories.

### Gemini CLI

`.gemini/agents/reviewer.md` — supports additional fields like `kind`, `temperature`, and `max_turns`:

```jinja
---
name: reviewer
description: Reviews code changes for correctness and style
kind: local
tools:
  - read_file
  - grep_search
  - run_shell_command
model: gemini-2.5-pro
---

You are a code reviewer. Examine the staged changes and report:

1. Correctness issues — bugs, edge cases, missing error handling.
2. Style violations — naming, formatting, idiomatic patterns.
3. Test coverage — are the changes tested? Are edge cases covered?

Run the project's lint and test suite. Report results.
Do not make changes yourself — only report findings.
```

Gemini agents can also be stored in `~/.gemini/agents/` for user-level agents.

## Verify sub-agents are being used

After running Sortie against an issue, check whether the agent invoked sub-agents. Two signals to look for:

**In the agent's output log**, look for delegation markers. Claude Code logs sub-agent invocations as tool uses — you'll see `Task` tool calls with the agent name. Copilot CLI logs agent selection in its debug output. Gemini CLI shows sub-agent dispatch in its session trace.

**In the agent's behavioral output**, look for the pattern you requested. If your prompt says "delegate to the reviewer agent," the output should contain review findings as a distinct step — not interleaved with implementation work.

If the agent ignores the sub-agents, strengthen the prompt language. Replace suggestions ("consider using the reviewer agent") with directives ("you must delegate to the reviewer agent before completing the task"). Agent runtimes discover the files automatically, but the primary agent decides whether to delegate based on the prompt instructions it receives.

## What we covered

Sub-agents work in Sortie workflows without any Sortie configuration — clone a repo with agent files, reference the agents by name in your prompt, and the agent runtime handles discovery and routing. The invocation syntax differs by runtime, but natural language descriptions work across all three. For the full prompt template syntax, see the [prompt template guide](/guides/write-prompt-template/). For the complete front matter schema including hooks, see the [WORKFLOW.md reference](/reference/workflow-config/).
