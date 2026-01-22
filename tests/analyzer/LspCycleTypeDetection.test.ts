import type { LspAnalysisResult } from "../../src/analyzer/LspCallHierarchyAnalyzer";
import { LspCallHierarchyAnalyzer } from "../../src/analyzer/LspCallHierarchyAnalyzer";
import { describe, expect, it } from "vitest";

describe("LspCallHierarchyAnalyzer - Cycle Type Detection", () => {
  const analyzer = new LspCallHierarchyAnalyzer();

  it("should detect self-recursive cycle (function calling itself)", () => {
    // Simulate a factorial function calling itself
    const lspData: LspAnalysisResult = {
      symbols: [
        {
          name: "factorial",
          kind: 12, // Function
          range: { start: 0, end: 5 },
          uri: "/test/math.ts",
        },
      ],
      callHierarchyItems: new Map(),
      outgoingCalls: new Map([
        [
          "/test/math.ts:factorial",
          [
            {
              to: {
                name: "factorial",
                kind: 12,
                uri: "/test/math.ts",
                range: { start: 0, end: 5 },
              },
              fromRanges: [{ start: 3, end: 3 }],
            },
          ],
        ],
      ]),
    };

    const graph = analyzer.buildIntraFileGraph("/test/math.ts", lspData);

    expect(graph.hasCycle).toBe(true);
    expect(graph.cycleType).toBe("self-recursive");
    expect(graph.cycleNodes).toHaveLength(1);
    expect(graph.cycleNodes?.[0]).toBe("/test/math.ts:factorial");
  });

  it("should detect mutual-recursive cycle (two functions calling each other)", () => {
    // Simulate eval ↔ execute pattern in interpreters
    const lspData: LspAnalysisResult = {
      symbols: [
        {
          name: "eval",
          kind: 12,
          range: { start: 0, end: 10 },
          uri: "/test/interpreter.ts",
        },
        {
          name: "execute",
          kind: 12,
          range: { start: 12, end: 22 },
          uri: "/test/interpreter.ts",
        },
      ],
      callHierarchyItems: new Map(),
      outgoingCalls: new Map([
        [
          "/test/interpreter.ts:eval",
          [
            {
              to: {
                name: "execute",
                kind: 12,
                uri: "/test/interpreter.ts",
                range: { start: 12, end: 22 },
              },
              fromRanges: [{ start: 5, end: 5 }],
            },
          ],
        ],
        [
          "/test/interpreter.ts:execute",
          [
            {
              to: {
                name: "eval",
                kind: 12,
                uri: "/test/interpreter.ts",
                range: { start: 0, end: 10 },
              },
              fromRanges: [{ start: 15, end: 15 }],
            },
          ],
        ],
      ]),
    };

    const graph = analyzer.buildIntraFileGraph(
      "/test/interpreter.ts",
      lspData,
    );

    expect(graph.hasCycle).toBe(true);
    expect(graph.cycleType).toBe("mutual-recursive");
    expect(graph.cycleNodes).toHaveLength(2);
    expect(graph.cycleNodes).toContain("/test/interpreter.ts:eval");
    expect(graph.cycleNodes).toContain("/test/interpreter.ts:execute");
  });

  it("should detect complex cycle (3+ functions)", () => {
    // Simulate A → B → C → A pattern
    const lspData: LspAnalysisResult = {
      symbols: [
        {
          name: "funcA",
          kind: 12,
          range: { start: 0, end: 5 },
          uri: "/test/complex.ts",
        },
        {
          name: "funcB",
          kind: 12,
          range: { start: 7, end: 12 },
          uri: "/test/complex.ts",
        },
        {
          name: "funcC",
          kind: 12,
          range: { start: 14, end: 19 },
          uri: "/test/complex.ts",
        },
      ],
      callHierarchyItems: new Map(),
      outgoingCalls: new Map([
        [
          "/test/complex.ts:funcA",
          [
            {
              to: {
                name: "funcB",
                kind: 12,
                uri: "/test/complex.ts",
                range: { start: 7, end: 12 },
              },
              fromRanges: [{ start: 2, end: 2 }],
            },
          ],
        ],
        [
          "/test/complex.ts:funcB",
          [
            {
              to: {
                name: "funcC",
                kind: 12,
                uri: "/test/complex.ts",
                range: { start: 14, end: 19 },
              },
              fromRanges: [{ start: 9, end: 9 }],
            },
          ],
        ],
        [
          "/test/complex.ts:funcC",
          [
            {
              to: {
                name: "funcA",
                kind: 12,
                uri: "/test/complex.ts",
                range: { start: 0, end: 5 },
              },
              fromRanges: [{ start: 16, end: 16 }],
            },
          ],
        ],
      ]),
    };

    const graph = analyzer.buildIntraFileGraph("/test/complex.ts", lspData);

    expect(graph.hasCycle).toBe(true);
    expect(graph.cycleType).toBe("complex");
    expect(graph.cycleNodes?.length).toBeGreaterThanOrEqual(3);
  });

  it("should not detect cycle when there is no cycle", () => {
    // Simulate A → B → C (no cycle)
    const lspData: LspAnalysisResult = {
      symbols: [
        {
          name: "funcA",
          kind: 12,
          range: { start: 0, end: 5 },
          uri: "/test/nocycle.ts",
        },
        {
          name: "funcB",
          kind: 12,
          range: { start: 7, end: 12 },
          uri: "/test/nocycle.ts",
        },
        {
          name: "funcC",
          kind: 12,
          range: { start: 14, end: 19 },
          uri: "/test/nocycle.ts",
        },
      ],
      callHierarchyItems: new Map(),
      outgoingCalls: new Map([
        [
          "/test/nocycle.ts:funcA",
          [
            {
              to: {
                name: "funcB",
                kind: 12,
                uri: "/test/nocycle.ts",
                range: { start: 7, end: 12 },
              },
              fromRanges: [{ start: 2, end: 2 }],
            },
          ],
        ],
        [
          "/test/nocycle.ts:funcB",
          [
            {
              to: {
                name: "funcC",
                kind: 12,
                uri: "/test/nocycle.ts",
                range: { start: 14, end: 19 },
              },
              fromRanges: [{ start: 9, end: 9 }],
            },
          ],
        ],
      ]),
    };

    const graph = analyzer.buildIntraFileGraph("/test/nocycle.ts", lspData);

    expect(graph.hasCycle).toBe(false);
    expect(graph.cycleType).toBeUndefined();
    expect(graph.cycleNodes).toBeUndefined();
  });
});
