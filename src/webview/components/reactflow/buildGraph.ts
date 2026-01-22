import type { Edge, Node } from "reactflow";
import { getLogger } from "../../../shared/logger";
import type {
  GraphData,
  SymbolDependency,
  SymbolInfo,
} from "../../../shared/types";
import {
  createEdgeStyle as createEdgeStyleUtil,
  nodeHeight,
} from "../../utils/nodeUtils";
import { normalizePath } from "../../utils/path";
import type { FileNodeData } from "./FileNode";
import type { SymbolNodeData } from "./SymbolNode";
import { detectCycles } from "./cycles";
import { calculateNodeWidth, layoutGraph } from "./layout";

/** Logger instance for buildGraph */
const log = getLogger("buildGraph");

export type UnusedDependencyMode = "none" | "hide" | "dim";

export const GRAPH_LIMITS = {
  MAX_RENDER_NODES: 400,
  MAX_CYCLE_DETECT_EDGES: 3000,
  MAX_PROCESS_EDGES: 20000,
  MAX_RENDER_EDGES: 1500,
  MAX_DAGRE_NODES: 350,
} as const;

export interface BuildGraphCallbacks {
  onDrillDown: (path: string) => void;
  onFindReferences: (path: string) => void;
  onToggleParents?: (path: string) => void;
  onToggle: (path: string) => void;
  onExpandRequest: (path: string) => void;
}

export interface BuildGraphResult {
  nodes: Node<FileNodeData | SymbolNodeData>[];
  edges: Edge[];
  cycles: Set<string>;
  edgesTruncated: boolean;
  renderEdgesTruncated: boolean;
  nodesTruncated: boolean;
}

/**
 * Filter edges to keep only those relevant to the current expansion state.
 * This ensures expand/collapse feels reliable even with huge graphs.
 */
function filterRelevantEdges(
  edges: Array<{ source: string; target: string }>,
  currentPath: string,
  expandedNodes: Set<string>,
  showParents: boolean,
  maxEdges: number,
): Array<{ source: string; target: string }> {
  const allowedSources = new Set<string>([normalizePath(currentPath)]);
  expandedNodes.forEach((n) => allowedSources.add(normalizePath(n)));

  const selected: typeof edges = [];
  for (const edge of edges) {
    const source = normalizePath(edge.source);
    const target = normalizePath(edge.target);
    if (
      allowedSources.has(source) ||
      (showParents && target === normalizePath(currentPath))
    ) {
      selected.push({ source, target });
      if (selected.length >= maxEdges) break;
    }
  }
  return selected;
}

/**
 * Configuration for edge processing
 */
interface EdgeProcessingConfig {
  currentPath: string;
  expandAll: boolean;
  expandedNodes: Set<string>;
  showParents: boolean;
  unusedEdges: string[];
  unusedDependencyMode: UnusedDependencyMode;
  filterUnused: boolean;
}

/**
 * Get edges for processing, applying truncation if needed
 */
function getEdgesForProcessing(
  data: GraphData,
  config: EdgeProcessingConfig,
): { edges: Array<{ source: string; target: string }>; truncated: boolean } {
  const isHideMode =
    config.unusedDependencyMode === "hide" && config.filterUnused;
  const unusedEdgeSet = new Set(config.unusedEdges);

  // In hide mode: filter out ALL unused edges (both incoming and outgoing)
  // In dim mode: keep all edges, styling is applied in createVisibleEdges
  let baseEdges = data.edges;
  if (isHideMode && config.unusedEdges.length > 0) {
    baseEdges = data.edges.filter((edge) => {
      const normalizedId = `${normalizePath(edge.source)}->${normalizePath(edge.target)}`;
      return !unusedEdgeSet.has(normalizedId);
    });
  }

  const truncated = baseEdges.length > GRAPH_LIMITS.MAX_PROCESS_EDGES;

  if (!truncated) {
    return { edges: baseEdges, truncated: false };
  }

  if (config.expandAll) {
    return {
      edges: baseEdges.slice(0, GRAPH_LIMITS.MAX_PROCESS_EDGES),
      truncated: true,
    };
  }

  return {
    edges: filterRelevantEdges(
      baseEdges,
      config.currentPath,
      config.expandedNodes,
      config.showParents,
      GRAPH_LIMITS.MAX_PROCESS_EDGES,
    ),
    truncated: true,
  };
}

