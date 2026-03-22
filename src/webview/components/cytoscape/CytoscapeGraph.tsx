/**
 * CytoscapeGraph — React component rendering the live call graph.
 *
 * Responsibilities:
 * - Initialize a Cytoscape.js instance inside a div ref on mount
 * - Register cytoscape-fcose layout extension (once, at module load)
 * - Listen to `window.message` for `showCallGraph` (render graph) and
 *   `callGraphIndexing` (show loading state) messages from the extension
 * - Post `callGraphReady` back to extension after layout completes
 * - Destroy Cytoscape instance on unmount (FR-016)
 *
 * NO @/ path aliases — webview uses relative imports.
 * SPEC: specs/001-live-call-graph/spec.md — FR-001..FR-016
 */

import cytoscape from "cytoscape";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  CallGraphDepthChangedCommand,
  CallGraphExtensionMessage,
  CallGraphMountedCommand,
  CallGraphReadyCommand,
  CallGraphSymbolFocusCommand,
  SerializedCallEdge,
  SerializedCallNode,
  SerializedCompoundNode,
  ShowCallGraphMessage,
  SymbolType,
} from "../../../shared/callgraph-types";
import { buildCallGraphStylesheet } from "./CytoscapeTheme";
import { GraphLegend } from "./GraphLegend";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcose = require("cytoscape-fcose") as cytoscape.Ext;

// ---------------------------------------------------------------------------
// Register fcose layout ONCE at module level (idempotent in Cytoscape)
// ---------------------------------------------------------------------------

cytoscape.use(fcose);

// ---------------------------------------------------------------------------
// VS Code webview API (available as window.acquireVsCodeApi in webviews)
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Lazily acquired so tests can load this module without the API.
// When CytoscapeGraph is rendered inside the main webview bundle (App.tsx),
// acquireVsCodeApi() was already called. In that case the caller passes its
// postMessage function as a prop; the local fallback is only for the
// standalone callgraph/index.tsx entry point.
let vsCodeApi: VsCodeApi | null = null;
function getVsCodeApi(): VsCodeApi | null {
  if (vsCodeApi) return vsCodeApi;
  try {
    if (typeof acquireVsCodeApi === "function") {
      vsCodeApi = acquireVsCodeApi();
    }
  } catch {
    // Already acquired — ignore
  }
  return vsCodeApi;
}

// ---------------------------------------------------------------------------
// Helper: compute call order for CALLS edges per source node
// ---------------------------------------------------------------------------

/**
 * For each source node, sort its outgoing CALLS edges by `sourceLine` and
 * assign a 1-based order index.  This reflects the sequence in which a
 * function calls its callees as written in source code.
 *
 * @returns Map from edge key (`sourceId→targetId→typeRelation`) to order number.
 */
function computeCallOrder(edges: SerializedCallEdge[]): Map<string, number> {
  const orderMap = new Map<string, number>();
  const edgesBySource = new Map<string, SerializedCallEdge[]>();

  for (const e of edges) {
    if (e.typeRelation !== "CALLS") continue;
    let list = edgesBySource.get(e.sourceId);
    if (!list) {
      list = [];
      edgesBySource.set(e.sourceId, list);
    }
    list.push(e);
  }

  for (const [, group] of edgesBySource) {
    group.sort((a, b) => a.sourceLine - b.sourceLine);
    for (let i = 0; i < group.length; i++) {
      orderMap.set(`${group[i].sourceId}→${group[i].targetId}→${group[i].typeRelation}`, i + 1);
    }
  }

  return orderMap;
}

// ---------------------------------------------------------------------------
// Helper: build Cytoscape elements from graph data
// ---------------------------------------------------------------------------

/**
 * Build Cytoscape node/compound elements. Edges are returned separately so they can
 * be added to the graph AFTER the batch that adds nodes — this ensures Cytoscape
 * renders edges above compound backgrounds regardless of z-index settings.
 */
