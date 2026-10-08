import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

describe('Spider - Symbol Analysis', () => {
  const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/symbols');
  const utilsPath = path.join(fixturesDir, 'utils.ts');
  
  let spider: Spider;

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .build();
    
    // Build the index first
    await spider.buildFullIndex();
  });

  it('should find unused symbols', async () => {
    const unused = await spider.findUnusedSymbols(utilsPath);
    
    const names = unused.map((s) => s.name).sort();
    expect(names).toEqual(['UnusedType', 'unusedFunc']);
  });

  it('should find symbol dependents', async () => {
    const dependents = await spider.getSymbolDependents(utilsPath, 'usedFunc');
    
    expect(dependents).toHaveLength(1);
    expect(dependents[0].sourceSymbolId).toContain('main');
    expect(dependents[0].targetSymbolId).toContain('usedFunc');
  });
});

describe('Spider - Destructured dynamic imports', () => {
  const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures/dynamic-import-destructuring');
  const commandsPath = path.join(fixturesDir, 'commands.ts');

  let spider: Spider;

  beforeAll(async () => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withReverseIndex(true)
     .build();

    await spider.buildFullIndex();
  });

  it('should not report exports destructured from await import() or .then() as unused', async () => {
    const unused = await spider.findUnusedSymbols(commandsPath);

    expect(unused.map((s) => s.name)).toEqual(['unusedCommand']);
  });
});

describe('Spider - Symbol dependents in the same file and through namespaces', () => {
  let rootDir: string;
  let spider: Spider;
  const file = (name: string) => path.join(rootDir, 'src', name);
  const dependentsOf = async (name: string, symbol: string) =>
    (await spider.getSymbolDependents(file(name), symbol)).map((d) => d.sourceSymbolId.split(':').pop()).sort();

  beforeAll(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitl-dependents-'));
    await fs.mkdir(path.join(rootDir, 'src'));
    const files: Record<string, string> = {
      'core.ts': [
        'export function target(x: number): number { return x * 2; }',
        'export class Service { run(): number { return target(21); } }',
        'export function isEven(n: number): boolean { return n === 0 || isOdd(n - 1); }',
        'export function isOdd(n: number): boolean { return n !== 0 && isEven(n - 1); }',
        'export function countdown(n: number): number { return n <= 0 ? 0 : countdown(n - 1); }',
      ].join('\n'),
      'named.ts': 'import { target } from "./core";\nexport const viaNamed = () => target(1);\n',
      'ns.ts': 'import * as core from "./core";\nexport const viaNamespace = () => core.target(2) + core.target(3);\n',
      'ns.test.ts': 'import * as core from "./core";\nimport { vi } from "vitest";\nexport const spy = vi.spyOn(core, "target");\n',
      'bare.ts': 'import * as core from "./core";\nexport const registry = [core];\n',
    };
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(file(name), content, 'utf-8');
    }
    spider = new SpiderBuilder().withRootDir(rootDir).withReverseIndex(true).build();
    await spider.buildFullIndex();
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('lists same-file, named, namespace and spyOn dependents once each', async () => {
    expect(await dependentsOf('core.ts', 'target')).toEqual(['Service', 'spy', 'viaNamed', 'viaNamespace']);
  });

  it('does not list a symbol as its own dependent', async () => {
    expect(await dependentsOf('core.ts', 'countdown')).toEqual([]);
    expect(await dependentsOf('core.ts', 'isEven')).toEqual(['isOdd']);
  });

  it('keeps cross-file dependents unchanged when the file has no same-file caller', async () => {
    expect(await dependentsOf('named.ts', 'viaNamed')).toEqual([]);
  });
});
