/**
 * Tests for MCP Worker Helper Functions
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/shared/toon";
import {
  buildEdgeCounts,
  buildEdgeInfo,
  buildNodeInfo,
  convertSpiderToLspFormat,
  detectCircularDependencies,
  edgeOwners,
  fitToTokenBudget,
  getRelativePath,
  mapKindToLspNumber,
  updateNodeCounts,
  validateAnalysisInput,
  validateFileExists,
  validateScopePath,
} from "../../../src/mcp/shared/helpers";
import type { EdgeInfo, NodeInfo } from "../../../src/mcp/types";
import { normalizePath } from "../../../src/shared/path";

describe("MCP Worker Helpers", () => {
  describe("getRelativePath", () => {
    it("should return relative path from workspace root", () => {
      const absolutePath = "/Users/test/project/src/file.ts";
      const workspaceRoot = "/Users/test/project";
      expect(getRelativePath(absolutePath, workspaceRoot)).toBe("src/file.ts");
    });

    it("should normalize backslashes to forward slashes (cross-platform)", () => {
      // Test the normalization logic with a realistic relative path
        const absolutePath = "/Users/test/project/src\\subdir\\file.ts"; //NOSONAR
      const workspaceRoot = "/Users/test/project";
      const result = getRelativePath(absolutePath, workspaceRoot);
      // The path.relative will compute the relative path, and we normalize backslashes
      expect(result).not.toContain("\\");
      expect(result).toContain("/");
    });

    it("should redact paths outside workspace", () => {
      const absolutePath = "/Users/other/file.ts";
      const workspaceRoot = "/Users/test/project";
      expect(getRelativePath(absolutePath, workspaceRoot)).toBe("[external:file.ts]");
    });

    it("should redact an unrelated absolute path", () => {
      const absolutePath = "/absolute/path/file.ts";
      const workspaceRoot = "/Users/test/project";
      const result = getRelativePath(absolutePath, workspaceRoot);
      expect(result).toBe("[external:file.ts]");
    });
  });

  describe("buildEdgeCounts", () => {
    it("should count dependencies and dependents correctly", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "C" },
      ];

      const { dependencyCount, dependentCount } = buildEdgeCounts(edges);

      expect(dependencyCount.get("A")).toBe(2); // A depends on B, C
      expect(dependencyCount.get("B")).toBe(1); // B depends on C
      expect(dependentCount.get("B")).toBe(1); // B is depended on by A
      expect(dependentCount.get("C")).toBe(2); // C is depended on by A, B
    });

    it("should handle empty edges", () => {
      const { dependencyCount, dependentCount } = buildEdgeCounts([]);
      expect(dependencyCount.size).toBe(0);
      expect(dependentCount.size).toBe(0);
    });

    it("should handle self-references", () => {
      const edges = [{ source: "A", target: "A" }];
      const { dependencyCount, dependentCount } = buildEdgeCounts(edges);
      expect(dependencyCount.get("A")).toBe(1);
      expect(dependentCount.get("A")).toBe(1);
    });
  });

  describe("buildNodeInfo", () => {
    it("should build node info with correct counts and relative paths", () => {
      const nodePaths = ["/proj/src/a.ts", "/proj/src/b.ts"];
      const dependencyCount = new Map([
        ["/proj/src/a.ts", 2],
        ["/proj/src/b.ts", 0],
      ]);
      const dependentCount = new Map([
        ["/proj/src/a.ts", 0],
        ["/proj/src/b.ts", 1],
      ]);

      const nodes = buildNodeInfo(nodePaths, dependencyCount, dependentCount, "/proj");

      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toEqual({
        path: "/proj/src/a.ts",
        relativePath: "src/a.ts",
        extension: "ts",
        dependencyCount: 2,
        dependentCount: 0,
      });
      expect(nodes[1]).toEqual({
        path: "/proj/src/b.ts",
        relativePath: "src/b.ts",
        extension: "ts",
        dependencyCount: 0,
        dependentCount: 1,
      });
    });

    it("should handle missing counts gracefully", () => {
      const nodePaths = ["/proj/file.ts"];
      const nodes = buildNodeInfo(nodePaths, new Map(), new Map(), "/proj");
      expect(nodes[0].dependencyCount).toBe(0);
      expect(nodes[0].dependentCount).toBe(0);
    });

    it("should not include hubScore/communityId when metadata is undefined", () => {
      const nodePaths = [normalizePath("/proj/src/a.ts")];
      const nodes = buildNodeInfo(nodePaths, new Map(), new Map(), "/proj", undefined);
      expect(nodes[0]).not.toHaveProperty("hubScore");
      expect(nodes[0]).not.toHaveProperty("communityId");
    });

    it("should attach hubScore and communityId from metadata when present", () => {
      const nodePathA = normalizePath("/proj/src/a.ts");
      const nodePathB = normalizePath("/proj/src/b.ts");
      const nodePaths = [nodePathA, nodePathB];
      const metadata = {
        [nodePathA]: { hubScore: 0.9, communityId: 1 },
        [nodePathB]: { hubScore: 0.3, communityId: 2 },
      };

      const nodes = buildNodeInfo(nodePaths, new Map(), new Map(), "/proj", metadata);

      expect(nodes[0].hubScore).toBe(0.9);
      expect(nodes[0].communityId).toBe(1);
      expect(nodes[1].hubScore).toBe(0.3);
      expect(nodes[1].communityId).toBe(2);
    });

    it("should omit hubScore/communityId for nodes missing from metadata", () => {
      const nodePathA = normalizePath("/proj/src/a.ts");
      const nodePathB = normalizePath("/proj/src/b.ts");
      const nodePaths = [nodePathA, nodePathB];
      // Only nodePathA has metadata
      const metadata = {
        [nodePathA]: { hubScore: 0.5, communityId: 0 },
      };

      const nodes = buildNodeInfo(nodePaths, new Map(), new Map(), "/proj", metadata);

      expect(nodes[0].hubScore).toBe(0.5);
      expect(nodes[0].communityId).toBe(0);
      expect(nodes[1]).not.toHaveProperty("hubScore");
      expect(nodes[1]).not.toHaveProperty("communityId");
    });

    it("should lookup metadata using normalized nodePaths keys (Règle 03)", () => {
      // Simulate un chemin brut (backslash Windows-like) vs clé normalisée
      const rawPath = "/proj/src/a.ts";
      const normalizedKey = normalizePath(rawPath);
      const nodePaths = [normalizedKey];
      const metadata = {
        [normalizedKey]: { hubScore: 0.75, communityId: 3 },
      };

      const nodes = buildNodeInfo(nodePaths, new Map(), new Map(), "/proj", metadata);

      expect(nodes[0].hubScore).toBe(0.75);
      expect(nodes[0].communityId).toBe(3);
    });
  });

  describe("buildEdgeInfo", () => {
    it("should build edge info with relative paths", () => {
      const edges = [
        { source: "/proj/src/a.ts", target: "/proj/src/b.ts" },
        { source: "/proj/lib/x.ts", target: "/proj/lib/y.ts" },
      ];

      const edgeInfo = buildEdgeInfo(edges, "/proj");

      expect(edgeInfo).toHaveLength(2);
      expect(edgeInfo[0]).toEqual({
        source: "/proj/src/a.ts",
        target: "/proj/src/b.ts",
        sourceRelative: "src/a.ts",
        targetRelative: "src/b.ts",
      });
      expect(edgeInfo[1]).toEqual({
        source: "/proj/lib/x.ts",
        target: "/proj/lib/y.ts",
        sourceRelative: "lib/x.ts",
        targetRelative: "lib/y.ts",
      });
    });

    it("should handle empty edges", () => {
      const edgeInfo = buildEdgeInfo([], "/proj");
      expect(edgeInfo).toHaveLength(0);
    });
  });

  describe("updateNodeCounts", () => {
    it("should update node counts based on edges", () => {
      const nodes: NodeInfo[] = [
        {
          path: "A",
          relativePath: "A",
          extension: "ts",
          dependencyCount: 0,
          dependentCount: 0,
        },
        {
          path: "B",
          relativePath: "B",
          extension: "ts",
          dependencyCount: 0,
          dependentCount: 0,
        },
      ];

      const edges: EdgeInfo[] = [
        { source: "A", target: "B", sourceRelative: "A", targetRelative: "B" },
      ];

      updateNodeCounts(nodes, edges);

      expect(nodes[0].dependencyCount).toBe(1); // A depends on B
      expect(nodes[0].dependentCount).toBe(0);
      expect(nodes[1].dependencyCount).toBe(0);
      expect(nodes[1].dependentCount).toBe(1); // B is depended on by A
    });
  });

  describe("edgeOwners", () => {
    it("gives each edge the page of its later listed end", () => {
      const owners = edgeOwners(
        ["A", "B", "C"],
        [
          { source: "A", target: "B" },
          { source: "C", target: "A" },
          { source: "B", target: "external" },
        ],
      );

      expect(owners).toEqual([1, 2, 1]);
    });

    it("puts an edge with no listed end on the first page", () => {
      expect(edgeOwners(["A"], [{ source: "X", target: "Y" }])).toEqual([0]);
    });

    it("matches Windows-style raw edge paths to normalized node paths", () => {
      const owners = edgeOwners(
        ["c:/repo/a.ts", "c:/repo/b.ts"],
        [{ source: String.raw`C:\repo\b.ts`, target: String.raw`C:\repo\a.ts` }],
      );

      expect(owners).toEqual([1]);
    });
  });

  describe("detectCircularDependencies", () => {
    it("should detect simple cycle", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
        { source: "C", target: "A" }, // Cycle: A -> B -> C -> A
      ];

      const cycles = detectCircularDependencies(edges);

      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toEqual(["A", "B", "C", "A"]);
    });

    it("should detect self-loop", () => {
      const edges = [{ source: "A", target: "A" }];
      const cycles = detectCircularDependencies(edges);

      expect(cycles).toHaveLength(1);
      expect(cycles[0]).toEqual(["A", "A"]);
    });

    it("should detect multiple cycles", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "B", target: "A" }, // Cycle 1: A -> B -> A
        { source: "C", target: "D" },
        { source: "D", target: "C" }, // Cycle 2: C -> D -> C
      ];

      const cycles = detectCircularDependencies(edges);

      expect(cycles.length).toBeGreaterThanOrEqual(2);
    });

    it("should return empty array for acyclic graph", () => {
      const edges = [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ];

      const cycles = detectCircularDependencies(edges);
      expect(cycles).toHaveLength(0);
    });

    it("should handle empty graph", () => {
      const cycles = detectCircularDependencies([]);
      expect(cycles).toHaveLength(0);
    });

    it("should handle a deeply nested acyclic graph without overflowing the stack", () => {
      const edges = Array.from({ length: 10_000 }, (_, index) => ({
        source: `node-${index}`,
        target: `node-${index + 1}`,
      }));

      expect(detectCircularDependencies(edges)).toEqual([]);
    });
  });

  describe("validateFileExists", () => {
    let tempFile: string;

    beforeEach(async () => {
      // Create a temporary file for testing
      const tmpDir = os.tmpdir();
      tempFile = path.join(tmpDir, `test-${Date.now()}.txt`);
      await fs.writeFile(tempFile, "test content");
    });

    afterEach(async () => {
      // Cleanup
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should pass for existing file", async () => {
      await expect(validateFileExists(tempFile)).resolves.toBeUndefined();
    });

    it("should throw for non-existent file", async () => {
      await expect(validateFileExists("/nonexistent/file.txt")).rejects.toThrow(
        "File not found",
      );
    });

    it("should throw for directory", async () => {
      const tmpDir = os.tmpdir();
      await expect(validateFileExists(tmpDir)).rejects.toThrow("Path is not a file");
    });
  });

  describe("validateAnalysisInput", () => {
    let tempFile: string;

    beforeEach(async () => {
      const tmpDir = os.tmpdir();
      tempFile = path.join(tmpDir, `test-${Date.now()}.ts`);
      await fs.writeFile(tempFile, "const x = 1;");
    });

    afterEach(async () => {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore
      }
    });

    it("should validate supported TypeScript file", async () => {
      const result = await validateAnalysisInput(tempFile);
      expect(result.ext).toBe(".ts");
      expect(result.language).toBe("typescript");
    });

    it("should throw for relative path", async () => {
      await expect(validateAnalysisInput("relative/path.ts")).rejects.toThrow(
        "Path must be absolute",
      );
    });

    it("should throw for non-existent file", async () => {
      await expect(
        validateAnalysisInput("/nonexistent/file.ts"),
      ).rejects.toThrow("FILE_NOT_FOUND");
    });

    it("should throw for unsupported extension", async () => {
      const unsupportedFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
      await fs.writeFile(unsupportedFile, "test");

      await expect(validateAnalysisInput(unsupportedFile)).rejects.toThrow(
        "UNSUPPORTED_FILE_TYPE",
      );

      await fs.unlink(unsupportedFile);
    });
  });

  describe("mapKindToLspNumber", () => {
    it("should map functions to 12 and methods to 6", () => {
      expect(mapKindToLspNumber("function")).toBe(12);
      expect(mapKindToLspNumber("FUNCTION")).toBe(12); // Case insensitive
      expect(mapKindToLspNumber("method")).toBe(6);
    });

    it("should map the AST kind names emitted by Spider", () => {
      expect(mapKindToLspNumber("FunctionDeclaration")).toBe(12);
      expect(mapKindToLspNumber("AsyncFunction")).toBe(12);
      expect(mapKindToLspNumber("ArrowFunction")).toBe(12);
      expect(mapKindToLspNumber("MethodDeclaration")).toBe(6);
      expect(mapKindToLspNumber("StaticMethodDeclaration")).toBe(6);
      expect(mapKindToLspNumber("GetAccessor")).toBe(6);
      expect(mapKindToLspNumber("SetAccessor")).toBe(6);
      expect(mapKindToLspNumber("Constructor")).toBe(9);
      expect(mapKindToLspNumber("ClassDeclaration")).toBe(5);
      expect(mapKindToLspNumber("StructDeclaration")).toBe(5);
      expect(mapKindToLspNumber("InterfaceDeclaration")).toBe(11);
      expect(mapKindToLspNumber("TypeAliasDeclaration")).toBe(11);
      expect(mapKindToLspNumber("EnumDeclaration")).toBe(10);
      expect(mapKindToLspNumber("PropertyDeclaration")).toBe(7);
      expect(mapKindToLspNumber("StaticPropertyDeclaration")).toBe(7);
      expect(mapKindToLspNumber("VariableDeclaration")).toBe(13);
    });

    it("should map class to 5", () => {
      expect(mapKindToLspNumber("class")).toBe(5);
      expect(mapKindToLspNumber("CLASS")).toBe(5);
    });

    it("should map variables to 13 and properties to 7", () => {
      expect(mapKindToLspNumber("variable")).toBe(13);
      expect(mapKindToLspNumber("property")).toBe(7);
    });

    it("should map interface to 11", () => {
      expect(mapKindToLspNumber("interface")).toBe(11);
    });

    it("should default unknown kinds to 13 (variable)", () => {
      expect(mapKindToLspNumber("unknown")).toBe(13);
      expect(mapKindToLspNumber("")).toBe(13);
    });
  });

  describe("convertSpiderToLspFormat", () => {
    it("should convert Spider symbols to LSP format", () => {
      const symbolGraphData = {
        symbols: [
          { name: "myFunction", kind: "function", line: 10, parentSymbolId: undefined },
          { name: "MyClass", kind: "class", line: 20, parentSymbolId: undefined },
        ],
        dependencies: [
          { sourceSymbolId: "myFunction", targetSymbolId: "MyClass" },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");
      const normalizedFilePath = normalizePath("/test/file.ts");

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]).toEqual({
        name: "myFunction",
        kind: 12, // Function
        range: { start: 10, end: 10 },
        containerName: undefined,
        uri: normalizedFilePath,
      });

      expect(result.callHierarchyItems.size).toBe(2);
      expect(result.outgoingCalls.get(`${normalizedFilePath}:myFunction`)).toHaveLength(1);
    });

    it("should use end lines, call-site lines and the target symbol range", () => {
      const symbolGraphData = {
        symbols: [
          { name: "caller", kind: "FunctionDeclaration", line: 3, endLine: 9 },
          { name: "callee", kind: "FunctionDeclaration", line: 11, endLine: 14 },
        ],
        dependencies: [
          { sourceSymbolId: "/test/file.ts:caller", targetSymbolId: "/test/file.ts:callee", line: 7 },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");
      const normalizedFilePath = normalizePath("/test/file.ts");

      expect(result.symbols[0].range).toEqual({ start: 3, end: 9 });
      const calls = result.outgoingCalls.get(`${normalizedFilePath}:caller`);
      expect(calls?.[0].fromRanges).toEqual([{ start: 7, end: 7 }]);
      expect(calls?.[0].to.kind).toBe(12);
      expect(calls?.[0].to.range).toEqual({ start: 11, end: 14 });
    });

    it("should fall back to line 0 and the Function kind when call data is missing", () => {
      const symbolGraphData = {
        symbols: [{ name: "caller", kind: "FunctionDeclaration", line: 3 }],
        dependencies: [
          { sourceSymbolId: "/test/file.ts:caller", targetSymbolId: "/other.ts:external" },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");
      const normalizedFilePath = normalizePath("/test/file.ts");

      expect(result.symbols[0].range).toEqual({ start: 3, end: 3 });
      const calls = result.outgoingCalls.get(`${normalizedFilePath}:caller`);
      expect(calls?.[0].fromRanges).toEqual([{ start: 0, end: 0 }]);
      expect(calls?.[0].to.kind).toBe(12);
      expect(calls?.[0].to.range).toEqual({ start: 0, end: 0 });
    });

    it("should handle symbol IDs with colon separator", () => {
      const symbolGraphData = {
        symbols: [{ name: "caller", kind: "function", line: 5, parentSymbolId: undefined }],
        dependencies: [
          { sourceSymbolId: "caller", targetSymbolId: "/path/to/file.ts:callee" },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");
      const normalizedFilePath = normalizePath("/test/file.ts");

      const calls = result.outgoingCalls.get(`${normalizedFilePath}:caller`);
      expect(calls).toBeDefined();
      expect(calls?.[0].to.name).toBe("callee"); // Should extract only the symbol name
    });

    it("should handle empty symbol graph", () => {
      const symbolGraphData = { symbols: [], dependencies: [] };
      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");

      expect(result.symbols).toHaveLength(0);
      expect(result.callHierarchyItems.size).toBe(0);
      expect(result.outgoingCalls.size).toBe(0);
    });

    it("should not double-qualify class member names via containerName", () => {
      // Spider provides fully-qualified names like "MyClass.calculate"
      // containerName must be undefined so generateSymbolId doesn't produce
      // "path:MyClass.calculate.MyClass.calculate"
      const symbolGraphData = {
        symbols: [
          { name: "MyClass", kind: "class", line: 1, parentSymbolId: undefined },
          { name: "MyClass.calculate", kind: "method", line: 5, parentSymbolId: "/test/file.ts:MyClass" },
          { name: "MyClass.helper", kind: "method", line: 10, parentSymbolId: "/test/file.ts:MyClass" },
        ],
        dependencies: [
          { sourceSymbolId: "/test/file.ts:MyClass.calculate", targetSymbolId: "/test/file.ts:MyClass.helper" },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");
      const normalizedFilePath = normalizePath("/test/file.ts");

      // All symbols must have containerName=undefined
      for (const sym of result.symbols) {
        expect(sym.containerName).toBeUndefined();
      }

      // Outgoing calls key must use the simple name format: "path:MyClass.calculate"
      const callsKey = `${normalizedFilePath}:MyClass.calculate`;
      const calls = result.outgoingCalls.get(callsKey);
      expect(calls).toBeDefined();
      expect(calls).toHaveLength(1);
      expect(calls?.[0].to.name).toBe("MyClass.helper");
    });
  });

  describe("validateScopePath", () => {
    const root = "/workspace/project";

    it("should pass when scopePath equals rootDir", () => {
      expect(() => validateScopePath(root, root)).not.toThrow();
    });

    it("should pass when scopePath is a subdirectory of rootDir", () => {
      expect(() => validateScopePath(`${root}/src`, root)).not.toThrow();
      expect(() => validateScopePath(`${root}/src/utils`, root)).not.toThrow();
    });

    it("should throw when scopePath contains null bytes", () => {
      expect(() => validateScopePath(`${root}/\0evil`, root)).toThrow(
        "INVALID_SCOPE_PATH: Path contains null bytes",
      );
    });

    it("should throw when scopePath is not absolute", () => {
      expect(() => validateScopePath("relative/path", root)).toThrow(
        "INVALID_SCOPE_PATH: Scope path must be absolute",
      );
    });

    it("should throw when scopePath is outside rootDir (traversal attempt)", () => {
      expect(() => validateScopePath("/workspace/other", root)).toThrow(
        "INVALID_SCOPE_PATH: Scope path",
      );
    });

    it("should throw for path traversal via .. segments", () => {
      expect(() => validateScopePath(`${root}/../outside`, root)).toThrow(
        "INVALID_SCOPE_PATH:",
      );
    });

    it("should reject paths that share a prefix but are not subdirectories", () => {
      // /workspace/project-evil should NOT be accepted as subdirectory of /workspace/project
      expect(() => validateScopePath(`${root}-evil`, root)).toThrow(
        "INVALID_SCOPE_PATH:",
      );
    });
  });

  describe("fitToTokenBudget", () => {
    const build = (keptCount: number) => ({ items: Array.from({ length: keptCount }, (_, i) => `item-${i}`) });

    it("keeps every item when the full result fits", () => {
      const { result, keptCount } = fitToTokenBudget(5, 500, build);

      expect(keptCount).toBe(5);
      expect(result.items).toHaveLength(5);
    });

    it("keeps the largest prefix that fits the budget", () => {
      const { result, keptCount } = fitToTokenBudget(1_000, 500, build);

      expect(keptCount).toBeGreaterThan(0);
      expect(keptCount).toBeLessThan(1_000);
      expect(estimateTokens(JSON.stringify(result))).toBeLessThanOrEqual(500);
      expect(estimateTokens(JSON.stringify(build(keptCount + 1)))).toBeGreaterThan(500);
    });

    it("throws when not even one item fits, so a caller never loops on the same offset", () => {
      expect(() => fitToTokenBudget(3, 1, build)).toThrow(RangeError);
    });

    it("returns an empty result as is when there is nothing to cut", () => {
      expect(fitToTokenBudget(0, 1, build).keptCount).toBe(0);
    });
  });
});
