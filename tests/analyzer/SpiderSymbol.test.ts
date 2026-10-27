import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

/** Indexes `files` (written under `<tmp>/src`) with a fresh Spider and exposes `dependentsOf`. */
function useTempProject(prefix: string, files: Record<string, string>) {
  const project = {
    rootDir: '',
    spider: undefined as unknown as Spider,
    file: (name: string) => path.join(project.rootDir, 'src', name),
    dependentsOf: async (name: string, symbol: string) =>
      (await project.spider.getSymbolDependents(project.file(name), symbol)).map((d) => d.sourceSymbolId.split(':').pop()).sort(),
  };
  beforeAll(async () => {
    project.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    await fs.mkdir(path.join(project.rootDir, 'src'));
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(project.file(name), content, 'utf-8');
    }
    project.spider = new SpiderBuilder().withRootDir(project.rootDir).withReverseIndex(true).build();
    await project.spider.buildFullIndex();
  });
  afterAll(async () => {
    await fs.rm(project.rootDir, { recursive: true, force: true });
  });
  return project;
}

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
  const { dependentsOf } = useTempProject('gitl-dependents-', {
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

describe('Spider - Symbol dependents behind re-export barrels', () => {
  const { dependentsOf, file } = useTempProject('gitl-barrel-', {
      'price.ts': 'export function formatPrice(amount: number): string { return `$${amount}`; }\nexport function lonely(): number { return 1; }\n',
      'cart.ts': 'import { formatPrice } from "./price";\nexport const cartTotal = () => formatPrice(1);\n',
      'index.ts': 'export { formatPrice } from "./price";\nexport { formatPrice as fmt } from "./price";\nexport { lonely } from "./price";\n',
      'invoice.ts': 'import { formatPrice } from "./index";\nexport const invoiceLine = () => formatPrice(2);\n',
      'renamed.ts': 'import { fmt } from "./index";\nexport const renamedLine = () => fmt(3);\n',
      'star.ts': 'export * from "./price";\n',
      'viaStar.ts': 'import { formatPrice } from "./star";\nexport const starLine = () => formatPrice(4);\n',
      'outer.ts': 'export * from "./star";\n',
      'viaOuter.ts': 'import { formatPrice } from "./outer";\nexport const outerLine = () => formatPrice(5);\n',
      'cycleA.ts': 'export * from "./cycleB";\nexport * from "./price";\n',
      'cycleB.ts': 'export * from "./cycleA";\n',
      'gone.ts': 'export { formatPrice } from "./price";\n',
      'viaGone.ts': 'import { formatPrice } from "./gone";\nexport const goneLine = () => formatPrice(7);\n',
      'viaCycle.ts': 'import { formatPrice } from "./cycleB";\nexport const cycleLine = () => formatPrice(6);\n',
  });

  it('lists direct, named-barrel, renamed, export * and chained-barrel consumers', async () => {
    expect(await dependentsOf('price.ts', 'formatPrice')).toEqual([
      'cartTotal', 'cycleLine', 'goneLine', 'invoiceLine', 'outerLine', 'renamedLine', 'starLine',
    ]);
  });

  it('terminates on a cycle of barrels', async () => {
    expect(await dependentsOf('price.ts', 'formatPrice')).toContain('cycleLine');
  });

  it('returns nothing for a re-exported symbol nobody consumes', async () => {
    expect(await dependentsOf('price.ts', 'lonely')).toEqual([]);
  });

  it('skips a barrel that can no longer be read and keeps the other consumers', async () => {
    await fs.rm(file('gone.ts'));
    const names = await dependentsOf('price.ts', 'formatPrice');
    expect(names).toContain('cartTotal');
    expect(names).toContain('invoiceLine');
  });
});
