import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diagramHeader, type DiagramInput } from "@/analyzer/diagram/architectureDiagram";
import { diagramSpec, flowSpec, sequenceSpec } from "@/analyzer/diagram/diagramSpec";
import { annotateSpec, cutNote, MAX_SPEC_BYTES, readDiagramSpec, specFlowRequest, specLevel, specSequenceRequest, type LoadedSpec, type SpecKind } from "@/analyzer/diagram/diagramSpecImport";
import type { SequenceModel } from "@/analyzer/diagram/sequenceModel";
import { layoutFlow } from "@/analyzer/diagram/flowDiagram";
import type { FlowModel } from "@/analyzer/diagram/flowModel";
import { normalizePath } from "@/shared/path";

const RUN = "src/a.ts#run";
const HELPER = "src/b.ts#helper";
const FAIL = "src/b.ts#fail";

const MODEL: FlowModel = {
  entry: RUN,
  language: "typescript",
  lanes: "detected",
  maxSteps: 8,
  omittedSteps: 0,
  nodes: [
    { id: RUN, title: "run", file: "src/a.ts", line: 2, lane: "main", symbolCount: 1 },
    { id: HELPER, title: "helper", subtitle: "Helps.", file: "src/b.ts", line: 3, lane: "main", symbolCount: 2 },
    { id: FAIL, title: "fail", file: "src/b.ts", line: 9, lane: "error", symbolCount: 1 },
  ],
  edges: [
    { from: RUN, to: HELPER, file: "src/a.ts", line: 3, relation: "CALLS", lane: "main" },
    { from: HELPER, to: FAIL, file: "src/b.ts", line: 5, relation: "CALLS", lane: "error", condition: "!ok" },
  ],
};

const LEVEL: DiagramInput = {
  workspace: "shop",
  scope: "units",
  noun: "units",
  revision: "r1",
  date: "2026-11-21",
  nodes: [
    { key: "apps/web", label: "web", layer: 1, fileCount: 2 },
    { key: "packages/core", label: "@shop/core", layer: 0, fileCount: 1 },
  ],
  edges: [{ from: "apps/web", to: "packages/core", fileEdgeCount: 2, kind: "down", rules: [] }],
  violations: 0,
};

const FLOW_SPEC = flowSpec(MODEL, "shop");
const LEVEL_SPEC = diagramSpec(LEVEL);
const loaded = (kind: SpecKind, data: object): LoadedSpec => ({ kind, file: "s.json", absolute: "/w/s.json", data: structuredClone(data) as Record<string, unknown> });
/** The flow spec with `change` applied to a deep copy. */
const flowWith = (change: (spec: any) => void) => {
  const spec = structuredClone(FLOW_SPEC) as any;
  change(spec);
  return loaded("flow", spec);
};

