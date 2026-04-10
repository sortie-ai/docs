---
title: How to Set Up Workspace Hooks
linkTitle: "Set Up Workspace Hooks"
description: "Configure after_create, before_run, after_run, and before_remove hooks to automate git clone, branch management, dependency install, and cleanup in Sortie workspaces."
keywords: sortie hooks, workspace hooks, after_create, before_run, after_run, before_remove, git clone, branch creation, workspace lifecycle, WORKFLOW.md hooks
author: Sortie AI
date: 2026-03-28
weight: 50
url: /guides/setup-workspace-hooks/
---
Hooks are shell scripts that run at specific points in a workspace's lifecycle — when it's created, before and after the agent runs, and before deletion. They handle the gap between "empty directory exists" and "workspace is ready for an agent to write code in."

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- A git repository the orchestrator host can clone (SSH key or token access configured)

## Understand when each hook fires

Four hooks cover the workspace lifecycle. Each runs with the workspace directory as its working directory:

| Hook | Fires when | Failure effect |
|---|---|---|
| `after_create` | Workspace directory is created for the first time | Fatal — aborts workspace creation |
| `before_run` | Before each agent attempt, including retries | Fatal — aborts the current attempt |
| `after_run` | After each agent attempt (success or failure) | Logged, ignored |
| `before_remove` | Before workspace deletion | Logged, ignored |

A typical issue lifecycle looks like this:

```
Issue dispatched
  │
  ├─ Directory created (first time)
  │   └─ after_create        ← clone repo, install deps
  │
  ├─ before_run              ← create branch, pull latest
  │   └─ Agent runs...
  │       └─ after_run       ← commit changes, run formatter
  │
  ├─ (retry — before_run → agent → after_run again)
  │
  └─ Issue reaches terminal state
      ├─ before_remove       ← push branch, clean up remote
      └─ Directory deleted
```

Notice that `after_create` runs once. `before_run` and `after_run` run on every attempt — first run, continuations, and retries.

## Clone a repository on workspace creation

The most common `after_create` hook clones your project into the fresh workspace directory:

```yaml
hooks:
  after_create: |
    git clone --depth 1 git@github.com:acme/backend.git .
```

The trailing `.` clones into the current directory (which is the workspace). `--depth 1` keeps clones fast by fetching only the latest commit.

If the project needs dependencies after cloning, chain the commands:

```yaml
hooks:
  after_create: |
    git clone --depth 1 git@github.com:acme/backend.git .
    go mod download
```

Because `after_create` failure is fatal, a failed clone prevents the agent from running in a broken workspace. Sortie retries with backoff — the next attempt creates the workspace from scratch.

## Create a branch before each run

`before_run` fires before every agent attempt. Use it to set up a clean branch so each attempt starts from the latest upstream code:

```yaml
hooks:
  before_run: |
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
```

`git checkout -B` creates or resets the branch. On the first run, it creates `sortie/PROJ-42`. On a retry, it resets that branch to the latest `main`, discarding the failed attempt's changes. This gives each attempt a clean starting point.

If your workflow needs to preserve changes across retries, skip the reset and merge instead:

```yaml
hooks:
  before_run: |
    git fetch origin main
    if [ "$SORTIE_ATTEMPT" -gt 0 ]; then
      git checkout "sortie/${SORTIE_ISSUE_IDENTIFIER}"
      git merge origin/main --no-edit || git merge --abort
    else
      git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
    fi
```

## Commit and format after each run

`after_run` fires after every agent attempt regardless of outcome. Use it to preserve the agent's work:

```yaml
hooks:
  after_run: |
    make fmt 2>/dev/null || true
    git add -A
    git diff --cached --quiet || git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
```

The `|| true` after `make fmt` prevents a formatter failure from producing noisy logs — `after_run` failures are ignored anyway, but clean logs are worth the guard.

`git diff --cached --quiet` checks whether there's anything to commit. If the agent made no changes (or the run failed before writing files), the hook exits cleanly without creating an empty commit.

## Clean up on workspace removal

`before_remove` fires when Sortie deletes a workspace directory — typically after the issue reaches a terminal state. Use it to clean up remote resources:

```yaml
hooks:
  before_remove: |
    git push origin --delete "sortie/${SORTIE_ISSUE_IDENTIFIER}" 2>/dev/null || true
```

