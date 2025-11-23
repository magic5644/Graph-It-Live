import React, { useEffect, useMemo } from 'react';
import ReactFlow, { Background, Controls, useReactFlow, ReactFlowProvider, useNodesInitialized, Handle, Position, NodeProps, Node } from 'reactflow';
// @ts-expect-error - ReactFlow types are complex
import reactFlowStyles from 'reactflow/dist/style.css';
import { useGraphData } from '../hooks/useGraphData';

// Inject React Flow CSS
if (typeof document !== 'undefined' && !document.getElementById('reactflow-styles')) {
    const style = document.createElement('style');
    style.id = 'reactflow-styles';
    style.textContent = reactFlowStyles;
    document.head.appendChild(style);
}

const CustomNode = ({ data, isConnectable }: NodeProps) => {
    return (
        <div
            style={{ position: 'relative', width: '100%', height: '100%' }}
            title={data.fullPath}
        >
            <Handle type="target" position={Position.Left} isConnectable={isConnectable} style={{ visibility: 'hidden' }} />

            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                pointerEvents: 'none' // Let clicks pass through to parent for file opening
            }}>
                {data.label}
            </div>

            {/* Cycle indicator badge */}
            {data.isInCycle && (
                <div
                    style={{
                        position: 'absolute',
                        top: -15,
                        right: -15,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#dc3545',
                        border: '2px solid var(--vscode-editor-background)',
                        zIndex: 15,
                        pointerEvents: 'none',
                    }}
                    title="Node is part of a circular dependency"
                />
            )}

            {data.hasChildren && (
                <div
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent opening file
                        // Always use toggleNode - children are already in the graph
                        data.onToggle();
                    }}
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
                        fontSize: '14px',
                        fontWeight: 'bold',
                        zIndex: 10,
                        pointerEvents: 'auto', // Re-enable pointer events for the button
                        border: '2px solid var(--vscode-editor-background)'
                    }}
                >
                    {data.isExpanded ? '-' : '+'}
                </div>
            )}

            {/* Referenced By Button (Only for Root) */}
            {data.isRoot && (
                <div
                    onClick={(e) => {
                        e.stopPropagation();
                        data.onFindReferences?.();
                    }}
                    style={{
                        position: 'absolute',
                        left: -24, // Moved further left to avoid overlap
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
                        fontSize: '10px',
                        fontWeight: 'bold',
                        zIndex: 10,
                        pointerEvents: 'auto',
                        border: '2px solid var(--vscode-editor-background)'
                    }}
                    title="Find referencing files"
                >
                    ◀
                </div>
            )}

            <Handle type="source" position={Position.Right} isConnectable={isConnectable} style={{ visibility: 'hidden' }} />
        </div>
    );
};

const GraphContent: React.FC = () => {
    const { nodes, edges, onNodesChange, onEdgesChange, onNodeClick, currentFilePath, openFile, expandAll, toggleExpandAll, refreshGraph } = useGraphData();
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const [navigationHistory, setNavigationHistory] = React.useState<string[]>([]);

    const nodeTypes = useMemo(() => ({ custom: CustomNode }), []);

    useEffect(() => {
        if (nodesInitialized && nodes.length > 0) {
            setTimeout(() => fitView({ padding: 0.2, duration: 800 }), 100);
        }
    }, [nodesInitialized, nodes.length, fitView]);

    const handleNodeClick = (event: React.MouseEvent, node: Node) => {
        // Add current file to history before navigating
        if (currentFilePath && currentFilePath !== node.id) {
            setNavigationHistory(prev => [...prev, currentFilePath]);
        }
        onNodeClick(event, node);
    };

    const handleBack = () => {
        if (navigationHistory.length > 0) {
            const previousFile = navigationHistory[navigationHistory.length - 1];
            setNavigationHistory(prev => prev.slice(0, -1));
            openFile(previousFile);
        }
    };

    return (
        <div style={{ width: '100vw', height: '100vh', position: 'fixed', top: 0, left: 0 }}>
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
            {navigationHistory.length > 0 && (
                <button
                    onClick={handleBack}
                    style={{
                        position: 'absolute',
                        top: 10,
                        left: 10,
                        zIndex: 1000,
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: 'none',
                        borderRadius: 4,
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--vscode-button-hoverBackground)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--vscode-button-background)'}
                >
                    ← Back
                </button>
            )}

            <div style={{
                position: 'absolute',
                top: 10,
                right: 10,
                zIndex: 1000,
                display: 'flex',
                gap: 8
            }}>
                <button
                    onClick={refreshGraph}
                    style={{
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: 'none',
                        borderRadius: 4,
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                    }}
                    title="Refresh graph from active editor"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 4v6h-6"></path>
                        <path d="M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                </button>
                <button
                    onClick={() => toggleExpandAll(true)}
                    style={{
                        background: expandAll ? 'var(--vscode-button-hoverBackground)' : 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: expandAll ? '1px solid var(--vscode-focusBorder)' : 'none',
                        borderRadius: 4,
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                    }}
                    title="Expand all nodes and set as default"
                >
                    Expand All
                </button>
                <button
                    onClick={() => toggleExpandAll(false)}
                    style={{
                        background: !expandAll ? 'var(--vscode-button-hoverBackground)' : 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: !expandAll ? '1px solid var(--vscode-focusBorder)' : 'none',
                        borderRadius: 4,
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                    }}
                    title="Collapse all nodes and set as default"
                >
                    Collapse All
                </button>
            </div>
        </div>
    );
};

const Graph: React.FC = () => {
    return (
        <ReactFlowProvider>
            <GraphContent />
        </ReactFlowProvider>
    );
};

export default Graph;