describe("annotateSpec (#794)", () => {
  it("gives back the rebuilt spec, nothing cut, for an untouched flow or architecture spec", () => {
    expect(annotateSpec(loaded("flow", FLOW_SPEC), FLOW_SPEC)).toEqual({ spec: FLOW_SPEC, cut: [] });
    expect(annotateSpec(loaded("architecture", LEVEL_SPEC), LEVEL_SPEC)).toEqual({ spec: LEVEL_SPEC, cut: [] });
  });

  it("takes the rewritten texts, sanitized, cut to their box with their paths listed", () => {
    const long = "Asks the helper for an answer and waits for it";
    const { spec, cut } = annotateSpec(flowWith((s) => {
      s.nodes[0].title = "Start\u0007 <here>";
      delete s.nodes[1].subtitle;
      s.nodes[2].subtitle = "Stops";
      s.edges[0].label = long;
      s.caption.title = "How run works";
      s.caption.caption = "x".repeat(200);
    }), FLOW_SPEC);
    expect(spec.nodes.map((node) => [node.title, node.subtitle])).toEqual([["Start� <here>", undefined], ["helper", undefined], ["fail", "Stops"]]);
    expect(spec.edges.map((edge) => edge.label)).toEqual(["Asks the helper for…", "!ok"]);
    expect(spec.caption).toEqual({ ...FLOW_SPEC.caption, title: "How run works", caption: `${"x".repeat(95)}…` });
    expect(cut).toEqual(["edges[0].label", "caption.caption"]);
  });

  it("never reports an untouched long text as cut", () => {
    const longTitle = { ...MODEL, nodes: MODEL.nodes.map((node) => ({ ...node, title: `${node.title}${"_".repeat(40)}` })) };
    const rebuilt = flowSpec(longTitle, "shop");
    expect(annotateSpec(loaded("flow", rebuilt), rebuilt).cut).toEqual([]);
  });

  it("keeps the index's date of an architecture level, and takes its node labels and caption", () => {
    const given = { ...structuredClone(LEVEL_SPEC), date: "2020-01-01", nodes: LEVEL_SPEC.nodes.map((node) => ({ ...node, label: `${node.label} app` })) };
    const { spec } = annotateSpec(loaded("architecture", { ...given, caption: { ...given.caption, title: "Shop" } }), LEVEL_SPEC);
    expect(spec.date).toBe("2026-11-21");
    expect(spec.nodes.map((node) => node.label)).toEqual(["web app", "@shop/core app"]);
    expect(spec.caption.title).toBe("Shop");
  });

  it.each<[string, (spec: any) => void, string]>([
    ["an unknown node id, with the closest", (s) => { s.nodes[1].id = "src/b.ts#helpr"; }, "s.json: nodes[1] src/b.ts#helpr is not in the current index; nodes and edges cannot be added or renamed. Closest: src/b.ts#helper."],
    ["an unknown id far from all", (s) => { s.nodes[1].id = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"; }, `Known: ${RUN}, ${HELPER}, ${FAIL}.`],
    ["an added edge", (s) => { s.edges.push({ ...s.edges[0], to: FAIL }); }, `s.json: edges[2] ${RUN} -> ${FAIL} is not in the current index`],
    ["a removed node", (s) => { s.nodes.pop(); }, `s.json: nodes lacks ${FAIL}, which the current index has; nodes and edges cannot be removed.`],
    ["a node listed twice", (s) => { s.nodes[2] = s.nodes[1]; }, `s.json: nodes[2] ${HELPER} is listed twice.`],
    ["a changed lane", (s) => { s.nodes[1].lane = "error"; }, 's.json: nodes[1].lane is "error" in the spec, "main" in the current index. Only the node title and subtitle, edge label, caption title and caption may change'],
    ["a changed line", (s) => { s.edges[1].line = 6; }, "s.json: edges[1].line is 6 in the spec, 5 in the current index."],
    ["a changed kind of value", (s) => { s.edges[1].condition = 3; }, "s.json: edges[1].condition is 3 in the spec, \"!ok\" in the current index."],
    ["a removed condition", (s) => { delete s.edges[1].condition; }, "s.json: edges[1].condition is absent in the spec"],
    ["changed counts", (s) => { s.caption.counts = "9 steps"; }, "s.json: caption.counts is \"9 steps\" in the spec"],
    ["another entry", (s) => { s.entry = HELPER; }, `s.json: entry is "${HELPER}" in the spec, "${RUN}" in the current index.`],
    ["an unknown field", (s) => { s.nodes[0].colour = "red"; }, "s.json: nodes[0].colour is not a field of a flow diagram spec."],
    ["an unknown top-level field", (s) => { s.theme = "dark"; }, "s.json: theme is not a field of a flow diagram spec."],
    ["an inherited name as a field", (s) => { s.nodes[0] = JSON.parse(`{"__proto__":1,${JSON.stringify(s.nodes[0]).slice(1)}`); }, "s.json: nodes[0].__proto__ is not a field of a flow diagram spec."],
    ["toString as a field", (s) => { s.caption.toString = "x"; }, "s.json: caption.toString is not a field of a flow diagram spec."],
    ["a huge value, shown cut", (s) => { s.language = "x".repeat(10_000); }, `s.json: language is "${"x".repeat(78)}… in the spec`],
    ["an empty title", (s) => { s.nodes[0].title = "  "; }, "s.json: nodes[0].title must be a non-empty string (schemas/diagram-spec.schema.json)."],
    ["a title that is no string", (s) => { s.nodes[0].title = 1; }, "s.json: nodes[0].title must be a non-empty string"],
    ["a removed title", (s) => { delete s.nodes[0].title; }, "s.json: nodes[0].title must be a non-empty string"],
    ["nodes that are no array", (s) => { s.nodes = {}; }, "s.json: nodes must be an array"],
    ["a node that is no object", (s) => { s.nodes[0] = "run"; }, "s.json: nodes[0] must be an object"],
    ["an edge without its ends", (s) => { delete s.edges[0].to; }, "s.json: edges[0].from/to must be a string"],
    ["a caption that is no object", (s) => { s.caption = "x"; }, "s.json: caption must be an object"],
  ])("refuses %s, naming its JSON path", (_name, change, message) => {
    expect(() => annotateSpec(flowWith(change), FLOW_SPEC)).toThrow(message);
  });

  it("refuses an architecture spec of another revision, and a flow text field in it", () => {
    expect(() => annotateSpec(loaded("architecture", { ...LEVEL_SPEC, revision: "r0" }), LEVEL_SPEC)).toThrow(
      's.json is stale or drawn with other rules: it was exported at revision "r0", this level is at "r1". Pass the rules, config and baseline of its export',
    );
    const titled = { ...LEVEL_SPEC, nodes: LEVEL_SPEC.nodes.map((node) => ({ ...node, title: "x" })) };
    expect(() => annotateSpec(loaded("architecture", titled), LEVEL_SPEC)).toThrow("s.json: nodes[0].title is not a field of a architecture diagram spec.");
    expect(() => annotateSpec(loaded("architecture", { ...LEVEL_SPEC, nodes: [LEVEL_SPEC.nodes[1]] }), LEVEL_SPEC)).toThrow("nodes lacks apps/web");
  });
});

describe("annotated texts in the drawing (#794)", () => {
  it("draws a flow's caption and edge labels, and an architecture caption, instead of the built ones", () => {
    const layout = layoutFlow({ ...MODEL, caption: { title: "How run works", caption: "Shop" }, edges: MODEL.edges.map((edge) => ({ ...edge, label: "asks" })) }, "/w/shop");
    expect([layout.text.title, layout.text.caption]).toEqual(["How run works", "Shop"]);
    expect(layout.edges.map((edge) => edge.label.text)).toEqual(["asks", "asks"]);
    expect(layoutFlow(MODEL, "/w/shop").edges.map((edge) => edge.label.text)).toEqual(["line 3", "!ok"]);
    expect(diagramHeader({ ...LEVEL, caption: { title: "T", caption: "C" } }).text).toMatchObject({ title: "T", caption: "C" });
    expect(FLOW_SPEC.caption).toEqual({ title: "Flow · run", caption: "shop · src/a.ts:2 · typescript", counts: "3 steps · 2 calls · 0 references" });
    expect(FLOW_SPEC.edges.map((edge) => edge.label)).toEqual(["line 3", "!ok"]);
  });
});

describe("spec targets (#794)", () => {
  const root = path.resolve("/w/shop");

  it("reads the level and the flow request a spec names", () => {
    expect(specLevel(loaded("architecture", LEVEL_SPEC))).toEqual({ view: "units" });
    expect(specLevel(loaded("architecture", { level: "groups", scope: "apps/web" }))).toEqual({ view: "folder", folder: "apps/web" });
    const request = specFlowRequest(loaded("flow", FLOW_SPEC), root);
    expect({ ...request, filePath: normalizePath(request.filePath) }).toEqual({ filePath: normalizePath(path.join(root, "src/a.ts")), symbolName: "run", startLine: 2, maxSteps: 8 });
    const homonym = { entry: "src/a.ts#run@12", maxSteps: 12, nodes: [{ id: "src/a.ts#run@12", line: 12 }] };
    expect(specFlowRequest(loaded("flow", homonym), root)).toMatchObject({ symbolName: "run", startLine: 12, maxSteps: 12 });
    const decorated = { entry: "src/a#b.ts#on@click", maxSteps: 1, nodes: [{ id: "src/a#b.ts#on@click", line: 1 }] };
    expect(specFlowRequest(loaded("flow", decorated), root)).toMatchObject({ symbolName: "on@click", startLine: 1 });
  });

  it.each<[object, string]>([
    [{ level: "files", scope: "units" }, 's.json: level must be "units" or "groups", not "files"'],
    [{ level: "units", scope: "apps" }, 's.json: scope must be "units" for level "units", not "apps"'],
    [{ level: "groups", scope: "" }, "s.json: scope must be the unit or folder key whose groups are drawn"],
  ])("refuses the level of %j", (data, message) => {
    expect(() => specLevel(loaded("architecture", data))).toThrow(message);
  });

  it.each<[object, string]>([
    [{ entry: "run", maxSteps: 8 }, 's.json: entry must be the entry step\'s id, file#symbol, not "run"'],
    [{ entry: 3, maxSteps: 8 }, "s.json: entry must be the entry step's id, file#symbol, not 3"],
    [{ entry: "src/a.ts#", maxSteps: 8 }, 's.json: entry must be the entry step\'s id, file#symbol, not "src/a.ts#"'],
    [{ entry: RUN, maxSteps: 13 }, "s.json: maxSteps must be an integer from 1 to 12, not 13"],
    [{ entry: RUN, maxSteps: 1.5 }, "s.json: maxSteps must be an integer from 1 to 12, not 1.5"],
    [{ entry: RUN }, "s.json: maxSteps must be an integer from 1 to 12, not absent"],
    [{ entry: RUN, maxSteps: 8 }, `s.json: nodes must hold the entry step ${RUN} with its 1-based line`],
    [{ entry: RUN, maxSteps: 8, nodes: [{ id: RUN, line: 0 }] }, `s.json: nodes must hold the entry step ${RUN}`],
    [{ entry: "../x.ts#run", maxSteps: 8, nodes: [{ id: "../x.ts#run", line: 1 }] }, "s.json: entry ../x.ts#run names a file outside workspace."],
  ])("refuses the flow request of %j", (data, message) => {
    expect(() => specFlowRequest(loaded("flow", data), root)).toThrow(message);
  });

  it("names the cut texts, five at most", () => {
    expect(cutNote([])).toBe("");
    expect(cutNote(["a", "b"])).toBe(' Cut to fit their box (ends with "…"): a, b.');
    expect(cutNote(["a", "b", "c", "d", "e", "f", "g"])).toBe(' Cut to fit their box (ends with "…"): a, b, c, d, e and 2 more.');
  });
});

describe("readDiagramSpec (#794)", () => {
  let root: string;
  const write = (name: string, text: string) => fs.writeFile(path.join(root, name), text);

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-spec-")));
    await fs.mkdir(path.join(root, "specs"));
    await write("specs/flow.json", JSON.stringify(FLOW_SPEC));
    await write("specs/level.json", JSON.stringify(LEVEL_SPEC));
    await write("bad.json", "{ nope");
    await write("array.json", "[1]");
    await write("v2.json", JSON.stringify({ ...FLOW_SPEC, version: 2 }));
    await write("seq.json", JSON.stringify({ ...FLOW_SPEC, kind: "sketch" }));
    await write("big.json", " ".repeat(MAX_SPEC_BYTES + 1));
  });

  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it("reads a flow and an architecture spec, Windows separators included", async () => {
    expect(await readDiagramSpec(root, "specs/flow.json")).toEqual({ kind: "flow", file: "specs/flow.json", absolute: path.join(root, "specs", "flow.json"), data: FLOW_SPEC });
    const level = await readDiagramSpec(root, String.raw`specs\level.json`);
    expect(level).toMatchObject({ kind: "architecture", file: String.raw`specs\level.json`, data: LEVEL_SPEC });
    expect(normalizePath(level.absolute)).toBe(normalizePath(path.join(root, "specs", "level.json")));
  });

  it.each([
    ["specs/flw.json", "Spec file not found: specs/flw.json. Did you mean: specs/flow.json?"],
    ["specs", "Spec file not found: specs."],
    [path.join("..", "x.json"), `Spec file outside workspace: ${path.join("..", "x.json")}. Pass a file of the workspace.`],
    ["bad.json", "bad.json is not valid JSON ("],
    ["array.json", "array.json is not a diagram spec: expected a JSON object in format diagram-spec."],
    ["v2.json", "v2.json: version 2 is not supported; this graph-it reads diagram-spec version 1."],
    ["seq.json", 'seq.json: kind "sketch" is not a diagram-spec kind; expected "flow", "sequence", or no kind for an architecture level.'],
    ["big.json", `Spec file big.json is ${MAX_SPEC_BYTES + 1} bytes; a diagram spec is at most ${MAX_SPEC_BYTES}.`],
  ])("refuses %s", async (file, message) => {
    await expect(readDiagramSpec(root, file)).rejects.toThrow(message);
  });
});

