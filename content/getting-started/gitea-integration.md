---
title: Connect Sortie to Gitea
linkTitle: "Gitea Integration"
description: "Tutorial: stand up a local Gitea in a container, connect Sortie to it, poll for issues, process them with a mock agent, and watch Sortie update the label-driven state automatically."
author: Sortie AI
date: 2026-07-16
weight: 47
---
In this tutorial, we will stand up a throwaway Gitea in a container, connect Sortie to it, and watch it discover real issues, process them through a mock agent, and transition them by swapping labels. By the end, you will have a working Gitea integration that polls, dispatches, and hands off, with the whole tracker running on your own machine.

We use the mock agent on purpose. The quick start taught you how Sortie works with local files. This tutorial isolates the next variable, a real issue tracker, and nothing else. Once Gitea works, swapping in a real coding agent is one config change. And because Gitea is self-hosted, this is the one integration tutorial you can run end to end with no external account: the tracker is a container you start now and delete at the end.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](/getting-started/installation/))
- [Quick start](/getting-started/quick-start/) completed
- Docker running, to host the disposable Gitea
- `curl` and `jq`, to provision the instance over its API

{{% steps %}}

### Start a local Gitea

Everything here runs on your machine. We start Gitea in a container, create an account and a scoped access token, then seed a repository with two issues for Sortie to find.

Start the container and publish it on port 3000:

```bash
docker run -d --name sortie-gitea \
  -p 3000:3000 \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__service__DISABLE_REGISTRATION=true \
  docker.gitea.com/gitea:1.27.0-rootless
```

The two `-e` flags skip the first-run setup wizard and turn off open signup, so the API is usable the moment the instance boots. Docker prints the new container's id.

Give it a few seconds to come up, then confirm the API answers:

```bash
curl -s http://localhost:3000/api/v1/version
```

You should see the pinned version:

```json
{"version":"1.27.0"}
```

Create an admin user named `sortie`:

```bash
docker exec sortie-gitea gitea admin user create \
  --username sortie \
  --password 'Sortie-Integration-Pw1' \
  --email sortie@example.com \
  --admin \
  --must-change-password=false
```

The `--must-change-password=false` flag is load-bearing. Without it, Gitea forces the fresh account into a password-change state that blocks token creation. Gitea prints a confirmation that the user was created.

Now mint an access token for that user. Sortie needs three scopes: `write:issue` covers every issue, comment, and label operation, `read:user` backs the startup credential check, and `read:repository` backs the repository check. We capture the token into a shell variable:

```bash
TOKEN=$(curl -sS \
  -u sortie:'Sortie-Integration-Pw1' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/v1/users/sortie/tokens \
  -d '{"name":"sortie-integration","scopes":["write:issue","read:user","read:repository"]}' \
  | jq -r '.sha1')
```

Confirm you captured it:

```bash
echo "$TOKEN"
```

You should see a 40-character hex string. A Gitea token has no prefix, so this string is the whole credential.

Create the repository. This one call uses your username and password, because repository creation needs broader access than the token carries. Every call after it uses the token:

```bash
curl -sS -u sortie:'Sortie-Integration-Pw1' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/v1/user/repos \
  -d '{"name":"adapter-lab","private":false,"auto_init":true}' \
  | jq -r '.full_name'
```

This prints `sortie/adapter-lab`, the `owner/repo` you will point Sortie at.

Create the `backlog` label and capture its id, because the issue API attaches labels by id:

```bash
LABEL_BACKLOG=$(curl -sS -H "Authorization: token $TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:3000/api/v1/repos/sortie/adapter-lab/labels \
  -d '{"name":"backlog","color":"#cccccc"}' \
  | jq -r '.id')
```

Notice the `Authorization: token $TOKEN` header. Gitea reads the value straight after the word `token`, which is exactly how Sortie sends it.

Create two issues, both labeled `backlog`, for Sortie to discover:

```bash
for title in "Add a health-check endpoint" "Document the configuration options"; do
  jq -nc --arg t "$title" --argjson l "[$LABEL_BACKLOG]" '{title:$t, labels:$l}' \
    | curl -sS -H "Authorization: token $TOKEN" \
        -H 'Content-Type: application/json' \
        -X POST http://localhost:3000/api/v1/repos/sortie/adapter-lab/issues \
        -d @- | jq -r '"created #\(.number): \(.title)"'
done
```

You should see:

```
created #1: Add a health-check endpoint
created #2: Document the configuration options
```

Your local Gitea now has a repository and two open, labeled issues. Open `http://localhost:3000` in a browser and sign in as `sortie` with the password above to see them.

### Export the connection settings

Sortie reads its connection details from three environment variables. Export them now, reusing the `$TOKEN` you captured:

```bash
export SORTIE_GITEA_ENDPOINT="http://localhost:3000"
export SORTIE_GITEA_TOKEN="$TOKEN"
export SORTIE_GITEA_PROJECT="sortie/adapter-lab"
```

| Variable | Value | Role |
|---|---|---|
| `SORTIE_GITEA_ENDPOINT` | `http://localhost:3000` | Instance base URL. Sortie appends `/api/v1`. |
| `SORTIE_GITEA_TOKEN` | the token you minted | The access token. |
| `SORTIE_GITEA_PROJECT` | `sortie/adapter-lab` | The repository, as `owner/repo`. |

Sortie sends the token exactly as you stored it, in the `Authorization: token <key>` header, a lowercase `token` scheme rather than `Bearer`, with no transformation. Keep the value free of surrounding whitespace, or authentication fails.

Confirm the project resolved:

```bash
echo "$SORTIE_GITEA_PROJECT"
```

