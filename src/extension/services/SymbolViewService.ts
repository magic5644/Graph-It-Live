import { Spider } from '../../analyzer/Spider';
import type { SymbolInfo, SymbolDependency } from '../../shared/types';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
};

interface SymbolGraphResult {
  nodes: string[];
  edges: { source: string; target: string }[];
  symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  referencingFiles: string[];
  parentCounts?: Record<string, number>;
}

export class SymbolViewService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  async buildSymbolGraph(resolvedFilePath: string, rootNodeId: string): Promise<SymbolGraphResult> {
    const symbolData = await this.spider.getSymbolGraph(resolvedFilePath);
    const referencingDependency = await this.spider.findReferencingFiles(resolvedFilePath);
    const referencingFiles = referencingDependency.map((d) => d.path);

    const payload = this.buildPayload(symbolData, resolvedFilePath, rootNodeId);

    return {
      ...payload,
      symbolData,
      referencingFiles,
      parentCounts: referencingFiles.length > 0 ? { [rootNodeId]: referencingFiles.length } : undefined,
    };
  }

  private buildPayload(
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    resolvedFilePath: string,
    rootNodeId: string
  ) {
    const nodes = new Set<string>([rootNodeId]);

    symbolData.symbols
      .filter((s) => !s.parentSymbolId)
      .forEach((s) => nodes.add(s.id));

    symbolData.dependencies.forEach((d) => {
      if (!d.targetSymbolId.startsWith(resolvedFilePath)) {
        nodes.add(d.targetSymbolId);
      }
    });

    const edges: { source: string; target: string }[] = [];
    symbolData.symbols
      .filter((s) => s.isExported && !s.parentSymbolId)
      .forEach((s) => edges.push({ source: rootNodeId, target: s.id }));
    symbolData.dependencies.forEach((d) => edges.push({ source: d.sourceSymbolId, target: d.targetSymbolId }));

    this.logger.debug('Built symbol graph payload', nodes.size, 'nodes');

    return {
      nodes: Array.from(nodes),
      edges,
    };
  }
}
