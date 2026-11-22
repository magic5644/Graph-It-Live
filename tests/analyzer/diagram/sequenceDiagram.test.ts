import { describe, expect, it } from "vitest";
import { renderDiagramHtml, renderDiagramSvg } from "@/analyzer/diagram/diagramSvg";
import { defaultDiagramFile } from "@/analyzer/diagram/diagramStyle";
import { fragmentTitle, layoutSequence, mermaidText, sequenceMermaid, type SequenceLayout } from "@/analyzer/diagram/sequenceDiagram";
import type { SequenceMessage, SequenceModel } from "@/analyzer/diagram/sequenceModel";

const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts#Cart";

const message = (id: string, from: string, to: string, name: string, extra: Partial<SequenceMessage> = {}): SequenceMessage => ({
  id, from, to, name, targetFile: to.split("#")[0], targetLine: 1, file: from.split("#")[0], line: 3, relation: "CALLS", level: 1, ...extra,
});

/** run (a.ts) → load (b.ts) → save (Cart, self-call inside) ; then a ref and an alt / catch. */
const MODEL: SequenceModel = {
  entry: `${A}#run`,
  entryLine: 2,
  entryParticipant: A,
  language: "typescript",
  fragmentDetection: "detected",
  participantsBy: "class",
  depth: 3,
  maxMessages: 30,
  participants: [
    { id: A, title: "a.ts", kind: "file", file: A },
    { id: B, title: "b.ts", kind: "file", file: B },
    { id: C, title: "Cart", kind: "class", file: "src/c.ts", line: 4 },
  ],
  messages: [
    message("m1", A, B, "load", { await: true }),
    message("m2", B, C, "save", { level: 2, parent: "m1" }),
    message("m3", C, C, "check", { level: 3, parent: "m2" }),
    message("m4", A, B, "format", { relation: "REFERENCES" }),
    message("m5", A, A, "retry"),
    message("m6", A, C, "fail"),
  ],
  fragments: [
    { id: `${A}:5:3`, kind: "alt", operands: [{ guard: "ok", first: "m1", last: "m4" }, { guard: "else", first: "m5", last: "m6" }] },
    { id: `${A}:6:5`, kind: "loop", operands: [{ guard: ".map", first: "m4", last: "m4" }] },
    { id: `${A}:9:5`, kind: "catch", operands: [{ guard: "catch (error)", first: "m6", last: "m6" }] },
  ],
  omitted: { depth: 2, messages: 0, participants: 0 },
};

const layout = layoutSequence(MODEL, "/w/shop");
const inside = (outer: { x: number; y: number; width: number; height: number }, inner: typeof outer) =>
  inner.x > outer.x && inner.y > outer.y && inner.x + inner.width < outer.x + outer.width && inner.y + inner.height < outer.y + outer.height;

