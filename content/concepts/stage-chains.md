---
title: "Stage Chains"
description: "Why a pipeline of focused agent steps, such as specify then implement, beats one long prompt, and how Sortie hands an issue from one coding agent to the next without a person moving it."
author: Sortie AI
date: 2026-10-08
weight: 45
---
Ask one coding agent to research a problem, design a fix, write the code, and test it, all from one prompt, and you get one long session that does each of those jobs worse than it would do it alone. The research is shallow because the agent is eager to start coding. The design lives only in the agent's context, so nobody can review it before code exists. And the whole session runs on one model, whether the step in front of it needs careful reasoning or fast, cheap edits.

So many teams already run their agents as a pipeline. A common shape has two steps: "specify", where an agent studies the issue and writes a specification and a plan, then "implement", where another agent follows that plan and writes the code and tests. Others split the work finer, into specify, plan, implement, and test, each step its own prompt, each reading the file the step before it wrote. The single-prompt case exists, but it is rarely the one that produces the best work.

Until stage chains, Sortie could run every one of those steps, but it ended every successful run the same way: the issue moved to the handoff state and waited for a person. A four-step pipeline cost three trips by someone whose only job was to move a ticket and relabel it. No judgment happened on those trips. The issue sat idle until someone noticed it, and people were pulled into the loop at exactly the points where there was nothing to decide. Stage chains remove those trips. The issue moves from step to step by itself, and a person sees it when the last step is done, or when something stopped it.

This page explains the model behind a chain, why stages are labels rather than tracker states, what keeps a chain from running away, and when a single rule is still the better choice. For setup, see [how to configure dispatch rules](/guides/configure-dispatch-rules/).

## A stage is a dispatch rule

A [dispatch rule](/guides/configure-dispatch-rules/) already decides which agent, prompt template, and model work on an issue. A stage is a dispatch rule with two additions: a `stage` label that puts an issue on it, and a `next` key that names the rule to run after it succeeds.

```yaml
- name: specify
  stage: stage-specify
  next: implement
- name: implement
  stage: stage-implement
```

That is a chain. It can have two rules or ten, linked one to the next through `next`. The last rule has no `next` and ends the way every rule ended before chains existed, on `tracker.handoff_state`. The first rule does not need a stage label of its own; it can match an ordinary label such as `feature`, so the person who files the issue labels it once and the chain does the rest.

When a run of `specify` succeeds, Sortie makes a **hop**: it adds `stage-implement` to the issue, removes the other stage labels, and releases its claim on the issue. It writes no tracker state, so the issue stays in the active state it was in. On the next poll tick, the issue carries `stage-implement`, and the `implement` rule picks it up on a new claim, with its own agent, its own template, and its own model.

Think of the stage label as a routing slip clipped to the issue. Each station reads the slip, does its work, and writes the next station's name on it. The stations never talk to each other directly, and the slip is visible to anyone who looks at the issue.

### Fresh session, shared workspace

The next stage starts a fresh agent session. It does not resume the previous stage's conversation, because a session belongs to one agent and one prompt, and the next stage may run a different agent altogether. What carries over is the workspace. Sortie gives each issue [one workspace directory](/concepts/isolation/), named after the issue's identifier and reused by every run of that issue, so the specification `specify` wrote is on disk when `implement` starts.

Sortie never opens those files. Where a stage writes its output and where the next stage looks for it is a convention between your prompt templates, typically a path built from the issue identifier. Each render also tells the template which stage it is running and which stage, if any, handed the issue over, so a template can tell a hop from a person placing the issue by hand. The workspace is removed when the issue reaches a terminal state, or when an optional age limit reclaims it, so a file that must outlive the issue, such as a specification you want to keep, belongs in the repository the agent commits to.

## Why stages are labels, not tracker states

The obvious design is a tracker column per stage: "Specifying", "Implementing", "Testing". Sortie already moves issues between tracker states, so why not move them between these?

