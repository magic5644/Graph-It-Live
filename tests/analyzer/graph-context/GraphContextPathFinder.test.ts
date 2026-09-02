import { describe, expect, it } from 'vitest';
import { findShortestPath } from '../../../src/analyzer/graph-context/GraphContextPathFinder';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextSnapshot,
} from '../../../src/shared/graph-context-types';

const node = (
  id: string,
  name: string,
  path: string,
  kind: GraphContextNode['kind'] = 'symbol',
): GraphContextNode => ({ id, kind, name, path });

const nodes: GraphContextNode[] = [
  node('symbol:src/api/controller.ts:UserController:4', 'UserController', 'src/api/controller.ts'),
  node('symbol:src/db/repository.ts:UserRepository:9', 'UserRepository', 'src/db/repository.ts'),
  node('file:src/db/pool.ts', 'DatabasePool', 'src/db/pool.ts', 'file'),
  node('symbol:src/isolated.ts:Isolated:1', 'Isolated', 'src/isolated.ts'),
  node('symbol:src/tie/start.ts:TieStart:1', 'TieStart', 'src/tie/start.ts'),
  node('symbol:src/tie/zeta.ts:ZetaRoute:1', 'ZetaRoute', 'src/tie/zeta.ts'),
  node('symbol:src/tie/alpha.ts:AlphaRoute:1', 'AlphaRoute', 'src/tie/alpha.ts'),
  node('symbol:src/tie/target.ts:TieTarget:1', 'TieTarget', 'src/tie/target.ts'),
  node('symbol:src/api/scope-start.ts:ScopeStart:1', 'ScopeStart', 'src/api/scope-start.ts'),
  node('symbol:src/admin/bridge.ts:AdminBridge:1', 'AdminBridge', 'src/admin/bridge.ts'),
  node('symbol:src/api/scope-target.ts:ScopeTarget:1', 'ScopeTarget', 'src/api/scope-target.ts'),
];

const edge = (
  source: string,
  target: string,
  relation: GraphContextEdge['relation'] = 'CALLS',
): GraphContextEdge => ({ source, target, relation, confidence: 'EXTRACTED' });

const edges: GraphContextEdge[] = [
  edge(
    'symbol:src/api/controller.ts:UserController:4',
    'symbol:src/db/repository.ts:UserRepository:9',
  ),
  edge(
    'symbol:src/db/repository.ts:UserRepository:9',
    'file:src/db/pool.ts',
    'USES',
  ),
  edge(
    'symbol:src/tie/start.ts:TieStart:1',
    'symbol:src/tie/zeta.ts:ZetaRoute:1',
  ),
  edge(
    'symbol:src/tie/start.ts:TieStart:1',
    'symbol:src/tie/alpha.ts:AlphaRoute:1',
  ),
  edge(
    'symbol:src/tie/zeta.ts:ZetaRoute:1',
    'symbol:src/tie/target.ts:TieTarget:1',
  ),
  edge(
    'symbol:src/tie/alpha.ts:AlphaRoute:1',
    'symbol:src/tie/target.ts:TieTarget:1',
  ),
  edge(
    'symbol:src/api/scope-start.ts:ScopeStart:1',
    'symbol:src/admin/bridge.ts:AdminBridge:1',
  ),
  edge(
    'symbol:src/admin/bridge.ts:AdminBridge:1',
    'symbol:src/api/scope-target.ts:ScopeTarget:1',
  ),
];

const snapshot: GraphContextSnapshot = {
  revision: 'path-fixture',
  fresh: true,
  nodes,
  edges,
};

describe('findShortestPath', () => {
  it('returns a directed shortest path with ordered response edge indexes', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'UserController' },
      { label: 'DatabasePool' },
      { directed: true, maxHops: 8 },
    );

    expect(path).toEqual({
      nodeIds: [
        'symbol:src/api/controller.ts:UserController:4',
        'symbol:src/db/repository.ts:UserRepository:9',
        'file:src/db/pool.ts',
      ],
      edgeIndexes: [0, 1],
      hops: 2,
    });
  });

  it('does not traverse a reverse-only route when directed', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'DatabasePool' },
      { label: 'UserController' },
      { directed: true, maxHops: 8 },
    );

    expect(path).toBeNull();
  });

  it('returns null when no route connects the endpoints', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'Isolated' },
      { label: 'DatabasePool' },
      { directed: false, maxHops: 8 },
    );

    expect(path).toBeNull();
  });

  it('does not expand nodes beyond maxHops', () => {
    const tooShort = findShortestPath(
      snapshot,
      { label: 'UserController' },
      { label: 'DatabasePool' },
      { directed: true, maxHops: 1 },
    );
    const exact = findShortestPath(
      snapshot,
      { label: 'UserController' },
      { label: 'DatabasePool' },
      { directed: true, maxHops: 2 },
    );

    expect(tooShort).toBeNull();
    expect(exact?.hops).toBe(2);
  });

  it('applies relation filters before expanding an edge', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'UserController' },
      { label: 'DatabasePool' },
      { directed: true, maxHops: 8, relations: ['CALLS'] },
    );

    expect(path).toBeNull();
  });

  it('breaks equal-length path ties by ascending node ID', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'TieStart' },
      { label: 'TieTarget' },
      { directed: true, maxHops: 8 },
    );

    expect(path).toEqual({
      nodeIds: [
        'symbol:src/tie/start.ts:TieStart:1',
        'symbol:src/tie/alpha.ts:AlphaRoute:1',
        'symbol:src/tie/target.ts:TieTarget:1',
      ],
      edgeIndexes: [3, 5],
      hops: 2,
    });
  });

  it('traverses edges in reverse while retaining original indexes when directed is false', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'DatabasePool' },
      { label: 'UserController' },
      { directed: false, maxHops: 8 },
    );

    expect(path).toEqual({
      nodeIds: [
        'file:src/db/pool.ts',
        'symbol:src/db/repository.ts:UserRepository:9',
        'symbol:src/api/controller.ts:UserController:4',
      ],
      edgeIndexes: [1, 0],
      hops: 2,
    });
  });

  it('applies scope filters before expanding through an out-of-scope node', () => {
    const path = findShortestPath(
      snapshot,
      { label: 'ScopeStart' },
      { label: 'ScopeTarget' },
      { directed: true, maxHops: 8, scope: 'src/api/**' },
    );

    expect(path).toBeNull();
  });

  it('returns a zero-hop path when both endpoints resolve to the same node', () => {
    const path = findShortestPath(
      snapshot,
      { id: 'symbol:src/api/controller.ts:UserController:4' },
      { label: 'UserController' },
      { directed: true, maxHops: 0 },
    );

    expect(path).toEqual({
      nodeIds: ['symbol:src/api/controller.ts:UserController:4'],
      edgeIndexes: [],
      hops: 0,
    });
  });
});
