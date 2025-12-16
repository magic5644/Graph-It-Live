import type { Dependency, SpiderConfig } from '../types';
import { normalizePath } from '../types';
import { isInIgnoredDirectory } from '../utils/PathPredicates';
import { SpiderDependencyAnalyzer } from './SpiderDependencyAnalyzer';

/**
 * Single responsibility: traverse the dependency graph and build (or extend) a graph view model.
 */
export class SpiderGraphCrawler {
  constructor(
    private readonly dependencyAnalyzer: SpiderDependencyAnalyzer,
    private readonly getConfig: () => SpiderConfig
  ) {}

  async crawl(
    startPath: string
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    const nodes = new Set<string>();
    const edges: { source: string; target: string }[] = [];
    const edgeIds = new Set<string>();
    const visited = new Set<string>();
    const nodeLabels: Record<string, string> = {};

    const crawlRecursive = async (filePath: string, depth: number) => {
      const normalizedFile = normalizePath(filePath);
      const maxDepth = this.getConfig().maxDepth ?? 3;
      if (depth > maxDepth) return;

      if (visited.has(normalizedFile)) return;
      visited.add(normalizedFile);
      nodes.add(normalizedFile);

      try {
        const dependencies = await this.dependencyAnalyzer.analyze(filePath);

        for (const dep of dependencies) {
          nodes.add(dep.path);
          const edgeId = `${normalizedFile}->${dep.path}`;
          if (!edgeIds.has(edgeId)) {
            edgeIds.add(edgeId);
            edges.push({ source: normalizedFile, target: dep.path });
          }

          if (dep.module.startsWith('@') && dep.module.includes('/') && !dep.module.startsWith('@/')) {
            nodeLabels[dep.path] = dep.module;
          }

          if (!isInIgnoredDirectory(dep.path)) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }
      } catch {
        // External package/unreadable: skip
      }
    };

    await crawlRecursive(startPath, 0);

    return {
      nodes: Array.from(nodes),
      edges,
      nodeLabels: Object.keys(nodeLabels).length > 0 ? nodeLabels : undefined,
    };
  }

  async crawlFrom(
    startNode: string,
    existingNodes: Set<string>,
    extraDepth: number = 10,
    options?: {
      onBatch?: (batch: { nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }) => Promise<void> | void;
      batchSize?: number;
      signal?: AbortSignal;
      totalHint?: number;
    }
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    const newNodes = new Set<string>();
    const newEdges: { source: string; target: string }[] = [];
    const visited = new Set<string>();
    const nodeLabels: Record<string, string> = {};

    const normalizedExisting = new Set(Array.from(existingNodes).map((n) => normalizePath(n)));
    const normalizedStartNode = normalizePath(startNode);

    const batchNodes = new Set<string>();
    const batchEdges: { source: string; target: string }[] = [];
    const edgeIds = new Set<string>();
    const batchLabels: Record<string, string> = {};
    const batchSize = options?.batchSize ?? 200;

    const throwIfAborted = (): void => {
      if (options?.signal?.aborted) {
        const error = new Error('Expansion cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };

    const shouldSkipNode = (normalizedFile: string, depth: number): boolean => {
      if (depth > extraDepth) return true;
      if (normalizedFile === normalizedStartNode) {
        return depth !== 0 && visited.has(normalizedFile);
      }
      return visited.has(normalizedFile);
    };

    const processNewNode = (normalizedFile: string): void => {
      if (!normalizedExisting.has(normalizedFile)) {
        newNodes.add(normalizedFile);
        batchNodes.add(normalizedFile);
      }
    };

    const processDependency = (dep: Dependency, normalizedFile: string): void => {
      const edgeId = `${normalizedFile}->${dep.path}`;
      if (!edgeIds.has(edgeId)) {
        edgeIds.add(edgeId);
        newEdges.push({ source: normalizedFile, target: dep.path });
        batchEdges.push({ source: normalizedFile, target: dep.path });
      }

      if (!visited.has(dep.path) && !normalizedExisting.has(dep.path)) {
        newNodes.add(dep.path);
        batchNodes.add(dep.path);
      }

      if (dep.module.startsWith('@') && dep.module.includes('/') && !dep.module.startsWith('@/')) {
        nodeLabels[dep.path] = dep.module;
        batchLabels[dep.path] = dep.module;
      }
    };

    const flushBatch = async (): Promise<void> => {
      if (!options?.onBatch) {
        batchNodes.clear();
        batchEdges.length = 0;
        return;
      }

      if (batchNodes.size === 0 && batchEdges.length === 0) {
        return;
      }

      const payload = {
        nodes: Array.from(batchNodes),
        edges: [...batchEdges],
        nodeLabels: Object.keys(batchLabels).length > 0 ? { ...batchLabels } : undefined,
      };

      batchNodes.clear();
      batchEdges.length = 0;
      for (const key of Object.keys(batchLabels)) {
        delete batchLabels[key];
      }

      await options.onBatch(payload);
    };

    const crawlRecursive = async (filePath: string, depth: number): Promise<void> => {
      throwIfAborted();
      const normalizedFile = normalizePath(filePath);

      if (shouldSkipNode(normalizedFile, depth)) return;

      visited.add(normalizedFile);
      processNewNode(normalizedFile);

      try {
        const dependencies = await this.dependencyAnalyzer.analyze(filePath);

        for (const dep of dependencies) {
          processDependency(dep, normalizedFile);

          if (!isInIgnoredDirectory(dep.path)) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }

        if (batchNodes.size + batchEdges.length >= batchSize) {
          await flushBatch();
        }
      } catch {
        // External package/unreadable: skip
      }
    };

    await crawlRecursive(startNode, 0);
    await flushBatch();

    return {
      nodes: Array.from(newNodes),
      edges: newEdges,
      nodeLabels: Object.keys(nodeLabels).length > 0 ? nodeLabels : undefined,
    };
  }
}

