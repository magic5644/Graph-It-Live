import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandUseTree,
  isPythonOrRust,
  namesModule,
  pyRsReExports,
  pythonStarExports,
  pythonImportBindings,
  pythonReExports,
  readImportBindings,
  rustGlobPrefixes,
  rustImportBindings,
  rustReExports,
} from '@/analyzer/utils/pyRsImports';
import { readModuleReExports } from '@/analyzer/utils/reExports';

const one = (specifier: string, imported = 'one', exported = imported) => ({ specifier, names: [{ imported, exported }] });

describe('pythonReExports', () => {
  it.each([
    ['named', 'from .impl import one\n', [one('.impl')]],
    ['renamed', 'from .impl import one as uno\n', [one('.impl', 'one', 'uno')]],
    ['star', 'from .impl import *\n', [{ specifier: '.impl', names: 'all' }]],
    ['absolute module', 'from pkg.impl import one\n', [one('pkg.impl')]],
    [
      'parenthesised over lines, trailing comma',
      'from .impl import (\n    one,\n    two as deux,\n)\n',
      [{ specifier: '.impl', names: [{ imported: 'one', exported: 'one' }, { imported: 'two', exported: 'deux' }] }],
    ],
    [
      'backslash continuation and comment',
      'from .impl import one, \\\n    two  # both\n',
      [{ specifier: '.impl', names: [{ imported: 'one', exported: 'one' }, { imported: 'two', exported: 'two' }] }],
    ],
    ['CRLF line ends', 'from .impl import one\r\n', [one('.impl')]],
    ['indented in a try block', 'try:\n    from .impl import one\nexcept ImportError:\n    pass\n', [one('.impl')]],
    ['commented out', '# from .impl import one\n', []],
    ['inside a docstring', '"""Usage:\n\nfrom .impl import one\n"""\n', []],
    ['inside a string with a #', "s = '# x'\nt = 'from .impl import one'\n", []],
    ['a # in a string does not hide the next import', "s = '#'\nfrom .impl import one\n", [one('.impl')]],
    ['plain import is not a name re-export', 'import pkg.impl\n', []],
    ['empty', '', []],
  ])('%s', (_case, content, expected) => {
    expect(pythonReExports(content).reExports).toEqual(expected);
  });

  it.each([
    ['from . import a submodule', 'from . import impl\n', [{ specifier: '.impl', alias: 'impl' }]],
    ['from .. import, renamed', 'from .. import impl as i\n', [{ specifier: '..impl', alias: 'i' }]],
    ['from a package', 'from pkg import impl\n', [{ specifier: 'pkg.impl', alias: 'impl' }]],
    ['star has no submodule', 'from pkg import *\n', []],
  ])('submodule candidates: %s', (_case, content, expected) => {
    expect(pythonReExports(content).namespaces).toEqual(expected);
  });
});

describe('pythonImportBindings', () => {
  it.each([
    ['from import', 'from pkg import one\n', [{ specifier: 'pkg', imported: 'one', local: 'one' }]],
    ['aliased', 'from pkg import one as o\n', [{ specifier: 'pkg', imported: 'one', local: 'o' }]],
    ['star is the whole module', 'from pkg import *\n', [{ specifier: 'pkg', imported: '*', local: '*' }]],
    [
      'import of modules: `import a.b` binds a, an alias binds itself',
      'import pkg.sub, pkg.impl as impl\n',
      [{ specifier: 'pkg.sub', imported: '*', local: 'pkg' }, { specifier: 'pkg.impl', imported: '*', local: 'impl' }],
    ],
    ['inside a docstring', "'''\nimport pkg\nfrom pkg import one\n'''\n", []],
    ['nothing imported', 'x = 1\n', []],
    ['empty', '', []],
  ])('%s', (_case, content, expected) => {
    expect(pythonImportBindings(content)).toEqual(expected);
  });
});

describe('expandUseTree', () => {
  it.each([
    ['plain path', 'imp::one', [{ specifier: 'imp', name: 'one' }]],
    ['aliased', 'self::imp::one as uno', [{ specifier: 'self::imp', name: 'one', alias: 'uno' }]],
    ['glob', 'imp::*', [{ specifier: 'imp', name: '*' }]],
    [
      'nested groups',
      'crate::a::{b::{c, d as e}, f, self}',
      [
        { specifier: 'crate::a::b', name: 'c' },
        { specifier: 'crate::a::b', name: 'd', alias: 'e' },
        { specifier: 'crate::a', name: 'f' },
        { specifier: 'crate::a', name: 'self' },
      ],
    ],
    ['leading ::', '::imp::one', [{ specifier: 'imp', name: 'one' }]],
    ['raw identifier', 'r#mod::r#type', [{ specifier: 'mod', name: 'type' }]],
    ['single segment has no module', 'one', []],
    ['empty group', 'imp::{}', []],
    ['empty', '', []],
  ])('%s', (_case, tree, expected) => {
    expect(expandUseTree(tree, [])).toEqual(expected);
  });
});

