---
title: Installation
description: Install Sortie on macOS, Linux, or Windows. Supports install script, Homebrew, Go install, Docker, and manual binary downloads.
keywords: sortie install, installation, setup, autonomous coding agent, homebrew, go install, docker, binary download
author: Sortie AI
date: 2026-03-26
weight: 10
---
This guide covers every supported way to install sortie on your machine.
Pick the method that fits your setup, verify the installation, and you're
ready to go.

## Install Script (macOS and Linux)

The recommended method for macOS and Linux. The script detects your OS and
architecture, downloads the correct binary, verifies its checksum, and places
it on your `PATH`.

```bash
curl -sSL https://get.sortie-ai.com/install.sh | sh
```

By default the binary is installed to `/usr/local/bin` when running as root,
or `~/.local/bin` otherwise. If the install directory is not already on your
`PATH`, the script prints the exact command to add it.

### Script Options

| Variable | Effect |
|---|---|
| `SORTIE_VERSION` | Pin a specific release (e.g. `1.11.0`). Without it, the latest release is used. |
| `SORTIE_INSTALL_DIR` | Override the install directory. |
| `SORTIE_NO_VERIFY=1` | Skip SHA-256 checksum verification (not recommended). |

Example — install a specific version to a custom directory:

```bash
SORTIE_VERSION=1.11.0 SORTIE_INSTALL_DIR=/opt/bin \
  curl -sSL https://get.sortie-ai.com/install.sh | sh
```

## Install Script (Windows)

The recommended method for Windows. The script detects your architecture,
downloads the correct binary, verifies its checksum, installs `sortie.exe`, and
adds the install directory to your user `PATH`. It runs on Windows PowerShell
5.1 (the default on Windows 10 and 11) and on PowerShell 7+.

Run the one-liner in a PowerShell prompt:

```powershell
irm 'https://get.sortie-ai.com/install.ps1' | iex
```

By default the binary is installed to `%LOCALAPPDATA%\Programs\sortie`, a
per-user location that needs no administrator rights. The script adds that
directory to your user `PATH`; restart any open shell sessions for the change
to take effect.

### Script Options

Set these as environment variables before running the one-liner:

| Variable | Effect |
|---|---|
| `SORTIE_VERSION` | Pin a specific release (e.g. `1.11.0`). Without it, the latest release is used. |
| `SORTIE_INSTALL_DIR` | Override the install directory. |
| `SORTIE_NO_VERIFY` | Set to `1` to skip SHA-256 checksum verification (not recommended). |

Example — install a specific version to a custom directory:

```powershell
$env:SORTIE_VERSION = '1.11.0'
$env:SORTIE_INSTALL_DIR = 'C:\tools\sortie'
irm 'https://get.sortie-ai.com/install.ps1' | iex
```

## Homebrew (macOS and Linux)

If you use Homebrew, install Sortie from the official tap:

```bash
brew install sortie-ai/tap/sortie
```

The tap is added automatically on first install. To upgrade to a new release:

```bash
brew upgrade sortie
```

## Docker

Sortie provides a Docker image at `ghcr.io/sortie-ai/sortie`.

See our guide on using [Sortie in Docker](/guides/use-sortie-in-docker/) for more details.

## Download from GitHub Releases

If you prefer to download and install manually, grab the archive directly from
GitHub.

{{% steps %}}

### Determine your platform

| OS | Architecture | Asset name |
|---|---|---|
| Linux | x86_64 | `sortie_VERSION_linux_amd64.tar.gz` |
| Linux | ARM64 | `sortie_VERSION_linux_arm64.tar.gz` |
| macOS | Intel | `sortie_VERSION_darwin_amd64.tar.gz` |
| macOS | Apple Silicon | `sortie_VERSION_darwin_arm64.tar.gz` |
| Windows | x86_64 | `sortie_VERSION_windows_amd64.zip` |
| Windows | ARM64 | `sortie_VERSION_windows_arm64.zip` |

### Download and extract

Go to the [Releases page](https://github.com/sortie-ai/sortie/releases) and
download the asset matching your platform.

**macOS / Linux:**

```bash
tar -xzf sortie_VERSION_linux_amd64.tar.gz
```

**Windows (PowerShell):**

```powershell
Expand-Archive sortie_VERSION_windows_amd64.zip -DestinationPath .
```

### Verify the checksum (recommended)

Each release includes a `checksums.txt` file. Download it alongside the
archive and verify the SHA-256 hash.

**macOS / Linux:**

```bash
sha256sum -c checksums.txt --ignore-missing
```

**Windows (PowerShell):**

```powershell
(Get-FileHash sortie_VERSION_windows_amd64.zip -Algorithm SHA256).Hash
```

Compare the output against the matching line in `checksums.txt`.

### Move the binary to your PATH

**macOS / Linux:**

```bash
install -m 755 sortie /usr/local/bin/sortie
```

**Windows:**

Move `sortie.exe` to a directory on your `PATH`, or add its current location
to `PATH` through **Settings > System > About > Advanced system settings >
Environment Variables**.

{{% /steps %}}

## Go Install

If you have Go 1.26+ installed, you can install directly from source:

```bash
go install github.com/sortie-ai/sortie/cmd/sortie@latest
```

The binary is placed in `$GOPATH/bin` (or `$HOME/go/bin` by default). Make
sure that directory is on your `PATH`.

To pin a version:

```bash
go install github.com/sortie-ai/sortie/cmd/sortie@v1.0.0
```

## Build from Source

For development or when you need a custom build. Requires
[Git](https://git-scm.com/) and [Go](https://go.dev/dl/) 1.26+.

{{% steps %}}

### Clone the repository

```bash
git clone https://github.com/sortie-ai/sortie.git
cd sortie
```

### Compile the binary

```bash
make build
```

This produces a `sortie` binary in the repository root.

### Move the binary to your PATH

```bash
install -m 755 sortie /usr/local/bin/sortie
```

{{% /steps %}}

## Verify the Installation

Confirm sortie is installed and on your `PATH`:

```bash
sortie --version
```

You should see output like:

```
sortie v0.x.x
```

## Troubleshooting

**Homebrew formula fails to install** — The local tap may be stale. Run `brew update` first, then retry:

```bash
brew update
brew install sortie-ai/tap/sortie
```

**`command not found: sortie`** — The install directory is not on your `PATH`.
Add it to your shell configuration file (`~/.bashrc`, `~/.zshrc`, or
`~/.config/fish/config.fish`) and reload your shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**`sortie` is not recognized (Windows)** — The install script updates your user
`PATH`, but open shells keep their old environment until you restart them. Close
and reopen PowerShell, then run `sortie --version` again. To check that the
install directory is on your user `PATH`:

```powershell
[Environment]::GetEnvironmentVariable('Path', 'User')
```

**Checksum mismatch** — The download may have been corrupted or tampered with.
Delete the file and download again. If the problem persists, open an
[issue](https://github.com/sortie-ai/sortie/issues).

**Permission denied during install** — Either run the install command with
`sudo`, or choose a directory you own (e.g. `~/.local/bin`).

## Next steps

- [Quick start](/getting-started/quick-start/) — run Sortie end-to-end with a mock agent and local issues
