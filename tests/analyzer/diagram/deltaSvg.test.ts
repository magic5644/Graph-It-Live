// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DELTA } from "@/analyzer/diagram/diagramStyle";
import { deltaChanged, deltaUnchangedLine, renderArchitectureDelta, renderDeltaSvg } from "@/analyzer/diagram/deltaSvg";
import { buildDeltaModel, layoutDelta } from "@/analyzer/diagram/architectureDelta";
import { deltaSource, edge, item, rule } from "./deltaFixtures";

const SOURCE = () => deltaSource({
  items: [item("ADDED", "billing"), item("REMOVED", "legacy"), item("CHANGED", "api", { role: { before: "lib", after: "app" } }), item("RENAMED", "web", { previousKey: "ui" })],
  edges: [edge("ADDED", "api", "billing"), edge("REMOVED", "api", "legacy", { gone: ["to"] }), edge("CHANGED", "web", "api"), edge("ADDED", "db", "api")],
  cycles: [{ status: "ADDED", members: ["api", "billing"] }],
  rules: [rule("r", { new: [["db", "api"]] })],
  unchangedEdges: 3,
});

const parse = (markup: string) => new DOMParser().parseFromString(markup, "image/svg+xml");
const panel = (doc: Document, snapshot: string) => doc.querySelector(`g[data-snapshot="${snapshot}"]`)!;
const ids = (group: Element, kind: string) => [...group.querySelectorAll(`[data-kind="${kind}"]`)].map((el) => el.getAttribute("data-object-id")!);

