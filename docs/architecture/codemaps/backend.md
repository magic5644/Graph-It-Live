# Backend/Analyzer Structure

**Last Updated:** 2026-10-09
**Layer:** Pure Node.js (NO vscode imports)

## Directory: `src/analyzer/`

### Core Components (223 total TS/TSX files across entire project; 83 in `src/analyzer/`)

#### Main Facade

```
Spider.ts (350 lines)
├─→ Orchestrates all analysis services
├─→ Config: maxDepth, excludeNodeModules, indexing, caching
└─→ Public API: analyze(), crawl(), getSymbolGraph()
```
#### Spider Builder ✅

```
SpiderBuilder.ts (955 lines)
├→ Builder pattern for constructing fully-wired Spider instances
├→ Wires: FileReader, Cache, LanguageService, AstWorkerHost, ReverseIndexManager
├→ Wires: IndexerWorkerHost, SourceFileCollector, SpiderServices
└→ build() → Spider (replaces manual DI in GraphProvider)
```
#### Language Service Factory ✅

```
LanguageService.ts (201 lines) [ENHANCED]
├─→ detectLanguage(filePath) - File extension → Language enum
├─→ getAnalyzer(filePath) - Factory for parsers
├─→ getSymbolAnalyzer(filePath) - Factory for symbol analyzers
├─→ extractFilePath(pathOrSymbolId) [NEW] - Symbol ID protection
└─→ Lazy-loaded singletons for performance
```

**Recent Enhancement:** Multi-layer defense against symbol ID contamination

#### Source File Discovery

```
SourceFileCollector.ts (85 lines)
├→ Discovers all supported source files in a workspace directory
├→ Recursive traversal with yieldToEventLoop() for large projects
└→ collectFiles(root, options) → AsyncGenerator<string>

SourceFileFilters.ts (17 lines)
├→ isSupportedSourceFile(filePath) - checks extension whitelist
└→ shouldSkipDirectory(dir) - node_modules, .git, dist, etc.
```

#### Signature Analyzer

```
SignatureAnalyzer.ts (767 lines)
├→ Detects breaking changes in TypeScript function/method/interface signatures
├→ Uses ts-morph for AST analysis
├→ Detects: new required params, removed params, type changes, visibility changes
└→ compareSignatures(before, after) → SignatureComparisonResult
```

#### Symbol Dependency Helper

```
SymbolDependencyHelper.ts (96 lines)
├→ Shared logic for resolving symbol dependency chains
└→ Used by SpiderSymbolService and AstWorker
```

#### Parsers (Strategy Pattern) ✅

```
Parser.ts (178 lines) [PROTECTED]
├─→ TypeScript/JavaScript import parsing
├─→ Regex-based for performance
└─→ parseImports(), resolvePath() [Protected against symbol IDs]

languages/PythonParser.ts (288 lines) [PROTECTED]
├─→ Tree-sitter based AST parsing
├─→ Handles: import x, from y import z, relative imports
└─→ parseImports(), resolvePath() [Protected]

languages/RustParser.ts (546 lines) [PROTECTED]
├─→ Tree-sitter based AST parsing
├─→ Handles: use statements, mod declarations
└─→ parseImports(), resolvePath() [Protected]

languages/CSharpParser.ts [PROTECTED]
├─→ Tree-sitter based AST parsing
├─→ Handles: using directives, namespaces, project references
└─→ parseImports(), resolvePath() [Protected]

languages/GoParser.ts [PROTECTED]
├─→ Tree-sitter based AST parsing
├─→ Handles: import declarations, single and grouped
└─→ parseImports(), resolvePath() [Protected]

languages/JavaParser.ts [PROTECTED]
├─→ Tree-sitter based AST parsing
├─→ Handles: import statements, package declarations
└─→ parseImports(), resolvePath() [Protected]
```

#### Symbol Analyzers

