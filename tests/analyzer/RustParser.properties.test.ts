import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';
import path from 'node:path';
import { RustParser } from '../../src/analyzer/languages/RustParser';
import { normalizePath } from '../../src/shared/path';
import fs from 'node:fs/promises';
import type Parser from 'web-tree-sitter';

/**
 * Property-Based Tests for RustParser WASM Migration
 * 
 * These tests validate universal properties that should hold across all valid inputs.
 * Each test runs 100 iterations with randomly generated data.
 * 
 * Note: These tests use mocked web-tree-sitter to avoid requiring WASM files during testing.
 * The mocks simulate the tree-sitter AST structure for Rust import statements.
 */

// Mock extension path for testing
const mockExtensionPath = path.resolve(process.cwd());
const fixturesDir = path.resolve(__dirname, '../fixtures/rust-integration');

// Mock tree-sitter to simulate parsing without requiring WASM files
vi.mock('web-tree-sitter', () => {
  const createMockNode = (type: string, text: string, startRow: number): Parser.SyntaxNode => ({
    type,
    startPosition: { row: startRow, column: 0 },
    endPosition: { row: startRow, column: text.length },
    startIndex: 0,
    endIndex: text.length,
    text,
    children: [],
    childCount: 0,
    namedChildCount: 0,
    firstChild: null,
    firstNamedChild: null,
    lastChild: null,
    lastNamedChild: null,
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
    childForFieldName: () => null,
    childForFieldId: () => null,
    fieldNameForChild: () => null,
    fieldNameForNamedChild: () => null,
    child: () => null,
    namedChild: () => null,
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
    
    // Calculate absolute byte positions for each line
    let currentPosition = 0;
    const linePositions: number[] = [];
    
    for (const line of lines) {
      linePositions.push(currentPosition);
      currentPosition += line.length + 1; // +1 for newline character
    }

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('//')) {
        return;
      }
      
      const lineStartPos = linePositions[lineIndex];
      
      // Match: use path::to::module;
      if (trimmed.startsWith('use ')) {
        const match = /^use\s+([a-z_][a-z0-9_]*(?:::[a-z_][a-z0-9_]*)*)/i.exec(trimmed);
        if (match) {
          const modulePath = match[1];
          
          // Find the position of the module path in the line
          const moduleStartInLine = line.indexOf(modulePath);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + modulePath.length;
          
          // Create scoped_identifier node
          const scopedIdentifierNode = createMockNode('scoped_identifier', modulePath, lineIndex);
          (scopedIdentifierNode as any).startIndex = moduleStartPos;
          (scopedIdentifierNode as any).endIndex = moduleEndPos;
          
          const useNode = createMockNode('use_declaration', line, lineIndex);
          (useNode as any).startIndex = lineStartPos;
          (useNode as any).endIndex = lineStartPos + line.length;
          (useNode as any).children = [scopedIdentifierNode];
          children.push(useNode);
        }
      }
      
      // Match: mod module_name;
      else if (trimmed.startsWith('mod ') && trimmed.includes(';')) {
        const match = /^mod\s+([a-z_][a-z0-9_]*)/i.exec(trimmed);
        if (match) {
          const moduleName = match[1];
          
          // Find the position of the module name in the line
          const moduleStartInLine = line.indexOf(moduleName);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + moduleName.length;
          
          // Create identifier node
          const identifierNode = createMockNode('identifier', moduleName, lineIndex);
          (identifierNode as any).startIndex = moduleStartPos;
          (identifierNode as any).endIndex = moduleEndPos;
          
          const modNode = createMockNode('mod_item', line, lineIndex);
          (modNode as any).startIndex = lineStartPos;
          (modNode as any).endIndex = lineStartPos + line.length;
          (modNode as any).children = [identifierNode];
          children.push(modNode);
        }
      }
      
      // Match: extern crate crate_name;
      else if (trimmed.startsWith('extern crate ')) {
        const match = /^extern\s+crate\s+([a-z_][a-z0-9_]*)/i.exec(trimmed);
        if (match) {
          const crateName = match[1];
          
          // Find the position of the crate name in the line
          const crateStartInLine = line.indexOf(crateName);
          const crateStartPos = lineStartPos + crateStartInLine;
          const crateEndPos = crateStartPos + crateName.length;
          
          // Create identifier node
          const identifierNode = createMockNode('identifier', crateName, lineIndex);
          (identifierNode as any).startIndex = crateStartPos;
          (identifierNode as any).endIndex = crateEndPos;
          
          const externNode = createMockNode('extern_crate_declaration', line, lineIndex);
          (externNode as any).startIndex = lineStartPos;
          (externNode as any).endIndex = lineStartPos + line.length;
          (externNode as any).children = [identifierNode];
          children.push(externNode);
        }
      }
    });

    const rootNode = createMockNode('source_file', content, 0);
    (rootNode as any).startIndex = 0;
    (rootNode as any).endIndex = content.length;
    (rootNode as any).children = children;

    return {
      rootNode,
      edit: vi.fn(),
      walk: vi.fn(),
      getChangedRanges: vi.fn(),
      getEditedRange: vi.fn(),
      printDotGraph: vi.fn(),
      delete: vi.fn(),
    };
  });

  class MockParser {
    static init = vi.fn().mockResolvedValue(undefined);
    static Language = {
      load: vi.fn().mockResolvedValue({}),
    };
    setLanguage = vi.fn();
    parse = mockParse;
    getLanguage = vi.fn();
    getTimeoutMicros = vi.fn();
    setTimeoutMicros = vi.fn();
    reset = vi.fn();
    getIncludedRanges = vi.fn();
    setIncludedRanges = vi.fn();
    getLogger = vi.fn();
    setLogger = vi.fn();
    delete = vi.fn();
    printDotGraphs = vi.fn();
  }

  return {
    Parser: MockParser,
    Language: MockParser.Language,
    default: MockParser,
  };
});

