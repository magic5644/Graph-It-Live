import { describe, it, expect } from 'vitest';
import { SymbolAnalyzer } from '../../src/analyzer/SymbolAnalyzer';

describe('SymbolAnalyzer - Hierarchical Symbols', () => {
  const analyzer = new SymbolAnalyzer();

  it('should extract class methods with parent relationship', () => {
    const filePath = '/test/MyClass.ts';
    const content = `
      export class MyClass {
        constructor() {}
        
        public greet(name: string): string {
          return \`Hello, \${name}!\`;
        }
        
        private formatName(name: string): string {
          return name.toUpperCase();
        }
        
        static create(): MyClass {
          return new MyClass();
        }
      }
    `;

    const { symbols } = analyzer.analyzeFileContent(filePath, content);

    // Should have 1 class + 4 methods (constructor, greet, formatName, create)
    expect(symbols.length).toBeGreaterThanOrEqual(4);

    // Find the class symbol
    const classSymbol = symbols.find(s => s.name === 'MyClass' && s.kind === 'ClassDeclaration');
    expect(classSymbol).toBeDefined();
    expect(classSymbol?.parentSymbolId).toBeUndefined(); // Class has no parent

    // Find method symbols
    const greetMethod = symbols.find(s => s.name === 'MyClass.greet');
    expect(greetMethod).toBeDefined();
    expect(greetMethod?.parentSymbolId).toBe(`${filePath}:MyClass`);
    expect(greetMethod?.kind).toBe('MethodDeclaration');

    const formatNameMethod = symbols.find(s => s.name === 'MyClass.formatName');
    expect(formatNameMethod).toBeDefined();
    expect(formatNameMethod?.parentSymbolId).toBe(`${filePath}:MyClass`);

    const staticMethod = symbols.find(s => s.name === 'MyClass.create');
    expect(staticMethod).toBeDefined();
    expect(staticMethod?.parentSymbolId).toBe(`${filePath}:MyClass`);
    expect(staticMethod?.kind).toBe('StaticMethodDeclaration');
  });

  it('should extract class properties with parent relationship', () => {
    const filePath = '/test/DataClass.ts';
    const content = `
      export class DataClass {
        public name: string;
        private age: number;
        static readonly MAX_AGE = 100;
        
        constructor(name: string, age: number) {
          this.name = name;
          this.age = age;
        }
      }
    `;

    const { symbols } = analyzer.analyzeFileContent(filePath, content);

    // Find property symbols
    const nameProperty = symbols.find(s => s.name === 'DataClass.name');
    expect(nameProperty).toBeDefined();
    expect(nameProperty?.parentSymbolId).toBe(`${filePath}:DataClass`);
    expect(nameProperty?.kind).toBe('PropertyDeclaration');

    const maxAgeProperty = symbols.find(s => s.name === 'DataClass.MAX_AGE');
    expect(maxAgeProperty).toBeDefined();
    expect(maxAgeProperty?.parentSymbolId).toBe(`${filePath}:DataClass`);
    expect(maxAgeProperty?.kind).toBe('StaticPropertyDeclaration');
  });

  it('should handle getters and setters with parent relationship', () => {
    const filePath = '/test/GetSet.ts';
    const content = `
      export class GetSet {
        private _value: number = 0;
        
        get value(): number {
          return this._value;
        }
        
        set value(v: number) {
          this._value = v;
        }
      }
    `;

    const { symbols } = analyzer.analyzeFileContent(filePath, content);

    const getter = symbols.find(s => s.name === 'GetSet.value' && s.kind === 'GetAccessor');
    expect(getter).toBeDefined();
    expect(getter?.parentSymbolId).toBe(`${filePath}:GetSet`);

    const setter = symbols.find(s => s.name === 'GetSet.value' && s.kind === 'SetAccessor');
    expect(setter).toBeDefined();
    expect(setter?.parentSymbolId).toBe(`${filePath}:GetSet`);
  });

  it('should not create parent relationship for standalone functions', () => {
    const filePath = '/test/standalone.ts';
    const content = `
      export function standalone() {
        return 'Hello';
      }
      
      export class MyClass {
        method() {}
      }
    `;

    const { symbols } = analyzer.analyzeFileContent(filePath, content);

    const standaloneFunc = symbols.find(s => s.name === 'standalone');
    expect(standaloneFunc).toBeDefined();
    expect(standaloneFunc?.parentSymbolId).toBeUndefined(); // No parent for standalone function

    const method = symbols.find(s => s.name === 'MyClass.method');
    expect(method).toBeDefined();
    expect(method?.parentSymbolId).toBe(`${filePath}:MyClass`); // Has parent
  });
});
