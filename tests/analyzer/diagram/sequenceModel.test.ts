import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sequenceSpec } from "@/analyzer/diagram/diagramSpec";
import { defaultMessageLabel, sequenceText } from "@/analyzer/diagram/sequenceDiagram";
import { buildSequenceModel, type SequenceModel, type SequenceModelRequest } from "@/analyzer/diagram/sequenceModel";
import { normalizePath } from "@/shared/path";
import { createTreeSitterHarness } from "../callgraph/treeSitterHarness";

const SPEC_SCHEMA = JSON.parse(readFileSync(path.resolve("schemas/diagram-spec.schema.json"), "utf8"));
const validateSpec = new Ajv2020({ allErrors: true }).compile(SPEC_SCHEMA);

let harness: Awaited<ReturnType<typeof createTreeSitterHarness>>;
let run = 0;

beforeAll(async () => {
  harness = await createTreeSitterHarness("gil-sequence-");
});

afterAll(() => harness.dispose());

/** Indexes `files` in a fresh folder, then builds the sequence model of `request` there. */
async function sequenceOf(files: Record<string, string>, request: Omit<SequenceModelRequest, "filePath"> & { file: string }): Promise<SequenceModel> {
  const folder = `case${run++}`;
  const dir = path.join(harness.root, folder);
  const indexer = await harness.newIndexer();
  try {
    await harness.indexInto(indexer, Object.fromEntries(Object.entries(files).map(([name, source]) => [`${folder}/${name}`, source])));
    const { file, ...rest } = request;
    return await buildSequenceModel(indexer.getDb(), { ...rest, filePath: path.join(dir, file) }, { rootDir: dir, extractor: harness.extractor });
  } finally {
    indexer.dispose();
  }
}

const fn = (name: string, body = "") => `export function ${name}(x?: unknown): unknown {\n  ${body}\n  return x;\n}\n`;
const calls = (model: SequenceModel) => model.messages.map((message) => `${message.from}>${message.to}:${message.name}`);
const operandText = (operand: SequenceModel["fragments"][number]["operands"][number]) => `${operand.guard}:${operand.first}-${operand.last}`;
const fragments = (model: SequenceModel) => model.fragments.map((fragment) => `${fragment.kind}[${fragment.operands.map(operandText).join("|")}]`);

const COMMAND = [
  'import { load, validate, report, save, audit, commit, rollback, skip, done, fail, pick } from "./lib";',
  "export async function run(args: string[], ok: boolean, mode: string) {",
  "  const data = await load(args);",
  "  if (!validate(data)) {",
  '    report("bad");',
  "    return;",
  "  }",
  "  for (const item of args) {",
  "    save(item);",
  "  }",
  "  args.map((a) => audit(a));",
  "  try {",
  "    commit();",
  "  } catch (error) {",
  "    rollback();",
  "  }",
  "  switch (mode) {",
  '    case "a":',
  "      pick();",
  "      break;",
  "    default:",
  "      skip();",
  "  }",
  "  return ok ? done() : fail();",
  "}",
  "",
].join("\n");

const LIB = ["load", "validate", "report", "save", "audit", "commit", "rollback", "skip", "done", "fail", "pick"].map((name) => fn(name)).join("");

