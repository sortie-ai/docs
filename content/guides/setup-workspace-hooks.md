---
title: How to Set Up Workspace Hooks
linkTitle: "Set Up Workspace Hooks"
description: "Configure after_create, before_run, after_run, and before_remove hooks to automate git clone, branch management, and cleanup in Sortie workspaces."
author: Sortie AI
date: 2026-03-28
weight: 50
url: /guides/setup-workspace-hooks/
---
Hooks are shell scripts that run at specific points in a workspace's lifecycle: when it's created, before and after the agent runs, and before deletion. They handle the gap between "empty directory exists" and "workspace is ready for an agent to write code in."

## Prerequisites

- A working Sortie setup ([quick start](/getting-started/quick-start/))
- A git repository the orchestrator host can clone (SSH key or token access configured)

## Understand when each hook fires

Four hooks cover the workspace lifecycle. Each runs with the workspace directory as its working directory:

| Hook | Fires when | Failure effect |
|---|---|---|
| `after_create` | Workspace directory is created for the first time | Fatal: aborts workspace creation |
| `before_run` | Before each agent attempt, including retries | Fatal: aborts the current attempt |
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
  ├─ (retry: before_run → agent → after_run again)
  │
  └─ Issue reaches terminal state
      ├─ before_remove       ← push branch, clean up remote
      └─ Directory deleted
```

Notice that `after_create` runs once. `before_run` and `after_run` run on every attempt: first run, continuations, and retries.

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

Because `after_create` failure is fatal, a failed clone prevents the agent from running in a broken workspace. Sortie retries with backoff. The next attempt creates the workspace from scratch.

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

```yaml {hl_lines=[4]}
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

The `|| true` after `make fmt` prevents a formatter failure from producing noisy logs. `after_run` failures are ignored anyway, but clean logs are worth the guard.

`git diff --cached --quiet` checks whether there's anything to commit. If the agent made no changes (or the run failed before writing files), the hook exits cleanly without creating an empty commit.

## Clean up on workspace removal

