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
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
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
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
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
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
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
  "path-in": `graph-it path-in — Find incoming dependencies for a target file

Usage: graph-it path-in <file> [options]

Arguments:
  <file>            Target file whose importers should be listed

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it path-in src/index.ts
  graph-it path-in src/index.ts --format mermaid
`,
  "check-dependencies": `graph-it check-dependencies — Check incoming and outgoing dependencies

Usage: graph-it check-dependencies <file> [options]

Arguments:
  <file>            Target file to analyze

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it check-dependencies src/index.ts
`,
  cycles: `graph-it cycles — List confirmed dependency cycles for a file

Usage: graph-it cycles <file> [options]

Arguments:
  <file>            Target file to inspect for cycles

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it cycles src/index.ts
`,
  architecture: `graph-it architecture — Build full workspace dependency architecture

Usage: graph-it architecture [options]

Options:
  --maxFiles N       Optional cap on analyzed source files
  --workspace, -w    Workspace root directory (default: auto-detected)
  --format, -f       Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h         Show this help

Examples:
  graph-it architecture
  graph-it architecture --format mermaid
  graph-it architecture --maxFiles 2000
`,
  check: `graph-it check — Find unused exported symbols in a file

Usage: graph-it check <file> [options]

Arguments:
  <file>            File to check for unused exports

Options:
  --workspace, -w   Workspace root directory (default: auto-detected)
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h        Show this help

Examples:
  graph-it check src/api.ts
`,
  "review-pr": `graph-it review-pr — Review a Git diff against a base ref

Usage: graph-it review-pr --base <git-ref> [options]

Options:
  --base <ref>       Required: Git ref to diff against (e.g. origin/main)
  --head <ref>        Optional: Git ref for the changed side (default: working tree)
  --depth N            Optional: max dependency-impact traversal depth
  --max-files N        Optional: cap on files analyzed
  --workspace, -w      Workspace root directory (default: auto-detected)
  --format, -f         Output format: text|json|toon|markdown|mermaid (default: text)
  --help, -h           Show this help

Examples:
  graph-it review-pr --base origin/main
  graph-it review-pr --base origin/main --head HEAD --format markdown
`,
  query: `graph-it query — Query the codebase with natural language

Usage: graph-it query "<question>" [options]

Arguments:
  <question>          Natural language question about the codebase

Options:
  --depth N            Optional: call-graph traversal depth (default varies)
  --token-budget N     Optional: cap on response size
  --workspace, -w      Workspace root directory (default: auto-detected)
  --format, -f         Output format: text|json|toon (default: text)
  --help, -h           Show this help

Description:
  Uses ANTHROPIC_API_KEY (claude-haiku-4-5) or OPENAI_API_KEY +
  OPENAI_BASE_URL + OPENAI_MODEL when set. Falls back to heuristic
  keyword analysis (with a stderr warning) when no key is configured.

Examples:
  graph-it query "how does Spider crawl files"
  graph-it query "what calls CallGraphIndexer" --depth 3
`,
  wiki: `graph-it wiki — Generate a navigable markdown wiki from the call graph

Usage: graph-it wiki [options]

Options:
  --output <dir>       Output directory, relative to workspace root (default: wiki)
  --scope <rel-path>   Restrict wiki to a relative path within the workspace
  --exclude <pattern>  Glob-like pattern to exclude (repeatable)
  --top N              Number of top hub files to include, 1-50 (default: 10)
  --workspace, -w      Workspace root directory (default: auto-detected)
  --format, -f         Output format: markdown|json|toon (default: markdown)
  --help, -h           Show this help

Description:
  tests/, dist/, *.test.ts and similar are excluded automatically unless
  --exclude is passed, which replaces the default exclusions.

Examples:
  graph-it wiki
  graph-it wiki --output docs/wiki --top 15
  graph-it wiki --scope src/analyzer --exclude "**/*.spec.ts"
`,
  stats: `graph-it stats — Session token stats

Usage: graph-it stats [options]

Options:
  --stats-dir <dir>    Directory containing session stats files (default: .graph-it)
  --format, -f         Output format: text|json|markdown (default: text)
  --help, -h           Show this help

Description:
  Reports TOON encoding size vs. JSON equivalent and LLM usage recorded
  across CLI/MCP sessions. Does not require a workspace scan.

Examples:
  graph-it stats
  graph-it stats --format json
`,
  export: `graph-it export — Export dependency graph as standalone HTML

Usage: graph-it export [scope] --format html [options]

Arguments:
  [scope]              Optional: relative path to scope the exported graph to

Options:
  --output, -o <file>  Output HTML file path (default: graph.html)
  --format, -f          Must be "html" — this is the only supported format
  --workspace, -w       Workspace root directory (default: auto-detected)
  --help, -h            Show this help

Examples:
  graph-it export --format html
  graph-it export src/analyzer --format html --output analyzer.html
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
  --format, -f      Output format: text|json|toon|markdown|mermaid (default: text)
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