/**
 * Add parent nodes to the visible set
 */
function addParentNodes(
  visibleNodes: Set<string>,
  parents: string[],
  maxNodes: number,
): boolean {
  let truncated = false;
  for (const parent of parents) {
    if (visibleNodes.size >= maxNodes) {
      truncated = true;
      break;
    }
    visibleNodes.add(parent);
  }
  return truncated;
}

/**
 * Perform BFS traversal to find visible nodes
 */
function findVisibleNodesBFS(
  rootPath: string,
  children: Map<string, string[]>,
  expandedNodes: Set<string>,
  initialNodes: Set<string>,
  maxNodes: number,
): { visibleNodes: Set<string>; truncated: boolean } {
  const visibleNodes = new Set(initialNodes);
  const queue = [rootPath];
  const visited = new Set<string>();
  let truncated = false;

  log.debug("🔍 buildGraph: Starting BFS traversal", {
    normalizedCurrentPath: rootPath,
    expandedNodesSize: expandedNodes.size,
    expandedNodesList: Array.from(expandedNodes),
  });

  for (const node of queue) {
    if (visited.has(node)) continue;
    visited.add(node);
    visibleNodes.add(node);

    const nodeChildren = children.get(node) || [];
    const shouldShowChildren = expandedNodes.has(node) || node === rootPath;

    log.debug("🔍 buildGraph: Processing node", {
      node,
      hasInExpandedNodes: expandedNodes.has(node),
      isRoot: node === rootPath,
      shouldShowChildren,
      childrenCount: nodeChildren.length,
    });

    if (shouldShowChildren) {
      for (const child of nodeChildren) {
        if (visibleNodes.size >= maxNodes) {
          truncated = true;
          break;
        }
        queue.push(child);
      }
    }
    if (truncated) break;
  }

  log.debug("🔍 buildGraph: BFS complete", {
    visibleNodesSize: visibleNodes.size,
    visibleNodesList: Array.from(visibleNodes),
  });

  return { visibleNodes, truncated };
}

/**
 * Build relationship maps from edges
 */
function buildRelationshipMaps(
  edges: Array<{ source: string; target: string }>,
): { children: Map<string, string[]>; parents: Map<string, string[]> } {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  edges.forEach(({ source, target }) => {
    const ns = normalizePath(source);
    const nt = normalizePath(target);
    if (!children.has(ns)) children.set(ns, []);
    children.get(ns)!.push(nt);
    if (!parents.has(nt)) parents.set(nt, []);
    parents.get(nt)!.push(ns);
  });

  return { children, parents };
}

/**
 * Filter and create edges for the visible nodes
 */