`before_remove` fires whenever Sortie deletes a workspace directory, on either of the two grounds it removes one: the issue reached a terminal tracker state, or the workspace outlived the opt-in [`workspace.retention_days`](/reference/workflow-config/#workspace) window. Use it to clean up remote resources:

```yaml
hooks:
  before_remove: |
    git push origin --delete "sortie/${SORTIE_ISSUE_IDENTIFIER}" 2>/dev/null || true
```

The `2>/dev/null || true` suppresses errors when the branch doesn't exist remotely (for example, if the run never pushed). `before_remove` failures are logged and ignored. Cleanup still proceeds.

> [!NOTE]
> Workspace removal does not happen instantly when an issue reaches a terminal state. If the worker has already exited, Sortie detects the terminal state through a periodic sweep that runs every 60 poll ticks. With the default `polling.interval_ms: 30000`, cleanup happens within approximately 30 minutes; with `polling.interval_ms: 60000`, within approximately 60 minutes. On startup Sortie runs the terminal check alone, so a restart clears the workspaces of issues the tracker reports terminal and leaves everything else in place. A startup pass that cannot read tracker state removes nothing, and the age bound is evaluated only by the periodic sweep, never at startup.

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

- **POSIX (Linux, macOS):** `PATH`, `HOME`, `SHELL`, `TMPDIR`, `USER`, `LOGNAME`, `TERM`, `LANG`, `LC_ALL`, `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`
- **Windows:** `PATH`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `TEMP`, `TMP`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`

On POSIX systems, hooks execute via `sh -c`. On Windows, hooks execute via `cmd.exe /C`. If a hook needs additional credentials, expose them under a `SORTIE_` prefix in the Sortie process environment (for example, `SORTIE_DEPLOY_KEY`) or load them from a file inside the script.

## Start a service that outlives a hook

Sortie terminates every process a hook's shell leaves running in its process group when the hook exits, whatever its exit status, so a command backgrounded with `&` inside the script dies with the hook. This is deliberate: a process a previous `before_run` backgrounded and left running would collide with the one the next attempt starts. See [why hooks do not keep processes alive](/concepts/isolation/#why-hooks-do-not-keep-processes-alive) for the full reasoning.

If your `before_run` or `after_create` hook needs to start something that keeps running after the hook returns, such as a local database or a test double, start it through a supervisor outside the hook's process tree instead of backgrounding it.

The example below runs unchanged whether Sortie runs interactively on a Linux host or under the systemd service from [how to run Sortie as a systemd service](/guides/run-as-systemd-service/), with no edit to that unit's `[Service]` section. It does not apply inside any image built in [how to use Sortie in Docker](/guides/use-sortie-in-docker/): none of those images installs a `docker` CLI or mounts a daemon socket, so a hook running there has no route to Docker at all. For macOS, for Windows, or for the systemd-user and Windows-service routes, see the full [hook process lifetime](/reference/workflow-config/#hook-process-lifetime) table.

Reaching the daemon needs the account Sortie runs as to be a member of the `docker` group; [that group grants root-level privileges on the host](https://docs.docker.com/engine/install/linux-postinstall/), so add it deliberately:

```sh
sudo usermod -aG docker sortie   # or your own login, when running interactively
```

Group membership is read once, at process start: an interactive shell needs a fresh login and the systemd service needs a restart (`sudo systemctl restart sortie`) before either picks up the change. No edit to the unit file itself: `Group=sortie` in that unit sets only the process's primary group, and systemd still initializes its supplementary groups, `docker` included, from the account's own membership in `/etc/group`.

The example starts one PostgreSQL container shared by every workspace running concurrently on the host, the way a local integration-test database usually works; it is deliberately not workspace-scoped, so its name and port are fixed rather than unique per issue. Put the compose file at a fixed path outside every workspace and outside `/home`, since `ProtectHome=yes` hides `/home` from the systemd service entirely: `/etc/sortie/`, the directory that guide already uses for `WORKFLOW.md`, stays readable under `ProtectSystem=strict`, which makes the filesystem read-only rather than inaccessible.

```yaml
# /etc/sortie/docker-compose.test-postgres.yml
name: sortie-test-postgres
services:
  test-postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: test
```

Create the directory if it does not already exist, and start the container once, before Sortie needs it. Compose finds a project's containers by the label it attached to them, through the daemon both accounts share, not by which account ran the command, so this does not need to run as any particular user, only one that reaches the daemon:

```sh
sudo mkdir -p /etc/sortie
docker compose -f /etc/sortie/docker-compose.test-postgres.yml up -d
```

The top-level `name:` gives the project a fixed, predictable name instead of one Compose would otherwise derive from the directory holding the file. Run `up -d` once, by hand, not from a hook: `before_run` fires from every concurrently running workspace, and concurrent `docker compose up` invocations racing to create the same project can fail on a container-name conflict. The hook itself only starts the already-created container and waits for it:

```yaml
hooks:
  before_run: |
    set -e
    docker compose -f /etc/sortie/docker-compose.test-postgres.yml start
    until docker compose -f /etc/sortie/docker-compose.test-postgres.yml exec -T test-postgres pg_isready -U postgres >/dev/null 2>&1; do
      sleep 1
    done
```

`docker compose start` only starts a container that already exists; it never creates one, so concurrent hooks calling it at once are safe, and it recovers a container a host reboot left stopped. `set -e` fails the hook on a genuine error instead of letting the `pg_isready` loop spin to `hooks.timeout_ms`.

Because the container is shared, no single workspace's `before_remove` hook should stop it: doing so would pull the database out from under every other workspace still using it. Stop it independently of any hook, with `docker compose -f /etc/sortie/docker-compose.test-postgres.yml down`, when you decommission it.

For every supported platform and route (systemd user or system units, launchd via `brew services`, Windows services and Task Scheduler, and a container engine on any platform), with the prerequisite each one needs, see [hook process lifetime](/reference/workflow-config/#hook-process-lifetime) in the workflow configuration reference.

## Set a timeout

All hooks share a single timeout controlled by `hooks.timeout_ms`. The default is 60 seconds. For repositories that take longer to clone or have heavy dependency installs, increase it:

```yaml
hooks:
  after_create: |
    git clone git@github.com:acme/monorepo.git .
    npm ci
  timeout_ms: 180000
```

A timed-out hook is treated the same as a failure: fatal for `after_create` and `before_run`, ignored for `after_run` and `before_remove`.

## Put it all together

Here is a complete hooks configuration for a Go project tracked in Jira:

```yaml {hl_lines=[2,5,8,12]}
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

On the first dispatch, you should see the hook run during workspace creation:

```
level=INFO msg="running hook" issue_id=42 issue_identifier=PROJ-42 hook=after_create workspace=/tmp/sortie_workspaces/PROJ-42
level=INFO msg="workspace prepared" issue_id=42 issue_identifier=PROJ-42 workspace=/tmp/sortie_workspaces/PROJ-42
```

If a hook fails, the WARN record carries the error and the hook's combined stdout and stderr under `hook_output` (the last 8 KiB, prefixed with a truncation marker when earlier output was dropped):

```
level=WARN msg="after_create hook failed, rolling back workspace" issue_id=42 issue_identifier=PROJ-42 workspace=/tmp/sortie_workspaces/PROJ-42 error="hook run: exit_code=128: exit status 128" hook_output="fatal: repository 'git@github.com:acme/backend.git' not found"
```

A hook that succeeds while printing output logs it only at `--log-level debug`, on a `hook completed` record.

## Troubleshooting

**"Permission denied (publickey)" during clone.**
The SSH agent isn't available inside the hook. Verify that `SSH_AUTH_SOCK` is set in the Sortie process environment; it's on the allowlist and will pass through. Run `ssh -T git@github.com` as the same user that runs Sortie to confirm key access. If your git setup relies on a variable outside the allowlist, such as `GIT_SSH_COMMAND`, Sortie strips it; point SSH at the agent or `~/.ssh/config` instead.

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

**A service or helper started from a hook is gone after the hook finishes.**
A command backgrounded with `&` (or `nohup ... &`) inside a hook script does not outlive the hook: Sortie terminates it, along with everything else left in the hook's process group, the moment the hook exits. Sortie logs `leftover processes terminated after the command exited` at INFO when this happens. Start anything that must outlive the hook through a supervisor instead; see [start a service that outlives a hook](#start-a-service-that-outlives-a-hook) above.

For the full hooks schema, see the [WORKFLOW.md reference](/reference/workflow-config/). For hooks in SSH-distributed setups, see [scaling agents with SSH](/guides/scale-agents-with-ssh/).