```
SymbolAnalyzer.ts (730 lines)
├─→ TypeScript/JavaScript AST analysis via ts-morph
├─→ Extracts: functions, classes, methods, exports
├─→ Builds: import map, symbol dependencies
└─→ Complexity: 8 (refactored from 34)

languages/PythonSymbolAnalyzer.ts (370 lines)
├─→ Tree-sitter based symbol extraction
├─→ Handles: functions, classes, decorators
└─→ Type imports vs runtime imports

languages/RustSymbolAnalyzer.ts (540 lines)
├─→ Tree-sitter based symbol extraction
├─→ Handles: functions, structs, impl blocks
└─→ Trait implementations
```

#### Spider Services (SRP)

**Dependency Analysis:**

```
spider/SpiderDependencyAnalyzer.ts (104 lines)
├─→ File-level dependency analysis
├─→ Uses LanguageService for parser selection
├─→ Caching & reverse index sync
└─→ analyze(filePath) → Dependency[]
```

**Symbol Analysis:**

```
spider/SpiderSymbolService.ts (515 lines)
├─→ Symbol-level analysis
├─→ getSymbolGraph(filePath) → { symbols, dependencies }
├─→ findUnusedSymbols(filePath)
├─→ scanDeadCode(scopePath?, options?) → { entries, scannedFiles, skippedFiles }
├─→ getSymbolDependents(filePath, symbolName)
├─→ traceFunctionExecution(filePath, symbolName)
└─→ verifyDependencyUsage() - Batch optimization
```

**Graph Crawling:**

```
spider/SpiderGraphCrawler.ts (216 lines)
├─→ Recursive dependency graph traversal
├─→ Breadth-first with depth limit
├─→ crawl(entryFile, maxDepth) → { nodes, edges }
└─→ Cycle detection
```

**Indexing:**

```
spider/SpiderIndexingService.ts (161 lines)
├─→ Full index build & incremental updates
├─→ Progress callbacks
├─→ Cancellation support
├─→ Event loop yielding (non-blocking)
└─→ buildFullIndex(), updateIncrementalIndex()
```

**Cancellation:**

```
spider/SpiderIndexingCancellation.ts
├─→ Cancellation token for long-running indexing
└─→ isCancelled(), cancel()
```

**Other Services:**

```
spider/SpiderReferenceLookup.ts (87 lines)
├─→ Find files that reference a target
└─→ Uses reverse index or full scan

spider/SpiderWorkerManager.ts (104 lines)
├─→ Worker thread pool management
└─→ Parallel file processing

spider/SpiderCacheCoordinator.ts (41 lines)
├─→ Coordinates cache invalidation
└─→ Sync between dependency cache & symbol cache
```

#### Reverse Index System

```
ReverseIndexManager.ts (135 lines)
├─→ Manages reverse dependency lookup
├─→ enable(), disable(), ensure()
└─→ Persistence to disk

ReverseIndex.ts (261 lines)
├─→ File → Dependencies mapping
├─→ addDependencies(), removeDependencies()
├─→ getReferencingFiles()
└─→ Critical fix: Lazy cleanup to prevent race conditions ✅

SymbolReverseIndex.ts (220 lines)
├─→ Symbol → Callers mapping
├─→ getCallers(), hasCallers()
└─→ Type-only vs runtime filtering
```

#### AST Processing

```
ast/AstWorkerHost.ts (330 lines)
├─→ Manages worker thread lifecycle
├─→ analyzeFile(), getInternalExportDeps()
└─→ Parallel AST processing

ast/AstWorker.ts (191 lines)
├─→ Worker thread code
├─→ Uses ts-morph, tree-sitter
└─→ Language detection & analysis
```
#### Background Indexer Workers

```
IndexerWorkerHost.ts (249 lines)
├→ Manages worker thread lifecycle for background dependency indexing
├→ Promise-based API for main thread
├→ Callbacks: IndexerStatusCallback for progress reporting
└→ indexFiles(files) → IndexingResult

IndexerWorker.ts (292 lines)
├→ Worker thread for parallel file dependency indexing
├→ Processes batches with event loop yielding
└→ Returns: IndexedFileData[]
```

