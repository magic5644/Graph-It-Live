import { describe, it, expect } from "vitest";
import {
  buildDependencyDiagram,
  buildCallerDiagram,
  buildArchitectureDiagram,
} from "../../../src/analyzer/wiki/DiagramBuilder.js";
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
// buildArchitectureDiagram
// ---------------------------------------------------------------------------

describe("buildArchitectureDiagram", () => {
  it("returns null when articles array is empty", () => {
    expect(buildArchitectureDiagram([], display)).toBeNull();
  });

  it("returns null when only one article (needs ≥2 hubs)", () => {
    const articles = [makeArticle({ hubScore: 10 })];
    expect(buildArchitectureDiagram(articles, display)).toBeNull();
  });

  it("returns a diagram when at least 2 hub articles exist", () => {
    const articles = [
      makeArticle({
        filePath: "/workspace/src/hub1.ts",
        hubScore: 20,
        callees: [],
      }),
      makeArticle({
        filePath: "/workspace/src/hub2.ts",
        hubScore: 10,
        callees: [],
      }),
    ];
    const result = buildArchitectureDiagram(articles, display);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("architecture");
    expect(result!.mermaid).toContain("flowchart TD");
    expect(result!.mermaid).toContain("hub1.ts");
    expect(result!.mermaid).toContain("hub2.ts");
  });

  it("deduplicates edges between hub files", () => {
    const hub2 = makeArticle({
      filePath: "/workspace/src/hub2.ts",
      hubScore: 10,
      callees: [],
    });
    const hub1 = makeArticle({
      filePath: "/workspace/src/hub1.ts",
      hubScore: 20,
      callees: [
        makeLink("/workspace/src/hub2.ts"),
        makeLink("/workspace/src/hub2.ts"), // duplicate
      ],
    });
    const result = buildArchitectureDiagram([hub1, hub2], display);
    expect(result).not.toBeNull();
    const edges = result!.mermaid
      .split("\n")
      .filter((l) => /^\s+\w+ --> \w+$/.test(l));
    // Only one edge hub1 → hub2, no duplicate
    expect(edges).toHaveLength(1);
  });

  it("truncates when articles exceed limit", () => {
    const articles: WikiArticle[] = Array.from({ length: 10 }, (_, i) =>
      makeArticle({
        filePath: `/workspace/src/file${i}.ts`,
        hubScore: 10 - i,
        callees: [],
      }),
    );
    // limit to 3 → truncated because 10 > 3
    const result = buildArchitectureDiagram(articles, display, 3);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.truncationNote).toMatch(/3/);
  });

  it("is not truncated when articles fit within limit", () => {
    const articles = [
      makeArticle({ filePath: "/workspace/src/a.ts", hubScore: 5, callees: [] }),
      makeArticle({ filePath: "/workspace/src/b.ts", hubScore: 3, callees: [] }),
    ];
    const result = buildArchitectureDiagram(articles, display);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
  });

  it("respects MAX_ARCH_EDGES (40) limit on edges", () => {
    // Create one big hub with 50 callees all pointing to other hubs
    const targets: WikiArticle[] = Array.from({ length: 50 }, (_, i) =>
      makeArticle({
        filePath: `/workspace/src/dep${i}.ts`,
        hubScore: 1,
        callees: [],
      }),
    );
    const hub = makeArticle({
      filePath: "/workspace/src/hub.ts",
      hubScore: 100,
      callees: targets.map((t) => makeLink(t.filePath)),
    });
    const result = buildArchitectureDiagram([hub, ...targets], display);
    expect(result).not.toBeNull();
    const edges = result!.mermaid
      .split("\n")
      .filter((l) => /^\s+\w+ --> \w+$/.test(l));
    expect(edges.length).toBeLessThanOrEqual(40);
  });
});
