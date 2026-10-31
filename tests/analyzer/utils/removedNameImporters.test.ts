import { describe, expect, it, vi } from 'vitest';
import { findRemovedNameImporters, mentionsIdentifier, type ImporterSource } from '@/analyzer/utils/removedNameImporters';

/**
 * A fake workspace: `files` holds each file's content, `referrers` who the index says references a file, and
 * specifiers resolve by name (`./x` → `src/x.ts`, `.x` → `pkg/x.py`, `pkg` → `pkg/__init__.py`).
 */
function sourceOf(files: Record<string, string | null>, referrers: Record<string, string[] | string>): ImporterSource {
  return {
    referencingFiles: async (file) => referrers[file] ?? [],
    read: async (file) => files[file] ?? null,
    resolve: async (_from, specifier) => {
      if (specifier === 'pkg') return 'pkg/__init__.py';
      if (specifier.startsWith('./')) return `src/${specifier.slice(2)}.ts`;
      if (specifier.startsWith('.')) return `pkg/${specifier.slice(1)}.py`;
      return null;
    },
  };
}

describe('findRemovedNameImporters (#524)', () => {
  it.each([
    ['a named import that is never called', 'import { fn } from "./lib";\nexport const u = 3;\n', true],
    ['an aliased import', 'import { fn as g } from "./lib";\ng();\n', true],
    ['a type-only import', 'import type { fn } from "./lib";\n', true],
    ['a namespace import naming it', 'import * as lib from "./lib";\nlib.fn();\n', true],
    ['a namespace import not naming it', 'import * as lib from "./lib";\nlib.other();\n', false],
    ['a default import not naming it', 'import lib from "./lib";\nlib();\n', false],
    // Over-approximation: a default-imported object is not followed, so any mention counts, a local `fn` included.
    ['a default import naming it', 'import lib from "./lib";\nconst fn = lib.fn;\n', true],
    ['an import of another name', 'import { other } from "./lib";\n', false],
    ['a named re-export, which breaks too', 'export { fn } from "./lib";\n', true],
    ['an `export *` barrel, which does not', 'export * from "./lib";\n', false],
  ])('classifies %s', async (_label, content, listed) => {
    const source = sourceOf({ 'src/use.ts': content }, { 'src/lib.ts': ['src/use.ts'] });
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], source)).toEqual(listed ? ['src/use.ts'] : []);
  });

  it('counts an indexed referrer in an unparsed form (require, Vue SFC) when it names the symbol', async () => {
    const source = sourceOf(
      { 'src/req.ts': 'const { fn } = require("./lib");\n', 'src/other.ts': 'const lib = require("./lib");\n' },
      { 'src/lib.ts': ['src/req.ts', 'src/other.ts'] },
    );
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], source)).toEqual(['src/req.ts']);
  });

  it('does not credit an unparsed form to a file the index does not link to the module', async () => {
    const source = sourceOf({ 'src/changed.ts': 'const { fn } = require("./lib");\n' }, {});
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', ['src/changed.ts'], source)).toEqual([]);
  });

  it('checks the extra candidates the index does not list yet, on the first level only', async () => {
    const source = sourceOf(
      { 'src/new.ts': 'import { fn } from "./lib";\n', 'src/index.ts': 'export * from "./lib";\n', 'src/far.ts': 'import { fn } from "./lib";\n' },
      { 'src/lib.ts': ['src/index.ts'], 'src/index.ts': [] },
    );
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', ['src/new.ts', 'src/lib.ts'], source)).toEqual(['src/new.ts']);
  });

  it('follows barrels under the name they give the symbol, through chains and cycles', async () => {
    const source = sourceOf(
      {
        'src/index.ts': 'export * from "./lib";\nexport * from "./more";\n',
        'src/more.ts': 'export { fn as renamed } from "./index";\nexport * from "./index";\n',
        'src/app.ts': 'import { fn } from "./index";\n',
        'src/deep.ts': 'import { renamed } from "./more";\n',
        'src/blind.ts': 'import { other } from "./index";\n',
      },
      {
        'src/lib.ts': ['src/index.ts'],
        'src/index.ts': ['src/app.ts', 'src/more.ts', 'src/blind.ts'],
        'src/more.ts': ['src/deep.ts', 'src/index.ts'],
      },
    );
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], source)).toEqual(['src/app.ts', 'src/deep.ts', 'src/more.ts']);
  });

  it.each([
    ['from .lib import pfn', 'pkg/user1.py', 'from .lib import pfn\ndef u1(): return pfn(1)\n'],
    ['an aliased import', 'pkg/user1.py', 'from .lib import pfn as p\n'],
    ['a star import naming it', 'pkg/user1.py', 'from .lib import *\npfn(1)\n'],
  ])('finds a Python importer: %s', async (_label, file, content) => {
    const source = sourceOf({ [file]: content }, { 'pkg/lib.py': [file] });
    expect(await findRemovedNameImporters('pkg/lib.py', 'pfn', [], source)).toEqual([file]);
  });

  it('follows a Python package that re-exports the name: `from pkg import pfn`', async () => {
    const source = sourceOf(
      { 'pkg/__init__.py': 'from .lib import pfn\n', 'app.py': 'from pkg import pfn\n', 'other.py': 'from pkg import helper\n' },
      { 'pkg/lib.py': ['pkg/__init__.py'], 'pkg/__init__.py': ['app.py', 'other.py'] },
    );
    expect(await findRemovedNameImporters('pkg/lib.py', 'pfn', [], source)).toEqual(['app.py', 'pkg/__init__.py']);
  });

  it('ignores an import of the same name from another module, in a file the index does not link', async () => {
    const source = sourceOf({ 'src/changed.ts': 'import { fn } from "./elsewhere";\n' }, {});
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', ['src/changed.ts'], source)).toEqual([]);
  });

  it('skips unreadable files, and keeps an indexed referrer naming the symbol when its specifiers fail to resolve', async () => {
    const source = sourceOf(
      { 'src/use.ts': 'import { fn } from "./lib";\n', 'src/blind.ts': 'import { other } from "./lib";\n' },
      { 'src/lib.ts': ['src/gone.ts', 'src/use.ts', 'src/blind.ts'] },
    );
    const failing = { ...source, resolve: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], failing)).toEqual(['src/use.ts']);
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], source)).toEqual(['src/use.ts']);
  });

  it('returns why a referrer list could not be read, at any level', async () => {
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], sourceOf({}, { 'src/lib.ts': 'index failed' }))).toBe('index failed');
    const nested = sourceOf({ 'src/index.ts': 'export * from "./lib";\n' }, { 'src/lib.ts': ['src/index.ts'], 'src/index.ts': 'barrel failed' });
    expect(await findRemovedNameImporters('src/lib.ts', 'fn', [], nested)).toBe('barrel failed');
  });

  it('reads each candidate file once', async () => {
    const source = sourceOf({ 'src/use.ts': 'import { fn } from "./lib";\n' }, { 'src/lib.ts': ['src/use.ts', 'src/use.ts'] });
    const read = vi.fn(source.read);
    await findRemovedNameImporters('src/lib.ts', 'fn', ['src/use.ts'], { ...source, read });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('mentionsIdentifier', () => {
  it.each([
    ['fn()', 'fn', true],
    ['x = lib.fn', 'fn', true],
    ['fnx()', 'fn', false],
    ['my_fn()', 'fn', false],
    ['$fn()', 'fn', false],
    ['fn$()', 'fn', false],
    ['a fnx fn', 'fn', true],
    ['', 'fn', false],
    ['anything', '', false],
  ])('%j names %j: %s', (content, name, expected) => {
    expect(mentionsIdentifier(content, name)).toBe(expected);
  });
});