function createVisibleEdges(
  edgesForProcessing: Array<{
    source: string;
    target: string;
    relationType?: "dependency" | "call" | "reference";
  }>,
  visibleNodes: Set<string>,
  cycles: Set<string>,
  unusedEdges: string[],
  unusedDependencyMode: "none" | "hide" | "dim",
  filterUnused: boolean,
): Edge[] {
  const seenEdgeIds = new Set<string>();
  const unusedEdgeSet = new Set(unusedEdges);
  const isDimMode = unusedDependencyMode === "dim" && filterUnused;

  return edgesForProcessing
    .map(({ source, target, relationType }) => ({
      source: normalizePath(source),
      target: normalizePath(target),
      relationType,
    }))
    .filter(
      ({ source, target }) =>
        visibleNodes.has(source) && visibleNodes.has(target),
    )
    .flatMap(({ source, target, relationType }) => {
      const id = `${source}->${target}`;
      if (seenEdgeIds.has(id)) return [];
      seenEdgeIds.add(id);

      const isUnused = unusedEdgeSet.has(id);
      const isCircular = cycles.has(source) && cycles.has(target);
      const edgeStyle = createEdgeStyleUtil(isCircular);

      // In dim mode, apply reduced opacity and dashed style to unused edges
      let styleOverrides: Partial<Edge> = {};

      if (isDimMode && isUnused) {
        styleOverrides = {
          style: { ...edgeStyle.style, opacity: 0.3, strokeDasharray: "5 5" },
          animated: false,
          label: "unused",
          labelStyle: {
            fill: "var(--vscode-descriptionForeground)",
            opacity: 0.5,
          },
          labelBgStyle: { fill: "transparent" },
        };
      } else if (isCircular) {
        // Cycle badge for circular dependencies (T048)
        styleOverrides = {
          style: { ...edgeStyle.style, strokeWidth: 2.5 },
          animated: true,
          label: "cycle",
          labelStyle: {
            fill: "var(--vscode-errorForeground)",
            fontSize: 10,
            fontWeight: "bold",
          },
          labelBgStyle: {
            fill: "var(--vscode-editor-background)",
            fillOpacity: 0.9,
          },
        };
      } else if (relationType === "reference") {
        // Dashed style for references
        styleOverrides = {
          style: { ...edgeStyle.style, strokeDasharray: "4 4" },
          animated: true,
          label: "references",
          labelStyle: {
            fill: "var(--vscode-descriptionForeground)",
            fontSize: 10,
          },
          labelBgStyle: {
            fill: "var(--vscode-editor-background)",
            fillOpacity: 0.7,
          },
        };
      } else if (relationType === "call") {
        // Solid style for calls (default, but explicit)
        styleOverrides = {
          style: { ...edgeStyle.style, strokeWidth: 2 },
          animated: true,
        };
      }

      return [
        {
          id,
          source,
          target,
          animated: true,
          ...edgeStyle,
          ...styleOverrides,
        },
      ];
    });
}

