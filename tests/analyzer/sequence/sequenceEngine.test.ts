import { describe, expect, it } from "vitest";

import { generateSequence } from "../../../src/analyzer/sequence/SequenceEngine.js";
import { orderMessages } from "../../../src/analyzer/sequence/order.js";
import { renderSequenceMarkdown } from "../../../src/analyzer/sequence/renderers/markdownSequenceRenderer.js";
import { renderMermaidSequence } from "../../../src/analyzer/sequence/renderers/mermaidSequenceRenderer.js";
import type {
  SequenceGenerationParams,
  SequenceMessage,
  SequenceModel,
} from "../../../src/analyzer/sequence/types.js";

describe("sequence types contract", () => {
  it("accepts minimal valid model shape", () => {
    const params: SequenceGenerationParams = {
      workspaceRoot: "/repo",
      filePath: "/repo/src/index.ts",
      symbolName: "main",
      maxDepth: 3,
      maxSteps: 100,
      includeExternal: true,
      includeAnnotations: true,
      useCache: true,
    };

    const model: SequenceModel = {
      root: {
        id: "/repo/src/index.ts:main:1:0",
        symbolName: "main",
        filePath: "/repo/src/index.ts",
      },
      participants: [],
      messages: [],
      warnings: [],
      truncated: false,
      stats: {
        participantsCount: 0,
        messagesCount: 0,
        maxDepthReached: 0,
        analysisTimeMs: 0,
      },
    };

    expect(params.symbolName).toBe("main");
    expect(model.truncated).toBe(false);
  });
});

