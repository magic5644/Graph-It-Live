import { describe, it, expect } from "vitest";
import {
  formatOutput,
  validateFormatForCommand,
  CLI_OUTPUT_FORMATS,
} from "@/cli/formatter";
import { CliError, ExitCode } from "@/cli/errors";

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

  it("throws UNSUPPORTED_FORMAT when no graph data", () => {
    expect(() => formatOutput(objectData, "mermaid", "trace")).toThrow(CliError);
    try {
      formatOutput(objectData, "mermaid", "trace");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.UNSUPPORTED_FORMAT);
    }
  });
});
