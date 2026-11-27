import { describe, expect, it } from "vitest";
import { buildDeltaModel, deltaMeta, layoutDelta, MAX_DELTA_EDGES, MAX_DELTA_LEDGER, MAX_DELTA_UNITS } from "@/analyzer/diagram/architectureDelta";
import { deltaSource, edge, item, rule } from "./deltaFixtures";

const nodeOf = (model: ReturnType<typeof buildDeltaModel>, id: string) => model.nodes.find((node) => node.id === id)!;
const COMMAND = "graph-it review-pr --base main --head feature --format json";

describe("buildDeltaModel statuses", () => {
  it("derives ADDED, REMOVED, CHANGED, RENAMED, REWIRED and context units", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("ADDED", "billing"), item("REMOVED", "legacy"), item("CHANGED", "api", { role: { before: "lib", after: "app" } }), item("RENAMED", "web", { previousKey: "ui" })],
      edges: [edge("ADDED", "api", "core"), edge("REMOVED", "api", "db"), edge("CHANGED", "web", "api"), edge("CHANGED", "ctx1", "ctx2")],
    }));
    const status = Object.fromEntries(model.nodes.map((node) => [node.id, node.status]));
    expect(status).toEqual({ api: "CHANGED", billing: "ADDED", ctx1: "UNCHANGED", ctx2: "UNCHANGED", core: "REWIRED", db: "REWIRED", "-legacy": "REMOVED", web: "RENAMED" });
    expect(nodeOf(model, "web").label).toBe("web (was ui)");
    expect(deltaMeta(nodeOf(model, "api"))).toBe("CHANGED · files 3 -> 4 · role lib -> app");
    expect(deltaMeta(nodeOf(model, "ctx1"))).toBe("context");
    expect(deltaMeta(nodeOf(model, "core"))).toBe("REWIRED · connections changed");
    expect(model.counts).toMatch(/^units 4 -> 4: 1 added, 1 removed, 1 changed, 1 renamed, 2 rewired /);
  });

  it("writes one ledger row per target and change, each starting with the status word", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("ADDED", "billing"), item("RENAMED", "web", { previousKey: "ui" })],
      edges: [edge("ADDED", "billing", "web"), edge("CHANGED", "web", "api")],
      cycles: [{ status: "ADDED", members: ["api", "billing"] }],
    }));
    const keys = model.ledger.map((row) => `${row.target}|${row.change}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(model.ledger.map((row) => row.text)).toEqual(expect.arrayContaining([
      "ADDED unit billing (files 3)", "RENAMED unit web (was ui, files 3 -> 4)", "CHANGED edge web -> api (2 -> 5 file pairs)", "ADDED edge billing -> web (2 file pairs)", "ADDED cycle api, billing",
    ]));
  });

  it("keeps a REMOVED unit and a head unit of the same key apart (collision)", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("REMOVED", "a"), item("ADDED", "a")],
      edges: [edge("REMOVED", "a", "x", { gone: ["from"] }), edge("ADDED", "y", "a")],
    }));
    expect(model.nodes.map((node) => node.id).toSorted()).toEqual(["-a", "a", "x", "y"]);
    expect(model.edges.map((e) => `${e.status} ${e.from}->${e.to}`).toSorted()).toEqual(["ADDED y->a", "REMOVED -a->x"]);
    const rows = model.ledger.map((row) => row.text);
    expect(rows).toContain("REMOVED edge a -> x (2 file pairs)");
    expect(new Set(model.ledger.map((row) => `${row.target}|${row.change}`)).size).toBe(model.ledger.length);
  });

  it("marks a gone end of a REMOVED cycle with the removed id and flags unchanged edges", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("REMOVED", "a"), item("ADDED", "a")],
      cycles: [{ status: "REMOVED", members: ["a", "b"], gone: ["a"] }, { status: "ADDED", members: ["a", "c"] }],
    }));
    expect(nodeOf(model, "-a").inCycle).toBe("REMOVED");
    expect(nodeOf(model, "a").inCycle).toBe("ADDED");
    expect(deltaMeta(nodeOf(model, "-a"))).toContain("in resolved cycle · unchanged edges not drawn");
    expect(deltaMeta(nodeOf(model, "b"))).toContain("in resolved cycle");
  });

  it("does not hide cycle edges that are all drawn", () => {
    const model = buildDeltaModel(deltaSource({
      edges: [edge("ADDED", "a", "b"), edge("ADDED", "b", "a")],
      cycles: [{ status: "ADDED", members: ["a", "b"] }],
    }));
    expect(deltaMeta(nodeOf(model, "a"))).toBe("REWIRED · connections changed · in new cycle");
  });
});

describe("buildDeltaModel violations", () => {
  it("marks new, accepted and resolved violations on edges and nodes", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("ADDED", "ui")],
      edges: [edge("ADDED", "ui", "db"), edge("CHANGED", "app", "core")],
      rules: [rule("no-ui-db", { new: [["ui", "db"], ["ui", "db"]] }), rule("soft", { new: [["app", "core", true]] }), rule("old", { resolved: [["x", "y"]] })],
    }));
    expect(model.edges.find((e) => e.from === "ui")).toMatchObject({ violation: "new", rules: ["no-ui-db"] });
    expect(model.edges.find((e) => e.from === "app")).toMatchObject({ violation: "accepted" });
    expect(nodeOf(model, "ui").violations.new).toBe(2);
    expect(model.ledger.map((row) => row.text)).toEqual(expect.arrayContaining([
      "NEW violation no-ui-db: ui -> db (2 file pairs)", "ACCEPTED violation soft: app -> core (1 file pair)",
    ]));
    expect(model.counts).toContain("violations (file pairs): 2 new, 1 accepted");
  });

  it("lists a violation whose end is not a unit without drawing a node for it", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("ADDED", "ui")],
      rules: [rule("r", { new: [["(no element)", "ui, db"]] })],
    }));
    expect(model.nodes.map((node) => node.id)).toEqual(["ui"]);
    expect(model.ledger.find((row) => row.change === "new")!.text).toContain("ends are not single units: not drawn");
  });

  it("maps a resolved violation end of a renamed and of a removed unit to the drawn ids", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("RENAMED", "web", { previousKey: "ui" }), item("REMOVED", "legacy")],
      edges: [edge("REMOVED", "legacy", "web", { gone: ["from"] })],
      rules: [rule("r", { resolved: [["legacy", "ui"]] })],
    }));
    expect(nodeOf(model, "web").violations.resolved).toBe(1);
    expect(nodeOf(model, "-legacy").violations.resolved).toBe(1);
    expect(model.edges[0]).toMatchObject({ violation: "resolved", rules: ["r"] });
    expect(model.ledger.find((row) => row.change === "resolved")!.text).toBe("RESOLVED violation r: legacy -> ui (1 file pair)");
  });

  it.each([
    ["packages/app-store/make-v2", "packages/app-store/make", "packages/app-store/make-v2 (was make)"],
    ["web", "ui", "web (was ui)"],
    ["apps/web", "packages/web", "apps/web (was packages/web)"],
    ["a/b", "a/b/c", "a/b (was b/c)"],
  ])("labels a rename %s from %s without the shared folder", (key, previousKey, label) => {
    const model = buildDeltaModel(deltaSource({ items: [item("RENAMED", key, { previousKey })] }));
    expect(model.nodes[0].label).toBe(label);
  });

  it("draws a violation end the unit diff does not name as a context unit", () => {
    const model = buildDeltaModel(deltaSource({
      items: [item("ADDED", "ui")],
      rules: [rule("r", { new: [["ui", "db"]] })],
    }));
    expect(model.nodes.map((node) => [node.id, node.status])).toEqual([["db", "UNCHANGED"], ["ui", "ADDED"]]);
    expect(model.ledger.find((row) => row.change === "new")!.text).not.toContain("not drawn");
  });

  it("draws the ends of a rules-only change as context units, never empty panels", () => {
    const model = buildDeltaModel(deltaSource({ verdict: "unchanged", rules: [rule("new-rule", { new: [["a", "b"]] })] }));
    expect(model.nodes.map((node) => [node.id, node.status, node.violations.new])).toEqual([["a", "UNCHANGED", 1], ["b", "UNCHANGED", 1]]);
    expect(model.ledger.map((row) => row.text)).toEqual(["NEW violation new-rule: a -> b (1 file pair)"]);
  });

  it.each([
    ["ADDED", { after: "library" }, "role library"],
    ["REMOVED", { before: "test" }, "role test"],
    ["CHANGED", { before: "test", after: "library" }, "role test -> library"],
  ] as const)("writes the role of a %s unit without an arrow from or to nothing", (status, role, expected) => {
    const model = buildDeltaModel(deltaSource({ items: [item(status, "u", { role })] }));
    expect(deltaMeta(model.nodes[0])).toContain(expected);
    expect(deltaMeta(model.nodes[0])).not.toContain("none");
  });

  it("throws when the review holds no structure", () => {
    expect(() => buildDeltaModel({ baseRef: "a", headRef: "b", limitations: [] })).toThrow(/No structure diff/);
  });
});

describe("buildDeltaModel caps and cut notes", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => item("ADDED", `u${String(index).padStart(3, "0")}`));

  it("draws at most MAX_DELTA_UNITS units, violation ends then cycle members first within a tier, and names the command", () => {
    const model = buildDeltaModel(deltaSource({
      items: [...many(MAX_DELTA_UNITS + 10), item("CHANGED", "zzz")],
      cycles: [{ status: "ADDED", members: ["u049", "zzz"] }],
      rules: [rule("r", { new: [["u048", "u047"]] })],
      unchangedEdges: 7, movedFiles: 2,
    }));
    const ids = model.nodes.map((node) => node.id);
    expect(ids).toHaveLength(MAX_DELTA_UNITS);
    expect(ids).toEqual(expect.arrayContaining(["u049", "zzz", "u048", "u047"]));
    expect(model.cut).toContain(`11 changed units not drawn (11 added): ${COMMAND}`);
    expect(model.cut).toContain(`2 files moved between units: not drawn: ${COMMAND}`);
    expect(model.cut).toContain("7 unchanged unit edges not drawn");
  });

  it("caps the ledger at MAX_DELTA_LEDGER and says how many rows are cut", () => {
    const model = buildDeltaModel(deltaSource({ items: many(MAX_DELTA_UNITS) , edges: Array.from({ length: 50 }, (_, index) => edge("ADDED", `u${String(index % 40).padStart(3, "0")}`, `u${String((index + 1) % 40).padStart(3, "0")}`)) }));
    expect(model.ledger).toHaveLength(MAX_DELTA_LEDGER);
    expect(model.cut.some((line) => /^\d+ ledger rows? not drawn: graph-it review-pr/.test(line))).toBe(true);
  });

  it("counts edges and violations left out", () => {
    const model = buildDeltaModel(deltaSource({
      items: many(MAX_DELTA_UNITS + 1),
      edges: many(MAX_DELTA_UNITS + 1).map((unit, index) => edge("ADDED", unit.key, `u${String((index + 1) % (MAX_DELTA_UNITS + 1)).padStart(3, "0")}`)),
      cycles: [{ status: "ADDED", members: many(MAX_DELTA_UNITS + 1).map((unit) => unit.key) }],
    }));
    expect(model.cut).toContain(`2 edges, 1 cycles not drawn: ${COMMAND}`);
  });

  it("draws content changes before removals, even when a cycle holds every removed unit (cal.com)", () => {
    const removed = Array.from({ length: MAX_DELTA_UNITS }, (_, index) => item("REMOVED", `r${String(index).padStart(3, "0")}`));
    const kept = [item("ADDED", "added"), item("RENAMED", "renamed", { previousKey: "old" }), item("CHANGED", "changed", { role: { before: "test", after: "library" } })];
    const model = buildDeltaModel(deltaSource({
      items: [...removed, ...kept],
      edges: [edge("REMOVED", "r000", "hub", { gone: ["from"] })],
      cycles: [{ status: "REMOVED", members: removed.map((unit) => unit.key), gone: removed.map((unit) => unit.key) }],
    }));
    const statuses = model.nodes.map((node) => node.status);
    expect(model.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["added", "renamed", "changed"]));
    expect(statuses.filter((status) => status === "REMOVED")).toHaveLength(MAX_DELTA_UNITS - kept.length);
    expect(model.nodes.find((node) => node.id === "hub")).toBeUndefined();
    expect(model.cut[0]).toBe(`4 changed units not drawn (3 removed, 1 rewired): ${COMMAND}`);
  });

  it("draws at most MAX_DELTA_EDGES edges, the heaviest, and counts the rest", () => {
    const units = many(20);
    const edges = units.flatMap((from, index) => units.slice(index + 1).map((to) => edge("ADDED", from.key, to.key, { pairs: { after: index + 1 } })));
    expect(edges.length).toBeGreaterThan(MAX_DELTA_EDGES);
    const model = buildDeltaModel(deltaSource({ items: units, edges }));
    expect(model.edges).toHaveLength(MAX_DELTA_EDGES);
    const lightest = Math.min(...model.edges.map((drawn) => drawn.pairs.after ?? 0));
    expect(edges.filter((candidate) => (candidate.pairs.after ?? 0) > lightest).every((heavy) => model.edges.some((drawn) => drawn.from === heavy.from && drawn.to === heavy.to))).toBe(true);
    expect(model.cut).toContain(`${edges.length - MAX_DELTA_EDGES} edges not drawn: ${COMMAND}`);
  });

  it("says unchanged edges are not drawn even under the cap, and no moved-files line without any", () => {
    const model = buildDeltaModel(deltaSource({ items: [item("ADDED", "a")], unchangedEdges: 1 }));
    expect(model.cut).toEqual(["1 unchanged unit edge not drawn"]);
  });

  it("carries the structure warnings", () => {
    expect(buildDeltaModel(deltaSource({ items: [item("ADDED", "a")], warnings: ["w"] })).warnings).toEqual(["w"]);
  });
});

describe("layoutDelta", () => {
  it("is deterministic and survives corrupt input (empty items, an edge end absent from items)", async () => {
    const source = deltaSource({ edges: [edge("ADDED", "ghost", "other")] });
    const first = await layoutDelta(buildDeltaModel(source));
    const second = await layoutDelta(buildDeltaModel(source));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.nodes.map((node) => node.id)).toEqual(["ghost", "other"]);
  });

  it("lays out empty edges and a RENAMED-only diff", async () => {
    const layout = await layoutDelta(buildDeltaModel(deltaSource({ items: [item("RENAMED", "web", { previousKey: "ui" })] })));
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].text).toBe("web (was ui)");
    expect(layout.edges).toEqual([]);
  });
});
