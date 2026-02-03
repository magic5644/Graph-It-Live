export interface GraphEdge {
  source: string;
  target: string;
  relationType?: "dependency" | "call" | "reference";
}

export interface GraphData {
  nodes: string[];
  edges: GraphEdge[];
  /** Optional custom labels for nodes (key: node path, value: display label) */
  nodeLabels?: Record<string, string>;
  /** Optional map of parent counts (how many files import a node). If present, used to show/hide the Find References toggle button in the UI. */
  parentCounts?: Record<string, number>;
  /** Optional list of edge IDs (source-target) that represent unused dependencies (imports that are not used in code). */
  unusedEdges?: string[];
}

export interface ShowGraphMessage {
  command: "updateGraph";
  filePath: string;
  data: GraphData;
  expandAll?: boolean;
  /** If true, this is a refresh of the current view, not a navigation - don't change viewMode or push to history */
  isRefresh?: boolean;
  /**
   * Optional refresh reason. Used by the webview to decide whether to replace the
   * graph data or merge it (eg. keep expanded nodes while refreshing parentCounts after indexing).
   */
  refreshReason?:
    | "manual"
    | "indexing"
    | "fileSaved"
    | "navigation"
    | "fileChange"
    | "usage-analysis"
    | "unknown";
  unusedDependencyMode?: "none" | "hide" | "dim";
  /** Whether the unused dependency filter is active (controlled by backend state) */
  filterUnused?: boolean;
}

export interface OpenFileMessage {
  command: "openFile";
  path: string;
  /** Optional line number to navigate to (1-indexed) */
  line?: number;
}

export interface ExpandNodeMessage {
  command: "expandNode";
  nodeId: string;
  knownNodes: string[];
}

export interface SetExpandAllMessage {
  command: "setExpandAll";
  expandAll: boolean;
}

export interface CancelExpandNodeMessage {
  command: "cancelExpandNode";
  nodeId?: string;
}

export interface UpdateFilterMessage {
  command: "updateFilter";
  filterUnused: boolean;
  unusedDependencyMode: "none" | "hide" | "dim";
}

export interface RefreshingMessage {
  command: "refreshing";
}

export interface RefreshGraphMessage {
  command: "refreshGraph";
}

export interface EnableUnusedFilterMessage {
  command: "enableUnusedFilter";
}

export interface DisableUnusedFilterMessage {
  command: "disableUnusedFilter";
}

export interface SelectSymbolMessage {
  command: "selectSymbol";
  symbolId: string | undefined;
}

export interface ExpandedGraphMessage {
  command: "expandedGraph";
  nodeId: string;
  data: GraphData;
}

export interface FindReferencingFilesMessage {
  command: "findReferencingFiles";
  nodeId: string;
}

export interface ReferencingFilesMessage {
  command: "referencingFiles";
  nodeId: string;
  data: GraphData;
}

export interface ExpansionProgressMessage {
  command: "expansionProgress";
  nodeId: string;
  status: "started" | "in-progress" | "completed" | "cancelled" | "error";
  processed?: number;
  total?: number;
  message?: string;
}

export interface IndexingProgressMessage {
  command: "indexingProgress";
  /** Number of files processed so far */
  processed: number;
  /** Total number of files to process */
  total: number;
  /** Current status of the indexing operation */
  status: "starting" | "indexing" | "complete" | "error" | "validating";
  /** Optional message for additional context */
  message?: string;
}

export interface DrillDownMessage {
  command: "drillDown";
  filePath: string;
}

export interface ReadyMessage {
  command: "ready";
}

export interface SwitchModeMessage {
  command: "switchMode";
  mode: "file" | "symbol";
}

export interface SwitchViewModeMessage {
  command: "switchViewMode";
  mode: "file" | "list" | "symbol";
}

export interface WebviewLogMessage {
  command: "webviewLog";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  args?: unknown[];
}

// ===========================
// Symbol-Level Entities (LSP-Based Call Hierarchy)
// ===========================

/**
 * Represents a code symbol (function, class, method, variable) discovered via LSP.
 * Used for intra-file symbol-level call hierarchy visualization.
 */
