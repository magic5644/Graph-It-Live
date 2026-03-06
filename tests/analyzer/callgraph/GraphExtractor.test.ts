import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Configurable captures shared between the mock Query and individual tests.
// The factory is hoisted by vitest but the method reads this variable lazily,
// so tests can reassign it in beforeEach / per-test without issues.
// ---------------------------------------------------------------------------
let mockCapturesResult: Array<{ name: string; node: object }> = [];

// ---------------------------------------------------------------------------
// Mock web-tree-sitter
// Provides a MockQuery whose captures() reads mockCapturesResult at call time
// and a MockParser with a stable `language` object for downstream checks.
// ---------------------------------------------------------------------------
vi.mock("web-tree-sitter", () => {
  class MockQuery {
    captures(_rootNode: unknown) {
      return mockCapturesResult;
    }
    delete = vi.fn();
  }

  class MockParser {
    static readonly init = vi.fn().mockResolvedValue(undefined);
    static readonly Language = {
      load: vi.fn().mockResolvedValue({}),
    };
    language: object = { __isMockLanguage: true };
    setLanguage = vi.fn();
    parse = vi.fn().mockReturnValue({ rootNode: {} });
    getLanguage = vi.fn();
    reset = vi.fn();
    delete = vi.fn();
  }

  return {
    Parser: MockParser,
    Query: MockQuery,
    Language: MockParser.Language,
    default: MockParser,
  };
});

// ---------------------------------------------------------------------------
// Mock WasmParserFactory — replaces the singleton so no real WASM is loaded.
// The parser returned has a truthy `language` and a parse() stub.
// ---------------------------------------------------------------------------
vi.mock("@/analyzer/languages/WasmParserFactory", () => ({
  WasmParserFactory: {
    getInstance: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      getParser: vi.fn().mockResolvedValue({
        language: { __isMockLanguage: true },
        parse: vi.fn().mockReturnValue({ rootNode: {} }),
        setLanguage: vi.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// GraphExtractor uses fs.readFile for both the source file (in extractFile)
// and the .scm query file (in loadQuerySource).
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

// Imports AFTER vi.mock declarations so that mocked modules are in place.
import {
  GraphExtractor,
  fileExtToLang,
  type ExtractorConfig,
} from "@/analyzer/callgraph/GraphExtractor";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EXTENSION_PATH = "/mock/extension";
const WORKSPACE_ROOT = "/mock/workspace";

const defaultConfig: ExtractorConfig = {
  extensionPath: EXTENSION_PATH,
  workspaceRoot: WORKSPACE_ROOT,
};

/**
 * Convenience helper: configure the fs.readFile mock so that:
 *  - *.scm paths return `querySrc`
 *  - any other path returns `sourceSrc`
 */
function setupFsMock(
  sourceSrc: string,
  querySrc = "(identifier) @def.function",
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(fs.readFile).mockImplementation((p: any) => {
    const filePath = String(p);
    if (filePath.endsWith(".scm")) {
      return Promise.resolve(querySrc) as unknown as ReturnType<typeof fs.readFile>;
    }
    return Promise.resolve(sourceSrc) as unknown as ReturnType<typeof fs.readFile>;
  });
}

// ---------------------------------------------------------------------------
// Tests: fileExtToLang utility
// ---------------------------------------------------------------------------

describe("fileExtToLang", () => {
  it("returns 'typescript' for .ts extension", () => {
    expect(fileExtToLang("src/app.ts")).toBe("typescript");
  });

  it("returns 'python' for .py extension", () => {
    expect(fileExtToLang("scripts/analyze.py")).toBe("python");
  });

  it("returns null for an unknown extension", () => {
    expect(fileExtToLang("README.unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: GraphExtractor
// ---------------------------------------------------------------------------

describe("GraphExtractor", () => {
  let extractor: GraphExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCapturesResult = [];
    extractor = new GraphExtractor(defaultConfig);
    setupFsMock("// default source", "(identifier) @def.function");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // extractSource
  // -------------------------------------------------------------------------

  describe("extractSource", () => {
    it("returns 1 node with type 'function' when captures contain 1 @def.function capture", async () => {
      mockCapturesResult = [
        {
          name: "def.function",
          node: {
            text: "myFunction",
            startPosition: { row: 0, column: 9 },
            endPosition: { row: 0, column: 19 },
            parent: null,
            type: "identifier",
          },
        },
      ];

      const result = await extractor.extractSource(
        "/mock/workspace/src/utils.ts",
        "typescript",
        "function myFunction() {}",
      );

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].name).toBe("myFunction");
      expect(result.nodes[0].type).toBe("function");
      expect(result.nodes[0].lang).toBe("typescript");
      expect(result.nodes[0].path).toBe("/mock/workspace/src/utils.ts");
      expect(result.edges).toHaveLength(0);
    });

    it("returns 1 node and 1 CALLS edge when captures include @def.class and @call", async () => {
      // The class node is reused as the `parent` of the call node so that
      // findEnclosingDefinitionId can walk up and find the enclosing definition.
      const classNode = {
        text: "MyClass",
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 10, column: 1 },
        parent: null,
        type: "class_declaration",
      };

      mockCapturesResult = [
        {
          name: "def.class",
          node: classNode,
        },
        {
          name: "call",
          node: {
            text: "doSomething",
            startPosition: { row: 3, column: 4 },
            endPosition: { row: 3, column: 15 },
            type: "identifier",
            // Parent is the class body — its position matches the def.class capture
            // so findEnclosingDefinitionId resolves the edge source correctly.
            parent: classNode,
          },
        },
      ];

      const result = await extractor.extractSource(
        "/mock/workspace/src/MyClass.ts",
        "typescript",
        "class MyClass { doSomething() {} }",
      );

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].name).toBe("MyClass");
      expect(result.nodes[0].type).toBe("class");

      expect(result.edges).toHaveLength(1);
      const edge = result.edges[0];
      expect(edge.typeRelation).toBe("CALLS");
      // doSomething is not in the node map → cross-file stub
      expect(edge.targetId).toBe("@@external:doSomething");
      // sourceId must reference the enclosing class definition
      expect(edge.sourceId).toContain("MyClass");
    });
  });

  // -------------------------------------------------------------------------
  // extractFile
  // -------------------------------------------------------------------------

  describe("extractFile", () => {
    it("reads the source file via fs.readFile and delegates to extractSource", async () => {
      const filePath = "/mock/workspace/src/hello.ts";
      const fileSource = "export function hello() {}";

      vi.mocked(fs.readFile).mockImplementation((p: unknown) => {
        const fp = typeof p === "string" ? p : (p as { toString(): string }).toString();
        if (fp.endsWith(".scm")) {
          // Return valid (non-empty) query so the extract pipeline runs
          return Promise.resolve("(identifier) @def.function") as unknown as ReturnType<
            typeof fs.readFile
          >;
        }
        if (fp === filePath) {
          return Promise.resolve(fileSource) as unknown as ReturnType<typeof fs.readFile>;
        }
        return Promise.resolve("") as unknown as ReturnType<typeof fs.readFile>;
      });

      mockCapturesResult = [
        {
          name: "def.function",
          node: {
            text: "hello",
            startPosition: { row: 0, column: 16 },
            endPosition: { row: 0, column: 21 },
            parent: null,
            type: "identifier",
          },
        },
      ];

      const result = await extractor.extractFile(filePath, "typescript");

      // fs.readFile must have been called with the source file path
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledWith(filePath, "utf8");

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].name).toBe("hello");
      expect(result.nodes[0].type).toBe("function");
      expect(result.edges).toHaveLength(0);
    });
  });
});
