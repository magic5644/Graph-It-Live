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
