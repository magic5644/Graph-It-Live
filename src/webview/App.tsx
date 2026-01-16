import React from 'react';
import {
  getLogger,
  type ILogger,
  type LogLevel,
  setLoggerBackend,
} from "../shared/logger";
import {
  ExtensionToWebviewMessage,
  GraphData,
  SymbolDependency,
  SymbolInfo,
  WebviewToExtensionMessage,
} from "../shared/types";
import ReactFlowGraph from './components/ReactFlowGraph';
import SymbolCardView from './components/SymbolCardView';
import { BreadcrumbNav } from "./components/reactflow/BreadcrumbNav";
import { mergeGraphDataUnion } from './utils/graphMerge';
import { normalizePath } from "./utils/path";
import { applyUpdateGraph, isUpdateGraphNavigation } from './utils/updateGraphReducer';

/** Logger instance for App */
const log = getLogger('App');

// VS Code API
interface VSCodeApi {
    postMessage(message: WebviewToExtensionMessage): void;
}

function createWebviewPostMessageLogger(
    prefix: string,
    level: LogLevel,
    post: (m: WebviewToExtensionMessage) => void
): ILogger {
    let currentLevel: LogLevel = level;
    const priority: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
        none: 4,
    };

    const shouldLog = (l: LogLevel): boolean => priority[l] >= priority[currentLevel];

    const formatArgs = (args: unknown[]): unknown[] =>
        args.map((a) => {
            if (a instanceof Error) {
                return { name: a.name, message: a.message, stack: a.stack };
            }
            return a;
        });

    const send = (l: LogLevel, message: string, args: unknown[]): void => {
        if (!shouldLog(l)) return;
        if (l === 'none') return; // 'none' is not a valid WebviewLogMessage level
        try {
            post({
                command: 'webviewLog',
                level: l,
                message: prefix ? `[${prefix}] ${message}` : message,
                args: formatArgs(args),
            });
        } catch {
            // no-op: avoid throwing from logging
        }
    };

    return {
        get level(): LogLevel {
            return currentLevel;
        },
        setLevel(l: LogLevel): void {
            currentLevel = l;
        },
        debug(message: string, ...args: unknown[]): void {
            send('debug', message, args);
        },
        info(message: string, ...args: unknown[]): void {
            send('info', message, args);
        },
        warn(message: string, ...args: unknown[]): void {
            send('warn', message, args);
        },
        error(message: string, ...args: unknown[]): void {
            send('error', message, args);
        },
    };
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
        log.error('Webview render crashed:', error);
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
                            log.error('Failed to reset state before reload:', e);
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
    const [layout, setLayout] = React.useState<'hierarchical' | 'force' | 'radial'>('hierarchical');
    const [symbolViewMode, setSymbolViewMode] = React.useState<'graph' | 'list'>('graph');
    const [showTypes, setShowTypes] = React.useState<boolean>(true);


    const handleExpandAllChange = React.useCallback((expand: boolean) => {
        setExpandAll(expand);
        if (vscode) {
            vscode.postMessage({ command: 'setExpandAll', expandAll: expand });
        }
    }, []);

    // Notify extension that webview is ready on mount
    React.useEffect(() => {
        if (vscode) {
            setLoggerBackend({
                createLogger(prefix: string, level: LogLevel = 'info'): ILogger {
                    return createWebviewPostMessageLogger(prefix, level, (m) => vscode.postMessage(m));
                },
            });

            log.debug('App: Sending ready message to extension');
            vscode.postMessage({ command: 'ready' });
        }
    }, []);
    const [viewMode, setViewMode] = React.useState<'file' | 'symbol' | 'references'>('file');
    const [expandAll, setExpandAll] = React.useState<boolean>(false);
    // Toggle to show/hide parent/reference files for the current root file
    const [showParents, setShowParents] = React.useState<boolean>(false);

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
        log.debug('App: Received updateFilter message', {
            filterUnused: message.filterUnused,
            unusedDependencyMode: message.unusedDependencyMode
        });
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
            log.debug('App: updateGraph setting filterUnused to', message.filterUnused);
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

    // Store viewMode and graphData in refs to avoid re-render cascade (per copilot-instructions.md)
    const viewModeRef = React.useRef(viewMode);
    const graphDataRef = React.useRef(graphData);
    React.useEffect(() => {
        viewModeRef.current = viewMode;
        graphDataRef.current = graphData;
    }, [viewMode, graphData]);

    // Handler for referencingFiles message
    const handleReferencingFilesMessage = React.useCallback((message: ExtensionToWebviewMessage & { command: 'referencingFiles' }) => {
        log.debug('App: Received referencingFiles message for', message.nodeId, 'nodes:', message.data.nodes.length, 'edges:', (message.data.edges || []).length);
        const files = message.data.nodes.filter((n: string) => n !== message.nodeId);
        setReferencingFiles(files);

        const currentViewMode = viewModeRef.current;
        const currentGraphData = graphDataRef.current;

        if (currentViewMode === 'file' && currentGraphData) {
            const newNodes = files.filter((f: string) => !currentGraphData.nodes.includes(f));
            const newEdges = files.map((f: string) => ({ source: f, target: message.nodeId }));
            const newLabels: Record<string, string> = {};
            newNodes.forEach((f: string) => {
                newLabels[f] = f.split('/').pop() || f;
            });

            if (newNodes.length > 0 || newEdges.length > 0) {
                const mergedParentCounts = { ...currentGraphData.parentCounts, ...message.data.parentCounts };
                const updatedData: GraphData = {
                    nodes: [...new Set([...currentGraphData.nodes, ...newNodes])],
                    edges: [...currentGraphData.edges, ...newEdges.filter(e =>
                        !currentGraphData.edges.some(ge => ge.source === e.source && ge.target === e.target)
                    )],
                    nodeLabels: { ...currentGraphData.nodeLabels, ...newLabels },
                    unusedEdges: [...new Set([...(currentGraphData.unusedEdges || []), ...(message.data.unusedEdges || [])])]
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
    }, []); // No state/callback deps - prevents re-render cascade

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


                {/* Breadcrumb Navigation - Show in symbol mode */}
                {viewMode === 'symbol' && (
                    <BreadcrumbNav
                        filePath={currentFilePath}
                        workspaceRoot={undefined} // TODO: Get from extension state
                        onBackToProject={() => setViewMode('file')}
                        mode={viewMode}
                    />
                )}

                {/* ReactFlow Graph (Handles both File and Symbol modes) */}
                {(viewMode === 'file' || (viewMode === 'symbol' && symbolViewMode === 'graph')) && (
                    <ReactFlowGraph
                        key={`${normalizePath(currentFilePath)}:${resetToken}:${viewMode}`}
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
                        onSwitchToListView={() => setSymbolViewMode('list')}
                        expansionState={expansionState}
                        onCancelExpand={handleCancelExpansion}
                        resetToken={resetToken}
                        unusedDependencyMode={unusedDependencyMode}
                        filterUnused={filterUnused}
                        mode={viewMode as 'file' | 'symbol'}
                        symbolData={symbolData}
                        layout={layout}
                        onLayoutChange={(l) => setLayout(l)}
                    />
                )}

                {/* Symbol List View */}
                {viewMode === 'symbol' && symbolViewMode === 'list' && symbolData && (
                    <SymbolCardView
                        filePath={currentFilePath}
                        symbols={symbolData.symbols}
                        dependencies={symbolData.dependencies}
                        referencingFiles={referencingFiles}
                        showTypes={showTypes}
                        onShowTypesChange={setShowTypes}
                        onSymbolClick={(id, line) => handleNodeClick(id, line)}
                        onNavigateToFile={(path) => handleDrillDown(path)}
                        onBack={() => setViewMode('file')}
                        onSwitchToGraphView={() => setSymbolViewMode('graph')}
                        onRefresh={handleRefresh}
                    />
                )}
            </div>
        </ErrorBoundary>
    );
};


export default App;
