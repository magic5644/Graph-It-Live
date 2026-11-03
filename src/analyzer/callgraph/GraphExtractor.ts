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
 *     Named JS/TS and Python imports retain their module in `@@import:` stubs,
 *     qualified Go/Rust/Java/C# calls their container in `@@qualified:` stubs;
 *     other cross-file targets are stored as `@@external:<name>` stubs.
 *
 * NO vscode imports — this module is VS Code-agnostic.
 *
 * SPEC: specs/001-live-call-graph/research.md Decision 3
 */

import { WasmParserFactory } from "@/analyzer/languages/WasmParserFactory";
import { analyzeReactIdentity, readReactJsxImportSource } from '@/analyzer/ReactIdentity';
import { PathResolver } from "@/analyzer/utils/PathResolver";
import type { RelationType, SupportedLang, SymbolType } from "@/shared/callgraph-types";
import { mapWithConcurrency } from "@/shared/concurrency";
import { getLogger } from "@/shared/logger";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import type { Node as TreeNode } from "web-tree-sitter";
import { Query } from "web-tree-sitter";
import type { CallGraphEdge, CallGraphNode } from "./CallGraphIndexer";
import { resolveNamedImportCalls } from "./importBindings";
import { isComponentFactory } from "@/analyzer/utils/declarations";
import { LOCAL_ONLY, resolvePythonImportCalls } from "./pythonImportBindings";
import { extractGraphQL } from "./graphqlExtractor";
import { definitionOwner, QUALIFIED_PREFIX, resolveQualifiedCalls, workspaceFolder } from "./qualifiedCalls";
import { enclosingType, methodOwner, TYPE_SCOPES, typeNameOf, variableType } from "./receiverTypes";

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
  jsx: "REFERENCES",
  ref: "REFERENCES",
  lazy: "REFERENCES",
};

/** Captures whose target goes through import resolution (`@@import:` / `@@qualified:` stubs). */
const IMPORT_RESOLVED_CAPTURES = new Set(["call", "jsx", "ref", "lazy"]);

/**
 * Runtime references (`<Card />`, `onClick={save}`, `lazy(() => import())`) reach an import or a single
 * same-file declaration only: a global name or a homonym is never guessed, unlike a call.
 */
const REFERENCE_CAPTURES = new Set(["jsx", "ref", "lazy"]);

/**
 * A tree-sitter grammar: one per SupportedLang, plus `tsx` for `.tsx` and `.jsx`.
 * The node language stays typescript/javascript so cross-file names resolve as before.
 */
type Grammar = SupportedLang | "tsx";

/** Query files per grammar: tsx is the TypeScript rules plus the JSX captures. */
const GRAMMAR_QUERY_FILES: Partial<Record<Grammar, string[]>> = {
  javascript: ["typescript.scm"],
  tsx: ["typescript.scm", "tsx.scm"],
};

function queryFilesOf(grammar: Grammar): string[] {
  return GRAMMAR_QUERY_FILES[grammar] ?? [`${grammar}.scm`];
}

/** The grammar that parses `filePath`: JSX is not valid TypeScript, so `.tsx`/`.jsx` use tsx. */
export function grammarOf(lang: SupportedLang, filePath: string): Grammar {
  if (lang !== "typescript" && lang !== "javascript") return lang;
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".tsx" || ext === ".jsx" ? "tsx" : lang;
}

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

function resolveEdgeTarget(
  node: TreeNode,
  targetNodeIds: string[] | undefined,
  importTargets: Map<number, string | null>,
): string | null {
  // Only `IMPORT_RESOLVED_CAPTURES` nodes are keys of importTargets.
  if (importTargets.has(node.id)) {
    const target = importTargets.get(node.id);
    if (!target) return null;
    if (target === LOCAL_ONLY) return targetNodeIds?.[0] ?? null;
    return target.startsWith("@@import:") || target.startsWith(QUALIFIED_PREFIX) || targetNodeIds?.includes(target) ? target : null;
  }
  return targetNodeIds?.[0] ?? `@@external:${node.text.trim()}`;
}

/** The object of a member reference, per grammar: `this.save`, `self.save`, `Self::save`, `this::save`. */
const MEMBER_OBJECT_FIELD: Record<string, string> = {
  member_expression: "object",
  attribute: "object",
  field_expression: "value",
  member_access_expression: "expression",
  selector_expression: "operand",
  scoped_identifier: "path",
  method_invocation: "object",
};

