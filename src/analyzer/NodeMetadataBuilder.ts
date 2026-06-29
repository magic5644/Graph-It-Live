import * as path from 'node:path';
import type { GraphData, GraphNodeMetadata } from '../shared/graph-types.js';
import { normalizePath } from '../shared/path.js';

/**
 * Computes and attaches `nodeMetadata` to a `GraphData` object.
 *
 * Must be called AFTER `parentCounts` has been populated on `graphData`.
 * Does NOT perform any filesystem reads.
 *
 * hubScore = parentCount / maxParentCount, rounded to 3 decimal places.
 * Guard: when maxParentCount === 0, all hubScores are 0.
 *
 * fileExtension: path.extname(filePath).slice(1).toLowerCase(), omitted if empty.
 * loc: not computed here (would require FS read) — absent on all nodes.
 *
 * CRITICAL ARCHITECTURE RULE: NO import from 'vscode' — pure Node.js only.
 */
export function computeNodeMetadata(graphData: GraphData): void {
  const nodes = graphData.nodes;
  if (nodes.length === 0) return;

  const parentCounts = graphData.parentCounts ?? {};

  const maxCount = Math.max(
    ...nodes.map((p) => parentCounts[normalizePath(p)] ?? 0),
    1,
  );

  const nodeMetadata: Record<string, GraphNodeMetadata> = {};

  for (const filePath of nodes) {
    const key = normalizePath(filePath);
    const rawCount = parentCounts[key] ?? 0;
    const hubScore = Math.round((rawCount / maxCount) * 1000) / 1000;
    const ext = path.extname(filePath).slice(1).toLowerCase();

    const meta: GraphNodeMetadata = { hubScore };
    if (ext) meta.fileExtension = ext;
    nodeMetadata[key] = meta;
  }

  graphData.nodeMetadata = nodeMetadata;
}
