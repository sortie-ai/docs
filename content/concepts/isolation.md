---
title: "Workspace Isolation"
description: "How Sortie isolates concurrent agent sessions in per-issue directories: safety invariants, the hook-based extension model, and why alternatives like containers and git worktrees were rejected."
keywords: sortie workspace isolation, agent isolation, workspace safety, directory per issue, autonomous coding agent orchestration, workspace hooks, git worktree alternative
author: Sortie AI
date: 2026-03-31
weight: 70
---

# Why every issue gets its own directory

Sortie runs multiple coding agents in parallel, each working on a different issue. Each agent gets its own filesystem directory -- its working directory, its git clone (if hooks set one up), its build cache, its scratch space. One directory per issue, nothing shared.

This sounds like the obvious approach, but the design space has real alternatives. Some orchestrators give agents a shared checkout with branch switching. Some use containers. Some use git worktrees off a shared bare repository. Sortie chose the simplest model and makes the operator responsible for what goes inside it. The reasoning behind that choice shapes everything from hook scripts to SSH worker support.

## The architectural constraint behind the choice

Sortie is agent-agnostic, tracker-agnostic, and VCS-agnostic. The orchestrator core knows nothing about git, Jira, Claude Code, or any particular development workflow. When you extend that principle to workspaces, the only model that doesn't violate it is a bare directory. A directory is the universal primitive -- every VCS can populate one, every build system can work in one, every coding agent can accept one as its working directory.

Embedding git-specific workspace logic would mean the orchestrator treats git repositories differently from Perforce depots, SVN checkouts, or plain file trees. That's a crack in the abstraction -- a small one at first, but cracks in abstractions widen under pressure. Next it's submodule handling, then sparse checkout configuration, then LFS filters. The workspace stops being a neutral isolation boundary and becomes a git management layer.

Instead, Sortie creates an empty directory and hands control to the operator through lifecycle hooks. For most teams that means git. But the core never assumes it.

## What Sortie guarantees

Three safety invariants are enforced unconditionally on every workspace operation. They are not configurable. There is no WORKFLOW.md field to relax them. They exist because directory creation from external input -- issue identifiers controlled by whoever can file tickets -- is the most common class of filesystem vulnerability in orchestration systems.

**Path containment enforces a flat workspace layout.** An issue identifier like `../../etc/shadow` must not create a workspace outside the configured root. Sortie resolves both the workspace root and the computed workspace path to absolute form with symlinks evaluated, then verifies that the workspace is a *direct child* of the root -- not merely a descendant. The containment check rejects any relative path that contains a path separator, so nested structures like `team/project/issue-123` are flattened by sanitization rather than allowed as subdirectories. This is a deliberate design decision: a flat layout means every workspace is one `ls` away from inspection, cleanup is a single `rm -rf` with no recursive discovery, and there is no ambiguity about which directory belongs to which issue. The check uses path relationship analysis, not string prefix matching -- the naive approach that breaks when the root is `/workspaces` and an attacker crafts a path under `/workspaces-evil`.

**Name sanitization neutralizes shell injection.** Issue identifiers arrive from trackers as arbitrary strings. An identifier like `FIX/login; rm -rf /` becomes `FIX_login__rm_-rf__` before it touches the filesystem. Only `[A-Za-z0-9._-]` survive; everything else becomes underscore. The special names `.` and `..` are rejected outright. This is a hard boundary between tracker-controlled input and filesystem operations -- not cosmetic filtering for display.

**Symlink rejection and atomic creation close race windows.** If a workspace path already exists as a symlink, Sortie rejects it rather than following it. This prevents an attacker who can write to the workspace root from planting a symlink that redirects workspace creation to an arbitrary location. Directory creation itself uses atomic `os.Mkdir` -- not `os.MkdirAll` -- so the "created now" signal is reliable even when external processes share the filesystem. There is no window between checking whether a directory exists and creating it.

Before launching any agent subprocess, Sortie verifies that the process working directory matches the expected workspace path. If someone or something moved the directory, swapped it with a symlink, or changed the configuration between workspace creation and agent launch, the run does not start. Workspaces persist across sessions for the same issue -- a retry reuses the same directory, so agents can build on partial commits, cached dependencies, and compilation artifacts from earlier attempts. The [orchestration model](/concepts/orchestration/) explains how retries interact with workspace lifecycle.

