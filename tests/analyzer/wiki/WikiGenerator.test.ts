import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WikiGenerator } from "../../../src/analyzer/wiki/WikiGenerator.js";

// ---------------------------------------------------------------------------
// Minimal DB mock helpers
// ---------------------------------------------------------------------------

function makeDb(rows: {
  fileIndex?: string[];
  nodes?: Array<{ path: string; name: string; type: string; start_line: number }>;
  edges?: Array<{ source_path: string; source_name: string; target_path: string; source_line: number }>;
}) {
  const fileIndex = rows.fileIndex ?? [];
  const nodes = rows.nodes ?? [];
  const edges = rows.edges ?? [];

  return {
    exec: vi.fn((sql: string) => {
      if (sql.includes("FROM file_index")) {
        return [{ columns: ["path"], values: fileIndex.map((p) => [p]) }];
      }
      if (sql.includes("COUNT(DISTINCT e.source_id)")) {
        // hub score query
        const hubMap = new Map<string, number>();
        for (const e of edges) {
          hubMap.set(e.target_path, (hubMap.get(e.target_path) ?? 0) + 1);
        }
        const result = [...hubMap.entries()].map(([p, h]) => [p, h]);
        return [{ columns: ["path", "hub"], values: result }];
      }
      return [];
    }),
    prepare: vi.fn((sql: string) => {
      let results: Array<Record<string, unknown>> = [];
      if (sql.includes("FROM nodes WHERE path = ?")) {
        results = nodes.map((n) => ({ name: n.name, type: n.type, start_line: n.start_line }));
      } else if (sql.includes("n_tgt.path = ?")) {
        // callers
        results = edges.map((e) => ({
          caller_path: e.source_path,
          caller_name: e.source_name,
          source_line: e.source_line,
        }));
      } else if (sql.includes("n_src.path = ?")) {
        // callees
        results = edges.map((e) => ({
          callee_path: e.target_path,
          callee_name: e.source_name,
          source_line: e.source_line,
        }));
      }
      let idx = 0;
      return {
        bind: vi.fn(),
        step: vi.fn(() => idx < results.length),
        getAsObject: vi.fn(() => results[idx++] ?? {}),
        free: vi.fn(),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WikiGenerator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-gen-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("generates index and article files", async () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({
      fileIndex: ["/workspace/src/foo.ts", "/workspace/src/bar.ts"],
      nodes: [
        { path: "/workspace/src/foo.ts", name: "fooFn", type: "function", start_line: 1 },
      ],
    });

    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });
    const result = await gen.generate();

    expect(result.articlesCount).toBe(2);

    const indexContent = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
    expect(indexContent).toContain("# Wiki");
    expect(indexContent).not.toMatch(/^.*\/workspace\/.*/m); // no absolute paths

    const artDir = await fs.readdir(path.join(tmpDir, "articles"));
    expect(artDir).toHaveLength(2);
  });

  it("renders article with no absolute paths", async () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({
      fileIndex: ["/workspace/src/a.ts", "/workspace/src/b.ts"],
      nodes: [
        { path: "/workspace/src/a.ts", name: "aFn", type: "function", start_line: 5 },
      ],
      edges: [
        { source_path: "/workspace/src/b.ts", source_name: "bFn", target_path: "/workspace/src/a.ts", source_line: 10 },
      ],
    });

    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });
    const result = await gen.generate();

    // Read the article for a.ts
    const articles = await fs.readdir(path.join(tmpDir, "articles"));
    const aArticle = articles.find((f) => f.includes("src_a.ts") || f.includes("a.ts"));
    expect(aArticle).toBeTruthy();

    if (aArticle) {
      const content = await fs.readFile(path.join(tmpDir, "articles", aArticle), "utf-8");
      expect(content).not.toContain("/workspace");
      expect(content).toContain("aFn");
    }

    expect(result.topHubs[0]?.score).toBeGreaterThan(0);
  });

  it("buildArticle produces correct structure", () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({ fileIndex: ["/workspace/src/c.ts"] });
    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });

    const article = gen.buildArticle("/workspace/src/c.ts", 75);
    expect(article.hubScore).toBe(75);
    expect(article.filePath).toBe("/workspace/src/c.ts");
    expect(article.title).toBe("c");
    expect(article.articlePath).not.toContain("/workspace");
    expect(article.articlePath.startsWith(tmpDir)).toBe(true);
  });

  it("relLink produces relative paths only", async () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({
      fileIndex: ["/workspace/src/x.ts", "/workspace/lib/y.ts"],
    });

    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });
    const result = await gen.generate();

    const indexContent = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
    const links = [...indexContent.matchAll(/\[.*?\]\((.*?)\)/g)].map((m) => m[1]);
    for (const link of links) {
      expect(link).not.toMatch(/^[A-Za-z]:\\|^\//); // not absolute
    }

    expect(result.articlesCount).toBe(2);
  });

  it("handles empty database gracefully", async () => {
    const db = makeDb({});
    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" });
    const result = await gen.generate();

    expect(result.articlesCount).toBe(0);
    expect(result.topHubs).toEqual([]);
  });
});
