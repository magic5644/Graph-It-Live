import * as vscode from 'vscode';
import { getExtensionLogger } from '../extensionLogger';

const log = getExtensionLogger('LspCallHierarchyService');

/**
 * Represents a node in the intra-file call graph
 */
export interface CallNode {
    /** Unique identifier for the symbol (format: filePath:symbolName) */
    id: string;
    /** Display name of the symbol */
    name: string;
    /** VS Code symbol kind (Function, Method, Class, etc.) */
    kind: vscode.SymbolKind;
    /** Line number where the symbol is defined (1-indexed) */
    line: number;
    /** Category for visualization coloring */
    category: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'other';
}

/**
 * Represents an edge (call relationship) in the call graph
 */
export interface CallEdge {
    /** Source symbol ID (the caller) */
    source: string;
    /** Target symbol ID (the callee) */
    target: string;
    /** Type of relationship */
    type: 'call' | 'reference';
    /** Locations where the call occurs (for navigation) */
    locations: { line: number; character: number }[];
}

/**
 * Result of intra-file call graph analysis
 */
export interface IntraFileCallGraph {
    nodes: CallNode[];
    edges: CallEdge[];
    /** Whether LSP was available and used */
    lspUsed: boolean;
    /** Any warnings or limitations encountered */
    warnings: string[];
}

/**
 * Options for call hierarchy analysis
 */
export interface CallHierarchyOptions {
    /** Maximum number of symbols to analyze (for performance) */
    maxSymbols?: number;
    /** Whether to include incoming calls (who calls this symbol) */
    includeIncoming?: boolean;
    /** Whether to include outgoing calls (who this symbol calls) */
    includeOutgoing?: boolean;
    /** Maximum file size in lines for LSP analysis */
    maxFileLines?: number;
}

const DEFAULT_OPTIONS: Required<CallHierarchyOptions> = {
    maxSymbols: 500,
    includeIncoming: false,
    includeOutgoing: true,
    maxFileLines: 5000,
};

/**
 * Service for extracting call hierarchy information using VS Code's LSP integration.
 * 
 * This service leverages the Language Server Protocol to extract call relationships
 * between symbols within a file, providing multi-language support (TypeScript, Rust, Python, etc.)
 * without custom parsers.
 * 
 * @example
 * ```typescript
 * const service = new LspCallHierarchyService();
 * const callGraph = await service.buildIntraFileCallGraph(vscode.Uri.file('/path/to/file.ts'));
 * console.log(callGraph.edges); // [{source: 'foo', target: 'bar', type: 'call'}]
 * ```
 */
export class LspCallHierarchyService {
    /**
     * Map SymbolKind to category for visualization coloring
     */
    private getCategory(kind: vscode.SymbolKind): CallNode['category'] {
        switch (kind) {
            case vscode.SymbolKind.Function:
            case vscode.SymbolKind.Method:
            case vscode.SymbolKind.Constructor:
                return 'function';
            case vscode.SymbolKind.Class:
                return 'class';
            case vscode.SymbolKind.Variable:
            case vscode.SymbolKind.Constant:
            case vscode.SymbolKind.Property:
            case vscode.SymbolKind.Field:
                return 'variable';
            case vscode.SymbolKind.Interface:
                return 'interface';
            case vscode.SymbolKind.TypeParameter:
            case vscode.SymbolKind.Struct:
            case vscode.SymbolKind.Enum:
                return 'type';
            default:
                return 'other';
        }
    }

    /**
     * Build a unique symbol ID from file path and symbol name
     */
    private buildSymbolId(uri: vscode.Uri, symbolName: string): string {
        return `${uri.fsPath}:${symbolName}`;
    }

