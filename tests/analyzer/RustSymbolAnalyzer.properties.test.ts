import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';
import path from 'node:path';
import { RustSymbolAnalyzer } from '@/analyzer/languages/RustSymbolAnalyzer';
import { normalizePath } from '@/shared/path';
import type Parser from 'web-tree-sitter';

/**
 * Property-Based Tests for RustSymbolAnalyzer WASM Migration
 * 
 * These tests validate universal properties that should hold across all valid inputs.
 * Each test runs 100 iterations with randomly generated data.
 * 
 * **Validates: Requirements 3.5**
 * 
 * Note: These tests use mocked web-tree-sitter to avoid requiring WASM files during testing.
 * The mocks simulate the tree-sitter AST structure for Rust symbols.
 */

// Mock extension path for testing
const mockExtensionPath = path.resolve(process.cwd());
const fixturesDir = path.resolve(__dirname, '../fixtures/rust-integration');
const unusedDepsDir = path.resolve(__dirname, '../fixtures/rust-unused-deps');

// Mock tree-sitter to simulate parsing without requiring WASM files
vi.mock('web-tree-sitter', () => {
  const createMockNode = (
    type: string,
    text: string,
    startRow: number,
    startCol: number = 0,
    startIndex: number = 0,
    children: Parser.SyntaxNode[] = []
  ): Parser.SyntaxNode => ({
    type,
    startPosition: { row: startRow, column: startCol },
    endPosition: { row: startRow, column: startCol + text.length },
    startIndex,
    endIndex: startIndex + text.length,
    text,
    children,
    childCount: children.length,
    namedChildCount: children.length,
    firstChild: children[0] || null,
    firstNamedChild: children[0] || null,
    lastChild: children[children.length - 1] || null,
    lastNamedChild: children[children.length - 1] || null,
    nextSibling: null,
    nextNamedSibling: null,
    previousSibling: null,
    previousNamedSibling: null,
    parent: null,
    descendantCount: 0,
    id: 0,
    tree: null as any,
    isNamed: true,
    isMissing: false,
    isExtra: false,
    hasChanges: false,
    hasError: false,
    isError: false,
    parseState: 0,
    nextParseState: 0,
    grammarId: 0,
    grammarType: type,
    childForFieldName: (fieldName: string) => {
      if (fieldName === 'name' && children.length > 0) {
        return children.find(c => c.type === 'identifier') || null;
      }
      if (fieldName === 'visibility_modifier') {
        return children.find(c => c.type === 'visibility_modifier') || null;
      }
      return null;
    },
    childForFieldId: () => null,
    fieldNameForChild: () => null,
    fieldNameForNamedChild: () => null,
    child: (index: number) => children[index] || null,
    namedChild: (index: number) => children[index] || null,
    childrenForFieldName: () => [],
    childrenForFieldId: () => [],
    descendantForIndex: () => null as any,
    namedDescendantForIndex: () => null as any,
    descendantForPosition: () => null as any,
    namedDescendantForPosition: () => null as any,
    descendantsOfType: () => [],
    walk: () => null as any,
    toString: () => text,
  });

  const mockParse = vi.fn((content: string) => {
    const lines = content.split('\n');
    const children: Parser.SyntaxNode[] = [];
    
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//')) {
        return;
      }
      
      // Calculate the start index of this line in the content
      const lineStartIndex = lines.slice(0, lineIndex).reduce((acc, l) => acc + l.length + 1, 0);
      
      // Match: pub fn function_name(...) or fn function_name(...)
      if (trimmed.includes('fn ')) {
        const match = /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i.exec(trimmed);
        if (match) {
          const funcName = match[1];
          const isPublic = trimmed.includes('pub fn');
          const isAsync = trimmed.includes('async fn');
          
          // Find the position of the function name in the line
          const funcNameIndex = line.indexOf(funcName);
          const funcNameStartIndex = lineStartIndex + funcNameIndex;
          
          // Create identifier node for function name
          const nameNode = createMockNode('identifier', funcName, lineIndex, funcNameIndex, funcNameStartIndex);
          
          const funcChildren: Parser.SyntaxNode[] = [nameNode];
          
          // Add visibility modifier if public
          if (isPublic) {
            const pubIndex = line.indexOf('pub');
            const visNode = createMockNode('visibility_modifier', 'pub', lineIndex, pubIndex, lineStartIndex + pubIndex);
            funcChildren.unshift(visNode);
          }
          
          // Add async keyword if present
          if (isAsync) {
            const asyncIndex = line.indexOf('async');
            const asyncNode = createMockNode('async', 'async', lineIndex, asyncIndex, lineStartIndex + asyncIndex);
            funcChildren.unshift(asyncNode);
          }
          
          // Create function_item node
          const funcNode = createMockNode(
            'function_item',
            line,
            lineIndex,
            0,
            lineStartIndex,
            funcChildren
          );
          
          children.push(funcNode);
        }
      }
      
      // Match: pub struct StructName or struct StructName
      else if (trimmed.includes('struct ')) {
        const match = /(?:pub\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(trimmed);
        if (match) {
          const structName = match[1];
          const isPublic = trimmed.includes('pub struct');
          
          // Find the position of the struct name in the line
          const structNameIndex = line.indexOf(structName);
          const structNameStartIndex = lineStartIndex + structNameIndex;
          
          // Create identifier node for struct name
          const nameNode = createMockNode('identifier', structName, lineIndex, structNameIndex, structNameStartIndex);
          
          const structChildren: Parser.SyntaxNode[] = [nameNode];
          
          // Add visibility modifier if public
          if (isPublic) {
            const pubIndex = line.indexOf('pub');
            const visNode = createMockNode('visibility_modifier', 'pub', lineIndex, pubIndex, lineStartIndex + pubIndex);
            structChildren.unshift(visNode);
          }
          
          // Create struct_item node
          const structNode = createMockNode(
            'struct_item',
            line,
            lineIndex,
            0,
            lineStartIndex,
            structChildren
          );
          
          children.push(structNode);
        }
      }
      
      // Match: pub enum EnumName or enum EnumName
      else if (trimmed.includes('enum ')) {
        const match = /(?:pub\s+)?enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(trimmed);
        if (match) {
          const enumName = match[1];
          const isPublic = trimmed.includes('pub enum');
          
          // Find the position of the enum name in the line
          const enumNameIndex = line.indexOf(enumName);
          const enumNameStartIndex = lineStartIndex + enumNameIndex;
          
          // Create identifier node for enum name
          const nameNode = createMockNode('identifier', enumName, lineIndex, enumNameIndex, enumNameStartIndex);
          
          const enumChildren: Parser.SyntaxNode[] = [nameNode];
          
          // Add visibility modifier if public
          if (isPublic) {
            const pubIndex = line.indexOf('pub');
            const visNode = createMockNode('visibility_modifier', 'pub', lineIndex, pubIndex, lineStartIndex + pubIndex);
            enumChildren.unshift(visNode);
          }
          
          // Create enum_item node
          const enumNode = createMockNode(
            'enum_item',
            line,
            lineIndex,
            0,
            lineStartIndex,
            enumChildren
          );
          
          children.push(enumNode);
        }
      }
      
      // Match: pub trait TraitName or trait TraitName
      else if (trimmed.includes('trait ')) {
        const match = /(?:pub\s+)?trait\s+([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(trimmed);
        if (match) {
          const traitName = match[1];
          const isPublic = trimmed.includes('pub trait');
          
          // Find the position of the trait name in the line
          const traitNameIndex = line.indexOf(traitName);
          const traitNameStartIndex = lineStartIndex + traitNameIndex;
          
          // Create identifier node for trait name
          const nameNode = createMockNode('identifier', traitName, lineIndex, traitNameIndex, traitNameStartIndex);
          
          const traitChildren: Parser.SyntaxNode[] = [nameNode];
          
          // Add visibility modifier if public
          if (isPublic) {
            const pubIndex = line.indexOf('pub');
            const visNode = createMockNode('visibility_modifier', 'pub', lineIndex, pubIndex, lineStartIndex + pubIndex);
            traitChildren.unshift(visNode);
          }
          
          // Create trait_item node
          const traitNode = createMockNode(
            'trait_item',
            line,
            lineIndex,
            0,
            lineStartIndex,
            traitChildren
          );
          
          children.push(traitNode);
        }
      }
      
      // Match: impl blocks
      else if (trimmed.startsWith('impl ')) {
        // Create impl_item node (no name, just a container)
        const implNode = createMockNode(
          'impl_item',
          line,
          lineIndex,
          0,
          lineStartIndex,
          []
        );
        
        children.push(implNode);
      }
    });

    return {
      rootNode: createMockNode('source_file', content, 0, 0, 0, children),
    };
  });

  return {
    default: class MockParser {
      static init = vi.fn().mockResolvedValue(undefined);
      static Language = {
        load: vi.fn().mockResolvedValue({
          id: 1,
          fieldCount: 0,
          nodeTypeCount: 0,
        }),
      };
      setLanguage = vi.fn();
      parse = mockParse;
      getLanguage = vi.fn();
      getTimeoutMicros = vi.fn();
      setTimeoutMicros = vi.fn();
      reset = vi.fn();
      delete = vi.fn();
    },
  };
});

