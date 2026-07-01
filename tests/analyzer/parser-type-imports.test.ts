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
});