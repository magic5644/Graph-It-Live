import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { normalizePath } from '../../shared/path';
import { exportHtml } from '../../analyzer/export/HtmlExporter';
import { computeNodeMetadata } from '../../analyzer/NodeMetadataBuilder';
import type { CliRuntime } from '../runtime';
import type { GraphData } from '../../shared/graph-types';

export async function runExportHtml(
  runtime: CliRuntime,
  workspaceName: string,
  args: string[],
  scopePath?: string,
): Promise<void> {
  const { values: cmdValues, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' } },
    strict: false,
    allowPositionals: true,
  });
  const outputPath = typeof cmdValues.output === 'string'
    ? path.resolve(cmdValues.output)
    : path.join(process.cwd(), 'graph.html');

  // Resolve scope: positional arg > scopePath from session state
  const rawScope = positionals[0] ?? scopePath;
  const resolvedScope = rawScope ? normalizePath(path.resolve(runtime.workspaceRoot, rawScope)) : undefined;

  // Build graph data by delegating to the architecture command (json format)
  const { run: architectureRun } = await import('./architecture.js');
  const jsonOutput = await architectureRun([], runtime, 'json');
  const raw = JSON.parse(jsonOutput) as Record<string, unknown>;

  // Convert architecture output shape to GraphData
  const rawNodes = Array.isArray(raw['nodes']) ? (raw['nodes'] as Array<Record<string, unknown>>) : [];
  const rawEdges = Array.isArray(raw['edges']) ? (raw['edges'] as Array<Record<string, unknown>>) : [];

  const graphData: GraphData = {
    nodes: rawNodes.map(n => normalizePath(String(n['id'] ?? n['path'] ?? ''))),
    edges: rawEdges.map(e => ({
      source: normalizePath(String(e['source'] ?? '')),
      target: normalizePath(String(e['target'] ?? '')),
    })),
    unusedEdges: [],
  };

  // Reconstruct parentCounts from dependentCount field (nb of files that import each node)
  const parentCounts: Record<string, number> = {};
  for (const n of rawNodes) {
    const depCount = Number(n['dependentCount'] ?? 0);
    if (depCount > 0) {
      const id = normalizePath(String(n['id'] ?? n['path'] ?? ''));
      if (id) parentCounts[id] = depCount;
    }
  }
  if (Object.keys(parentCounts).length > 0) {
    graphData.parentCounts = parentCounts;
  }
  computeNodeMetadata(graphData); // populates hubScore + communityId

  // Scope filter: positional arg or state.lastFile narrows the graph
  if (resolvedScope) {
    const isFile = graphData.nodes.includes(resolvedScope);
    let kept: Set<string>;
    if (isFile) {
      // 1-hop neighborhood: scope node + direct imports + direct importers
      kept = new Set([resolvedScope]);
      for (const e of graphData.edges) {
        if (e.source === resolvedScope) kept.add(e.target);
        if (e.target === resolvedScope) kept.add(e.source);
      }
    } else {
      // Directory prefix: all nodes under that path
      const prefix = resolvedScope.endsWith('/') ? resolvedScope : resolvedScope + '/';
      kept = new Set(graphData.nodes.filter(n => n === resolvedScope || n.startsWith(prefix)));
    }
    graphData.nodes = graphData.nodes.filter(n => kept.has(n));
    graphData.edges = graphData.edges.filter(e => kept.has(e.source) && kept.has(e.target));
    if (graphData.unusedEdges) {
      graphData.unusedEdges = graphData.unusedEdges.filter(e => kept.has(e));
    }
  }

  const nodes = graphData.nodes.map(filePath => ({
    id: filePath,
    label: path.basename(filePath),
    hubScore: graphData.nodeMetadata?.[normalizePath(filePath)]?.hubScore,
    communityId: graphData.nodeMetadata?.[normalizePath(filePath)]?.communityId,
  }));

  const edges = graphData.edges.map(e => ({
    from: e.source,
    to: e.target,
    id: `${e.source}::${e.target}`,
  }));

  exportHtml({
    nodes,
    edges,
    unusedEdges: graphData.unusedEdges ?? [],
    workspaceName,
    outputPath,
  });

  process.stdout.write(`Graph exported to ${outputPath}\n`);
}
