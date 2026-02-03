import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Edge,
  Node,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "reactflow";
// @ts-expect-error - ReactFlow types are complex
import reactFlowStyles from "reactflow/dist/style.css";
import { getLogger } from "../../shared/logger";
import { GraphData, SymbolDependency, SymbolInfo } from "../../shared/types";
import {
  createDebouncedRafScheduler,
  createSizePoller,
} from "../utils/fitViewScheduler";
import { computeRelatedNodes } from "../utils/graphTraversal";
import { normalizePath } from "../utils/path";
import { buildReactFlowGraph, GRAPH_LIMITS } from "./reactflow/buildGraph";
import {
  ExpansionOverlay,
  type ExpansionState,
} from "./reactflow/ExpansionOverlay";
import { FileNode } from "./reactflow/FileNode";
import { SymbolNode } from "./reactflow/SymbolNode";

/** Logger instance for ReactFlowGraph */
const log = getLogger("ReactFlowGraph");

/** Layout type for graph visualization */
type LayoutType = "hierarchical" | "force" | "radial";

// Inject React Flow CSS
if (
  typeof document !== "undefined" &&
  !document.getElementById("reactflow-styles")
) {
  const style = document.createElement("style");
  style.id = "reactflow-styles";
  style.textContent = reactFlowStyles;
  document.head.appendChild(style);
}

// Lightweight spinner animation for expansion overlay
if (
  typeof document !== "undefined" &&
  !document.getElementById("gil-spin-style")
) {
  const spin = document.createElement("style");
  spin.id = "gil-spin-style";
  spin.textContent = `
        @keyframes gil-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
    `;
  document.head.appendChild(spin);
}

interface ReactFlowGraphProps {
  data: GraphData;
  currentFilePath: string;
  onNodeClick: (path: string, line?: number) => void;
  onDrillDown: (path: string) => void;
  onFindReferences: (path: string) => void;
  onExpandNode?: (path: string) => void;
  autoExpandNodeId?: string | null;
  expandAll: boolean;
  onExpandAllChange: (expand: boolean) => void;
  onRefresh?: () => void;
  onSwitchToSymbol?: () => void;
  onSwitchToListView?: () => void;
  // Toggle to show/hide parent referencing files for the current root
  showParents?: boolean;
  onToggleParents?: (path: string) => void;
  expansionState?: ExpansionState | null;
  onCancelExpand?: (nodeId?: string) => void;
  resetToken?: number;
  unusedDependencyMode?: "none" | "hide" | "dim";
  /** Whether the unused dependency filter is active (from backend state) */
  filterUnused?: boolean;
  mode?: "file" | "symbol";
  symbolData?: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  onLayoutChange?: (layout: LayoutType) => void;
  layout?: LayoutType;
  selectedNodeId?: string | null;
  /** Callback for symbol highlight on double-click */
  onHighlight?: (symbolId: string) => void;
}

function stableGlobal<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[key]) return g[key] as T;
  const value = factory();
  g[key] = value;
  return value;
}

const PRO_OPTIONS = stableGlobal("__graphItLive_proOptions", () =>
  Object.freeze({ hideAttribution: true } as const),
);