/**
 * Per member grammar, the object that names the enclosing type: `this` (TS/JS, Java, C#), `self`/`cls` (Python),
 * `self`/`Self` (Rust). Elsewhere `self` is an ordinary variable; Go has no such receiver keyword.
 */
const SELF_NAMES: Record<string, ReadonlySet<string>> = {
  attribute: new Set(["self", "cls"]),
  field_expression: new Set(["self"]),
  scoped_identifier: new Set(["self", "Self"]),
};

/** Whether `object`, the object of a `memberType` reference, is the enclosing type, so its member is in this file. */
function isSelfObject(memberType: string | undefined, object: TreeNode | null | undefined): boolean {
  if (!object) return false;
  if (object.type === "this" || object.type === "this_expression") return true;
  return object.type === "identifier" && (SELF_NAMES[memberType ?? ""]?.has(object.text) ?? false);
}

/** The object of `node`'s member reference (`this` in `this.save`), or undefined when `node` is no member. */
function memberObject(node: TreeNode): TreeNode | null | undefined {
  const member = node.parent;
  if (member?.type === "method_reference") return member.namedChildren[0];
  const objectField = MEMBER_OBJECT_FIELD[member?.type ?? ""];
  return objectField === undefined ? undefined : member?.childForFieldName(objectField);
}

/**
 * Candidates a `this.save` / `self.save` / `Self::save` reference can reach: the members of its enclosing type
 * (a same-name function elsewhere in the file is not one of them); every candidate for any other reference.
 */
function ownMembers(node: TreeNode, candidates: string[] | undefined): string[] | undefined {
  if (!candidates || candidates.length < 2 || !isSelfObject(node.parent?.type, memberObject(node))) return candidates;
  let owner = node.parent;
  while (owner && !TYPE_SCOPES.has(owner.type)) owner = owner.parent;
  if (!owner) return candidates;
  const [start, end] = [owner.startPosition.row, owner.endPosition.row];
  // Node ids end with their 0-based start line.
  return candidates.filter((id) => {
    const line = Number(id.slice(id.lastIndexOf(":") + 1));
    return line >= start && line <= end;
  });
}

/** Bare calls that reach a method of the enclosing type, as `this.m()` does: Java and C# invocations. */
const IMPLICIT_THIS_CALLS = new Set(["method_invocation", "invocation_expression"]);

/** Type of the receiver of a member call: `this`/`self`, a variable, a type (`B.m()`) or a construction (`new B()`). */
function receiverType(node: TreeNode, object: TreeNode): string | null {
  if (isSelfObject(node.parent?.type, object)) return enclosingType(object);
  return object.type === "identifier" ? variableType(object) : typeNameOf(object);
}

/**
 * Same-file homonyms a call can reach (#505): the method of its receiver's type, a function (or, in Java and
 * C#, a method of the enclosing type) for a bare call. Null, so no edge, unless exactly one matches: a call is
 * never linked to an arbitrary homonym. A single candidate is kept as is.
 * shortcut: a method inherited from a same-file base type is not followed; upgrade with the INHERITS edges.
 */
function homonymTargets(node: TreeNode, candidates: string[] | undefined, definitions: Map<string, TreeNode>): string[] | null | undefined {
  if (!candidates || candidates.length < 2) return candidates;
  // A Java bare invocation has no `object` field: null, like no member at all.
  const object = memberObject(node) ?? undefined;
  let owner: string | null = null;
  if (object) owner = receiverType(node, object);
  else if (IMPLICIT_THIS_CALLS.has(node.parent?.type ?? "")) owner = enclosingType(node);
  if (object && owner === null) return null;
  const matching = candidates.filter((id) => {
    const definition = definitions.get(id);
    return definition !== undefined && methodOwner(definition) === owner;
  });
  return matching.length === 1 ? matching : null;
}

/** Same-file candidates of a capture: a call not bound by an import or a qualifier picks among its homonyms. */
function callTargets(
  capture: ReturnType<Query["captures"]>[number],
  candidates: string[] | undefined,
  definitions: Map<string, TreeNode>,
  importTargets: Map<number, string | null>,
): string[] | null | undefined {
  const bound = importTargets.has(capture.node.id) && importTargets.get(capture.node.id) !== LOCAL_ONLY;
  return capture.name === "call" && !bound ? homonymTargets(capture.node, candidates, definitions) : candidates;
}

