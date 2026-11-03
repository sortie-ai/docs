---
title: How to Use the File Adapter for Local Testing
linkTitle: "Use File Adapter for Testing"
description: "Test Sortie workflows without Jira: create a JSON fixture, configure the file adapter, iterate on prompts and hooks, then graduate to production."
author: Sortie AI
date: 2026-03-28
weight: 30
url: /guides/use-file-adapter-for-testing/
---
The file adapter replaces a live tracker with a local JSON file. Pair it with the mock agent and you can validate your entire workflow (prompts, hooks, state transitions) without API credentials, network access, or token spend.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))

{{% steps %}}

### Create a test fixture

Create `issues.json` with the fields your prompt template uses. Four fields are required; the rest are optional and default to empty or nil values:

```json {filename="issues.json"}
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

This fixture tests two template paths at once: `TEST-1` has comments and labels, `TEST-2` has an empty description and a blocker. Every `{{ if }}` branch in your prompt gets exercised because the adapter preserves nil-vs-empty semantics: `"comments": null` means "not fetched," `"comments": []` means "none exist," and omitting the field entirely defaults to null.

A comment needs an `author`, a `body`, and a `created_at` in RFC 3339 form. Its `id` is optional: a comment without one gets an identity Sortie derives from its author, time, and text, so the same comment keeps the same identity across reads and restarts. The author is also the comment's identity, because the file has no accounts.

For the full field schema, see the [file-based tasks spec](https://github.com/sortie-ai/sortie/blob/main/docs/file-based-tasks-spec.md).

### Configure the workflow

Set `tracker.kind` to `file` and point `file.path` at your fixture:

```jinja {filename="WORKFLOW.md",hl_lines=[3,"8-9",20,24,30]}
---
tracker:
  kind: file
  active_states: ["To Do"]
  handoff_state: In Review
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

Run `sortie validate ./WORKFLOW.md` to catch syntax errors before starting. It also reports an `agent.kind.no_tool_channel` warning here, because the mock agent launches no process for Sortie's tools to reach. The configuration stays valid and the exit code stays `0`, but it marks the edge of this rig: a prompt that calls a Sortie tool is the one thing the file adapter and the mock agent cannot exercise together. See the [`validate` command reference](/reference/cli/#validate) for the check.

### Run and observe

```bash
sortie ./WORKFLOW.md
```

Watch the logs. Sortie reads your JSON file, dispatches one mock agent session per active issue, runs two turns each, and hands them off to "In Review." The full poll-dispatch-execute-handoff lifecycle runs identically to production. Only the data source and agent are swapped. The handoff target stays outside `active_states` and `terminal_states` here for the same reason it does in production: Sortie rejects a configuration where they overlap.

Press **Ctrl+C** to stop after the cycle completes.

The comment on `TEST-1` reaches the agent without any change to the template, which never mentions comments. Look for this line at the start of the first turn:

```text
level=INFO msg="issue comments delivered" issue_id=1 issue_identifier=TEST-1 session_id=mock-session-001 turn_number=1 new_comments=1 earlier_comments=0
```

The mock agent does not print the prompt, so this line is how you see a delivery. The second turn logs no such line, because the agent already holds the comment. The [`comment_feed` reference](/reference/workflow-config/#comment_feed) describes what the agent receives, and [Steer agents with issue comments](/guides/steer-agents-with-issue-comments/) covers it from the operator's side.

To run the fixture to completion and exit, with a status a script can check, start Sortie with [`--once`](/reference/cli/#--once) instead. It dispatches the issues in the file once, waits for the agents to finish, and exits `0` when every issue's last run succeeded. Add `--once-result result.json` to also get the outcome of each issue in a file; the [reference](/reference/cli/#--once-result) describes its contents.

### Test edge cases

The file adapter re-reads the JSON on every operation, so you can edit `issues.json` while Sortie is running. Add a new issue, change a state, introduce a nil field. The next poll picks it up.

Scenarios worth testing:

- **Nil parent guard.** Add `"parent": null` and confirm your template handles it.
- **Empty description.** Set `"description": ""` and verify the `{{ if }}` block skips it.
- **Priority sorting.** Add issues with `"priority": 1`, `"priority": 3`, and `"priority": null` to confirm dispatch order.
- **Blocker rendering.** Populate `blocked_by` with multiple entries and check the rendered prompt.
- **Tracker comments.** Add a `tracker_comment` entry that lists `session.started` under `notifications` and check the logs for "dispatch comment posted" messages. The file adapter keeps the comments Sortie posts in memory for the duration of the process and never writes them to `issues.json`. They follow the comments of the file in every read, and the feed never hands them to the agent.
- **A comment that arrives mid-run.** Add a comment to an issue's `comments` while its agent is between turns. The next turn logs `issue comments delivered` with the new comment. An edit to the text of a comment that has an `id` is delivered again, marked as replacing the earlier text. An edit to a comment without an `id` gives it a new identity, so it arrives as a new comment.
- **Who counts as a member.** By default the feed delivers a comment only when its author is a member of the project. On the file tracker every comment with a named `author` counts, and a comment with an empty `author` does not, so no line is logged for it. Set `comment_feed.authors` to `all` to deliver it, or `comment_feed.enabled` to `false` to deliver nothing.
- **Stage labels.** Put a [stage label](/reference/workflow-config/#dispatch) in an issue's `labels` to start it on that rule. Labels Sortie adds or removes live in memory too: the adapter keeps every label it adds, matches labels ignoring case, and never writes to `issues.json`. A label Sortie removed stays hidden even if you type it back into the file, until Sortie adds it again. Restart Sortie to return to the labels the file holds.

Each scenario targets a specific `{{ if }}` or `{{ range }}` branch in your template. If a field reference is misspelled, Sortie's strict mode (`missingkey=error`) fails immediately with a line number. There are no silent empty strings.

### Graduate to a real agent

Once your template renders correctly with the mock agent, swap `agent.kind` to `claude-code` and keep the file tracker:

```yaml {hl_lines=[2]}
agent:
  kind: claude-code
  max_turns: 3
```

This runs a real agent against your test fixture: full code generation sessions without touching Jira. When you're satisfied, swap `tracker.kind` to `jira`, point it at your project, and the same workflow file drives production.

{{% /steps %}}

## Troubleshooting

**"missing required config key: path"**: The `file:` block is absent or `path` is empty. Add `file.path` to your front matter.

**"failed to parse file"**: The JSON is malformed. Validate it: `python3 -m json.tool issues.json > /dev/null`

**No issues dispatched**: `active_states` is empty, which dispatches nothing, or the `state` values in your JSON don't match it. The adapter lowercases both sides before comparing, so `"To do"` matches `"To Do"`, but a spelling difference such as `"ToDo"` does not.

**"issue comment feed read failed" in the log**: A comment in the issue has a `created_at` that is not an RFC 3339 timestamp, or two comments of the issue share an `id`. The turn runs without comments until you fix the file. The `created_at` value `2026-03-15T09:00:00Z` is valid; `yesterday` is not.

**A comment never reaches the agent**: Check that `comment_feed.enabled` is not `false`, that the comment has a non-empty `author`, and that the author is not in `comment_feed.exclude_authors`. A comment that Sortie posted itself is never delivered.

For the full configuration schema, see the [WORKFLOW.md reference](/reference/workflow-config/). For template syntax and available variables, see [How to write a prompt template](/guides/write-prompt-template/).
