# Data Models & Types

**Last Updated:** 2026-10-09
**Layer:** Shared Types (Cross-Boundary)

## Directory: `src/shared/`

**Note:** Types are now split across multiple files:
- `src/shared/types.ts` - Core shared types
- `src/shared/graph-types.ts` - Graph-specific type definitions
- `src/shared/symbol-types.ts` - Symbol-specific type definitions
- `src/shared/callgraph-types.ts` - Call graph message types (extension ↔ callgraph webview protocol)
- `src/shared/messages.ts` - Extension ↔ webview message protocol
- `src/shared/constants.ts` - Application-wide constants
- `src/shared/path.ts` - Cross-platform path normalization
- `src/shared/logger.ts` - Logging infrastructure
- `src/shared/toon.ts` - Token-Oriented Object Notation
- `src/shared/converters.ts` - Spider AST → LSP format conversion utilities
- `src/shared/index.ts` - Barrel file re-exporting all public shared API
- `src/shared/utils/languageDetection.ts` - Language detection utilities

### Core Data Models

#### Branch Watch

`BranchWatchSnapshot` contains the local reference SHA, `HEAD`, unique merge-base, normalized Git changes, bounded readable paths, fingerprint, and limitations. `BranchWatchResult` adds file impacts, cycle classifications, the additive TS/JS `ReviewGateResult`, and analysis time. `BranchWatchViewState` separates disabled, paused, dirty, running, unavailable, and ready phases so historical results are never presented as current success.

#### File-Level Graph Data

```typescript
// src/shared/types.ts

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  labels: Map<string, string>;
  rootFile: string;
  timestamp?: number;
}

interface GraphNode {
  id: string; // Absolute file path
  label: string; // Display name (filename)
  type: "file" | "external"; // Node classification
  isExternal?: boolean; // From node_modules
  metadata?: {
    language?: string;
    size?: number;
    lastModified?: number;
    exported?: boolean;
  };
}

interface GraphEdge {
  source: string; // Source file path
  target: string; // Target file path
  type: "dependency" | "import"; // Edge classification
  metadata?: {
    lineNumber?: number;
    importType?: "default" | "named" | "namespace";
    isCircular?: boolean;
  };
}
```

#### Symbol-Level Graph Data

```typescript
interface SymbolGraphData {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  labels: Map<string, string>;
  rootSymbol: string; // Format: "filePath:symbolName"
  fileContext: string; // File being analyzed
  timestamp?: number;
}

interface SymbolNode {
  id: string; // Format: "filePath:symbolName"
  label: string; // Symbol name
  type: "function" | "class" | "variable" | "interface" | "type" | "enum";
  filePath: string; // Source file
  isExported: boolean;
  isUsed: boolean; // Has incoming dependencies
  metadata?: {
    language?: string;
    lineNumber?: number;
    signature?: string;
    complexity?: number;
  };
}

interface SymbolEdge {
  source: string; // Source symbol ID
  target: string; // Target symbol ID
  sourceSymbol: string; // Symbol name only
  targetSymbol: string; // Symbol name only
  type: "call" | "reference" | "import";
  metadata?: {
    lineNumber?: number;
    isAsync?: boolean;
    isCircular?: boolean;
  };
}
```

### Call Graph Types (`src/shared/callgraph-types.ts`)

```typescript
// Symbol types recognized by tree-sitter GraphExtractor
type SymbolType = "function" | "class" | "method" | "interface" | "type" | "variable";
type RelationType = "CALLS" | "INHERITS" | "IMPLEMENTS" | "USES";
type SupportedLang = "typescript" | "javascript" | "python" | "rust";

// Serialized Cytoscape nodes sent to webview
interface SerializedCallNode {
  id: string;
  label: string;
  type: SymbolType;
  lang: SupportedLang;
  filePath: string;
  folder: string;
  startLine: number;
  endLine: number;
  isCyclic?: boolean;
  isExported?: boolean;
}

interface SerializedCallEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  isCyclic?: boolean;
}

interface SerializedCompoundNode {
  id: string;
  label: string; // folder name
}

// Extension → webview messages for call graph panel
interface ShowCallGraphMessage {
  type: "showCallGraph";
  nodes: SerializedCallNode[];
  edges: SerializedCallEdge[];
  compounds: SerializedCompoundNode[];
  focusNodeId?: string;
}

interface CallGraphIndexingMessage {
  type: "callGraphIndexing";
  status: "start" | "progress" | "done" | "error";
  message?: string;
  progress?: number;
}

type CallGraphExtensionMessage = ShowCallGraphMessage | CallGraphIndexingMessage;

// Webview → extension messages for call graph panel
interface CallGraphOpenFileCommand {
  command: "callGraphOpenFile";
  filePath: string;
  symbolName: string;
}

interface CallGraphFilterChangedCommand {
  command: "callGraphFilterChanged";
  filters: Record<string, boolean>;
}
```

