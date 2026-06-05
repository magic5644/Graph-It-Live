/**
 * MCP Integration Tests for analyze_file_logic tool (T070-T074)
 *
 * Tests the complete MCP pipeline for symbol-level analysis:
 * - TypeScript/JavaScript/Python file analysis
 * - TOON and JSON format output
 * - Error handling (invalid paths, unsupported extensions)
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    McpWorkerHost,
    type McpWorkerHostOptions,
} from "../../src/mcp/McpWorkerHost";
import { SpiderBuilder } from "../../src/analyzer/SpiderBuilder";
import { LspCallHierarchyAnalyzer } from "../../src/analyzer/LspCallHierarchyAnalyzer";
import type {
    AnalyzeFileLogicParams,
  AnalyzeFileLogicResult,
} from "../../src/mcp/types";
import { convertSpiderToLspFormat } from "../../src/shared/converters";
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from "../../src/shared/constants";
import { detectLanguageFromExtension } from "../../src/shared/utils/languageDetection";

function assertAnalyzeFileLogicResult(value: unknown): asserts value is AnalyzeFileLogicResult {
  if (!value || typeof value !== "object") {
    throw new Error("Expected object result from analyze_file_logic");
  }
  const candidate = value as { filePath?: unknown; language?: unknown; graph?: unknown };
  if (
    typeof candidate.filePath !== "string"
    || typeof candidate.language !== "string"
    || !candidate.graph
    || typeof candidate.graph !== "object"
  ) {
    throw new Error("Invalid analyze_file_logic result shape");
  }
}

async function invokeAnalyze(
  worker: McpWorkerHost,
  params: AnalyzeFileLogicParams,
): Promise<AnalyzeFileLogicResult> {
  const result = await worker.invoke("analyze_file_logic", params);
  assertAnalyzeFileLogicResult(result);
  return result;
}

describe("MCP analyze_file_logic Integration Tests (T070-T074)", () => {
  let mcpWorker: McpWorkerHost;
  let tempDir: string;

  beforeAll(async () => {
    // Create temporary test directory and resolve to real long path.
    // On Windows CI, os.tmpdir() may return an 8.3 short path (RUNNER~1).
    // Passing the short path to chokidar causes libuv to abort() when
    // ReadDirectoryChangesW fires events with the long-name path.
    const rawTempDir = await fs.mkdtemp(path.join(tmpdir(), "mcp-analyze-file-logic-"));
    tempDir = await fs.realpath(rawTempDir);

    const workerPath = path.resolve(__dirname, "../../dist/mcpWorker.js");
    const options: McpWorkerHostOptions = {
      workerPath,
      warmupTimeout: 15000,
      invokeTimeout: 15000,
    };

    mcpWorker = new McpWorkerHost(options);

    // Start the worker with workspace configuration
    await mcpWorker.start({
      rootDir: tempDir,
      excludeNodeModules: true,
      maxDepth: 50,
      extensionPath: process.cwd(),
    });
  }, 20000);

  afterAll(async () => {
    if (mcpWorker) {
      await mcpWorker.dispose();
    }
    // Cleanup temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("T070: TypeScript file analysis with TOON format", () => {
    it("should analyze TypeScript file and return TOON format", async () => {
      // Create a TypeScript file with function calls
      const tsFile = path.join(tempDir, "example.ts");
      await fs.writeFile(
        tsFile,
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

      const params: AnalyzeFileLogicParams = {
        filePath: tsFile,
        includeExternal: false,
        format: "toon",
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      expect(result).toHaveProperty("filePath");
      expect(result.filePath).toBe(tsFile);
      expect(result).toHaveProperty("language");
      expect(result.language).toBe("typescript");
      expect(result).toHaveProperty("graph");
      expect(result.graph).toHaveProperty("nodes");
      expect(result.graph).toHaveProperty("edges");
      expect(result.graph.nodes.length).toBeGreaterThan(0);

      // Verify symbols are present
      const symbolNames = result.graph.nodes.map((n: any) => n.name);
      expect(symbolNames).toContain("calculate");
      expect(symbolNames).toContain("helper");
      expect(symbolNames).toContain("Calculator");
    });

    it("should return TOON format by default", async () => {
      const tsFile = path.join(tempDir, "default-format.ts");
      await fs.writeFile(
        tsFile,
        `export function test() {
  return 42;
}
`,
      );

      const params: AnalyzeFileLogicParams = {
        filePath: tsFile,
      };

      const result = await mcpWorker.invoke("analyze_file_logic", params);

      expect(result).toBeDefined();
      expect(result).toHaveProperty("graph");
    });
  });

  describe("T071: Python file analysis with TOON format", () => {
    it("should analyze Python file and return TOON format", async () => {
      const pyFile = path.join(tempDir, "example.py");
      await fs.writeFile(
        pyFile,
        `def calculate(x: int) -> int:
    return helper(x) * 2

def helper(n: int) -> int:
    return n + 1

class Calculator:
    def multiply(self, a: int, b: int) -> int:
        return a * b
`,
      );

      const params: AnalyzeFileLogicParams = {
        filePath: pyFile,
        includeExternal: false,
        format: "toon",
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      expect(result.filePath).toBe(pyFile);
      expect(result.language).toBe("python");
      expect(result.graph).toHaveProperty("nodes");
      expect(result.graph.nodes.length).toBeGreaterThan(0);

      // Python analysis should detect functions and classes
      const symbolNames = result.graph.nodes.map((n: any) => n.name);
      expect(symbolNames.length).toBeGreaterThan(0);
    });
  });

  describe("T072: Invalid file path error handling", () => {
    it("should return FILE_NOT_FOUND error for non-existent file", async () => {
      const nonExistentFile = path.join(tempDir, "does-not-exist.ts");

      const params: AnalyzeFileLogicParams = {
        filePath: nonExistentFile,
      };

      await expect(
        mcpWorker.invoke("analyze_file_logic", params),
      ).rejects.toThrow(/not found|does not exist/i);
    });

    it("should handle path outside workspace", async () => {
      const outsideFile = path.resolve(tempDir, "..", "outside-workspace.ts");

      const params: AnalyzeFileLogicParams = {
        filePath: outsideFile,
      };

      // Should either reject due to path validation or file not found
      await expect(
        mcpWorker.invoke("analyze_file_logic", params),
      ).rejects.toThrow();
    });
  });

  describe("T073: Unsupported file extension error", () => {
    it("should return UNSUPPORTED_FILE_TYPE error for .txt file", async () => {
      const txtFile = path.join(tempDir, "document.txt");
      await fs.writeFile(txtFile, "Just some text content");

      const params: AnalyzeFileLogicParams = {
        filePath: txtFile,
      };

      await expect(
        mcpWorker.invoke("analyze_file_logic", params),
      ).rejects.toThrow(/UNSUPPORTED_FILE_TYPE/i);
    });

    it("should return error for .md file", async () => {
      const mdFile = path.join(tempDir, "README.md");
      await fs.writeFile(mdFile, "# README\n\nMarkdown content");

      const params: AnalyzeFileLogicParams = {
        filePath: mdFile,
      };

      await expect(
        mcpWorker.invoke("analyze_file_logic", params),
      ).rejects.toThrow(/UNSUPPORTED_FILE_TYPE/i);
    });

    it("should accept .ts, .tsx, .js, .jsx, .py, .rs extensions", async () => {
      for (const ext of SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS) {
        const file = path.join(tempDir, `test${ext}`);

        // Create minimal valid content for each extension
        const language = detectLanguageFromExtension(ext);
        let content: string;
        if (language === "python") {
          content = "def test(): pass";
        } else if (language === "rust") {
          content = "fn test() {}\n";
        } else {
          content = "function test() {}\n";
        }

        await fs.writeFile(file, content);

        const params: AnalyzeFileLogicParams = {
          filePath: file,
        };

        const result = await invokeAnalyze(mcpWorker, params);
        expect(result).toBeDefined();
        expect(result.graph).toBeDefined();
      }
    });
  });

  describe("T074: JSON format output", () => {
    it("should return JSON format when requested", async () => {
      const jsFile = path.join(tempDir, "json-format.js");
      await fs.writeFile(
        jsFile,
        `function main() {
  return process();
}

function process() {
  return 42;
}

module.exports = { main };
`,
      );

      const params: AnalyzeFileLogicParams = {
        filePath: jsFile,
        format: "json",
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      expect(result.language).toBe("javascript");
      expect(result.graph).toHaveProperty("nodes");
      expect(result.graph).toHaveProperty("edges");

      // JSON format should include all graph structure
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(Array.isArray(result.graph.edges)).toBe(true);
      expect(result.graph).toHaveProperty("hasCycle");
    });

    it("should include metadata in response", async () => {
      const tsFile = path.join(tempDir, "metadata.ts");
      await fs.writeFile(
        tsFile,
        `export function test() {
  return 42;
}
`,
      );

      const params: AnalyzeFileLogicParams = {
        filePath: tsFile,
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.filePath).toBe(tsFile);
    });
  });

  describe("MCP parity with extension analysis pipeline", () => {
    it("matches direct Spider + LspCallHierarchyAnalyzer graph for TypeScript file", async () => {
      const tsFile = path.join(tempDir, "parity.ts");
      await fs.writeFile(
        tsFile,
        `export function alpha(x: number): number {
  return beta(x);
}

function beta(y: number): number {
  return gamma(y) + 1;
}

function gamma(z: number): number {
  return z * 2;
}
`,
      );

      const mcpParams: AnalyzeFileLogicParams = {
        filePath: tsFile,
        format: "json",
      };

      const mcpResult = await invokeAnalyze(mcpWorker, mcpParams);

      const spider = new SpiderBuilder()
        .withRootDir(tempDir)
        .withExtensionPath(process.cwd())
        .build();

      try {
        const symbolGraphData = await spider.getSymbolGraph(tsFile);
        const lspData = convertSpiderToLspFormat(symbolGraphData, tsFile);
        const analyzer = new LspCallHierarchyAnalyzer();
        const directGraph = analyzer.buildIntraFileGraph(tsFile, lspData);

        const mcpNodes = new Set(mcpResult.graph.nodes.map((n: any) => n.id));
        const directNodes = new Set(directGraph.nodes.map((n) => n.id));
        expect(mcpNodes).toEqual(directNodes);

        const mcpEdges = new Set(
          mcpResult.graph.edges.map((e: any) => `${e.source}->${e.target}`),
        );
        const directEdges = new Set(
          directGraph.edges.map((e) => `${e.source}->${e.target}`),
        );
        expect(mcpEdges).toEqual(directEdges);
        expect(mcpResult.graph.hasCycle).toBe(directGraph.hasCycle);
      } finally {
        await spider.dispose();
      }
    });
  });

  describe("Performance and edge cases", () => {
    it("should handle empty file", async () => {
      const emptyFile = path.join(tempDir, "empty.ts");
      await fs.writeFile(emptyFile, "");

      const params: AnalyzeFileLogicParams = {
        filePath: emptyFile,
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      expect(result.graph.nodes.length).toBe(0);
      expect(result.graph.edges.length).toBe(0);
    });

    it("should handle file with only comments", async () => {
      const commentsFile = path.join(tempDir, "comments.ts");
      await fs.writeFile(
        commentsFile,
        `// This is a comment
/* Multi-line
   comment */
`,
      );

      const params: AnalyzeFileLogicParams = {
        filePath: commentsFile,
      };

      const result = await invokeAnalyze(mcpWorker, params);

      expect(result).toBeDefined();
      // Should have no symbols (only comments)
      expect(result.graph.nodes.length).toBe(0);
    });

    it("should complete analysis within reasonable time", async () => {
      const largeFile = path.join(tempDir, "large.ts");

      // Create a file with multiple functions
      let content = "";
      for (let i = 0; i < 50; i++) {
        content += `function func${i}() {\n  return ${i};\n}\n\n`;
      }
      await fs.writeFile(largeFile, content);

      const params: AnalyzeFileLogicParams = {
        filePath: largeFile,
      };

      const startTime = Date.now();
      const result = await invokeAnalyze(mcpWorker, params);
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(result.graph.nodes.length).toBeGreaterThan(0);

      // Should complete in reasonable time (< 5 seconds)
      expect(duration).toBeLessThan(5000);
    });
  });
});
