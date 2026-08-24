---
title: "How to Configure Dispatch Rules"
linkTitle: "Configure Dispatch Rules"
description: "Route issues to different agents and prompt templates by label, type, priority, identifier, or assignee using first-match-wins dispatch rules in WORKFLOW.md."
author: Sortie AI
date: 2026-05-27
weight: 95
url: /guides/configure-dispatch-rules/
---
By default, Sortie dispatches every issue with one agent (`agent.kind`) and one prompt template (the Markdown body of WORKFLOW.md). Dispatch rules change that: they route each issue to a specific agent, a specific template, or both, based on the issue's metadata. Use them when bug fixes need a different prompt than documentation tasks, when frontend and backend issues should go to different agents, or when high-priority work needs a more capable model. This guide shows you how to set up rules from zero, starting with a two-rule label split and adding the other match types as you need them.

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

When a rule's `agent` differs from the top-level `agent.kind`, give that kind its own configuration block in the front matter. The example above routes to `codex`, so it includes a `codex:` block. A routed session reads that block and no other, on every attempt of the session; the block named by `agent.kind` does not stand in for it. Leave the block out and the session still dispatches, on the adapter's own defaults, and neither `sortie validate` nor startup preflight says anything about it.

The shared `agent.*` settings (`max_turns`, `turn_timeout_ms`, `max_sessions`, concurrency caps) stay workflow-wide. Rules override the agent kind and the template only, not these budgets.

## Match on type, priority, identifier, or assignee

The `match` block accepts five keys. A rule matches when every key present in its block matches (AND across keys). Within a single key, a list matches when any entry matches (OR within a key).

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

If a rule never fires, confirm the tracker actually provides the field it matches on.

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

Sortie evaluates rules once, at the issue's first dispatch, and freezes the resolved `(agent, template)` for the life of the claim. Retries and reaction-driven continuations (CI failure, review comments) reuse the frozen selection so the agent keeps the same prompt and session thread across turns.

A changed rule set from a WORKFLOW.md reload applies to future claims only. An issue already in flight keeps its original agent and template until its claim is released. For the dispatch and claim lifecycle, see the [state machine reference](/reference/state-machine/); for the architectural model, see [Architecture](/concepts/architecture/).

## Verify the rules

Check the configuration offline before starting the orchestrator:

```bash
sortie validate WORKFLOW.md
```

`validate` parses the dispatch block and reports rule errors: an unknown agent kind, a missing or unreadable template file, a duplicate rule name, a non-final catch-all, an unknown match key, a malformed glob, or a priority predicate without exactly one operator. It exits non-zero when any error is present.

Then run one poll cycle without spawning agents:

```bash
sortie --dry-run WORKFLOW.md
```

`--dry-run` fetches candidate issues and resolves each one against your rules without launching an agent or writing to the database. The logs show the agent and template selected for each candidate, so you can confirm a `bug` issue routes one way and a `docs` issue another. See the [CLI reference](/reference/cli/) for both subcommands.

## Troubleshooting

**A rule never matches.** Confirm the tracker supplies the field. A `priority` predicate never matches a GitHub issue, because GitHub issues carry no priority. Confirm label spelling and case: labels are normalized to lowercase, so match patterns must be lowercase. Confirm `issue_type` and `assignee` values are exact, since those keys do not glob.

**Validation reports "unreachable rules".** A catch-all rule (one with no `match` block) sits before other rules. Move it to the end of the list, or replace it with a `dispatch.default` block.

**Validation rejects an unknown agent kind.** The `agent` value must name a registered adapter. Its configuration block is not required for validation to pass, but a session the rule routes reads only that block, so a rule with `agent: codex` and no `codex:` block runs on the adapter's defaults.

**A match key is ignored or rejected.** Unknown match keys are configuration errors, not warnings, so a typo like `lables:` fails `validate` instead of silently disabling the rule. Use only `labels`, `issue_type`, `priority`, `identifier`, and `assignee`.

**A rule change did not affect a running issue.** Rule selection is frozen at first dispatch. A reloaded rule set applies to future claims only. Let the in-flight issue finish, or release its claim, for the new rules to take effect.

## Dispatch rule fields

The `dispatch` block accepts a `rules` list, evaluated first-match-wins in YAML order, and a `default` fallback for when nothing matches. Each rule pairs a `match` predicate (keys: `labels`, `issue_type`, `priority`, `identifier`, `assignee`) with the `agent` and `template` to use, falling through to `default` and then to the top-level `agent.kind` when a rule leaves them unset. The `priority` predicate takes exactly one numeric operator (`eq`, `in`, `lt`, `lte`, `gt`, `gte`).

For the complete field-by-field table, including every match key's matching rule and every accepted operator, see the [`dispatch` section of the workflow config reference](/reference/workflow-config/#dispatch).

## Related guides

- [Write a prompt template](/guides/write-prompt-template/): template syntax and variables for per-rule files
- [Connect to Jira](/guides/connect-to-jira/): Jira adapter setup, which supplies priority and issue type
- [Connect to GitHub](/guides/connect-to-github/): GitHub adapter setup, label-based state mapping
- [Configure review feedback](/guides/configure-review-feedback/): reaction continuations reuse the frozen rule selection
- [Workflow config reference](/reference/workflow-config/): every WORKFLOW.md field
- [State machine reference](/reference/state-machine/): claims, dispatch, and retry lifecycle
