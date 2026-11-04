---
title: "How to Steer a Coding Agent With Issue Comments"
linkTitle: "Steer Agents With Comments"
description: "Answer or redirect an AI coding agent that is already working on an issue by writing a comment on it. Choose whose comments the agent reads, or switch the feature off."
author: Sortie AI
date: 2026-11-03
weight: 170
url: /guides/steer-agents-with-issue-comments/
---
Write a comment on the issue an agent is working on, and the agent reads it. This guide shows how that works, how to decide whose comments the agent reads, and how to switch it off.

## Prerequisites

- A working Sortie setup with a tracker ([quick start](/getting-started/quick-start/))
- Permission to comment on the issues Sortie dispatches

## Comment on the issue

Nothing needs configuring. Write the comment on the issue the agent is working on, in the tracker you already use. Sortie reads it and adds it to the agent's next prompt, with no change to your `WORKFLOW.md` or your prompt template.

One thing to know before you rely on it:

- A comment does not interrupt a turn in progress. The agent reads it at the start of its next turn. Continuation turns and self-review turns count, so a correction written during a run reaches the agent before the run ends. When the agent has stopped and the issue is waiting, the comment is in the first prompt of the next run.

The comments reach the agent even when your template never mentions them. Sortie appends them after the rendered template. To choose where they appear instead, see [place issue comments in your prompt](/guides/write-prompt-template/#place-issue-comments-in-your-prompt).

## What the agent receives

The agent gets each comment once per conversation. If you edit a comment, the agent gets the edited text once more, marked as replacing the version it already holds. Deleting a comment sends nothing, so to retract an instruction, write a new comment or edit the old one.

A comment that Sortie posted itself, such as a session-started or session-completed notification, never comes back to the agent. A comment the agent wrote with its own tools does, unless you exclude the account that wrote it (see [keep a noisy author out](#keep-a-noisy-author-out)).

A session that starts without the history of the one before it also receives the comments the earlier sessions on the issue were given, in a separate group ahead of the new ones. The full rules are in the [`comment_feed` reference](/reference/workflow-config/#comment_feed).

## Choose whose comments count

By default the agent reads comments from people who can write to the project, and from nobody else. On a public GitHub, GitLab, or Gitea project, any account can comment, and a delivered comment steers an agent that runs with your credentials. The default keeps a stranger's text out of the prompt. [Security](/concepts/security/) explains the reasoning.

What "can write to the project" means depends on the tracker:

- On GitHub, Gitea, and GitLab, Sortie asks the forge whether the commenter has write access.
- On Jira and Linear, commenting already requires access to the project or workspace, so every identified commenter counts.
- On the file tracker, every comment with an author counts.

Bots, apps, and external accounts are outside the default on every tracker. The tasks below change that. Each snippet is a complete `WORKFLOW.md` you can validate.

### Let a bot or a teammate without write access through

List the author in `include_authors`. Sortie delivers the comments of a listed author without checking the author's kind or access:

```yaml {filename="WORKFLOW.md",hl_lines=[13,14]}
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

comment_feed:
  include_authors: [release-bot, alice-contractor]
---

Fix #{{ .issue.identifier }}: {{ .issue.title }}
```

An entry is the identity the tracker reports for the author, matched exactly, with letter case counted. It is not a display name:

| Tracker | What to list |
| ------- | ------------ |
| GitHub, Gitea | The account login |
| GitLab | The account username |
| Jira | The account ID (on Jira Data Center, the user name) |
| Linear | The ID of the user, or of the bot actor |
| File | The comment's author string |

The other members keep working. `include_authors` adds to the default and replaces nothing.

### Keep a noisy author out

List the author in `exclude_authors`. Sortie never delivers that author, and an author listed in both lists is excluded:

```yaml {filename="WORKFLOW.md",hl_lines=[13,14]}
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

comment_feed:
  exclude_authors: [ci-notifier]
---

Fix #{{ .issue.identifier }}: {{ .issue.title }}
```

Use this for an integration that comments on every build, and for the account the agent itself comments from. Without the exclusion, the agent receives its own comments back on its next turn.

### Accept every author

Set `authors: all` to deliver every comment, including comments from accounts with no write access and comments with no identifiable author:

```yaml {filename="WORKFLOW.md",hl_lines=[13,14]}
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

comment_feed:
  authors: all
---

Fix #{{ .issue.identifier }}: {{ .issue.title }}
```

Choose this only for a private project where everyone who can comment is trusted. `exclude_authors` still applies under `all`, so you can accept everyone except one account.

## Check that the token can resolve members

The `members` default needs the tracker token to answer whether a commenter has write access. Jira, Linear, and the file tracker need no lookup. The forges differ in what the token must allow:

- [GitHub](/reference/adapter-github/)
- [GitLab](/reference/adapter-gitlab/)
- [Gitea](/reference/adapter-gitea/)

When the token cannot ask the question, Sortie logs one error per process, `comment author access lookup refused`, with the tracker kind and a hint. From then on the comments that need a lookup are not delivered, and nothing else fails. The comments reach the agent once you give the token the access (from the next run), list the author in `include_authors`, or set `authors: all`.

Search the Sortie logs for that message to see whether you are in this case.

## Turn the feed off

Set `enabled: false`. The agent then receives no issue comments from Sortie, and Sortie makes no extra requests to your tracker:

```yaml {filename="WORKFLOW.md",hl_lines=[13,14]}
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

comment_feed:
  enabled: false
---

Fix #{{ .issue.identifier }}: {{ .issue.title }}
```

A reload of `WORKFLOW.md` applies the change to the runs that start after it. A run in progress keeps the behavior it started with.

## Verify the result

Check the file offline:

```bash
sortie validate ./WORKFLOW.md
```

Validation fails with an error that names the key when `authors` is anything other than `members` or `all`, or when an author list holds an item that is not a non-empty string. A misspelled key under `comment_feed` draws a warning.

Then comment on an issue Sortie is working on. The comment appears in the agent's next prompt under the heading `New issue comments`.

## Next steps

- [Place issue comments in your prompt](/guides/write-prompt-template/#place-issue-comments-in-your-prompt) to choose where the comments appear, or to keep them out of the prompt on purpose
- [`comment_feed` reference](/reference/workflow-config/#comment_feed) for every key and rule
- [Troubleshoot common failures](/guides/troubleshoot-common-failures/) when a comment never reaches the agent
