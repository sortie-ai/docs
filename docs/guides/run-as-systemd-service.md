---
title: "How to Run Sortie as a systemd Service | Sortie"
description: "Configure Sortie as a persistent systemd service on Linux with a dedicated user, hardened unit file, journald logging, and zero-downtime upgrades."
keywords: sortie systemd, linux service, unit file, journald, daemonize, production deploy, systemctl, hardening
author: Sortie AI
---

# How to run Sortie as a systemd service

Set up Sortie as a managed systemd service so it starts on boot, restarts on failure, and logs through journald — no terminal session required.

## Prerequisites

- Sortie installed at `/usr/local/bin/sortie` ([installation guide](../getting-started/installation.md))
- A working `WORKFLOW.md` you've tested from the command line
- A Linux system running systemd (Ubuntu 20.04+, Debian 11+, RHEL 8+, or equivalent)
- Root or sudo access

## Create a dedicated user

Sortie should not run as root. Create a system user with no login shell:

```bash
sudo useradd --system --shell /usr/sbin/nologin --create-home sortie
```

This creates a `sortie` user whose home directory exists but can't be logged into interactively. The `--system` flag assigns a UID below 1000, which keeps it out of login screens and user listings.

## Set up the directory structure

Sortie needs three things on disk: a workflow file, a database, and a workspace root. Place them under predictable system paths:

```bash
sudo mkdir -p /etc/sortie
sudo mkdir -p /var/lib/sortie/workspaces
sudo chown -R sortie:sortie /var/lib/sortie
```

Copy your tested workflow file into `/etc/sortie/`:

```bash
sudo cp ~/my-project/WORKFLOW.md /etc/sortie/WORKFLOW.md
```

Edit the workflow file to use absolute paths. The `sortie` user has no interactive home directory to resolve `~` against, and relative paths resolve against the working directory — which under systemd is `/`.

```yaml
# /etc/sortie/WORKFLOW.md (front matter excerpt)
---
workspace:
  root: /var/lib/sortie/workspaces
db_path: /var/lib/sortie/sortie.db
# ... rest of your config
---
```

The database file is created automatically on first run. The workspace directory is where Sortie clones repos and runs agents — it needs to be writable by the `sortie` user.

## Configure environment variables

Sortie and its agent subprocesses inherit the process environment. Secrets like API keys belong in a dedicated environment file that systemd loads at service start.

Create `/etc/sortie/env`:

```bash
sudo touch /etc/sortie/env
sudo chmod 600 /etc/sortie/env
sudo chown sortie:sortie /etc/sortie/env
```

Add your secrets:

```bash
# /etc/sortie/env
ANTHROPIC_API_KEY=sk-ant-api03-abc123...
SORTIE_JIRA_ENDPOINT=https://mycompany.atlassian.net
SORTIE_JIRA_API_KEY=deploy-bot@mycompany.com:xyztoken123
```

The `chmod 600` ensures only the `sortie` user can read the file. Agent subprocesses inherit these variables automatically — no extra forwarding is needed.

## Write the unit file

Create `/etc/systemd/system/sortie.service`:

```ini
[Unit]
Description=Sortie Agent Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sortie
Group=sortie
EnvironmentFile=/etc/sortie/env
ExecStart=/usr/local/bin/sortie --port 8080 /etc/sortie/WORKFLOW.md
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=sortie

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/sortie
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

A few things worth noting about this configuration:

**`Type=simple`** — Sortie runs as a foreground process and does not fork. systemd tracks the main process directly.

**`Restart=on-failure` with `RestartSec=10`** — If Sortie crashes, systemd waits 10 seconds and restarts it. A clean shutdown via `systemctl stop` sends SIGTERM, which Sortie handles gracefully — that does not trigger a restart.

**`StandardOutput=journal` and `StandardError=journal`** — Sortie logs structured `key=value` output to stderr. journald captures both streams and makes them searchable via `journalctl`.

**`ProtectSystem=strict`** — Makes the entire filesystem read-only from Sortie's perspective. `ReadWritePaths=/var/lib/sortie` punches a hole for the database and workspace directory. If your workspace root lives elsewhere (say `/opt/sortie/workspaces`), add that path to `ReadWritePaths` instead.

**`ProtectHome=yes`** — Blocks access to `/home`, `/root`, and `/run/user`. If your workspace root is under `/home`, replace `ProtectHome=yes` with `ReadWritePaths=/home/sortie/workspaces` (or wherever it lives).

**`NoNewPrivileges=yes`** and **`PrivateTmp=yes`** — Prevents privilege escalation and gives the service its own `/tmp`. Both are low-risk hardening options that work with any application.

## Enable and start the service

Reload systemd's unit file cache, enable the service to start on boot, and start it now:

```bash
sudo systemctl daemon-reload
sudo systemctl enable sortie
sudo systemctl start sortie
```

Check that it's running:

```bash
sudo systemctl status sortie
```

You should see `Active: active (running)` and the first few log lines. If Sortie started with `--port 8080`, the dashboard is live at `http://localhost:8080`.

## View logs

All log output flows through journald. No log files to manage, no rotation to configure.

```bash
# Follow logs in real time
journalctl -u sortie -f

# Last 100 lines
journalctl -u sortie -n 100

# Everything since the last boot
journalctl -u sortie -b
```

Sortie's structured `key=value` format works well with `grep`:

```bash
# Find all errors
journalctl -u sortie | grep 'level=ERROR'

# Track a specific issue
journalctl -u sortie | grep 'issue_identifier=PROJ-42'
```

For deeper troubleshooting, add `--log-level debug` to `ExecStart` in the unit file, then restart the service. See [How to monitor with logs](monitor-with-logs.md) for grep patterns and lifecycle messages.

## Run multiple workflows

Each Sortie process handles one workflow file. To orchestrate multiple projects, create separate unit files — one per workflow:

```
sortie-billing.service   → /etc/sortie/billing/WORKFLOW.md
sortie-platform.service  → /etc/sortie/platform/WORKFLOW.md
```

Each service needs its own `db_path`, `workspace.root`, and `server.port`. The unit files are identical in structure, differing only in `ExecStart` and `EnvironmentFile` paths.

See [How to run multiple workflows](run-multiple-workflows.md) for the full isolation rules and a worked example.

## Update the binary

Sortie persists all state — run history, retry schedules, session metadata — in SQLite. Stopping and restarting loses nothing. In-flight agent sessions are drained gracefully on stop and can resume on the next start.

The upgrade pattern:

```bash
sudo systemctl stop sortie
sudo cp /path/to/sortie-new /usr/local/bin/sortie
sudo systemctl start sortie
```

If you installed via the install script, download the new version first:

```bash
curl -sSL https://get.sortie-ai.com/install.sh | sudo sh
sudo systemctl restart sortie
```

Verify the new version is running:

```bash
journalctl -u sortie -n 5 | grep version
```

You'll see the version in the startup log line:

```
level=INFO msg="sortie starting" version=0.1.0 workflow_path=/etc/sortie/WORKFLOW.md port=8080
```

## What we configured

A production-ready Sortie deployment running as a systemd service with:

- A dedicated `sortie` system user with no login shell
- Workflow config in `/etc/sortie/`, state and workspaces in `/var/lib/sortie/`
- Secrets loaded from an environment file with restricted permissions
- A hardened unit file that limits filesystem access to what Sortie needs
- Automatic restart on failure, logs via journald, and startup on boot

For monitoring beyond logs, see [How to monitor with Prometheus](monitor-with-prometheus.md). For the full set of CLI flags and signal handling behavior, see the [CLI reference](../reference/cli.md).
