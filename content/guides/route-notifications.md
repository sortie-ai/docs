---
title: "How to Send Sortie Events to Issue Comments, Slack, Telegram, Discord, and Webhooks"
linkTitle: "Route Notifications"
description: "Choose which Sortie events reach the tracker issue, a Slack, Telegram, or Discord chat, or a webhook endpoint, add the agent's stop reason, and move off the deprecated comment settings without losing a comment."
author: Sortie AI
date: 2026-10-01
weight: 168
url: /guides/route-notifications/
---
Decide which of Sortie's messages reach the issue, Slack, Telegram, Discord, or a webhook. Each destination is one entry in `notifications`, and each entry lists the events it receives. This guide also shows how to replace the deprecated `tracker.comments` flags and `escalation: comment` with the same behavior in the new form.

## Prerequisites

- A working workflow with a configured `tracker`. A `tracker_comment` entry needs one.
- For Slack, an incoming webhook URL. For a webhook, an HTTPS endpoint that accepts a JSON POST.
- For Telegram, a bot token and the id of the chat the bot posts to. Create the bot as described in the [Telegram bot documentation](https://core.telegram.org/bots#how-do-i-create-a-bot), add it to the chat (as an administrator for a channel), and find the chat id as described for [`getUpdates`](https://core.telegram.org/bots/api#getupdates) in the Bot API documentation. A public channel can use its `@username` instead.
- For Discord, a channel webhook URL. Create it as described in [Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).
- Each URL or token in an environment variable whose name starts with `SORTIE_`, such as `SORTIE_SLACK_WEBHOOK_URL` or `SORTIE_TELEGRAM_BOT_TOKEN`.

## Comment on the issue

Add a `tracker_comment` entry and list the events you want as comments:

```yaml
notifications:
  - kind: tracker_comment
    events:
      - session.completed
      - session.stopped
      - session.failed
```

The three events cover every worker exit. Soft stops (`blocked`, `needs-human-review`, `no-change-needed`) are `session.stopped`, not `session.completed`, so an entry that lists only `session.completed` misses them. Add `session.started` for a comment when Sortie claims the issue.

The entry takes only `kind` and `events`. At most one `tracker_comment` entry is allowed, and `events: []` is valid when you want no comments beyond what the deprecated settings enable.

## Show the agent's reason for stopping

When an agent stops on `blocked`, `needs-human-review`, or `no-change-needed`, it can write its reason on the lines after the value in `.sortie/status`. Sortie asks for one in the first-turn prompt it adds. The reason appears only on `session.stopped`, so list that event on every destination that should show it.

On the issue, the reason follows the stop text after a blank line:

```text
Sortie session completed (agent signaled: blocked).
Duration: 12m4s
Turns: 7

The ticket asks for both soft and hard delete of invoices.
Which one should the API expose?
```

To make agents write a useful one for your project, say what a good reason contains in your prompt. See [guide the agent to signal blocked status](/guides/use-agent-tools-in-prompts/#guide-the-agent-to-signal-blocked-status). The statement is the agent's own text. Sortie masks the secrets it knows, but write the prompt so agents never put credentials in it. See [what reaches a tracker comment](/concepts/security/#what-reaches-a-tracker-comment).

## Send events to Slack

Add a `slack` entry. List `agent.message` to keep the agent's own `notify_operator` messages in the channel, and add the events that need a person:

```yaml
notifications:
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    events:
      - agent.message
      - session.stopped
      - session.failed
      - escalation.ci_failure
      - budget.held
```

Each message reads `[WARNING] PROJ-42: session.failed`, followed by the same text the issue comment carries. On `session.stopped`, the agent's stop reason follows the same way, after a blank line.

The agent's own `notify_operator` messages are capped per agent run, and `max_per_session` on an entry that lists `agent.message` changes that cap. See [the `notifications` reference](/reference/workflow-config/#notifications) for the exact rules.

## Send events to Telegram

Add a `telegram` entry with the bot token and the chat id:

```yaml
notifications:
  - kind: telegram
    bot_token: $SORTIE_TELEGRAM_BOT_TOKEN
    chat_id: "-1001234567890"
    events:
      - agent.message
      - session.stopped
      - session.failed
      - budget.held
```

`chat_id` is a number, written bare or quoted, or a public channel's `@username`. Each message arrives as plain text in the chat and reads like the Slack one: `[WARNING] PROJ-42: session.failed`, then the body. A message longer than Telegram's limit is cut to fit.

## Send events to Discord

Add a `discord` entry with the channel webhook URL:

```yaml
notifications:
  - kind: discord
    webhook_url: $SORTIE_DISCORD_WEBHOOK_URL
    events:
      - agent.message
      - session.stopped
      - session.failed
      - budget.held
```

Each message arrives in the channel as plain text and reads like the Slack one. A message longer than Discord's limit is cut to fit. The reference lists the [fields and limits](/reference/workflow-config/#notifications) of both kinds.

## Send events to a webhook

Add a `webhook` entry for a system that archives or reacts to events:

```yaml
notifications:
  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL
    events:
      - session.started
      - session.completed
      - session.stopped
      - session.failed
```

Branch on the `event_type` key of each JSON payload. The stop reason, when there is one, arrives in `agent_text`. Payloads for `agent.message` carry neither key, so an endpoint that only handles agent messages keeps working. For the full payload, see [what each destination receives](/reference/workflow-config/#what-each-destination-receives).

## Combine destinations

One event can go to several destinations, and each destination picks its own events:

```yaml
notifications:
  - kind: tracker_comment
    events:
      - session.completed
      - session.stopped
      - session.failed

  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    events:
      - agent.message
      - session.stopped
      - session.failed
      - escalation.ci_failure
      - budget.held

  - kind: webhook
    url: $SORTIE_OPS_WEBHOOK_URL
    events:
      - session.started
      - session.completed
      - session.stopped
      - session.failed
```

Here `agent.message` reaches Slack only, because only that entry lists it. The agent's messages never reach the issue, and `agent.message` is rejected on a `tracker_comment` entry. The agent gets the `notify_operator` tool only when some entry lists `agent.message`.

For every event name and when it fires, see the [event catalog](/reference/workflow-config/#event-catalog).

## Get an escalation as a comment without a label

Reactions label the issue by default when they hand it to a person. To get a comment instead, or as well, subscribe to the escalation event:

```yaml
reactions:
  ci_failure:
    provider: github
    escalation: none

notifications:
  - kind: tracker_comment
    events:
      - escalation.ci_failure
```

`escalation: none` skips the label. Keep `escalation: label` and list the event to get both. Every escalation emits its event whatever `escalation` says, so an entry of any other kind can list it too.

## Move off the deprecated settings

The old settings still work and draw a warning at startup and in `sortie validate`. Each replacement posts the same comment. Do the steps that apply to your workflow, then write all of them into one `tracker_comment` entry.

### If you set `tracker.comments`

Map each flag that is `true` to its events, then delete the `comments` block:

| Flag | Events to list |
|---|---|
| `on_dispatch` | `session.started` |
| `on_completion` | `session.completed`, `session.stopped` |
| `on_failure` | `session.failed` |

### If you set `escalation: comment`

For each reaction that uses it, set `escalation: none` and list `escalation.<kind>`, for example `escalation.ci_failure` or `escalation.merge_completion`.

### If you use auto-merge or a per-issue budget

The auto-merge success comment and the budget-hold comment have no setting of their own. They post while no `tracker_comment` entry exists, and they stop the moment you add one that omits them. Do not lose them by accident: list `auto_merge.merged` if you use the auto-merge reaction, and `budget.held` if `agent.max_sessions`, `agent.max_tokens`, or `agent.max_cost_usd` is above `0`.

### If a `slack`, `telegram`, `discord`, or `webhook` entry has no `events`

Add `events: [agent.message]`. That is what the entry received before.

### A complete before and after

Before:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme/billing-api
  comments:
    on_completion: true
    on_failure: true

agent:
  max_sessions: 3

reactions:
  ci_failure:
    provider: github
    escalation: comment

notifications:
  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
```

After:

```yaml
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: acme/billing-api

agent:
  max_sessions: 3

reactions:
  ci_failure:
    provider: github
    escalation: none

notifications:
  - kind: tracker_comment
    events:
      - session.completed
      - session.stopped
      - session.failed
      - escalation.ci_failure
      - budget.held

  - kind: slack
    webhook_url: $SORTIE_SLACK_WEBHOOK_URL
    events:
      - agent.message
```

You can migrate in two steps. While both forms are present, an event listed in both is still delivered once to each destination, so keeping `on_completion: true` next to `session.completed` gives one comment, not two.

## Verify

Run the validator:

```sh
sortie validate WORKFLOW.md
```

A finished migration prints no `deprecated` or `implicit` warnings from the list below, and `valid` stays `true`. Each warning names the setting and its replacement:

- `tracker.comments.<flag>.deprecated`
- `reactions.<kind>.escalation.deprecated`
- `notifications.tracker_comment.implicit_auto_merge` and `notifications.tracker_comment.implicit_budget_hold`
- `notifications[<i>].events.missing`

Then trigger one real event, such as a session on a test issue, and check each destination. The run log shows `tracker comment posted` for the issue and a `notification delivery failed` warning, with the `event_type` and `destination`, for a send to any other kind that did not go through.

## Troubleshooting

**A blocked issue got no comment.** The entry lists `session.completed` but not `session.stopped`. Add it.

**The auto-merge or budget-hold comment disappeared after adding an entry.** An explicit `tracker_comment` entry posts only what it lists. Add `auto_merge.merged` or `budget.held`.

**`sortie validate` rejects the entry.** The message names the rule. Common causes are a second `tracker_comment` entry, no `tracker.kind`, a missing `events` key on `tracker_comment`, or an event name the catalog does not contain. See the [configuration errors](/reference/errors/#startup-and-configuration-errors).

**Slack, Telegram, Discord, or the webhook receives nothing.** For an entry that lists `agent.message`, check that the URL or token variable starts with `SORTIE_`; the tool server sees only variables with that prefix. Otherwise read the `notification delivery failed` warning, which names the destination.

**A config edit did not apply.** Events Sortie produces use the new entries from the next poll tick. The agent's `notify_operator` messages use them from the next agent session. A reload that cannot build a destination is rejected, and the previous configuration stays in force.

## Related

- [WORKFLOW.md reference: notifications](/reference/workflow-config/#notifications)
- [Reactions reference: escalation actions](/reference/reactions/#escalation-actions)
- [Agent extensions reference: stop statement](/reference/agent-extensions/#stop-statement)
- [What reaches a tracker comment](/concepts/security/#what-reaches-a-tracker-comment)
