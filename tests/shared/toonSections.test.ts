import { describe, expect, it } from 'vitest';
import { collectScalarFields, collectToonSections, encodeToonSections, formatToonScalarHeader } from '../../src/shared/toonSections';

describe('encodeToonSections', () => {
  it('encodes every array and the scalar fields of a crawl-like result', () => {
    const encoded = encodeToonSections({
      nodeCount: 2,
      nodes: [{ path: 'a.ts' }, { path: 'b.ts' }],
      edges: [{ source: 'a.ts', target: 'b.ts' }],
      circularDependencies: [['a.ts', 'b.ts']],
    });

    expect(encoded?.content).toBe([
      '# nodeCount=2',
      'nodes(path)',
      '[a.ts]',
      '[b.ts]',
      'edges(source,target)',
      '[a.ts,b.ts]',
      'circularDependencies(value)',
      '[a.ts|b.ts]',
    ].join('\n'));
    expect(JSON.parse(encoded?.encodedJson ?? '')).toEqual({
      nodes: [{ path: 'a.ts' }, { path: 'b.ts' }],
      edges: [{ source: 'a.ts', target: 'b.ts' }],
      circularDependencies: [{ value: ['a.ts', 'b.ts'] }],
    });
  });

  it('keeps callees, not only callers, and flattens the symbol record into the header', () => {
    const encoded = encodeToonSections({
      symbol: { name: 'run', startLine: 3 },
      callers: [{ sourceId: 'a.ts:main:1' }],
      callees: [{ targetId: 'b.ts:helper:9' }],
      totalCallers: 1,
    });

    expect(encoded?.content).toBe([
      '# symbol.name=run symbol.startLine=3 totalCallers=1',
      'callers(sourceId)',
      '[a.ts:main:1]',
      'callees(targetId)',
      '[b.ts:helper:9]',
    ].join('\n'));
  });

  it('names a root array with the given name, else infers it', () => {
    expect(encodeToonSections([{ file: 'a.ts' }], 'hits')?.content).toBe('hits(file)\n[a.ts]');
    expect(encodeToonSections([{ file: 'a.ts' }])?.content).toBe('files(file)\n[a.ts]');
  });

  it('returns null when there is no non-empty array', () => {
    expect(encodeToonSections({ count: 0, items: [] })).toBeNull();
    expect(encodeToonSections([])).toBeNull();
    expect(encodeToonSections('text')).toBeNull();
    expect(encodeToonSections(null)).toBeNull();
  });

  it('throws on a root array of primitives so callers can fall back to JSON', () => {
    expect(() => encodeToonSections([1, 2])).toThrow();
  });
});

describe('collectToonSections', () => {
  it('reads one level deeper when the top level holds no array', () => {
    expect(collectToonSections({ graph: { nodes: [{ id: 'a' }] } })).toEqual([
      { name: 'nodes', items: [{ id: 'a' }] },
    ]);
  });

  it('merges check-dependencies outgoing and incoming arrays', () => {
    expect(collectToonSections({
      outgoing: { dependencies: [{ path: 'b.ts' }] },
      incoming: { referencingFiles: [{ path: 'c.ts' }] },
    })).toEqual([{
      name: 'dependencies',
      items: [{ direction: 'outgoing', path: 'b.ts' }, { direction: 'incoming', path: 'c.ts' }],
    }]);
  });

  it('returns no section for a scalar-only object', () => {
    expect(collectToonSections({ count: 1, nested: { flag: true } })).toEqual([]);
  });
});

describe('formatToonScalarHeader', () => {
  it('skips encoded, array and empty values, and flattens nested records', () => {
    const header = formatToonScalarHeader(
      { a: 1, b: null, c: undefined, d: [1], omitted: { nodes: 2, deep: { x: 1 } } },
      [{ name: 'a', items: [] }],
    );

    expect(header).toBe('# omitted.nodes=2 omitted.deep.x=1\n');
  });

  it('returns an empty string for arrays, primitives and empty objects', () => {
    expect(formatToonScalarHeader([{ a: 1 }], [])).toBe('');
    expect(formatToonScalarHeader(3, [])).toBe('');
    expect(formatToonScalarHeader({}, [])).toBe('');
  });
});

describe('collectScalarFields', () => {
  it('returns unencoded scalars and flattens small scalar records', () => {
    const data = { nodes: [{ id: 'a' }], count: 2, omitted: { nodes: 1, deep: { x: 1 } }, none: null };

    expect(collectScalarFields(data, [{ name: 'nodes', items: [] }])).toEqual([['count', 2], ['omitted.nodes', 1], ['omitted.deep.x', 1]]);
  });

  it('returns nothing for arrays and primitives', () => {
    expect(collectScalarFields([{ a: 1 }], [])).toEqual([]);
    expect(collectScalarFields('x', [])).toEqual([]);
  });
});

describe('nested lists (review-pr structure and architecture)', () => {
  const review = {
    risk: 'low',
    changedFiles: ['a.ts'],
    architecture: { verdict: 'unchanged', rules: [{ name: 'r1', newViolations: 0 }] },
    structure: {
      verdict: 'changed',
      files: { before: 3, after: 3 },
      renames: { mapped: 3, complete: true },
      warnings: ['git could not map a file'],
      units: {
        items: [{ status: 'RENAMED', key: 'u/b' }],
        edges: [{ status: 'ADDED', from: 'u/a', to: 'u/b' }],
        cycles: [{ status: 'ADDED', members: ['u/a', 'u/b'] }],
        movedFiles: [{ file: 'b/x.ts', from: 'u/a', to: 'u/b' }],
        compared: { items: { before: 1, after: 1 }, unchangedItems: 0 },
      },
      groups: { items: [{ status: 'ADDED', key: 'g' }], edges: [], cycles: [], movedFiles: [] },
    },
  };

  it('encodes every nested list under its dotted path and every nested scalar in the header', () => {
    const content = encodeToonSections(review)?.content ?? '';

    for (const name of [
      'changedFiles', 'architecture.rules', 'structure.warnings', 'structure.units.items', 'structure.units.edges',
      'structure.units.cycles', 'structure.units.movedFiles', 'structure.groups.items',
    ]) {
      expect(content, name).toContain(`\n${name}(`);
    }
    expect(content).toContain('[RENAMED,u/b]');
    expect(content).toContain('[b/x.ts,u/a,u/b]');
    expect(content).toContain('[git could not map a file]');
    expect(content).not.toContain('structure.groups.edges(');
    for (const scalar of ['structure.verdict=changed', 'structure.files.before=3', 'structure.renames.mapped=3', 'structure.renames.complete=true', 'structure.units.compared.items.before=1']) {
      expect(content.split('\n')[0]).toContain(scalar);
    }
    expect(JSON.parse(encodeToonSections(review)?.encodedJson ?? '')).toHaveProperty(['structure.units.edges']);
  });

  it('leaves payloads without nested lists unchanged', () => {
    expect(encodeToonSections({ nodes: [{ id: 'a' }], meta: { n: 1 } })?.content).toBe('# meta.n=1\nnodes(id)\n[a]');
  });
});
