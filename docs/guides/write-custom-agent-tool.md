---
title: "How to Write a Custom Agent Tool | Sortie"
description: "Step-by-step guide to implementing a custom agent tool for Sortie: implement the AgentTool interface, register the tool, test it, and make it available via MCP during agent sessions."
keywords: sortie custom tool, agent tool, AgentTool interface, tool registry, MCP, Go development, extensibility
author: Sortie AI
---

# How to Write a Custom Agent Tool

This guide walks you through creating a new tool that agents can call during Sortie sessions. You'll implement the `AgentTool` interface, register your tool in the MCP server, and test it — making it available to agents via the MCP `tools/list` and `tools/call` endpoints.

**Prerequisites:**

- Go development environment
- Familiarity with Sortie's codebase layout
- The [agent extensions reference](../reference/agent-extensions.md) for the full tool contract and response format spec

## Understand the tool interface

Every agent tool implements the `AgentTool` interface defined in `internal/domain/tool.go`:

```go
type AgentTool interface {
    Name() string
    Description() string
    InputSchema() json.RawMessage
    Execute(ctx context.Context, input json.RawMessage) (json.RawMessage, error)
}
```

| Method | Purpose |
|---|---|
| `Name()` | Stable identifier used to match incoming `tools/call` requests. Must be unique within the registry. |
| `Description()` | Human-readable summary included in agent prompts and MCP `tools/list` responses. |
| `InputSchema()` | JSON Schema describing the tool's input format. The MCP server sends this to agents so they know what arguments to pass. Return a defensive copy of the schema bytes. |
| `Execute()` | Runs the tool. Receives raw JSON input from the agent, returns raw JSON output. The Go `error` return is for internal failures only (marshal errors, nil dependencies). Tool-level errors go in the JSON response as `{"error": "message"}`. |

## Create the tool package

Create a new package under `internal/tool/`:

```
internal/tool/repostats/
    repostats.go
    repostats_test.go
```

Here's a complete implementation of a `repo_stats` tool that returns file and line counts for the session workspace:

```go
package repostats

import (
    "context"
    "encoding/json"
    "io/fs"
    "os"
    "path/filepath"
    "strings"

    "github.com/sortie-ai/sortie/internal/domain"
)

// Compile-time interface check.
var _ domain.AgentTool = (*RepoStatsTool)(nil)

var inputSchema = json.RawMessage(`{
  "type": "object",
  "properties": {
    "extension": {
      "type": "string",
      "description": "Optional file extension filter (e.g. '.go'). Counts all files if omitted."
    }
  },
  "additionalProperties": false
}`)

// RepoStatsTool implements [domain.AgentTool] for the repo_stats tool.
// Construct via [New]; safe for concurrent use after construction.
type RepoStatsTool struct {
    workspacePath string
}

// New returns a [RepoStatsTool] scoped to the given workspace directory.
// Panics if workspacePath is empty (programming error).
func New(workspacePath string) *RepoStatsTool {
    if workspacePath == "" {
        panic("repostats.New: workspacePath must not be empty")
    }
    return &RepoStatsTool{workspacePath: workspacePath}
}

func (t *RepoStatsTool) Name() string { return "repo_stats" }

func (t *RepoStatsTool) Description() string {
    return "Returns file count and total line count for the session workspace. " +
        "Optionally filters by file extension."
}

// InputSchema returns a defensive copy of the JSON Schema.
func (t *RepoStatsTool) InputSchema() json.RawMessage {
    out := make(json.RawMessage, len(inputSchema))
    copy(out, inputSchema)
    return out
}

func (t *RepoStatsTool) Execute(ctx context.Context, input json.RawMessage) (json.RawMessage, error) {
    var params struct {
        Extension string `json:"extension"`
    }
    if err := json.Unmarshal(input, &params); err != nil {
        return errorResponse("invalid input: " + err.Error())
    }

    var fileCount, lineCount int

    err := filepath.WalkDir(t.workspacePath, func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return nil // skip unreadable entries
        }
        if ctx.Err() != nil {
            return ctx.Err()
        }
        if d.IsDir() {
            if d.Name() == ".git" || d.Name() == "node_modules" {
                return filepath.SkipDir
            }
            return nil
        }
        if params.Extension != "" && filepath.Ext(path) != params.Extension {
            return nil
        }
        fileCount++
        data, readErr := os.ReadFile(path)
        if readErr != nil {
            return nil // skip unreadable files
        }
        lineCount += strings.Count(string(data), "\n")
        return nil
    })
    if err != nil {
        return errorResponse("walk failed: " + err.Error())
    }

    return json.Marshal(map[string]int{
        "file_count": fileCount,
        "line_count": lineCount,
    })
}

func errorResponse(msg string) (json.RawMessage, error) {
    return json.Marshal(map[string]string{"error": msg})
}
```

Key patterns to follow:

- **Compile-time interface check** with `var _ domain.AgentTool = (*RepoStatsTool)(nil)`.
- **Constructor panics** on invalid arguments because callers pass programmer-controlled values, not user input.
- **`InputSchema()` returns a defensive copy** so callers can't mutate the shared schema bytes.
- **`Execute()` returns tool errors as JSON** (`{"error": "..."}`) and reserves the Go `error` return for internal marshal failures.
- **`ctx.Err()` is checked** inside long-running operations to respect cancellation.

## Register the tool in the MCP server

Tools are wired explicitly in the `runMCPServer` function in `cmd/sortie/mcpserver.go`. Registration is conditional — register when the tool's dependencies are available, skip when they aren't:

