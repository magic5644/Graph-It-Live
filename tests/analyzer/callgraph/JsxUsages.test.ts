import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphExtractor, grammarOf } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

describe("grammarOf", () => {
  it("parses .tsx and .jsx, in any case, with the tsx grammar", () => {
    expect(grammarOf("typescript", "src/Page.tsx")).toBe("tsx");
    expect(grammarOf("javascript", "src/Old.jsx")).toBe("tsx");
    expect(grammarOf("typescript", String.raw`C:\repo\src\PAGE.TSX`)).toBe("tsx");
  });

  it("keeps other TS/JS files, Vue, Svelte and other languages on their own grammar", () => {
    for (const file of ["a.ts", "a.mts", "a.cts", "App.vue", "App.svelte"]) expect(grammarOf("typescript", file)).toBe("typescript");
    for (const file of ["a.js", "a.mjs", "a.cjs"]) expect(grammarOf("javascript", file)).toBe("javascript");
    expect(grammarOf("python", "a.tsx")).toBe("python");
  });
});

describe("JSX usages in the call graph", () => {
  let root: string;
  let extractor: GraphExtractor;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-jsx-")));
    const wasm = path.join(root, "dist/wasm");
    const queries = path.join(root, "dist/queries");
    await fs.mkdir(wasm, { recursive: true });
    await fs.mkdir(queries, { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
    for (const grammar of ["typescript", "tsx"]) {
      await fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`, path.join(wasm, `tree-sitter-${grammar}.wasm`));
      await fs.copyFile(`resources/queries/${grammar}.scm`, path.join(queries, `${grammar}.scm`));
    }
    extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  });
  afterAll(async () => {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** `file#name` nodes and edges of an index. */
  function describeIndex(indexer: CallGraphIndexer) {
    const snapshot = indexer.getIndexSnapshot();
    const key = (id: string) => {
      const node = snapshot.nodes.find(n => n.id === id);
      return node ? `${path.relative(root, node.path).replaceAll("\\", "/")}#${node.name}` : id;
    };
    return {
      nodes: snapshot.nodes.map(n => ({ key: key(n.id), lang: n.lang, startLine: n.startLine, endLine: n.endLine })),
      edges: snapshot.edges.map(e => `${key(e.sourceId)} -${e.typeRelation}@${e.sourceLine}-> ${key(e.targetId)}`),
    };
  }

  /**
   * Index `files` (relative path → source) in a fresh index and return `file#name` nodes and edges.
   * With `savePath`, also save the index there.
   */
  async function index(files: Record<string, string>, savePath?: string) {
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    try {
      for (const [name, source] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), source);
      }
      for (const [name, source] of Object.entries(files)) {
        const file = normalizePath(path.join(root, name));
        const lang: SupportedLang = /\.jsx?$/.test(name) ? "javascript" : "typescript";
        const result = await extractor.extractSource(file, lang, source);
        indexer.indexFile(result.nodes, result.edges, file, lang, 1);
      }
      indexer.resolveExternalEdges();
      if (savePath) await indexer.saveToFile(savePath);
      return describeIndex(indexer);
    } finally {
      indexer.dispose();
    }
  }

  const ISSUE_FIXTURE = {
    "src/ui/Card.tsx": "export function Card() { return <section />; }\nexport default function Panel() { return <aside />; }\n",
    "src/ui/index.ts": "export * from './Card';\n",
    "src/hooks.ts": "export function useCounter() { return 1; }\nexport function track(_e: string) {}\n",
    "src/Page.tsx": `import * as UI from './ui';
import Panel from './ui/Card';
import { useCounter, track } from './hooks';
export function Page({ show }: { show: boolean }) {
  const n = useCounter();
  return (
    <main>
      {show && <UI.Card />}
      <Panel />
      <button onClick={() => track('x')}>{n}</button>
    </main>
  );
}
export function Later() { return useCounter(); }
`,
    "src/Old.jsx": "import { Card } from './ui/Card';\nexport function Old() { return <div><Card /></div>; }\n",
  };

  it("indexes every component of a .tsx/.jsx file with its line range and links its JSX, calls and handlers", async () => {
    const { nodes, edges } = await index(ISSUE_FIXTURE);

    expect(nodes).toEqual(expect.arrayContaining([
      { key: "src/Page.tsx#Page", lang: "typescript", startLine: 3, endLine: 12 },
      { key: "src/Page.tsx#Later", lang: "typescript", startLine: 13, endLine: 13 },
      { key: "src/ui/Card.tsx#Card", lang: "typescript", startLine: 0, endLine: 0 },
      { key: "src/ui/Card.tsx#Panel", lang: "typescript", startLine: 1, endLine: 1 },
      { key: "src/Old.jsx#Old", lang: "javascript", startLine: 1, endLine: 1 },
    ]));
    expect(edges.filter(e => e.startsWith("src/Page.tsx#Page ")).sort()).toEqual([
      "src/Page.tsx#Page -CALLS@4-> src/hooks.ts#useCounter",
      "src/Page.tsx#Page -CALLS@9-> src/hooks.ts#track",
      "src/Page.tsx#Page -USES@7-> src/ui/Card.tsx#Card",
      "src/Page.tsx#Page -USES@8-> src/ui/Card.tsx#Panel",
    ]);
    expect(edges).toContain("src/Old.jsx#Old -USES@1-> src/ui/Card.tsx#Card");
    expect(edges).toContain("src/Page.tsx#Later -CALLS@13-> src/hooks.ts#useCounter");
  });

  it("returns the same components and JSX edges from a reloaded (warm) index as from the cold run", async () => {
    const dbPath = path.join(root, "callgraph.db");
    const cold = await index(ISSUE_FIXTURE, dbPath);
    const warm = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    try {
      await expect(warm.loadFromFile(dbPath)).resolves.toBe(true);
      const reloaded = describeIndex(warm);

      expect(reloaded.nodes).toEqual(cold.nodes);
      expect(reloaded.edges.sort()).toEqual([...cold.edges].sort());
      expect(reloaded.edges).toContain("src/Page.tsx#Page -USES@7-> src/ui/Card.tsx#Card");
    } finally {
      warm.dispose();
    }
  });

  const NULL_COMPONENTS = "export const Card = () => null;\nexport function Panel() { return null; }\nexport function C() { return null; }\n";

  it.each([
    {
      // `<Tabs.Panel />` resolves in its own file, like `this.method()`; a cross-file member never resolves by name.
      title: "keeps intrinsic, namespaced and custom elements, fragments and unresolved members out of the graph",
      file: "src/Tags.tsx",
      source: `export function Tags() {
  return (<>
    <div><span /></div>
    <svg:rect />
    <my-element />
    <Tabs.Panel />
    <A.B.C />
  </>);
}
export function Panel() { return null; }
export function C() { return null; }
`,
      expected: ["src/Tags.tsx#Tags -USES@5-> src/Tags.tsx#Panel", "src/Tags.tsx#Tags -USES@6-> src/Tags.tsx#C"],
    },
    {
      title: "links paired, self-closing, nested, conditional and ternary JSX once per target",
      file: "src/Shell.tsx",
      source: `import { Card, Panel } from './parts';
export function Shell({ a }: { a: boolean }) {
  return (
    <Card title="t">
      {a ? <Panel /> : null}
      <Card><Panel></Panel></Card>
    </Card>
  );
}
`,
      expected: ["src/Shell.tsx#Shell -USES@3-> src/parts.tsx#Card", "src/Shell.tsx#Shell -USES@4-> src/parts.tsx#Panel"],
    },
    {
      title: "follows a component's local binding: a parameter shadowing an import or a type-only import links nowhere",
      file: "src/Wrap.tsx",
      source: `import type { Card } from './parts';
import { Panel } from './parts';
export function Wrap() { return <Card />; }
export function Pass({ Panel }: { Panel: () => null }) { return <Panel />; }
export function Uses() { return <Panel />; }
`,
      expected: ["src/Wrap.tsx#Uses -USES@4-> src/parts.tsx#Panel"],
    },
    {
      title: "links a .jsx component to a same-file component without an import",
      file: "src/Local.jsx",
      source: "function Item() { return <li />; }\nexport function List() { return <ul><Item /></ul>; }\n",
      expected: ["src/Local.jsx#List -USES@1-> src/Local.jsx#Item"],
    },
  ])("$title", async ({ file, source, expected }) => {
    const { edges } = await index({ [file]: source, "src/parts.tsx": NULL_COMPONENTS });

    expect(edges.filter(e => e.startsWith(`${file}#`)).sort()).toEqual(expected);
  });

  it("keeps .ts files on the TypeScript grammar, where `<T>x` is a type assertion, not JSX", async () => {
    const { nodes, edges } = await index({
      "src/cast.ts": `function wrap<T>(x: T) { return x; }
export function cast(v: unknown) { return <string>wrap(v); }
export const ident = <T,>(x: T) => wrap(x);
`,
    });

    expect(nodes.map(n => n.key).sort()).toEqual(["src/cast.ts#cast", "src/cast.ts#ident", "src/cast.ts#wrap"]);
    expect(edges.sort()).toEqual([
      "src/cast.ts#cast -CALLS@1-> src/cast.ts#wrap",
      "src/cast.ts#ident -CALLS@2-> src/cast.ts#wrap",
    ]);
  });
});
