import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { Node, Edge, useNodesState, useEdgesState, Position } from 'reactflow';
import dagre from 'dagre';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, GraphData } from '../../shared/types';
import { mergeGraphData, detectCycles } from '../utils/graphUtils';

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

/**
 * Collect all nodes that have children (are sources of edges)
 */
function collectNodesWithChildren(filePath: string | undefined, edges: { source: string; target: string }[]): Set<string> {
    const allNodesWithChildren = new Set<string>();
    if (filePath) {
        allNodesWithChildren.add(filePath);
    }
    for (const edge of edges) {
        allNodesWithChildren.add(edge.source);
    }
    return allNodesWithChildren;
}

const nodeWidth = 180;
const nodeHeight = 50;

/**
 * Get node style based on file type and state
 */
function getNodeStyle(fileName: string, path: string, isRoot: boolean, isSymbolNode: boolean = false): { background: string; border: string; color: string; shape: 'rect' | 'circle' } {
    if (isRoot) {
        return {
            background: 'var(--vscode-button-background)',
            color: 'var(--vscode-button-foreground)',
            border: '1px solid var(--vscode-button-background)',
            shape: 'rect',
        };
    }
    
    // Symbol nodes get circular shape and different styling
    if (isSymbolNode) {
        return {
            background: 'var(--vscode-editor-background)',
            border: '2px solid var(--vscode-button-background)',
            color: 'var(--vscode-editor-foreground)',
            shape: 'circle',
        };
    }
    
    const isNodeModule = /^(?!\.|\/|\\|[a-zA-Z]:)/.test(path);
    if (isNodeModule) {
        return {
            background: 'var(--vscode-sideBar-background)',
            border: '1px dashed var(--vscode-disabledForeground)',
            color: 'var(--vscode-editor-foreground)',
            shape: 'rect',
        };
    }

    const baseStyle = {
        background: 'var(--vscode-editor-background)',
        color: 'var(--vscode-editor-foreground)',
        border: '1px solid var(--vscode-widget-border)',
        shape: 'rect' as const,
    };

    // File type specific borders
    const borderColors: Record<string, string> = {
        '.ts': '#3178c6',   // TS Blue
        '.tsx': '#3178c6',  // TS Blue
        '.js': '#f7df1e',   // JS Yellow
        '.jsx': '#f7df1e',  // JS Yellow
        '.vue': '#41b883',  // Vue Green
        '.svelte': '#ff3e00', // Svelte Orange
        '.gql': '#e535ab',  // GraphQL Pink
        '.graphql': '#e535ab', // GraphQL Pink
    };

    for (const [ext, color] of Object.entries(borderColors)) {
        if (fileName.endsWith(ext)) {
            return { ...baseStyle, border: `1px solid ${color}` };
        }
    }

    return baseStyle;
}

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ 
    rankdir: 'LR', 
    nodesep: 30, 
    ranksep: 50,
    align: 'UL'
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    node.targetPosition = Position.Left;
    node.sourcePosition = Position.Right;

    // We are shifting the dagre node position (anchor=center center) to the top left
    // so it matches the React Flow node anchor point (top left).
    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };

    return node;
  });

  return { nodes, edges };
};

