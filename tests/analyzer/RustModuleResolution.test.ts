import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInsideDir, moduleDir, RustParser } from '@/analyzer/languages/RustParser';
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
  ])('%s', async (_case, from, specifier, expected) => {
    expect(await parser.resolvePath(at(from), specifier)).toBe(normalizePath(at(expected)));
  });

  it.each([
    ['missing module', 'app/src/a/b.rs', 'crate::missing'],
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
});
