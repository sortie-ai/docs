---
title: "How to Check That an Issue Is Ready Before an Agent Works on It"
linkTitle: "Check Issue Readiness"
description: "Stop vague issues before a coding agent spends a full session on them: a cheap first stage reads each issue, sends ready ones on to the real work, and parks the rest with what is missing posted back on the issue."
author: Sortie AI
date: 2026-11-04
weight: 96
url: /guides/check-issue-readiness/
---
An issue that says "fix the thing" is dispatched like any other. The agent reads the repository, guesses, and the team learns the issue could not be done only after a full session on the main model has run.

This guide builds a workflow that stops such an issue early. A first stage on a cheap model reads each issue. A ready issue moves on to the real work on its own. An unready issue is parked, and the reporter finds a comment on it that lists what is missing. The price is one short extra session on every issue you check.

## Prerequisites

- Sortie running with a tracker adapter and one agent working end to end (see [Connect to GitHub](/guides/connect-to-github/), [Connect to Jira](/guides/connect-to-jira/), or the other tracker guides). The examples use GitHub and Claude Code.
- A cheap model name for the check and the model name you use for the real work, both served by your provider.
- The idea of a stage chain, in one line: dispatch rules linked with `next`, where a successful run hands the issue to the next rule by adding that rule's stage label. [Stage chains](/concepts/stage-chains/) explains why.

## Link a readiness rule to the main rule

Add a rule that checks readiness and a rule that does the work to `dispatch.rules`:

```yaml
dispatch:
  rules:
    - name: readiness
      next: implement
      template: ./prompts/readiness.md

    - name: implement
      stage: stage-implement
      template: ./prompts/implement.md
```

`readiness` has no `stage` and no `match`, so it matches every issue that no stage label already places. Nobody labels anything to start the chain. Its `next` names `implement`, which carries the `stage-implement` label. When the check succeeds, Sortie adds `stage-implement` to the issue and the main rule picks it up on the next poll tick.

To check only some issues, give `readiness` a `match` block, such as `match: { labels: ["feature"] }`. Issues it does not match run on the top-level prompt and settings, with no check.

A chain ends on `tracker.handoff_state`, so set it (the full listing below uses `review`). Sortie rejects `next` without it. An issue you label `stage-implement` yourself skips the check, because a stage label is matched before any other rule.

## Run the check on a cheaper model

Give the `readiness` rule its own settings for the agent kind, under the kind's name. Sortie lays them over the top-level block:

```yaml
    - name: readiness
      next: implement
      template: ./prompts/readiness.md
      claude-code:
        model: <cheap-model-id>
```

