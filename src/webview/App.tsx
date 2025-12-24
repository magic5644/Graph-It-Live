import React from 'react';
import ReactFlowGraph from './components/ReactFlowGraph';
import SymbolCardView from './components/SymbolCardView';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, GraphData, SymbolInfo, SymbolDependency } from '../shared/types';
import { getLogger } from '../shared/logger';
import { normalizePath } from './utils/path';
import { mergeGraphDataUnion } from './utils/graphMerge';
import { applyUpdateGraph, isUpdateGraphNavigation } from './utils/updateGraphReducer';

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

class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean; message?: string }
> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error: unknown) {
        return { hasError: true, message: error instanceof Error ? error.message : String(error) };
    }

    componentDidCatch(error: unknown) {
        console.error('Webview render crashed:', error);
    }

    render() {
        if (!this.state.hasError) return this.props.children;
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
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                    Graph-It-Live: la webview a rencontré une erreur
                </div>
                <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', maxWidth: 520 }}>
                    {this.state.message || 'Erreur inconnue'}
                </div>
                <button
                    type="button"
                    onClick={() => {
                        try {
                            vscode?.postMessage({ command: 'setExpandAll', expandAll: false });
                            vscode?.postMessage({ command: 'refreshGraph' });
                        } catch (e) {
                            console.error('Failed to reset state before reload:', e);
                        }
                        globalThis.location.reload();
                    }}
                    style={{
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: '1px solid var(--vscode-button-border, transparent)',
                        borderRadius: 4,
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                    }}
                >
                    Recharger la vue
                </button>
            </div>
        );
    }
}