### Converter Utilities (`src/shared/converters.ts`)

```typescript
// Map string kind to LSP SymbolKind number
function mapKindToLspNumber(kind: string): number;

// Convert Spider AST SymbolInfo[] + SymbolDependency[] → LSP-compatible format
// Used by SymbolViewService and MCP logic.ts tool
function convertSpiderToLspFormat(
  symbols: SymbolInfo[],
  dependencies: SymbolDependency[],
  filePath: string
): { lspSymbols: LspSymbol[]; lspDependencies: LspDependency[] };
```

### Analysis Results

#### Spider Crawl Result

```typescript
interface CrawlResult {
  root: string;
  dependencies: Map<string, Dependency[]>;
  visited: Set<string>;
  errors: SpiderError[];
  metadata: {
    totalFiles: number;
    totalDependencies: number;
    crawlDuration: number;
    maxDepth: number;
  };
}

interface Dependency {
  type: "import" | "require" | "dynamic";
  module: string; // Import path (raw)
  resolvedPath: string; // Absolute file path
  lineNumber?: number;
  isExternal: boolean;
  isType: boolean; // TypeScript type-only import
}
```

#### Symbol Analysis Result

```typescript
interface SymbolAnalysisResult {
  filePath: string;
  symbols: SymbolInfo[];
  dependencies: SymbolDependency[];
  exports: SymbolExport[];
  imports: SymbolImport[];
  errors: AnalysisError[];
}

interface SymbolInfo {
  name: string;
  type: "function" | "class" | "variable" | "interface" | "type" | "enum";
  filePath: string;
  lineNumber: number;
  isExported: boolean;
  isAsync?: boolean;
  signature?: string; // Function/method signature
  complexity?: number; // Cyclomatic complexity
  references?: Reference[]; // Where symbol is used
}

interface SymbolDependency {
  sourceSymbol: string; // Symbol name
  targetSymbol: string; // Symbol name
  targetFile: string; // Target file path
  type: "call" | "reference" | "import";
  lineNumber: number;
}

interface SymbolExport {
  name: string;
  type: "default" | "named";
  isType: boolean;
  lineNumber: number;
}

interface SymbolImport {
  localName: string; // As used in file
  originalName: string; // Original export name
  modulePath: string; // Import source
  isType: boolean;
  lineNumber: number;
}
```

### Reverse Index Data

#### File-Level Reverse Index

```typescript
interface ReverseIndexEntry {
  targetFile: string; // File being depended upon
  referencingFiles: Set<string>; // Files that import it
  lastUpdated: number; // Timestamp
}

type ReverseIndexMap = Map<string, ReverseIndexEntry>;
```

#### Symbol-Level Reverse Index

```typescript
interface SymbolReverseIndexEntry {
  symbolId: string; // Format: "filePath:symbolName"
  referencingSymbols: SymbolReference[];
  lastUpdated: number;
}

interface SymbolReference {
  sourceSymbolId: string; // Format: "filePath:symbolName"
  referenceType: "call" | "reference" | "import";
  lineNumber: number;
  filePath: string; // Source file
}

type SymbolReverseIndexMap = Map<string, SymbolReverseIndexEntry>;
```

### Configuration

#### Extension Settings

```typescript
interface GraphItLiveConfig {
  maxDepth: number; // Default: 10
  excludeNodeModules: boolean; // Default: true
  enableBackgroundIndexing: boolean; // Default: true
  indexingConcurrency: number; // Default: 4 (1-16)
  performanceProfile: "default" | "low-memory" | "high-performance";
  enableMcpServer: boolean; // Default: false
  mcpServerPort?: number; // Default: undefined (stdio)
}
```

#### Performance Profiles

```typescript
interface PerformanceProfile {
  name: string;
  maxDepth: number;
  concurrency: number;
  cacheSize: number;
  batchSize: number;
  memoryLimit?: number;
}

const profiles: Record<string, PerformanceProfile> = {
  default: {
    maxDepth: 10,
    concurrency: 4,
    cacheSize: 500,
    batchSize: 20,
  },
  "low-memory": {
    maxDepth: 5,
    concurrency: 2,
    cacheSize: 100,
    batchSize: 10,
  },
  "high-performance": {
    maxDepth: 20,
    concurrency: 8,
    cacheSize: 1000,
    batchSize: 50,
  },
};
```

### Message Protocol Types

#### Extension ↔ Webview Messages

