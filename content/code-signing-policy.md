---
title: Code signing policy
description: Code signing policy for Sortie's Windows binaries. Which release files are signed, who can commit, review, and approve a signing request, and what data Sortie sends.
author: Sortie AI
date: 2026-10-09
weight: 6
---
Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org)

## What is signed

The signed files are the Windows executables `sortie.exe` for amd64 and arm64. Each ships inside its release archive, `sortie_VERSION_windows_amd64.zip` or `sortie_VERSION_windows_arm64.zip`, on the [GitHub Releases page](https://github.com/sortie-ai/sortie/releases). The archives and the hashes in `checksums.txt` are produced after signing, so they cover the signed executable.

Every signed executable is built from the source in the [sortie-ai/sortie](https://github.com/sortie-ai/sortie) repository by the project's release workflow on GitHub-hosted runners. That workflow is the only place a signing request is submitted.

The Linux and macOS archives, the Docker image, and any binary built with `go install` or from source are not signed through this program.

## Team roles

| Role | Members | What the role does |
|---|---|---|
| Committers | Serghei Iakovlev ([@sergeyklay](https://github.com/sergeyklay), [@serghei-dev](https://github.com/serghei-dev)) | Maintain the repository and merge changes into `main`. |
| Reviewers | Serghei Iakovlev ([@sergeyklay](https://github.com/sergeyklay), [@serghei-dev](https://github.com/serghei-dev)) | Default code owners in [`CODEOWNERS`](https://github.com/sortie-ai/sortie/blob/main/.github/CODEOWNERS). A change from anyone else reaches `main` only through a pull request with an approving code-owner review. |
| Approvers | Serghei Iakovlev ([@sergeyklay](https://github.com/sergeyklay), [@serghei-dev](https://github.com/serghei-dev)) | Manually approve every signing request before SignPath signs it. |

`@serghei-dev` is a second GitHub account of the same person.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the person installing or operating it. A running instance connects only to the endpoints its configuration names, such as the issue tracker, the code forge, and notification URLs, and it sends no telemetry, analytics, or update checks. The coding agent Sortie launches is a separate program with its own privacy policy. [Outbound data posture](/concepts/security/#outbound-data-posture) has the details.