const SEQUENCE: SequenceModel = {
  entry: RUN,
  entryLine: 2,
  entryParticipant: "src/a.ts",
  language: "typescript",
  fragmentDetection: "detected",
  participantsBy: "file",
  depth: 3,
  maxMessages: 30,
  participants: [
    { id: "src/a.ts", title: "a.ts", kind: "file", file: "src/a.ts" },
    { id: "src/b.ts", title: "b.ts", kind: "file", file: "src/b.ts" },
  ],
  messages: [
    { id: "m1", from: "src/a.ts", to: "src/b.ts", name: "helper", targetFile: "src/b.ts", targetLine: 3, file: "src/a.ts", line: 3, relation: "CALLS", level: 1 },
    { id: "m2", from: "src/b.ts", to: "src/b.ts", name: "fail", targetFile: "src/b.ts", targetLine: 9, file: "src/b.ts", line: 5, relation: "CALLS", level: 2, parent: "m1" },
  ],
  fragments: [{ id: "src/b.ts:4:3", kind: "opt", operands: [{ guard: "!ok", first: "m2", last: "m2" }] }],
  omitted: { depth: 0, messages: 0, participants: 0 },
};
const SEQUENCE_SPEC = sequenceSpec(SEQUENCE, "shop");
const sequenceWith = (change: (spec: any) => void) => {
  const spec = structuredClone(SEQUENCE_SPEC) as any;
  change(spec);
  return loaded("sequence", spec);
};