export const useGraphData = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [currentFilePath, setCurrentFilePath] = useState<string>('');
  const [fullGraphData, setFullGraphData] = useState<GraphData | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const [expandAll, setExpandAll] = useState<boolean>(false);

  // Function to toggle expand all
  const toggleExpandAll = useCallback((shouldExpandAll: boolean) => {
      console.log('toggleExpandAll called with:', shouldExpandAll, 'fullGraphData:', !!fullGraphData, 'currentFilePath:', currentFilePath);
      console.log('Current expandedNodes:', expandedNodes.size);
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
          
          console.log('Expanding all nodes:', allNodesWithChildren.size, 'nodes', Array.from(allNodesWithChildren));
          setExpandedNodes(allNodesWithChildren);
      } else if (!shouldExpandAll) {
          // Reset to just root expanded (or empty if no current file)
          const rootSet = currentFilePath ? new Set([currentFilePath]) : new Set<string>();
          console.log('Collapsing all nodes, keeping root:', rootSet.size, Array.from(rootSet));
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
          console.log('Applying expandAll state to new graph data');
          const allNodesWithChildren = new Set<string>();
          allNodesWithChildren.add(currentFilePath);
          fullGraphData.edges.forEach(edge => {
              allNodesWithChildren.add(edge.source);
          });
          console.log('Setting expanded nodes from effect:', allNodesWithChildren.size);
          setExpandedNodes(allNodesWithChildren);
      }
  }, [fullGraphData, expandAll, currentFilePath]);

  // Debug: Log when expandedNodes changes
  useEffect(() => {
      console.log('expandedNodes changed, new size:', expandedNodes.size, 'nodes:', Array.from(expandedNodes).slice(0, 5));
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
  const calculateVisibleGraph = useCallback((
    graphData: GraphData,
    rootPath: string,
    expanded: Set<string>
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

    // Add incoming edges to root (Referenced By)
    const incomingEdges = graphData.edges.filter(e => e.target === rootPath);
    incomingEdges.forEach(edge => {
      visibleNodes.add(edge.source);
      addEdge(edge);
    });

    return { visibleNodes, visibleEdges };
  }, []);

  // Helper: Get disambiguated label for a node
  const getNodeLabel = useCallback((
    path: string,
    graphData: GraphData,
    fileNameCounts: Map<string, number>
  ): string => {
    const fileName = path.split(/[/\\]/).pop() || path;
    
    // Use custom label if available
    if (graphData.nodeLabels?.[path]) {
      return graphData.nodeLabels[path];
    }
    
    // Disambiguate duplicate filenames
    if ((fileNameCounts.get(fileName) || 0) > 1) {
      const parentDir = path.split(/[/\\]/).slice(-2, -1)[0];
      if (parentDir) {
        return `${parentDir}/${fileName}`;
      }
    }
    
    return fileName;
  }, []);

  // Helper: Build node style object
  const buildNodeStyle = useCallback((
    isRoot: boolean,
    shape: 'rect' | 'circle',
    background: string,
    color: string,
    border: string
  ): React.CSSProperties => ({
    background,
    color,
    border,
    borderRadius: shape === 'circle' ? '50%' : 4,
    padding: 10,
    fontSize: '12px',
    width: shape === 'circle' ? 80 : nodeWidth,
    height: shape === 'circle' ? 80 : nodeHeight,
    fontWeight: isRoot ? 'bold' : 'normal',
    cursor: 'pointer',
    textDecoration: isRoot ? 'underline' : 'none',
    textAlign: 'center',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    fontFamily: 'var(--vscode-font-family)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }), []);

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
  }, [toggleNode, getNodeLabel, buildNodeStyle]);

  // Helper: Create React Flow edges
  const createFlowEdges = useCallback((
    visibleEdges: { source: string; target: string }[],
    cycleEdgeSet: Set<string>
  ): Edge[] => {
    return visibleEdges.map(edge => {
      const edgeId = `${edge.source}-${edge.target}`;
      const isCircular = cycleEdgeSet.has(edgeId);

      return {
        id: edgeId,
        source: edge.source,
        target: edge.target,
        animated: true,
        style: isCircular
          ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' }
          : { stroke: 'var(--vscode-editor-foreground)' },
        label: isCircular ? 'Cycle' : undefined,
        labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
        labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
      };
    });
  }, []);

  // Re-calculate visible nodes and edges when fullGraphData or expandedNodes changes
  useEffect(() => {
    if (!fullGraphData || !currentFilePath) return;

    const { visibleNodes, visibleEdges } = calculateVisibleGraph(
      fullGraphData,
      currentFilePath,
      expandedNodes
    );

    // Calculate filename frequencies for disambiguation
    const fileNameCounts = new Map<string, number>();
    visibleNodes.forEach(path => {
      const fileName = path.split(/[/\\]/).pop() || path;
      fileNameCounts.set(fileName, (fileNameCounts.get(fileName) || 0) + 1);
    });

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

  }, [fullGraphData, expandedNodes, currentFilePath, setNodes, setEdges, circularEdges, nodesInCycles, calculateVisibleGraph, createFlowNode, createFlowEdges]);

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
        console.log('Received setExpandAll message:', message.expandAll);
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