describe("SequenceEngine determinism", () => {
  const symbolGraphs = new Map<string, {
    symbols: Array<{ id: string; name: string; parentSymbolId?: string }>;
    dependencies: Array<{ sourceSymbolId: string; targetSymbolId: string; targetFilePath: string }>;
  }>([
    [
      "/repo/src/index.ts",
      {
        symbols: [
          { id: "/repo/src/index.ts:main", name: "main" },
          { id: "/repo/src/index.ts:helper", name: "helper" },
        ],
        dependencies: [
          {
            sourceSymbolId: "/repo/src/index.ts:main",
            targetSymbolId: "/repo/src/index.ts:helper",
            targetFilePath: "/repo/src/index.ts",
          },
          {
            sourceSymbolId: "/repo/src/index.ts:main",
            targetSymbolId: "/repo/src/service.ts:run",
            targetFilePath: "/repo/src/service.ts",
          },
        ],
      },
    ],
    [
      "/repo/src/service.ts",
      {
        symbols: [
          { id: "/repo/src/service.ts:run", name: "run" },
        ],
        dependencies: [
          {
            sourceSymbolId: "/repo/src/service.ts:run",
            targetSymbolId: "/repo/src/index.ts:helper",
            targetFilePath: "/repo/src/index.ts",
          },
        ],
      },
    ],
  ]);

  const resolveSymbolGraph = async (filePath: string) => {
    return (
      symbolGraphs.get(filePath) ?? {
        symbols: [],
        dependencies: [],
      }
    );
  };

  it("returns stable message order for same inputs", async () => {
    const params: SequenceGenerationParams = {
      workspaceRoot: "/repo",
      filePath: "/repo/src/index.ts",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 100,
      includeExternal: true,
      includeAnnotations: true,
      useCache: false,
      resolveSymbolGraph,
    };

    const first = await generateSequence(params);
    const second = await generateSequence(params);

    expect(second.messages.map((message: SequenceMessage) => message.id)).toEqual(
      first.messages.map((message: SequenceMessage) => message.id),
    );
    expect(first.root.id).toBe("/repo/src/index.ts:main");
    expect(second.root.id).toBe(first.root.id);
    expect(first.messages.length).toBeGreaterThan(0);
    expect(
      first.messages.some((message: SequenceMessage) => message.sourceFile === "/repo/src/service.ts"),
    ).toBe(true);
    expect(first.participants.length).toBeGreaterThan(1);
    expect(first.stats.maxDepthReached).toBe(2);
  });

  it("falls back to unresolved symbol to unique call-root", async () => {
    const model = await generateSequence({
      workspaceRoot: "/repo",
      filePath: "/repo/src/index.ts",
      symbolName: "result",
      maxDepth: 2,
      maxSteps: 20,
      includeExternal: true,
      includeAnnotations: true,
      useCache: false,
      resolveSymbolGraph,
    });

    expect(model.root.id).toBe("/repo/src/index.ts:main");
    expect(model.messages.length).toBeGreaterThan(0);
    expect(
      model.warnings.some(
        (warning: { code: string; message: string }) =>
          warning.code === "AMBIGUOUS_TARGET" && warning.message.includes("result"),
      ),
    ).toBe(true);
  });

  it("does not emit unresolved warning when symbol backend returns no data", async () => {
    const model = await generateSequence({
      workspaceRoot: "/repo",
      filePath: "/repo/main.go",
      symbolName: "main",
      maxDepth: 2,
      maxSteps: 20,
      includeExternal: true,
      includeAnnotations: true,
      useCache: false,
      resolveSymbolGraph: async () => ({
        symbols: [],
        dependencies: [],
      }),
    });

    expect(model.root.id).toBe("/repo/main.go:main");
    expect(model.warnings.some((warning: { code: string }) => warning.code === "UNRESOLVED_TARGET")).toBe(false);
  });

  it("falls back to class-level edges when method dependencies are unavailable", async () => {
    const fallbackGraph = new Map<string, {
      symbols: Array<{ id: string; name: string; parentSymbolId?: string }>;
      dependencies: Array<{ sourceSymbolId: string; targetSymbolId: string; targetFilePath: string }>;
    }>([
      [
        "/repo/src/class.ts",
        {
          symbols: [
            { id: "/repo/src/class.ts:MyClass", name: "MyClass" },
            {
              id: "/repo/src/class.ts:MyClass.execute",
              name: "MyClass.execute",
              parentSymbolId: "/repo/src/class.ts:MyClass",
            },
            { id: "/repo/src/class.ts:helper", name: "helper" },
          ],
          dependencies: [
            {
              sourceSymbolId: "/repo/src/class.ts:MyClass",
              targetSymbolId: "/repo/src/class.ts:helper",
              targetFilePath: "/repo/src/class.ts",
            },
          ],
        },
      ],
    ]);

    const model = await generateSequence({
      workspaceRoot: "/repo",
      filePath: "/repo/src/class.ts",
      symbolName: "execute",
      maxDepth: 2,
      maxSteps: 20,
      includeExternal: true,
      includeAnnotations: true,
      useCache: false,
      resolveSymbolGraph: async (filePath: string) =>
        fallbackGraph.get(filePath) ?? { symbols: [], dependencies: [] },
    });

    expect(model.messages.length).toBeGreaterThan(0);
    expect(
      model.warnings.some((warning: { code: string }) => warning.code === "AMBIGUOUS_TARGET"),
    ).toBe(true);
  });

  it("orders messages deterministically by file and location", () => {
    const input: SequenceMessage[] = [
      {
        id: "m3",
        fromParticipantId: "service",
        toParticipantId: "repo",
        label: "save",
        relationType: "CALLS",
        async: false,
        confidence: "high",
        sourceFile: "/repo/src/service.ts",
        startLine: 12,
        startCol: 4,
        endLine: 12,
        endCol: 20,
      },
      {
        id: "m1",
        fromParticipantId: "main",
        toParticipantId: "service",
        label: "run",
        relationType: "CALLS",
        async: false,
        confidence: "high",
        sourceFile: "/repo/src/index.ts",
        startLine: 8,
        startCol: 2,
        endLine: 8,
        endCol: 12,
      },
      {
        id: "m2",
        fromParticipantId: "main",
        toParticipantId: "service",
        label: "runLater",
        relationType: "CALLS",
        async: true,
        confidence: "medium",
        sourceFile: "/repo/src/index.ts",
        startLine: 8,
        startCol: 10,
        endLine: 8,
        endCol: 22,
      },
    ];

    const ordered = orderMessages(input);

    expect(ordered.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("sequence renderers", () => {
  it("renders mermaid sequence header and participants", () => {
    const mermaid = renderMermaidSequence({
      root: {
        id: "a",
        symbolName: "main",
        filePath: "/repo/src/index.ts",
      },
      participants: [
        {
          id: "p1",
          label: "main",
          filePath: "/repo/src/index.ts",
          external: false,
        },
      ],
      messages: [],
      warnings: [],
      truncated: false,
      stats: {
        participantsCount: 1,
        messagesCount: 0,
        maxDepthReached: 0,
        analysisTimeMs: 1,
      },
    });

    expect(mermaid).toContain("sequenceDiagram");
    expect(mermaid).toContain("participant p1 as main");
  });

  it("renders compact warning notes in mermaid output", () => {
    const longPath = "/repo/src/services/accountableAccount/AccountableAccountService.ts:AccountableAccountService.getOrCreateDoubtfulCustomersAccount";
    const mermaid = renderMermaidSequence({
      root: {
        id: "a",
        symbolName: "main",
        filePath: "/repo/src/index.ts",
      },
      participants: [
        {
          id: "p1",
          label: "main",
          filePath: "/repo/src/index.ts",
          external: false,
        },
      ],
      messages: [],
      warnings: [
        {
          code: "AMBIGUOUS_TARGET",
          message: `Resolved method name 'getOrCreateDoubtfulCustomersAccount' to '${longPath}'.`,
        },
      ],
      truncated: false,
      stats: {
        participantsCount: 1,
        messagesCount: 0,
        maxDepthReached: 0,
        analysisTimeMs: 1,
      },
    });

    expect(mermaid).toContain("Warnings: AMBIGUOUS_TARGET");
    expect(mermaid).not.toContain(longPath);
  });

  it("renders markdown wrapper around mermaid output", () => {
    const model: SequenceModel = {
      root: {
        id: "a",
        symbolName: "main",
        filePath: "/repo/src/index.ts",
      },
      participants: [],
      messages: [],
      warnings: [],
      truncated: false,
      stats: {
        participantsCount: 0,
        messagesCount: 0,
        maxDepthReached: 0,
        analysisTimeMs: 0,
      },
    };

    const markdown = renderSequenceMarkdown(model);

    expect(markdown).toContain("## Sequence Diagram");
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("sequenceDiagram");
    expect(markdown).toContain("## Warnings");
    expect(markdown).toContain("- none");
  });
});
