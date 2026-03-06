/**
 * GraphLegend — Interactive filter legend for the live call graph.
 *
 * Displays all active SymbolType and folder values present in the current graph.
 * Checkbox-style toggles let the user show/hide node types and folders without
 * recalculating the Cytoscape layout (FR-014).
 *
 * Posts `callGraphFilterChanged` to the extension on every toggle for optional
 * filter-state persistence (T028).
 *
 * NO @/ path aliases — webview uses relative imports.
 * SPEC: specs/001-live-call-graph/spec.md — US4
 */

import React from "react";
import type { CallGraphFilterChangedCommand, SymbolType } from "../../../shared/callgraph-types";

// ---------------------------------------------------------------------------
// VS Code webview API (same lazy-acquire pattern as CytoscapeGraph)
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vsCodeApi: VsCodeApi | null = null;
function getVsCodeApi(): VsCodeApi {
  if (!vsCodeApi) {
    vsCodeApi = acquireVsCodeApi();
  }
  return vsCodeApi;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphLegendProps {
  /** Symbol types present in the current graph */
  nodeTypes: SymbolType[];
  /** Workspace-relative folder paths present in the current graph */
  folders: string[];
  /** Currently hidden filters — encoded as "nodeType:<type>", "folder:<folder>", or "edgeType:<key>" */
  hiddenFilters: Set<string>;
  /** Called when a filter toggle occurs */
  onToggle: (filterType: "nodeType" | "folder" | "edgeType", value: string, visible: boolean) => void;
  /** Optional postMessage function (for shared webview mode) */
  postMessage?: (message: unknown) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYMBOL_TYPE_LABELS: Record<SymbolType, string> = {
  function: "Function",
  class: "Class",
  method: "Method",
  interface: "Interface",
  type: "Type",
  variable: "Variable",
};

const legendStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "12px",
  right: "12px",           // right side \u2014 avoids overlap with depth slider on the left
  background: "var(--vscode-sideBar-background, rgba(30,30,30,0.92))",
  border: "1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))",
  borderRadius: "6px",
  padding: "8px 10px",
  minWidth: "140px",
  maxWidth: "200px",
  maxHeight: "50vh",       // prevent oversized legend from covering the graph
  overflowY: "auto" as const,
  fontSize: "11px",
  color: "var(--vscode-foreground, #ccc)",
  zIndex: 20,
  backdropFilter: "blur(6px)",
  userSelect: "none" as const,
};

const sectionHeaderStyle: React.CSSProperties = {
  fontWeight: "600",
  marginBottom: "4px",
  color: "var(--vscode-descriptionForeground, #888)",
  fontSize: "10px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  marginBottom: "2px",
  cursor: "pointer",
};

const labelStyle = (visible: boolean): React.CSSProperties => ({
  opacity: visible ? 1 : 0.45,
  transition: "opacity 0.15s",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
});

// ---------------------------------------------------------------------------
// Edge legend colour definitions
// ---------------------------------------------------------------------------

interface EdgeLegendEntry {
  label: string;
  color: string;
  style: "solid" | "dashed" | "dotted";
  /** Key used for toggle filter state, e.g. "edgeType:outgoing" */
  filterKey: string;
}

const EDGE_LEGEND_ENTRIES: EdgeLegendEntry[] = [
  { label: "Outgoing call", color: "#4fc3f7", style: "solid", filterKey: "outgoing" },
  { label: "Incoming call", color: "#ffb74d", style: "solid", filterKey: "incoming" },
  { label: "Lateral", color: "#aaaaaa", style: "dashed", filterKey: "lateral" },
  { label: "Inherits", color: "#5a9cf8", style: "solid", filterKey: "inherits" },
  { label: "Implements", color: "#9b59b6", style: "dashed", filterKey: "implements" },
  { label: "Uses", color: "#888888", style: "dotted", filterKey: "uses" },
  { label: "Cycle", color: "#ff4d4d", style: "dashed", filterKey: "cycle" },
];

const edgeSwatchStyle = (entry: EdgeLegendEntry): React.CSSProperties => ({
  display: "inline-block",
  width: "18px",
  height: "0px",
  borderTop: `2px ${entry.style} ${entry.color}`,
  verticalAlign: "middle",
  flexShrink: 0,
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Interactive legend overlay for the Cytoscape call graph.
 * Renders outside Cytoscape DOM, positioned over the graph container.
 */
export function GraphLegend({
  nodeTypes,
  folders,
  hiddenFilters,
  onToggle,
  postMessage: postMessageProp,
}: Readonly<GraphLegendProps>): React.ReactElement {

  function handleToggle(filterType: "nodeType" | "folder" | "edgeType", value: string): void {
    const key = `${filterType}:${value}`;
    const nowVisible = hiddenFilters.has(key); // was hidden → becoming visible

    onToggle(filterType, value, nowVisible);

    const cmd: CallGraphFilterChangedCommand = {
      command: "callGraphFilterChanged",
      filterType,
      value,
      visible: nowVisible,
    };
    try {
      const sendMessage = postMessageProp ?? ((m: unknown) => getVsCodeApi().postMessage(m));
      sendMessage(cmd);
    } catch {
      // acquireVsCodeApi not available outside webview (e.g., unit tests)
    }
  }

  return (
    <div style={legendStyle} data-testid="graph-legend">
      {/* Edge colour legend with toggles */}
      <div>
        <div style={sectionHeaderStyle}>Edges</div>
        {EDGE_LEGEND_ENTRIES.map((entry) => {
          const key = `edgeType:${entry.filterKey}`;
          const visible = !hiddenFilters.has(key);
          return (
            <label
              key={entry.label}
              style={{ ...rowStyle, cursor: "pointer" }}
              aria-label={`Toggle ${entry.label} edges`}
            >
              <input
                type="checkbox"
                checked={visible}
                onChange={() => { handleToggle("edgeType", entry.filterKey); }}
                style={{ margin: 0 }}
              />
              <span style={edgeSwatchStyle(entry)} />
              <span style={labelStyle(visible)}>{entry.label}</span>
            </label>
          );
        })}
      </div>

      {nodeTypes.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <div style={sectionHeaderStyle}>Symbols</div>
          {nodeTypes.map((type) => {
            const key = `nodeType:${type}`;
            const visible = !hiddenFilters.has(key);
            return (
              <label
                key={key}
                style={{ ...rowStyle, cursor: "pointer" }}
                aria-label={`Toggle ${SYMBOL_TYPE_LABELS[type]} nodes`}
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => { handleToggle("nodeType", type); }}
                  style={{ margin: 0 }}
                />
                <span style={labelStyle(visible)}>{SYMBOL_TYPE_LABELS[type]}</span>
              </label>
            );
          })}
        </div>
      )}

      {folders.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <div style={sectionHeaderStyle}>Folders</div>
          {folders.map((folder) => {
            const key = `folder:${folder}`;
            const visible = !hiddenFilters.has(key);
            const label = folder.split("/").at(-1) ?? folder;
            return (
              <label
                key={key}
                style={{ ...rowStyle, cursor: "pointer" }}
                aria-label={`Toggle ${label} folder`}
                title={folder}
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => { handleToggle("folder", folder); }}
                  style={{ margin: 0 }}
                />
                <span style={{ ...labelStyle(visible), fontFamily: "monospace" }}>
                  {label}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
