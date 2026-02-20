import { PythonParser } from '@/analyzer/languages/PythonParser';
import { normalizePath } from '@/shared/path';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock WasmParserFactory to avoid WASM initialization in unit tests
vi.mock('@/analyzer/languages/WasmParserFactory', () => {
  const createMockNode = (type: string, text: string, startRow: number): any => ({
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

  const mockParse = (content: string) => {
    const lines = content.split('\n');
    const children: any[] = [];
    
    let currentPosition = 0;
    const linePositions: number[] = [];
    
    for (const line of lines) {
      linePositions.push(currentPosition);
      currentPosition += line.length + 1;
    }

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }
      
      const lineStartPos = linePositions[lineIndex];
      
      // Match: import module
      if (trimmed.startsWith('import ') && !trimmed.includes(' from ')) {
        const match = /^import\s+([a-z][a-z0-9_.]*)/i.exec(trimmed);
        if (match) {
          const moduleName = match[1].split(' as ')[0].trim();
          const moduleStartInLine = line.indexOf(moduleName);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + moduleName.length;
          
          const dottedNameNode = createMockNode('dotted_name', moduleName, lineIndex);
          dottedNameNode.startIndex = moduleStartPos;
          dottedNameNode.endIndex = moduleEndPos;
          
          const importNode = createMockNode('import_statement', line, lineIndex);
          importNode.startIndex = lineStartPos;
          importNode.endIndex = lineStartPos + line.length;
          importNode.children = [dottedNameNode];
          children.push(importNode);
        }
      }
      // Match: from module import name
      else if (trimmed.startsWith('from ') && trimmed.includes(' import ')) {
        const match = /^from\s+(\.{0,2}[a-z][a-z0-9_.]*|\.\.|\.)\s+import/i.exec(trimmed);
        if (match) {
          const moduleName = match[1];
          const moduleStartInLine = line.indexOf(moduleName);
          const moduleStartPos = lineStartPos + moduleStartInLine;
          const moduleEndPos = moduleStartPos + moduleName.length;
          
          let childNode: any;
          if (moduleName.startsWith('.')) {
            childNode = createMockNode('relative_import', moduleName, lineIndex);
          } else {
            childNode = createMockNode('dotted_name', moduleName, lineIndex);
          }
          
          childNode.startIndex = moduleStartPos;
          childNode.endIndex = moduleEndPos;
          
          const importNode = createMockNode('import_from_statement', line, lineIndex);
          importNode.startIndex = lineStartPos;
          importNode.endIndex = lineStartPos + line.length;
          importNode.children = [childNode];
          children.push(importNode);
        }
      }
    });

    const rootNode = createMockNode('module', content, 0);
    rootNode.startIndex = 0;
    rootNode.endIndex = content.length;
    rootNode.children = children;
    rootNode.descendantsOfType = (types: string[]) => {
      return children.filter(child => types.includes(child.type));
    };

    return { rootNode };
  };

  return {
    WasmParserFactory: {
      getInstance: vi.fn().mockReturnValue({
        init: vi.fn().mockResolvedValue(undefined),
        getParser: vi.fn().mockResolvedValue({
          parse: mockParse,
          setLanguage: vi.fn(),
        }),
        isInitialized: vi.fn().mockReturnValue(true),
      }),
    },
  };
});

describe('PythonParser', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/python-project');
  const extensionPath = process.cwd();
  let parser: PythonParser;

  beforeEach(() => {
    parser = new PythonParser(fixturesDir, extensionPath);
  });

  describe('parseImports', () => {
    it('should parse absolute imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module).sort();
      expect(modules).toContain('utils.helpers');
    });

    it('should parse from...import statements', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module);
      expect(modules).toContain('utils.helpers');
    });

    it('should parse relative imports with dot', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const deps = await parser.parseImports(relFile);

      const modules = deps.map(d => d.module).sort();
      expect(modules).toContain('.');
      expect(modules).toContain('.utils');
      expect(modules).toContain('..utils.helpers');
    });

    it('should parse import aliases', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const deps = await parser.parseImports(relFile);

      // Should capture the module being imported (before 'as')
      const modules = deps.map(d => d.module);
      expect(modules).toContain('.utils');
    });

    it('should not duplicate imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      const modules = deps.map(d => d.module);
      const uniqueModules = [...new Set(modules)];
      expect(modules.length).toBe(uniqueModules.length);
    });

    it('should include line numbers', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const deps = await parser.parseImports(mainFile);

      expect(deps.every(d => d.line > 0)).toBe(true);
    });
  });

  describe('resolvePath', () => {
    it('should resolve absolute imports to __init__.py', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', '__init__.py'))
      );
    });

    it('should resolve absolute imports to module file', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils.helpers');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', 'helpers.py'))
      );
    });

    it('should resolve single dot relative import', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const resolved = await parser.resolvePath(relFile, '.');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, '__init__.py'))
      );
    });

    it('should resolve relative import with module name', async () => {
      const relFile = path.join(fixturesDir, 'relative_imports.py');
      const resolved = await parser.resolvePath(relFile, '.utils');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, 'utils', '__init__.py'))
      );
    });

    it('should resolve double dot relative import', async () => {
      const helpersFile = path.join(fixturesDir, 'utils', 'helpers.py');
      const resolved = await parser.resolvePath(helpersFile, '..');

      expect(resolved).toBeTruthy();
      expect(normalizePath(resolved!)).toBe(
        normalizePath(path.join(fixturesDir, '__init__.py'))
      );
    });

    it('should return null for unresolvable imports', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'nonexistent.module');

      expect(resolved).toBeNull();
    });

    it('should normalize paths before returning', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved = await parser.resolvePath(mainFile, 'utils');

      expect(resolved).toBeTruthy();
      // Should use forward slashes and lowercase drive letters
      expect(resolved).not.toContain('\\');
      if (process.platform === 'win32') {
        expect(resolved![0]).toBe(resolved![0].toLowerCase());
      }
    });
  });

  describe('cross-platform compatibility', () => {
    it('should handle Windows paths with normalizePath', async () => {
      // Use String.raw for Windows-style paths
      const windowsStylePath = String.raw`C:\Users\test\project\main.py`;
      const normalized = normalizePath(windowsStylePath);

      // Should convert to forward slashes and lowercase drive letter
      expect(normalized).toContain('/');
      expect(normalized).not.toContain('\\');
      if (normalized.includes(':')) {
        expect(normalized[0]).toBe('c');
      }
    });

    it('should resolve paths consistently across platforms', async () => {
      const mainFile = path.join(fixturesDir, 'main.py');
      const resolved1 = await parser.resolvePath(mainFile, 'utils');
      const resolved2 = await parser.resolvePath(mainFile, 'utils');

      expect(normalizePath(resolved1!)).toBe(normalizePath(resolved2!));
    });
  });
});
