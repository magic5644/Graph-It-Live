import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { fileExtToLang, GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { flowSpec } from "@/analyzer/diagram/diagramSpec";
import { buildFlowModel, docSubtitle, laneAt, type FlowModel, type FlowModelRequest } from "@/analyzer/diagram/flowModel";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

const SPEC_SCHEMA = JSON.parse(readFileSync(path.resolve("schemas/diagram-spec.schema.json"), "utf8"));
const validateSpec = new Ajv2020({ allErrors: true }).compile(SPEC_SCHEMA);

let root: string;
let extractor: GraphExtractor;
let run = 0;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-flow-")));
  const wasm = path.join(root, "dist/wasm");
  const queries = path.join(root, "dist/queries");
  await fs.mkdir(wasm, { recursive: true });
  await fs.mkdir(queries, { recursive: true });
  await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(wasm, "tree-sitter.wasm"));
  for (const grammar of ["typescript", "tsx", "python", "go"]) {
    await fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`, path.join(wasm, `tree-sitter-${grammar}.wasm`));
    await fs.copyFile(`resources/queries/${grammar}.scm`, path.join(queries, `${grammar}.scm`));
  }
  extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
});

afterAll(async () => {
  extractor.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

/** Indexes `files` in a fresh folder (in `order`), then builds the flow model of `request` there. */
async function flowOf(
  files: Record<string, string>,
  request: Omit<FlowModelRequest, "filePath"> & { file: string },
  order = Object.keys(files),
): Promise<FlowModel> {
  const dir = path.join(root, `case${run++}`);
  for (const [name, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), source);
  }
  const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  await indexer.init();
  try {
    for (const name of order) {
      const file = normalizePath(path.join(dir, name));
      const lang = fileExtToLang(file) as SupportedLang;
      const result = await extractor.extractSource(file, lang, files[name]);
      indexer.indexFile(result.nodes, result.edges, file, lang, 1);
    }
    indexer.resolveExternalEdges();
    const { file, ...rest } = request;
    return await buildFlowModel(indexer.getDb(), { ...rest, filePath: path.join(dir, file) }, { rootDir: dir, extractor });
  } finally {
    indexer.dispose();
  }
}

const exported = (name: string, body = "") => `export function ${name}(x?: unknown): unknown {\n  ${body}\n  return x;\n}\n`;

const ORDER_FILES: Record<string, string> = {
  "src/command.ts": [
    'import { load } from "./load";',
    'import { validate } from "./validate";',
    'import { report } from "./report";',
    'import { audit } from "./audit";',
    'import { save } from "./save";',
    'import { notify } from "./notify";',
    'import { format } from "./format";',
    "",
    "/** Places an order. Validates it first. */",
    "export function placeOrder(input: string) {",
    "  const order = load(input);",
    "  if (!validate(order)) {",
    "    throw new Error(report(order));",
    "  }",
    "  if (order === null) {",
    "    return audit(order);",
    "  }",
    "  try {",
    "    save(order);",
    "  } catch (error) {",
    "    notify(error);",
    "  }",
    "  return finish(order);",
    "}",
    "",
    "function finish(order: unknown) {",
    "  return format(order);",
    "}",
    "",
  ].join("\n"),
  "src/load.ts": exported("load"),
  "src/validate.ts": `/**\n * Checks an order.\n * @param x the order\n */\n${exported("validate")}`,
  "src/report.ts": exported("report"),
  "src/audit.ts": exported("audit"),
  "src/save.ts": exported("save"),
  "src/notify.ts": exported("notify"),
  "src/format.ts": exported("format"),
};

describe("buildFlowModel (#792)", () => {
  it("puts a command's steps in call order, the validation error and the catch on the error lane, the early return on the alternative lane", async () => {
    const model = await flowOf(ORDER_FILES, { file: "src/command.ts", symbolName: "placeOrder" });

    expect(model).toMatchObject({ entry: "src/command.ts#placeOrder", language: "typescript", lanes: "detected", maxSteps: 8, omittedSteps: 0 });
    expect(model.nodes.map((node) => [node.id, node.lane, node.line])).toEqual([
      ["src/command.ts#placeOrder", "main", 10],
      ["src/load.ts#load", "main", 1],
      ["src/validate.ts#validate", "main", 5],
      ["src/report.ts#report", "error", 1],
      ["src/audit.ts#audit", "alternative", 1],
      ["src/save.ts#save", "main", 1],
      ["src/notify.ts#notify", "error", 1],
      ["src/format.ts#format", "main", 1],
    ]);
    expect(model.nodes[0]).toMatchObject({ title: "placeOrder", subtitle: "Places an order.", file: "src/command.ts", symbolCount: 2 });
    expect(model.nodes[2].subtitle).toBe("Checks an order.");
    expect(model.edges.map((edge) => [edge.to, edge.file, edge.line, edge.lane, edge.condition])).toEqual([
      ["src/load.ts#load", "src/command.ts", 11, "main", undefined],
      ["src/validate.ts#validate", "src/command.ts", 12, "main", undefined],
      ["src/report.ts#report", "src/command.ts", 13, "error", "!validate(order)"],
      ["src/audit.ts#audit", "src/command.ts", 16, "alternative", "order === null"],
      ["src/save.ts#save", "src/command.ts", 19, "main", undefined],
      ["src/notify.ts#notify", "src/command.ts", 21, "error", "catch (error)"],
      // finish() is folded into the entry step: its call into format() is the step's edge, at finish's call site.
      ["src/format.ts#format", "src/command.ts", 27, "main", undefined],
    ]);
    expect(model.edges.every((edge) => edge.from === "src/command.ts#placeOrder" && edge.relation === "CALLS")).toBe(true);
  });

  it("gives one model per index revision, whatever the order the files were indexed in", async () => {
    const first = await flowOf(ORDER_FILES, { file: "src/command.ts", symbolName: "placeOrder" });
    const reversed = await flowOf(ORDER_FILES, { file: "src/command.ts", symbolName: "placeOrder" }, Object.keys(ORDER_FILES).reverse());
    expect(reversed).toEqual(first);
  });

  it("exports a diagram spec valid against the schema, with the model's ids, lanes and locations", async () => {
    const model = await flowOf(ORDER_FILES, { file: "src/command.ts", symbolName: "placeOrder" });
    const spec = flowSpec(model, "shop\u0007");
    expect(validateSpec(JSON.parse(JSON.stringify(spec))), JSON.stringify(validateSpec.errors)).toBe(true);
    expect(spec).toMatchObject({ kind: "flow", version: 1, workspace: "shop\uFFFD", entry: model.entry, nodes: model.nodes, edges: model.edges });
    const ids = new Set(spec.nodes.map((node) => node.id));
    for (const edge of spec.edges) expect([ids.has(edge.from), ids.has(edge.to)]).toEqual([true, true]);
    // Unknown fields and a missing kind are rejected.
    expect(validateSpec({ ...spec, extra: 1 })).toBe(false);
    expect(validateSpec({ ...spec, nodes: [{ ...spec.nodes[0], lane: "side" }] })).toBe(false);
  });

  it("caps the steps at maxSteps and counts the callees it left out without walking them", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 11; index++) {
      const next = index < 10 ? `step${index + 1}` : "";
      files[`s${index}.ts`] = (next ? `import { ${next} } from "./s${index + 1}";\n` : "") + exported(`step${index}`, next ? `${next}();` : "");
    }
    const model = await flowOf(files, { file: "s0.ts", symbolName: "step0" });
    expect(model.nodes.map((node) => node.title)).toEqual(["step0", "step1", "step2", "step3", "step4", "step5", "step6", "step7"]);
    // step7 calls step8, left out; step9 and step10 are never reached.
    expect(model.omittedSteps).toBe(1);
    expect(model.edges).toHaveLength(7);

    const fanOut = {
      "main.ts": `${["a", "b", "c", "d", "e"].map((name) => `import { ${name} } from "./${name}";`).join("\n")}\n${exported("main", "a(); b(); c();\n  d(); e();")}`,
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`${name}.ts`, exported(name)])),
    };
    const capped = await flowOf(fanOut, { file: "main.ts", symbolName: "main", maxSteps: 3 });
    expect(capped.nodes.map((node) => node.title)).toEqual(["main", "a", "b"]);
    expect(capped.omittedSteps).toBe(3);
  });

  it("links a later call into a step already shown, and folds a call chain inside one file into one step", async () => {
    const model = await flowOf({
      "app.ts": 'import { store } from "./store";\nexport function app() {\n  store();\n  later();\n}\nfunction later() {\n  helper();\n}\nfunction helper() {\n  store();\n}\n',
      "store.ts": 'import { app } from "./app";\nexport function store() {\n  return 1;\n}\nexport function back() {\n  app();\n}\n',
    }, { file: "app.ts", symbolName: "app" });
    expect(model.nodes.map((node) => [node.id, node.symbolCount])).toEqual([["app.ts#app", 3], ["store.ts#store", 1]]);
    // The second call into store() repeats the step pair: the first call site stands for it.
    expect(model.edges.map((edge) => [edge.from, edge.to, edge.line])).toEqual([["app.ts#app", "store.ts#store", 3]]);
  });

  it("ends a recursion or a cycle across files on the symbols already placed, with one edge per step pair", async () => {
    const model = await flowOf({
      "a.ts": 'import { b } from "./b";\nexport function a(n: number): number {\n  if (n > 0) a(n - 1);\n  return b(n);\n}\n',
      "b.ts": 'import { a } from "./a";\nexport function b(n: number): number {\n  return a(n) + b(n);\n}\n',
    }, { file: "a.ts", symbolName: "a" });
    expect(model.nodes.map((node) => [node.id, node.symbolCount])).toEqual([["a.ts#a", 1], ["b.ts#b", 1]]);
    expect(model.edges.map((edge) => [edge.from, edge.to, edge.line])).toEqual([["a.ts#a", "b.ts#b", 4], ["b.ts#b", "a.ts#a", 3]]);
  });

  it("draws the most direct call between two steps: a call on main wins over an earlier one in an error branch", async () => {
    const model = await flowOf({
      "main.ts": 'import { x } from "./x";\nexport function main(bad: boolean) {\n  if (bad) {\n    throw new Error(String(x()));\n  }\n  helper();\n}\nfunction helper() {\n  x();\n}\n',
      "x.ts": exported("x"),
    }, { file: "main.ts", symbolName: "main" });
    expect(model.nodes.map((node) => [node.id, node.lane])).toEqual([["main.ts#main", "main"], ["x.ts#x", "main"]]);
    expect(model.edges).toEqual([{ from: "main.ts#main", to: "x.ts#x", file: "main.ts", line: 9, relation: "CALLS", lane: "main" }]);
  });

  it("refuses a step cap below 1 or not an integer", async () => {
    for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
      await expect(flowOf({ "idle.ts": exported("idle") }, { file: "idle.ts", symbolName: "idle", maxSteps })).rejects.toThrow(
        `maxSteps must be an integer of at least 1, got ${maxSteps}.`,
      );
    }
  });

  it("fails when a step file cannot be parsed instead of leaving its calls on main", async () => {
    const dir = path.join(root, `case${run++}`);
    await fs.mkdir(dir, { recursive: true });
    const file = normalizePath(path.join(dir, "a.ts"));
    const source = 'import { b } from "./b";\nexport function a() {\n  b();\n}\n';
    await fs.writeFile(file, source);
    await fs.writeFile(path.join(dir, "b.ts"), exported("b"));
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    try {
      for (const [name, content] of [["a.ts", source], ["b.ts", exported("b")]]) {
        const target = normalizePath(path.join(dir, name));
        const result = await extractor.extractSource(target, "typescript", content);
        indexer.indexFile(result.nodes, result.edges, target, "typescript", 1);
      }
      indexer.resolveExternalEdges();
      await expect(buildFlowModel(indexer.getDb(), { filePath: file, symbolName: "a" }, { rootDir: dir, extractor: { parseTree: async () => null } }))
        .rejects.toThrow("a.ts could not be parsed to read its call sites' lanes.");
    } finally {
      indexer.dispose();
    }
  });

  it("gives one node and no edge for a symbol that calls nothing", async () => {
    const model = await flowOf({ "idle.ts": exported("idle") }, { file: "idle.ts", symbolName: "idle" });
    expect(model).toMatchObject({ entry: "idle.ts#idle", nodes: [{ id: "idle.ts#idle", title: "idle", line: 1, lane: "main", symbolCount: 1 }], edges: [], omittedSteps: 0 });
  });

  it("reads Python raise, sys.exit, elif and except lanes, and the docstring", async () => {
    const model = await flowOf({
      "job.py": [
        "import sys",
        "from checks import check, fail",
        "from store import load, save",
        "from alerts import alert, warn",
        "",
        "def run(arg):",
        '    """Run the job. Then stop."""',
        "    data = load(arg)",
        "    if not check(data):",
        "        raise ValueError(fail(data))",
        "    elif data is None:",
        "        alert(data)",
        "        sys.exit(1)",
        "    try:",
        "        save(data)",
        "    except OSError:",
        "        warn(data)",
        "    return data",
        "",
      ].join("\n"),
      "checks.py": "def check(x):\n    return x\n\ndef fail(x):\n    return x\n",
      "store.py": "def load(x):\n    return x\n\ndef save(x):\n    return x\n",
      "alerts.py": "def alert(x):\n    return x\n\ndef warn(x):\n    return x\n",
    }, { file: "job.py", symbolName: "run" });
    expect(model).toMatchObject({ language: "python", lanes: "detected" });
    expect(model.nodes[0].subtitle).toBe("Run the job.");
    // Each called symbol opens its own step, in call order; only a call chain inside one step's file folds.
    expect(model.edges.map((edge) => [edge.to, edge.line, edge.lane, edge.condition])).toEqual([
      ["store.py#load", 8, "main", undefined],
      ["checks.py#check", 9, "main", undefined],
      ["checks.py#fail", 10, "error", "not check(data)"],
      ["alerts.py#alert", 12, "error", "data is None"],
      ["store.py#save", 15, "main", undefined],
      ["alerts.py#warn", 17, "error", "except OSError"],
    ]);
    expect(model.nodes.map((node) => node.lane)).toEqual(["main", "main", "main", "error", "error", "main", "error"]);
  });

  it("puts every step on main in call order for a language without lane detection, and says so", async () => {
    const model = await flowOf({
      "main.go": "package main\n\nfunc Run(ok bool) {\n\tif !ok {\n\t\tpanic(fail())\n\t}\n\tdone()\n}\n\nfunc fail() string { return \"x\" }\n",
      "done.go": "package main\n\nfunc done() {}\n",
    }, { file: "main.go", symbolName: "Run" });
    expect(model).toMatchObject({
      language: "go",
      lanes: "unsupported",
      nodes: [{ id: "main.go#Run", lane: "main", symbolCount: 2 }, { id: "done.go#done", lane: "main" }],
    });
  });

  // #823: a step is one file, so calls that all stay in the entry's file draw no edge; an empty flow would say "no calls".
  it("refuses an entry whose calls all stay in its file, naming them and pointing to the sequence view", async () => {
    const source = "function toNumber(v: unknown): number { return Number(v); }\n"
      + "export function mathFix(v: unknown): number { return toNumber(v); }\n"
      + "export function format(v: unknown): string { return String(mathFix(toNumber(v))); }\n";
    await expect(flowOf({ "maths/index.ts": source }, { file: "maths/index.ts", symbolName: "format" })).rejects.toThrow(
      "format makes 3 calls, all inside maths/index.ts: a Flow step is one file, so no call joins two steps. Use view sequence to see them.",
    );
    await expect(flowOf({ "maths/index.ts": source }, { file: "maths/index.ts", symbolName: "mathFix" })).rejects.toThrow(
      "mathFix makes 1 call, all inside maths/index.ts:",
    );
  });

  it("keeps an empty flow for an entry with no call, and draws the step of a call into another file", async () => {
    const files = { "a.ts": `import { b } from "./b";\n${exported("idle")}${exported("run", "b(x);")}`, "b.ts": exported("b") };
    expect(await flowOf(files, { file: "a.ts", symbolName: "idle" })).toMatchObject({ nodes: [{ id: "a.ts#idle", symbolCount: 1 }], edges: [] });
    expect((await flowOf(files, { file: "a.ts", symbolName: "run" })).edges).toMatchObject([{ from: "a.ts#run", to: "b.ts#b" }]);
  });

  it("keeps an empty flow when the step cap leaves out every call into another file", async () => {
    const files = { "a.ts": `import { b } from "./b";\n${exported("helper")}${exported("run", "helper(x); b(x);")}`, "b.ts": exported("b") };
    expect(await flowOf(files, { file: "a.ts", symbolName: "run", maxSteps: 1 })).toMatchObject({ omittedSteps: 1, edges: [] });
  });

  it("names the closest candidates for an unknown symbol or file, and every candidate with its 1-based line for an ambiguous one", async () => {
    const files = {
      "svc.ts": "export class A {\n  run() { return 1; }\n}\nexport class B {\n  run() { return 2; }\n}\nexport function runner() { return 3; }\n",
    };
    await expect(flowOf(files, { file: "svc.ts", symbolName: "runer" })).rejects.toThrow("Symbol 'runer' not found in svc.ts. Did you mean: runner, run?");
    await expect(flowOf(files, { file: "svc.ts", symbolName: "run" })).rejects.toThrow(
      "Symbol 'run' is ambiguous in svc.ts: run (method, line 2), run (method, line 5). Pass startLine to select one.",
    );
    await expect(flowOf(files, { file: "svc.ts", symbolName: "run", startLine: 9 })).rejects.toThrow(
      "No symbol 'run' starts at line 9 in svc.ts. Candidates: run (method, line 2), run (method, line 5). Pass startLine to select one.",
    );
    const selected = await flowOf(files, { file: "svc.ts", symbolName: "run", startLine: 5 });
    expect(selected.nodes).toMatchObject([{ id: "svc.ts#run", line: 5 }]);
    await expect(flowOf(files, { file: "sv.ts", symbolName: "run" })).rejects.toThrow("File 'sv.ts' is not in the call graph index. Did you mean: svc.ts?");
  });

  it("fails with a re-index hint when a step file of the index cannot be read", async () => {
    const dir = path.join(root, `case${run++}`);
    await fs.mkdir(dir, { recursive: true });
    const file = normalizePath(path.join(dir, "gone.ts"));
    const source = exported("gone");
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    try {
      const result = await extractor.extractSource(file, "typescript", source);
      indexer.indexFile(result.nodes, result.edges, file, "typescript", 1);
      await expect(buildFlowModel(indexer.getDb(), { filePath: file, symbolName: "gone" }, { rootDir: dir, extractor }))
        .rejects.toThrow("gone.ts is in the call graph index but cannot be read (ENOENT): re-index the workspace.");
    } finally {
      indexer.dispose();
    }
  });
});

describe("laneAt (#792)", () => {
  async function laneOf(lang: "typescript" | "python", source: string, name: string) {
    const lines = source.split("\n");
    const row = lines.findIndex((line) => line.includes(`${name}(`));
    const tree = await extractor.parseTree(lang === "python" ? "x.py" : "x.ts", lang, source);
    try {
      return laneAt(tree!.rootNode, lines[row], { file: "x", row, name });
    } finally {
      tree!.delete();
    }
  }

  it.each([
    ["typescript", "function f(x) {\n  if (!x) return fail();\n  go();\n}", "fail", { lane: "alternative", condition: "!x" }],
    ["typescript", "function f(x) {\n  if (!x) return fail();\n  go();\n}", "go", { lane: "main" }],
    ["typescript", "function f(x) {\n  if (x) {\n    log();\n    process.exit(1);\n  }\n}", "log", { lane: "error", condition: "x" }],
    ["typescript", "function f(x) {\n  if (x) {\n    ok();\n  } else {\n    bad();\n    return;\n  }\n}", "bad", { lane: "alternative", condition: "else" }],
    ["typescript", "function f(x) {\n  if (x) {\n    ok();\n  }\n}", "ok", { lane: "main" }],
    ["typescript", "function f() {\n  throw wrap();\n}", "wrap", { lane: "error" }],
    ["typescript", "function f(x) {\n  if (x) {\n    done();\n    process.exit(ExitCode.SUCCESS);\n  }\n}", "done", { lane: "alternative", condition: "x" }],
    ["typescript", "function f(x) {\n  if (x) {\n    done();\n    process.exit(code(x));\n  }\n}", "done", { lane: "error", condition: "x" }],
    ["python", "def f(x):\n    if x:\n        done()\n        sys.exit()\n", "done", { lane: "alternative", condition: "x" }],
    ["typescript", "function f() {\n  try { a(); } finally { tidy(); }\n}", "tidy", { lane: "main" }],
    ["typescript", `function f(x) {\n  if (${"x".repeat(70)}) throw err();\n}`, "err", { lane: "error" }],
    ["typescript", "function f(x) {\n  if (x) {\n    items.map(() => { inner(); });\n    throw 1;\n  }\n}", "inner", { lane: "main" }],
    ["python", "def f(x):\n    if x:\n        log()\n        return\n    go()\n", "log", { lane: "alternative", condition: "x" }],
    ["python", "def f(x):\n    if x:\n        pass\n    else:\n        bye()\n        os._exit(2)\n", "bye", { lane: "error", condition: "else" }],
    ["python", "def f(x):\n    try:\n        go()\n    except (KeyError, OSError) as e:\n        fix()\n", "fix", { lane: "error", condition: "except (KeyError, OSError) as e" }],
    ["python", "def f(xs):\n    for x in xs:\n        pass\n    else:\n        done()\n        return\n", "done", { lane: "main" }],
  ] as const)("%s: %j calls %s on %j", async (lang, source, name, expected) => {
    expect(await laneOf(lang, source, name)).toEqual(expected);
  });
});

describe("docSubtitle (#792)", () => {
  it.each([
    [["/** One. Two. */", "function f() {}"], 1, "typescript", "One."],
    [["/**", " * Multi", " * line, no period", " * @returns x", " */", "@decorator()", "function f() {}"], 6, "typescript", "Multi line, no period"],
    [["/// Rust doc.", "/// More.", "#[inline]", "fn f() {}"], 3, "rust", "Rust doc."],
    [["// Go doc", "func F() {}"], 1, "go", "Go doc"],
    [["const x = 1;", "function f() {}"], 1, "typescript", undefined],
    [["function f() {}"], 0, "typescript", undefined],
    [[" * stray", " */", "function f() {}"], 2, "typescript", undefined],
    [["def f(", "    a,", "):", "    '''Docs here! More.'''"], 0, "python", "Docs here!"],
    [["def f():", "    return 1"], 0, "python", undefined],
    [["def f():", '    """Unclosed'], 0, "python", undefined],
    [[`/** ${"word ".repeat(40)}*/`, "function f() {}"], 1, "typescript", `${"word ".repeat(40).slice(0, 119)}…`],
  ] as const)("%j at line %i (%s) gives %j", (lines, startLine, lang, expected) => {
    expect(docSubtitle([...lines], startLine, lang)).toBe(expected);
  });
});