Because tracker states are the one place where the trackers Sortie supports disagree most. Some have native workflow states with a transition graph that can refuse a move between two states the team never connected. Others derive state from labels, which would make each stage one more entry in the list of active states. Dispatch rules cannot match a tracker state at all. And every dispatch already writes `tracker.in_progress_state` when that is configured, which would overwrite a stage state the moment the stage started. Labels have none of these problems. Every tracker Sortie supports can add and remove a label, and each adapter checks the issue's labels after the write before it reports success, so a hop behaves the same on Jira, Linear, GitHub, GitLab, Gitea, and the `file` tracker.

Labels also keep a chain inside the set of issues Sortie already works on. A staged issue stays in its active state from the first stage to the last. A hop changes which rule picks the issue up next; it does not decide whether the issue is active or done, so reconciliation, workspace cleanup, and per-state concurrency limits see a chain as one active issue. Sortie rejects a stage label that equals a tracker state name or a label it applies for another purpose, such as the parking label, so moving a stage can never double as a state change or an escalation.

Two other designs were weighed and set aside. Keeping the stage only in Sortie's database would avoid tracker writes entirely, but the stage would be invisible where your team works: nobody could see which stage an issue is on or move it without a new tool, and a database restore would lose every issue's position. Letting the agent advance the issue itself, through a tracker tool call, would put a routing decision in a probabilistic step that a crash or a timeout can skip. Sortie advances an issue only on a success it observed.

The practical payoff is that a stage is something a person can see and change with the gesture they already use. Applying a stage label puts an issue on that stage. Swapping it sends the issue to a different stage.

## Only success advances

A hop takes the place of exactly one exit: the one where a run finished normally and Sortie would otherwise move the issue to the handoff state. Every other outcome behaves as it did before chains.

A run whose agent reported `blocked` parks the issue. A failed, timed-out, or stalled run retries the same stage and never advances. An issue that someone closed while its run was finishing takes the terminal path. A run whose workspace shows no work when Sortie's handoff evidence check expects some is retried rather than handed off, and it does not advance either. A run that declared the requested outcome already held counts as a success and advances, and the next stage's template can see that the previous outcome was `no_change`.

When a hop is due and cannot be made, because the tracker refused the label or the issue reached the hop ceiling described below, the run falls back to the handoff write. The issue lands on `tracker.handoff_state` with its stage label unchanged, which is exactly where a person looks for work that needs attention. A hop whose label add succeeded but whose removal of the old label failed still advances, with a warning, and the routing picks the stage the hop sent the issue to.

A tracker's issue listing can lag behind a write. If the next poll trusted a listing that still showed the old label, it would run the previous stage again. So after a hop, Sortie routes the issue only on what it sees itself: a listing that shows the new label, or, when the listing lacks it, a direct read of the issue. If that direct read still finds the issue active, Sortie routes it by the labels the read returned, so a person who removed or swapped the stage label in the meantime gets their way. If the read fails, the issue waits for the next tick. The [state machine reference](/reference/state-machine/#candidate-eligibility) gives the exact rules.

## Why there is a hop ceiling

Before chains, the handoff write was what stopped a loop: a successful run moved the issue out of the active states, so the next tick could not pick it up again. A hop deliberately keeps the issue active. Something else has to stop a loop, and Sortie uses two guards.

The first runs whenever Sortie loads or reloads the workflow, before every tick's dispatch, and in `sortie validate`. Each rule names at most one `next`, and Sortie rejects `next` links that form a cycle, so every chain the configuration describes has an end.

The second guard exists because the configuration is not the only thing that moves labels. A person, a tracker automation, or another tool can put an issue back on an earlier stage, and a loop built that way is invisible to any check of the workflow file. So Sortie counts the consecutive hops it makes on each issue and stores the count in its database, where it survives a restart. A hop that would go past `dispatch.max_consecutive_hops` is not made, and the issue falls back to the handoff state. When the key is absent, the ceiling is the larger of 10 and the number of hops in the longest configured chain, so a healthy chain never reaches it.

The count resets when Sortie sees the issue outside the active states (after a handoff, in a terminal state, or in any other state a person moved it to) and when a park is placed on the issue or released. It does not reset when a stage label changes while the issue stays active. That is deliberate: a label moved by a person and a label moved by automation look the same to Sortie, and resetting on either would let automation rebuild the cycle the ceiling exists to stop.