/**
 * Whether a reference capture resolved exactly: through an import or a scope, or to the only same-file
 * declaration of its name. A member (`<Tabs.Panel />`, `onClick={props.save}`, `register(obj.save)`)
 * reaches this file only through `this`/`self` (`register(this.save)`, Java `this::save`).
 */
function isExactReference(
  node: TreeNode,
  targetId: string,
  targetNodeIds: string[] | undefined,
  importTargets: Map<number, string | null>,
): boolean {
  if (importTargets.has(node.id)) return true;
  if (targetId.startsWith("@@external:") || targetNodeIds?.length !== 1) return false;
  const object = memberObject(node);
  return object === undefined || isSelfObject(node.parent?.type, object);
}

/**
 * `memo` of `const Card = memo(...)` (or `React.memo`): the component is what the wrapper wraps, so the wrapper
 * is no callee of it, as in SymbolAnalyzer.
 */
const FACTORY_NAME = /^(?:memo|forwardRef|lazy)$/;

function isFactoryCallee(node: TreeNode, name: string): boolean {
  if (!FACTORY_NAME.test(name)) return false; // most calls: no tree walk (each node access crosses into WASM)
  const callee = node.parent?.type === "member_expression" ? node.parent : node;
  if (!isComponentFactory(callee.text)) return false;
  const call = callee.parent;
  return call?.type === "call_expression" && call.childForFieldName("function")?.id === callee.id
    && call.parent?.type === "variable_declarator";
}

/** Whether an edge target would only be a guess by name, so the edge is dropped. */
function isGuessedTarget(
  captureName: string,
  node: TreeNode,
  targetId: string,
  targetNodeIds: string[] | undefined,
  importTargets: Map<number, string | null>,
): boolean {
  // Skip cross-file edges from member/method access calls (e.g. obj.method()).
  // Without type information, name-only resolution creates false positives:
  // Object.keys() → user's `keys`, Math.round() → user's `round`, etc.
  // Intra-file member calls (this.method()) are kept — targetNodeIds is set.
  // Same for JSX `<Tabs.Panel />` outside a resolved namespace import.
  if (IMPORT_RESOLVED_CAPTURES.has(captureName) && targetId.startsWith("@@external:") && isMemberAccessCapture(node)) return true;
  return REFERENCE_CAPTURES.has(captureName) && !isExactReference(node, targetId, targetNodeIds, importTargets);
}

/** One edge per source/target/relation; any React JSX use of it marks the kept edge. */
function addEdge(seen: Map<string, CallGraphEdge>, edges: CallGraphEdge[], edge: CallGraphEdge, reactComponent: boolean): void {
  const key = `${edge.sourceId}::${edge.targetId}::${edge.typeRelation}`;
  const kept = seen.get(key) ?? edge;
  if (reactComponent) kept.reactComponent = true;
  if (kept !== edge) return;
  seen.set(key, edge);
  edges.push(edge);
}

// ---------------------------------------------------------------------------
// GraphExtractor
// ---------------------------------------------------------------------------

export class GraphExtractor {
  private readonly config: ExtractorConfig;
  /** shortcut: read once per extractor, so a tsconfig runtime edit applies after the next re-index session. */
  private jsxImportSource?: Promise<string | undefined>;
  /** In-memory cache for .scm query sources — avoids re-reading from disk per file */
  private readonly querySourceCache = new Map<string, string>();
  /** Compiled tree-sitter Query objects cached per language — avoids recompilation per file */
  private readonly compiledQueryCache = new Map<string, Query>();

  constructor(config: ExtractorConfig) {
    this.config = config;
  }

