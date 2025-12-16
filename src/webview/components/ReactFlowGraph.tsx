import React, { useEffect, useMemo, useCallback, useState } from 'react';
import ReactFlow, {
    Background,
    Controls,
    useReactFlow,
    ReactFlowProvider,
    useNodesInitialized,
    Node,
    useNodesState,
    useEdgesState,
} from 'reactflow';
// @ts-expect-error - ReactFlow types are complex
import reactFlowStyles from 'reactflow/dist/style.css';
import { GraphData } from '../../shared/types';
import { getLogger } from '../../shared/logger';
import { normalizePath } from '../utils/path';
import { createDebouncedRafScheduler, createSizePoller } from '../utils/fitViewScheduler';
import { FileNode } from './reactflow/FileNode';
import { buildReactFlowGraph, GRAPH_LIMITS } from './reactflow/buildGraph';
import { ExpansionOverlay, type ExpansionState } from './reactflow/ExpansionOverlay';

/** Logger instance for ReactFlowGraph */
const log = getLogger('ReactFlowGraph');

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
    expansionState?: ExpansionState | null;
    onCancelExpand?: (nodeId?: string) => void;
}

function stableGlobal<T>(key: string, factory: () => T): T {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g[key]) return g[key] as T;
    const value = factory();
    g[key] = value;
    return value;
}

const NODE_TYPES = stableGlobal('__graphItLive_nodeTypes', () =>
    Object.freeze({ file: FileNode } as const)
);
const PRO_OPTIONS = stableGlobal('__graphItLive_proOptions', () =>
    Object.freeze({ hideAttribution: true } as const)
);

function useExpandedNodes(params: {
    expandAll: boolean;
    currentFilePath: string;
    edges: GraphData['edges'] | undefined;
    autoExpandNodeId: string | null | undefined;
    onExpandNode?: (path: string) => void;
}) {
    const { expandAll, currentFilePath, edges, autoExpandNodeId, onExpandNode } = params;
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (expandAll) return;
        const rootSet = currentFilePath ? new Set([normalizePath(currentFilePath)]) : new Set<string>();
        setExpandedNodes(rootSet);
    }, [expandAll, currentFilePath]);

    useEffect(() => {
        if (!expandAll || !edges) return;
        const allNodesWithChildren = new Set<string>();

        if (currentFilePath) {
            allNodesWithChildren.add(normalizePath(currentFilePath));
        }
        const edgesForSources =
            edges.length > GRAPH_LIMITS.MAX_PROCESS_EDGES
                ? edges.slice(0, GRAPH_LIMITS.MAX_PROCESS_EDGES)
                : edges;
        edgesForSources.forEach((edge) => {
            allNodesWithChildren.add(normalizePath(edge.source));
        });
        setExpandedNodes(allNodesWithChildren);
    }, [expandAll, edges, currentFilePath]);

    useEffect(() => {
        if (!autoExpandNodeId) return;
        const normalized = normalizePath(autoExpandNodeId);
        setExpandedNodes((prev) => new Set(prev).add(normalized));
    }, [autoExpandNodeId]);

    const toggleExpandedNode = useCallback((path: string) => {
        setExpandedNodes((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const handleExpandRequest = useCallback(
        (path: string) => {
            const normalized = normalizePath(path);
            onExpandNode?.(normalized);
            setExpandedNodes((prev) => new Set(prev).add(normalized));
        },
        [onExpandNode]
    );

    return { expandedNodes, toggleExpandedNode, handleExpandRequest };
}

function useAutoFitView(params: {
    containerRef: React.RefObject<HTMLDivElement | null>;
    nodesInitialized: boolean;
    nodeCount: number;
    fitView: (options?: { padding?: number; duration?: number }) => void;
}) {
    const { containerRef, nodesInitialized, nodeCount, fitView } = params;

    useEffect(() => {
        if (!nodesInitialized || nodeCount === 0) return;
        const timeoutId = setTimeout(() => fitView({ padding: 0.2, duration: 500 }), 100);
        return () => clearTimeout(timeoutId);
    }, [nodesInitialized, nodeCount, fitView]);

    useEffect(() => {
        if (!nodesInitialized || nodeCount === 0) return;
        const element = containerRef.current;
        if (!element) return;

        const scheduler = createDebouncedRafScheduler(
            () => fitView({ padding: 0.2, duration: 200 }),
            60
        );

        const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduler.trigger);
        const poller = createSizePoller(
            () => {
                const rect = element.getBoundingClientRect();
                return { width: Math.round(rect.width), height: Math.round(rect.height) };
            },
            scheduler.trigger,
            250
        );

        resizeObserver?.observe(element);
        window.addEventListener('resize', scheduler.trigger);

        poller.start();
        scheduler.trigger();

        return () => {
            window.removeEventListener('resize', scheduler.trigger);
            resizeObserver?.disconnect();
            poller.dispose();
            scheduler.dispose();
        };
    }, [nodesInitialized, nodeCount, fitView, containerRef]);
}

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
    const { expandedNodes, toggleExpandedNode, handleExpandRequest } = useExpandedNodes({
        expandAll,
        currentFilePath,
        edges: data?.edges,
        autoExpandNodeId,
        onExpandNode,
    });

    const graph = useMemo(() => {
        log.debug('ReactFlowGraph: build graph', {
            nodes: data?.nodes?.length || 0,
            edges: data?.edges?.length || 0,
            currentFilePath,
            expandedNodesSize: expandedNodes.size,
            showParents,
            expandAll,
        });
        return buildReactFlowGraph({
            data,
            currentFilePath,
            expandAll,
            expandedNodes,
            showParents,
            callbacks: {
                onDrillDown,
                onFindReferences,
                onToggleParents,
                onToggle: (path) => toggleExpandedNode(path),
                onExpandRequest: handleExpandRequest,
            },
        });
    }, [
        data,
        currentFilePath,
        expandAll,
        expandedNodes,
        showParents,
        onDrillDown,
        onFindReferences,
        onToggleParents,
        toggleExpandedNode,
        handleExpandRequest,
    ]);

    const isTruncated = graph.nodesTruncated;

    const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

    // Update nodes when data changes
    useEffect(() => {
        setNodes(graph.nodes);
        setEdges(graph.edges);
    }, [graph.nodes, graph.edges, setNodes, setEdges]);

    useAutoFitView({
        containerRef,
        nodesInitialized,
        nodeCount: nodes.length,
        fitView,
    });

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
            {expansionState && (
                <ExpansionOverlay state={expansionState} onCancel={onCancelExpand} />
            )}
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
                    Graphe trop volumineux : affichage limité à {GRAPH_LIMITS.MAX_RENDER_NODES} nœuds pour éviter un crash.
                </div>
            )}
            {graph.edgesTruncated && (
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
                    Trop d’arêtes : rendu limité à {GRAPH_LIMITS.MAX_PROCESS_EDGES} edges pour éviter un crash.
                </div>
            )}
            {graph.renderEdgesTruncated && (
                <div
                    style={{
                        position: 'absolute',
                        top: (isTruncated ? 56 : 12) + (graph.edgesTruncated ? 44 : 0),
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
                    Trop d’arêtes visibles : affichage limité à {GRAPH_LIMITS.MAX_RENDER_EDGES} edges.
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
            {graph.cycles.size > 0 && (
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
                    <span>Circular dependency ({graph.cycles.size} files)</span>
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