```typescript
// Webview → Extension
type WebviewMessage =
  | { command: "refresh" }
  | { command: "expandAll" }
  | { command: "collapseAll" }
  | { command: "drillDown"; nodeId: string }
  | { command: "findReferences"; nodeId: string; symbolId?: string }
  | { command: "navigateToSource"; filePath: string; line?: number }
  | { command: "toggleUnusedFilter"; enabled: boolean }
  | { command: "toggleViewMode"; mode: "hierarchy" | "dependency" };

// Extension → Webview
type ExtensionMessage =
  | { command: "showGraph"; data: GraphData }
  | { command: "updateGraph"; data: GraphData; merge?: boolean }
  | { command: "showSymbolGraph"; data: SymbolGraphData }
  | { command: "highlightUnused"; nodeIds: string[] }
  | { command: "showError"; message: string; details?: ErrorDetails }
  | { command: "showProgress"; message: string; percentage?: number };
```

#### MCP Tool Messages

```typescript
// MCP Server ↔ MCP Client (AI/LLM)
// MCP registers 22 tools (prefixed graphitlive_): 21 below plus get_session_stats.
// Five names marked (alias) are no longer MCP tools; `graph-it tool` keeps them.
type McpToolName =
  | "set_workspace"          // Set workspace directory (rate-limited: 5 calls/10s)
  | "graph_context"          // Token-bounded subgraph answering a question
  | "analyze_dependencies"   // Single-file dependency analysis
  | "crawl_dependency_graph" // Recursive file-level crawl
  | "find_referencing_files" // Reverse file lookup
  | "expand_node"            // (alias) use crawl_dependency_graph
  | "parse_imports"          // (alias) use analyze_dependencies
  | "verify_dependency_usage"// Verify if import is actually used
  | "resolve_module_path"    // Resolve a module specifier
  | "get_index_status"       // Index health & stats
  | "invalidate_files"       // Invalidate cache entries (rate-limited: 20 calls/10s)
  | "rebuild_index"          // Full index rebuild (rate-limited: 5 calls/10s)
  | "get_symbol_graph"       // Symbol-level dependency graph
  | "find_unused_symbols"    // Dead code detection
  | "get_symbol_dependents"  // (alias) use query_call_graph
  | "trace_function_execution" // Execution path tracing
  | "get_symbol_callers"     // (alias) use query_call_graph
  | "analyze_breaking_changes" // Detect breaking API changes
  | "review_pr"              // Review a local Git diff (risk score, evidence)
  | "get_impact_analysis"    // Full change impact analysis
  | "analyze_file_logic"     // (alias) use generate_codemap
  | "generate_codemap"       // AI-friendly code map (TOON format)
  | "query_call_graph"       // Cross-file caller/callee queries via SQLite BFS
  | "scan_dead_code"         // Workspace-wide or scoped unused export scan
  | "query_natural_language" // Subgraph relevant to a plain-language question
  | "generate_wiki";         // Navigable Markdown wiki from the call graph index

interface McpToolRequest {
  toolName: McpToolName;
  parameters: Record<string, unknown>;
  format?: "json" | "toon"; // Output format
}

interface McpToolResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata?: {
    executionTime: number;
    cacheHit: boolean;
    truncated: boolean;
  };
}
```

### Error Types

#### Spider Errors

```typescript
enum SpiderErrorCode {
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  PARSE_ERROR = "PARSE_ERROR",
  RESOLVE_ERROR = "RESOLVE_ERROR",
  UNSUPPORTED_LANGUAGE = "UNSUPPORTED_LANGUAGE",
  MAX_DEPTH_EXCEEDED = "MAX_DEPTH_EXCEEDED",
  CIRCULAR_DEPENDENCY = "CIRCULAR_DEPENDENCY",
  TIMEOUT = "TIMEOUT",
}

class SpiderError extends Error {
  code: SpiderErrorCode;
  filePath?: string;
  lineNumber?: number;
  details?: unknown;
}
```

#### Analysis Errors

```typescript
enum AnalysisErrorCode {
  AST_PARSE_ERROR = "AST_PARSE_ERROR",
  SYMBOL_NOT_FOUND = "SYMBOL_NOT_FOUND",
  AMBIGUOUS_SYMBOL = "AMBIGUOUS_SYMBOL",
  IMPORT_RESOLUTION_FAILED = "IMPORT_RESOLUTION_FAILED",
  UNSUPPORTED_SYNTAX = "UNSUPPORTED_SYNTAX",
}

class AnalysisError extends Error {
  code: AnalysisErrorCode;
  filePath: string;
  symbolName?: string;
  lineNumber?: number;
  context?: string;
}
```

### Cache Data Structures

#### LRU Cache Entry

```typescript
interface CacheEntry<T> {
  key: string;
  value: T;
  timestamp: number;
  accessCount: number;
  size?: number; // Size in bytes (for memory tracking)
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  totalSize: number;
  maxSize: number;
  hitRate: number;
}
```