describe("buildSequenceModel — TypeScript fragments", () => {
  it("draws the calls in call order with opt, loop, iterator, catch, switch and ternary fragments", async () => {
    const model = await sequenceOf({ "src/command.ts": COMMAND, "src/lib.ts": LIB }, { file: "src/command.ts", symbolName: "run" });
    expect(model.entry).toBe("src/command.ts#run");
    expect(model.entryParticipant).toBe("src/command.ts");
    expect(model.fragmentDetection).toBe("detected");
    expect(model.participants.map((participant) => participant.id)).toEqual(["src/command.ts", "src/lib.ts"]);
    expect(model.messages.map((message) => message.name)).toEqual(["load", "validate", "report", "save", "audit", "commit", "rollback", "pick", "skip", "done", "fail"]);
    expect(model.messages[0]).toMatchObject({ id: "m1", await: true, file: "src/command.ts", line: 3, targetFile: "src/lib.ts", targetLine: 1, level: 1, relation: "CALLS" });
    expect(model.messages[1].await).toBeUndefined();
    expect(fragments(model)).toEqual([
      "opt[!validate(data):m3-m3]",
      "loop[for (const item of args):m4-m4]",
      "loop[.map:m5-m5]",
      "catch[catch (error):m7-m7]",
      'alt[case "a":m8-m8|default:m9-m9]',
      "alt[ok:m10-m10|else:m11-m11]",
    ]);
  });

  it("reads if / else and else-if as alt operands, nested for an else-if", async () => {
    const source = [
      'import { a, b, c } from "./lib";',
      "export function run(x: number) {",
      "  if (x > 1) {",
      "    a();",
      "  } else if (x > 0) {",
      "    b();",
      "  } else {",
      "    c();",
      "  }",
      "}",
      "",
    ].join("\n");
    const model = await sequenceOf({ "src/run.ts": source, "src/lib.ts": fn("a") + fn("b") + fn("c") }, { file: "src/run.ts", symbolName: "run" });
    expect(fragments(model)).toEqual(["alt[x > 1:m1-m1|else:m2-m3]", "alt[x > 0:m2-m2|else:m3-m3]"]);
    expect(model.fragments[0].id).toBe("src/run.ts:3:3");
  });

  it("puts a callee's calls inside the fragment of the call that reaches it", async () => {
    const files = {
      "src/run.ts": 'import { step } from "./step";\nexport function run(ok: boolean) {\n  if (ok) {\n    step();\n  }\n}\n',
      "src/step.ts": 'import { leaf } from "./leaf";\nexport function step() {\n  leaf();\n}\n',
      "src/leaf.ts": fn("leaf"),
    };
    const model = await sequenceOf(files, { file: "src/run.ts", symbolName: "run" });
    expect(calls(model)).toEqual(["src/run.ts>src/step.ts:step", "src/step.ts>src/leaf.ts:leaf"]);
    expect(model.messages[1]).toMatchObject({ level: 2, parent: "m1" });
    expect(fragments(model)).toEqual(["opt[ok:m1-m2]"]);
  });
});

