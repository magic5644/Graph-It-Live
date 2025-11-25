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

const nodeWidth = 180;
const nodeHeight = 50;

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
          
          setExpandedNodes(allNodesWithChildren);
      } else if (!shouldExpandAll && currentFilePath) {
          // Reset to just root expanded
          setExpandedNodes(new Set([currentFilePath]));
      }

      if (vscode) {
          vscode.postMessage({
              command: 'setExpandAll',
              expandAll: shouldExpandAll
          });
      }
  }, [fullGraphData, currentFilePath]);

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

  // Re-calculate visible nodes and edges when fullGraphData or expandedNodes changes
  useEffect(() => {
    if (!fullGraphData || !currentFilePath) return;

    const visibleNodes = new Set<string>();
    const visibleEdges: { source: string; target: string }[] = [];
    
    // Always show root
    visibleNodes.add(currentFilePath);
    
    // Helper to add children if parent is expanded
    const visited = new Set<string>();
    
    const addedEdgeIds = new Set<string>();

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

        // Find edges starting from parent
        const childrenEdges = fullGraphData.edges.filter(e => e.source === parentId);
        
        childrenEdges.forEach(edge => {
            visibleNodes.add(edge.target);
            addEdge(edge);
            
            // If child is expanded, recurse
            if (expandedNodes.has(edge.target)) {
                addChildren(edge.target);
            }
        });
    };

    // Start from root - root is always treated as expanded
    // So we always call addChildren for it
    addChildren(currentFilePath);

    // Also check for incoming edges to the root (Referenced By)
    console.log('Graph-It-Live Webview: Checking incoming edges for', currentFilePath);
    const incomingEdges = fullGraphData.edges.filter(e => {
        const isMatch = e.target === currentFilePath;
        if (!isMatch && e.target.endsWith(currentFilePath.split(/[/\\]/).pop() || '')) {

             console.log('Graph-It-Live Webview: Potential path mismatch?', e.target, currentFilePath);
        }
        return isMatch;
    });
    console.log('Graph-It-Live Webview: Incoming edges to root', incomingEdges);
    incomingEdges.forEach(edge => {
        visibleNodes.add(edge.source);
        addEdge(edge);
        
        // If the referencing node is expanded, we might want to show its parents too?
        // For now, let's just show the immediate parents of the root.
        // If we want to support traversing up, we'd need an addParents function.
    });

    // Create React Flow Nodes
    const newNodes: Node[] = [];
    
    // Calculate filename frequencies to detect duplicates
    const fileNameCounts = new Map<string, number>();
    visibleNodes.forEach(path => {
        const fileName = path.split(/[/\\]/).pop() || path;
        fileNameCounts.set(fileName, (fileNameCounts.get(fileName) || 0) + 1);
    });

    visibleNodes.forEach(path => {
        const fileName = path.split(/[/\\]/).pop() || path;
        
        // Disambiguate if multiple files have the same name
        let label = fileName;
        if ((fileNameCounts.get(fileName) || 0) > 1) {
            const parentDir = path.split(/[/\\]/).slice(-2, -1)[0];
            if (parentDir) {
                label = `${parentDir}/${fileName}`;
            }
        }

        const isTs = fileName.endsWith('.ts') || fileName.endsWith('.tsx');
        const isJs = fileName.endsWith('.js') || fileName.endsWith('.jsx');
        const isVue = fileName.endsWith('.vue');
        const isSvelte = fileName.endsWith('.svelte');
        const isNodeModule = !path.startsWith('/') && !path.startsWith('.');
        const isRoot = path === currentFilePath;
        
        // Check if node has children (outgoing edges) in the full graph
        const hasChildren = fullGraphData.edges.some(e => e.source === path);
        const isExpanded = expandedNodes.has(path) || isRoot; // Root is always expanded effectively
        const isInCycle = nodesInCycles?.has(path) || false;

        let background = 'var(--vscode-editor-background)';
        let border = '1px solid var(--vscode-widget-border)';
        let color = 'var(--vscode-editor-foreground)';
        
        if (isRoot) {
            background = 'var(--vscode-button-background)';
            color = 'var(--vscode-button-foreground)';
            border = '1px solid var(--vscode-button-background)';
        } else if (isNodeModule) {
            background = 'var(--vscode-sideBar-background)';
            border = '1px dashed var(--vscode-disabledForeground)';
        } else if (isTs) {
            border = '1px solid #3178c6'; // TS Blue
        } else if (isJs) {
            border = '1px solid #f7df1e'; // JS Yellow
        } else if (isVue) {
            border = '1px solid #41b883'; // Vue Green
        } else if (isSvelte) {
            border = '1px solid #ff3e00'; // Svelte Orange
        }

        newNodes.push({
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
              isRoot,
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          position: { x: 0, y: 0 },
          type: 'custom', // Use custom node type
          style: {
            background,
            color,
            border,
            borderRadius: 4,
            padding: 10,
            fontSize: '12px',
            width: nodeWidth,
            fontWeight: isRoot ? 'bold' : 'normal',
            cursor: 'pointer',
            textDecoration: isRoot ? 'underline' : 'none',
            textAlign: 'center',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
            fontFamily: 'var(--vscode-font-family)',
          },
        });
    });

    // Create React Flow Edges
    const newEdges: Edge[] = visibleEdges.map(edge => {
        const edgeId = `${edge.source}-${edge.target}`;
        const isCircular = circularEdges.has(edgeId);
        
        return {
            id: edgeId,
            source: edge.source,
            target: edge.target,
            animated: true,
            style: isCircular 
                ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' } // Red dashed for cycles
                : { stroke: 'var(--vscode-editor-foreground)' },
            label: isCircular ? 'Cycle' : undefined,
            labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
            labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
        };
    });

    // Apply Layout
    const layouted = getLayoutedElements(newNodes, newEdges);

    setNodes(layouted.nodes);
    setEdges(layouted.edges);

    setNodes(layouted.nodes);
    setEdges(layouted.edges);

  }, [fullGraphData, expandedNodes, currentFilePath, setNodes, setEdges, toggleNode, circularEdges, expandAll]);

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

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const handleMessage = (event: MessageEvent) => {
      const message = event.data as ExtensionToWebviewMessage;
      
      if (message.command === 'updateGraph') {
        // Debounce updates to prevent flickering
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            console.log('Graph-It-Live Webview: Processing update', message.filePath);
            setCurrentFilePath(message.filePath);
            setFullGraphData(message.data);
            // Set expandAll from message if present
            if (message.expandAll !== undefined) {
                setExpandAll(message.expandAll);
                
                // If expandAll is true, we need to populate expandedNodes
                if (message.expandAll && message.data) {
                    const allNodesWithChildren = new Set<string>();
                    if (message.filePath) allNodesWithChildren.add(message.filePath);
                    message.data.edges.forEach(edge => {
                        allNodesWithChildren.add(edge.source);
                    });
                    setExpandedNodes(allNodesWithChildren);
                } else {
                    // Reset expanded nodes on new graph load, or keep root expanded
                    setExpandedNodes(new Set([message.filePath])); 
                }
            } else {
                // Default behavior if expandAll not provided
                setExpandedNodes(new Set([message.filePath])); 
            }
        }, 100);
      } else if (message.command === 'expandedGraph' || message.command === 'referencingFiles') {
        console.log('Graph-It-Live Webview: Received referencingFiles/expandedGraph', message.data);
        // Merge new graph data with existing
        const currentData = fullGraphDataRef.current;
        if (currentData && message.data) {
          console.log('Graph-It-Live Webview: Merging data. Current edges:', currentData.edges.length, 'New edges:', message.data.edges.length);
          const mergedData = mergeGraphData(currentData, message.data);
          console.log('Graph-It-Live Webview: Merged edges:', mergedData.edges.length);
          
          setFullGraphData(mergedData);
          
          // Auto-expand the node that was requested
          setExpandedNodes(prev => new Set([...prev, message.nodeId]));
        } else {
            console.warn('Graph-It-Live Webview: Cannot merge, fullGraphData is missing', !!currentData);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
        window.removeEventListener('message', handleMessage);
        clearTimeout(timeoutId);
    };
  }, []);

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
  };
};