#### Indexed Data

```typescript
interface IndexedFile {
  filePath: string;
  language: LanguageId;
  hash: string; // File content hash
  dependencies: Dependency[];
  symbols: SymbolInfo[];
  lastIndexed: number;
  version: number; // Incremental version
}

interface IndexMetadata {
  version: string; // Index schema version
  workspaceRoot: string;
  totalFiles: number;
  totalSymbols: number;
  lastFullIndex: number;
  indexHealth: "healthy" | "stale" | "corrupted";
}
```

### Language-Specific Types

#### Language Identifiers

```typescript
enum LanguageId {
  TYPESCRIPT = "typescript",
  JAVASCRIPT = "javascript",
  PYTHON = "python",
  RUST = "rust",
  GRAPHQL = "graphql",
  GO = "go",
  JAVA = "java",
  CSHARP = "csharp",
  UNKNOWN = "unknown",
}
```

#### Parser Configuration

```typescript
interface ParserConfig {
  language: LanguageId;
  parseImports: boolean;
  parseExports: boolean;
  parseSymbols: boolean;
  resolveAliases: boolean;
  followTypeImports: boolean;
}
```

### Path Resolution Types

#### Path Resolution Result

```typescript
interface ResolvedPath {
  originalPath: string; // Raw import path
  resolvedPath: string; // Absolute file path
  isExternal: boolean; // From node_modules
  isRelative: boolean; // Relative import
  isAlias: boolean; // Path alias used
  resolvedVia?: "filesystem" | "tsconfig" | "package.json";
}
```

#### Path Alias Configuration

```typescript
interface PathAliasConfig {
  paths: Record<string, string[]>; // tsconfig paths
  baseUrl?: string;
  rootDirs?: string[];
}
```

### Serialization Formats

#### TOON Format (Token-Oriented Object Notation)

```typescript
// Compact format for MCP responses (30-60% token savings)
interface ToonNode {
  i: string; // id
  l: string; // label
  t: string; // type
  f?: string; // filePath
  e?: boolean; // isExternal/isExported
}

interface ToonEdge {
  s: string; // source
  t: string; // target
  r: string; // type (relation)
}

interface ToonGraph {
  n: ToonNode[]; // nodes
  e: ToonEdge[]; // edges
  r: string; // root
  m?: Record<string, unknown>; // metadata
}
```

### Constants

#### Symbol ID Format

```typescript
// Format: "filePath:symbolName"
// Example: "/Users/user/project/src/utils.ts:formatPath"

const SYMBOL_ID_SEPARATOR = ":";
const SYMBOL_ID_REGEX = /^(.+):([^:]+)$/;

// Extract file path from symbol ID
function extractFilePath(symbolId: string): string {
  const match = symbolId.match(SYMBOL_ID_REGEX);
  return match ? match[1] : symbolId;
}

// Extract symbol name from symbol ID
function extractSymbolName(symbolId: string): string {
  const match = symbolId.match(SYMBOL_ID_REGEX);
  return match ? match[2] : symbolId;
}
```

#### Path Normalization

```typescript
// Cross-platform path handling
// Windows: C:\Users\file.ts → c:/users/file.ts
// Unix: /Users/file.ts → /users/file.ts

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  // Lowercase Windows drive letters
  return normalized.replace(
    /^([A-Z]):/,
    (_, drive) => drive.toLowerCase() + ":",
  );
}
```

### Type Guards

#### Type Predicates

```typescript
function isSymbolNode(node: GraphNode | SymbolNode): node is SymbolNode {
  return "isExported" in node;
}

function isSymbolId(id: string): boolean {
  return SYMBOL_ID_REGEX.test(id) && id.includes(":");
}

function isExternalDependency(dep: Dependency): boolean {
  return (
    dep.isExternal ||
    dep.module.startsWith("node:") ||
    (!dep.module.startsWith(".") && !dep.module.startsWith("/"))
  );
}

function isFilePath(path: string): boolean {
  return (
    !isSymbolId(path) &&
    (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
  );
}
```

### Data Transformation Utilities

#### Graph Merging

```typescript
function mergeGraphData(base: GraphData, additional: GraphData): GraphData {
  // Deduplicate nodes by ID
  // Merge edges without duplicates
  // Combine labels
  // Update timestamp
}
```

#### Symbol ID Construction

```typescript
function createSymbolId(filePath: string, symbolName: string): string {
  return `${normalizePath(filePath)}:${symbolName}`;
}

function parseSymbolId(
  symbolId: string,
): { filePath: string; symbolName: string } | null {
  const match = symbolId.match(SYMBOL_ID_REGEX);
  return match ? { filePath: match[1], symbolName: match[2] } : null;
}
```
