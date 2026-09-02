import { describe, expect, it } from 'vitest';
import { resolveSeeds } from '../../../src/analyzer/graph-context/GraphContextResolver';
import type {
  GraphContextNode,
  GraphContextSnapshot,
} from '../../../src/shared/graph-context-types';

const nodes: GraphContextNode[] = [
  {
    id: 'file:src/api/controller.ts',
    kind: 'file',
    name: 'controller.ts',
    path: 'src/api/controller.ts',
  },
  {
    id: 'symbol:src/api/controller.ts:UserController:4',
    kind: 'symbol',
    name: 'UserController',
    path: 'src/api/controller.ts',
    startLine: 4,
  },
  {
    id: 'symbol:src/admin/controller.ts:UserController:8',
    kind: 'symbol',
    name: 'UserController',
    path: 'src/admin/controller.ts',
    startLine: 8,
  },
  {
    id: 'file:src/db/pool.ts',
    kind: 'file',
    name: 'pool.ts',
    path: 'src/db/pool.ts',
  },
  {
    id: 'symbol:src/db/pool.ts:DatabasePool:3',
    kind: 'symbol',
    name: 'DatabasePool',
    path: 'src/db/pool.ts',
    startLine: 3,
  },
];

const snapshot: GraphContextSnapshot = {
  revision: 'resolver-fixture',
  fresh: true,
  nodes,
  edges: [],
};

describe('resolveSeeds', () => {
  it('selects an exact stable file-plus-symbol ID before conflicting seed fields', () => {
    const result = resolveSeeds({
      id: 'symbol:src/api/controller.ts:UserController:4',
      filePath: 'src/db/pool.ts',
      symbolName: 'DatabasePool',
      label: 'DatabasePool',
    }, snapshot);

    expect(result).toMatchObject({
      selected: { id: 'symbol:src/api/controller.ts:UserController:4' },
      ambiguous: false,
      notFound: false,
    });
    expect(result.candidates.map(candidate => candidate.node.id)).toEqual([
      'symbol:src/api/controller.ts:UserController:4',
    ]);
  });

  it('selects an exact normalized relative file path before a conflicting label', () => {
    const result = resolveSeeds({
      filePath: 'src\\api\\controller.ts',
      label: 'DatabasePool',
    }, snapshot);

    expect(result.selected?.id).toBe('file:src/api/controller.ts');
    expect(result.ambiguous).toBe(false);
    expect(result.notFound).toBe(false);
  });

  it('uses an exact symbol name plus normalized path before an unqualified name', () => {
    const result = resolveSeeds({
      filePath: './src\\admin\\controller.ts',
      symbolName: 'UserController',
    }, snapshot);

    expect(result.selected?.id).toBe('symbol:src/admin/controller.ts:UserController:8');
    expect(result.candidates).toHaveLength(1);
    expect(result.ambiguous).toBe(false);
  });

  it('returns every same-name symbol as an ambiguous candidate without a path', () => {
    const result = resolveSeeds({ symbolName: 'UserController' }, snapshot);

    expect(result.selected).toBeUndefined();
    expect(result.ambiguous).toBe(true);
    expect(result.notFound).toBe(false);
    expect(result.candidates.map(candidate => candidate.node.id)).toEqual([
      'symbol:src/admin/controller.ts:UserController:8',
      'symbol:src/api/controller.ts:UserController:4',
    ]);
    expect(new Set(result.candidates.map(candidate => candidate.score)).size).toBe(1);
  });

  it('returns a typed not-found result for a missing entity', () => {
    expect(resolveSeeds({ label: 'MissingGateway' }, snapshot)).toEqual({
      candidates: [],
      ambiguous: false,
      notFound: true,
    });
  });

  it('never resolves a case-insensitive label outside the requested scope', () => {
    const inScope = resolveSeeds(
      { label: 'usercontroller' },
      snapshot,
      'src/api/**',
    );
    const outOfScope = resolveSeeds(
      { label: 'databasepool' },
      snapshot,
      'src/api/**',
    );

    expect(inScope.selected?.id).toBe('symbol:src/api/controller.ts:UserController:4');
    expect(inScope.candidates.map(candidate => candidate.node.id)).toEqual([
      'symbol:src/api/controller.ts:UserController:4',
    ]);
    expect(outOfScope).toEqual({
      candidates: [],
      ambiguous: false,
      notFound: true,
    });
  });
});
