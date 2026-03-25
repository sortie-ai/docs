---
title: CLI Reference | Sortie
description: Complete reference for the sortie command-line interface. Arguments, flags, exit codes, and usage examples.
keywords: sortie CLI, command line, flags, arguments, exit codes, usage
author: Sortie AI
---

# CLI reference

```
sortie [flags] [workflow-path]
```

Sortie runs as a long-lived process. It loads the workflow file, opens the SQLite database, and enters the poll-dispatch loop.

## Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `workflow-path` | No | `./WORKFLOW.md` | Path to the workflow file. Relative paths are resolved to absolute at startup. |

Only one positional argument is accepted. Providing more than one is an error.

## Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--port` | integer | `0` | HTTP server port. Logged at startup but has no runtime effect in the current release. |
| `--version` | boolean | `false` | Print version banner with copyright and exit. |
| `-dumpversion` | boolean | `false` | Print the version string alone and exit. |

When both `--version` and `-dumpversion` are provided, `-dumpversion` takes precedence.

Version flags bypass workflow file validation and database initialization.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean shutdown or version output. |
| `1` | Startup failure: unknown flag, too many arguments, missing workflow file, or invalid configuration. |

## Examples

```sh
# Run with default WORKFLOW.md in current directory
sortie

# Run with explicit workflow path
sortie /etc/sortie/WORKFLOW.md

# Print version
sortie --version

# Print version string only (GCC-style, scripts)
sortie -dumpversion
```
