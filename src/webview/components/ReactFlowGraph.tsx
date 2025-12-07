import React, { useEffect, useMemo, useCallback, useState } from 'react';
import ReactFlow, {
    Background,
    Controls,
    useReactFlow,
    ReactFlowProvider,
    useNodesInitialized,
    Handle,
    Position,
    NodeProps,
    Node,
    Edge,
    useNodesState,
    useEdgesState,
} from 'reactflow';
// @ts-expect-error - ReactFlow types are complex
import reactFlowStyles from 'reactflow/dist/style.css';
import dagre from 'dagre';
import { GraphData } from '../../shared/types';

// Inject React Flow CSS
if (typeof document !== 'undefined' && !document.getElementById('reactflow-styles')) {
    const style = document.createElement('style');
    style.id = 'reactflow-styles';
    style.textContent = reactFlowStyles;
    document.head.appendChild(style);
}

interface ReactFlowGraphProps {
    data: GraphData;
    currentFilePath: string;
    onNodeClick: (path: string) => void;
    onDrillDown: (path: string) => void;
    onFindReferences: (path: string) => void;
    expandAll: boolean;
    onExpandAllChange: (expand: boolean) => void;
    onRefresh?: () => void;
    onSwitchToSymbol?: () => void;
}

// File type specific border colors
const FILE_TYPE_COLORS: Record<string, string> = {
    '.ts': '#3178c6',      // TS Blue
    '.tsx': '#3178c6',     // TS Blue
    '.js': '#f7df1e',      // JS Yellow
    '.jsx': '#f7df1e',     // JS Yellow
    '.vue': '#41b883',     // Vue Green
    '.svelte': '#ff3e00',  // Svelte Orange
    '.gql': '#e535ab',     // GraphQL Pink
    '.graphql': '#e535ab', // GraphQL Pink
};

// Get border color based on file extension
const getFileBorderColor = (fileName: string): string => {
    for (const [ext, color] of Object.entries(FILE_TYPE_COLORS)) {
        if (fileName.endsWith(ext)) {
            return color;
        }
    }
    return 'var(--vscode-widget-border)';
};

// Custom node component
const FileNode = ({ data }: NodeProps) => {
    const isRoot = data.isRoot;
    const isInCycle = data.isInCycle;
    const borderColor = getFileBorderColor(data.label);

    return (
        <div
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
            }}
            title={data.fullPath}
        >
            <Handle
                type="target"
                position={Position.Left}
                style={{ visibility: 'hidden' }}
            />

            {/* Main node content */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                background: isRoot
                    ? borderColor
                    : 'var(--vscode-editor-background)',
                color: isRoot
                    ? '#000'
                    : 'var(--vscode-editor-foreground)',
                border: `2px solid ${borderColor}`,
                borderRadius: 4,
                padding: '0 12px',
                fontSize: 12,
                fontWeight: isRoot ? 'bold' : 'normal',
                fontFamily: 'var(--vscode-font-family)',
                pointerEvents: 'none',
            }}>
                {data.label}
            </div>

            {/* Cycle indicator */}
            {isInCycle && (
                <div
                    style={{
                        position: 'absolute',
                        top: -4,
                        right: -4,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#dc3545',
                        border: '2px solid var(--vscode-editor-background)',
                        zIndex: 15,
                        pointerEvents: 'none',
                    }}
                    title="Part of circular dependency"
                />
            )}

            {/* Expand/Collapse button */}
            {data.hasChildren && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onToggle?.();
                    }}
                    aria-label={data.isExpanded ? 'Collapse node' : 'Expand node'}
                    style={{
                        position: 'absolute',
                        right: -10,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 14,
                        zIndex: 10,
                        pointerEvents: 'auto',
                        border: '2px solid var(--vscode-editor-background)',
                        padding: 0,
                    }}
                >
                    {data.isExpanded ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14" />
                        </svg>
                    ) : (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                    )}
                </button>
            )}

            {/* Drill down button (symbols) */}
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    data.onDrillDown?.();
                }}
                aria-label="View symbols"
                title="View symbols"
                style={{
                    position: 'absolute',
                    right: -10,
                    bottom: -10,
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: 'var(--vscode-button-secondaryBackground)',
                    color: 'var(--vscode-button-secondaryForeground)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 'bold',
                    zIndex: 10,
                    pointerEvents: 'auto',
                    border: '2px solid var(--vscode-editor-background)',
                    padding: 0,
                }}
            >
                ⚡
            </button>

            {/* Find references button (root only) */}
            {isRoot && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onFindReferences?.();
                    }}
                    aria-label="Find referencing files"
                    title="Find referencing files"
                    style={{
                        position: 'absolute',
                        left: -24,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: 'var(--vscode-button-secondaryBackground)',
                        color: 'var(--vscode-button-secondaryForeground)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 10,
                        fontWeight: 'bold',
                        zIndex: 10,
                        pointerEvents: 'auto',
                        border: '2px solid var(--vscode-editor-background)',
                        padding: 0,
                    }}
                >
                    ◀
                </button>
            )}

            <Handle
                type="source"
                position={Position.Right}
                style={{ visibility: 'hidden' }}
            />
        </div>
    );
};

