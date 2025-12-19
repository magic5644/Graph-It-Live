import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { Node, Edge, useNodesState, useEdgesState, Position } from 'reactflow';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, GraphData } from '../../shared/types';
import { mergeGraphData, detectCycles } from '../utils/graphUtils';
import { 
  collectNodesWithChildren,
  getNodeStyle,
  getLayoutedElements,
  buildNodeStyle,
  getNodeLabel,
  calculateFileNameCounts,
  createEdgeStyle,
} from '../utils/nodeUtils';
import { getLogger } from '../../shared/logger';

/** Logger instance for useGraphData */
const log = getLogger('useGraphData');
log.info('useGraphData initialized');

// Define VS Code API type
interface VSCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VSCodeApi;
}

// Initialize VS Code API safely
const vscode = (function() {
    try {
        return typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    } catch {
        return null;
    }
})();

export const useGraphData = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [currentFilePath, setCurrentFilePath] = useState<string>('');
  const [fullGraphData, setFullGraphData] = useState<GraphData | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const [expandAll, setExpandAll] = useState<boolean>(false);
  // Toggle to show/hide parent referencing files for the current root
  const [showParents, setShowParents] = useState<boolean>(false);
  const toggleShowParents = useCallback(() => setShowParents((prev) => !prev), []);
  // Auto-request logic removed; we only fetch referencing files on explicit user action

  // Function to toggle expand all
  const toggleExpandAll = useCallback((shouldExpandAll: boolean) => {
      log.debug('toggleExpandAll called with:', shouldExpandAll, 'fullGraphData:', !!fullGraphData, 'currentFilePath:', currentFilePath);
      log.debug('Current expandedNodes:', expandedNodes.size);
      setExpandAll(shouldExpandAll);
      
      if (shouldExpandAll && fullGraphData) {
          // Add all nodes that have children to expandedNodes
          const allNodesWithChildren = new Set<string>();
          // Add root
          if (currentFilePath) allNodesWithChildren.add(currentFilePath);
          
          // Add all source nodes from edges
          fullGraphData.edges.forEach(edge => {
              allNodesWithChildren.add(edge.source);
          });
          
          log.debug('Expanding all nodes:', allNodesWithChildren.size, 'nodes', Array.from(allNodesWithChildren));
          setExpandedNodes(allNodesWithChildren);
      } else if (!shouldExpandAll) {
          // Reset to just root expanded (or empty if no current file)
          const rootSet = currentFilePath ? new Set([currentFilePath]) : new Set<string>();
          log.debug('Collapsing all nodes, keeping root:', rootSet.size, Array.from(rootSet));
          setExpandedNodes(rootSet);
      } else if (shouldExpandAll && !fullGraphData) {
          console.warn('toggleExpandAll: No fullGraphData available yet');
      }

      if (vscode) {
          vscode.postMessage({
              command: 'setExpandAll',
              expandAll: shouldExpandAll
          });
      }
  }, [fullGraphData, currentFilePath]);

  // Apply expandAll state when fullGraphData changes
  useEffect(() => {
      if (expandAll && fullGraphData && currentFilePath) {
          log.debug('Applying expandAll state to new graph data');
          const allNodesWithChildren = new Set<string>();
          allNodesWithChildren.add(currentFilePath);
          fullGraphData.edges.forEach(edge => {
              allNodesWithChildren.add(edge.source);
          });
          log.debug('Setting expanded nodes from effect:', allNodesWithChildren.size);
          setExpandedNodes(allNodesWithChildren);
      }
  }, [fullGraphData, expandAll, currentFilePath]);

  // Debug: Log when expandedNodes changes
  useEffect(() => {
      log.debug('expandedNodes changed, new size:', expandedNodes.size, 'nodes:', Array.from(expandedNodes).slice(0, 5));
  }, [expandedNodes]);

  // Function to toggle node expansion
  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // Detect cycles when fullGraphData changes
  const { circularEdges, nodesInCycles } = useMemo(() => {
      if (!fullGraphData) {
          return { circularEdges: new Set<string>(), nodesInCycles: new Set<string>() };
      }
      const { cycleEdges, cycleNodes } = detectCycles(fullGraphData);
      return { circularEdges: cycleEdges, nodesInCycles: cycleNodes };
  }, [fullGraphData]);

  // Helper: Calculate visible nodes and edges based on expansion state
  const calculateVisibleGraphLocal = useCallback((
    graphData: GraphData,
    rootPath: string,
    expanded: Set<string>
  , showParentsFlag: boolean
  ): { visibleNodes: Set<string>; visibleEdges: { source: string; target: string }[] } => {
    const visibleNodes = new Set<string>();
    const visibleEdges: { source: string; target: string }[] = [];
    const visited = new Set<string>();
    const addedEdgeIds = new Set<string>();

    visibleNodes.add(rootPath);

    const addEdge = (edge: { source: string; target: string }) => {
      const edgeId = `${edge.source}-${edge.target}`;
      if (!addedEdgeIds.has(edgeId)) {
        addedEdgeIds.add(edgeId);
        visibleEdges.push(edge);
      }
    };

    const addChildren = (parentId: string) => {
      if (visited.has(parentId)) return;
      visited.add(parentId);

      const childrenEdges = graphData.edges.filter(e => e.source === parentId);
      childrenEdges.forEach(edge => {
        visibleNodes.add(edge.target);
        addEdge(edge);
        if (expanded.has(edge.target)) {
          addChildren(edge.target);
        }
      });
    };

    addChildren(rootPath);

    // Add incoming edges to root (Referenced By) only when showParentsFlag is true
    if (showParentsFlag) {
      const incomingEdges = graphData.edges.filter((e) => e.target === rootPath);
      incomingEdges.forEach((edge) => {
        visibleNodes.add(edge.source);
        addEdge(edge);
      });
    }

    return { visibleNodes, visibleEdges };
  }, []);

  // Helper: Create a React Flow node from path
  const createFlowNode = useCallback((
    path: string,
    graphData: GraphData,
    rootPath: string,
    expanded: Set<string>,
    fileNameCounts: Map<string, number>,
    cycleNodes: Set<string> | undefined
  ): Node => {
    const fileName = path.split(/[/\\]/).pop() || path;
    const label = getNodeLabel(path, graphData, fileNameCounts);
    const isRoot = path === rootPath;
    const hasChildren = graphData.edges.some(e => e.source === path);
    const hasReferencingFiles = graphData.edges.some((e) => e.target === path);
    const isExpanded = expanded.has(path) || isRoot;
    const isInCycle = cycleNodes?.has(path) || false;
    const isFileNode = !path.includes(':');
    const { background, border, color, shape } = getNodeStyle(fileName, path, isRoot, !isFileNode);

    return {
      id: path,
      data: {
        label,
        fullPath: path,
        hasChildren,
        isExpanded,
        isInCycle,
        onToggle: () => toggleNode(path),
        onExpand: hasChildren ? () => requestExpandNode?.(path) : undefined,
        onFindReferences: () => requestFindReferencingFiles?.(path),
        onToggleParents: () => toggleShowParents(),
        isParentsVisible: showParents,
        hasReferencingFiles,
        onDrillDown: isFileNode ? () => drillDownToSymbols(path) : undefined,
        isRoot,
        isFileNode,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      position: { x: 0, y: 0 },
      type: 'custom',
      style: buildNodeStyle(isRoot, shape, background, color, border),
    };
  }, [toggleNode, toggleShowParents, showParents]);

  // Helper: Create React Flow edges
  const createFlowEdges = useCallback((
    visibleEdges: { source: string; target: string }[],
    cycleEdgeSet: Set<string>
  ): Edge[] => {
    return visibleEdges.map(edge => {
      const edgeId = `${edge.source}-${edge.target}`;
      const isCircular = cycleEdgeSet.has(edgeId);
      const edgeStyle = createEdgeStyle(isCircular);

      return {
        id: edgeId,
        source: edge.source,
        target: edge.target,
        animated: true,
        ...edgeStyle,
      };
    });
  }, []);

  // Re-calculate visible nodes and edges when fullGraphData or expandedNodes changes
  useEffect(() => {
    if (!fullGraphData || !currentFilePath) return;

    const { visibleNodes, visibleEdges } = calculateVisibleGraphLocal(
      fullGraphData,
      currentFilePath,
      expandedNodes,
      showParents
    );

    // Calculate filename frequencies for disambiguation
    const fileNameCounts = calculateFileNameCounts(visibleNodes);

    // Create React Flow nodes
    const newNodes: Node[] = Array.from(visibleNodes).map(path =>
      createFlowNode(path, fullGraphData, currentFilePath, expandedNodes, fileNameCounts, nodesInCycles)
    );

    // Create React Flow edges
    const newEdges = createFlowEdges(visibleEdges, circularEdges);

    // Apply layout
    const layouted = getLayoutedElements(newNodes, newEdges);
    setNodes(layouted.nodes);
    setEdges(layouted.edges);

  }, [fullGraphData, expandedNodes, currentFilePath, setNodes, setEdges, circularEdges, nodesInCycles, calculateVisibleGraphLocal, createFlowNode, createFlowEdges, showParents]);

  // Function to request on-demand scan when expanding a node
  const requestExpandNode = useCallback((nodeId: string) => {
    if (!fullGraphData || !vscode) return;
    
    const allKnownNodes = Array.from(new Set([
      ...fullGraphData.nodes,
      ...fullGraphData.edges.map(e => e.source),
      ...fullGraphData.edges.map(e => e.target),
    ]));

    vscode.postMessage({
      command: 'expandNode',
      nodeId,
      knownNodes: allKnownNodes,
    });
  }, [fullGraphData]);

  const requestFindReferencingFiles = useCallback((nodeId: string) => {
    if (!vscode) return;
    vscode.postMessage({
      command: 'findReferencingFiles',
      nodeId,
    });
  }, []);

  // Keep track of fullGraphData in a ref to access it in the event listener
  const fullGraphDataRef = React.useRef(fullGraphData);
  useEffect(() => {
    fullGraphDataRef.current = fullGraphData;
  }, [fullGraphData]);

  // Helper to handle updateGraph message
  const handleUpdateGraphMessage = useCallback((message: ExtensionToWebviewMessage & { command: 'updateGraph' }) => {
    setCurrentFilePath(message.filePath);
    setFullGraphData(message.data);
    
    // Default behavior if expandAll not provided
    if (message.expandAll === undefined) {
      setExpandedNodes(new Set([message.filePath]));
      return;
    }
    
    setExpandAll(message.expandAll);
    
    // If expandAll is true, populate expandedNodes with all nodes that have children
    if (message.expandAll && message.data) {
      const allNodesWithChildren = collectNodesWithChildren(message.filePath, message.data.edges);
      setExpandedNodes(allNodesWithChildren);
    } else {
      setExpandedNodes(new Set([message.filePath]));
    }

    // Do NOT auto-request parent/reference files on load; the button will be shown only when
    // the backend indicates parent counts via GraphData.parentCounts or when the user explicitly clicks.
  }, []);

  // Helper to handle symbolGraph message
  const handleSymbolGraphMessage = useCallback((message: ExtensionToWebviewMessage & { command: 'symbolGraph' }) => {
    setCurrentFilePath(message.filePath);
    setFullGraphData(message.data);
    
    // In symbol view, expand the file node by default to show its symbols
    setExpandedNodes(new Set([message.filePath]));
  }, []);

  // Helper to handle expandedGraph/referencingFiles message
  const handleMergeGraphMessage = useCallback((message: ExtensionToWebviewMessage & { command: 'expandedGraph' | 'referencingFiles' }) => {
    const currentData = fullGraphDataRef.current;
    if (!currentData || !message.data) {
      return;
    }
    
    const mergedData = mergeGraphData(currentData, message.data);
    setFullGraphData(mergedData);
    
    // Auto-expand the node that was requested
    setExpandedNodes(prev => new Set([...prev, message.nodeId]));
  }, []);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const handleMessage = (event: MessageEvent) => {
      const message = event.data as ExtensionToWebviewMessage;
      
      if (message.command === 'updateGraph') {
        // Debounce updates to prevent flickering
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => handleUpdateGraphMessage(message), 100);
      } else if (message.command === 'symbolGraph') {
        handleSymbolGraphMessage(message);
      } else if (message.command === 'expandedGraph' || message.command === 'referencingFiles') {
        handleMergeGraphMessage(message);
      } else if (message.command === 'setExpandAll') {
        log.debug('Received setExpandAll message:', message.expandAll);
        toggleExpandAll(message.expandAll);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
        window.removeEventListener('message', handleMessage);
        clearTimeout(timeoutId);
    };
  }, [handleUpdateGraphMessage, handleSymbolGraphMessage, handleMergeGraphMessage, toggleExpandAll]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    // If clicking on the expand button, don't open file
    // This is handled by the custom node component
    // But if clicking the body, we open the file
    
    // Actually, let's separate concerns:
    // Click on node body -> Open File
    // Click on +/- button -> Toggle Expand (handled in CustomNode)
    
    if (vscode) {
      vscode.postMessage({
        command: 'openFile',
        path: node.id,
      });
    }
  }, []);

  const openFile = useCallback((path: string) => {
    if (vscode) {
      vscode.postMessage({
        command: 'openFile',
        path,
      });
    }
  }, []);

  const refreshGraph = useCallback(() => {
    if (vscode) {
      vscode.postMessage({
        command: 'refreshGraph'
      });
    }
  }, []);

  const drillDownToSymbols = useCallback((filePath: string) => {
    if (vscode) {
      vscode.postMessage({
        command: 'drillDown',
        filePath,
      });
    }
  }, []);

  return {
      showParents,
      toggleShowParents,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onNodeClick,
    openFile,
    toggleNode,
    nodesInCycles,
    requestExpandNode,
    currentFilePath,
    expandAll,
    toggleExpandAll,
    refreshGraph,
    requestFindReferencingFiles,
    drillDownToSymbols,
  };
};