The ceiling has a limit worth knowing. Automation that moves every handed-off issue back into an active state creates a loop that leaves and re-enters the active states, and the ceiling resets on each pass. That loop exists without chains too; a chain does not widen it. The per-issue budgets `agent.max_sessions` and `agent.max_tokens` sum every stage an issue passes through and bound it where you set them. `sortie validate` warns when `agent.max_sessions` is too small for the longest chain to finish.

## Stepping in

The controls for a chain are the ones you already have. Moving an issue out of the active states stops it: reconciliation stops a running agent, nothing is dispatched, and the hop count resets. Moving it back resumes on whatever stage label it carries. Removing the stage label sends it back to whichever rule matches it without one, which is the chain's entry rule when that rule matches an ordinary label. Applying a different stage label places it on that stage directly.

A label change on an issue whose claim is held re-routes nothing until the claim is released, because Sortie [freezes a rule's selection](/concepts/orchestration/) for the life of a claim. Each stage is its own claim, so the boundary between stages is where your change takes effect.

## Seeing where a chain went

A chain spreads one issue's work across several runs, so Sortie ties those runs together. Every run carries a chain identifier, and each run a hop leads to inherits the identifier of the run that made the hop. A run that reached a hop decision also records the stage it targeted and the result: `advanced`, `partial`, `failed`, or `ceiling`.

That record feeds three views. [`sortie stats`](/reference/cli/#stats) groups runs by chain, listing the chains in which a hop was due or made. The [dashboard's run history](/reference/dashboard/#run-history-table) shows each run's rule, chain, and stage path. And Sortie emits `stage.advanced` when it makes a hop and `stage.not_advanced`, with the reason, when a due hop is not made. Both are ordinary events in the [event catalog](/reference/workflow-config/#event-catalog): no destination receives them until you list them, and once you do, a tracker comment, a Slack channel, or a webhook can tell you where each issue moved and where one stopped.

## When a chain pays off

A chain earns its overhead when its stages differ. If specifying needs a strong reasoning model and implementing runs well on a cheaper one, a chain lets each stage use the model it needs. The same holds when stages need different agents, or prompts too different to merge without one of them suffering. A chain also pays off when the artifact between stages is worth having on its own: a specification a person can read, or a plan that later explains why the code looks the way it does.

One rule is better for small, uniform work. A typo fix or a dependency bump gains nothing from a separate planning step, and each stage costs a fresh session that has to load its context again, at least one poll interval between stages, and one more session against `agent.max_sessions`.

The design also accepts trade-offs you should plan around:

- Sortie does not check that a stage produced its file. A stage that cannot produce its output should report `blocked`, which parks the issue; a template that reads a previous stage's file should handle the file being absent.
- A stage has exactly one successor, and only success advances. There is no branch chosen by outcome and no edge back from a review stage to an implementation stage.
- Pull request reactions, such as CI feedback and review comments, attach to the last stage. A hop drops the reactions pending on the stage it leaves.
- An issue that carries several stage labels runs on the one furthest along its chain. It is a rule to learn, and Sortie logs a warning when it applies it.

For most teams already running a pipeline by hand, those costs are smaller than the trips a person makes today. Start with the two-stage shape, specify then implement, and add stages when a step clearly needs its own model or prompt.

## Further reading

- [How to configure dispatch rules](/guides/configure-dispatch-rules/) for setting up a chain, placing an issue on a stage, and sending it back
- [Workflow configuration reference](/reference/workflow-config/#dispatch) for the exact contract of `stage`, `next`, `dispatch.max_consecutive_hops`, and the stage data in prompt templates
- [Orchestration](/concepts/orchestration/) for the poll-dispatch-reconcile loop and the claim freeze a hop builds on
- [State machine reference](/reference/state-machine/) for where a hop sits among the worker exit paths
- [Workspace isolation](/concepts/isolation/) for the per-issue workspace that carries files between stages
