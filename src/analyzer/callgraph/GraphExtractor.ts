/**
 * GraphExtractor — Tree-sitter WASM query-based symbol & relationship extractor.
 *
 * Extracts CallGraphNode (symbol definitions) and CallGraphEdge (call/inherit/
 * implements/uses relationships) from a source file for a given language.
 *
 * Strategy:
 *  1. Load the per-language `.scm` query file from `dist/queries/<lang>.scm`.
 *  2. Run the query on the parsed AST. Captures are named:
 *       - `@def.*`  → symbol definition nodes (function, class, method, etc.)
 *       - `@call`   → CALLS relationship (call_expression callee)
 *       - `@inherit`→ INHERITS relationship (extends clause parent)
 *       - `@impl`   → IMPLEMENTS relationship (implements clause target)
 *       - `@uses`   → USES relationship (type reference)
 *  3. For each relationship capture, walk up the AST to find the nearest
 *     enclosing `@def.*` node — this is the edge source.
 *  4. Intra-file target IDs are resolved against the extracted node set.
 *     Cross-file targets are stored as `@@external:<name>` stubs.
 *
 * NO vscode imports — this module is VS Code-agnostic.
 *
 * SPEC: specs/001-live-call-graph/research.md Decision 3
 */

import { WasmParserFactory } from "@/analyzer/languages/WasmParserFactory";
import type { RelationType, SupportedLang, SymbolType } from "@/shared/callgraph-types";
import { getLogger } from "@/shared/logger";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import type { Node as TreeNode } from "web-tree-sitter";
import { Query } from "web-tree-sitter";
import type { CallGraphEdge, CallGraphNode } from "./CallGraphIndexer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractorConfig {
  /** Absolute path to extension root — used to locate dist/wasm and dist/queries */
  extensionPath: string;
  /** Absolute workspace root path — used to compute workspace-relative folder */
  workspaceRoot: string;
}

export interface ExtractionResult {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

// ---------------------------------------------------------------------------
// Capture name conventions used in .scm files
// ---------------------------------------------------------------------------

const DEF_FUNCTION = "def.function";
const DEF_CLASS = "def.class";
const DEF_METHOD = "def.method";
const DEF_INTERFACE = "def.interface";
const DEF_TYPE = "def.type";
const DEF_VARIABLE = "def.variable";

const DEF_CAPTURE_NAMES = new Set([
  DEF_FUNCTION,
  DEF_CLASS,
  DEF_METHOD,
  DEF_INTERFACE,
  DEF_TYPE,
  DEF_VARIABLE,
]);

const RELATION_CAPTURE_MAP: Record<string, RelationType> = {
  call: "CALLS",
  inherit: "INHERITS",
  impl: "IMPLEMENTS",
  uses: "USES",
};

function captureNameToSymbolType(captureName: string): SymbolType {
  const part = captureName.replace(/^def\./, "");
  const valid: SymbolType[] = ["function", "class", "method", "interface", "type", "variable"];
  return valid.includes(part as SymbolType) ? (part as SymbolType) : "function";
}

function captureNameToRelationType(captureName: string): RelationType | null {
  return RELATION_CAPTURE_MAP[captureName] ?? null;
}

/**
 * Check whether a @call capture node comes from a member/method access pattern
 * rather than a direct function call.  Member calls cannot be reliably resolved
 * across files because tree-sitter captures only the method name (e.g. `keys`
 * from `Object.keys()`), not the owning object's type.
 *
 * Language-specific parent node types:
 *  - TypeScript/JavaScript: `member_expression`  (obj.method())
 *  - Python:                `attribute`           (obj.method())
 *  - Rust:                  `field_expression`    (obj.method())
 *  - C#:                    `member_access_expression` (obj.Method())
 *
 * NOTE: Go's `selector_expression` is intentionally excluded. In Go it covers
 * both method calls (obj.Method()) and package-qualified function calls
 * (pkg.Func()). Filtering it would drop all cross-file package calls and
 * produce an empty call graph for Go files.
 *
 * NOTE: Java's `field_access` is not listed because Java @call captures sit
 * inside `method_invocation` nodes (name field), not `field_access`. Adding
 * it would be dead code and would not affect Java call extraction.
 */
const MEMBER_ACCESS_PARENT_TYPES = new Set([
  "member_expression",        // TS/JS
  "attribute",                // Python
  "field_expression",         // Rust
  "member_access_expression", // C#
]);

function isMemberAccessCapture(node: TreeNode): boolean {
  return MEMBER_ACCESS_PARENT_TYPES.has(node.parent?.type ?? "");
}

// ---------------------------------------------------------------------------
// GraphExtractor
// ---------------------------------------------------------------------------

export class GraphExtractor {
  private readonly config: ExtractorConfig;
  /** In-memory cache for .scm query sources — avoids re-reading from disk per file */
  private readonly querySourceCache = new Map<string, string>();
  /** Compiled tree-sitter Query objects cached per language — avoids recompilation per file */
  private readonly compiledQueryCache = new Map<string, Query>();

