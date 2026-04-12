---
title: How to Write a Prompt Template for WORKFLOW.md
linkTitle: "Write a Prompt Template"
description: "Write the Go text/template prompt body in WORKFLOW.md: use issue fields, branch on retries and continuations, render blockers, and avoid common mistakes."
keywords: sortie prompt template, WORKFLOW.md prompt, text/template, issue variables, continuation prompt, retry prompt, template functions
author: Sortie AI
date: 2026-03-28
weight: 40
url: /guides/write-prompt-template/
---
The Markdown body below the YAML front matter in `WORKFLOW.md` is a `text/template` that Sortie renders once per agent turn. This guide walks you through building a production prompt — from a one-liner to a full multi-mode template with conditionals, iteration, and structured data.

## Prerequisites

- A `WORKFLOW.md` with valid YAML front matter ([quick start](/getting-started/quick-start/))
- Familiarity with your tracker's issue fields (title, description, labels)

## Start with the essentials

Every prompt needs the issue identifier and title. Place them after the closing `---` of the front matter:

```jinja
---
tracker:
  kind: jira
  project: PROJ
  active_states: [To Do, In Progress]
  terminal_states: [Done]
agent:
  kind: claude-code
---

Fix {{ .issue.identifier }}: {{ .issue.title }}
```

This renders to `Fix PROJ-42: Login page returns 500 on empty email`.

## Add the description

Guard optional fields with `{{ if }}` — empty strings evaluate to `false`:

```jinja
{{ if .issue.description }}
### Description

{{ .issue.description }}
{{ end }}
```

The same pattern works for every optional string field: `url`, `assignee`, `branch_name`, `issue_type`.

The description often contains multiline Markdown. The template inserts it as-is — formatting passes through to the agent.

## Use all available issue fields

The `.issue` object is normalized across tracker backends:

| Variable | Type | Notes |
|---|---|---|
| `.issue.id` | string | Internal tracker ID |
| `.issue.identifier` | string | Human-readable key (`PROJ-123`) |
| `.issue.title` | string | Issue summary |
| `.issue.description` | string | Body text; empty when absent |
| `.issue.priority` | integer or nil | Lower = higher priority; nil when unavailable. `{{ if .issue.priority }}` guards both |
| `.issue.state` | string | Current tracker state |
| `.issue.branch_name` | string | Tracker-provided branch; empty when absent |
| `.issue.url` | string | Web link to the issue |
| `.issue.labels` | list of strings | Lowercase; empty (non-nil) list when none |
| `.issue.assignee` | string | Identity from the tracker; empty when absent |
| `.issue.issue_type` | string | Bug, Story, Task, etc.; empty when absent |
| `.issue.parent` | object or nil | `.parent.id`, `.parent.identifier` |
| `.issue.comments` | list or nil | Each has `.id`, `.author`, `.body`, `.created_at`. `nil` = not fetched; `[]` = no comments |
| `.issue.blocked_by` | list of objects | Each has `.id`, `.identifier`, `.state`. Never nil; empty when no blockers |
| `.issue.created_at` | string | ISO-8601 timestamp |
| `.issue.updated_at` | string | ISO-8601 timestamp |

Two other top-level variables are available alongside `.issue`:

| Variable | Type | Purpose |
|---|---|---|
| `.attempt` | integer | `0` on first try, `>= 1` on retry |
| `.run.turn_number` | integer | Current turn within the session |
| `.run.max_turns` | integer | Configured maximum turns |
| `.run.is_continuation` | boolean | `true` on turns 2+ of a multi-turn session |

{{< callout type="info" >}}
**What counts as falsy in `{{ if }}`**

`0`, `""` (empty string), `nil`, `false`, and empty collections (`[]`, `{}`) all evaluate to `false`. This means `{{ if .issue.description }}` skips absent descriptions, `{{ if .attempt }}` skips the first try, and `{{ if .issue.blocked_by }}` skips empty blocker lists — no explicit comparison needed.
{{< /callout >}}

## Branch on first run, continuation, and retry

A single template serves three modes. Use `.attempt` and `.run.is_continuation` to branch:

