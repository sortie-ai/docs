---
title: Connect Sortie to GitLab
linkTitle: "GitLab Integration"
description: "Tutorial: connect Sortie to a GitLab project on GitLab.com or a self-managed instance, poll for issues, process them with a mock agent, and watch Sortie update the label-driven state automatically."
keywords: sortie gitlab tutorial, gitlab access token, private-token header, namespace path, self-managed gitlab, community edition, mock agent, tracker integration, getting started, label states
author: Sortie AI
date: 2026-08-06
weight: 48
---
In this tutorial, we will connect Sortie to a live GitLab project, watch it discover the issues sitting in the states you configured, process them through a mock agent, and transition each one by swapping its state label. By the end, you will have a working GitLab integration that polls, dispatches, and hands off.

We use the mock agent on purpose. The quick start taught you how Sortie works with local files. This tutorial isolates the next variable, a real issue tracker, and nothing else. Once GitLab works, swapping in a real coding agent is one config change. GitLab ships two ways, and both reach the same adapter: GitLab.com needs no install and is the path this tutorial walks, and a self-managed Community Edition container is available as an optional step if you would rather run the whole thing on your own machine.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- [Quick start](/getting-started/quick-start/) completed
- A GitLab.com account with a project whose issues you can write to
- Docker, only if you take the optional self-managed path

{{% steps %}}

### Create the project and issues

Sign in to GitLab.com and create a new project. Give it a name, leave the visibility at whatever you prefer, and create it. GitLab drops you on the project overview page.

Two values on that page both work as `tracker.project`, and you will pick one in a moment. The **namespace path** is the part of the URL after the host, `your-username/adapter-lab` for a personal project or `group/subgroup/project` for a nested one. The **numeric project ID** comes from the overview page's **Actions** menu in the upper-right corner, under **Copy project ID**. The path is readable in a workflow file; the numeric ID survives a rename. This tutorial uses the path.

Now create the label Sortie will poll on. Open **Manage > Labels**, select **New label**, name it `backlog`, pick any color, and create it. Lowercase matters here, and the next step explains why.

Create two issues and apply the `backlog` label to both. Titles like "Add a health-check endpoint" and "Document the configuration options" are enough; the mock agent never reads them. GitLab numbers them `#1` and `#2` within the project.

Your project now has two open, labeled issues waiting for Sortie to find.

### Create an access token

Sortie authenticates with a GitLab access token carrying the **`api`** scope. GitLab's classic scopes are coarse, and `api` is the narrowest one that authorizes issue writes: `read_api` performs every read and refuses every write with `403 insufficient_scope`.

