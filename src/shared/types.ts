export interface GraphData {
  nodes: string[];
  edges: { source: string; target: string }[];
  /** Optional custom labels for nodes (key: node path, value: display label) */
  nodeLabels?: Record<string, string>;
}

export interface ShowGraphMessage {
  command: 'updateGraph';
  filePath: string;
  data: GraphData;
  expandAll?: boolean;
  /** If true, this is a refresh of the current view, not a navigation - don't change viewMode or push to history */
  isRefresh?: boolean;
}

export interface OpenFileMessage {
  command: 'openFile';
  path: string;
  /** Optional line number to navigate to (1-indexed) */
  line?: number;
}

export interface ExpandNodeMessage {
  command: 'expandNode';
  nodeId: string;
  knownNodes: string[];
}

export interface SetExpandAllMessage {
  command: 'setExpandAll';
  expandAll: boolean;
}

export interface RefreshGraphMessage {
  command: 'refreshGraph';
}

export interface ExpandedGraphMessage {
  command: 'expandedGraph';
  nodeId: string;
  data: GraphData;
}

export interface FindReferencingFilesMessage {
  command: 'findReferencingFiles';
  nodeId: string;
}

export interface ReferencingFilesMessage {
  command: 'referencingFiles';
  nodeId: string;
  data: GraphData;
}

export interface IndexingProgressMessage {
  command: 'indexingProgress';
  /** Number of files processed so far */
  processed: number;
  /** Total number of files to process */
  total: number;
  /** Current status of the indexing operation */
  status: 'starting' | 'indexing' | 'complete' | 'error' | 'validating';
  /** Optional message for additional context */
  message?: string;
}

export interface DrillDownMessage {
  command: 'drillDown';
  filePath: string;
}

export interface ReadyMessage {
  command: 'ready';
}

export interface SwitchModeMessage {
  command: 'switchMode';
  mode: 'file' | 'symbol';
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  isExported: boolean;
  id: string;
  parentSymbolId?: string;
  category: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'other';
}

export interface SymbolDependency {
  sourceSymbolId: string;
  targetSymbolId: string;
  targetFilePath: string;
}

export interface EmptyStateMessage {
  command: 'emptyState';
  reason: 'no-file-open' | 'no-workspace';
  /** Optional message to display to the user */
  message?: string;
}

export interface SymbolGraphMessage {
  command: 'symbolGraph';
  filePath: string;
  /** If true, this is a refresh of the current view, not a navigation - don't push to history */
  isRefresh?: boolean;
  data: GraphData & {
    symbolData?: {
      symbols: SymbolInfo[];
      dependencies: SymbolDependency[];
    };
    /** List of files that import the current file */
    referencingFiles?: string[];
  };
}

export type ExtensionToWebviewMessage = ShowGraphMessage | ExpandedGraphMessage | ReferencingFilesMessage | IndexingProgressMessage | SymbolGraphMessage | EmptyStateMessage | SetExpandAllMessage;
export type WebviewToExtensionMessage = OpenFileMessage | ExpandNodeMessage | SetExpandAllMessage | RefreshGraphMessage | FindReferencingFilesMessage | DrillDownMessage | ReadyMessage | SwitchModeMessage;