```jinja {hl_lines=[1,8,15]}
{{ if not .run.is_continuation }}
## First Run

Read the specification. Understand the problem before writing code.
Write tests first, then implement the solution.
{{ end }}

{{ if .run.is_continuation }}
## Continuation (Turn {{ .run.turn_number }}/{{ .run.max_turns }})

You are resuming. Check `git status` and test output.
Continue from where the previous turn left off.
{{ end }}

{{ if and .attempt (not .run.is_continuation) }}
## Retry — Attempt {{ .attempt }}

A previous attempt failed. Do not repeat the same approach.
Diagnose the root cause before making changes.
{{ end }}
```

How the branching works:

- **First run:** `.attempt` is `0`, `.run.is_continuation` is `false`. The "First Run" block renders; the other two don't.
- **Continuation turn:** `.run.is_continuation` is `true`. Only the "Continuation" block renders.
- **Retry:** `.attempt` is `>= 1`, `.run.is_continuation` is `false`. Only the "Retry" block renders.

If you omit the `is_continuation` branch entirely, Sortie substitutes a built-in fallback on continuation turns when the rendered output is empty. Explicit branching gives better results because you control what the agent sees.

## Render labels, blockers, and comments

### Labels

Labels are a list of lowercase strings. Use the `join` function to flatten them:

```jinja
{{ if .issue.labels }}
**Labels:** {{ .issue.labels | join ", " }}
{{ end }}
```

### Blockers

Blockers are a list of objects. Iterate with `{{ range }}`:

```jinja
{{ if .issue.blocked_by }}
## Blockers

{{ range .issue.blocked_by }}- **{{ .identifier }}**{{ if .state }} ({{ .state }}){{ end }}
{{ end }}
{{ end }}
```

{{< callout type="warning" >}}
**The dot changes inside `{{ range }}`**

Inside a `range` block, `.` is rebound to the current list element — not the root data. Writing `{{ .issue.identifier }}` inside `{{ range .issue.blocked_by }}` fails because `.` is now a blocker object, not the top-level map. Use the dollar-sign prefix `{{ $.issue.identifier }}` to reach the root from inside any `range` or `with` block. `sortie validate` detects this mistake statically and emits a `dot_context` warning.
{{< /callout >}}

### Comments

Comments carry human feedback and review notes. Each has `.id`, `.author`, `.body`, and `.created_at`. The field is `nil` when not fetched and an empty list when no comments exist — both are falsy in `{{ if }}`:

```jinja
{{ if .issue.comments }}
## Feedback

{{ range .issue.comments }}### {{ .author }} ({{ .created_at }})
{{ .body }}
{{ end }}
{{ end }}
```

For long comment threads, `toJSON` passes everything in one block:

```jinja
{{ if .issue.comments }}
Comments: {{ .issue.comments | toJSON }}
{{ end }}
```

## Use the built-in functions

Sortie ships three functions beyond Go's template builtins:

| Function | Usage | Result |
|---|---|---|
| `toJSON` | `{{ .issue.labels \| toJSON }}` | `["bug","urgent"]` |
| `join` | `{{ .issue.labels \| join ", " }}` | `bug, urgent` |
| `lower` | `{{ .issue.state \| lower }}` | `in progress` |

{{< callout type="info" >}}
**Pipe argument order**

The pipe (`|`) passes the value as the **last** argument. `{{ .issue.labels | join ", " }}` calls `join(", ", labels)` — the separator comes first in the function signature because the piped list is appended at the end.
{{< /callout >}}

`toJSON` is useful when the agent needs structured data. Instead of a range loop for blockers:

```jinja
Blockers: {{ .issue.blocked_by | toJSON }}
```

The agent receives valid JSON directly.

## Add template comments

Go template comments (`{{/* ... */}}`) are stripped at parse time:

```jinja
{{/* Required env vars: SORTIE_JIRA_ENDPOINT, SORTIE_JIRA_API_KEY */}}
You are a senior engineer working on {{ .issue.identifier }}.
```

Useful for documenting env var requirements or leaving notes for colleagues.

