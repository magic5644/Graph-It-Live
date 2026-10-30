import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

describe('Spider - scanDeadCode counts module-level Python calls (#514)', () => {
  const root = path.resolve(process.cwd(), 'tests/analyzer/fixtures/python-module-level');
  let unusedByFile: Map<string, string[]>;

  const unused = (relativePath: string): string[] => unusedByFile.get(relativePath) ?? [];

  beforeAll(async () => {
    const spider: Spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const result = await spider.scanDeadCode();
    unusedByFile = new Map(
      result.entries.map((e) => [path.relative(root, e.filePath).replaceAll('\\', '/'), e.unusedSymbols.map((s) => s.name)])
    );
  });

  it('reports only what no module-level or nested call reaches', () => {
    expect(unused('src/py/used.py').sort()).toEqual(['f_dead', 'f_imported_unused', 'f_string_only']);
  });

  it('still reports the definitions nobody calls', () => {
    expect(unused('src/py/consumer.py').sort()).toEqual(['K', 'deco', 'decorated', 'run', 'with_default']);
  });

  it('counts a TypeScript call made at the top level of a script', () => {
    expect(unused('src/ts/lib.ts')).toEqual(['tsDead']);
  });

  it('counts a Rust call made in a const initialiser', () => {
    expect(unused('src/rs/helpers.rs')).toEqual(['rs_dead']);
  });

  it('does not credit a same-name function of a module nobody imports', () => {
    expect(unused('src/py/twin.py')).toEqual(['f_toplevel']);
  });
});