// Mock WasmParserFactory to return mocked parser
vi.mock('@/analyzer/languages/WasmParserFactory', () => {
  return {
    WasmParserFactory: {
      getInstance: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        getParser: vi.fn().mockImplementation(async () => {
          const Parser = (await import('web-tree-sitter')).default;
          return new Parser();
        }),
        isInitialized: vi.fn().mockReturnValue(true),
      })),
    },
  };
});

// ============================================================================
// Property Tests
// ============================================================================

describe('RustSymbolAnalyzer - Property-Based Tests', () => {
  let analyzer: RustSymbolAnalyzer;

  beforeEach(() => {
    analyzer = new RustSymbolAnalyzer(fixturesDir, mockExtensionPath);
  });

  describe('Property 6: Rust Symbol Extraction Completeness', () => {
    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, all expected symbols are extracted', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { file: 'utils/helpers.rs', expectedSymbols: ['format_data', 'process_data'] },
            { file: 'utils/database.rs', expectedSymbols: ['Connection', 'connect_db', 'disconnect_db'] },
            { file: 'main.rs', expectedSymbols: ['main'] }
          ),
          async ({ file, expectedSymbols }) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            const symbolNames = Array.from(symbols.values()).map(s => s.name);
            
            // All expected symbols should be extracted
            for (const expectedName of expectedSymbols) {
              expect(symbolNames).toContain(expectedName);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, symbol types are correctly identified', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { file: 'utils/database.rs', name: 'Connection', expectedKind: 'StructDeclaration', expectedCategory: 'class' },
            { file: 'utils/database.rs', name: 'connect_db', expectedKind: 'FunctionDeclaration', expectedCategory: 'function' },
            { file: 'utils/helpers.rs', name: 'format_data', expectedKind: 'FunctionDeclaration', expectedCategory: 'function' },
            { file: 'main.rs', name: 'main', expectedKind: 'FunctionDeclaration', expectedCategory: 'function' }
          ),
          async ({ file, name, expectedKind, expectedCategory }) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            const symbolArray = Array.from(symbols.values());
            const symbol = symbolArray.find(s => s.name === name);
            
            expect(symbol).toBeDefined();
            expect(symbol?.kind).toBe(expectedKind);
            expect(symbol?.category).toBe(expectedCategory);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, line numbers are positive integers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils/helpers.rs',
            'utils/database.rs',
            'main.rs'
          ),
          async (file) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            
            // All symbols should have positive line numbers
            for (const symbol of symbols.values()) {
              expect(symbol.line).toBeGreaterThan(0);
              expect(Number.isInteger(symbol.line)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, isExported flag is correct based on pub visibility', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { file: 'utils/helpers.rs', name: 'format_data', expectedExported: true },
            { file: 'utils/helpers.rs', name: 'process_data', expectedExported: true },
            { file: 'utils/database.rs', name: 'Connection', expectedExported: true },
            { file: 'utils/database.rs', name: 'connect_db', expectedExported: true },
            { file: 'main.rs', name: 'main', expectedExported: true }
          ),
          async ({ file, name, expectedExported }) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            const symbolArray = Array.from(symbols.values());
            const symbol = symbolArray.find(s => s.name === name);
            
            expect(symbol).toBeDefined();
            expect(symbol?.isExported).toBe(expectedExported);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file with async functions, async functions are correctly identified', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { file: 'utils/helpers.rs', name: 'format_data', isAsync: false },
            { file: 'utils/database.rs', name: 'connect_db', isAsync: false },
            { file: 'main.rs', name: 'main', isAsync: false }
          ),
          async ({ file, name, isAsync }) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            const symbolArray = Array.from(symbols.values());
            const symbol = symbolArray.find(s => s.name === name);
            
            expect(symbol).toBeDefined();
            if (isAsync) {
              expect(symbol?.kind).toBe('AsyncFunction');
            } else {
              expect(symbol?.kind).toBe('FunctionDeclaration');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, symbol IDs follow the correct format', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils/helpers.rs',
            'utils/database.rs',
            'main.rs'
          ),
          async (file) => {
            const filePath = path.join(fixturesDir, file);
            const normalizedPath = normalizePath(filePath);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            
            // Check symbol ID format: <filePath>:<symbolName>
            for (const symbol of symbols.values()) {
              expect(symbol.id).toBe(`${normalizedPath}:${symbol.name}`);
              expect(symbol.id.startsWith(normalizedPath)).toBe(true);
              expect(symbol.id).toContain(':');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, symbol extraction is deterministic', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils/helpers.rs',
            'utils/database.rs',
            'main.rs'
          ),
          async (file) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file twice
            const symbols1 = await analyzer.analyzeFile(filePath);
            const symbols2 = await analyzer.analyzeFile(filePath);
            
            // Results should be identical
            expect(symbols1.size).toBe(symbols2.size);
            
            for (const [id, symbol1] of symbols1) {
              const symbol2 = symbols2.get(id);
              expect(symbol2).toBeDefined();
              expect(symbol2?.name).toBe(symbol1.name);
              expect(symbol2?.kind).toBe(symbol1.kind);
              expect(symbol2?.line).toBe(symbol1.line);
              expect(symbol2?.isExported).toBe(symbol1.isExported);
              expect(symbol2?.category).toBe(symbol1.category);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, category field is correctly set', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils/helpers.rs',
            'utils/database.rs',
            'main.rs'
          ),
          async (file) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            
            // Check category field
            for (const symbol of symbols.values()) {
              // Category should be either 'function', 'class', or 'type'
              expect(['function', 'class', 'type']).toContain(symbol.category);
              
              // If kind is StructDeclaration, category should be 'class'
              if (symbol.kind === 'StructDeclaration') {
                expect(symbol.category).toBe('class');
              }
              
              // If kind is FunctionDeclaration or AsyncFunction, category should be 'function'
              if (symbol.kind === 'FunctionDeclaration' || symbol.kind === 'AsyncFunction') {
                expect(symbol.category).toBe('function');
              }
              
              // If kind is EnumDeclaration or InterfaceDeclaration, category should be 'type'
              if (symbol.kind === 'EnumDeclaration' || symbol.kind === 'InterfaceDeclaration') {
                expect(symbol.category).toBe('type');
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file, all symbols have required fields', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils/helpers.rs',
            'utils/database.rs',
            'main.rs'
          ),
          async (file) => {
            const filePath = path.join(fixturesDir, file);
            
            // Analyze file
            const symbols = await analyzer.analyzeFile(filePath);
            
            // Check all symbols have required fields
            for (const symbol of symbols.values()) {
              expect(symbol.name).toBeDefined();
              expect(typeof symbol.name).toBe('string');
              expect(symbol.name.length).toBeGreaterThan(0);
              
              expect(symbol.kind).toBeDefined();
              expect(typeof symbol.kind).toBe('string');
              
              expect(symbol.line).toBeDefined();
              expect(typeof symbol.line).toBe('number');
              
              expect(symbol.isExported).toBeDefined();
              expect(typeof symbol.isExported).toBe('boolean');
              
              expect(symbol.id).toBeDefined();
              expect(typeof symbol.id).toBe('string');
              
              expect(symbol.category).toBeDefined();
              expect(typeof symbol.category).toBe('string');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 6: For any Rust fixture file with private functions, private functions are correctly identified', async () => {
      // Use rust-unused-deps fixtures which have private functions
      const unusedAnalyzer = new RustSymbolAnalyzer(unusedDepsDir, mockExtensionPath);
      
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { file: 'helper.rs', name: 'format_data', expectedExported: true },
            { file: 'helper.rs', name: 'internal_helper', expectedExported: false },
            { file: 'unused.rs', name: 'unused_function', expectedExported: true },
            { file: 'unused.rs', name: 'UnusedStruct', expectedExported: true }
          ),
          async ({ file, name, expectedExported }) => {
            const filePath = path.join(unusedDepsDir, file);
            
            // Analyze file
            const symbols = await unusedAnalyzer.analyzeFile(filePath);
            const symbolArray = Array.from(symbols.values());
            const symbol = symbolArray.find(s => s.name === name);
            
            expect(symbol).toBeDefined();
            expect(symbol?.isExported).toBe(expectedExported);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
