import type { Edge, Node } from 'reactflow';
import type { GraphData } from '../../../shared/types';
import { getLogger } from '../../../shared/logger';
import { nodeHeight } from '../../utils/nodeUtils';
import { normalizePath } from '../../utils/path';
import type { FileNodeData } from './FileNode';
import { detectCycles } from './cycles';
import { calculateNodeWidth, layoutGraph } from './layout';

/** Logger instance for buildGraph */
const log = getLogger('buildGraph');

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
  nodes: Node<FileNodeData>[];
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
  maxEdges: number
): Array<{ source: string; target: string }> {
  const allowedSources = new Set<string>([normalizePath(currentPath)]);
  expandedNodes.forEach((n) => allowedSources.add(normalizePath(n)));

  const selected: typeof edges = [];
  for (const edge of edges) {
    const source = normalizePath(edge.source);
    const target = normalizePath(edge.target);
    if (allowedSources.has(source) || (showParents && target === normalizePath(currentPath))) {
      selected.push({ source, target });
      if (selected.length >= maxEdges) break;
    }
  }
  return selected;
}

/**
 * Get edges for processing, applying truncation if needed
 */
function getEdgesForProcessing(
  data: GraphData,
  currentPath: string,
  expandAll: boolean,
  expandedNodes: Set<string>,
  showParents: boolean
): { edges: Array<{ source: string; target: string }>; truncated: boolean } {
  const truncated = data.edges.length > GRAPH_LIMITS.MAX_PROCESS_EDGES;
  
  if (!truncated) {
    return { edges: data.edges, truncated: false };
  }
  
  if (expandAll) {
    return { 
      edges: data.edges.slice(0, GRAPH_LIMITS.MAX_PROCESS_EDGES),
      truncated: true 
    };
  }

  return {
    edges: filterRelevantEdges(
      data.edges,
      currentPath,
      expandedNodes,
      showParents,
      GRAPH_LIMITS.MAX_PROCESS_EDGES
    ),
    truncated: true
  };
}

/**
 * Add parent nodes to the visible set
 */
function addParentNodes(
  visibleNodes: Set<string>,
  parents: string[],
  maxNodes: number
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
  maxNodes: number
): { visibleNodes: Set<string>; truncated: boolean } {
  const visibleNodes = new Set(initialNodes);
  const queue = [rootPath];
  const visited = new Set<string>();
  let truncated = false;

  log.debug('🔍 buildGraph: Starting BFS traversal', {
    normalizedCurrentPath: rootPath,
    expandedNodesSize: expandedNodes.size,
    expandedNodesList: Array.from(expandedNodes)
  });

  for (const node of queue) {
    if (visited.has(node)) continue;
    visited.add(node);
    visibleNodes.add(node);

    const nodeChildren = children.get(node) || [];
    const shouldShowChildren = expandedNodes.has(node) || node === rootPath;

    log.debug('🔍 buildGraph: Processing node', {
      node,
      hasInExpandedNodes: expandedNodes.has(node),
      isRoot: node === rootPath,
      shouldShowChildren,
      childrenCount: nodeChildren.length
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

  log.debug('🔍 buildGraph: BFS complete', {
    visibleNodesSize: visibleNodes.size,
    visibleNodesList: Array.from(visibleNodes)
  });

  return { visibleNodes, truncated };
}

/**
 * Build relationship maps from edges
 */
function buildRelationshipMaps(
  edges: Array<{ source: string; target: string }>
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
 * Create edge style based on whether it's part of a cycle
 */
function createEdgeStyle(isCircular: boolean) {
  return isCircular
    ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' }
    : { stroke: 'var(--vscode-editor-foreground)' };
}

/**
 * Filter and create edges for the visible nodes
 */
function createVisibleEdges(
  edgesForProcessing: Array<{ source: string; target: string }>,
  visibleNodes: Set<string>,
  cycles: Set<string>
): Edge[] {
  const seenEdgeIds = new Set<string>();
  
  return edgesForProcessing
    .map(({ source, target }) => ({ source: normalizePath(source), target: normalizePath(target) }))
    .filter(({ source, target }) => visibleNodes.has(source) && visibleNodes.has(target))
    .flatMap(({ source, target }) => {
      const id = `${source}->${target}`;
      if (seenEdgeIds.has(id)) return [];
      seenEdgeIds.add(id);

      const isCircular = cycles.has(source) && cycles.has(target);
      return [
        {
          id,
          source,
          target,
          animated: true,
          style: createEdgeStyle(isCircular),
          label: isCircular ? 'Cycle' : undefined,
          labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
          labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
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
}): BuildGraphResult {
  const { data, currentFilePath, expandAll, expandedNodes, showParents, callbacks } = params;
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

  const { edges: edgesForProcessing, truncated: edgesTruncated } = getEdgesForProcessing(
    data,
    normalizedCurrentPath,
    expandAll,
    expandedNodes,
    showParents
  );

  const cycles =
    edgesForProcessing.length <= GRAPH_LIMITS.MAX_CYCLE_DETECT_EDGES 
      ? detectCycles(edgesForProcessing) 
      : new Set<string>();

  const getLabel = (path: string) => data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

  const { children, parents } = buildRelationshipMaps(edgesForProcessing);

  const initialVisibleNodes = new Set<string>([normalizedCurrentPath]);
  let nodesTruncated = false;

  const fileParents = parents.get(normalizedCurrentPath) || [];
  const fileParentsSet = new Set(fileParents);
  
  if (showParents) {
    nodesTruncated = addParentNodes(initialVisibleNodes, fileParents, GRAPH_LIMITS.MAX_RENDER_NODES);
  }

  const { visibleNodes, truncated: bfsTruncated } = findVisibleNodesBFS(
    normalizedCurrentPath,
    children,
    expandedNodes,
    initialVisibleNodes,
    GRAPH_LIMITS.MAX_RENDER_NODES
  );
  
  nodesTruncated = nodesTruncated || bfsTruncated;

  const createNodeData = (path: string, label: string): FileNodeData => {
    const parentCountRaw = data.parentCounts?.[path];
    const parentCount = typeof parentCountRaw === 'number' && parentCountRaw > 0 ? parentCountRaw : undefined;
    const hasParents = (parents.get(path) || []).length > 0 || (parentCount ? parentCount > 0 : false);
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
      onToggleParents: callbacks.onToggleParents ? () => callbacks.onToggleParents!(path) : undefined,
      onToggle: () => callbacks.onToggle(path),
      onExpandRequest: () => callbacks.onExpandRequest(path),
    };
  };

  const nodes: Node<FileNodeData>[] = Array.from(visibleNodes).map((path) => {
    const label = getLabel(path);
    const width = calculateNodeWidth(label);
    return {
      id: path,
      type: 'file',
      position: { x: 0, y: 0 },
      style: { width, height: nodeHeight },
      data: createNodeData(path, label),
    };
  });

  let edges: Edge[] = createVisibleEdges(edgesForProcessing, visibleNodes, cycles);

  const renderEdgesTruncated = edges.length > GRAPH_LIMITS.MAX_RENDER_EDGES;
  if (renderEdgesTruncated) {
    edges = edges.slice(0, GRAPH_LIMITS.MAX_RENDER_EDGES);
  }

  const layouted = layoutGraph(nodes, edges, normalizedCurrentPath, GRAPH_LIMITS.MAX_DAGRE_NODES);

  return {
    nodes: layouted.nodes as Node<FileNodeData>[],
    edges: layouted.edges,
    cycles,
    edgesTruncated,
    renderEdgesTruncated,
    nodesTruncated,
  };
}
