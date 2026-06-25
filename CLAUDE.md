# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build          # Bundle extension via esbuild + copy WASM files to dist/wasm/
npm run build:cli      # Build CLI only
npm run watch          # Rebuild on change

# Test
npm test               # All tests (Vitest)
npm run test:unit      # Unit tests only
npm run test:cli       # CLI tests
npm run test:coverage  # Coverage report (V8)
npm run test:watch     # Watch mode
npx vitest run tests/path/to/foo.test.ts  # Single test file

# E2E (real VS Code Electron instance)
npm run test:vscode      # E2E from source
npm run test:vscode:vsix # E2E from packaged .vsix

# Lint / Types
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run check:types    # TypeScript strict check

# Package
npm run package        # Build .vsix
npm run package:verify # Verify no .map files in package

# dependencies
npm audit
npm audit fix
cve-lite --verbose # use npm install -g cve-lite to install cve-lite
```

Requires Node.js ≥22. No native compilation needed — Tree-sitter uses WASM.

## Architecture

VS Code extension + standalone CLI + MCP server for AI-friendly dependency visualization.

### Four-Layer Structure

1. **`analyzer/`** — Pure Node.js. **NO vscode imports**. Core analysis: Spider (file-level regex import parsing), SymbolAnalyzer (ts-morph AST), LspCallHierarchyAnalyzer (VS Code LSP), PathResolver, caching.
   - `analyzer/callgraph/` — Live Call Graph: GraphExtractor (Tree-sitter queries), CallGraphIndexer (sql.js SQLite), CallGraphQuery (BFS), cycleUtils.

2. **`extension/`** — VS Code host. GraphProvider orchestrates 8+ services in `extension/services/`: BackgroundIndexingManager, CallGraphViewService, CommandRegistrationService, EditorEventsService, GraphViewService, SymbolViewService, WebviewMessageRouter, etc.

3. **`mcp/`** — MCP server (stdio transport). **NO vscode imports**. 22 tools for LLM clients (Copilot, Claude, Cursor). Standalone Node.js process.

4. **`webview/`** — React 19 browser context. ReactFlow for file/symbol graphs (`webview/components/reactflow/`), Cytoscape.js for live call graph (`webview/components/cytoscape/`). Entry points: `webview/index.tsx` → `dist/webview.js` and `webview/callgraph/index.tsx` → `dist/callgraph.js`.

**`shared/`** — Types, message protocol (extension ↔ webview), path utilities, constants.

### Dual Bundles

- `dist/extension.js` — VS Code extension
- `dist/graph-it.js` — Standalone CLI
- `dist/webview.js` — File/symbol graph React app
- `dist/callgraph.js` — Call graph panel React app

### Message Protocol

Extension ↔ Webview uses typed messages defined in `src/shared/types.ts`. Always update both sides when adding new messages.

## Critical Rules

**No vscode imports** in `analyzer/` or `mcp/` — these run outside VS Code context.

**No .map files in .vsix** — enforced by `npm run package:verify`. Verify: `npx vsce ls | grep "\.map$"` must return empty.

**Cross-platform paths** — use `normalizePath()` from `src/shared/path.ts` before storing paths in Sets/Maps. Never assume case-sensitive filesystem.

**React: no callback props in useMemo/useCallback deps** — causes re-render cascades. Use `useRef` to hold callbacks, omit from deps arrays.

## Codebase Exploration

For broad tasks spanning multiple folders, bootstrap with:
```bash
graph-it architecture --format toon
```
Returns a TOON-format token-optimized snapshot (`nodes`, `edges`, `nodeCount`, `edgeCount`). Then use targeted MCP tools (`generate_codemap`, `query_call_graph`, `analyze_file_logic`) on specific files/symbols.

## Key Docs

- `.github/copilot-instructions.md` — Full dev guide (603 lines): architecture, patterns, WASM, packaging, E2E setup
- `docs/architecture/codemaps/architecture.md` — 5-layer diagram, 50+ components
- `docs/development/CODING_STANDARDS.md` — TypeScript conventions
- `DEVELOPMENT.md` — Setup and testing details

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
