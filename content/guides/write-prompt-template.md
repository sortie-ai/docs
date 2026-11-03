---
title: How to Write a Prompt Template for WORKFLOW.md
linkTitle: "Write a Prompt Template"
description: "Write the Go text/template prompt body in WORKFLOW.md: use issue fields, branch on retries and continuations, render blockers, and avoid common mistakes."
author: Sortie AI
date: 2026-03-28
weight: 40
url: /guides/write-prompt-template/
---
The Markdown body below the YAML front matter in `WORKFLOW.md` is a `text/template` that Sortie renders once per agent turn. This guide walks you through building a production prompt, from a one-liner to a full multi-mode template with conditionals, iteration, and structured data.

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
  command: claude
---

Fix {{ .issue.identifier }}: {{ .issue.title }}
```

This renders to `Fix PROJ-42: Login page returns 500 on empty email`.

## Add the description

Guard optional fields with `{{ if }}`. Empty strings evaluate to `false`:

```jinja
{{ if .issue.description }}
### Description

{{ .issue.description }}
{{ end }}
```

The same pattern works for every optional string field: `url`, `assignee`, `branch_name`, `issue_type`.

The description often contains multiline Markdown. The template inserts it as-is. Formatting passes through to the agent.

## Use all available issue fields

The `.issue` object is normalized across tracker backends, so the same field names work whether you're polling Jira, Linear, or a forge's issues. Common fields you'll reach for: `.issue.identifier` (the human-readable key, like `PROJ-123`), `.issue.title`, `.issue.description`, `.issue.labels` (a lowercase list), and `.issue.blocked_by` (never nil, resolved before every session starts). `.issue.priority` is an integer or nil depending on whether the tracker supplies one. `{{ if .issue.priority }}` guards both cases.

For the complete field list with every type and nil/empty distinction, see the [`.issue` table in the workflow config reference](/reference/workflow-config/#issue).

Three other top-level variables are available on every render alongside `.issue`: `.attempt` (`0` on the first try, `>= 1` on retry), `.run` (`.run.turn_number`, `.run.max_turns`, `.run.is_continuation`), and `.stage` (the current and previous stage of a [stage chain](/concepts/stage-chains/), empty strings outside one). See the [`.attempt` and `.run` reference](/reference/workflow-config/#attempt) and the [`.stage` reference](/reference/workflow-config/#stage) for the full field lists.

Reaction dispatches add one more top-level variable each, carrying the context that triggered them. They are `nil` on an ordinary dispatch, so `{{ if .ci_failure }}` is safe to write in a template that also serves primary runs. Each stays set on every turn of its reaction run. A template needs no block for a variable: without one, Sortie sends a built-in prompt for that reaction, and a block replaces it. See [built-in reaction prompts](/reference/workflow-config/#built-in-reaction-prompts) for the rule, and [configure CI feedback](/guides/configure-ci-feedback/) and [configure review feedback](/guides/configure-review-feedback/) for their fields.

`.review_comments` and `.bot_review_comments` are also set on the first turn of a new run of an issue whose pull request holds comments no earlier run was given, so write each as an added block that leaves the rest of the prompt unchanged; see [give a new run its pending review comments](/guides/configure-review-feedback/#give-a-new-run-its-pending-review-comments).

{{< callout type="info" >}}
**What counts as falsy in `{{ if }}`**

`0`, `""` (empty string), `nil`, `false`, and empty collections (`[]`, `{}`) all evaluate to `false`. This means `{{ if .issue.description }}` skips absent descriptions, `{{ if .attempt }}` skips the first try, and `{{ if .issue.blocked_by }}` skips empty blocker lists. No explicit comparison is needed.
{{< /callout >}}

## Branch on first run, continuation, and retry

A single template serves three modes. Use `.attempt` and `.run.is_continuation` to branch:

```jinja {hl_lines=[1,8,15]}
{{ if not .run.is_continuation }}
## First run

Read the specification. Understand the problem before writing code.
Write tests first, then implement the solution.
{{ end }}

{{ if .run.is_continuation }}
## Continuation (turn {{ .run.turn_number }}/{{ .run.max_turns }})

You are resuming. Check `git status` and test output.
Continue from where the previous turn left off.
{{ end }}

{{ if and .attempt (not .run.is_continuation) }}
## Retry (attempt {{ .attempt }})

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

Inside a `range` block, `.` is rebound to the current list element, not the root data. Writing `{{ .issue.identifier }}` inside `{{ range .issue.blocked_by }}` fails because `.` is now a blocker object, not the top-level map. Use the dollar-sign prefix `{{ $.issue.identifier }}` to reach the root from inside any `range` or `with` block. `sortie validate` detects this mistake statically and emits a `dot_context` warning.
{{< /callout >}}

### Comments

