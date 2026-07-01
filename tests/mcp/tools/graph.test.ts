import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import {
    executeCrawlDependencyGraph,
    executeExpandNode,
    executeFindReferencingFiles,
} from "../../../src/mcp/tools/graph";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("graph tools", () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-graph-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeCrawlDependencyGraph", () => {
    it("should crawl graph and return nodes/edges", async () => {
      const entryFile = await createTempFile(tempDir, "entry.ts", "");
      const depFile = path.join(tempDir, "dep.ts");

      const spiderMock = {
        config: { maxDepth: 5 },
        updateConfig: vi.fn(),
        crawl: vi.fn(async () => ({
          nodes: [entryFile, depFile],
          edges: [{ source: entryFile, target: depFile }],
        })),
        verifyDependencyUsage: vi.fn(async () => true),
      };

      setupWorkerState(spiderMock);

      const result = await executeCrawlDependencyGraph({
        entryFile,
        maxDepth: 2,
      });

      expect(spiderMock.updateConfig).toHaveBeenCalledWith({ maxDepth: 2 });
      expect(spiderMock.updateConfig).toHaveBeenCalledWith({ maxDepth: 5 });
      expect(result.nodeCount).toBe(2);
      expect(result.edgeCount).toBe(1);
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.circularDependencies).toEqual([]);
    });

    it("should populate hubScore on each returned node", async () => {
      const entryFile = await createTempFile(tempDir, "entry.ts", "");
      const depFile = await createTempFile(tempDir, "dep.ts", "");

      const spiderMock = {
        config: { maxDepth: 5 },
        updateConfig: vi.fn(),
        crawl: vi.fn(async () => ({
          nodes: [entryFile, depFile],
          edges: [{ source: entryFile, target: depFile }],
        })),
        verifyDependencyUsage: vi.fn(async () => true),
      };

      setupWorkerState(spiderMock);

      const result = await executeCrawlDependencyGraph({ entryFile });

      // computeNodeMetadata attache toujours hubScore (même 0)
      for (const node of result.nodes) {
        expect(node).toHaveProperty("hubScore");
        expect(typeof node.hubScore).toBe("number");
      }
    });

    it("should assign distinct communityIds to nodes in different directories", async () => {
      // Crée deux fichiers dans des sous-dossiers différents pour forcer des communautés distinctes
      const subDirA = path.join(tempDir, "moduleA");
      const subDirB = path.join(tempDir, "moduleB");
      await fs.mkdir(subDirA);
      await fs.mkdir(subDirB);

      const fileA = await createTempFile(subDirA, "index.ts", "");
      const fileB = await createTempFile(subDirB, "index.ts", "");

      const spiderMock = {
        config: { maxDepth: 5 },
        updateConfig: vi.fn(),
        crawl: vi.fn(async () => ({
          nodes: [fileA, fileB],
          edges: [],
        })),
        verifyDependencyUsage: vi.fn(async () => true),
      };

      setupWorkerState(spiderMock);

      const result = await executeCrawlDependencyGraph({ entryFile: fileA });

      // Les deux nodes doivent avoir un communityId défini
      for (const node of result.nodes) {
        expect(node).toHaveProperty("communityId");
        expect(typeof node.communityId).toBe("number");
      }

      // Les communityIds des deux nodes doivent être distincts (dossiers différents)
      const communityIds = result.nodes.map((n) => n.communityId);
      expect(communityIds[0]).not.toBe(communityIds[1]);
    });
  });

  describe("executeExpandNode", () => {
    it("should expand node and return relative edge info", async () => {
      const entryFile = await createTempFile(tempDir, "entry.ts", "");
      const depFile = path.join(tempDir, "dep.ts");

      const spiderMock = {
        crawlFrom: vi.fn(async () => ({
          nodes: [depFile],
          edges: [{ source: entryFile, target: depFile }],
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeExpandNode({
        filePath: entryFile,
        knownPaths: [entryFile],
      });

      expect(result.newNodeCount).toBe(1);
      expect(result.newEdgeCount).toBe(1);
      expect(result.newEdges[0]).toEqual({
        source: entryFile,
        target: depFile,
        sourceRelative: "entry.ts",
        targetRelative: "dep.ts",
      });
    });
  });

  describe("executeFindReferencingFiles", () => {
    it("should return empty array when reverse index has no entries for target", async () => {
      const targetFile = await createTempFile(tempDir, "target.ts", "");

      const spiderMock = {
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeFindReferencingFiles({ targetPath: targetFile });

      expect(result.referencingFileCount).toBe(0);
      expect(result.referencingFiles).toEqual([]);
    });

    it("should return referencing files with relative paths", async () => {
      const targetFile = await createTempFile(tempDir, "target.ts", "");
      const refFile = path.join(tempDir, "ref.ts");

      const spiderMock = {
        findReferencingFiles: vi.fn(async () => [
          {
            path: refFile,
            type: "import",
            line: 1,
            module: "./target",
          },
        ]),
      };

      setupWorkerState(spiderMock);

      const result = await executeFindReferencingFiles({ targetPath: targetFile });

      expect(result.referencingFileCount).toBe(1);
      expect(result.referencingFiles[0]).toEqual({
        path: refFile,
        relativePath: "ref.ts",
        type: "import",
        line: 1,
        module: "./target",
      });
    });
  });
});