export interface SymbolNode {
  /** Unique identifier: ${filePath}:${symbolName} (e.g., "src/utils.ts:calculateSum") */
  id: string;
  /** Display name (may be contextual for anonymous functions, e.g., "map callback") */
  name: string;
  /** Original AST name if different from display name (for anonymous functions) */
  originalName?: string;
  /** LSP symbol kind enum: Function, Class, Method, Variable, etc. */
  kind: number; // vscode.SymbolKind value
  /** Simplified category for color coding */
  type: "class" | "function" | "variable";
  /** Line range in file (1-indexed) */
  range: { start: number; end: number };
  /** Whether symbol is exported (for external call detection) */
  isExported: boolean;
  /** Whether symbol is defined in a different file (dimmed rendering with opacity: 0.5) */
  isExternal: boolean;
  /** ID of containing symbol (for nested methods in classes) */
  parentSymbolId?: string;
}

/**
 * Represents a relationship between symbols (function call or variable reference).
 */
export interface CallEdge {
  /** Caller symbol ID (SymbolNode.id) */
  source: string;
  /** Callee symbol ID (SymbolNode.id) */
  target: string;
  /** Type of relationship */
  relation: "calls" | "references";
  /** Direction of call (outgoing = this calls someone, incoming = someone calls this) - Étape 5 */
  direction?: "outgoing" | "incoming";
  /** Line number where call/reference occurs in source (for navigation) */
  line: number;
}

/**
 * Cycle type classification for better understanding of circular dependencies
 */
export type CycleType = 
  | "self-recursive"    // Single function calling itself (e.g., factorial, tree traversal)
  | "mutual-recursive"  // Two functions calling each other (e.g., eval ↔ execute)
  | "complex";          // Cycle involving 3+ functions (e.g., A → B → C → A)

/**
 * Represents the complete symbol-level dependency graph for a single file.
 */
export interface IntraFileGraph {
  /** File path this graph represents */
  filePath: string;
  /** All symbols discovered in the file */
  nodes: SymbolNode[];
  /** All call/reference relationships between symbols */
  edges: CallEdge[];
  /** Étape 5: Incoming call edges (callers → callee) - optional, populated when includeIncomingCalls=true */
  incomingEdges?: CallEdge[];
  /** True if cycle detected (recursive or mutually recursive calls) */
  hasCycle: boolean;
  /** Optional list of node IDs involved in cycles */
  cycleNodes?: string[];
  /** Type of cycle detected (helps distinguish intentional recursion from problematic cycles) */
  cycleType?: CycleType;
}

/**
 * Represents the breadcrumb navigation path (Project → folder → filename.ts).
 */
export interface BreadcrumbPath {
  /** Segments of the breadcrumb (e.g., ["Project", "src", "utils.ts"]) */
  segments: string[];
  /** File path associated with this breadcrumb */
  filePath: string;
}

// ===========================
// Existing Symbol Info (File-Level)
// ===========================

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  isExported: boolean;
  id: string;
  parentSymbolId?: string;
  category: "function" | "class" | "variable" | "interface" | "type" | "other";
}

export interface SymbolDependency {
  sourceSymbolId: string;
  targetSymbolId: string;
  targetFilePath: string;
  /** Type of relationship: 'dependency' (import/export), 'call' (function call), 'reference' (variable usage) */
  relationType?: "dependency" | "call" | "reference";
  /** For calls: positions of calls in source code (for navigation) */
  callLocations?: { line: number; character: number }[];
  /** Whether this is a type-only dependency (interface/type usage vs runtime) */
  isTypeOnly?: boolean;
}

export interface EmptyStateMessage {
  command: "emptyState";
  reason: "no-file-open" | "no-workspace";
  /** Optional message to display to the user */
  message?: string;
}

export interface SymbolGraphMessage {
  command: "symbolGraph";
  filePath: string;
  /** If true, this is a refresh of the current view, not a navigation - don't push to history */
  isRefresh?: boolean;
  /** Target view mode for the webview (overrides automatic mode detection) */
  targetViewMode?: "symbol" | "list";
  /** Symbol-level graph data (LSP-based call hierarchy) */
  graph: IntraFileGraph;
  /** Breadcrumb navigation path */
  breadcrumb: BreadcrumbPath;
  /** Legacy graph data structure for backward compatibility */
  data?: {
    nodes: string[];
    edges: Array<{ source: string; target: string }>;
    symbolData?: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
    incomingDependencies?: SymbolDependency[]; // External calls TO symbols in this file
    referencingFiles?: string[];
    parentCounts?: Record<string, number>;
  };
}