  private readJsxImportSource(): Promise<string | undefined> {
    this.jsxImportSource ??= readReactJsxImportSource(this.config.workspaceRoot);
    return this.jsxImportSource;
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
    // No tree-sitter grammar ships for GraphQL: it has its own scanner.
    if (lang === "graphql") return extractGraphQL(source, normalizedPath, this.computeFolder(normalizedPath));

    // Resolve WASM paths
    const treeSitterWasmPath = path.join(
      this.config.extensionPath,
      "dist",
      "wasm",
      "tree-sitter.wasm",
    );

    const grammar = grammarOf(lang, normalizedPath);
    const wasmFileName = this.langToWasmFileName(grammar);
    const langWasmPath = path.join(
      this.config.extensionPath,
      "dist",
      "wasm",
      wasmFileName,
    );

    // Load query source for this grammar
    const querySrc = await this.loadQuerySource(grammar);
    if (!querySrc.trim()) {
      // Empty query file — return empty result
      return { nodes: [], edges: [] };
    }

    // Initialize WASM parser factory
    const factory = WasmParserFactory.getInstance();
    await factory.init(treeSitterWasmPath);

    const parser = await factory.getParser(grammar, langWasmPath);
    const language = parser.language;
    if (!language) {
      throw new Error(`Language not loaded for ${grammar}`);
    }

    // Parse the source
    const tree = parser.parse(source);
    if (!tree) {
      return { nodes: [], edges: [] };
    }
    try {
      // Run query (compiled Query is cached per language — safe to reuse across files)
      const query = this.getOrCompileQuery(language, querySrc, grammar);
      const captures = query.captures(tree.rootNode);
      const calls = captures.filter(c => IMPORT_RESOLVED_CAPTURES.has(c.name)).map(c => c.node);
      // A reference can only reach an import or a name this file declares: other passed values are left out early.
      const declared = new Set(captures.filter(c => DEF_CAPTURE_NAMES.has(c.name)).map(c => c.node.text));
      const references = new Set(captures.filter(c => REFERENCE_CAPTURES.has(c.name)).map(c => c.node.id));
      const resolver = new PathResolver(undefined, true, this.config.workspaceRoot);
      let importTargets: Map<number, string | null>;
      if (lang === "typescript" || lang === "javascript") {
        importTargets = await resolveNamedImportCalls(tree.rootNode, calls, normalizedPath, resolver, { references, declared });
      } else if (lang === "python") {
        importTargets = await resolvePythonImportCalls(tree.rootNode, calls, normalizedPath, resolver);
      } else {
        importTargets = await resolveQualifiedCalls(tree.rootNode, calls, lang, normalizedPath, normalizePath(this.config.workspaceRoot));
      }
      const jsxImportSource = lang === 'typescript' || lang === 'javascript'
        ? await this.readJsxImportSource() : undefined;
      return this.processCaptures(captures, normalizedPath, lang, source, importTargets, jsxImportSource);
    } finally {
      tree.delete();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers — Query compilation cache
  // ---------------------------------------------------------------------------

  /**
   * Return a cached compiled Query for the given language, compiling on first use.
   * The Query object is safe to reuse across multiple tree parses — `.captures()` is stateless.
   */
  private getOrCompileQuery(language: ConstructorParameters<typeof Query>[0], querySrc: string, grammar: Grammar): Query {
    // Keyed by grammar: a query compiled for one grammar's Language does not run on another's tree.
    const key = queryFilesOf(grammar).join("+");
    const cached = this.compiledQueryCache.get(key);
    if (cached) return cached;

    let query: Query;
    try {
      query = new Query(language, querySrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Tree-sitter query for ${grammar}: ${msg}`, { cause: err });
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
    importTargets: Map<number, string | null>,
    jsxImportSource?: string,
  ): ExtractionResult {
    const folder = this.computeFolder(normalizedFilePath);
    const { nodeMap, positionToNodeId, nameToNodeIds, definitions } =
      this.buildNodeMap(captures, normalizedFilePath, lang, folder, source);
    const identity = analyzeReactIdentity(normalizedFilePath, source, jsxImportSource);
    for (const node of nodeMap.values()) {
      node.reactEligible = identity.eligible;
      if (identity.components.some(component => component.name === node.name && component.startLine === node.startLine)) node.framework = 'react';
    }
    const edges = this.buildEdges(captures, positionToNodeId, nameToNodeIds, definitions, importTargets, identity.isReact);
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
    positionToNodeId: Map<string, string>;
    nameToNodeIds: Map<string, string[]>;
    /** Name node of each definition, read only to tell same-named methods apart. */
    definitions: Map<string, TreeNode>;
  } {
    const nodeMap = new Map<string, CallGraphNode>();
    const defCaptures: Array<{ captureName: string; node: TreeNode }> = [];
    const positionToNodeId = new Map<string, string>();
    const nameToNodeIds = new Map<string, string[]>();
    const definitions = new Map<string, TreeNode>();

    for (const capture of captures) {
      if (!DEF_CAPTURE_NAMES.has(capture.name)) continue;
      defCaptures.push({ captureName: capture.name, node: capture.node });
    }

    for (const { captureName, node } of defCaptures) {
      const symbolName = node.text.trim();
      if (!symbolName) continue;
      const startLine = node.startPosition.row;
      // The capture is the name identifier; the declaration spans the body.
      const endLine = (node.parent ?? node).endPosition.row;
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
      const owner = definitionOwner(lang, node);
      if (owner) cgNode.owner = owner;
      nodeMap.set(nodeId, cgNode);
      definitions.set(nodeId, node);
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
    return { nodeMap, positionToNodeId, nameToNodeIds, definitions };
  }

  private buildEdges(
    captures: ReturnType<Query["captures"]>,
    positionToNodeId: Map<string, string>,
    nameToNodeIds: Map<string, string[]>,
    definitions: Map<string, TreeNode>,
    importTargets: Map<number, string | null>,
    reactContext: boolean,
  ): CallGraphEdge[] {
    const edges: CallGraphEdge[] = [];
    const seenEdges = new Map<string, CallGraphEdge>();

    for (const capture of captures) {
      const relationType = captureNameToRelationType(capture.name);
      if (!relationType) continue;
      const targetName = capture.node.text.trim();
      if (!targetName || (capture.name === "call" && isFactoryCallee(capture.node, targetName))) continue;
      const named = nameToNodeIds.get(targetName);
      const targetNodeIds = REFERENCE_CAPTURES.has(capture.name) ? ownMembers(capture.node, named) : callTargets(capture, named, definitions, importTargets);
      if (targetNodeIds === null) continue;
      const targetId = resolveEdgeTarget(capture.node, targetNodeIds, importTargets);
      // Target first: most passed values are variables that link nowhere, and the ancestor walk below is costly.
      if (!targetId || isGuessedTarget(capture.name, capture.node, targetId, targetNodeIds, importTargets)) continue;
      const sourceLine = capture.node.startPosition.row;
      const sourceNodeId = this.findEnclosingDefinitionId(capture.node, positionToNodeId);
      if (!sourceNodeId) continue;

      addEdge(seenEdges, edges, { sourceId: sourceNodeId, targetId, typeRelation: relationType, sourceLine }, capture.name === 'jsx' && reactContext);
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
    positionToNodeId: Map<string, string>,
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
    // Python has no export keyword: a module-level def/class is what `from m import x` can reach.
    const declaration = node.parent;
    if (declaration?.type === "function_definition" || declaration?.type === "class_definition") {
      const outer = declaration.parent?.type === "decorated_definition" ? declaration.parent.parent : declaration.parent;
      if (outer?.type === "module") return true;
    }
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
    return workspaceFolder(normalizedFilePath, this.config.workspaceRoot);
  }


  /**
   * Load the Tree-sitter query source for the given grammar (its query files, concatenated).
   * Empty string if a file is not found or the files are empty.
   */
  private async loadQuerySource(grammar: Grammar): Promise<string> {
    const files = queryFilesOf(grammar);
    const key = files.join("+");
    const cached = this.querySourceCache.get(key);
    if (cached !== undefined) return cached;

    const queryPaths = files.map(file => path.join(this.config.extensionPath, "dist", "queries", file));
    try {
      const src = (await Promise.all(queryPaths.map(queryPath => fs.readFile(queryPath, "utf8")))).join("\n");
      this.querySourceCache.set(key, src);
      return src;
    } catch (err) {
      getLogger('GraphExtractor').error(`Query file not found: ${queryPaths.join(", ")}`, err);
      this.querySourceCache.set(key, "");
      return "";
    }
  }

  /**
   * Map a grammar to its WASM file name in dist/wasm.
   */
  private langToWasmFileName(grammar: Grammar): string {
    switch (grammar) {
      case "typescript":
      case "javascript":
        // The TypeScript grammar parses JS too; JSX files use the tsx grammar.
        return "tree-sitter-typescript.wasm";
      case "tsx":
        return "tree-sitter-tsx.wasm";
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
      case "graphql":
        throw new Error("GraphQL is extracted without tree-sitter");
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: determine SupportedLang from file extension
// ---------------------------------------------------------------------------

/**
 * Returns the SupportedLang for a given normalized file path, or null if not
 * supported by the GraphExtractor. `.tsx`/`.jsx` keep the typescript/javascript
 * language; `grammarOf()` picks their tsx grammar.
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
    case ".graphql":
    case ".gql":
      return "graphql";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Incremental indexing helpers (shared by the extension and the CLI)
// ---------------------------------------------------------------------------

/** Minimal view of a `file_index` row — avoids a CallGraphIndexer import cycle. */
export interface IndexedFileRecord {
  lastModified: number;
  indexedAt: number;
}

/** Lookup of the persisted index record for a file, or null when never indexed. */
export type IndexedFileLookup = (filePath: string) => IndexedFileRecord | null;

/** One file that needs (re-)extraction. */
export interface ExtractionJob {
  filePath: string;
  lang: SupportedLang;
  mtime: number;
}

/** `fs.stat` calls in flight when checking freshness. */
const STAT_BATCH = 32;

/**
 * Returns per-language freshness cutoffs derived from query-file mtimes.
 * A file indexed before its language query was updated must be re-extracted
 * even when the source file itself is unchanged.
 *
 * @param extensionPath Package root containing `dist/queries/*.scm`.
 */
export async function getQueryFreshnessCutoffs(
  extensionPath: string,
): Promise<Record<SupportedLang, number>> {
  const queryDir = path.join(extensionPath, "dist", "queries");
  // .tsx/.jsx files keep the typescript/javascript language but also run tsx.scm.
  const langs: Array<Exclude<SupportedLang, "graphql">> = ["typescript", "javascript", "python", "rust", "csharp", "go", "java"];
  const queryFiles = langs.map((lang) => [lang, queryFilesOf(lang === "typescript" || lang === "javascript" ? "tsx" : lang)] as const);

  const mtimeOf = async (file: string): Promise<number> => {
    try {
      return Math.floor((await fs.stat(path.join(queryDir, file))).mtimeMs);
    } catch {
      // A missing query file must not block indexing.
      return 0;
    }
  };
  const entries = await Promise.all(
    queryFiles.map(async ([lang, files]) => [lang, Math.max(...(await Promise.all(files.map(mtimeOf))))] as const),
  );

  // GraphQL has no query file: its rules live in graphqlExtractor.ts.
  return { ...Object.fromEntries(entries), graphql: 0 } as Record<SupportedLang, number>;
}

/**
 * Batch-`fs.stat` the given files and drop the ones already fresh in the index.
 *
 * A file is skipped only when both the source file AND the extractor rules that
 * produced its rows are still fresh.
 *
 * @param files    Candidate source files (normalized absolute paths).
 * @param lookup   Reads the persisted index record for a file.
 * @param cutoffs  Per-language query freshness cutoffs.
 * @param langOf   Maps a path to its language; files mapping to null are skipped.
 */
export async function collectChangedFiles(
  files: readonly string[],
  lookup: IndexedFileLookup,
  cutoffs: Record<SupportedLang, number>,
  langOf: (filePath: string) => SupportedLang | null = fileExtToLang,
  isCancelled: () => boolean = () => false,
): Promise<{ jobs: ExtractionJob[]; skipped: number }> {
  const jobs: ExtractionJob[] = [];
  let skipped = 0;

  let cancelled = false;
  const stats = await mapWithConcurrency(files, STAT_BATCH, async (filePath) => {
    // Once cancelled, no new stat starts and the remaining files are neither jobs nor skipped.
    if (cancelled || isCancelled()) {
      cancelled = true;
      return null;
    }
    try {
      const s = await fs.stat(filePath);
      return { filePath, mtime: Math.floor(s.mtimeMs), ok: true as const };
    } catch {
      return { filePath, mtime: 0, ok: false as const };
    }
  });

  for (const s of stats) {
    if (!s) continue;
    const lang = s.ok ? langOf(s.filePath) : null;
    if (!lang) {
      skipped++;
      continue;
    }

    const record = lookup(s.filePath);
    const queryCutoff = cutoffs[lang] ?? 0;
    if (record && record.lastModified >= s.mtime && record.indexedAt >= queryCutoff) {
      skipped++;
      continue;
    }

    jobs.push({ filePath: s.filePath, lang, mtime: s.mtime });
  }

  return { jobs, skipped };
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