function buildElements(
  nodes: SerializedCallNode[],
  edges: SerializedCallEdge[],
  compounds: SerializedCompoundNode[],
): { nodeElements: cytoscape.ElementDefinition[]; edgeElements: cytoscape.ElementDefinition[] } {
  const nodeElements: cytoscape.ElementDefinition[] = [];
  const edgeElements: cytoscape.ElementDefinition[] = [];

  // Build lookup sets for fast parent-existence checks
  const compoundIds = new Set(compounds.map((c) => c.id));

  // Folder compounds first, then file compounds (Cytoscape requires parents before children)
  const folderCompounds = compounds.filter((c) => c.compoundLevel === "folder");
  const fileCompounds = compounds.filter((c) => c.compoundLevel === "file");

  for (const c of [...folderCompounds, ...fileCompounds]) {
    nodeElements.push({
      group: "nodes",
      data: {
        id: c.id,
        label: c.label,
        type: "compound",
        compoundLevel: c.compoundLevel,
        parent: c.parent && compoundIds.has(c.parent) ? c.parent : undefined,
      },
    });
  }

  // Symbol nodes — parent is the file-level compound (n.path)
  for (const n of nodes) {
    nodeElements.push({
      group: "nodes",
      data: {
        id: n.id,
        label: n.name,
        name: n.name,
        type: n.type,
        lang: n.lang,
        path: n.path,
        startLine: n.startLine,
        startCol: n.startCol,
        // Use numeric 1/0 so Cytoscape [?isRoot] truthy selector works correctly
        // (the string "false" is truthy, which would style all nodes as roots)
        isRoot: n.isRoot ? 1 : 0,
        parent: compoundIds.has(n.path) ? n.path : undefined,
      },
    });
  }

  // Compute call order: for each source, sort CALLS edges by sourceLine
  const callOrderMap = computeCallOrder(edges);

  // Edges — carry direction for colour styling + call order
  for (const e of edges) {
    const edgeKey = `${e.sourceId}→${e.targetId}→${e.typeRelation}`;
    const order = callOrderMap.get(edgeKey);
    edgeElements.push({
      group: "edges",
      data: {
        id: edgeKey,
        source: e.sourceId,
        target: e.targetId,
        typeRelation: e.typeRelation,
        // Use numeric 1/0 so Cytoscape [?isCyclic] truthy selector works correctly
        // (the string "false" is truthy, which styled every edge as cyclic/red)
        isCyclic: e.isCyclic ? 1 : 0,
        direction: e.direction,
        // Call order label (1-based) — only set for CALLS edges
        ...(order !== undefined && { callOrder: order }),
      },
    });
  }

  return { nodeElements, edgeElements };
}

// ---------------------------------------------------------------------------
// Helper: force Cytoscape to fully repaint after a layout
// ---------------------------------------------------------------------------

/**
 * A zero-delta pan is the lightest operation that triggers Cytoscape's full
 * canvas repaint path (same code path as a real user pan).  This ensures
 * edges rendered with z-index-compare:manual appear above compound fills
 * on the very first frame after a layout completes.
 */
function triggerCanvasRepaint(cy: cytoscape.Core): void {
  requestAnimationFrame(() => {
    cy.panBy({ x: 0, y: 0 });
    cy.forceRender();
  });
}

// ---------------------------------------------------------------------------
// Theme detection — VS Code adds class to <body>: vscode-dark, vscode-light,
// vscode-high-contrast, vscode-high-contrast-light
// ---------------------------------------------------------------------------