Create a personal access token from your [user settings](https://docs.gitlab.com/user/profile/personal_access_tokens/), select the `api` scope, and copy the value. GitLab shows it once.

Two mechanics matter, and they matter here rather than later. The token travels in the **`PRIVATE-TOKEN`** header, not `Authorization: Bearer` and not `Authorization: token`. And Sortie sends it **verbatim**, with no trimming, so a trailing newline picked up from a copy-paste is part of the credential and authentication fails.

There is a tighter option, and it is worth naming honestly. A project access token authenticates as a generated bot user that the server confines to one project, which is real least privilege rather than a convention. On GitLab.com it requires a Premium or Ultimate subscription, so a Free namespace cannot create one. That is why this tutorial uses a personal access token.

### (Optional) Run GitLab Community Edition locally

Skip this step if you are on GitLab.com. It replaces the two steps above, and it is not free: the pinned image `gitlab/gitlab-ce:19.2.1-ce.0` is multiple gigabytes on disk, and on a machine constrained to 4 CPUs and 16 GB of memory, two measured boots both took **111 seconds** to return the first HTTP 200 or 401 from `GET /api/v4/version`. Budget a few minutes before the API answers at all.

GitLab also needs a different bootstrap than a smaller forge. There is no basic-auth route for minting the first token, so the first credential comes from a `gitlab-rails runner` invocation inside the container. Rather than reconstruct that sequence here, run the script the Sortie repository ships for exactly this purpose, `scripts/gitlab-integration-provision.sh`. It pulls the pinned image, starts it as a container named `sortie-gitlab-integration` on host port 8929, polls `GET /api/v4/version` until the instance answers, mints the bootstrap token, and creates a group, a project, the state labels, and seed issues.

The script prints its coordinates to stdout as `export` lines, so you can load them straight into your shell:

```bash
eval "$(scripts/gitlab-integration-provision.sh)"
```

That exports `SORTIE_GITLAB_ENDPOINT`, `SORTIE_GITLAB_TOKEN`, and `SORTIE_GITLAB_PROJECT` (along with a few fixture coordinates the test suite reads and you can ignore). The next step is then already done for you, and everything after it is identical on both paths, with one configuration difference: on this path you set `tracker.endpoint` to the instance base URL, and on GitLab.com you omit it. The seeded project carries several labeled issues, so the counts in the log excerpt further down, which come from the GitLab.com path, will be higher here.

When you are finished, one command reclaims the container and everything in it:

```bash
docker rm -f sortie-gitlab-integration
```

### Export the connection settings

Sortie reads its connection details from environment variables the workflow file references. Export the token and the project:

```bash
export SORTIE_GITLAB_TOKEN="<the token you copied>"
export SORTIE_GITLAB_PROJECT="your-username/adapter-lab"
```

| Variable | Value | Role |
|---|---|---|
| `SORTIE_GITLAB_TOKEN` | the token you created | The access token, sent verbatim in the `PRIVATE-TOKEN` header. |
| `SORTIE_GITLAB_PROJECT` | `your-username/adapter-lab` | The project, as a namespace path or a numeric project ID. |

There is no endpoint variable on this path. The adapter defaults to `https://gitlab.com`, so a GitLab.com workflow omits `tracker.endpoint` entirely. Only the self-managed path sets `SORTIE_GITLAB_ENDPOINT`.

Confirm both resolved:

```bash
echo "$SORTIE_GITLAB_PROJECT"
```

You should see your namespace path printed back. If it is blank, re-run the `export` command.

### Write the workflow file

Create a working directory:

```bash
mkdir sortie-gitlab && cd sortie-gitlab
```

Create `WORKFLOW.md` with this content:

```jinja {filename="WORKFLOW.md"}
---
tracker:
  kind: gitlab
  api_key: $SORTIE_GITLAB_TOKEN
  project: $SORTIE_GITLAB_PROJECT
  active_states:
    - backlog
    - in-progress
  handoff_state: review
  terminal_states:
    - done
    - wontfix

polling:
  interval_ms: 30000

server:
  port: 8642

agent:
  kind: mock
  max_turns: 1
---

You are working on {{ .issue.identifier }}: {{ .issue.title }}
{{ if .issue.description }}

{{ .issue.description }}
{{ end }}
```

A few GitLab-specific lines to notice:

- `tracker.kind: gitlab` selects the GitLab adapter instead of the local file adapter from the quick start.
- No `endpoint` line appears, because the adapter defaults to `https://gitlab.com`. On the self-managed path, add `endpoint: $SORTIE_GITLAB_ENDPOINT` and give the instance root; the adapter appends `/api/v4` itself.
- `api_key` is your token. Sortie sends it verbatim in the `PRIVATE-TOKEN` header.
- `project` is the namespace path, or the numeric project ID if you prefer that. Write it unencoded. The adapter percent-encodes the whole value exactly once, and a pre-encoded value is a configuration error. Subgroups nest to any depth, so `group/subgroup/project` is as valid as `group/project`.
- `active_states` and `terminal_states` are label names, matched case-insensitively when Sortie reads them. You pre-created only `backlog`. GitLab creates any other label the moment Sortie names it in a write, so `review` appears on its own after the first handoff. Case is the one thing GitLab is strict about: label names are case-sensitive on the server, and attaching `Review` to a project that already holds `review` creates a second label rather than matching the first. Sortie reads the project's label catalog at startup and sends the stored casing for every configured state, so it never grows that duplicate for you.
- `handoff_state: review` moves each finished issue to the `review` label. Because `review` is not a terminal state, the issue stays open.
- `agent.kind: mock` runs the built-in mock agent, which simulates a session with no subprocess and no file changes. `max_turns: 1` gives it a single turn, enough to prove the loop.
- `polling.interval_ms: 30000` polls GitLab every 30 seconds, and `server.port: 8642` serves the dashboard at `http://localhost:8642`.

### Validate the configuration

Check the file before you run it:

```bash
sortie validate ./WORKFLOW.md
```

`sortie validate` runs entirely offline. It catches a malformed endpoint, a project value that is percent-encoded or otherwise malformed, and a `query_filter` naming a parameter outside the adapter's allowlist, and it warns when your active and terminal state lists overlap or the token resolves empty. On the configuration above it prints nothing and exits 0.

Validation never contacts GitLab, so it cannot tell you whether the token works or whether the project exists. A wrong token or an inaccessible project fails the construction preflight the moment Sortie starts, when the adapter introspects the credential and reads the project.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output like this:

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-gitlab/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-gitlab/.sortie.db
level=INFO msg="sortie started"
level=INFO msg="tick completed" candidates=2 dispatched=2 running=2 retrying=0
level=INFO msg="workspace prepared" issue_id=1 issue_identifier=1 workspace=…/1
level=INFO msg="agent session started" issue_id=1 issue_identifier=1 session_id=mock-session-001
level=INFO msg="turn started" issue_id=1 issue_identifier=1 turn_number=1 max_turns=1
level=INFO msg="turn completed" issue_id=1 issue_identifier=1 turn_number=1 max_turns=1
level=INFO msg="worker exiting" issue_id=1 issue_identifier=1 exit_kind=normal turns_completed=1
level=INFO msg="handoff transition succeeded, releasing claim" issue_id=1 issue_identifier=1 handoff_state=review
level=INFO msg="tick completed" candidates=0 dispatched=0 running=0 retrying=0
```

The first `tick completed` line reports `candidates=2 dispatched=2`: Sortie found both `backlog` issues and started a mock session for each. The lines that follow trace issue 1 from workspace to handoff. Issue 2 moves through the identical sequence in the same tick, and because Sortie runs the two sessions concurrently, the two issues' lines interleave in your terminal. By the next poll, neither issue sits in an active state, so the second `tick completed` reports `candidates=0` and Sortie goes idle.

Those bare numbers in `issue_identifier` and the workspace name are GitLab's project-scoped `iid`, the number GitLab shows as `#1` inside the project. GitLab's fully qualified display form for the same issue is `group/project#1`, but the identifier Sortie stores and logs is the `iid` alone.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Open the dashboard at `http://localhost:8642`. The run history shows the two completed mock sessions, one per issue.

Now open the project in GitLab and look at the two issues. Each one carries the `review` label instead of `backlog`, and both are still open, because `review` is not a terminal state. Had the transition targeted `done` or `wontfix`, Sortie would have closed the issue in the same request that swapped the label. Notice a `review` label you never created in the project's label list: GitLab created it when Sortie first named it in a write.

Here is the lifecycle you watched, end to end:

1. **Poll.** Sortie fetched the opened issues from GitLab and matched the two labeled `backlog` against `active_states`.
2. **Dispatch.** It claimed each issue, prepared a workspace, and ran a one-turn mock session.
3. **Handoff.** When each session finished, Sortie removed the `backlog` label and added `review` in a single request, leaving the issue open.

Neither change shows up as a comment. GitLab records a label swap as a system note in the issue's activity feed, and Sortie filters system notes out when it reads an issue's comments, so nothing Sortie did here pollutes the comment thread an agent would later read.

{{% /steps %}}

## What we built

We connected Sortie to a live GitLab project and ran the full orchestration cycle without wiring a real coding agent. Sortie authenticated with the `PRIVATE-TOKEN` header, resolved the project from its namespace path, matched the two `backlog` issues against `active_states`, ran a mock session for each, and transitioned each to `review` in one request, letting GitLab create the `review` label along the way. The mock agent stood in for a real coding agent so we could confirm the tracker integration on its own.

Swapping the mock agent for a real coding agent is one change: set `agent.kind` to a coding-agent adapter and configure that section. The tracker configuration stays exactly as you wrote it. That swap is the subject of the GitLab and Claude Code end-to-end tutorial.

If you took the container path, reclaim the multiple gigabytes it is holding with one command:

```bash
docker rm -f sortie-gitlab-integration
```

## Where to go next

- [Connect Sortie to GitLab](/guides/connect-to-gitlab/) scopes candidates with query filters, maps richer state sets, and covers project and group access tokens.
- The [GitLab adapter reference](/reference/adapter-gitlab/) documents every tracker field, the label-driven state model, the `query_filter` allowlist, and the error mapping.
- The [WORKFLOW.md reference](/reference/workflow-config/) lists every field and its default value.
</content>
</invoke>
