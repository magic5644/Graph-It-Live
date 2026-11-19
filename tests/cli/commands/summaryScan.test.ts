import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliProgress } from "@/cli/progress";
import type { CliRuntime } from "@/cli/runtime";

const mocks = vi.hoisted(() => ({
  buildArchitectureGraph: vi.fn(),
  executeGetIndexStatus: vi.fn(),
  executeGenerateCodemap: vi.fn(),
}));

vi.mock("@/analyzer/architecture/ArchitectureGraphBuilder.js", () => ({ buildArchitectureGraph: mocks.buildArchitectureGraph }));
vi.mock("@/mcp/tools", () => ({ executeGetIndexStatus: mocks.executeGetIndexStatus, executeGenerateCodemap: mocks.executeGenerateCodemap }));

import { run as summary } from "@/cli/commands/summary";
import { run as scan } from "@/cli/commands/scan";

const node = (relativePath: string, dependentCount: number, communityKey: string, extension = "ts") =>
  ({ relativePath, dependentCount, dependencyCount: 1, communityKey, extension });

function runtime(root = "/workspace"): CliRuntime {
  return { workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn(), loadState: () => undefined } as unknown as CliRuntime;
}

describe("summary (#767)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeGetIndexStatus.mockResolvedValue({ state: "complete", cacheSize: 0 });
  });

  it("gives a workspace overview without a file, not the index status", async () => {
    mocks.buildArchitectureGraph.mockResolvedValue({
      nodes: [node("src/a.ts", 0, "src"), node("src/b.ts", 3, "src"), node("lib/c.py", 1, "lib", "py"), node("x.ts", 0, "")],
      edges: [{}, {}, {}, {}],
      scannedFiles: 4,
      failedFiles: [],
    });

    const overview = JSON.parse(await summary([], runtime(), "json"));

    expect(overview).toEqual({
      files: 4,
      failedFiles: 0,
      importEdges: 4,
      extensions: { ts: 3, py: 1 },
      mostImported: [{ file: "src/b.ts", importedBy: 3, imports: 1 }, { file: "lib/c.py", importedBy: 1, imports: 1 }],
      largestFolders: [{ folder: "src", files: 2 }, { folder: "lib", files: 1 }],
      next: expect.stringContaining("graph-it summary <file>"),
    });
    expect(mocks.executeGetIndexStatus).not.toHaveBeenCalled();
  });

  it("keeps the index status and codemap of an existing file, and refuses a missing one", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "summary-file-")));
    fs.writeFileSync(path.join(root, "a.ts"), "");
    mocks.executeGenerateCodemap.mockResolvedValue({ relativePath: "a.ts" });

    expect(JSON.parse(await summary(["a.ts"], runtime(root), "json"))).toEqual({ indexStatus: { state: "complete", cacheSize: 0 }, codemap: { relativePath: "a.ts" } });
    await expect(summary(["b.ts"], runtime(root), "json")).rejects.toThrow("File not found: b.ts. Did you mean: a.ts?");
  });
});

describe("scan (#767)", () => {
  it("leaves out cacheSize, which reads 0 right after a cache restore", async () => {
    mocks.executeGetIndexStatus.mockResolvedValue({ state: "complete", cacheSize: 0, reverseIndexStats: { indexedFiles: 8 } });

    expect(JSON.parse(await scan([], runtime(), "json"))).toEqual({ state: "complete", reverseIndexStats: { indexedFiles: 8 } });
  });
});
