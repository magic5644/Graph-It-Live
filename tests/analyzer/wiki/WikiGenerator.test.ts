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

/** Every Markdown link in the generated articles and index, with the file holding it. */
async function collectLinks(outputDir: string): Promise<Array<{ from: string; target: string }>> {
  const files = [
    path.join(outputDir, "index.md"),
    ...(await fs.readdir(path.join(outputDir, "articles"))).map((f) => path.join(outputDir, "articles", f)),
  ];
  const links: Array<{ from: string; target: string }> = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (m[1].endsWith(".md")) links.push({ from: file, target: m[1] });
    }
  }
  return links;
}

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

  describe("article name collisions (#220)", () => {
    it("writes one distinct article per file when paths flatten to the same name", async () => {
      const db = makeDb({
        fileIndex: ["/workspace/src/a/b.ts", "/workspace/src/a_b.ts", "/workspace/src/main.ts"],
        nodes: [
          { path: "/workspace/src/a/b.ts", name: "nested", type: "function", start_line: 1 },
          { path: "/workspace/src/a_b.ts", name: "flat", type: "function", start_line: 1 },
        ],
        edges: [
          { source_path: "/workspace/src/main.ts", source_name: "main", target_path: "/workspace/src/a_b.ts", source_line: 3 },
        ],
      });
      const result = await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();

      const articles = await fs.readdir(path.join(tmpDir, "articles"));
      expect(result.articlesCount).toBe(3);
      expect(articles).toHaveLength(result.articlesCount);
      expect(articles.sort()).toEqual(["src_a_b.ts-2.md", "src_a_b.ts.md", "src_main.ts.md"]);

      const nested = await fs.readFile(path.join(tmpDir, "articles", "src_a_b.ts.md"), "utf-8");
      const flat = await fs.readFile(path.join(tmpDir, "articles", "src_a_b.ts-2.md"), "utf-8");
      expect(nested).toContain("nested");
      expect(flat).toContain("flat");
      expect(flat).toContain("[src/main.ts](src_main.ts.md)");

      const main = await fs.readFile(path.join(tmpDir, "articles", "src_main.ts.md"), "utf-8");
      expect(main).toContain("[src/a_b.ts](src_a_b.ts-2.md)");

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain("(articles/src_a_b.ts.md)");
      expect(index).toContain("(articles/src_a_b.ts-2.md)");
    });

    it("disambiguates names that differ only by case (case-insensitive file systems)", async () => {
      const db = makeDb({ fileIndex: ["/workspace/src/Foo.ts", "/workspace/src/foo.ts"] });
      const result = await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();

      const articles = await fs.readdir(path.join(tmpDir, "articles"));
      expect(new Set(articles.map((a) => a.toLowerCase())).size).toBe(2);
      expect(articles).toHaveLength(result.articlesCount);
    });

    it("keeps a real file named like a suffixed article distinct", async () => {
      const db = makeDb({
        fileIndex: ["/workspace/src/a/b.ts", "/workspace/src/a_b.ts", "/workspace/src/a_b.ts-2"],
      });
      const result = await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();
      const articles = await fs.readdir(path.join(tmpDir, "articles"));
      expect(articles).toHaveLength(3);
      expect(result.articlesCount).toBe(3);
    });

    it("handles colliding Windows paths", async () => {
      const db = makeDb({ fileIndex: [String.raw`C:\ws\src\a\b.ts`, String.raw`C:\ws\src\a_b.ts`] });
      const result = await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: String.raw`C:\ws` }).generate();
      const articles = await fs.readdir(path.join(tmpDir, "articles"));
      expect(articles.sort()).toEqual(["src_a_b.ts-2.md", "src_a_b.ts.md"]);
      expect(result.articlesCount).toBe(2);
    });
  });

  describe("article content (#222)", () => {
    it("links only to generated articles and shows out-of-scope files as plain text", async () => {
      const db = makeDb({
        fileIndex: ["/workspace/src/wiki/a.ts", "/workspace/src/wiki/b.ts", "/workspace/src/other/c.ts"],
        edges: [
          { source_path: "/workspace/src/wiki/b.ts", source_name: "bFn", target_path: "/workspace/src/wiki/a.ts", source_line: 1 },
          { source_path: "/workspace/src/other/c.ts", source_name: "cFn", target_path: "/workspace/src/wiki/a.ts", source_line: 2 },
          { source_path: "/workspace/src/wiki/a.ts", source_name: "aFn", target_path: "/workspace/src/other/c.ts", source_line: 3 },
        ],
      });
      await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace", scope: "src/wiki" }).generate();

      const a = await fs.readFile(path.join(tmpDir, "articles", "src_wiki_a.ts.md"), "utf-8");
      expect(a).toContain("| bFn | [src/wiki/b.ts](src_wiki_b.ts.md) | 1 |");
      expect(a).toContain("| cFn | src/other/c.ts | 2 |");
      expect(a).not.toContain("src_other_c.ts.md");

      for (const { from, target } of await collectLinks(tmpDir)) {
        await expect(fs.access(path.resolve(path.dirname(from), target)), `${from} → ${target}`).resolves.toBeUndefined();
      }
    });

    it("states how many callers and callees were left out", async () => {
      const callers = Array.from({ length: 25 }, (_, i) => ({
        source_path: `/workspace/src/c${i}.ts`, source_name: `c${i}`, target_path: "/workspace/src/hub.ts", source_line: i + 1,
      }));
      const callees = Array.from({ length: 21 }, (_, i) => ({
        source_path: "/workspace/src/hub.ts", source_name: `d${i}`, target_path: `/workspace/src/d${i}.ts`, source_line: i + 1,
      }));
      const db = makeDb({ fileIndex: ["/workspace/src/hub.ts"], edges: [...callers, ...callees] });
      const gen = new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" });
      await gen.generate();

      const hub = await fs.readFile(path.join(tmpDir, "articles", "src_hub.ts.md"), "utf-8");
      expect(hub).toContain("> 20 of 25 callers shown.");
      expect(hub).toContain("> 20 of 21 callees shown.");
      expect(hub.match(/^\| c\d+ \|/gm)).toHaveLength(20);

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain("25 callers");
      expect(index).toMatch(/\| 0 \| 25 \|/);
    });

    it("adds no truncation note when every relation is listed", async () => {
      const db = makeDb({
        fileIndex: ["/workspace/src/a.ts", "/workspace/src/b.ts"],
        edges: [{ source_path: "/workspace/src/b.ts", source_name: "bFn", target_path: "/workspace/src/a.ts", source_line: 1 }],
      });
      await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();
      const a = await fs.readFile(path.join(tmpDir, "articles", "src_a.ts.md"), "utf-8");
      expect(a).not.toMatch(/of \d+ (callers|callees) shown/);
    });

    it("removes stale generated articles but keeps unrelated files", async () => {
      const files = ["/workspace/src/a.ts", "/workspace/lib/b.ts"];
      await new WikiGenerator({ db: makeDb({ fileIndex: files }), outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();
      const articlesDir = path.join(tmpDir, "articles");
      await fs.writeFile(path.join(articlesDir, "notes.md"), "# My own notes\n", "utf-8");
      await fs.mkdir(path.join(articlesDir, "sub.md"));

      await new WikiGenerator({
        db: makeDb({ fileIndex: files }), outputDir: tmpDir, workspaceRoot: "/workspace", scope: "src",
      }).generate();

      expect((await fs.readdir(articlesDir)).sort()).toEqual(["notes.md", "src_a.ts.md", "sub.md"]);
      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).not.toContain("lib_b.ts.md");
    });

    it("starts every article with the generated-article marker", async () => {
      const db = makeDb({ fileIndex: ["/workspace/src/a.ts"] });
      await new WikiGenerator({ db, outputDir: tmpDir, workspaceRoot: "/workspace" }).generate();
      const a = await fs.readFile(path.join(tmpDir, "articles", "src_a.ts.md"), "utf-8");
      expect(a.split("\n")[0]).toBe("<!-- graph-it-live:wiki-article -->");
      expect(a.split("\n")[1]).toBe("# a");
    });
  });

  describe("overwrite protection (#269)", () => {
    const files = ["/workspace/src/a.ts"];
    const generate = (overwrite?: boolean) =>
      new WikiGenerator({ db: makeDb({ fileIndex: files }), outputDir: tmpDir, workspaceRoot: "/workspace", overwrite }).generate();
    const indexPath = () => path.join(tmpDir, "index.md");
    const articlePath = () => path.join(tmpDir, "articles", "src_a.ts.md");

    it("starts the index with the generated-file marker", async () => {
      await generate();
      const index = await fs.readFile(indexPath(), "utf-8");
      expect(index.split("\n")[0]).toBe("<!-- graph-it-live:wiki-article -->");
    });

    it("regenerates over its own previous output", async () => {
      await generate();
      await expect(generate()).resolves.toMatchObject({ articlesCount: 1 });
    });

    it("refuses to replace a hand-written index.md and writes nothing", async () => {
      await fs.writeFile(indexPath(), "hand-written\n", "utf-8");

      await expect(generate()).rejects.toThrow(/Refusing to overwrite .*index\.md.*--force/);
      expect(await fs.readFile(indexPath(), "utf-8")).toBe("hand-written\n");
      await expect(fs.stat(path.join(tmpDir, "articles"))).rejects.toThrow();
    });

    it("regenerates over an index.md written by v1.17.1, before the marker", async () => {
      await fs.writeFile(indexPath(), "# Wiki — workspace\n\nold\n", "utf-8");

      await generate();

      expect(await fs.readFile(indexPath(), "utf-8")).toMatch(/^<!-- graph-it-live:wiki-article -->\n# Wiki — workspace/);
    });

    it("does not take a foreign file titled like another workspace's index for its own", async () => {
      await fs.writeFile(indexPath(), "# Wiki — other\n", "utf-8");
      await expect(generate()).rejects.toThrow(/Refusing to overwrite/);
    });

    it("refuses to replace a hand-written article", async () => {
      await fs.mkdir(path.join(tmpDir, "articles"));
      await fs.writeFile(articlePath(), "mine\n", "utf-8");

      await expect(generate()).rejects.toThrow(/Refusing to overwrite .*src_a\.ts\.md/);
      expect(await fs.readFile(articlePath(), "utf-8")).toBe("mine\n");
      await expect(fs.stat(indexPath())).rejects.toThrow();
    });

    it("replaces foreign files when overwrite is set", async () => {
      await fs.mkdir(path.join(tmpDir, "articles"));
      await fs.writeFile(indexPath(), "hand-written\n", "utf-8");
      await fs.writeFile(articlePath(), "mine\n", "utf-8");

      await generate(true);

      expect(await fs.readFile(indexPath(), "utf-8")).toMatch(/^<!-- graph-it-live:wiki-article -->\n# Wiki/);
      expect(await fs.readFile(articlePath(), "utf-8")).toMatch(/^<!-- graph-it-live:wiki-article -->/);
    });

    it("refuses a directory where a wiki file goes, even with overwrite", async () => {
      await fs.mkdir(indexPath());
      await expect(generate(true)).rejects.toThrow(/directory or special file/);
    });

    it("never writes through a symbolic link, even with overwrite", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-gen-outside-"));
      try {
        const target = path.join(outside, "victim.md");
        await fs.writeFile(target, "keep\n", "utf-8");
        await fs.symlink(target, indexPath());

        await expect(generate(true)).rejects.toThrow(/symbolic link .*index\.md/);
        expect(await fs.readFile(target, "utf-8")).toBe("keep\n");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("never writes through a hard link, even with overwrite", async () => {
      const other = path.join(tmpDir, "..", `${path.basename(tmpDir)}-linked.md`);
      await fs.writeFile(other, "keep\n", "utf-8");
      try {
        await fs.link(other, indexPath());

        await expect(generate(true)).rejects.toThrow(/hard link/);
        expect(await fs.readFile(other, "utf-8")).toBe("keep\n");
      } finally {
        await fs.rm(other, { force: true });
      }
    });

    it("never writes through a symbolic articles directory", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-gen-outside-"));
      try {
        await fs.symlink(outside, path.join(tmpDir, "articles"), "junction");

        await expect(generate(true)).rejects.toThrow(/symbolic link .*articles/);
        expect(await fs.readdir(outside)).toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