Comments carry human feedback and review notes. Each has `.id`, `.author`, `.body`, and `.created_at`. The field is `nil` when not fetched and an empty list when no comments exist. Both are falsy in `{{ if }}`:

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

`.issue.comments` is the list the tracker returned for the run. Most runs start without it, so it is `nil` there. To show the agent the comments it has not been given yet on every turn, use the `comment_feed` variable instead; see [place issue comments in your prompt](#place-issue-comments-in-your-prompt). Rendering `.issue.comments` as well makes the same comments appear twice.

## Place issue comments in your prompt

A template that never mentions comments still gets them. When a person comments on the issue, Sortie hands the agent the comments it has not been given yet at the start of its next turn, in a block it appends to the end of the prompt. This section is optional: read it to choose where the comments appear, how they look, or to keep them out of the prompt. For whose comments count and how to turn the feed off, see [steer agents with issue comments](/guides/steer-agents-with-issue-comments/).

### Put the comments where you want them

The `comment_feed` variable holds two lists. `.comment_feed.new` holds the comments the agent has not been given. `.comment_feed.earlier` holds the comments an earlier agent session on this issue was given, and it is filled only when the run starts a new session that does not carry the earlier conversation. Each element has `id`, `author`, `body`, `created_at`, and `replacing`. Both lists are empty, never `nil`, on a turn with nothing to deliver, so `{{ range }}` and `{{ if }}` need no guard.

```jinja
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress, review]
  terminal_states: [done]

agent:
  kind: claude-code
  command: claude
---

Fix {{ .issue.identifier }}: {{ .issue.title }}

{{ if .comment_feed.earlier }}
## Comments from earlier sessions

{{ range .comment_feed.earlier }}### {{ .author }}, {{ .created_at }}
<issue_comment>{{ .body | toJSON }}</issue_comment>
{{ end }}
{{ end }}
{{ if .comment_feed.new }}
## New comments

Answer these before you continue.

{{ range .comment_feed.new }}### {{ .author }}, {{ .created_at }}{{ if .replacing }} (edited, replaces the text you were given before){{ end }}
<issue_comment>{{ .body | toJSON }}</issue_comment>
{{ end }}
{{ end }}
```

Piping the body through `toJSON` quotes it as a single string, so a comment's line breaks and markup cannot pass as headings or another author's section of your prompt. Quoting does not stop a model from following what the text says; who may comment matters more than how the comment is framed, as [issue comments reach the agent unasked](/concepts/security/#issue-comments-reach-the-agent-unasked) explains. Sortie's own block quotes the same way.

When a person edits a comment the agent already has, the comment is delivered once more in full with `.replacing` set to `true`. Use it to tell the agent that the new text supersedes the old.

Sortie decides that your template placed the comments by rendering it twice, once without the comments and once with them. When the two prompts differ, Sortie sends yours unchanged and appends nothing. When they are identical, or the prompt is blank, or Sortie substituted a built-in prompt for your output, the block is appended. Either way every comment counts as given.

### Leave the comments out on purpose

To keep comment text out of the prompt, render something else in its place, such as a pointer to the agent's tracker tool:

```jinja
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress, review]
  terminal_states: [done]

agent:
  kind: claude-code
  command: claude
---

Fix {{ .issue.identifier }}: {{ .issue.title }}

{{ if or .comment_feed.new .comment_feed.earlier }}A person commented on the issue. Read the comments with your tracker tool before you continue.{{ end }}
```

The prompt differs whenever a comment is pending, so Sortie sends it unchanged. Every pending comment counts as given, and Sortie does not deliver it again. Test both lists, as the example does: a template that tests only `.comment_feed.new` renders the same text when only earlier comments are pending, and Sortie appends the block. Setting `enabled: false` in the `comment_feed` block is the other way to keep comments out; it also stops the extra comment reads.

### Avoid the placement traps

- **Rendering one list.** The comments of the list you leave out count as given and are never shown. A template that renders only `.comment_feed.new` hides the earlier comments from a new session for good. Render both.
- **Rendering `.issue.comments`.** Sortie does not count it as placing the feed. A template that renders it and neither `comment_feed` list receives the block as well, so the comments appear twice. Use the `comment_feed` lists to show comments.
- **Rendering on some turns only.** A template that shows the comments only while `.run.is_continuation` is false places them on those turns. On the other turns the two prompts are identical and Sortie appends the block.
- **Rendering `.park.comments` and the lists.** On the first turn after a park release `.park.comments` holds the same pending comments, so a template that renders both prints them twice. Pick one; see the next section.

For the block's exact layout and the rules for which comments are delivered, see the [`comment_feed` reference](/reference/workflow-config/#comment_feed).

## Hand the agent a person's answer after a park

When an agent writes `blocked`, or its runs keep showing no evidence of work, Sortie parks the issue until a person acts. The person releases it by removing the parking label or moving the issue to another state. The next run then needs to know why the agent stopped and what the person said. Sortie sets `.park` on the first turn of that run, and it is `nil` on every other run, so the block below costs nothing when no park occurred:

```jinja
{{ if .park }}
## You were parked and a person released the issue

{{ if .park.statement }}You stopped earlier: {{ .park.statement }}{{ end }}

{{ if .park.comments }}
Comments written since then:

{{ range .park.comments }}### {{ .author }} ({{ .created_at }})
{{ .body }}
{{ end }}
{{ else }}
Nobody commented. Re-read the issue before you continue.
{{ end }}
{{ end }}
```

Inside `range`, the dot is a comment, as in the comments section above. Sortie never lists a comment it posted in `.park.comments`, so when it posted the stop statement as a tracker comment, the statement still prints once, through `.park.statement`.

What the list holds depends on the issue comment feed:

- **Feed on (the default).** `.park.comments` holds the comments the agent has not been given, from the authors the feed delivers, which by default are people with write access to the project. In a new session the comments earlier sessions were given come first. A template that renders the list places those comments itself, so Sortie appends no block for them. A template without the park block still delivers the answer, through the appended block, though without the stop statement. "Nobody commented" also shows when the only new comments come from authors the feed does not deliver.
- **Feed off.** `.park.comments` holds every comment written since the parked run sent its last prompt, whoever wrote it.

Render `.park.comments` or the `comment_feed` lists, not both, or the person's reply prints twice. Its elements carry no `replacing` field.

On this run `.issue.comments` holds every comment of the issue, including the ones the agent already saw, and the run continues the agent's earlier session where the agent supports it. Render `.park.comments` rather than `.issue.comments` for the answer. Leave the first-run instructions in place, because a run that cannot resume starts without the earlier conversation. See [`.park`](/reference/workflow-config/#park) for every field and the rules for which comments count.

## Use the built-in functions

Sortie ships three functions beyond Go's template builtins:

| Function | Usage | Result |
|---|---|---|
| `toJSON` | `{{ .issue.labels \| toJSON }}` | `["bug","urgent"]` |
| `join` | `{{ .issue.labels \| join ", " }}` | `bug, urgent` |
| `lower` | `{{ .issue.state \| lower }}` | `in progress` |

{{< callout type="info" >}}
**Pipe argument order**

The pipe (`|`) passes the value as the **last** argument. `{{ .issue.labels | join ", " }}` calls `join(", ", labels)`. The separator comes first in the function signature because the piped list is appended at the end.
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
Sortie runs in strict mode (`missingkey=error`). A typo like `{{ .issue.titel }}` fails rendering immediately instead of producing an empty string. `sortie validate` catches these statically: unknown fields like `.issue.titel` produce an `unknown_field` warning, and unknown top-level variables like `{{ .config }}` produce an `unknown_var` warning. Check field names against the [`.issue` field list](/reference/workflow-config/#issue).

**Forgetting to guard nil fields.**
`.issue.parent` is `nil` when no parent exists. Accessing `.issue.parent.identifier` without a guard fails the render with `nil pointer evaluating interface {}.identifier`, and the worker attempt ends there:

```jinja
{{/* Wrong: render fails when parent is nil */}}
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

```jinja {hl_lines=[7,13,16,25,32,38,44,54]}
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
2. Run `make lint && make test`. All checks must pass.
3. Keep changes minimal.
{{ if not .run.is_continuation }}

## First run

Start by reading the specification and existing code.
Write tests first. Implement second.
{{ end }}
{{ if .run.is_continuation }}

## Continuation (turn {{ .run.turn_number }}/{{ .run.max_turns }})

Review workspace state and continue. Do not restart from scratch.
{{ end }}
{{ if and .attempt (not .run.is_continuation) }}

## Retry (attempt {{ .attempt }})

A previous attempt failed. Diagnose before changing code.
{{ end }}
{{ if or .comment_feed.earlier .comment_feed.new }}

## Feedback

{{ range .comment_feed.earlier }}### {{ .author }}
{{ .body | toJSON }}
{{ end }}{{ range .comment_feed.new }}### {{ .author }}{{ if .replacing }} (edited){{ end }}
{{ .body | toJSON }}
{{ end }}
{{ end }}
{{ if .issue.blocked_by }}

## Blockers

{{ range .issue.blocked_by }}- **{{ .identifier }}**{{ if .state }} ({{ .state }}){{ end }}
{{ end }}
{{ end }}
```

This template handles all three modes, renders every useful issue field including comments and blockers, and degrades gracefully when optional data is absent. For the full front matter schema, see the [WORKFLOW.md reference](/reference/workflow-config/).