describe("buildSequenceModel — walk", () => {
  const files = {
    "src/run.ts": 'import { first, second } from "./steps";\nexport function run() {\n  first();\n  second();\n}\n',
    "src/steps.ts": [
      'import { shared } from "./shared";',
      "export function first() {\n  shared();\n}",
      "export function second() {\n  shared();\n  second();\n}",
      "",
    ].join("\n"),
    "src/shared.ts": 'import { deep } from "./deep";\nexport function shared() {\n  deep();\n}\n',
    "src/deep.ts": 'import { deeper } from "./deeper";\nexport function deep() {\n  deeper();\n}\n',
    "src/deeper.ts": fn("deeper"),
  };

  it("expands a callee once and draws a recursive call as a self-message", async () => {
    const model = await sequenceOf(files, { file: "src/run.ts", symbolName: "run" });
    expect(calls(model)).toEqual([
      "src/run.ts>src/steps.ts:first",
      "src/steps.ts>src/shared.ts:shared",
      "src/shared.ts>src/deep.ts:deep",
      "src/run.ts>src/steps.ts:second",
      "src/steps.ts>src/shared.ts:shared",
      "src/steps.ts>src/steps.ts:second",
    ]);
    expect(model.messages[4].repeat).toBe(true);
    expect(model.messages[5].recursive).toBe(true);
    expect(model.omitted).toEqual({ depth: 1, messages: 0, participants: 0 });
    expect(sequenceText(model, "ws").hidden).toEqual([
      "1 call past depth 3 left out: rerun with --depth 4",
      "a callee drawn again is not expanded twice: its calls are under its first message",
    ]);
  });

  it("counts the calls past depth and past maxMessages, with the option that shows them", async () => {
    const shallow = await sequenceOf(files, { file: "src/run.ts", symbolName: "run", depth: 1 });
    expect(shallow.messages.map((message) => message.name)).toEqual(["first", "second"]);
    expect(shallow.omitted.depth).toBe(3);
    const capped = await sequenceOf(files, { file: "src/run.ts", symbolName: "run", maxMessages: 2 });
    expect(capped.messages.map((message) => message.name)).toEqual(["first", "shared"]);
    expect(capped.omitted.messages).toBe(2);
    expect(sequenceText(capped, "ws").hidden[0]).toBe("2 calls past 2 messages left out: rerun with --maxMessages 4");
    const full = await sequenceOf(files, { file: "src/run.ts", symbolName: "run", maxMessages: 60, depth: 9 });
    expect(full.omitted).toEqual({ depth: 0, messages: 0, participants: 0 });
  });

  it("caps the lifelines at 12 and counts the calls left out", async () => {
    const names = Array.from({ length: 14 }, (_, index) => `f${index}`);
    const wide: Record<string, string> = {
      "src/run.ts": [...names.map((name) => `import { ${name} } from "./${name}";`), "export function run() {", ...names.map((name) => `  ${name}();`), "}", ""].join("\n"),
    };
    for (const name of names) wide[`src/${name}.ts`] = fn(name);
    const model = await sequenceOf(wide, { file: "src/run.ts", symbolName: "run" });
    expect(model.participants).toHaveLength(12);
    expect(model.messages).toHaveLength(11);
    expect(model.omitted.participants).toBe(3);
    expect(sequenceText(model, "ws").hidden).toEqual(["3 calls into lifelines past 12 left out: rerun with a smaller --depth"]);
  });

  it("gives one lifeline per class for methods and one per file for free functions", async () => {
    const files = {
      "src/run.ts": [
        'import { Cart } from "./cart";',
        'import { log } from "./log";',
        "export function run() {",
        "  const cart = new Cart();",
        "  cart.add();",
        "  log();",
        "}",
        "",
      ].join("\n"),
      "src/cart.ts": 'import { Price } from "./price";\nexport class Cart {\n  add() {\n    new Price().total();\n  }\n}\n',
      "src/price.ts": "export class Price {\n  total() {\n    return 1;\n  }\n}\n",
      "src/log.ts": fn("log"),
    };
    const model = await sequenceOf(files, { file: "src/run.ts", symbolName: "run", participants: "class" });
    expect(model.participantsBy).toBe("class");
    const ids = model.participants.map((participant) => participant.id);
    expect(ids).toContain("src/cart.ts#Cart");
    expect(ids).toContain("src/price.ts#Price");
    expect(ids).toContain("src/log.ts");
    expect(model.participants.find((participant) => participant.id === "src/cart.ts#Cart")).toMatchObject({ kind: "class", title: "Cart", line: 2 });
    expect(calls(model)).toContain("src/cart.ts#Cart>src/price.ts#Price:total");
  });

  it("gives one participant and no message for a symbol that calls nothing", async () => {
    const model = await sequenceOf({ "src/leaf.ts": fn("leaf") }, { file: "src/leaf.ts", symbolName: "leaf" });
    expect(model.participants).toHaveLength(1);
    expect(model.messages).toEqual([]);
    expect(sequenceText(model, "ws").counts).toBe("1 lifeline · 0 calls · 0 references · 0 fragments");
  });
});

