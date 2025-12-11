import React from 'react';
import ReactFlowGraph from './components/ReactFlowGraph';
import SymbolCardView from './components/SymbolCardView';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, GraphData, SymbolInfo, SymbolDependency } from '../shared/types';
import { getLogger } from '../shared/logger';

/** Logger instance for App */
const log = getLogger('App');

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
            log.debug('App: Sending ready message to extension');
            vscode.postMessage({ command: 'ready' });

            // Forward console logs from the webview to the extension OutputChannel
            const origLog = console.log;
            const origInfo = console.info;
            const origWarn = console.warn;
            const origError = console.error;
            const consoleDebugHolder = console as unknown as { debug?: (...args: unknown[]) => void };
            const origDebug = consoleDebugHolder.debug ?? origLog;

            console.log = (...args: unknown[]) => {
                origLog(...args);
                try {
                    vscode.postMessage({ command: 'webviewLog', level: 'info', message: String(args[0] ?? ''), args });
                } catch (error_) {  console.log(error_); }
            };
            console.info = (...args: unknown[]) => {
                origInfo(...args);
                try {
                    vscode.postMessage({ command: 'webviewLog', level: 'info', message: String(args[0] ?? ''), args });
                } catch (err) { origLog('Webview log forward failed', err); }
            };
            console.warn = (...args: unknown[]) => {
                origWarn(...args);
                try {
                    vscode.postMessage({ command: 'webviewLog', level: 'warn', message: String(args[0] ?? ''), args });
                } catch (err) { origLog('Webview log forward failed', err); }
            };
            console.error = (...args: unknown[]) => {
                origError(...args);
                try {
                    vscode.postMessage({ command: 'webviewLog', level: 'error', message: String(args[0] ?? ''), args });
                } catch (err) { origLog('Webview log forward failed', err); }
            };
            consoleDebugHolder.debug = (...args: unknown[]) => {
                origDebug(...args);
                try {
                    vscode.postMessage({ command: 'webviewLog', level: 'debug', message: String(args[0] ?? ''), args });
                } catch (error_) {  console.log(error_); }
            };

            return () => {
                // Restore original console functions
                console.log = origLog;
                console.info = origInfo;
                console.warn = origWarn;
                console.error = origError;
                consoleDebugHolder.debug = origDebug;
            };
        }
    }, []);
    const [viewMode, setViewMode] = React.useState<'file' | 'symbol' | 'references'>('file');
    const [expandAll, setExpandAll] = React.useState<boolean>(false);
    // Toggle to show/hide parent/reference files for the current root file
    const [showParents, setShowParents] = React.useState<boolean>(false);
    const [showTypes, setShowTypes] = React.useState<boolean>(true);
    const [symbolData, setSymbolData] = React.useState<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] } | undefined>(undefined);
    const [referencingFiles, setReferencingFiles] = React.useState<string[]>([]);

    // Handler for updateGraph message
    const handleUpdateGraphMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'updateGraph' }) => {
        if (!message.isRefresh) {
            setViewMode('file');
            setSymbolData(undefined);
        }
        log.debug('App: Received updateGraph message:', {
            filePath: message.filePath,
            nodes: message.data.nodes?.length || 0,
            edges: message.data.edges?.length || 0,
            expandAll: message.expandAll
        });
        setGraphData(message.data);
        setCurrentFilePath(message.filePath);
        setEmptyStateMessage(null);
        // Reset parent visibility on new navigation
        setShowParents(false);
    }, []);

    // Handler for symbolGraph message
    const handleSymbolGraphMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'symbolGraph' }) => {
        if (!message.isRefresh) {
            setViewMode('symbol');
        }
        setGraphData(message.data);
        setCurrentFilePath(message.filePath);
        if (message.data.symbolData) {
            setSymbolData(message.data.symbolData as { symbols: SymbolInfo[]; dependencies: SymbolDependency[] });
        }
        setReferencingFiles(message.data.referencingFiles || []);
    }, []);

    // Handler for expandedGraph message
    const handleExpandedGraphMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'expandedGraph' }) => {
        if (graphData) {
            const mergedNodes = [...new Set([...graphData.nodes, ...message.data.nodes])];
            const mergedEdges = [...graphData.edges, ...message.data.edges];
            setGraphData({ 
                nodes: mergedNodes, 
                edges: mergedEdges, 
                nodeLabels: { ...graphData.nodeLabels, ...message.data.nodeLabels } 
            });
        }
    }, [graphData]);

    // Handler for referencingFiles message
    const handleReferencingFilesMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'referencingFiles' }) => {
        log.debug('App: Received referencingFiles message for', message.nodeId, 'nodes:', message.data.nodes.length, 'edges:', (message.data.edges || []).length);
        const files = message.data.nodes.filter((n: string) => n !== message.nodeId);
        setReferencingFiles(files);

        if (viewMode === 'file' && graphData) {
            const newNodes = files.filter((f: string) => !graphData.nodes.includes(f));
            const newEdges = files.map((f: string) => ({ source: f, target: message.nodeId }));
            const newLabels: Record<string, string> = {};
            newNodes.forEach((f: string) => {
                newLabels[f] = f.split('/').pop() || f;
            });

            if (newNodes.length > 0 || newEdges.length > 0) {
                const mergedParentCounts = { ...graphData.parentCounts, ...message.data.parentCounts };
                const updatedData: GraphData = {
                    nodes: [...new Set([...graphData.nodes, ...newNodes])],
                    edges: [...graphData.edges, ...newEdges.filter(e =>
                        !graphData.edges.some(ge => ge.source === e.source && ge.target === e.target)
                    )],
                    nodeLabels: { ...graphData.nodeLabels, ...newLabels }
                };

                // Only include parentCounts if we have any counts to merge
                if (Object.keys(mergedParentCounts).length > 0) {
                    updatedData.parentCounts = mergedParentCounts;
                }

                setGraphData(updatedData);
            }
            // Show parents when we receive referencing files (explicitly requested)
            setShowParents(true);
        }
    }, [viewMode, graphData]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data as ExtensionToWebviewMessage;

            switch (message.command) {
                case 'updateGraph':
                    handleUpdateGraphMessage(message);
                    break;
                case 'emptyState':
                    setEmptyStateMessage(message.message || 'No file is currently open');
                    setGraphData(null);
                    setCurrentFilePath('');
                    break;
                case 'symbolGraph':
                    handleSymbolGraphMessage(message);
                    break;
                case 'expandedGraph':
                    handleExpandedGraphMessage(message);
                    break;
                case 'referencingFiles':
                    handleReferencingFilesMessage(message);
                    break;
                case 'setExpandAll':
                    log.debug('App: Received setExpandAll message:', message.expandAll);
                    setExpandAll(message.expandAll);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [handleUpdateGraphMessage, handleSymbolGraphMessage, handleExpandedGraphMessage, handleReferencingFilesMessage]);

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
        log.debug('App: Switching to mode:', mode);
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
        log.debug('App: Refresh button clicked');
        if (vscode) {
            vscode.postMessage({
                command: 'refreshGraph'
            });
        }
    };

    const handleFindReferences = (path: string) => {
        log.debug('App: Find references clicked for:', path, 'showParents:', showParents, 'referencingFilesCount:', referencingFiles.length);
        if (!showParents && referencingFiles.length === 0) {
            // If we don't currently show parents and we haven't fetched referencing files yet,
            // request them from the extension
            if (vscode) {
                vscode.postMessage({
                    command: 'findReferencingFiles',
                    nodeId: path,
                });
            }
        }

        // Toggle visibility
        setShowParents((prev) => !prev);
    };

    

    const handleNavigateToFile = (path: string, mode: 'card' | 'file') => {
        log.debug('App: Navigate to file:', path, 'mode:', mode);
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
                    showParents={showParents}
                    onToggleParents={(path) => handleFindReferences(path)}
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