describe("layoutSequence (#798 b)", () => {
  it("puts one lifeline per participant left to right, the entry's first and marked", () => {
    expect(layout.lifelines.map((lifeline) => [lifeline.id, lifeline.text, lifeline.meta, lifeline.entry])).toEqual([
      [A, "a.ts", A, true],
      [B, "b.ts", B, false],
      [C, "Cart", "src/c.ts:4", false],
    ]);
    const centres = layout.lifelines.map((lifeline) => lifeline.centre);
    expect(centres).toEqual(centres.toSorted((left, right) => left - right));
    expect(new Set(layout.lifelines.map((lifeline) => lifeline.bottom)).size).toBe(1);
  });

  it("draws each message on its own row, in call order, pointing at its callee", () => {
    const rows = layout.messages.map((placed) => placed.points[0].y);
    expect(rows).toEqual(rows.toSorted((left, right) => left - right));
    expect(new Set(rows).size).toBe(rows.length);
    const [load] = layout.messages;
    expect(load.points).toHaveLength(2);
    expect(load.points[1].x).toBeGreaterThan(load.points[0].x);
    expect(load.label.text).toBe("await load");
    expect(load.title).toBe(`${A} → ${B}: load, ${A}:3 (CALLS, level 1)`);
  });

  it("loops a self-call out and back to a bar nested right of its caller's", () => {
    const check = layout.messages[2];
    expect(check.points).toHaveLength(4);
    expect(check.points[1].x).toBeGreaterThan(check.points[0].x);
    expect(check.points[3].y).toBeGreaterThan(check.points[0].y);
    const cart = layout.activations.filter((bar) => bar.participant === C);
    expect(cart.length).toBeGreaterThanOrEqual(2);
    expect(cart[1].x).toBeGreaterThan(cart[0].x);
  });

  it("keeps the entry's bar over every message and a callee's bar over its sub-calls", () => {
    const [entry, load] = layout.activations;
    expect(entry.participant).toBe(A);
    const last = layout.messages.at(-1)!.points[0].y;
    expect(entry.y).toBeLessThan(layout.messages[0].points[0].y);
    expect(entry.y + entry.height).toBeGreaterThan(last);
    expect(load.participant).toBe(B);
    // load's bar ends after save's and check's rows (its sub-calls), before format's.
    expect(load.y + load.height).toBeGreaterThan(layout.messages[2].points[3].y);
    expect(load.y + load.height).toBeLessThan(layout.messages[3].points[0].y);
  });

  it("starts no bar for a reference and draws it dotted, a call in a catch in the error colour", () => {
    expect(layout.activations).toHaveLength(1 + MODEL.messages.filter((item) => item.relation === "CALLS").length);
    expect(layout.messages.map((placed) => placed.kind)).toEqual(["call", "call", "call", "reference", "call", "catch-call"]);
    expect(layout.legend.kinds).toEqual(expect.arrayContaining(["entry", "call", "reference", "catch-call"]));
  });

  it("frames each fragment around its messages, nested ones inside, one separator per extra operand", () => {
    const [alt, loop, caught] = layout.fragments;
    expect(alt.label.text).toBe("alt [ok]");
    expect(alt.separators.map((separator) => separator.label.text)).toEqual(["[else]"]);
    expect(loop.label.text).toBe("loop [.map]");
    expect(caught.label.text).toBe("catch (error)");
    expect(inside(alt, loop)).toBe(true);
    expect(inside(alt, caught)).toBe(true);
    for (const [fragment, from, to] of [[alt, 0, 5], [loop, 3, 3], [caught, 5, 5]] as const) {
      expect(layout.messages[from].points[0].y).toBeGreaterThan(fragment.y);
      expect(layout.messages[to].points.at(-1)!.y).toBeLessThan(fragment.y + fragment.height);
    }
    expect(alt.separators[0].y).toBeGreaterThan(layout.messages[3].points[0].y);
    expect(alt.separators[0].y).toBeLessThan(layout.messages[4].points[0].y);
  });

  it("states what was left out and fits the canvas around every drawn thing", () => {
    expect(layout.text.title).toBe("Sequence · run");
    expect(layout.text.counts).toBe("3 lifelines · 5 calls · 1 reference · 3 fragments");
    expect(layout.text.hidden).toEqual(["2 calls past depth 3 left out: rerun with --depth 4"]);
    const right = Math.max(...layout.fragments.map((fragment) => fragment.x + fragment.width), ...layout.lifelines.map((lifeline) => lifeline.x + lifeline.width));
    expect(layout.width).toBeGreaterThan(right);
    // A self-call on the last lifeline with a long label widens the canvas past the label.
    const selfLast = layoutSequence({ ...MODEL, messages: [message("m1", A, C, "save"), message("m2", C, C, "validateEveryLineOfTheCart", { level: 2, parent: "m1" })], fragments: [] }, "/w/shop");
    const label = selfLast.messages[1].label;
    expect(selfLast.width).toBeGreaterThan(label.x + label.text.length * 11 * 0.62);
    expect(layout.height).toBeGreaterThan(layout.lifelines[0].bottom);
  });

  it("is deterministic and draws a sequence without messages as its lifeline alone", () => {
    expect(layoutSequence(MODEL, "/w/shop")).toEqual(layout);
    const empty = layoutSequence({ ...MODEL, participants: MODEL.participants.slice(0, 1), messages: [], fragments: [], omitted: { depth: 0, messages: 0, participants: 0 } }, "/w/shop");
    expect(empty.lifelines).toHaveLength(1);
    expect([empty.messages, empty.activations, empty.fragments]).toEqual([[], [], []]);
  });

  it("draws annotated labels and cuts long ones", () => {
    const annotated = layoutSequence({ ...MODEL, messages: MODEL.messages.map((item, index) => (index === 0 ? { ...item, label: "loads the cart from the database store" } : item)) }, "/w/shop");
    expect(annotated.messages[0].label.text).toBe("loads the cart from the dat…");
  });

  it("names a fragment by its keyword and first guard, a catch by its clause", () => {
    expect(fragmentTitle(MODEL.fragments[0])).toBe("alt [ok]");
    expect(fragmentTitle({ id: "x", kind: "catch", operands: [{ guard: "except OSError", first: "m1", last: "m1" }] })).toBe("except OSError");
  });
});

