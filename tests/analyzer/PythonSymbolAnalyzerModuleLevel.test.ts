import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PythonSymbolAnalyzer } from '@/analyzer/languages/PythonSymbolAnalyzer';
import { normalizePath } from '@/shared/path';

// Real tree-sitter WASM (dist/wasm), unlike PythonSymbolAnalyzer.test.ts which mocks the parser.
describe('PythonSymbolAnalyzer - module-level references (#514)', () => {
  const file = normalizePath(path.resolve('/ws/src/consumer.py'));
  const fileScope = `${file}:(file)`;
  const analyzer = new PythonSymbolAnalyzer(process.cwd());

  beforeAll(async () => {
    await analyzer.ensureInitialized();
  });

  /** `[source scope, target]` pairs, target as `<module specifier>:<name>`. */
  const edges = (code: string): Array<[string, string]> =>
    analyzer.analyzeFileContent(file, code).dependencies.map((d) => [d.sourceSymbolId, d.targetSymbolId]);

  it.each([
    ['a statement', 'from .m import f\nf()\n'],
    ['an if __name__ block', "from .m import f\nif __name__ == '__main__':\n    f()\n"],
    ['a decorator argument', 'from .m import f\n@deco(f())\ndef g(): pass\n'],
    ['a comprehension', 'from .m import f\nxs = [f(i) for i in range(3)]\n'],
  ])('attributes a call in %s to the file scope', (_form, code) => {
    expect(edges(code)).toContainEqual([fileScope, '.m:f']);
  });

  it('keeps the enclosing function as source inside a function', () => {
    expect(edges('from .m import f\ndef run():\n    return f()\n')).toEqual([[`${file}:run`, '.m:f']]);
  });

  it.each([
    ['from . import used', 'from . import used\nused.f()\n', '.used:f'],
    ['from pkg import sub as s', 'from pkg import sub as s\ns.f()\n', 'pkg.sub:f'],
    ['from .. import used', 'from .. import used\nused.f()\n', '..used:f'],
    ['import pkg.mod', 'import pkg.mod\npkg.mod.f()\n', 'pkg.mod:f'],
    ['import pkg.mod as m', 'import pkg.mod as m\nm.f()\n', 'pkg.mod:f'],
  ])('resolves a module attribute call after %s', (_form, code, target) => {
    expect(edges(code)).toEqual([[fileScope, target]]);
  });

  it('counts an imported function used as a value', () => {
    expect(edges('from .m import f\nhandlers = [f]\nregister(callback=f)\n')).toEqual([
      [fileScope, '.m:f'],
      [fileScope, '.m:f'],
    ]);
  });

  it('does not count an import clause, a keyword name or an attribute name as a use', () => {
    expect(edges('from .m import f\nimport f\nx.f\nregister(f=1)\n')).toEqual([]);
  });

  it('does not count a name that is only in a comment or a string', () => {
    expect(edges('from .m import f\n# f()\ns = "f()"\n')).toEqual([]);
  });

  it('uses the normalized path in the file scope id, whatever the platform separator', () => {
    const windowsFile = 'C:\\ws\\src\\consumer.py';
    const [dep] = analyzer.analyzeFileContent(windowsFile, 'from .m import f\nf()\n').dependencies;
    expect(dep.sourceSymbolId).toBe(`${normalizePath(windowsFile)}:(file)`);
    expect(dep.sourceSymbolId.slice(0, dep.sourceSymbolId.lastIndexOf(':'))).toBe(normalizePath(windowsFile));
  });

  it.each([
    ['empty content', ''],
    ['no import', 'x = 1\nprint(x)\n'],
  ])('yields no dependency for %s', (_form, code) => {
    expect(edges(code)).toEqual([]);
  });

  it('credits a parameter that shadows an import (over-credit, pinned)', () => {
    expect(edges('from .m import f\ndef g(f):\n    return f()\n')).toEqual([[`${file}:g`, '.m:f']]);
  });

  it('does not credit the class of `K.attr` as a value (pinned limit)', () => {
    expect(edges('from .m import K\nx = K.CONST\n')).toEqual([]);
  });

  it('resolves `f.bar()` after `from .m import f` as submodule `.m.f` (pinned limit)', () => {
    // shortcut: every from-import may be a submodule; a wrong guess resolves to no file, so it credits nothing.
    expect(edges('from .m import f\nf.bar()\n')).toEqual([[fileScope, '.m.f:bar']]);
  });

  it('ignores a call to an attribute of something that is not an imported module', () => {
    expect(edges('from .m import f\nobj.g()\n')).toEqual([]);
  });
});