These invariants are cheap to enforce, produce zero false positives, and work identically across Linux, macOS, and Windows. They represent the baseline that every Sortie deployment gets regardless of the operator's trust posture or infrastructure choices. The [workflow file reference](/reference/workflow-config/) documents `workspace.root`, hook fields, and timeout defaults; the [architecture spec Section 9](https://github.com/sortie-ai/sortie/blob/main/docs/architecture.md#9-workspace-management-and-safety) contains the full workspace management specification.

## What Sortie does not isolate

The workspace model provides filesystem safety, not process sandboxing. The distinction matters, and being clear about it is more useful than pretending it doesn't exist.

An agent that writes files using absolute paths can write anywhere the host user can write. Sortie sets the initial working directory; it does not restrict where the process goes from there. An agent can reach any network endpoint the host can reach. One agent can consume all available CPU, memory, or disk unless the operator imposes OS-level limits. Agent A can read Agent B's workspace if it knows the path -- there are no filesystem permission barriers between workspaces unless the operator creates them.

Why doesn't Sortie solve these? Because prescribing a single sandbox model would limit where Sortie can run. A developer laptop has different constraints than a locked-down CI server. Docker is not available everywhere. Each coding agent already has its own sandbox mechanism -- Claude Code has `--allowedTools`, Copilot CLI has sandbox policies. Sortie passes these through to the adapter rather than overriding them.

The trust model mirrors CI systems. Jenkins gives you workspaces, not containers. If you want containers, you configure them through your pipeline definition. If you want agents running under dedicated OS users with restricted filesystem permissions, you set that up at the deployment level. Sortie provides the workspace safety invariants as a foundation. The operator builds the walls appropriate to their environment. The [security model](/concepts/security/) document covers this split in detail, including hardening guidance for different deployment scenarios.

## Why not git worktrees

The team evaluated `git worktree` as an alternative to full clones. The appeal is real: one shared bare repository with `git worktree add` per issue. One `.git` directory instead of N. One fetch updates all worktrees.

Three problems killed it.

**SSH workers make worktrees impossible without shared storage.** Sortie's [SSH worker extension](/guides/scale-agents-with-ssh/) executes agents on remote hosts. Each host interprets `workspace.root` locally and operates autonomously -- no shared filesystem, no network-mounted volumes. Git worktrees require all worktrees to reference one physical `.git` directory on one filesystem. Making this work across hosts requires NFS or similar shared storage, adding an infrastructure dependency that contradicts the zero-dependency model. Worktrees work fine on a single machine. They fall apart the moment you distribute work across hosts.

**Concurrent git operations on a shared `.git` directory cause lock contention.** Git uses file-level locking for index operations. With N parallel agents, a fetch in the shared repository during a checkout in a worktree produces lock errors -- `index.lock`, `shallow.lock`. These failures are sporadic, load-dependent, and non-deterministic: hard to reproduce locally, easy to dismiss as "flaky," and deeply confusing when they hit at 3 AM with ten agents running.

**The architectural principle doesn't bend.** Embedding git worktree management as a first-class feature would be the first VCS-specific code in the orchestrator core. That's a precedent with consequences. If the core knows about worktrees, why not submodules? LFS? Sparse checkouts? The VCS-agnostic boundary exists to prevent this scope creep. Implementing worktrees through hooks -- which is technically possible -- provides no advantage over clone-based hooks. You trade one set of git commands for another, except worktree commands have more fragile cleanup. `rm -rf` always works. `git worktree remove` requires the `.git` directory to be intact and the worktree to be properly registered.

Worktrees are a fine tool for human developers managing multiple branches. For an orchestrator managing autonomous agents at concurrency, the failure modes are too subtle and the architectural cost too high.

## Why not containers

Containers solve a different problem at a different layer. Workspace isolation is about giving each issue its own filesystem scope; container isolation is about sandboxing the process that runs inside it. Sortie doesn't build in container support for the same reason it doesn't build in git support -- it would add a runtime dependency (Docker daemon, Podman, a Linux VM on macOS) that contradicts the single-binary deployment model, and coding agent environments vary too widely across teams for a universal container image to exist. Operators who want container isolation can launch one in `before_run` and tear it down in `after_run`, or run the entire Sortie process inside a container with restricted capabilities. The hook model composes with container tooling without requiring Sortie to contain container orchestration logic.

