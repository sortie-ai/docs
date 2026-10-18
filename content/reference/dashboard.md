---
title: "Dashboard"
description: "Reference for the web dashboard of Sortie, an orchestrator for autonomous coding agents: its screens, issue peek, attention items, retry and acknowledge actions, live updates, keyboard shortcuts, and how token and cost figures are worded."
author: Sortie AI
date: 2026-04-26
weight: 50
url: /reference/dashboard/
---
The dashboard shows what Sortie is doing now and what it did before: which issues need a person, which agents run, how each issue moves toward a merged pull request, what finished runs used and cost, and whether Sortie itself is healthy. It is a web application served from inside the Sortie binary at `/ui/`, on the same port as the [JSON API](/reference/http-api/) and the [Prometheus metrics](/reference/prometheus-metrics/). It needs nothing else installed and loads nothing from other hosts: no CDN, no web fonts, no external services.

## Opening the dashboard

Sortie serves the dashboard whenever its HTTP server runs. The default address is `http://127.0.0.1:7678/`. Sortie answers `/` with a temporary redirect (`302 Found`) to `/ui/`, so either address opens the dashboard.

| Setting | Effect | Default |
|---|---|---|
| `--port`, `server.port` | TCP port of the HTTP server. `--port 0` turns the whole server off: no dashboard, no JSON API, no metrics. | `7678` |
| `--host`, `server.host` | Bind address. It must be an IP address, and `0.0.0.0` listens on every interface. | `127.0.0.1` |