function useExpandedNodes(params: {
  expandAll: boolean;
  currentFilePath: string;
  edges: GraphData["edges"] | undefined;
  autoExpandNodeId: string | null | undefined;
  onExpandNode?: (path: string) => void;
  resetToken?: number;
}) {
  const {
    expandAll,
    currentFilePath,
    edges,
    autoExpandNodeId,
    onExpandNode,
    resetToken,
  } = params;

  // Track the last values to detect ACTUAL changes (not re-renders)
  const lastExpandAllRef = React.useRef<boolean>(expandAll);
  const lastResetTokenRef = React.useRef<number | undefined>(resetToken);

  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Effect ONLY for navigation resets (resetToken or currentFilePath changes)
  // This resets expandedNodes according to expandAll state at time of navigation
  useEffect(() => {
    log.debug("useExpandedNodes: Navigation effect", {
      resetToken,
      currentFilePath,
      expandAll,
      edgesCount: edges?.length,
    });

    lastResetTokenRef.current = resetToken;

    if (expandAll && edges && edges.length > 0) {
      // Expand ALL nodes with children
      const allNodesWithChildren = new Set<string>();
      edges.forEach((edge) => {
        allNodesWithChildren.add(edge.source);
      });
      log.debug("Navigation: Expanding all nodes", {
        size: allNodesWithChildren.size,
      });
      setExpandedNodes(allNodesWithChildren);
    } else {
      // Reset to root only
      const rootSet = currentFilePath
        ? new Set([normalizePath(currentFilePath)])
        : new Set<string>();
      log.debug("Navigation: Resetting to root", { rootSize: rootSet.size });
      setExpandedNodes(rootSet);
    }
  }, [resetToken, currentFilePath]); // CRITICAL: Only navigation triggers, NOT expandAll or edges!

  // Separate effect ONLY for expandAll button changes
  // This allows manual node toggling to work independently
  useEffect(() => {
    // Only react when expandAll ACTUALLY changes (not on every render)
    if (expandAll === lastExpandAllRef.current) {
      return; // No change, skip
    }

    log.debug("useExpandedNodes: expandAll changed", {
      from: lastExpandAllRef.current,
      to: expandAll,
      edgesCount: edges?.length,
    });

    lastExpandAllRef.current = expandAll;

    if (expandAll && edges && edges.length > 0) {
      // Expand ALL nodes with children
      const allNodesWithChildren = new Set<string>();
      edges.forEach((edge) => {
        allNodesWithChildren.add(edge.source);
      });
      log.debug("ExpandAll: Expanding all nodes", {
        size: allNodesWithChildren.size,
      });
      setExpandedNodes(allNodesWithChildren);
    } else if (!expandAll) {
      // Collapse all - keep only root
      const rootSet = currentFilePath
        ? new Set([normalizePath(currentFilePath)])
        : new Set<string>();
      log.debug("ExpandAll: Collapsing to root", { rootSize: rootSet.size });
      setExpandedNodes(rootSet);
    }
  }, [expandAll]); // CRITICAL: Only expandAll changes, NOT edges!

  // Auto-expand specific node (typically after expansion request)
  useEffect(() => {
    if (!autoExpandNodeId) return;
    const normalized = normalizePath(autoExpandNodeId);

    // Use callback form to ensure atomic update
    setExpandedNodes((prev) => {
      if (prev.has(normalized)) return prev; // Already expanded, no change
      const next = new Set(prev);
      next.add(normalized);
      return next;
    });
  }, [autoExpandNodeId]);

  // Toggle expanded state for a node (collapse if expanded, expand if collapsed)
  const toggleExpandedNode = useCallback((path: string) => {
    const normalized = normalizePath(path); // CRITICAL: Always normalize before Set operations
    log.debug("👆 toggleExpandedNode called", { path, normalized });
    setExpandedNodes((prev) => {
      const prevArray = Array.from(prev);
      const had = prev.has(normalized);
      log.debug("👆 toggleExpandedNode: BEFORE", {
        had,
        prevSize: prev.size,
        normalized,
        prevContents: prevArray,
      });
      const next = new Set(prev);
      if (had) {
        next.delete(normalized);
        log.debug("👆 toggleExpandedNode: DELETED", {
          normalized,
          newSize: next.size,
        });
      } else {
        next.add(normalized);
        log.debug("👆 toggleExpandedNode: ADDED", {
          normalized,
          newSize: next.size,
        });
      }
      const nextArray = Array.from(next);
      log.debug("👆 toggleExpandedNode: AFTER", {
        nextSize: next.size,
        nextContents: nextArray,
      });
      // Always return new Set since we're toggling (content definitely changed)
      return next;
    });
  }, []);

  // Store callback in ref to avoid re-render cascade (per copilot-instructions.md)
  const onExpandNodeRef = React.useRef(onExpandNode);
  React.useEffect(() => {
    onExpandNodeRef.current = onExpandNode;
  }, [onExpandNode]);

  // Request expansion of a node (always adds to expanded set)
  const handleExpandRequest = useCallback(
    (path: string) => {
      const normalized = normalizePath(path);

      // Notify parent component first via ref
      onExpandNodeRef.current?.(normalized);

      // Then update local state atomically
      setExpandedNodes((prev) => {
        if (prev.has(normalized)) return prev; // Already expanded
        const next = new Set(prev);
        next.add(normalized);
        return next;
      });
    },
    [], // No callback in deps - prevents re-render cascade
  );

  return { expandedNodes, toggleExpandedNode, handleExpandRequest };
}

