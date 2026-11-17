import { describe, it, expect } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';

describe('Parser - Type-Only Imports', () => {
  it('should skip type-only imports and exports when configured', () => {
    const parser = new Parser(undefined, true);

    const content = `
import type { Foo } from './foo';
import { Bar } from './bar';
export type { Baz } from './baz';
export { Quux } from './quux';
`;

    const imports = parser.parse(content, '/project/file.ts');

    expect(imports).toHaveLength(2);
    expect(imports.map((entry) => entry.module)).toEqual(['./bar', './quux']);
  });

  it('should keep type-only imports and exports when not configured to ignore them', () => {
    const parser = new Parser();

    const content = `
import type { Foo } from './foo';
import { Bar } from './bar';
export type { Baz } from './baz';
export { Quux } from './quux';
`;

    const imports = parser.parse(content, '/project/file.ts');

    expect(imports).toHaveLength(4);
    expect(imports.map((entry) => entry.module)).toEqual([
      './foo',
      './bar',
      './baz',
      './quux',
    ]);
  });

  it('should skip TS 5+ per-specifier type-only imports when configured', () => {
    const parser = new Parser(undefined, true);

    const content = `
import { type Foo } from './foo';
import { type Bar, type Baz } from './types';
import { Quux } from './quux';
export { type Corge } from './corge';
`;

    const imports = parser.parse(content, '/project/file.ts');

    expect(imports).toHaveLength(1);
    expect(imports.map((entry) => entry.module)).toEqual(['./quux']);
  });

  it('should NOT skip mixed imports (type + value specifiers) when configured', () => {
    const parser = new Parser(undefined, true);

    const content = `
import { type Foo, Bar } from './mixed';
import { type Baz, type Qux } from './types-only';
import { Value } from './value';
`;

    const imports = parser.parse(content, '/project/file.ts');

    // './mixed' has a value specifier (Bar) → must be kept
    // './types-only' has only type specifiers → skipped
    // './value' is a value import → kept
    expect(imports).toHaveLength(2);
    expect(imports.map((entry) => entry.module)).toEqual(['./mixed', './value']);
  });

  describe('typeOnly flag (#740)', () => {
    const parse = (content: string) => new Parser().parse(content, '/project/file.ts');
    const flags = (content: string) => parse(content).map((entry) => [entry.module, entry.typeOnly === true]);

    it('flags import type, all-type specifiers, export type and export type *', () => {
      expect(flags(`
import type { A } from './a';
import { type B, type C as D } from './b';
export type { E } from './e';
export type * from './f';
import type G from './g';
`)).toEqual([['./a', true], ['./b', true], ['./g', true], ['./e', true], ['./f', true]]);
    });

    it('keeps value imports, mixed specifiers, export * and require/import()/bare imports runtime', () => {
      expect(flags(`
import { v } from './v';
import { type T, w } from './mixed';
import Def, { type X } from './default';
export { r } from './re';
export * from './star';
const c = require('./cjs');
const d = import('./dyn');
import './side';
`)).toEqual([
        ['./v', false], ['./mixed', false], ['./default', false], ['./re', false], ['./star', false],
        ['./cjs', false], ['./dyn', false], ['./side', false],
      ]);
    });

    it('drops the flag when a later statement imports the same module at runtime', () => {
      expect(flags(`
import type { A } from './a';
import { a } from './a';
import type { B } from './b';
export { b } from './b';
import type { C } from './c';
const c = import('./c');
import type { D } from './d';
import type { E } from './d';
`)).toEqual([['./a', false], ['./b', false], ['./c', false], ['./d', true]]);
    });

    it('keeps the first line and type of a module imported twice', () => {
      expect(parse("import type { A } from './a';\nimport { a } from './a';\n")).toEqual([{ module: './a', type: 'import', line: 1 }]);
    });

    it('still drops type-only imports when configured to ignore them', () => {
      const imports = new Parser(undefined, true).parse("import type { A } from './a';\nimport { a } from './a';\n", '/project/file.ts');
      expect(imports).toEqual([{ module: './a', type: 'import', line: 2 }]);
    });

    it('carries the flag through parseImports', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-type-only-'));
      try {
        const file = path.join(dir, 'x.ts');
        fs.writeFileSync(file, "import type { A } from './a';\nimport { b } from './b';\n");
        expect(await new Parser(dir).parseImports(file)).toEqual([
          { path: '', type: 'import', line: 1, module: './a', typeOnly: true },
          { path: '', type: 'import', line: 2, module: './b' },
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
