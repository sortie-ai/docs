---
title: "How to Configure Dispatch Rules"
linkTitle: "Configure Dispatch Rules"
description: "Route issues to different agents, models, reasoning levels, and prompt templates by label, type, priority, identifier, assignee, or title, and chain dispatch rules into stages, such as specify then implement, that run one after another in WORKFLOW.md."
author: Sortie AI
date: 2026-05-27
weight: 95
url: /guides/configure-dispatch-rules/
---
By default, Sortie dispatches every issue with one agent (`agent.kind`) and one prompt template (the Markdown body of WORKFLOW.md). Dispatch rules change that: they route each issue to a specific agent, a specific template, specific agent settings such as the model and reasoning level, or any combination, based on the issue's metadata. Use them when bug fixes need a different prompt than documentation tasks, when frontend and backend issues should go to different agents, or when routine work belongs on a cheaper model and hard work on a stronger one. This guide shows you how to set up rules from zero, starting with a two-rule label split, then routing by model and by title, adding the other match types as you need them, and chaining rules into stages that hand an issue from one agent step to the next.

## Prerequisites

- Sortie running with a tracker adapter configured (see [Connect to Jira](/guides/connect-to-jira/) or [Connect to GitHub](/guides/connect-to-github/))
- One agent already working end to end (see your agent adapter reference)
- A second agent adapter configured, if you plan to route to different agents. Routing to different templates with the same agent needs no extra adapter.

## Route bugs and docs to different agents

Dispatch rules live in a `dispatch` block in the WORKFLOW.md front matter. Add an ordered `rules` list. Sortie evaluates rules top to bottom and uses the first one whose `match` block succeeds.

This example sends `bug`-labeled issues to Claude Code with a debugging prompt, and `docs`-labeled issues to Codex with a documentation prompt:

```yaml
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]

agent:
  kind: claude-code          # default agent kind
  command: claude
  max_turns: 5

claude-code:
  model: <model-id>
  permission_mode: bypassPermissions

codex:                       # required: a rule routes to codex below
  approval_policy: never

dispatch:
  rules:
    - name: bug-fix
      match:
        labels: ["bug", "bug/*"]
      agent: claude-code
      template: ./prompts/bug.md

    - name: docs
      match:
        labels: ["docs", "documentation"]
      agent: codex
      template: ./prompts/docs.md

  default:
    template: ./prompts/default.md
    # agent omitted: falls back to the top-level agent.kind (claude-code)
---

You are a coding assistant. Resolve {{ .issue.identifier }}: {{ .issue.title }}.
```

An issue labeled `bug` matches the first rule and runs Claude Code with `./prompts/bug.md`. An issue labeled `docs` matches the second rule and runs Codex with `./prompts/docs.md`. An issue with neither label falls through to `dispatch.default`.

Label matching uses glob syntax and runs against the adapter-normalized lowercase label set. The pattern `bug/*` matches `bug/regression` and `bug/crash`. Write label patterns in lowercase.

## Create the per-rule template files

Each `template` path points to a separate prompt file. Paths resolve relative to the directory containing WORKFLOW.md. Create the files referenced above:

```bash
mkdir -p prompts
```

`prompts/bug.md`:

```text
You are debugging {{ .issue.identifier }}: {{ .issue.title }}.

{{ .issue.description }}

Reproduce the failure first, then fix the root cause. Add a regression test.
```

`prompts/docs.md`:

```text
You are writing documentation for {{ .issue.identifier }}: {{ .issue.title }}.

{{ .issue.description }}

Match the surrounding style. Do not change code behavior.
```

Per-rule template files are plain Go `text/template` bodies with no YAML front matter. They use the same variables and functions as the WORKFLOW.md body. For the full template contract, see [Write a prompt template](/guides/write-prompt-template/).

Sortie rejects unsafe paths at load time: absolute paths, `~`-prefixed paths, and any path that resolves outside the WORKFLOW.md directory tree (including through symlinks). Keep templates under the workflow directory, for example in `./prompts/`.

## Share text between rule templates

