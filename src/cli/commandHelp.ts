/**
 * Per-command help strings for "graph-it <command> --help"
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

const COMMAND_HELP: Record<string, string> = {
  scan: `graph-it scan — Index/re-index the workspace

Usage: graph-it scan [options]

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown (default: text)
  --help, -h        Show this help

Examples:
  graph-it scan
  graph-it scan --workspace /path/to/project
`,
  summary: `graph-it summary — Workspace overview with optional per-file codemap

Usage: graph-it summary [file] [options]

Arguments:
  file              Optional: generate detailed codemap for a specific file

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown (default: text)
  --help, -h        Show this help

Examples:
  graph-it summary
  graph-it summary src/index.ts
`,
  trace: `graph-it trace — Trace execution flow from a symbol

Usage: graph-it trace <file>#<symbol> [options]

Arguments:
  <file>#<symbol>   Entry symbol in format: path/to/file.ts#FunctionName

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it trace src/index.ts#main
  graph-it trace src/api.ts#handleRequest --format mermaid
`,
  explain: `graph-it explain — Analyze file logic (intra-file call hierarchy)

Usage: graph-it explain <file> [options]

Arguments:
  <file>            File to analyze

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown (default: text)
  --help, -h        Show this help

Examples:
  graph-it explain src/utils.ts
`,
  path: `graph-it path — Crawl dependency graph from an entry file

Usage: graph-it path <file> [options]

Arguments:
  <file>            Entry file to start crawling from

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it path src/index.ts
  graph-it path src/index.ts --format mermaid
`,
  check: `graph-it check — Find unused exported symbols in a file

Usage: graph-it check <file> [options]

Arguments:
  <file>            File to check for unused exports

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown (default: text)
  --help, -h        Show this help

Examples:
  graph-it check src/api.ts
`,
  serve: `graph-it serve — Launch MCP stdio server

Usage: graph-it serve [options]

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --help, -h        Show this help

MCP Client Configuration:
  Claude Code CLI:
    claude mcp add graph-it -- graph-it serve

  VS Code / Cursor (.vscode/mcp.json):
    {
      "servers": {
        "graph-it-live": {
          "type": "stdio",
          "command": "graph-it",
          "args": ["serve"],
          "env": { "WORKSPACE_ROOT": "\${workspaceFolder}" }
        }
      }
    }

Examples:
  graph-it serve
  graph-it --workspace /path/to/project serve
`,
  tool: `graph-it tool — Invoke any MCP tool directly

Usage: graph-it tool <name> [--<param>=<value>...] [options]
       graph-it tool --list

Arguments:
  <name>            MCP tool name (see --list for all available tools)

Options:
  --list            List all available MCP tools with descriptions
  --args '<json>'   Pass parameters as a JSON object
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown (default: text)
  --help, -h        Show this help

Examples:
  graph-it tool --list
  graph-it tool get_index_status
  graph-it tool analyze_dependencies --filePath=/abs/path/file.ts
  graph-it tool crawl_dependency_graph --entryFile=/abs/path/file.ts
  graph-it tool --args '{"filePath":"/abs/path/file.ts"}' analyze_dependencies
`,
  install: `graph-it install — Install CLI to system PATH

Usage: graph-it install [options]

Options:
  --help, -h        Show this help

Description:
  Adds the graph-it binary to your system PATH so it can be invoked from
  anywhere without npx. This is a VS Code opt-in convenience command.

Examples:
  graph-it install
`,
  update: `graph-it update — Update to the latest version

Usage: graph-it update [options]

Options:
  --help, -h        Show this help

Description:
  Checks the npm registry for the latest version of @magic5644/graph-it-live
  and runs "npm install -g @magic5644/graph-it-live@<latest>" if an update is
  available. Requires an active internet connection and npm in PATH.

Examples:
  graph-it update
`,
};

const FALLBACK_HELP = `graph-it <command> --help

Run "graph-it --help" to see all available commands.
`;

export function getCommandHelp(command: string): string {
  return COMMAND_HELP[command] ?? `Unknown command "${command}".\n\n${FALLBACK_HELP}`;
}
