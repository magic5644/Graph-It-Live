import React from 'react';
import ReactFlowGraph from './components/ReactFlowGraph';
import SymbolCardView from './components/SymbolCardView';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, GraphData, SymbolInfo, SymbolDependency } from '../shared/types';

// VS Code API
interface VSCodeApi {
    postMessage(message: WebviewToExtensionMessage): void;
}

declare global {
    function acquireVsCodeApi(): VSCodeApi;
}

const vscode = (function () {
    try {
        return typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    } catch {
        return null;
    }
})();

const App: React.FC = () => {
    const [graphData, setGraphData] = React.useState<GraphData | null>(null);
    const [currentFilePath, setCurrentFilePath] = React.useState<string>('');
    const [emptyStateMessage, setEmptyStateMessage] = React.useState<string | null>(null);

    // Notify extension that webview is ready on mount
    React.useEffect(() => {
        if (vscode) {
            console.log('App: Sending ready message to extension');
            vscode.postMessage({ command: 'ready' });
        }
    }, []);
    const [viewMode, setViewMode] = React.useState<'file' | 'symbol' | 'references'>('file');
    const [expandAll, setExpandAll] = React.useState<boolean>(false);
    const [showTypes, setShowTypes] = React.useState<boolean>(true);
    const [symbolData, setSymbolData] = React.useState<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] } | undefined>(undefined);
    const [referencingFiles, setReferencingFiles] = React.useState<string[]>([]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data as ExtensionToWebviewMessage;

            if (message.command === 'updateGraph') {
                // Update to file view mode unless this is just a refresh
                if (!message.isRefresh) {
                    setViewMode('file');
                    setSymbolData(undefined); // Clear symbol data in file view
                }
                console.log('App: Received updateGraph message:', {
                    filePath: message.filePath,
                    nodes: message.data.nodes?.length || 0,
                    edges: message.data.edges?.length || 0,
                    expandAll: message.expandAll
                });
                setGraphData(message.data);
                setCurrentFilePath(message.filePath);
                setEmptyStateMessage(null); // Clear empty state when we have data
            } else if (message.command === 'emptyState') {
                // Display empty state message
                setEmptyStateMessage(message.message || 'No file is currently open');
                setGraphData(null);
                setCurrentFilePath('');
            } else if (message.command === 'symbolGraph') {
                // Update to symbol view mode unless this is just a refresh
                if (!message.isRefresh) {
                    setViewMode('symbol');
                }
                setGraphData(message.data);
                setCurrentFilePath(message.filePath);
                // Store symbol data for navigation and filtering
                if (message.data.symbolData) {
                    setSymbolData(message.data.symbolData as { symbols: SymbolInfo[]; dependencies: SymbolDependency[] });
                }
                // Always update referencingFiles from the message payload
                // If missing, reset to empty array to prevent stale data persisting from previous file
                setReferencingFiles(message.data.referencingFiles || []);
            } else if (message.command === 'expandedGraph') {
                // Merge new data with existing for expanded nodes
                if (graphData) {
                    const mergedNodes = [...new Set([...graphData.nodes, ...message.data.nodes])];
                    const mergedEdges = [...graphData.edges, ...message.data.edges];
                    setGraphData({ nodes: mergedNodes, edges: mergedEdges, nodeLabels: { ...graphData.nodeLabels, ...message.data.nodeLabels } });
                }
            } else if (message.command === 'referencingFiles') {
                // Store referencing files for symbol card view
                const files = message.data.nodes.filter((n: string) => n !== message.nodeId);
                setReferencingFiles(files);

                // In file mode: merge referencing files as parent nodes in the graph
                if (viewMode === 'file' && graphData) {
                    // Add referencing files as new nodes
                    const newNodes = files.filter((f: string) => !graphData.nodes.includes(f));
                    // Add edges from referencing files TO the target (they import it)
                    const newEdges = files.map((f: string) => ({ source: f, target: message.nodeId }));
                    // Build node labels for new nodes
                    const newLabels: Record<string, string> = {};
                    newNodes.forEach((f: string) => {
                        newLabels[f] = f.split('/').pop() || f;
                    });

                    if (newNodes.length > 0 || newEdges.length > 0) {
                        setGraphData({
                            nodes: [...new Set([...graphData.nodes, ...newNodes])],
                            edges: [...graphData.edges, ...newEdges.filter(e =>
                                !graphData.edges.some(ge => ge.source === e.source && ge.target === e.target)
                            )],
                            nodeLabels: { ...graphData.nodeLabels, ...newLabels }
                        });
                    }
                }
                // In symbol mode: just update referencing files for display in card view (no view change)
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [graphData]);

    const handleNodeClick = (path: string, line?: number) => {
        if (vscode) {
            vscode.postMessage({
                command: 'openFile',
                path,
                line, // Navigate to specific line for symbol nodes
            });
        }
    };

    const handleDrillDown = (path: string) => {
        if (vscode) {
            vscode.postMessage({
                command: 'drillDown',
                filePath: path,
            });
        }
    };

    const handleSwitchMode = (mode: 'file' | 'symbol') => {
        console.log('App: Switching to mode:', mode);
        if (vscode) {
            vscode.postMessage({
                command: 'switchMode',
                mode,
            });
        }
    };

    const handleBack = () => {
        // Switch to file view mode
        handleSwitchMode('file');
    };

    const handleRefresh = () => {
        console.log('App: Refresh button clicked');
        if (vscode) {
            vscode.postMessage({
                command: 'refreshGraph'
            });
        }
    };

    const handleFindReferences = (path: string) => {
        console.log('App: Find references clicked for:', path);
        if (vscode) {
            vscode.postMessage({
                command: 'findReferencingFiles',
                nodeId: path,
            });
        }
    };

    const handleNavigateToFile = (path: string, mode: 'card' | 'file') => {
        console.log('App: Navigate to file:', path, 'mode:', mode);
        if (vscode) {
            if (mode === 'card') {
                // Drill down to symbol view
                vscode.postMessage({
                    command: 'drillDown',
                    filePath: path,
                });
            } else {
                // Open file in editor (file view will update automatically)
                vscode.postMessage({
                    command: 'openFile',
                    path,
                });
            }
        }
    };

    if (!graphData) {
        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100vh',
                color: 'var(--vscode-editor-foreground)',
                fontFamily: 'var(--vscode-font-family)',
                padding: '20px',
                textAlign: 'center',
                gap: '12px',
            }}>
                <div style={{
                    fontSize: '24px',
                    fontWeight: '600',
                    marginBottom: '8px',
                }}>
                    📊 Graph-It-Live
                </div>
                <div style={{
                    fontSize: '14px',
                    color: 'var(--vscode-descriptionForeground)',
                    maxWidth: '400px',
                }}>
                    {emptyStateMessage || 'Waiting for graph data...'}
                </div>
                {emptyStateMessage && (
                    <div style={{
                        fontSize: '12px',
                        color: 'var(--vscode-descriptionForeground)',
                        marginTop: '8px',
                        opacity: 0.8,
                    }}>
                        💡 Tip: Open a TypeScript, JavaScript, Vue, or Svelte file to see its dependency graph
                    </div>
                )}
            </div>
        );
    }

    return (
        <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
            {/* Symbol Card View */}
            {viewMode === 'symbol' && symbolData && (
                <SymbolCardView
                    filePath={currentFilePath}
                    symbols={symbolData.symbols}
                    dependencies={symbolData.dependencies}
                    referencingFiles={referencingFiles}
                    showTypes={showTypes}
                    onShowTypesChange={setShowTypes}
                    onSymbolClick={(_symbolId: string, line: number) => handleNodeClick(currentFilePath, line)}
                    onNavigateToFile={handleNavigateToFile}
                    onBack={handleBack}
                    onRefresh={handleRefresh}
                />
            )}

            {/* File Dependencies View - ReactFlow */}
            {viewMode === 'file' && (
                <ReactFlowGraph
                    data={graphData}
                    currentFilePath={currentFilePath}
                    onNodeClick={(path) => handleNodeClick(path)}
                    onDrillDown={handleDrillDown}
                    onFindReferences={handleFindReferences}
                    expandAll={expandAll}
                    onExpandAllChange={setExpandAll}
                    onRefresh={handleRefresh}
                    onSwitchToSymbol={() => handleSwitchMode('symbol')}
                />
            )}
        </div>
    );
};

export default App;
