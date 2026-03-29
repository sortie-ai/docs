---
title: "How to Run Sortie as a launchctl Service | Sortie"
description: "Configure Sortie as a persistent launchd service on macOS with a property list, environment variables, log files, and automatic restarts."
keywords: sortie launchd, launchctl, macOS service, plist, daemon, macos deploy, launch agent
author: Sortie AI
---

# How to run Sortie as a launchctl service

Set up Sortie as a managed launchd service on macOS so it starts on login (or boot), restarts on failure, and logs to disk — no terminal session required.

## Prerequisites

- Sortie installed at `/usr/local/bin/sortie` ([installation guide](../getting-started/installation.md))
- A working `WORKFLOW.md` you've tested from the command line
- macOS 13 (Ventura) or later
- Administrator access for system-wide daemons, or your own user account for user agents

## Choose: user agent or system daemon

macOS draws a hard line between two kinds of launchd jobs:

| Type | Runs when | Plist directory | Privileges |
|------|-----------|-----------------|------------|
| User agent | Your user session is active | `~/Library/LaunchAgents/` | Your user |
| System daemon | System is running (any user or none) | `/Library/LaunchDaemons/` | root (or a named user) |

For most setups — a developer machine, a CI Mac mini you SSH into — a **user agent** is the right choice. It runs as your user, inherits your filesystem permissions, and doesn't require `sudo` to manage.

Use a **system daemon** only when Sortie must run before anyone logs in (headless build servers, always-on Mac infrastructure). This guide covers both, starting with the user agent path.

## Set up the directory structure

Create directories for Sortie's config, database, and workspaces:

```bash
mkdir -p ~/.config/sortie
mkdir -p ~/.local/share/sortie/workspaces
```

Copy your tested workflow file:

```bash
cp ~/my-project/WORKFLOW.md ~/.config/sortie/WORKFLOW.md
```

Edit the workflow file to use absolute paths. User agents default to your home directory, system daemons to `/` — but neither is where your workflow expects to run. Absolute paths remove the guesswork.

```yaml
# ~/.config/sortie/WORKFLOW.md (front matter excerpt)
---
workspace:
  root: /Users/deploy/.local/share/sortie/workspaces
db_path: /Users/deploy/.local/share/sortie/sortie.db
# ... rest of your config
---
```

Replace `deploy` with your macOS username. The database file is created on first run.

## Configure environment variables

Sortie and its agent subprocesses inherit the process environment. API keys and tracker credentials belong in a dedicated env file that the plist loads at startup.

You can inline secrets directly in the service plist (shown in the next section), or keep them in a separate `.env` file and pass it to Sortie with the `--env-file` flag. Either way, protect the file with `chmod 600` so only your user can read it.

For the `--env-file` approach, create `~/.config/sortie/.env`:

```bash
# ~/.config/sortie/.env
ANTHROPIC_API_KEY=sk-ant-api03-abc123...
SORTIE_JIRA_ENDPOINT=https://mycompany.atlassian.net
SORTIE_JIRA_API_KEY=deploy-bot@mycompany.com:xyztoken123
```

```bash
chmod 600 ~/.config/sortie/.env
```

## Write the plist (user agent)

Create `~/Library/LaunchAgents/com.sortie-ai.sortie.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sortie-ai.sortie</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/sortie</string>
    <string>--port</string>
    <string>8080</string>
    <string>--env-file</string>
    <string>/Users/deploy/.config/sortie/.env</string>
    <string>/Users/deploy/.config/sortie/WORKFLOW.md</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>WorkingDirectory</key>
  <string>/Users/deploy/.local/share/sortie</string>

  <key>StandardOutPath</key>
  <string>/Users/deploy/.local/share/sortie/sortie.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/deploy/.local/share/sortie/sortie.stderr.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
```

Replace `deploy` with your macOS username throughout.

A few things worth noting about this configuration:

**`RunAtLoad`** — Starts Sortie when the plist is loaded (at login or manually). Without this, launchd waits for an incoming connection or other trigger before launching the process.

**`KeepAlive` with `SuccessfulExit` false** — Restarts Sortie whenever it exits with a non-zero status. A clean `launchctl bootout` sends SIGTERM, which Sortie handles gracefully — that does not trigger a restart. If Sortie crashes, launchd brings it back.

**`ThrottleInterval`** — Waits 10 seconds between restart attempts. This matches the systemd guide's `RestartSec=10` and prevents a crash loop from saturating the machine.

**`ProcessType` Background** — Tells macOS this is a background service, not a user-facing app. The system applies appropriate CPU and I/O scheduling.

**`StandardOutPath` and `StandardErrorPath`** — Sortie logs structured `key=value` output to stderr. launchd writes both streams to log files under your data directory. Unlike journald on Linux, macOS doesn't manage rotation for you — see the log rotation section below.

If you prefer to inline secrets directly, replace the `--env-file` argument with an `EnvironmentVariables` dictionary in the plist and protect the plist with `chmod 600`.

## Load and start the service

Load the plist into launchd and start Sortie:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sortie-ai.sortie.plist
```

Verify it's running:

```bash
launchctl print gui/$(id -u)/com.sortie-ai.sortie
```

Look for a `pid =` line with a nonzero value and confirm the process is live. The exact output format is not a stable API and may change across macOS releases, but a running service is obvious from context. If Sortie started with `--port 8080`, the dashboard is live at `http://localhost:8080`.

