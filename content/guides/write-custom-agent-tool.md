---
title: "How to Write a Custom Agent Tool"
linkTitle: "Write a Custom Agent Tool"
description: "Write a custom agent tool for Sortie: implement the AgentTool interface, register it, test it, and expose it over MCP during agent sessions."
keywords: sortie custom tool, agent tool, AgentTool interface, toolresult, tool registry, MCP, Go development, extensibility
author: Sortie AI
date: 2026-04-03
weight: 220
url: /guides/write-custom-agent-tool/
---
This guide walks you through creating a new tool that agents can call during Sortie sessions. You'll implement the `AgentTool` interface, register your tool in the MCP server, and test it — making it available to agents via the MCP `tools/list` and `tools/call` endpoints.

**Prerequisites:**

- Go development environment
- Familiarity with Sortie's codebase layout
- The [agent extensions reference](/reference/agent-extensions/) for the full tool contract and response format spec

{{% steps %}}

### Understand the tool interface

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
| `Execute()` | Runs the tool. Receives raw JSON input from the agent, returns raw JSON output in the uniform envelope: `{"success": true, "data": ...}` on success, `{"success": false, "error": {"kind": "...", "message": "..."}}` on a domain failure, both marshaled through `toolresult`. The Go `error` return is for internal failures only (marshal errors, nil dependencies). |

### Create the tool package

Create a new package under `internal/tool/`:

```
internal/tool/repostats/
    repostats.go
    repostats_test.go
```

Here's a complete implementation of a `repo_stats` tool that returns file and line counts for the session workspace:

```go {filename="repostats.go",hl_lines=[16,39,54,63,72]}
package repostats

import (
    "context"
    "encoding/json"
    "io/fs"
    "os"
    "path/filepath"
    "strings"

    "github.com/sortie-ai/sortie/internal/domain"
    "github.com/sortie-ai/sortie/internal/tool/toolresult"
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
        return toolresult.Failure("invalid_input", "invalid input: "+err.Error())
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
        return toolresult.Failure("walk_failed", "walk failed: "+err.Error())
    }

    return toolresult.Success(map[string]int{
        "file_count": fileCount,
        "line_count": lineCount,
    })
}
```

Key patterns to follow:

- **Compile-time interface check** with `var _ domain.AgentTool = (*RepoStatsTool)(nil)`.
- **Constructor panics** on invalid arguments because callers pass programmer-controlled values, not user input.
- **`InputSchema()` returns a defensive copy** so callers can't mutate the shared schema bytes.
- **`Execute()` returns the uniform envelope** via `toolresult.Success` and `toolresult.Failure`, reserving the Go `error` return for internal marshal failures. Success payloads wrap under `data`, so a single parser handles every tool's result.
- **The `error.kind` values are the tool author's choice**: a small closed set the tool documents, machine-readable and stable. Here `invalid_input` matches the string `tracker_api` and `notify_operator` use for the same situation, and `walk_failed` names the tool-specific failure.
- **`ctx.Err()` is checked** inside long-running operations to respect cancellation.

### Register the tool in the MCP server

Tools are wired explicitly in the `runMCPServer` function in `cmd/sortie/mcpserver.go`. Registration is conditional — register when the tool's dependencies are available, skip when they aren't:

```go {filename="mcpserver.go",hl_lines=[5,6]}
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

### Test the tool

Write unit tests in `repostats_test.go`. Use `t.TempDir()` to create an isolated workspace:

```go {filename="repostats_test.go",hl_lines=["13-14","16","45-46","78-79"]}
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

    var resp struct {
        Success bool           `json:"success"`
        Data    map[string]int `json:"data"`
    }
    if err := json.Unmarshal(out, &resp); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if !resp.Success {
        t.Fatal("success = false, want true")
    }
    if resp.Data["file_count"] != 2 {
        t.Errorf("file_count = %d, want 2", resp.Data["file_count"])
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

    var resp struct {
        Success bool           `json:"success"`
        Data    map[string]int `json:"data"`
    }
    if err := json.Unmarshal(out, &resp); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if !resp.Success {
        t.Fatal("success = false, want true")
    }
    if resp.Data["file_count"] != 1 {
        t.Errorf("file_count = %d, want 1", resp.Data["file_count"])
    }
}

