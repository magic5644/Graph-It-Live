import { JavaParser } from '@/analyzer/languages/JavaParser';
import { ReportReads } from '@/analyzer/utils/ReportReads';
import { normalizePath } from '@/shared/path';
import fs from 'node:fs';
import os from 'node:os';
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

    return { rootNode, delete: vi.fn() };
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
      const deleteTree = vi.fn();
      vi.spyOn(parser as any, 'ensureInitialized').mockResolvedValue(undefined);
      (parser as any).parser = {
        parse: (_: string) => ({
          rootNode: {
            type: 'program',
            children: [],
            descendantsOfType: () => [],
          },
          delete: deleteTree,
        }),
      };

      const deps = await parser.parseImports(path.join(fixturesDir, 'Main.java'));
      expect(deps).toEqual([]);
      expect(deleteTree).toHaveBeenCalledOnce();
    });
  });

  describe('resolvePath', () => {
      it('should return null for java stdlib imports', async () => {
      const result = await parser.resolvePath('/project/Main.java', 'java.util.List');
      expect(result).toBeNull();
    });

      it('should return null for wildcard imports', async () => {
          const result = await parser.resolvePath('/project/Main.java', 'com.example.myapp.*');
          expect(result).toBeNull();
      });

      it('should resolve a project-local FQN to a .java file', async () => {
          const result = await parser.resolvePath(
              path.join(fixturesDir, 'Main.java'),
              'com.example.myapp.UserService',
          );
          expect(result).toBeTruthy();
          expect(result).toMatch(/UserService\.java$/);
      });

      it('should resolve a nested class to a .java file', async () => {
          const result = await parser.resolvePath(
              path.join(fixturesDir, 'Main.java'),
              'com.example.myapp.models.User',
          );
          expect(result).toBeTruthy();
          expect(result).toMatch(/User\.java$/);
      });

          it('should reject a path escaping through a symbolic link', () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-java-root-'));
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-java-outside-'));
            const linkedPath = path.join(root, 'linked');
            fs.symlinkSync(outside, linkedPath);
            const scopedParser = new JavaParser(root, process.cwd());

            expect((scopedParser as any).isWithinRoot(linkedPath)).toBe(false);

            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
          });
  });

  describe('localTargetOf (#774)', () => {
    let root: string;
    const at = (file: string) => normalizePath(path.join(root, file));
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'class X {}\n');
    };
    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-java-target-')));
      write('mod/src/main/java/com/acme/app/App.java');
      write('com/top/Root.java');
    });

    it('names the class file in the nearest folder holding the package, existing or not', async () => {
      const scoped = new JavaParser(root, process.cwd());
      const app = path.join(root, 'mod/src/main/java/com/acme/app/App.java');
      expect(await scoped.localTargetOf(app, 'com.acme.app.Generated')).toBe(at('mod/src/main/java/com/acme/app/Generated.java'));
      // The workspace root itself is a source root too.
      expect(await scoped.localTargetOf(app, 'com.top.Missing')).toBe(at('com/top/Missing.java'));
    });

    it('is null for the JDK, wildcards, lower-case names, unsafe segments, missing packages and files outside the root', async () => {
      const scoped = new JavaParser(root, process.cwd());
      const app = path.join(root, 'mod/src/main/java/com/acme/app/App.java');
      for (const specifier of ['java.util.List', 'com.acme.app.*', 'com.acme.app.util', 'com..app.X', 'Single', 'org.junit.Test']) {
        expect(await scoped.localTargetOf(app, specifier)).toBeNull();
      }
      expect(await scoped.localTargetOf(path.join(os.tmpdir(), 'Elsewhere.java'), 'com.top.Missing')).toBeNull();
    });

    it('probes each package folder once across the imports of one report', async () => {
      const scoped = new JavaParser(root, process.cwd());
      const reads = new ReportReads();
      const app = path.join(root, 'mod/src/main/java/com/acme/app/App.java');
      expect(await scoped.localTargetOf(app, 'com.gen.First', reads)).toBeNull();
      fs.mkdirSync(path.join(root, 'com/gen'), { recursive: true });
      // Same report: the folder probes are not made again. A new report sees the folder.
      expect(await scoped.localTargetOf(app, 'com.gen.Second', reads)).toBeNull();
      expect(await scoped.localTargetOf(app, 'com.gen.Second')).toBe(at('com/gen/Second.java'));
    });
  });
});