describe('rustReExports', () => {
  it.each([
    ['pub use', 'pub use imp::one;\n', [one('imp')]],
    ['pub(crate) renamed', 'pub(crate) use self::imp::one as uno;\n', [one('self::imp', 'one', 'uno')]],
    ['pub(in path)', 'pub(in crate::a) use imp::one;\n', [one('imp')]],
    ['glob', 'pub use imp::*;\n', [{ specifier: 'imp', names: 'all' }]],
    ['group, self skipped', 'pub use imp::{self, one, two as deux};\n', [one('imp'), one('imp', 'two', 'deux')]],
    ['CRLF line ends', 'pub use imp::one;\r\n', [one('imp')]],
    ['private use is not a re-export', 'use imp::one;\n', []],
    ['commented out, nested block comment', '// pub use imp::one;\n/* a /* pub use imp::two; */ pub use imp::three; */\n', []],
    ['inside strings', 'const S: &str = "pub use imp::one;";\nconst R: &str = r#"pub use imp::two;"#;\n', []],
    ['a char quote does not open a string', "const Q: char = '\"';\npub use imp::one;\n", [one('imp')]],
    ['a lifetime is code', "fn f<'a>(x: &'a str) {}\npub use imp::one;\n", [one('imp')]],
    ['empty', '', []],
  ])('%s', (_case, content, expected) => {
    expect(rustReExports(content).reExports).toEqual(expected);
  });

  it.each([
    ['a path may name a module', 'pub use inner::imp;\n', [{ specifier: 'inner::imp', alias: 'imp' }]],
    ['self names the module', 'pub use inner::imp::{self as i};\n', [{ specifier: 'inner::imp', alias: 'i' }]],
    ['glob has no module', 'pub use inner::*;\n', []],
  ])('module candidates: %s', (_case, content, expected) => {
    expect(rustReExports(content).namespaces).toEqual(expected);
  });
});

describe('rustImportBindings', () => {
  it.each([
    ['use', 'use inner::one;\n', [{ specifier: 'inner', imported: 'one', local: 'one' }]],
    ['pub use binds too', 'pub use inner::o as p;\n', [{ specifier: 'inner', imported: 'o', local: 'p' }]],
    [
      'glob and self are the whole module',
      'use inner::*;\nuse other::{self};\n',
      [{ specifier: 'inner', imported: '*', local: '*' }, { specifier: 'other', imported: '*', local: 'self' }],
    ],
    ['qualified call without use', 'fn f() { crate::inner::one(); }\n', [{ specifier: 'crate::inner', imported: 'one', local: 'one' }]],
    ['a type path is not a module path', 'fn f() { Vec::new(); }\n', []],
    ['mod declaration is not a binding', 'mod inner;\n', []],
    ['inside a string or comment', 'fn f() { let s = "inner::one"; } // inner::two\n', []],
    ['empty', '', []],
  ])('%s', (_case, content, expected) => {
    expect(rustImportBindings(content)).toEqual(expected);
  });
});

describe('namesModule', () => {
  it.each([
    ['a Rust module file', 'inner::imp', path.join('src', 'inner', 'imp.rs'), true],
    ['a Rust mod.rs', 'crate::inner', path.join('src', 'inner', 'mod.rs'), true],
    ['a Rust item resolved to its module', 'inner::one', path.join('src', 'inner', 'mod.rs'), false],
    ['Python is resolved exactly', '.impl', path.join('pkg', 'impl.py'), true],
    ['TS aliases are free', 'ns', path.join('src', 'a.ts'), true],
  ])('%s', (_case, specifier, file, expected) => {
    expect(namesModule(specifier, file)).toBe(expected);
  });
});

