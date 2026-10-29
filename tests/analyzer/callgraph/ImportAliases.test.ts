import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { queryNeighbourhood } from "@/analyzer/callgraph/CallGraphQuery";
import { normalizePath } from "@/shared/path";

describe.each(["javascript", "typescript"] as const)("%s named import calls", (lang) => {
  let root: string;
  let extractor: GraphExtractor;
  let indexer: CallGraphIndexer;
  const ext = lang === "javascript" ? "js" : "ts";

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-imports-")));
    const wasm = path.join(root, "dist/wasm");
    const queries = path.join(root, "dist/queries");
    await fs.mkdir(wasm, { recursive: true });
    await fs.mkdir(queries, { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
    await fs.copyFile("node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm", path.join(wasm, "tree-sitter-typescript.wasm"));
    await fs.copyFile("resources/queries/typescript.scm", path.join(queries, "typescript.scm"));
    extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  });
  beforeEach(async () => {
    indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
  });
  afterEach(() => indexer.dispose());
  afterAll(async () => {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>) {
    for (const [name, source] of Object.entries(files)) {
      await fs.writeFile(path.join(root, `${name}.${ext}`), source);
    }
    for (const [name, source] of Object.entries(files)) {
      const file = normalizePath(path.join(root, `${name}.${ext}`));
      const result = await extractor.extractSource(file, lang, source);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    return indexer.getIndexSnapshot();
  }

  it("links aliased and ordinary imports to their actual module, including transitive callers", async () => {
    const snapshot = await index({
      journal: "export function startJournal() {}\nexport function closeJournal() {}",
      decoy: "export function startJournal() {}\nexport function closeJournal() {}\nexport function open() {}",
      pipeline: `import { startJournal as open, closeJournal } from './journal.${ext}';
export function handleBatch() { open(); closeJournal(); }`,
      entry: `import { handleBatch } from './pipeline.${ext}'; export function main() { handleBatch(); }`,
    });
    const nameOf = new Map(snapshot.nodes.map(n => [n.id, `${path.basename(n.path)}#${n.name}`]));
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS").map(e => [nameOf.get(e.sourceId), nameOf.get(e.targetId)])).toEqual(expect.arrayContaining([
      [`pipeline.${ext}#handleBatch`, `journal.${ext}#startJournal`],
      [`pipeline.${ext}#handleBatch`, `journal.${ext}#closeJournal`],
      [`entry.${ext}#main`, `pipeline.${ext}#handleBatch`],
    ]));
    expect(snapshot.edges.some(e => nameOf.get(e.targetId)?.startsWith("decoy."))).toBe(false);
    const target = snapshot.nodes.find(n => n.name === "startJournal" && n.path.endsWith(`/journal.${ext}`))!;
    expect(queryNeighbourhood(indexer.getDb(), target.id, 2).nodes.map(n => n.name)).toEqual(expect.arrayContaining(["startJournal", "handleBatch", "main"]));
  });

  it("links a call made through a barrel to the declaring symbol (named, renamed, export *, chained, cyclic)", async () => {
    const snapshot = await index({
      price: "export function formatPrice() {}\nexport function lonely() {}",
      barrel: `export { formatPrice, formatPrice as fmt } from './price.${ext}';`,
      star: `export * from './barrel.${ext}';\nexport * from './loop.${ext}';`,
      loop: `export * from './star.${ext}';`,
      outer: `export * from './star.${ext}';`,
      direct: `import { formatPrice } from './price.${ext}'; export function viaDirect() { formatPrice(); }`,
      named: `import { formatPrice } from './barrel.${ext}'; export function viaNamed() { formatPrice(); }`,
      renamed: `import { fmt } from './barrel.${ext}'; export function viaRenamed() { fmt(); }`,
      chained: `import { formatPrice } from './outer.${ext}'; export function viaChain() { formatPrice(); }`,
      missing: `import { nothing } from './outer.${ext}'; export function viaMissing() { nothing(); }`,
    });
    const target = snapshot.nodes.find(n => n.name === "formatPrice")!;
    const callers = snapshot.edges.filter(e => e.typeRelation === "CALLS" && e.targetId === target.id)
      .map(e => snapshot.nodes.find(n => n.id === e.sourceId)!.name).sort();
    expect(callers).toEqual(["viaChain", "viaDirect", "viaNamed", "viaRenamed"]);
    expect(snapshot.edges.some(e => e.sourceId.includes("viaMissing") && e.typeRelation === "CALLS")).toBe(false);
  });

  it("keeps no edge when the barrel's re-export target cannot be read, and skips `default` through export *", async () => {
    const snapshot = await index({
      broken: `export { x } from './gone.${ext}';`,
      user: `import { x } from './broken.${ext}'; export function viaBroken() { x(); }`,
      impl: "export default function impl() {}",
      star: `export * from './impl.${ext}';`,
      defUser: `import { default as impl } from './star.${ext}'; export function viaDefault() { impl(); }`,
    });
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS")).toEqual([]);
  });

  it.each([
    "export function run(open) { open(); }",
    "export function run() { const open = () => 0; open(); }",
    "export function run() { { let open; open(); } }",
    "export function run({ open }) { open(); }",
    "export function run() { try {} catch (open) { open(); } }",
    "export function run() { open(); if (true) { var open; } }",
    "export function run() { const { value: open = () => 0 } = {}; open(); }",
    "export function run() { for (const open of []) { open(); } }",
    "export function run() { class open {} new open(); }",
    "export const run = open => open();",
    "export function run([open = () => 0]) { open(); }",
    "export function run(...open) { open(); }",
  ])("does not connect a shadowed binding to the imported function: %s", async (body) => {
    const snapshot = await index({
      journal: "export function startJournal() {}",
      pipeline: `import { startJournal as open } from './journal.${ext}';\n${body}`,
    });
    const target = snapshot.nodes.find(n => n.name === "startJournal")!;
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS" && e.targetId === target.id)).toEqual([]);
  });

  it("keeps the import outside a sibling scope that shadows it", async () => {
    const snapshot = await index({
      journal: "export function startJournal() {}",
      pipeline: `import { startJournal as open } from './journal.${ext}';
export function shadow(open) { open(); }
export function run() { open(); }`,
    });
    const target = snapshot.nodes.find(n => n.name === "startJournal")!;
    const run = snapshot.nodes.find(n => n.name === "run")!;
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS" && e.targetId === target.id).map(e => e.sourceId)).toEqual([run.id]);
  });

  it("does not guess a target for a missing module", async () => {
    const snapshot = await index({
      decoy: "export function open() {}\nexport function startJournal() {}",
      pipeline: "import { startJournal as open } from './missing'; export function run() { open(); }",
    });
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS")).toEqual([]);
  });

  it("preserves calls to a local function that shadows the import", async () => {
    const snapshot = await index({
      journal: "export function startJournal() {}",
      pipeline: `import { startJournal as open } from './journal.${ext}';
export function run() {
  function open() { return 0; }
  return open();
}`,
    });
    const local = snapshot.nodes.find(n => n.name === "open")!;
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS").map(e => e.targetId)).toEqual([local.id]);
  });

  it("keeps member calls separate from an identically named import", async () => {
    const snapshot = await index({
      journal: "export function startJournal() {}",
      pipeline: `import { startJournal as open } from './journal.${ext}'; export function run(obj) { obj.open(); }`,
    });
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS")).toEqual([]);
  });

  it("does not resolve a name absent from the imported module", async () => {
    const snapshot = await index({
      journal: "export function other() {}",
      decoy: "export function startJournal() {}",
      pipeline: `import { startJournal as open } from './journal.${ext}'; export function run() { open(); }`,
    });
    expect(snapshot.edges.filter(e => e.typeRelation === "CALLS")).toEqual([]);
  });

  describe("namespace imports", () => {
    const callEdges = (snapshot: Awaited<ReturnType<typeof index>>) => {
      const nameOf = new Map(snapshot.nodes.map(n => [n.id, `${path.basename(n.path, `.${ext}`)}#${n.name}`]));
      return snapshot.edges.filter(e => e.typeRelation === "CALLS").map(e => `${nameOf.get(e.sourceId)} -> ${nameOf.get(e.targetId)}`).sort();
    };

    it("links ns.member() to the imported module, not to a same-named decoy, with inverse callers", async () => {
      const snapshot = await index({
        math: "export function add() {}",
        decoy: "export function add() {}",
        namespace: `import * as math from './math.${ext}'; export function namespaceCall() { return math.add(1, 2); }`,
        mixed: `import def, * as math from './math.${ext}'; export function mixedCall() { math.add(); }`,
      });
      expect(callEdges(snapshot)).toEqual(["mixed#mixedCall -> math#add", "namespace#namespaceCall -> math#add"]);
      const target = snapshot.nodes.find(n => n.name === "add" && n.path.endsWith(`/math.${ext}`))!;
      expect(queryNeighbourhood(indexer.getDb(), target.id, 1).nodes.map(n => n.name)).toEqual(expect.arrayContaining(["add", "namespaceCall", "mixedCall"]));
    });

    it("follows direct, renamed, star and chained re-exports through a namespace", async () => {
      const snapshot = await index({
        price: "export function formatPrice() {}",
        barrel: `export { formatPrice, formatPrice as fmt } from './price.${ext}';`,
        star: `export * from './barrel.${ext}';`,
        outer: `export * from './star.${ext}';`,
        user: `import * as b from './barrel.${ext}'; import * as o from './outer.${ext}';
export function viaNamed() { b.formatPrice(); }
export function viaRenamed() { b.fmt(); }
export function viaChain() { o.formatPrice(); }`,
      });
      expect(callEdges(snapshot)).toEqual(["user#viaChain -> price#formatPrice", "user#viaNamed -> price#formatPrice", "user#viaRenamed -> price#formatPrice"]);
    });

    it.each([
      "export function run(math) { math.add(); }",
      "export function run() { const math = { add() {} }; math.add(); }",
      "export function run() { { let math; math.add(); } }",
      "export const run = math => math.add();",
    ])("does not bind a shadowed namespace: %s", async (body) => {
      const snapshot = await index({
        math: "export function add() {}",
        user: `import * as math from './math.${ext}';\n${body}`,
      });
      expect(callEdges(snapshot).filter(edge => edge.endsWith("-> math#add"))).toEqual([]);
    });

    it("keeps the namespace outside a sibling scope that shadows it", async () => {
      const snapshot = await index({
        math: "export function add() {}",
        user: `import * as math from './math.${ext}';
export function shadow(math) { math.add(); }
export function run() { math.add(); }`,
      });
      expect(callEdges(snapshot)).toEqual(["user#run -> math#add"]);
    });

    it("invents no edge for unknown members, missing modules, non-identifier objects or builtins", async () => {
      const snapshot = await index({
        math: "export function add() {}",
        keys: "export function keys() {}\nexport function round() {}",
        user: `import * as math from './math.${ext}'; import * as gone from './missing';
export function unknown() { math.nope(); }
export function missing() { gone.add(); }
export function nested(a) { a.math.add(); }
export function builtins() { Object.keys({}); Math.round(1.5); }`,
      });
      expect(callEdges(snapshot)).toEqual([]);
    });

    it("does not treat a namespace member that is not a call as an edge", async () => {
      const snapshot = await index({
        math: "export function add() {}",
        user: `import * as math from './math.${ext}'; export function run() { return math['add'](); }`,
      });
      expect(callEdges(snapshot)).toEqual([]);
    });

    if (lang === "typescript") {
      it("ignores type-only namespace imports", async () => {
        const snapshot = await index({
          math: "export function add() {}",
          user: "import type * as math from './math.ts'; export function run() { math.add(); }",
        });
        expect(callEdges(snapshot)).toEqual([]);
      });
    }
  });

  if (lang === "typescript") {
    it.each(["import type { startJournal as open }", "import { type startJournal as open }"])("ignores type-only bindings: %s", async (declaration) => {
      const snapshot = await index({
        journal: "export function startJournal() {}\nexport function open() {}",
        pipeline: `${declaration} from './journal.ts'; export function run() { open(); }`,
      });
      expect(snapshot.edges.filter(e => e.typeRelation === "CALLS")).toEqual([]);
    });
  }
});
