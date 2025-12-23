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
    resetToken?: number;
    unusedDependencyMode?: 'none' | 'hide' | 'dim';
    /** Whether the unused dependency filter is active (from backend state) */
    filterUnused?: boolean;
}

function stableGlobal<T>(key: string, factory: () => T): T {
    const g = globalThis as unknown as Record<string, unknown>;
    if (g[key]) return g[key] as T;
    const value = factory();
    g[key] = value;
    return value;
}

const PRO_OPTIONS = stableGlobal('__graphItLive_proOptions', () =>
    Object.freeze({ hideAttribution: true } as const)
);

function useExpandedNodes(params: {
    expandAll: boolean;
    currentFilePath: string;
    edges: GraphData['edges'] | undefined;
    autoExpandNodeId: string | null | undefined;
    onExpandNode?: (path: string) => void;
    resetToken?: number;
}) {
    const { expandAll, currentFilePath, edges, autoExpandNodeId, onExpandNode, resetToken } = params;

    // Track the last values to detect ACTUAL changes (not re-renders)
    const lastExpandAllRef = React.useRef<boolean>(expandAll);
    const lastResetTokenRef = React.useRef<number | undefined>(resetToken);

    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    // Effect ONLY for navigation resets (resetToken or currentFilePath changes)
    // This resets expandedNodes according to expandAll state at time of navigation
    useEffect(() => {
        log.debug('🔄 useExpandedNodes: Navigation effect', {
            resetToken,
            currentFilePath,
            expandAll,
            edgesCount: edges?.length
        });

        lastResetTokenRef.current = resetToken;

        if (expandAll && edges && edges.length > 0) {
            // Expand ALL nodes with children
            const allNodesWithChildren = new Set<string>();
            edges.forEach(edge => {
                allNodesWithChildren.add(edge.source);
            });
            log.debug('🔄 Navigation: Expanding all nodes', { size: allNodesWithChildren.size });
            setExpandedNodes(allNodesWithChildren);
        } else {
            // Reset to root only
            const rootSet = currentFilePath ? new Set([normalizePath(currentFilePath)]) : new Set<string>();
            log.debug('🔄 Navigation: Resetting to root', { rootSize: rootSet.size });
            setExpandedNodes(rootSet);
        }
    }, [resetToken, currentFilePath]); // CRITICAL: Only navigation triggers, NOT expandAll or edges!

    // Separate effect ONLY for expandAll button changes
    // This allows manual node toggling to work independently
    useEffect(() => {
        // Only react when expandAll ACTUALLY changes (not on every render)
        if (expandAll === lastExpandAllRef.current) {
            return; // No change, skip
        }

        log.debug('🔄 useExpandedNodes: expandAll changed', {
            from: lastExpandAllRef.current,
            to: expandAll,
            edgesCount: edges?.length
        });

        lastExpandAllRef.current = expandAll;

        if (expandAll && edges && edges.length > 0) {
            // Expand ALL nodes with children
            const allNodesWithChildren = new Set<string>();
            edges.forEach(edge => {
                allNodesWithChildren.add(edge.source);
            });
            log.debug('🔄 ExpandAll: Expanding all nodes', { size: allNodesWithChildren.size });
            setExpandedNodes(allNodesWithChildren);
        } else if (!expandAll) {
            // Collapse all - keep only root
            const rootSet = currentFilePath ? new Set([normalizePath(currentFilePath)]) : new Set<string>();
            log.debug('🔄 ExpandAll: Collapsing to root', { rootSize: rootSet.size });
            setExpandedNodes(rootSet);
        }
    }, [expandAll]); // CRITICAL: Only expandAll changes, NOT edges!

    // Auto-expand specific node (typically after expansion request)
    useEffect(() => {
        if (!autoExpandNodeId) return;
        const normalized = normalizePath(autoExpandNodeId);

        // Use callback form to ensure atomic update
        setExpandedNodes((prev) => {
            if (prev.has(normalized)) return prev; // Already expanded, no change
            const next = new Set(prev);
            next.add(normalized);
            return next;
        });
    }, [autoExpandNodeId]);

    // Toggle expanded state for a node (collapse if expanded, expand if collapsed)
    const toggleExpandedNode = useCallback((path: string) => {
        const normalized = normalizePath(path); // CRITICAL: Always normalize before Set operations
        log.debug('👆 toggleExpandedNode called', { path, normalized });
        setExpandedNodes((prev) => {
            const prevArray = Array.from(prev);
            const had = prev.has(normalized);
            log.debug('👆 toggleExpandedNode: BEFORE', {
                had,
                prevSize: prev.size,
                normalized,
                prevContents: prevArray
            });
            const next = new Set(prev);
            if (had) {
                next.delete(normalized);
                log.debug('👆 toggleExpandedNode: DELETED', { normalized, newSize: next.size });
            } else {
                next.add(normalized);
                log.debug('👆 toggleExpandedNode: ADDED', { normalized, newSize: next.size });
            }
            const nextArray = Array.from(next);
            log.debug('👆 toggleExpandedNode: AFTER', { nextSize: next.size, nextContents: nextArray });
            // Always return new Set since we're toggling (content definitely changed)
            return next;
        });
    }, []);

    // Request expansion of a node (always adds to expanded set)
    const handleExpandRequest = useCallback(
        (path: string) => {
            const normalized = normalizePath(path);

            // Notify parent component first
            onExpandNode?.(normalized);

            // Then update local state atomically
            setExpandedNodes((prev) => {
                if (prev.has(normalized)) return prev; // Already expanded
                const next = new Set(prev);
                next.add(normalized);
                return next;
            });
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
    resetToken,
    unusedDependencyMode = 'none',
    filterUnused: backendFilterUnused,
}) => {
    const [filterUnused, setFilterUnused] = useState<boolean>(backendFilterUnused ?? false);

    // Sync filterUnused state when backend state changes
    useEffect(() => {
        if (backendFilterUnused !== undefined) {
            setFilterUnused(backendFilterUnused);
        }
    }, [backendFilterUnused]);
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const nodeTypes = useMemo(() => Object.freeze({ file: FileNode } as const), []);
    const { expandedNodes, toggleExpandedNode, handleExpandRequest } = useExpandedNodes({
        expandAll,
        currentFilePath,
        edges: data?.edges,
        autoExpandNodeId,
        onExpandNode,
        resetToken,
    });

    // Use refs for callbacks to avoid including them in useMemo deps
    // This prevents constant re-renders when parent component recreates callbacks
    const callbacksRef = React.useRef({
        onDrillDown,
        onFindReferences,
        onToggleParents,
        onToggle: toggleExpandedNode,
        onExpandRequest: handleExpandRequest,
    });

    // Update ref on every render so buildGraph always uses latest callbacks
    callbacksRef.current = {
        onDrillDown,
        onFindReferences,
        onToggleParents,
        onToggle: toggleExpandedNode,
        onExpandRequest: handleExpandRequest,
    };

    const graph = useMemo(() => {
        const expandedArray = Array.from(expandedNodes);
        log.debug('🏗️ ReactFlowGraph: build graph START', {
            nodes: data?.nodes?.length || 0,
            edges: data?.edges?.length || 0,
            currentFilePath,
            expandedNodesSize: expandedNodes.size,
            expandedNodesList: expandedArray,
            showParents,
            expandAll,
        });
        const result = buildReactFlowGraph({
            data,
            currentFilePath,
            expandAll,
            expandedNodes,
            showParents,
            callbacks: callbacksRef.current,
            unusedEdges: data?.unusedEdges,
            unusedDependencyMode,
            filterUnused,
        });
        log.debug('🏗️ ReactFlowGraph: build graph END', {
            resultNodes: result.nodes.length,
            resultEdges: result.edges.length,
            nodesTruncated: result.nodesTruncated
        });
        return result;
    }, [
        data,
        currentFilePath,
        expandAll,
        expandedNodes,
        showParents,
        unusedDependencyMode,
        filterUnused,
        // DO NOT include callbacks in deps! They don't change graph structure,
        // only node data handlers. Including them causes constant re-renders.
    ]);

    const isTruncated = graph.nodesTruncated;

    // Process edges to apply unused dependency filtering/styling
    const processedEdges = useMemo(() => {
        if (!filterUnused || unusedDependencyMode === 'none' || !data?.unusedEdges?.length) {
            return graph.edges;
        }

        const unusedEdgeSet = new Set(data.unusedEdges);

        if (unusedDependencyMode === 'dim') {
            return graph.edges.map(edge => {
                if (unusedEdgeSet.has(edge.id)) {
                    return {
                        ...edge,
                        style: { ...edge.style, opacity: 0.2, strokeDasharray: '5 5' },
                        animated: false,
                        label: 'unused', // Optional: indicate it's unused
                        labelStyle: { fill: 'var(--vscode-descriptionForeground)', opacity: 0.5 },
                        labelBgStyle: { fill: 'transparent' },
                    };
                }
                return edge;
            });
        }

        return graph.edges;
    }, [graph.edges, data?.unusedEdges, unusedDependencyMode, filterUnused]);

    const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(processedEdges);

    // Sync nodes/edges when graph recalculates
    useEffect(() => {
        log.debug('ReactFlowGraph: Syncing nodes/edges', {
            nodeCount: graph.nodes.length,
            edgeCount: processedEdges.length,
        });
        setNodes(graph.nodes);
        setEdges(processedEdges);
    }, [graph.nodes, processedEdges, setNodes, setEdges]);

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
                nodeTypes={nodeTypes}
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
                    Graph too large: display limited to {GRAPH_LIMITS.MAX_RENDER_NODES} nodes to avoid crashes.
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
                    Too many edges: rendering limited to {GRAPH_LIMITS.MAX_PROCESS_EDGES} edges to avoid crashes.
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
                    Too many visible edges: display limited to {GRAPH_LIMITS.MAX_RENDER_EDGES} edges.
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
                    {unusedDependencyMode !== 'none' && (
                        <button
                            onClick={() => setFilterUnused(!filterUnused)}
                            title={`Filter Unused Imports (${unusedDependencyMode === 'hide' ? 'Hide' : 'Dim'})`}
                            style={{
                                background: filterUnused ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)',
                                color: filterUnused ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)',
                                border: '1px solid var(--vscode-button-border)',
                                borderRadius: 4,
                                padding: '6px 12px',
                                cursor: 'pointer',
                                fontSize: 12,
                            }}
                        >
                            {filterUnused ? 'Used Only' : 'Show All'}
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
