/**
 * Barrel re-export for backward compatibility.
 * Import from domain files directly for reduced blast radius:
 * - graph-types.ts      → GraphEdge, GraphData
 * - symbol-types.ts     → SymbolNode, CallEdge, IntraFileGraph, ...
 * - messages.ts         → All *Message types, ExtensionToWebviewMessage, WebviewToExtensionMessage
 * - callgraph-types.ts  → Live Call Graph types (SymbolType, SerializedCallNode, ShowCallGraphMessage, …)
 */
export * from './callgraph-types';
export * from './graph-types';
export * from './messages';
export * from './symbol-types';