func TestRepoStatsTool_ExecuteReturnsErrorOnBadInput(t *testing.T) {
    t.Parallel()

    tool := New(t.TempDir())
    out, err := tool.Execute(context.Background(), json.RawMessage(`not json`))
    if err != nil {
        t.Fatalf("Execute: unexpected Go error: %v", err)
    }

    var resp struct {
        Success bool `json:"success"`
        Error   struct {
            Kind    string `json:"kind"`
            Message string `json:"message"`
        } `json:"error"`
    }
    if err := json.Unmarshal(out, &resp); err != nil {
        t.Fatalf("unmarshal response: %v", err)
    }
    if resp.Success {
        t.Error("success = true, want false for invalid input")
    }
    if resp.Error.Kind != "invalid_input" {
        t.Errorf("error.kind = %q, want %q", resp.Error.Kind, "invalid_input")
    }
}
```

For integration testing, spawn the MCP server with your tool registered and verify it appears in `tools/list` and responds to `tools/call`. See the existing MCP server tests in `cmd/sortie/mcpserver_test.go` for the pattern.

{{% /steps %}}

## Access session context

Tools receive session context through environment variables set by the MCP server process. The orchestrator passes these via the `env` block in `.sortie/mcp.json` when launching the sidecar.

Key variables:

| Variable | Purpose |
|---|---|
| `SORTIE_WORKSPACE` | Absolute path to the session workspace directory |
| `SORTIE_ISSUE_ID` | Tracker issue ID for the current session |
| `SORTIE_ISSUE_IDENTIFIER` | Human-readable ticket key (e.g., `PROJ-123`) |
| `SORTIE_SESSION_ID` | Unique session identifier |
| `SORTIE_ATTEMPT` | Current retry attempt number (1-based). Absent on first dispatch. |
| `SORTIE_DB_PATH` | Path to the SQLite database (read-only access) |

Read them with `os.Getenv` from inside your constructor or `Execute` method, depending on when you need the value. For the full table and details, see the [environment variables reference](/reference/environment/#mcp-server-environment).

## Understand tool tiers

Sortie classifies every tool by its dependency profile into two tiers; the [agent tools concept](/concepts/agent-tools/) is the canonical home for the model, the guarantees, and the built-in catalog.

The practical rule: if your tool makes external network calls or needs credentials, follow the Tier 2 pattern: check availability in the registration block, skip registration when the dependency is absent, and bound every call with a timeout. Otherwise it is Tier 1, available whenever its session inputs are present. Either way, results use the same uniform envelope.

## Avoid common mistakes

**Ignoring context cancellation.** Tool calls must respect `ctx.Done()`. If your tool does I/O or computation in a loop, check `ctx.Err()` periodically. A hung tool stalls the MCP server and the agent session.

**Returning a bare payload or a flat error string.** Return `json.RawMessage` from `Execute`, shaped by the uniform envelope: `toolresult.Success` for results, `toolresult.Failure` with a machine-readable `kind` for domain failures. A bare success object or a flat `{"error": "..."}` response breaks the contract every built-in tool keeps.

**Blocking network calls without a timeout.** If your tool makes HTTP requests, derive a timeout context from the one passed to `Execute`:

```go
reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
```

A tool that blocks indefinitely freezes the agent's session.

**Writing to the workspace without documenting it.** Agents expect tools to be read-only unless the tool's description states otherwise. If your tool writes files, say so in `Description()` and document the paths.

**Using `init()` for registration.** All tool registration happens explicitly in `runMCPServer`. Global `init()` functions make registration order unpredictable and testing harder.

## Related guides and references

- [Agent extensions reference](/reference/agent-extensions/) — tool contracts, response formats, and the full `AgentTool` specification
- [Agent tools concept](/concepts/agent-tools/) for the tier model: what each tier guarantees and how to classify a new tool
- [Agent communication model](/concepts/agent-communication/) — why tools use the MCP sidecar channel alongside prompts
- [Environment variables reference](/reference/environment/#mcp-server-environment) — complete table of MCP server session context variables
- [Use agent tools in prompts](/guides/use-agent-tools-in-prompts/) — how to reference tools from prompt templates
- [WORKFLOW.md reference](/reference/workflow-config/) — configuring the `agent` section that controls tool availability
- [Error reference](/reference/errors/) — error kind taxonomy for structured tool error responses