export function buildReactFlowGraph(params: {
  data: GraphData | undefined;
  currentFilePath: string;
  expandAll: boolean;
  expandedNodes: Set<string>;
  showParents: boolean;
  callbacks: BuildGraphCallbacks;
  unusedEdges?: string[];
  unusedDependencyMode?: "none" | "hide" | "dim";
  filterUnused?: boolean;
  mode?: "file" | "symbol";
  symbolData?: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  layout?: "hierarchical" | "force" | "radial";
}): BuildGraphResult {
  const {
    data,
    currentFilePath,
    expandAll,
    expandedNodes,
    showParents,
    callbacks,
    unusedEdges = [],
    unusedDependencyMode = "none",
    filterUnused = true,
    mode = "file",
    symbolData,
    layout = "hierarchical",
  } = params;
  const normalizedCurrentPath = normalizePath(currentFilePath);

  if (!data?.nodes?.length) {
    return {
      nodes: [],
      edges: [],
      cycles: new Set<string>(),
      edgesTruncated: false,
      renderEdgesTruncated: false,
      nodesTruncated: false,
    };
  }

  const { edges: edgesForProcessing, truncated: edgesTruncated } =
    getEdgesForProcessing(data, {
      currentPath: normalizedCurrentPath,
      expandAll,
      expandedNodes,
      showParents,
      unusedEdges,
      unusedDependencyMode,
      filterUnused,
    });

  const cycles =
    edgesForProcessing.length <= GRAPH_LIMITS.MAX_CYCLE_DETECT_EDGES
      ? detectCycles(edgesForProcessing)
      : new Set<string>();

  const getLabel = (path: string) =>
    data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

  const { children, parents } = buildRelationshipMaps(edgesForProcessing);

  const initialVisibleNodes = new Set<string>([normalizedCurrentPath]);
  let nodesTruncated = false;

  const fileParents = parents.get(normalizedCurrentPath) || [];
  const fileParentsSet = new Set(fileParents);

  if (showParents) {
    nodesTruncated = addParentNodes(
      initialVisibleNodes,
      fileParents,
      GRAPH_LIMITS.MAX_RENDER_NODES,
    );
  }

  const { visibleNodes, truncated: bfsTruncated } = findVisibleNodesBFS(
    normalizedCurrentPath,
    children,
    expandedNodes,
    initialVisibleNodes,
    GRAPH_LIMITS.MAX_RENDER_NODES,
  );

  nodesTruncated = nodesTruncated || bfsTruncated;

  const createNodeData = (
    path: string,
    label: string,
  ): FileNodeData | SymbolNodeData => {
    if (mode === "symbol" && symbolData) {
      // Find symbol info
      const symbol = symbolData.symbols.find((s) => s.id === path);
      if (symbol) {
        return {
          label: symbol.name,
          fullPath: symbol.id,
          kind: symbol.kind,
          category: symbol.category,
          line: symbol.line,
          isExported: symbol.isExported,
          isRoot: path === normalizedCurrentPath,
          onDrillDown: () => callbacks.onDrillDown(path),
          // Expansion props
          hasChildren: (children.get(path) || []).length > 0,
          isExpanded: expandedNodes.has(path) || path === normalizedCurrentPath,
          onToggle: () => callbacks.onToggle(path),
          onExpandRequest: () => callbacks.onExpandRequest(path),
        } as SymbolNodeData;
      }
    }

    const parentCountRaw = data.parentCounts?.[path];
    const parentCount =
      typeof parentCountRaw === "number" && parentCountRaw > 0
        ? parentCountRaw
        : undefined;
    const hasParents =
      (parents.get(path) || []).length > 0 ||
      (parentCount ? parentCount > 0 : false);
    return {
      label,
      fullPath: path,
      isRoot: path === normalizedCurrentPath,
      isParent: fileParentsSet.has(path),
      isInCycle: cycles.has(path),
      hasChildren: (children.get(path) || []).length > 0,
      isExpanded: expandedNodes.has(path) || path === normalizedCurrentPath,
      hasReferencingFiles: hasParents,
      parentCount,
      isParentsVisible: showParents,
      onDrillDown: () => callbacks.onDrillDown(path),
      onFindReferences: () => callbacks.onFindReferences(path),
      onToggleParents: callbacks.onToggleParents
        ? () => callbacks.onToggleParents!(path)
        : undefined,
      onToggle: () => callbacks.onToggle(path),
      onExpandRequest: () => callbacks.onExpandRequest(path),
    } as FileNodeData;
  };

  const nodes: Node<FileNodeData | SymbolNodeData>[] = Array.from(
    visibleNodes,
  ).map((path) => {
    const label = getLabel(path);
    const width = calculateNodeWidth(label);
    return {
      id: path,
      type: mode === "symbol" ? "symbol" : "file",
      position: { x: 0, y: 0 },
      style: { width, height: nodeHeight },
      data: createNodeData(path, label),
    };
  });

  let edges: Edge[] = createVisibleEdges(
    edgesForProcessing,
    visibleNodes,
    cycles,
    unusedEdges,
    unusedDependencyMode,
    filterUnused,
  );

  const renderEdgesTruncated = edges.length > GRAPH_LIMITS.MAX_RENDER_EDGES;
  if (renderEdgesTruncated) {
    edges = edges.slice(0, GRAPH_LIMITS.MAX_RENDER_EDGES);
  }

  // Determine layout settings
  const maxNodesForDagre =
    layout === "force" || layout === "radial"
      ? Infinity
      : GRAPH_LIMITS.MAX_DAGRE_NODES;

  const layouted = layoutGraph(
    nodes,
    edges,
    normalizedCurrentPath,
    maxNodesForDagre,
    layout,
  );

  return {
    nodes: layouted.nodes as Node<FileNodeData | SymbolNodeData>[],
    edges: layouted.edges,
    cycles,
    edgesTruncated,
    renderEdgesTruncated,
    nodesTruncated,
  };
}