const nodeTypes = { file: FileNode };

// Layout dimensions (matching main branch)
const nodeWidth = 180;
const nodeHeight = 50;

// Dagre layout helper
const getLayoutedElements = (
    nodes: Node[],
    edges: Edge[],
    direction: 'TB' | 'LR' = 'LR'
): { nodes: Node[]; edges: Edge[] } => {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    dagreGraph.setGraph({ 
        rankdir: direction, 
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

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        // Set handle positions for proper edge connections
        node.targetPosition = Position.Left;
        node.sourcePosition = Position.Right;
        return {
            ...node,
            position: {
                // Shift dagre center anchor to React Flow top-left anchor
                x: nodeWithPosition.x - nodeWidth / 2,
                y: nodeWithPosition.y - nodeHeight / 2,
            },
        };
    });

    return { nodes: layoutedNodes, edges };
};

// Detect cycles in the graph
const detectCycles = (edges: Array<{ source: string; target: string }>): Set<string> => {
    const cycleNodes = new Set<string>();
    const adjacency = new Map<string, string[]>();

    edges.forEach(({ source, target }) => {
        if (!adjacency.has(source)) adjacency.set(source, []);
        adjacency.get(source)!.push(target);
    });

    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (node: string, path: string[]): boolean => {
        visited.add(node);
        recursionStack.add(node);

        for (const neighbor of adjacency.get(node) || []) {
            if (!visited.has(neighbor)) {
                if (dfs(neighbor, [...path, node])) {
                    return true;
                }
            } else if (recursionStack.has(neighbor)) {
                // Found cycle - mark all nodes in cycle
                const cycleStart = path.indexOf(neighbor);
                if (cycleStart !== -1) {
                    path.slice(cycleStart).forEach((n) => cycleNodes.add(n));
                }
                cycleNodes.add(neighbor);
                cycleNodes.add(node);
                return true;
            }
        }

        recursionStack.delete(node);
        return false;
    };

    adjacency.forEach((_, node) => {
        if (!visited.has(node)) {
            dfs(node, []);
        }
    });

    return cycleNodes;
};

