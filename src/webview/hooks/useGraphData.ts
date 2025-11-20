import React, { useEffect, useCallback } from 'react';
import { Node, Edge, useNodesState, useEdgesState, Position } from 'reactflow';
import dagre from 'dagre';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types';
import { Dependency } from '../../analyzer/types';

// Define VS Code API type
interface VSCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): any;
  setState(state: any): void;
}

declare global {
  function acquireVsCodeApi(): VSCodeApi;
}

// Initialize VS Code API safely
const vscode = (function() {
    try {
        return typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    } catch (e) {
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
  const [currentFilePath, setCurrentFilePath] = React.useState<string>('');

  const processDependencies = useCallback((filePath: string, dependencies: Dependency[]) => {
    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    const nodeMap = new Map<string, boolean>();

    // Helper to add node if not exists
    const addNode = (path: string, isRoot = false) => {
      if (!nodeMap.has(path)) {
        const fileName = path.split('/').pop() || path;
        const isTs = fileName.endsWith('.ts') || fileName.endsWith('.tsx');
        const isJs = fileName.endsWith('.js') || fileName.endsWith('.jsx');
        const isNodeModule = !path.startsWith('/') && !path.startsWith('.');
        
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
        }

        newNodes.push({
          id: path,
          data: { label: fileName },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          position: { x: 0, y: 0 },
          style: {
            background,
            color: isRoot ? 'white' : 'var(--vscode-editor-foreground)',
            border: isRoot ? '2px solid var(--vscode-focusBorder)' : '1px solid var(--vscode-widget-border)',
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
        nodeMap.set(path, true);
      }
    };

    // Add Source Node
    addNode(filePath, true);

    // Add Dependency Nodes and Edges
    dependencies.forEach((dep) => {
        addNode(dep.path);
        
        newEdges.push({
            id: `${filePath}-${dep.path}`,
            source: filePath,
            target: dep.path,
        });
    });

    // Apply Layout
    const layouted = getLayoutedElements(newNodes, newEdges);

    setNodes(layouted.nodes);
    setEdges(layouted.edges);
  }, [setNodes, setEdges]);

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
            processDependencies(message.filePath, message.dependencies);
        }, 100);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
        window.removeEventListener('message', handleMessage);
        clearTimeout(timeoutId);
    };
  }, [processDependencies]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    console.log('[useGraphData] Node clicked:', node.id);
    console.log('[useGraphData] VS Code API available:', !!vscode);
    
    if (vscode) {
      console.log('[useGraphData] Sending openFile message for:', node.id);
      vscode.postMessage({
        command: 'openFile',
        path: node.id,
      });
      console.log('[useGraphData] Message sent successfully');
    } else {
        console.error('[useGraphData] VS Code API not available!');
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

  return { nodes, edges, onNodesChange, onEdgesChange, onNodeClick, currentFilePath, openFile };
};
