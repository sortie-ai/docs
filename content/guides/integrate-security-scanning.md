---
title: "How to Integrate Security Scanning"
linkTitle: "Integrate Security Scanning"
description: "Run gitleaks, semgrep, and govulncheck as Sortie workspace hooks to catch secrets, vulnerabilities, and code issues before agent code reaches a PR."
keywords: sortie security scanning, gitleaks, semgrep, gosec, govulncheck, workspace hooks, SAST, secret scanning, dependency audit, agent security
author: Sortie AI
date: 2026-03-30
weight: 70
url: /guides/integrate-security-scanning/
---
Gate agent-generated code with security tools by running scanners in workspace hooks — no CI pipeline modifications, no Sortie plugins, no vendor lock-in.

Security teams often require SAST, secret scanning, or dependency audits on all code changes regardless of who wrote them. Sortie's `after_run` and `before_run` hooks run arbitrary shell scripts at specific lifecycle points, making them the natural place to plug in existing tooling. The agent writes code; the hook scans it.

## Prerequisites

- Sortie up and running with at least one workspace configured ([quick start](/getting-started/quick-start/))
- Hooks configured for your workspace ([set up workspace hooks](/guides/setup-workspace-hooks/))
- At least one security scanner installed on the orchestrator host: [gitleaks](https://github.com/gitleaks/gitleaks), [semgrep](https://semgrep.dev/docs/getting-started/), [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck), or equivalent

## Which hook to use

Four workspace hooks fire at different lifecycle points. Choose based on whether you want findings to *log* or *block*:

| Goal | Hook | Why |
|---|---|---|
| Scan code the agent just wrote | `after_run` | Agent has written its files; code is on disk. Non-zero exit is logged and ignored — findings record but don't block. |
| Block dispatch on a known-bad workspace | `before_run` | Fatal on non-zero exit. Aborts the current attempt and schedules a retry. |
| Scan dependencies before the agent starts | `before_run` | Lock files from the prior `after_run` (or the initial clone) are already present. |

Most teams use `after_run` for scanning combined with existing CI gates for hard enforcement. If you need Sortie itself to block on findings, the [two-hook pattern](#fail-the-session-on-critical-findings) covers that.

## Scan for secrets with gitleaks

Add a `gitleaks` scan to your `after_run` hook:

```yaml
hooks:
  after_run: |
    if command -v gitleaks >/dev/null 2>&1; then
      gitleaks detect --source . --no-git --report-format json \
        --report-path .sortie/gitleaks-report.json 2>/dev/null
      if [ $? -ne 0 ]; then
        echo "SECURITY: gitleaks found secrets in workspace"
        cat .sortie/gitleaks-report.json
      fi
    fi
```

A few flags worth calling out:

- `--no-git` scans the working directory rather than git history. Faster, and catches uncommitted files the agent just wrote.
- `--report-path .sortie/gitleaks-report.json` writes findings to the workspace for later inspection. The `.sortie/` directory is not special to Sortie — it is a convention for workspace metadata that agents and hooks can read and write freely.
- The `command -v` guard makes the hook a no-op when gitleaks isn't installed. The same hook works on development laptops and CI-configured build servers without modification.

Because `after_run` non-zero exits are ignored, gitleaks finding secrets does not abort the workflow. Findings appear in Sortie's logs and in the report file. Sortie truncates long hook output in logs, so the `cat` of the JSON report may be truncated for large finding sets — read the file directly for full output.

## Run SAST with semgrep

```yaml
hooks:
  after_run: |
    if command -v semgrep >/dev/null 2>&1; then
      semgrep scan --config auto --json --quiet \
        --output .sortie/semgrep-report.json . 2>/dev/null || true
      if [ -s .sortie/semgrep-report.json ]; then
        echo "SECURITY: semgrep findings detected"
      fi
    fi
```

`--config auto` selects rulesets that match the languages semgrep detects in the workspace. `--quiet` suppresses progress output that would clutter Sortie's logs. The `|| true` prevents semgrep's exit codes — which include "findings present" in addition to actual errors — from being treated as hook failures.

For Go projects, `gosec` is a focused alternative that understands Go-specific patterns:

```yaml
hooks:
  after_run: |
    if command -v gosec >/dev/null 2>&1; then
      gosec -fmt json -out .sortie/gosec-report.json ./... 2>/dev/null || true
    fi
```

## Check dependencies for vulnerabilities

For Go projects, `govulncheck` checks only reachable code paths — it skips vulnerabilities in dependencies your code never calls:

```yaml
hooks:
  after_run: |
    if command -v govulncheck >/dev/null 2>&1; then
      govulncheck ./... 2>&1 | tee .sortie/govulncheck-report.txt
    fi
```

For Node.js projects:

```yaml
hooks:
  after_run: |
    if [ -f package-lock.json ]; then
      npm audit --json > .sortie/npm-audit-report.json 2>/dev/null || true
    fi
```

The `package-lock.json` guard prevents the hook from failing on runs where the agent worked on non-Node files and never created a lock file.

## Fail the session on critical findings

When you want Sortie to block on findings — not just log them — use the two-hook pattern. `after_run` scans and writes findings to a file. `before_run` checks that file on the next attempt and exits non-zero if critical findings remain. A non-zero exit from `before_run` aborts the attempt and schedules a retry with exponential backoff.

```yaml
hooks:
  after_run: |
    gitleaks detect --source . --no-git --report-format json \
      --report-path .sortie/gitleaks-report.json 2>/dev/null || true
  before_run: |
    if [ -f .sortie/gitleaks-report.json ]; then
      findings=$(cat .sortie/gitleaks-report.json | python3 -c \
        "import json,sys; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo 0)
      if [ "$findings" -gt 0 ]; then
        echo "SECURITY: blocking dispatch -- $findings secret(s) found in workspace from prior run"
        echo "Review .sortie/gitleaks-report.json and remove secrets before retrying"
        exit 1
      fi
    fi
```

The sequence on first dispatch: the agent writes code, `after_run` scans and records findings. On the second attempt, `before_run` reads the findings file and aborts if anything critical is present. The issue stays blocked until an operator inspects the workspace, resolves the problem, deletes `.sortie/gitleaks-report.json`, and lets the retry proceed naturally.

The first attempt always completes. This is intentional — the agent needs to write code before there is anything to scan.

For how a blocked `before_run` interacts with retry budgets and backoff timing, see [Configure retry behavior](/guides/configure-retry-behavior/).

## Combine multiple scanners

Here is a production-ready `after_run` combining gitleaks and semgrep:

```yaml
hooks:
  after_run: |
    mkdir -p .sortie/security

    # Secret scanning
    if command -v gitleaks >/dev/null 2>&1; then
      gitleaks detect --source . --no-git --report-format json \
        --report-path .sortie/security/secrets.json 2>/dev/null
      [ $? -ne 0 ] && echo "SECURITY: secrets detected"
    fi

    # SAST
    if command -v semgrep >/dev/null 2>&1; then
      semgrep scan --config auto --json --quiet \
        --output .sortie/security/sast.json . 2>/dev/null || true
    fi

    echo "Security scan complete. Reports in .sortie/security/"
  timeout_ms: 120000
```

`timeout_ms: 120000` raises the hook timeout to 2 minutes. The default 60 seconds is tight for semgrep scans on larger codebases — a medium Go or Python project can take 20–40 seconds. All hooks share this value, so set it to your slowest scanner's expected worst case. The `.sortie/security/` subdirectory keeps findings organized and readable by both human operators and follow-up automation.

For all available hook configuration fields, see the [workflow config reference](/reference/workflow-config/).

## Trade-offs

Hook-based scanning is flexible. Any tool that runs on the command line works. The same scripts used in CI or local git hooks drop straight into a WORKFLOW.md hook without modification.

The main limitation is scope: hooks scan the workspace, not the diff. A scanner reports all findings in the working directory, not just the code the agent introduced this run. For codebases with pre-existing findings, this creates noise. Mitigate with baseline files — `semgrep --baseline-commit` and `gitleaks --baseline-path` compare against a known-good state rather than scanning everything cold.

Hook execution adds latency on every attempt. A semgrep scan of a medium codebase takes 10–30 seconds. For issues that retry frequently, that compounds. If scan latency becomes a problem, skip scanning on early attempts using the `SORTIE_ATTEMPT` variable:

```sh
# Skip scanning on the first two attempts
if [ "$SORTIE_ATTEMPT" -lt 2 ]; then exit 0; fi
```

The strongest enforcement point remains your CI pipeline. Hooks catch findings early — before the PR exists — but they run on the orchestrator host, without CI's reproducibility guarantees. Treat hooks as an early warning system and your CI pipeline as the gate of record. The two reinforce each other: hooks reduce the number of PRs that fail CI; CI ensures nothing slips through regardless of hook coverage.

## What you've configured

After following this guide, your workspace hooks scan agent-generated code on every attempt and write structured reports to `.sortie/security/`. Findings appear in Sortie's logs immediately. If you added the two-hook enforcement pattern, attempts on a workspace with unresolved critical findings block until an operator clears them.

For further reading:

- [Set up workspace hooks](/guides/setup-workspace-hooks/) — hook lifecycle and environment variables
- [Configure retry behavior](/guides/configure-retry-behavior/) — what happens when `before_run` exits non-zero
- [Security model](/concepts/security/) — Sortie's trust boundaries and what the operator is responsible for
- [Errors reference](/reference/errors/) — how hook failures are classified in error logs
