import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  WikiGenerator,
  matchesExcludePattern,
  normalizeScope,
} from "../../../src/analyzer/wiki/WikiGenerator.js";

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
      let idx = 0;
      return {
        bind: vi.fn(([boundPath]: unknown[]) => {
          if (sql.includes("FROM nodes WHERE path = ?")) {
            results = nodes
              .filter((n) => n.path === boundPath)
              .map((n) => ({ name: n.name, type: n.type, start_line: n.start_line }));
          } else if (sql.includes("n_tgt.path = ?")) {
            results = edges
              .filter((e) => e.target_path === boundPath)
              .map((e) => ({ caller_path: e.source_path, caller_name: e.source_name, source_line: e.source_line }));
          } else if (sql.includes("n_src.path = ?")) {
            results = edges
              .filter((e) => e.source_path === boundPath)
              .map((e) => ({ callee_path: e.target_path, callee_name: e.source_name, source_line: e.source_line }));
          }
        }),
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

  it("escapes backslashes and pipes in rendered table cells", () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({
      fileIndex: ["/workspace/src/d.ts"],
      nodes: [{ path: "/workspace/src/d.ts", name: String.raw`foo\bar|baz`, type: "function", start_line: 3 }],
    });
    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });

    const article = gen.buildArticle("/workspace/src/d.ts", 50);
    const rendered = gen.renderArticle(article);

    expect(rendered).toContain(String.raw`foo\\bar\|baz`);
  });

  it("escapes markdown link/HTML delimiters in symbol names and titles", () => {
    const workspaceRoot = "/workspace";
    const maliciousFilePath = "/workspace/src/evil](https://attacker.example/x)[<script>.ts";
    const maliciousName = "evil](https://attacker.example/x)[<script>";
    const db = makeDb({
      fileIndex: [maliciousFilePath],
      nodes: [{ path: maliciousFilePath, name: maliciousName, type: "function", start_line: 1 }],
    });
    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });

    const article = gen.buildArticle(maliciousFilePath, 10);
    const rendered = gen.renderArticle(article);

    // Neither the malicious title nor the malicious symbol name can break out
    // of Markdown link/table syntax or inject raw HTML.
    expect(rendered).not.toContain("](https://attacker.example/x)[");
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain(String.raw`evil\]\(https://attacker.example/x\)\[&lt;script&gt;`);
  });

  it("relLink produces relative paths only", async () => {
    const workspaceRoot = "/workspace";
    const db = makeDb({
      fileIndex: ["/workspace/src/x.ts", "/workspace/lib/y.ts"],
    });

    const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot });
    const result = await gen.generate();

    const indexContent = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
    const links = [...indexContent.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
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

// ---------------------------------------------------------------------------
// Regression tests (v1.17.1)
// ---------------------------------------------------------------------------

describe("matchesExcludePattern (#221)", () => {
  it.each([
    ["tests/analyzer/wiki/a.test.ts", "**/*.test.ts", true],
    ["a.test.ts", "**/*.test.ts", true],
    ["tests/analyzer/wiki/a.ts", "**/*.test.ts", false],
    ["src/deep/a.test.ts", "*.test.ts", true],
    ["src/a.ts", "*.test.ts", false],
    ["tests/a.ts", "tests/**", true],
    ["tests/a.ts", "tests/", true],
    ["src/tests/a.ts", "tests/**", false],
    ["src/fixtures/a.ts", "fixtures", true],
    ["src/fixturesX/a.ts", "fixtures", false],
    ["src/a.ts", "src/?.ts", true],
    ["src/ab.ts", "src/?.ts", false],
    ["src/a/b.ts", "src/*.ts", false],
    ["src/a/b.ts", "src/**/b.ts", true],
    ["src/b.ts", "src/**/b.ts", true],
    ["src/a+b(1).ts", "src/a+b(1).ts", true],
    ["src/aab1.ts", "src/a+b(1).ts", false],
    ["tests/a.ts", String.raw`.\tests\**`, true],
    ["tests/a.ts", "./tests/**", true],
    ["src/a.ts", "", false],
    ["src/a.ts", "./", false],
  ])("%s vs %s → %s", (relPath, pattern, expected) => {
    expect(matchesExcludePattern(relPath, pattern)).toBe(expected);
  });
});

describe("normalizeScope (#221)", () => {
  const root = path.resolve("/workspace");

  it.each([
    ["./src/analyzer/wiki", "src/analyzer/wiki"],
    ["src/analyzer/wiki/", "src/analyzer/wiki"],
    [String.raw`src\analyzer\wiki`, "src/analyzer/wiki"],
    [String.raw`.\src\analyzer`, "src/analyzer"],
    [".", ""],
    ["./", ""],
  ])("%s → %s", (scope, expected) => {
    expect(normalizeScope(root, scope)).toBe(expected);
  });

  it("accepts an absolute scope inside the workspace", () => {
    expect(normalizeScope(root, path.join(root, "src", "lib"))).toBe("src/lib");
  });

  it("keeps a scope outside the workspace outside (matches nothing)", () => {
    expect(normalizeScope(root, "../other").startsWith("..")).toBe(true);
  });
});

describe("WikiGenerator regressions (v1.17.1)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-gen-reg-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("scope and exclude filtering (#221)", () => {
    const fileIndex = [
      "/workspace/src/analyzer/wiki/A.ts",
      "/workspace/src/analyzer/wiki/A.test.ts",
      "/workspace/src/other/B.ts",
      "/workspace/srcfoo/C.ts",
    ];

    it("applies a ./-prefixed scope like the plain one", async () => {
      const db = makeDb({ fileIndex });
      const result = await new WikiGenerator({
        db, outputDir: tmpDir, workspaceRoot: "/workspace", scope: "./src/analyzer/wiki", exclude: [],
      }).generate();
      expect(result.articlesCount).toBe(2);
      expect(result.scopeNote).toContain("scope: `src/analyzer/wiki`");
    });

    it("applies a Windows-style scope", async () => {
      const db = makeDb({ fileIndex });
      const result = await new WikiGenerator({
        db, outputDir: tmpDir, workspaceRoot: "/workspace", scope: String.raw`src\analyzer\wiki`, exclude: [],
      }).generate();
      expect(result.articlesCount).toBe(2);
    });

    it("does not treat a scope as a bare string prefix", async () => {
      const db = makeDb({ fileIndex });
      const result = await new WikiGenerator({
        db, outputDir: tmpDir, workspaceRoot: "/workspace", scope: "src", exclude: [],
      }).generate();
      expect(result.articlesCount).toBe(3); // srcfoo/C.ts excluded
    });

    it("honours a ** exclude glob", async () => {
      const db = makeDb({ fileIndex });
      const result = await new WikiGenerator({
        db, outputDir: tmpDir, workspaceRoot: "/workspace", scope: "src/analyzer/wiki", exclude: ["**/*.test.ts"],
      }).generate();
      expect(result.articlesCount).toBe(1);
      const articles = await fs.readdir(path.join(tmpDir, "articles"));
      expect(articles).toEqual(["src_analyzer_wiki_A.ts.md"]);
    });

    it("throws a clear error when the filters leave no file, without writing anything", async () => {
      const db = makeDb({ fileIndex });
      const outputDir = path.join(tmpDir, "wiki");
      const gen = new WikiGenerator({
        db, outputDir, workspaceRoot: "/workspace", scope: "./does/not/exist",
      });
      await expect(gen.generate()).rejects.toThrow(/No indexed file matches the wiki filters \(scope `does\/not\/exist`/);
      await expect(fs.access(outputDir)).rejects.toThrow();
    });

    it("throws when the excludes remove every file", async () => {
      const db = makeDb({ fileIndex });
      const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace", exclude: ["**"] });
      await expect(gen.generate()).rejects.toThrow(/exclude `\*\*`/);
    });

    it("filters raw Windows paths from the index", async () => {
      const db = makeDb({
        fileIndex: [String.raw`C:\ws\src\a\b.ts`, String.raw`C:\ws\lib\c.ts`],
      });
      const result = await new WikiGenerator({
        db, outputDir: tmpDir, workspaceRoot: String.raw`C:\ws`, scope: String.raw`.\src`, exclude: [],
      }).generate();
      expect(result.articlesCount).toBe(1);
      expect(await fs.readdir(path.join(tmpDir, "articles"))).toEqual(["src_a_b.ts.md"]);
    });
  });
});
