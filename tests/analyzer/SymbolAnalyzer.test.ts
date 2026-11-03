import { describe, expect, it } from 'vitest';
import { SymbolAnalyzer } from '../../src/analyzer/SymbolAnalyzer';

describe('SymbolAnalyzer', () => {
  it('should extract exported functions', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export function myFunction() {
  return 42;
}

export const anotherFunction = () => {
  return 'hello';
};
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('myFunction');
    expect(result[0].isExported).toBe(true);
    expect(result[1].name).toBe('anotherFunction');
    expect(result[1].isExported).toBe(true);
  });

  it('should extract exported classes', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export class MyClass {
  constructor() {}
  
  method() {
    return 'test';
  }
}
`;
    
   const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('MyClass');
    expect(result[0].isExported).toBe(true);
  });

  it('should extract constants and variables', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export const MY_CONSTANT = 42;
export let myVariable = 'hello';
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(2);
    expect(result.some(s => s.name === 'MY_CONSTANT')).toBe(true);
    expect(result.some(s => s.name === 'myVariable')).toBe(true);
  });

  it('should extract interfaces and types', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export interface MyInterface {
  prop: string;
}

export type MyType = {
  value: number;
};
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(2);
    expect(result.some(s => s.name === 'MyInterface')).toBe(true);
    expect(result.some(s => s.name === 'MyType')).toBe(true);
  });

  it('should handle default exports', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export default function defaultFunction() {
  return true;
}
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'defaultFunction', id: '/test.ts:defaultFunction', isExported: true, isDefaultExport: true });
  });

  it('should not include non-exported symbols', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
function privateFunction() {
  return 'private';
}

export function publicFunction() {
  return 'public';
}

const privateConst = 123;
export const publicConst = 456;
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(2);
    expect(result.every(s => s.isExported)).toBe(true);
    expect(result.some(s => s.name === 'privateFunction')).toBe(false);
    expect(result.some(s => s.name === 'privateConst')).toBe(false);
  });

  it('should capture line numbers correctly', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
// Line 2
export function firstFunction() {
  return 1;
}

// Line 7
export function secondFunction() {
  return 2;
}
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe(3); // firstFunction on line 3
    expect(result[1].line).toBe(8); // secondFunction on line 8
  });

  it('should generate unique IDs for symbols', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export function myFunc() {}
export class MyClass {}
`;
    
    const result = analyzer.getExportedSymbols('/path/to/file.ts', content);
    
    expect(result[0].id).toBe('/path/to/file.ts:myFunc');
    expect(result[1].id).toBe('/path/to/file.ts:MyClass');
  });

  it('should handle empty files', () => {
    const analyzer = new SymbolAnalyzer();
    const content = '';
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(0);
  });

  it('should handle files with only imports', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
import { something } from './other';
import * as utils from './utils';

console.log('no exports here');
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    expect(result).toHaveLength(0);
  });

  it('should handle re-exports', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export { myFunction } from './other';
export * from './utils';
`;
    
    const result = analyzer.getExportedSymbols('/test.ts', content);
    
    // Re-exports should be captured
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('should extract symbols from analyzeFile', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export function testFunc() {
  return 42;
}
`;
    
    const result = analyzer.analyzeFileContent('/test.ts', content);
    
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].name).toBe('testFunc');
    expect(result.dependencies).toEqual([]); // Dependencies not yet implemented
  });

  it('should not produce duplicate symbols for function overloads', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export function greet(name: string): string;
export function greet(name: string, greeting: string): string;
export function greet(name: string, greeting?: string): string {
  return (greeting ?? 'Hello') + ', ' + name;
}
`;

    const result = analyzer.getExportedSymbols('/overloads.ts', content);

    // Should produce exactly one symbol for 'greet', not three
    const greetSymbols = result.filter(s => s.name === 'greet');
    expect(greetSymbols).toHaveLength(1);
  });

  it('should not produce duplicate symbols for merged interfaces', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export interface Config {
  host: string;
}

export interface Config {
  port: number;
}
`;

    const result = analyzer.getExportedSymbols('/merged.ts', content);

    const configSymbols = result.filter(s => s.name === 'Config');
    expect(configSymbols).toHaveLength(1);
  });

  it('should not produce duplicate symbols via analyzeFileContent for overloads', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export function parse(input: string): number;
export function parse(input: string, radix: number): number;
export function parse(input: string, radix?: number): number {
  return parseInt(input, radix);
}
`;

    const result = analyzer.analyzeFileContent('/parse.ts', content);

    const parseSymbols = result.symbols.filter(s => s.name === 'parse');
    expect(parseSymbols).toHaveLength(1);
  });

  it('counts reparses of the same file toward the project reset', () => {
    // ts-morph keeps wrapper nodes of replaced trees until the project is dropped:
    // a workspace under maxFiles files rebuilt again and again must still reset.
    const analyzer = new SymbolAnalyzer(undefined, { maxFiles: 3 });
    analyzer.analyzeFileContent('/a.ts', 'export const a = 1;');
    analyzer.analyzeFileContent('/a.ts', 'export const a = 2;');
    expect(analyzer.getFileCount()).toBe(2);

    analyzer.analyzeFileContent('/a.ts', 'export const a = 3;');
    const result = analyzer.analyzeFileContent('/a.ts', 'export const b = 4;');

    expect(analyzer.getFileCount()).toBe(1);
    expect(result.symbols.map(s => s.name)).toEqual(['b']);
  });

  it('reparses an existing file with its new content', () => {
    const analyzer = new SymbolAnalyzer();
    analyzer.analyzeFileContent('/a.ts', 'export const a = 1;');

    const result = analyzer.analyzeFileContent('/a.ts', 'export function b() {}');

    expect(result.symbols.map(s => s.name)).toEqual(['b']);
  });

  describe('intra-file member calls', () => {
    const targetsOf = (content: string, source: string) => new SymbolAnalyzer()
      .analyzeFileContent('/calls.ts', content).dependencies
      .filter(d => d.sourceSymbolId === `/calls.ts:${source}`)
      .map(d => d.targetSymbolId);

    // Regression: `spider.scanDeadCode()` inside `function scanDeadCode` was
    // resolved by name to the function itself and reported as a cycle.
    it('does not resolve obj.method() to a local function of the same name', () => {
      const content = `export function scanDeadCode(spider: { scanDeadCode(): number }) { return spider.scanDeadCode(); }\n`;
      expect(targetsOf(content, 'scanDeadCode')).not.toContain('/calls.ts:scanDeadCode');
    });

    it('does not resolve a bare call to a class method of the same name', () => {
      const content = `export class Runner { run() { return 1; } }\nexport function start(run: () => number) { return run(); }\n`;
      expect(targetsOf(content, 'start')).toEqual([]);
    });

    it('resolves this.method() to the enclosing class method, arrow functions included', () => {
      const content = `export class Greeter {
  greet() { return [1].map(() => this.wrap()); }
  wrap() { return 1; }
}
`;
      expect(targetsOf(content, 'Greeter')).toContain('/calls.ts:Greeter.wrap');
    });

    it('ignores this.method() where this is not the class instance', () => {
      const content = `export class Greeter {
  greet() {
    const other = { wrap() { return 2; }, call() { return this.wrap(); } };
    return function (this: { wrap(): number }) { return this.wrap(); }.call(other);
  }
  wrap() { return 1; }
  missing() { return this.absent?.(); }
}
`;
      expect(targetsOf(content, 'Greeter')).not.toContain('/calls.ts:Greeter.wrap');
    });
  });

  it('should record end lines for symbols and lines for call sites', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `import { format } from './format';

export class Greeter {
  greet(name: string) {
    return this.wrap(format(name));
  }

  wrap(text: string) {
    return text;
  }
}

function helper() {
  return 1;
}

export function main() {
  const value = helper();
  return import('./lazy').then(() => value);
}
`;

    const result = analyzer.analyzeFileContent('/greeter.ts', content);
    const byName = new Map(result.symbols.map(s => [s.name, s]));

    expect(byName.get('Greeter')).toMatchObject({ line: 3, endLine: 11 });
    expect(byName.get('Greeter.greet')).toMatchObject({ line: 4, endLine: 6 });
    expect(byName.get('helper')).toMatchObject({ line: 13, endLine: 15 });
    expect(byName.get('main')).toMatchObject({ line: 17, endLine: 20 });

    const lineOf = (source: string, target: string) =>
      result.dependencies.find(d => d.sourceSymbolId === `/greeter.ts:${source}` && d.targetSymbolId.endsWith(target))?.line;
    expect(lineOf('Greeter', ':format')).toBe(5);
    expect(lineOf('Greeter', ':Greeter.wrap')).toBe(5);
    expect(lineOf('main', ':helper')).toBe(18);
    expect(lineOf('main', './lazy:default')).toBe(19);
  });

  it('should map exported symbols to the other exports they reference', () => {
    const analyzer = new SymbolAnalyzer();
    const content = `
export type Options = { depth: number };
export function helper(): number { return 1; }
export function run(options: Options): number { return helper() + options.depth; }
`;

    const graph = analyzer.getInternalExportDependencyGraph('/test.ts', content);

    expect([...(graph.get('/test.ts:run') ?? [])].sort()).toEqual(['/test.ts:Options', '/test.ts:helper']);
    expect([...(graph.get('/test.ts:helper') ?? [])]).toEqual([]);
  });
});

describe('SymbolAnalyzer - namespace imports', () => {
  const targetsOf = (content: string, source: string) =>
    new SymbolAnalyzer()
      .analyzeFileContent('/consumer.ts', content)
      .dependencies.filter((d) => d.sourceSymbolId === `/consumer.ts:${source}` && d.targetFilePath === './mod')
      .map((d) => d.targetSymbolId)
      .sort();

  it('resolves a member access on a namespace to the accessed export', () => {
    const content = `
import * as m from './mod';
export const run = () => m.fn(1);
`;
    expect(targetsOf(content, 'run')).toEqual(['./mod:fn']);
  });

  it.each(['vi.spyOn', 'jest.spyOn', 'spyOn'])('resolves %s(ns, "member") to the spied export', (spyOn) => {
    const content = `
import * as m from './mod';
export const spy = ${spyOn}(m, "fn");
`;
    expect(targetsOf(content, 'spy')).toEqual(['./mod:fn']);
  });

  it('keeps a bare namespace passed as a value unresolved', () => {
    const content = `
import * as m from './mod';
declare function register(target: unknown, name: string): void;
export const all = () => register(m, "fn");
export const copy = { ...m };
`;
    expect(targetsOf(content, 'all')).toEqual(['./mod:*']);
    expect(targetsOf(content, 'copy')).toEqual(['./mod:*']);
  });

  it('keeps isTypeOnly for a member of a type-only namespace import', () => {
    const content = `
import type * as T from './types';
export function read(options: T.Options): void {}
`;
    const deps = new SymbolAnalyzer()
      .analyzeFileContent('/consumer.ts', content)
      .dependencies.filter((d) => d.sourceSymbolId === '/consumer.ts:read');
    expect(deps.map((d) => [d.targetSymbolId, d.isTypeOnly])).toEqual([['./types:Options', true]]);
  });
});

describe('SymbolAnalyzer - category', () => {
  const content = `
type Fn = () => number;
declare function wrap<T>(fn: T): T;
export const f = () => 1;
export const g = async function () { return 2; };
export const p = (() => 1);
export const s = (() => 1) satisfies Fn;
export const a = (() => 1) as Fn;
export const t = <Fn>(() => 1);
export const n = (() => 1)!;
export const c = /* c */ async () => 1;
export const k = 42;
export const h = wrap(() => 1);
export const iife = (() => 1)();
export let u;
export enum E { A }
export class C {
  run() { return 1; }
  handler = () => 1;
  count = 0;
  get size() { return 1; }
}
export namespace N {}
export interface I {}
export type T = string;
export function d() { return g(); }
const local = function () { return 3; };
let localValue = 4;
enum LocalEnum { B }
class LocalClass {}
function localFn() { return local() + localValue; }
`;
  const expected = {
    f: 'function', g: 'function', p: 'function', s: 'function', a: 'function',
    t: 'function', n: 'function', c: 'function',
    k: 'variable', h: 'variable', iife: 'variable', u: 'variable',
    E: 'type', C: 'class', 'C.run': 'function', 'C.handler': 'function', 'C.count': 'variable', 'C.size': 'function',
    N: 'other',
    I: 'interface', T: 'type', d: 'function',
    local: 'function', localValue: 'variable', LocalEnum: 'type', LocalClass: 'class', localFn: 'function',
  };

  it('categorizes function-valued consts as function and keeps kind VariableDeclaration', () => {
    const symbols = new SymbolAnalyzer().analyzeFileContent('/cat.ts', content).symbols;
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(Object.fromEntries(Object.keys(expected).map((name) => [name, byName.get(name)?.category])))
      .toEqual(expected);
    for (const name of ['f', 'g', 'p', 's', 'c', 'k', 'h', 'local']) {
      expect(byName.get(name)?.kind).toBe('VariableDeclaration');
    }
    expect(byName.get('E')?.kind).toBe('EnumDeclaration');
  });

  it('gives getExportedSymbols the same categories as analyzeFileContent', () => {
    const analyzer = new SymbolAnalyzer();
    const full = analyzer.analyzeFileContent('/cat.ts', content).symbols.filter((s) => s.isExported);
    const exported = analyzer.getExportedSymbols('/cat.ts', content);

    expect(exported.map((s) => [s.name, s.category])).toEqual(full.map((s) => [s.name, s.category]));
  });

  it('does not change filterRuntimeSymbols for the new categories', () => {
    const analyzer = new SymbolAnalyzer();
    const runtime = analyzer.filterRuntimeSymbols(analyzer.getExportedSymbols('/cat.ts', content));

    expect(runtime.map((s) => s.name).sort()).toEqual(
      ['C', 'E', 'N', 'a', 'c', 'd', 'f', 'g', 'h', 'iife', 'k', 'n', 'p', 's', 't', 'u'],
    );
  });
});

describe('SymbolAnalyzer - symbols do not depend on the files analyzed before (#541)', () => {
  const DEP = 'export function yFn() {}\nexport default function dflt() {}\nexport const yv = 1;\nexport * from "./x";\n';
  const summary = (symbols: Array<{ name: string; isExported: boolean; kind: string }>) =>
    symbols.map((s) => `${s.name}${s.isExported ? '*' : ''}:${s.kind}`);

  // [form, source of the barrel, expected symbols of the barrel]
  it.each([
    ['export *', 'export * from "./y";', []],
    ['export * as ns', 'export * as ns from "./y";', []],
    ['named and renamed re-export', 'export { yFn, yv as alias } from "./y";', []],
    ['import then export', 'import { yFn } from "./y";\nexport { yFn };', []],
    ['default re-export through an import', 'import d from "./y";\nexport default d;', []],
    ['export { default } from', 'export { default } from "./y";', []],
    ['namespace import then export', 'import * as N from "./y";\nexport { N };', []],
    ['local export renamed next to export *', 'function f() {}\nexport { f as g };\nexport * from "./y";', ['g*:FunctionDeclaration', 'f:FunctionDeclaration']],
    ['local non-exported name shadowed by export *', 'function yFn() {}\nexport * from "./y";', ['yFn:FunctionDeclaration']],
    ['local export of the same name as export *', 'export function yFn() {}\nexport * from "./y";', ['yFn*:FunctionDeclaration']],
    ['export = of an import', 'import y = require("./y");\nexport = y;', []],
    ['export import of a require', 'export import Y = require("./y");', []],
    ['export import alias of an imported namespace', 'import * as Y from "./y";\nexport import A = Y.yFn;', []],
    ['export import alias of a local namespace', 'namespace N { export function b() {} }\nexport import A = N.b;', ['A*:ImportEqualsDeclaration']],
    ['export import alias of a nested local namespace', 'namespace N { export namespace M { export const c = 1; } }\nexport import A = N.M.c;', ['A*:ImportEqualsDeclaration']],
  ])('%s: same symbols alone and after the re-exported file', (_form, source, expected) => {
    for (const [x, y] of [['/ws/cyc/x.ts', '/ws/cyc/y.ts'], [String.raw`C:\ws\cyc\x.ts`, String.raw`C:\ws\cyc\y.ts`]]) {
      const alone = new SymbolAnalyzer().analyzeFileContent(x, source);
      const warm = new SymbolAnalyzer();
      warm.analyzeFileContent(y, DEP);
      const after = warm.analyzeFileContent(x, source);

      expect(summary(alone.symbols)).toEqual(expected);
      expect(summary(after.symbols)).toEqual(expected);
      expect(after.dependencies).toEqual(alone.dependencies);
      expect(new SymbolAnalyzer().getExportedSymbols(x, source)).toEqual(warm.getExportedSymbols(x, source));
    }
  });

  it('keeps the symbols of the file that declares them', () => {
    const analyzer = new SymbolAnalyzer();
    analyzer.analyzeFileContent('/ws/cyc/x.ts', 'export * from "./y";');
    const { symbols } = analyzer.analyzeFileContent('/ws/cyc/y.ts', DEP);

    // A named default export is listed once, under its declared name (#575).
    expect(summary(symbols)).toEqual(['yFn*:FunctionDeclaration', 'yv*:VariableDeclaration', 'dflt*:FunctionDeclaration']);
    expect(symbols.every((s) => s.id.startsWith('/ws/cyc/y.ts:'))).toBe(true);
  });

  it('builds the internal export graph from local exports only, in any order', () => {
    const source = 'import { yFn } from "./y";\nexport { yFn };\nexport function use() { return yFn(); }\nexport function helper() { return use(); }';
    const alone = new SymbolAnalyzer().getInternalExportDependencyGraph('/ws/x.ts', source);
    const warm = new SymbolAnalyzer();
    warm.analyzeFileContent('/ws/y.ts', DEP);
    const after = warm.getInternalExportDependencyGraph('/ws/x.ts', source);

    expect([...alone].map(([id, deps]) => [id, [...deps]])).toEqual([
      ['/ws/x.ts:use', []],
      ['/ws/x.ts:helper', ['/ws/x.ts:use']],
    ]);
    expect([...after].map(([id, deps]) => [id, [...deps]])).toEqual([...alone].map(([id, deps]) => [id, [...deps]]));
  });

  it('returns no symbols for an empty file or a file of re-exports only', () => {
    expect(new SymbolAnalyzer().analyzeFileContent('/ws/empty.ts', '').symbols).toEqual([]);
    expect(new SymbolAnalyzer().getExportedSymbols('/ws/barrel.ts', 'export * from "./missing";')).toEqual([]);
  });
});

describe('SymbolAnalyzer - React references (#575)', () => {
  /** `source -> target:relation@line` for the dependencies of a .tsx file. */
  const edges = (source: string, file = '/ws/App.tsx') =>
    new SymbolAnalyzer().analyzeFileContent(file, source).dependencies
      .map((d) => `${d.sourceSymbolId.split(':').pop()} -> ${d.targetSymbolId.replace(/^\/ws\//, '')}:${d.relation ?? 'use'}@${d.line}`);

  it.each([
    {
      title: 'a JSX element of an import, once for its opening and closing tags',
      source: `import { Card } from './Card';\nexport function App() { return <Card>\n</Card>; }`,
      expected: ['App -> ./Card:Card:REFERENCES@2'],
    },
    {
      title: 'a namespace JSX element and a namespace attribute value',
      source: `import * as UI from './ui';\nexport function App() { return <UI.Card onClick={UI.save} />; }`,
      expected: ['App -> ./ui:Card:REFERENCES@2', 'App -> ./ui:save:REFERENCES@2'],
    },
    {
      title: 'a handler passed as a value, and the same handler called in an arrow',
      source: `import { save } from './h';\nexport function App() { return <><b onClick={save} />\n<i onClick={() => save()} /></>; }`,
      expected: ['App -> ./h:save:REFERENCES@2', 'App -> ./h:save:use@3'],
    },
    {
      title: 'a render prop, a local component and a self-recursive one',
      source: `function Row() { return null; }\nexport function Tree() { return <List render={Row}><Tree /></List>; }`,
      expected: ['Tree -> App.tsx:Row:REFERENCES@2', 'Tree -> App.tsx:Tree:REFERENCES@2'],
    },
    {
      title: 'a member tag of a local object, whose member is not a declaration of this file',
      source: `const Ext = { Card: () => null };\nfunction Card() { return null; }\nexport function App() { return <Ext.Card />; }`,
      expected: [],
    },
    {
      title: 'a lowercase tag even when a local or an import has its name',
      source: `import { button } from './b';\nconst main = 1;\nexport function App() { return <main><button /></main>; }`,
      expected: [],
    },
    {
      title: 'a child value or a parameter used as a component',
      source: `const label = 'x';\nexport function App({ Slot }: { Slot: () => null }) { return <div>{label}<Slot /></div>; }`,
      expected: [],
    },
    {
      title: 'the memo, forwardRef and lazy wrappers, bare or as React.*',
      source: `import React, { memo, lazy } from 'react';\nexport const A = memo(function A() { return null; });\nexport const B = React.forwardRef(function B() { return null; });\nexport const C = lazy(() => import('./C'));\nexport default memo(A);`,
      expected: ['C -> ./C:default:REFERENCES@4'],
    },
    {
      title: 'an import() outside lazy(), which stays a plain use',
      source: `export async function load() { const { run } = await import('./run'); return run; }`,
      expected: ['load -> ./run:run:use@1'],
    },
  ])('records $title', ({ source, expected }) => {
    expect(edges(source).sort()).toEqual([...expected].sort());
  });

  it('records JSX references in a .jsx file and a class component', () => {
    expect(edges(`import { Card } from './Card';\nexport class Page { render() { return <Card />; } }`, '/ws/Page.jsx'))
      .toEqual(['Page -> ./Card:Card:REFERENCES@2']);
  });

  it.each([
    ['memo', 'export const A = memo(() => null);'],
    ['React.forwardRef', 'export const A = React.forwardRef(function A() { return null; });'],
    ['lazy', "export const A = lazy(() => import('./A'));"],
  ])('treats a %s component as a function', (_wrapper, source) => {
    expect(new SymbolAnalyzer().getExportedSymbols('/ws/A.tsx', source).map((s) => s.category)).toEqual(['function']);
  });

  it('keeps an unknown wrapper a variable', () => {
    expect(new SymbolAnalyzer().getExportedSymbols('/ws/A.tsx', 'export const A = withRouter(B);').map((s) => s.category)).toEqual(['variable']);
  });

  it.each([
    ['function Panel() { return null; }\nexport default memo(Panel);', 'Panel'],
    ['export default () => null;', 'default'],
  ])('lists a default export under its declared name, or default when anonymous', (source, name) => {
    const symbols = new SymbolAnalyzer().analyzeFileContent('/ws/P.tsx', source).symbols;

    expect(symbols.filter((s) => s.isExported).map((s) => [s.name, s.isDefaultExport])).toEqual([[name, true]]);
  });
});

describe('SymbolAnalyzer - a parameter of a top-level function shadows a same-name declaration (#575)', () => {
  it.each([
    ['a function parameter', 'export function run(save: () => void) { register(save); }'],
    ['a destructured parameter', 'export function run({ save }: { save: () => void }) { register(save); }'],
    ['an arrow function parameter', 'export const run = (save: () => void) => register(save);'],
    ['a catch variable', 'export function run() { try {} catch (save) { register(save); } }'],
    ['a for-of variable', 'export function run(list: Array<() => void>) { for (const save of list) register(save); }'],
  ])('passes no reference to the top-level function through %s', (_title, source) => {
    const deps = new SymbolAnalyzer().analyzeFileContent('/ws/a.ts', `function save() {}\n${source}`).dependencies;

    expect(deps.filter((d) => d.relation === 'REFERENCES')).toEqual([]);
  });

  it('references the top-level function when nothing shadows it', () => {
    const deps = new SymbolAnalyzer().analyzeFileContent('/ws/a.ts', 'function save() {}\nexport function run() { register(save); }').dependencies;

    expect(deps.map((d) => `${d.targetSymbolId}:${d.relation}@${d.line}`)).toEqual(['/ws/a.ts:save:REFERENCES@2']);
  });
});