#### New Sub-Packages (since 2026-06)

```
wiki/WikiGenerator.ts
├→ Generates a navigable Markdown wiki from the call graph SQLite index
├→ renderArticle() escapes Markdown/HTML delimiters in source-derived names ✅
└→ Backs MCP tool generate_wiki / CLI `graph-it wiki`

export/HtmlExporter.ts, NodeMetadataBuilder.ts
├→ Standalone HTML graph export (CLI `export-html` command)
└→ Builds per-node metadata (language, size, exported flags) for export

graph-context/
├→ Backs graph_context / query_natural_language MCP tools
└→ Token-bounded subgraph retrieval, pagination, cursor handling

deadcode/, stats/
├→ Dead-code scanning helpers, session TOON/JSON token stats
└→ Support scan_dead_code and get_session_stats

community/LouvainDetector.ts, community/PathCommunityDetector.ts
├→ detectPathCommunityAssignments(): folder-based domains (skips common prefix and src/tests);
│  NodeMetadataBuilder uses it to fill node communityId (graph view, HTML export, crawl output)
└→ detectCommunities() (Louvain): unit-tested, no production caller

BranchWatchAnalyzer.ts
├→ Local, read-only Git capture for VS Code Branch Watch (no vscode import)
├→ Changed files between base and head, file impact, cycle findings
└→ maxFiles default 200, capped at 2000 (normalizeBranchWatchMaxFiles)

ReviewGateAnalyzer.ts (351+ lines)
├→ Pure Node analyzer for `graph-it review-pr` / MCP review_pr
├→ Local Git diff (argument-array process invocation), path validation against workspace
├→ Composes SignatureAnalyzer, reverse symbol index, cycle detection, unused-export detection
└→ Produces deterministic score factors, evidence, and partial-result data

QueryEngine.ts, LspCallHierarchyAnalyzer.ts, ReferencingFilesFinder.ts, IndexerStatus.ts
├→ QueryEngine: natural-language query resolution over the call graph
├→ LspCallHierarchyAnalyzer: intra-file call hierarchy (LSP-shaped output)
├→ ReferencingFilesFinder: extracted reverse-lookup helper
└→ IndexerStatus: shared indexing status/health types
```

#### WASM Parser Factory

```
languages/WasmParserFactory.ts
├→ Loads tree-sitter WASM parsers for Python, Rust, C#, Go, and Java
├→ Resolves WASM file paths relative to extension dist/wasm/
└→ getSupportedLanguageParser(lang, extensionPath) → Parser
```

#### Call Graph Sub-Package

```
callgraph/GraphExtractor.ts (521 lines)
├→ Extracts symbol nodes and call edges using tree-sitter .scm queries
├→ Supports TypeScript, JavaScript, Python, Rust, C#, Go, Java
├→ extract(filePath, content) → ExtractionResult { nodes, edges }
└→ Filters false-positive cross-file edges from member access calls

callgraph/CallGraphIndexer.ts (596 lines)
├→ sql.js SQLite in-memory database for the call graph
├→ Schema: nodes (id, name, type, lang, path, folder, lines, is_exported)
├→        edges (source_id, target_id, indexed_at)
├→ indexFile(filePath, result) - upsert nodes & edges
├→ invalidateFile(filePath) - remove stale entries
├→ markCycles() - DFS to flag cyclic edges
├→ exportDb() / importDb() - serialisation
└→ getSqlJsWasmPath(extensionPath) - resolve sql-wasm.wasm location

callgraph/CallGraphQuery.ts (355 lines)
├→ BFS/CTE neighbourhood queries against CallGraphIndexer SQLite DB
├→ queryNeighbourhood(db, symbolName, direction, depth) → NeighbourhoodResult
├→ Compound nodes grouped by folder for Cytoscape rendering
└→ direction: 'callers' | 'callees' | 'both'

callgraph/cycleUtils.ts (103 lines)
├→ detectCycles({ source, target }[]) → sets of cycle node IDs
└→ Migrated from webview/components/reactflow/cycles.ts
```
#### Utilities

