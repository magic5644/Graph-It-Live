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

export type ExtensionToWebviewMessage = ShowGraphMessage | ExpandedGraphMessage;
export type WebviewToExtensionMessage = OpenFileMessage | ExpandNodeMessage | SetExpandAllMessage | RefreshGraphMessage;
