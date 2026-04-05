import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "../../src/cli/errors";
import {
  CLI_OUTPUT_FORMATS,
  formatOutput,
  validateFormatForCommand,
} from "../../src/cli/formatter";

// Sample data used across tests
const arrayData = [
  { file: "src/a.ts", deps: 2 },
  { file: "src/b.ts", deps: 3 },
];

const objectData = { state: "idle", filesIndexed: 42 };

describe("CLI_OUTPUT_FORMATS", () => {
  it("contains all expected formats", () => {
    expect(CLI_OUTPUT_FORMATS).toContain("text");
    expect(CLI_OUTPUT_FORMATS).toContain("json");
    expect(CLI_OUTPUT_FORMATS).toContain("toon");
    expect(CLI_OUTPUT_FORMATS).toContain("markdown");
    expect(CLI_OUTPUT_FORMATS).toContain("mermaid");
  });
});

describe("validateFormatForCommand", () => {
  it("allows mermaid for trace command", () => {
    expect(() => validateFormatForCommand("mermaid", "trace")).not.toThrow();
  });

  it("allows mermaid for path command", () => {
    expect(() => validateFormatForCommand("mermaid", "path")).not.toThrow();
  });

  it("throws UNSUPPORTED_FORMAT for mermaid on summary", () => {
    expect(() => validateFormatForCommand("mermaid", "summary")).toThrow(CliError);
    try {
      validateFormatForCommand("mermaid", "summary");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.UNSUPPORTED_FORMAT);
    }
  });

  it("throws UNSUPPORTED_FORMAT for mermaid on explain", () => {
    expect(() => validateFormatForCommand("mermaid", "explain")).toThrow(CliError);
  });

  it("allows all formats for non-mermaid-restricted commands", () => {
    for (const fmt of ["text", "json", "toon", "markdown"] as const) {
      expect(() => validateFormatForCommand(fmt, "summary")).not.toThrow();
      expect(() => validateFormatForCommand(fmt, "explain")).not.toThrow();
    }
  });
});

describe("formatOutput - json", () => {
  it("serializes object as pretty JSON", () => {
    const out = formatOutput(objectData, "json", "summary");
    expect(out).toBe(JSON.stringify(objectData, null, 2));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("serializes array as pretty JSON", () => {
    const out = formatOutput(arrayData, "json", "summary");
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(2);
  });
});

describe("formatOutput - text", () => {
  it("renders array items", () => {
    const out = formatOutput(arrayData, "text", "scan");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/b.ts");
  });

  it("renders string directly", () => {
    const out = formatOutput("hello world", "text", "scan");
    expect(out).toBe("hello world");
  });

  it("renders plain object", () => {
    const out = formatOutput(objectData, "text", "summary");
    expect(out).toContain("filesIndexed");
    expect(out).toContain("42");
  });

  it("renders trace result as human-readable call chain", () => {
    const traceData = {
      rootSymbol: { id: "src/cli/index.ts:main", filePath: "/abs/src/cli/index.ts", relativePath: "src/cli/index.ts", symbolName: "main" },
      maxDepth: 10,
      callCount: 1,
      uniqueSymbolCount: 2,
      maxDepthReached: false,
      callChain: [
        { depth: 1, callerSymbolId: "/abs/src/cli/index.ts:main", calledSymbolId: "/abs/src/cli/index.ts:run", calledFilePath: "./index", resolvedFilePath: "/abs/src/cli/index.ts", resolvedRelativePath: "src/cli/index.ts" },
      ],
      visitedSymbols: ["/abs/src/cli/index.ts:main", "/abs/src/cli/index.ts:run"],
    };
    const out = formatOutput(traceData, "text", "trace");
    expect(out).toContain("Trace: src/cli/index.ts :: main");
    expect(out).toContain("calls: 1");
    expect(out).toContain("Call Chain:");
    expect(out).toContain("depth 1");
    expect(out).toContain("main \u2192 run");
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("Visited Symbols:");
    expect(out).toContain("- main");
  });
});

describe("formatOutput - toon", () => {
  it("produces toon header for array data", () => {
    const out = formatOutput(arrayData, "toon", "scan");
    expect(out).toMatch(/files\(file,deps\)/);
  });

  it("falls back to JSON for non-array object", () => {
    const out = formatOutput(objectData, "toon", "summary");
    // Non-array: should fall through to JSON
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("formatOutput - markdown", () => {
  it("wraps output in fenced code blocks", () => {
    const out = formatOutput(objectData, "markdown", "summary");
    expect(out).toContain("```json");
    expect(out).toContain("```");
  });
});

describe("formatOutput - mermaid", () => {
  it("generates graph from nodes/edges", () => {
    const graphData = {
      nodes: [{ id: "a", name: "a.ts" }, { id: "b", name: "b.ts" }],
      edges: [{ source: "a", target: "b" }],
    };
    const out = formatOutput(graphData, "mermaid", "path");
    expect(out).toContain("graph LR");
    expect(out).toContain("-->");
  });

  it("generates graph from callChain (trace result)", () => {
    const traceData = {
      rootSymbol: { id: "src/a.ts:main", filePath: "/abs/src/a.ts", relativePath: "src/a.ts", symbolName: "main" },
      maxDepth: 10,
      callCount: 1,
      uniqueSymbolCount: 2,
      maxDepthReached: false,
      callChain: [
        { depth: 1, callerSymbolId: "/abs/src/a.ts:main", calledSymbolId: "/abs/src/a.ts:helper", calledFilePath: "./a", resolvedFilePath: "/abs/src/a.ts", resolvedRelativePath: "src/a.ts" },
      ],
      visitedSymbols: ["/abs/src/a.ts:main", "/abs/src/a.ts:helper"],
    };
    const out = formatOutput(traceData, "mermaid", "trace");
    expect(out).toContain("graph TD");
    expect(out).toContain("main --> helper");
  });

  it("throws UNSUPPORTED_FORMAT when no graph data", () => {
    expect(() => formatOutput(objectData, "mermaid", "trace")).toThrow(CliError);
    try {
      formatOutput(objectData, "mermaid", "trace");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.UNSUPPORTED_FORMAT);
    }
  });
});
