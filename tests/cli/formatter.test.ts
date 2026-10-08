import { describe, expect, it } from "vitest";
import {
  CLI_OUTPUT_FORMATS,
  formatOutput,
  relativizeWorkspacePaths,
  renderCliOutput,
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

  it("produces toon rows for check-dependencies (nested outgoing/incoming), not a JSON fallback", () => {
    const dependencyData = {
      filePath: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      outgoing: {
        dependencyCount: 1,
        dependencies: [{ path: "src/utils.ts", relativePath: "src/utils.ts", type: "import", line: 1 }],
      },
      incoming: {
        referencingFileCount: 1,
        referencingFiles: [{ path: "src/app.ts", relativePath: "src/app.ts", type: "import", line: 2 }],
      },
    };

    const out = formatOutput(dependencyData, "toon", "check-dependencies");
    expect(out).toMatch(/dependencies\(direction,path/);
    expect(out).toContain("outgoing");
    expect(out).toContain("incoming");
    expect(out).not.toContain("Token Savings");
    // A JSON fallback would pretty-print with 2-space indented braces; TOON rows should not.
    expect(() => JSON.parse(out)).toThrow();
  });

  it("produces toon rows for explain (nested graph.nodes), not a JSON fallback", () => {
    const explainData = {
      filePath: "/workspace/src/index.ts",
      graph: {
        filePath: "/workspace/src/index.ts",
        nodes: [{ id: "src/index.ts:foo", name: "foo", kind: 13 }],
        edges: [],
        hasCycle: false,
      },
      language: "typescript",
      analysisTimeMs: 5,
    };

    const out = formatOutput(explainData, "toon", "explain");
    expect(out).not.toContain("Token Savings");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("produces toon rows for check (unusedSymbols), not a JSON fallback", () => {
    const checkData = {
      filePath: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      unusedCount: 1,
      unusedSymbols: [{ name: "foo", kind: "FunctionDeclaration", line: 1, isExported: true }],
      totalExportedSymbols: 1,
      unusedPercentage: 100,
    };

    const out = formatOutput(checkData, "toon", "check");
    expect(out).not.toContain("Token Savings");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("never prints undefined nested fields in the scalar header", () => {
    const out = formatOutput(
      { graph: { filePath: "src/a.ts", incomingEdges: undefined, nodes: [{ name: "run" }] } },
      "toon",
      "explain",
    );
    expect(out).not.toContain("undefined");
  });

  it("emits the scalar header for cycles with no confirmed cycles, not a JSON fallback", () => {
    const cyclesData = {
      filePath: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      cycleCount: 0,
      confirmedCycles: [],
    };

    const out = formatOutput(cyclesData, "toon", "cycles");
    expect(out).toBe("# filePath=src/index.ts cycleCount=0");
  });

  it("emits the scalar header for check with no unused symbols, not a JSON fallback", () => {
    const checkData = {
      filePath: "/workspace/src/index.ts",
      unusedCount: 0,
      unusedSymbols: [],
      totalExportedSymbols: 2,
    };

    const out = formatOutput(checkData, "toon", "check");
    expect(out).toBe("# filePath=/workspace/src/index.ts unusedCount=0 totalExportedSymbols=2");
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
    const out = formatOutput(traceData, "mermaid", "trace", "/abs");
    expect(out).toBe([
      "graph TD",
      '  S0["main · src/a.ts"]',
      '  S1["helper · src/a.ts"]',
      "  S0 --> S1",
    ].join("\n"));
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

describe("formatOutput - mermaid call chain (#265)", () => {
  const ROOT = "/ws";
  const chainOf = (...pairs: [string, string][]) => ({
    callChain: pairs.map(([callerSymbolId, calledSymbolId]) => ({ callerSymbolId, calledSymbolId })),
  });
  const edgeLines = (out: string) => out.split("\n").filter((line) => line.includes("-->"));
  // Resolves every edge back to the labels of its two nodes, so a diagram that
  // renders but depicts the wrong relationships still fails.
  const labelledEdges = (out: string) => {
    const labels = new Map<string, string>();
    for (const match of out.matchAll(/^ {2}(S\d+)\(?\["([^"]*)"\]/gm)) {
      labels.set(match[1], match[2]);
    }
    return edgeLines(out).map((line) => {
      const [from, to] = line.trim().split(" --> ");
      return `${labels.get(from)} -> ${labels.get(to)}`;
    });
  };

  const issueChain = chainOf(
    ["/ws/src/e.ts:entry", "/ws/src/a.ts:helper"],
    ["/ws/src/a.ts:helper", "/ws/src/x.ts:x"],
    ["/ws/src/e.ts:entry", "/ws/src/b.ts:helper"],
    ["/ws/src/b.ts:helper", "node:fs:readFileSync"],
    ["/ws/src/b.ts:helper", "/ws/src/b.ts:end"],
  );

  it("renders the issue reproduction exactly as expected", () => {
    expect(formatOutput(issueChain, "mermaid", "trace", ROOT)).toBe([
      "graph TD",
      '  S0["entry · src/e.ts"]',
      '  S1["helper · src/a.ts"]',
      '  S2["x · src/x.ts"]',
      '  S3["helper · src/b.ts"]',
      '  S4(["readFileSync · node:fs"]):::external',
      '  S5["end · src/b.ts"]',
      "  S0 --> S1",
      "  S1 --> S2",
      "  S0 --> S3",
      "  S3 --> S4",
      "  S3 --> S5",
      "  classDef external stroke-dasharray: 4 2",
    ].join("\n"));
  });

  it("keeps same-name symbols from different files as distinct nodes with the right edges", () => {
    expect(labelledEdges(formatOutput(issueChain, "mermaid", "trace", ROOT))).toEqual([
      "entry · src/e.ts -> helper · src/a.ts",
      "helper · src/a.ts -> x · src/x.ts",
      "entry · src/e.ts -> helper · src/b.ts",
      "helper · src/b.ts -> readFileSync · node:fs",
      "helper · src/b.ts -> end · src/b.ts",
    ]);
  });

  it("never emits a reserved word as a node id", () => {
    const out = formatOutput(
      chainOf(["/ws/a.ts:graph", "/ws/a.ts:end"], ["/ws/a.ts:end", "/ws/a.ts:subgraph"]),
      "mermaid",
      "trace",
      ROOT,
    );
    for (const line of edgeLines(out)) {
      expect(line).toMatch(/^\s+S\d+ --> S\d+$/);
    }
    expect(out).not.toMatch(/^\s+(end|graph|subgraph)\b/m);
  });

  it("keeps names that would collide after sanitizing as distinct nodes", () => {
    const out = formatOutput(chainOf(["/ws/a.ts:a$b", "/ws/a.ts:a_b"]), "mermaid", "trace", ROOT);
    expect(labelledEdges(out)).toEqual(["a$b · a.ts -> a_b · a.ts"]);
  });

  it("escapes quotes and line breaks in symbol labels", () => {
    const out = formatOutput(chainOf(['/ws/a.ts:say"hi"', "/ws/a.ts:line\nbreak"]), "mermaid", "trace", ROOT);
    expect(out).toContain(`S0["say'hi' · a.ts"]`);
    expect(out).toContain('S1["line break · a.ts"]');
  });

  it("does not expose the workspace root and marks only external symbols", () => {
    const out = formatOutput(issueChain, "mermaid", "trace", ROOT);
    expect(out).not.toContain("/ws/");
    expect(out.match(/:::external/g)).toHaveLength(1);
  });

  it("omits classDef when every symbol is local", () => {
    const out = formatOutput(chainOf(["/ws/a.ts:f", "/ws/a.ts:g"]), "mermaid", "trace", ROOT);
    expect(out).not.toContain("classDef");
  });

  it("handles Windows ids with backslashes and drive letters", () => {
    const out = formatOutput(
      chainOf(["C:\\ws\\src\\a.ts:helper", "C:\\ws\\src\\b.ts:helper"], ["C:\\ws\\src\\b.ts:helper", "lodash:map"]),
      "mermaid",
      "trace",
      "C:\\ws",
    );
    expect(labelledEdges(out)).toEqual(["helper · src/a.ts -> helper · src/b.ts", "helper · src/b.ts -> map · lodash"]);
    expect(out).toContain('S2(["map · lodash"]):::external');
    expect(out.toLowerCase()).not.toContain("c:");
  });

  it("keeps the normalized absolute path when no workspace root is given", () => {
    const out = formatOutput(chainOf(["/ws/a.ts:f", "bare"]), "mermaid", "trace");
    expect(out).toContain('S0["f · /ws/a.ts"]');
    expect(out).toContain('S1["bare"]');
  });

  it("deduplicates repeated edges", () => {
    const out = formatOutput(chainOf(["/ws/a.ts:f", "/ws/a.ts:g"], ["/ws/a.ts:f", "/ws/a.ts:g"]), "mermaid", "trace", ROOT);
    expect(edgeLines(out)).toEqual(["  S0 --> S1"]);
  });

  it("embeds the same block in markdown output", () => {
    const mermaid = formatOutput(issueChain, "mermaid", "trace", ROOT);
    const markdown = formatOutput(issueChain, "markdown", "trace", ROOT);
    expect(markdown).toContain("```mermaid\n" + mermaid + "\n```");
  });

  it("still marks call chain truncation", () => {
    const pairs = Array.from({ length: 510 }, (_, i): [string, string] => [`/ws/a.ts:f${i}`, `/ws/a.ts:g${i}`]);
    const out = formatOutput(chainOf(...pairs), "mermaid", "trace", ROOT);
    const lines = out.split("\n");
    // Unique nodes would push edges past the line cap: entries stop early instead.
    expect(lines.length).toBeLessThanOrEqual(700);
    expect(edgeLines(out).length).toBeGreaterThan(200);
    expect(lines.at(-1)).toMatch(/^%% call chain truncated \(\d+ hidden edge\(s\)\)$/);

    const short = Array.from({ length: 505 }, (_, i): [string, string] => ["/ws/a.ts:f", `/ws/a.ts:g${i % 3}`]);
    expect(formatOutput(chainOf(...short), "mermaid", "trace", ROOT)).toContain("%% call chain truncated (5 hidden edge(s))");
  });
});

describe("formatOutput - mermaid synthetic ids for other shapes (#265)", () => {
  it("uses synthetic ids for generic trace steps", () => {
    const out = formatOutput(
      { steps: [{ caller: "/ws/a.ts", callee: "end" }, { from: "end", to: "a$b" }, { from: "end", to: "a_b" }] },
      "mermaid",
      "trace",
      "/ws",
    );
    expect(out).toBe([
      "graph TD",
      '  S0["a.ts"]',
      '  S1["end"]',
      '  S2["a$b"]',
      '  S3["a_b"]',
      "  S0 --> S1",
      "  S1 --> S2",
      "  S1 --> S3",
    ].join("\n"));
  });

  it("marks generic trace truncation and keeps raw labels without a root", () => {
    const steps = Array.from({ length: 502 }, () => ({ caller: "/ws/a", callee: "/ws/b" }));
    const out = formatOutput({ trace: steps }, "mermaid", "trace");
    expect(out).toContain('S0["/ws/a"]');
    expect(out).toContain("%% trace truncated (2 hidden step(s))");
  });

  it("stops generic trace steps before node declarations push edges past the line cap", () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({ caller: `c${i}`, callee: `d${i}` }));
    const lines = formatOutput({ trace: steps }, "mermaid", "trace").split("\n");
    expect(lines.length).toBeLessThanOrEqual(700);
    expect(lines.filter((line) => line.includes("-->")).length).toBeGreaterThan(200);
    expect(lines.at(-1)).toMatch(/^%% trace truncated \(\d+ hidden step\(s\)\)$/);
  });

  it("declares undeclared graph edge endpoints instead of using raw ids", () => {
    const out = formatOutput({ nodes: [{ id: "a", name: "a.ts" }], edges: [{ source: "a", target: "end" }] }, "mermaid", "path");
    expect(out).toContain('  N1["end"]');
    expect(out).toContain("  N0 --> N1");
  });

  it("keeps dependency-check paths that collide after sanitizing as distinct nodes", () => {
    const out = formatOutput({
      filePath: "/ws/src/index.ts",
      relativePath: "src/index.ts",
      outgoing: { dependencies: [{ path: "src/a-b.ts" }, { path: "src/a_b.ts" }, { path: "src/a-b.ts" }] },
      incoming: { referencingFiles: [{ path: "src/end" }] },
    }, "mermaid", "check-dependencies");
    expect(out).toBe([
      "graph LR",
      '  D0["index.ts"]',
      '  D1["a-b.ts"]',
      "  D0 --> D1",
      '  D2["a_b.ts"]',
      "  D0 --> D2",
      "  D0 --> D1",
      '  D3["end"]',
      "  D3 --> D0",
    ].join("\n"));
  });
});

describe("relativizeWorkspacePaths", () => {
  it("strips the workspace root from every occurrence", () => {
    const output = [
      "[/repo/src/a.ts:A:3,A,class,/repo/src/a.ts,3,0]",
      "[/repo/src/b.ts:B:9,B,class,/repo/src/b.ts,9,0]",
    ].join("\n");

    expect(relativizeWorkspacePaths(output, "/repo")).toBe(
      ["[src/a.ts:A:3,A,class,src/a.ts,3,0]", "[src/b.ts:B:9,B,class,src/b.ts,9,0]"].join("\n"),
    );
  });

  it("tolerates a trailing slash on the workspace root", () => {
    expect(relativizeWorkspacePaths("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
  });

  it("strips a Windows root in its normalized form", () => {
    // normalizePath lowercases the drive letter and uses forward slashes, which
    // is the form every indexed path is stored in.
    const output = "c:/work/repo/src/a.ts and c:/work/repo/src/b.ts";

    expect(relativizeWorkspacePaths(output, "C:\\work\\repo")).toBe(
      "src/a.ts and src/b.ts",
    );
  });

  it("leaves output without the workspace root untouched", () => {
    expect(relativizeWorkspacePaths("nothing to strip", "/repo")).toBe("nothing to strip");
  });

  it("returns the output unchanged for an empty workspace root", () => {
    expect(relativizeWorkspacePaths("/repo/src/a.ts", "")).toBe("/repo/src/a.ts");
  });

  it("does not strip a path that merely shares a prefix with the root", () => {
    // "/repo-backup" must survive when the root is "/repo".
    expect(relativizeWorkspacePaths("/repo-backup/src/a.ts", "/repo")).toBe(
      "/repo-backup/src/a.ts",
    );
  });
});

describe("formatToon - multi-section payloads", () => {
  const graphPayload = {
    mode: "search",
    truncated: true,
    nextCursor: "abc123",
    nodes: [{ id: "n1", name: "alpha" }, { id: "n2", name: "beta" }],
    edges: [{ source: "n1", target: "n2", relation: "CALLS" }],
  };

  it("encodes every array, not just the first one found", () => {
    const out = formatOutput(graphPayload, "toon", "context");

    expect(out).toMatch(/^nodes\(id,name\)$/m);
    expect(out).toMatch(/^edges\(source,target,relation\)$/m);
    expect(out).toContain("[n1,n2,CALLS]");
  });

  it("starts each section on its own line", () => {
    const out = formatOutput(graphPayload, "toon", "context");
    const rowBeforeEdges = out.split("\n").find(line => line.startsWith("[n2,"));

    expect(rowBeforeEdges).toBe("[n2,beta]");
  });

  it("keeps scalar fields in a header comment", () => {
    const out = formatOutput(graphPayload, "toon", "context");

    // nextCursor is the handle for the next page; dropping it strands the caller.
    expect(out.split("\n")[0]).toBe("# mode=search truncated=true nextCursor=abc123");
  });

  it("measures savings against what it encoded, never against dropped content", () => {
    sessionStats.reset();
    const out = formatOutput(graphPayload, "toon", "context");
    const stats = sessionStats.snapshot().byTool["context"];

    // Encoding both sections cannot claim the savings of having dropped one.
    expect(out).not.toContain("Token Savings");
    expect(stats.jsonTokens).toBeGreaterThan(0);
    expect((stats.savings / stats.jsonTokens) * 100).toBeLessThan(80);
  });

  it("emits only the scalar header when there is no array to encode", () => {
    const out = formatOutput({ count: 3, truncated: false }, "toon", "stats");

    expect(out).toBe("# count=3 truncated=false");
  });

  it("still falls back to JSON when there is neither a row nor a scalar", () => {
    expect(formatOutput({ items: [] }, "toon", "stats")).toBe('{\n  "items": []\n}');
    expect(formatOutput([], "toon", "stats")).toBe("[]");
  });

  it("ignores empty arrays instead of emitting a bare header", () => {
    const out = formatOutput({ nodes: [{ id: "n1" }], edges: [] }, "toon", "context");

    expect(out).not.toContain("edges(");
  });
});

describe("renderCliOutput", () => {
  const row = "[/repo/src/a.ts:A:3,A,class,/repo/src/a.ts,3,0]";

  it("strips the workspace root from toon output", () => {
    expect(renderCliOutput(row, "toon", "/repo")).toBe("[src/a.ts:A:3,A,class,src/a.ts,3,0]\n");
  });

  it("leaves json output absolute, since scripts depend on it", () => {
    const json = '{"filePath":"/repo/src/a.ts"}';

    expect(renderCliOutput(json, "json", "/repo")).toBe(`${json}\n`);
  });

  it("leaves the other formats untouched", () => {
    for (const format of ["text", "markdown", "mermaid"] as const) {
      expect(renderCliOutput("/repo/src/a.ts", format, "/repo")).toBe("/repo/src/a.ts\n");
    }
  });

  it("appends a trailing newline only when one is missing", () => {
    expect(renderCliOutput("done\n", "text", "/repo")).toBe("done\n");
    expect(renderCliOutput("done", "text", "/repo")).toBe("done\n");
  });
});
