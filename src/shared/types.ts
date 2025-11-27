export interface GraphData {
  nodes: string[];
  edges: { source: string; target: string }[];
}

export interface ShowGraphMessage {
  command: 'updateGraph';
  filePath: string;
  data: GraphData;
  expandAll?: boolean;
}

export interface OpenFileMessage {
  command: 'openFile';
  path: string;
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

export type ExtensionToWebviewMessage = ShowGraphMessage | ExpandedGraphMessage | ReferencingFilesMessage | IndexingProgressMessage;
export type WebviewToExtensionMessage = OpenFileMessage | ExpandNodeMessage | SetExpandAllMessage | RefreshGraphMessage | FindReferencingFilesMessage;
