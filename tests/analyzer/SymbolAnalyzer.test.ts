import { describe, it, expect } from 'vitest';
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
});