// Inner component that uses ReactFlow hooks
const ReactFlowGraphContent: React.FC<ReactFlowGraphProps> = ({
    data,
    currentFilePath,
    onNodeClick,
    onDrillDown,
    onFindReferences,
    expandAll,
    onExpandAllChange,
    onRefresh,
    onSwitchToSymbol,
}) => {
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    // Build nodes and edges from data
    const { initialNodes, initialEdges, cycles } = useMemo(() => {
        if (!data?.nodes?.length) {
            return { initialNodes: [], initialEdges: [], cycles: new Set<string>() };
        }

        const cycles = detectCycles(data.edges);
        const getLabel = (path: string) => data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

        // Build adjacency for children (source → target means source imports target)
        const children = new Map<string, string[]>();
        // Build reverse adjacency for parents (who imports this file)
        const parents = new Map<string, string[]>();
        
        data.edges.forEach(({ source, target }) => {
            if (!children.has(source)) children.set(source, []);
            children.get(source)!.push(target);
            if (!parents.has(target)) parents.set(target, []);
            parents.get(target)!.push(source);
        });

        // Calculate visible nodes: include both children AND parents of current file
        const visibleNodes = new Set<string>();
        
        // Add all parents (files that import currentFilePath) - always visible
        const fileParents = parents.get(currentFilePath) || [];
        fileParents.forEach(p => visibleNodes.add(p));
        
        // Traverse children starting from current file
        const queue = [currentFilePath];

        while (queue.length > 0) {
            const node = queue.shift()!;
            if (visibleNodes.has(node)) continue;
            visibleNodes.add(node);

            const nodeChildren = children.get(node) || [];
            if (expandAll || expandedNodes.has(node) || node === currentFilePath) {
                nodeChildren.forEach((child) => queue.push(child));
            }
        }

        const nodes: Node[] = Array.from(visibleNodes).map((path) => ({
            id: path,
            type: 'file',
            position: { x: 0, y: 0 },
            style: { width: nodeWidth, height: nodeHeight },
            data: {
                label: getLabel(path),
                fullPath: path,
                isRoot: path === currentFilePath,
                isParent: fileParents.includes(path), // Mark parent nodes
                isInCycle: cycles.has(path),
                hasChildren: (children.get(path) || []).length > 0,
                isExpanded: expandAll || expandedNodes.has(path),
                onDrillDown: () => onDrillDown(path),
                onFindReferences: () => onFindReferences(path),
                onToggle: () => {
                    setExpandedNodes((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) {
                            next.delete(path);
                        } else {
                            next.add(path);
                        }
                        return next;
                    });
                },
            },
        }));

        const edges: Edge[] = data.edges
            .filter(({ source, target }) => visibleNodes.has(source) && visibleNodes.has(target))
            .map(({ source, target }) => {
                const isCircular = cycles.has(source) && cycles.has(target);
                const edgeId = `${source}-${target}`;
                
                return {
                    id: edgeId,
                    source,
                    target,
                    animated: true,
                    style: isCircular 
                        ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' }
                        : { stroke: 'var(--vscode-editor-foreground)' },
                    label: isCircular ? 'Cycle' : undefined,
                    labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
                    labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
                };
            });

        const layouted = getLayoutedElements(nodes, edges);
        return { initialNodes: layouted.nodes, initialEdges: layouted.edges, cycles };
    }, [data, currentFilePath, expandAll, expandedNodes, onDrillDown, onFindReferences]);

    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    // Update nodes when data changes
    useEffect(() => {
        setNodes(initialNodes);
        setEdges(initialEdges);
    }, [initialNodes, initialEdges, setNodes, setEdges]);

    // Fit view when nodes are initialized
    useEffect(() => {
        if (nodesInitialized && nodes.length > 0) {
            setTimeout(() => fitView({ padding: 0.2, duration: 500 }), 100);
        }
    }, [nodesInitialized, nodes.length, fitView]);

    // Handle node click
    const handleNodeClick = useCallback(
        (_: React.MouseEvent, node: Node) => {
            onNodeClick(node.id);
        },
        [onNodeClick]
    );

    return (
        <div style={{ width: '100%', height: '100vh', position: 'relative' }}>
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
                proOptions={{ hideAttribution: true }}
            >
                <Background />
                <Controls />
            </ReactFlow>

            {/* Top bar */}
            <div
                style={{
                    position: 'absolute',
                    top: 10,
                    left: 10,
                    right: 10,
                    zIndex: 1000,
                    display: 'flex',
                    justifyContent: 'space-between',
                    pointerEvents: 'none',
                }}
            >
                {/* Left buttons */}
                <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto' }}>
                    {onSwitchToSymbol && (
                        <button
                            onClick={onSwitchToSymbol}
                            title="Switch to Symbol View"
                            style={{
                                background: 'var(--vscode-button-secondaryBackground)',
                                color: 'var(--vscode-button-secondaryForeground)',
                                border: 'none',
                                borderRadius: 4,
                                padding: '6px 12px',
                                cursor: 'pointer',
                                fontSize: 12,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                            }}
                        >
                            ⚡ Symbol View
                        </button>
                    )}
                </div>

                {/* Right buttons */}
                <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto' }}>
                    {onRefresh && (
                        <button
                            onClick={onRefresh}
                            title="Refresh graph from current file"
                            aria-label="Refresh"
                            style={{
                                background: 'var(--vscode-button-secondaryBackground)',
                                color: 'var(--vscode-button-secondaryForeground)',
                                border: '1px solid var(--vscode-button-border)',
                                borderRadius: 4,
                                padding: '6px 8px',
                                cursor: 'pointer',
                                fontSize: 14,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            ↻
                        </button>
                    )}
                    <button
                        onClick={() => onExpandAllChange(!expandAll)}
                        style={{
                            background: 'var(--vscode-button-secondaryBackground)',
                            color: 'var(--vscode-button-secondaryForeground)',
                            border: '1px solid var(--vscode-button-border)',
                            borderRadius: 4,
                            padding: '6px 12px',
                            cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >
                        {expandAll ? '⊟ Collapse All' : '⊞ Expand All'}
                    </button>
                    <div
                        style={{
                            background: 'var(--vscode-editor-background)',
                            padding: '6px 10px',
                            borderRadius: 4,
                            border: '1px solid var(--vscode-widget-border)',
                            fontSize: 11,
                            color: 'var(--vscode-descriptionForeground)',
                        }}
                    >
                        📁 File Dependencies
                    </div>
                </div>
            </div>

            {/* Legend */}
            {cycles.size > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 50,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 1000,
                        background: 'var(--vscode-editor-background)',
                        padding: '8px 12px',
                        borderRadius: 4,
                        border: '1px solid var(--vscode-widget-border)',
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                    }}
                >
                    <div
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: '#dc3545',
                        }}
                    />
                    <span>Circular dependency ({cycles.size} files)</span>
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
