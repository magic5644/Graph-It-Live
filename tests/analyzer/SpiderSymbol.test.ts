import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { SpiderSymbolService } from '../../src/analyzer/spider/SpiderSymbolService';

/** Indexes `files` (written under `<tmp>/src`) with a fresh Spider and exposes `dependentsOf`. */
function useTempProject(prefix: string, files: Record<string, string>) {
  const project = {
    rootDir: '',
    spider: undefined as unknown as Spider,
    file: (name: string) => path.join(project.rootDir, 'src', name),
    dependentsOf: async (name: string, symbol: string) =>
      (await project.spider.getSymbolDependents(project.file(name), symbol)).map((d) => d.sourceSymbolId.split(':').pop()).sort(),
    /** `<file>` for a direct referencer, `<file> < <barrel>` behind a barrel; basenames only (paths differ per OS). */
    referencesOf: async (name: string) =>
      (await project.spider.findReferencingFilesThroughBarrels(project.file(name)))
        .map((ref) => path.basename(ref.path) + (ref.via ? ` < ${path.basename(ref.via)}` : ''))
        .sort(),
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

describe('Spider - Referencing files behind re-export barrels (#521)', () => {
  const { referencesOf } = useTempProject('gitl-refs-barrel-', {
    'one.ts': 'export const one = 1;\nexport type One = number;\n',
    'other.ts': 'export const one = 9;\nexport const two = 2;\n',
    'otherBarrel.ts': 'export { one, two } from "./other";\n',
    'viaOtherBarrel.ts': 'import { one } from "./otherBarrel";\nconsole.log(one);\n',
    'index.ts': 'export { one } from "./one";\nexport { two } from "./other";\n',
    'main.ts': 'import { one } from "./index";\nconsole.log(one);\n',
    'onlyTwo.ts': 'import { two } from "./index";\nconsole.log(two);\n',
    'nsImport.ts': 'import * as all from "./index";\nconsole.log(all);\n',
    'sideEffect.ts': 'import "./index";\n',
    'both.ts': 'import { one } from "./one";\nimport { one as again } from "./index";\nconsole.log(one, again);\n',
    'star.ts': 'export * from "./one";\n',
    'viaStar.ts': 'import { one } from "./star";\nconsole.log(one);\n',
    'viaType.ts': 'import type { One } from "./star";\nexport const typed: One = 1;\n',
    'outer.ts': 'export * from "./star";\n',
    'viaOuter.ts': 'import { one } from "./outer";\nconsole.log(one);\n',
    'renamed.ts': 'export { one as uno } from "./one";\n',
    'viaRenamed.ts': 'import { uno } from "./renamed";\nconsole.log(uno);\n',
    'ns.ts': 'export * as nums from "./one";\n',
    'viaNs.ts': 'import { nums } from "./ns";\nconsole.log(nums.one);\n',
    'local.ts': 'import { one } from "./one";\nexport { one };\n',
    'viaLocal.ts': 'import { one } from "./local";\nconsole.log(one);\n',
    'cycleA.ts': 'export * from "./cycleB";\nexport * from "./one";\n',
    'cycleB.ts': 'export * from "./cycleA";\n',
    'viaCycle.ts': 'import { one } from "./cycleB";\nconsole.log(one);\n',
    'mixed.ts': 'import { two } from "./index";\nexport * from "./star";\nconsole.log(two);\n',
    'plain.ts': 'export const plain = 1;\n',
    'usePlain.ts': 'import { plain } from "./plain";\nconsole.log(plain);\n',
    'lonely.ts': 'export const lonely = 1;\n',
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists direct referencers, then each consumer behind a barrel once with the barrel it imports', async () => {
    expect(await referencesOf('one.ts')).toEqual([
      'both.ts', // imports the source and the barrel: listed once, as direct
      'cycleA.ts',
      'cycleB.ts < cycleA.ts', // a barrel of the chain re-exporting onwards
      'index.ts',
      'local.ts',
      'main.ts < index.ts', // named re-export
      'mixed.ts < star.ts', // re-exports the target from star.ts, imports only `two` from index.ts
      'ns.ts',
      'nsImport.ts < index.ts', // namespace import of the barrel
      'outer.ts < star.ts',
      'renamed.ts',
      'star.ts',
      'viaCycle.ts < cycleB.ts', // cycle of barrels terminates
      'viaLocal.ts < local.ts', // import-then-export
      'viaNs.ts < ns.ts', // export * as ns
      'viaOuter.ts < outer.ts', // chain of two barrels
      'viaRenamed.ts < renamed.ts', // export { a as b }
      'viaStar.ts < star.ts', // export *
      'viaType.ts < star.ts', // import type
    ]);
  });

  it.each([
    ['another name of the same barrel', 'onlyTwo.ts'],
    ['a same-name symbol of another file', 'viaOtherBarrel.ts'],
    ['a side-effect import of the barrel', 'sideEffect.ts'],
  ])('does not report %s', async (_case, consumer) => {
    const refs = (await referencesOf('one.ts')).map((ref) => ref.split(' < ')[0]);
    expect(refs).not.toContain(consumer);
  });

  it.each([
    ['no referencer re-exports it', 'plain.ts', ['usePlain.ts']],
    ['nothing references it', 'lonely.ts', []],
  ])('returns the direct referencers without reading the symbol graph when %s', async (_case, name, expected) => {
    const symbolGraph = vi.spyOn(SpiderSymbolService.prototype, 'getSymbolGraph');
    expect(await referencesOf(name)).toEqual(expected);
    expect(symbolGraph).not.toHaveBeenCalled();
  });

  it('propagates a symbol graph failure of a re-exported target', async () => {
    vi.spyOn(SpiderSymbolService.prototype, 'getSymbolGraph').mockRejectedValueOnce(new Error('ast failed'));
    await expect(referencesOf('one.ts')).rejects.toThrow('ast failed');
  });
});

describe('Spider - Referencing files behind a barrel, unreadable consumer (#521)', () => {
  const { referencesOf, file } = useTempProject('gitl-refs-gone-', {
    'one.ts': 'export const one = 1;\n',
    'index.ts': 'export { one } from "./one";\n',
    'kept.ts': 'import { one } from "./index";\nconsole.log(one);\n',
    'gone.ts': 'import { one } from "./index";\nconsole.log(one);\n',
  });

  it('drops a consumer that can no longer be read and keeps the others', async () => {
    expect(await referencesOf('one.ts')).toEqual(['gone.ts < index.ts', 'index.ts', 'kept.ts < index.ts']);
    await fs.rm(file('gone.ts'));
    expect(await referencesOf('one.ts')).toEqual(['index.ts', 'kept.ts < index.ts']);
  });
});
