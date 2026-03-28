---
title: Installation | Sortie
description: Install Sortie on macOS, Linux, or Windows. Supports install script, Homebrew, Go install, Docker, and manual binary downloads.
keywords: sortie install, installation, setup, homebrew, go install, docker, binary download
author: Sortie AI
---

# Installation

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
| `SORTIE_VERSION` | Pin a specific release (e.g. `0.0.9`). Without it, the latest release is used. |
| `SORTIE_INSTALL_DIR` | Override the install directory. |
| `SORTIE_NO_VERIFY=1` | Skip SHA-256 checksum verification (not recommended). |

Example — install a specific version to a custom directory:

```bash
SORTIE_VERSION=0.0.9 SORTIE_INSTALL_DIR=/opt/bin \
  curl -sSL https://get.sortie-ai.com/install.sh | sh
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

## Download from GitHub Releases

If you prefer to download manually, or you're on a platform the install script
doesn't cover (like Windows), grab the archive directly from GitHub.

### 1. Determine Your Platform

| OS | Architecture | Asset name |
|---|---|---|
| Linux | x86_64 | `sortie_VERSION_linux_amd64.tar.gz` |
| Linux | ARM64 | `sortie_VERSION_linux_arm64.tar.gz` |
| macOS | Intel | `sortie_VERSION_darwin_amd64.tar.gz` |
| macOS | Apple Silicon | `sortie_VERSION_darwin_arm64.tar.gz` |
| Windows | x86_64 | `sortie_VERSION_windows_amd64.zip` |
| Windows | ARM64 | `sortie_VERSION_windows_arm64.zip` |

### 2. Download and Extract

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

### 3. Verify the Checksum (Recommended)

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

### 4. Move the Binary to Your PATH

**macOS / Linux:**

```bash
install -m 755 sortie /usr/local/bin/sortie
```

**Windows:**

Move `sortie.exe` to a directory on your `PATH`, or add its current location
to `PATH` through **Settings > System > About > Advanced system settings >
Environment Variables**.

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

For development or when you need a custom build.

### Prerequisites

- [Git](https://git-scm.com/)
- [Go](https://go.dev/dl/) 1.26+

### Steps

Clone the repository and compile:

```bash
git clone https://github.com/sortie-ai/sortie.git
cd sortie
make build
```

This produces a `sortie` binary in the repository root. Move it somewhere on
your `PATH`:

```bash
install -m 755 sortie /usr/local/bin/sortie
```

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

**Checksum mismatch** — The download may have been corrupted or tampered with.
Delete the file and download again. If the problem persists, open an
[issue](https://github.com/sortie-ai/sortie/issues).

**Permission denied during install** — Either run the install command with
`sudo`, or choose a directory you own (e.g. `~/.local/bin`).

## Next steps

- [Quick start](quick-start.md) — run Sortie end-to-end with a mock agent and local issues