## Verify the result

Check for syntax errors, configuration typos, and template mistakes without running a full cycle:

```bash
sortie validate WORKFLOW.md
```

This parses the front matter, compiles the template, and runs static analysis on both YAML keys and the template body. Typos in YAML keys (like `trackers:` instead of `tracker:`) appear as warnings, and so do common template mistakes: referencing `.issue.title` inside `{{ range }}` where dot has been rebound, using an unknown variable like `{{ .config }}`, or accessing a non-existent sub-field like `{{ .run.foo }}`. Run it after every edit.

For JSON-structured output in CI pipelines:

```bash
sortie validate --format json WORKFLOW.md
```

For an end-to-end test with rendering, use the file tracker and a mock agent:

```yaml
---
tracker:
  kind: file
  active_states: [To Do]
  terminal_states: [Done]
file:
  path: test-issues.json
agent:
  kind: mock
  max_turns: 1
---

Your template here...
```

Create `test-issues.json` with a sample issue (see `examples/issues.json` for the format) and start Sortie:

```bash
sortie WORKFLOW.md
```

Check the logs for the rendered prompt. Render errors appear with line numbers.

## Avoid common mistakes

**Referencing a variable that doesn't exist.**
Sortie runs in strict mode (`missingkey=error`). A typo like `{{ .issue.titel }}` fails rendering immediately instead of producing an empty string. `sortie validate` catches these statically — unknown fields like `.issue.titel` produce an `unknown_field` warning, and unknown top-level variables like `{{ .config }}` produce an `unknown_var` warning. Check field names against the variable table above.

**Forgetting to guard nil fields.**
`.issue.parent` is `nil` when no parent exists. Accessing `.issue.parent.identifier` without a guard panics:

```jinja
{{/* Wrong — crashes when parent is nil */}}
Parent: {{ .issue.parent.identifier }}

{{/* Correct */}}
{{ if .issue.parent }}
Parent: {{ .issue.parent.identifier }}
{{ end }}
```

**Whitespace control.**
Go templates insert newlines for each `{{ if }}` and `{{ end }}` line. For tighter output, use the trim markers `{{-` and `-}}`:

```jinja
{{- if .issue.url }}
Ticket: {{ .issue.url }}
{{- end }}
```

The `-` trims whitespace on that side of the tag. For most prompts, the extra newlines are harmless.

## Complete example

```jinja {hl_lines=[7,13,16,25,32,38,44,52]}
{{/* Production prompt for Jira + Claude Code workflow */}}
You are a senior engineer. Your work is tracked by Sortie.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}
{{ if .issue.description }}

### Description

{{ .issue.description }}
{{ end }}
{{ if .issue.labels }}
**Labels:** {{ .issue.labels | join ", " }}
{{ end }}
{{ if .issue.url }}
**Ticket:** {{ .issue.url }}
{{ end }}

## Rules

1. Read relevant docs before writing code.
2. Run `make lint && make test` — all checks must pass.
3. Keep changes minimal.
{{ if not .run.is_continuation }}

## First Run

Start by reading the specification and existing code.
Write tests first. Implement second.
{{ end }}
{{ if .run.is_continuation }}

## Continuation (Turn {{ .run.turn_number }}/{{ .run.max_turns }})

Review workspace state and continue. Do not restart from scratch.
{{ end }}
{{ if and .attempt (not .run.is_continuation) }}

## Retry — Attempt {{ .attempt }}

A previous attempt failed. Diagnose before changing code.
{{ end }}
{{ if .issue.comments }}

## Feedback

{{ range .issue.comments }}### {{ .author }}
{{ .body }}
{{ end }}
{{ end }}
{{ if .issue.blocked_by }}

## Blockers

{{ range .issue.blocked_by }}- **{{ .identifier }}**{{ if .state }} ({{ .state }}){{ end }}
{{ end }}
{{ end }}
```

This template handles all three modes, renders every useful issue field including comments and blockers, and degrades gracefully when optional data is absent. For the full front matter schema, see the [WORKFLOW.md reference](/reference/workflow-config/).
