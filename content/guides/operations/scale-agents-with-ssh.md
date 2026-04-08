---
title: How to Scale Agents with SSH
description: "Distribute autonomous coding agent sessions across remote build machines using SSH. Configure host pools, update hooks, and monitor utilization."
keywords: sortie ssh, remote agents, scale agents, autonomous coding agent, ssh workers, host pool, distributed agents, build machines, concurrent agents
author: Sortie AI
date: 2026-03-26
weight: 60
url: /guides/scale-agents-with-ssh/
---

# How to scale agents with SSH

Distribute agent sessions across a pool of remote build machines so your orchestrator host stops being the bottleneck.

## Prerequisites

- A working Sortie setup (the [quick start](/getting-started/quick-start/) covers this)
- SSH key-based access from the orchestrator host to each build machine — no password prompts
- The agent binary (e.g., `claude`) installed and on `PATH` on every remote host
- `~/.ssh/config` entries or DNS for your build hosts (recommended but not required)

> [!NOTE]
> Remote build hosts must run a POSIX operating system (Linux, macOS). The orchestrator can run on any platform including Windows, but the remote command execution assumes a POSIX shell on the target host.

Verify connectivity before touching any Sortie config:

```bash
ssh build01.internal "which claude && echo ok"
```

Expected output:

```
/usr/local/bin/claude
ok
```

If that fails, fix your SSH setup first. Sortie delegates to the system `ssh` binary and inherits your full SSH configuration — `ProxyJump` bastions, FIDO2 keys, agent forwarding all work without Sortie-specific config.

## Add the worker extension

Open your `WORKFLOW.md` and add an [`extensions.worker`](/reference/workflow-config/) block to the YAML front matter. List your SSH hosts and set a per-host concurrency cap:

```yaml
# WORKFLOW.md (front matter excerpt)
extensions:
  worker:
    ssh_hosts:
      - "build01.internal"
      - "build02.internal"
    max_concurrent_agents_per_host: 2
```

This tells Sortie to run agents on `build01` and `build02` instead of locally. Each host accepts up to 2 concurrent sessions, giving you 4 total agent slots across the pool. Sortie picks the least-loaded host for each new dispatch.

If you also have `agent.max_concurrent_agents` set, total concurrency is the lower of the two limits. With `max_concurrent_agents: 3` and two hosts at 2 each, you get 3 concurrent agents — the global cap wins.

## Update hooks for remote execution

Sortie runs the agent command remotely over SSH, but hooks still execute locally on the orchestrator. When SSH mode is active, Sortie injects `SORTIE_SSH_HOST` into every hook's environment with the hostname assigned to that issue.

Your hooks need to use this variable to prepare and clean up remote workspaces. Here is a complete set:

```yaml
# WORKFLOW.md (front matter excerpt)
hooks:
  after_create: |
    if [ -n "$SORTIE_SSH_HOST" ]; then
      ssh "$SORTIE_SSH_HOST" "mkdir -p \"$SORTIE_WORKSPACE\""
      ssh "$SORTIE_SSH_HOST" "cd \"$SORTIE_WORKSPACE\" && git clone --depth 1 git@github.com:acme/backend.git ."
    else
      git clone --depth 1 git@github.com:acme/backend.git .
    fi
  before_run: |
    if [ -n "$SORTIE_SSH_HOST" ]; then
      ssh "$SORTIE_SSH_HOST" "cd \"$SORTIE_WORKSPACE\" && git fetch origin main && git checkout -B sortie/${SORTIE_ISSUE_IDENTIFIER} origin/main"
    else
      git fetch origin main
      git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main
    fi
  after_run: |
    if [ -n "$SORTIE_SSH_HOST" ]; then
      ssh "$SORTIE_SSH_HOST" "cd \"$SORTIE_WORKSPACE\" && git add -A && git diff --cached --quiet || git commit -m 'sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes'"
    else
      git add -A
      git diff --cached --quiet || git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
    fi
  before_remove: |
    if [ -n "$SORTIE_SSH_HOST" ]; then
      ssh "$SORTIE_SSH_HOST" "rm -rf \"$SORTIE_WORKSPACE\""
    fi
  timeout_ms: 120000
```

The `if [ -n "$SORTIE_SSH_HOST" ]` guard keeps your hooks working in both modes. When running locally (no `ssh_hosts` configured), `SORTIE_SSH_HOST` is absent and the `else` branch runs. This means you can test locally and deploy with SSH hosts using the same `WORKFLOW.md`.

Note the quotes around `$SORTIE_WORKSPACE` in the remote commands. Workspace paths can contain characters that break unquoted shell expansion.

## Start Sortie and verify

Restart Sortie the same way you normally would:

```bash
sortie ./WORKFLOW.md
```

Watch for the SSH mode confirmation in the startup logs:

