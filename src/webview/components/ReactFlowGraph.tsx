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
import { nodeHeight, minNodeWidth, maxNodeWidth, charWidth, actionButtonSize, cycleIndicatorSize } from '../utils/nodeUtils';
import { getLogger } from '../../shared/logger';

/** Logger instance for ReactFlowGraph */
const log = getLogger('ReactFlowGraph');

// Normalize path for cross-platform comparison (convert backslashes to forward slashes)
const normalizePath = (filePath: string): string => {
    return filePath.replaceAll('\\', '/');
};

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
    // Toggle to show/hide parent referencing files for the current root
    showParents?: boolean;
    onToggleParents?: (path: string) => void;
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

// Dark gray for node_modules and unknown types
const EXTERNAL_PACKAGE_COLOR = '#6b6b6b';

// Check if a path represents a node_modules package or external dependency
const isExternalPackage = (path: string): boolean => {
    // Node modules don't have file extensions or start with relative/absolute path markers
    // They look like: 'react', 'lodash', '@types/node', 'vscode', etc.
    if (!path) return false;
    
    // Has a known file extension = not external
    for (const ext of Object.keys(FILE_TYPE_COLORS)) {
        if (path.endsWith(ext)) return false;
    }
    
    // Starts with . or / or drive letter = local file
    if (path.startsWith('.') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
        return false;
    }
    
    // Contains path separators but no extension = likely local file without extension
    if ((path.includes('/') || path.includes('\\')) && !path.includes('node_modules')) {
        return false;
    }
    
    // Everything else is likely a node_modules package
    return true;
};

// Get border color based on file extension or package type
const getFileBorderColor = (fileName: string, fullPath?: string): string => {
    // Check if it's an external package first
    if (isExternalPackage(fullPath || fileName)) {
        return EXTERNAL_PACKAGE_COLOR;
    }
    
    for (const [ext, color] of Object.entries(FILE_TYPE_COLORS)) {
        if (fileName.endsWith(ext)) {
            return color;
        }
    }
    return EXTERNAL_PACKAGE_COLOR; // Unknown file types also get dark gray
};

