import type { SymbolCluster, SymbolNode } from "@/shared/types";
import {
    buildClusters,
    calculateClusterBounds,
    calculateFitTransform,
    getClassClustersInNamespace,
    getStandaloneSymbolIds,
    getVisibleSymbolIds,
} from "@/webview/utils/clusterUtils";
import { describe, expect, it } from "vitest";

describe("clusterUtils", () => {
  // Helper to get symbol kind from type
  const getSymbolKind = (type: "class" | "function" | "variable"): number => {
    if (type === "class") return 5;
    if (type === "function") return 12;
    return 13;
  };

  // Sample symbols for testing
  const createSymbol = (
    id: string,
    name: string,
    type: "class" | "function" | "variable",
    parentSymbolId?: string
  ): SymbolNode => ({
    id,
    name,
    originalName: name,
    kind: getSymbolKind(type),
    type,
    range: { start: 1, end: 10 },
    isExported: true,
    isExternal: false,
    parentSymbolId,
  });

  describe("buildClusters", () => {
    it("should create namespace cluster from symbols", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/utils.ts:add", "add", "function"),
        createSymbol("src/utils.ts:subtract", "subtract", "function"),
      ];

      const clusters = buildClusters(symbols);

      expect(clusters.length).toBeGreaterThan(0);
      const namespaceCluster = clusters.find((c) => c.type === "namespace");
      expect(namespaceCluster).toBeDefined();
      expect(namespaceCluster?.id).toBe("src/utils.ts");
    });

    it("should create class clusters within namespace", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:constructor", "constructor", "function", "src/User.ts:User"),
        createSymbol("src/User.ts:getName", "getName", "function", "src/User.ts:User"),
      ];

      const clusters = buildClusters(symbols);

      const classCluster = clusters.find((c) => c.type === "class");
      expect(classCluster).toBeDefined();
      expect(classCluster?.name).toBe("User");
      expect(classCluster?.symbolIds).toContain("src/User.ts:constructor");
      expect(classCluster?.symbolIds).toContain("src/User.ts:getName");
    });

    it("should group symbols by namespace", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/utils.ts:add", "add", "function"),
        createSymbol("src/helpers.ts:format", "format", "function"),
      ];

      const clusters = buildClusters(symbols);

      const namespaces = clusters.filter((c) => c.type === "namespace");
      expect(namespaces.length).toBe(2);
    });

    it("should mark all clusters as open by default", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:getName", "getName", "function", "src/User.ts:User"),
      ];

      const clusters = buildClusters(symbols);

      clusters.forEach((cluster) => {
        expect(cluster.isOpen).toBe(true);
      });
    });
  });

  describe("getVisibleSymbolIds", () => {
    it("should return all symbol IDs when all clusters are open", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:getName", "getName", "function", "src/User.ts:User"),
      ];
      const clusters = buildClusters(symbols);

      const visible = getVisibleSymbolIds(clusters, symbols);

      expect(visible.size).toBe(2);
      expect(visible.has("src/User.ts:User")).toBe(true);
      expect(visible.has("src/User.ts:getName")).toBe(true);
    });

    it("should hide class members when class cluster is closed", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:getName", "getName", "function", "src/User.ts:User"),
      ];
      const clusters = buildClusters(symbols);

      // Close the class cluster
      const classCluster = clusters.find((c) => c.type === "class");
      if (classCluster) {
        classCluster.isOpen = false;
      }

      const visible = getVisibleSymbolIds(clusters, symbols);

      expect(visible.has("src/User.ts:getName")).toBe(false);
      expect(visible.has("src/User.ts:User")).toBe(true); // Class itself is still visible
    });

    it("should hide all symbols when namespace cluster is closed", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:getName", "getName", "function", "src/User.ts:User"),
      ];
      const clusters = buildClusters(symbols);

      // Close the namespace cluster
      const namespaceCluster = clusters.find((c) => c.type === "namespace");
      if (namespaceCluster) {
        namespaceCluster.isOpen = false;
      }

      const visible = getVisibleSymbolIds(clusters, symbols);

      expect(visible.size).toBe(0);
    });
  });

  describe("calculateClusterBounds", () => {
    it("should return null for empty clusters", () => {
      const bounds = calculateClusterBounds([]);
      expect(bounds).toBeNull();
    });

    it("should calculate bounding box for clusters with positions", () => {
      const clusters: SymbolCluster[] = [
        {
          id: "cluster1",
          type: "namespace",
          name: "Test",
          symbolIds: [],
          childClusterIds: [],
          isOpen: true,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        },
        {
          id: "cluster2",
          type: "namespace",
          name: "Test2",
          symbolIds: [],
          childClusterIds: [],
          isOpen: true,
          x: 150,
          y: 50,
          width: 100,
          height: 100,
        },
      ];

      const bounds = calculateClusterBounds(clusters);

      expect(bounds).not.toBeNull();
      expect(bounds?.minX).toBe(0);
      expect(bounds?.minY).toBe(0);
      expect(bounds?.maxX).toBe(250);
      expect(bounds?.maxY).toBe(150);
    });
  });

  describe("calculateFitTransform", () => {
    it("should calculate zoom to fit within viewport", () => {
      const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
      const params = {
        viewportWidth: 800,
        viewportHeight: 600,
        padding: 40,
        maxZoom: 4,
      };

      const transform = calculateFitTransform(bounds, params);

      expect(transform.scale).toBeLessThanOrEqual(4);
      expect(transform.scale).toBeGreaterThan(0);
    });

    it("should not exceed maxZoom", () => {
      const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
      const params = {
        viewportWidth: 1000,
        viewportHeight: 1000,
        padding: 40,
        maxZoom: 2,
      };

      const transform = calculateFitTransform(bounds, params);

      expect(transform.scale).toBeLessThanOrEqual(2);
    });
  });

  describe("getClassClustersInNamespace", () => {
    it("should return class clusters for a namespace", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/User.ts:User", "User", "class"),
        createSymbol("src/User.ts:Admin", "Admin", "class"),
      ];
      const clusters = buildClusters(symbols);

      const classesInNamespace = getClassClustersInNamespace(clusters, "src/User.ts");

      expect(classesInNamespace.length).toBe(2);
      classesInNamespace.forEach((c) => {
        expect(c.type).toBe("class");
        expect(c.namespace).toBe("src/User.ts");
      });
    });

    it("should return empty array for non-existent namespace", () => {
      const clusters: SymbolCluster[] = [];

      const classesInNamespace = getClassClustersInNamespace(clusters, "non-existent");

      expect(classesInNamespace).toEqual([]);
    });
  });

  describe("getStandaloneSymbolIds", () => {
    it("should return symbols not in any class", () => {
      const symbols: SymbolNode[] = [
        createSymbol("src/utils.ts:User", "User", "class"),
        createSymbol("src/utils.ts:add", "add", "function"),
        createSymbol("src/utils.ts:subtract", "subtract", "function"),
        createSymbol("src/utils.ts:method", "method", "function", "src/utils.ts:User"),
      ];
      const clusters = buildClusters(symbols);

      const standalone = getStandaloneSymbolIds(clusters, symbols, "src/utils.ts");

      expect(standalone).toContain("src/utils.ts:add");
      expect(standalone).toContain("src/utils.ts:subtract");
      expect(standalone).not.toContain("src/utils.ts:method");
      expect(standalone).not.toContain("src/utils.ts:User");
    });
  });
});