```go
// In cmd/sortie/mcpserver.go, inside runMCPServer():
toolRegistry := domain.NewToolRegistry()

// Register conditionally based on available context.
if workspacePath := os.Getenv("SORTIE_WORKSPACE"); workspacePath != "" {
    toolRegistry.Register(repostats.New(workspacePath))
}
```

Three rules:

1. **Explicit wiring only.** Do not use `init()` for registration. All tools are wired in `runMCPServer`.
2. **Conditional registration.** Check for required environment variables or dependencies before constructing the tool. Skip gracefully if they're absent.
3. **Unique names.** The `ToolRegistry` panics on duplicate `Name()` values — pick a name that won't collide with existing tools.

## Test the tool

Write unit tests in `repostats_test.go`. Use `t.TempDir()` to create an isolated workspace:

```go
package repostats

import (
    "context"
    "encoding/json"
    "os"
    "path/filepath"
    "testing"
)

func TestRepoStatsTool_Execute(t *testing.T) {
    t.Parallel()

    dir := t.TempDir()
    if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o600); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello\n"), 0o600); err != nil {
        t.Fatal(err)
    }

    tool := New(dir)
    out, err := tool.Execute(context.Background(), json.RawMessage(`{}`))
    if err != nil {
        t.Fatalf("Execute: %v", err)
    }

    var result map[string]int
    if err := json.Unmarshal(out, &result); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if result["file_count"] != 2 {
        t.Errorf("file_count = %d, want 2", result["file_count"])
    }
}

func TestRepoStatsTool_ExecuteWithExtensionFilter(t *testing.T) {
    t.Parallel()

    dir := t.TempDir()
    if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n"), 0o600); err != nil {
        t.Fatal(err)
    }
    if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hello\n"), 0o600); err != nil {
        t.Fatal(err)
    }

    tool := New(dir)
    out, err := tool.Execute(context.Background(), json.RawMessage(`{"extension": ".go"}`))
    if err != nil {
        t.Fatalf("Execute: %v", err)
    }

    var result map[string]int
    if err := json.Unmarshal(out, &result); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if result["file_count"] != 1 {
        t.Errorf("file_count = %d, want 1", result["file_count"])
    }
}

func TestRepoStatsTool_ExecuteReturnsErrorOnBadInput(t *testing.T) {
    t.Parallel()

    tool := New(t.TempDir())
    out, err := tool.Execute(context.Background(), json.RawMessage(`not json`))
    if err != nil {
        t.Fatalf("Execute: unexpected Go error: %v", err)
    }

    var result map[string]string
    if err := json.Unmarshal(out, &result); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if result["error"] == "" {
        t.Error("expected error key in response for invalid input")
    }
}
```

For integration testing, spawn the MCP server with your tool registered and verify it appears in `tools/list` and responds to `tools/call`. See the existing MCP server tests in `cmd/sortie/mcpserver_test.go` for the pattern.

## Access session context

Tools receive session context through environment variables set by the MCP server process. The orchestrator passes these via the `env` block in `.sortie/mcp.json` when launching the sidecar.

Key variables:

| Variable | Purpose |
|---|---|
| `SORTIE_WORKSPACE` | Absolute path to the session workspace directory |
| `SORTIE_ISSUE_ID` | Tracker issue ID for the current session |
| `SORTIE_SESSION_ID` | Unique session identifier |
| `SORTIE_ATTEMPT` | Current retry attempt number (1-based) |
| `SORTIE_DB_PATH` | Path to the SQLite database (read-only access) |

Read them with `os.Getenv` from inside your constructor or `Execute` method, depending on when you need the value. For the full table and details, see the [environment variables reference](../reference/environment.md#mcp-server-environment).

## Understand tool tiers

Sortie tools fall into two tiers:

- **Tier 1** — Pure orchestrator state, no external dependencies. These are always available when their required environment variables are set. Examples: `sortie_status`, `workspace_history`.
- **Tier 2** — Depends on external services (tracker APIs, databases). These must degrade gracefully when the dependency is absent. Return a structured JSON error; never panic or block indefinitely. Example: `tracker_api` skips registration when no tracker adapter is configured.

If your tool depends on an external service, follow the Tier 2 pattern: check availability in the registration block and skip when unavailable.

## Avoid common mistakes

**Ignoring context cancellation.** Tool calls must respect `ctx.Done()`. If your tool does I/O or computation in a loop, check `ctx.Err()` periodically. A hung tool stalls the MCP server and the agent session.

**Returning unstructured strings.** The MCP protocol expects JSON. Return `json.RawMessage` from `Execute`, not a stringified message. If something goes wrong, return `{"error": "descriptive message"}`.

**Blocking network calls without a timeout.** If your tool makes HTTP requests, derive a timeout context from the one passed to `Execute`:

```go
reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
```

A tool that blocks indefinitely freezes the agent's session.

**Writing to the workspace without documenting it.** Agents expect tools to be read-only unless the tool's description states otherwise. If your tool writes files, say so in `Description()` and document the paths.

**Using `init()` for registration.** All tool registration happens explicitly in `runMCPServer`. Global `init()` functions make registration order unpredictable and testing harder.

## Related guides and references

- [Agent extensions reference](../reference/agent-extensions.md) — tool contracts, response formats, and the full `AgentTool` specification
- [Agent communication model](../concepts/agent-communication.md) — why tools use the MCP sidecar channel alongside prompts
- [Environment variables reference](../reference/environment.md#mcp-server-environment) — complete table of MCP server session context variables
- [Use agent tools in prompts](use-agent-tools-in-prompts.md) — how to reference tools from prompt templates
- [WORKFLOW.md reference](../reference/workflow-config.md) — configuring the `agent` section that controls tool availability
- [Error reference](../reference/errors.md) — error kind taxonomy for structured tool error responses
