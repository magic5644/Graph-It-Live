import { JavaParser } from '@/analyzer/languages/JavaParser';
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

      // Match: import com.example.pkg.Class; or import static com.example.Class.method;
      if (trimmed.startsWith('import ')) {
        const match = /^import\s+(?:static\s+)?([A-Za-z][A-Za-z0-9._]*)/.exec(trimmed);
        if (match) {
          const importPath = match[1];
          const importStartInLine = line.indexOf(importPath);
          const importStartPos = lineStartPos + importStartInLine;
          const importEndPos = importStartPos + importPath.length;

          const scopedNode = createMockNode('scoped_identifier', importPath, lineIndex);
          scopedNode.startIndex = importStartPos;
          scopedNode.endIndex = importEndPos;

          const importNode = createMockNode('import_declaration', line, lineIndex);
          importNode.startIndex = lineStartPos;
          importNode.endIndex = lineStartPos + line.length;
          importNode.childCount = 1;
          importNode.namedChildCount = 1;
          importNode.namedChildren = [scopedNode];
          importNode.children = [scopedNode];
          importNode.descendantsOfType = (nodeType: string) =>
            nodeType === 'scoped_identifier' || nodeType === 'identifier' ? [scopedNode] : [];

          children.push(importNode);
        }
      }
    });

    const rootNode = createMockNode('program', content, 0);
    rootNode.childCount = children.length;
    rootNode.namedChildCount = children.length;
    rootNode.namedChildren = children;
    rootNode.children = children;
    rootNode.descendantsOfType = (nodeType: string) =>
      nodeType === 'import_declaration' ? children : [];

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

const fixturesDir = path.resolve(__dirname, '../fixtures/java-project');

describe('JavaParser', () => {
  let parser: JavaParser;

  beforeEach(() => {
    parser = new JavaParser(fixturesDir, process.cwd());
  });

  describe('parseImports', () => {
    it('should parse import declarations from a Java file', async () => {
      const filePath = path.join(fixturesDir, 'Main.java');
      const deps = await parser.parseImports(filePath);

      expect(deps).toBeDefined();
      expect(Array.isArray(deps)).toBe(true);
      expect(deps.length).toBeGreaterThan(0);
    });

    it('should detect java.util imports', async () => {
      const filePath = path.join(fixturesDir, 'Main.java');
      const deps = await parser.parseImports(filePath);

      const modules = deps.map(d => d.module);
      expect(modules.some(m => m.startsWith('java.util'))).toBe(true);
    });

    it('should return empty array for a file with no imports', async () => {
      vi.spyOn(parser as any, 'ensureInitialized').mockResolvedValue(undefined);
      (parser as any).parser = {
        parse: (_: string) => ({
          rootNode: {
            type: 'program',
            children: [],
            descendantsOfType: () => [],
          },
        }),
      };

      const deps = await parser.parseImports(path.join(fixturesDir, 'Main.java'));
      expect(deps).toEqual([]);
    });
  });

  describe('resolvePath', () => {
    it('should always return null (package paths are not file paths)', async () => {
      const result = await parser.resolvePath('/project/Main.java', 'java.util.List');
      expect(result).toBeNull();
    });
  });
});
