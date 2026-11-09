# Graph-It-Live installation, MCP server and VS Code

Read on demand from the `graph-it-live` skill.

## Install (only on explicit request)

Requires Node.js 22 or later.

```bash
npm install -g @magic5644/graph-it-live   # then: graph-it --version
npx @magic5644/graph-it-live <command>     # without installing
```

## MCP server mode

```bash
graph-it serve
```

MCP availability is set by the connected host's advertised tools and input schemas; it can differ
from the CLI inventory. Use only advertised names, namespaces and parameters. MCP `response_format`
(`toon|markdown|json`, TOON by default on current servers) is not the CLI `--format` flag; pass it only
when the schema advertises it. If the host advertises `graph_context`, use it for open-ended
questions.

**VS Code / Cursor** (`.vscode/mcp.json` or `.cursor/mcp.json`):

```json
{
  "servers": {
    "graph-it-live": {
      "type": "stdio",
      "command": "graph-it",
      "args": ["serve"],
      "env": { "WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

**Claude Desktop** (`~/.config/claude/claude_desktop_config.json`) and **Windsurf**
(`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "graph-it",
      "args": ["serve"],
      "env": { "WORKSPACE_ROOT": "/path/to/project" }
    }
  }
}
```

**Claude Code CLI:** `claude mcp add graph-it -- graph-it serve`

**Codex CLI:** `codex mcp add graph-it-live --env WORKSPACE_ROOT=/path/to/project -- graph-it serve`

`graph-it --help` prints the same snippets for the installed version.

## VS Code extension

Graph-It-Live is also a VS Code extension with native language model tools for Copilot Agent mode (no
MCP setup needed); they answer in TOON by default. Install it from the Marketplace (search
"Graph-It-Live"). To expose the MCP server from the extension, set `graph-it-live.enableMcpServer` to
`true`.