describe('language dispatch', () => {
  it.each([
    ['a.py', true],
    ['A.RS', true],
    ['a.ts', false],
    ['a.go', false],
  ])('isPythonOrRust(%s) = %s', (file, expected) => {
    expect(isPythonOrRust(file)).toBe(expected);
  });

  it.each([
    ['a.py', 'from m import x\n', [{ specifier: 'm', imported: 'x', local: 'x' }]],
    ['a.rs', 'use m::x;\n', [{ specifier: 'm', imported: 'x', local: 'x' }]],
    ['a.ts', 'import { x } from "./m";\n', [{ specifier: './m', imported: 'x', local: 'x' }]],
    ['a.ts', '', []],
  ])('readImportBindings parses %s with its language', (file, content, expected) => {
    expect(readImportBindings(file, content)).toEqual(expected);
  });

  it.each([
    ['a.py', 'from .m import x\n'],
    ['a.rs', 'pub use m::x;\n'],
  ])('readModuleReExports reads %s with its language', (file, content) => {
    expect(readModuleReExports(file, content)).toEqual(pyRsReExports(file, content));
    expect(readModuleReExports(file, content).reExports).toHaveLength(1);
  });
});

describe('Python __all__', () => {
  it.each([
    ['list', "__all__ = ['one', \"two\"]\n", ['one', 'two']],
    ['tuple over lines', "__all__ = (\n    'one',\n)\n", ['one']],
    ['annotated', "__all__: list[str] = ['one']\n", ['one']],
    ['+= merged', "__all__ = ['one']\n__all__ += ['two']\n", ['one', 'two']],
    ['a bracket in a name string', "__all__ = ['one', ']']\n", ['one']],
    ['in a docstring is not code', '"""\n__all__ = [\'one\']\n"""\n', undefined],
    ['absent', 'def one():\n    pass\n', undefined],
  ])('%s', (_case, content, expected) => {
    expect(pythonReExports(content).starNames).toEqual(expected);
  });

  it.each([
    ['public name, no __all__', 'one', undefined, true],
    ['underscore name, no __all__', '_hidden', undefined, false],
    ['listed in __all__', '_hidden', ['_hidden'], true],
    ['not listed in __all__', 'one', ['two'], false],
  ])('pythonStarExports: %s', (_case, name, starNames, expected) => {
    expect(pythonStarExports(name, starNames)).toBe(expected);
  });
});

describe('Rust glob scope', () => {
  it.each([
    ['globs', 'use super::*;\npub use crate::a::*;\nuse b::c;\n', ['super', 'crate::a']],
    ['none', 'use b::c;\n', []],
  ])('rustGlobPrefixes: %s', (_case, content, expected) => {
    expect(rustGlobPrefixes(content)).toEqual(expected);
  });

  it('binds a plain qualified path under each glob, and a relative one as written', () => {
    expect(rustImportBindings('use super::*;\nfn f() { inner::one(); crate::x::two(); }\n')).toEqual([
      { specifier: 'super', imported: '*', local: '*' },
      { specifier: 'inner', imported: 'one', local: 'one' },
      { specifier: 'super::inner', imported: 'one', local: 'one' },
      { specifier: 'crate::x', imported: 'two', local: 'two' },
    ]);
  });
});

describe('literal scanner edge cases', () => {
  it.each([
    ['an unclosed one-line string stops at the newline', 's = "abc\nfrom .impl import one\n', 1],
    ['an unclosed triple-quoted string runs to the end', 's = """abc\nfrom .impl import one\n', 0],
    ['a backslash at the end of the file', "s = 'abc\\", 0],
    ['an escaped quote stays inside the string', "s = 'it\\'s from .impl import one'\nfrom .impl import two\n", 1],
    ['a string prefix', "s = rb'from .impl import one'\nf'{x}'\nfrom .impl import two\n", 1],
    ['a # right at the end of the file', 'from .impl import one #', 1],
  ])('Python: %s', (_case, content, count) => {
    expect(pythonReExports(content).reExports).toHaveLength(count);
  });

  it.each([
    ['an unclosed block comment runs to the end', '/* pub use a::b;\npub use a::c;\n', 0],
    ['an unclosed string runs to the end', 'const S: &str = "x;\npub use a::b;\n', 0],
    ['an escaped quote char', "const Q: char = '\\'';\npub use a::b;\n", 1],
    ['an escaped backslash char', "const Q: char = '\\\\';\npub use a::b;\n", 1],
    ['a byte raw string', 'const B: &[u8] = br"pub use a::b;";\npub use a::c;\n', 1],
    ['a raw string holding a quote', 'const R: &str = r#"say " pub use a::b; "#;\npub use a::c;\n', 1],
    ['an identifier ending in r before a string is not a raw string', 'fn f() { bar("x"); }\npub use a::c;\n', 1],
    ['a backslash at the end of the file', 'pub use a::c;\nconst S: &str = "\\', 1],
  ])('Rust: %s', (_case, content, count) => {
    expect(rustReExports(content).reExports).toHaveLength(count);
  });
});