describe("sequence SVG and HTML (#798 b)", () => {
  const svg = renderDiagramSvg(layout, "dark");

  it("draws lifelines, bars, frames, messages and the legend, every text escaped", () => {
    expect(svg).toMatch(/^<svg /);
    expect(svg.match(/class="lifeline"/g)).toHaveLength(3);
    expect(svg.match(/class="activation"/g)).toHaveLength(layout.activations.length);
    expect(svg.match(/<rect class="fragment"/g)).toHaveLength(3);
    expect(svg).toContain('class="fragment operand"');
    expect(svg).toContain(">call in a catch<");
    expect(svg).toContain('marker-end="url(#arrow-catch-call)"');
    expect(svg).toContain("#0d1117");
    const hostile: SequenceLayout = layoutSequence({ ...MODEL, participants: MODEL.participants.map((item, index) => (index === 1 ? { ...item, title: "<b>&\u202E" } : item)) }, "/w/shop");
    expect(renderDiagramSvg(hostile)).toContain("&lt;b&gt;&amp;\uFFFD");
  });

  it("writes one self-contained page following the reader's scheme", () => {
    const html = renderDiagramHtml(layout);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/<script|https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("sequenceMermaid (#798 b)", () => {
  it("writes a sequenceDiagram GitHub renders: aliases, arrows, activations, fragments, notes", () => {
    expect(sequenceMermaid(MODEL, "/w/shop")).toBe([
      "sequenceDiagram",
      "  title Sequence · run · 3 lifelines · 5 calls · 1 reference · 3 fragments",
      "  participant P1 as a.ts",
      "  participant P2 as b.ts",
      "  participant P3 as Cart",
      "  alt ok",
      "  P1->>P2: await load",
      "  activate P2",
      "  P2->>P3: save",
      "  activate P3",
      "  P3->>P3: check",
      "  activate P3",
      "  deactivate P3",
      "  deactivate P3",
      "  deactivate P2",
      "  loop .map",
      "  P1-->>P2: ref format",
      "  end",
      "  else else",
      "  P1->>P1: retry",
      "  activate P1",
      "  deactivate P1",
      "  break catch (error)",
      "  P1->>P3: fail",
      "  activate P3",
      "  deactivate P3",
      "  end",
      "  end",
      "  Note over P1,P3: 2 calls past depth 3 left out: rerun with --depth 4",
      "",
    ].join("\n"));
  });

  it("keeps the Mermaid syntax out of labels: no separator, entity, tag, comment or control character", () => {
    expect(mermaidText("a;b#c<d>e%f")).toBe("a b c d e f");
    expect(mermaidText(`x === "--" && [a] {b} 'c' \`d\``)).toBe("x === -- a b c d");
    expect(mermaidText("x\ny\u0007z\u202Ew")).toBe("x y z w");
    expect(mermaidText(";#")).toBe("_");
    expect(mermaidText("x".repeat(200))).toHaveLength(96);
    const single = sequenceMermaid({ ...MODEL, participants: MODEL.participants.slice(0, 1), messages: [], fragments: [] }, "/w/shop");
    expect(single).toContain("  Note over P1: 2 calls past depth 3 left out");
  });

  it("closes nested fragments sharing their first and last message inner first, after the bars they hold", () => {
    const nested: SequenceModel = {
      ...MODEL,
      messages: [message("m1", A, B, "load"), message("m2", B, B, "parse", { level: 2, parent: "m1" })],
      fragments: [
        { id: "a:1:1", kind: "alt", operands: [{ guard: "ok", first: "m1", last: "m2" }] },
        { id: "a:2:3", kind: "opt", operands: [{ guard: "ready", first: "m1", last: "m2" }] },
      ],
      omitted: { depth: 0, messages: 0, participants: 0 },
    };
    const lines = sequenceMermaid(nested, "/w/shop").split("\n").slice(5, -1);
    expect(lines).toEqual([
      "  alt ok", "  opt ready",
      "  P1->>P2: load", "  activate P2", "  P2->>P2: parse", "  activate P2", "  deactivate P2", "  deactivate P2",
      "  end", "  end",
    ]);
    const [outer, inner] = layoutSequence(nested, "/w/shop").fragments;
    expect(inside(outer, inner)).toBe(true);
  });

  it("names its default file sequence.mmd", () => {
    expect(defaultDiagramFile("mermaid", "sequence")).toBe("sequence.mmd");
    expect(defaultDiagramFile("svg", "sequence")).toBe("sequence.svg");
    expect(defaultDiagramFile("diagram-spec", "sequence")).toBe("sequence.diagram-spec.json");
  });
});