    /**
     * Get all document symbols for a file using VS Code's LSP
     */
    async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );
            return symbols || [];
        } catch (error) {
            log.warn('Failed to get document symbols:', error);
            return [];
        }
    }

    /**
     * Prepare call hierarchy for a specific position in a document
     */
    async prepareCallHierarchy(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<vscode.CallHierarchyItem[]> {
        try {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                'vscode.executePrepareCallHierarchy',
                uri,
                position
            );
            return items || [];
        } catch {
            log.debug('Call hierarchy not available at position:', position.line, position.character);
            return [];
        }
    }

    /**
     * Get outgoing calls (who does this symbol call?)
     */
    async getOutgoingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
        try {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.executeOutgoingCallsProvider',
                item
            );
            return calls || [];
        } catch {
            log.debug('Failed to get outgoing calls for:', item.name);
            return [];
        }
    }

    /**
     * Get incoming calls (who calls this symbol?)
     */
    async getIncomingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyIncomingCall[]> {
        try {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.executeIncomingCallsProvider',
                item
            );
            return calls || [];
        } catch {
            log.debug('Failed to get incoming calls for:', item.name);
            return [];
        }
    }

    /**
     * Check if a file is too large for LSP analysis
     */
    async isFileTooLarge(uri: vscode.Uri, maxLines: number): Promise<boolean> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            return document.lineCount > maxLines;
        } catch {
            return false;
        }
    }

    /**
     * Flatten nested document symbols into a flat array
     */
    private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
        const result: vscode.DocumentSymbol[] = [];

        const processSymbol = (symbol: vscode.DocumentSymbol) => {
            result.push(symbol);
            if (symbol.children && symbol.children.length > 0) {
                for (const child of symbol.children) {
                    processSymbol(child);
                }
            }
        };

        for (const symbol of symbols) {
            processSymbol(symbol);
        }

        return result;
    }

    /**
     * Filter symbols to only include callable symbols (functions, methods, etc.)
     */
    private filterCallableSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
        const callableKinds = new Set([
            vscode.SymbolKind.Function,
            vscode.SymbolKind.Method,
            vscode.SymbolKind.Constructor,
        ]);

        return symbols.filter(s => callableKinds.has(s.kind));
    }

    /**
     * Build the complete intra-file call graph for a document.
     * 
     * This method:
     * 1. Fetches all symbols in the document using LSP
     * 2. For each callable symbol, prepares the call hierarchy
     * 3. Resolves outgoing calls and filters for intra-file calls
     * 4. Returns a graph of nodes (symbols) and edges (call relationships)
     * 
     * @param uri - The URI of the file to analyze
     * @param options - Configuration options for the analysis
     * @returns The intra-file call graph with nodes and edges
     */
    async buildIntraFileCallGraph(
        uri: vscode.Uri,
        options: CallHierarchyOptions = {}
    ): Promise<IntraFileCallGraph> {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const warnings: string[] = [];
        const nodes = new Map<string, CallNode>();
        const edges: CallEdge[] = [];
        const edgeSet = new Set<string>(); // Deduplicate edges

        // Check file size limit
        if (await this.isFileTooLarge(uri, opts.maxFileLines)) {
            warnings.push(`File exceeds ${opts.maxFileLines} lines. Skipping LSP call hierarchy.`);
            return { nodes: [], edges: [], lspUsed: false, warnings };
        }

        // Step 1: Get all symbols in the document
        const documentSymbols = await this.getDocumentSymbols(uri);
        if (documentSymbols.length === 0) {
            warnings.push('No document symbols found. LSP may not be available for this language.');
            return { nodes: [], edges: [], lspUsed: false, warnings };
        }

        // Flatten and filter to callable symbols
        const allSymbols = this.flattenSymbols(documentSymbols);
        const callableSymbols = this.filterCallableSymbols(allSymbols);

        // Add all symbols as nodes (for reference targets)
        for (const symbol of allSymbols) {
            const id = this.buildSymbolId(uri, symbol.name);
            if (!nodes.has(id)) {
                nodes.set(id, {
                    id,
                    name: symbol.name,
                    kind: symbol.kind,
                    line: symbol.selectionRange.start.line + 1, // 1-indexed
                    category: this.getCategory(symbol.kind),
                });
            }
        }

        // Limit symbols to analyze for performance
        const symbolsToAnalyze = callableSymbols.slice(0, opts.maxSymbols);
        if (callableSymbols.length > opts.maxSymbols) {
            warnings.push(`Analyzing ${opts.maxSymbols} of ${callableSymbols.length} callable symbols.`);
        }

        log.debug(`Analyzing ${symbolsToAnalyze.length} callable symbols in ${uri.fsPath}`);

        // Step 2: For each callable symbol, get call hierarchy
        for (const symbol of symbolsToAnalyze) {
            const sourceId = this.buildSymbolId(uri, symbol.name);

            // Prepare call hierarchy at the symbol's position
            const hierarchyItems = await this.prepareCallHierarchy(
                uri,
                symbol.selectionRange.start
            );

            if (hierarchyItems.length === 0) {
                continue;
            }

            const item = hierarchyItems[0];

            // Step 3: Get outgoing calls if enabled
            if (opts.includeOutgoing) {
                const outgoingCalls = await this.getOutgoingCalls(item);

                for (const call of outgoingCalls) {
                    // Filter for intra-file calls only
                    if (call.to.uri.fsPath !== uri.fsPath) {
                        continue;
                    }

                    const targetId = this.buildSymbolId(uri, call.to.name);
                    const edgeKey = `${sourceId}->${targetId}`;

                    // Avoid duplicate edges
                    if (edgeSet.has(edgeKey)) {
                        continue;
                    }
                    edgeSet.add(edgeKey);

                    // Add target node if not already present
                    if (!nodes.has(targetId)) {
                        nodes.set(targetId, {
                            id: targetId,
                            name: call.to.name,
                            kind: call.to.kind,
                            line: call.to.selectionRange.start.line + 1,
                            category: this.getCategory(call.to.kind),
                        });
                    }

                    // Create edge with call locations
                    edges.push({
                        source: sourceId,
                        target: targetId,
                        type: 'call',
                        locations: call.fromRanges.map(range => ({
                            line: range.start.line + 1,
                            character: range.start.character + 1,
                        })),
                    });
                }
            }

            // Step 4: Get incoming calls if enabled
            if (opts.includeIncoming) {
                const incomingCalls = await this.getIncomingCalls(item);

                for (const call of incomingCalls) {
                    // Filter for intra-file calls only
                    if (call.from.uri.fsPath !== uri.fsPath) {
                        continue;
                    }

                    const callerId = this.buildSymbolId(uri, call.from.name);
                    const edgeKey = `${callerId}->${sourceId}`;

                    // Avoid duplicate edges
                    if (edgeSet.has(edgeKey)) {
                        continue;
                    }
                    edgeSet.add(edgeKey);

                    // Add caller node if not already present
                    if (!nodes.has(callerId)) {
                        nodes.set(callerId, {
                            id: callerId,
                            name: call.from.name,
                            kind: call.from.kind,
                            line: call.from.selectionRange.start.line + 1,
                            category: this.getCategory(call.from.kind),
                        });
                    }

                    // Create edge with call locations
                    edges.push({
                        source: callerId,
                        target: sourceId,
                        type: 'call',
                        locations: call.fromRanges.map(range => ({
                            line: range.start.line + 1,
                            character: range.start.character + 1,
                        })),
                    });
                }
            }
        }

        log.debug(`Built call graph: ${nodes.size} nodes, ${edges.length} edges`);

        return {
            nodes: Array.from(nodes.values()),
            edges,
            lspUsed: true,
            warnings,
        };
    }

    /**
     * Check if LSP call hierarchy is available for a given file.
     * 
     * @param uri - The URI of the file to check
     * @returns True if call hierarchy is available
     */
    async isCallHierarchyAvailable(uri: vscode.Uri): Promise<boolean> {
        try {
            // Try to get document symbols first as a basic check
            const symbols = await this.getDocumentSymbols(uri);
            if (symbols.length === 0) {
                return false;
            }

            // Try to prepare call hierarchy for the first callable symbol
            const flatSymbols = this.flattenSymbols(symbols);
            const callableSymbols = this.filterCallableSymbols(flatSymbols);

            if (callableSymbols.length === 0) {
                return false;
            }

            const items = await this.prepareCallHierarchy(
                uri,
                callableSymbols[0].selectionRange.start
            );

            return items.length > 0;
        } catch {
            return false;
        }
    }
}
