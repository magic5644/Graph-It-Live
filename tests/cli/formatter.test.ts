import { describe, expect, it } from "vitest";
import {
  CLI_OUTPUT_FORMATS,
  formatOutput,
  validateFormatForCommand,
} from "../../src/cli/formatter";
import { sessionStats } from "../../src/shared/sessionStats";

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
  it("allows mermaid for all formatOutput-based commands", () => {
    const commands = [
      "scan",
      "summary",
      "trace",
      "explain",
      "path",
      "path-in",
      "check-dependencies",
      "cycles",
      "architecture",
      "check",
      "tool",
    ];

    for (const command of commands) {
      expect(() => validateFormatForCommand("mermaid", command)).not.toThrow();
    }
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

  it("renders architecture summary without dumping failure details", () => {
    const architectureData = {
      workspaceRoot: "/workspace",
      scannedFiles: 10,
      analyzedFiles: 10,
      skippedFiles: 2,
      nodeCount: 12,
      edgeCount: 18,
      nodes: [
        { relativePath: "src/index.ts", dependencyCount: 3, dependentCount: 7 },
        { relativePath: "src/utils.ts", dependencyCount: 1, dependentCount: 2 },
      ],
      failedFiles: [
        { relativePath: "src/bad.ts", reason: "Parse error: unexpected token" },
      ],
    };

    const out = formatOutput(architectureData, "text", "architecture");
    expect(out).toContain("Workspace Architecture");
    expect(out).toContain("skipped files: 2");
    expect(out).toContain("details available with --format json");
    expect(out).not.toContain("Parse error: unexpected token");
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

  it("records a session stats entry on successful TOON conversion", () => {
    sessionStats.reset();
    formatOutput(arrayData, "toon", "architecture");
    const snapshot = sessionStats.snapshot();
    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.byTool["architecture"].calls).toBe(1);
    expect(snapshot.byTool["architecture"].jsonTokens).toBeGreaterThan(0);
    expect(snapshot.byTool["architecture"].toonTokens).toBeGreaterThan(0);
  });

  it("does not record session stats when falling back to JSON", () => {
    sessionStats.reset();
    formatOutput(objectData, "toon", "summary");
    expect(sessionStats.hasEntries()).toBe(false);
  });

  it("infers object name from caller and dependency keys", () => {
    const callers = formatOutput([{ caller: "main", line: 3 }], "toon", "callers");
    expect(callers).toMatch(/callers\(/);
    const deps = formatOutput([{ dependency: "lodash" }], "toon", "deps");
    expect(deps).toMatch(/dependencies\(/);
  });

  it("falls back to generic name for primitive arrays", () => {
    const out = formatOutput([1, 2, 3], "toon", "scan");
    // Primitive rows cannot be TOON-encoded; output falls back to JSON
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

  it("generates graph from check-dependencies result", () => {
    const dependencyData = {
      filePath: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      outgoing: {
        dependencyCount: 1,
        dependencies: [{ path: "src/utils.ts" }],
      },
      incoming: {
        referencingFileCount: 1,
        referencingFiles: [{ path: "src/app.ts" }],
      },
    };

    const out = formatOutput(dependencyData, "mermaid", "check-dependencies");
    expect(out).toContain("graph LR");
    expect(out).toContain("index.ts");
    expect(out).toContain("utils.ts");
    expect(out).toContain("app.ts");
    expect(out).toContain("--> ");
  });

  it("falls back to a generic graph when payload is not graph-shaped", () => {
    const out = formatOutput(objectData, "mermaid", "summary");
    expect(out).toContain("graph TD");
    expect(out).toContain("summary");
    expect(out).toContain("state");
  });

  it("applies generic fallback to primitive payloads", () => {
    const out = formatOutput("done", "mermaid", "scan");
    expect(out).toContain("graph TD");
    expect(out).toContain("done");
  });

  it("strips control characters from Mermaid node labels", () => {
    const graphData = {
      nodes: [
        { id: "a", name: "a\nwith\nnewlines.ts" },
        { id: "b", name: "b\twith\ttabs.ts" },
      ],
      edges: [{ source: "a", target: "b" }],
    };
    const out = formatOutput(graphData, "mermaid", "path");
    // Raw newlines/tabs must not appear inside the quoted label strings
    // (the overall diagram has legitimate newlines between statements — that's fine).
    expect(out).not.toMatch(/"\w*\n\w*"/);  // no newline inside a quoted label
    expect(out).not.toContain("\t");
    expect(out).toContain("graph LR");
  });

  it("escapes double-quotes in Mermaid node labels", () => {
    const graphData = {
      nodes: [{ id: "a", name: 'he said "hello"' }],
      edges: [],
    };
    const out = formatOutput(graphData, "mermaid", "path");
    expect(out).not.toContain('"he said "');
    expect(out).toContain("he said 'hello'");
  });

  it('truncates oversized graph payloads with an explicit marker', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({
      id: `node-${i}`,
      name: `node-${i}.ts`,
    }));
    const edges = Array.from({ length: 900 }, (_, i) => ({
      source: `node-${i % 399}`,
      target: `node-${(i + 1) % 399}`,
    }));

    const out = formatOutput({ nodes, edges }, 'mermaid', 'architecture');
    expect(out).toContain('graph LR');
    expect(out).toContain('more node(s)');
    expect(out).not.toContain('output truncated');
    expect(out.split('\n').length).toBeLessThanOrEqual(700);
  });

  it('truncates oversized dependency-check payloads silently within output budget', () => {
    const outgoing = Array.from({ length: 600 }, (_, i) => ({ path: `src/out-${i}.ts` }));
    const incoming = Array.from({ length: 650 }, (_, i) => ({ path: `src/in-${i}.ts` }));

    const out = formatOutput({
      filePath: '/workspace/src/index.ts',
      relativePath: 'src/index.ts',
      outgoing: { dependencyCount: outgoing.length, dependencies: outgoing },
      incoming: { referencingFileCount: incoming.length, referencingFiles: incoming },
    }, 'mermaid', 'check-dependencies');

    expect(out).toContain('graph LR');
    expect(out).not.toContain('output truncated');
    expect(out.split('\n').length).toBeLessThanOrEqual(700);
  });
});
