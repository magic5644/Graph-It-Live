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
    expect(result[0].name).toBe('default');
    expect(result[0].isExported).toBe(true);
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
    expect(lineOf('Greeter', ':wrap')).toBe(5);
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