If the top-level `claude-code` block sets `effort`, the rule inherits a level chosen for the other model, and `sortie validate` warns with `agent.effort.inherited`. Write `effort` in the rule for the level the cheap model should use, or `effort: null` to clear it. The listing below sets no top-level `effort`, so it needs neither. [Route issues to a cheaper or a stronger model](/guides/configure-dispatch-rules/#route-issues-to-a-cheaper-or-a-stronger-model) covers the overlay rules.

## Write the readiness prompt

The readiness template defines what "ready" means for your team, forbids any change to the repository, and tells the agent exactly how to report each verdict. The agent reports through `.sortie/status`, a file in its workspace. Sortie reads the first line as the verdict and the lines after it as the reason.

| Verdict | First line | Lines after it | What Sortie does |
|---|---|---|---|
| Ready | `no-change-needed` | A one-line note | Counts the run as a success and hands the issue to `implement`. |
| Not ready | `blocked` | What is missing | Parks the issue and never hands it on. |

The ready verdict is `no-change-needed` and not "write nothing", because a readiness run changes nothing. Under the default `tracker.handoff_evidence: observed`, a run in a Git work tree that left no commit and no changed file reads as a run that did no work. Sortie withholds the handoff and retries the run. After `agent.max_consecutive_absences` such runs in a row (3 by default), it parks the issue with the reason `handoff_absence`. Writing `no-change-needed` is the agent saying the outcome already held, which counts as evidence, so the run succeeds and the issue advances. The built-in status instructions describe `no-change-needed` in those terms, so your template has to say what it means for this stage.

For the not-ready verdict, the whole file must stay under 1024 bytes. Sortie reads no more than that, and a reason cut at the limit ends in an ellipsis. Ask for a short list of questions, not an essay.

Save this as `prompts/readiness.md`:

```text
You are checking whether {{ .issue.identifier }} is ready for an engineer to work on. You do not fix it.

Title: {{ .issue.title }}

{{ .issue.description }}

An issue is ready when a person who has never seen it could tell from the text alone what behavior to change or add, where in the product it happens, and how to tell the work is done. Read the repository to check that what the issue names exists. Do not create, edit or delete any file other than .sortie/status.
{{ if .park }}
You stopped on this issue earlier and a person has since released it: {{ .park.statement }}
Check it again against the description above and any new comments.
{{ end }}
When you have decided, write the verdict to .sortie/status and stop.

If the issue is ready, run:

    mkdir -p .sortie && printf '%s\n' "no-change-needed" "Ready: <one line on what you will build>" > .sortie/status

If it is not ready, run the command below. After the word blocked, list each missing detail on its own line, as a question the reporter can answer in the issue description. Keep the whole file under 1024 bytes and put no credentials in it:

    mkdir -p .sortie && printf '%s\n' "blocked" "<first missing detail>" "<second missing detail>" > .sortie/status
```

Change the definition of ready to fit your project. A team with acceptance criteria in every issue might require them; a team that files bugs might require steps to reproduce. The `.park` block only renders on the run that follows a release, which the section on what happens next explains.

## Write the main prompt

The main template reads what the check decided. `.stage.previous` names the stage that handed the issue over, and `.stage.previous_outcome` is `no_change` when that stage ended on `no-change-needed`. Both are empty when a person put the label on the issue, so the template can tell the cases apart:

```text
You are implementing {{ .issue.identifier }}: {{ .issue.title }}.

{{ .issue.description }}

{{ if eq .stage.previous_outcome "no_change" }}The {{ .stage.previous }} stage judged this issue ready and changed nothing.{{ else if .stage.current }}A person placed this issue on the {{ .stage.current }} stage directly, so nobody has checked it yet. If it is too vague to act on, write blocked to .sortie/status and say what is missing.{{ end }}

Write the code and its tests.
```

Save it as `prompts/implement.md`. The [`.stage` reference](/reference/workflow-config/#stage) lists the fields.

## Post the reason on the issue

Without a `notifications` block, Sortie posts no comment when an agent stops on `blocked`. The reason would sit in the run history and the log, and the reporter would see only a new label. Add a `tracker_comment` entry that lists `session.stopped`, the event for every stop on `blocked`, `needs-human-review` or `no-change-needed`:

```yaml
notifications:
  - kind: tracker_comment
    events: [session.stopped]
```

The entry also comments on a ready issue, with the one-line note from the ready verdict. That is why the template asks for a short one. To send the reason to a chat or an endpoint as well, add `slack` or `webhook` entries that list the same event; see [Route notifications](/guides/route-notifications/#show-the-agents-reason-for-stopping).

## The complete workflow

Put `WORKFLOW.md` in the working directory of your Sortie process and the two templates in `prompts/` beside it. Replace the model placeholders with names your provider serves.

`WORKFLOW.md`:

```yaml
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]
  handoff_state: review          # required: the chain ends here

agent:
  kind: claude-code
  max_sessions: 4                # covers the check, the main run, and a retry or a release

claude-code:
  permission_mode: bypassPermissions
  model: <main-model-id>

notifications:
  - kind: tracker_comment
    events: [session.stopped]    # posts the agent's reason on the issue

dispatch:
  rules:
    - name: readiness
      next: implement            # a successful check hands the issue on
      template: ./prompts/readiness.md
      claude-code:
        model: <cheap-model-id>

    - name: implement
      stage: stage-implement
      template: ./prompts/implement.md
---

Resolve {{ .issue.identifier }}: {{ .issue.title }}.
```

The templates are the ones shown above: `prompts/readiness.md` and `prompts/implement.md`. The body under the front matter is the prompt for issues no rule matches; it is never used while `readiness` matches every issue.

Run `sortie validate WORKFLOW.md`. It checks the rules, their settings, and the templates, and prints nothing when it finds no error or warning. Your tracker's adapter reference ([GitHub](/reference/adapter-github/), [GitLab](/reference/adapter-gitlab/), [Gitea](/reference/adapter-gitea/), [Jira](/reference/adapter-jira/), [Linear](/reference/adapter-linear/)) says what the credential needs to add the stage and parking labels.

## Confirm a ready and a vague issue

Start Sortie and file two issues in an active state with no stage label: one with a clear description (what to change, where, and how to tell it is done), and one that says only "fix the thing".

For the clear issue, within a poll interval or two:

- The log has a `stage hop made` record with `source_rule=readiness` and `target_rule=implement`.
- The issue carries `stage-implement`, and a comment that starts `Sortie session completed (agent signaled: no-change-needed).` followed by the note.
- The next `issue dispatched` record carries `rule_name=implement`, and the main run starts on `<main-model-id>`.

For the vague issue:

- The log has an `issue parked` record with `reason=agent_blocked`, and the issue gains the label `needs-human`.
- The issue has a comment shaped like this, with the agent's questions after the blank line:

  ```text
  Sortie session completed (agent signaled: blocked).
  Duration: 41s
  Turns: 1

  Which screen is "the thing"?
  What should it do instead of what it does now?
  ```

- `GET /api/v1/state` lists the issue under `parked` with `"reason": "agent_blocked"`, `"rule_name": "readiness"`, and `"label": "needs-human"`. The dashboard shows the attention item "Parked: the agent needs a person". See the [HTTP API reference](/reference/http-api/#get-apiv1state-system-state) and the [dashboard attention items](/reference/dashboard/#attention-items).
- The issue never gets `stage-implement`, and no `implement` run starts.

The parking label is `needs-human` unless `reactions.review_comments.escalation_label` names another. A parked issue stays in its active state; it is held out of dispatch, not closed.

## What happens after a person answers

The reporter reads the comment and answers. The surest place is the issue description: edit it to include the missing detail. Then remove the `needs-human` label. Moving the issue to a different active state also releases it.

Sortie releases the issue on the poll tick that sees the label gone. It must have seen the label on the issue first; until then the dashboard marks the label "not yet seen on the issue". The issue still carries no stage label, so the `readiness` rule runs again and checks the new text. From there it follows either path above.

That release run receives more than a fresh run does:

- The current description, rendered into the template as usual.
- The `.park` variable, which the readiness template above uses for `.park.statement`, the reason the agent gave when it stopped. `.park.gesture` says how the person released the issue.
- The comments the agent has not seen, appended after the rendered prompt. Sortie does not post its own stop comment back to the agent. By default only comments from project members count; set [`comment_feed`](/reference/workflow-config/#comment_feed) to change that.
- The agent's earlier session, when the agent kind can resume one and the rule still picks the same agent kind and template. Otherwise the run starts a fresh session and has only the description, `.park`, and the comments.

A reply that lives only in a comment from someone without write access reaches none of this, so ask the reporter to edit the description. For more on what a released run sees, see [Hand the agent a person's answer after a park](/guides/write-prompt-template/#hand-the-agent-a-persons-answer-after-a-park) and [Steer agents with issue comments](/guides/steer-agents-with-issue-comments/).

## What the check costs

Every checked issue gets one more agent session, and every release gets one more. The sessions run on the cheap model, but each one starts a fresh agent, reads the repository, and waits at least one poll interval before the next stage starts.

`agent.max_sessions`, if you set it, counts every session of an issue across both stages. A ready issue needs a session for each stage. `sortie validate` warns with `dispatch.next.max_sessions` when the value is smaller than the chain's length. Leave room for a retry and a release or two, as the listing does with `4`.

One rule is the better choice when:

- Almost every issue arrives well specified, because a form or a template in your tracker demands the detail. The check then adds a session to each issue and rarely stops one.
- The work is small and uniform, such as a typo fix or a dependency bump, where a wrong guess costs less than the check.
- You have no way to tell the reporter. Without the `tracker_comment` entry, a parked issue carries a label and nothing else.

In those cases, tell the main prompt to write `blocked` with its reason when the issue is too vague, and skip the first stage. The agent then spends a main-model session to find out. The check exists to avoid that session.

## Troubleshooting

**A ready issue is retried and never gets `stage-implement`.** The agent finished without a recognized verdict. In a Git work tree the log shows `handoff withheld by evidence policy`. Check that the template tells the agent to write `no-change-needed` alone on the first line of `.sortie/status`, with the note on the lines after it. The whole first line must be exactly that word, so `no-change-needed.` or `no-change-needed: ready` is ignored, with an `unrecognized .sortie/status value` warning.

**A vague issue is retried instead of parked.** The same cause: the first line of `.sortie/status` was not exactly `blocked`. A line such as `blocked: which screen?` is ignored with the `unrecognized .sortie/status value` warning, and the issue is retried. Sortie parks only on a recognized `blocked`, and the reasons go on the lines after it.

**An issue is parked and no comment appears.** The workflow has no `tracker_comment` entry that lists `session.stopped`. The park and its label still work.

**The comment has no reason.** The agent wrote `blocked` with nothing after the first line break. The reason is the text after that break. Tell the template to put each missing detail on its own line.

**The reason ends in an ellipsis.** The status file was over 1024 bytes. Ask for fewer or shorter questions.

**The label is removed and nothing runs.** Sortie has not yet seen the label on the issue, or the issue is no longer in an active state. The dashboard's attention item says "not yet seen on the issue" while the first is true. Also check that the poll interval has passed.

**The released run ignores the answer.** The answer sits in a comment from an author the feed does not deliver, or the tracker read for comments failed. A failed read holds the issue under **Not dispatched** with the reason `park_comments_unread` until the next poll. Put the detail in the description.

**`sortie validate` reports `agent.effort.inherited`.** See [Run the check on a cheaper model](#run-the-check-on-a-cheaper-model).

## Related guides

- [Configure dispatch rules](/guides/configure-dispatch-rules/): rule matching, model routing, and the full chain mechanics
- [Stage chains](/concepts/stage-chains/): why stages are labels and what keeps a chain from looping
- [Route notifications](/guides/route-notifications/): send the agent's reason to Slack or a webhook
- [Steer agents with issue comments](/guides/steer-agents-with-issue-comments/): what the agent receives from comments
- [Write a prompt template](/guides/write-prompt-template/): template syntax and the `.park` variable
- [Control agent costs](/guides/control-costs/): session, token, and money ceilings