describe("buildSequenceModel — other languages", () => {
  it("reads Python if / elif / else, for, comprehension and except fragments", async () => {
    const source = [
      "from lib import a, b, c, d, e, f",
      "",
      "def run(x, items):",
      "    if x > 1:",
      "        a()",
      "    elif x > 0:",
      "        b()",
      "    else:",
      "        c()",
      "    for item in items:",
      "        d(item)",
      "    values = [e(item) for item in items]",
      "    try:",
      "        pass",
      "    except OSError:",
      "        f()",
      "",
    ].join("\n");
    const lib = ["a", "b", "c", "d", "e", "f"].map((name) => `def ${name}(*args):\n    return 1\n\n`).join("");
    const model = await sequenceOf({ "run.py": source, "lib.py": lib }, { file: "run.py", symbolName: "run" });
    expect(model.messages.map((message) => message.name)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(fragments(model)).toEqual([
      "alt[x > 1:m1-m1|x > 0:m2-m2|else:m3-m3]",
      "loop[for item in items:m4-m4]",
      "loop[for item in items:m5-m5]",
      "catch[except OSError:m6-m6]",
    ]);
  });

  it("draws Go calls in call order without fragments and says so", async () => {
    const source = "package main\n\nfunc run(ok bool) {\n\tif ok {\n\t\tfirst()\n\t}\n\tsecond()\n}\n\nfunc first() {}\n\nfunc second() {}\n";
    const model = await sequenceOf({ "main.go": source }, { file: "main.go", symbolName: "run" });
    expect(model.fragmentDetection).toBe("unsupported");
    expect(model.messages.map((message) => message.name)).toEqual(["first", "second"]);
    expect(model.fragments).toEqual([]);
    expect(sequenceText(model, "ws").hidden).toContain("fragments not read for go: messages in call order");
  });
});

describe("buildSequenceModel — failures", () => {
  const files = { "src/run.ts": fn("run") + fn("runner") };

  it("names the candidates of an unknown symbol", async () => {
    await expect(sequenceOf(files, { file: "src/run.ts", symbolName: "rnu" })).rejects.toThrow(/rnu.*run/s);
  });

  it("lists the closest paths for a file not in the index", async () => {
    await expect(sequenceOf(files, { file: "src/missing.ts", symbolName: "run" })).rejects.toThrow("File 'src/missing.ts' is not in the call graph index.");
  });

  it.each([
    [{ depth: 0 }, "depth must be an integer of at least 1, got 0."],
    [{ maxMessages: 61 }, "maxMessages must be an integer from 1 to 60, got 61."],
    [{ maxMessages: 0 }, "maxMessages must be an integer from 1 to 60, got 0."],
    [{ participants: "module" as never }, 'participants must be "file" or "class", got "module".'],
  ])("refuses %o", async (options, message) => {
    await expect(sequenceOf(files, { file: "src/run.ts", symbolName: "run", ...options })).rejects.toThrow(message);
  });
});

describe("sequenceSpec", () => {
  it("validates against the schema, holds no absolute path and is deterministic", async () => {
    const files = { "src/command.ts": COMMAND, "src/lib.ts": LIB };
    const first = sequenceSpec(await sequenceOf(files, { file: "src/command.ts", symbolName: "run" }), "my-app");
    const second = sequenceSpec(await sequenceOf(files, { file: "src/command.ts", symbolName: "run" }), "my-app");
    expect(validateSpec(first), JSON.stringify(validateSpec.errors)).toBe(true);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain(normalizePath(harness.root));
    expect(first.kind).toBe("sequence");
    expect(first.caption.title).toBe("Sequence · run");
    expect(first.messages[0].label).toBe("await load");
  });

  it("labels a reference and sanitizes control characters", () => {
    const message = { id: "m1", from: "a", to: "b", name: "go", targetFile: "b", targetLine: 1, file: "a", line: 1, relation: "REFERENCES" as const, level: 1 };
    expect(defaultMessageLabel(message)).toBe("ref go");
    const model: SequenceModel = {
      entry: "a#run", entryParticipant: "a", language: "typescript", fragmentDetection: "detected", participantsBy: "file", depth: 3, maxMessages: 60,
      participants: [{ id: "a", title: "a\u0007", kind: "file", file: "a" }], messages: [{ ...message, label: "x‮y" }], fragments: [],
      omitted: { depth: 0, messages: 5, participants: 0 },
    };
    const spec = sequenceSpec(model, "ws");
    expect(spec.participants[0].title).toBe("a�");
    expect(spec.messages[0].label).toBe("x�y");
    expect(sequenceText(model, "ws").hidden).toEqual(["5 calls past 60 messages left out: 60 messages is the most a sequence draws: rerun with a smaller --depth"]);
  });
});