## Hooks as isolation policy

The four lifecycle hooks -- `after_create`, `before_run`, `after_run`, `before_remove` -- are the extension point for the isolation model. They turn a bare directory into whatever execution environment the operator needs.

A typical git-based deployment uses `after_create` for the initial clone and `before_run` for branch creation off a fresh `main`:

```yaml
hooks:
  after_create: |
    git clone --depth 1 "$REPO_URL" .
  before_run: |
    git fetch origin main
    git checkout -b "$SORTIE_ISSUE_IDENTIFIER" origin/main
```

But hooks serve a broader purpose than VCS setup. They are where any isolation policy the operator wants gets implemented: container launch and teardown, filesystem snapshots for hermetic builds, dependency cache warm-up, security scanning gates before an agent touches the code.

The cost of this flexibility is real. A production git workflow is not two lines. It handles edge cases: what if the branch already exists on the remote? What if `main` moved since the last clone? What if there are submodules? Sortie documents recommended starter recipes for common setups, but the operator owns the complexity of their hook scripts. That complexity exists whether it lives in hooks, in a CI pipeline, or in a custom tool. Sortie provides the lifecycle events and environment variables (`SORTIE_ISSUE_ID`, `SORTIE_WORKSPACE`, `SORTIE_ATTEMPT`) to write them against.

The alternative -- built-in VCS support -- would reduce hook complexity for git users while adding maintenance burden to Sortie's core and excluding non-git users. Given the agent-agnostic, tracker-agnostic, VCS-agnostic positioning, the hook model is the consistent choice. The complexity is in the right place: with the operator who understands their repository topology, not in the orchestrator core that doesn't.

## Making the model scale

The current model has real costs at concurrency. Ten concurrent agents mean ten full git clones -- disk space, network bandwidth, and wall-clock time for the initial setup. For large repositories, this adds up. Acknowledging the cost is the first step toward addressing it.

Two optimizations work within the current architecture without changing the isolation model.

**`git clone --reference` creates a shared object store.** A single reference repository via git alternates lets each workspace share immutable git objects while remaining a fully independent git directory. Each workspace has its own index, its own HEAD, its own branches. No lock contention because there is no shared mutable state. Each workspace is still safe to `rm -rf`. On SSH worker hosts, you duplicate the reference repository on each host -- one copy per host instead of one per workspace.

> [!WARNING]
> Git alternates create a live dependency on the reference repository's object store. If `git gc --prune` runs on the reference repo while workspaces still reference its objects, those workspaces can break. Either disable automatic gc on the reference repo, or use `git clone --reference --dissociate` to copy objects at clone time instead of linking them. `--dissociate` trades the disk savings for independence from the reference repo's lifecycle.

**Shallow clones with `--depth 1` reduce initial setup to seconds.** Most agent workflows don't need repository history. A depth-1 clone fetches one commit and its tree -- orders of magnitude less data than a full clone. Combined with `--reference`, you get fast workspace creation with shared storage for the cases where history is needed.

Both optimizations live in hook scripts, not in Sortie's core. They are standard git features that operators can adopt incrementally. The N-clone cost is real for a naive setup but addressable through well-known git mechanisms without changing the architectural foundations.

## The design bet

The workspace isolation model is a bet on composability over completeness. Sortie provides a minimal, safe, VCS-agnostic workspace primitive and lets operators compose it with their existing tools -- git, Docker, NFS, cgroups, whatever their environment demands. The alternative would be a more opinionated system that handles git natively, manages containers, and prescribes a sandbox policy. That system would be easier to set up for the common case and harder to adapt for everything else.

The bet pays off when your deployment doesn't match the common case -- when you use Perforce instead of git, when Docker isn't available, when your agents run across SSH workers on heterogeneous hosts, when your security team requires a sandbox configuration that a built-in model can't express. It costs you when all you want is a git clone and a branch, because you'll write hook scripts instead of setting a config flag.

Whether that trade-off works for you depends on how much you value deployment flexibility versus out-of-the-box convenience. The [workspace hooks guide](/guides/setup-workspace-hooks/) has starter recipes that cover the common git setup in about ten lines. The [architecture overview](/concepts/architecture/) explains how this fits into the broader design. And the [security model](/concepts/security/) covers where workspace isolation ends and operator responsibility begins.

The isolation model does exactly what it claims to do -- no more, no less.