```
utils/PathResolver.ts (250 lines)
├─→ Module resolution (TS, Python, Rust)
├─→ tsconfig.json path mapping
└─→ Cross-platform path handling

utils/PathPredicates.ts (40 lines)
├─→ isInIgnoredDirectory()
└─→ Path filtering logic

utils/PathExtractor.ts
├─→ extractFilePath() - Strip symbol suffix from "file:symbol" IDs
└─→ Shared by LanguageService and parsers

utils/EventLoopYield.ts
├─→ yieldToEventLoop() - Non-blocking helpers
└─→ Used during large index builds

FileReader.ts (35 lines)
├─→ UTF-8 file reading
└─→ Error handling

Cache.ts (60 lines)
├─→ LRU cache implementation
└─→ Generic caching
```

#### Type Definitions

```
types.ts (400+ lines)
├─→ Core interfaces: ILanguageAnalyzer, ISymbolAnalyzer
├─→ Data types: Dependency, SymbolInfo, SymbolDependency
├─→ Config types: SpiderConfig
└─→ Error types: SpiderError with error codes
```

## Data Flow: File Analysis

```
1. analyze(filePath)
   ↓
2. LanguageService.getAnalyzer(filePath)
   ├─→ extractFilePath() ✅ Protection
   ├─→ detectLanguage()
   └─→ return Parser instance
   ↓
3. Parser.parseImports(filePath)
   ├─→ extractFilePath() ✅ Protection
   └─→ FileReader.readFile()
   ↓
4. Parser.resolvePath(fromFile, moduleSpecifier)
   ├─→ extractFilePath() ✅ Protection
   └─→ PathResolver.resolve()
   ↓
5. Return: Dependency[]
```

## Data Flow: Symbol Analysis

```
1. getSymbolGraph(filePath)
   ↓
2. AstWorkerHost.analyzeFile(filePath, content)
   ↓
3. AstWorker (separate thread)
   ├─→ LanguageService.detectLanguage()
   ├─→ SymbolAnalyzer.analyzeFileContent()
   └─→ Extract symbols & dependencies
   ↓
4. SpiderSymbolService resolves module paths
   ├─→ LanguageService.getAnalyzer()
   └─→ analyzer.resolvePath()
   ↓
5. Return: { symbols[], dependencies[] }
```

## Caching Strategy

**Three-level cache:**

1. **Dependency Cache** - File → Dependencies mapping (LRU 500)
2. **Symbol Cache** - File → Symbol graph mapping (LRU 200)
3. **Reverse Index** - Target → Referencing files (persistent)

**Invalidation:**

- File change → Clear both dependency & symbol cache
- Delete → Remove from reverse index
- Config change → Clear all caches

## Performance Optimizations

1. **Lazy Loading** - Parsers loaded on-demand
2. **Worker Threads** - AST parsing in parallel
3. **Caching** - LRU caches at multiple levels
4. **Batch Operations** - verifyDependencyUsageBatch()
5. **Event Loop Yielding** - Non-blocking for large projects
6. **Symbol ID Protection** - Prevents invalid file operations ✅

## Error Handling

**SpiderError System:**

```typescript
enum SpiderErrorCode {
  FILE_NOT_FOUND,
  PARSE_ERROR,
  RESOLUTION_ERROR,
  INVALID_CONFIG,
  ANALYSIS_TIMEOUT,
}
```

**Error Recovery:**

- File read errors → Skip file, log warning
- Parse errors → Return empty dependencies
- Resolution errors → Keep module specifier
- Analysis errors → Return partial results

## Testing

**Analyzer Tests:**

- Unit tests with mocked fs
- Integration tests with real fixtures
- Benchmark tests for performance
- Cross-platform path tests

**Coverage:** ≥80% per touched file (project-wide per-file gate, not a global average)
