import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { executeResolveModulePath } from "../../../src/mcp/tools/resolve";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("resolve tools", () => {
  let tempDir: string;

  const setupWorkerState = (resolverMock: any) => {
    workerState.spider = {} as any;
    workerState.parser = {} as any;
    workerState.resolver = resolverMock;
    workerState.config = {
      rootDir: tempDir,
      excludeNodeModules: false,
      maxDepth: 3,
    };
    workerState.isReady = true;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-resolve-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should resolve module path and return relative path", async () => {
    const fromFile = await createTempFile(tempDir, "entry.ts", "");
    const resolvedFile = path.join(tempDir, "dep.ts");

    const resolverMock = {
      resolve: vi.fn(async () => resolvedFile),
    };

    setupWorkerState(resolverMock);

    const result = await executeResolveModulePath({
      fromFile,
      moduleSpecifier: "./dep",
    });

    expect(result.resolved).toBe(true);
    expect(result.resolvedPath).toBe(resolvedFile);
    expect(result.resolvedRelativePath).toBe("dep.ts");
  });

  it("should return unresolved with failure reason", async () => {
    const fromFile = await createTempFile(tempDir, "entry.ts", "");

    const resolverMock = {
      resolve: vi.fn(async () => null),
    };

    setupWorkerState(resolverMock);

    const result = await executeResolveModulePath({
      fromFile,
      moduleSpecifier: "./missing",
    });

    expect(result.resolved).toBe(false);
    expect(result.resolvedPath).toBeNull();
    expect(result.failureReason).toBe(
      "Module could not be resolved (may be a node_module or non-existent file)",
    );
  });
});