  constructor(config: ExtractorConfig) {
    this.config = config;
  }

  /**
   * Release all cached compiled Query objects (frees WASM memory).
   * Must be called when the extractor is no longer needed.
   */
  dispose(): void {
    for (const query of this.compiledQueryCache.values()) {
      query.delete();
    }
    this.compiledQueryCache.clear();
    this.querySourceCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Extract call graph nodes and edges from a given source file.
   *
   * @param filePath - Normalized absolute path to the source file
   * @param lang - Language key (typescript | javascript | python | rust)
   * @param mtime - File modification time (ms) — only used by indexer, returned for convenience
   * @returns Extracted nodes and edges
   */
  async extractFile(
    filePath: string,
    lang: SupportedLang,
    _mtime?: number,
  ): Promise<ExtractionResult> {
    let source = await fs.readFile(filePath, "utf8");

    // Vue/Svelte SFCs: extract <script> blocks before tree-sitter parsing
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".vue" || ext === ".svelte") {
      source = extractScriptFromSFC(source);
    }

    return this.extractSource(filePath, lang, source);
  }
  async extractSource(
    filePath: string,
    lang: SupportedLang,
    source: string,
  ): Promise<ExtractionResult> {
    const normalizedPath = normalizePath(filePath);

    // Resolve WASM paths
    const treeSitterWasmPath = path.join(
      this.config.extensionPath,
      "dist",
      "wasm",
      "tree-sitter.wasm",
    );

    const wasmFileName = this.langToWasmFileName(lang);
    const langWasmPath = path.join(
      this.config.extensionPath,
      "dist",
      "wasm",
      wasmFileName,
    );

    // Load query source for this language
    const querySrc = await this.loadQuerySource(lang);
    if (!querySrc.trim()) {
      // Empty query file — return empty result
      return { nodes: [], edges: [] };
    }

    // Initialize WASM parser factory
    const factory = WasmParserFactory.getInstance();
    await factory.init(treeSitterWasmPath);

    const parser = await factory.getParser(lang, langWasmPath);
    const language = parser.language;
    if (!language) {
      throw new Error(`Language not loaded for ${lang}`);
    }

    // Parse the source
    const tree = parser.parse(source);
    if (!tree) {
      return { nodes: [], edges: [] };
    }

    // Run query (compiled Query is cached per language — safe to reuse across files)
    const query = this.getOrCompileQuery(language, querySrc, lang);
    const captures = query.captures(tree.rootNode);

    return this.processCaptures(captures, normalizedPath, lang, source);
  }

  // ---------------------------------------------------------------------------
  // Private helpers — Query compilation cache
  // ---------------------------------------------------------------------------

