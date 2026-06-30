import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { normalizePath } from '../../shared/path';
import { exportHtml } from '../../analyzer/export/HtmlExporter';
import { computeNodeMetadata } from '../../analyzer/NodeMetadataBuilder';
import type { CliRuntime } from '../runtime';
import type { GraphData } from '../../shared/graph-types';

type RawRecord = Record<string, unknown>;

function getStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNormalizedNodeId(node: RawRecord): string {
  const id = getStringValue(node['id']);
  if (id) {
    return normalizePath(id);
  }

  const filePath = getStringValue(node['path']);
  return filePath ? normalizePath(filePath) : '';
}

function getNormalizedEdgeEndpoint(edge: RawRecord, key: 'source' | 'target'): string {
  const value = getStringValue(edge[key]);
  return value ? normalizePath(value) : '';
}

function parseArchitectureOutput(raw: RawRecord): {
  rawNodes: RawRecord[];
  rawEdges: RawRecord[];
} {
  const rawNodes = Array.isArray(raw['nodes']) ? (raw['nodes'] as RawRecord[]) : [];
  const rawEdges = Array.isArray(raw['edges']) ? (raw['edges'] as RawRecord[]) : [];
  return { rawNodes, rawEdges };
}

function buildGraphData(rawNodes: RawRecord[], rawEdges: RawRecord[]): GraphData {
  const graphData: GraphData = {
    nodes: rawNodes.map(getNormalizedNodeId),
    edges: rawEdges.map(edge => ({
      source: getNormalizedEdgeEndpoint(edge, 'source'),
      target: getNormalizedEdgeEndpoint(edge, 'target'),
    })),
    unusedEdges: [],
  };

  const parentCounts: Record<string, number> = {};
  for (const node of rawNodes) {
    const depCount = Number(node['dependentCount'] ?? 0);
    if (depCount <= 0) {
      continue;
    }

    const id = getNormalizedNodeId(node);
    if (id) {
      parentCounts[id] = depCount;
    }
  }

  if (Object.keys(parentCounts).length > 0) {
    graphData.parentCounts = parentCounts;
  }

  return graphData;
}

function filterGraphByScope(graphData: GraphData, resolvedScope?: string): void {
  if (!resolvedScope) {
    return;
  }

  const isFile = graphData.nodes.includes(resolvedScope);
  let kept: Set<string>;
  if (isFile) {
    kept = new Set([resolvedScope]);
    for (const edge of graphData.edges) {
      if (edge.source === resolvedScope) {
        kept.add(edge.target);
      }
      if (edge.target === resolvedScope) {
        kept.add(edge.source);
      }
    }
  } else {
    const prefix = resolvedScope.endsWith('/') ? resolvedScope : resolvedScope + '/';
    kept = new Set(graphData.nodes.filter(node => node === resolvedScope || node.startsWith(prefix)));
  }

  graphData.nodes = graphData.nodes.filter(node => kept.has(node));
  graphData.edges = graphData.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target));
  if (graphData.unusedEdges) {
    graphData.unusedEdges = graphData.unusedEdges.filter(edge => kept.has(edge));
  }
}

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
  const outputPath = normalizePath(typeof cmdValues.output === 'string'
    ? path.resolve(cmdValues.output)
    : path.join(process.cwd(), 'graph.html'));

  // Resolve scope: positional arg > scopePath from session state
  const rawScope = positionals[0] ?? scopePath;
  const resolvedScope = rawScope ? normalizePath(path.resolve(runtime.workspaceRoot, rawScope)) : undefined;

  // Build graph data by delegating to the architecture command (json format)
  const { run: architectureRun } = await import('./architecture.js');
  const jsonOutput = await architectureRun([], runtime, 'json');
  const raw = JSON.parse(jsonOutput) as RawRecord;
  const { rawNodes, rawEdges } = parseArchitectureOutput(raw);
  const graphData = buildGraphData(rawNodes, rawEdges);
  computeNodeMetadata(graphData, runtime.workspaceRoot); // populates hubScore + communityId

  // Scope filter: positional arg or state.lastFile narrows the graph
  filterGraphByScope(graphData, resolvedScope);

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
    workspaceRoot: runtime.workspaceRoot,
  });

  process.stdout.write(`Graph exported to ${outputPath}\n`);
}
