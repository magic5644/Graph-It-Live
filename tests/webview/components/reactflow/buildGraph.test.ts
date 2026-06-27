import { describe, expect, it, vi } from "vitest";
import type { GraphData } from "../../../../src/shared/types";
import type { BuildGraphCallbacks } from "../../../../src/webview/components/reactflow/buildGraph";
import {
  buildReactFlowGraph,
  GRAPH_LIMITS,
} from "../../../../src/webview/components/reactflow/buildGraph";

describe("buildReactFlowGraph", () => {
  const createMockCallbacks = (): BuildGraphCallbacks => ({
    onNodeClick: vi.fn(),
    onDrillDown: vi.fn(),
    onFindReferences: vi.fn(),
    onToggleParents: vi.fn(),
    onToggle: vi.fn(),
    onExpandRequest: vi.fn(),
  });

  const createBasicGraphData = (): GraphData => ({
    nodes: ["root.ts", "child1.ts", "child2.ts"],
    edges: [
      { source: "root.ts", target: "child1.ts" },
      { source: "root.ts", target: "child2.ts" },
    ],
    nodeLabels: {
      "root.ts": "root.ts",
      "child1.ts": "child1.ts",
      "child2.ts": "child2.ts",
    },
  });

  describe("empty data handling", () => {
    it("should return empty result when data is undefined", () => {
      const result = buildReactFlowGraph({
        data: undefined,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
      expect(result.cycles.size).toBe(0);
      expect(result.edgesTruncated).toBe(false);
      expect(result.nodesTruncated).toBe(false);
    });

    it("should return empty result when nodes array is empty", () => {
      const result = buildReactFlowGraph({
        data: { nodes: [], edges: [] },
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });
  });

  describe("basic graph building", () => {
    it("should build graph with root node only when nothing is expanded", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.some((n) => n.id === "root.ts")).toBe(true);
    });

    it("should include children when root is expanded", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(["root.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.some((n) => n.id === "child1.ts")).toBe(true);
      expect(result.nodes.some((n) => n.id === "child2.ts")).toBe(true);
    });

    it("should expand all nodes when expandAll is true", () => {
      const data = createBasicGraphData();
      // When expandAll=true, expandedNodes should contain all nodes with children
      const expandedNodes = new Set(["root.ts"]);
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes,
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.length).toBe(3);
      // Only nodes with children (or root) are marked as expanded
      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      expect(rootNode?.data.isExpanded).toBe(true);
      // Children are visible (meaning root is expanded)
      expect(result.nodes.some((n) => n.id === "child1.ts")).toBe(true);
      expect(result.nodes.some((n) => n.id === "child2.ts")).toBe(true);
    });
  });

  describe("parent nodes handling", () => {
    it("should include parent nodes when showParents is true", () => {
      const data: GraphData = {
        nodes: ["parent.ts", "root.ts", "child.ts"],
        edges: [
          { source: "parent.ts", target: "root.ts" },
          { source: "root.ts", target: "child.ts" },
        ],
        nodeLabels: {
          "parent.ts": "parent.ts",
          "root.ts": "root.ts",
          "child.ts": "child.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: true,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodes.some((n) => n.id === "parent.ts")).toBe(true);
      const parentNode = result.nodes.find((n) => n.id === "parent.ts");
      expect((parentNode?.data as any).isParent).toBe(true);
    });
  });

  describe("cycle detection", () => {
    it("should detect cycles in the graph", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts", "c.ts"],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "b.ts", target: "c.ts" },
          { source: "c.ts", target: "a.ts" }, // Cycle
        ],
        nodeLabels: {
          "a.ts": "a.ts",
          "b.ts": "b.ts",
          "c.ts": "c.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.cycles.size).toBeGreaterThan(0);
      const cyclicNodes = result.nodes.filter((n) => (n.data as any).isInCycle);
      expect(cyclicNodes.length).toBeGreaterThan(0);
    });

    it("should mark cyclic edges with special styling", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "b.ts", target: "a.ts" }, // Cycle
        ],
        nodeLabels: {
          "a.ts": "a.ts",
          "b.ts": "b.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const cyclicEdge = result.edges.find((e) => e.label === "Cycle");
      if (cyclicEdge) {
        expect(cyclicEdge.style).toHaveProperty("stroke", "#ff4d4d");
        expect(cyclicEdge.style).toHaveProperty("strokeDasharray", "5,5");
      }
    });
  });

  describe("edge truncation", () => {
    it("should truncate edges when exceeding MAX_PROCESS_EDGES", () => {
      const edges = Array.from(
        { length: GRAPH_LIMITS.MAX_PROCESS_EDGES + 100 },
        (_, i) => ({
          source: "root.ts",
          target: `child${i}.ts`,
        }),
      );

      const nodes = ["root.ts", ...edges.map((e) => e.target)];

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map((n) => [n, n])),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.edgesTruncated).toBe(true);
    });

    it("should not truncate when edges are within limits", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.edgesTruncated).toBe(false);
    });

    it("keeps edges relevant to expanded nodes when the full edge list is truncated", () => {
      const root = "/workspace/src/root.ts";
      const nodeB = "/workspace/src/b.ts";
      const nodeC = "/workspace/src/c.ts";

      const noiseEdges = Array.from(
        { length: GRAPH_LIMITS.MAX_PROCESS_EDGES + 5 },
        (_, i) => ({
          source: `/workspace/noise/${i}.ts`,
          target: `/workspace/noise/${i}-dep.ts`,
        }),
      );

      const data: GraphData = {
        nodes: [root, nodeB, nodeC],
        edges: [
          ...noiseEdges,
          // Put the relevant edges at the very end: old "slice(0, N)" logic would drop them.
          { source: root, target: nodeB },
          { source: nodeB, target: nodeC },
        ],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: root,
        expandAll: false,
        expandedNodes: new Set([nodeB]),
        showParents: false,
        callbacks: {
          onNodeClick: () => {},
          onDrillDown: () => {},
          onFindReferences: () => {},
          onToggle: () => {},
          onExpandRequest: () => {},
        },
      });

      // Root expands by default and nodeB is explicitly expanded, so nodeC must be visible.
      expect(result.nodes.some((n) => n.id.endsWith("/c.ts"))).toBe(true);
    });
  });

  describe("node data properties", () => {
    it("should mark root node correctly", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      expect(rootNode?.data.isRoot).toBe(true);
      expect(rootNode?.data.isExpanded).toBe(true); // Root is always expanded
    });

    it("should set hasChildren property correctly", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      expect(rootNode?.data.hasChildren).toBe(true);

      const childNode = result.nodes.find((n) => n.id === "child1.ts");
      expect(childNode?.data.hasChildren).toBe(false);
    });

    it("should bind callbacks to node data", () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      expect(rootNode?.data.onDrillDown).toBeDefined();
      expect(rootNode?.data.onToggle).toBeDefined();
      expect(rootNode?.data.onExpandRequest).toBeDefined();

      // Test callback execution
      rootNode?.data.onToggle?.();
      expect(callbacks.onToggle).toHaveBeenCalledWith("root.ts");
    });
  });

  describe("path normalization", () => {
    it("should normalize paths consistently", () => {
      const data: GraphData = {
        nodes: ["root.ts", "Child1.ts"],
        edges: [{ source: "root.ts", target: "Child1.ts" }],
        nodeLabels: {
          "root.ts": "root.ts",
          "Child1.ts": "Child1.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should find node regardless of case (on case-insensitive systems)
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  });

  describe("expanded nodes tracking", () => {
    it("should respect expandedNodes set", () => {
      const data: GraphData = {
        nodes: ["root.ts", "a.ts", "b.ts", "c.ts"],
        edges: [
          { source: "root.ts", target: "a.ts" },
          { source: "a.ts", target: "b.ts" },
          { source: "b.ts", target: "c.ts" },
        ],
        nodeLabels: {
          "root.ts": "root.ts",
          "a.ts": "a.ts",
          "b.ts": "b.ts",
          "c.ts": "c.ts",
        },
      };

      // Expand only 'a.ts'
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should include root, a, and b (child of a), but not necessarily c
      expect(result.nodes.some((n) => n.id === "root.ts")).toBe(true);
      expect(result.nodes.some((n) => n.id === "a.ts")).toBe(true);
      expect(result.nodes.some((n) => n.id === "b.ts")).toBe(true);
    });
  });

  describe("node labels", () => {
    it("should use provided node labels", () => {
      const data: GraphData = {
        nodes: ["src/components/Button.tsx"],
        edges: [],
        nodeLabels: {
          "src/components/Button.tsx": "Button Component",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "src/components/Button.tsx",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const node = result.nodes.find((n) => n.id.includes("Button"));
      expect(node?.data.label).toBe("Button Component");
    });

    it("should fallback to filename when no label provided", () => {
      const data: GraphData = {
        nodes: ["src/components/Button.tsx"],
        edges: [],
        nodeLabels: {},
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "src/components/Button.tsx",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const node = result.nodes[0];
      expect(node?.data.label).toBe("Button.tsx");
    });
  });

  describe("parent count tracking", () => {
    it("should include parent count in node data", () => {
      const data: GraphData = {
        nodes: ["root.ts", "child.ts"],
        edges: [{ source: "root.ts", target: "child.ts" }],
        nodeLabels: {
          "root.ts": "root.ts",
          "child.ts": "child.ts",
        },
        parentCounts: {
          "child.ts": 5,
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const childNode = result.nodes.find((n) => n.id === "child.ts");
      expect((childNode?.data as any).parentCount).toBe(5);
      expect((childNode?.data as any).hasReferencingFiles).toBe(true);
    });

    it("should keep root reverse-dependency toggle available without parentCounts", () => {
      const data: GraphData = {
        nodes: ["root.ts", "child.ts"],
        edges: [{ source: "root.ts", target: "child.ts" }],
        nodeLabels: {
          "root.ts": "root.ts",
          "child.ts": "child.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      expect((rootNode?.data as any).hasReferencingFiles).toBe(true);
    });
  });

  describe("edge deduplication", () => {
    it("should deduplicate edges with same source and target", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "a.ts", target: "b.ts" }, // Duplicate
          { source: "a.ts", target: "b.ts" }, // Duplicate
        ],
        nodeLabels: {
          "a.ts": "a.ts",
          "b.ts": "b.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Should only have one edge
      const edges = result.edges.filter(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(edges.length).toBe(1);
    });
  });

  describe("node truncation", () => {
    it("should truncate nodes when exceeding MAX_RENDER_NODES", () => {
      const nodeCount = GRAPH_LIMITS.MAX_RENDER_NODES + 50;
      const nodes = Array.from({ length: nodeCount }, (_, i) => `node${i}.ts`);
      const edges = nodes.slice(1).map((target, i) => ({
        source: nodes[i],
        target,
      }));

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map((n) => [n, n])),
      };

      // When expandAll=true, expandedNodes should contain all nodes with children (sources in edges)
      const expandedNodes = new Set(edges.map((e) => e.source));
      const result = buildReactFlowGraph({
        data,
        currentFilePath: nodes[0],
        expandAll: true,
        expandedNodes,
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodesTruncated).toBe(true);
      expect(result.nodes.length).toBeLessThanOrEqual(
        GRAPH_LIMITS.MAX_RENDER_NODES,
      );
    });
  });

  describe("render edge truncation", () => {
    it("should truncate rendered edges when exceeding MAX_RENDER_EDGES", () => {
      const edgeCount = GRAPH_LIMITS.MAX_RENDER_EDGES + 100;
      const nodes = Array.from(
        { length: edgeCount + 1 },
        (_, i) => `node${i}.ts`,
      );
      const edges = Array.from({ length: edgeCount }, (_, i) => ({
        source: "node0.ts",
        target: `node${i + 1}.ts`,
      }));

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map((n) => [n, n])),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "node0.ts",
        expandAll: true,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      expect(result.renderEdgesTruncated).toBe(true);
      expect(result.edges.length).toBeLessThanOrEqual(
        GRAPH_LIMITS.MAX_RENDER_EDGES,
      );
    });
  });

  describe("edge styling - call vs reference (T053)", () => {
    it("should apply solid style to call edges", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [{ source: "a.ts", target: "b.ts", relationType: "call" }],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const edge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(edge).toBeDefined();
      expect(edge?.style?.strokeWidth).toBe(2);
      expect(edge?.style?.strokeDasharray).toBeUndefined();
      expect(edge?.animated).toBe(true);
    });

    it("should apply dashed style to reference edges", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [{ source: "a.ts", target: "b.ts", relationType: "reference" }],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const edge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(edge).toBeDefined();
      expect(edge?.style?.strokeDasharray).toBe("4 4");
      expect(edge?.label).toBe("references");
      expect(edge?.animated).toBe(true);
    });

    it("should apply cycle badge to circular dependencies", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [
          { source: "a.ts", target: "b.ts", relationType: "call" },
          { source: "b.ts", target: "a.ts", relationType: "call" },
        ],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts", "b.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Both nodes should be in cycles
      expect(result.cycles.has("a.ts")).toBe(true);
      expect(result.cycles.has("b.ts")).toBe(true);

      // At least one edge should have cycle styling
      const cycleEdge = result.edges.find(
        (e) => typeof e.label === "string" && e.label.includes("cycle"),
      );
      expect(cycleEdge).toBeDefined();
      expect(cycleEdge?.style?.strokeWidth).toBe(2.5);
      expect(cycleEdge?.animated).toBe(true);
    });

    it("should apply dim style to unused edges when mode is dim", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts", "c.ts"],
        edges: [
          { source: "a.ts", target: "b.ts", relationType: "call" },
          { source: "a.ts", target: "c.ts", relationType: "call" },
        ],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts", "c.ts": "c.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        unusedEdges: ["a.ts->c.ts"],
        unusedDependencyMode: "dim",
        filterUnused: true,
      });

      const unusedEdge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "c.ts",
      );
      expect(unusedEdge).toBeDefined();
      expect(unusedEdge?.style?.opacity).toBe(0.3);
      expect(unusedEdge?.style?.strokeDasharray).toBe("5 5");
      expect(unusedEdge?.label).toBe("unused");
      expect(unusedEdge?.animated).toBe(false);

      const usedEdge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(usedEdge).toBeDefined();
      expect(usedEdge?.style?.opacity).not.toBe(0.3);
    });

    it("should prioritize cycle styling over reference styling", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [
          { source: "a.ts", target: "b.ts", relationType: "reference" },
          { source: "b.ts", target: "a.ts", relationType: "reference" },
        ],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts", "b.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // Cycle detection should override reference styling
      const edges = result.edges.filter(
        (e) => typeof e.label === "string" && e.label.includes("cycle"),
      );
      expect(edges.length).toBeGreaterThan(0);

      // Cycle styling takes precedence
      const cycleEdge = edges[0];
      expect(cycleEdge.style?.strokeWidth).toBe(2.5);
      expect(typeof cycleEdge.label === "string" && cycleEdge.label).toContain(
        "cycle",
      );
    });

    it("should handle mixed edge types in same graph", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts", "c.ts", "d.ts"],
        edges: [
          { source: "a.ts", target: "b.ts", relationType: "call" },
          { source: "a.ts", target: "c.ts", relationType: "reference" },
          { source: "b.ts", target: "d.ts", relationType: "call" },
        ],
        nodeLabels: {
          "a.ts": "a.ts",
          "b.ts": "b.ts",
          "c.ts": "c.ts",
          "d.ts": "d.ts",
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts", "b.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const callEdges = result.edges.filter(
        (e) => e.style?.strokeWidth === 2 && !e.style?.strokeDasharray,
      );
      const referenceEdges = result.edges.filter(
        (e) => e.style?.strokeDasharray === "4 4",
      );

      expect(callEdges.length).toBeGreaterThan(0);
      expect(referenceEdges.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: internal helpers exercised via buildReactFlowGraph
  // ---------------------------------------------------------------------------

  describe("unusedDependencyMode: hide — getEdgesForProcessing + createVisibleEdges", () => {
    it("removes unused edges completely when mode is hide", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts", "c.ts"],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "a.ts", target: "c.ts" },
        ],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts", "c.ts": "c.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        unusedEdges: ["a.ts->c.ts"],
        unusedDependencyMode: "hide",
        filterUnused: true,
      });

      // c.ts edge is completely removed
      const cEdge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "c.ts",
      );
      expect(cEdge).toBeUndefined();

      // b.ts edge is kept
      const bEdge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(bEdge).toBeDefined();
    });

    it("keeps all edges when filterUnused is false regardless of mode", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [{ source: "a.ts", target: "b.ts" }],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        unusedEdges: ["a.ts->b.ts"],
        unusedDependencyMode: "hide",
        filterUnused: false,
      });

      const edge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(edge).toBeDefined();
    });

    it("unusedDependencyMode: none keeps all edges without dim", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts"],
        edges: [{ source: "a.ts", target: "b.ts" }],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "a.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        unusedEdges: ["a.ts->b.ts"],
        unusedDependencyMode: "none",
        filterUnused: true,
      });

      const edge = result.edges.find(
        (e) => e.source === "a.ts" && e.target === "b.ts",
      );
      expect(edge).toBeDefined();
      // No dim/opacity override
      expect(edge?.style?.opacity).not.toBe(0.3);
    });
  });

  describe("layout variants — force and radial", () => {
    it("builds graph with layout: force", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(["root.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        layout: "force",
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.edgesTruncated).toBe(false);
    });

    it("builds graph with layout: radial", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(["root.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        layout: "radial",
      });

      expect(result.nodes.length).toBeGreaterThan(0);
    });

    it("builds graph with layout: hierarchical (default)", () => {
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(["root.ts"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        layout: "hierarchical",
      });

      expect(result.nodes.length).toBeGreaterThan(0);
    });
  });

  describe("symbol mode — createNodeData symbol branch", () => {
    it("builds symbol nodes from symbolData", () => {
      const data: GraphData = {
        nodes: ["file.ts:FunctionA", "file.ts:FunctionB"],
        edges: [
          { source: "file.ts:FunctionA", target: "file.ts:FunctionB" },
        ],
        nodeLabels: {
          "file.ts:FunctionA": "FunctionA",
          "file.ts:FunctionB": "FunctionB",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:FunctionA",
            name: "FunctionA",
            kind: "function",
            category: "function" as const,
            line: 10,
            isExported: true,
          },
          {
            id: "file.ts:FunctionB",
            name: "FunctionB",
            kind: "function",
            category: "function" as const,
            line: 20,
            isExported: false,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:FunctionA",
        expandAll: true,
        expandedNodes: new Set(["file.ts:FunctionA"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      const nodeA = result.nodes.find((n) =>
        n.id.includes("FunctionA"),
      );
      expect(nodeA).toBeDefined();
      expect(nodeA?.type).toBe("symbol");
    });

    it("handles external symbols (not found in symbolData.symbols)", () => {
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "external-lib:ExternalFn"],
        edges: [
          { source: "file.ts:LocalFn", target: "external-lib:ExternalFn" },
        ],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "external-lib:ExternalFn": "ExternalFn",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 5,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
      });

      // ExternalFn is an external symbol — should still be a node
      const externalNode = result.nodes.find((n) =>
        n.id.includes("ExternalFn"),
      );
      expect(externalNode).toBeDefined();
    });

    it("infers category: method for dotted external symbol labels", () => {
      // label "service.doThing" → contains '.' → category inferred as 'method'
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "lib:service.doThing"],
        edges: [
          { source: "file.ts:LocalFn", target: "lib:service.doThing" },
        ],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "lib:service.doThing": "service.doThing",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: false,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
      });

      const methodNode = result.nodes.find((n) =>
        n.id.includes("service.doThing"),
      );
      expect(methodNode).toBeDefined();
    });
  });

  describe("highlightState — étape 4 highlight props", () => {
    it("marks highlighted nodes when highlightState is provided", () => {
      const data: GraphData = {
        nodes: ["file.ts:FnA", "file.ts:FnB"],
        edges: [{ source: "file.ts:FnA", target: "file.ts:FnB" }],
        nodeLabels: {
          "file.ts:FnA": "FnA",
          "file.ts:FnB": "FnB",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:FnA",
            name: "FnA",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: true,
          },
          {
            id: "file.ts:FnB",
            name: "FnB",
            kind: "function",
            category: "function" as const,
            line: 5,
            isExported: false,
          },
        ],
        dependencies: [],
      };

      const highlightState = {
        highlightedNodes: new Set(["file.ts:FnA"]),
        highlightedEdges: new Set(["file.ts:FnA->file.ts:FnB"]),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:FnA",
        expandAll: true,
        expandedNodes: new Set(["file.ts:FnA"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
        highlightState,
      });

      const nodeA = result.nodes.find((n) => n.id === "file.ts:FnA");
      expect((nodeA?.data as any).isHighlighted).toBe(true);
      expect((nodeA?.data as any).isHighlightActive).toBe(true);

      const nodeB = result.nodes.find((n) => n.id === "file.ts:FnB");
      expect((nodeB?.data as any).isHighlighted).toBe(false);
      expect((nodeB?.data as any).isHighlightActive).toBe(true);
    });

    it("sets isHighlightActive to false when highlightState is null", () => {
      const data: GraphData = {
        nodes: ["file.ts:FnA"],
        edges: [],
        nodeLabels: { "file.ts:FnA": "FnA" },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:FnA",
            name: "FnA",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:FnA",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
        highlightState: null,
      });

      const nodeA = result.nodes.find((n) => n.id === "file.ts:FnA");
      expect((nodeA?.data as any).isHighlightActive).toBe(false);
    });
  });

  describe("addParentNodes — parent truncation", () => {
    it("marks nodesTruncated when parents exceed MAX_RENDER_NODES", () => {
      // Build a graph where root has more parents than the limit
      const parentCount = GRAPH_LIMITS.MAX_RENDER_NODES + 10;
      const parents = Array.from(
        { length: parentCount },
        (_, i) => `parent${i}.ts`,
      );
      const data: GraphData = {
        nodes: ["root.ts", ...parents],
        edges: parents.map((p) => ({ source: p, target: "root.ts" })),
        nodeLabels: {
          "root.ts": "root.ts",
          ...Object.fromEntries(parents.map((p) => [p, p])),
        },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: true,
        callbacks: createMockCallbacks(),
      });

      expect(result.nodesTruncated).toBe(true);
    });
  });

  describe("buildRelationshipMaps — edge processing", () => {
    it("handles graph where a node has both incoming and outgoing edges", () => {
      const data: GraphData = {
        nodes: ["a.ts", "b.ts", "c.ts"],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "b.ts", target: "c.ts" },
        ],
        nodeLabels: { "a.ts": "a.ts", "b.ts": "b.ts", "c.ts": "c.ts" },
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "b.ts",
        expandAll: true,
        expandedNodes: new Set(["a.ts", "b.ts"]),
        showParents: true,
        callbacks: createMockCallbacks(),
      });

      // b.ts is root, should have both a.ts (parent) and c.ts (child) visible
      expect(result.nodes.some((n) => n.id === "a.ts")).toBe(true);
      expect(result.nodes.some((n) => n.id === "c.ts")).toBe(true);
    });
  });

  describe("MAX_CYCLE_DETECT_EDGES threshold", () => {
    it("skips cycle detection when edge count exceeds MAX_CYCLE_DETECT_EDGES", () => {
      // Build a graph that exceeds the cycle detection threshold
      const edgeCount = GRAPH_LIMITS.MAX_CYCLE_DETECT_EDGES + 1;
      const nodes = Array.from({ length: edgeCount + 1 }, (_, i) => `n${i}.ts`);
      const edges = Array.from({ length: edgeCount }, (_, i) => ({
        source: `n${i}.ts`,
        target: `n${i + 1}.ts`,
      }));

      const data: GraphData = {
        nodes,
        edges,
        nodeLabels: Object.fromEntries(nodes.map((n) => [n, n])),
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "n0.ts",
        expandAll: true,
        expandedNodes: new Set(nodes),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      // cycles should be empty when edge count exceeds threshold
      expect(result.cycles.size).toBe(0);
    });
  });

  describe("nodeLabels fallback — path.pop()", () => {
    it("falls back to the last path segment when nodeLabels is undefined", () => {
      const data: GraphData = {
        nodes: ["src/utils/helper.ts"],
        edges: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "src/utils/helper.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks: createMockCallbacks(),
      });

      const node = result.nodes[0];
      expect(node?.data.label).toBe("helper.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // Callback invocation — covers the inline arrow functions in createNodeData
  // These are created but never called unless we explicitly invoke them.
  // ---------------------------------------------------------------------------

  describe("file mode node callbacks", () => {
    it("onFindReferences callback calls the underlying callbacks.onFindReferences", () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: true,
        expandedNodes: new Set(["root.ts"]),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      (rootNode?.data as any).onFindReferences?.();
      expect(callbacks.onFindReferences).toHaveBeenCalledWith("root.ts");
    });

    it("onToggleParents callback calls the underlying callbacks.onToggleParents", () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      (rootNode?.data as any).onToggleParents?.();
      expect(callbacks.onToggleParents).toHaveBeenCalledWith("root.ts");
    });

    it("onNodeClick (file mode) callback calls callbacks.onNodeClick", () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      (rootNode?.data as any).onNodeClick?.();
      expect(callbacks.onNodeClick).toHaveBeenCalledWith("root.ts");
    });

    it("onDrillDown (file mode) callback calls callbacks.onDrillDown", () => {
      const callbacks = createMockCallbacks();
      const data = createBasicGraphData();
      const result = buildReactFlowGraph({
        data,
        currentFilePath: "root.ts",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
      });

      const rootNode = result.nodes.find((n) => n.id === "root.ts");
      (rootNode?.data as any).onDrillDown?.();
      expect(callbacks.onDrillDown).toHaveBeenCalledWith("root.ts");
    });
  });

  describe("symbol mode external node callbacks", () => {
    it("onNodeClick on external symbol calls callbacks.onNodeClick with filePath", () => {
      const callbacks = createMockCallbacks();
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "external-lib:ExternalFn"],
        edges: [{ source: "file.ts:LocalFn", target: "external-lib:ExternalFn" }],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "external-lib:ExternalFn": "ExternalFn",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks,
        mode: "symbol",
        symbolData,
      });

      const externalNode = result.nodes.find((n) => n.id.includes("ExternalFn"));
      (externalNode?.data as any).onNodeClick?.();
      expect(callbacks.onNodeClick).toHaveBeenCalledWith("external-lib", 0);
    });

    it("onDrillDown on external symbol calls callbacks.onDrillDown with path", () => {
      const callbacks = createMockCallbacks();
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "external-lib:ExternalFn"],
        edges: [{ source: "file.ts:LocalFn", target: "external-lib:ExternalFn" }],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "external-lib:ExternalFn": "ExternalFn",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks,
        mode: "symbol",
        symbolData,
      });

      const externalNode = result.nodes.find((n) => n.id.includes("ExternalFn"));
      (externalNode?.data as any).onDrillDown?.();
      expect(callbacks.onDrillDown).toHaveBeenCalledWith("external-lib:ExternalFn");
    });

    it("onToggle on external symbol calls callbacks.onToggle with path", () => {
      const callbacks = createMockCallbacks();
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "external-lib:ExternalFn"],
        edges: [{ source: "file.ts:LocalFn", target: "external-lib:ExternalFn" }],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "external-lib:ExternalFn": "ExternalFn",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks,
        mode: "symbol",
        symbolData,
      });

      const externalNode = result.nodes.find((n) => n.id.includes("ExternalFn"));
      (externalNode?.data as any).onToggle?.();
      expect(callbacks.onToggle).toHaveBeenCalledWith("external-lib:ExternalFn");
    });

    it("infers class category for uppercase external symbol", () => {
      const data: GraphData = {
        nodes: ["file.ts:LocalFn", "lib:MyClass"],
        edges: [{ source: "file.ts:LocalFn", target: "lib:MyClass" }],
        nodeLabels: {
          "file.ts:LocalFn": "LocalFn",
          "lib:MyClass": "MyClass",
        },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:LocalFn",
            name: "LocalFn",
            kind: "function",
            category: "function" as const,
            line: 1,
            isExported: false,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:LocalFn",
        expandAll: true,
        expandedNodes: new Set(["file.ts:LocalFn"]),
        showParents: false,
        callbacks: createMockCallbacks(),
        mode: "symbol",
        symbolData,
      });

      const classNode = result.nodes.find((n) => n.id.includes("MyClass"));
      expect(classNode).toBeDefined();
      // category should be 'class' (label starts with uppercase)
      expect((classNode?.data as any).category).toBe("class");
    });
  });

  describe("symbol mode known node callbacks", () => {
    it("onNodeClick on known symbol calls callbacks.onNodeClick with symbol.id and line", () => {
      const callbacks = createMockCallbacks();
      const data: GraphData = {
        nodes: ["file.ts:FnA"],
        edges: [],
        nodeLabels: { "file.ts:FnA": "FnA" },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:FnA",
            name: "FnA",
            kind: "function",
            category: "function" as const,
            line: 42,
            isExported: true,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:FnA",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
        mode: "symbol",
        symbolData,
      });

      const node = result.nodes.find((n) => n.id === "file.ts:FnA");
      (node?.data as any).onNodeClick?.();
      expect(callbacks.onNodeClick).toHaveBeenCalledWith("file.ts:FnA", 42);
    });

    it("onDrillDown on known symbol calls callbacks.onDrillDown", () => {
      const callbacks = createMockCallbacks();
      const data: GraphData = {
        nodes: ["file.ts:FnA"],
        edges: [],
        nodeLabels: { "file.ts:FnA": "FnA" },
      };

      const symbolData = {
        symbols: [
          {
            id: "file.ts:FnA",
            name: "FnA",
            kind: "function",
            category: "function" as const,
            line: 5,
            isExported: false,
          },
        ],
        dependencies: [],
      };

      const result = buildReactFlowGraph({
        data,
        currentFilePath: "file.ts:FnA",
        expandAll: false,
        expandedNodes: new Set(),
        showParents: false,
        callbacks,
        mode: "symbol",
        symbolData,
      });

      const node = result.nodes.find((n) => n.id === "file.ts:FnA");
      (node?.data as any).onDrillDown?.();
      expect(callbacks.onDrillDown).toHaveBeenCalledWith("file.ts:FnA");
    });
  });
});
