/**
 * contracts/messages.ts
 *
 * Extension ↔ Webview message protocol for the Live Call Graph feature.
 *
 * SPEC REFERENCE: specs/001-live-call-graph/spec.md — FR-001, FR-013
 * DATA MODEL: specs/001-live-call-graph/data-model.md
 *
 * These types extend src/shared/types.ts.
 * Adding them here first so the contract is reviewable before implementation.
 *
 * Convention matches existing message types in src/shared/types.ts:
 *   - extension → webview: discriminated union on `type`
 *   - webview → extension: discriminated union on `command`
 */

// ---------------------------------------------------------------------------
// Shared primitive types (mirrored in src/shared/types.ts at implementation)
// ---------------------------------------------------------------------------

/** Symbol types recognized by the GraphExtractor */
export type SymbolType = "function" | "class" | "method" | "interface" | "type" | "variable";

/** Relation types extracted by Tree-sitter queries */
export type RelationType = "CALLS" | "INHERITS" | "IMPLEMENTS" | "USES";

/** Language keys aligned with LANGUAGE_COLORS in src/shared/constants.ts */
export type SupportedLang = "typescript" | "javascript" | "python" | "rust";

// ---------------------------------------------------------------------------
// Serialized graph payload (sent in showCallGraph message)
// ---------------------------------------------------------------------------

export interface SerializedCallNode {
  /** Stable ID: normalizedFilePath:symbolName:startLine */
  id: string;
  /** Symbol's bare display name */
  name: string;
  type: SymbolType;
  lang: SupportedLang;
  /** Normalized absolute path */
  path: string;
  /** Workspace-relative folder path (determines compound node parent) */
  folder: string;
  /** 0-based start line */
  startLine: number;
  /** 0-based end line */
  endLine: number;
  /** 0-based start column */
  startCol: number;
  isExported: boolean;
  /** True when this node is the symbol the user clicked on */
  isRoot: boolean;
}

export interface SerializedCallEdge {
  sourceId: string;
  targetId: string;
  typeRelation: RelationType;
  /** True when this edge is part of a detected cycle */
  isCyclic: boolean;
  /** Line in source file where the reference occurs */
  sourceLine: number;
}

export interface SerializedCompoundNode {
  /** Workspace-relative folder path, e.g. "src/services" */
  id: string;
  /** Last path segment label, e.g. "services" */
  label: string;
  type: "compound";
}

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/**
 * Sent when the extension has resolved the neighbourhood graph for a symbol.
 * The webview initialises or refreshes the Cytoscape instance with this data.
 */
export interface ShowCallGraphMessage {
  type: "showCallGraph";
  /** The ID of the root symbol (as defined in SerializedCallNode.id) */
  rootSymbolId: string;
  nodes: SerializedCallNode[];
  edges: SerializedCallEdge[];
  compounds: SerializedCompoundNode[];
  /** Traversal depth used to build this neighbourhood */
  depth: number;
  /** Unix ms — webview discards messages older than the last received */
  timestamp: number;
}

/**
 * Sent during indexation to inform the webview of progress.
 */
export interface CallGraphIndexingMessage {
  type: "callGraphIndexing";
  status: "started" | "progress" | "complete" | "error";
  message?: string;
  /** 0-100 */
  percent?: number;
}

/** Discriminated union of all extension → webview messages for this feature */
export type CallGraphExtensionMessage = ShowCallGraphMessage | CallGraphIndexingMessage;

// ---------------------------------------------------------------------------
// Webview → Extension messages
// ---------------------------------------------------------------------------

/**
 * Sent when the user clicks on a node in the Cytoscape graph.
 * The extension opens the corresponding file at the symbol's location.
 */
export interface CallGraphOpenFileCommand {
  command: "callGraphOpenFile";
  /** Absolute file URI scheme path */
  uri: string;
  /** 0-based line number to reveal */
  line: number;
  /** 0-based column number to reveal */
  character: number;
}

/**
 * Sent when the Cytoscape graph has finished rendering (used for E2E test instrumentation).
 */
export interface CallGraphReadyCommand {
  command: "callGraphReady";
  /** Number of nodes rendered */
  nodeCount: number;
  /** Number of edges rendered */
  edgeCount: number;
}

/**
 * Sent when the user toggles a filter in the legend (show/hide a node type or folder).
 * The extension may use this to persist filter state; the webview applies filters locally.
 */
export interface CallGraphFilterChangedCommand {
  command: "callGraphFilterChanged";
  /** What was toggled */
  filterType: "nodeType" | "folder";
  /** The value being toggled (SymbolType string or folder path) */
  value: string;
  /** New visibility state */
  visible: boolean;
}

/** Discriminated union of all webview → extension messages for this feature */
export type CallGraphWebviewCommand =
  | CallGraphOpenFileCommand
  | CallGraphReadyCommand
  | CallGraphFilterChangedCommand;
