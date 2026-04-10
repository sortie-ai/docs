---
title: How to Use the File Adapter for Local Testing
linkTitle: "Use File Adapter for Testing"
description: "Test Sortie workflows without Jira: create a JSON fixture, configure the file adapter, iterate on prompts and hooks, then graduate to production."
keywords: sortie file adapter, local testing, file tracker, mock agent, JSON fixture, test workflow, no Jira, CI testing, prompt iteration
author: Sortie AI
date: 2026-03-28
weight: 30
url: /guides/use-file-adapter-for-testing/
---
The file adapter replaces a live tracker with a local JSON file. Pair it with the mock agent and you can validate your entire workflow — prompts, hooks, state transitions — without API credentials, network access, or token spend.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))

{{% steps %}}

### Create a test fixture

Create `issues.json` with the fields your prompt template uses. Four fields are required; the rest are optional and default to empty or nil values:

```json
[
  {
    "id": "1",
    "identifier": "TEST-1",
    "title": "Validate login form inputs",
    "state": "To Do",
    "description": "The form accepts empty email addresses.",
    "priority": 1,
    "labels": ["bug", "auth"],
    "comments": [
      {
        "id": "c1",
        "author": "reviewer",
        "body": "Check the regex pattern, not just length.",
        "created_at": "2026-03-15T09:00:00Z"
      }
    ]
  },
  {
    "id": "2",
    "identifier": "TEST-2",
    "title": "Add rate limiting to public API",
    "state": "To Do",
    "description": "",
    "labels": [],
    "blocked_by": [
      { "id": "1", "identifier": "TEST-1", "state": "To Do" }
    ]
  }
]
```

This fixture tests two template paths at once: `TEST-1` has comments and labels, `TEST-2` has an empty description and a blocker. Every `{{ if }}` branch in your prompt gets exercised because the adapter preserves nil-vs-empty semantics — `"comments": null` means "not fetched," `"comments": []` means "none exist," and omitting the field entirely defaults to null.

For the full field schema, see the [file-based tasks spec](https://github.com/sortie-ai/sortie/blob/main/docs/file-based-tasks-spec.md).

### Configure the workflow

Set `tracker.kind` to `file` and point `file.path` at your fixture:

```jinja
---
tracker:
  kind: file
  active_states: ["To Do"]
  handoff_state: Done
  terminal_states: ["Done"]

file:
  path: ./issues.json

agent:
  kind: mock
  max_turns: 2

polling:
  interval_ms: 10000
---

**{{ .issue.identifier }}**: {{ .issue.title }}

{{ if .issue.description }}
{{ .issue.description }}
{{ end }}

{{ if .issue.comments }}
## Feedback
{{ range .issue.comments }}
- {{ .author }}: {{ .body }}
{{ end }}
{{ end }}

{{ if .issue.blocked_by }}
## Blockers
{{ range .issue.blocked_by }}
- {{ .identifier }} ({{ .state }})
{{ end }}
{{ end }}
```

Run `sortie validate ./WORKFLOW.md` to catch syntax errors before starting.

### Run and observe

```bash
sortie ./WORKFLOW.md
```

Watch the logs. Sortie reads your JSON file, dispatches one mock agent session per active issue, runs two turns each, and transitions them to "Done." The full poll-dispatch-execute-handoff lifecycle runs identically to production — only the data source and agent are swapped.

Press **Ctrl+C** to stop after the cycle completes.

### Test edge cases

The file adapter re-reads the JSON on every operation, so you can edit `issues.json` while Sortie is running. Add a new issue, change a state, introduce a nil field — the next poll picks it up.

Scenarios worth testing:

- **Nil parent guard.** Add `"parent": null` and confirm your template handles it.
- **Empty description.** Set `"description": ""` and verify the `{{ if }}` block skips it.
- **Priority sorting.** Add issues with `"priority": 1`, `"priority": 3`, and `"priority": null` to confirm dispatch order.
- **Blocker rendering.** Populate `blocked_by` with multiple entries and check the rendered prompt.
- **Tracker comments.** Enable `tracker.comments.on_dispatch: true` and check the logs for "dispatch comment posted" messages. The file adapter stores comments in memory for the duration of the process.

Each scenario targets a specific `{{ if }}` or `{{ range }}` branch in your template. If a field reference is misspelled, Sortie's strict mode (`missingkey=error`) fails immediately with a line number — no silent empty strings.

### Graduate to a real agent

Once your template renders correctly with the mock agent, swap `agent.kind` to `claude-code` and keep the file tracker:

```yaml
agent:
  kind: claude-code
  max_turns: 3
```

This runs a real agent against your test fixture — full code generation sessions without touching Jira. When you're satisfied, swap `tracker.kind` to `jira`, point it at your project, and the same workflow file drives production.

{{% /steps %}}

## Troubleshooting

**"missing required config key: path"** — The `file:` block is absent or `path` is empty. Add `file.path` to your front matter.

**"failed to parse file"** — The JSON is malformed. Validate it: `python3 -m json.tool issues.json > /dev/null`

**No issues dispatched** — The `state` values in your JSON don't match `active_states`. Comparison is case-insensitive, but check for typos: `"To do"` won't match `"To Do"` because both sides are lowercased to `"to do"` before comparison — this means case differences are fine, but spelling must match.

For the full configuration schema, see the [WORKFLOW.md reference](/reference/workflow-config/). For template syntax and available variables, see [How to write a prompt template](/guides/write-prompt-template/).