You should see `sortie/adapter-lab` printed back.

### Write the workflow file

Create a working directory and a `WORKFLOW.md` inside it:

```bash
mkdir sortie-gitea && cd sortie-gitea
```

Create `WORKFLOW.md` with this content:

```jinja {filename="WORKFLOW.md"}
---
tracker:
  kind: gitea
  endpoint: $SORTIE_GITEA_ENDPOINT
  api_key: $SORTIE_GITEA_TOKEN
  project: $SORTIE_GITEA_PROJECT
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

A few Gitea-specific lines to notice:

- `tracker.kind: gitea` selects the Gitea adapter instead of the local file adapter from the quick start.
- `endpoint` is required and has no default, because Gitea is self-hosted. You give the instance root, and Sortie appends `/api/v1`.
- `api_key` is your token. Sortie sends it verbatim in the `Authorization: token <key>` header, the same header you used with `curl` above.
- `project` is the repository in `owner/repo` form, the `sortie/adapter-lab` you created.
- `active_states` and `terminal_states` are repository label names, matched case-insensitively. Sortie creates a state label on demand the first time it moves an issue into that state, so you did not pre-create `review`. Watch it appear after the handoff.
- `handoff_state: review` moves each finished issue to the `review` label. Because `review` is not a terminal state, the issue stays open.
- `agent.kind: mock` runs the built-in mock agent, which simulates a session with no subprocess and no file changes. `max_turns: 1` gives it a single turn, enough to prove the loop.
- `polling.interval_ms: 30000` polls Gitea every 30 seconds, and `server.port: 8642` serves the dashboard at `http://localhost:8642`.

### Validate the configuration

Check the file before you run it:

```bash
sortie validate ./WORKFLOW.md
```

`sortie validate` runs entirely offline. It confirms the endpoint is present and well-formed, that `project` is a valid `owner/repo`, and that your active and terminal state lists do not overlap, and it warns if the token resolves empty. Because the local container speaks plain HTTP, you will see one advisory warning:

```
warning: tracker.endpoint.insecure: tracker.endpoint uses http; the token travels in cleartext, use https
```

That is expected for a disposable local instance, and it does not block anything. Validation never contacts Gitea, so it cannot tell you whether the token works or whether the repository exists. An invalid token or a mistyped repository instead fails the construction preflight the moment Sortie starts, when the adapter calls `GET /user` and `GET /repos/{owner}/{repo}`.

### Run Sortie

Start Sortie:

```bash
sortie ./WORKFLOW.md
```

You should see output like this:

```
level=INFO msg="sortie starting" version=0.x.x workflow_path=/home/you/sortie-gitea/WORKFLOW.md
level=INFO msg="database path resolved" db_path=/home/you/sortie-gitea/.sortie.db
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

The first `tick completed` line reports `candidates=2 dispatched=2`: Sortie found both `backlog` issues and started a mock session for each. The lines that follow trace issue 1 from workspace to handoff. Issue 2 moves through the identical sequence in the same tick, and because Sortie runs the two sessions concurrently, the two issues' lines interleave in your terminal. Each session removes the `backlog` label, adds `review`, and leaves the issue open, because `review` is not a terminal state. By the next poll, neither issue sits in an active state, so the second `tick completed` reports `candidates=0` and Sortie goes idle.

Press **Ctrl+C** to stop Sortie.

### Verify the results

Open the dashboard at `http://localhost:8642`. The run history shows the two completed mock sessions, one per issue.

Now open Gitea at `http://localhost:3000` and look at the two issues in `sortie/adapter-lab`. Each one now carries the `review` label instead of `backlog`, and both are still open, because `review` is not a terminal state. Notice a `review` label you never created: Sortie added it the first time it moved an issue into that state.

Here is the lifecycle you watched, end to end:

1. **Poll.** Sortie fetched the open issues from Gitea and matched the two labeled `backlog` against `active_states`.
2. **Dispatch.** It claimed each issue, prepared a workspace, and ran a one-turn mock session.
3. **Handoff.** When each session finished, Sortie removed the `backlog` label, created and applied the `review` label, and left the issue open.

{{% /steps %}}

## What we built

We connected Sortie to a live Gitea repository and ran the full orchestration cycle without wiring a real coding agent. Sortie polled the repository, matched the two `backlog` issues against `active_states`, ran a mock session for each, and transitioned each to `review` through the Gitea API, creating the `review` label along the way because the repository did not have it yet. The mock agent stood in for a real coding agent so we could confirm the tracker integration on its own.

Swapping the mock agent for a real coding agent is one change: set `agent.kind` to a coding-agent adapter and configure that section. The tracker configuration stays exactly as you wrote it. That swap is the subject of the [Gitea and OpenCode end-to-end tutorial](/getting-started/gitea-opencode-end-to-end/).

Because the entire tracker ran in a container, you can tear it all down with one command:

```bash
docker rm -f sortie-gitea
```

The container, its repository, and every issue and label go with it.

## Where to go next

- The [Gitea and OpenCode end-to-end tutorial](/getting-started/gitea-opencode-end-to-end/) swaps the mock agent for the OpenCode CLI, adds workspace hooks, and pushes code to a branch.
- [Connect Sortie to Gitea](/guides/connect-to-gitea/) scopes candidates with query filters, maps richer state sets, and points Sortie at an existing instance.
- [Write a prompt template](/guides/write-prompt-template/) gives a real agent detailed instructions from issue fields, conditionals, and template functions.
- The [Gitea adapter reference](/reference/adapter-gitea/) documents every tracker field, the label-driven state model, and the error mapping.
- The [WORKFLOW.md reference](/reference/workflow-config/) lists every field and its default value.
