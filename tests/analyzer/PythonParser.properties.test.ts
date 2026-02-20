import fc from 'fast-check';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Parser from 'web-tree-sitter';
import { PythonParser } from '../../src/analyzer/languages/PythonParser';
import { normalizePath } from '../../src/shared/path';

/**
 * Property-Based Tests for PythonParser WASM Migration
 * 
 * These tests validate universal properties that should hold across all valid inputs.
 * Each test runs 100 iterations with randomly generated data.
 * 
 * Note: These tests use mocked web-tree-sitter to avoid requiring WASM files during testing.
 * The mocks simulate the tree-sitter AST structure for Python import statements.
 */

// Mock extension path for testing
const mockExtensionPath = path.resolve(process.cwd());
const fixturesDir = path.resolve(__dirname, '../fixtures/python-project');

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
    namedChildren: [],
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
    id: 0,
    tree: null as any,
    isNamed: () => true,
    isMissing: () => false,
    hasChanges: () => false,
    hasError: () => false,
    childForFieldName: () => null,
    childForFieldId: () => null,
    child: () => null,
    namedChild: () => null,
    descendantForIndex: () => null as any,
    namedDescendantForIndex: () => null as any,
    descendantForPosition: () => null as any,
    namedDescendantForPosition: () => null as any,
    descendantsOfType: () => [],
    walk: () => null as any,
    equals: () => false,
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
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }
      
      const lineStartPos = linePositions[lineIndex];
      
      // Match: import module (with optional "as alias")
      if (trimmed.startsWith('import ') && !trimmed.includes(' from ')) {
        const match = /^import\s+([a-z][a-z0-9_.]*)/i.exec(trimmed);
        if (match) {
          const moduleName = match[1].split(' as ')[0].trim();
          
          // Find the position of the module name in the line
          const moduleStartInLine = line.indexOf(moduleName);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + moduleName.length;
          
          // Create node with correct absolute positions
          const dottedNameNode = createMockNode('dotted_name', moduleName, lineIndex);
          (dottedNameNode as any).startIndex = moduleStartPos;
          (dottedNameNode as any).endIndex = moduleEndPos;
          
          const importNode = createMockNode('import_statement', line, lineIndex);
          (importNode as any).startIndex = lineStartPos;
          (importNode as any).endIndex = lineStartPos + line.length;
          (importNode as any).children = [dottedNameNode];
          children.push(importNode);
        }
      }
      
      // Match: from module import name (including relative imports)
      else if (trimmed.startsWith('from ') && trimmed.includes(' import ')) {
        const match = /^from\s+(\.{0,2}[a-z][a-z0-9_.]*|\.\.|\.)\s+import/i.exec(trimmed);
        if (match) {
          const moduleName = match[1];
          
          // Find the position of the module name in the line
          const moduleStartInLine = line.indexOf(moduleName);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + moduleName.length;
          
          let childNode: Parser.SyntaxNode;
          
          if (moduleName.startsWith('.')) {
            childNode = createMockNode('relative_import', moduleName, lineIndex);
          } else {
            childNode = createMockNode('dotted_name', moduleName, lineIndex);
          }
          
          // Set correct absolute positions
          (childNode as any).startIndex = moduleStartPos;
          (childNode as any).endIndex = moduleEndPos;
          
          const importNode = createMockNode('import_from_statement', line, lineIndex);
          (importNode as any).startIndex = lineStartPos;
          (importNode as any).endIndex = lineStartPos + line.length;
          (importNode as any).children = [childNode];
          children.push(importNode);
        }
      }
    });

    const rootNode = createMockNode('module', content, 0);
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
    static readonly init = vi.fn().mockResolvedValue(undefined);
    static readonly Language = {
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

describe('PythonParser Property-Based Tests', () => {
  let parser: PythonParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new PythonParser(fixturesDir, mockExtensionPath);
  });

  describe('Property 1: Python Import Extraction Completeness', () => {
    /**
     * Property 1: Python import extraction completeness
     * 
     * For any valid Python file containing import statements (including `import x`, 
     * `from y import z`, and relative imports with `.` or `..`), parsing the file 
     * should extract all import statements with correct line numbers and module names.
     * 
     * Validates: Requirements 2.1, 2.2
     */

    // Arbitrary for generating Python import types
    const pythonImportTypeArbitrary = () =>
      fc.constantFrom(
        'absolute',      // import module or from module import name
        'relative-dot',  // from . import name or from .module import name
        'relative-dots'  // from .. import name or from ..module import name
      );

    // Arbitrary for generating valid Python module names
    const pythonModuleNameArbitrary = () =>
      fc.stringMatching(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,2}$/);

    // Arbitrary for generating Python import statements
    const pythonImportStatementArbitrary = () =>
      fc.record({
        type: pythonImportTypeArbitrary(),
        module: pythonModuleNameArbitrary(),
        importStyle: fc.constantFrom('import', 'from-import'),
      });

    // Generate a Python file with known imports
    const pythonFileWithImportsArbitrary = () =>
      fc.record({
        imports: fc.array(pythonImportStatementArbitrary(), { minLength: 1, maxLength: 10 }),
      }).map((data) => {
        const lines: string[] = ['# Test Python file'];
        const expectedImports: Array<{ module: string; line: number }> = [];
        const seenModules = new Set<string>(); // Track seen modules for deduplication

        data.imports.forEach((imp) => {
          let importLine = '';
          let expectedModule = '';

          if (imp.type === 'absolute') {
            if (imp.importStyle === 'import') {
              importLine = `import ${imp.module}`;
              expectedModule = imp.module;
            } else {
              importLine = `from ${imp.module} import something`;
              expectedModule = imp.module;
            }
          } else if (imp.type === 'relative-dot') {
            if (imp.importStyle === 'import') {
              importLine = `from .${imp.module} import something`;
              expectedModule = `.${imp.module}`;
            } else {
              importLine = `from . import ${imp.module}`;
              expectedModule = '.';
            }
          } else if (imp.type === 'relative-dots') {
            if (imp.importStyle === 'import') {
              importLine = `from ..${imp.module} import something`;
              expectedModule = `..${imp.module}`;
            } else {
              importLine = `from .. import ${imp.module}`;
              expectedModule = '..';
            }
          }

          lines.push(importLine);
          
          // Only add to expected if not seen before (parser deduplicates)
          if (!seenModules.has(expectedModule)) {
            seenModules.add(expectedModule);
            expectedImports.push({
              module: expectedModule,
              line: lines.length,
            });
          }
        });

        return {
          content: lines.join('\n'),
          expectedImports,
        };
      });

    it('Feature: tree-sitter-wasm-migration, Property 1: For any Python file with import statements, all imports are extracted', async () => {
      await fc.assert(
        fc.asyncProperty(
          pythonFileWithImportsArbitrary(),
          async (pythonFile) => {
            // Create a temporary test file
            const tempFilePath = path.join(fixturesDir, `temp_test_${Date.now()}.py`);
            
            try {
              await fs.writeFile(tempFilePath, pythonFile.content);

              // Parse imports
              const deps = await parser.parseImports(tempFilePath);

              // Verify all expected imports are extracted
              for (const expectedImport of pythonFile.expectedImports) {
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

    it('Feature: tree-sitter-wasm-migration, Property 1: For any Python file, import line numbers are accurate', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(pythonImportStatementArbitrary(), { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 10 }), // Number of blank lines before imports
          async (imports, blankLinesBefore) => {
            const lines: string[] = ['# Test file'];
            
            // Add blank lines
            for (let i = 0; i < blankLinesBefore; i++) {
              lines.push('');
            }

            const expectedLineNumbers: number[] = [];
            const seenModules = new Set<string>();

            imports.forEach((imp) => {
              let importLine = '';
              let expectedModule = '';
              
              if (imp.type === 'absolute') {
                importLine = imp.importStyle === 'import' 
                  ? `import ${imp.module}`
                  : `from ${imp.module} import something`;
                expectedModule = imp.module;
              } else if (imp.type === 'relative-dot') {
                importLine = imp.importStyle === 'import'
                  ? `from .${imp.module} import something`
                  : `from . import ${imp.module}`;
                expectedModule = imp.importStyle === 'import' ? `.${imp.module}` : '.';
              } else {
                importLine = imp.importStyle === 'import'
                  ? `from ..${imp.module} import something`
                  : `from .. import ${imp.module}`;
                expectedModule = imp.importStyle === 'import' ? `..${imp.module}` : '..';
              }

              lines.push(importLine);
              
              // Only track line number if module not seen before (parser deduplicates)
              if (!seenModules.has(expectedModule)) {
                seenModules.add(expectedModule);
                expectedLineNumbers.push(lines.length);
              }
            });

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_line_test_${Date.now()}.py`);

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

    it('Feature: tree-sitter-wasm-migration, Property 1: For any Python file with mixed import types, all types are extracted', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(pythonImportStatementArbitrary(), { minLength: 3, maxLength: 8 }),
          async (imports) => {
            // Ensure we have at least one of each type
            const hasAbsolute = imports.some((i) => i.type === 'absolute');
            const hasRelativeDot = imports.some((i) => i.type === 'relative-dot');
            const hasRelativeDots = imports.some((i) => i.type === 'relative-dots');

            if (!hasAbsolute || !hasRelativeDot || !hasRelativeDots) {
              // Skip this iteration if we don't have all types
              return;
            }

            const lines: string[] = ['# Mixed imports test'];
            const expectedModules: string[] = [];
            const seenModules = new Set<string>();

            imports.forEach((imp, index) => {
              let importLine = '';
              let expectedModule = '';

              if (imp.type === 'absolute') {
                // Make module unique by appending index
                const uniqueModule = `${imp.module}${index}`;
                importLine = imp.importStyle === 'import'
                  ? `import ${uniqueModule}`
                  : `from ${uniqueModule} import something`;
                expectedModule = uniqueModule;
              } else if (imp.type === 'relative-dot') {
                // Make module unique by appending index
                const uniqueModule = `${imp.module}${index}`;
                importLine = imp.importStyle === 'import'
                  ? `from .${uniqueModule} import something`
                  : `from . import ${uniqueModule}`;
                expectedModule = imp.importStyle === 'import' ? `.${uniqueModule}` : '.';
              } else {
                // Make module unique by appending index
                const uniqueModule = `${imp.module}${index}`;
                importLine = imp.importStyle === 'import'
                  ? `from ..${uniqueModule} import something`
                  : `from .. import ${uniqueModule}`;
                expectedModule = imp.importStyle === 'import' ? `..${uniqueModule}` : '..';
              }

              lines.push(importLine);
              
              // Only add if not seen before
              if (!seenModules.has(expectedModule)) {
                seenModules.add(expectedModule);
                expectedModules.push(expectedModule);
              }
            });

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_mixed_${Date.now()}.py`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify all expected modules are present
              const actualModules = deps.map((d) => d.module);
              for (const expectedModule of expectedModules) {
                expect(actualModules).toContain(expectedModule);
              }

              // Verify we extracted the right number of imports
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

    it('Feature: tree-sitter-wasm-migration, Property 1: For any Python file, import type field is always "import"', async () => {
      await fc.assert(
        fc.asyncProperty(
          pythonFileWithImportsArbitrary(),
          async (pythonFile) => {
            const tempFilePath = path.join(fixturesDir, `temp_type_${Date.now()}.py`);

            try {
              await fs.writeFile(tempFilePath, pythonFile.content);
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

    it('Feature: tree-sitter-wasm-migration, Property 1: For any Python file with import aliases, module name is extracted (not alias)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(pythonModuleNameArbitrary(), { minLength: 1, maxLength: 5 }),
          fc.array(fc.stringMatching(/^[a-z][a-z0-9_]*$/), { minLength: 1, maxLength: 5 }),
          async (modules, aliases) => {
            const lines: string[] = ['# Import aliases test'];
            const expectedModules: string[] = [];
            const seenModules = new Set<string>();

            const count = Math.min(modules.length, aliases.length);
            for (let i = 0; i < count; i++) {
              // Make module unique by appending index
              const uniqueModule = `${modules[i]}${i}`;
              lines.push(`import ${uniqueModule} as ${aliases[i]}`);
              
              if (!seenModules.has(uniqueModule)) {
                seenModules.add(uniqueModule);
                expectedModules.push(uniqueModule);
              }
            }

            const content = lines.join('\n');
            const tempFilePath = path.join(fixturesDir, `temp_alias_${Date.now()}.py`);

            try {
              await fs.writeFile(tempFilePath, content);
              const deps = await parser.parseImports(tempFilePath);

              // Verify we extracted the module names, not the aliases
              const actualModules = deps.map((d) => d.module);
              for (const expectedModule of expectedModules) {
                expect(actualModules).toContain(expectedModule);
              }

              // Verify aliases are not in the module list
              for (const alias of aliases.slice(0, count)) {
                expect(actualModules).not.toContain(alias);
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
  });

  describe('Property 2: Python Module Resolution Correctness', () => {
    /**
     * Property 2: Python module resolution correctness
     * 
     * For any Python file and valid module specifier (absolute or relative), 
     * resolving the module path should return the same result as the native 
     * implementation would have returned, or null if the module cannot be resolved.
     * 
     * Validates: Requirements 2.3
     */

    // Arbitrary for generating valid Python module specifiers
    const absoluteModuleSpecifierArbitrary = () =>
      fc.stringMatching(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,2}$/);

    const relativeModuleSpecifierArbitrary = () =>
      fc.oneof(
        fc.constant('.'),           // from . import x
        fc.constant('..'),          // from .. import x
        fc.stringMatching(/^\.[a-z][a-z0-9_]*$/).map(s => s),  // from .module import x
        fc.stringMatching(/^\.\.[a-z][a-z0-9_]*$/).map(s => s) // from ..module import x
      );

    const moduleSpecifierArbitrary = () =>
      fc.oneof(
        absoluteModuleSpecifierArbitrary(),
        relativeModuleSpecifierArbitrary()
      );

    it('Feature: tree-sitter-wasm-migration, Property 2: For any valid module specifier, resolvePath returns a valid path or null', async () => {
      await fc.assert(
        fc.asyncProperty(
          moduleSpecifierArbitrary(),
          async (moduleSpecifier) => {
            // Use main.py as the source file (it exists in fixtures)
            const fromFile = path.join(fixturesDir, 'main.py');

            // Resolve the module path
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Result should be either a string (valid path) or null (not found)
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

    it('Feature: tree-sitter-wasm-migration, Property 2: For any existing module in fixtures, resolvePath returns a valid file path', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils.helpers',      // Absolute import
            'utils',              // Absolute import (package)
            '.relative_imports',  // Relative import (same directory)
            '.utils.helpers'      // Relative import (subdirectory)
          ),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.py');
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // These modules exist in fixtures, so should resolve
            expect(resolvedPath).not.toBeNull();
            expect(typeof resolvedPath).toBe('string');

            // Resolved path should end with .py or .pyi
            if (resolvedPath) {
              expect(
                resolvedPath.endsWith('.py') || 
                resolvedPath.endsWith('.pyi') ||
                resolvedPath.endsWith('__init__.py') ||
                resolvedPath.endsWith('__init__.pyi')
              ).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any non-existent module, resolvePath returns null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^nonexistent[a-z0-9_]*(\.[a-z][a-z0-9_]*){0,2}$/),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.py');
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Non-existent modules should return null
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any relative import, resolution is relative to the source file directory', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { fromFile: 'main.py', module: '.relative_imports', shouldResolve: true },
            { fromFile: 'main.py', module: '.utils.helpers', shouldResolve: true },
            { fromFile: 'utils/helpers.py', module: '..main', shouldResolve: true },
            { fromFile: 'utils/helpers.py', module: '.', shouldResolve: true },
            { fromFile: 'main.py', module: '..nonexistent', shouldResolve: false }
          ),
          async (testCase) => {
            const fromFile = path.join(fixturesDir, testCase.fromFile);
            const resolvedPath = await parser.resolvePath(fromFile, testCase.module);

            if (testCase.shouldResolve) {
              expect(resolvedPath).not.toBeNull();
              expect(typeof resolvedPath).toBe('string');
            } else {
              expect(resolvedPath).toBeNull();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any absolute import, resolution searches from source directory up to workspace root', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { fromFile: 'main.py', module: 'utils.helpers', shouldResolve: true },
            { fromFile: 'utils/helpers.py', module: 'utils.helpers', shouldResolve: true },
            { fromFile: 'main.py', module: 'utils', shouldResolve: true },
            { fromFile: 'utils/helpers.py', module: 'main', shouldResolve: true }
          ),
          async (testCase) => {
            const fromFile = path.join(fixturesDir, testCase.fromFile);
            const resolvedPath = await parser.resolvePath(fromFile, testCase.module);

            if (testCase.shouldResolve) {
              expect(resolvedPath).not.toBeNull();
              expect(typeof resolvedPath).toBe('string');
              
              // Resolved path should be within the fixtures directory
              if (resolvedPath) {
                const normalizedResolved = normalizePath(resolvedPath);
                const normalizedFixtures = normalizePath(fixturesDir);
                expect(normalizedResolved.startsWith(normalizedFixtures)).toBe(true);
              }
            } else {
              expect(resolvedPath).toBeNull();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any module specifier, resolution handles __init__.py correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils',              // Should resolve to utils/__init__.py
            '.utils',             // Should resolve to utils/__init__.py (relative)
          ),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.py');
            const resolvedPath = await parser.resolvePath(fromFile, moduleSpecifier);

            // Should resolve to __init__.py
            expect(resolvedPath).not.toBeNull();
            if (resolvedPath) {
              expect(
                resolvedPath.endsWith('__init__.py') || 
                resolvedPath.endsWith('__init__.pyi')
              ).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any module specifier with dots, resolution converts dots to path separators', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            { module: 'utils.helpers', expectedPathPart: 'utils/helpers' },
            { module: '.utils.helpers', expectedPathPart: 'utils/helpers' }
          ),
          async (testCase) => {
            const fromFile = path.join(fixturesDir, 'main.py');
            const resolvedPath = await parser.resolvePath(fromFile, testCase.module);

            // Should resolve successfully
            expect(resolvedPath).not.toBeNull();
            
            if (resolvedPath) {
              // Normalized path should contain the expected path structure
              const normalizedPath = normalizePath(resolvedPath);
              expect(normalizedPath.includes(testCase.expectedPathPart)).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any module specifier, resolution is idempotent', async () => {
      await fc.assert(
        fc.asyncProperty(
          moduleSpecifierArbitrary(),
          async (moduleSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.py');

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

    it('Feature: tree-sitter-wasm-migration, Property 2: For any module specifier, resolution handles errors gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant('...'),                 // Too many dots
            fc.constant('....module'),          // Too many dots with module
            fc.stringMatching(/^\d/),       // Starts with number (invalid)
            fc.constant('/absolute/path'),      // Absolute file path (invalid)
            fc.constant('nonexistent_module_xyz123')  // Non-existent module
          ),
          async (invalidSpecifier) => {
            const fromFile = path.join(fixturesDir, 'main.py');

            // Should not throw, should return null for invalid/non-existent specifiers
            const resolvedPath = await parser.resolvePath(fromFile, invalidSpecifier);
            
            // Invalid/non-existent specifiers should return null (not throw)
            expect(resolvedPath).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Feature: tree-sitter-wasm-migration, Property 2: For any source file with symbol ID, resolution extracts file path correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            'utils.helpers',
            '.relative_imports'
          ),
          fc.stringMatching(/^[a-z][a-z0-9_]*$/), // Symbol name
          async (moduleSpecifier, symbolName) => {
            const fromFile = path.join(fixturesDir, 'main.py');
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
  });
});
