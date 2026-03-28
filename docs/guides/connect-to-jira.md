---
title: How to Connect Sortie to Jira Cloud | Sortie
description: "Configure Sortie to poll a Jira Cloud project: set up API authentication, map workflow states, scope queries with JQL filters, and verify the connection."
keywords: sortie jira, jira cloud, jira adapter, api token, jql, workflow states, tracker configuration, connect jira
author: Sortie AI
---

# How to connect Sortie to Jira Cloud

This guide configures Sortie to poll issues from a Jira Cloud project, dispatch agents, and transition issues through your Jira workflow. By the end, you'll have a working `WORKFLOW.md` that authenticates against your Jira instance, fetches the right issues, and reports back status changes.

## Prerequisites

- Sortie installed and on your `PATH` ([installation guide](../getting-started/installation.md))
- Quick start completed with the file adapter ([quick start](../getting-started/quick-start.md))
- A **Jira Cloud** instance (Server and Data Center are not supported — the adapter uses REST API v3, which is Cloud-only)
- An API token from [Atlassian account settings → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
- Your Jira project key (the prefix on issue identifiers — `PROJ` in `PROJ-42`)
- The workflow status names used in your project (e.g., "To Do", "In Progress", "Done")

## Create the API token

Generate a token in your Atlassian account settings. Sortie authenticates with Basic Auth, which requires your **email address and the token joined by a colon**:

```
you@company.com:your-api-token-here
```

Both parts must be non-empty. Sortie validates this format at startup and rejects values without a colon or with an empty side.

Store the credentials in environment variables:

```bash
export SORTIE_JIRA_ENDPOINT="https://yourcompany.atlassian.net"
export SORTIE_JIRA_API_KEY="you@company.com:your-api-token-here"
```

The endpoint is the base URL of your Jira instance — no `/rest/api/...` suffix. Sortie rejects endpoints that include an API path.

## Write the minimum configuration

Replace the `tracker` section in your `WORKFLOW.md` front matter:

```jinja
---
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  active_states: [To Do, In Progress]
  terminal_states: [Done]

agent:
  kind: claude-code
---

Fix {{ .issue.identifier }}: {{ .issue.title }}
```

Three fields are required:

- **`endpoint`** — Jira Cloud base URL. Sortie strips trailing slashes.
- **`api_key`** — `email:token` format. Sent as a Base64-encoded Basic Auth header on every request.
- **`project`** — Jira project key. Must not be empty.

The `$VAR` syntax expands environment variables at config load time. `endpoint` and `project` expand only when the entire value is a variable reference (`$VAR` or `${VAR}`). `api_key` expands variables anywhere in the string, so `$SORTIE_JIRA_API_KEY` works both ways.

If you omit `active_states`, Sortie defaults to `["Backlog", "Selected for Development", "In Progress"]`. Override this to match your project's actual workflow status names. State names are compared **case-insensitively** — `"to do"` matches Jira's `"To Do"`.

## Scope issues with a query filter

By default, Sortie fetches all issues in `active_states` for the project. The `query_filter` field appends a raw JQL fragment to narrow the result:

```yaml
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  query_filter: "labels = 'agent-ready'"
  active_states: [To Do, In Progress]
  terminal_states: [Done]
```

Sortie wraps your fragment in `AND (...)` and appends it to the base query. The resulting JQL for this example:

```
project = "PROJ" AND status IN ("To Do", "In Progress") AND (labels = 'agent-ready') ORDER BY priority ASC, created ASC
```

Other useful filters:

```yaml
# Only backend issues
query_filter: "component = Backend"

# Only issues assigned to me
query_filter: "assignee = currentUser()"

# Combination
query_filter: "component = Backend AND assignee = currentUser()"
```

The filter applies to candidate fetches and state-change polls. It does **not** apply to reconciliation lookups (ID-based fetches of issues already dispatched) because those issues already passed filtering at dispatch time.

## Configure handoff state

When an agent completes its work, Sortie can transition the issue to a specific state — a review column, a QA queue, or any reachable status in your Jira workflow:

```yaml
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  active_states: [To Do, In Progress]
  handoff_state: Human Review
  terminal_states: [Done]
```

Sortie uses the Jira transitions API: it fetches available transitions for the issue, finds one whose target status matches `handoff_state` (case-insensitive), and executes it. If no matching transition exists — because the Jira workflow doesn't allow it from the current status — Sortie logs an error:

```
level=ERROR msg="transition failed" error="tracker: tracker_payload: no transition to state \"Human Review\" available for issue PROJ-42"
```

Two constraints:

- `handoff_state` must not collide with any value in `terminal_states`. Sortie rejects this at startup.
- The transition must be available from the issue's current Jira status. Check your Jira workflow diagram if transitions fail.

## Configure dispatch-time transitions

Sortie can also transition an issue when the agent *picks it up* — moving it to an "In Progress" column so your team sees work has started:

```yaml
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PROJ
  active_states: [To Do, In Progress]
  in_progress_state: In Progress
  handoff_state: Human Review
  terminal_states: [Done]
```

`in_progress_state` must be a value in `active_states`. If the issue is already in that state at dispatch time, the transition is skipped (debug log only). If the transition fails for other reasons — for example, the Jira workflow doesn't allow it — Sortie logs a warning and continues. The agent session proceeds regardless.

Three constraints:

- `in_progress_state` must appear in `active_states`. Otherwise reconciliation would cancel the worker after the state change.
- `in_progress_state` must not collide with `terminal_states` or `handoff_state`.
- The API token needs write permissions (same as `handoff_state`).

## Enable tracker comments

Sortie can post comments on Jira issues at session lifecycle points — dispatch, completion, and failure. This creates a visible audit trail in the ticket without leaving Jira:

```yaml
tracker:
  # ... existing fields ...
  comments:
    on_dispatch: true
    on_completion: true
    on_failure: true
```

Each flag is independent. Enable only the events you care about. All default to `false`.

Comment failures are non-fatal — Sortie logs a warning and continues. The API token needs the same write permissions as `handoff_state` (`write:jira-work` or `write:issue:jira`).

See the [workflow config reference](../reference/workflow-config.md) for comment content details.

## Verify the connection

### Validate syntax

Check your configuration without making API calls:

```bash
sortie validate ./WORKFLOW.md
```

This parses front matter, compiles the prompt template, and runs preflight checks. It catches missing fields, bad `email:token` format, and env vars that resolve to empty strings.

### Test connectivity

Run a single poll cycle without dispatching agents:

```bash
sortie --dry-run ./WORKFLOW.md
```

Watch the logs. A successful poll produces:

```
level=INFO msg="tick completed" candidates=3 dispatched=0 running=0 retrying=0
```

`candidates=3` means Sortie found 3 issues in your active states (and matching your `query_filter`, if set). `dispatched=0` is expected in dry-run mode — no agents are launched.

If `candidates=0` and you expected results, check that your `active_states` values match Jira's status names exactly (comparison is case-insensitive, but the names must otherwise match) and that your `query_filter` JQL is valid.

## Troubleshoot authentication and API errors

### Wrong credentials or expired token

```
level=ERROR msg="poll failed" error="tracker: tracker_auth_error: GET /rest/api/3/search/jql: 401"
```

Verify your token is valid by testing it directly:

```bash
curl -s -u "you@company.com:your-api-token" \
  "https://yourcompany.atlassian.net/rest/api/3/myself" | head -5
```

If this returns your user profile, the token works. If it returns 401, regenerate the token.

### CAPTCHA lockout

```
level=ERROR msg="poll failed" error="tracker: tracker_auth_error: GET /rest/api/3/search/jql: 401 (CAPTCHA challenge triggered — log in via browser to resolve)"
```

Jira locked the account after repeated failed attempts. Log in to Jira through a browser, complete the CAPTCHA, then restart Sortie.

### Project not found

```
level=ERROR msg="poll failed" error="tracker: tracker_not_found: GET /rest/api/3/search/jql: not found"
```

The `project` key doesn't match any project in your Jira instance. Verify the key in Jira's project settings — it's the short prefix, not the project name.

### Rate limiting

```
level=WARN msg="poll failed" error="tracker: tracker_api: GET /rest/api/3/search/jql: rate limited (retry after 30 seconds)"
```

Jira enforces rate limits on API calls. Sortie does not throttle client-side — it logs the response and waits for the next poll interval. If you hit this repeatedly, increase `polling.interval_ms` or narrow your `query_filter` to reduce result set size. Sortie paginates with a page size of 50, so large projects generate multiple API calls per poll.

### Unreachable handoff transition

```
level=ERROR msg="transition failed" error="tracker: tracker_payload: no transition to state \"Human Review\" available for issue PROJ-42"
```

The target state isn't reachable from the issue's current status in your Jira workflow. Open the Jira workflow editor and confirm that a transition exists from the expected source status to your `handoff_state`.

## Full production example

```jinja
---
tracker:
  kind: jira
  endpoint: $SORTIE_JIRA_ENDPOINT
  api_key: $SORTIE_JIRA_API_KEY
  project: PLATFORM
  query_filter: "labels = 'agent-ready'"
  active_states:
    - To Do
    - In Progress
  in_progress_state: In Progress
  handoff_state: Human Review
  terminal_states:
    - Done
    - Won't Do

polling:
  interval_ms: 60000

workspace:
  root: ~/workspace/sortie

agent:
  kind: claude-code
  max_turns: 3
---

You are a senior engineer. Your work is tracked by Sortie.

## Task

**{{ .issue.identifier }}**: {{ .issue.title }}
{{ if .issue.description }}

### Description

{{ .issue.description }}
{{ end }}
{{ if .issue.labels }}
**Labels:** {{ .issue.labels | join ", " }}
{{ end }}
{{ if .issue.url }}
**Ticket:** {{ .issue.url }}
{{ end }}
```

This configuration polls every 60 seconds, picks up issues labeled `agent-ready` in "To Do" or "In Progress," runs up to 3 agent turns per issue, and moves completed issues to "Human Review." For the full set of configuration options, see the [WORKFLOW.md reference](../reference/workflow-config.md). For prompt template syntax, see [How to write a prompt template](write-prompt-template.md).
