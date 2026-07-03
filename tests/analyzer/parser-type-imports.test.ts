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
});