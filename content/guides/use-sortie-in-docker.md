---
title: "How to Use Sortie in Docker"
linkTitle: "Use Sortie in Docker"
description: "Run Sortie in a Docker container: build the distroless image, compose agent-specific images with COPY --from, configure volumes, health checks, and process reaping."
keywords: sortie docker, container, distroless, dockerfile, docker image, claude code docker, copilot docker, COPY --from, non-root, healthcheck
author: Sortie AI
date: 2026-04-07
weight: 180
url: /guides/use-sortie-in-docker/
---
Build a container image that pairs Sortie with your agent of choice. The published Sortie image is [distroless](https://github.com/GoogleContainerTools/distroless) — it contains only the binary. You copy it into your own image and choose the base OS, runtime, and packages your agent needs.

## Prerequisites

- Docker 20.10+ with BuildKit enabled
- A working `WORKFLOW.md` tested locally ([quick start](/getting-started/quick-start/))
- API credentials for your agent (e.g., `ANTHROPIC_API_KEY` for Claude Code, `GITHUB_TOKEN` for Copilot, etc.)

## Install Sortie into your image

Sortie publishes a distroless image at `ghcr.io/sortie-ai/sortie`. It contains one file: `/usr/bin/sortie`. Copy the binary into your own Dockerfile using a multi-stage build:

```dockerfile
FROM ghcr.io/sortie-ai/sortie:latest AS sortie

FROM node:24-slim
COPY --from=sortie /usr/bin/sortie /usr/bin/sortie
```

Pin to a specific version for reproducible builds:

```dockerfile
FROM ghcr.io/sortie-ai/sortie:1.5.0 AS sortie
```

This pattern keeps Sortie agent-agnostic: it does not dictate your OS, package manager, or runtime environment. You pick the base image your agent requires.

## Build a Claude Code image

Claude Code requires Node.js and npm. Its `--dangerously-skip-permissions` mode refuses to run as root, so the container must use a non-root user.

Create a file named `Dockerfile.claude`:

```dockerfile
FROM ghcr.io/sortie-ai/sortie:latest AS sortie

FROM node:24-slim

# Install Claude Code.
RUN npm install -g @anthropic-ai/claude-code@latest \
    && npm cache clean --force

# Create a non-root user at UID 1000. The node base image already has
# a "node" user at that UID — remove it first.
RUN userdel -r node 2>/dev/null; \
    useradd --create-home --shell /bin/bash --uid 1000 sortie

COPY --from=sortie /usr/bin/sortie /usr/bin/sortie

USER sortie
WORKDIR /home/sortie

EXPOSE 7678

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO /dev/null http://localhost:7678/readyz || exit 1

ENTRYPOINT ["/usr/bin/sortie", "--host", "0.0.0.0"]
```

Build the image:

```sh
docker build -f Dockerfile.claude -t sortie-claude .
```

## Build a Copilot image

GitHub Copilot Coding Agent also requires Node.js. The same pattern applies, with a different npm package:

```dockerfile
FROM ghcr.io/sortie-ai/sortie:latest AS sortie

FROM node:24-slim

RUN npm install -g @github/copilot@latest \
    && npm cache clean --force

RUN userdel -r node 2>/dev/null; \
    useradd --create-home --shell /bin/bash --uid 1000 sortie

COPY --from=sortie /usr/bin/sortie /usr/bin/sortie

USER sortie
WORKDIR /home/sortie

EXPOSE 7678

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO /dev/null http://localhost:7678/readyz || exit 1

ENTRYPOINT ["/usr/bin/sortie", "--host", "0.0.0.0"]
```

## Run the container

Sortie needs two paths at runtime, plus credentials for both the agent and the tracker passed as environment variables:

| Path | Purpose | Mount type |
|---|---|---|
| Workspace root | Agent working directories for each issue | Read-write volume |
| `WORKFLOW.md` | Workflow configuration file | Read-only bind mount |

### Pass environment variables

The container needs credentials for the **agent** (to run code) and the **tracker** (to poll issues and report status). Forward them with `-e`:

**Agent credentials:**

| Agent | Variable |
|---|---|
| Claude Code | `ANTHROPIC_API_KEY` |
| Copilot | `GITHUB_TOKEN` (or `GH_TOKEN`, or `COPILOT_GITHUB_TOKEN`) |

**Tracker credentials:**

| Tracker | Variables |
|---|---|
| GitHub Issues | `SORTIE_GITHUB_TOKEN`, `SORTIE_GITHUB_PROJECT` |
| Jira | `SORTIE_JIRA_API_KEY`, `SORTIE_JIRA_ENDPOINT`, `SORTIE_JIRA_PROJECT` |
| File (local testing) | None — configured in `WORKFLOW.md` |

For tracker setup details, see [How to connect to GitHub Issues](/guides/connect-to-github/) or [How to connect to Jira](/guides/connect-to-jira/).

If your workflow references other services (private package registries, cloud providers, CI systems), forward those variables too. The container inherits nothing from the host environment unless explicitly passed with `-e`.

### Claude Code with GitHub Issues

```sh
docker run --rm --init \
    -e ANTHROPIC_API_KEY \
    -e SORTIE_GITHUB_TOKEN \
    -e SORTIE_GITHUB_PROJECT \
    -v "$(pwd)/workspaces:/home/sortie/workspaces" \
    -v "$(pwd)/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro" \
    -p 7678:7678 \
    sortie-claude /home/sortie/WORKFLOW.md
```

### Claude Code with Jira

```sh
docker run --rm --init \
    -e ANTHROPIC_API_KEY \
    -e SORTIE_JIRA_API_KEY \
    -e SORTIE_JIRA_ENDPOINT \
    -e SORTIE_JIRA_PROJECT \
    -v "$(pwd)/workspaces:/home/sortie/workspaces" \
    -v "$(pwd)/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro" \
    -p 7678:7678 \
    sortie-claude /home/sortie/WORKFLOW.md
```

### Copilot with GitHub Issues

```sh
docker run --rm --init \
    -e GITHUB_TOKEN \
    -e SORTIE_GITHUB_TOKEN \
    -e SORTIE_GITHUB_PROJECT \
    -v "$(pwd)/workspaces:/home/sortie/workspaces" \
    -v "$(pwd)/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro" \
    -p 7678:7678 \
    sortie-copilot /home/sortie/WORKFLOW.md
```

The flags explained:

| Flag | Purpose |
|---|---|
| `--rm` | Remove the container on exit |
| `--init` | Inject an init process (tini) for zombie reaping |
| `-e ANTHROPIC_API_KEY` | Forward the agent credential into the container |
| `-e SORTIE_GITHUB_TOKEN` | Forward the tracker credential into the container |
| `-v .../workspaces:...` | Mount the workspace root as a read-write volume |
| `-v .../WORKFLOW.md:...:ro` | Mount the workflow file as read-only |
| `-p 7678:7678` | Expose the HTTP observability server |

## Persist the database

Sortie creates a SQLite database (`.sortie.db`) in the working directory. Without a volume mount, data is lost when the container stops.

To persist it, mount a volume for the working directory:

```sh
docker run --rm --init \
    -e ANTHROPIC_API_KEY \
    -v sortie-data:/home/sortie \
    -v "$(pwd)/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro" \
    -p 7678:7678 \
    sortie-claude /home/sortie/WORKFLOW.md
```

Or point the database to a specific path with `--db`:

```sh
docker run --rm --init \
    -e ANTHROPIC_API_KEY \
    -v sortie-db:/data \
    -v "$(pwd)/workspaces:/home/sortie/workspaces" \
    -v "$(pwd)/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro" \
    -p 7678:7678 \
    sortie-claude --db /data/sortie.db /home/sortie/WORKFLOW.md
```

## Handle process reaping

Sortie handles `SIGTERM` for graceful shutdown, but orphaned grandchild processes — agent subprocesses that outlive their parent — need an init process for zombie reaping.

The `--init` flag in the `docker run` examples above handles this. It injects Docker's built-in tini as PID 1.

On Kubernetes, enable `shareProcessNamespace: true` in the pod spec instead.

If you need tini baked into the image itself, install it in your Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["tini", "--", "/usr/bin/sortie", "--host", "0.0.0.0"]
```

## Run as non-root

Claude Code enforces a non-root requirement: `--dangerously-skip-permissions` exits with an error under UID 0. Even for agents without this restriction, running as non-root is a security best practice.

The example Dockerfiles above create a `sortie` user at UID 1000. On `node:*-slim` base images, UID 1000 is already claimed by the `node` user — remove it first with `userdel -r node` before creating your own.

If your base image has a different UID layout, adjust accordingly:

```dockerfile
RUN useradd --create-home --shell /bin/bash --uid 1000 sortie
USER sortie
```

## Add a health check

Sortie exposes two health endpoints:

| Endpoint | Purpose |
|---|---|
| `/readyz` | Readiness — checks database, preflight, and workflow state. Returns HTTP 503 if any subsystem is unhealthy. |
| `/livez` | Liveness — returns HTTP 200 unless the server is draining (graceful shutdown in progress). |

Use `/readyz` for Docker `HEALTHCHECK` because it detects real failures (broken database, invalid workflow), not just process liveness:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO /dev/null http://localhost:7678/readyz || exit 1
```

The tool (`wget`, `curl`) depends on your base image. `node:24-slim` includes `wget`. The distroless image has no shell, so the health check must be defined in your downstream image.

## Emit JSON logs for aggregation

Container runtimes route stdout/stderr to log aggregation pipelines (Loki, Datadog, CloudWatch, ELK). These systems expect newline-delimited JSON. Enable JSON log output with `--log-format json`:

```dockerfile
ENTRYPOINT ["/usr/bin/sortie", "--host", "0.0.0.0", "--log-format", "json"]
```

Or set it in the workflow file's front matter:

```yaml
logging:
  format: json
```

With JSON active, each log line becomes a self-contained JSON object:

```json
{"time":"2026-04-07T14:30:00.000Z","level":"INFO","msg":"tick completed","candidates":3,"dispatched":2,"running":2,"retrying":0}
```

All structured fields (`issue_id`, `session_id`, `error`, etc.) appear as top-level keys, ready for indexed search in your aggregation system.

The default `text` format (`key=value` lines) remains available and is the better choice when reading logs directly in `docker logs` or a terminal.

## Build the distroless image locally

To build the published distroless image from source:

```sh
docker build -t sortie .
```

Inject a version string:

```sh
docker build --build-arg VERSION=1.5.0 -t sortie .
```

Include the Git revision in OCI labels:

```sh
docker build \
    --build-arg VERSION=1.5.0 \
    --build-arg REVISION=$(git rev-parse HEAD) \
    -t sortie .
```

Cross-compile for a different architecture:

```sh
docker build --platform linux/arm64 -t sortie:arm64 .
```

The builder stage runs on the host architecture and uses Go's native cross-compilation — no QEMU emulation needed.

## Adapt for a different agent

The pattern is the same for any agent:

1. Start from the distroless image as a named stage.
2. Pick a base image that provides your agent's runtime (Node.js, Python, etc.).
3. Install the agent.
4. Create a non-root user.
5. Copy the Sortie binary from the named stage.
6. Set the entrypoint to Sortie.

Example skeleton for a Python-based agent:

```dockerfile
FROM ghcr.io/sortie-ai/sortie:latest AS sortie

FROM python:3.12-slim

RUN pip install --no-cache-dir your-agent-package

RUN useradd --create-home --shell /bin/bash --uid 1000 sortie
COPY --from=sortie /usr/bin/sortie /usr/bin/sortie

USER sortie
WORKDIR /home/sortie

ENTRYPOINT ["/usr/bin/sortie", "--host", "0.0.0.0"]
```

## Verify the setup

After building and running your image, confirm that everything works:

```sh
# Binary executes correctly
docker run --rm sortie-claude sortie --version

# Container runs as non-root
docker run --rm sortie-claude id
# Expected: uid=1000(sortie) gid=1000(sortie) ...

# Health check passes (wait ~30s for the first check)
docker inspect --format='{{.State.Health.Status}}' <container-id>
# Expected: healthy
```

## Troubleshooting

**Claude Code fails with "must not run as root":** The container is running as UID 0. Verify the `USER sortie` directive is in your Dockerfile and that you're not overriding it with `docker run --user root`.

**`COPY --from` fails with "not found":** The image tag in the `FROM ghcr.io/sortie-ai/sortie:...` line doesn't exist. Check available tags at the [GitHub Container Registry page](https://github.com/sortie-ai/sortie/pkgs/container/sortie) or use `:latest`.

**Health check reports unhealthy:** Sortie's HTTP server binds to `127.0.0.1` by default. Ensure the entrypoint includes `--host 0.0.0.0` so the health check can reach it from within the container. Also verify that port 7678 is not blocked or remapped. Run `wget -qO- http://localhost:7678/readyz` inside the container to inspect the response — it returns JSON with per-subsystem status.

**Workspace files have wrong permissions:** The host directory mounted at `/home/sortie/workspaces` must be writable by UID 1000. Run `chown -R 1000:1000 workspaces/` on the host, or use `docker run --user $(id -u):$(id -g)` if your host UID differs.

**SQLite database locked:** Two containers are sharing the same database file. Each Sortie instance needs its own `.sortie.db`. Use separate named volumes or `--db` paths for each container.

## Example Dockerfiles

The Dockerfiles in this guide are self-contained — copy them into your project and build directly. The Sortie repository also maintains reference versions that track the latest best practices:

| File | Agent | Base Image |
|---|---|---|
| [`claude-code.Dockerfile`](https://github.com/sortie-ai/sortie/blob/main/examples/docker/claude-code.Dockerfile) | Claude Code | `node:24-slim` |
| [`copilot.Dockerfile`](https://github.com/sortie-ai/sortie/blob/main/examples/docker/copilot.Dockerfile) | GitHub Copilot | `node:24-slim` |

If a section in this guide becomes outdated, check those files for the current recommended configuration.
