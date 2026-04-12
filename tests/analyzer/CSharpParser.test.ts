import { CSharpParser } from '@/analyzer/languages/CSharpParser';
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

      // Match: using Namespace.Name; or using static Namespace.Name;
      if (trimmed.startsWith('using ')) {
        const match = /^using\s+(?:static\s+)?([A-Za-z][A-Za-z0-9_.]*)/.exec(trimmed);
        if (match) {
          const ns = match[1];
          const nsStartInLine = line.indexOf(ns);
          const nsStartPos = lineStartPos + nsStartInLine;
          const nsEndPos = nsStartPos + ns.length;

          const nsNode = createMockNode('identifier', ns, lineIndex);
          nsNode.startIndex = nsStartPos;
          nsNode.endIndex = nsEndPos;

          const usingNode = createMockNode('using_directive', line, lineIndex);
          usingNode.startIndex = lineStartPos;
          usingNode.endIndex = lineStartPos + line.length;
          usingNode.childCount = 1;
          usingNode.namedChildCount = 1;
          usingNode.namedChildren = [nsNode];
          usingNode.children = [nsNode];
          usingNode.descendantsOfType = (nodeType: string) =>
            nodeType === 'identifier' || nodeType === 'qualified_name' || nodeType === 'member_access_expression'
              ? [nsNode]
              : [];

          children.push(usingNode);
        }
      }
    });

    const rootNode = createMockNode('compilation_unit', content, 0);
    rootNode.childCount = children.length;
    rootNode.namedChildCount = children.length;
    rootNode.namedChildren = children;
    rootNode.children = children;
    rootNode.descendantsOfType = (nodeType: string) =>
      nodeType === 'using_directive' ? children : [];

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

const fixturesDir = path.resolve(__dirname, '../fixtures/csharp-project');

describe('CSharpParser', () => {
  let parser: CSharpParser;

  beforeEach(() => {
    parser = new CSharpParser(fixturesDir, process.cwd());
  });

  describe('parseImports', () => {
    it('should parse using directives from a C# file', async () => {
      const filePath = path.join(fixturesDir, 'Program.cs');
      const deps = await parser.parseImports(filePath);

      expect(deps).toBeDefined();
      expect(Array.isArray(deps)).toBe(true);
      expect(deps.length).toBeGreaterThan(0);
    });

    it('should detect System using directive', async () => {
      const filePath = path.join(fixturesDir, 'Program.cs');
      const deps = await parser.parseImports(filePath);

      const modules = deps.map(d => d.module);
      expect(modules).toContain('System');
    });

    it('should detect multi-part namespace imports', async () => {
      const filePath = path.join(fixturesDir, 'Program.cs');
      const deps = await parser.parseImports(filePath);

      const modules = deps.map(d => d.module);
      expect(modules.some(m => m.includes('.'))).toBe(true);
    });

    it('should return empty array for a file with no using directives', async () => {
      const filePath = path.join(fixturesDir, 'Program.cs');
      vi.spyOn(parser as any, 'ensureInitialized').mockResolvedValue(undefined);
      (parser as any).parser = {
        parse: (_: string) => ({
          rootNode: {
            type: 'compilation_unit',
            children: [],
            descendantsOfType: () => [],
          },
        }),
      };

      const deps = await parser.parseImports(filePath);
      expect(deps).toEqual([]);
    });
  });

  describe('resolvePath', () => {
    it('should always return null (namespaces are not file paths)', async () => {
      const result = await parser.resolvePath('/project/Program.cs', 'System.Collections.Generic');
      expect(result).toBeNull();
    });
  });
});