describe('RustParser Property-Based Tests', () => {
  let parser: RustParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new RustParser(fixturesDir, mockExtensionPath);
  });

  describe('Property 4: Rust Import Extraction Completeness', () => {
    /**
     * Property 4: Rust import extraction completeness
     * 
     * For any valid Rust file containing import declarations (use, mod, extern crate), 
     * parsing the file should extract all local module references while filtering out 
     * external crates (std, serde, etc.).
     * 
     * **Validates: Requirements 3.1, 3.2**
     */

    // List of known external crates that should be filtered out
    const externalCrates = [
      'std', 'core', 'alloc', 'proc_macro', 'test',
      'serde', 'tokio', 'async_std', 'futures',
      'vm', 'rustpython_vm', 'rustpython',
      'rustpython_parser', 'rustpython_compiler',
      'num_traits', 'enum_dispatch', 'dashmap',
    ];

    // Arbitrary for generating Rust import types
    const rustImportTypeArbitrary = () =>
      fc.constantFrom(
        'use',           // use path::to::module;
        'mod',           // mod module_name;
        'extern_crate'   // extern crate crate_name;
      );

    // Arbitrary for generating valid Rust module names (lowercase with underscores)
    const rustModuleNameArbitrary = () =>
      fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

    // Arbitrary for generating Rust module paths (e.g., utils::helpers)
    const rustModulePathArbitrary = () =>
      fc.array(rustModuleNameArbitrary(), { minLength: 1, maxLength: 3 })
        .map(parts => parts.join('::'));

    // Arbitrary for generating external crate names
    const externalCrateArbitrary = () =>
      fc.constantFrom(...externalCrates);

    // Arbitrary for generating Rust import statements
    const rustImportStatementArbitrary = () =>
      fc.record({
        type: rustImportTypeArbitrary(),
        module: fc.oneof(
          rustModulePathArbitrary(),
          externalCrateArbitrary()
        ),
        isExternal: fc.boolean(),
      }).map((data) => {
        // If marked as external, use an external crate name
        if (data.isExternal) {
          return {
            ...data,
            module: externalCrates[Math.floor(Math.random() * externalCrates.length)],
          };
        }
        return data;
      });

    // Generate a Rust file with known imports
    const rustFileWithImportsArbitrary = () =>
      fc.record({
        imports: fc.array(rustImportStatementArbitrary(), { minLength: 1, maxLength: 10 }),
      }).map((data) => {
        const lines: string[] = ['// Test Rust file'];
        const localImports: Array<{ module: string; line: number }> = [];
        const externalImports: string[] = [];
        const seenModules = new Set<string>(); // Track seen modules for deduplication

        data.imports.forEach((imp) => {
          let importLine = '';
          const firstComponent = imp.module.split('::')[0];
          const isExternal = externalCrates.includes(firstComponent);

          if (imp.type === 'use') {
            importLine = `use ${imp.module};`;
            
            // use declarations: external crates are filtered
            if (isExternal) {
              externalImports.push(firstComponent);
            } else {
              const normalizedModule = imp.module.toLowerCase();
              
              if (!seenModules.has(normalizedModule)) {
                seenModules.add(normalizedModule);
                localImports.push({
                  module: normalizedModule,
                  line: lines.length + 1,
                });
              }
            }
          } else if (imp.type === 'mod') {
            // mod declarations: NOT filtered (even if they match external crate names)
            // This is because mod std; could theoretically be a local file std.rs
            importLine = `mod ${firstComponent};`;
            
            const normalizedModule = firstComponent.toLowerCase();
            
            if (!seenModules.has(normalizedModule)) {
              seenModules.add(normalizedModule);
              localImports.push({
                module: normalizedModule,
                line: lines.length + 1,
              });
            }
            
            // Track as external for test purposes (to verify use filtering)
            if (isExternal) {
              externalImports.push(firstComponent);
            }
          } else if (imp.type === 'extern_crate') {
            // extern crate declarations: external crates are filtered
            importLine = `extern crate ${firstComponent};`;
            
            if (isExternal) {
              externalImports.push(firstComponent);
            } else {
              // Non-external extern crate (rare, but possible for local crates)
              const normalizedModule = firstComponent.toLowerCase();
              
              if (!seenModules.has(normalizedModule)) {
                seenModules.add(normalizedModule);
                localImports.push({
                  module: normalizedModule,
                  line: lines.length + 1,
                });
              }
            }
          }

          lines.push(importLine);
        });

        return {
          content: lines.join('\n'),
          localImports,
          externalImports,
        };
      });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file with import statements, all local imports are extracted', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustFileWithImportsArbitrary(),
          async (rustFile) => {
            // Create a temporary test file
            const tempFilePath = path.join(fixturesDir, `temp_test_${Date.now()}.rs`);
            
            try {
              await fs.writeFile(tempFilePath, rustFile.content);

              // Parse imports
              const deps = await parser.parseImports(tempFilePath);

              // Verify all expected local imports are extracted
              for (const expectedImport of rustFile.localImports) {
                const found = deps.find(
                  (d) => d.module === expectedImport.module && d.line === expectedImport.line
                );
                expect(found).toBeDefined();
              }

              // Verify no duplicate imports
              const modules = deps.map((d) => d.module);
              const uniqueModules = [...new Set(modules)];
              expect(modules.length).toBe(uniqueModules.length);

              // Verify all imports have valid line numbers
              expect(deps.every((d) => d.line > 0)).toBe(true);
            } finally {
              // Clean up temp file
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file, external crates in use and extern crate are filtered out', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustFileWithImportsArbitrary(),
          async (rustFile) => {
            const tempFilePath = path.join(fixturesDir, `temp_external_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, rustFile.content);
              const deps = await parser.parseImports(tempFilePath);

              // Parse the content to check each line
              const lines = rustFile.content.split('\n');
              
              // Check each dependency to ensure it's not an external crate from use/extern crate
              for (const dep of deps) {
                const depLine = lines[dep.line - 1];
                
                if (depLine && (depLine.trim().startsWith('use ') || depLine.trim().startsWith('extern crate '))) {
                  // This dependency came from a use or extern crate declaration
                  // Verify it's not an external crate
                  const firstComponent = dep.module.split('::')[0];
                  expect(externalCrates).not.toContain(firstComponent);
                }
              }

              // Verify no external crate names appear in scoped use paths (with ::)
              for (const dep of deps) {
                if (dep.module.includes('::')) {
                  const firstComponent = dep.module.split('::')[0];
                  expect(externalCrates).not.toContain(firstComponent);
                }
              }
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file, module names are normalized to lowercase', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.stringMatching(/^[A-Z][a-zA-Z0-9_]{0,15}$/), // PascalCase module names
            { minLength: 1, maxLength: 5 }
          ),
          async (moduleNames) => {
            const lines: string[] = ['// Test case sensitivity'];
            
            // Create use declarations with PascalCase names
            for (const moduleName of moduleNames) {
              lines.push(`use ${moduleName};`);
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_case_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all module names are lowercase
              for (const dep of deps) {
                expect(dep.module).toBe(dep.module.toLowerCase());
              }

              // Verify we extracted the expected modules (in lowercase)
              const expectedModules = [...new Set(moduleNames.map(m => m.toLowerCase()))];
              expect(deps.length).toBe(expectedModules.length);
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file with use declarations, scoped paths are extracted correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(rustModulePathArbitrary(), { minLength: 1, maxLength: 5 }),
          async (modulePaths) => {
            const lines: string[] = ['// Test scoped paths'];
            const expectedModules: string[] = [];
            const seenModules = new Set<string>();

            // Create use declarations with scoped paths
            for (const modulePath of modulePaths) {
              const firstComponent = modulePath.split('::')[0];
              
              // Skip if it's an external crate
              if (externalCrates.includes(firstComponent)) {
                continue;
              }

              lines.push(`use ${modulePath};`);
              
              const normalizedPath = modulePath.toLowerCase();
              if (!seenModules.has(normalizedPath)) {
                seenModules.add(normalizedPath);
                expectedModules.push(normalizedPath);
              }
            }

            if (expectedModules.length === 0) {
              // Skip if all modules were external
              return;
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_scoped_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all expected modules are extracted
              for (const expectedModule of expectedModules) {
                const found = deps.find((d) => d.module === expectedModule);
                expect(found).toBeDefined();
              }

              // Verify scoped paths contain "::"
              for (const dep of deps) {
                if (dep.module.includes('::')) {
                  expect(dep.module.split('::').length).toBeGreaterThan(1);
                }
              }
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file with mod declarations, module names are extracted', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(rustModuleNameArbitrary(), { minLength: 1, maxLength: 5 }),
          async (moduleNames) => {
            const lines: string[] = ['// Test mod declarations'];
            const expectedModules: string[] = [];
            const seenModules = new Set<string>();

            // Create mod declarations
            for (const moduleName of moduleNames) {
              // Skip if it's an external crate
              if (externalCrates.includes(moduleName)) {
                continue;
              }

              lines.push(`mod ${moduleName};`);
              
              const normalizedName = moduleName.toLowerCase();
              if (!seenModules.has(normalizedName)) {
                seenModules.add(normalizedName);
                expectedModules.push(normalizedName);
              }
            }

            if (expectedModules.length === 0) {
              // Skip if all modules were external
              return;
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_mod_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all expected modules are extracted
              for (const expectedModule of expectedModules) {
                const found = deps.find((d) => d.module === expectedModule);
                expect(found).toBeDefined();
              }

              // Verify we extracted the right number of modules
              expect(deps.length).toBe(expectedModules.length);
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file with extern crate declarations, external crates are filtered', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(externalCrateArbitrary(), { minLength: 1, maxLength: 5 }),
          async (crateNames) => {
            const lines: string[] = ['// Test extern crate filtering'];

            // Create extern crate declarations
            for (const crateName of crateNames) {
              lines.push(`extern crate ${crateName};`);
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_extern_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify NO external crates are extracted
              expect(deps.length).toBe(0);

              // Verify none of the external crate names appear
              for (const crateName of crateNames) {
                const found = deps.find((d) => d.module === crateName.toLowerCase());
                expect(found).toBeUndefined();
              }
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file with mixed import types, all local imports are extracted and external filtered', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            localModules: fc.array(rustModuleNameArbitrary(), { minLength: 1, maxLength: 3 }),
            externalCrates: fc.array(externalCrateArbitrary(), { minLength: 1, maxLength: 3 }),
          }),
          async ({ localModules, externalCrates: externalCratesList }) => {
            const lines: string[] = ['// Test mixed imports'];
            const expectedModules: string[] = [];
            const seenModules = new Set<string>();

            // Add local use declarations
            for (const localModule of localModules) {
              lines.push(`use ${localModule};`);
              const normalizedModule = localModule.toLowerCase();
              if (!seenModules.has(normalizedModule)) {
                seenModules.add(normalizedModule);
                expectedModules.push(normalizedModule);
              }
            }

            // Add external use declarations (should be filtered)
            for (const externalCrate of externalCratesList) {
              lines.push(`use ${externalCrate}::SomeType;`);
            }

            // Add local mod declarations
            for (const localModule of localModules) {
              lines.push(`mod ${localModule};`);
              // Note: mod declarations might duplicate use declarations
              // Parser deduplicates, so we don't add again
            }

            // Add external extern crate declarations (should be filtered)
            for (const externalCrate of externalCratesList) {
              lines.push(`extern crate ${externalCrate};`);
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_mixed_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all local modules are extracted
              for (const expectedModule of expectedModules) {
                const found = deps.find((d) => d.module === expectedModule);
                expect(found).toBeDefined();
              }

              // Verify NO external crates are extracted
              for (const externalCrate of externalCratesList) {
                const found = deps.find((d) => 
                  d.module === externalCrate.toLowerCase() ||
                  d.module.startsWith(`${externalCrate.toLowerCase()}::`)
                );
                expect(found).toBeUndefined();
              }

              // Verify only local modules are in results
              expect(deps.length).toBe(expectedModules.length);
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file, import line numbers are accurate', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(rustModuleNameArbitrary(), { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 10 }), // Number of blank lines before imports
          async (moduleNames, blankLinesBefore) => {
            const lines: string[] = ['// Test line numbers'];
            
            // Add blank lines
            for (let i = 0; i < blankLinesBefore; i++) {
              lines.push('');
            }

            const expectedLineNumbers: number[] = [];
            const seenModules = new Set<string>();

            // Add use declarations
            for (const moduleName of moduleNames) {
              // Skip external crates
              if (externalCrates.includes(moduleName)) {
                continue;
              }

              lines.push(`use ${moduleName};`);
              
              const normalizedModule = moduleName.toLowerCase();
              if (!seenModules.has(normalizedModule)) {
                seenModules.add(normalizedModule);
                expectedLineNumbers.push(lines.length);
              }
            }

            if (expectedLineNumbers.length === 0) {
              // Skip if all modules were external
              return;
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_line_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify line numbers match expected positions
              const actualLineNumbers = deps.map((d) => d.line).sort((a, b) => a - b);
              const sortedExpectedLines = expectedLineNumbers.sort((a, b) => a - b);

              expect(actualLineNumbers).toEqual(sortedExpectedLines);
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 4: For any Rust file, import type field is always "import"', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustFileWithImportsArbitrary(),
          async (rustFile) => {
            const tempFilePath = path.join(fixturesDir, `temp_type_${Date.now()}.rs`);

            try {
              await fs.writeFile(tempFilePath, rustFile.content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all dependencies have type "import"
              expect(deps.every((d) => d.type === 'import')).toBe(true);
            } finally {
              try {
                await fs.unlink(tempFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 5: Rust Module Resolution Correctness', () => {
    /**
     * Property 5: Rust module resolution correctness
     * 
     * For any Rust file and valid local module specifier, resolving the module path 
     * should correctly handle mod.rs and lib.rs patterns, and return null for external 
     * crates or unresolvable modules.
     * 
     * **Validates: Requirements 3.3**
     */

    // Arbitrary for generating valid Rust module names (lowercase with underscores)
    const rustModuleNameArbitrary = () =>
      fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

    // Arbitrary for generating Rust module paths (e.g., utils::helpers)
    const rustModulePathArbitrary = () =>
      fc.array(rustModuleNameArbitrary(), { minLength: 1, maxLength: 3 })
        .map(parts => parts.join('::'));

    // List of known external crates that should return null
    const externalCrates = [
      'std', 'core', 'alloc', 'proc_macro', 'test',
      'serde', 'tokio', 'async_std', 'futures',
      'vm', 'rustpython_vm', 'rustpython',
      'rustpython_parser', 'rustpython_compiler',
      'num_traits', 'enum_dispatch', 'dashmap',
    ];

    // Arbitrary for generating external crate names
    const externalCrateArbitrary = () =>
      fc.constantFrom(...externalCrates);

    it('Feature: tree-sitter-wasm-migration, Property 5: For any valid module specifier, resolvePath returns a valid path or null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            rustModuleNameArbitrary(),
            rustModulePathArbitrary(),
            externalCrateArbitrary()
          ),
          async (moduleSpecifier) => {
            // Use a test file from fixtures
            const fromFile = path.join(fixturesDir, 'main.rs');

            // Resolve the module path
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Result should be either a string (valid path) or null (not found/external)
            expect(resolvedPath === null || typeof resolvedPath === 'string').toBe(true);

            // If resolved, the path should be normalized (forward slashes)
            if (resolvedPath !== null) {
              expect(resolvedPath).toBeDefined();
              expect(typeof resolvedPath).toBe('string');
              
              // Path should not contain backslashes (normalized)
              if (process.platform !== 'win32') {
                expect(resolvedPath.includes('\\')).toBe(false);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any external crate, resolvePath returns null', async () => {
      await fc.assert(
        fc.asyncProperty(
          externalCrateArbitrary(),
          async (externalCrate) => {
            const fromFile = path.join(fixturesDir, 'main.rs');
            const resolvedPath = await parser.resolvePath(fromFile, externalCrate);

            // External crates should always return null
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any external crate with scoped path, resolvePath returns null', async () => {
      await fc.assert(
        fc.asyncProperty(
          externalCrateArbitrary(),
          rustModuleNameArbitrary(),
          async (externalCrate, subModule) => {
            const fromFile = path.join(fixturesDir, 'main.rs');
            const scopedPath = `${externalCrate}::${subModule}`;
            const resolvedPath = await parser.resolvePath(fromFile, scopedPath);

            // External crates with scoped paths should return null
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any non-existent local module, resolvePath returns null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^nonexistent[a-z0-9_]{5,15}$/),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.rs');
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Non-existent modules should return null
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any module with uppercase letters, resolvePath returns null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[A-Z][a-zA-Z0-9_]{0,15}$/), // PascalCase module names
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.rs');
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Uppercase module names are likely types/symbols, not files
            // Rust file names are always lowercase (snake_case)
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any local module, resolution handles mod.rs pattern', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          async (moduleName) => {
            // Create a temporary module directory with mod.rs
            const moduleDir = path.join(fixturesDir, moduleName);
            const modRsPath = path.join(moduleDir, 'mod.rs');
            
            try {
              // Create directory and mod.rs file
              await fs.mkdir(moduleDir, { recursive: true });
              await fs.writeFile(modRsPath, '// Test module');

              const fromFile = path.join(fixturesDir, 'main.rs');
              const resolvedPath = await parser.resolvePath(fromFile, moduleName);

              // Should resolve to the mod.rs file
              expect(resolvedPath).not.toBeNull();
              if (resolvedPath) {
                const normalizedPath = normalizePath(resolvedPath);
                expect(normalizedPath.endsWith(`${moduleName}/mod.rs`)).toBe(true);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(modRsPath);
                await fs.rmdir(moduleDir);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any local module, resolution handles direct .rs file', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          async (moduleName) => {
            // Create a temporary .rs file
            const moduleFilePath = path.join(fixturesDir, `${moduleName}.rs`);
            
            try {
              await fs.writeFile(moduleFilePath, '// Test module');

              const fromFile = path.join(fixturesDir, 'main.rs');
              const resolvedPath = await parser.resolvePath(fromFile, moduleName);

              // Should resolve to the .rs file
              expect(resolvedPath).not.toBeNull();
              if (resolvedPath) {
                const normalizedPath = normalizePath(resolvedPath);
                expect(normalizedPath.endsWith(`${moduleName}.rs`)).toBe(true);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(moduleFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any local module, .rs file takes precedence over mod.rs', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          async (moduleName) => {
            // Create both .rs file and mod.rs directory
            const moduleFilePath = path.join(fixturesDir, `${moduleName}.rs`);
            const moduleDir = path.join(fixturesDir, moduleName);
            const modRsPath = path.join(moduleDir, 'mod.rs');
            
            try {
              // Create both patterns
              await fs.writeFile(moduleFilePath, '// Direct file');
              await fs.mkdir(moduleDir, { recursive: true });
              await fs.writeFile(modRsPath, '// Module directory');

              const fromFile = path.join(fixturesDir, 'main.rs');
              const resolvedPath = await parser.resolvePath(fromFile, moduleName);

              // Should resolve to the .rs file (takes precedence)
              expect(resolvedPath).not.toBeNull();
              if (resolvedPath) {
                const normalizedPath = normalizePath(resolvedPath);
                expect(normalizedPath.endsWith(`${moduleName}.rs`)).toBe(true);
                expect(normalizedPath.endsWith('mod.rs')).toBe(false);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(moduleFilePath);
                await fs.unlink(modRsPath);
                await fs.rmdir(moduleDir);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any scoped local module path, resolution handles nested modules', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          rustModuleNameArbitrary(),
          async (parentModule, childModule) => {
            // Create nested module structure: parent/child.rs
            const parentDir = path.join(fixturesDir, parentModule);
            const childFilePath = path.join(parentDir, `${childModule}.rs`);
            
            try {
              await fs.mkdir(parentDir, { recursive: true });
              await fs.writeFile(childFilePath, '// Child module');

              const fromFile = path.join(fixturesDir, 'main.rs');
              const scopedPath = `${parentModule}::${childModule}`;
              const resolvedPath = await parser.resolvePath(fromFile, scopedPath);

              // Should resolve to the nested module file
              expect(resolvedPath).not.toBeNull();
              if (resolvedPath) {
                const normalizedPath = normalizePath(resolvedPath);
                expect(normalizedPath.includes(`${parentModule}/${childModule}.rs`)).toBe(true);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(childFilePath);
                await fs.rmdir(parentDir);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any module specifier, resolution is idempotent', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            rustModuleNameArbitrary(),
            externalCrateArbitrary()
          ),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.rs');

            // Resolve the same module multiple times
            const result1 = await parser.resolvePath(fromFile, moduleSpecifier);
            const result2 = await parser.resolvePath(fromFile, moduleSpecifier);
            const result3 = await parser.resolvePath(fromFile, moduleSpecifier);

            // All results should be identical
            expect(result1).toEqual(result2);
            expect(result2).toEqual(result3);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any module specifier, resolution handles errors gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(''),                    // Empty string
            fc.constant('::'),                  // Just separator
            fc.constant(':::module'),           // Triple colon
            fc.stringMatching(/^[0-9]/),       // Starts with number (invalid)
            fc.constant('/absolute/path'),      // Absolute file path (invalid)
            fc.constant('nonexistent_module_xyz123')  // Non-existent module
          ),
          async (invalidSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.rs');

            // Should not throw, should return null for invalid/non-existent specifiers
            const resolvedPath = await parser.resolvePath(fromFile, invalidSpecifier);
            
            // Invalid/non-existent specifiers should return null (not throw)
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any source file with symbol ID, resolution extracts file path correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          fc.stringMatching(/^[a-z][a-z0-9_]*$/), // Symbol name
          async (moduleSpecifier, symbolName) => {
            const fromFile = path.join(fixturesDir, 'main.rs');
            const fromFileWithSymbol = `${fromFile}#${symbolName}`;

            // Resolution should work with symbol IDs (extracts file path)
            const resolvedPath = await parser.resolvePath(fromFileWithSymbol, moduleSpecifier);

            // Should resolve the same as without symbol ID
            const resolvedPathWithoutSymbol = await parser.resolvePath(fromFile, moduleSpecifier);
            expect(resolvedPath).toEqual(resolvedPathWithoutSymbol);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any module specifier with :: separator, resolution converts to path separators', async () => {
      await fc.assert(
        fc.asyncProperty(
          rustModuleNameArbitrary(),
          rustModuleNameArbitrary(),
          async (parentModule, childModule) => {
            // Create nested module structure
            const parentDir = path.join(fixturesDir, parentModule);
            const childFilePath = path.join(parentDir, `${childModule}.rs`);
            
            try {
              await fs.mkdir(parentDir, { recursive: true });
              await fs.writeFile(childFilePath, '// Child module');

              const fromFile = path.join(fixturesDir, 'main.rs');
              const scopedPath = `${parentModule}::${childModule}`;
              const resolvedPath = await parser.resolvePath(fromFile, scopedPath);

              // Should resolve successfully
              expect(resolvedPath).not.toBeNull();
              
              if (resolvedPath) {
                // Normalized path should contain the expected path structure
                const normalizedPath = normalizePath(resolvedPath);
                const expectedPathPart = `${parentModule}/${childModule}`;
                expect(normalizedPath.includes(expectedPathPart)).toBe(true);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(childFilePath);
                await fs.rmdir(parentDir);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 5: For any module specifier, module names are normalized to lowercase', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/),
          async (moduleName) => {
            // Create a lowercase module file
            const moduleFilePath = path.join(fixturesDir, `${moduleName}.rs`);
            
            try {
              await fs.writeFile(moduleFilePath, '// Test module');

              const fromFile = path.join(fixturesDir, 'main.rs');
              
              // Try resolving with the lowercase name
              const resolvedPath = await parser.resolvePath(fromFile, moduleName);

              // Should resolve successfully
              expect(resolvedPath).not.toBeNull();
              
              if (resolvedPath) {
                const normalizedPath = normalizePath(resolvedPath);
                // Path should contain the lowercase module name
                expect(normalizedPath.toLowerCase().includes(moduleName.toLowerCase())).toBe(true);
              }
            } finally {
              // Clean up
              try {
                await fs.unlink(moduleFilePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
