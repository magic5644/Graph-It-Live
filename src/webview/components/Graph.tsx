import React, { useEffect } from 'react';
import ReactFlow, { Background, Controls, useReactFlow, ReactFlowProvider, useNodesInitialized } from 'reactflow';
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

const GraphContent: React.FC = () => {
    const { nodes, edges, onNodesChange, onEdgesChange, onNodeClick, currentFilePath, openFile } = useGraphData();
    const { fitView } = useReactFlow();
    const nodesInitialized = useNodesInitialized();
    const [navigationHistory, setNavigationHistory] = React.useState<string[]>([]);

    useEffect(() => {
        if (nodesInitialized && nodes.length > 0) {
            setTimeout(() => fitView({ padding: 0.2 }), 100);
        }
    }, [nodesInitialized, nodes.length, fitView]);

    const handleNodeClick = (event: React.MouseEvent, node: any) => {
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
                panOnDrag
                zoomOnScroll
                minZoom={0.5}
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
