import { describe, it, expect } from "vitest";
import {
  buildDependencyDiagram,
  buildCallerDiagram,
  buildGroupedDiagram,
} from "../../../src/analyzer/wiki/DiagramBuilder.js";
import type { GraphData } from "../../../src/shared/graph-types.js";
import { normalizePath } from "../../../src/shared/path.js";
import type { WikiArticle, WikiLink } from "../../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLink(filePath: string, name = "fn"): WikiLink {
  return { filePath, name, callSiteLine: 1 };
}

function makeArticle(overrides: Partial<WikiArticle> = {}): WikiArticle {
  return {
    title: "foo",
    filePath: "/workspace/src/foo.ts",
    articlePath: "/out/articles/foo.md",
    hubScore: 10,
    symbols: [],
    callers: [],
    callees: [],
    callerCount: 0,
    calleeCount: 0,
    diagrams: [],
    ...overrides,
  };
}

/** Simple display function: strips /workspace/ prefix */
const display = (fp: string) => fp.replace("/workspace/", "");

// ---------------------------------------------------------------------------
// buildDependencyDiagram
// ---------------------------------------------------------------------------

describe("buildDependencyDiagram", () => {
  it("returns null when callees is empty", () => {
    const article = makeArticle({ callees: [] });
    expect(buildDependencyDiagram(article, display)).toBeNull();
  });

  it("returns a diagram when callees are present", () => {
    const article = makeArticle({
      callees: [makeLink("/workspace/src/bar.ts")],
    });
    const result = buildDependencyDiagram(article, display);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("dependency");
    expect(result!.title).toBe("External calls");
    expect(result!.mermaid).toContain("flowchart LR");
    expect(result!.mermaid).toContain("bar.ts");
  });

  it("filters out self-loops (callee.filePath === article.filePath)", () => {
    const article = makeArticle({
      callees: [makeLink("/workspace/src/foo.ts")], // same as article.filePath
    });
    // All callees are self — result should be null
    expect(buildDependencyDiagram(article, display)).toBeNull();
  });

  it("deduplicates callees with same filePath — produces only one edge", () => {
    const article = makeArticle({
      callees: [
        makeLink("/workspace/src/bar.ts", "fn1"),
        makeLink("/workspace/src/bar.ts", "fn2"),
      ],
    });
    const result = buildDependencyDiagram(article, display);
    expect(result).not.toBeNull();
    // Only one "-->" line for the deduplicated callee
    const edges = result!.mermaid.split("\n").filter((l) => l.includes("-->"));
    expect(edges).toHaveLength(1);
  });

  it("truncates when more than 50 callees", () => {
    const callees: WikiLink[] = Array.from({ length: 55 }, (_, i) =>
      makeLink(`/workspace/src/dep${i}.ts`),
    );
    const article = makeArticle({ callees });
    const result = buildDependencyDiagram(article, display);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.truncationNote).toMatch(/50/);
  });

  it("is not truncated when exactly 50 callees", () => {
    const callees: WikiLink[] = Array.from({ length: 50 }, (_, i) =>
      makeLink(`/workspace/src/dep${i}.ts`),
    );
    const article = makeArticle({ callees });
    const result = buildDependencyDiagram(article, display);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCallerDiagram
// ---------------------------------------------------------------------------

describe("buildCallerDiagram", () => {
  it("returns null when callers is empty", () => {
    const article = makeArticle({ callers: [] });
    expect(buildCallerDiagram(article, display)).toBeNull();
  });

  it("returns a diagram when callers are present", () => {
    const article = makeArticle({
      callers: [makeLink("/workspace/src/caller.ts")],
    });
    const result = buildCallerDiagram(article, display);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("caller");
    expect(result!.title).toBe("Called by");
    expect(result!.mermaid).toContain("flowchart LR");
    expect(result!.mermaid).toContain("caller.ts");
  });

  it("filters out self-loop callers", () => {
    const article = makeArticle({
      callers: [makeLink("/workspace/src/foo.ts")], // self
    });
    expect(buildCallerDiagram(article, display)).toBeNull();
  });

  it("deduplicates callers with same filePath — produces only one edge", () => {
    const article = makeArticle({
      callers: [
        makeLink("/workspace/src/caller.ts", "a"),
        makeLink("/workspace/src/caller.ts", "b"),
      ],
    });
    const result = buildCallerDiagram(article, display);
    expect(result).not.toBeNull();
    const edges = result!.mermaid.split("\n").filter((l) => l.includes("-->"));
    expect(edges).toHaveLength(1);
  });

  it("edges point TO the article (callers --> self)", () => {
    const article = makeArticle({
      filePath: "/workspace/src/foo.ts",
      callers: [makeLink("/workspace/src/caller.ts")],
    });
    const result = buildCallerDiagram(article, display);
    expect(result).not.toBeNull();
    // The edge must end with the article's node id, not start with it
    const edgeLine = result!.mermaid.split("\n").find((l) => l.includes("-->"))!;
    // caller node id comes first
    const [left, right] = edgeLine.split("-->").map((s) => s.trim());
    expect(left).toContain("caller");
    expect(right).toContain("foo");
  });

  it("truncates when more than 50 callers", () => {
    const callers: WikiLink[] = Array.from({ length: 60 }, (_, i) =>
      makeLink(`/workspace/src/caller${i}.ts`),
    );
    const article = makeArticle({ callers });
    const result = buildCallerDiagram(article, display);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.truncationNote).toMatch(/50/);
  });
});

// ---------------------------------------------------------------------------
// buildGroupedDiagram
// ---------------------------------------------------------------------------

describe("buildGroupedDiagram", () => {
  /** Files under /workspace/src/<group>/…; group ids follow first appearance, "" = unassigned. */
  function graph(edges: Array<[string, string]>, extraFiles: string[] = []): GraphData {
    const files = [...new Set([...edges.flat(), ...extraFiles])];
    const keys = [...new Set(files.map((file) => file.split("/")[3]).filter((key) => key.includes(".") === false))];
    const nodeMetadata = Object.fromEntries(files.map((file) => {
      const key = file.split("/")[3];
      const id = keys.indexOf(key) + 1;
      return [file, { hubScore: 0, communityId: id, communityKey: id === 0 ? "" : key }];
    }));
    return { nodes: files, edges: edges.map(([source, target]) => ({ source, target })), nodeMetadata };
  }
  const options = { display, context: "grouped by path · imports graph" };
  const api = "/workspace/src/api/index.ts";
  const api2 = "/workspace/src/api/routes.ts";
  const db = "/workspace/src/db/index.ts";
  const root = "/workspace/src/main.ts";

  it("returns null for an empty graph", () => {
    expect(buildGroupedDiagram({ nodes: [], edges: [] }, options)).toBeNull();
  });

  it("draws one subgraph per group, file edges inside groups and counted edges between them", () => {
    const result = buildGroupedDiagram(graph([[api, api2], [api, db], [api2, db], [root, api]]), options)!;

    expect(result).toMatchObject({ type: "architecture", truncated: false, truncationNote: undefined });
    expect(result.mermaid.split("\n")).toEqual([
      "flowchart LR",
      "%% grouped by path · imports graph",
      "%% 4 files, 4 file edges (1 intra-group, 3 inter-group)",
      "%% view: expanded; hidden: 0 group(s), 0 group edge(s)",
      '  subgraph G1["api (2 files)"]',
      '    F0["src/api/index.ts"]',
      '    F1["src/api/routes.ts"]',
      "  end",
      '  subgraph G0["unassigned (1 file)"]',
      '    F2["src/main.ts"]',
      "  end",
      '  subgraph G2["db (1 file)"]',
      '    F3["src/db/index.ts"]',
      "  end",
      "  F0 --> F1",
      "  G1 -->|2| G2",
      "  G0 -->|1| G1",
    ]);
  });

  it("collapses groups into nodes beyond the caps and says so", () => {
    const result = buildGroupedDiagram(graph([[api, api2], [api, db], [api2, db]]), { ...options, maxFiles: 2 })!;

    expect(result.mermaid).not.toContain("subgraph");
    expect(result.mermaid).toContain("%% view: collapsed; hidden: 0 group(s), 0 group edge(s)");
    expect(result.mermaid).toContain('  G1["api (2 files)"]');
    expect(result.mermaid).toContain("  G1 -->|2| G2");
    expect(result.truncated).toBe(true);
    expect(result.truncationNote).toBe("Collapsed to groups: 3 files and 1 intra-group edges exceed 2 files or 40 edges");
  });

  it("collapses when intra-group edges exceed maxEdges, and hides the smallest groups and weakest edges", () => {
    const cache = "/workspace/src/cache/lru.ts";
    const result = buildGroupedDiagram(
      graph([[api, api2], [api, db], [api2, db], [api, cache]]),
      { ...options, maxFiles: 2, maxEdges: 0 },
    )!;

    expect(result.mermaid).toContain("%% 4 files, 4 file edges (1 intra-group, 3 inter-group)");
    expect(result.mermaid).toContain("%% view: collapsed; hidden: 1 group(s), 2 group edge(s)");
    expect(result.mermaid).not.toContain("cache");
    expect(result.mermaid).not.toContain("-->");
    expect(result.truncationNote).toContain("1 smallest group(s) hidden; 2 weakest group edge(s) hidden");
  });

  it("keeps Mermaid valid with special characters, duplicate labels and Windows paths", () => {
    const quoted = String.raw`C:\ws\src\api\a"b|c<d>` + "`#1;.ts";
    const twin = String.raw`C:\ws\src\db\a"b|c<d>` + "`#1;.ts";
    const data: GraphData = {
      nodes: [quoted, twin],
      edges: [{ source: quoted, target: twin }],
      nodeMetadata: {
        [normalizePath(quoted)]: { hubScore: 0, communityId: 1, communityKey: 'a"pi\n' },
        [normalizePath(twin)]: { hubScore: 0, communityId: 2, communityKey: 'a"pi\n' },
      },
    };
    const result = buildGroupedDiagram(data, {
      display: (fp) => fp.split("/").at(-1)!,
      context: "line\nbreak",
    })!;

    const lines = result.mermaid.split("\n");
    expect(lines[1]).toBe("%% line break");
    expect(lines.filter((line) => line.includes("subgraph"))).toEqual([
      "  subgraph G1[\"a'pi  (1 file)\"]",
      "  subgraph G2[\"a'pi  (1 file)\"]",
    ]);
    expect(lines.filter((line) => line.startsWith("    F"))).toEqual([
      "    F0[\"a'bcd#35;1;.ts\"]",
      "    F1[\"a'bcd#35;1;.ts\"]",
    ]);
    expect(lines.at(-1)).toBe("  G1 -->|1| G2");
  });
});
