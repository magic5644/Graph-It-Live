import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateSequence: vi.fn(),
  renderMermaidSequence: vi.fn(),
  renderSequenceMarkdown: vi.fn(),
}));

vi.mock("../../src/analyzer/sequence/SequenceEngine", () => ({
  generateSequence: mocks.generateSequence,
}));

vi.mock("../../src/analyzer/sequence/renderers/mermaidSequenceRenderer", () => ({
  renderMermaidSequence: mocks.renderMermaidSequence,
}));

vi.mock("../../src/analyzer/sequence/renderers/markdownSequenceRenderer", () => ({
  renderSequenceMarkdown: mocks.renderSequenceMarkdown,
}));

describe("sequence command", () => {
  it("generates Mermaid output for a symbol", async () => {
    const model = {
      participants: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
      messages: [{ from: "A", to: "B", label: "call" }],
      truncated: false,
      warnings: [],
    };

    mocks.generateSequence.mockResolvedValueOnce(model);
    mocks.renderMermaidSequence.mockReturnValueOnce("sequenceDiagram\nA->>B: call");

    const { run } = await import("../../src/cli/commands/sequence.js");

    const runtime = {
      workspaceRoot: "/workspace",
    } as unknown as import("../../src/cli/runtime").CliRuntime;

    const output = await run(["src/app.ts#handleRequest", "--maxDepth", "4", "--maxSteps", "50"], runtime, "mermaid");

    expect(mocks.generateSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/workspace",
        symbolName: "handleRequest",
        maxDepth: 4,
        maxSteps: 50,
      }),
    );
    expect(output).toContain("sequenceDiagram");
  });

  it("throws when symbol name is missing", async () => {
    const { run } = await import("../../src/cli/commands/sequence.js");

    const runtime = {
      workspaceRoot: "/workspace",
    } as unknown as import("../../src/cli/runtime").CliRuntime;

    await expect(run(["src/app.ts"], runtime, "text")).rejects.toThrow(
      "sequence requires a symbol name",
    );
  });
});
