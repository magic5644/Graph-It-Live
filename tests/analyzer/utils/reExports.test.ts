import { describe, it, expect } from 'vitest';
import { declaresExport, exportsOnlyAsDefault, mayReExport, parseReExports } from '../../../src/analyzer/utils/reExports';

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
