/**
 * Message protocol between extension and webview
 * Shared types for type-safe communication
 */

export interface GraphNode {
  id: string;
  label: string;
  filePath: string;
  fileType: 'ts' | 'tsx' | 'js' | 'jsx' | 'node_module' | 'other';
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'import' | 'require' | 'export' | 'dynamic';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Messages from Extension -> Webview
export type ExtensionMessage =
  | { command: 'updateGraph'; data: GraphData }
  | { command: 'clearGraph' };

// Messages from Webview -> Extension
export type WebviewMessage =
  | { command: 'openFile'; filePath: string }
  | { command: 'ready' };

// VSCode API declaration for webview
export interface VSCodeAPI {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi(): VSCodeAPI;
  }
}
