/**
 * Converter utilities for transforming Spider AST data into LSP-compatible format.
 *
 * Shared between the extension layer (SymbolViewService) and the MCP layer (logic.ts).
 */

import { normalizePath } from "./path";

/**
 * Map string kind to LSP SymbolKind number (vscode.SymbolKind enum)
 */
export function mapKindToLspNumber(kind: string): number {
  switch (kind.toLowerCase()) {
    case "function":
    case "method":
      return 12; // Function
    case "class":
      return 5; // Class
    case "variable":
    case "property":
      return 13; // Variable
    case "interface":
      return 11; // Interface
    default:
      return 13; // Variable (default)
  }
}

/**
 * Convert Spider's symbol graph data to LSP format
 */
export function convertSpiderToLspFormat(
  symbolGraphData: {
    symbols: Array<{ name: string; kind: string; line: number; parentSymbolId?: string }>;
    dependencies: Array<{ sourceSymbolId: string; targetSymbolId: string }>;
  },
  filePath: string,
): {
  symbols: Array<{ name: string; kind: number; range: { start: number; end: number }; containerName?: string; uri: string }>;
  callHierarchyItems: Map<string, { name: string; kind: number; uri: string; range: { start: number; end: number } }>;
  outgoingCalls: Map<string, Array<{ to: { name: string; kind: number; uri: string; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>>;
} {
  const normalizedFilePath = normalizePath(filePath);

  const extractSymbolName = (symbolId: string): string => {
    const separatorIndex = symbolId.lastIndexOf(":");
    if (separatorIndex < 0 || separatorIndex === symbolId.length - 1) {
      return symbolId;
    }
    return symbolId.slice(separatorIndex + 1);
  };

  // Convert Spider symbols to LSP format
  // Spider already provides fully-qualified names (e.g. "MyClass.calculate"),
  // so containerName must stay undefined to avoid double-qualification in
  // generateSymbolId which would produce "path:MyClass.calculate.MyClass.calculate".
  const lspSymbols = symbolGraphData.symbols.map((sym) => ({
    name: sym.name,
    kind: mapKindToLspNumber(sym.kind),
    range: { start: sym.line, end: sym.line },
    containerName: undefined,
    uri: normalizedFilePath,
  }));

  // Convert Spider dependencies to LSP call hierarchy format
  const callHierarchyItems = new Map<string, { name: string; kind: number; uri: string; range: { start: number; end: number } }>();
  const outgoingCalls = new Map<string, Array<{ to: { name: string; kind: number; uri: string; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>>();

  for (const symbol of lspSymbols) {
    callHierarchyItems.set(symbol.name, {
      name: symbol.name,
      kind: symbol.kind,
      uri: normalizedFilePath,
      range: symbol.range,
    });
  }

  for (const dep of symbolGraphData.dependencies) {
    const sourceSymbolName = extractSymbolName(dep.sourceSymbolId);
    const sourceSymbolId = `${normalizedFilePath}:${sourceSymbolName}`;
    if (!outgoingCalls.has(sourceSymbolId)) {
      outgoingCalls.set(sourceSymbolId, []);
    }

    // Extract symbol name from targetSymbolId (format: "filePath:symbolName")
    // This prevents LspCallHierarchyAnalyzer from double-concatenating the ID
    const symbolName = extractSymbolName(dep.targetSymbolId);

    outgoingCalls.get(sourceSymbolId)?.push({
      to: {
        name: symbolName,
        kind: 12,
        uri: normalizedFilePath,
        range: { start: 0, end: 0 },
      },
      fromRanges: [{ start: 0, end: 0 }],
    });
  }

  return {
    symbols: lspSymbols,
    callHierarchyItems,
    outgoingCalls,
  };
}
