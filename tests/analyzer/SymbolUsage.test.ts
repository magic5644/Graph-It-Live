import { describe, it, expect } from 'vitest';
import { SymbolAnalyzer } from '../../src/analyzer/SymbolAnalyzer';

describe('SymbolAnalyzer - Symbol Usage Tracking', () => {
  
  describe('Import resolution and alias tracking', () => {
    it('should track usage of imported symbols', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { utilFunc } from './utils';

export function myFunction() {
  return utilFunc();
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('myFunction');
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('./utils:utilFunc');
    });

    it('should handle aliased imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { format as f } from './formatter';

export function prettify(text: string) {
  return f(text);
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      // Should track the ORIGINAL name, not the alias
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('./formatter:format');
    });

    it('should handle default imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import React from 'react';

export function Component() {
  return React.createElement('div');
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('react:default');
    });

    it('should handle namespace imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import * as Utils from './utils';

export function doSomething() {
  return Utils.helper();
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('./utils:*');
    });

    it('should ignore type-only imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import type { MyType } from './types';
import { MyClass } from './classes';

export function process(x: MyType) {
  return new MyClass();
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      // Should have both dependencies, but type-only imports are marked with isTypeOnly: true
      expect(result.dependencies).toHaveLength(2);
      
      const classDep = result.dependencies.find(d => d.targetSymbolId === './classes:MyClass');
      expect(classDep).toBeDefined();
      expect(classDep!.isTypeOnly).toBe(false);
      
      const typeDep = result.dependencies.find(d => d.targetSymbolId === './types:MyType');
      expect(typeDep).toBeDefined();
      expect(typeDep!.isTypeOnly).toBe(true);
    });

    it('should detect unused imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { used, unused } from './module';

export function myFunc() {
  return used();
  // 'unused' is imported but never called
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      // Should only have dependency on 'used', not 'unused'
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('./module:used');
    });
  });

  describe('Multiple symbols and dependencies', () => {
    it('should track dependencies for multiple exported symbols', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { helperA, helperB } from './helpers';

export function funcA() {
  return helperA();
}

export function funcB() {
  return helperB();
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.symbols).toHaveLength(2);
      expect(result.dependencies).toHaveLength(2);
      
      // funcA depends on helperA
      const depA = result.dependencies.find(d => d.sourceSymbolId.includes('funcA'));
      expect(depA?.targetSymbolId).toBe('./helpers:helperA');
      
      // funcB depends on helperB
      const depB = result.dependencies.find(d => d.sourceSymbolId.includes('funcB'));
      expect(depB?.targetSymbolId).toBe('./helpers:helperB');
    });

    it('should handle a symbol using multiple imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { add, multiply } from './math';

export function calculate(a: number, b: number) {
  return multiply(add(a, b), 2);
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies.some(d => d.targetSymbolId === './math:add')).toBe(true);
      expect(result.dependencies.some(d => d.targetSymbolId === './math:multiply')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle files with no imports', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
export function standalone() {
  return 42;
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.symbols).toHaveLength(1);
      expect(result.dependencies).toHaveLength(0);
    });

    it('should handle files with imports but no usage', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { unused } from './module';

export function myFunc() {
  return 42;
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      expect(result.symbols).toHaveLength(1);
      expect(result.dependencies).toHaveLength(0);
    });

    it('should avoid duplicate dependencies', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
import { helper } from './utils';

export function myFunc() {
  helper();
  helper(); // Called twice
  helper(); // Called three times
}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      
      // Should only have ONE dependency edge, despite multiple calls
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].targetSymbolId).toBe('./utils:helper');
    });
  });

  describe('Runtime filtering', () => {
    it('should filter out type-only symbols', () => {
      const analyzer = new SymbolAnalyzer();
      const content = `
export interface MyInterface {
  prop: string;
}

export type MyType = {
  value: number;
};

export function myFunction() {
  return 42;
}

export class MyClass {}
`;
      
      const result = analyzer.analyzeFileContent('/test.ts', content);
      const runtimeSymbols = analyzer.filterRuntimeSymbols(result.symbols);
      
      // Should only have function and class, not interface or type
      expect(runtimeSymbols).toHaveLength(2);
      expect(runtimeSymbols.some(s => s.name === 'myFunction')).toBe(true);
      expect(runtimeSymbols.some(s => s.name === 'MyClass')).toBe(true);
      expect(runtimeSymbols.some(s => s.name === 'MyInterface')).toBe(false);
      expect(runtimeSymbols.some(s => s.name === 'MyType')).toBe(false);
    });
  });
});