A flag overrides the matching `server` key in WORKFLOW.md, and a change to either needs a restart. See the [`--port`](/reference/cli/#--port) and [`--host`](/reference/cli/#--host) flags and the [`server` extension](/reference/workflow-config/#server).

Every screen has its own address, so a link to an issue or to a filtered view can be bookmarked and shared, and the browser's Back button returns to the previous screen or filter.

| Screen | Address | Carried in the address |
|---|---|---|
| Overview | `/ui/` | `phase` and `rule` filters, the open peek (`peek`) |
| Pipeline | `/ui/pipeline` | `phase` and `rule` filters, the open peek (`peek`) |
| Issue page | `/ui/issues/<identifier>` | |
| Session view | `/ui/issues/<identifier>/sessions/<dispatch ID>` | |
| History | `/ui/history` | `issue`, `rule`, `status`, and `stage` filters |
| Analytics | `/ui/analytics` | `range`, and the sort of each breakdown table |
| Health | `/ui/health` | |
| Workflow | `/ui/workflow` | |

An address under `/ui/` that names no screen shows "This page does not exist." with an **Open Overview** button.

## Security

{{< callout type="warning" >}}
**The HTTP server has no authentication.** Anyone who can reach the port can open the dashboard and read every issue Sortie handles, its tracker and pull request links, its run history, the agent events of every retained run, and the workflow configuration in effect. The same visitor can acknowledge attention items, run a scheduled retry now, ask for a pull request check, and queue a tracker poll.

Sortie binds to `127.0.0.1` by default, so only the machine it runs on reaches it. Any deployment that others can reach, including one started with `--host 0.0.0.0`, must put the port behind a reverse proxy that authenticates or behind a VPN.
{{< /callout >}}

The server refuses a dashboard action that a browser sends from a page on another origin, so a web page you have open cannot press these buttons for you. A reverse proxy must pass on the browser's `Host` header unchanged, port included; see [cross-origin requests](/reference/http-api/#cross-origin-requests).

## Layout

### Side rail

The rail lists the screens in groups separated by a divider: **Overview**, **Pipeline**, **History**, and **Analytics**, then **Health** and **Workflow**. A **Filter** field above the list narrows it by name, and Enter opens the first match. The rail also shows the Sortie version, the [status card](#status-card), and these controls: **Commands** opens the [command palette](#command-palette), **Shortcuts** opens the shortcut sheet, and **Theme** opens the [theme menu](#themes).

**Overview** carries a count badge while items need attention. The badge is amber, and red while any open item is critical.

### Status card

The status card sits above the rail's controls and links to **Overview**. A dot and a headline give the one condition that applies, and the first row of the table wins when several apply.

| Headline | Applies when |
|---|---|
| **Degraded** | A health check fails. A line under the headline names the failing checks, such as "Tracker poll failing". |
| **N items need attention** | No check fails and at least one attention item is unacknowledged. |
| **All clear** | Neither of the above. |

A second line under the headline says how many agents run: "No agents running", "2 of 4 agents running", or, when only one agent may run at a time, "Agent running" or "Agent idle". Acknowledging an item removes it from the count but does not clear **Degraded**, which follows the failing check itself.

### Health banner

While a health check fails, a banner under the top bar names each failing check, the time it began failing, and the error it reported, with an **Open Health** link on every screen except **Health**. The checks are the WORKFLOW.md reload, the dispatch preflight, the tracker poll, the database check, and, when a source control provider is configured, the reads from that provider.

### Top bar

On screens 768 px wide and up, the top bar shows the date and time, or on an issue page or session view a breadcrumb that leads back to the screen the reader came from. At its right it shows the [live indicator](#live-updates) and a **Search or run a command** button that opens the command palette. Clock times throughout the dashboard use the browser's time zone.

### Browser tab

The tab title and icon carry the same condition as the status card. The title reads the condition ("All clear", "Needs attention", or "Degraded") followed by "Sortie", with the attention count in parentheses in front of it while any item needs attention. The icon is the Sortie mark, with a yellow dot for **Needs attention** and a red dot for **Degraded**. While live updates are paused, the title and icon stay as they were.

### Narrow screens

Below 768 px the rail gives way to a bar at the top of the page with the Sortie name, the condition ("All clear", "Needs attention" with its count, or "Degraded"), and a **Menu** button that opens the command palette, which reaches every screen. The top bar, with its clock and live indicator, is hidden, and so is the station header of **Pipeline**. The peek takes the full width. Keyboard shortcuts stay available, including `P` to pause.

### Themes

The theme is **System** (follows the operating system), **Light**, or **Dark**. The **Theme** menu in the rail foot names the current choice and sets it, the `T` key moves to the next choice in that order, and the palette has one command per choice. The choice is stored in the browser.

### Loading and failure states

Before the first answer the page body reads "Loading". When Sortie does not answer, it reads "Sortie is not answering. The dashboard keeps trying." A screen that fails to load, which happens in a tab opened before an upgrade, shows "This screen could not be shown." with **Reload** and **Open Overview** buttons.

## Overview

**Overview** answers: does anything need a person right now? The page opens with a headline sentence and a lede, then the blocks below.

![Overview with the headline "1 item needs attention", an attention item for a parked issue with Acknowledge and Open issue buttons, the active issues in dispatch order under lifecycle chips and the Rule menu, and an Ended today list with its tally line](/img/dashboard/overview.webp)

| Headline | Shown when |
|---|---|
| "Sortie is picking up its first issues." | No run is on record, an agent runs, and nothing needs attention. |
| "Sortie is degraded, and N more items need attention." or ", and nothing else needs attention." | A health check fails or a critical item is open. |
| "N items need attention." | At least one item is unacknowledged. |
| "Nothing needs attention." | None of the above. |

The lede under the headline says what else Sortie is doing, for example "Everything else is handled: 2 agents are running and 1 pull request is waiting on CI.". It counts running agents, pull requests waiting on reactions, scheduled retries, issues between stages, and acknowledged items that wait in **Active**, and reads "No agents are running." when there is nothing to count.

**Needs attention** lists the unacknowledged [attention items](#attention-items), critical first and then oldest. Each item shows its reason in bold, the issue title and key, why the item exists, what clears it, how long it has existed, and its buttons. A click outside the buttons opens the [peek](#issue-peek) of the item's issue.

While nothing needs attention, a calm line and a row of tiles take the place of the list, unless a health check fails or the first run is still to come. The calm line reads "Nothing is parked, held, escalated or stopped, and Sortie is healthy." Each tile links to the screen that explains its figure.

| Tile | Shows | Opens |
|---|---|---|
| **Agents running** | How many agents run, "of" the concurrency limit, and the longest running time | **Pipeline** |
| **Ended today** | How many issues ended today, split into merged, handed off, and done | **History** |
| **Last one ended** | When the newest ending happened, how long ago, and the issue title | The issue page |
| **Runs finished today** | How many runs finished today, split into succeeded and failed | **Analytics** |

**Active** lists every issue Sortie is working on or waiting for, in the order Sortie picked the issues up. Beside the heading it shows the issue count and a tally such as "2 retrying, 1 held", and a **List** and **Pipeline** switch that moves between this block and the [**Pipeline** screen](#pipeline) with the filters kept. Lifecycle chips filter the list, and the **Rule** menu filters by dispatch rule or stage.

| Chip | Issues in it |
|---|---|
| **Agent running** | An agent session is running. |
| **Waiting on PR** | Sortie watches the pull request for a reaction, and no reaction has escalated. |
| **Between stages** | A stage hop moved the issue to the next stage and that stage has not started. |
| **Retry scheduled** | A retry waits for its due time. |
| **Needs attention** | The issue is parked, held by a budget, or has an escalated reaction. |

A chip shows only while it has issues, and the whole row of chips shows only while more than one lifecycle is present. The **Rule** menu shows only when the workflow has dispatch rules. It lists the rules, grouped by stage chain, with a count each, and it has a search field. A filter that leaves nothing reads "No active issue matches these filters." with a **Show all** button.

Each row shows the issue title, a second line with the key, the rule (or the stage and its place in the chain, such as "implement, 2 of 3"), and the agent kind, then Sortie's sentence about the issue, and a time. The time counts down to the due time for a retry and counts up from the start of the current state for every other row. A running issue whose agent has sent no event for longer than usual carries a stall marker. A held issue whose item was acknowledged reads "Acknowledged at" with the time. A click opens the peek.

**Ended today** lists the issues that ended today and that Sortie no longer holds, newest ending first, each with its outcome, such as "Reached done", "Handed off to Review", or "Merged #1331", and the time. Beside the heading a tally line lists, for example, 2 issues ended, 23 runs finished, 7 succeeded, 16 failed, and 48.03M tokens with "(6 runs not measured)", plus stopped and cancelled counts when there are any and an estimated cost when `token_rates` is configured. A **History** link follows. The tally reads "No run finished today." when none did, and it is absent before the first run and while run history is unavailable ("Run history is not available.").

## Pipeline

**Pipeline** answers: where does each issue stand on its way from the tracker to the end of its pull request? It shows the same active issues as **Overview**, plus the issues that ended today, each as a lane across the stations of the workflow.

![Pipeline with a lane for each issue across the stations of the workflow, from Tracker and Agent through the pull request reaction stations under a PR loop bracket to End, a stage meter under the Agent station, and a legend below the lanes](/img/dashboard/pipeline.webp)

A line above the lanes names how many items need attention, links each affected issue, and links **Open Overview**. The **Active** header, the lifecycle chips, and the **Rule** menu work as on **Overview**, and the chips add **Ended today**.

The stations are fixed by the configuration, never by an issue, and they read left to right:

| Station | Present when |
|---|---|
| **Tracker** | Always. |
| **Agent** | Always. All agent work sits here, whichever stage the issue is on. |
| The handoff state, named as the tracker names it | `tracker.handoff_state` is set. |
| One station per configured pull request reaction: **CI fix**, **Review**, **Bot review**, **Conflicts**, **Merge**, **Merge completion**, **Label commands** | The matching [reaction](/reference/reactions/) is configured. |
| **End**, or the name of the terminal state | Any reaction is configured. |

A bracket labeled "PR loop" spans the reaction stations. The station header above the lanes counts the lanes standing at each station, and a station whose lane needs attention is drawn in the attention color. Each lane shows the issue title, key, route, and agent, Sortie's sentence, a state word ("Agent running", "Waiting", "Retry scheduled", "Needs attention", or "Ended today"), and the track with the issue's marker at its station and the time beside it. On an issue in a stage chain, a stage meter under the **Agent** station shows the stage and its place in the chain, such as "implement 2 of 3", while the issue stands at the agent. Elsewhere the meter shows how many stages are done.

A reaction station that the issue is not standing at reads from what the reaction did during the issue's current pass:

| Mark on the station | Meaning |
|---|---|
| Dashed circle, "a reaction waiting" | A reaction is pending there now. |
| X, "an escalated reaction" | The reaction escalated. |
| Check, "Sortie acted" | The reaction started work. On lanes and the issue page the station adds a count, such as "2 fixes" (or "runs" for label commands), for the reactions that count their work. |
| Dash, "nothing to act on" | Sortie watched the reaction and found nothing to act on. |
| Empty circle, "no record" | Sortie has no record of the reaction in this pass. It does not mean the reaction did not run. |

A legend under the lanes explains every mark in use. With more than 24 lanes the lanes compress to a dense form without counts or meter captions, and, while no lifecycle chip or rule is chosen, they group by station: one line per station lists the issue keys and expands with **Show lanes** and **Hide lanes**. A click on a lane opens the peek.

## Issue peek

The peek is a drawer that shows one issue over **Overview** or **Pipeline** without leaving the list. It opens from a click on a row or lane, or from `Space` on the selected row, and it has its own address, so it can be shared. While it is open the list holds still, and the live indicator reads "Holding still while you read". `J` and `K` move the peek to the neighboring issue, and `Esc`, `Space`, the **Close** button, or the browser's Back button close it. **Open page** opens the [issue page](#issue-page).

![The peek drawer open over Overview for an issue waiting on a retry, with its title, Sortie's sentence, its lane and stage meter, the Route, Agent, Sessions, and Tokens facts, What happens next, and the last runs under So far](/img/dashboard/issue-peek.webp)

| Part | Contents |
|---|---|
| Head | The issue key and its tracker state, **Open page**, and **Close**. |
| Summary | The issue title, Sortie's sentence about it, and its lane. |
| Buttons | **Acknowledge** for each open attention item, **Open live session** or **Last session**, **Open issue** (the tracker page), and the pull request button, such as **PR #1331**. |
| Facts | **Route** (the rule or stage and its place in the chain), **Agent** (kind and model), **This session** while one runs (turn, tokens, and estimated cost), **Sessions**, **Tokens** or **Spent**, and **Pull request** with its branch. |
| **What happens next** | What Sortie will do under each condition, such as "When retry 7 comes due". |
| **So far** | The last runs of the issue with their outcome, and a closing line with the issue's current sentence. |

An issue Sortie no longer knows reads "Sortie no longer knows" followed by its key. Showing an issue, in the peek or on its page, marks its attention items and its ending as [read](#unread-markers).

## Issue page

The issue page answers: what happened to this issue, what happens next, and what has it cost? It opens from the peek, from **History**, from the palette, and from the **Overview** tiles, and `Esc` returns to the screen it was opened from.

![Issue page of a finished issue with its breadcrumb, title, and sentence, a Pipeline card with every station passed, folded stage chapters, a Pull request chapter of run cards, and the Budget and Route panels in the margin](/img/dashboard/issue-page.webp)

The page opens with the issue's tracker state and type, its title, Sortie's sentence about it, and, for a running issue whose agent has been quiet, a stall notice. Buttons follow: **Open live session** or **Last session**, **Open issue**, and the pull request button. Under them a **Pipeline** card draws the issue's [lane](#pipeline) with the station names, with the stage meter and, at reaction stations, the counts. From 1280 px wide the story sits beside a margin of panels. Below that the margin follows the story.

The story is the issue's history, newest at the bottom, grouped into chapters.

- Each stage of a chain is a chapter named after its rule, and a stage that ran again reads "again". Work on the pull request, such as CI fixes and review fixes, forms chapters named "Pull request" with its number. Work outside a stage chain forms chapters named "Work".
- An issue in a stage chain opens with a summary of the stages done, the current stage with its place, such as "implement (2 of 3)", and the stages ahead. Its **All stages** button lists every stage with its time span. A stage that did not hop to the next reads "hop to" the target "not made" with the reason.
- Every chapter but the current one is folded to one line with its run count, time span, and outcome.
- Each run is a card with its number, its status, what started it ("CI fix", "Retry after an error", "Continuation", and so on), its time span and duration, its error when it failed, its turns, its tokens, its estimated cost when `token_rates` is configured, and a **Session timeline** link to the [session view](#session-view).
- The current chapter closes on Sortie's sentence about the issue. When older runs are not loaded, a line says how many are not listed, and **Show older runs** loads them.

The margin holds these panels, each only when it applies.

| Panel | Contents |
|---|---|
| Attention cards | Each item of the issue: reason, why, what clears it, **Open issue** or **Open pull request**, and **Acknowledge**, or "Acknowledged" with the time. |
| **Retry N** | While the issue waits for a retry: when it is **Due**, what it was **Started by**, the **Error**, and **Retry now**. |
| **What happens next** | The conditions and what Sortie does under each. |
| **Pull request #N** | The repository, branch, and head commit, then one line per watched reaction with its state, the time of its next check, how many fixes it has used of its limit, and **Check now**. A reaction's state reads "fixing", "checks failing", "checks passing", "comments arriving", "comments to answer", "conflict", "waiting", or "escalated". |
| **Budget** or **Budget and cost** | Meters for **Sessions** and **Tokens and cache reads** against the issue's limits, "No token budget" when none is set, and, with `token_rates`, the **Estimated cost** with its share for pull request fixes and for stage runs or the rule. |
| **Route** or **Agent** | **Entry rule**, **Stage** (with its place in the chain), and **Agent** (kind and model). |
| **Issue** | **Status**, **Type**, and **Labels**. |

A failed read of run history shows "Run history could not be read." above the story. An issue Sortie no longer knows reads "Sortie no longer knows" followed by its key.

## Session view

The session view answers: what is this agent doing, or what did it do? It shows one agent session of one issue, live while the session runs and from the stored events once it ends. It opens from a run card, from the **Open live session** and **Last session** buttons, from `O`, and from the palette. `Esc` returns to the issue page.

![Session view of a finished session with its facts line, an Events pane with turns and folded tool calls, a Tokens per turn chart, and the Usage, Session, and Sessions panels](/img/dashboard/agent-session.webp)

The page head shows the issue key and title, the heading "Session N of" the key, and a line of facts: agent kind, model, route, the reaction that started the session when a pull request fix did, the SSH host when one is used, its time span and duration, and its status, such as "Running, turn 3 of 20" or "Succeeded, 4 turns". A running session whose agent has sent no event for longer than usual shows a stall notice, and a running session with no stall timeout shows a notice that stall detection is off. A session that ended with an error shows why, with the agent's last message when it sent one.

**Events** is a scrolling pane with one line per event. Consecutive tool calls fold into one line such as "4 tool calls: Bash, 2 Read, Grep" with a count of failed calls, and the line expands to list them. A turn that ended reads "Turn N completed" with its tokens and duration. Events the dashboard no longer holds read as a count of events not retained, and a run with none reads "No events retained". The pane keeps the newest 1,000 events of the run. A finished session ends with its status, and the foot line counts its events.

A live session follows its newest event until the reader scrolls up. Then a **Jump to latest** button appears, with a count of new events, and the foot line reads "Live" with the time of the last event, and "following new events" while the pane follows. Pausing live updates holds the pane still and the foot line reads "Paused".

| Panel | Contents |
|---|---|
| **Tokens per turn** | A bar for each completed turn whose tokens are known, and for a live session whose agent reports usage as it happens, a bar for the turn in progress. A turn that ended without usage is listed in **Events** but has no bar. The panel appears once two completed turns have bars. |
| **Usage** | **Input**, **Output**, **Cache read**, **Cache write**, **Tokens** ("so far" while live), and **Est. cost**. A session whose agent reported no usage shows **Tokens** "not measured" alone. |
| **Session** | **Configured** model ("agent default" when none), **Reported model**, **Host** for SSH, **Workspace** while live, **Session ID**, **Workflow**, and **Stall timeout** while live. |
| **Sessions** | Every session of the issue, newest first, each linking to its view, when the issue has more than one. **Show older** loads earlier ones. |

An address that names no session reads "No such session". The [HTTP API](/reference/http-api/#get-apiv1runsdispatch_idevents-run-events) describes which events Sortie keeps and for how long.

## History

**History** answers: what finished, how did it end, and what did it use? It lists finished runs grouped by issue, the issue with the newest ending first, 20 issues at a time. **Show more issues** loads the next 20.

![History grouped by issue, with the Issue key field and the Rule, Run status, and Hop to filters above a table of runs with their status, rule, agent, duration, turns, tokens, and finish time](/img/dashboard/history.webp)

Filters sit above the table, and each is part of the address.

| Filter | Matches |
|---|---|
| **Issue key** | An issue whose identifier or display key equals the text exactly, case included. Enter applies it. |
| **Rule** | Runs of one dispatch rule, of `dispatch.default`, or of no rule. Shown when the workflow has dispatch rules. |
| **Run status** | **Succeeded**, **Failed**, **CI failed**, **Stopped for a person**, **Stopped at a budget**, or **Cancelled**. |
| **Hop to** | Runs that hopped to one stage. Shown when the workflow has stage chains. |

Each issue is a header row and its newest runs beneath it. The header shows the outcome mark, the issue title linking to the issue page, and a second line with the key, Sortie's sentence about the issue, its run count, its tokens, its cache reads when it has any, and its estimated cost when `token_rates` is configured. At the right it shows when the issue ended. **Show more runs** loads the issue's earlier runs.

| Column | Shows |
|---|---|
| **Status** | The run's status. |
| **Rule** | The dispatch rule, with the hop the run made, such as "Hop to make-pr: advanced". Shown when the workflow has rules. |
| **Agent** | The agent kind and the model. The tooltip names the configured model when the agent reported another. |
| **Duration** | From start to end. |
| **Turns** | Turns completed. |
| **Tokens** | Tokens without cache reads. The tooltip gives the cache reads. |
| **Est. cost** | The estimated cost. Shown when `token_rates` is configured. |
| **Finished** | When the run ended. |

With no run on record the screen reads "No run has finished yet." A filter that matches nothing reads "No finished run matches these filters." with a **Clear filters** button. Without run history the screen reads "Run history is not available.", and a failed read reads "Run history could not be read.".

## Analytics

**Analytics** answers: how do runs go over time, and where do they spend their effort? A **Range** control picks **24 hours**, **7 days** (the default), or **Since first run**, and a label states the start of the range. A range without a run reads "No run finished in this range." (or "No run has finished yet." for **Since first run**). Warnings about the report, such as a bad `token_rates` entry, appear above the figures.

![Analytics over 7 days with the success rate and summary figures, the Outcomes bar, a stage chain funnel table, and the By rule and By model breakdown tables](/img/dashboard/analytics.webp)

The summary opens with the success rate, large, and "N of M runs succeeded" under it. Beside it the figures run in one row.

| Figure | Shows |
|---|---|
| **Runs** | Finished runs, with failed, stopped, and cancelled counts. |
| **Issues** | Issues with a run in the range. |
| **Duration, succeeded runs** | The median, and the 95th percentile ("p50, p95"). Shown once a run succeeded. |
| **Turns per succeeded run** | The mean. Shown once a run succeeded. |
| **Tokens** | Tokens without cache reads, with "N runs not measured" or "every run measured". |
| **Cache reads** | Cache read tokens, when there are any. |
| **Estimated cost** | The estimated cost with the runs it leaves out. Shown when `token_rates` is configured. |

**Outcomes** is one bar that shows how the runs ended, with a legend and a count for each outcome that has runs: **Succeeded**, **Stopped for a person or budget**, **Cancelled**, and **Failed**. A tooltip gives a segment's count and share.

Each stage chain gets a table headed "Chain from" its entry rule, with a row per stage.

| Column | Counts |
|---|---|
| **#**, **Stage** | The stage's place and rule name, tagged **ENTRY** for an entry stage. |
| **Runs** | Finished runs of the rule, retries and pull request fixes included. |
| **Entered** | Passes through the stage, each counted once, with a bar. |
| **By label** | Passes that arrived by a stage label a person put on the issue. |
| **Advanced** | Passes that hopped to the next stage. On the last stage, passes that moved to the handoff state. |
| **Ceiling** | Hops refused by `dispatch.max_consecutive_hops`. |
| **Hop failed** | Hops that could not add the next stage's label. |
| **No hop** | Passes that ended without a hop being due. The tooltip gives the reasons. |
| **In stage** | Passes whose run is going or retrying now. |
| **Median** | The median time spent in the stage. |

The breakdowns follow, each a table sortable by any column header, 20 rows at a time with **Show more**, and with the sort kept in the address.

| Table | Groups runs by | Shown |
|---|---|---|
| **By rule** | Dispatch rule | The workflow has rules and the range holds a group besides the default. |
| **By model** | The model the agent reported, or the configured one when it reported none | It has a group. |
| **By agent** | Agent kind | It has a group. |
| **By run status** | Run status | It has a group. |
| **By retry trigger** | What caused a retry | It has a group. |
| **Why runs started** | What started a run: a poll, a retry, a stage hop, or a pull request reaction | It has a group. |

Each table has the columns **Runs** (with a bar), **Success** (with a bar, and **Share** in **By run status**), **Duration** (a mark from the median to the 95th percentile and the same range in text), **Mean turns**, **Tokens**, and **Est. cost** when `token_rates` is configured.

## Health

**Health** answers: is Sortie itself working? **Checks** lists one row per check, each with a mark, a sentence about the last result, and the error text when the check failed.

| Check | Reads |
|---|---|
| **Database** | Whether the SQLite state database is reachable. |
| **Dispatch preflight** | Whether the last poll tick passed preflight. While it fails, no new issue starts. |
| The WORKFLOW.md file, named as it is | When the file loaded last, or how many reloads in a row failed and which load is still in effect. |
| **Tracker poll** | The result of the last poll, in Sortie's sentence. |
| GitHub, GitLab, or Gitea | Whether the provider is reachable. Shown when Sortie has a source control provider configured. |

A failing row reads, for example, "3 ticks in a row failed since 14:02; last success at 13:58." A check that has not run yet reads "Not run yet." Beside the checks, **Poll loop** gives the **Interval**, **Last poll**, **Last good poll**, **Next poll**, and **Failures in a row**, and **Process** gives the **Version**, when Sortie **Started**, how many **Agents** run, and when the **Config loaded**. A Sortie that serves no health data reads "Sortie serves no health checks."

## Workflow

**Workflow** answers: what configuration is Sortie running? It shows the WORKFLOW.md in effect, under a line that gives the time of the load ("Loaded at 15:34."). When a newer edit failed to load, the line adds that no new issue starts until it does. A Sortie that serves no configuration reads "Sortie serves no configuration."

![Workflow with the Dispatch panel showing one stage chain, the Reactions table, and the Tracker, Agent, and Token rates panels](/img/dashboard/workflow.webp)

| Panel | Contents |
|---|---|
| **Dispatch** | Rules that belong to no chain, as a table of **Rule**, **Selected by**, and **Agent**. Each [stage chain](/concepts/stage-chains/) as a numbered list of stages with the agent each runs and how it is selected, ending on the handoff state or on the chain it joins. A line gives the limit on automatic hops in a row. Without rules the panel reads "No dispatch rules: every issue runs on" the agent kind. |
| **Reactions** | One row per configured [reaction](/reference/reactions/): **Kind**, **Limit** (fixes, fix runs, merge strategy, or target state), and **Escalation**. Without reactions it reads "No reactions: Sortie's part ends at" the handoff state. |
| **Tracker** | **Kind**, the **Active**, **In progress**, **Handoff**, **No change**, and **Terminal** states, and the **Poll** interval. |
| **Agent** | **Kind**, **Max turns**, **Stall timeout**, **Retry backoff**, **Concurrency** with any per-state limits, **Token budget**, **Session budget**, **Usage reporting** for each agent kind in use, and **SSH workers** with their per-host limit. |
| **Token rates** | The rate of each agent kind for **Input**, **Output**, **Cache read**, and **Cache write**, per million tokens. A kind without both **Input** and **Output** reads "Not priced without `input_per_mtok` and `output_per_mtok`." Without `token_rates` the panel reads "Not set: no cost is shown." |

**Usage reporting** reads "reports tokens", "reports none", or "not declared" for each kind. See [`token_rates`](/reference/workflow-config/#token_rates) and the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind).

## Attention items

An attention item is one thing that needs a person. Sortie derives the items from its own state, so an item exists exactly while its cause does. Each item has a reason, an explanation of why it exists, and a sentence on what clears it.

| Reason shown | Cause | Severity | Buttons | Clears when |
|---|---|---|---|---|
| "Parked: the agent needs a person" | The agent stopped because it cannot go on without a person, so Sortie parked the issue under a label. | Warning | **Acknowledge**, **Open issue** | A poll tick finds the label removed, or the issue left the state it was parked in. |
| "Parked: no evidence of work" | The issue's runs ended without evidence of work as many times in a row as `agent.max_consecutive_absences` allows. | Warning | **Acknowledge**, **Open issue** | The same as above. |
| "Session budget reached" or "Token budget reached" | The issue used its `agent.max_sessions` or `agent.max_tokens` ceiling. | Warning | **Acknowledge** | The ceiling is raised or removed (on the next poll tick), or the issue leaves the active tracker states. |
| "CI escalated on #N", "Review comments escalated on #N", "Bot review escalated on #N", "Merge conflict escalated on #N", "Auto-merge escalated on #N", "Merge completion escalated on #N" | A pull request reaction escalated. | Warning | **Acknowledge**, **Open pull request #N** (**Open issue** for merge completion) | The cause of the escalation is resolved, the pull request merges or closes, or the issue reaches a terminal state. The item's text states the rest for its reaction. |
| "<file> failed to load" | An edit of WORKFLOW.md did not load, so poll ticks dispatch nothing and the configuration that last loaded stays in effect. | Critical | **Acknowledge** | The file loads again. |
| "Dispatch preflight failed" | The preflight failed, so poll ticks dispatch nothing. | Critical | **Acknowledge** | A poll tick passes preflight. |

An item that has a tracker or pull request address gets a button that opens it in a new tab. Items without an issue, the two failing-check items at the end of the table, are not clickable and open no peek. Critical items sort first. Both critical causes are failing health checks, so the status card reads **Degraded** while the check keeps failing.

**Acknowledge** tells Sortie that a person has seen the item. The item leaves **Needs attention** and the count in the rail, the status card, the browser tab, and the headline. An acknowledged item does not disappear from view: the issue stays in **Active**, marked "Acknowledged at" with the time, and the issue page shows the item with the time it was acknowledged. Sortie stores the acknowledgement, so it survives a restart, and it ends together with its cause. An item that appears for a new cause, such as a second park of the same issue, is a new item and shows as unacknowledged.

### Unread markers

A dot marks each attention item and each **Ended today** row that has not been read. An item counts as read once its issue is shown in the peek or on its page, once it is acknowledged, and once its button opens the issue or pull request. **Mark everything read** (`Shift` and `U`, or the palette) marks every item and every ending loaded for today. Read state belongs to the browser, so another browser starts unread. A dot never changes the attention count.

## Actions

These actions change what Sortie does. Each answers with a short message at the bottom of the screen that states the answer Sortie gave, such as "Retry 7 of sortie-ai/sortie#1363 is due now." When Sortie does not answer, the message reads "Sortie did not answer. Nothing changed." During shutdown it reads that nothing was queued or acknowledged. The [HTTP API](/reference/http-api/) documents the routes behind them.

| Action | Where it is offered | What it changes |
|---|---|---|
| **Acknowledge** | On every unacknowledged attention item: **Overview**, the peek, and the issue page. `E` acknowledges the selected item. | Records that a person saw the item, as [described above](#attention-items). An item that cleared in the meantime reads "This item cleared before it was acknowledged." See [POST /api/v1/attention/{id}/acknowledge](/reference/http-api/#post-apiv1attentionidacknowledge-acknowledge-an-attention-item). |
| **Retry now** | On the issue page, in the **Retry N** panel of an issue that waits for a scheduled retry. It is disabled once the retry is due. | Makes the scheduled retry due at once instead of at its due time. The retry then goes through the same checks as a retry that came due by itself: a free slot under the concurrency limits, the issue's session and token budgets, and the issue's tracker state. A retry that fails one of them is rescheduled or released as usual. See [POST /api/v1/retries/{identifier}/run](/reference/http-api/#post-apiv1retriesidentifierrun-run-a-scheduled-retry-now). |
| **Check now** | On the issue page, beside each watched reaction in the **Pull request** panel. | Moves the reaction's next check to the next poll tick instead of its scheduled time, so the answer reads "queued for the next poll tick". It does not run the check on the spot. See [POST /api/v1/reactions/{identifier}/{kind}/check](/reference/http-api/#post-apiv1reactionsidentifierkindcheck-check-a-pending-reaction-now). |

Other commands act on Sortie as a whole: **Refresh now** and **Pause live updates**, described under [live updates](#live-updates). The `A` key, **Run the item's action** on the shortcut sheet, opens the item's tracker or pull request address in a new tab, or acknowledges an item that has no address.

## Live updates

The dashboard holds a connection to Sortie's [change stream](/reference/http-api/#get-apiv1events-change-signals-and-agent-events). When Sortie reports a change, the dashboard rereads what the open screen shows. No timer reloads the page. **History** rereads at most once every 5 seconds and **Analytics** at most once every 30 seconds, however often changes arrive. A session view also receives the events of the session it shows over the same connection.

**Refresh now** (`R`, or the palette) asks Sortie to poll the tracker now, and the message reads "Tracker poll and reconciliation queued." or says that a poll was already queued. **Pause** (`P`, the palette, or the live indicator) holds the screens still, and resuming applies what changed in the meantime. While paused, the title and icon of the tab stay as they were and a session view stops adding events.

The live indicator at the right of the top bar says how fresh the screen is. When several rows apply, the first one wins.

| Indicator | Means |
|---|---|
| **Paused**, "press P to resume" | Live updates are paused. |
| **Holding still while you read** | A peek is open over **Overview** or **Pipeline**, and the list holds still. |
| **Reconnecting** | The change stream is not open. The dashboard reopens it with growing delays of up to 30 seconds, and reopens it after 45 seconds of silence. |
| **Not updating**, "last update" with a time | The dashboard could not read Sortie's state. |
| **Poll failing**, "next try" with a time | The stream is open, but the last tracker poll failed. |
| **Live**, "next poll in" a time | The stream is open and the last poll succeeded. The detail is absent when no poll is scheduled. |

When the version of the running Sortie differs from the version the open tab first saw, a message that stays until dismissed reads "Sortie" and the new version, then "is running. Reload to update the dashboard.", with a **Reload** button.

## How the screens follow the workflow

The dashboard shows only what the workflow configures. Every row below changes with the matching part of WORKFLOW.md.

| Configured | What the dashboard shows |
|---|---|
| No [dispatch rules](/reference/workflow-config/#dispatch) | No **Rule** menu, no **Rule** column or filter in **History**, no **By rule** table. Issues run on the default agent. |
| Dispatch rules | The **Rule** menu on **Overview** and **Pipeline**, the rule on each row and run, the **Rule** filter and column in **History**, and **By rule** in **Analytics**, which stays hidden while every run used the default. |
| [Stage chains](/concepts/stage-chains/) | The rule menu grouped by chain, the stage and its place on rows ("implement, 2 of 3"), the stage meter on lanes, the "stages done" legend entry, the stage summary and stage chapters on the issue page, the **Hop to** filter in **History**, one funnel table per chain in **Analytics**, and the chains in **Workflow**. |
| Pull request [reactions](/reference/reactions/) | One station per reaction on **Pipeline** and the issue page, the **Waiting on PR** chip, the pull request chapters and the **Pull request** panel with **Check now**, escalations as attention items, and the **Reactions** panel in **Workflow**. Without reactions the lane ends at the handoff state. |
| `token_rates` | The **Est. cost** column in **History** and **Analytics**, the **Estimated cost** figure, the cost in run cards, the peek, the **Budget and cost** panel, and the **Ended today** tally. Without `token_rates` none of these appears, and the **Est. cost** row of a session view whose tokens were measured reads "unpriced". |
| An agent kind that [reports no token usage](/reference/workflow-config/#usage-reporting-by-agent-kind) | "not measured" in place of its tokens and cost on every screen, "reports none" under **Usage reporting** in **Workflow**, and a **Tokens** line of "not measured" in the session view. |
| `agent.max_sessions` or `agent.max_tokens` | The budget meters on the issue page, the budget attention items, and the **Session budget** and **Token budget** lines in **Workflow**. See [how to control agent costs](/guides/control-costs/). |

## How figures are written

Costs are estimates, built from the rates in `token_rates`, and the dashboard says so with the words "estimated", "est.", and "Estimated cost". Token figures leave out cache reads, which the dashboard shows separately where it has them. `agent.max_tokens` still counts cache reads, which is why the budget meter reads **Tokens and cache reads**. Durations use at most two units ("1h 17m"), tokens read as "830K" or "48.03M", costs read with two decimals below $100 and as whole dollars from $100, and a share strictly between 0 and 100 percent never rounds to either end.

A figure Sortie does not have is never written as zero.

| Wording | Means |
|---|---|
| "not measured" | The agent reported no token usage for the run, or none has arrived yet. It stands for a token figure and for a cost that depends on one. |
| "unpriced" | The tokens are known but `token_rates` has no complete rate for the run's agent kind. The tally reads "cost unpriced". |
| "not recorded" | Sortie's run history does not hold the figure, or has no value for it, as for **Mean turns** of a group with no turn count. The tally reads "tokens not recorded". |
| "not reported" | The agent named no model, as in **Reported model**. In the budget panel, "No token budget: tokens not reported." |
| "N runs not measured" and "N runs unpriced" | A total that leaves those runs out. The tally reads "(N runs not measured)" and "(N runs unpriced)". |
| "every run measured" | A token total with no run left out. |
| "at least" | A held token budget whose figure is a lower bound because part of the issue's spend was not measured, as in "used at least 4.2M tokens and cache reads of its budget". |
| "unknown" | A time, duration, or cost the dashboard cannot state. |

## Keyboard shortcuts and command palette

`?` opens the shortcut sheet, which lists the keys that act on the current screen. Keys are ignored while the cursor is in a text field and while `Ctrl`, `Alt`, or `Cmd` is held, except for the palette key. Keys that activate a focused button or link keep that job.

### Global shortcuts

| Keys | Action |
|---|---|
| `R` | Refresh now |
| `P` | Pause or resume live updates |
| `Shift` `U` | Mark everything read |
| `T` | Next theme |
| `G`, then `O`, `P`, `H`, `A`, `E`, or `W` | Go to **Overview**, **Pipeline**, **History**, **Analytics**, **Health**, or **Workflow** |
| `?` | Keyboard shortcuts |
| `Ctrl` `K` (`Cmd` `K` on macOS) | Command palette |
| `Esc` | Close, go back |

The go-to sequence is `G` followed by the letter within 1.2 seconds. `Esc` closes the peek first. On an issue page it returns to the screen the page was opened from, and on a session view it returns to the issue page.

### Overview shortcuts

| Keys | Action |
|---|---|
| `J`, `K` (or `Down`, `Up`) | Select the next or previous item, across **Needs attention**, **Active**, and **Ended today** |
| `Space` | Peek the selected issue |
| `Enter` | Open the issue page |
| `O` | Open the latest session |
| `A` | Run the item's action |
| `E` | Acknowledge the item |
| `L` | Switch to **Pipeline** |

### Pipeline shortcuts

| Keys | Action |
|---|---|
| `J`, `K` (or `Down`, `Up`) | Select the next or previous lane |
| `Space` | Peek the selected issue |
| `Enter` | Open the issue page |
| `O` | Open the latest session |
| `A` | Run the peeked issue's action |
| `E` | Acknowledge the peeked issue's item |
| `L` | Switch to **Overview** |

### Issue page shortcuts

| Keys | Action |
|---|---|
| `O` | Open the latest session |

"The latest session" is the running session when there is one, and otherwise the issue's newest session. On **Overview**, `A` and `E` act on the selected item, or on the peeked issue's item while a peek is open.

### Command palette

`Ctrl` `K` or `Cmd` `K` opens the palette from any screen, and so do the **Commands** button in the rail, the **Search or run a command** button in the top bar, and the **Menu** button on narrow screens. It has a search field and lists the commands, each with its key.

| Command | Key |
|---|---|
| **Go to** each screen | `G` and the screen's letter |
| **Refresh now** | `R` |
| **Pause live updates** or **Resume live updates** | `P` |
| **Mark everything read** | `Shift` `U` |
| **Theme: System**, **Theme: Light**, **Theme: Dark** | `T` |
| **Keyboard shortcuts** | `?` |

Typing narrows the commands and adds the groups below. **Issues** lists active issues whose key or title contains the text (the first 8), then finished issues from run history that match by key or title (up to 5 more). **Sessions** lists the live sessions of matching running issues, named "key live session", and the finished sessions of the issues found, named "key session N" with the route, status, and start time (up to 8 in all). Choosing an issue opens its page, and choosing a session opens its view. A search with no match reads "Nothing matches" and the text, and a failed history lookup reads "Run history could not be read."

![Command palette listing the go-to commands for each screen, Refresh now, Pause live updates, Mark everything read, the theme commands, and Keyboard shortcuts, each with its key](/img/dashboard/command-palette.webp)
