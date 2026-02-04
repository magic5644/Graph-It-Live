/**
 * Tests for MCP Worker Helper Functions
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  applyPagination,
  buildEdgeCounts,
  buildEdgeInfo,
  buildNodeInfo,
  convertSpiderToLspFormat,
  detectCircularDependencies,
  getRelativePath,
  mapKindToLspNumber,
  updateNodeCounts,
  validateAnalysisInput,
  validateFileExists,
} from "@/mcp/shared/helpers";
import type { EdgeInfo, NodeInfo } from "@/mcp/types";

describe("MCP Worker Helpers", () => {
  describe("getRelativePath", () => {
    it("should return relative path from workspace root", () => {
      const absolutePath = "/Users/test/project/src/file.ts";
      const workspaceRoot = "/Users/test/project";
      expect(getRelativePath(absolutePath, workspaceRoot)).toBe("src/file.ts");
    });

    it("should normalize backslashes to forward slashes (cross-platform)", () => {
      // Test the normalization logic with a realistic relative path
      const absolutePath = "/Users/test/project/src\\subdir\\file.ts";
      const workspaceRoot = "/Users/test/project";
      const result = getRelativePath(absolutePath, workspaceRoot);
      // The path.relative will compute the relative path, and we normalize backslashes
      expect(result).not.toContain("\\");
      expect(result).toContain("/");
    });

    it("should return absolute path if outside workspace", () => {
      const absolutePath = "/Users/other/file.ts";
      const workspaceRoot = "/Users/test/project";
      expect(getRelativePath(absolutePath, workspaceRoot)).toBe(absolutePath);
    });

    it("should return absolute path if already absolute and no relative calc possible", () => {
      const absolutePath = "/absolute/path/file.ts";
      const workspaceRoot = "/Users/test/project";
      const result = getRelativePath(absolutePath, workspaceRoot);
      expect(result).toBe(absolutePath);
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

  describe("applyPagination", () => {
    let nodes: NodeInfo[];
    let edges: EdgeInfo[];

    beforeEach(() => {
      nodes = [
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
        {
          path: "C",
          relativePath: "C",
          extension: "ts",
          dependencyCount: 0,
          dependentCount: 0,
        },
      ];

      edges = [
        { source: "A", target: "B", sourceRelative: "A", targetRelative: "B" },
        { source: "B", target: "C", sourceRelative: "B", targetRelative: "C" },
      ];
    });

    it("should paginate nodes and filter edges correctly", () => {
      const { nodes: paginatedNodes, edges: paginatedEdges } = applyPagination(
        nodes,
        edges,
        2,
        0,
      );

      expect(paginatedNodes).toHaveLength(2);
      expect(paginatedNodes[0].path).toBe("A");
      expect(paginatedNodes[1].path).toBe("B");
      expect(paginatedEdges).toHaveLength(1); // Only A->B edge (both nodes present)
      expect(paginatedEdges[0].source).toBe("A");
    });

    it("should handle offset pagination", () => {
      const { nodes: paginatedNodes, edges: paginatedEdges } = applyPagination(
        nodes,
        edges,
        2,
        1,
      );

      expect(paginatedNodes).toHaveLength(2);
      expect(paginatedNodes[0].path).toBe("B");
      expect(paginatedNodes[1].path).toBe("C");
      expect(paginatedEdges).toHaveLength(1); // Only B->C edge
    });

    it("should return all nodes when no limit specified", () => {
      const { nodes: paginatedNodes, edges: paginatedEdges } = applyPagination(
        nodes,
        edges,
        undefined,
        0,
      );

      expect(paginatedNodes).toHaveLength(3);
      expect(paginatedEdges).toHaveLength(2);
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
    it("should map function/method to 12", () => {
      expect(mapKindToLspNumber("function")).toBe(12);
      expect(mapKindToLspNumber("method")).toBe(12);
      expect(mapKindToLspNumber("FUNCTION")).toBe(12); // Case insensitive
    });

    it("should map class to 5", () => {
      expect(mapKindToLspNumber("class")).toBe(5);
      expect(mapKindToLspNumber("CLASS")).toBe(5);
    });

    it("should map variable/property to 13", () => {
      expect(mapKindToLspNumber("variable")).toBe(13);
      expect(mapKindToLspNumber("property")).toBe(13);
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

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]).toEqual({
        name: "myFunction",
        kind: 12, // Function
        range: { start: 10, end: 10 },
        containerName: undefined,
        uri: "/test/file.ts",
      });

      expect(result.callHierarchyItems.size).toBe(2);
      expect(result.outgoingCalls.get("myFunction")).toHaveLength(1);
    });

    it("should handle symbol IDs with colon separator", () => {
      const symbolGraphData = {
        symbols: [{ name: "caller", kind: "function", line: 5, parentSymbolId: undefined }],
        dependencies: [
          { sourceSymbolId: "caller", targetSymbolId: "/path/to/file.ts:callee" },
        ],
      };

      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");

      const calls = result.outgoingCalls.get("caller");
      expect(calls).toBeDefined();
      expect(calls![0].to.name).toBe("callee"); // Should extract only the symbol name
    });

    it("should handle empty symbol graph", () => {
      const symbolGraphData = { symbols: [], dependencies: [] };
      const result = convertSpiderToLspFormat(symbolGraphData, "/test/file.ts");

      expect(result.symbols).toHaveLength(0);
      expect(result.callHierarchyItems.size).toBe(0);
      expect(result.outgoingCalls.size).toBe(0);
    });
  });
});
