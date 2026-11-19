import { JavaParser } from '@/analyzer/languages/JavaParser';
import { ReportReads } from '@/analyzer/utils/ReportReads';
import { normalizePath } from '@/shared/path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('resolvePath across source roots and modules (#774)', () => {
    let root: string;
    const at = (file: string) => normalizePath(path.join(root, file));
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'class X {}\n');
    };
    const mainApp = 'core/src/main/java/com/acme/app/App.java';
    const testFile = () => path.join(root, 'core/src/test/java/com/acme/app/AppTest.java');
    const otherModule = () => path.join(root, 'web/src/main/java/com/acme/web/Page.java');
    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-java-modules-')));
      write(mainApp);
      write('core/src/main/java/com/acme/util/Strings.java');
      write('core/src/test/java/com/acme/app/AppTest.java');
      write('core/src/test/java/com/acme/app/Fixtures.java');
      write('web/src/main/java/com/acme/web/Page.java');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('resolves a test to its module main classes, a main class to another package, and a test to its own test classes', async () => {
      const scoped = new JavaParser(root, process.cwd());
      expect(await scoped.resolvePath(testFile(), 'com.acme.app.App')).toBe(at(mainApp));
      expect(await scoped.resolvePath(path.join(root, mainApp), 'com.acme.util.Strings')).toBe(at('core/src/main/java/com/acme/util/Strings.java'));
      expect(await scoped.resolvePath(testFile(), 'com.acme.app.Fixtures')).toBe(at('core/src/test/java/com/acme/app/Fixtures.java'));
    });

    it('resolves a class of a sibling module', async () => {
      const scoped = new JavaParser(root, process.cwd());
      expect(await scoped.resolvePath(otherModule(), 'com.acme.app.App')).toBe(at(mainApp));
      expect(await scoped.resolvePath(otherModule(), 'com.acme.util.Strings')).toBe(at('core/src/main/java/com/acme/util/Strings.java'));
    });

    it('never resolves a sibling module class to a copy in an ignored or build folder', async () => {
      fs.writeFileSync(path.join(root, '.gitignore'), 'generated/\n');
      write('generated/src/main/java/com/acme/gen/Model.java');
      write('core/target/classes/com/acme/gen/Model.java');
      const scoped = new JavaParser(root, process.cwd());
      expect(await scoped.resolvePath(otherModule(), 'com.acme.gen.Model')).toBeNull();
      write('api/src/main/java/com/acme/gen/Model.java');
      expect(await new JavaParser(root, process.cwd()).resolvePath(otherModule(), 'com.acme.gen.Model')).toBe(at('api/src/main/java/com/acme/gen/Model.java'));
    });

    it('resolves static imports, static wildcards and nested classes to the top-level class file', async () => {
      const scoped = new JavaParser(root, process.cwd());
      for (const specifier of ['com.acme.app.App.helper', 'com.acme.app.App.*', 'com.acme.app.App.Inner', 'com.acme.app.App.Inner.Deeper']) {
        expect(await scoped.resolvePath(otherModule(), specifier)).toBe(at(mainApp));
      }
    });

    it('is null for the JDK, package wildcards, missing classes and unsafe segments', async () => {
      const scoped = new JavaParser(root, process.cwd());
      for (const specifier of ['java.util.List', 'com.acme.app.*', 'com.acme.app.Missing', 'org.junit.Test', 'com.acme..App', 'com.acme.../App', 'com.a/b.App', 'com.a\\b.App']) {
        expect(await scoped.resolvePath(testFile(), specifier)).toBeNull();
      }
    });

    it('lists the workspace once, and again for a miss once the list is stale', async () => {
      const scoped = new JavaParser(root, process.cwd());
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        expect(await scoped.resolvePath(testFile(), 'com.acme.web.Later')).toBeNull();
        write('web/src/main/java/com/acme/web/Later.java');
        // Same list within its lifetime: the new file of another module is not seen yet.
        expect(await scoped.resolvePath(testFile(), 'com.acme.web.Later')).toBeNull();
        now.mockReturnValue(1_000_000 + 60_000);
        expect(await scoped.resolvePath(testFile(), 'com.acme.web.Later')).toBe(at('web/src/main/java/com/acme/web/Later.java'));
      } finally {
        now.mockRestore();
      }
    });

    it('finds a class created after the listing in the importing module at once', async () => {
      const scoped = new JavaParser(root, process.cwd());
      expect(await scoped.resolvePath(testFile(), 'com.acme.app.Fresh')).toBeNull();
      write('core/src/main/java/com/acme/app/Fresh.java');
      expect(await scoped.resolvePath(testFile(), 'com.acme.app.Fresh')).toBe(at('core/src/main/java/com/acme/app/Fresh.java'));
    });

    it('never resolves through a symbolic link leaving the root', async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-java-outside-')));
      try {
        fs.mkdirSync(path.join(outside, 'leak'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'leak', 'Secret.java'), 'class Secret {}\n');
        fs.symlinkSync(outside, path.join(root, 'core/src/main/java/com/acme/linked'));
        const scoped = new JavaParser(root, process.cwd());
        expect(await scoped.resolvePath(testFile(), 'com.acme.linked.leak.Secret')).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('reports a missing class of a static import where its package lives', async () => {
      const scoped = new JavaParser(root, process.cwd());
      expect(await scoped.localTargetOf(testFile(), 'com.acme.app.Missing.method')).toBe(at('core/src/test/java/com/acme/app/Missing.java'));
      expect(await scoped.localTargetOf(otherModule(), 'com.acme.web.Gone.*')).toBe(at('web/src/main/java/com/acme/web/Gone.java'));
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