```
level=INFO msg="SSH worker mode enabled" host_count=2 max_per_host=2
```

If you see this instead, something is wrong with your config:

```
level=WARN msg="max_concurrent_agents_per_host has no effect without worker.ssh_hosts"
```

That warning means you set `max_concurrent_agents_per_host` but forgot `ssh_hosts`, or the YAML nesting is off.

When Sortie dispatches an issue, the logs show which host was selected:

```
level=INFO msg="workspace prepared" issue_id=42 issue_identifier=PROJ-42 workspace=/tmp/sortie_workspaces/PROJ-42 ssh_host=build01.internal
level=INFO msg="agent session started" issue_id=42 issue_identifier=PROJ-42 session_id=session-abc ssh_host=build01.internal
```

## Monitor host utilization

Sortie exposes per-host usage through two channels.

**The state API** returns `ssh_host` on each running session. Hit the endpoint while agents are active:

```bash
curl -s localhost:8080/api/v1/state | jq '.running[] | {identifier, ssh_host}'
```

```json
{"identifier": "PROJ-42", "ssh_host": "build01.internal"}
{"identifier": "PROJ-43", "ssh_host": "build02.internal"}
```

**Prometheus metrics** expose a gauge per host:

```
sortie_ssh_host_usage{host="build01.internal"} 2
sortie_ssh_host_usage{host="build02.internal"} 1
```

Use this to alert on hosts nearing capacity or to right-size your `max_concurrent_agents_per_host` setting.

## Configure SSH host key checking

Sortie uses `StrictHostKeyChecking=accept-new` by default: the first connection to a new host accepts its key on trust, and subsequent connections reject key changes. This works for most setups, but your environment may need a different policy.

Add `ssh_strict_host_key_checking` to the `worker` block:

```yaml
extensions:
  worker:
    ssh_hosts:
      - "build01.internal"
      - "build02.internal"
    max_concurrent_agents_per_host: 2
    ssh_strict_host_key_checking: "yes"
```

### If you manage `known_hosts` externally

Production environments where host keys are baked into VM images or distributed through configuration management (Ansible, Puppet, Chef) should use `yes`. SSH refuses connections to any host whose key is not already in `known_hosts`. If someone impersonates a host (MITM), the connection fails.

```yaml
    ssh_strict_host_key_checking: "yes"
```

Make sure `known_hosts` on the orchestrator host contains entries for every host in `ssh_hosts` before starting Sortie. Missing entries cause immediate connection failures — there is no interactive prompt to accept the key.

### If your hosts are stable but you don't manage keys

Keep the default. Omit the field or set it explicitly:

```yaml
    ssh_strict_host_key_checking: "accept-new"
```

The first connection to each host accepts the key automatically. Changed keys are rejected on subsequent connections. This is the current behavior and requires no action.

### If your hosts are ephemeral

CI runners, auto-scaled spot instances, and test VMs that get rebuilt frequently reuse IP addresses with new host keys. Use `no` to prevent `known_hosts` mismatches from breaking connections:

```yaml
    ssh_strict_host_key_checking: "no"
```

> [!WARNING]
> `no` disables MITM protection entirely. Use it only in isolated networks where you trust the infrastructure between the orchestrator and the build hosts.

For the full list of allowed values, see the [worker configuration reference](/reference/workflow-config/#worker).

## Handle SSH failures

SSH connection problems (exit code 255) are transient infrastructure failures. Sortie retries them automatically with exponential backoff. The retry uses host affinity — it prefers dispatching back to the same host, but falls back to the least-loaded alternative if that host is at capacity or unreachable.

A remote "command not found" error (exit code 127) is fatal. It means the agent binary is missing on that host. Sortie will not retry this. Check that `claude` (or your configured `agent.command`) is installed and on `PATH` for the SSH user.

## What we configured

You now have a Sortie setup where the orchestrator runs on one machine and agent sessions execute across remote build hosts. The orchestrator handles dispatch, retry, and state tracking. The build machines handle the CPU and I/O of running agents.

The key pieces:

- **`extensions.worker.ssh_hosts`** — the pool of remote machines
- **`extensions.worker.max_concurrent_agents_per_host`** — per-host concurrency cap
- **`extensions.worker.ssh_strict_host_key_checking`** — SSH host key verification policy (`accept-new`, `yes`, or `no`)
- **`SORTIE_SSH_HOST`** in hooks — the bridge between local orchestration and remote preparation
- **Least-loaded dispatch** — Sortie balances work across hosts automatically
- **Retry affinity** — failed sessions prefer the same host on retry, avoiding redundant workspace setup

For the full SSH configuration schema, see the [WORKFLOW.md reference](/reference/workflow-config/). For environment variables injected into hooks during SSH dispatch, see the [environment variables reference](/reference/environment/).