// Custom node component
const FileNode = ({ data }: NodeProps) => {
    const isRoot = data.isRoot;
    // no-op: we don't need to show button based on hasReferencingFiles, we allow toggling regardless
    const isInCycle = data.isInCycle;
    const borderColor = getFileBorderColor(data.label, data.fullPath);
    const isExternal = isExternalPackage(data.fullPath || data.label);

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
                border: isExternal 
                    ? `2px dashed ${borderColor}`
                    : `2px solid ${borderColor}`,
                borderRadius: 4,
                padding: '0 12px',
                fontSize: 12,
                fontWeight: isRoot ? 'bold' : 'normal',
                fontStyle: isExternal ? 'italic' : 'normal',
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
                        top: -(cycleIndicatorSize / 2),
                        right: -(cycleIndicatorSize / 2),
                        width: cycleIndicatorSize,
                        height: cycleIndicatorSize,
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
                            right: -(actionButtonSize / 2),
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: actionButtonSize,
                        height: actionButtonSize,
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
                            right: -(actionButtonSize / 2),
                            bottom: -(actionButtonSize / 2),
                    width: actionButtonSize,
                    height: actionButtonSize,
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
                ✨
            </button>

            {/* Find references button (root only) - shown only if backend signals parents exist or graph already shows parents */}
            {isRoot && (data.hasReferencingFiles || (data.parentCount && data.parentCount > 0)) && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onToggleParents?.();
                    }}
                    aria-label={data.isParentsVisible ? 'Hide referencing files' : 'Show referencing files'}
                    title={data.isParentsVisible ? 'Hide referencing files' : 'Show referencing files'}
                    style={{
                        position: 'absolute',
                        left: -(actionButtonSize + 4),
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: actionButtonSize,
                        height: actionButtonSize,
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
                    {data.isParentsVisible ? '◀' : '▶'}
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

// Calculate node width based on label length
const calculateNodeWidth = (label: string): number => {
    const estimatedWidth = label.length * charWidth + 24; // 24px for padding
    return Math.max(minNodeWidth, Math.min(maxNodeWidth, estimatedWidth));
};

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
        const width = (node.style?.width as number) || minNodeWidth;
        dagreGraph.setNode(node.id, { width, height: nodeHeight });
    });

    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        const width = (node.style?.width as number) || minNodeWidth;
        // Set handle positions for proper edge connections
        node.targetPosition = Position.Left;
        node.sourcePosition = Position.Right;
        return {
            ...node,
            position: {
                // Shift dagre center anchor to React Flow top-left anchor
                x: nodeWithPosition.x - width / 2,
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

    // Extracted DFS helper to reduce nesting
    const dfs = (
        node: string, 
        path: string[],
        onCycleFound: (cyclePath: string[], currentNode: string, neighbor: string) => void
    ): boolean => {
        visited.add(node);
        recursionStack.add(node);

        for (const neighbor of adjacency.get(node) || []) {
            if (!visited.has(neighbor)) {
                if (dfs(neighbor, [...path, node], onCycleFound)) {
                    return true;
                }
            } else if (recursionStack.has(neighbor)) {
                onCycleFound(path, node, neighbor);
                return true;
            }
        }

        recursionStack.delete(node);
        return false;
    };

    const handleCycleFound = (path: string[], currentNode: string, neighbor: string): void => {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
            path.slice(cycleStart).forEach((n) => cycleNodes.add(n));
        }
        cycleNodes.add(neighbor);
        cycleNodes.add(currentNode);
    };

    adjacency.forEach((_, node) => {
        if (!visited.has(node)) {
            dfs(node, [], handleCycleFound);
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
    showParents = false,
    onToggleParents,
}) => {
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const requestedParentsRef = React.useRef<Set<string>>(new Set());
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    // Synchronize expandedNodes with expandAll prop
    useEffect(() => {
        log.debug('ReactFlowGraph: expandAll changed to:', expandAll);
        if (expandAll && data?.nodes && data?.edges) {
            // Expand all nodes that have children
            const allNodesWithChildren = new Set<string>();
            
            // Add current file as root
            if (currentFilePath) {
                allNodesWithChildren.add(normalizePath(currentFilePath));
            }
            
            // Add all source nodes (nodes that have outgoing edges)
            data.edges.forEach(edge => {
                allNodesWithChildren.add(normalizePath(edge.source));
            });
            
            log.debug('ReactFlowGraph: Expanding all nodes:', allNodesWithChildren.size);
            setExpandedNodes(allNodesWithChildren);
        } else if (!expandAll) {
            // Collapse all, keep only root
            const rootSet = currentFilePath ? new Set([normalizePath(currentFilePath)]) : new Set<string>();
            log.debug('ReactFlowGraph: Collapsing all nodes, keeping root:', rootSet.size);
            setExpandedNodes(rootSet);
        }
    }, [expandAll, data, currentFilePath]);

    // Auto-request referencing files for root when the incoming data doesn't include parents
    // Clear previously requested parents when we navigate to a new root path
    useEffect(() => {
        requestedParentsRef.current.clear();
    }, [currentFilePath]);

    // We no longer automatically request referencing files on load. The 'Find references' button
    // will be shown only when the backend reports that a node has parents (via parentCounts),
    // and the user can request referencing files explicitly by clicking the button.

    // Toggle handler extracted to reduce nesting
    const createToggleHandler = useCallback((path: string) => {
        return () => {
            setExpandedNodes((prev) => {
                const next = new Set(prev);
                if (next.has(path)) {
                    next.delete(path);
                } else {
                    next.add(path);
                }
                return next;
            });
        };
    }, []);

    // Build nodes and edges from data
    const { initialNodes, initialEdges, cycles } = useMemo(() => {
        // Normalize currentFilePath for comparison with graph nodes (which are normalized on backend)
        const normalizedCurrentPath = normalizePath(currentFilePath);
        
        log.debug('ReactFlowGraph useMemo: Building graph with:', {
            nodes: data?.nodes?.length || 0,
            edges: data?.edges?.length || 0,
            currentFilePath,
            normalizedCurrentPath,
            expandAll,
            expandedNodesSize: expandedNodes.size,
            expandedNodesArray: Array.from(expandedNodes).slice(0, 5),
            showParents
        });
        
        if (!data?.nodes?.length) {
            log.debug('ReactFlowGraph: No nodes in data, returning empty');
            return { initialNodes: [], initialEdges: [], cycles: new Set<string>() };
        }

        const cycles = detectCycles(data.edges);
        const getLabel = (path: string) => data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

        // Build adjacency for children (source → target means source imports target)
        const children = new Map<string, string[]>();
        // Build reverse adjacency for parents (who imports this file)
        const parents = new Map<string, string[]>();
        
        data.edges.forEach(({ source, target }) => {
            const ns = normalizePath(source);
            const nt = normalizePath(target);
            if (!children.has(ns)) children.set(ns, []);
            children.get(ns)!.push(nt);
            if (!parents.has(nt)) parents.set(nt, []);
            parents.get(nt)!.push(ns);
        });

        // Calculate visible nodes: include both children AND parents of current file
        const visibleNodes = new Set<string>();
        
        // CRITICAL: Always ensure root node is visible first, before any other logic
        // This prevents race conditions where parents are added but root/children are lost
        visibleNodes.add(normalizedCurrentPath);
        
        // Add all parents (files that import currentFilePath) only when showParents is enabled
        const fileParents = parents.get(normalizedCurrentPath) || [];
        console.debug('ReactFlowGraph: fileParents for root', normalizedCurrentPath, fileParents, 'showParents:', showParents);
        if (showParents) {
            fileParents.forEach((p) => visibleNodes.add(p));
        }
        
        // Traverse children starting from current file
        const queue = [normalizedCurrentPath];
        const visited = new Set<string>(); // Track processed nodes to avoid infinite loops

        while (queue.length > 0) {
            const node = queue.shift()!;
            if (visited.has(node)) continue; // Skip if already processed
            visited.add(node);
            visibleNodes.add(node); // Re-add to ensure it's in visibleNodes (idempotent for Set)

            const nodeChildren = children.get(node) || [];
            // Show children if:
            // 1. expandAll is true (global expand state)
            // 2. node is manually expanded (in expandedNodes)
            // 3. node is the root (currentFilePath) - always show immediate children
            const shouldShowChildren = expandAll || expandedNodes.has(node) || node === normalizedCurrentPath;
            
            if (shouldShowChildren) {
                nodeChildren.forEach((child) => queue.push(child));
            }
        }

        // Create node data objects
        const createNodeData = (path: string, label: string) => {
            const parentCountRaw = data.parentCounts?.[path];
            const parentCount = typeof parentCountRaw === 'number' && parentCountRaw > 0 ? parentCountRaw : undefined;
            return ({
            label,
            fullPath: path,
            isRoot: path === normalizedCurrentPath,
            isParent: fileParents.includes(path),
            isInCycle: cycles.has(path),
            hasChildren: (children.get(path) || []).length > 0,
            // Node is visually expanded if expandAll is true OR it's in expandedNodes
            isExpanded: expandAll || expandedNodes.has(path) || path === normalizedCurrentPath,
            hasReferencingFiles: ((parents.get(path) || []).length > 0) || (parentCount ? parentCount > 0 : false),
            parentCount,
            isParentsVisible: showParents,
            onDrillDown: () => onDrillDown(path),
            onFindReferences: () => onFindReferences(path),
            onToggleParents: () => onToggleParents?.(path),
            onToggle: createToggleHandler(path),
        });
        };

        const nodes: Node[] = Array.from(visibleNodes).map((path) => {
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

        // Create edge style based on circular dependency
        const createEdgeStyle = (isCircular: boolean) => 
            isCircular 
                ? { stroke: '#ff4d4d', strokeWidth: 2, strokeDasharray: '5,5' }
                : { stroke: 'var(--vscode-editor-foreground)' };

        const edges: Edge[] = data.edges
            .map(({ source, target }) => ({ source: normalizePath(source), target: normalizePath(target) }))
            .filter(({ source, target }) => visibleNodes.has(source) && visibleNodes.has(target))
            .map(({ source, target }) => {
                const isCircular = cycles.has(source) && cycles.has(target);

                return {
                    id: `${source}-${target}`,
                    source,
                    target,
                    animated: true,
                    style: createEdgeStyle(isCircular),
                    label: isCircular ? 'Cycle' : undefined,
                    labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
                    labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
                };
            });

        log.debug('ReactFlowGraph: Visible nodes:', visibleNodes.size, 'edges:', edges.length);
        log.debug('ReactFlowGraph: Current file (normalized):', normalizedCurrentPath);
        log.debug('ReactFlowGraph: visibleNodes contains root?', visibleNodes.has(normalizedCurrentPath));
        log.debug('ReactFlowGraph: All data nodes:', data.nodes);
        log.debug('ReactFlowGraph: All data edges:', data.edges);
        
        const layouted = getLayoutedElements(nodes, edges);
        return { initialNodes: layouted.nodes, initialEdges: layouted.edges, cycles };
    }, [data, currentFilePath, expandAll, expandedNodes, showParents, onDrillDown, onFindReferences, onToggleParents, createToggleHandler]);

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
    const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
        onNodeClick(node.id);
    }, [onNodeClick]);

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
                    visibility: 'hidden',
                    top: 10,
                    left: 10,
                    right: 10,
                    zIndex: 1000,
                    display: 'flex',
                    justifyContent: 'space-between',
                    pointerEvents: 'none',
                }}>
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
                                visibility: 'hidden',
                                borderRadius: 4,
                                padding: '6px 12px',
                                cursor: 'pointer',
                                fontSize: 12,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                            }}
                        >
                            ✨ Symbol View
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
                                visibility: 'hidden',
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
                            visibility: 'hidden',
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
                            visibility: 'hidden',
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
                        left: '80%',
                        transform: 'translateX(-80%)',
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
