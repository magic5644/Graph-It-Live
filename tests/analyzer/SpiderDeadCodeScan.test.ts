import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { SpiderErrorCode } from '../../src/analyzer/types';

describe('Spider - scanDeadCode', () => {
  const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/symbols');
  const utilsPath = path.join(fixturesDir, 'utils.ts');

  let spider: Spider;

  beforeAll(async () => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesDir)
      .withReverseIndex(true)
      .build();

    await spider.buildFullIndex();
  });

  it('should return the correct shape: { entries, scannedFiles, skippedFiles }', async () => {
    const result = await spider.scanDeadCode();

    expect(result).toHaveProperty('entries');
    expect(result).toHaveProperty('scannedFiles');
    expect(result).toHaveProperty('skippedFiles');
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.scannedFiles).toBe('number');
    expect(typeof result.skippedFiles).toBe('number');
  });

  it('should find unused symbols in utils.ts', async () => {
    const result = await spider.scanDeadCode();

    const utilsEntry = result.entries.find((e) => e.filePath === utilsPath);
    expect(utilsEntry).toBeDefined();

    const symbolNames = utilsEntry?.unusedSymbols.map((s) => s.name) ?? [];
    expect(symbolNames).toContain('unusedFunc');
    expect(symbolNames).toContain('UnusedType');
  });

  it('should count scannedFiles >= entries.length (total ≥ files with dead code)', async () => {
    const result = await spider.scanDeadCode();

    expect(result.scannedFiles).toBeGreaterThanOrEqual(result.entries.length);
  });

  it('should return 0 skippedFiles when all files parse successfully', async () => {
    const result = await spider.scanDeadCode();

    expect(result.skippedFiles).toBe(0);
  });

  it('should scope results when scopePath is a subdirectory', async () => {
    // Passing the exact fixturesDir should still work as a valid scope
    const result = await spider.scanDeadCode(fixturesDir);

    expect(result).toHaveProperty('entries');
    expect(result.scannedFiles).toBeGreaterThan(0);
  });

  it('reports no truncation when the scope fits maxFiles (#231)', async () => {
    const result = await spider.scanDeadCode(undefined, { maxFiles: 10_000 });

    expect(result.scannedFiles).toBeGreaterThan(1);
    expect(result.filesBeyondLimit).toBe(0);
  });

  it('reports the files left out when maxFiles is reached (#231)', async () => {
    const full = await spider.scanDeadCode(undefined, { maxFiles: 10_000 });
    const capped = await spider.scanDeadCode(undefined, { maxFiles: 1 });

    expect(capped.scannedFiles).toBe(1);
    expect(capped.filesBeyondLimit).toBe(full.scannedFiles - 1);
  });

  it('reports no truncation when maxFiles equals the number of files (#231)', async () => {
    const full = await spider.scanDeadCode(undefined, { maxFiles: 10_000 });
    const exact = await spider.scanDeadCode(undefined, { maxFiles: full.scannedFiles });

    expect(exact.scannedFiles).toBe(full.scannedFiles);
    expect(exact.filesBeyondLimit).toBe(0);
  });

  it('should throw INDEX_NOT_READY when reverse index is absent', async () => {
    const spiderWithoutIndex = new SpiderBuilder()
      .withRootDir(fixturesDir)
      .withReverseIndex(false)
      .build();

    await expect(spiderWithoutIndex.scanDeadCode()).rejects.toMatchObject({
      code: SpiderErrorCode.INDEX_NOT_READY,
    });
  });

  it('should throw INDEX_NOT_READY after reset (index cleared)', async () => {
    // A fresh spider with reverse index enabled but NOT yet indexed
    const freshSpider = new SpiderBuilder()
      .withRootDir(fixturesDir)
      .withReverseIndex(true)
      .build();

    // Do NOT call buildFullIndex — index is empty
    await expect(freshSpider.scanDeadCode()).rejects.toMatchObject({
      code: SpiderErrorCode.INDEX_NOT_READY,
    });
  });
});