  /**
   * Return a cached compiled Query for the given language, compiling on first use.
   * The Query object is safe to reuse across multiple tree parses — `.captures()` is stateless.
   */
  private getOrCompileQuery(language: ConstructorParameters<typeof Query>[0], querySrc: string, lang: SupportedLang): Query {
    const key = this.normalizeQueryLang(lang);
    const cached = this.compiledQueryCache.get(key);
    if (cached) return cached;

    let query: Query;
    try {
      query = new Query(language, querySrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Tree-sitter query for ${lang}: ${msg}`, { cause: err });
    }
    this.compiledQueryCache.set(key, query);
    return query;
  }

  // ---------------------------------------------------------------------------
  // Private processing
  // ---------------------------------------------------------------------------

  private processCaptures(
    captures: ReturnType<Query["captures"]>,
    normalizedFilePath: string,
    lang: SupportedLang,
    source: string,
  ): ExtractionResult {
    const folder = this.computeFolder(normalizedFilePath);
    const { nodeMap, defCaptures, positionToNodeId, nameToNodeIds } =
      this.buildNodeMap(captures, normalizedFilePath, lang, folder, source);
    const edges = this.buildEdges(captures, normalizedFilePath, positionToNodeId, nameToNodeIds, defCaptures);
    return { nodes: [...nodeMap.values()], edges };
  }

  private buildNodeMap(
    captures: ReturnType<Query["captures"]>,
    normalizedFilePath: string,
    lang: SupportedLang,
    folder: string,
    source: string,
  ): {
    nodeMap: Map<string, CallGraphNode>;
    defCaptures: Array<{ captureName: string; node: TreeNode }>;
    positionToNodeId: Map<string, string>;
    nameToNodeIds: Map<string, string[]>;
  } {
    const nodeMap = new Map<string, CallGraphNode>();
    const defCaptures: Array<{ captureName: string; node: TreeNode }> = [];
    const positionToNodeId = new Map<string, string>();
    const nameToNodeIds = new Map<string, string[]>();

    for (const capture of captures) {
      if (!DEF_CAPTURE_NAMES.has(capture.name)) continue;
      defCaptures.push({ captureName: capture.name, node: capture.node });
    }

    for (const { captureName, node } of defCaptures) {
      const symbolName = node.text.trim();
      if (!symbolName) continue;
      const startLine = node.startPosition.row;
      const endLine = node.endPosition.row;
      const startCol = node.startPosition.column;
      const nodeId = `${normalizedFilePath}:${symbolName}:${startLine}`;
      if (nodeMap.has(nodeId)) continue;
      const cgNode: CallGraphNode = {
        id: nodeId,
        name: symbolName,
        type: captureNameToSymbolType(captureName),
        lang,
        path: normalizedFilePath,
        folder,
        startLine,
        endLine,
        startCol,
        isExported: this.detectIsExported(node, source),
      };
      nodeMap.set(nodeId, cgNode);
      // Store the containing DECLARATION node's position for AST ancestor walking.
      // The def capture node is the *name identifier* (e.g. `foo` in `function foo()`),
      // but findEnclosingDefinitionId walks up and compares full declaration node positions
      // (e.g. `function_declaration` starts at the `function` keyword, not the name).
      // Using node.parent's position ensures the walk can find a match.
      const declNode = node.parent ?? node;
      positionToNodeId.set(
        `${declNode.startPosition.row}:${declNode.startPosition.column}`,
        nodeId,
      );
      const existing = nameToNodeIds.get(symbolName) ?? [];
      existing.push(nodeId);
      nameToNodeIds.set(symbolName, existing);
    }
    return { nodeMap, defCaptures, positionToNodeId, nameToNodeIds };
  }

  private buildEdges(
    captures: ReturnType<Query["captures"]>,
    normalizedFilePath: string,
    positionToNodeId: Map<string, string>,
    nameToNodeIds: Map<string, string[]>,
    defCaptures: Array<{ captureName: string; node: TreeNode }>,
  ): CallGraphEdge[] {
    const edges: CallGraphEdge[] = [];
    const seenEdges = new Set<string>();

    for (const capture of captures) {
      const relationType = captureNameToRelationType(capture.name);
      if (!relationType) continue;
      const targetName = capture.node.text.trim();
      if (!targetName) continue;
      const sourceLine = capture.node.startPosition.row;
      const sourceNodeId = this.findEnclosingDefinitionId(
        capture.node, normalizedFilePath, positionToNodeId, defCaptures,
      );
      if (!sourceNodeId) continue;
      const targetNodeIds = nameToNodeIds.get(targetName);
      const targetId = targetNodeIds?.[0] ?? `@@external:${targetName}`;

      // Skip cross-file edges from member/method access calls (e.g. obj.method()).
      // Without type information, name-only resolution creates false positives:
      // Object.keys() → user's `keys`, Math.round() → user's `round`, etc.
      // Intra-file member calls (this.method()) are kept — targetNodeIds is set.
      if (
        relationType === "CALLS" &&
        targetId.startsWith("@@external:") &&
        isMemberAccessCapture(capture.node)
      ) {
        continue;
      }

      const edgeKey = `${sourceNodeId}::${targetId}::${relationType}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      edges.push({ sourceId: sourceNodeId, targetId, typeRelation: relationType, sourceLine });
    }
    return edges;
  }

  /**
   * Walk up the AST from a reference node to find the nearest enclosing definition.
   * Returns the Call Graph Node ID for that definition, or null if not inside any definition.
   *
   * positionToNodeId is keyed by the *declaration* node's start position (e.g. `function_declaration`
   * starts at the `function` keyword), which matches the ancestor nodes encountered during the walk.
   */
  private findEnclosingDefinitionId(
    refNode: TreeNode,
    _filePath: string,
    positionToNodeId: Map<string, string>,
    _defCaptures: Array<{ captureName: string; node: TreeNode }>,
  ): string | null {
    let current: TreeNode | null = refNode.parent;
    while (current !== null) {
      const posKey = `${current.startPosition.row}:${current.startPosition.column}`;
      const nodeId = positionToNodeId.get(posKey);
      if (nodeId) return nodeId;
      current = current.parent;
    }
    return null;
  }

  /**
   * Detect whether a node is exported.
   * Heuristic: walk up one parent and check for export keyword in its type.
   */
  private detectIsExported(node: TreeNode, _source: string): boolean {
    let parent: TreeNode | null = node.parent;
    // Walk up at most 3 levels
    let depth = 0;
    while (parent && depth < 3) {
      const parentType = parent.type;
      if (
        parentType === "export_statement" ||
        parentType === "export_clause" ||
        parentType === "export_specifier" ||
        parentType === "visibility_modifier"
      ) {
        return true;
      }
      parent = parent.parent;
      depth++;
    }
    return false;
  }

  /**
   * Compute workspace-relative folder from a normalized absolute file path.
   * Result uses forward slashes and is never absolute.
   */
  private computeFolder(normalizedFilePath: string): string {
    const workspaceRoot = normalizePath(this.config.workspaceRoot);
    const dir = path.posix.dirname(normalizedFilePath);
    if (dir.startsWith(workspaceRoot)) {
      const rel = dir.slice(workspaceRoot.length);
      return rel.startsWith("/") ? rel.slice(1) : rel;
    }
    return dir;
  }

  /**
   * Load the Tree-sitter query source for the given language.
   * Empty string if the file is not found or is empty.
   */
  private async loadQuerySource(lang: SupportedLang): Promise<string> {
    const normalizedLang = this.normalizeQueryLang(lang);
    const cached = this.querySourceCache.get(normalizedLang);
    if (cached !== undefined) return cached;

    const queryFileName = `${normalizedLang}.scm`;
    const queryPath = path.join(
      this.config.extensionPath,
      "dist",
      "queries",
      queryFileName,
    );
    try {
      const src = await fs.readFile(queryPath, "utf8");
      this.querySourceCache.set(normalizedLang, src);
      return src;
    } catch (err) {
      getLogger('GraphExtractor').error(`Query file not found: ${queryPath}`, err);
      this.querySourceCache.set(normalizedLang, "");
      return "";
    }
  }

  /**
   * Map SupportedLang to the .scm file base name.
   * JavaScript reuses the typescript query file.
   */
  private normalizeQueryLang(lang: SupportedLang): string {
    if (lang === "javascript") return "typescript";
    return lang;
  }

  /**
   * Map SupportedLang to the language WASM file name in dist/wasm.
   */
  private langToWasmFileName(lang: SupportedLang): string {
    switch (lang) {
      case "typescript":
      case "javascript":
        // The web-tree-sitter TypeScript WASM handles both TS and JS
        // Note: for JS-only files you'd use tree-sitter-javascript.wasm,
        // but we currently only have TS WASM; fall through to ts for now.
        return "tree-sitter-typescript.wasm";
      case "python":
        return "tree-sitter-python.wasm";
      case "rust":
        return "tree-sitter-rust.wasm";
      case "csharp":
        return "tree-sitter-c_sharp.wasm";
      case "go":
        return "tree-sitter-go.wasm";
      case "java":
        return "tree-sitter-java.wasm";
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: determine SupportedLang from file extension
// ---------------------------------------------------------------------------

/**
 * Returns the SupportedLang for a given normalized file path, or null if not
 * supported by the GraphExtractor.
 */
export function fileExtToLang(filePath: string): SupportedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".vue":
    case ".svelte":
      return "typescript";
    case ".py":
    case ".pyi":
      return "python";
    case ".rs":
      return "rust";
    case ".cs":
    case ".csproj":
      return "csharp";
    case ".go":
      return "go";
    case ".java":
      return "java";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SFC script extraction (Vue / Svelte)
// ---------------------------------------------------------------------------

/**
 * Extract all <script> block contents from a Vue or Svelte SFC.
 * Returns the concatenated script source that can be parsed as TypeScript/JavaScript.
 */
function extractScriptFromSFC(content: string): string {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script\s*[^>]*>/gi; //NOSONAR
  const matches = [...content.matchAll(scriptRegex)];
  return matches.map((m) => m[1]).join("\n");
}
