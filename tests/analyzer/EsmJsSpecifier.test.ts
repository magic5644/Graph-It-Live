import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { PathResolver } from '../../src/analyzer/utils/PathResolver';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

/**
 * TypeScript's NodeNext/ESM resolution requires import specifiers to carry the
 * *emitted* extension: you write `./commands/scan.js` to import `scan.ts`.
 * Without the remap those edges are silently missing from the dependency graph —
 * in this repository that hid every dynamic import of the CLI dispatcher, so the
 * command modules looked as though nothing referenced them.
 */
describe('PathResolver - emitted ESM specifiers', () => {
  let resolver: PathResolver;
  const rootDir = path.resolve(process.cwd(), 'temp-esm-root');
  const np = (value: string) => normalizePath(value);

  /** Mock a filesystem containing exactly the given files. */
  const withFiles = (...files: string[]) => {
    const present = new Set(files.map(np));
    vi.mocked(fs.stat).mockImplementation(async (candidate) => {
      if (present.has(np(candidate.toString()))) {
        return { isFile: () => true } as never;
      }
      throw new Error('ENOENT');
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new PathResolver();
  });

  it('resolves a .js specifier to the .ts source', async () => {
    const source = path.join(rootDir, 'commands', 'scan.ts');
    withFiles(source);

    const resolved = await resolver.resolve(path.join(rootDir, 'index.ts'), './commands/scan.js');

    expect(resolved).toBe(np(source));
  });

  it('resolves a .js specifier to a .tsx source', async () => {
    const source = path.join(rootDir, 'ui', 'Panel.tsx');
    withFiles(source);

    const resolved = await resolver.resolve(path.join(rootDir, 'index.ts'), './ui/Panel.js');

    expect(resolved).toBe(np(source));
  });

  it('resolves .mjs to .mts and .cjs to .cts', async () => {
    const esm = path.join(rootDir, 'esm.mts');
    const cjs = path.join(rootDir, 'legacy.cts');
    withFiles(esm, cjs);
    const from = path.join(rootDir, 'index.ts');

    expect(await resolver.resolve(from, './esm.mjs')).toBe(np(esm));
    expect(await resolver.resolve(from, './legacy.cjs')).toBe(np(cjs));
  });

  it('prefers a real .js file over the .ts remap', async () => {
    // A genuine JavaScript file on disk must win: the remap is a fallback, not an
    // override, or a mixed JS/TS project would resolve to the wrong file.
    const real = path.join(rootDir, 'vendor', 'shim.js');
    const shadow = path.join(rootDir, 'vendor', 'shim.ts');
    withFiles(real, shadow);

    const resolved = await resolver.resolve(path.join(rootDir, 'index.ts'), './vendor/shim.js');

    expect(resolved).toBe(np(real));
  });

  it('leaves an unresolvable specifier unresolved', async () => {
    withFiles(path.join(rootDir, 'index.ts'));

    const resolved = await resolver.resolve(path.join(rootDir, 'index.ts'), './missing.js');

    expect(resolved).toBeNull();
  });

  it('still resolves an extensionless specifier', async () => {
    const source = path.join(rootDir, 'commands', 'scan.ts');
    withFiles(source);

    const resolved = await resolver.resolve(path.join(rootDir, 'index.ts'), './commands/scan');

    expect(resolved).toBe(np(source));
  });
});