const App: React.FC = () => {
    const [graphData, setGraphData] = React.useState<GraphData | null>(null);
    const [currentFilePath, setCurrentFilePath] = React.useState<string>('');
    const currentFilePathRef = React.useRef<string>('');
    React.useEffect(() => {
        currentFilePathRef.current = currentFilePath;
    }, [currentFilePath]);
    const [emptyStateMessage, setEmptyStateMessage] = React.useState<string | null>(null);
    const [resetToken, setResetToken] = React.useState<number>(0);
    const [unusedDependencyMode, setUnusedDependencyMode] = React.useState<'none' | 'hide' | 'dim'>('none');
    const [filterUnused, setFilterUnused] = React.useState<boolean>(false);


    const handleExpandAllChange = React.useCallback((expand: boolean) => {
        setExpandAll(expand);
        if (vscode) {
            vscode.postMessage({ command: 'setExpandAll', expandAll: expand });
        }
    }, []);

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
                } catch (error_) { origLog('Webview log forward failed', error_); }
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
                } catch (error_) { origLog('Webview log forward failed', error_); }
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
    const [lastExpandedNode, setLastExpandedNode] = React.useState<string | null>(null);
    const [expansionState, setExpansionState] = React.useState<{
        nodeId: string;
        status: 'started' | 'in-progress' | 'completed' | 'cancelled' | 'error';
        processed?: number;
        total?: number;
        message?: string;
    } | null>(null);
    const clearExpansionTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (clearExpansionTimeoutRef.current) {
                clearTimeout(clearExpansionTimeoutRef.current);
                clearExpansionTimeoutRef.current = null;
            }
        };
    }, []);

    // Handler for updateFilter message
    const handleUpdateFilterMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'updateFilter' }) => {
        log.debug('App: Received updateFilter message:', message);
        if (message.filterUnused !== undefined) {
            setFilterUnused(message.filterUnused);
        }
        if (message.unusedDependencyMode) {
            setUnusedDependencyMode(message.unusedDependencyMode);
        }
    }, []);

    // Handler for updateGraph message
    const handleUpdateGraphMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'updateGraph' }) => {
        const previousFilePath = currentFilePathRef.current;
        const isNavigation = isUpdateGraphNavigation(previousFilePath, message.filePath);

        if (!message.isRefresh || isNavigation) {
            setViewMode('file');
            setSymbolData(undefined);
            setShowParents(false);
            setReferencingFiles([]);
            setLastExpandedNode(null);
            setResetToken((v) => v + 1);
        }

        if (message.isRefresh && message.refreshReason === 'manual') {
            setLastExpandedNode(null);
            setExpansionState(null);
            setResetToken((v) => v + 1);
        }

        log.debug('App: Received updateGraph message:', {
            filePath: message.filePath,
            nodes: message.data.nodes?.length || 0,
            edges: message.data.edges?.length || 0,
            expandAll: message.expandAll
        });
        setGraphData((current) => applyUpdateGraph(current, previousFilePath, message));
        setCurrentFilePath(message.filePath);
        setEmptyStateMessage(null);

        // CRITICAL: Synchronize expandAll state with extension's persisted state
        // This ensures the webview button reflects the actual state on first render
        if (message.expandAll !== undefined) {
            setExpandAll(message.expandAll);
        }
        if (message.unusedDependencyMode !== undefined) {
            setUnusedDependencyMode(message.unusedDependencyMode);
        }
        if (message.filterUnused !== undefined) {
            setFilterUnused(message.filterUnused);
        }
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
        setGraphData((current) => (current ? mergeGraphDataUnion(current, message.data) : message.data));
        setLastExpandedNode(message.nodeId);
    }, []);

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
                    nodeLabels: { ...graphData.nodeLabels, ...newLabels },
                    unusedEdges: [...new Set([...(graphData.unusedEdges || []), ...(message.data.unusedEdges || [])])]
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
                case 'updateFilter':
                    handleUpdateFilterMessage(message);
                    break;
                case 'emptyState':
                    setEmptyStateMessage(message.message || 'No file is currently open');
                    setGraphData((current) => (message.reason === 'no-file-open' ? current : null));
                    if (message.reason !== 'no-file-open') {
                        setCurrentFilePath('');
                    }
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
                    if (message.expandAll) {
                        setExpansionState({
                            nodeId: 'expandAll',
                            status: 'in-progress',
                            processed: undefined,
                            total: undefined,
                            message: 'Expansion globale en cours…',
                        });
                    } else {
                        setExpansionState(null);
                    }
                    break;
                case 'expansionProgress':
                    if (clearExpansionTimeoutRef.current) {
                        clearTimeout(clearExpansionTimeoutRef.current);
                        clearExpansionTimeoutRef.current = null;
                    }

                    setExpansionState({
                        nodeId: message.nodeId,
                        status: message.status,
                        processed: message.processed,
                        total: message.total,
                        message: message.message,
                    });

                    if (['completed', 'cancelled', 'error'].includes(message.status)) {
                        clearExpansionTimeoutRef.current = setTimeout(() => {
                            setExpansionState(null);
                            clearExpansionTimeoutRef.current = null;
                        }, 1500);
                    }
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
            setResetToken((v) => v + 1);
            vscode.postMessage({
                command: 'refreshGraph'
            });
        }
    };

    const handleFindReferences = (path: string) => {
        log.debug('App: Find references clicked for:', path, 'showParents:', showParents, 'referencingFilesCount:', referencingFiles.length);

        if (showParents) {
            // If parents are currently visible, just hide them (no need to re-fetch)
            setShowParents(false);
        } else if (referencingFiles.length === 0) {
            // We haven't fetched referencing files yet, request them from the extension
            // IMPORTANT: Don't toggle showParents yet - wait for the response
            if (vscode) {
                vscode.postMessage({
                    command: 'findReferencingFiles',
                    nodeId: path,
                });
            }
            // handleReferencingFilesMessage will set showParents=true when data arrives
        } else {
            // We already have the data, just toggle visibility
            setShowParents(true);
        }
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

    const handleCancelExpansion = (nodeId?: string) => {
        if (!vscode) return;
        vscode.postMessage({
            command: 'cancelExpandNode',
            nodeId,
        });
        setExpansionState((prev) => prev ? { ...prev, status: 'cancelled' } : prev);
    };

    const handleExpandNode = (nodeId: string) => {
        if (!vscode || !graphData) return;

        const normalizedId = normalizePath(nodeId);
        const knownNodes = new Set<string>((graphData.nodes || []).map((n) => normalizePath(n)));
        (graphData.edges || []).forEach((edge) => {
            knownNodes.add(normalizePath(edge.source));
            knownNodes.add(normalizePath(edge.target));
        });

        vscode.postMessage({
            command: 'expandNode',
            nodeId: normalizedId,
            knownNodes: Array.from(knownNodes),
        });
    };

    // Lightweight overlay when expandAll is toggled locally (no backend progress events)
    // Must NOT depend on `expansionState`, otherwise it can loop (setState → effect rerun → setState...).
    React.useEffect(() => {
        if (clearExpansionTimeoutRef.current) {
            clearTimeout(clearExpansionTimeoutRef.current);
            clearExpansionTimeoutRef.current = null;
        }

        if (!expandAll) {
            setExpansionState((prev) => (prev?.nodeId === 'expandAll' ? null : prev));
            return;
        }

        setExpansionState((prev) => {
            if (prev?.nodeId === 'expandAll') return prev;
            return {
                nodeId: 'expandAll',
                status: 'in-progress',
                message: 'Expansion globale en cours…',
            };
        });

        clearExpansionTimeoutRef.current = setTimeout(() => {
            setExpansionState((prev) => (prev?.nodeId === 'expandAll' ? null : prev));
            clearExpansionTimeoutRef.current = null;
        }, 2000);

        return () => {
            if (clearExpansionTimeoutRef.current) {
                clearTimeout(clearExpansionTimeoutRef.current);
                clearExpansionTimeoutRef.current = null;
            }
        };
    }, [expandAll]);

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
        <ErrorBoundary>
            <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
                {emptyStateMessage && (
                    <div
                        style={{
                            position: 'absolute',
                            top: 12,
                            left: 12,
                            right: 12,
                            zIndex: 2000,
                            pointerEvents: 'none',
                            display: 'flex',
                            justifyContent: 'center',
                        }}
                    >
                        <div
                            style={{
                                background: 'var(--vscode-editor-background)',
                                border: '1px solid var(--vscode-widget-border)',
                                color: 'var(--vscode-descriptionForeground)',
                                borderRadius: 6,
                                padding: '6px 10px',
                                fontSize: 12,
                                maxWidth: 640,
                                textAlign: 'center',
                                boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                            }}
                        >
                            {emptyStateMessage}
                        </div>
                    </div>
                )}
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
                        key={`${normalizePath(currentFilePath)}:${resetToken}`}
                        data={graphData}
                        currentFilePath={currentFilePath}
                        onNodeClick={(path) => handleNodeClick(path)}
                        onDrillDown={handleDrillDown}
                        onFindReferences={handleFindReferences}
                        onExpandNode={handleExpandNode}
                        autoExpandNodeId={lastExpandedNode}
                        showParents={showParents}
                        onToggleParents={(path) => handleFindReferences(path)}
                        expandAll={expandAll}
                        onExpandAllChange={handleExpandAllChange}
                        onRefresh={handleRefresh}
                        onSwitchToSymbol={() => handleSwitchMode('symbol')}
                        expansionState={expansionState}
                        onCancelExpand={handleCancelExpansion}
                        resetToken={resetToken}
                        unusedDependencyMode={unusedDependencyMode}                        filterUnused={filterUnused}                    />
                )}
            </div>
        </ErrorBoundary>
    );
};

export default App;