describe("sequence specs (#798 b)", () => {
  const root = path.resolve("/w/shop");

  it("gives back an untouched sequence spec, and takes its lifeline titles, labels, guards and caption", () => {
    expect(annotateSpec(loaded("sequence", SEQUENCE_SPEC), SEQUENCE_SPEC)).toEqual({ spec: SEQUENCE_SPEC, cut: [] });
    const { spec, cut } = annotateSpec(sequenceWith((s) => {
      s.participants[1].title = "Helpers <b>";
      s.messages[0].label = "asks the helper for a long and detailed answer";
      s.fragments[0].operands[0].guard = "when the answer is not ok";
      s.caption.title = "How run works";
    }), SEQUENCE_SPEC);
    expect(spec.participants[1].title).toBe("Helpers <b>");
    expect(spec.messages[0].label).toBe("asks the helper for a long …");
    expect(spec.fragments[0].operands[0].guard).toBe("when the answer is not ok");
    expect(spec.caption.title).toBe("How run works");
    expect(cut).toEqual(["messages[0].label"]);
  });

  it.each<[string, (spec: any) => void, string]>([
    ["an unknown message id", (s) => { s.messages[1].id = "m9"; }, "s.json: messages[1] m9 is not in the current index; lifelines and messages cannot be added or renamed. Closest: m1, m2."],
    ["a removed lifeline", (s) => { s.participants.pop(); }, "s.json: participants lacks src/b.ts, which the current index has; lifelines and messages cannot be removed. Only the lifeline title, message label, operand guard, caption title and caption may change"],
    ["a moved message", (s) => { s.messages[1].to = "src/a.ts"; }, 's.json: messages[1].to is "src/a.ts" in the spec, "src/b.ts" in the current index.'],
    ["a fragment of another kind", (s) => { s.fragments[0].kind = "loop"; }, 's.json: fragments[0].kind is "loop" in the spec, "opt" in the current index.'],
    ["an empty guard", (s) => { s.fragments[0].operands[0].guard = " "; }, "s.json: fragments[0].operands[0].guard must be a non-empty string"],
    ["an unknown field", (s) => { s.messages[0].colour = "red"; }, "s.json: messages[0].colour is not a field of a sequence diagram spec."],
  ])("refuses %s", (_name, change, message) => {
    expect(() => annotateSpec(sequenceWith(change), SEQUENCE_SPEC)).toThrow(message);
  });

  it("reads the entry, its line and the bounds a sequence spec names", () => {
    const request = specSequenceRequest(loaded("sequence", SEQUENCE_SPEC), root);
    expect({ ...request, filePath: normalizePath(request.filePath) }).toEqual({
      filePath: normalizePath(path.join(root, "src/a.ts")), symbolName: "run", startLine: 2, depth: 3, maxMessages: 30, participants: "file",
    });
    // A name ending in @digits is a name: a sequence entry holds no @line.
    expect(specSequenceRequest(loaded("sequence", { ...SEQUENCE_SPEC, entry: "src/a#b.ts#on@12" }), root)).toMatchObject({ symbolName: "on@12" });
  });

  it.each<[object, string]>([
    [{ entry: "run" }, 's.json: entry must be the entry symbol, file#symbol, not "run"'],
    [{ entry: "src/a.ts#" }, 's.json: entry must be the entry symbol, file#symbol, not "src/a.ts#"'],
    [{ entryLine: 0 }, "s.json: entryLine must be the entry's 1-based declaration line, not 0"],
    [{ depth: 1.5 }, "s.json: depth must be an integer of at least 1, not 1.5"],
    [{ maxMessages: 61 }, "s.json: maxMessages must be an integer from 1 to 60, not 61"],
    [{ participantsBy: "module" }, 's.json: participantsBy must be "file" or "class", not "module"'],
    [{ entry: "../x.ts#run" }, "s.json: entry ../x.ts#run names a file outside workspace."],
  ])("refuses the sequence request of %j", (change, message) => {
    expect(() => specSequenceRequest(loaded("sequence", { ...SEQUENCE_SPEC, ...change }), root)).toThrow(message);
  });
});
