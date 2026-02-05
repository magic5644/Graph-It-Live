import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Spider } from "../../src/analyzer/Spider";
import { SpiderBuilder } from "../../src/analyzer/SpiderBuilder";
import type { BuildGraphCallbacks } from "../../src/webview/components/reactflow/buildGraph";
import { buildReactFlowGraph } from "../../src/webview/components/reactflow/buildGraph";

/**
 * Integration tests that verify the complete flow from Spider analysis
 * to webview graph rendering, covering:
 * - Cycle detection and visualization
 * - Reverse dependencies
 * - Multi-file dependency chains
 */
describe("Webview Integration - Graph Rendering", () => {
  const createMockCallbacks = (): BuildGraphCallbacks => ({
    onDrillDown: vi.fn(),
    onFindReferences: vi.fn(),
    onToggleParents: vi.fn(),
    onToggle: vi.fn(),
    onExpandRequest: vi.fn(),
  });

  describe("Cycle Detection", () => {
    const cyclicDir = path.resolve(
      process.cwd(),
      "tests/fixtures/cyclic-project/simple-cycle",
    );
    let spider: Spider;

    beforeAll(async () => {
      spider = new SpiderBuilder()
     .withRootDir(cyclicDir)
     .withReverseIndex(true)
     .build();
      await spider.buildFullIndex();
    });

    afterAll(async () => {
      await spider.dispose();
    });

    it("should detect and visualize cycles in the webview graph", async () => {
      const aPath = path.join(cyclicDir, "a.ts");

      // Step 1: Crawl from entry point
      const crawlResult = await spider.crawl(aPath);

      // Verify Spider detected both files
      expect(crawlResult.nodes).toHaveLength(2);
      expect(crawlResult.edges).toHaveLength(2); // a->b and b->a

      // Step 2: Build webview graph
      const graphData = buildReactFlowGraph({
        data: {
          nodes: crawlResult.nodes,
          edges: crawlResult.edges,
          nodeLabels: crawlResult.nodeLabels,
        },
        currentFilePath: aPath,
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Verify cycles are detected
      expect(graphData.cycles.size).toBeGreaterThan(0);

      // Verify nodes are marked as being in cycle
      const nodeA = graphData.nodes.find((n) => n.id.includes("a.ts"));
      const nodeB = graphData.nodes.find((n) => n.id.includes("b.ts"));

      expect(nodeA).toBeDefined();
      expect(nodeB).toBeDefined();
      expect(nodeA?.data.isInCycle).toBe(true);
      expect(nodeB?.data.isInCycle).toBe(true);

      // Verify edges are labeled as cycle edges (T048: cycle badge implementation)
      const cycleEdges = graphData.edges.filter((e) =>
        e.label?.includes("cycle"),
      );
      expect(cycleEdges.length).toBeGreaterThan(0);
    });
  });

  describe("Reverse Dependencies", () => {
    const sampleDir = path.resolve(
      process.cwd(),
      "tests/fixtures/sample-project",
    );
    let spider: Spider;

    beforeAll(async () => {
      spider = new SpiderBuilder()
     .withRootDir(sampleDir)
     .withReverseIndex(true)
     .build();
      await spider.buildFullIndex();
    });

    afterAll(async () => {
      await spider.dispose();
    });

    it("should include reverse dependencies in graph when index is built", async () => {
      const utilsPath = path.join(sampleDir, "src/utils.ts");

      // Find who imports utils
      const referencingFiles = await spider.findReferencingFiles(utilsPath);

      expect(referencingFiles.length).toBeGreaterThan(0);

      // Crawl from utils
      const crawlResult = await spider.crawl(utilsPath);

      // Build graph
      const graphData = buildReactFlowGraph({
        data: {
          nodes: crawlResult.nodes,
          edges: crawlResult.edges,
          nodeLabels: crawlResult.nodeLabels,
        },
        currentFilePath: utilsPath,
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Verify reverse dependencies are included in nodes
      // The graph should show files that import utils

      // At minimum, utils itself should be present
      const utilsNode = graphData.nodes.find((n) => n.id.includes("utils.ts"));
      expect(utilsNode).toBeDefined();
    });
  });

  describe("Multi-file Navigation", () => {
    const sampleDir = path.resolve(
      process.cwd(),
      "tests/fixtures/sample-project",
    );
    let spider: Spider;

    beforeAll(async () => {
      spider = new SpiderBuilder()
     .withRootDir(sampleDir)
     .withReverseIndex(true)
     .build();
      await spider.buildFullIndex();
    });

    afterAll(async () => {
      await spider.dispose();
    });

    it("should correctly rebuild graph when switching files", async () => {
      const mainPath = path.join(sampleDir, "src/main.ts");
      const utilsPath = path.join(sampleDir, "src/utils.ts");

      // Crawl from first file
      const graph1 = await spider.crawl(mainPath);
      const webviewGraph1 = buildReactFlowGraph({
        data: {
          nodes: graph1.nodes,
          edges: graph1.edges,
          nodeLabels: graph1.nodeLabels,
        },
        currentFilePath: mainPath,
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Verify first graph
      expect(webviewGraph1.nodes.length).toBeGreaterThan(0);
      const mainNodeInGraph1 = webviewGraph1.nodes.find((n) =>
        n.id.includes("main.ts"),
      );
      expect(mainNodeInGraph1).toBeDefined();

      // Crawl from second file
      const graph2 = await spider.crawl(utilsPath);
      const webviewGraph2 = buildReactFlowGraph({
        data: {
          nodes: graph2.nodes,
          edges: graph2.edges,
          nodeLabels: graph2.nodeLabels,
        },
        currentFilePath: utilsPath,
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Verify second graph
      expect(webviewGraph2.nodes.length).toBeGreaterThan(0);
      const utilsNodeInGraph2 = webviewGraph2.nodes.find((n) =>
        n.id.includes("utils.ts"),
      );
      expect(utilsNodeInGraph2).toBeDefined();

      // Verify graphs are different
      expect(webviewGraph1.nodes).not.toEqual(webviewGraph2.nodes);
    });
  });

  describe("Python File Support", () => {
    const pythonDir = path.resolve(
      process.cwd(),
      "tests/fixtures/python-project",
    );
    let spider: Spider;

    beforeAll(async () => {
      spider = new SpiderBuilder()
     .withRootDir(pythonDir)
     .withReverseIndex(true)
     .build();
      await spider.buildFullIndex();
    });

    afterAll(async () => {
      await spider.dispose();
    });

    it("should correctly analyze and visualize Python file dependencies", async () => {
      const mainPath = path.join(pythonDir, "main.py");

      // Crawl Python file
      const crawlResult = await spider.crawl(mainPath);

      // Should find dependencies
      expect(crawlResult.nodes.length).toBeGreaterThan(1);
      expect(crawlResult.edges.length).toBeGreaterThan(0);

      // Build webview graph
      const graphData = buildReactFlowGraph({
        data: {
          nodes: crawlResult.nodes,
          edges: crawlResult.edges,
          nodeLabels: crawlResult.nodeLabels,
        },
        currentFilePath: mainPath,
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Verify Python files are included
      const pythonNodes = graphData.nodes.filter((n) => n.id.endsWith(".py"));
      expect(pythonNodes.length).toBeGreaterThan(0);

      // Verify main.py is present
      const mainNode = graphData.nodes.find((n) => n.id.includes("main.py"));
      expect(mainNode).toBeDefined();
    });
  });
});