describe("renderArchitectureDelta", () => {
  it("draws both panels on one grid with the data-attribute grammar", async () => {
    const { markup, counts, cut } = await renderArchitectureDelta(SOURCE());
    const doc = parse(markup);
    expect(doc.documentElement.getAttribute("data-diagram")).toBe("architecture-delta");
    const [before, after] = [panel(doc, "before"), panel(doc, "after")];
    expect(before.getAttribute("data-grid")).toBe(after.getAttribute("data-grid"));
    expect(ids(before, "unit").toSorted()).toEqual(["-legacy", "api", "db", "web"]);
    expect(ids(after, "unit").toSorted()).toEqual(["api", "billing", "db", "web"]);
    // an edge is drawn in a panel only when both ends are there
    expect(ids(before, "edge").toSorted()).toEqual(["api->-legacy", "web->api"]);
    expect(ids(after, "edge").toSorted()).toEqual(["api->billing", "db->api", "web->api"]);
    expect(counts).toContain("units");
    expect(cut).toContain("3 unchanged unit edges not drawn");
    for (const unit of doc.querySelectorAll('g[data-kind="unit"]')) {
      expect(unit.querySelector('rect[data-role="bounds"]')).not.toBeNull();
      expect(unit.getAttribute("data-status")).toMatch(/^(ADDED|REMOVED|CHANGED|RENAMED|REWIRED|UNCHANGED)$/);
    }
  });

  it("rings a member of a resolved and a new cycle in both panels", async () => {
    const { markup } = await renderArchitectureDelta(deltaSource({
      items: [item("ADDED", "shipping")],
      cycles: [{ status: "REMOVED", members: ["billing", "orders"] }, { status: "ADDED", members: ["billing", "orders", "shipping"] }],
    }));
    const doc = parse(markup);
    const ringed = (snapshot: string) => [...panel(doc, snapshot).querySelectorAll('[data-role="ring"]')].map((ring) => ring.parentElement!.getAttribute("data-object-id"));
    expect(ringed("before")).toEqual(["billing", "orders"]);
    expect(ringed("after")).toEqual(["billing", "orders", "shipping"]);
    expect(markup).toContain("in resolved and new cycles");
  });

  it.each([["ADDED", "after", "before"], ["REMOVED", "before", "after"]] as const)("rings a %s cycle only in the %s panel", async (status, shown, hidden) => {
    const { markup } = await renderArchitectureDelta(deltaSource({
      items: [item("CHANGED", "api"), item("CHANGED", "billing")],
      cycles: [{ status, members: ["api", "billing"] }],
    }));
    const doc = parse(markup);
    expect(panel(doc, shown).querySelectorAll('[data-role="ring"]')).toHaveLength(2);
    expect(panel(doc, hidden).querySelectorAll('[data-role="ring"]')).toHaveLength(0);
  });

  it("gives a retained unit the same x and y in both panels, parsed from the SVG", async () => {
    const doc = parse((await renderArchitectureDelta(SOURCE())).markup);
    const box = (snapshot: string, id: string) => {
      const rect = panel(doc, snapshot).querySelector(`g[data-object-id="${id}"] rect[data-role="bounds"]`)!;
      return [rect.getAttribute("x"), rect.getAttribute("y")];
    };
    for (const id of ["api", "db", "web"]) expect(box("before", id)).toEqual(box("after", id));
    const shift = (snapshot: string) => panel(doc, snapshot).getAttribute("transform")!.replace(/translate\(([\d.]+) ([\d.]+)\)/, "$2");
    expect(shift("before")).toBe(shift("after"));
    expect(panel(doc, "before").getAttribute("transform")).not.toBe(panel(doc, "after").getAttribute("transform"));
  });

  it("writes one ledger row per (target, change), none duplicated, every change has one", async () => {
    const doc = parse((await renderArchitectureDelta(SOURCE())).markup);
    const rows = [...doc.querySelectorAll("text[data-target]")];
    const keys = rows.map((row) => `${row.getAttribute("data-target")}|${row.getAttribute("data-change")}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const unit of doc.querySelectorAll('g[data-kind="unit"]:not([data-status="UNCHANGED"])')) {
      const status = unit.getAttribute("data-status");
      expect(keys).toContain(`${unit.getAttribute("data-object-id")}|${status}`);
      expect(unit.querySelector("text.meta")!.textContent).toContain(status);
    }
    for (const row of rows) expect(row.textContent).toMatch(/^(ADDED|REMOVED|CHANGED|RENAMED|REWIRED|NEW|ACCEPTED|RESOLVED) /);
  });

  it("tells every status apart by a unique (width, dash) pair, with colours removed", async () => {
    const pairs = Object.values(DELTA).map((style) => `${style.width}:${(style as { dash?: string }).dash ?? "solid"}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const doc = parse((await renderArchitectureDelta(SOURCE())).markup);
    const bySignature = new Map<string, string>();
    for (const unit of doc.querySelectorAll('g[data-kind="unit"]')) {
      const signature = unit.getAttribute("data-signature")!;
      const status = unit.getAttribute("data-status")!;
      expect(bySignature.get(signature) ?? status).toBe(status);
      bySignature.set(signature, status);
      const bounds = unit.querySelector('rect[data-role="bounds"]')!;
      expect(`${bounds.getAttribute("stroke-width")}:${bounds.getAttribute("stroke-dasharray") ?? "solid"}`).toBe(signature);
    }
  });

  it("is byte-identical across runs, in both themes, and the themes differ", async () => {
    const layout = await layoutDelta(buildDeltaModel(SOURCE()));
    expect(renderDeltaSvg(layout)).toBe(renderDeltaSvg(layout));
    expect((await renderArchitectureDelta(SOURCE())).markup).toBe((await renderArchitectureDelta(SOURCE())).markup);
    const dark = (await renderArchitectureDelta(SOURCE(), { theme: "dark" })).markup;
    expect(dark).toContain("--bg:#0d1117");
    expect(renderDeltaSvg(layout, "light")).toContain("--bg:#ffffff");
    expect(parse(dark).querySelector("parsererror")).toBeNull();
  });

  it("escapes hostile names and refs and holds no script, foreignObject or external URL", async () => {
    const hostile = `<script>"&'`;
    const source = deltaSource({
      items: [item("ADDED", hostile), item("RENAMED", `<b onload="x">`, { previousKey: hostile })],
      edges: [edge("ADDED", hostile, "x")],
      rules: [rule(hostile, { new: [[hostile, "x"]] })],
      warnings: ["see https://evil.example/x <script>"],
    });
    const { markup } = await renderArchitectureDelta({ ...source, baseRef: hostile, headRef: "feature" });
    expect(markup).not.toMatch(/<script|<foreignObject/i);
    expect(markup.match(/https?:\/\/[^"\s<]*/g)?.filter((url) => url !== "http://www.w3.org/2000/svg") ?? []).toEqual(["https://evil.example/x"]);
    expect(markup).toContain("&lt;script&gt;");
    const doc = parse(markup);
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("script")).toBeNull();
    expect(ids(panel(doc, "after"), "unit")).toContain(hostile);
  });

  it("draws the ledger, the cut notes, the warnings and the legend", async () => {
    const { markup, warnings } = await renderArchitectureDelta({ ...SOURCE(), structure: { ...SOURCE().structure!, warnings: ["Git rename detection failed"] } });
    expect(warnings).toEqual(["Git rename detection failed"]);
    expect(markup).toContain("warning: Git rename detection failed");
    expect(markup).toContain("3 unchanged unit edges not drawn");
    for (const word of ["ADDED", "REMOVED", "CHANGED", "RENAMED", "REWIRED", "UNCHANGED (context)"]) expect(markup).toContain(`>${word}</text>`);
  });

  it("marks a violation edge red on the side where it exists and a resolved one in Before", async () => {
    const source = deltaSource({ items: [item("REMOVED", "x")], edges: [edge("REMOVED", "x", "y", { gone: ["from"] })], rules: [rule("r", { resolved: [["x", "y"]] })] });
    const doc = parse((await renderArchitectureDelta(source)).markup);
    expect(panel(doc, "before").querySelector('path[data-kind="edge"]')!.getAttribute("class")).toContain("s-error");
    expect(panel(doc, "after").querySelector('path[data-kind="edge"]')).toBeNull();
  });

  it("refuses a review without a structure", async () => {
    await expect(renderArchitectureDelta({ baseRef: "a", headRef: "b", limitations: [] })).rejects.toThrow(/No structure diff/);
  });

  it("stays valid with 60 changed units and cuts at the cap", async () => {
    const items = Array.from({ length: 60 }, (_, index) => item(index % 3 === 0 ? "ADDED" : index % 3 === 1 ? "REMOVED" : "CHANGED", `unit-${String(index).padStart(2, "0")}`));
    const edges = items.slice(1).map((unit, index) => edge("ADDED", items[index].key, unit.key, { gone: items[index].status === "REMOVED" ? ["from"] : undefined }));
    const { markup, cut } = await renderArchitectureDelta(deltaSource({ items, edges }));
    const doc = parse(markup);
    expect(doc.querySelectorAll('g[data-snapshot="after"] g[data-kind="unit"]').length).toBeLessThanOrEqual(40);
    expect(cut.some((line) => line.includes("graph-it review-pr --base main --head feature --format json"))).toBe(true);
    expect(doc.querySelectorAll("text[data-target]").length).toBeLessThanOrEqual(60);
  });
});

describe("deltaChanged", () => {
  const withVerdict = (verdict: "degraded" | "improved" | "unchanged") => {
    const source = deltaSource({});
    return { ...source, architecture: { ...source.architecture!, verdict } };
  };
  it.each([
    ["a unit added", deltaSource({ items: [item("ADDED", "a")] }), true],
    ["a unit removed", deltaSource({ items: [item("REMOVED", "a")] }), true],
    ["a unit renamed", deltaSource({ items: [item("RENAMED", "b", { previousKey: "a" })] }), true],
    ["a role changed", deltaSource({ items: [item("CHANGED", "a", { role: { before: "test", after: "library" } })] }), true],
    ["a unit edge added", deltaSource({ edges: [edge("ADDED", "a", "b")] }), true],
    ["a unit edge removed", deltaSource({ edges: [edge("REMOVED", "a", "b")] }), true],
    ["a cycle", deltaSource({ cycles: [{ status: "REMOVED", members: ["a", "b"] }] }), true],
    ["a rules-only change", withVerdict("degraded"), true],
    ["file counts only", deltaSource({ items: [item("CHANGED", "a", { role: { before: "library", after: "library" } })] }), false],
    ["file-pair counts only", deltaSource({ edges: [edge("CHANGED", "a", "b")] }), false],
    ["nothing", withVerdict("unchanged"), false],
  ] as const)("%s -> %s", (_name, source, expected) => {
    expect(deltaChanged(source)).toBe(expected);
  });

  it("says how many units and edges only changed size", () => {
    const source = deltaSource({ items: [item("CHANGED", "a")], edges: [edge("CHANGED", "a", "b")] });
    expect(deltaUnchangedLine({ ...source, baseRef: "main", headRef: "feature" })).toBe(
      "No architecture change between main and feature (1 unit, 1 unit edge compared; 1 unit and 1 unit edge only changed size (file or file-pair counts)): no diagram written.");
  });
});
