import { describe, expect, it } from 'vitest';
import { computeNodeMetadata } from '../../../src/analyzer/NodeMetadataBuilder';
import { aggregateCommunityGroups } from '../../../src/analyzer/community/groupAggregation';
import type { GraphData } from '../../../src/shared/graph-types';

const ROOT = '/repo';
const api = `${ROOT}/src/api/a.ts`;
const api2 = `${ROOT}/src/api/b.ts`;
const db = `${ROOT}/src/db/c.ts`;
const rootFile = `${ROOT}/index.ts`;

function graph(edges: Array<[string, string]>, mode: 'path' | 'louvain' = 'path'): GraphData {
  const data: GraphData = {
    nodes: [api, api2, db, rootFile],
    edges: edges.map(([source, target]) => ({ source, target })),
  };
  computeNodeMetadata(data, ROOT, mode);
  return data;
}

describe('aggregateCommunityGroups', () => {
  it('counts intra and inter group file edges by path community', () => {
    const result = aggregateCommunityGroups(graph([[api, api2], [api, db], [api2, db], [rootFile, api]]));

    expect(result.groups).toEqual([
      { id: 1, key: 'api', label: 'api', fileCount: 2, internalEdgeCount: 1 },
      { id: 2, key: 'db', label: 'db', fileCount: 1, internalEdgeCount: 0 },
    ]);
    expect(result.unassigned).toEqual({ fileCount: 1, internalEdgeCount: 0 });
    expect(result.groupEdges).toEqual([
      { from: 0, to: 1, fileEdgeCount: 1 },
      { from: 1, to: 2, fileEdgeCount: 2 },
    ]);
    expect(result.totals).toEqual({ files: 4, fileEdges: 4, intraGroupEdges: 1, interGroupEdges: 3 });
  });

  it('counts each directed file pair once and keeps self-edges intra-group', () => {
    const result = aggregateCommunityGroups(graph([[api, db], [api, db], [db, api], [api, api]]));

    expect(result.groupEdges).toEqual([
      { from: 1, to: 2, fileEdgeCount: 1 },
      { from: 2, to: 1, fileEdgeCount: 1 },
    ]);
    expect(result.groups[0].internalEdgeCount).toBe(1);
    expect(result.totals).toEqual({ files: 4, fileEdges: 3, intraGroupEdges: 1, interGroupEdges: 2 });
  });

  it('reports unassigned files and their internal edges explicitly', () => {
    const other = `${ROOT}/main.ts`;
    const data = graph([[rootFile, other]]);
    data.nodes.push(other);
    computeNodeMetadata(data, ROOT, 'path');

    const result = aggregateCommunityGroups(data);

    expect(result.unassigned).toEqual({ fileCount: 2, internalEdgeCount: 1 });
    expect(result.groupEdges).toEqual([]);
    expect(result.totals.intraGroupEdges + result.totals.interGroupEdges).toBe(result.totals.fileEdges);
  });

  it('aggregates Louvain communities and leaves isolated files unassigned', () => {
    const result = aggregateCommunityGroups(graph([[api, api2], [api2, db]], 'louvain'));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ id: 1, fileCount: 3, internalEdgeCount: 2 });
    expect(result.unassigned).toEqual({ fileCount: 1, internalEdgeCount: 0 });
    expect(result.totals).toEqual({ files: 4, fileEdges: 2, intraGroupEdges: 2, interGroupEdges: 0 });
  });

  it('matches Windows backslash paths to their normalized metadata', () => {
    const winRoot = String.raw`C:\repo`;
    const winApi = String.raw`C:\repo\src\api\a.ts`;
    const winDb = String.raw`C:\repo\src\db\c.ts`;
    const data: GraphData = { nodes: [winApi, winDb], edges: [{ source: winApi, target: winDb }] };
    computeNodeMetadata(data, winRoot, 'path');

    const result = aggregateCommunityGroups(data);

    expect(result.groups.map(group => group.key)).toEqual(['api', 'db']);
    expect(result.groupEdges).toEqual([{ from: 1, to: 2, fileEdgeCount: 1 }]);
  });

  it('counts edge ends missing from nodes as unassigned files', () => {
    const result = aggregateCommunityGroups({ nodes: [], edges: [{ source: api, target: db }] });

    expect(result.groups).toEqual([]);
    expect(result.unassigned).toEqual({ fileCount: 2, internalEdgeCount: 1 });
    expect(result.totals).toEqual({ files: 2, fileEdges: 1, intraGroupEdges: 1, interGroupEdges: 0 });
  });
});