function detectIsDarkTheme(): boolean {
  return !document.body.classList.contains("vscode-light") &&
         !document.body.classList.contains("vscode-high-contrast-light");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CytoscapeGraphProps {
  /** Called when Cytoscape has finished rendering the first layout */
  onReady?: (nodeCount: number, edgeCount: number) => void;
  /** Post a message to the VS Code extension.
   *  When embedded in the main webview (App.tsx), pass `vscode.postMessage`.
   *  When used standalone (callgraph/index.tsx) this falls back to the local API. */
  postMessage?: (message: unknown) => void;
}

/**
 * Full-height Cytoscape graph container for the live call graph webview.
 */
export function CytoscapeGraph({ onReady, postMessage }: Readonly<CytoscapeGraphProps>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Resolved postMessage function: prefer the prop, fall back to local acquireVsCodeApi
  const postMessageFn = useCallback(
    (msg: unknown): void => {
      if (postMessage) {
        postMessage(msg);
      } else {
        getVsCodeApi()?.postMessage(msg);
      }
    },
    [postMessage],
  );

  // Keep latest postMessageFn in a ref so event-handler closures use the current version
  const postMessageRef = useRef(postMessageFn);
  postMessageRef.current = postMessageFn;

  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Analyzing…");
  const [isEmpty, setIsEmpty] = useState(false);

  // T027 — filter legend state
  const [hiddenFilters, setHiddenFilters] = useState<Set<string>>(new Set());
  const [graphNodeTypes, setGraphNodeTypes] = useState<SymbolType[]>([]);
  const [graphFolders, setGraphFolders] = useState<string[]>([]);
  const hiddenFiltersRef = useRef<Set<string>>(new Set());

  // Depth slider state — synchronised with extension on each showCallGraph message
  const [currentDepth, setCurrentDepth] = useState(1);

  // Keep latest onReady in a ref to avoid stale closure in the effect
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Track the pending layout setTimeout so it can be cancelled when a new
  // showCallGraph arrives before the previous one has run layout.run().
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Safety timeout ref: clears isLoading if layoutstop never fires (e.g. on
  // certain Cytoscape edge cases or rapid component teardown).
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Initialize / destroy Cytoscape instance
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: buildCallGraphStylesheet(detectIsDarkTheme()),
      layout: { name: "preset" },
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 5,
    });

    cyRef.current = cy;

    // T036: ensure nodes are always draggable (compound graphs can unset this)
    cy.autoungrabify(false);
    cy.autounselectify(false);

    // T038: Node click → (a) open source file AND (b) recenter graph on clicked symbol
    cy.on("tap", "node[type != 'compound']", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const cmd: CallGraphSymbolFocusCommand = {
        command: "callGraphSymbolFocus",
        nodeId: node.data("id") as string,
        path: node.data("path") as string,
        startLine: node.data("startLine") as number,
        startCol: node.data("startCol") as number,
      };
      try {
        postMessageRef.current(cmd);
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    // File-compound click → open file (no graph recenter)
    cy.on("tap", "node[compoundLevel = 'file']", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const filePath = node.id();
      try {
        postMessageRef.current({ command: "callGraphOpenFile", uri: filePath, line: 0, character: 0 });
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    // Auto-resize + auto-center when the webview panel is resized.
    // cy.resize() recalculates internal canvas dimensions; cy.fit() re-centers.
    // Debounced at 120 ms so we don't thrash during a live drag-resize.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = (): void => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!cyRef.current) return;
        cyRef.current.resize();
        cyRef.current.fit(undefined, 60);
        triggerCanvasRepaint(cyRef.current);
        resizeTimer = null;
      }, 120);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleResize);

    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    // Fallback for environments where ResizeObserver is unavailable
    window.addEventListener("resize", handleResize);

    // Theme change detection — VS Code mutates body.className when the user
    // switches color themes.  Re-apply the Cytoscape stylesheet so text/edge
    // colors adapt to the new theme without a full reload.
    let lastIsDark = detectIsDarkTheme();
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            const nowDark = detectIsDarkTheme();
            if (nowDark !== lastIsDark) {
              lastIsDark = nowDark;
              if (cyRef.current) {
                cyRef.current
                  .style()
                  .fromJson(buildCallGraphStylesheet(nowDark))
                  .update();
                triggerCanvasRepaint(cyRef.current);
              }
            }
          });
    themeObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (layoutTimerRef.current !== null) {
        clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = null;
      }
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      cy.destroy();
      cyRef.current = null;
    };
    // Intentionally empty deps — run once on mount/unmount
  }, []);

  // ---------------------------------------------------------------------------
  // Listen for messages from the extension
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleMessage(event: MessageEvent<CallGraphExtensionMessage>): void {
      // VS Code extension messages arrive from the webview's own vscode-webview://
      // origin. Reject messages from any other origin to satisfy the SonarQube
      // S2819 rule while remaining functional in the webview sandbox.
      if (event.origin && !event.origin.startsWith("vscode-webview://") && event.origin !== "null") {
        return;
      }
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;

      if (msg.type === "callGraphIndexing") {
        if (msg.status === "started" || msg.status === "progress") {
          setIsLoading(true);
          setIsEmpty(false);
          setLoadingMessage(msg.message ?? "Analyzing…");
        } else if (msg.status === "complete" || msg.status === "error") {
          setIsLoading(false);
          if (msg.status === "error") {
            setLoadingMessage(msg.message ?? "Error occurred");
          }
        }
        return;
      }

      if (msg.type === "showCallGraph") {
        handleShowCallGraph(msg);
      }
    }

    window.addEventListener("message", handleMessage);

    // Signal to the extension that the message listener is now active.
    // The extension may have already posted showCallGraph data before this listener
    // was registered (race on first open). Sending callGraphMounted lets the extension
    // replay any buffered pendingGraph data so nothing is lost.
    const mountedCmd: CallGraphMountedCommand = { command: "callGraphMounted" };
    try {
      postMessageRef.current(mountedCmd);
    } catch {
      // postMessage not available outside webview (e.g., unit tests)
    }

    return () => window.removeEventListener("message", handleMessage);
  }, []);

  function handleShowCallGraph(msg: ShowCallGraphMessage): void {
    const cy = cyRef.current;
    if (!cy) return;

    if (msg.nodes.length === 0) {
      setIsLoading(false);
      setIsEmpty(true);
      cy.elements().remove();
      setGraphNodeTypes([]);
      setGraphFolders([]);
      return;
    }

    setIsEmpty(false);

    // Sync depth from extension
    if (msg.depth !== undefined) {
      setCurrentDepth(msg.depth);
    }

    // Add nodes/compounds first (batch), then edges outside the batch so they
    // render on top of compound backgrounds (fixes invisible-edges-on-first-open).
    const { nodeElements, edgeElements } = buildElements(msg.nodes, msg.edges, msg.compounds);
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodeElements);
    });
    cy.add(edgeElements);

    // Do NOT call ungrabify() on compound nodes — cy.autoungrabify(false) (set
    // at init) ensures all nodes including compounds are grabifiable so users
    // can freely move both individual symbols and entire file/folder groups.
    cy.resize();

    // Extract unique nodeTypes and folders for legend (T027)
    const types = [...new Set(msg.nodes.map((n) => n.type))];
    const folders = msg.compounds
      .filter((c) => c.compoundLevel === "folder")
      .map((c) => c.id);
    setGraphNodeTypes(types);
    setGraphFolders(folders);
    hiddenFiltersRef.current = new Set();
    setHiddenFilters(new Set());

    // Cancel any layout timer still pending from a previous showCallGraph
    // to avoid running two layouts on the same graph data.
    if (layoutTimerRef.current !== null) {
      clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
    }
    // Cancel any safety timer from a previous layout cycle.
    if (safetyTimerRef.current !== null) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }

    // Show a "Calculating layout…" overlay while fcose runs.
    // fcose is synchronous and blocks the entire browser thread for several
    // seconds on large graphs — setting isLoading=true here and deferring
    // layout.run() one frame lets React paint the overlay BEFORE fcose blocks.
    setIsLoading(true);
    setLoadingMessage("Calculating layout…");

    const layout = cy.layout({
      name: "fcose",
      animate: false,
      randomize: true,
      quality: "default",
      nodeSeparation: 220,
      idealEdgeLength: 220,
      edgeElasticity: () => 0.45,
      gravity: 0.15,
      gravityCompound: 1.5,
      gravityRange: 3.8,
      numIter: 2500,
      packComponents: true,
      tilingPaddingVertical: 60,
      tilingPaddingHorizontal: 60,
    } as cytoscape.LayoutOptions);

    // Safety net: if layoutstop never fires (e.g. destroyed Cytoscape instance
    // or rapid component teardown while layout timer is pending), clear the
    // loading overlay after 15 s to avoid permanently blocking interaction.
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      setIsLoading(false);
    }, 15000);

    // Register layoutstop BEFORE running to avoid missing the event on fast graphs.
    layout.on("layoutstop", () => {
      // Disarm the safety net — layoutstop fired normally.
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }

      cy.fit(undefined, 60);
      cy.style().update();
      triggerCanvasRepaint(cy);

      // Clear loading overlay now that the layout (and canvas repaint) is complete.
      setIsLoading(false);

      // Safety retry: if the container was still sizing during the layout run
      // (VS Code sidebar animation), a deferred resize + fit corrects it.
      setTimeout(() => {
        if (!cyRef.current) return;
        cyRef.current.resize();
        cyRef.current.fit(undefined, 60);
        triggerCanvasRepaint(cyRef.current);
      }, 500);

      const nodeCount = cy.nodes().not("[type='compound']").length;
      const edgeCount = cy.edges().length;

      onReadyRef.current?.(nodeCount, edgeCount);

      const readyCmd: CallGraphReadyCommand = {
        command: "callGraphReady",
        nodeCount,
        edgeCount,
      };
      try {
        postMessageFn(readyCmd);
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    // Defer layout.run() by one frame so React can paint the loading overlay
    // before fcose monopolises the thread.
    layoutTimerRef.current = setTimeout(() => {
      layoutTimerRef.current = null;
      layout.run();
    }, 20);
  }

  // ---------------------------------------------------------------------------
  // T027 — filter toggle handler
  // ---------------------------------------------------------------------------

  const handleFilterToggle = useCallback(
    (filterType: "nodeType" | "folder" | "edgeType", value: string, visible: boolean): void => {
      const key = `${filterType}:${value}`;
      const next = new Set(hiddenFiltersRef.current);
      if (visible) {
        next.delete(key);
      } else {
        next.add(key);
      }
      hiddenFiltersRef.current = next;
      setHiddenFilters(new Set(next)); // trigger re-render

      // Apply visibility to Cytoscape elements (no layout recalculation — FR-014)
      const cy = cyRef.current;
      if (!cy) return;

      // Restore all elements first, then re-hide filtered ones
      cy.elements().removeStyle("display");
      for (const filterKey of next) {
        const colonIdx = filterKey.indexOf(":");
        const filterType = filterKey.slice(0, colonIdx);
        const filterValue = filterKey.slice(colonIdx + 1);
        if (filterType === "nodeType") {
          cy.nodes(`[type="${filterValue}"]`).style("display", "none");
        } else if (filterType === "folder") {
          const folderNode = cy.getElementById(filterValue);
          // Hide the folder compound and ALL nested elements (file compounds + symbol nodes)
          folderNode.style("display", "none");
          folderNode.descendants().style("display", "none");
        } else if (filterType === "edgeType") {
          // Map edge filter keys to Cytoscape selectors
          const edgeSelectors: Record<string, string> = {
            outgoing: 'edge[typeRelation="CALLS"][direction="outgoing"]',
            incoming: 'edge[typeRelation="CALLS"][direction="incoming"]',
            lateral: 'edge[direction="lateral"]',
            inherits: 'edge[typeRelation="INHERITS"]',
            implements: 'edge[typeRelation="IMPLEMENTS"]',
            uses: 'edge[typeRelation="USES"]',
            cycle: "edge[isCyclic=1]",
          };
          const selector = edgeSelectors[filterValue];
          if (selector) {
            cy.elements(selector).style("display", "none");
          }
        }
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Cytoscape container */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
        data-testid="cytoscape-container"
      />

      {/* Depth slider */}
      {!isLoading && !isEmpty && (
        <div
          style={{
            position: "absolute",
            top: "12px",
            left: "12px",
            background: "var(--vscode-sideBar-background, rgba(30,30,30,0.85))",
            border: "1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))",
            borderRadius: "6px",
            padding: "6px 10px",
            fontSize: "11px",
            color: "var(--vscode-foreground, #ccc)",
            zIndex: 20,
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            userSelect: "none" as const,
          }}
          data-testid="depth-slider"
        >
          <label
            htmlFor="depth-range"
            style={{
              fontWeight: 600,
              fontSize: "10px",
              textTransform: "uppercase" as const,
              letterSpacing: "0.06em",
              color: "var(--vscode-descriptionForeground, #888)",
              whiteSpace: "nowrap" as const,
            }}
          >
            Depth
          </label>
          <input
            id="depth-range"
            type="range"
            min={1}
            max={5}
            value={currentDepth}
            onChange={(e) => {
              const d = Number(e.target.value);
              setCurrentDepth(d);
              const cmd: CallGraphDepthChangedCommand = { command: "callGraphDepthChanged", depth: d };
              try { postMessageRef.current(cmd); } catch { /* no-op */ }
            }}
            style={{ width: "80px", cursor: "pointer" }}
            aria-label="Traversal depth"
          />
          <span style={{ minWidth: "12px", textAlign: "center" }}>{currentDepth}</span>
        </div>
      )}

      {/* T027: Filter legend */}
      {!isLoading && !isEmpty && (
        <GraphLegend
          nodeTypes={graphNodeTypes}
          folders={graphFolders}
          hiddenFilters={hiddenFilters}
          onToggle={handleFilterToggle}
        />
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
            color: "var(--vscode-foreground, #ccc)",
            fontSize: "14px",
            zIndex: 10,
          }}
          data-testid="loading-overlay"
        >
          <span>{loadingMessage}</span>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && !isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--vscode-descriptionForeground, #888)",
            fontSize: "13px",
          }}
          data-testid="empty-state"
        >
          <span>No relationships found for this symbol.</span>
        </div>
      )}
    </div>
  );
}
