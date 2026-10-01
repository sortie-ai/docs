---
title: "How to Configure Dispatch Rules"
linkTitle: "Configure Dispatch Rules"
description: "Route issues to different agents, models, reasoning levels, and prompt templates by label, type, priority, identifier, assignee, or title using first-match-wins dispatch rules in WORKFLOW.md."
author: Sortie AI
date: 2026-05-27
weight: 95
url: /guides/configure-dispatch-rules/
---
By default, Sortie dispatches every issue with one agent (`agent.kind`) and one prompt template (the Markdown body of WORKFLOW.md). Dispatch rules change that: they route each issue to a specific agent, a specific template, specific agent settings such as the model and reasoning level, or any combination, based on the issue's metadata. Use them when bug fixes need a different prompt than documentation tasks, when frontend and backend issues should go to different agents, or when routine work belongs on a cheaper model and hard work on a stronger one. This guide shows you how to set up rules from zero, starting with a two-rule label split, then routing by model and by title, and adding the other match types as you need them.

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

A catch-all rule must be the last entry. A catch-all placed earlier makes the rules after it unreachable, and Sortie rejects that at load time.

## How rules resolve

Sortie evaluates rules once, at the issue's first dispatch, and freezes the resolved agent kind, template, and rule name for the life of the claim. Retries and reaction-driven continuations (CI failure, review comments) reuse the frozen selection so the agent keeps the same prompt and session thread across turns. The settings are the exception: they are read from the current WORKFLOW.md at the start of every attempt, as described in [Edit settings while Sortie runs](#edit-settings-while-sortie-runs).

A changed rule set from a WORKFLOW.md reload applies to future claims only. An issue already in flight keeps its original agent, template, and rule until its claim is released. A waiting retry keeps them too, unless the reload removed its agent kind or template; then it is routed afresh and starts a new session. See [Freeze and reload](/reference/workflow-config/#freeze-and-reload) for the details. A reload that moves `agent.kind` while a rule without its own `agent` still carries a block for the old kind is rejected, and Sortie keeps the last good configuration. For the dispatch and claim lifecycle, see the [state machine reference](/reference/state-machine/); for the architectural model, see [Architecture](/concepts/architecture/).

## Verify the rules

Check the configuration offline before starting the orchestrator:

```bash
sortie validate WORKFLOW.md
```

`validate` parses the dispatch block and reports rule errors: an unknown agent kind, a missing or unreadable template file, a duplicate rule name, a non-final catch-all, an unknown match key, a malformed glob, a priority predicate without exactly one operator, or a `title` with no phrase or an unquoted phrase. It also reports a settings block that names a kind the rule does not run, one that sets `command` or a timeout, and one on a rule with no `name`. It reports a registered agent kind that a rule routes to but that carries no settings block of its own, neither at the top level nor in every rule that selects it. It exits non-zero when any error is present.

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

**Validation rejects a settings block.** The message names the rule and the field. A block must sit under the name of the kind the rule runs: its `agent`, else `dispatch.default.agent`, else `agent.kind`. Remove `command`, `kind`, and the timeout keys from it, give the rule a `name`, and write `{}` for an empty block.

**`sortie validate` warns about an inherited effort.** A rule sets `model` and inherits an `effort` from the top-level block, which was chosen for another model. Write `effort` in the rule, or `effort: null` to clear it.

**A rule change did not affect a running issue.** Rule selection is frozen at first dispatch. A reloaded rule set applies to future claims only. Let the in-flight issue finish, or release its claim, for the new rules to take effect. An edit to the settings inside a rule is different: it applies from the next attempt of the issue, but a session that is already running keeps the settings it started with.

## Dispatch rule fields

The `dispatch` block accepts a `rules` list, evaluated first-match-wins in YAML order, and a `default` fallback for when nothing matches. Each rule pairs a `match` predicate (keys: `labels`, `issue_type`, `priority`, `identifier`, `assignee`, `title`) with the `agent` and `template` to use, falling through to `default` and then to the top-level `agent.kind` when a rule leaves them unset, and may carry a settings block for its agent kind that is laid over the kind's top-level block. The `priority` predicate takes exactly one numeric operator (`eq`, `in`, `lt`, `lte`, `gt`, `gte`).

For the complete field-by-field table, including every match key's matching rule, the overlay rules for a settings block, and every accepted operator, see the [`dispatch` section of the workflow config reference](/reference/workflow-config/#dispatch).

## Related guides

- [Write a prompt template](/guides/write-prompt-template/): template syntax and variables for per-rule files
- [Connect to Jira](/guides/connect-to-jira/): Jira adapter setup, which supplies priority and issue type
- [Connect to GitHub](/guides/connect-to-github/): GitHub adapter setup, label-based state mapping
- [Configure review feedback](/guides/configure-review-feedback/): reaction continuations reuse the frozen rule selection
- [Control agent costs](/guides/control-costs/): model and effort as cost levers
- [Monitor with logs](/guides/monitor-with-logs/): the dispatch record that names a run's rule, model, and effort
- [Workflow config reference](/reference/workflow-config/): every WORKFLOW.md field
- [State machine reference](/reference/state-machine/): claims, dispatch, and retry lifecycle
