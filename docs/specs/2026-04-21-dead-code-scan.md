# Spec: Workspace-Wide Dead Code Scan

**Date:** 2026-04-21  
**Status:** Approved  
**Author:** Engineering

---

## 1. Problem Statement

`graphitlive_find_unused_symbols` analyses one file at a time.  
To scan a whole workspace an LLM must emit N sequential calls, each with
per-file latency and context overhead.  
There is no CLI shortcut for a full-workspace sweep either.

---

## 2. Goal

Provide a single, efficient mechanism to discover all unused exported symbols
across the entire workspace (or a scoped directory) in one call.

---

## 3. Out of Scope

- IDE inline decorations for unused symbols  
- Auto-removal / codemods  
- Languages not yet supported by the AST analyzer (GraphQL, C#, Go, Java)

---

## 4. User-Facing APIs

### 4.1 MCP Tool — `graphitlive_scan_dead_code`

| Attribute | Value |
|-----------|-------|
| Tool ID | `graphitlive_scan_dead_code` |
| Transport | stdio MCP |
| Internal name | `scan_dead_code` |

**Parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `scopePath` | `string?` | workspace root | Absolute path to a directory to scope the scan. Must be inside the workspace. |
| `maxFiles` | `number?` | 500 | Hard cap on files analysed. Avoids accidental OOM on huge monorepos. |
| `response_format` | `'json'\|'markdown'\|'toon'` | `'toon'` | Output format. |

**Returns** `ScanDeadCodeResult`

```ts
interface DeadCodeFileEntry {
  filePath: string;
  relativePath: string;
  unusedCount: number;
  unusedSymbols: SymbolInfo[];
}

interface ScanDeadCodeResult {
  rootDir: string;
  scopePath: string;
  scannedFiles: number;
  filesWithDeadCode: number;
  totalUnusedSymbols: number;
  entries: DeadCodeFileEntry[];
  skippedFiles: number;    // unsupported language, parse error, etc.
  analysisTimeMs: number;
}
```

### 4.2 CLI extension

```
graph-it check                 # scan whole workspace
graph-it check ./src           # scan a subdirectory  
graph-it check ./src/foo.ts    # per-file (existing behaviour)
```

`graph-it check` with no argument is equivalent to:
`graph-it check <workspaceRoot>`.

### 4.3 LM Tool — `graph-it-live_scan_dead_code`

Same parameters as the MCP tool (minus `response_format`).  
Registered via `LmToolsService.registerScanDeadCode()`.

---

## 5. Architecture

### 5.1 Layers

```
CLI check.ts / LmToolsService        ← consumer
        │
        ▼
src/mcp/tools/deadcode.ts            ← executeScanDeadCode()
        │
        ▼
Spider.scanDeadCode()                ← façade on Spider.ts
        │
        ▼
SpiderSymbolService.scanDeadCode()   ← core batching loop
        │  uses
        ├─ SourceFileCollector.collectAllSourceFiles()
        └─ SpiderSymbolService.findUnusedSymbols()  (existing, per-file)
```

### 5.2 Batching strategy

- Collect all source files under `scopePath` via `SourceFileCollector`.
- Filter to files supported by the AST analyzer
  (`SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS`).
- Apply `maxFiles` cap.
- Process files **sequentially** (reuses symbol cache; avoids memory spikes).
- Accumulate entries where `unusedCount > 0`.

### 5.3 Guards

| Condition | Behaviour |
|-----------|-----------|
| Reverse index not ready | Throw `INDEX_NOT_READY` — never silent O(n²) fallback |
| `scopePath` outside workspace | Throw `SECURITY_ERROR` (path traversal) |
| File parse error | Increment `skippedFiles`, continue |
| `scannedFiles === 0` | Return empty result with `skippedFiles > 0` |

---

## 6. Security

`validateScopePath(scopePath, rootDir)` in `src/mcp/shared/helpers.ts`:

```
resolvedScope = path.resolve(scopePath)
assert resolvedScope.startsWith(path.resolve(rootDir))
assert no null bytes
```

Called before any `fs` access.

---

## 7. Types (additions to `src/mcp/types.ts`)

```ts
export type McpToolName = ... | "scan_dead_code";

export interface DeadCodeFileEntry { ... }
export interface ScanDeadCodeResult { ... }

export const ScanDeadCodeParamsSchema = z.object({
  scopePath: FilePathSchema.optional(),
  maxFiles: z.number().int().min(1).max(10_000).default(500).optional(),
  response_format: ResponseFormatSchema.optional(),
});
export type ScanDeadCodeParams = z.infer<typeof ScanDeadCodeParamsSchema>;
```

---

## 8. Tests

| File | Coverage |
|------|----------|
| `tests/analyzer/SpiderDeadCodeScan.test.ts` | `SpiderSymbolService.scanDeadCode` — happy path, empty workspace, all-used, maxFiles cap |
| `tests/mcp/tools/deadcode.test.ts` | `executeScanDeadCode` — calls spider, maps result, security validation |
| `tests/cli/deadcode.test.ts` | CLI `check` with no arg, dir arg, file arg |
| `tests/vscode-e2e/suite/lmTools.test.ts` | Updated `EXPECTED_TOOLS` count (20 → 21) |

---

## 9. File Change Summary

| File | Change |
|------|--------|
| `src/mcp/types.ts` | Add `"scan_dead_code"` to `McpToolName`; add schemas + interfaces |
| `src/analyzer/spider/SpiderSymbolService.ts` | Add `scanDeadCode()` |
| `src/analyzer/Spider.ts` | Add `scanDeadCode()` façade |
| `src/mcp/shared/helpers.ts` | Add `validateScopePath()` |
| `src/mcp/tools/deadcode.ts` | New: `executeScanDeadCode()` |
| `src/mcp/tools/index.ts` | Export `executeScanDeadCode` |
| `src/mcp/worker/invokeTool.ts` | Add `case "scan_dead_code"` |
| `src/mcp/mcpServer.ts` | Register `graphitlive_scan_dead_code` |
| `src/cli/commands/check.ts` | Make arg optional; handle dir/workspace |
| `src/cli/commands/tool.ts` | Add `scan_dead_code` to `TOOL_NAMES` + `TOOL_DESCRIPTIONS` |
| `src/extension/services/LmToolsService.ts` | Add `registerScanDeadCode()` |
| `tests/vscode-e2e/suite/lmTools.test.ts` | Add tool to `EXPECTED_TOOLS` |
| `tests/analyzer/SpiderDeadCodeScan.test.ts` | New: analyzer unit tests |
| `tests/mcp/tools/deadcode.test.ts` | New: tool unit tests |
| `tests/cli/deadcode.test.ts` | New: CLI integration tests |
