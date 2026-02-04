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
    /** Direction of the call (outgoing = this calls someone, incoming = someone calls this) */
    direction?: 'outgoing' | 'incoming';
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

/**
 * Context for processing calls and references.
 * @private
 */
interface CallGraphContext {
    uri: vscode.Uri;
    sourceId: string;
    nodes: Map<string, CallNode>;
    edges: CallEdge[];
    edgeSet: Set<string>;
}

/**
 * Context for processing references.
 * @private
 */
interface ReferenceContext extends CallGraphContext {
    symbol: vscode.DocumentSymbol;
    allSymbols: vscode.DocumentSymbol[];
    processedReferences: Set<string>;
}

const DEFAULT_OPTIONS: Required<CallHierarchyOptions> = {
    maxSymbols: 500,
    includeIncoming: true, // Always enable incoming calls
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
     * Retries with delays to wait for language server
     */
    async prepareCallHierarchy(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<vscode.CallHierarchyItem[]> {
        // Retry logic for command availability
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                log.debug(`[Attempt ${attempt + 1}] Executing prepareCallHierarchy at ${position.line}:${position.character} in ${uri.fsPath}`);
                const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                    'vscode.prepareCallHierarchy',
                    uri,
                    position
                );
                log.debug(`prepareCallHierarchy returned ${items?.length ?? 0} items`);
                return items || [];
            } catch (error) {
                if (attempt < 2) {
                    log.debug(`Attempt ${attempt + 1} failed: ${error}. Retrying in ${(attempt + 1) * 200}ms...`);
                    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 200));
                } else {
                    log.debug(`Call hierarchy not available at position ${position.line}:${position.character}: ${error}`);
                    return [];
                }
            }
        }
        return [];
    }

    /**
     * Get outgoing calls (who does this symbol call?)
     */
    async getOutgoingCalls(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
        try {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.provideOutgoingCalls',
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
                'vscode.provideIncomingCalls',
                item
            );
            return calls || [];
        } catch {
            log.debug('Failed to get incoming calls for:', item.name);
            return [];
        }
    }

    /**
     * Get all references to this symbol (types, classes, imports, etc.)
     * This captures more than just function calls
     */
    async getSymbolReferences(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<vscode.Location[]> {
        try {
            log.info(`[REFERENCES-FETCH] Getting references for symbol at ${position.line}:${position.character}`);
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                uri,
                position
            );
            log.info(`[REFERENCES-FETCH] Command returned ${references?.length ?? 0} references`);
            return references || [];
        } catch (error) {
            log.info(`[REFERENCES-FETCH] Failed to get references: ${error}`);
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
    /**
     * Prepare document for LSP analysis by opening it and waiting for LSP readiness.
     * @private
     */
    private async prepareDocumentForLsp(uri: vscode.Uri): Promise<{ success: boolean; warning?: string }> {
        try {
            await vscode.workspace.openTextDocument(uri);
            log.debug(`Opened document for LSP analysis: ${uri.fsPath}`);

            // IMPORTANT: Wait for language server to index the document
            // VS Code's call hierarchy commands need time to be available
            // Retry multiple times with delay
            let commandAvailable = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    // Test if prepareCallHierarchy command is available
                    await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                        'vscode.prepareCallHierarchy',
                        uri,
                        new vscode.Position(0, 0)
                    );
                    commandAvailable = true;
                    log.debug(`Call hierarchy command available on attempt ${attempt + 1}`);
                    break;
                } catch {
                    if (attempt < 4) {
                        log.debug(`Attempt ${attempt + 1}: Call hierarchy not ready yet, waiting...`);
                        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
                    }
                }
            }

            if (!commandAvailable) {
                log.debug('Call hierarchy command not available after retries');
            }
            return { success: true };
        } catch (error) {
            return { success: false, warning: `Failed to open document: ${error}` };
        }
    }

    /**
     * Process outgoing calls for a symbol and add edges to the graph.
     * @private
     */
    private async processOutgoingCalls(
        symbol: vscode.DocumentSymbol,
        uri: vscode.Uri,
        sourceId: string,
        nodes: Map<string, CallNode>,
        edges: CallEdge[],
        edgeSet: Set<string>
    ): Promise<void> {
    // Prepare call hierarchy at the symbol's position
        const position = new vscode.Position(
            symbol.selectionRange.start.line,
            symbol.selectionRange.start.character + Math.floor(symbol.name.length / 2)
        );

        log.debug(`Attempting call hierarchy for ${symbol.name} at position ${position.line}:${position.character}`);

        const hierarchyItems = await this.prepareCallHierarchy(uri, position);

        if (hierarchyItems.length === 0) {
            log.debug(`No call hierarchy items found for ${symbol.name}`);
            return;
        }

        log.debug(`Found ${hierarchyItems.length} hierarchy items for ${symbol.name}`);

        const item = hierarchyItems[0];
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
                direction: 'outgoing',
                locations: call.fromRanges.map(range => ({
                    line: range.start.line + 1,
                    character: range.start.character + 1,
                })),
            });
        }
    }

    /**
     * Process incoming calls for a symbol and add edges to the graph.
     * @private
     */
    private async processIncomingCalls(
        symbol: vscode.DocumentSymbol,
        uri: vscode.Uri,
        sourceId: string,
        nodes: Map<string, CallNode>,
        edges: CallEdge[],
        edgeSet: Set<string>
    ): Promise<void> {
        const position = new vscode.Position(
            symbol.selectionRange.start.line,
            symbol.selectionRange.start.character + Math.floor(symbol.name.length / 2)
        );

        const hierarchyItems = await this.prepareCallHierarchy(uri, position);
        if (hierarchyItems.length === 0) {
            return;
        }

        const item = hierarchyItems[0];
        const incomingCalls = await this.getIncomingCalls(item);
        log.debug(`Symbol ${sourceId}: found ${incomingCalls.length} incoming calls`);

        for (const call of incomingCalls) {
            const callUri = call.from.uri;
            const callerId = this.buildSymbolId(callUri, call.from.name);
            log.debug(`  Adding incoming edge: ${callerId} -> ${sourceId}, from file: ${callUri.fsPath}`);
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
                direction: 'incoming',
                locations: call.fromRanges.map(range => ({
                    line: range.start.line + 1,
                    character: range.start.character + 1,
                })),
            });
        }
    }

    /**
     * Process references (intra-file and inter-file) for a symbol.
     * @private
     */
    private async processSymbolReferences(
        symbol: vscode.DocumentSymbol,
        uri: vscode.Uri,
        sourceId: string,
        allSymbols: vscode.DocumentSymbol[],
        nodes: Map<string, CallNode>,
        edges: CallEdge[],
        edgeSet: Set<string>
    ): Promise<void> {
        const refPosition = new vscode.Position(
            symbol.selectionRange.start.line,
            symbol.selectionRange.start.character + Math.floor(symbol.name.length / 2)
        );
        const references = await this.getSymbolReferences(uri, refPosition);
        log.info(`[REFERENCES] Symbol '${symbol.name}': found ${references.length} total references`);

        if (references.length === 0) {
            log.info(`[REFERENCES] No references found for '${symbol.name}' at ${uri.fsPath}:${refPosition.line}:${refPosition.character}`);
            return;
        }

        const processedReferences = new Set<string>();
        let intraFileRefCount = 0;
        let interFileRefCount = 0;

        log.info(`[REFERENCES] Processing ${references.length} references for '${symbol.name}'...`);

        // Create reference context
        const context: ReferenceContext = {
            uri,
            sourceId,
            symbol,
            allSymbols,
            nodes,
            edges,
            edgeSet,
            processedReferences,
        };

        for (const ref of references) {
            // Skip references in the same file at the definition location
            if (ref.uri.fsPath === uri.fsPath &&
                ref.range.start.line === symbol.selectionRange.start.line) {
                log.debug(`  Skipping definition location for ${symbol.name}`);
                continue;
            }

            // Handle intra-file references
            if (ref.uri.fsPath === uri.fsPath) {
                intraFileRefCount++;
                await this.processIntraFileReference(ref, context);
                continue;
            }

            // Handle inter-file references
            interFileRefCount++;
            await this.processInterFileReference(ref, context, interFileRefCount);
        }

        log.info(`[REFERENCES] Symbol '${symbol.name}' reference summary: ${intraFileRefCount} intra-file, ${interFileRefCount} inter-file`);
    }

    /**
     * Process an intra-file reference.
     * @private
     */
    private async processIntraFileReference(
        ref: vscode.Location,
        context: ReferenceContext
    ): Promise<void> {
        const containingSymbol = this.findContainingSymbol(context.allSymbols, ref.range.start);
        if (containingSymbol && containingSymbol.name !== context.symbol.name) {
            const refId = this.buildSymbolId(context.uri, containingSymbol.name);
            const refKey = `${refId}->reference-intra->${context.sourceId}`;

            if (!context.processedReferences.has(refKey)) {
                context.processedReferences.add(refKey);

                const edgeKey = `${refId}->${context.sourceId}`;
                if (!context.edgeSet.has(edgeKey)) {
                    context.edgeSet.add(edgeKey);
                    context.edges.push({
                        source: refId,
                        target: context.sourceId,
                        type: 'reference',
                        direction: 'outgoing',
                        locations: [{
                            line: ref.range.start.line + 1,
                            character: ref.range.start.character + 1,
                        }],
                    });
                    log.debug(`  ✓ Added intra-file reference edge: ${refId} -> ${context.sourceId}`);
                }
            }
        } else {
            log.debug(`  ✗ No containing symbol found for intra-file ref at line ${ref.range.start.line}`);
        }
    }

    /**
     * Process an inter-file reference.
     * @private
     */
    private async processInterFileReference(
        ref: vscode.Location,
        context: ReferenceContext,
        interFileRefCount: number
    ): Promise<void> {
        log.info(`[REFERENCES] Inter-file reference #${interFileRefCount} at ${ref.uri.fsPath}:${ref.range.start.line}:${ref.range.start.character}`);

        try {
            await vscode.workspace.openTextDocument(ref.uri);
            const symbolsAtRef = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                ref.uri
            ) || [];
            log.info(`[REFERENCES] Found ${symbolsAtRef.length} symbols in remote file`);

            const containingSymbol = this.findContainingSymbol(symbolsAtRef, ref.range.start);
            if (containingSymbol) {
                const refId = this.buildSymbolId(ref.uri, containingSymbol.name);
                const refKey = `${refId}->reference->${context.sourceId}`;
                log.info(`[REFERENCES] Found containing symbol: '${containingSymbol.name}' (refId: ${refId})`);

                if (context.processedReferences.has(refKey)) {
                    return;
                }
                context.processedReferences.add(refKey);

                // Add referencing symbol node if not present
                if (!context.nodes.has(refId)) {
                    context.nodes.set(refId, {
                        id: refId,
                        name: containingSymbol.name,
                        kind: containingSymbol.kind,
                        line: containingSymbol.selectionRange.start.line + 1,
                        category: this.getCategory(containingSymbol.kind),
                    });
                    log.info(`[REFERENCES] Added new node: ${refId}`);
                }

                // Add reference edge
                const edgeKey = `${refId}->${context.sourceId}`;
                if (context.edgeSet.has(edgeKey)) {
                    log.info(`[REFERENCES] Edge already exists: ${edgeKey}`);
                } else {
                    context.edgeSet.add(edgeKey);
                    context.edges.push({
                        source: refId,
                        target: context.sourceId,
                        type: 'reference',
                        direction: 'incoming',
                        locations: [{
                            line: ref.range.start.line + 1,
                            character: ref.range.start.character + 1,
                        }],
                    });
                    log.info(`[REFERENCES] ✓ Added reference edge: '${containingSymbol.name}' -> '${context.symbol.name}'`);
                }
            } else {
                log.info(`[REFERENCES] ✗ No containing symbol found at ${ref.uri.fsPath}:${ref.range.start.line}`);
            }
        } catch (refError) {
            log.info(`[REFERENCES] ✗ Failed to process reference at ${ref.uri.fsPath}: ${refError}`);
        }
    }

    async buildIntraFileCallGraph(
        uri: vscode.Uri,
        options: CallHierarchyOptions = {}
    ): Promise<IntraFileCallGraph> {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const warnings: string[] = [];
        const nodes = new Map<string, CallNode>();
        const edges: CallEdge[] = [];
        const edgeSet = new Set<string>();

        // Check file size limit
        if (await this.isFileTooLarge(uri, opts.maxFileLines)) {
            warnings.push(`File exceeds ${opts.maxFileLines} lines. Skipping LSP call hierarchy.`);
            return { nodes: [], edges: [], lspUsed: false, warnings };
        }

        // Prepare document for LSP analysis
        const prepResult = await this.prepareDocumentForLsp(uri);
        if (!prepResult.success) {
            warnings.push(prepResult.warning!);
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
                    line: symbol.selectionRange.start.line + 1,
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

        // Step 2: For each callable symbol, analyze calls and references
        for (const symbol of symbolsToAnalyze) {
            const sourceId = this.buildSymbolId(uri, symbol.name);

            // Step 3: Process outgoing calls if enabled
            if (opts.includeOutgoing) {
                await this.processOutgoingCalls(symbol, uri, sourceId, nodes, edges, edgeSet);
            }

            // Step 4: Process incoming calls if enabled
            if (opts.includeIncoming) {
                await this.processIncomingCalls(symbol, uri, sourceId, nodes, edges, edgeSet);
            }

            // Step 5: Process references for complete picture
            await this.processSymbolReferences(symbol, uri, sourceId, allSymbols, nodes, edges, edgeSet);
        }

        const referenceEdgeCount = edges.filter(e => e.type === 'reference').length;
        log.info(`[REFERENCES] FINAL GRAPH: ${nodes.size} nodes, ${edges.length} total edges (including ${referenceEdgeCount} reference edges)`);

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

    /**
     * Find the symbol (class, function, etc.) that contains a given position
     */
    private findContainingSymbol(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): vscode.DocumentSymbol | undefined {
        for (const symbol of symbols) {
            // Check if position is within this symbol's range
            if (this.isPositionInRange(position, symbol.range)) {
                // Check children first (more specific)
                if (symbol.children) {
                    const childSymbol = this.findContainingSymbol(symbol.children, position);
                    if (childSymbol) {
                        return childSymbol;
                    }
                }
                // Return this symbol if no more specific child found
                return symbol;
            }
        }
        return undefined;
    }

    /**
     * Check if a position is within a range
     */
    private isPositionInRange(position: vscode.Position, range: vscode.Range): boolean {
        const start = range.start;
        const end = range.end;

        // After start
        if (position.line < start.line ||
            (position.line === start.line && position.character < start.character)) {
            return false;
        }

        // Before end
        if (position.line > end.line ||
            (position.line === end.line && position.character > end.character)) {
            return false;
        }

        return true;
    }
}
