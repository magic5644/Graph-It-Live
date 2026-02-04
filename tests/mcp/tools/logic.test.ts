import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { executeAnalyzeFileLogic } from "../../../src/mcp/tools/logic";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("logic tools", () => {
  let tempDir: string;

  const setupWorkerState = (spiderMock: any) => {
    workerState.spider = spiderMock;
    workerState.parser = {} as any;
    workerState.resolver = {} as any;
    workerState.config = {
      rootDir: tempDir,
      excludeNodeModules: false,
      maxDepth: 3,
    };
    workerState.isReady = true;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-logic-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should analyze file logic and return an intra-file graph", async () => {
    const filePath = await createTempFile(
      tempDir,
      "sample.ts",
      "export function main() { return helper(); }\nfunction helper() { return 1; }",
    );

    const spiderMock = {
      getSymbolGraph: vi.fn(async () => ({
        symbols: [
          { name: "main", kind: "function", line: 1 },
          { name: "helper", kind: "function", line: 2 },
        ],
        dependencies: [
          {
            sourceSymbolId: `${filePath}:main`,
            targetSymbolId: `${filePath}:helper`,
          },
        ],
      })),
    };

    setupWorkerState(spiderMock);

    const result = await executeAnalyzeFileLogic({
      filePath,
      includeExternal: false,
    });

    expect(result.filePath).toBe(filePath);
    expect(result.language).toBe("typescript");
    expect(result.graph.nodes.length).toBe(2);
    expect(result.graph.edges.length).toBe(1);
    expect(result.graph.nodes.map((node) => node.name)).toEqual(
      expect.arrayContaining(["main", "helper"]),
    );
  });
});
