import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromFileModule, isInsideDir, libraryName, moduleDir, RustParser } from '@/analyzer/languages/RustParser';
import { normalizePath } from '@/analyzer/types';

/** `crate::`, `self::`, `super::` and item-suffixed paths resolve the way rustc finds module files (#521). */
describe('RustParser module resolution', () => {
  const files = [
    'app/Cargo.toml',
    'app/src/main.rs',
    'app/src/top.rs',
    'app/src/a/mod.rs',
    'app/src/a/x.rs',
    'app/src/a/b.rs',
    'app/src/a/b/c.rs',
    'app/src/bin/tool.rs',
    'app/src/bin/helper.rs',
    'both/Cargo.toml',
    'both/src/lib.rs',
    'both/src/main.rs',
    'both/src/m.rs',
    'app/src/p/lib.rs',
    'app/src/p/x.rs',
    'lone/x.rs',
    'lone/w.rs',
    '..x/k.rs',
    'y.rs',
  ];
  let root = '';
  let parser: RustParser;
  const at = (rel: string) => path.join(root, ...rel.split('/'));

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitl-rust-resolve-'));
    await Promise.all(
      files.map(async (rel) => {
        await fs.mkdir(path.dirname(at(rel)), { recursive: true });
        await fs.writeFile(at(rel), '', 'utf-8');
      })
    );
    parser = new RustParser(root, process.cwd());
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ['crate:: from the crate root', 'app/src/main.rs', 'crate::a::x::f', 'app/src/a/x.rs'],
    ['crate:: from a nested module', 'app/src/a/b.rs', 'crate::top', 'app/src/top.rs'],
    ['self:: in a non-mod file is its own directory', 'app/src/a/b.rs', 'self::c', 'app/src/a/b/c.rs'],
    ['super:: in a non-mod file is its parent module', 'app/src/a/b.rs', 'super::x', 'app/src/a/x.rs'],
    ['super:: in mod.rs', 'app/src/a/mod.rs', 'super::top', 'app/src/top.rs'],
    ['super::super:: from a grandchild module', 'app/src/a/b/c.rs', 'super::super::x', 'app/src/a/x.rs'],
    ['mod child of a non-mod file', 'app/src/a/b.rs', 'c', 'app/src/a/b/c.rs'],
    ['item and type suffixes are dropped', 'app/src/main.rs', 'a::b::Thing', 'app/src/a/b.rs'],
    ['another crate root keeps children next to it', 'app/src/bin/tool.rs', 'helper', 'app/src/bin/helper.rs'],
    ['no Cargo.toml: crate:: from the workspace root', 'lone/x.rs', 'crate::y', 'y.rs'],
    ['no Cargo.toml: a loose file finds its sibling', 'lone/x.rs', 'w', 'lone/w.rs'],
    ['a `..x` directory is inside the workspace', '..x/k.rs', 'crate::y', 'y.rs'],
    ['self:: in another crate root', 'app/src/bin/tool.rs', 'self::helper', 'app/src/bin/helper.rs'],
    // #519: a path with no module file names an item of the module itself (`pub use` barrels live there).
    ['crate:: item of the crate root', 'app/src/a/b.rs', 'crate::used', 'app/src/main.rs'],
    ['bare crate (`use crate::{f}`)', 'app/src/a/b.rs', 'crate', 'app/src/main.rs'],
    ['lib.rs is the crate root before main.rs', 'both/src/m.rs', 'crate::f', 'both/src/lib.rs'],
    ['super:: item of a mod.rs module', 'app/src/a/x.rs', 'super::f', 'app/src/a/mod.rs'],
    ['bare super', 'app/src/a/b.rs', 'super', 'app/src/a/mod.rs'],
    ['super:: item of a non-mod module', 'app/src/a/b/c.rs', 'super::f', 'app/src/a/b.rs'],
    ['super:: item of the crate root', 'app/src/top.rs', 'super::f', 'app/src/main.rs'],
  ])('%s', async (_case, from, specifier, expected) => {
    expect(await parser.resolvePath(at(from), specifier)).toBe(normalizePath(at(expected)));
  });

  it.each([
    ['self:: item of the file itself', 'app/src/a/b.rs', 'self::f'],
    ['bare self in a crate root', 'app/src/main.rs', 'self'],
    ['crate:: item with no crate root file', 'lone/x.rs', 'crate::f'],
    ['super:: above the workspace root', 'app/src/a/b.rs', 'super::super::super::super::x'],
    ['super:: item of a directory whose lib.rs is a plain module, not a crate root', 'app/src/p/x.rs', 'super::f'],
    ['super above nothing that exists', 'app/src/main.rs', 'super::nowhere'],
    ['external crate', 'app/src/main.rs', 'std::fmt'],
    ['sibling of a non-root file inside a crate (an extern crate there)', 'app/src/a/b.rs', 'x::f'],
  ])('returns null for a %s', async (_case, from, specifier) => {
    expect(await parser.resolvePath(at(from), specifier)).toBeNull();
  });

  it('resolves crate:: from a file outside the workspace against the workspace root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitl-rust-outside-'));
    try {
      expect(await parser.resolvePath(path.join(outside, 'z.rs'), 'crate::y')).toBe(normalizePath(at('y.rs')));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    ['C:\\ws\\src\\a.rs', 'C:\\ws', true],
    ['C:\\ws', 'C:\\ws', true],
    ['C:\\ws\\..x\\a.rs', 'C:\\ws', true],
    ['C:\\other\\a.rs', 'C:\\ws', false],
    ['D:\\ws\\a.rs', 'C:\\ws', false],
  ])('isInsideDir on Windows: %s in %s = %s', (file, dir, expected) => {
    expect(isInsideDir(file, dir, path.win32)).toBe(expected);
  });

  it.each([
    ['/ws/..x/a.rs', '/ws', true],
    ['/ws/../a.rs', '/ws', false],
  ])('isInsideDir on POSIX: %s in %s = %s', (file, dir, expected) => {
    expect(isInsideDir(file, dir, path.posix)).toBe(expected);
  });

  it.each([
    [path.join('src', 'a', 'mod.rs'), path.join('src', 'a')],
    [path.join('src', 'bin', 'tool.rs'), path.join('src', 'bin')],
    [path.join('src', 'lib.rs'), 'src'],
    [path.join('src', 'a', 'b.rs'), path.join('src', 'a', 'b')],
  ])('moduleDir(%s) = %s', (file, expected) => {
    expect(moduleDir(file)).toBe(expected);
  });

  it.each([
    ['super::helper', 0, 'super::helper'],
    ['crate::a', 2, 'crate::a'],
    ['inner::x', 1, 'inner::x'],
    ['super::helper', 1, 'self::helper'],
    ['super', 1, 'self'],
    ['super::super::x', 1, 'self::super::x'],
    ['super::x', 2, null],
    ['self::x', 1, null],
  ])('fromFileModule(%s, depth %i) = %s', (specifier, depth, expected) => {
    expect(fromFileModule(specifier, depth)).toBe(expected);
  });

  it('keeps `super::` inside an inline `mod tests` in the file, not its parent (#519)', async () => {
    const file = at('app/src/a/b.rs');
    await fs.writeFile(file, 'mod tests {\n    use super::helper;\n    use super::c::f;\n    use super::super::x::g;\n    fn t() { super::helper(); self::y(); }\n}\n', 'utf-8');
    try {
      const deps = await parser.parseImports(file);
      const resolved = await Promise.all(deps.map((dep) => parser.resolvePath(file, dep.module ?? '')));
      const targets = new Set(resolved.filter((p): p is string => !!p).map((p) => path.relative(root, p).replaceAll('\\', '/')));
      expect([...targets].sort()).toEqual(['app/src/a/b/c.rs', 'app/src/a/x.rs']);
    } finally {
      await fs.writeFile(file, '', 'utf-8');
    }
  });

  it('resolves each `use` list item under its base path (#519)', async () => {
    const file = at('app/src/a/b.rs');
    await fs.writeFile(file, 'use crate::{used, top::f, a::{x::g}};\nuse super::{h as k};\nuse std::{fmt};\n', 'utf-8');
    try {
      const deps = await parser.parseImports(file);
      const resolved = await Promise.all(deps.map((dep) => parser.resolvePath(file, dep.module ?? '')));
      const targets = new Set(resolved.filter((p): p is string => !!p).map((p) => path.relative(root, p).replaceAll('\\', '/')));
      expect([...targets].sort()).toEqual(['app/src/a/mod.rs', 'app/src/a/x.rs', 'app/src/main.rs', 'app/src/top.rs']);
    } finally {
      await fs.writeFile(file, '', 'utf-8');
    }
  });

  it.each([
    ['[package]\nname = "my-app"\n', 'my_app'],
    ['[package]\nname = "pkg"\n\n[lib]\nname = "core_lib"\n', 'core_lib'],
    ['[lib]\npath = "src/lib.rs"\n[package]\nname = "late"\n', 'late'],
    ['[dependencies]\nserde = "1"\n', undefined],
    ['', undefined],
  ])('libraryName(%j) = %s', (toml, expected) => {
    expect(libraryName(toml)).toBe(expected);
  });

  it('resolves `use <package>::f` from the binary to the library root, and only the package name (#519)', async () => {
    const cargo = at('both/Cargo.toml');
    await fs.writeFile(cargo, '[package]\nname = "my-app"\n', 'utf-8');
    try {
      expect(await parser.resolvePath(at('both/src/main.rs'), 'my_app::f')).toBe(normalizePath(at('both/src/lib.rs')));
      expect(await parser.resolvePath(at('both/src/main.rs'), 'other_crate::f')).toBeNull();
    } finally {
      await fs.writeFile(cargo, '', 'utf-8');
    }
  });

  it('resolves `self` in a `use` list to the list base (#519)', async () => {
    const file = at('app/src/main.rs');
    await fs.writeFile(file, 'use crate::{a::{self, x}};\n', 'utf-8');
    try {
      const modules = (await parser.parseImports(file)).map((dep) => dep.module);
      expect(modules).toContain('crate::a');
      expect(modules).toContain('crate::a::x');
    } finally {
      await fs.writeFile(file, '', 'utf-8');
    }
  });
});
