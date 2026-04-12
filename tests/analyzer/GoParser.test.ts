import { GoParser } from '@/analyzer/languages/GoParser';
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
      if (!trimmed || trimmed.startsWith('//')) return;

      const lineStartPos = linePositions[lineIndex];

      // Match: "github.com/pkg/path" or `path`
      const match = /^["`]([^"`]+)["`]/.exec(trimmed);
      if (match) {
        const importPath = match[1];
        const importStartInLine = line.indexOf(importPath);
        const importStartPos = lineStartPos + importStartInLine;
        const importEndPos = importStartPos + importPath.length;

        const pathNode = createMockNode('interpreted_string_literal', `"${importPath}"`, lineIndex);
        pathNode.startIndex = importStartPos;
        pathNode.endIndex = importEndPos;

        const specNode = createMockNode('import_spec', trimmed, lineIndex);
        specNode.startIndex = lineStartPos;
        specNode.endIndex = lineStartPos + trimmed.length;
        specNode.childCount = 1;
        specNode.namedChildCount = 1;
        specNode.namedChildren = [pathNode];
        specNode.children = [pathNode];
        specNode.childForFieldName = (field: string) => field === 'path' ? pathNode : null;

        children.push(specNode);
      }
    });

    const rootNode = createMockNode('source_file', content, 0);
    rootNode.childCount = children.length;
    rootNode.namedChildCount = children.length;
    rootNode.namedChildren = children;
    rootNode.children = children;
    rootNode.descendantsOfType = (nodeType: string) =>
      nodeType === 'import_spec' ? children : [];

    return { rootNode };
  };

  const MockWasmParserFactory = {
    getInstance: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      getParser: vi.fn().mockResolvedValue({
        parse: mockParse,
        setLanguage: vi.fn(),
      }),
      isInitialized: vi.fn().mockReturnValue(true),
    }),
  };

  return { WasmParserFactory: MockWasmParserFactory };
});

const fixturesDir = path.resolve(__dirname, '../fixtures/go-project');

describe('GoParser', () => {
  let parser: GoParser;

  beforeEach(() => {
    parser = new GoParser(fixturesDir, process.cwd());
  });

  describe('parseImports', () => {
    it('should parse import statements from a Go file', async () => {
      const filePath = path.join(fixturesDir, 'main.go');
      const deps = await parser.parseImports(filePath);

      expect(deps).toBeDefined();
      expect(Array.isArray(deps)).toBe(true);
      expect(deps.length).toBeGreaterThan(0);
    });

    it('should return empty array for a file with no imports', async () => {
      vi.spyOn(parser as any, 'ensureInitialized').mockResolvedValue(undefined);
      (parser as any).parser = {
        parse: (_: string) => ({
          rootNode: {
            type: 'source_file',
            children: [],
            descendantsOfType: () => [],
          },
        }),
      };

      const deps = await parser.parseImports(path.join(fixturesDir, 'main.go'));
      expect(deps).toEqual([]);
    });
  });

  describe('resolvePath', () => {
    it('should return null for stdlib packages', async () => {
      const result = await parser.resolvePath('/project/main.go', 'fmt');
      expect(result).toBeNull();
    });

      it('should return null for net/http stdlib package', async () => {
          const result = await parser.resolvePath('/project/main.go', 'net/http');
          expect(result).toBeNull();
      });

      it('should resolve a module-local package via go.mod', async () => {
      const result = await parser.resolvePath(
          path.join(fixturesDir, 'main.go'),
          'github.com/example/myapp/config',
      );
        expect(result).toBeTruthy();
        expect(result).toMatch(/\.go$/);
    });

      it('should resolve a module-local package via last-segment fallback', async () => {
          const result = await parser.resolvePath(
              path.join(fixturesDir, 'main.go'),
              'github.com/example/myapp/utils',
          );
          expect(result).toBeTruthy();
          expect(result).toMatch(/\.go$/);
    });
  });
});
