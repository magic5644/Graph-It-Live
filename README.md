# Graph-It-Live

<div align="center">
  <img src="media/Graph-It-Live-Logo-256.png" alt="Graph-It-Live Logo" width="400"/>
</div>

[![Version](https://img.shields.io/visual-studio-marketplace/v/magic5644.graph-it-live?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=magic5644.graph-it-live)
[![Open VSX Version](https://img.shields.io/open-vsx/v/magic5644/graph-it-live?label=Open%20VSX&logo=eclipse&logoColor=white)](https://open-vsx.org/extension/magic5644/graph-it-live)
[![AI Ready](https://img.shields.io/badge/AI%20Ready-MCP%20Server-blue?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/github/license/magic5644/Graph-It-Live)](https://github.com/magic5644/Graph-It-Live/blob/main/LICENSE)
[![Github stars](https://img.shields.io/github/stars/magic5644/graph-it-live?style=flat&color=gold&logo=github)](https://github.com/magic5644/Graph-It-Live)
[![vscode downloads](https://img.shields.io/visual-studio-marketplace/d/magic5644.graph-it-live?label=vscode%20Marketplace%20Downloads)](https://marketplace.visualstudio.com/items?itemName=magic5644.graph-it-live)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/magic5644/graph-it-live?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/magic5644/graph-it-live)

**Give your AI "eyes" to see your entire codebase structure.**

Graph-It-Live is a dual-purpose tool:

1.**For Humans**: A real-time interactive graph to visualize and navigate dependencies in **TypeScript**, **JavaScript**, **Python**, **Rust**,**Vue**, **Svelte**, and **GraphQL** projects.

2.**For AI**: A built-in **Model Context Protocol (MCP) Server** that lets assistants like **GitHub Copilot**, **Claude**, and **Cursor** analyze your project's architecture, find impact of changes, and understand complex relationships without hallucinating.

<div align="center">
  <img src="media/demo-plugin-graph-it-live.gif" alt="Graph-It-Live Demo" width="800"/>
</div>

## 🤖 Supercharge Your AI Assistant

Stop pasting file paths and explaining your project structure. Graph-It-Live exposes **17 powerful dependency analysis tools** directly to your AI assistant via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

**What your AI can do with Graph-It-Live:**

* **"Map out the architecture of the `auth` module"** -> AI crawls the dependency tree.
* **"What breaks if I change `User.ts`?"** -> AI performs instant reverse lookup to find all dependents.
* **"What calls `formatDate()` function?"** -> AI finds all symbol-level callers with O(1) lookup.
* **"Show me function-level dependencies in this file"** -> AI analyzes symbol-level relationships.
* **"Analyze the impact of changing `calculateTotal`'s signature"** -> AI detects breaking changes.
* **"Find unused exports in the codebase"** -> AI detects dead code automatically.
* **"Are there circular dependencies?"** -> AI detects cycles automatically.
* **"Explain how data flows from `App.vue` to the API"** -> AI traces the import path.

<div align="center">
  <img src="media/graph-it-live-tools-in-copilot.gif" alt="Using Graph-It-Live tools with GitHub Copilot" width="800"/>
  <p><em>Example: Asking GitHub Copilot to analyze dependencies using Graph-It-Live tools</em></p>
</div>

## Features

* **MCP Server for AI Integration** *(New)*: Built-in **Model Context Protocol (MCP) Server** exposes dependency analysis tools to AI assistants.
* **Unused Dependency Filter** *(New)*: Smart filter to show only dependencies that are actually used in your code. Toggle between showing all imports or filtering unused ones with a single click. Configurable to either hide unused edges completely or show them dimmed.

<div align="center">
  <img src="media/demo-filter-hide-mode.gif" alt="Hide mode - removes unused dependencies" width="600"/>
  <p><em>Hide mode: Unused dependencies are completely removed from the graph</em></p>
</div>

<div align="center">
  <img src="media/demo-filter-dim-mode.gif" alt="Dim mode - shows unused dependencies with reduced opacity" width="600"/>
  <p><em>Dim mode: Unused dependencies are shown with reduced opacity and dashed lines</em></p>
</div>

* **Symbol-Level Analysis** *(New)*: Drill down to see function-to-function and class-to-class dependencies within files.
* **Real-time Dependency Visualization**: Interactive graph showing file dependencies.
* **Multi-Language Support**: First-class support for **TypeScript** (`.ts`, `.tsx`), **JavaScript** (`.js`, `.jsx`), **Python** (`.py`, `.pyi`), **Rust** (`.rs`), **TOML** (`.toml`), **Vue** (`.vue`), **Svelte** (`.svelte`), and **GraphQL** (`.gql`, `.graphql`).
* **Cycle Detection**: Automatically detects and highlights circular dependencies with red dashed lines and badges.
* **Smart Navigation**: Use VS Code's built-in navigation (Go Back / Go Forward) to move through your code history. Graph-It-Live also exposes navigation actions in the webview or panel menu.
* **Background Indexing** *(New)*: Optionally index your entire workspace in the background for instant reverse dependency lookups. Uses a separate worker thread to avoid blocking the IDE.
* **Interactive Graph**:
  * **Filter Unused Dependencies**: Use the eye/eye-closed toggle button in the toolbar to show only imports that are actually used in the code. Choose between hiding unused edges completely or showing them dimmed.
  * **Expand/Collapse**: Dynamically load dependencies using the node controls available in the webview/panel menu or the node's context menu (hover actions may still appear depending on layout).
  * **Bidirectional Navigation**: Use the "Find Referencing Files" action from a node's context menu or the webview/panel menu to see files that import the selected file. With background indexing enabled, this is instant (O(1) lookup).
  * **File Navigation**: Click on any node to instantly open the corresponding file in the editor.
  * **Drill-Down** *(New)*: Double-click a file node or choose the "Drill Down" action in the node context menu or webview/panel menu to see symbol-level dependencies within that file.

<div align="center">
  <img src="media/drill-down-symbol-view.png" alt="Symbol-level drill-down view" width="600"/>
  <p><em>Symbol-level drill-down: explore function and class dependencies within a file</em></p>
</div>

## Prerequisites

* **Node.js**: v18 or higher (v20 LTS recommended)
* **VS Code**: v1.96.0 or higher

## Installation

### From Marketplace

Install directly from the VS Code Marketplace (when published) or search for "Graph-It-Live" in the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).

### From Open VSX Registry

The extension is also available on the [Open VSX Registry](https://open-vsx.org/). You can install it using a compatible editor (like VSCodium) or by downloading the `.vsix` from the registry page.

## Usage

1.**Open a Project**: Open a folder containing TypeScript, JavaScript, Python, Rust, TOML, Vue, Svelte, or GraphQL files.
2.**Open the Graph**:
    -   Click the **Graph-It-Live** icon in the Activity Bar (left sidebar).
    -   Or run the command: `Graph-It-Live: Show Dependency Graph`.
    -   Or click the graph icon in the editor title bar when viewing a supported file.
3.**Interact**:
    -   **Navigate**: Click a node to open the file.
    -   **Expand**: Use the "Expand" action from the node context menu or the webview/panel menu to reveal a node's dependencies.
    -   **Drill-Down**: Double-click a file node or choose the "Drill Down" action in the node context menu to see symbol-level dependencies (functions, classes) within that file.
    -   **Reverse Lookup**: Use the "Find Referencing Files" action in the node context menu or the webview/panel menu to see which files import the current file.

## Configuration

### Performance Profiles

For optimal performance on your machine, configure the performance profile in VS Code settings:

**Setting**: `graph-it-live.performanceProfile`

- **`default`** *(recommended)*: Balanced settings for most machines (4GB-8GB RAM)
  - Concurrency: 4, Max edges: 2000, Cache: 500/200
- **`low-memory`**: Optimized for resource-constrained machines (<4GB RAM)
  - Concurrency: 2, Max edges: 1000, Cache: 200/100
- **`high-performance`**: Maximizes speed on powerful workstations (16GB+ RAM)
  - Concurrency: 12, Max edges: 5000, Cache: 1500/800
- **`custom`**: Manual configuration - all performance settings become editable

#### Automatic Profile Application

When you select a preset profile (`default`, `low-memory`, or `high-performance`):
- All related performance settings are **automatically configured**
- Settings like `unusedAnalysisConcurrency`, `maxCacheSize`, etc. update instantly
- Individual settings become read-only to prevent conflicts

Select **`custom`** profile to unlock manual control of all performance parameters:
- `graph-it-live.unusedAnalysisConcurrency`: Parallel file analysis (1-16)
- `graph-it-live.unusedAnalysisMaxEdges`: Skip auto-analysis threshold (0=unlimited)
- `graph-it-live.maxCacheSize`: Dependency cache size (50-2000)
- `graph-it-live.maxSymbolCacheSize`: Symbol cache size (50-1000)
- `graph-it-live.indexingConcurrency`: Background indexing parallelism (1-16)

### General Settings

Customize the extension in VS Code Settings (`Cmd+,` or `Ctrl+,`):

<div align="center">
  <img src="media/unused-dependency-mode-option.png" alt="Unused Dependency Mode configuration" width="700"/>
  <p><em>Configure how unused dependencies are displayed: hide (remove completely) or dim (show with reduced opacity)</em></p>
</div>

| Setting | Default | Description |
| :--- | :--- | :--- |
| `graph-it-live.performanceProfile` | `default` | Performance preset: `default`, `low-memory`, `high-performance`, or `custom` for manual control. When set to a preset, related performance settings are applied automatically. |
| `graph-it-live.enableMcpServer` | `false` | Enable the MCP (Model Context Protocol) server for AI/LLM integration. Only enable if you need AI assistants to access project analysis tools. |
| `graph-it-live.enableMcpDebugLogging` | `false` | Privacy-sensitive debug logging for the MCP server (creates `~/mcp-debug.log`). Enable only for troubleshooting; logs rotate automatically. See Security Guide. |
| `graph-it-live.maxDepth` | `50` | Maximum dependency depth to analyze during crawls and initial graph generation. |
| `graph-it-live.excludeNodeModules` | `true` | Exclude `node_modules` imports from the graph to reduce noise and improve performance. |
| `graph-it-live.enableBackgroundIndexing` | `true` | Enable background indexing of the workspace for fast reverse dependency lookups (O(1) queries). |
| `graph-it-live.persistIndex` | `false` | Persist the reverse index to disk for faster startup. Index entries are validated by `mtime`/size. |
| `graph-it-live.indexingConcurrency` | `4` | Number of files to process in parallel during background indexing (1-16). Editable only when `performanceProfile` is `custom`. |
| `graph-it-live.indexingStartDelay` | `1000` | Delay (ms) before starting background indexing after activation; allows VS Code to finish startup. |
| `graph-it-live.logLevel` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error`, or `none`. |
| `graph-it-live.unusedDependencyMode` | `hide` | How to display unused dependencies: `hide` removes them, `dim` shows them with reduced opacity and dashed styling. |
| `graph-it-live.unusedAnalysisConcurrency` | `4` | Number of source files to analyze in parallel for unused dependency detection (1-16). Lower values reduce memory usage. Editable only when `performanceProfile` is `custom`. |
| `graph-it-live.unusedAnalysisMaxEdges` | `2000` | Skip automatic unused dependency analysis if the graph has more edges than this threshold. Set to `0` for no limit. Editable only when `performanceProfile` is `custom`. |
| `graph-it-live.persistUnusedAnalysisCache` | `false` | Cache unused dependency analysis results to disk to speed up subsequent loads. Results are invalidated on file change. |
| `graph-it-live.maxUnusedAnalysisCacheSize` | `200` | Maximum number of source files to cache for unused dependency analysis (LRU eviction). Adjust to tune memory vs hit-rate. |
| `graph-it-live.maxCacheSize` | `500` | Maximum number of file dependency analyses to keep in memory cache. Useful to control memory usage. |
| `graph-it-live.maxSymbolCacheSize` | `200` | Maximum number of symbol analysis results to keep in memory cache. |

## MCP Server (AI/LLM Integration)

Graph-It-Live includes an optional **Model Context Protocol (MCP) Server** that exposes its dependency analysis capabilities to AI assistants and LLMs.

### Enabling the MCP Server

Set `graph-it-live.enableMcpServer` to `true` in your VS Code settings. The server will automatically start when the extension activates.

<div align="center">
  <img src="media/enable-mcp-server-tools.gif" alt="Enable MCP Server in VS Code Settings" width="800"/>
</div>

### Available Tools

The MCP server exposes **17 tools** for AI/LLM consumption:

| Tool | Description |
| :--- | :--- |
| `graphitlive_set_workspace` | Set the project directory to analyze (required first if not auto-detected) |
| `graphitlive_analyze_dependencies` | Analyze a single file's direct imports and exports |
| `graphitlive_crawl_dependency_graph` | Crawl the full dependency tree from an entry file |
| `graphitlive_find_referencing_files` | Find all files that import a given file (reverse lookup) |
| `graphitlive_expand_node` | Expand a node to discover dependencies beyond known paths |
| `graphitlive_parse_imports` | Parse raw import statements without path resolution |
| `graphitlive_resolve_module_path` | Resolve a module specifier to an absolute file path |
| `graphitlive_get_symbol_graph` | Get symbol-level dependencies (functions, classes) within a file |
| `graphitlive_find_unused_symbols` | Find potentially unused exported symbols for dead code detection |
| `graphitlive_get_symbol_dependents` | Find all symbols that depend on a specific symbol |
| `graphitlive_trace_function_execution` | Trace the complete execution path through function calls |
| `graphitlive_get_symbol_callers` | Find all callers of a symbol with O(1) instant lookup |
| `graphitlive_analyze_breaking_changes` | Detect breaking changes when modifying function signatures |
| `graphitlive_get_impact_analysis` | Full impact analysis combining callers and breaking changes |
| `graphitlive_get_index_status` | Get the current state of the dependency index |
| `graphitlive_invalidate_files` | Invalidate specific files from the cache after modifications |
| `graphitlive_rebuild_index` | Rebuild the entire dependency index from scratch |

Note: Tool names were renamed from `graphItLive_*` to `graphitlive_*` (snake_case).

### TOON Format (Token-Optimized Output)

All MCP tools now support an optional `format` parameter to reduce token consumption for large datasets:

```json
{
  "tool": "graphitlive_crawl_dependency_graph",
  "params": {
    "entryFile": "/path/to/main.ts",
    "format": "toon"
  }
}
```

**Available formats**:
- `json` (default): Standard JSON output
- `toon`: Compact Token-Oriented Object Notation (saves 30-60% tokens)
- `markdown`: JSON wrapped in markdown code blocks

**Example TOON Output**:
```
files(file,deps,line)
[main.ts,fs|path,10]
[utils.ts,os|crypto,20]

# Token Savings
JSON: 125 tokens
TOON: 48 tokens
Savings: 77 tokens (61.6%)
```

**Learn more**: See [TOON Format Documentation](./docs/TOON_FORMAT.md) for complete specifications and usage examples.

### Manual MCP Server Configuration

If the automatic MCP server registration doesn't work in your editor (e.g., when using Antigravity, Cursor, or if you want to use the server outside of VS Code), you can manually configure the MCP server.

<details>
<summary><strong>Click to expand configuration instructions for VS Code, Cursor, Claude Desktop, etc.</strong></summary>

#### VS Code / VS Code Insiders

Create or edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "graph-it-live": {
      "type": "stdio",
      "command": "node",
      "args": ["${extensionPath:magic5644.graph-it-live}/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}",
        "EXCLUDE_NODE_MODULES": "true",
        "MAX_DEPTH": "50"
      }
    }
  }
}
```

> **Note**: The `${extensionPath:magic5644.graph-it-live}` variable automatically resolves to the extension's installation directory.

#### Cursor

Create or edit `.cursor/mcp.json` in your workspace or `~/.cursor/mcp.json` for global configuration:

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "bash",
      "args": ["-c", "node ~/.cursor/extensions/magic5644.graph-it-live-*/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}",
        "EXCLUDE_NODE_MODULES": "true",
        "MAX_DEPTH": "50"
      }
    }
  }
}
```

#### Antigravity (Google's VS Code fork)

> ⚠️ **Partial Support**: Antigravity's MCP integration is experimental.

Create `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "node",
      "args": ["${extensionPath:magic5644.graph-it-live}/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}",
        "EXCLUDE_NODE_MODULES": "true",
        "MAX_DEPTH": "50"
      }
    }
  }
}
```

#### Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS).

First, find your extension path:

```bash
ls ~/.vscode/extensions/ | grep graph-it-live
# Example output: magic5644.graph-it-live-1.0.0
```

Then use the full path in your config:

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "bash",
      "args": ["-c", "node ~/.vscode/extensions/magic5644.graph-it-live-*/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project",
        "EXCLUDE_NODE_MODULES": "true",
        "MAX_DEPTH": "50"
      }
    }
  }
}
```

#### Development / Local Testing

When developing the extension locally:

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "node",
      "args": ["/path/to/Graph-It-Live/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "/absolute/path/to/your/project",
        "TSCONFIG_PATH": "/absolute/path/to/your/project/tsconfig.json",
        "EXCLUDE_NODE_MODULES": "true",
        "MAX_DEPTH": "50"
      }
    }
  }
}
```

</details>

## Development

### Project Structure

```bash
Graph-It-Live/
├── src/
│   ├── analyzer/          # Dependency analysis (AST parsing)
│   ├── extension/         # VS Code extension host logic
│   ├── shared/            # Shared types
│   └── webview/           # React + ReactFlow UI
├── tests/                 # Vitest unit tests
└── ...
```

### Setup

1.**Clone**:
    ```bash
    git clone https://github.com/magic5644/Graph-It-Live.git
    cd Graph-It-Live
    ```

2.**Install**:
    ```bash
    npm install
    ```

3.**Run**:

    -   Press `F5` in VS Code to start the Extension Development Host.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgements

Language icons provided by [SuperTinyIcons](https://github.com/edent/SuperTinyIcons) - a collection of miniscule SVG versions of website and app logos, under CC0-1.0 license.

## Author

**magic56** (magic5644)
