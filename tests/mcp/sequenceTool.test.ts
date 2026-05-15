import { describe, expect, it, vi } from "vitest";
import { workerState } from "../../src/mcp/shared/state";

const mocks = vi.hoisted(() => ({
  generateSequence: vi.fn(),
  renderMermaidSequence: vi.fn(),
}));

vi.mock("../../src/analyzer/sequence/SequenceEngine", () => ({
  generateSequence: mocks.generateSequence,
}));

vi.mock("../../src/analyzer/sequence/renderers/mermaidSequenceRenderer", () => ({
  renderMermaidSequence: mocks.renderMermaidSequence,
}));

describe("executeGenerateSequenceDiagram", () => {
  it("returns Mermaid output with counters", async () => {
    const model = {
      participants: [{ id: "svc", label: "Service" }, { id: "repo", label: "Repo" }],
      messages: [{ from: "svc", to: "repo", label: "find" }],
      truncated: false,
      warnings: [{ code: "W_TEST", message: "test warning" }],
      stats: { maxDepthReached: 2 },
    };

    mocks.generateSequence.mockResolvedValueOnce(model);
    mocks.renderMermaidSequence.mockReturnValueOnce("sequenceDiagram\nService->>Repo: find");

    workerState.config = {
      rootDir: "/workspace",
      excludeNodeModules: true,
      maxDepth: 50,
    };

    const { executeGenerateSequenceDiagram } = await import("../../src/mcp/tools/sequence.js");

    const result = await executeGenerateSequenceDiagram({
      filePath: "/workspace/src/service.ts",
      symbolName: "loadUser",
      maxDepth: 3,
      maxSteps: 25,
      diagram_format: "mermaid",
    });

    expect(result.diagram).toContain("sequenceDiagram");
    expect(result.rootSymbol).toBe("/workspace/src/service.ts:loadUser");
    expect(result.participantsCount).toBe(2);
    expect(result.messagesCount).toBe(1);
    expect(result.maxDepthReached).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([{ code: "W_TEST", message: "test warning" }]);
  });

  it("returns JSON output when diagram_format=json", async () => {
    const model = {
      participants: [{ id: "a", label: "A" }],
      messages: [],
      truncated: false,
      warnings: [],
      stats: { maxDepthReached: 0 },
    };

    mocks.generateSequence.mockResolvedValueOnce(model);

    const { executeGenerateSequenceDiagram } = await import("../../src/mcp/tools/sequence.js");

    const result = await executeGenerateSequenceDiagram({
      filePath: "/workspace/src/app.ts",
      symbolName: "main",
      diagram_format: "json",
    });

    expect(() => JSON.parse(result.diagram)).not.toThrow();
    expect(result.participantsCount).toBe(1);
    expect(result.messagesCount).toBe(0);
  });
});
