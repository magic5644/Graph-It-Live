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
      await fs.mkdir(path.dirname(project.file(name)), { recursive: true });
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

describe('Spider - Referencing files behind Python and Rust re-exports (#521)', () => {
  const project = useTempProject('gitl-refs-pyrs-', {
    'py/pkg/impl.py': 'def one():\n    return 1\n\ndef lonely():\n    return 0\n',
    'py/pkg/other.py': 'def one():\n    return 9\n\ndef two():\n    return 2\n',
    'py/pkg/__init__.py': 'from .impl import one\nfrom .other import two\nfrom . import impl\n',
    'py/main.py': 'from pkg import one\n\ndef run():\n    return one()\n',
    'py/only_two.py': 'from pkg import two\n',
    'py/doc_only.py': '"""Example: from pkg import one"""\nfrom pkg import two\n',
    'py/whole.py': 'import pkg\n\nprint(pkg.one())\n',
    'py/via_sub.py': 'from pkg import impl\n\nprint(impl.one())\n',
    'py/renamed.py': 'from pkg.impl import one as uno\n',
    'py/via_renamed.py': 'from renamed import uno\n',
    'py/outer.py': 'from pkg import *\n',
    'py/via_outer.py': 'from outer import one\n',
    'py/cyc_a.py': 'from cyc_b import *\nfrom pkg.impl import one\n',
    'py/cyc_b.py': 'from cyc_a import *\n',
    'py/via_cycle.py': 'from cyc_b import one\n',
    'py/other_barrel.py': 'from pkg.other import one\n',
    'py/via_other.py': 'from other_barrel import one\n',
    'py/limited.py': "from pkg.impl import one\n__all__ = ['other_name']\n",
    'py/via_limited_star.py': 'from limited import *\n',
    'py/via_limited_named.py': 'from limited import one\n',
    'rs/Cargo.toml': '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    'rs/src/inner/imp.rs': 'pub fn one() -> i32 { 1 }\npub fn lonely() -> i32 { 0 }\n',
    'rs/src/inner/other.rs': 'pub fn one() -> i32 { 9 }\npub fn two() -> i32 { 2 }\n',
    'rs/src/inner/mod.rs': 'pub mod imp;\npub mod other;\npub use imp::one;\npub use self::other::two;\n',
    'rs/src/main.rs': 'mod inner;\nuse inner::one;\nfn main() { one(); }\n',
    'rs/src/only_two.rs': 'use crate::inner::two;\nconst DOC: &str = "use inner::one;";\nfn f() { two(); }\n',
    'rs/src/nested/deep.rs': 'use crate::inner::one;\nfn d() -> i32 { one() }\n',
    'rs/src/qualified.rs': 'pub fn q() -> i32 { crate::inner::one() }\n',
    'rs/src/child.rs': 'use super::*;\nfn c() -> i32 { inner::one() }\n',
    'rs/src/glob.rs': 'pub use crate::inner::*;\n',
    'rs/src/via_glob.rs': 'use crate::glob::{one};\nfn g() { one(); }\n',
    'rs/src/renamed.rs': 'pub use crate::inner::imp::one as uno;\n',
    'rs/src/via_renamed.rs': 'use crate::renamed::uno;\nfn h() { uno(); }\n',
    'rs/src/modrexp.rs': 'pub use crate::inner::imp;\n',
    'rs/src/via_mod.rs': 'use crate::modrexp::imp;\nfn m() -> i32 { imp::one() }\n',
    'rs/src/other_barrel.rs': 'pub use crate::inner::other::one;\n',
    'rs/src/via_other.rs': 'use crate::other_barrel::one;\nfn k() { one(); }\n',
  });

  it.each([
    [
      'Python: from-import, renamed, star, chain, cycle, whole-module and submodule imports',
      'py/pkg/impl.py',
      [
        '__init__.py',
        'cyc_a.py',
        'cyc_b.py < cyc_a.py',
        'limited.py',
        'main.py < __init__.py',
        'outer.py < __init__.py',
        'renamed.py',
        'via_cycle.py < cyc_b.py',
        'via_limited_named.py < limited.py', // via_limited_star.py: limited's __all__ leaves `one` out
        'via_outer.py < outer.py',
        'via_renamed.py < renamed.py',
        'via_sub.py < __init__.py',
        'whole.py < __init__.py',
      ],
    ],
    [
      'Rust: pub use, self::, crate::, qualified call, renamed, glob chain, module re-export',
      'rs/src/inner/imp.rs',
      [
        'child.rs < mod.rs', // `use super::*;` then `inner::one()`
        'deep.rs < mod.rs',
        'glob.rs < mod.rs',
        'main.rs < mod.rs',
        'mod.rs',
        'modrexp.rs',
        'qualified.rs < mod.rs',
        'renamed.rs',
        'via_glob.rs < glob.rs',
        'via_mod.rs < modrexp.rs',
        'via_renamed.rs < renamed.rs',
      ],
    ],
  ])('%s', async (_case, target, expected) => {
    expect(await project.referencesOf(target)).toEqual(expected);
  });

  it.each([
    ['Python package', 'py/pkg/impl.py', 'run'],
    ['Rust module', 'rs/src/inner/imp.rs', 'main'],
  ])('follows the %s barrel for symbol dependents too', async (_case, target, caller) => {
    expect(await project.dependentsOf(target, 'one')).toContain(caller);
  });

  it.each([['py/pkg/impl.py'], ['rs/src/inner/imp.rs']])('reports only the unused symbol of %s behind its barrel', async (target) => {
    const unused = await project.spider.findUnusedSymbols(project.file(target));
    expect(unused.map((symbol) => symbol.name)).toEqual(['lonely']);
  });
});
