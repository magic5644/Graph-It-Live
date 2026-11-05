import { describe, it, expect } from 'vitest';
import { declaresExport, exportsOnlyAsDefault, mayReExport, parseModule, parseNamespaceReExports, parseReExports } from '../../../src/analyzer/utils/reExports';

describe('parseReExports', () => {
  it('reads named, renamed and wildcard re-exports', () => {
    const content = [
      'export { a, b as c } from "./m";',
      'export * from "./n";',
    ].join('\n');
    expect(parseReExports('/x/index.ts', content)).toEqual([
      { specifier: './m', names: [{ imported: 'a', exported: 'a' }, { imported: 'b', exported: 'c' }] },
      { specifier: './n', names: 'all' },
    ]);
  });

  it('ignores namespace re-exports, local exports and plain imports', () => {
    const content = [
      'export * as ns from "./m";',
      'export const x = 1;',
      'export { x as y };',
      'import { z } from "./z";',
    ].join('\n');
    expect(parseReExports('/x/index.ts', content)).toEqual([]);
  });

  it('returns an empty list for empty or unparsable content', () => {
    expect(parseReExports('/x/index.ts', '')).toEqual([]);
    expect(() => parseReExports('/x/index.ts', 'export { from ;;')).not.toThrow();
  });
});

describe('mayReExport', () => {
  it.each(['export * from "./a";', 'export { a } from "./a";', 'export type { A } from "./a";', 'export * as ns from "./a";'])('detects %s', (line) => {
    expect(mayReExport(line)).toBe(true);
  });

  it.each(['export { a };', 'export type { A };', 'export*from "./a";'])('detects the local form %s', (line) => {
    expect(mayReExport(line)).toBe(true);
  });

  it('rejects plain modules', () => {
    expect(mayReExport('export const a = 1;\nimport { b } from "./b";')).toBe(false);
  });
});

describe('declaresExport', () => {
  it.each([
    'export function a() {}',
    'export class a {}',
    'export const a = 1, b = 2;',
    'export interface a {}',
    'const x = 1;\nexport { x as a };',
  ])('finds a declared export in %s', (content) => {
    expect(declaresExport('/x/m.ts', content, 'a')).toBe(true);
  });

  it('does not count re-exports, private declarations or other names', () => {
    expect(declaresExport('/x/m.ts', 'export { a } from "./m";', 'a')).toBe(false);
    expect(declaresExport('/x/m.ts', 'function a() {}', 'a')).toBe(false);
    expect(declaresExport('/x/m.ts', 'export function b() {}', 'a')).toBe(false);
    expect(declaresExport('/x/m.ts', 'export default function a() {}', 'a')).toBe(false);
  });
});

describe('exportsOnlyAsDefault', () => {
  it.each([
    'export default function a() {}',
    'export default async function a() {}',
    'export default function* a() {}',
    'export default class a {}',
    'export default abstract class a {}',
    'export\n  default\tfunction a() {}',
  ])('is true for %s', (source) => {
    expect(exportsOnlyAsDefault('/x/m.ts', source, 'a')).toBe(true);
  });

  it('is false when the name is also exported by name, or is another name', () => {
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function a() {}\nexport { a };', 'a')).toBe(false);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function a() {}', 'b')).toBe(false);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function ab() {}', 'a')).toBe(false);
  });

  it('is false for anonymous defaults, named exports and plain modules', () => {
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function () {}', 'a')).toBe(false);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export function a() {}', 'a')).toBe(false);
    expect(exportsOnlyAsDefault('/x/m.ts', 'const a = 1;', 'a')).toBe(false);
  });

  it('escapes `$` in the name', () => {
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function $a() {}', '$a')).toBe(true);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function xa() {}', '$a')).toBe(false);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function a$() {}', 'a$')).toBe(true);
    expect(exportsOnlyAsDefault('/x/m.ts', 'export default function a$b() {}', 'a')).toBe(false);
  });

  it('ignores a match that only appears in a comment or string', () => {
    expect(exportsOnlyAsDefault('/x/m.ts', '// export default function a() {}\nexport function a() {}', 'a')).toBe(false);
  });
});

describe('parseNamespaceReExports', () => {
  it('reads `export * as ns from` only', () => {
    const content = ['export * as ns from "./m";', 'export * from "./n";', 'export { a } from "./o";', 'export const x = 1;'].join('\n');
    expect(parseNamespaceReExports('/x/index.ts', content)).toEqual([{ specifier: './m', alias: 'ns' }]);
  });
  it('returns nothing for plain modules, empty files and local namespace exports', () => {
    expect(parseNamespaceReExports('/x/m.ts', 'export function a() {}')).toEqual([]);
    expect(parseNamespaceReExports('/x/m.ts', 'import * as ns from "./m"; export { ns };')).toEqual([]);
    expect(parseNamespaceReExports('/x/m.ts', '')).toEqual([]);
  });
});

describe('parseReExports - import then export', () => {
  it('follows named, aliased and default imports exported locally', () => {
    const content = ['import d, { a, b as c } from "./m";', 'export { a, c as renamed, d as dflt };'].join('\n');
    expect(parseReExports('/x/index.ts', content)).toEqual([
      { specifier: './m', names: [{ imported: 'a', exported: 'a' }] },
      { specifier: './m', names: [{ imported: 'b', exported: 'renamed' }] },
      { specifier: './m', names: [{ imported: 'default', exported: 'dflt' }] },
    ]);
  });
  it('ignores local declarations and unknown names exported without `from`', () => {
    expect(parseReExports('/x/m.ts', 'const a = 1; export { a, missing };')).toEqual([]);
    expect(parseReExports('/x/m.ts', 'import * as ns from "./m"; export { ns };')).toEqual([]);
  });
});

describe('parseModule', () => {
  it('parses a path and content once, under any spelling of the path, with parent pointers', () => {
    const content = 'export const a = 1;\n';
    const first = parseModule('/ws/cache-hit.ts', content);
    expect(parseModule(String.raw`\ws\cache-hit.ts`, content)).toBe(first);
    expect(first.statements[0].parent).toBe(first);
  });

  it('parses an edited file again, so a lookup never reads stale content', () => {
    const before = parseModule('/ws/edited.ts', 'export const a = 1;\n');
    expect(declaresExport('/ws/edited.ts', 'export const a = 1;\n', 'a')).toBe(true);
    const after = parseModule('/ws/edited.ts', 'export const b = 1;\n');
    expect(after).not.toBe(before);
    expect(declaresExport('/ws/edited.ts', 'export const b = 1;\n', 'a')).toBe(false);
    expect(declaresExport('/ws/edited.ts', 'export const b = 1;\n', 'b')).toBe(true);
  });

  it('keeps the 128 most recently used modules', () => {
    const content = 'export const x = 1;\n';
    const oldest = parseModule('/ws/lru-0.ts', content);
    const kept = parseModule('/ws/lru-1.ts', content);
    for (let index = 2; index <= 128; index++) parseModule(`/ws/lru-${index}.ts`, content);
    expect(parseModule('/ws/lru-1.ts', content)).toBe(kept);
    parseModule('/ws/lru-129.ts', content);
    expect(parseModule('/ws/lru-0.ts', content)).not.toBe(oldest);
  });
});
