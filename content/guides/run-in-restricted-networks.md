---
title: Run Sortie in a Network-Restricted Environment
linkTitle: Network-Restricted Environments
description: "Install Sortie offline and plan tracker, forge, notification, proxy, certificate, and agent connectivity."
author: Sortie AI
date: 2026-10-26
weight: 190
url: /guides/run-in-restricted-networks/
---
Sortie can run on a host without public internet access when its configured services are reachable. An air-gapped setup also needs a coding agent that can work with the model endpoint and tools available inside that network. Installing the Sortie binary alone does not make a cloud-backed agent work offline.

## Bring the binary into the network

On a connected machine, follow [manual installation](/getting-started/installation/#download-from-github-releases) and download the platform archive and `checksums.txt` from the **same release**. Releases provide Linux and macOS `tar.gz` archives and Windows `zip` archives, for amd64 and arm64, named `sortie_<version>_<os>_<arch>`. Software bills of materials are attached to releases too.

For example, with a chosen Linux amd64 release archive already downloaded:

```sh
sha256sum sortie_<version>_linux_amd64.tar.gz
```

Compare the result with that archive's entry in `checksums.txt` before extracting it. On macOS use `shasum -a 256`; on Windows use `Get-FileHash -Algorithm SHA256`. Transfer the verified binary, `sortie` or `sortie.exe`, through your approved transfer process to a directory on the restricted host's `PATH`. Keep the release version and checksum with the transfer record.

The release binary is statically linked and needs no runtime libraries on the target host. The install scripts fetch from GitHub at installation time, so do not depend on them being able to run on the restricted host. The [Docker guide](/guides/use-sortie-in-docker/) covers the published `ghcr.io/sortie-ai/sortie` image and building an image with an agent; mirror the required images into an internal registry when public registries are unavailable.

## Plan Sortie's connections

Allow the destinations your workflow actually uses, rather than a fixed list of public vendor hosts:

| Surface | Destination to make reachable |
|---|---|
| Tracker polling and configured tracker writes | The API behind `tracker.endpoint`, or the adapter's default endpoint when it is omitted. The `file` tracker makes no network calls. |
| SCM and CI reactions | The provider APIs selected by the workflow's reactions. The top-level `github:`, `gitea:`, and `gitlab:` pass-through blocks can override their endpoints; when the tracker kind matches, those providers can reuse the tracker configuration. |
| Operator notifications | The Slack, Discord, Telegram, or webhook destinations enabled under `notifications`. Omit unused destinations. See [notification routing](/guides/route-notifications/). |

Sortie has no automatic update check and sends no telemetry. Its dashboard assets are embedded in the binary and do not need an external CDN. The coding agent and workspace hooks have their own network requirements, described below.

Inbound access is a separate choice: the HTTP server serves the dashboard, JSON API, `/metrics`, and health probes, and tracker webhooks are optional. Bind and expose only what operators need. See the [HTTP API reference](/reference/http-api/) and [security model](/concepts/security/) before exposing a listener beyond the host.

## Point adapters at internal services

The endpoint forms differ by adapter:

| Adapter | Internal configuration and limitations |
|---|---|
| Jira Server or Data Center | Set `tracker.endpoint` to the instance base URL, without `/rest/api/...`, and `tracker.api_version: "2"`. A personal access token is sent as Bearer; a `user:password` value uses Basic authentication. Follow the [Jira host/version rules](/reference/adapter-jira/#api_version). |
| GitLab self-managed | Set `tracker.endpoint` to the instance root. The adapter appends `/api/v4`. If omitted, it uses `https://gitlab.com`. See [GitLab setup](/guides/connect-to-gitlab/). |
| Gitea | Set `tracker.endpoint` to the instance root; it is required. The adapter appends `/api/v1`. See [Gitea setup](/guides/connect-to-gitea/). |
| GitHub Enterprise Server | Set `tracker.endpoint` to the instance's `/api/v3` REST root; GraphQL requests use `/api/graphql`. Without an override, the adapter uses `https://api.github.com`. This describes the configuration, not a claim of validation against a GitHub Enterprise Server installation. See [GitHub setup](/guides/connect-to-github/). |
| Linear | There is no self-hosted option. A Linear workflow needs its service reachable; the default is `https://api.linear.app/graphql`. See the [Linear adapter](/reference/adapter-linear/). |

Configure reaction-provider overrides as well as the tracker if those reactions use a different forge. The [workflow reference](/reference/workflow-config/#adapter-pass-through-configuration) describes their fallback rules. Do not substitute the tracker URL for a separate provider's endpoint without checking which API it expects.

## Configure proxies and private certificate authorities

Sortie's HTTP clients use Go's standard transport. Set `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` in the environment of the Sortie process when a proxy is required. Include internal hosts that should be reached directly in `NO_PROXY`. These are transport environment variables, not `WORKFLOW.md` keys.

There is no Sortie-specific custom CA bundle setting. Install the internal certificate authority in the host's trust store. On Linux, Go also supports `SSL_CERT_FILE` and `SSL_CERT_DIR` for certificate locations. Keep TLS verification enabled; a proxy route does not make an untrusted certificate valid.

## Prepare the agent host and workspace hooks

Sortie launches a coding-agent CLI as a subprocess, locally or over SSH. It does not call a model API itself. Install that CLI on the agent host and configure its model endpoint using the CLI's own supported configuration. Verify the agent independently inside the restricted network before asking Sortie to schedule it.

Locally launched agents inherit Sortie's process environment, including proxy and model-endpoint variables. An SSH worker uses its remote environment plus the variables Sortie explicitly carries. Runtime credential variables can be carried automatically; other names need `ssh_pass_env`, and `ssh_disallow_pass_env` prevents Sortie from carrying a name. Do not assume local proxy or model settings automatically reach an SSH worker. See [remote environment handling](/guides/scale-agents-with-ssh/#give-the-remote-agent-its-credentials).

Sortie disables OpenCode's auto-update on every launch. Update checks and vendor telemetry for other agent CLIs are controlled by those CLIs; consult their documentation and configure them on the agent host. Sortie's own lack of telemetry is not a guarantee about a child process.

Workspace hooks that clone or fetch repositories need the forge reachable from the machine executing that operation. Hooks run on the orchestrator; in an SSH setup, a hook that explicitly invokes `ssh` to clone runs that clone on the remote host. The [SSH guide](/guides/scale-agents-with-ssh/#update-hooks-for-remote-execution) shows the distinction. Preinstall any toolchains and dependencies the agent needs, or supply reachable internal mirrors.

## Keep local state writable and validate first

The SQLite database uses `db_path`, defaulting to `.sortie.db` next to `WORKFLOW.md`; it needs no network service. Workspaces use `workspace.root`. Give the process writable paths for both and follow the [persistence guidance](/concepts/persistence/) when arranging backups.

On the restricted host, start with:

```sh
sortie validate WORKFLOW.md
```

This checks configuration offline. It does not prove that tokens authenticate, endpoints are reachable, the agent can contact its model, or hooks can fetch a repository. Verify those connections separately before starting unattended work.

Before the first run, provide:

- The platform binary, its release version, and verified checksum.
- Internal tracker and forge endpoints with the required tokens.
- A direct route or configured proxy to each enabled destination.
- The internal CA in the relevant host trust stores.
- The agent CLI and a model endpoint reachable from its host.
- Writable database and workspace paths, plus any internal dependency mirrors the workflow needs.