`prompts/bug.md` and `prompts/docs.md` both print the issue description. To keep that text in one file, move it into a partial: a file of named blocks, each opened by `{{ define "name" }}` and closed by `{{ end }}`. Every template calls a block with `{{ template "name" . }}`. Put partials in a directory of their own, beside `prompts/`:

```text
WORKFLOW.md
partials/shared.md
prompts/bug.md
prompts/docs.md
```

List the partials under `dispatch`. An entry is a path or a glob pattern, relative to the directory that holds WORKFLOW.md:

```yaml
dispatch:
  partials:
    - ./partials/*.md
  rules:
    # bug-fix and docs rules as above
```

`partials/shared.md` holds one block:

```text
{{ define "issue-context" }}{{ .issue.description }}

Work only on this issue. Leave files it does not touch unchanged.{{ end }}
```

Replace the description line in each rule template with a call. `prompts/bug.md`:

```text
You are debugging {{ .issue.identifier }}: {{ .issue.title }}.

{{ template "issue-context" . }}

Reproduce the failure first, then fix the root cause. Add a regression test.
```

`prompts/docs.md`:

```text
You are writing documentation for {{ .issue.identifier }}: {{ .issue.title }}.

{{ template "issue-context" . }}

Match the surrounding style. Do not change code behavior.
```

Run `sortie validate WORKFLOW.md`. It exits `0` when both templates find the block. The WORKFLOW.md body and the default template can call `issue-context` the same way.

Two mistakes are easy to make:

- Pass `.` in the call. `{{ template "issue-context" }}` hands the block no data, so `validate` accepts it and the run fails when the template renders, with `nil data; no entry for key "issue"`.
- Select only partial files. A pattern that also picks up a prompt template, such as `./*/*.md`, stops the workflow from loading, because a partial may hold nothing but blocks.