To stop the service:

```bash
launchctl bootout gui/$(id -u)/com.sortie-ai.sortie
```

To reload after editing the plist (stop + start in one step):

```bash
launchctl bootout gui/$(id -u)/com.sortie-ai.sortie 2>/dev/null; \
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sortie-ai.sortie.plist
```

## View logs

All output goes to the log files specified in the plist:

```bash
# Follow stderr (where Sortie writes structured logs) in real time
tail -f ~/.local/share/sortie/sortie.stderr.log

# Find all errors
grep 'level=ERROR' ~/.local/share/sortie/sortie.stderr.log

# Track a specific issue
grep 'issue_identifier=PROJ-42' ~/.local/share/sortie/sortie.stderr.log
```

### Log rotation

launchd doesn't rotate logs. The files grow until you manage them. A `newsyslog` entry handles this. Create `/etc/newsyslog.d/sortie.conf`:

```bash
sudo tee /etc/newsyslog.d/sortie.conf << 'EOF'
# logfilename                                           [owner:group] mode count size(KB) when  flags
/Users/deploy/.local/share/sortie/sortie.stderr.log     deploy:staff  640  5     10240    *     J
/Users/deploy/.local/share/sortie/sortie.stdout.log     deploy:staff  640  5     10240    *     J
EOF
```

This keeps 5 rotated copies, each up to 10 MB, compressed with bzip2. macOS runs `newsyslog` roughly every 30 minutes via its own launchd job (`com.apple.newsyslog`).

For debugging, add `--log-level debug` to the `ProgramArguments` in the plist, then reload the service.

## System daemon variant

If you need Sortie running before any user logs in, use a system daemon instead. The key differences:

1. Place the plist in `/Library/LaunchDaemons/com.sortie-ai.sortie.plist`.
2. Add `UserName` and `GroupName` keys to run as a dedicated user.
3. Use `sudo` for all `launchctl` commands, targeting the `system` domain.

Create a hidden service account with `dscl`. macOS uses UIDs below 500 for system accounts — pick one that's free (check with `dscl . -list /Users UniqueID | sort -n -k2`):

```bash
sudo dscl . -create /Users/sortie
sudo dscl . -create /Users/sortie UserShell /usr/bin/false
sudo dscl . -create /Users/sortie UniqueID 499
sudo dscl . -create /Users/sortie PrimaryGroupID 20
sudo dscl . -create /Users/sortie NFSHomeDirectory /var/empty
sudo dscl . -create /Users/sortie RealName "Sortie Service"
sudo dscl . -create /Users/sortie IsHidden 1
```

Store state in a system-level directory:

```bash
sudo mkdir -p /usr/local/etc/sortie
sudo mkdir -p /var/lib/sortie/workspaces
sudo chown -R sortie:staff /var/lib/sortie
```

The plist adds two keys that the user agent version doesn't need:

```xml
<key>UserName</key>
<string>sortie</string>
<key>GroupName</key>
<string>staff</string>
```

Load and manage with the `system` domain:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.sortie-ai.sortie.plist
sudo launchctl print system/com.sortie-ai.sortie
sudo launchctl bootout system/com.sortie-ai.sortie
```

The permissions requirement is strict: the plist must be owned by root and not writable by group or others (`chmod 644`).

## Run multiple workflows

Each Sortie process handles one workflow file. To orchestrate multiple projects, create separate plists — one per workflow:

```
com.sortie-ai.sortie-billing.plist   → ~/.config/sortie/billing/WORKFLOW.md
com.sortie-ai.sortie-platform.plist  → ~/.config/sortie/platform/WORKFLOW.md
```

Each service needs its own `db_path`, `workspace.root`, port, and log file paths. The plists are identical in structure, differing only in `ProgramArguments`, `EnvironmentVariables`, and output paths.

See [How to run multiple workflows](run-multiple-workflows.md) for the full isolation rules and a worked example.

## Update the binary

Sortie persists all state — run history, retry schedules, session metadata — in SQLite. Stopping and restarting loses nothing. In-flight agent sessions are drained gracefully on stop and can resume on the next start.

```bash
launchctl bootout gui/$(id -u)/com.sortie-ai.sortie
cp /path/to/sortie-new /usr/local/bin/sortie
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sortie-ai.sortie.plist
```

If you installed via the install script:

```bash
curl -sSL https://get.sortie-ai.com/install.sh | sh
launchctl bootout gui/$(id -u)/com.sortie-ai.sortie 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sortie-ai.sortie.plist
```

Verify the new version:

```bash
grep 'version=' ~/.local/share/sortie/sortie.stderr.log | tail -1
```

You'll see the version in the startup log line:

```
level=INFO msg="sortie starting" version=0.1.0 workflow_path=/Users/deploy/.config/sortie/WORKFLOW.md port=8080
```

## What we configured

A production-ready Sortie deployment running as a launchd service on macOS with:

- A property list that starts Sortie at login and restarts on failure
- Workflow config in `~/.config/sortie/`, state and workspaces in `~/.local/share/sortie/`
- Environment variables for API keys, protected by filesystem permissions
- Structured log output to disk with `newsyslog` rotation
- A clear upgrade path that preserves all state across restarts

For monitoring beyond logs, see [How to monitor with Prometheus](monitor-with-prometheus.md). For the full set of CLI flags and signal handling behavior, see the [CLI reference](../reference/cli.md).