function useAutoFitView(params: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodesInitialized: boolean;
  nodeCount: number;
  fitView: (options?: { padding?: number; duration?: number }) => void;
}) {
  const { containerRef, nodesInitialized, nodeCount, fitView } = params;

  useEffect(() => {
    if (!nodesInitialized || nodeCount === 0) return;
    const timeoutId = setTimeout(
      () => fitView({ padding: 0.2, duration: 500 }),
      100,
    );
    return () => clearTimeout(timeoutId);
  }, [nodesInitialized, nodeCount, fitView]);

  useEffect(() => {
    if (!nodesInitialized || nodeCount === 0) return;
    const element = containerRef.current;
    if (!element) return;

    const scheduler = createDebouncedRafScheduler(
      () => fitView({ padding: 0.2, duration: 200 }),
      60,
    );

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduler.trigger);
    const poller = createSizePoller(
      () => {
        const rect = element.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      },
      scheduler.trigger,
      250,
    );

    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduler.trigger);

    poller.start();
    scheduler.trigger();

    return () => {
      window.removeEventListener("resize", scheduler.trigger);
      resizeObserver?.disconnect();
      poller.dispose();
      scheduler.dispose();
    };
  }, [nodesInitialized, nodeCount, fitView, containerRef]);
}

// Inner component that uses ReactFlow hooks
const ReactFlowGraphContent: React.FC<ReactFlowGraphProps> = ({
  data,
  currentFilePath,
  onNodeClick,
  onDrillDown,
  onHighlight,
  onFindReferences,
  onExpandNode,
  autoExpandNodeId,
  expandAll,
  onExpandAllChange,
  onRefresh,
  onSwitchToSymbol,
  onSwitchToListView,
  showParents = false,
  onToggleParents,
  expansionState,
  onCancelExpand,
  resetToken,
  unusedDependencyMode = "none",
  filterUnused: backendFilterUnused,
  mode = "file",
  symbolData,
  onLayoutChange,
  layout = "hierarchical",
  selectedNodeId,
}) => {
  // Use backendFilterUnused directly - no local state to avoid stale closures
  const filterUnused = backendFilterUnused ?? false;

  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  
  // T080: Track previous graph state for diffing
  const prevGraphRef = React.useRef<{ nodeIds: Set<string>; edgeIds: Set<string>; mode?: string } | null>(null);
  
  // T081: Track loading/reanalyzing state
  const [isReanalyzing, setIsReanalyzing] = React.useState(false);
  
  // Étape 4: Highlight state for symbol graph double-click
  const [highlightState, setHighlightState] = React.useState<{
    highlightedNodes: Set<string>;
    highlightedEdges: Set<string>;
  } | null>(null);
  
  const nodeTypes = useMemo(
    () => Object.freeze({ file: FileNode, symbol: SymbolNode } as const),
    [],
  );
  const { expandedNodes, toggleExpandedNode, handleExpandRequest } =
    useExpandedNodes({
      expandAll,
      currentFilePath,
      edges: data?.edges,
      autoExpandNodeId,
      onExpandNode,
      resetToken,
    });

  // Initialize React Flow states early
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Store graph data in ref so handleHighlight can access the complete graph
  const graphDataRef = React.useRef<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });

  // Étape 4: Handler for symbol highlight on double-click
  // Uses graphDataRef to access complete graph data for BFS calculation
  const handleHighlight = useCallback((symbolId: string) => {
    log.debug('[ReactFlowGraph] handleHighlight CALLED', { symbolId, mode });
    if (mode !== "symbol" || !graphDataRef.current.nodes.length) {
      log.debug('[ReactFlowGraph] handleHighlight ABORT - wrong mode or no nodes', { mode, nodeCount: graphDataRef.current.nodes.length });
      return;
    }
    
    log.debug('[ReactFlowGraph] Computing highlight for symbol', { 
      symbolId,
      totalNodes: graphDataRef.current.nodes.length,
      totalEdges: graphDataRef.current.edges.length,
    });
    log.debug("ReactFlowGraph: Computing highlight for symbol", { 
      symbolId,
      totalNodes: graphDataRef.current.nodes.length,
      totalEdges: graphDataRef.current.edges.length,
    });
    
    // Use complete graph data from ref, not filtered state
    const relatedNodes = computeRelatedNodes(
      symbolId, 
      graphDataRef.current.nodes, 
      graphDataRef.current.edges
    );
    
    log.debug('[ReactFlowGraph] Highlight computed', {
      highlightedNodes: relatedNodes.highlightedNodes.size,
      highlightedEdges: relatedNodes.highlightedEdges.size,
      nodesList: Array.from(relatedNodes.highlightedNodes),
    });
    log.debug("ReactFlowGraph: Highlight computed", {
      highlightedNodes: relatedNodes.highlightedNodes.size,
      highlightedEdges: relatedNodes.highlightedEdges.size,
    });
    
    log.debug('[ReactFlowGraph] Setting highlightState...');
    setHighlightState(relatedNodes);
    log.debug('[ReactFlowGraph] highlightState set!');
    
    // Call parent's onHighlight callback if provided (for logging/tracking)
    if (onHighlight) {
      onHighlight(symbolId);
    }
  }, [mode, onHighlight]);

  // Use refs for callbacks to avoid including them in useMemo deps
  // This prevents constant re-renders when parent component recreates callbacks
  const callbacksRef = React.useRef<{
    onNodeClick: (path: string, line?: number) => void;
    onDrillDown: (path: string) => void;
    onFindReferences: (path: string) => void;
    onToggleParents?: (path: string) => void;
    onToggle: (path: string) => void;
    onExpandRequest: (path: string) => void;
    onHighlight?: (symbolId: string) => void;
  }>({
    onNodeClick,
    onDrillDown,
    onFindReferences,
    onToggleParents,
    onToggle: toggleExpandedNode,
    onExpandRequest: handleExpandRequest,
    onHighlight: handleHighlight,
  });

  // Update ref on every render so buildGraph always uses latest callbacks
  callbacksRef.current = {
    onNodeClick,
    onDrillDown,
    onFindReferences,
    onToggleParents,
    onToggle: toggleExpandedNode,
    onExpandRequest: handleExpandRequest,
    onHighlight: handleHighlight,
  };

  const graph = useMemo(() => {
    const expandedArray = Array.from(expandedNodes);
    log.debug("🏗️ ReactFlowGraph: build graph START", {
      nodes: data?.nodes?.length || 0,
      edges: data?.edges?.length || 0,
      currentFilePath,
      expandedNodesSize: expandedNodes.size,
      expandedNodesList: expandedArray,
      showParents,
      expandAll,
    });
    const result = buildReactFlowGraph({
      data,
      currentFilePath,
      expandAll,
      expandedNodes,
      showParents,
      callbacks: callbacksRef.current,
      unusedEdges: data?.unusedEdges,
      unusedDependencyMode,
      filterUnused,
      mode,
      symbolData,
      layout,
      selectedNodeId,
      highlightState, // Étape 4
    });
    log.debug("🏗️ ReactFlowGraph: build graph END", {
      resultNodes: result.nodes.length,
      resultEdges: result.edges.length,
      nodesTruncated: result.nodesTruncated,
    });
    
    // Update graphDataRef with complete graph data for handleHighlight
    graphDataRef.current = {
      nodes: result.nodes,
      edges: result.edges,
    };
    
    return result;
  }, [
    data,
    currentFilePath,
    expandAll,
    expandedNodes,
    showParents,
    unusedDependencyMode,
    filterUnused,
    // DO NOT include callbacks in deps! They don't change graph structure,
    // only node data handlers. Including them causes constant re-renders.
    mode,
    symbolData,
    layout,
    selectedNodeId,
    highlightState, // Étape 4
  ]);

  const isTruncated = graph.nodesTruncated;

  // Process edges to apply unused dependency filtering/styling
  const processedEdges = useMemo(() => {
    log.debug("ReactFlowGraph: processedEdges useMemo triggered", {
      filterUnused,
      unusedDependencyMode,
      unusedEdgesCount: data?.unusedEdges?.length,
      hasUnusedEdges: !!data?.unusedEdges?.length,
      graphEdgesCount: graph.edges.length,
    });

    let edges = graph.edges;

    // Apply unused filtering first
    if (
      filterUnused &&
      unusedDependencyMode !== "none" &&
      data?.unusedEdges?.length
    ) {
      const unusedEdgeSet = new Set(data.unusedEdges);

      if (unusedDependencyMode === "hide") {
        log.debug("ReactFlowGraph: Filtering out unused edges (hide mode)");
        edges = edges.filter((edge) => !unusedEdgeSet.has(edge.id));
      } else if (unusedDependencyMode === "dim") {
        log.debug("ReactFlowGraph: Dimming unused edges (dim mode)");
        edges = edges.map((edge) => {
          if (unusedEdgeSet.has(edge.id)) {
            return {
              ...edge,
              style: { ...edge.style, opacity: 0.2, strokeDasharray: "5 5" },
              animated: false,
              label: "unused",
              labelStyle: {
                fill: "var(--vscode-descriptionForeground)",
                opacity: 0.5,
              },
              labelBgStyle: { fill: "transparent" },
            };
          }
          return edge;
        });
      }
    }

    // Apply recursive edge styling (self-loops) - only in symbol mode
    if (mode === "symbol") {
      edges = edges.map((edge) => {
        if (edge.source === edge.target) {
          // Recursive call (self-loop)
          return {
            ...edge,
            style: {
              ...edge.style,
              stroke: "#FF6B6B", // Red color for recursion
              strokeWidth: 3,
            },
            animated: true,
            label: "🔄 récursif",
            labelStyle: {
              fill: "#FF6B6B",
              fontWeight: "bold",
            },
            labelBgStyle: {
              fill: "var(--vscode-editor-background)",
              fillOpacity: 0.8,
            },
          };
        }
        return edge;
      });
    }

    return edges;
  }, [graph.edges, data?.unusedEdges, unusedDependencyMode, filterUnused, mode]);

  // Étape 5: Style edges based on direction (outgoing vs incoming) and highlight state
  const styledEdges = useMemo(() => {
    let edges = processedEdges;
    
    // If highlight is active, filter edges to show only highlighted ones
    if (highlightState && highlightState.highlightedEdges.size > 0) {
      log.debug("ReactFlowGraph: Filtering and styling highlighted edges", {
        highlightedEdgesCount: highlightState.highlightedEdges.size,
        totalEdges: processedEdges.length,
      });
      
      // Filter to only show highlighted edges
      edges = processedEdges.filter((edge) =>
        highlightState.highlightedEdges.has(edge.id)
      );
    }
    
    return edges.map((edge) => {
      // Check if edge has direction metadata
      const edgeData = edge as any; // Cast to access direction property
      
      // Recursive edges keep their red styling from processedEdges
      if (edge.source === edge.target) {
        return edge; // Already styled in processedEdges
      }
      
      // Apply highlight styles if this edge is highlighted
      if (highlightState && highlightState.highlightedEdges.has(edge.id)) {
        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: "var(--vscode-textLink-foreground)",
            strokeWidth: 2.5,
          },
          animated: true,
        };
      }
      
      if (edgeData.direction === 'incoming') {
        // Incoming calls: green dashed
        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: '#10b981', // Green
            strokeDasharray: '5,5',
          },
        };
      } else if (edgeData.direction === 'outgoing') {
        // Outgoing calls: blue solid
        return {
          ...edge,
          style: {
            ...edge.style,
            stroke: '#3b82f6', // Blue
          },
        };
      }
      // Default: no special styling (for file-level edges)
      return edge;
    });
  }, [processedEdges, highlightState]);

  // Filter nodes based on highlight state
  const visibleNodes = useMemo(() => {
    log.debug('[ReactFlowGraph] visibleNodes useMemo TRIGGERED', {
      hasHighlight: !!highlightState,
      highlightedCount: highlightState?.highlightedNodes.size,
      totalNodes: graph.nodes.length,
    });
    
    if (highlightState && highlightState.highlightedNodes.size > 0) {
      log.debug('[ReactFlowGraph] FILTERING nodes to highlighted only');
      log.debug("ReactFlowGraph: Filtering nodes to highlighted only", {
        highlightedNodesCount: highlightState.highlightedNodes.size,
        totalNodes: graph.nodes.length,
      });
      const filtered = graph.nodes.filter((node) =>
        highlightState.highlightedNodes.has(node.id)
      );
      log.debug('[ReactFlowGraph] Filtered result', {
        before: graph.nodes.length,
        after: filtered.length,
        filteredIds: filtered.map(n => n.id),
      });
      return filtered;
    }
    log.debug('[ReactFlowGraph] NO FILTERING - returning all nodes');
    return graph.nodes;
  }, [graph.nodes, highlightState]);

  // Use useLayoutEffect for highlight - runs synchronously AFTER useMemo recalculates
  // This ensures we see the updated visibleNodes/styledEdges values
  React.useLayoutEffect(() => {
    if (!highlightState || highlightState.highlightedNodes.size === 0) {
      log.debug('[ReactFlowGraph] Highlight useLayoutEffect - no highlight, skipping');
      return;
    }
    
    log.debug('[ReactFlowGraph] Highlight useLayoutEffect APPLYING FILTER', {
      highlightedNodes: highlightState.highlightedNodes.size,
      highlightedEdges: highlightState.highlightedEdges.size,
      visibleNodesCount: visibleNodes.length,
      styledEdgesCount: styledEdges.length,
    });
    
    log.debug("ReactFlowGraph: Applying highlight filter", {
      highlightedNodes: highlightState.highlightedNodes.size,
      highlightedEdges: highlightState.highlightedEdges.size,
    });
    
    log.debug('[ReactFlowGraph] Setting', visibleNodes.length, 'visible nodes');
    setNodes(visibleNodes);
    setEdges(styledEdges);
    
    // Update prevGraphRef to prevent false change detection
    prevGraphRef.current = {
      nodeIds: new Set(visibleNodes.map(n => n.id)),
      edgeIds: new Set(styledEdges.map(e => `${e.source}-${e.target}`)),
      mode: mode || 'file',
    };
  }, [highlightState, visibleNodes, styledEdges, setNodes, setEdges, mode]);

  // Sync nodes/edges when graph recalculates (but NOT when highlight is active)
  // T079-T080: Preserve expanded nodes and normal graph changes
  useEffect(() => {
    // Skip if highlight is active - handled by separate useEffect above
    if (highlightState && highlightState.highlightedNodes.size > 0) {
      log.debug('[ReactFlowGraph] Normal useEffect SKIPPED - highlight active');
      return;
    }
    
    log.debug('[ReactFlowGraph] Normal useEffect TRIGGERED', {
      visibleNodesCount: visibleNodes.length,
      styledEdgesCount: styledEdges.length,
    });
    log.debug("ReactFlowGraph: Syncing nodes/edges", {
      nodeCount: visibleNodes.length,
      edgeCount: styledEdges.length,
    });
    
    // T080: Graph diffing - detect changes (only when no highlight active)
    if (prevGraphRef.current) {
      const prevNodeIds = prevGraphRef.current.nodeIds;
      const newNodeIds = new Set(visibleNodes.map(n => n.id));
      
      const prevEdgeIds = prevGraphRef.current.edgeIds;
      const newEdgeIds = new Set(styledEdges.map(e => `${e.source}-${e.target}`));
      
      // Detect mode change (file ↔ symbol)
      const prevMode = prevGraphRef.current.mode;
      const currentMode = mode || 'file';
      const modeChanged = prevMode && prevMode !== currentMode;
      
      // Find added nodes/edges
      const addedNodeIds = new Set([...newNodeIds].filter(id => !prevNodeIds.has(id)));
      const addedEdgeIds = new Set([...newEdgeIds].filter(id => !prevEdgeIds.has(id)));
      
      // Only highlight if changes are incremental (< 50% of graph)
      // Avoid highlighting on:
      // - Full graph refresh or navigation
      // - Mode changes (file ↔ symbol view)
      const isIncrementalChange = 
        !modeChanged &&
        addedNodeIds.size > 0 && 
        addedNodeIds.size < newNodeIds.size * 0.5;
      
      if (isIncrementalChange || (addedEdgeIds.size > 0 && !modeChanged)) {
        log.debug('ReactFlowGraph: Detected graph changes', {
          addedNodes: addedNodeIds.size,
          addedEdges: addedEdgeIds.size,
        });
        
        // Apply highlighting to new nodes
        const highlightedNodes = addedNodeIds.size > 0
          ? visibleNodes.map(node => {
              if (addedNodeIds.has(node.id)) {
                return {
                  ...node,
                  style: {
                    ...node.style,
                    border: '2px solid #4AFF4A',
                    boxShadow: '0 0 10px rgba(74, 255, 74, 0.5)',
                  },
                };
              }
              return node;
            })
          : visibleNodes;
        
        // Apply highlighting to new edges
        const highlightedEdges = addedEdgeIds.size > 0
          ? styledEdges.map(edge => {
              const edgeId = `${edge.source}-${edge.target}`;
              if (addedEdgeIds.has(edgeId)) {
                return {
                  ...edge,
                  style: {
                    ...edge.style,
                    stroke: '#4AFF4A',
                    strokeWidth: 2,
                  },
                  animated: true,
                };
              }
              return edge;
            })
          : styledEdges;
        
        setNodes(highlightedNodes);
        setEdges(highlightedEdges);
        
        // Clear highlights after 2 seconds
        const timeoutId = setTimeout(() => {
          log.debug('ReactFlowGraph: Clearing highlights');
          setNodes(visibleNodes);
          setEdges(styledEdges);
        }, 2000);
        
        // Update previous graph state for next comparison
        prevGraphRef.current = {
          nodeIds: newNodeIds,
          edgeIds: newEdgeIds,
          mode: mode || 'file',
        };
        
        // Cleanup on unmount or new changes
        return () => clearTimeout(timeoutId);
      }
    }
    
    // Update previous graph state for next comparison
    prevGraphRef.current = {
      nodeIds: new Set(visibleNodes.map(n => n.id)),
      edgeIds: new Set(styledEdges.map(e => `${e.source}-${e.target}`)),
      mode: mode || 'file',
    };
    
    // No highlights - just set directly (only if no previous graph or no changes detected)
    setNodes(visibleNodes);
    setEdges(styledEdges);
  }, [visibleNodes, styledEdges, setNodes, setEdges, mode]);

  useAutoFitView({
    containerRef,
    nodesInitialized,
    nodeCount: nodes.length,
    fitView,
  });

  // T081: Listen for refreshing and updateGraph messages
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      
      if (message.command === 'refreshing') {
        log.debug('ReactFlowGraph: Received refreshing message');
        setIsReanalyzing(true);
      }
      
      if (message.command === 'updateGraph') {
        log.debug('ReactFlowGraph: Received updateGraph message, clearing loading state');
        setIsReanalyzing(false);
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Store callback in ref to avoid re-render cascade (per copilot-instructions.md)
  const onNodeClickRef = React.useRef(onNodeClick);
  React.useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  // Handle node click
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const line = node.data?.line;
    onNodeClickRef.current(node.id, line);
  }, []); // No callback in deps - prevents re-render cascade

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100vh", position: "relative" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        panOnDrag
        zoomOnScroll
        minZoom={0.1}
        maxZoom={2}
        fitView
        proOptions={PRO_OPTIONS}
      >
        <Background />
        <Controls />
      </ReactFlow>
      {/* T081: Loading indicator during re-analysis */}
      {isReanalyzing && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            background: 'var(--vscode-editor-background)',
            border: '1px solid var(--vscode-panel-border)',
            padding: '8px 12px',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            zIndex: 1000,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              border: '2px solid var(--vscode-progressBar-background)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'gil-spin 0.8s linear infinite',
            }}
          />
          <span style={{ color: 'var(--vscode-foreground)' }}>Updating...</span>
        </div>
      )}
      {expansionState && (
        <ExpansionOverlay state={expansionState} onCancel={onCancelExpand} />
      )}
      {isTruncated && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            zIndex: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "var(--vscode-editor-background)",
            border: "1px solid var(--vscode-widget-border)",
            color: "var(--vscode-descriptionForeground)",
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            maxWidth: 420,
          }}
        >
          Graph too large: display limited to {GRAPH_LIMITS.MAX_RENDER_NODES}{" "}
          nodes to avoid crashes.
        </div>
      )}
      {graph.edgesTruncated && (
        <div
          style={{
            position: "absolute",
            top: isTruncated ? 56 : 12,
            left: 12,
            zIndex: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "var(--vscode-editor-background)",
            border: "1px solid var(--vscode-widget-border)",
            color: "var(--vscode-descriptionForeground)",
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            maxWidth: 420,
          }}
        >
          Too many edges: rendering limited to {GRAPH_LIMITS.MAX_PROCESS_EDGES}{" "}
          edges to avoid crashes.
        </div>
      )}
      {graph.renderEdgesTruncated && (
        <div
          style={{
            position: "absolute",
            top: (isTruncated ? 56 : 12) + (graph.edgesTruncated ? 44 : 0),
            left: 12,
            zIndex: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: "var(--vscode-editor-background)",
            border: "1px solid var(--vscode-widget-border)",
            color: "var(--vscode-descriptionForeground)",
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            maxWidth: 420,
          }}
        >
          Too many visible edges: display limited to{" "}
          {GRAPH_LIMITS.MAX_RENDER_EDGES} edges.
        </div>
      )}

      {/* Top bar */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          right: 10,
          zIndex: 1000,
          display: "flex",
          justifyContent: "space-between",
          pointerEvents: "none",
        }}
      >
        {/* Left buttons */}
        <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
          {onSwitchToSymbol && (
            <button
              onClick={onSwitchToSymbol}
              title="Switch to Symbol View"
              style={{
                background: "var(--vscode-button-secondaryBackground)",
                color: "var(--vscode-button-secondaryForeground)",
                border: "none",
                borderRadius: 4,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              ✨ Symbol View
            </button>
          )}
        </div>

        {/* Right buttons */}
        <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Refresh graph from current file"
              aria-label="Refresh"
              style={{
                background: "var(--vscode-button-secondaryBackground)",
                color: "var(--vscode-button-secondaryForeground)",
                border: "1px solid var(--vscode-button-border)",
                borderRadius: 4,
                padding: "6px 8px",
                cursor: "pointer",
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ↻
            </button>
          )}
          {unusedDependencyMode !== "none" && (
            <button
              onClick={() => {
                /* Webview button not used - use toolbar button instead */
              }}
              title={`Filter Unused Imports (${unusedDependencyMode === "hide" ? "Hide" : "Dim"})`}
              style={{
                background: filterUnused
                  ? "var(--vscode-button-background)"
                  : "var(--vscode-button-secondaryBackground)",
                color: filterUnused
                  ? "var(--vscode-button-foreground)"
                  : "var(--vscode-button-secondaryForeground)",
                border: "1px solid var(--vscode-button-border)",
                borderRadius: 4,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {filterUnused ? "Used Only" : "Show All"}
            </button>
          )}
          {mode === "symbol" && (
            <div style={{ position: "relative", display: "flex" }}>
              <select
                onChange={(e) =>
                  onLayoutChange?.(
                    e.target.value as LayoutType,
                  )
                }
                style={{
                  background: "var(--vscode-button-secondaryBackground)",
                  color: "var(--vscode-button-secondaryForeground)",
                  border: "1px solid var(--vscode-button-border)",
                  borderRadius: 4,
                  padding: "6px 24px 6px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                  appearance: "none",
                  display: "flex",
                  alignItems: "center",
                }}
                defaultValue="hierarchical"
              >
                <option value="hierarchical">Hierarchy</option>
                <option value="force">Force</option>
                <option value="radial">Radial</option>
              </select>
              <div
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                  fontSize: 10,
                  color: "var(--vscode-button-secondaryForeground)",
                }}
              >
                ▼
              </div>
            </div>
          )}
          {mode === "symbol" && onSwitchToListView && (
            <button
              onClick={onSwitchToListView}
              title="Switch to List View"
              style={{
                background: "var(--vscode-button-secondaryBackground)",
                color: "var(--vscode-button-secondaryForeground)",
                border: "1px solid var(--vscode-button-border)",
                borderRadius: 4,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              List View
            </button>
          )}
          {/* Étape 4: Clear Highlight button - only show in symbol mode when highlight is active */}
          {mode === "symbol" && highlightState && (
            <button
              onClick={() => setHighlightState(null)}
              title="Clear highlight to show all nodes"
              style={{
                background: "var(--vscode-button-background)",
                color: "var(--vscode-button-foreground)",
                border: "1px solid var(--vscode-button-border)",
                borderRadius: 4,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              ✕ Clear Highlight
            </button>
          )}
          <button
            onClick={() => onExpandAllChange(!expandAll)}
            style={{
              background: "var(--vscode-button-secondaryBackground)",
              color: "var(--vscode-button-secondaryForeground)",
              border: "1px solid var(--vscode-button-border)",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {expandAll ? "⊟ Collapse All" : "⊞ Expand All"}
          </button>
          <div
            style={{
              background: "var(--vscode-editor-background)",
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid var(--vscode-widget-border)",
              fontSize: 11,
              color: "var(--vscode-descriptionForeground)",
            }}
          >
            📁 {mode === "symbol" ? "Symbol Graph" : "File Dependencies"}
          </div>
        </div>
      </div>

      {/* Legend */}
      {graph.cycles.size > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 50,
            left: "80%",
            transform: "translateX(-80%)",
            zIndex: 1000,
            background: "var(--vscode-editor-background)",
            padding: "8px 12px",
            borderRadius: 4,
            border: "1px solid var(--vscode-widget-border)",
            fontSize: 11,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#dc3545",
            }}
          />
          <span>Circular dependency ({graph.cycles.size} files)</span>
        </div>
      )}
    </div>
  );
};

// Main component wrapped with ReactFlowProvider
const ReactFlowGraph: React.FC<ReactFlowGraphProps> = (props) => {
  return (
    <ReactFlowProvider>
      <ReactFlowGraphContent {...props} />
    </ReactFlowProvider>
  );
};

export default ReactFlowGraph;