describe('Spider - scanDeadCode through re-exports (#513)', () => {
  const root = path.resolve(process.cwd(), 'tests/analyzer/fixtures/reexport-barrels');
  let unusedByFile: Map<string, string[]>;
  let spider: Spider;

  const unused = (relativePath: string): string[] => unusedByFile.get(relativePath) ?? [];

  beforeAll(async () => {
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const result = await spider.scanDeadCode();
    unusedByFile = new Map(
      result.entries.map((e) => [path.relative(root, e.filePath).replaceAll('\\', '/'), e.unusedSymbols.map((s) => s.name)])
    );
  });

  it.each([
    ['export *', 'src/lib/a.ts'],
    ['aliased re-export (as)', 'src/lib/c.ts'],
    ['type-only re-export', 'src/lib/types.ts'],
    ['namespace used as a whole', 'src/lib/escx.ts'],
    ['barrel of a barrel (depth 2)', 'src/lib/deep/nested.ts'],
    ['barrel of a barrel (depth 3)', 'src/lib/deep/deeper/leaf.ts'],
    ['symbol imported only from a test file', 'src/lib/onlyTest.ts'],
    ['import then export { x }', 'src/lib/g.ts'],
  ])('keeps a symbol used through %s', (_form, file) => {
    expect(unused(file)).toEqual([]);
  });

  it('reports only the namespace members nobody accesses', () => {
    expect(unused('src/lib/nsx.ts')).toEqual(['deadInNs']);
  });

  it('keeps a default export re-exported as a name', () => {
    expect(unused('src/lib/dflt.ts')).toEqual([]);
  });

  it('does not report a JS symbol consumed through an .mjs barrel', () => {
    // ponytail: JS exports yield no symbols in the AST worker, so dead JS code is not reported either.
    expect(unused('src/js/a.js')).toEqual([]);
  });

  it('still reports a symbol nobody imports', () => {
    expect(unused('src/lib/d.ts')).toEqual(['reallyDead']);
  });

  it('keeps a named re-export used and reports the one the consumer never uses', () => {
    expect(unused('src/lib/b.ts')).toEqual(['barrelNotUsed']);
  });

  it('does not credit a same-name symbol of a file the barrel does not re-export', () => {
    expect(unused('src/lib/e.ts')).toEqual([]);
    expect(unused('src/lib/f.ts')).toEqual(['twin']);
  });

  it('terminates on re-export cycles and keeps reporting the unused side', () => {
    expect(unused('src/cyc/x.ts')).toEqual([]);
    expect(unused('src/cyc/y.ts')).toEqual(['yFn']);
  });

  it('lists the consumer as dependent of a symbol re-exported with `export ... from`', async () => {
    const dependents = await spider.getSymbolDependents(path.join(root, 'src/lib/a.ts'), 'starUsed');
    expect(dependents.some((d) => d.sourceSymbolId.replaceAll('\\', '/').includes('/src/app.ts:'))).toBe(true);
  });

  it('agrees between findUnusedSymbols and scanDeadCode', async () => {
    for (const file of ['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/d.ts', 'src/lib/nsx.ts', 'src/lib/escx.ts']) {
      const names = (await spider.findUnusedSymbols(path.join(root, file))).map((s) => s.name);
      expect(names).toEqual(unused(file));
    }
  });

  it('stays fast with hundreds of exports behind one barrel', async () => {
    const big = await fs.mkdtemp(path.join(tmpdir(), 'reexport-many-'));
    try {
      const names = Array.from({ length: 300 }, (_, i) => `fn${i}`);
      await fs.mkdir(path.join(big, 'src'), { recursive: true });
      await fs.writeFile(path.join(big, 'src', 'many.ts'), names.map((n) => `export function ${n}() {}`).join('\n'));
      await fs.writeFile(path.join(big, 'src', 'index.ts'), "export * from './many';\n");
      await fs.writeFile(path.join(big, 'src', 'app.ts'), "import { fn0 } from './index';\nfn0();\n");
      const manySpider = new SpiderBuilder().withRootDir(big).withReverseIndex(true).build();
      await manySpider.buildFullIndex();

      const started = Date.now();
      const unusedNames = (await manySpider.findUnusedSymbols(path.join(big, 'src', 'many.ts'))).map((s) => s.name);

      expect(unusedNames).toHaveLength(299);
      expect(unusedNames).not.toContain('fn0');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await fs.rm(big, { recursive: true, force: true });
    }
  });
});