/**
 * Sent when symbol analysis is in progress (e.g., waiting for LSP response).
 * Allows UI to show progress indicators during potentially slow LSP operations.
 */
export interface SymbolAnalysisProgressMessage {
  command: "symbolAnalysisProgress";
  filePath: string;
  /** Progress status */
  status: "started" | "analyzing" | "complete" | "timeout" | "error";
  /** Optional progress message */
  message?: string;
}

/**
 * Sent when symbol analysis cannot proceed (LSP unavailable, unsupported file type).
 */
export interface SymbolEmptyStateMessage {
  command: "symbolEmptyState";
  filePath: string;
  /** Reason why symbol analysis is unavailable */
  reason:
    | "lsp-unavailable"
    | "unsupported-file-type"
    | "empty-file"
    | "analysis-error";
  /** Human-readable message to display */
  message: string;
}

/**
 * Sent from webview to extension to request navigation to a specific symbol in the editor.
 */
export interface NavigateToSymbolMessage {
  command: "navigateToSymbol";
  filePath: string;
  /** Line number to navigate to (1-indexed) */
  line: number;
  /** Optional symbol ID for context */
  symbolId?: string;
}

/**
 * Sent from extension to webview to change the graph layout.
 * Only applicable in symbol view mode.
 */
export interface LayoutChangeMessage {
  type: "layoutChange";
  /** Target layout: hierarchical (Dagre), force (d3-force), or radial */
  layout: "hierarchical" | "force" | "radial";
}

/**
 * Sent from extension to webview to show symbol list view.
 * Displays exported/imported symbols in tabular format.
 */
export interface ShowSymbolListMessage {
  type: "showSymbolList";
}

// ===========================
// Symbol Clustering (Hierarchical View)
// ===========================

/**
 * Represents a cluster of symbols (namespace/dossier or class).
 * Used for hierarchical visualization with expand/collapse functionality.
 */
export interface SymbolCluster {
  /** Unique cluster ID (format: "filePath" for namespace, "filePath:className" for class) */
  id: string;
  /** Type of cluster: 'namespace' (dossier), 'class' (class/struct) */
  type: "namespace" | "class";
  /** Display name (folder name or class name) */
  name: string;
  /** Namespace/dossier path (e.g., "src/components") - only for namespace clusters */
  namespace?: string;
  /** Parent class name - only for nested class clusters */
  parentClass?: string;
  /** IDs of symbols contained in this cluster */
  symbolIds: string[];
  /** IDs of child clusters (e.g., classes within a namespace) */
  childClusterIds: string[];
  /** Whether this cluster is currently expanded */
  isOpen: boolean;
  /** Calculated position for rendering */
  x?: number;
  y?: number;
  /** Calculated dimensions for rendering */
  width?: number;
  height?: number;
}

/**
 * Extension of IntraFileGraph with clustering information.
 */
export interface IntraFileGraphWithClusters extends IntraFileGraph {
  /** Hierarchical clusters organizing symbols */
  clusters: SymbolCluster[];
}

export type ExtensionToWebviewMessage =
  | ShowGraphMessage
  | ExpandedGraphMessage
  | ReferencingFilesMessage
  | IndexingProgressMessage
  | SymbolGraphMessage
  | SymbolAnalysisProgressMessage
  | SymbolEmptyStateMessage
  | EmptyStateMessage
  | SetExpandAllMessage
  | ExpansionProgressMessage
  | UpdateFilterMessage
  | RefreshingMessage
  | LayoutChangeMessage
  | ShowSymbolListMessage
  | SwitchViewModeMessage;
export type WebviewToExtensionMessage =
  | OpenFileMessage
  | ExpandNodeMessage
  | SetExpandAllMessage
  | RefreshGraphMessage
  | FindReferencingFilesMessage
  | DrillDownMessage
  | NavigateToSymbolMessage
  | ReadyMessage
  | SwitchModeMessage
  | SwitchViewModeMessage
  | WebviewLogMessage
  | CancelExpandNodeMessage
  | EnableUnusedFilterMessage
  | DisableUnusedFilterMessage
  | SelectSymbolMessage;