The `2>/dev/null || true` suppresses errors when the branch doesn't exist remotely (for example, if the run never pushed). `before_remove` failures are logged and ignored — cleanup still proceeds.

## Use hook environment variables

Every hook receives these variables from the orchestrator:

| Variable | Example | Description |
|---|---|---|
| `SORTIE_ISSUE_ID` | `10042` | Tracker-internal issue ID |
| `SORTIE_ISSUE_IDENTIFIER` | `PROJ-42` | Human-readable ticket key |
| `SORTIE_WORKSPACE` | `/tmp/sortie_workspaces/PROJ-42` | Absolute workspace path |
| `SORTIE_ATTEMPT` | `0` | Current attempt number (`0` on first dispatch, `1` on first retry, increments after that) |
| `SORTIE_SSH_HOST` | `build-07` | SSH host allocated for this issue. **Present only when SSH mode is active** ([scale agents with SSH](/guides/scale-agents-with-ssh/)). Absent in local mode. |

Hooks run in a restricted environment. Only a small set of system variables and variables prefixed with `SORTIE_` are available. Secrets like `JIRA_API_TOKEN` are stripped. The allowed system variables differ by platform:

- **POSIX (Linux, macOS):** `PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`
- **Windows:** `PATH`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`

On POSIX systems, hooks execute via `sh -c`. On Windows, hooks execute via `cmd.exe /C`. If a hook needs additional credentials, expose them under a `SORTIE_` prefix in the Sortie process environment (for example, `SORTIE_DEPLOY_KEY`) or load them from a file inside the script.

## Set a timeout

All hooks share a single timeout controlled by `hooks.timeout_ms`. The default is 60 seconds. For repositories that take longer to clone or have heavy dependency installs, increase it:

```yaml
hooks:
  after_create: |
    git clone git@github.com:acme/monorepo.git .
    npm ci
  timeout_ms: 180000
```

A timed-out hook is treated the same as a failure — fatal for `after_create` and `before_run`, ignored for `after_run` and `before_remove`.

## Put it all together

Here is a complete hooks configuration for a Go project tracked in Jira:

```yaml
hooks:
  after_create: |
    git clone --depth 1 $SORTIE_REPO_URL .
    go mod download
  before_run: |
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
  after_run: |
    make fmt 2>/dev/null || true
    git add -A
    git diff --cached --quiet || git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
  before_remove: |
    git push origin --delete "sortie/${SORTIE_ISSUE_IDENTIFIER}" 2>/dev/null || true
  timeout_ms: 120000
```



## Verify hooks are running

Start Sortie and watch the logs for hook activity:

```bash
sortie ./WORKFLOW.md
```

On the first dispatch, you should see workspace creation followed by the hook:

```
level=INFO msg="workspace prepared" issue_id=42 issue_identifier=PROJ-42 workspace=/tmp/sortie_workspaces/PROJ-42
```

If a hook fails, the logs show the error and output:

```
level=ERROR msg="after_create hook failed" issue_id=42 issue_identifier=PROJ-42 error="exit status 128" output="fatal: repository 'git@...' not found"
```

## Troubleshooting

**"Permission denied (publickey)" during clone.**
The SSH agent isn't available inside the hook. Verify that `SSH_AUTH_SOCK` is set in the Sortie process environment — it's on the allowlist and will pass through. Run `ssh -T git@github.com` as the same user that runs Sortie to confirm key access.

**Hook works locally but fails under Sortie.**
Hooks run in a restricted environment. Commands that depend on `~/.bashrc` (like `nvm` or `pyenv`) won't find their shims. Wrap them with `bash -lc '...'` to source the login profile:

```yaml
hooks:
  after_create: |
    git clone --depth 1 git@github.com:acme/frontend.git .
    bash -lc 'nvm use 20 && npm ci'
```

**Timeout on large repositories.**
Increase `hooks.timeout_ms`. Use `git clone --depth 1` or `git clone --filter=blob:none` for faster clones.

For the full hooks schema, see the [WORKFLOW.md reference](/reference/workflow-config/). For hooks in SSH-distributed setups, see [scaling agents with SSH](/guides/scale-agents-with-ssh/).
