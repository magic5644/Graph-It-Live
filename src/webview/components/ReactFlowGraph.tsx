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

const MAX_RENDER_NODES = 400;
const MAX_CYCLE_DETECT_EDGES = 3000;
const MAX_PROCESS_EDGES = 20000;
const MAX_RENDER_EDGES = 1500;

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

// Lightweight spinner animation for expansion overlay
if (typeof document !== 'undefined' && !document.getElementById('gil-spin-style')) {
    const spin = document.createElement('style');
    spin.id = 'gil-spin-style';
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
    onNodeClick: (path: string) => void;
    onDrillDown: (path: string) => void;
    onFindReferences: (path: string) => void;
    onExpandNode?: (path: string) => void;
    autoExpandNodeId?: string | null;
    expandAll: boolean;
    onExpandAllChange: (expand: boolean) => void;
    onRefresh?: () => void;
    onSwitchToSymbol?: () => void;
    // Toggle to show/hide parent referencing files for the current root
    showParents?: boolean;
    onToggleParents?: (path: string) => void;
    expansionState?: {
        nodeId: string;
        status: 'started' | 'in-progress' | 'completed' | 'cancelled' | 'error';
        processed?: number;
        total?: number;
        message?: string;
    } | null;
    onCancelExpand?: (nodeId?: string) => void;
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
                        // If currently expanded, collapse locally only.
                        // If collapsed, request backend expansion and mark as expanded.
                        if (data.isExpanded) {
                            data.onToggle?.();
                        } else {
                            data.onExpandRequest?.();
                        }
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

const NODE_TYPES = { file: FileNode } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

// Calculate node width based on label length
const calculateNodeWidth = (label: string): number => {
    const estimatedWidth = label.length * charWidth + 24; // 24px for padding
    return Math.max(minNodeWidth, Math.min(maxNodeWidth, estimatedWidth));
};

const fastLayout = (
    nodes: Node[],
    edges: Edge[],
    rootId: string,
): { nodes: Node[]; edges: Edge[] } => {
    const root = normalizePath(rootId);
    const children = new Map<string, string[]>();
    edges.forEach((edge) => {
        const source = normalizePath(edge.source);
        const target = normalizePath(edge.target);
        if (!children.has(source)) children.set(source, []);
        children.get(source)!.push(target);
    });

    const depth = new Map<string, number>();
    const queue: string[] = [root];
    depth.set(root, 0);

    for (let i = 0; i < queue.length; i++) {
        const current = queue[i]!;
        const currentDepth = depth.get(current) ?? 0;
        const nextDepth = currentDepth + 1;
        for (const child of children.get(current) || []) {
            if (!depth.has(child)) {
                depth.set(child, nextDepth);
                queue.push(child);
            }
        }
    }

    const nodesByDepth = new Map<number, Node[]>();
    const unconnected: Node[] = [];
    for (const node of nodes) {
        const d = depth.get(normalizePath(node.id));
        if (typeof d === 'number') {
            if (!nodesByDepth.has(d)) nodesByDepth.set(d, []);
            nodesByDepth.get(d)!.push(node);
        } else {
            unconnected.push(node);
        }
    }

    const xStep = 260;
    const yStep = nodeHeight + 24;
    const positioned: Node[] = [];
    const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);
    for (const d of sortedDepths) {
        const group = nodesByDepth.get(d)!;
        group.forEach((node, idx) => {
            positioned.push({
                ...node,
                position: { x: d * xStep, y: idx * yStep },
                targetPosition: Position.Left,
                sourcePosition: Position.Right,
            });
        });
    }

    const maxDepth = sortedDepths.length ? sortedDepths[sortedDepths.length - 1]! : 0;
    const unconnectedX = (maxDepth + 1) * xStep;
    unconnected.forEach((node, idx) => {
        positioned.push({
            ...node,
            position: { x: unconnectedX, y: idx * yStep },
            targetPosition: Position.Left,
            sourcePosition: Position.Right,
        });
    });

    return { nodes: positioned, edges };
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
    onExpandNode,
    autoExpandNodeId,
    expandAll,
    onExpandAllChange,
    onRefresh,
    onSwitchToSymbol,
    showParents = false,
    onToggleParents,
    expansionState,
    onCancelExpand,
}) => {
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const requestedParentsRef = React.useRef<Set<string>>(new Set());
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    // Expand/collapse all should NOT reset manual expansion when data changes.
    // We only collapse when expandAll flips to false, and we only compute expandAll set when expandAll is true.
    useEffect(() => {
        if (expandAll) return;
        const rootSet = currentFilePath ? new Set([normalizePath(currentFilePath)]) : new Set<string>();
        log.debug('ReactFlowGraph: Collapsing all nodes, keeping root:', rootSet.size);
        setExpandedNodes(rootSet);
    }, [expandAll, currentFilePath]);

    useEffect(() => {
        if (!expandAll || !data?.edges) return;
        const allNodesWithChildren = new Set<string>();

        if (currentFilePath) {
            allNodesWithChildren.add(normalizePath(currentFilePath));
        }
        const edgesForSources = data.edges.length > MAX_PROCESS_EDGES ? data.edges.slice(0, MAX_PROCESS_EDGES) : data.edges;
        edgesForSources.forEach((edge) => {
            allNodesWithChildren.add(normalizePath(edge.source));
        });
        log.debug('ReactFlowGraph: Expanding all nodes:', allNodesWithChildren.size);
        setExpandedNodes(allNodesWithChildren);
    }, [expandAll, data?.edges, currentFilePath]);

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
    const handleExpandRequest = useCallback((path: string) => {
        const normalized = normalizePath(path);
        onExpandNode?.(normalized);
        setExpandedNodes((prev) => new Set(prev).add(normalized));
    }, [onExpandNode]);

    // Auto-expand node when backend sends expandedGraph
    useEffect(() => {
        if (!autoExpandNodeId) return;
        const normalized = normalizePath(autoExpandNodeId);
        setExpandedNodes((prev) => new Set(prev).add(normalized));
    }, [autoExpandNodeId]);

    // Build nodes and edges from data
    const { initialNodes, initialEdges, cycles, edgesTruncated, renderEdgesTruncated } = useMemo(() => {
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

        const edgesTruncated = data.edges.length > MAX_PROCESS_EDGES;
        const edgesForProcessing = edgesTruncated ? data.edges.slice(0, MAX_PROCESS_EDGES) : data.edges;

        const cycles = edgesForProcessing.length <= MAX_CYCLE_DETECT_EDGES ? detectCycles(edgesForProcessing) : new Set<string>();
        const getLabel = (path: string) => data.nodeLabels?.[path] || path.split(/[/\\]/).pop() || path;

        // Build adjacency for children (source → target means source imports target)
        const children = new Map<string, string[]>();
        // Build reverse adjacency for parents (who imports this file)
        const parents = new Map<string, string[]>();
        
        edgesForProcessing.forEach(({ source, target }) => {
            const ns = normalizePath(source);
            const nt = normalizePath(target);
            if (!children.has(ns)) children.set(ns, []);
            children.get(ns)!.push(nt);
            if (!parents.has(nt)) parents.set(nt, []);
            parents.get(nt)!.push(ns);
        });

        // Calculate visible nodes: include both children AND parents of current file
        const visibleNodes = new Set<string>();
        let isTruncated = false;
        
        // CRITICAL: Always ensure root node is visible first, before any other logic
        // This prevents race conditions where parents are added but root/children are lost
        visibleNodes.add(normalizedCurrentPath);
        
        // Add all parents (files that import currentFilePath) only when showParents is enabled
        const fileParents = parents.get(normalizedCurrentPath) || [];
        const fileParentsSet = new Set(fileParents);
        console.debug('ReactFlowGraph: fileParents for root', normalizedCurrentPath, fileParents, 'showParents:', showParents);
        if (showParents) {
            for (const parent of fileParents) {
                if (visibleNodes.size >= MAX_RENDER_NODES) {
                    isTruncated = true;
                    break;
                }
                visibleNodes.add(parent);
            }
        }
        
        // Traverse children starting from current file
        const queue = [normalizedCurrentPath];
        const visited = new Set<string>(); // Track processed nodes to avoid infinite loops

        for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
            const node = queue[queueIndex]!;
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
                for (const child of nodeChildren) {
                    if (visibleNodes.size >= MAX_RENDER_NODES) {
                        isTruncated = true;
                        break;
                    }
                    queue.push(child);
                }
            }
            if (isTruncated) break;
        }

        // Create node data objects
        const createNodeData = (path: string, label: string) => {
            const parentCountRaw = data.parentCounts?.[path];
            const parentCount = typeof parentCountRaw === 'number' && parentCountRaw > 0 ? parentCountRaw : undefined;
            return ({
            label,
            fullPath: path,
            isRoot: path === normalizedCurrentPath,
            isParent: fileParentsSet.has(path),
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
            onExpandRequest: () => handleExpandRequest(path),
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

        const seenEdgeIds = new Set<string>();
        let duplicateEdgesSkipped = 0;
        let edges: Edge[] = edgesForProcessing
            .map(({ source, target }) => ({ source: normalizePath(source), target: normalizePath(target) }))
            .filter(({ source, target }) => visibleNodes.has(source) && visibleNodes.has(target))
            .flatMap(({ source, target }) => {
                const id = `${source}->${target}`;
                if (seenEdgeIds.has(id)) {
                    duplicateEdgesSkipped += 1;
                    return [];
                }
                seenEdgeIds.add(id);

                const isCircular = cycles.has(source) && cycles.has(target);
                return [{
                    id,
                    source,
                    target,
                    animated: true,
                    style: createEdgeStyle(isCircular),
                    label: isCircular ? 'Cycle' : undefined,
                    labelStyle: isCircular ? { fill: '#ff4d4d', fontWeight: 'bold' } : undefined,
                    labelBgStyle: isCircular ? { fill: 'var(--vscode-editor-background)' } : undefined,
                }];
            });
        const renderEdgesTruncated = edges.length > MAX_RENDER_EDGES;
        if (renderEdgesTruncated) {
            edges = edges.slice(0, MAX_RENDER_EDGES);
        }

        log.debug(
            'ReactFlowGraph: Visible nodes:',
            visibleNodes.size,
            'edges:',
            edges.length,
            'duplicateEdgesSkipped:',
            duplicateEdgesSkipped,
            'truncatedNodes:',
            isTruncated,
            'truncatedEdges:',
            edgesTruncated,
        );
        log.debug('ReactFlowGraph: Current file (normalized):', normalizedCurrentPath, 'rootVisible:', visibleNodes.has(normalizedCurrentPath));
        
        const MAX_DAGRE_NODES = 350;
        const layouted = nodes.length > MAX_DAGRE_NODES
            ? fastLayout(nodes, edges, normalizedCurrentPath)
            : getLayoutedElements(nodes, edges);

        return { initialNodes: layouted.nodes, initialEdges: layouted.edges, cycles, edgesTruncated, renderEdgesTruncated };
    }, [data, currentFilePath, expandAll, expandedNodes, showParents, onDrillDown, onFindReferences, onToggleParents, createToggleHandler, handleExpandRequest]);

    const isTruncated = (initialNodes.length >= MAX_RENDER_NODES);

    const renderExpansionOverlay = () => {
        if (!expansionState) return null;
        const isRunning = expansionState.status === 'started' || expansionState.status === 'in-progress';
        const processed = typeof expansionState.processed === 'number' ? expansionState.processed : undefined;
        const total = typeof expansionState.total === 'number' ? expansionState.total : undefined;
        const showTotals = (typeof processed === 'number' && processed > 0) || (typeof total === 'number' && total > 0);
        const statusLabel = (() => {
            switch (expansionState.status) {
                case 'started':
                case 'in-progress':
                    return 'Expansion en cours';
                case 'completed':
                    return 'Expansion terminée';
                case 'cancelled':
                    return 'Expansion annulée';
                case 'error':
                    return 'Erreur pendant l’expansion';
                default:
                    return 'Expansion';
            }
        })();

        const fileLabel = expansionState.nodeId.split(/[/\\]/).pop() || expansionState.nodeId;

        return (
            <div
                style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    zIndex: 20,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: 'var(--vscode-editor-background)',
                    border: '1px solid var(--vscode-focusBorder)',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                    minWidth: 260,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                    <div
                        style={{
                            width: 14,
                            height: 14,
                            borderRadius: '50%',
                            border: '2px solid var(--vscode-editor-foreground)',
                            borderTopColor: 'transparent',
                            animation: isRunning ? 'gil-spin 0.9s linear infinite' : 'none',
                        }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontWeight: 600 }}>{statusLabel}</span>
                        <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                            {fileLabel}
                        </span>
                        {showTotals && (
                            <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                                {typeof processed === 'number' ? processed : '?'}
                                {typeof total === 'number' ? ` / ${total}` : ''}
                            </span>
                        )}
                        {!showTotals && isRunning && (
                            <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                                Découverte des dépendances…
                            </span>
                        )}
                        {expansionState.message && (
                            <span style={{
                                fontSize: 12,
                                color: expansionState.status === 'error'
                                    ? 'var(--vscode-errorForeground)'
                                    : 'var(--vscode-descriptionForeground)',
                            }}>
                                {expansionState.message}
                            </span>
                        )}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => onCancelExpand?.(expansionState.nodeId)}
                    disabled={!isRunning}
                    style={{
                        padding: '6px 10px',
                        borderRadius: 4,
                        border: '1px solid var(--vscode-button-border, transparent)',
                        background: isRunning ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
                        color: isRunning ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
                        cursor: isRunning ? 'pointer' : 'not-allowed',
                        fontSize: 12,
                        fontWeight: 600,
                    }}
                >
                    Annuler
                </button>
            </div>
        );
    };

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

    // Fit view when the webview/container is resized (better UX than requiring a manual "zoom to fit")
    useEffect(() => {
        if (!nodesInitialized || nodes.length === 0) return;
        const element = containerRef.current;
        if (!element) return;

        let timeout: ReturnType<typeof setTimeout> | null = null;
        let rafId: number | null = null;

        const scheduleFit = () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    fitView({ padding: 0.2, duration: 200 });
                });
            }, 60);
        };

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => scheduleFit())
            : null;

        resizeObserver?.observe(element);
        window.addEventListener('resize', scheduleFit);

        return () => {
            window.removeEventListener('resize', scheduleFit);
            resizeObserver?.disconnect();
            if (timeout) clearTimeout(timeout);
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [nodesInitialized, nodes.length, fitView]);

    // Handle node click
    const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
        onNodeClick(node.id);
    }, [onNodeClick]);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100vh', position: 'relative' }}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={handleNodeClick}
                nodeTypes={NODE_TYPES}
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
            {renderExpansionOverlay()}
            {isTruncated && (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        left: 12,
                        zIndex: 10,
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'var(--vscode-editor-background)',
                        border: '1px solid var(--vscode-widget-border)',
                        color: 'var(--vscode-descriptionForeground)',
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                        maxWidth: 420,
                    }}
                >
                    Graphe trop volumineux : affichage limité à {MAX_RENDER_NODES} nœuds pour éviter un crash.
                </div>
            )}
            {edgesTruncated && (
                <div
                    style={{
                        position: 'absolute',
                        top: isTruncated ? 56 : 12,
                        left: 12,
                        zIndex: 10,
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'var(--vscode-editor-background)',
                        border: '1px solid var(--vscode-widget-border)',
                        color: 'var(--vscode-descriptionForeground)',
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                        maxWidth: 420,
                    }}
                >
                    Trop d’arêtes : rendu limité à {MAX_PROCESS_EDGES} edges pour éviter un crash.
                </div>
            )}
            {renderEdgesTruncated && (
                <div
                    style={{
                        position: 'absolute',
                        top: (isTruncated ? 56 : 12) + (edgesTruncated ? 44 : 0),
                        left: 12,
                        zIndex: 10,
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'var(--vscode-editor-background)',
                        border: '1px solid var(--vscode-widget-border)',
                        color: 'var(--vscode-descriptionForeground)',
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                        maxWidth: 420,
                    }}
                >
                    Trop d’arêtes visibles : affichage limité à {MAX_RENDER_EDGES} edges.
                </div>
            )}

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
