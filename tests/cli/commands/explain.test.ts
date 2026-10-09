/**
 * Unit tests for `graph-it explain`: LSP SymbolKind numbers are shown by name
 * in every CLI format (#268). The MCP tool executor is mocked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeAnalyzeFileLogic: vi.fn(),
}));

vi.mock("../../../src/mcp/tools", () => ({
  executeAnalyzeFileLogic: mocks.executeAnalyzeFileLogic,
}));

import { run } from "../../../src/cli/commands/explain.js";

describe("explain command", () => {
  let root: string;
  let file: string;
  const runtime = () => ({ workspaceRoot: root, ensureIndexed: vi.fn().mockResolvedValue(undefined) }) as never;

  const node = (name: string, kind: number) => ({
    id: `${file}:${name}`,
    name,
    kind,
    type: "function",
    range: { start: 1, end: 1 },
    isExported: true,
    isExternal: false,
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-explain-")));
    file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export function a() {}\n");
    mocks.executeAnalyzeFileLogic.mockReset().mockResolvedValue({
      filePath: file,
      graph: { filePath: file, nodes: [node("a", 12), node("Box", 5), node("m", 1), node("T", 26), node("zero", 0), node("odd", 99)], edges: [], hasCycle: false },
      language: "typescript",
      analysisTimeMs: 1,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires a file argument", async () => {
    await expect(run([], runtime(), "text")).rejects.toThrow("Usage: graph-it explain <file>");
  });

  it.each(["toon", "text"] as const)("names the symbol kind in %s output (issue #268)", async (format) => {
    const output = await run([file], runtime(), format);

    expect(output).toContain("Function");
    expect(output).toContain("Class");
    expect(output).not.toMatch(/\b12\b/);
  });

  it("names kinds at both ends of the LSP range and keeps numbers outside it", async () => {
    const output = await run([file], runtime(), "json");
    const kinds = JSON.parse(output).graph.nodes.map((n: { kind: unknown }) => n.kind);

    expect(kinds).toEqual(["Function", "Class", "File", "TypeParameter", 0, 99]);
  });
});
