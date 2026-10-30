import { describe, expect, it } from 'vitest';
import { importBindings, namespaceUse } from '@/analyzer/utils/namespaceUsage';

const use = (source: string, local = 'ns') => {
  const { members, escapes } = namespaceUse('/x/app.ts', source, local);
  return { members: [...members].sort(), escapes };
};

describe('importBindings', () => {
  it('lists default, named, aliased and namespace imports', () => {
    const source = 'import d, { a, b as c } from "./m";\nimport * as all from "./n";\nimport "./side";';
    expect(importBindings('/x/app.ts', source)).toEqual([
      { specifier: './m', imported: 'default', local: 'd' },
      { specifier: './m', imported: 'a', local: 'a' },
      { specifier: './m', imported: 'b', local: 'c' },
      { specifier: './n', imported: '*', local: 'all' },
    ]);
  });
  it('returns nothing for a module without imports', () => {
    expect(importBindings('/x/app.ts', 'export const a = 1;')).toEqual([]);
    expect(importBindings('/x/app.ts', '')).toEqual([]);
  });
});

describe('namespaceUse', () => {
  it('collects member accesses, string-literal indexes and type members', () => {
    expect(use("import { ns } from './m';\nns.a(); ns['b'](); let t: ns.T;")).toEqual({ members: ['T', 'a', 'b'], escapes: false });
  });
  it.each([
    ['passed as a value', 'f(ns);'],
    ['destructured', 'const { a } = ns;'],
    ['dynamic index', 'ns[key]();'],
    ['re-exported', 'export { ns };'],
    ['shorthand property', 'const o = { ns };'],
    ['typeof query', 'type T = typeof ns;'],
  ])('escapes when %s', (_label, body) => {
    expect(use(`import { ns } from './m';\n${body}`).escapes).toBe(true);
  });
  it('ignores same-named properties and keys, and the import itself', () => {
    expect(use("import { ns } from './m';\nconst o = { ns: 1 }; o.ns; other.ns.x;")).toEqual({ members: [], escapes: false });
  });
  it('reports no use when the name never appears', () => {
    expect(use("import { ns } from './m';")).toEqual({ members: [], escapes: false });
  });
});
