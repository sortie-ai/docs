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
| History | `/ui/history` | `issue`, `rule`, `status`, and `stage` filters, the [units](#tokens-and-cost-switch) (`units`) |
| Analytics | `/ui/analytics` | `range`, the sort of each breakdown table, the [units](#tokens-and-cost-switch) (`units`) |
| Health | `/ui/health` | |
| Workflow | `/ui/workflow` | |
| Prices | `/ui/prices` | The sort of the **Models** table (`sort`) |

An address under `/ui/` that names no screen shows the title "This page does not exist", a line that names the address, and an **Open Overview** button.

## Security

{{< callout type="warning" >}}
**The HTTP server has no authentication.** Anyone who can reach the port can open the dashboard and read every issue Sortie handles, its tracker and pull request links, its run history, the agent events of every retained run, and the workflow configuration in effect. The same visitor can acknowledge attention items, run a scheduled retry now, ask for a pull request check, and queue a tracker poll.

Sortie binds to `127.0.0.1` by default, so only the machine it runs on reaches it. Any deployment that others can reach, including one started with `--host 0.0.0.0`, must put the port behind a reverse proxy that authenticates or behind a VPN.
{{< /callout >}}

The server refuses a dashboard action that a browser sends from a page on another origin, so a web page you have open cannot press these buttons for you. A reverse proxy must pass on the browser's `Host` header unchanged, port included; see [cross-origin requests](/reference/http-api/#cross-origin-requests).

## Layout

### Side rail

The rail starts with the Sortie logo and name, which link to **Overview**, and the Sortie version. The project the workflow tracks stands under them, then the [status card](#status-card), then the screens in groups separated by a divider: **Overview**, **Pipeline**, **History**, and **Analytics**, then **Health**, **Workflow**, and **Prices**. The foot of the rail links to the Sortie home page, the documentation, and the GitHub repository, each in a new tab. On an issue page or a session view, the screen the reader came from keeps an outline in the list.

**Overview** carries a count badge while items need attention. The badge is amber, and red while any open item is critical.

The project sits on its own line under the Sortie name. It is the value of [`tracker.project`](/reference/workflow-config/#tracker), such as `sortie-ai/sortie` for a GitHub tracker or a Jira project key, cut to the width of the rail with the whole value on hover. The line is absent while the workflow sets no project. While the state API serves the project's web address as `config.tracker.project_url`, the name links to that address in a new tab; otherwise it is plain text. The same project shows in the [browser tab](#browser-tab) and in the **Tracker** panel of [**Workflow**](#workflow), so the tabs of different Sortie instances can be told apart. See [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state) for when the address is served.

### Status card

The status card sits in the rail under the project and above the list of screens, and links to **Overview**. A dot and a headline give the one condition that applies, and the first row of the table wins when several apply.

| Headline | Applies when |
|---|---|
| **Degraded** | A health check fails. A line under the headline names the failing check, such as "Tracker poll failing", or counts them, as in "2 checks failing", when several fail. |
| **N items need attention** | No check fails and at least one attention item is unacknowledged. |
| **N acknowledged** | No check fails, every attention item is acknowledged, and at least one still stands. The dot is muted. |
| **All clear** | None of the above. |

Under the headline a bar draws one segment for each agent the concurrency limit allows, filled while an agent runs, and a line says how many agents run: "No agents running", "2 of 4 agents running", or, when only one agent may run at a time, "Agent running" or "Agent idle". While the card reads **Degraded**, the failing checks take the place of that line. Acknowledging an item removes it from the count of items that need attention, but the card reads **N acknowledged** rather than **All clear** while the item stands. It does not clear **Degraded**, which follows the failing check itself.

### Health banner

While a health check fails, a banner under the top bar names each failing check, the time it began failing, and the error it reported, with an **Open Health** link on every screen except **Health**. The checks are the WORKFLOW.md reload, the dispatch preflight, the tracker poll, the database check, and, when a source control provider is configured, the reads from that provider.

### Top bar

On screens 768 px wide and up, the top bar holds a **Search or run a command** button that opens the [command palette](#command-palette). At its right it shows how many agents run against the concurrency limit, as "Agents 2/4" (from 1024 px wide), the [live indicator](#live-updates), a **Shortcuts** button that opens the shortcut sheet, and the **Theme** button that opens the [theme menu](#themes).

### Screen header

Every screen opens with a header: the screen's title, a standfirst under it that says in a sentence what the screen shows now, and at the end of the title line the controls that act on the whole screen, such as the range menu of [**Analytics**](#analytics) and the buttons of an [issue page](#issue-page). The sections of a screen are panels, each with its own title. On an issue page and a session view, a breadcrumb above the title leads back to the screen the reader came from and names the issue, as in "Overview / PROJ-12 / Session 2". Clock times throughout the dashboard use the browser's time zone.

### Tokens and Cost switch

**History** and **Analytics** show either tokens or estimated cost, one at a time. A switch with the options **Tokens** and **Cost** at the end of the title line chooses which, and **Cost** is the default. The choice is stored in the browser and holds for both screens. An address with `units=tokens` or `units=cost` opens the screen in that view without changing the stored choice, and a link inside the dashboard carries the `units` of the current address to the page it opens. While no rate source is available (see [how the screens follow the workflow](#how-the-screens-follow-the-workflow)), the switch is absent and both screens show tokens. On **Analytics** the switch appears once the first report has loaded. The other screens show tokens and cost side by side and have no switch.

### Browser tab

The tab title and icon carry the same condition as the status card. The title reads the condition ("All clear", "Waiting on a person" for **N acknowledged**, "Needs attention", or "Degraded"), a hyphen, the tracked project and another hyphen while the workflow sets one, and "Sortie", with the attention count in parentheses in front of it while any item needs attention. A tab can read "(2) Needs attention - sortie-ai/sortie - Sortie". Before the first answer the title is "Sortie". The icon is the Sortie mark, with a yellow dot for **Needs attention** and a red dot for **Degraded**. **All clear** and **N acknowledged** carry no dot. While live updates are paused, the title and icon stay as they were.

### Narrow screens

Below 768 px the rail gives way to a bar at the top of the page with the Sortie logo, the condition ("All clear", "N acknowledged", "N items need attention", or "Degraded"), and a **Menu** button that opens the command palette, which reaches every screen. The bar does not name the project. The top bar, with its search button, agent count, live indicator, and theme button, is hidden, and so are the breadcrumb and the station header of **Pipeline**. The peek takes the full width. Keyboard shortcuts stay available, including `P` to pause.

### Themes

The theme is **System** (follows the operating system), **Light**, or **Dark**. The **Theme** menu at the right of the top bar shows the current choice as an icon and sets it, the `T` key moves to the next choice in that order, and the palette has one command per choice. The choice is stored in the browser.

### Loading and failure states

Before the first answer the page body reads "Loading". When Sortie does not answer, it reads "Sortie is not answering. The dashboard keeps trying." A screen that fails to load, which happens in a tab opened before an upgrade, shows the title "This screen could not be shown", the advice to reload the page, and **Reload** and **Open Overview** buttons.

### Code in messages

Sortie's own sentences show text between backticks as code. A code block of more than three lines, any JSON block, and inline JSON longer than 80 characters fold to one line with the line count, and a click opens the full text.

## Overview

**Overview** answers: does anything need a person right now? The standfirst under the title is a headline sentence and a lede, and the panels follow.

![Overview with the headline "3 items need attention." and a sentence on what else is handled, the Needs attention list with Acknowledge and Open buttons, the Usage section with a Budget card of daily and weekly spend meters and a plan limits card for each agent, and the Active list with its phase chips and the Rule menu](/img/dashboard/overview.webp)

| Headline | Shown when |
|---|---|
| "Sortie is picking up its first issues." | No run is on record, an agent runs, and nothing needs attention or waits on a person. |
| "Sortie is degraded, and N more items need attention." or ", and nothing else needs attention." | A health check fails or a critical item is open. |
| "N items need attention." | At least one item is unacknowledged. |
| "N acknowledged items wait on a person." ("1 acknowledged item waits on a person.") | Every item is acknowledged and at least one still stands. |
| "Nothing needs attention." | None of the above. |

The lede after the headline says what else Sortie is doing. It counts running agents, pull requests watched for a reaction, scheduled retries, issues between stages, and acknowledged items, in that order. Under "N items need attention." and under the degraded headline it opens with "Handled:", as in "Handled: 2 agents running, 1 pull request watched.". Under "Nothing needs attention." it has no lead, as in "2 agents running, 1 retry scheduled.". With nothing to count it reads "Handled: no agents running." or "No agents running.". While Sortie is degraded the lede leaves out the issues between stages and the acknowledged items, and under "N acknowledged items wait on a person." it leaves out the acknowledged items, because the headline already counts them.

**Needs attention** lists the unacknowledged [attention items](#attention-items), critical first and then oldest. Each item shows its reason in bold, the issue title, which links to the [issue page](#issue-page), the key, why the item exists, what clears it, how long it has existed, and its buttons. A click outside the buttons opens the [peek](#issue-peek) of the item's issue.

While nothing needs attention, a calm line and a row of tiles take the place of the list, unless a health check fails or the first run is still to come. The calm line reads "Nothing is parked, escalated, stopped or waiting on a person, and Sortie is healthy." It shows only when no acknowledged item stands either; under "N acknowledged items wait on a person." the tiles show without it. Each tile links to the screen that explains its figure.

| Tile | Shows | Opens |
|---|---|---|
| **Agents running** | How many agents run, how many more could start under [`agent.max_concurrent_agents`](/reference/workflow-config/#agent) ("2 agents idle"), and the longest running time. With no agent idle the line reads "All agents are running", or "The agent is running" when the limit is 1. | **Pipeline** |
| **Ended today** | How many issues ended today, split into merged, handed off, and done. A workflow with two or more [`tracker.terminal_states`](/reference/workflow-config/#tracker) counts the issues that reached a terminal state as closed instead of done. | **History** |
| **Last one ended** | When the newest ending happened, how long ago, and the issue title | The issue page |
| **Runs finished today** | How many runs finished today, split into succeeded and failed | **Analytics** |

**Usage** appears while a daily, weekly, or monthly spend ceiling is set or an agent kind has reported a usage limit that has not reset, below **Needs attention** and above **Active**. Each part shows only when it has data, and the section is absent when neither does. It holds one card for the budget and one card for each agent kind that reported a limit.

The **Budget** card appears while a spend ceiling is set. It has one meter for each window that is set, **Daily spend**, **Weekly spend**, and **Monthly spend**, in that order. Each meter reads, for example, "$41.27 of $100.00". While the spend is a [lower bound](#lower-bounds-and-hints), the amount is cut and underlined, and its hover reads "Some runs could not be fully priced or measured, so the real cost is higher." The bar changes color once the spend reaches the ceiling. A line under the meter reads "Resets Friday 27 March, 00:00 UTC", or "Holding dispatch, resets Friday 27 March, 00:00 UTC" while the window holds dispatch. The windows are UTC days, UTC weeks, which start on Monday at 00:00 UTC, and UTC months, so the reset time is written in UTC, while **Ended today** and **Runs finished today** count the day in your browser's time zone. While several windows have reached their ceiling, dispatch stays held until every one of them clears. When an agent card is also shown, the card carries the note "Estimated at API prices", because the figures are Sortie's estimate and not the plan the agent bills against. See [how to control agent costs](/guides/control-costs/#cap-what-the-whole-instance-spends).

An agent card is titled with the agent kind and appears for each kind the workflow can dispatch to, in alphabetical order, once that kind has reported a usage limit. It holds one entry per limit the agent reported, for example "5-hour limit" or "Weekly limit". An entry reads as a meter when the agent reported an amount, as "7.08 of 1,000 credits", or a share, as the percentage used, and as the label with a status word, "Under the limit", "Near the limit", or "Usage limit reached", when it reported neither ("Status not reported" when it reported no status either). A line under the entry reads "Resets" with the time in UTC, or "Reset time not reported". A near or reached limit that has a meter also puts its status word at the end of that line. A limit stops showing once its reset time has passed, and a card whose limits have all reset is hidden. A card shows "Reported" with a time while its newest report is an hour old or older, and so does a single entry whose report is that old and differs from the card's. The limits are the `rate_limits` member of [`GET /api/v1/state`](/reference/http-api/#get-apiv1state-system-state). Sortie holds them in memory, so none shows after a restart until the agent reports again.

**Active** lists every issue Sortie is working on or waiting for, in the order Sortie picked the issues up. Beside the heading it shows the issue count, until the lifecycle chips take over the counting, and the **Rule** menu stands at the end of the title line. `L` moves between this block and the [**Pipeline** screen](#pipeline) with the filters kept. Lifecycle chips filter the list, and the **Rule** menu filters by dispatch rule or stage.

| Chip | Issues in it |
|---|---|
| **Agent running** | An agent session is running. |
| **Waiting on PR** | Sortie watches the pull request for a reaction, and no reaction has escalated. |
| **Between stages** | A stage hop moved the issue to the next stage and that stage has not started. |
| **Retry scheduled** | A retry waits for its due time. |
| **Needs attention** | The issue is parked, held by a budget, or has an escalated reaction. |

A chip shows only while it has issues, and the whole row of chips shows only while more than one lifecycle is present. Each chip carries its issue count, and the first chip, **All**, carries the total. The **Rule** menu shows only when the workflow has dispatch rules. It lists the rules, grouped by stage chain, with a count each, and it has a search field. A filter that leaves nothing reads "No active issue matches these filters." with a **Show all** button.

Each row shows the issue's [mark and status word](#status-word-and-mark), the issue title, which links to the [issue page](#issue-page), a second line with the key, the rule (or the stage and its place in the chain, such as "implement, 2 of 3"), and the agent kind, and a time. The time counts down to the due time for a retry and counts up from the start of the current state for every other row. A row of an issue between stages whose hold is recorded adds a line under the second line with the reason, for example "Waiting to confirm the stage move". A row of an issue marked **Attention** carries a stripe in the attention color on its left edge. A click outside the title opens the peek, which carries Sortie's sentence about the issue.

**Not dispatched** lists the issues Sortie could start but holds back, below **Active** and above **Ended today**. The block shows only while at least one issue is held, and beside its heading it shows the issue count. Each item shows the issue title and key, why Sortie holds the issue back, what releases the hold, and how long ago the hold began, written as a time of day from one hour on. **Issue** opens the issue in the tracker in a new tab; a click on the item opens no peek. The reasons are an open blocker with its key and state, blockers Sortie could not read, has not read yet, or got only in part, a full agent slot limit with its usage, no free SSH host, a spend ceiling, an agent provider's usage limit, and comments Sortie could not yet read for an issue a person released from a park. The [HTTP API reference](/reference/http-api/#hold-object) lists every reason with its wording. A spend ceiling and a usage limit each add the time left until the window resets, as in "Usage limit reached for claude-code, resets in 3h 20m", and release when it passes. A usage limit that stops one model of an agent kind alone names the model, as in "Usage limit reached for sonnet on claude-code"; issues routed to other agents or models keep dispatching. The list is empty after a restart until the first poll tick has run.

A held issue is not in **Active**, and it adds no attention item, no mark, and nothing to the headline or the lede. A spend ceiling keeps its own item under **Needs attention**. The **Held** status word of **Active** is a different thing: it marks an issue whose attention items are all acknowledged.

**Ended today** lists the issues that ended today and that Sortie no longer holds, newest ending first, each with its mark, its ending word, which is the tracker state as the workflow spells it, such as "Done" or "In Review", or "Merged", and the time. Beside the heading a tally line lists, for example, 2 issues ended, 23 runs finished, 7 succeeded, 16 failed, and 48.03M tokens, plus stopped and cancelled counts when there are any and an estimated cost, such as "$12.40 estimated", when a rate source is available. A token total or cost that is a lower bound is cut and underlined, with the hover "Some runs were not measured or not fully counted, so the real figure is higher." on the tokens and "Some runs could not be fully priced or measured, so the real cost is higher." on the cost. Without a figure the tally reads "tokens N/A" or "cost N/A" (see [N/A](#na-and-its-reason)), "tokens not recorded", or "cost unpriced", whose hover reads "The configured rates leave these runs unpriced." A **History** link follows. The tally reads "No run finished today." when none did, and it is absent before the first run and while run history is unavailable ("Run history is not available.").

### Status word and mark

**Active**, the lanes of **Pipeline**, the issue headers of **History**, and the **Issues** group of the command palette give each issue one word for where it stands. Every list except the palette draws the same mark beside the word. **Ended today** uses the ending word of the issue.

| Word | Mark | The issue |
|---|---|---|
| **Running** | Filled circle | Has an agent session running. |
| **Waiting** | Dashed circle | Waits on a pull request reaction, or sits between stages. |
| **Approval** | Dashed circle | Has a pull request that waits only on a required approval. The hover on the mark reads "Waiting on approval". |
| **Retry** | Empty circle with a heavy outline | Has a retry scheduled. |
| **Attention** | Circle with an exclamation point | Has an attention item that nobody acknowledged. |
| **Held** | Dashed circle in a muted color | Has attention items, and all are acknowledged. |
| The merged or terminal ending: "Merged", or the tracker state as the workflow spells it, such as "Done" | Circle with a dot inside | Ended without a handoff to a person. |
| The handoff ending: the state Sortie moved the issue to, as the workflow spells it, such as "In Review" | Dashed circle | Ended with a handoff to a person. |

**Approval** replaces **Waiting** only for a pull request whose review reaction found no comment to answer and whose forge reports that a required approval is still missing. A standing escalation outranks it, and an issue whose pull request has comments to answer reads **Waiting**. An unacknowledged attention item outranks an acknowledged one, and both outrank the state the issue is in. An ended issue whose ending Sortie did not record reads "Ended" with no mark.

### Run outcome words

A finished run carries its own word wherever it is listed: the run cards and chapter lines of the [issue page](#issue-page), the **What happened so far** list of the [peek](#issue-peek), the head and the **Sessions** panel of the [session view](#session-view), the status column of [**History**](#history), and the sessions in the [command palette](#command-palette). The word is the run's recorded status: **Succeeded** (check mark), **Failed** and **CI failed** (cross), **Needed input**, **Stopped at a budget**, and **Usage limit reached** (paused circle in the attention color), or **Cancelled** (slashed circle).

A run recorded as succeeded reads differently when its agent ended the session by declaring an outcome in the [`.sortie/status` file](/reference/agent-extensions/#sortiestatus-file-protocol).

| Word | Mark | The agent declared |
|---|---|---|
| **Action required** | Paused circle in the attention color | `blocked`: it cannot go on without a person. |
| **Ready for human review** | Right arrow | `needs-human-review`: its work waits for a person to look at it. |
| **No change needed** | Check mark | `no-change-needed`: the requested outcome already held, so there was nothing to change. |

A run with no declared outcome reads **Succeeded**, and so does a run recorded before Sortie kept declared outcomes. Any recorded status other than succeeded keeps its own word, so a `needs-human-review` run whose handoff Sortie withheld reads **Failed**. The **Run status** filter of **History** and the figures of **Analytics** follow the recorded status, so a run that reads **Action required** still counts as succeeded there.

The sentence the agent wrote after the status word shows beside the outcome, in curly quotes that mark it as the agent's own: in the run card on the issue page, in a note under the facts line of the session view, and as the hover on the status cell in **History**. The other places show the outcome word alone. A run that declared nothing, or wrote no sentence, shows no quotation. The [HTTP API](/reference/http-api/#get-apiv1runs-run-history) serves the same outcome and sentence with each run.

## Pipeline

**Pipeline** answers: where does each issue stand on its way from the tracker to the end of its pull request? It shows the same active issues as **Overview**, plus the issues that ended today, each as a lane across the stations of the workflow.

![Pipeline with a lane for each issue across the stations of the workflow, from Tracker and Agent through the pull request reaction stations under a PR loop bracket to End, a stage meter under the Agent station, and a legend below the lanes](/img/dashboard/pipeline.webp)

The standfirst names how many items need attention and links the issue of each, up to eight, followed by the number of further issues; it reads "Nothing needs attention." when none does. The **Active** panel, with its issue count, lifecycle chips, and **Rule** menu, works as on **Overview**, and the chips add **Ended today**. `L` and the rail move between the two screens.

The stations are fixed by the configuration, never by an issue, and they read left to right:

| Station | Present when |
|---|---|
| **Tracker** | Always. Its detail, shown under the name, is the first of `tracker.active_states` that is not `tracker.in_progress_state`. |
| **Agent** | Always. All agent work sits here, whichever stage the issue is on. Its detail is `tracker.in_progress_state`. |
| **Handoff** | `tracker.handoff_state` is set. Its detail is that state, named as the tracker names it. |
| One station per configured pull request reaction, in this order: **CI**, **Bot review**, **Human review**, **Merge**, **Auto-merge**, **Merge completion**, **Label commands** | The matching [reaction](/reference/reactions/) is configured: **CI** is `ci_failure`, **Human review** is `review_comments`, **Merge** is `merge_conflicts`, and **Auto-merge** is `auto_merge`. The detail says what the reaction watches, "failures", "comments", "conflicts", "when ready", or "labels", and for **Merge completion** it is the target state. |
| **Terminal** | Any reaction is configured. Its detail is the target state of `merge_completion`, or else the one state of `tracker.terminal_states` when that list holds exactly one and no `auto_merge` reaction is configured. On the issue page, the lane of an ended issue in a workflow with two or more terminal states gives the state the issue reached, or "merged", as this station's detail. |

Brackets over the station header group the stations: **Work** spans the stations up to the handoff, **PR loop** spans the reaction stations, and **End** stands over the terminal station. A circle over each station holds the count of lanes standing there, in the attention color while one of those lanes needs attention, with the station's name under it. Each lane shows the issue title, which links to the [issue page](#issue-page), the key, route, and agent, its [status word](#status-word-and-mark), and the track with the issue's mark at its station and the time above it. Once an issue stands at or past the handoff station, the pull request number, such as "#931", stands under that station. On an issue in a stage chain, a note under the **Agent** station shows the stage and its place in the chain, such as "implement (2 of 3)", while the issue stands at the agent. Elsewhere the note counts the stages, as in "2 of 3 stages", or "3 stages" once all are done.

The heavy line of the track runs on through every reaction station the issue worked in its current pass, not only to the station it stands at. A bot review whose `triage` command answered `handled` holds no station: its issue stands at the **Handoff** station (or at **Agent** when the workflow has no handoff state) until the bot review's comments change, also after a restart, and the station header counts it there. The issue reads **Waiting** wherever the status word shows, and Sortie's sentence reads "The triage command handled the bot review of PR #N, so Sortie starts no session for it", followed by the time of the next check. The **Bot review** station counts a handled triage as Sortie having acted. A pull request that waits only on a required approval stands at the **Human review** station, marked with a dashed circle and read as **Approval**; a workflow without the `review_comments` reaction never shows this state.

A reaction station that the issue is not standing at reads from what the reaction did during the issue's current pass. Hovering the station gives its name and detail, then the reading and, where the reaction counts its work, the count.

| Mark on the station | Hover | Meaning |
|---|---|---|
| Dashed circle | "waiting" | A reaction is pending there now. |
| Dashed circle | "waiting on approval" | The **Human review** reaction is pending, found no comment to answer, and the pull request still needs a required approval. |
| Circle filled with the attention color | "needs attention" | A reaction is pending there with an escalation standing. |
| Filled circle | "Sortie acted" | The reaction started work. On lanes and the issue page the station adds a count, such as "2 fixes" (or "runs" for label commands), for the reactions that count their work. |
| Filled circle | "nothing to act on" | Sortie watched the reaction and found nothing to act on. |
| Filled circle | "escalated" | The reaction escalated during the pass, and no escalation stands now. |
| Empty circle | None | Sortie has no record of the reaction in this pass. It does not mean the reaction did not run. |

A legend under the lanes explains every mark in use. With more than 24 lanes the lanes compress to a dense form without times, counts, or stage notes, and, while no lifecycle chip or rule is chosen, they group by station: one line per station lists the issue keys and expands with **Show lanes** and **Hide lanes**. A click on a lane outside its title opens the peek.

## Issue peek

The peek is a drawer that shows one issue over **Overview** or **Pipeline** without leaving the list. It opens from a click on a row or lane, or from `Space` on the selected row, and it has its own address, so it can be shared. While it is open the list holds still, and the live indicator reads **Holding**. `J` and `K` move the peek to the neighboring issue, and `Esc`, `Space`, the **Close** button, or the browser's Back button close it. **Open page** opens the [issue page](#issue-page).

![The peek drawer open over Overview for an issue that reached done, with its title, Sortie's sentence, its lane and stage meter, the Last session and Open issue buttons, the Route, Agent, Sessions, and Spent facts, and the last runs under So far](/img/dashboard/issue-peek.webp)

| Part | Contents |
|---|---|
| Head | The issue key and its tracker state, **Open page**, and **Close**. |
| Summary | The issue title, Sortie's sentence about it, and its lane. |
| Buttons | **Acknowledge** for each open attention item, **Open live session** or **Last session**, **Issue** (the tracker page), and **PR** (the pull request). |
| **Details** | **Route** (the rule or stage and its place in the chain), **Agent** (kind and model), **This session** while one runs (turn, tokens, and estimated cost), **Sessions**, **Tokens** or **Spent**, and **Pull request** with its branch. **Spent** reads the cost and the tokens, such as "$12.40 estimated, 1.2M tokens", and the cost against the money limit, such as "$12.40 of $25.00 estimated, 1.2M tokens", while `agent.max_cost_usd` is set. A cost or token figure that is a lower bound is cut and underlined, as in [How figures are written](#how-figures-are-written). |
| **What happens next** | What Sortie will do under each condition, such as "When retry 7 comes due". Absent when no condition applies. |
| **What happened so far** | The last runs of the issue with their [outcome words](#run-outcome-words), and a closing line with the issue's current sentence, timed at the moment the issue ended once it has ended. |

An issue Sortie no longer knows reads "Sortie no longer knows" followed by its key. Showing an issue, in the peek or on its page, marks its ending as [read](#unread-markers).

## Issue page

The issue page answers: what happened to this issue, what happens next, and what has it cost? It opens from the title of an issue on **Overview**, **Pipeline**, and **History**, from the peek, from the palette, and from the **Overview** tiles, and `Esc` returns to the screen it was opened from.

![Issue page of a finished issue with its breadcrumb, title, and sentence, a Pipeline card with every station passed, folded stage chapters, a Pull request chapter with a run card, and the Budget and cost and Route panels in the margin](/img/dashboard/issue-page.webp)

The page opens with the issue's title, with Sortie's sentence about it as the standfirst, and, for a running issue whose agent has been quiet, a stall notice. At the end of the title line stand the buttons **Open live session** or **Last session**, **Issue**, and **PR**. Under the header a **Pipeline** panel draws the issue's [lane](#pipeline) with the station names and details, the stage note, and, at reaction stations, the counts. From 1280 px wide the story sits beside a margin of panels. Below that the margin follows the story.

The story is the issue's history, newest at the bottom, grouped into chapters.

- Each stage of a chain is a chapter named after its rule, and a stage that ran again reads "again". Work on the pull request, such as CI fixes and review fixes, forms chapters named "PR loop". Work outside a stage chain forms chapters named "Work".
- An issue in a stage chain opens with a summary of the stages done, the current stage with its place, such as "implement (2 of 3)", and the stages ahead. Its **All stages** button lists every stage with its time span. A stage that did not hop to the next reads "hop to" the target "not made" with the reason in plain words: the next stage's label could not be added, or the limit on automatic hops in a row was reached. Elsewhere a hop reads the same way, such as "moved to implement".
- In a stage chain, every chapter but the current one starts folded to one line, and a click opens or folds a chapter. Elsewhere chapters stay open. A folded chapter shows its run count, time span, and outcome. Unless the last run made or missed a hop, the outcome is its [outcome word](#run-outcome-words) with its first letter in lower case, such as "action required". An acronym keeps its capitals, as in "CI failed".
- Each run is a card with its number, its [outcome word](#run-outcome-words), what started it ("CI fix", "Retry after an error", "Continuation", and so on), its time span and duration, its error when it failed, the sentence its agent wrote with a declared outcome, its turns when it completed any, its tokens, its estimated cost when a rate source is available, and a **Session timeline** link to the [session view](#session-view). The tokens and cost of a finished run read as in the **Tokens** and **Est. cost** columns of [**History**](#history), hovers included. The tokens of a running session read "not measured" until its agent reports usage, and its cost is left out until then. A CI failure that Sortie recorded is not a run card, since no agent ran: it is one line in the story, "CI checks failed", with its time.
- The current chapter closes on Sortie's sentence about the issue, timed at the moment the issue ended once it has, and at the current time while it is active. When older runs are not loaded, a line says how many are not listed, and **Show older runs** loads them.

The margin holds these panels, each only when it applies.

| Panel | Contents |
|---|---|
| Attention cards | Each item of the issue: reason, why, what clears it, **Issue** or **PR**, and **Acknowledge**, or "Acknowledged" with the time. |
| **Retry N** | While the issue waits for a retry: when it is **Due**, what it was **Started by**, the **Error**, and **Retry now**. A retry that waits for a provider usage limit to reset shows **Waiting for** "the usage limit to reset" beside **Due**, in place of **Started by** and **Error**. |
| **What happens next** | The conditions and what Sortie does under each. |
| **Pull request #N** | The repository, branch, and head commit, then one line per watched reaction with its state, the time of its next check, how many fixes it has used of its limit, and **Check now**. A reaction's state reads "fixing", "checks failing", "checks passing", "comments arriving", "handled", "comments to answer", "waiting on approval", "conflict", "waiting", or "escalated". "Comments to answer" means the last check found comments the reaction has yet to act on; "handled" means the `triage` command of a bot review answered `handled` for its current comments, so Sortie starts no session for them; "waiting on approval" means the **Review** reaction found no comment to answer and the pull request still needs a required approval. A reaction with comments to answer never reads "waiting on approval", and "handled" outranks "comments to answer". |
| **Budget** or **Budget and cost** | **Sessions** and **Tokens**, each as a meter against the issue's limit or, when none is set, as the figure followed by "no budget" ("not reported" for tokens an agent did not report), and, when a rate source is available, the **Estimated cost**. When the issue has two or more shares, a line under **Tokens** and a line under the cost split each figure into its share for pull request fixes ("PR fixes") and for stage runs or the rule. A token share reads "not measured" when no run in it was measured, and as a [lower bound](#lower-bounds-and-hints) when a run in it was not measured or not fully counted. The **Estimated cost** of an issue with no running session reads as the cost in the issue's [**History**](#history) header, hovers included. A share reads "unpriced" when its runs were measured but no rate priced them, and the priced amount as a [lower bound](#lower-bounds-and-hints) when another run in it was unpriced, not measured, or not fully counted; it reads "not measured" only when no run in it was measured. While `agent.max_cost_usd` is set and a rate source is available, a **Cost** meter against that limit stands in for the **Estimated cost** figure and reads "$12.40 of $25.00". A **Tokens** or **Cost** meter whose used amount is a lower bound cuts that amount and underlines it. Under the token lines, once the issue has tokens, **Split** draws one bar that divides them into **Input**, **Output**, and **Cache write** in the colors of the [**Analytics**](#analytics) token chart, and a **Cache hit rate** line gives the share of the input tokens read from the prompt cache. Hovering the bar lists the tokens of each kind, **Cache read** included, and the **Cache hit rate**; the amounts are of the finished runs and the running session together, cut with the note "Some runs were not measured or not fully counted, so the real figure is higher." when the total is a lower bound. **Split** is absent while a run or the running session did not report the kinds, and **Cache hit rate** is absent while no input was read from the cache. |
| **Route** or **Agent** | **Entry rule**, **Stage** (with its place in the chain), **Agent** (the agent kind), **Model**, which reads "agent default" when no model is named, and **Effort** when the agent takes one. |
| **Issue** | **Status**, **Type**, and **Labels**. For a running issue, **Status** and **Labels** follow the tracker: they change right after Sortie moves the issue to `tracker.in_progress_state` and again on every poll tick, so a label added during the run shows within one tick. The state badge in the head of the issue page and of the peek follows the same reading. |

A failed read of run history shows "Run history could not be read." above the story. An issue Sortie no longer knows reads "Sortie no longer knows" followed by its key.

## Session view

The session view answers: what is this agent doing, or what did it do? It shows one agent session of one issue, live while the session runs and from the stored events once it ends. It opens from a run card, from the **Open live session** and **Last session** buttons, from `O`, and from the palette. `Esc` returns to the issue page.

![Session view of a finished session with its facts line, an Events pane with turns and folded tool calls, and the Usage, Cost per model, Skills, Session, and Sessions panels](/img/dashboard/agent-session.webp)

The title is "Session N", a colon, and the issue title. A button that reads "Open" and the issue's identifier opens the issue page. The standfirst is a line of facts: agent kind, model, route, the reaction that started the session when a pull request fix did, the SSH host when one is used, its time span and duration, and its status, such as "Running, turn 3 of 20", "Succeeded, 4 turns", or "Action required, 4 turns", with no turn count while the run completed no turn (see [run outcome words](#run-outcome-words)). A running session whose agent has sent no event for longer than usual shows a stall notice, and a running session with no stall timeout shows a notice that stall detection is off. A finished session shows an **Outcome** panel under the header, alarmed only when the run failed. It gives the error when the run recorded one, then the sentence the agent wrote with a declared outcome in curly quotes, then, for the newest session of an issue that has nothing running, the sentence the issue page shows for what happens next. The status in the standfirst is not repeated in the panel.

**Events** is a scrolling pane with one line per event. Every tool call is one line: an icon for its kind (a terminal for a shell command, a file for a read, a file with a pencil for an edit, an open book for a skill, a wrench for any other tool), the call itself, and its duration when the agent reports one. The call reads as follows, with secrets masked.

| Call | The line shows |
|---|---|
| Shell command | The command alone. |
| File read or edit | The tool and the file, with the path relative to the workspace. |
| Skill | The tool and the name of the skill. |
| Any other tool | The tool's name. An MCP tool reads as its server and tool, such as "github.get_issue". |

A line too long for the pane is cut at the pane's width, and hovering it shows the whole text. A failed call draws its line inside the failed mark.

Two or more consecutive tool calls fold into one line that counts them by kind, in the order the kinds first appear: "3 commands, 2 file reads", with "file edit" for an edit and "tool call" for every other tool, such as "4 tool calls". After the counts the line shows the total duration of the calls that report one and, when any call failed, "N failed" in the failed mark. A click expands the line into the calls it holds. A single call between other events is a line of its own, and a skill call is never folded: it stands alone and ends the fold before it, so the skills of a run read in order among the events. A turn that ended reads "Turn N completed" with its tokens and duration. Events the dashboard no longer holds read as a count of events not retained, and a run with none reads "No events retained". The pane keeps the newest 1,000 events of the run. When a failed turn closes a finished session, its line reads the run's [outcome word](#run-outcome-words) with that word's mark, so a session that stopped at a usage limit shows the paused circle, not a cross. The foot line counts the events.

A live session follows its newest event until the reader scrolls up. Then a **Jump to latest** button appears, with a count of new events, and the foot line reads "Live" with the time of the last event, and "following new events" while the pane follows. Pausing live updates holds the pane still and the foot line reads "Paused".

| Panel | Contents |
|---|---|
| **Tokens per turn** | A bar for each completed turn whose tokens are known, and for a live session whose agent reports usage as it happens, a bar for the turn in progress. A turn that ended without usage is listed in **Events** but has no bar. The panel appears once two completed turns have bars. A bar is a stack of **Input**, **Output**, and **Cache write**, each in its own color, so its height is the turn's tokens without cache reads; a legend names the colors. A turn whose kinds are not known draws a plain bar, and the turn in progress stays an outlined bar, labeled "In progress" in the legend. Under the bars, a **Cache read** plot draws the cache reads of each turn as a column against a scale of its own, and is absent while no turn has cache reads. Hovering a bar, or moving the keyboard focus to it, opens a note that names the turn and lists the tokens of each kind, **Cache read** included, the **Cache hit rate** while it has a value, and the turn's duration. |
| **Sessions** | Every session of the issue, newest first, each linking to its view with its outcome word, when the issue has more than one. **Show older** loads earlier ones. |
| **Usage** | **Input**, **Output**, **Cache write**, and **Cache read**, each beside its color in the token charts, then **Cache hit rate** while the session has input read from the cache, **Tokens** ("so far" while live), and **Est. cost**. A finished session that spent tokens on one model adds **Priced from** after **Est. cost**, worded as in **Cost per model**. A live session whose agent has reported no usage shows **Tokens** "not measured" in place of the token classes. A finished session adds **Measured from**, one line for each way Sortie measured the run, such as "Live protocol", "Live output", or "Saved session files", and **Agent reported**, one line per unit for the amounts the agent reported in its own unit, such as "7.08 credits". **Measured from** reads "not recorded" for a run recorded before Sortie kept where a figure came from. A finished session with no token figure shows **Tokens** "N/A" in place of the token classes, with [its reason](#na-and-its-reason) on hover. A **Tokens** figure that is a lower bound is underlined, with the hover "Some turns were not fully counted, so the real figure is higher. It will not be corrected later." The **Est. cost** of a finished session is its cost in US dollars only, worded as in the **Est. cost** column of [**History**](#history). |
| **Cost per model** | One block for each model a finished session spent tokens on, shown when it used more than one: **Model** (the name, or "not reported" when the agent named none), the token lines of **Usage** for that model, ending in **Tokens** without cache reads, then **Est. cost**, and **Priced from**, the source of its price: **Custom prices**, **Downloaded prices**, **Built-in prices**, or **Agent-reported** for a model that no price table lists and that Sortie priced from the US dollar amount the agent reported. **Priced from** reads "not recorded" for a run recorded before Sortie kept it, and is absent for a model with no cost. A model with a token class that had no rate reads its cost as a [lower bound](#lower-bounds-and-hints), and the hover names the classes, as in "claude-sonnet-4-5 has no price for cache reads and cache writes, so the real cost is higher. A price you add counts for future runs only." Absent on a live session and on a finished one that recorded no spend by model. |
| **Skills** | Every skill call of the run in the order the calls finished, each under its position, with a repeated skill listed each time. The name is cut at the panel's width and shows in full on hover, and a failed call sits in the failed mark. The panel shows while the session runs and after it ends, and it lists the whole run even when the oldest events are no longer held. It is absent while the run has called no skill, for an agent kind that reports none (the Claude Code, Copilot CLI, and OpenCode kinds report them), and for a run recorded before Sortie kept the list. |
| **Details** | **Configured** model ("agent default" when none), **Reported model**, **Host** for SSH, **Workspace** while live, **Session ID**, **Workflow**, and **Stall timeout** while live. |

An address that names no session reads "No such session". The [HTTP API](/reference/http-api/#get-apiv1runsdispatch_idevents-run-events) describes which events Sortie keeps and for how long.

## History

**History** answers: what finished, how did it end, and what did it use? It lists finished runs grouped by issue, the issue with the newest ending first, 20 issues at a time. **Show more issues** loads the next 20. The [**Tokens** and **Cost** switch](#tokens-and-cost-switch) at the end of the title line chooses whether the screen shows tokens or estimated cost.

![History grouped by issue, with the Issue key field and the Rule, Run status, and Hop to filters above a table of runs with their status, rule, agent and model, duration, turns, estimated cost, and finish time](/img/dashboard/history.webp)

The **Runs** panel holds the table, with the filters at the end of its title line, and each filter is part of the address.

| Filter | Matches |
|---|---|
| **Issue key** | An issue whose identifier or display key equals the text exactly, case included. Enter applies it. |
| **Rule** | Runs of one dispatch rule, of `dispatch.default`, or of no rule. Shown when the workflow has dispatch rules. |
| **Run status** | **Succeeded**, **Failed**, **CI failed**, **Needed input**, **Stopped at a budget**, **Usage limit reached**, or **Cancelled**. |
| **Hop to** | Runs that hopped to one stage. Shown when the workflow has stage chains. |

Each issue is a header row and its newest runs beneath it. The header shows the issue's [mark](#status-word-and-mark), the issue title linking to the issue page, and a second line with the key, the issue's status word, and its run count, then, in **Tokens**, its tokens, or, in **Cost**, its estimated cost and the amounts its agents reported in their own unit, one per unit, such as "7.08 credits". At the right it shows when the issue ended. The tokens and cost of the header are totals of the issue's runs. Hovering the tokens lists their kinds, as for a run in the **Tokens** column below. A total that is a [lower bound](#lower-bounds-and-hints) is cut and underlined, a total without a figure reads "tokens N/A", "cost N/A", or "cost unpriced", and a cost that holds an agent-reported US dollar amount carries a hover that gives the exact cost and the share the agent reported, as in "$4.20. $1.10 of it is the amount the agent reported for acme-coder-1, which no price table lists." **Show more runs** loads the issue's earlier runs.

| Column | Shows |
|---|---|
| **Status** | The run's [outcome word](#run-outcome-words) with its mark. Hovering shows the sentence the agent wrote with a declared outcome, else the error the run recorded. |
| **Rule** | The dispatch rule, with the hop the run made, such as "Moved to make-pr". Shown when the workflow has rules. |
| **Agent** | The agent kind and the model. The tooltip names the configured model when the agent reported another. |
| **Skills** | The skills the run called, in call order, separated by commas, repeats included. A skill whose call failed carries the failed mark. A long list is cut short, and hovering shows all of it with "(failed)" after each failed call. Empty for a run that called no skill and for a run recorded before Sortie kept skill calls. |
| **Duration** | From start to end, "< 1s" under one second. |
| **Turns** | Turns completed. |
| **Tokens** | Tokens without cache reads. The hover lists the tokens of each kind (**Input**, **Output**, **Cache write**, and **Cache read**) and the **Cache hit rate** while the run read input from the cache, then says how Sortie measured the run, such as "Measured from live protocol." A run whose kinds are not known has the second part alone. A lower bound is cut, its kinds are cut, and its hover ends "Some turns were not fully counted, so the real figure is higher. It will not be corrected later." A run with no token figure reads "N/A", with [its reason](#na-and-its-reason) on hover. Shown in **Tokens**. |
| **Est. cost** | The estimated cost in US dollars. A run with no dollar figure that reported amounts in its agent's own unit reads those amounts, such as "7.08 cr" or "3 req", and the hover spells them out, as in "7.08 credits reported by agent-client-protocol." A run with both a dollar figure and such amounts reads the dollar figure, and the hover gives its exact amount and the reported amounts. A cost priced in part from the US dollar amount the agent reported names that share on hover, and a cost that is a [lower bound](#lower-bounds-and-hints) is cut, with a hover that names the model and the token classes without a price, or reads "Some turns were not fully counted, so the real cost is higher. It will not be corrected later." An unpriced run reads "unpriced", and its hover names the model no price table lists. Shown in **Cost**. |
| **Finished** | When the run ended. |

With no run on record the screen reads "No run has finished yet." A filter that matches nothing reads "No finished run matches these filters." with a **Clear filters** button. Without run history the screen reads "Run history is not available.", and a failed read reads "Run history could not be read.".

## Analytics

**Analytics** answers: how do runs go over time, and where do they spend their effort? The standfirst names the range, as in "Runs finished in the last 7 days." or, for **All time**, "Every run on record.". At the end of the title line, the [**Tokens** and **Cost** switch](#tokens-and-cost-switch) chooses whether the screen shows tokens or estimated cost, and a range menu picks **Last 24 hours**, **Last 7 days** (the default), **Last 30 days**, **Last 90 days**, or **All time**, and hovering the menu gives the start of the range. A range without a run reads "No run finished in this range." (or "No run has finished yet." for **All time**). Warnings about the report, such as a database written before Sortie recorded a figure, appear above the figures.

![Analytics over the last 7 days with the success rate and summary figures, the Outcomes bar, the Spend chart, a stage chain funnel table, and the By rule breakdown table](/img/dashboard/analytics.webp)

The **Summary** panel opens with the success rate, large, and "N of M runs succeeded" beside it. The figures follow in one row.

| Figure | Shows |
|---|---|
| **Runs** | Finished runs. |
| **Issues** | Issues with a run in the range. |
| **Duration** | The median duration of succeeded runs. Shown once a run succeeded. |
| **Turns** | The mean turns per succeeded run. Shown once a run succeeded. |
| **Cache write**, **Cache read** | The cache writes and cache reads of the runs in the range. Shown in **Tokens** once the range holds cache reads. A lower bound is cut and underlined, with the note "Some runs were not measured or not fully counted, so the real figure is higher." |
| **Cache hit rate** | The share of the input tokens read from the prompt cache, with the hover "Share of input tokens read from the prompt cache." Shown in **Tokens** once the range holds cache reads. |
| **Tokens** | Tokens without cache reads. Hovering the label says "Counts every run, since every run reported its tokens." while every run in the range was measured in full. Otherwise the figure is a [lower bound](#lower-bounds-and-hints), cut and underlined, and hovering it reads "Some runs were not measured or not fully counted, so the real figure is higher." With no run measured it reads "N/A", with [its reason](#na-and-its-reason) on hover when there is one. Shown in **Tokens**. |
| **Estimated cost** | The estimated cost. While it leaves out runs that are unpriced, have a partial cost, or have no token figure, it is a [lower bound](#lower-bounds-and-hints): cut and underlined, and hovering it reads "Some runs could not be fully priced or measured, so the real cost is higher." A cost with no amount reads "unpriced", with the hover "The configured rates leave these runs unpriced.", or "N/A", with [its reason](#na-and-its-reason) on hover when there is one. Shown in **Cost**. |
| **Cost per run** | The estimated cost divided by the succeeded runs that reported usage, worded like **Estimated cost**. It reads "N/A" while no succeeded run has a token figure. Shown in **Cost**, once a run succeeded. |

Under each figure, a change row compares it with the previous range, the stretch of equal length that ends where the range starts: **Last 7 days** compares with the 7 days before them. A count, a duration, an amount, or a token figure changes as a signed whole percent, as in "+18%" or "-4%", and as a multiple with one decimal once it is double the previous figure or more, as in "2.7x". No change reads "0%", without a sign. The success rate and the **Cache hit rate** change in whole percentage points of the unrounded rates, as in "+3 pts", so two rates that both read "99%" can still differ by a point. The success rate's row ends "on the previous 7 days", reads green for a rise and red for a fall, and is muted at "0 pts". Every other change has a hover that gives the previous figure, as in "Previous 7 days: 61", written plainly even when that figure is a [lower bound](#lower-bounds-and-hints). A change row is empty for **All time**, for a previous range without runs, while the previous range loads, for a figure either range has no value for, and, for a percent or a multiple, when the previous figure is 0. A lower-bound figure compares by its full amount, not the cut one shown.

**Outcomes** is one bar that shows how the runs ended, with a legend and a count for each outcome that has runs: **Succeeded**, **Stopped**, **Cancelled**, and **Failed**. The bar's segments carry no tooltip.

A chart follows the bar for every range but **Last 24 hours**, on a database of the `full` [schema tier](/reference/cli/#schema-tiers): **Spend** in **Cost**, and **Tokens per hour**, **Tokens per day**, or **Tokens per month** in **Tokens**. The range sets the size of a bar: **Last 7 days** draws one bar per UTC hour, **Last 30 days** and **Last 90 days** one per UTC day, and **All time** one per UTC month, oldest first. The chart counts each agent turn in the period the turn ended in, so a run that works for hours spreads over them. A turn of a session that is running now counts as soon as it ends, and the last bar can still grow. A run recorded before Sortie kept turn records counts whole in the period it finished in. A range that starts at a fixed distance back, such as **Last 7 days**, begins at the first period boundary at or after that point, so its first bar is a whole period. For **All time**, the first bar is the period of the earliest run. The top of the scale is the smallest 1, 2, or 5 times a power of ten that holds the highest bar plus a fifth of it. The axis caption names the size of a bar: **UTC hour**, **UTC day**, or **UTC month**. The chart labels the axis with the date, as in "21 Oct" or "Oct 2026", and an hourly chart labels only the bars that start a UTC day. Where the labels are too wide to fit, the chart skips some of them. Hovering a period, or moving the keyboard focus to it, opens a note beside the chart. The note names the period, as in "Wednesday 21 October" for a day, "October 2026" for a month, and "Wednesday 21 October, 14:00 to 15:00 UTC" for an hour. For a period without activity it reads "No agent turns in this period." Every date and time on the chart is in UTC, whatever your time zone. The [JSON report](/reference/cli/#spend-by-period) carries the same buckets, and its sums need not equal the **Summary**, which counts the runs that finished in the range.

**Spend** draws the estimated cost of each period. A bar is solid while the period's cost is complete. A period that leaves out runs that are unpriced, have a partial cost, or reported no usage draws a diagonal hatch, and a period whose runs have no cost at all but include such runs draws a thin hatched bar, so it never reads as a period without spend. A period without activity, and a period that spent nothing, draws no bar. The note lists the cost of each token kind, **Input**, **Output**, **Cache write**, and **Cache read**, then **Estimated cost** with the period's total. The kinds are absent when a priced run recorded before Sortie kept turn records counts in the period, because it stored no split. A hatched bar adds "Some runs could not be fully priced or measured, so the real cost is higher.", a thin one reads "Cost unknown. The runs could not be priced or measured.", and a period that spent nothing reads "The runs of this period spent nothing.". A bar does not compare directly with the daily and monthly spend ceilings: a ceiling counts a finished run whole in the window it ended in, while a bar counts each turn in the period it ended in.

**Tokens per hour**, **Tokens per day**, and **Tokens per month** draw the tokens without cache reads of each period as a stack of **Input** (input tokens neither read from nor written to the cache), **Output**, and **Cache write**, each in its own color, so the stack's height is the period's tokens. A legend beside the title names the colors. A period that leaves out runs that were not measured or not fully counted draws a diagonal hatch over its stack, and a period whose runs have no token figure at all draws a thin bar. A period without activity, and a period that spent no tokens, draws no bar. Under the chart, a **Cache read** plot draws the cache reads of each period as a column, against a scale of its own, and is absent while no period has cache reads. The note lists the tokens of each kind, **Cache read** included, and adds "Some runs were not measured or not fully counted, so the real figure is higher." for a hatched stack. A period whose runs have no token figure reads **Tokens** "not measured".

Each stage chain gets a table headed "Chain from" its entry rule, with a row per stage.

| Column | Counts |
|---|---|
| **#**, **Stage** | The stage's place and rule name. |
| **Runs** | Finished runs of the rule, retries and pull request fixes included. |
| **Entered** | Passes through the stage, each counted once. |
| **By label** | Passes that arrived by a stage label a person put on the issue. |
| **Advanced** | Passes that hopped to the next stage. On the last stage, passes that moved to the handoff state. |
| **Ceiling** | Hops refused by `dispatch.max_consecutive_hops`. |
| **Hop failed** | Hops that could not add the next stage's label. |
| **No hop** | Passes that ended without a hop being due. The tooltip names the reasons. |
| **In stage** | Passes whose run is going or retrying now. |
| **Median** | The median time spent in the stage. |

The breakdowns follow, each a table sortable by any column header, 20 rows at a time with **Show more**, and with the sort kept in the address.

| Table | Groups runs by | Shown |
|---|---|---|
| **By rule** | Dispatch rule | The workflow has rules and the range holds a group besides the default. |
| **By model** | Every model a run spent tokens on, with that model's tokens and cost. A run that recorded no per-model spend falls under the model the agent reported, or the configured one when it reported none | It has a group. |
| **By agent** | Agent kind | It has a group. |
| **By run status** | Run status | It has a group. |
| **By retry trigger** | What caused a retry | It has a group. |
| **Why runs started** | What started a run: a poll, a retry, a stage hop, or a pull request reaction | It has a group. |
| **By skill** | Skill name | A run in the range called a skill, and the database records skill calls. It follows the other tables. |

Every table but **By skill** has the columns **Runs**, **Success** (**Share** in **By run status**), **Duration** (the median to the 95th percentile), and **Mean turns**, then **Tokens**, **Split**, and **Cache hit rate** in **Tokens**, or **Est. cost** and **Per run** in **Cost**. The header hover of **Per run** explains that it covers succeeded runs only. **Split** draws one bar per row that divides the row's tokens into **Input**, **Output**, and **Cache write** in the chart's colors. Hovering the bar lists the tokens of each kind, **Cache read** included, and the **Cache hit rate** while the row has one, and for a row whose tokens are a lower bound the amounts are cut and the note adds "Some runs were not measured or not fully counted, so the real figure is higher." The cell is empty for a row without tokens and on a database of the `base` schema tier. **Cache hit rate** is the row's share of input tokens read from the prompt cache, with that hover on its header, and its cell is empty for a row without cache reads and on a database of the `base` schema tier. **Split** does not sort, and **Cache hit rate** does.

A run that used two models counts in both **By model** rows, so the rows' runs can add up to more than the runs of the range. **Per run** is the cost divided by the group's succeeded runs that reported usage, and reads "N/A" for a group with no succeeded run. The **Tokens**, **Est. cost**, and **Per run** cells are worded like the summary figures: a lower bound is cut and underlined, and a hover says what the figure leaves out or why it has none.

**By skill** has the columns **Skill**, **Runs**, **Calls**, and **Failed calls**. **Runs** counts the runs that called the skill, once each however often they called it, and the header's hover says so. **Calls** counts every call, and **Failed calls** the calls that ended in a tool error, muted while it is `0`. The table starts ordered by **Runs**, most first, then by skill name, and any column header sorts it. Runs recorded before Sortie kept skill calls have none on record, so while the range holds any, the three counts are lower bounds: each draws a dotted underline, and hovering it reads "At least this many. It leaves out runs Sortie recorded before it kept skill calls." The warning above the figures also names the missing skill calls for a database written before Sortie recorded them. The same counts are the `skill_calls` member of the [run statistics report](/reference/cli/#skill-calls).


## Health

**Health** answers: is Sortie itself working? The standfirst counts the checks that fail, as in "N of M checks fail.", or the checks that have not run yet, or reads "All M checks pass.". **Checks** is a table with one row per check, each with a mark and name, a sentence about the last result, and the error text when the check failed.

![Health with the Database, Dispatch preflight, WORKFLOW.md, Tracker poll, and GitHub checks, and the Poll loop and Process panels beside them](/img/dashboard/health.webp)

| Check | Reads |
|---|---|
| **Database** | Whether the SQLite state database is reachable. |
| **Dispatch preflight** | Whether the last poll tick passed preflight. While it fails, no new issue starts. |
| The WORKFLOW.md file, named as it is | When the file loaded last, or how many reloads in a row failed and which load is still in effect. |
| **Tracker poll** | The result of the last poll, in Sortie's sentence. |
| GitHub, GitLab, or Gitea | Whether the provider is reachable. Shown when Sortie has a source control provider configured. |

A failing row reads, for example, "3 ticks in a row failed since 14:02; last success at 13:58." A check that has not run yet reads "Not run yet." Beside the checks, **Poll loop** gives the **Interval**, **Last poll**, **Last good poll**, **Next poll**, and **Failures in a row**, and **Process** gives the **Version**, when Sortie **Started**, how many **Agents** run, and when the **Config loaded**. A Sortie that serves no health data reads "Sortie serves no health checks."

## Workflow

**Workflow** answers: what configuration is Sortie running? It shows the WORKFLOW.md in effect, under a standfirst that gives the time of the load ("Configuration as of 15:34."). While a newer edit fails to load, the standfirst reads "Configuration as of 15:34; no new issue starts until the newer edit loads." A Sortie that serves no configuration reads "Sortie serves no configuration."

![Workflow with the Dispatch panel showing one stage chain, the Reactions table, and the Tracker, Agent, and Token rates panels](/img/dashboard/workflow.webp)

| Panel | Contents |
|---|---|
| **Dispatch** | Rules that belong to no chain, as a table of **Rule**, **Selected by**, and **Agent**. Each [stage chain](/concepts/stage-chains/) as a numbered list of stages with the agent each runs and how it is selected, ending on the handoff state or on the chain it joins. A line gives the limit on automatic hops in a row. Without rules the panel reads "No dispatch rules: every issue runs on" the agent kind. |
| **Reactions** | One row per configured [reaction](/reference/reactions/): **Kind**, **Limit** (fixes, fix runs, merge strategy, or target state), and **Escalation**. Without reactions it reads "No reactions: Sortie's part ends at" the handoff state. |
| **Tracker** | **Kind**, **Project** while the workflow sets one, the **Active**, **In progress**, **Handoff**, **No change**, and **Terminal** states, and the **Poll** interval. **Kind** and **Project** name the tracker Sortie started with, so after an edit of WORKFLOW.md changes either one they keep the old value until Sortie restarts. |
| **Agent** | **Kind**, **Max turns**, **Stall timeout**, **Retry backoff**, **Concurrency** with any per-state limits, **Token budget**, **Money budget**, **Session budget**, **Usage reporting** for each agent kind in use, and **SSH workers** with their per-host limit. |
| **Token rates** | The rate of each `token_rates` entry, an agent kind or a model name, for **Input**, **Output**, **Cache read**, and **Cache write**, per million tokens. A kind entry without both **Input** and **Output** reads "Not priced without `input_per_mtok` and `output_per_mtok`." Without `token_rates` the panel reads "Not set: costs come from the price table." while a rate source is available, and "Not set: no cost is shown." when none is. |

**Usage reporting** reads "reports tokens", "reports none", or "not declared" for each kind. See [`token_rates`](/reference/workflow-config/#token_rates) and the [usage reporting table](/reference/workflow-config/#usage-reporting-by-agent-kind).

## Prices

**Prices** answers: which rate prices each model, and where does it come from? It shows the rates in force, not a cost: the screen prices no run, and a finished run keeps the cost recorded when it finished. The panels state the price sources, and the **Models** table states the rates of each model. The standfirst names the price table in force and the date of its prices, or reads "No price table is in force.". The screen reads [`GET /api/v1/prices`](/reference/http-api/#get-apiv1prices-prices-in-force).

![Prices with the Prices in force, Token rates, Downloaded prices, and Built-in prices panels, and a Models table giving each model's agent, the source that prices it, its input, output, cache read, and cache write rates per million tokens, when it was last used, and its runs](/img/dashboard/prices.webp)

| Panel | Contents |
|---|---|
| **Prices in force** | **Source**, the highest-precedence price table in force (**Custom prices**, **Downloaded prices**, or **Built-in prices**, and "None" while no table is in force), **Prices as of**, the date of that table's prices, and its **Age** in whole days. The screen applies no age limit and shows no warning. |
| **Token rates** | **Entries**, as "N kind entries" and "N model entries" for the [`token_rates`](/reference/workflow-config/#token_rates) entries in force, or "Not set", and their **Version**. |
| **Custom prices** | The table named by [`price_table.replace_file`](/reference/workflow-config/#price_table) or `price_table.replace_url`. Shown only while one of them is set. |
| **Downloaded prices** | The shared table Sortie downloads from `price_table.fetch_url`. |
| **Built-in prices** | The table built into the binary. |

A table panel gives its **Status**, whether the table is **In force** ("Yes" or "No"), its **Version**, and its **Models**. A downloaded table, which is **Downloaded prices** and **Custom prices** for an address, gives **Last download** and **Next download**. **Custom prices** for a file gives **Loaded**, the time this process first read the file's current content. **Built-in prices** gives **Version date**, the date of its upstream revision, and no timing rows.

| Status | Means |
|---|---|
| **Loaded** | The source holds a table. The built-in table reads **On**. |
| **Not loaded yet** | The download has delivered no table and has not failed. The tables beneath it price runs. |
| **Failing** | The latest download try failed, or the latest load of WORKFLOW.md failed on `price_table.replace_file`. The panel adds **Failures in a row** while it is above zero, **Last failure**, and the **Error**. A table kept from an earlier download stays in force. |
| **Off by** `price_table.fetch` or `SORTIE_PRICE_TABLE_FETCH` | The download is turned off, by the setting or by the [environment variable](/reference/environment/#price-table-variables). A source that is off never reads as failing. |
| **Off** | `price_table.embedded` is `false`. |

A **Version** shows its first 12 characters, after `sha256:` for a content digest, and the hover shows the whole value. **Custom prices** and **Downloaded prices** show digests, and **Built-in prices** shows the upstream revision.

**Models** lists one row per agent kind and model: every pair run history records, and every model the workflow configures, in the top-level `agent` settings, the dispatch default, or a dispatch rule. A model that only the workflow names has no last use and no runs. Rows keep the order the server serves, the latest use first, until a column is sorted.

| Column | Shows |
|---|---|
| **Model** | The model name, or "Model not reported" for a run that named none. |
| **Agent** | The agent kind. The same model under two kinds is two rows. |
| **Priced by** | The layer that supplies the rates: **Kind entry**, **Model entry**, **Custom prices**, **Downloaded prices**, or **Built-in prices**. A model entry that takes some rates from a table reads "Model entry and" the table, as in "Model entry and Downloaded prices". Empty while no layer prices the model. |
| **Input per 1M**, **Output per 1M**, **Cache read per 1M**, **Cache write per 1M** | The rate in USD per million tokens, with at least two decimals. "not set" while no layer rates the class, which is never the same as `$0.00`, a rate that a layer sets to zero. A [kind entry](/reference/workflow-config/#kind-entries) that leaves a cache rate unset reads "input rate (not set)". When the classes of a row come from more than one layer, the hover of a rate names its layer. |
| **Last used** | When the latest recorded run of the model finished. |
| **Runs** | The recorded runs that used the model. |

Every column sorts, as the **Analytics** breakdowns do, and the choice is kept in the address. The **Search models** field above the table narrows the rows, as it is typed, to the models whose name contains the text, ignoring case; `Esc` or the clear button empties it, and while no row matches the table reads "No model matches this search." The table scrolls sideways on a screen narrower than its columns.

Before the first answer the screen reads "Loading". Without run history it reads "Run history is not available.", and a failed read reads "Prices could not be read.".

## Attention items

An attention item is one thing that needs a person. Sortie derives the items from its own state, so an item exists exactly while its cause does. Each item has a reason, an explanation of why it exists, and a sentence on what clears it.

| Reason shown | Cause | Severity | Buttons | Clears when |
|---|---|---|---|---|
| "Parked: the agent needs a person" | The agent stopped because it cannot go on without a person, so Sortie parked the issue under a label. | Warning | **Acknowledge**, **Issue** | A poll tick finds the label removed, or the issue left the state it was parked in. |
| "Parked: no evidence of work" | The issue's runs ended without evidence of work as many times in a row as `agent.max_consecutive_absences` allows. | Warning | **Acknowledge**, **Issue** | The same as above. |
| "Session budget reached", "Token budget reached", or "Money budget reached" | The issue used its `agent.max_sessions`, `agent.max_tokens`, or `agent.max_cost_usd` ceiling. The money item states the issue's estimated cost against the limit, with "at least" before the cost while it is a lower bound. | Warning | **Acknowledge** | The ceiling is raised or removed (on the next poll tick), or the issue leaves the active tracker states. |
| "Daily spend ceiling reached", "Weekly spend ceiling reached", or "Monthly spend ceiling reached" | The instance's estimated cost in the UTC day, week, or month reached `agent.max_daily_cost_usd`, `agent.max_weekly_cost_usd`, or `agent.max_monthly_cost_usd`, so Sortie starts no agent session for any issue while sessions already running finish. The item states the spend against the ceiling, with "at least" before the spend while it is a lower bound. It belongs to no issue. | Critical | **Acknowledge** | The UTC day, week (which ends at the start of Monday), or month ends, or the ceiling is raised above the spend or removed (on the next poll tick). Dispatch stays held until every reached window has cleared. |
| "CI escalated on #N", "Review comments escalated on #N", "Bot review escalated on #N", "Merge conflict escalated on #N", "Auto-merge escalated on #N", "Merge completion escalated on #N" | A pull request reaction escalated. | Warning | **Acknowledge**, **PR** (**Issue** for merge completion) | The cause of the escalation is resolved, the pull request merges or closes, or the issue reaches a terminal state. The item's text states the rest for its reaction. |
| "<file> failed to load" | An edit of WORKFLOW.md did not load, so poll ticks dispatch nothing and the configuration that last loaded stays in effect. | Critical | **Acknowledge** | The file loads again. |
| "Dispatch preflight failed" | The preflight failed, so poll ticks dispatch nothing. | Critical | **Acknowledge** | A poll tick passes preflight. |

An item that has a tracker or pull request address gets a button that opens it in a new tab. Items without an issue, the two failing-check items at the end of the table, are not clickable and open no peek. Critical items sort first. Both critical causes are failing health checks, so the status card reads **Degraded** while the check keeps failing.

**Acknowledge** tells Sortie that a person has seen the item. The item leaves **Needs attention** and the count in the rail, the status card, the browser tab, and the headline. An acknowledged item does not disappear from view: the issue stays in **Active**, read as **Held** with its [mark](#status-word-and-mark), and the issue page shows the item with the time it was acknowledged. Sortie stores the acknowledgement, so it survives a restart, and it ends together with its cause. An item that appears for a new cause, such as a second park of the same issue, is a new item and shows as unacknowledged.

### Unread markers

The title of each **Ended today** row that has not been read is bold. Attention items carry no marker. An ending counts as read once its issue is shown in the peek or on its page. **Mark everything read** (`Shift` and `U`, or the palette) marks every ending loaded for today. Read state belongs to the browser, so another browser starts unread.

## Actions

These actions change what Sortie does. Each answers with a short message at the bottom of the screen that states the answer Sortie gave, such as "Retry 7 of sortie-ai/sortie#1363 is due now." When Sortie does not answer, the message reads "Sortie did not answer. Nothing changed." During shutdown it reads that nothing was queued or acknowledged. The [HTTP API](/reference/http-api/) documents the routes behind them.

| Action | Where it is offered | What it changes |
|---|---|---|
| **Acknowledge** | On every unacknowledged attention item: **Overview**, the peek, and the issue page. `E` acknowledges the selected item. | Records that a person saw the item, as [described above](#attention-items). An item that cleared in the meantime reads "This item cleared before it was acknowledged." See [POST /api/v1/attention/{id}/acknowledge](/reference/http-api/#post-apiv1attentionidacknowledge-acknowledge-an-attention-item). |
| **Retry now** | On the issue page, in the **Retry N** panel of an issue that waits for a scheduled retry. It is disabled once the retry is due. | Makes the scheduled retry due at once instead of at its due time. The retry then goes through the same checks as a retry that came due by itself: a free slot under the concurrency limits, the issue's session, token, and money budgets, and the issue's tracker state. A retry that fails one of them is rescheduled or released as usual. See [POST /api/v1/retries/{identifier}/run](/reference/http-api/#post-apiv1retriesidentifierrun-run-a-scheduled-retry-now). |
| **Check now** | On the issue page, beside each watched reaction in the **Pull request** panel. | Moves the reaction's next check to the next poll tick instead of its scheduled time, so the answer reads "queued for the next poll tick". It does not run the check on the spot. See [POST /api/v1/reactions/{identifier}/{kind}/check](/reference/http-api/#post-apiv1reactionsidentifierkindcheck-check-a-pending-reaction-now). |

Other commands act on Sortie as a whole: **Refresh now** and **Pause live updates**, described under [live updates](#live-updates). The `A` key, **Run the item's action** on the shortcut sheet, opens the item's tracker or pull request address in a new tab, or acknowledges an item that has no address.

## Live updates

The dashboard holds a connection to Sortie's [change stream](/reference/http-api/#get-apiv1events-change-signals-and-agent-events). When Sortie reports a change, the dashboard rereads what the open screen shows. No timer reloads the page. **History** rereads at most once every 5 seconds and **Analytics** at most once every 30 seconds, however often changes arrive. **Prices** is the exception: it reads its route when it opens and when the browser window regains focus, and a change signal never rereads it, so a reload of WORKFLOW.md or a finished download shows after the screen is reopened or the window is focused again. A session view also receives the events of the session it shows over the same connection.

**Refresh now** (`R`, or the palette) asks Sortie to poll the tracker now, and the message reads "Tracker poll and reconciliation queued." or says that a poll was already queued. **Pause** (`P`, the palette, or the live indicator) holds the screens still, and resuming applies what changed in the meantime. While paused, the title and icon of the tab stay as they were and a session view stops adding events.

The live indicator at the right of the top bar says how fresh the screen is. When several rows apply, the first one wins.

| Indicator | Means |
|---|---|
| **Paused**, "Press P to resume." | Live updates are paused. |
| **Holding**, "Holding still while you read." | A peek is open over **Overview** or **Pipeline**, and the list holds still. |
| **Reconnecting**, "Reconnecting to live updates." | The change stream is not open. The dashboard reopens it with growing delays of up to 30 seconds, and reopens it after 45 seconds of silence. |
| **Not updating**, "last update" with a time | The dashboard could not read Sortie's state. |
| **Poll failing**, "next try" with a time | The stream is open, but the last tracker poll failed. |
| **Live**, "next poll in" a time, then "Press P to pause." | The stream is open and the last poll succeeded. The detail is absent when no poll is scheduled. |

When the version of the running Sortie differs from the version the open tab first saw, a message that stays until dismissed reads "Sortie" and the new version, then "is running. Reload to update the dashboard.", with a **Reload** button.

## How the screens follow the workflow

The dashboard shows only what the workflow configures. Every row below changes with the matching part of WORKFLOW.md.

| Configured | What the dashboard shows |
|---|---|
| No [dispatch rules](/reference/workflow-config/#dispatch) | No **Rule** menu, no **Rule** column or filter in **History**, no **By rule** table. Issues run on the default agent. |
| Dispatch rules | The **Rule** menu on **Overview** and **Pipeline**, the rule on each row and run, the **Rule** filter and column in **History**, and **By rule** in **Analytics**, which stays hidden while every run used the default. |
| [Stage chains](/concepts/stage-chains/) | The rule menu grouped by chain, the stage and its place on rows ("implement, 2 of 3"), the stage note on lanes, the "stages done" legend entry, the stage summary and stage chapters on the issue page, the **Hop to** filter in **History**, one funnel table per chain in **Analytics**, and the chains in **Workflow**. |
| Pull request [reactions](/reference/reactions/) | One station per reaction on **Pipeline** and the issue page, the **Waiting on PR** chip, the "PR loop" chapters and the **Pull request** panel with **Check now**, escalations as attention items, and the **Reactions** panel in **Workflow**. Without reactions the lane ends at the handoff state. |
| A rate source: the built-in price table, a downloaded or [`price_table.replace_file`](/reference/workflow-config/#price_table) table, or [`token_rates`](/reference/workflow-config/#token_rates) | The [**Tokens** and **Cost** switch](#tokens-and-cost-switch) of **History** and **Analytics** and their **Cost** view, the cost in run cards, the peek, the **Budget and cost** panel, and the **Ended today** tally. The built-in table is on by default, so these appear unless `price_table.embedded` is `false` and no `price_table.replace_file`, accepted download, or `token_rates` entry is in force. Then none of them appears, **History** and **Analytics** show tokens, and the **Est. cost** row of a session view whose tokens were measured reads "unpriced". **Prices** shows which of these sources is in force. |
| An agent kind that [reports no token usage](/reference/workflow-config/#usage-reporting-by-agent-kind) | "not measured" in place of the tokens of a running session, "N/A" in place of the tokens and cost of a finished run, "reports none" under **Usage reporting** in **Workflow**, and a **Tokens** line of "not measured" or "N/A" in the session view. |
| `agent.max_daily_cost_usd`, `agent.max_weekly_cost_usd`, or `agent.max_monthly_cost_usd` | The **Budget** card in the **Usage** section of **Overview** and the spend ceiling attention items. |
| `agent.max_sessions`, `agent.max_tokens`, or `agent.max_cost_usd` | The budget meters on the issue page, the budget attention items, and the **Session budget**, **Token budget**, and **Money budget** lines in **Workflow**. The **Cost** meter also needs a rate source. See [how to control agent costs](/guides/control-costs/). |

## How figures are written

Costs are estimates, built from the rates in force (`token_rates` entries over the price table), and the dashboard says so with the words "estimated", "est.", and "Estimated cost". A finished run keeps the cost recorded when it finished, whatever the rates say now. Token figures leave out cache reads, which the dashboard shows separately where it has them. `agent.max_tokens` leaves them out too, so the budget meter reads **Tokens** and counts the same figure. The **Cost** meter counts them, because the estimated cost prices them. Durations use at most two units ("1h 17m"), and a duration under one second reads "< 1s". Tokens read as "830K" or "48.03M", costs read with two decimals, amounts in an agent's own unit read with at most two decimals, and a share strictly between 0 and 100 percent never rounds to either end.

A figure Sortie does not have is never written as zero. A cost above zero and under one cent reads "under $0.01", so only a cost of zero reads "$0.00". How Sortie measures a run, and what makes a figure a lower bound, is explained in [spend measurement](/concepts/spend-measurement/).

### Lower bounds and hints

A figure that carries a note is drawn with a dotted underline, and hovering or tapping it opens the note. A figure without a note has no underline and no hover. A figure that is a lower bound always carries a note. Its amount is cut, never rounded up, so the text never exceeds what it bounds: tokens drop the digits past the last one shown (1,699,999 reads "1.69M"), a cost keeps two decimals, and under one cent keeps its first non-zero digit ("$0.004"), and an amount in an agent's own unit keeps at most two decimals. The dashboard writes no "at least" before such a figure; the underline and the note mark it.

| Figure | Note |
|---|---|
| Tokens of a finished run | "Some turns were not fully counted, so the real figure is higher. It will not be corrected later." |
| Cost of a finished run | "Some turns were not fully counted, so the real cost is higher. It will not be corrected later.", or, when a token class of the model had no price, "<model> has no price for <classes>, so the real cost is higher. A price you add counts for future runs only." |
| Cost of a running session | "Some turns were not fully counted, so the real cost is higher." |
| A token total: the **Ended today** tally, a **History** header, **Analytics** with its token chart and **Split** bars, the **Tokens** budget meter and its shares, the peek | "Some runs were not measured or not fully counted, so the real figure is higher." |
| A cost total: the same places, the **Budget and cost** panel, the **Budget** card, the **Spend** chart | "Some runs could not be fully priced or measured, so the real cost is higher." |
| An amount in an agent's own unit | "Some turns were not fully counted, so the real amount is higher. It will not be corrected later." |

Other notes give the provenance of a complete figure: the tokens of a finished run say how Sortie measured it ("Measured from live protocol."), and a cost that holds a US dollar amount the agent reported gives the exact cost and that share ("$4.20. $1.10 of it is the amount the agent reported for acme-coder-1, which no price table lists.").

### N/A and its reason

A finished run, or a total of finished runs, with no token figure reads "N/A" for its tokens and its cost. The note gives the reason.

| Reason | Note |
|---|---|
| The run ended before the agent reported usage | "The run ended before the agent reported any usage. It will not be measured later, and nothing needs doing on your side." |
| The agent sent no usage | "The agent sent no usage for this run. It will not be measured later, and nothing needs doing on your side." |
| The agent reports spend only in its own unit | "The agent reports its spend only in credits, not in tokens. Nothing to do on your side.", naming the units. The cost cell of such a run reads its amounts instead, such as "7.08 cr". |
| The run was recorded before Sortie kept provenance | "Sortie recorded this run before it kept where a figure came from." |
| A total over runs with different reasons | "These runs have no token figure, for more than one reason. Each session says why." |

A total whose runs all share one reason carries the note only when that reason is the agent's own unit; for any other shared reason it reads "N/A" with no note. A running session with no usage yet reads "not measured" instead.

### Wording

| Wording | Means |
|---|---|
| "N/A" | A finished run or a total with no token figure, and the cost that depends on it. See [N/A and its reason](#na-and-its-reason). The tally and the **History** header read "tokens N/A" and "cost N/A". |
| "not measured" | A running session whose agent has reported no usage yet, and the **Tokens** fact of the peek for an issue with no token figure. It stands for a token figure and for a cost that depends on one. A share of the budget panel reads it when no run in it was measured. |
| "unpriced" | The tokens are known but no rate prices the model of a running session, or none did when a finished run was recorded. The hover of a finished run names the model: "No price table lists <model>, so this run has no cost. A price you add counts for future runs only." The tally reads "cost unpriced". |
| "not recorded" | Sortie's run history does not hold the figure, or has no value for it, as for **Mean turns** of a group with no turn count. The tally reads "tokens not recorded". **Measured from** and **Priced from** in the session view read it, with the hover "Sortie recorded this run before it kept where a figure came from.", for a run recorded before Sortie kept provenance. |
| "not reported" | The agent named no model, as in **Reported model** and the **Model** row of **Cost per model**. In the budget panel, **Tokens** reads "not reported, no budget" when no token budget is set, and "not reported" when one is. |
| "Counts every run, since every run reported its tokens." | The hover of the **Tokens** figure of **Analytics** when no run is left out and none is counted in part. |
| "at least" | Only in Sortie's own sentences: the budget and spend ceiling [attention items](#attention-items), as in "The issue has used at least $12.40 of its budget of $25.00 in estimated cost", the sentence of an issue held at its budget, and the hover of a lower-bound count in the [**By skill**](#analytics) table. Figures elsewhere mark a lower bound with the [underline](#lower-bounds-and-hints). |
| "under $0.01" | A cost above zero that is smaller than one cent. |
| "unknown" | A time, duration, or cost the dashboard cannot state. |

## Keyboard shortcuts and command palette

`?` and the **Shortcuts** button of the top bar open the shortcut sheet. It groups the keys into **Navigation** and **Everywhere**, and, on **Overview**, **Pipeline**, and an issue page, **This page**. Keys are ignored while the cursor is in a text field and while `Ctrl`, `Alt`, or `Cmd` is held, except for the palette key. Keys that activate a focused button or link keep that job.

### Global shortcuts

| Keys | Action |
|---|---|
| `R` | Refresh now |
| `P` | Pause or resume live updates |
| `Shift` `U` | Mark everything read |
| `T` | Next theme |
| `G`, then `O`, `P`, `H`, `A`, `E`, `W`, or `R` | Go to **Overview**, **Pipeline**, **History**, **Analytics**, **Health**, **Workflow**, or **Prices** |
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

`Ctrl` `K` or `Cmd` `K` opens the palette from any screen, and so do the **Search or run a command** button in the top bar and the **Menu** button on narrow screens. It has a search field, with a button that clears it, and lists the commands, each with its key.

| Command | Key |
|---|---|
| **Go to** each screen | `G` and the screen's letter |
| **Refresh now** | `R` |
| **Pause live updates** or **Resume live updates** | `P` |
| **Mark everything read** | `Shift` `U` |
| **Theme: System**, **Theme: Light**, **Theme: Dark** | `T` |
| **Keyboard shortcuts** | `?` |

Typing narrows the commands and adds the groups below. **Issues** lists active issues whose key or title contains the text (the first 8), then finished issues from run history that match by key or title (up to 5 more), each with its [status word](#status-word-and-mark) under the name. **Sessions** lists the live sessions of matching running issues, named "key live session", and the finished sessions of the issues found, named "key session N" with the route, [outcome word](#run-outcome-words), and start time (up to 8 in all). Choosing an issue opens its page, and choosing a session opens its view. A search with no match reads "Nothing matches" and the text, and a failed history lookup reads "Run history could not be read."

![Command palette listing the go-to commands for each screen, Refresh now, Pause live updates, Mark everything read, the theme commands, and Keyboard shortcuts, each with its key](/img/dashboard/command-palette.webp)
