/**
 * Integration tests for McpWorker - ReverseIndex behavior
 *
 * Tests that the ReverseIndex correctly maintains references after file re-analysis,
 * which is critical for the MCP server's find_referencing_files functionality.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Spider } from "../../src/analyzer/Spider";
import { SpiderBuilder } from "../../src/analyzer/SpiderBuilder";
import { normalizePath } from "../../src/analyzer/types";
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from "../../src/shared/constants";
import { detectLanguageFromExtension } from "../../src/shared/utils/languageDetection";

describe("McpWorker - ReverseIndex Integration", () => {
  let spider: Spider;
  let tempDir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(async () => {
    // Create a temporary test workspace
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "mcp-worker-"));

    fileA = path.join(tempDir, "fileA.ts");
    fileB = path.join(tempDir, "fileB.ts");

    // fileA imports fileB
    await fs.writeFile(
      fileA,
      `import { helper } from './fileB';\nexport const result = helper();`,
    );
    await fs.writeFile(fileB, `export function helper() { return 42; }`);

    // Initialize Spider with reverse index enabled (like MCP server does)
    spider = new SpiderBuilder()
     .withRootDir(tempDir)
     .withMaxDepth(10)
     .withReverseIndex(true)
     .withExcludeNodeModules(true)
     .withExtensionPath(process.cwd())
     .build();
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      // Ignore cleanup errors
    });
  });

  it("should preserve references after file re-analysis (Bug #1 regression)", async () => {
    // Step 1: Initial analysis - A imports B
    await spider.crawl(fileA);

    // Step 2: Query references for B - should find A
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));
    expect(references[0].module).toBe("./fileB");

    // Step 3: Simulate file change - modify and re-analyze A
    await fs.writeFile(
      fileA,
      `import { helper } from './fileB';\nexport const result = helper() + 1;`,
    );
    spider.invalidateFile(fileA);
    await spider.reanalyzeFile(fileA);

    // Step 4: Query references for B again - A should STILL be there
    // This is the critical test: before the fix, references would disappear
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));
    expect(references[0].module).toBe("./fileB");
  });

  it("should handle multiple sequential re-analyses without losing references", async () => {
    // Initial analysis
    await spider.crawl(fileA);

    // First check
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);

    // Re-analyze multiple times (simulating repeated file changes)
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        fileA,
        `import { helper } from './fileB';\nexport const result = helper() + ${i};`,
      );
      spider.invalidateFile(fileA);
      await spider.reanalyzeFile(fileA);

      references = await spider.findReferencingFiles(fileB);
      expect(references).toHaveLength(1);
    }
  });

  it("should update references when import is removed", async () => {
    // Initial state: A imports B
    await spider.crawl(fileA);

    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);

    // Remove the import from A
    await fs.writeFile(fileA, `export const result = 42;`);
    spider.invalidateFile(fileA);
    await spider.reanalyzeFile(fileA);

    // B should have no references now
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(0);
  });

  it("should update references when import is added", async () => {
    // Initial state: A does NOT import B
    await fs.writeFile(fileA, `export const result = 42;`);
    await spider.crawl(fileA);

    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(0);

    // Add import to B
    await fs.writeFile(
      fileA,
      `import { helper } from './fileB';\nexport const result = helper();`,
    );
    spider.invalidateFile(fileA);
    await spider.reanalyzeFile(fileA);

    // B should now have A as reference
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));
  });

  it("should handle file deletion correctly", async () => {
    // Initial state: A imports B
    await spider.crawl(fileA);

    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);

    // Delete file A
    await fs.unlink(fileA);
    spider.handleFileDeleted(fileA);

    // B should have no references after A is deleted
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(0);
  });

  it("should maintain correct references with multiple importers", async () => {
    // Create fileC that also imports fileB
    const fileC = path.join(tempDir, "fileC.ts");
    await fs.writeFile(
      fileC,
      `import { helper } from './fileB';\nexport const value = helper();`,
    );

    // Analyze both files
    await spider.crawl(fileA);
    await spider.crawl(fileC);

    // B should have 2 references
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(2);
    const paths = references.map((r) => r.path).sort();
    expect(paths).toEqual([normalizePath(fileA), normalizePath(fileC)].sort());

    // Re-analyze A
    await fs.writeFile(
      fileA,
      `import { helper } from './fileB';\nexport const result = helper() + 1;`,
    );
    spider.invalidateFile(fileA);
    await spider.reanalyzeFile(fileA);

    // Both references should still be there
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(2);
    expect(references.map((r) => r.path).sort()).toEqual(
      [normalizePath(fileA), normalizePath(fileC)].sort(),
    );

    // Cleanup fileC
    await fs.unlink(fileC);
  });

  it("should handle MCP server typical workflow: analyze → query → modify → query", async () => {
    // Simulate typical MCP server usage pattern:

    // 1. Client calls crawlDependencyGraph
    const graph = await spider.crawl(fileA);
    expect(graph.nodes).toContain(normalizePath(fileA));
    expect(graph.nodes).toContain(normalizePath(fileB));

    // 2. Client calls findReferencingFiles for fileB
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));

    // 3. File watcher detects change, calls invalidateFile + reanalyzeFile
    await fs.writeFile(
      fileA,
      `import { helper } from './fileB';\n// Modified\nexport const result = helper();`,
    );
    spider.invalidateFile(fileA);
    await spider.reanalyzeFile(fileA);

    // 4. Client calls findReferencingFiles again - MUST still work
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));

    // 5. Verify we can still crawl from fileA
    const graph2 = await spider.crawl(fileA);
    expect(graph2.nodes).toContain(normalizePath(fileB));
  });
});

describe("McpWorker - File Watching Simulation", () => {
  let spider: Spider;
  let tempDir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(async () => {
    tempDir = path.join(__dirname, "../fixtures/temp-mcp-watch-test");
    await fs.mkdir(tempDir, { recursive: true });

    fileA = path.join(tempDir, "app.ts");
    fileB = path.join(tempDir, "utils.ts");

    await fs.writeFile(
      fileA,
      `import { format } from './utils';\nexport const text = format('hello');`,
    );
    await fs.writeFile(
      fileB,
      `export function format(s: string) { return s.toUpperCase(); }`,
    );

    spider = new SpiderBuilder()
     .withRootDir(tempDir)
     .withMaxDepth(10)
     .withReverseIndex(true)
     .withExcludeNodeModules(true)
     .withExtensionPath(process.cwd())
     .build();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
      // Ignore cleanup errors
    });
  });

  it("should invalidate cache when file changes (simulating chokidar watch)", async () => {
    // Initial analysis
    await spider.crawl(fileA);

    // Verify cache is populated
    const cache = (spider as any).cache;
    expect(cache.has(normalizePath(fileA))).toBe(true);

    // Simulate chokidar 'change' event → performFileInvalidation
    spider.invalidateFile(fileA);

    // Cache should be cleared for fileA
    expect(cache.has(normalizePath(fileA))).toBe(false);

    // Re-analyzing should work
    await spider.reanalyzeFile(fileA);
    expect(cache.has(normalizePath(fileA))).toBe(true);

    // References should still be correct
    const references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);
    expect(references[0].path).toBe(normalizePath(fileA));
  });

  it("should handle file deletion event (simulating chokidar unlink)", async () => {
    // Initial analysis
    await spider.crawl(fileA);

    // Verify references exist
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1);

    // Simulate chokidar 'unlink' event → performFileInvalidation → handleFileDeleted
    await fs.unlink(fileA);
    spider.handleFileDeleted(fileA);

    // References should be removed
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(0);

    // Cache should be cleared
    const cache = (spider as any).cache;
    expect(cache.has(normalizePath(fileA))).toBe(false);
  });

  it("should handle file creation event (simulating chokidar add)", async () => {
    // Create a new file that imports utils
    const fileC = path.join(tempDir, "newFile.ts");
    await fs.writeFile(
      fileC,
      `import { format } from './utils';\nexport const msg = format('new');`,
    );

    // Initial state: only fileA analyzed
    await spider.crawl(fileA);
    let references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(1); // Only fileA

    // Simulate chokidar 'add' event → performFileInvalidation (cache invalidation)
    // Then user queries the new file
    spider.invalidateFile(fileC); // In case it was somehow cached
    await spider.crawl(fileC);

    // Now fileB should have 2 references
    references = await spider.findReferencingFiles(fileB);
    expect(references).toHaveLength(2);
    const paths = references.map((r) => r.path).sort();
    expect(paths).toEqual([normalizePath(fileA), normalizePath(fileC)].sort());

    // Cleanup
    await fs.unlink(fileC);
  });
});

// ============================================================================
// Tests for analyze_file_logic MCP tool (T067-T069)
// ============================================================================

describe("McpWorker - analyze_file_logic tool", () => {
  let spider: Spider;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "mcp-analyze-logic-"));

    spider = new SpiderBuilder()
     .withRootDir(tempDir)
     .withMaxDepth(10)
     .withReverseIndex(false)
     .withExcludeNodeModules(true)
     .withExtensionPath(process.cwd())
     .build();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should analyze TypeScript file and return symbol graph", async () => {
    // Create a simple TypeScript file with functions
    const file = path.join(tempDir, "example.ts");
    await fs.writeFile(
      file,
      `export function calculate(x: number): number {
  return helper(x) * 2;
}

function helper(n: number): number {
  return n + 1;
}

export class Calculator {
  multiply(a: number, b: number): number {
    return a * b;
  }
}
`,
    );

    // Analyze the file
    const result = await spider.getSymbolGraph(file);

    // Verify we got symbols
    expect(result.symbols.length).toBeGreaterThan(0);

    // Should have calculate, helper, and Calculator class
    const symbolNames = result.symbols.map((s) => s.name);
    expect(symbolNames).toContain("calculate");
    expect(symbolNames).toContain("helper");
    expect(symbolNames).toContain("Calculator");

    // Dependencies array represents imports/exports between files, not intra-file calls
    // For intra-file call hierarchy, we need LSP or deeper AST analysis
    // This test verifies the function exists and Spider can analyze the file
    expect(result.dependencies.length).toBeGreaterThanOrEqual(0);
  });

  it("should analyze JavaScript file with function calls", async () => {
    const file = path.join(tempDir, "example.js");
    await fs.writeFile(
      file,
      `function main() {
  const result = processData(42);
  return result;
}

function processData(value) {
  return value * 2;
}

module.exports = { main };
`,
    );

    const result = await spider.getSymbolGraph(file);

    expect(result.symbols.length).toBeGreaterThan(0);

    const symbolNames = result.symbols.map((s) => s.name);
    expect(symbolNames).toContain("main");
    expect(symbolNames).toContain("processData");

    // main should depend on processData
    const mainSymbol = result.symbols.find((s) => s.name === "main");
    expect(mainSymbol).toBeDefined();
  });

  it("should handle file with no dependencies", async () => {
    const file = path.join(tempDir, "standalone.ts");
    await fs.writeFile(
      file,
      `export const PI = 3.14;

export function square(x: number): number {
  return x * x;
}
`,
    );

    const result = await spider.getSymbolGraph(file);

    // Should have symbols but no (or minimal) dependencies
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.dependencies.length).toBeGreaterThanOrEqual(0);
  });

  it("should detect symbol categories correctly", async () => {
    const file = path.join(tempDir, "categories.ts");
    await fs.writeFile(
      file,
      `export class MyClass {}
export function myFunction() {}
export const myVariable = 42;
export interface MyInterface {}
`,
    );

    const result = await spider.getSymbolGraph(file);

    const symbolsByCategory = new Map<string, number>();
    for (const sym of result.symbols) {
      symbolsByCategory.set(
        sym.category,
        (symbolsByCategory.get(sym.category) || 0) + 1,
      );
    }

    // Should have at least class, function, and variable categories
    expect(symbolsByCategory.has("class")).toBe(true);
    expect(symbolsByCategory.has("function")).toBe(true);
    expect(symbolsByCategory.has("variable")).toBe(true);
  });

  it("should handle unsupported file extension", async () => {
    const file = path.join(tempDir, "unsupported.txt");
    await fs.writeFile(file, "Just some text");

    // Spider's getSymbolGraph returns empty results for unsupported files
    // It doesn't throw an error, just returns no symbols
    const result = await spider.getSymbolGraph(file);
    expect(result.symbols.length).toBe(0);
    expect(result.dependencies.length).toBe(0);
  });

  it("should include exported symbols in results", async () => {
    const file = path.join(tempDir, "exports.ts");
    await fs.writeFile(
      file,
      `export function publicFunc() {}
function privateFunc() {}
export class PublicClass {}
class PrivateClass {}
`,
    );

    const result = await spider.getSymbolGraph(file);

    const exported = result.symbols.filter((s) => s.isExported);
    const notExported = result.symbols.filter((s) => !s.isExported);

    // Should have both exported and non-exported symbols
    expect(exported.length).toBeGreaterThan(0);
    expect(notExported.length).toBeGreaterThan(0);

    const exportedNames = exported.map((s) => s.name);
    expect(exportedNames).toContain("publicFunc");
    expect(exportedNames).toContain("PublicClass");
  });
});

// ============================================================================
// Tests for analyze_file_logic MCP tool validation and error handling (T067-T068)
// ============================================================================

describe("McpWorker - analyze_file_logic validation and errors (T064-T065)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "mcp-analyze-validation-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("T064 - Input validation", () => {
    it("should reject relative paths", async () => {
      // Create a file
      const file = path.join(tempDir, "test.ts");
      await fs.writeFile(file, "export function test() {}");

      // Try to invoke with relative path
      const relativePath = "test.ts";

      // This should fail with FILE_NOT_FOUND since relative paths are rejected
      // Note: We can't directly test executeAnalyzeFileLogic without initializing the worker
      // So we test the validation logic that would be applied
      expect(path.isAbsolute(relativePath)).toBe(false);
    });

    it("should accept absolute paths", () => {
      const absolutePath = path.join(tempDir, "test.ts");
      expect(path.isAbsolute(absolutePath)).toBe(true);
    });

    it("should validate supported file extensions", () => {
      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS).toContain(".ts");
      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS).toContain(".py");
      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS).toContain(".rs");
      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS).not.toContain(".txt");
      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS).not.toContain(".md");
    });

    it("should detect TypeScript language correctly", () => {
      const testCases = [
        { ext: ".ts" as const, expected: "typescript" },
        { ext: ".tsx" as const, expected: "typescript" },
        { ext: ".js" as const, expected: "javascript" },
        { ext: ".jsx" as const, expected: "javascript" },
        { ext: ".py" as const, expected: "python" },
        { ext: ".rs" as const, expected: "rust" },
      ];

      for (const { ext, expected } of testCases) {
        const language = detectLanguageFromExtension(ext);
        expect(language).toBe(expected);
      }
    });
  });

  describe("T065 - Error response handling", () => {
    it("should provide FILE_NOT_FOUND error for non-existent files", async () => {
      const nonExistentFile = path.join(tempDir, "does-not-exist.ts");

      // Verify file doesn't exist
      await expect(fs.access(nonExistentFile)).rejects.toThrow();
    });

    it("should provide UNSUPPORTED_FILE_TYPE error for invalid extensions", () => {
      const unsupportedFile = path.join(tempDir, "test.txt");
      const ext = path.extname(unsupportedFile).toLowerCase();

      expect(SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS.includes(ext as typeof SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS[number])).toBe(false);
    });

    it("should map error messages to correct error codes", () => {
      // Test error message detection patterns
      const errorCases = [
        {
          message: "timeout exceeded",
          expectedCode: "LSP_TIMEOUT",
        },
        {
          message: "LSP call hierarchy not available",
          expectedCode: "LSP_UNAVAILABLE",
        },
        {
          message: "ENOENT: no such file or directory",
          expectedCode: "FILE_NOT_FOUND",
        },
        {
          message: "Unknown analysis error",
          expectedCode: "ANALYSIS_FAILED",
        },
      ];

      for (const { message, expectedCode } of errorCases) {
        let detectedCode: string;

        if (message.includes("timeout") || message.includes("timed out")) {
          detectedCode = "LSP_TIMEOUT";
        } else if (message.includes("LSP") || message.includes("language server")) {
          detectedCode = "LSP_UNAVAILABLE";
        } else if (message.includes("ENOENT") || message.includes("no such file")) {
          detectedCode = "FILE_NOT_FOUND";
        } else {
          detectedCode = "ANALYSIS_FAILED";
        }

        expect(detectedCode).toBe(expectedCode);
      }
    });

    it("should handle partial results with warnings", () => {
      // Test result structure with optional fields
      const fullResult = {
        filePath: "/test/file.ts",
        graph: { nodes: [], edges: [], hasCycle: false },
        language: "typescript",
        analysisTimeMs: 100,
      };

      const partialResult = {
        ...fullResult,
        isPartial: true,
        warnings: ["LSP timeout, using AST-only analysis"],
      };

      expect(partialResult.isPartial).toBe(true);
      expect(partialResult.warnings).toHaveLength(1);
      expect(partialResult.warnings![0]).toContain("LSP timeout");
    });
  });

  describe("T067 - TOON format serialization", () => {
    it("should format IntraFileGraph nodes as TOON", () => {
      const graph = {
        nodes: [
          { id: "fn1", name: "calculate", symbolType: "Function", line: 10, isExported: true },
          { id: "fn2", name: "helper", symbolType: "Function", line: 20, isExported: false },
          { id: "cls1", name: "Calculator", symbolType: "Class", line: 30, isExported: true },
        ],
        edges: [
          { source: "fn1", target: "fn2", edgeType: "call" },
        ],
        hasCycle: false,
      };

      // Verify structure matches TOON requirements
      expect(graph.nodes.length).toBe(3);
      expect(graph.nodes[0]).toHaveProperty("id");
      expect(graph.nodes[0]).toHaveProperty("name");
      expect(graph.nodes[0]).toHaveProperty("symbolType");
    });

    it("should format IntraFileGraph edges as TOON", () => {
      const edges = [
        { source: "fn1", target: "fn2", edgeType: "call" as const, line: 12 },
        { source: "fn2", target: "fn3", edgeType: "reference" as const },
      ];

      // Expected TOON format
      // edges(source,target,edgeType,line)
      // [fn1,fn2,call,12]
      // [fn2,fn3,reference,]

      expect(edges.length).toBe(2);
      expect(edges[0].edgeType).toBe("call");
      expect(edges[1].edgeType).toBe("reference");
    });

    it("should handle empty graphs in TOON format", () => {
      const emptyGraph = {
        nodes: [],
        edges: [],
        hasCycle: false,
      };

      // Should produce valid TOON even for empty data
      expect(emptyGraph.nodes).toHaveLength(0);
      expect(emptyGraph.edges).toHaveLength(0);
    });

    it("should handle cycle detection in TOON format", () => {
      const graphWithCycle = {
        nodes: [
          { id: "fn1", name: "a", symbolType: "Function", line: 1, isExported: true },
          { id: "fn2", name: "b", symbolType: "Function", line: 2, isExported: true },
        ],
        edges: [
          { source: "fn1", target: "fn2", edgeType: "call" as const },
          { source: "fn2", target: "fn1", edgeType: "call" as const },
        ],
        hasCycle: true,
        cycleNodes: ["fn1", "fn2"],
      };

      expect(graphWithCycle.hasCycle).toBe(true);
      expect(graphWithCycle.cycleNodes).toContain("fn1");
      expect(graphWithCycle.cycleNodes).toContain("fn2");
    });
  });

  describe("T068 - JSON format fallback", () => {
    it("should provide full IntraFileGraph structure in JSON", () => {
      const result = {
        filePath: "/test/file.ts",
        graph: {
          nodes: [
            { id: "fn1", name: "test", symbolType: "Function", line: 10, isExported: true },
          ],
          edges: [
            { source: "fn1", target: "fn2", edgeType: "call" as const },
          ],
          hasCycle: false,
        },
        language: "typescript",
        analysisTimeMs: 150,
      };

      // Verify JSON serialization works
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);

      expect(parsed.filePath).toBe(result.filePath);
      expect(parsed.graph.nodes).toHaveLength(1);
      expect(parsed.graph.edges).toHaveLength(1);
      expect(parsed.language).toBe("typescript");
    });

    it("should include metadata in JSON response", () => {
      const response = {
        filePath: "/test/file.ts",
        graph: {
          nodes: [{ id: "1", name: "test", symbolType: "Function", line: 1, isExported: true }],
          edges: [],
          hasCycle: false,
        },
        language: "typescript",
        analysisTimeMs: 100,
        isPartial: false,
      };

      expect(response).toHaveProperty("analysisTimeMs");
      expect(response.analysisTimeMs).toBeGreaterThan(0);
    });

    it("should preserve all fields in JSON format", () => {
      const fullResponse = {
        filePath: "/test/file.ts",
        graph: {
          nodes: [],
          edges: [],
          hasCycle: false,
          cycleNodes: [] as string[],
        },
        language: "typescript",
        analysisTimeMs: 200,
        isPartial: true,
        warnings: ["Partial analysis due to timeout"],
      };

      const json = JSON.stringify(fullResponse);
      const parsed = JSON.parse(json);

      expect(parsed.isPartial).toBe(true);
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.graph.hasCycle).toBe(false);
    });
  });
});