Sortie does not watch partial files. An edit to one applies from the next poll tick. For the path rules, the order Sortie reads files in, and every other rule, see [Partials](/reference/workflow-config/#partials).

## Declare every agent kind a rule references

When a rule's `agent` differs from the top-level `agent.kind`, give that kind its own configuration block in the front matter. The example above routes to `codex`, so it includes a `codex:` block. A routed session reads that block and no other, on every attempt of the session; the block named by `agent.kind` does not stand in for it. Leave the block out and both `sortie validate` and startup preflight refuse the workflow with a `dispatch.agent.missing_block` error. Add the block, even an empty one (`codex: {}`), to fix it.

The shared `agent.*` settings (`max_turns`, `turn_timeout_ms`, `max_sessions`, concurrency caps) stay workflow-wide. A rule can override the agent kind, the template, and the settings of that kind, but never these budgets.

`agent.command` is the one `agent` setting that follows the kind rather than the workflow: only the default kind reads it. In the example above `claude-code` is the default, so the `docs` rule starts Codex with its own default command, `codex app-server`, and never runs `claude`. A routed kind cannot take a custom command; to give a kind one, make it the default kind. `agent-client-protocol` has no default command, so a rule cannot route to it beside a different default kind; see [Troubleshooting](#troubleshooting).

## Route issues to a cheaper or a stronger model

A rule can carry its own settings for the agent kind it runs. Write them in the rule under the kind's name, with the same keys that kind's top-level block takes. Sortie lays the rule's block over the top-level block, so the rule states only what differs.

This workflow sends `routine` issues to a cheaper model and `hard` issues to a stronger one at a higher reasoning level, all on Claude Code. Replace the model placeholders with names your provider serves:

```yaml
---
tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN
  project: myorg/myrepo
  active_states: [backlog, in-progress]
  terminal_states: [done, wontfix]

agent:
  kind: claude-code

claude-code:
  permission_mode: bypassPermissions
  model: <default-model-id>

dispatch:
  rules:
    - name: routine
      match:
        labels: ["routine"]
      claude-code:
        model: <cheap-model-id>

    - name: hard
      match:
        labels: ["hard"]
      claude-code:
        model: <strong-model-id>
        effort: high
---

You are a coding assistant. Resolve {{ .issue.identifier }}: {{ .issue.title }}.
```

An issue labeled `routine` runs on the cheap model with the default reasoning level of that model. An issue labeled `hard` runs on the strong model at `effort: high`. An issue with neither label runs on `<default-model-id>`. All three keep `permission_mode: bypassPermissions`, because the rules do not write it and so inherit it. A rule must have a `name` as soon as it carries a settings block.

The values are the runtime's to judge. Sortie passes `model` and `effort` through unchanged and does not check them against a list, so a misspelled model fails when the agent starts, not when the workflow loads. Which levels `effort` accepts depends on the model; each [agent adapter reference](/reference/workflow-config/#adapter-pass-through-configuration) names the flag the level rides on.

Two overlay behaviors matter when you build on this example:

- A key you write in a rule replaces the inherited value whole. A list such as `allowed_tools` is replaced, not extended.
- `null` removes an inherited key, so the agent kind falls back to its own default. Suppose the top-level block sets `effort: medium` and a rule sets only a cheaper `model`. The rule would ask the cheaper model for a level chosen for another one, and `sortie validate` warns with `agent.effort.inherited`. Write `effort: null` in the rule to clear the level, or write the level the cheaper model should use.

A rule that sends issues to a different agent kind carries that kind's whole block. With `agent: opencode` in a rule and an `opencode:` block under it, you need no top-level `opencode:` block.

The agent budgets and timeouts, such as `agent.max_tokens` and `agent.turn_timeout_ms`, stay workflow-wide and are not rule settings. See the [`dispatch` reference](/reference/workflow-config/#rule-settings-blocks) for the keys a rule's block cannot write.

### Confirm the routing

Run `sortie validate WORKFLOW.md`. It checks each rule's block with the same checks a top-level block gets and prefixes every message with the rule's name. Then start Sortie and read the dispatch record for a `routine` issue: it names the rule and the `model` and `effort` the session starts with. See [Monitor with logs](/guides/monitor-with-logs/#dispatch-and-agent-settings) for the record. To see which model each run used afterward, see [`sortie stats`](/reference/cli/#stats).

### Edit settings while Sortie runs

Sortie reads a rule's settings, like the top-level ones, at the start of every attempt: a first dispatch, a retry, or a reaction continuation. After you edit a model, the next attempt of every issue uses it, including issues that are already in flight. A session that is running keeps the settings it started with. An attempt whose settings fail validation does not start a session. A retry is scheduled again with backoff, and the first dispatch of an issue is skipped until you fix the file.

A resumed session keeps its session identifier when the model or level changes, and the new settings go with it.

## Route by issue title

`match.title` matches words in the issue title. Use it when teams mark issues with a prefix instead of a label, for example `[docs] Update install steps`:

```yaml
dispatch:
  rules:
    - name: docs-title
      match:
        title: ["[docs]", "docs:"]
      template: ./prompts/docs.md
```

Quote a phrase that starts with `[` or contains `: `. YAML reads `[docs]` unquoted as a list and `fix: typo` as a mapping. Sortie rejects the list and mapping forms and tells you which phrase to quote. Two forms slip through: `title: [docs]` loads as the plain word `docs`, and `title: fix: typo` fails with a front matter error.

The match works on whole words and ignores letter case:

- `[docs] Update install steps` and `[DOCS] Fix typo` match the first phrase.
- `Docs: rewrite the quick start` matches the second phrase.
- `Update the docsite` does not match, because `docs:` needs the colon and `docsite` is a different word.

A phrase is plain text, not a pattern. `*` and `?` match themselves, and there are no regular expressions. Text in Chinese, Japanese, Thai, Lao, Khmer, and Myanmar is matched character by character, because those scripts do not put spaces between words. The [`dispatch` reference](/reference/workflow-config/#title-phrases) lists the full rules.

`title` combines with the other keys like any match key. In one `match` block it is ANDed with them, so `match: { title: "[docs]", labels: ["bug"] }` runs only for `[docs]` issues that also carry the `bug` label. Across rules, the first match wins: put the `title` rule above a `labels` rule if a `[docs]` issue labeled `bug` should run the docs rule.

Sortie reads the title when the issue is first dispatched. Renaming the issue afterward does not move a claim that is already held to another rule. Anyone who can edit a title can steer an issue toward a rule, and on many trackers that includes the issue's author. Pair `title` with `labels` or `assignee` when the rule carries settings or a template that not every author should reach.

## Match on type, priority, identifier, or assignee

The `match` block accepts six keys: the five below and [`title`](#route-by-issue-title). A rule matches when every key present in its block matches (AND across keys). Within a single key, a list matches when any entry matches (OR within a key).

```yaml
dispatch:
  rules:
    - name: critical-backend
      match:
        labels: ["backend"]
        priority: { lte: 2 }     # priority 1 or 2 (most urgent)
      agent: claude-code
      template: ./prompts/critical.md

    - name: stories
      match:
        issue_type: ["Story", "Feature"]   # case-insensitive exact
      template: ./prompts/feature.md

    - name: frontend-keys
      match:
        identifier: ["FE-*"]     # glob against the issue key
      template: ./prompts/frontend.md
```

Two keys use glob matching, two use case-insensitive exact matching, and one takes a numeric predicate:

- `labels` and `identifier` use glob patterns (`*`, `?`, `[set]`).
- `issue_type` and `assignee` use case-insensitive equality. A glob like `Bug*` does not expand here.
- `priority` takes a predicate object with exactly one operator: `eq`, `in`, `lt`, `lte`, `gt`, or `gte`.

Priority is an integer where lower numbers are more urgent: priority 1 outranks priority 5. The predicate `{ lte: 2 }` matches the most urgent issues. An issue with no priority value never matches a priority predicate.

### Match keys depend on the tracker

Not every tracker supplies every field. Match on keys your tracker populates:

- **GitHub** supplies `labels`, `issue_type` (when the issue has a GitHub issue type set), `assignee`, and `identifier` (the issue number). GitHub issues have no priority, so a `priority` predicate never matches a GitHub issue.
- **Jira** supplies all five: `labels`, `issue_type`, `priority`, `assignee`, and `identifier` (the issue key, for example `ACME-123`).

Every tracker supplies a title, so `title` works everywhere. If a rule never fires, confirm the tracker actually provides the field it matches on.

## Set the fallback for unmatched issues

When no rule matches, Sortie resolves the agent and template through a fallback chain. Each field falls through independently:

1. The matched rule's `agent` or `template`.
2. `dispatch.default.agent` or `dispatch.default.template`.
3. The top-level `agent.kind`, and the WORKFLOW.md Markdown body for the template.

You have two ways to express a catch-all. Use `dispatch.default`:

```yaml
dispatch:
  rules:
    - name: bug-fix
      match: { labels: ["bug"] }
      template: ./prompts/bug.md
  default:
    agent: claude-code
    template: ./prompts/default.md
```

Or add a final rule with no `match` block, which matches every issue:

```yaml
dispatch:
  rules:
    - name: bug-fix
      match: { labels: ["bug"] }
      template: ./prompts/bug.md
    - name: catch-all          # no match block: matches everything
      template: ./prompts/default.md
```

A catch-all rule must come after every other rule that has no `stage`. A catch-all placed earlier makes those rules unreachable, and Sortie rejects that at load time. Rules with a `stage` label may follow it, because their label selects them first; see [Chain rules into stages](#chain-rules-into-stages).

## Chain rules into stages

A stage chain runs one issue through several rules in turn, each with its own agent kind, settings, and template, and moves the issue from one rule to the next after each successful run, with no person in between. For when a chain helps and when one rule is the better choice, see [Stage chains](/concepts/stage-chains/).

The example below is a two-stage chain. A `specify` stage writes a specification and a plan into a file, then an `implement` stage reads that file and writes the code.

### Write the chain

Give each stage a rule with a `name`, a `stage` label, and a template, and link the first rule to the second with `next`. Set `tracker.handoff_state`, the state the chain ends on:

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

claude-code:
  permission_mode: bypassPermissions

dispatch:
  rules:
    - name: specify
      stage: stage-specify       # the label that puts an issue on this stage
      next: implement            # where the issue goes after a successful run
      template: ./prompts/specify.md

    - name: implement
      stage: stage-implement     # no next: a successful run ends on review
      template: ./prompts/implement.md
---

Resolve {{ .issue.identifier }}: {{ .issue.title }}.
```

An issue labeled `stage-specify` runs `specify`. When that run succeeds, Sortie adds `stage-implement` to the issue, removes `stage-specify`, and writes no state, so the issue stays in `backlog` or `in-progress`. On the next poll tick `implement` runs in a new session. When `implement` succeeds, the issue moves to `review` like the end of any run without a chain, and your reactions take over from there.

A rule with `stage` is selected by its label, so it carries no `match` block. Pick labels that differ from every state name and from the labels Sortie applies for escalations and parking. On GitHub, where states are labels too, `stage-specify` must not be `backlog`, `review`, or any other state in the workflow; `sortie validate` reports a clash as `dispatch.stage.collision`.

Sortie adds and removes the stage labels with the tracker credential it already uses. Your tracker's adapter reference ([GitHub](/reference/adapter-github/), [GitLab](/reference/adapter-gitlab/), [Gitea](/reference/adapter-gitea/), [Jira](/reference/adapter-jira/), [Linear](/reference/adapter-linear/)) says what that credential needs and whether a label must exist before Sortie applies it.

### Hand the file from one stage to the next

Every run of an issue uses the same workspace directory, so a file the `specify` agent writes is still there when the `implement` agent starts. Sortie does not read or move the file. The two templates agree on its path, and the issue identifier in the path keeps issues apart.

`prompts/specify.md`:

```text
You are specifying {{ .issue.identifier }}: {{ .issue.title }}.

{{ .issue.description }}

Research the code this issue touches. Write a specification and a step-by-step implementation plan to specs/{{ .issue.identifier }}.md, relative to your working directory. Do not change any other file.
```

`prompts/implement.md`:

```text
You are implementing {{ .issue.identifier }}: {{ .issue.title }}.

{{ if .stage.previous }}The {{ .stage.previous }} stage wrote the specification and plan for this issue.{{ else }}A person placed this issue on the {{ .stage.current }} stage directly.{{ end }} Read specs/{{ .issue.identifier }}.md, relative to your working directory, and follow its plan.

Write the code and its tests. Do not edit the specification.
```

`.stage.previous` names the stage whose hop placed the issue here, and it is empty when a person applied the label, so the template can tell the agent which happened. `.stage.current` is the name of the staged rule that runs. Both render on every template, chained or not. The [`.stage` reference](/reference/workflow-config/#stage) lists its fields.

Two settings can make the file disappear or keep the chain from moving:

- `hooks.before_run` runs before every stage, while `hooks.after_create` runs only when the workspace is first created. A `before_run` script that deletes untracked files, such as `git clean -fdx`, deletes the specification before `implement` reads it.
- When the workspace is a Git work tree, write the file outside `.sortie/` and outside paths the repository ignores. Under the default `tracker.handoff_evidence: observed`, Sortie ignores those paths when it checks the workspace for work, and a run that made no commit and changed no other file is not a success: the stage is retried instead of advancing. See [handoff evidence](/reference/state-machine/#handoff-evidence).

### Extend the chain

A longer chain adds one rule per stage and links them with `next`; nothing else changes. Each stage can also carry its own agent kind or model settings, as in [Route issues to a cheaper or a stronger model](#route-issues-to-a-cheaper-or-a-stronger-model):

```yaml
dispatch:
  rules:
    - name: specify
      stage: stage-specify
      next: plan
      template: ./prompts/specify.md
      claude-code:
        model: <strong-model-id>

    - name: plan
      stage: stage-plan
      next: implement
      template: ./prompts/plan.md

    - name: implement
      stage: stage-implement
      next: test
      agent: codex
      template: ./prompts/implement.md
      codex: {}

    - name: test
      stage: stage-test
      template: ./prompts/test.md
```

The rule a `next` names must carry `stage`, but the first rule of a chain does not have to. To start the chain from a label your team already uses, replace `stage: stage-specify` with `match: { labels: ["feature"] }`. A person then labels the issue `feature` once, and Sortie applies the stage labels from there.

Every stage runs its own session, so an issue needs at least four sessions to get through this chain. `agent.max_sessions` and `agent.max_tokens` count every stage of the issue. If you set `agent.max_sessions`, make it at least the number of stages in the longest chain; `sortie validate` warns with `dispatch.next.max_sessions` when it is smaller.

### Place an issue on a stage or send it back

To start an issue at any stage, apply that stage's label and make sure the issue is in an active state. An issue labeled `stage-implement` skips `specify` and runs `implement`, whose template then takes the branch for a person-placed issue.

To send an issue back, for example from `review` to `specify` after reading the specification, remove `stage-implement`, apply `stage-specify`, and move the issue to an active state. Remove the old label: an issue that carries the labels of two stages of one chain runs the one further along the chain, and Sortie logs `several stage labels found`.

Change stage labels when no run is in progress on the issue. A run keeps the rule it started on until it ends, whatever labels you move during it, and when that run hops, the stage it hopped to runs next.

Sortie counts the hops it makes on an issue in a row and stops at `dispatch.max_consecutive_hops`. The count resets when the issue leaves the active states, which every chain does when it ends on the handoff state, and when Sortie parks the issue or a park on it is released. An issue you send back from `review` therefore starts from zero. Moving a stage label while the issue stays active does not reset the count. Leave `dispatch.max_consecutive_hops` unset: the default is the larger of `10` and the number of hops in your longest chain, so a healthy chain never reaches it, and a value below the longest chain's hops fails validation.

### Confirm the issue advanced

Run `sortie validate WORKFLOW.md`, start Sortie, and label a test issue `stage-specify`. After the `specify` run succeeds:

- The issue carries `stage-implement` instead of `stage-specify` and is still in its active state.
- The log has a `stage hop made` record with `source_rule=specify`, `target_rule=implement`, and the `hop_count`. Within one poll interval, the next run's `issue dispatched` record carries `rule_name=implement`.
- The dashboard's [run history](/reference/dashboard/#run-history-table) shows the rule, chain, and stage of each run, and [`sortie stats`](/reference/cli/#stats) groups runs by chain.

To be told about every hop, add `stage.advanced` and `stage.not_advanced` to the `events` list of a [notification entry](/reference/workflow-config/#event-catalog). No entry receives them unless it lists them.

## How rules resolve

Sortie picks one rule per dispatch, and the first of these that applies decides:

1. The stage the issue's latest hop sent it to, while the issue carries that stage's label.
2. A rule whose `stage` label the issue carries. When the issue carries the labels of several, the one furthest along its chain runs, then the one listed first.
3. The rules without `stage`, top to bottom: the first whose `match` block succeeds, or a catch-all.
4. `dispatch.default`, then the workflow-wide defaults, as in [Set the fallback for unmatched issues](#set-the-fallback-for-unmatched-issues).

So first match wins among the rules without `stage`, and no rule above a staged rule, a catch-all included, captures an issue that carries a stage label.

Sortie evaluates rules once, at the issue's first dispatch, and freezes the resolved agent kind, template, and rule name for the life of the claim. Retries and reaction-driven continuations (CI failure, review comments) reuse the frozen selection so the agent keeps the same prompt and session thread across turns. The settings are the exception: they are read from the current WORKFLOW.md at the start of every attempt, as described in [Edit settings while Sortie runs](#edit-settings-while-sortie-runs).

A changed rule set from a WORKFLOW.md reload applies to future claims only. An issue already in flight keeps its original agent, template, and rule until its claim is released. A stage hop releases the claim, so each stage of a chain is selected afresh, and a changed `next` applies from the next run that ends. A waiting retry keeps them too, unless the reload removed its agent kind or template; then it is routed afresh and starts a new session. See [Freeze and reload](/reference/workflow-config/#freeze-and-reload) for the details. A reload that moves `agent.kind` while a rule without its own `agent` still carries a block for the old kind is rejected, and Sortie keeps the last good configuration. For the dispatch and claim lifecycle, see the [state machine reference](/reference/state-machine/); for the architectural model, see [Architecture](/concepts/architecture/).

## Verify the rules

Check the configuration offline before starting the orchestrator:

```bash
sortie validate WORKFLOW.md
```

`validate` parses the dispatch block and reports rule errors: an unknown agent kind, a missing or unreadable template file, a duplicate rule name, a non-final catch-all, an unknown match key, a malformed glob, a priority predicate without exactly one operator, or a `title` with no phrase or an unquoted phrase. It also reports a settings block that names a kind the rule does not run, one that sets `command` or a timeout, and one on a rule with no `name`. It reports a registered agent kind that a rule routes to but that carries no settings block of its own, neither at the top level nor in every rule that selects it. For a stage chain it reports a `next` that names no rule or a rule without `stage`, a cycle of `next` links, a rule with both `stage` and `match`, a stage label shared by two rules or equal to a state name, `next` without `tracker.handoff_state`, and a `dispatch.max_consecutive_hops` below the longest chain's hops. It exits non-zero when any error is present.

Then run one poll cycle without spawning agents:

```bash
sortie --dry-run WORKFLOW.md
```

`--dry-run` fetches candidate issues and reports which of them would dispatch under your slot limits and blockers. It does not evaluate your rules, so it cannot show which rule an issue would match. To confirm the routing, start Sortie against a test project and read the dispatch record of the first issue each rule should catch; it names the rule, the agent kind, and the model and effort. See [Confirm the routing](#confirm-the-routing), and the [CLI reference](/reference/cli/) for both subcommands.

## Troubleshooting

**A rule never matches.** Confirm the tracker supplies the field. A `priority` predicate never matches a GitHub issue, because GitHub issues carry no priority. Confirm label spelling and case: labels are normalized to lowercase, so match patterns must be lowercase. Confirm `issue_type` and `assignee` values are exact, since those keys do not glob.

**Validation reports "unreachable rules".** A catch-all rule (one with no `match` block) sits before other rules. Move it to the end of the list, or replace it with a `dispatch.default` block.

**Validation rejects an unknown agent kind.** The `agent` value must name a registered adapter.

**Validation rejects a routed kind with no settings block.** A rule with `agent: codex` and no `codex:` block fails `sortie validate` with a `dispatch.agent.missing_block` error, because a session the rule routes reads only that block. Add the block, even an empty one (`codex: {}`), to fix it. See [Declare every agent kind a rule references](#declare-every-agent-kind-a-rule-references).

**Validation reports an `agent.command` error for a routed kind.** A rule routes to `agent-client-protocol` while another kind is the default. The message reads `dispatch.rules[0].agent selects agent kind "agent-client-protocol", which has no default command and launches agent.command only as the default agent kind`. Make `agent-client-protocol` the default kind with its own `agent.command`, or route the rule to a kind that has a default command.

**A match key is ignored or rejected.** Unknown match keys are configuration errors, not warnings, so a typo like `lables:` fails `validate` instead of silently disabling the rule. Use only `labels`, `issue_type`, `priority`, `identifier`, `assignee`, and `title`.

**A title rule never fires.** Check the quoting first: `title: [docs]` loads as the word `docs`, not the text `[docs]`. Then check that the phrase appears in the title as whole words. `fix` does not match `Fixes typo`, and `[infra]` does not match `Improve infra docs`, because punctuation in a phrase must appear in the title.

**Validation rejects a shared block call.** A template calls a block that no listed partial defines, for example a misspelled name. The message names the template file and the line of the call, and reads `calls template "issue-contex", which is not defined`. Correct the name, or list the partial that defines the block under `dispatch.partials`. The same fault stops Sortie from starting, and a running Sortie keeps its last good configuration. See [startup and configuration errors](/reference/errors/#startup-and-configuration-errors).

**Validation rejects a settings block.** The message names the rule and the field. A block must sit under the name of the kind the rule runs: its `agent`, else `dispatch.default.agent`, else `agent.kind`. Remove `command`, `kind`, and the timeout keys from it, give the rule a `name`, and write `{}` for an empty block.

**`sortie validate` warns about an inherited effort.** A rule sets `model` and inherits an `effort` from the top-level block, which was chosen for another model. Write `effort` in the rule, or `effort: null` to clear it.

**Validation rejects `next`.** `next requires tracker.handoff_state` means the workflow has no handoff state; set `tracker.handoff_state`, because the last stage and every hop that is not made end there. `names a rule without a stage label` means the rule `next` points to has no `stage`; add one. A cycle message lists the rules that loop; remove one of their `next` keys.

**Validation reports `dispatch.stage.collision`.** A stage label equals a state name, a reaction's escalation label, or the parking label. Rename the stage label; the message names what it collides with.

**A stage runs again instead of handing over.** A stage advances only after a successful run. A failed or timed-out run retries the same stage, and so does a run whose handoff evidence was withheld because it left the work tree unchanged, which logs `handoff withheld by evidence policy`. Check that the stage writes its file outside `.sortie/` and outside ignored paths, as in [Hand the file from one stage to the next](#hand-the-file-from-one-stage-to-the-next).

**The chain stops on the handoff state before its last stage.** A hop was due and was not made, and the issue took the handoff write instead. The `stage hop not made` log record says why in `reason`:

- `add_failed`: the tracker refused the next stage's label, and the record carries the `error`. Fix the credential or create the label, then replace the issue's current stage label with the next one and move the issue to an active state.
- `ceiling`: the issue made `dispatch.max_consecutive_hops` hops in a row without leaving the active states. Look for tracker automation or a person moving stage labels back while the issue stays active. The handoff reset the count, so the issue can go through the chain again.

**A hop leaves an old stage label on the issue.** Sortie logs `stage hop made, stage labels left on the issue` when it added the next label and failed to remove the old one. The chain still advances, because Sortie routes to the stage it hopped to. Remove the old label by hand.

**A rule change did not affect a running issue.** Rule selection is frozen at first dispatch. A reloaded rule set applies to future claims only. Let the in-flight issue finish, or release its claim, for the new rules to take effect. An edit to the settings inside a rule is different: it applies from the next attempt of the issue, but a session that is already running keeps the settings it started with.

## Dispatch rule fields

The `dispatch` block accepts a `rules` list, a `default` fallback for when nothing matches, and `max_consecutive_hops`, the ceiling on hops in a row. A rule with a `stage` label is selected by that label before any other rule; the rest are evaluated first-match-wins in YAML order. A rule's `next` names the staged rule an issue moves to after a successful run. Each rule pairs a `match` predicate (keys: `labels`, `issue_type`, `priority`, `identifier`, `assignee`, `title`), or a `stage` label, with the `agent` and `template` to use, falling through to `default` and then to the top-level `agent.kind` when a rule leaves them unset, and may carry a settings block for its agent kind that is laid over the kind's top-level block. The `priority` predicate takes exactly one numeric operator (`eq`, `in`, `lt`, `lte`, `gt`, `gte`).

For the complete field-by-field table, including every match key's matching rule, the overlay rules for a settings block, and every accepted operator, see the [`dispatch` section of the workflow config reference](/reference/workflow-config/#dispatch).

## Related guides

- [Stage chains](/concepts/stage-chains/): why a pipeline of agent steps runs as a chain of rules, and when one rule is enough
- [Write a prompt template](/guides/write-prompt-template/): template syntax and variables for per-rule files
- [Connect to Jira](/guides/connect-to-jira/): Jira adapter setup, which supplies priority and issue type
- [Connect to GitHub](/guides/connect-to-github/): GitHub adapter setup, label-based state mapping
- [Configure review feedback](/guides/configure-review-feedback/): reaction continuations reuse the frozen rule selection
- [Control agent costs](/guides/control-costs/): model and effort as cost levers
- [Monitor with logs](/guides/monitor-with-logs/): the dispatch record that names a run's rule, model, and effort
- [Workflow config reference](/reference/workflow-config/): every WORKFLOW.md field
- [State machine reference](/reference/state-machine/): claims, dispatch, and retry lifecycle
