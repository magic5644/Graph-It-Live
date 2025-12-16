import type { Edge, Node } from 'reactflow';
import type { GraphData } from '../../../shared/types';
import { nodeHeight } from '../../utils/nodeUtils';
import { normalizePath } from '../../utils/path';
import type { FileNodeData } from './FileNode';
import { detectCycles } from './cycles';
import { calculateNodeWidth, layoutGraph } from './layout';

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

  const edgesTruncated = data.edges.length > GRAPH_LIMITS.MAX_PROCESS_EDGES;
  const edgesForProcessing = (() => {
    if (!edgesTruncated) return data.edges;
    if (expandAll) return data.edges.slice(0, GRAPH_LIMITS.MAX_PROCESS_EDGES);

    // When the graph is huge we still want expand/collapse to feel reliable.
    // Instead of slicing the first N edges (which is sensitive to traversal order
    // and can vary across platforms), prefer keeping edges relevant to the current
    // expansion frontier (root + explicitly expanded nodes).
    const allowedSources = new Set<string>([normalizedCurrentPath]);
    expandedNodes.forEach((n) => allowedSources.add(normalizePath(n)));

    const selected: typeof data.edges = [];
    for (const edge of data.edges) {
      const source = normalizePath(edge.source);
      const target = normalizePath(edge.target);
      if (allowedSources.has(source) || (showParents && target === normalizedCurrentPath)) {
        selected.push({ source, target });
        if (selected.length >= GRAPH_LIMITS.MAX_PROCESS_EDGES) break;
      }
    }
    return selected;
  })();

  const cycles =
    edgesForProcessing.length <= GRAPH_LIMITS.MAX_CYCLE_DETECT_EDGES ? detectCycles(edgesForProcessing) : new Set<string>();

  const getLabel = (path: string) => data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  edgesForProcessing.forEach(({ source, target }) => {
    const ns = normalizePath(source);
    const nt = normalizePath(target);
    if (!children.has(ns)) children.set(ns, []);
    children.get(ns)!.push(nt);
    if (!parents.has(nt)) parents.set(nt, []);
    parents.get(nt)!.push(ns);
  });

  const visibleNodes = new Set<string>([normalizedCurrentPath]);
  let nodesTruncated = false;

  const fileParents = parents.get(normalizedCurrentPath) || [];
  const fileParentsSet = new Set(fileParents);
  if (showParents) {
    for (const parent of fileParents) {
      if (visibleNodes.size >= GRAPH_LIMITS.MAX_RENDER_NODES) {
        nodesTruncated = true;
        break;
      }
      visibleNodes.add(parent);
    }
  }

  console.log('🔍 buildGraph: Starting BFS traversal', {
    normalizedCurrentPath,
    expandedNodesSize: expandedNodes.size,
    expandedNodesList: Array.from(expandedNodes),
    expandAll
  });

  const queue = [normalizedCurrentPath];
  const visited = new Set<string>();
  for (const node of queue) {
    if (visited.has(node)) continue;
    visited.add(node);
    visibleNodes.add(node);

    const nodeChildren = children.get(node) || [];
    const shouldShowChildren = expandAll || expandedNodes.has(node) || node === normalizedCurrentPath;

    console.log('🔍 buildGraph: Processing node', {
      node,
      hasInExpandedNodes: expandedNodes.has(node),
      isRoot: node === normalizedCurrentPath,
      expandAll,
      shouldShowChildren,
      childrenCount: nodeChildren.length
    });

    if (shouldShowChildren) {
      for (const child of nodeChildren) {
        if (visibleNodes.size >= GRAPH_LIMITS.MAX_RENDER_NODES) {
          nodesTruncated = true;
          break;
        }
        queue.push(child);
      }
    }
    if (nodesTruncated) break;
  }

  console.log('🔍 buildGraph: BFS complete', {
    visibleNodesSize: visibleNodes.size,
    visibleNodesList: Array.from(visibleNodes)
  });

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
      isExpanded: expandAll || expandedNodes.has(path) || path === normalizedCurrentPath,
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

  const createEdgeStyle = (isCircular: boolean) =>
    isCircular
      ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' }
      : { stroke: 'var(--vscode-editor-foreground)' };

  const seenEdgeIds = new Set<string>();
  let edges: Edge[] = edgesForProcessing
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
