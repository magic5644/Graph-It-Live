import { describe, expect, it } from "vitest";
import { buildDeltaModel, deltaMeta, LEDGER_CELLS, layoutDelta, MAX_DELTA_EDGES, MAX_DELTA_LEDGER, MAX_DELTA_UNITS, MIN_FOLD } from "@/analyzer/diagram/architectureDelta";
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
    expect(model.cut).toContain("7 unchanged unit edges not drawn: the review passed no head snapshot");
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
    expect(model.cut).toEqual(["1 unchanged unit edge not drawn: the review passed no head snapshot"]);
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

const siblings = (status: "ADDED" | "REMOVED" | "CHANGED" | "RENAMED", parent: string, count: number) =>
  Array.from({ length: count }, (_, index) => item(status, `${parent}/p${index}`, status === "RENAMED" ? { previousKey: `${parent}/old${index}` } : {}));
const UNITS = "graph-it architecture --level units --format json";

describe("buildDeltaModel folds (#843)", () => {
  it("draws MIN_FOLD removed siblings as one node: summed files, one merged edge per other end, one ledger row", () => {
    const members = siblings("REMOVED", "packages/app-store", MIN_FOLD);
    const model = buildDeltaModel(deltaSource({
      items: members,
      edges: [...members.map((member) => edge("REMOVED", member.key, "core", { gone: ["from"] })), edge("REMOVED", "packages/app-store/p0", "packages/app-store/p1", { gone: ["from", "to"] })],
    }));
    const fold = nodeOf(model, "REMOVED:packages/app-store/*");
    expect(model.nodes.map((node) => node.id).toSorted()).toEqual(["REMOVED:packages/app-store/*", "core"]);
    expect(fold).toMatchObject({ key: "packages/app-store/*", status: "REMOVED", fileCount: { before: 12 }, fold: ["packages/app-store/p0", "packages/app-store/p1", "packages/app-store/p2", "packages/app-store/p3"], foldEdges: 1 });
    expect(deltaMeta(fold)).toBe("REMOVED · 4 units · files 12");
    expect(model.edges).toEqual([expect.objectContaining({ from: "REMOVED:packages/app-store/*", to: "core", status: "REMOVED", pairs: { before: 8 } })]);
    expect(model.ledger.filter((row) => row.target === fold.id)).toEqual([{ target: fold.id, change: "REMOVED", text: "REMOVED 4 units packages/app-store/* (files 12; 1 edge inside): p0, p1, p2, p3" }]);
    expect(model.ledger.some((row) => row.text.startsWith("REMOVED edge packages/app-store/* -> core (8 file pairs)"))).toBe(true);
    // the counts stay unit counts
    expect(model.counts).toMatch(/^units 4 -> 4: 4 removed, 1 rewired/);
  });

  it("cuts a long member list at LEDGER_CELLS and names the command", () => {
    const model = buildDeltaModel(deltaSource({ items: siblings("REMOVED", "packages/app-store", 60) }));
    const text = model.ledger.find((row) => row.target === "REMOVED:packages/app-store/*")!.text;
    expect(text.length).toBeLessThanOrEqual(LEDGER_CELLS);
    expect(text).toMatch(/^REMOVED 60 units packages\/app-store\/\* \(files 180\): p0, p1, .* … and \d+ more: graph-it review-pr --base main --head feature --format json$/);
  });

  it("keeps MIN_FOLD - 1 siblings as units, and a unit with no folder", () => {
    const model = buildDeltaModel(deltaSource({ items: [...siblings("ADDED", "lib", MIN_FOLD - 1), item("ADDED", "a"), item("ADDED", "b"), item("ADDED", "c"), item("ADDED", "d")] }));
    expect(model.nodes).toHaveLength(MIN_FOLD - 1 + 4);
    expect(model.nodes.some((node) => node.fold)).toBe(false);
  });

  it.each([
    ["CHANGED", { items: siblings("CHANGED", "lib", MIN_FOLD + 2) }],
    ["REWIRED", { items: [item("ADDED", "a")], edges: Array.from({ length: MIN_FOLD + 2 }, (_, index) => edge("ADDED", "a", `lib/c${index}`)) }],
    ["UNCHANGED", { items: [item("ADDED", "a")], head: Array.from({ length: MIN_FOLD + 2 }, (_, index): [string, string] => ["a", `lib/c${index}`]) }],
  ] as const)("never folds %s siblings, however many share a folder", (status, parts) => {
    const model = buildDeltaModel(deltaSource(parts as Parameters<typeof deltaSource>[0]));
    expect(model.nodes.filter((node) => node.status === status)).toHaveLength(MIN_FOLD + 2);
    expect(model.nodes.some((node) => node.fold)).toBe(false);
  });

  it("never folds a violation end (accepted included) or a RENAMED unit, nor mixes statuses and parents", () => {
    const model = buildDeltaModel(deltaSource({
      items: [...siblings("ADDED", "lib", MIN_FOLD + 1), ...siblings("REMOVED", "lib", 3), ...siblings("RENAMED", "ren", MIN_FOLD), ...siblings("ADDED", "other", 3)],
      rules: [rule("r", { new: [["lib/p0", "core", true]] })],
    }));
    expect(model.nodes.filter((node) => node.fold).map((node) => [node.id, node.fold!.length])).toEqual([["ADDED:lib/*", MIN_FOLD]]);
    expect(nodeOf(model, "lib/p0").violations.new).toBe(1);
    expect(model.nodes.filter((node) => node.status === "RENAMED")).toHaveLength(MIN_FOLD);
  });

  it("draws a cycle that holds every folded unit on the fold: ring on the fold, no false hidden-edges note (cal.com)", () => {
    const members = siblings("REMOVED", "pkg", MIN_FOLD);
    const model = buildDeltaModel(deltaSource({ items: members, cycles: [{ status: "REMOVED", members: members.map((member) => member.key), gone: members.map((member) => member.key) }] }));
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]).toMatchObject({ id: "REMOVED:pkg/*", inCycle: "REMOVED" });
    expect(model.nodes[0].cycleEdgesHidden).toBeUndefined();
    expect(model.ledger.some((row) => row.text.startsWith("REMOVED cycle pkg/p0"))).toBe(true);
  });

  it("folds 100,000 units of one folder in linear work: one box, one bounded ledger row (a quadratic fold hits the test timeout)", () => {
    const model = buildDeltaModel(deltaSource({ items: siblings("ADDED", "huge", 100_000) }));
    expect(model.nodes).toHaveLength(1);
    expect(model.ledger[0].text.length).toBeLessThanOrEqual(LEDGER_CELLS);
    expect(model.ledger[0].text).toContain("more: graph-it review-pr");
  });

  it("keeps one ledger row per cycle when two cycles fold onto the same box", () => {
    const members = siblings("REMOVED", "pkg", MIN_FOLD).map((member) => member.key);
    const ring = (keys: string[]) => ({ status: "REMOVED" as const, members: keys, gone: keys });
    const model = buildDeltaModel(deltaSource({ items: siblings("REMOVED", "pkg", MIN_FOLD), cycles: [ring(members.slice(0, 2)), ring(members.slice(2))] }));
    expect(model.ledger.filter((row) => row.text.startsWith("REMOVED cycle"))).toHaveLength(2);
  });

  it("folds by immediate parent: a/* and a/b/* are two folds, each unit once", () => {
    const model = buildDeltaModel(deltaSource({ items: [...siblings("ADDED", "a", MIN_FOLD), ...siblings("ADDED", "a/b", MIN_FOLD)] }));
    expect(model.nodes.map((node) => node.id)).toEqual(["ADDED:a/*", "ADDED:a/b/*"]);
  });

  it("draws a fold whose only edges reach units that are not drawn, and counts those edges in the cut", () => {
    const added = Array.from({ length: MAX_DELTA_UNITS - 1 }, (_, index) => item("ADDED", `a${String(index).padStart(2, "0")}`));
    const members = siblings("REMOVED", "x", MIN_FOLD);
    // `t` is context (tier 3): the 39 ADDED units and the fold fill the 40 slots first.
    const model = buildDeltaModel(deltaSource({ items: [...added, ...members], edges: members.map((member) => edge("REMOVED", member.key, "t", { gone: ["from"] })) }));
    expect(model.nodes.map((node) => node.id)).toContain("REMOVED:x/*");
    expect(model.nodes.map((node) => node.id)).not.toContain("t");
    expect(model.edges).toEqual([]);
    expect(model.cut).toContain(`1 edges not drawn: ${COMMAND}`);
  });

  it("counts a dropped fold as its members in the cut line", () => {
    const added = Array.from({ length: MAX_DELTA_UNITS }, (_, index) => item("ADDED", `a${String(index).padStart(2, "0")}`));
    const model = buildDeltaModel(deltaSource({ items: [...added, ...siblings("REMOVED", "x", MIN_FOLD)] }));
    expect(model.nodes.map((node) => node.id)).not.toContain("REMOVED:x/*");
    expect(model.cut).toContain(`${MIN_FOLD} changed units not drawn (${MIN_FOLD} removed): ${COMMAND}`);
  });

  it("keeps a REMOVED fold and an ADDED fold of the same keys apart, and folds every unit of the level into one box", () => {
    const model = buildDeltaModel(deltaSource({
      items: [...siblings("REMOVED", "x", MIN_FOLD), ...siblings("ADDED", "x", MIN_FOLD)],
      edges: [edge("REMOVED", "x/p0", "y", { gone: ["from"] }), edge("ADDED", "x/p1", "y")],
    }));
    expect(model.nodes.map((node) => node.id).toSorted()).toEqual(["ADDED:x/*", "REMOVED:x/*", "y"]);
    expect(model.edges.map((candidate) => `${candidate.from}->${candidate.to}`).toSorted()).toEqual(["ADDED:x/*->y", "REMOVED:x/*->y"]);
    expect(buildDeltaModel(deltaSource({ items: siblings("ADDED", "only", 6) })).nodes.map((node) => node.id)).toEqual(["ADDED:only/*"]);
  });
});

describe("buildDeltaModel unchanged edges and context (#843)", () => {
  const withHead = (parts: Parameters<typeof deltaSource>[0], headRef = "feature") => ({ ...deltaSource(parts), headRef });

  it("draws the unchanged edges between drawn units, fills context from the head, and cuts what stays out with the command", () => {
    const model = buildDeltaModel(withHead({ items: [item("CHANGED", "a", { role: { before: "x", after: "y" } })], head: [["a", "b"], ["b", "c"]], unchangedEdges: 2 }));
    expect(model.nodes.map((node) => [node.id, node.status])).toEqual([["a", "CHANGED"], ["b", "UNCHANGED"]]);
    expect(model.edges).toEqual([{ from: "a", to: "b", status: "UNCHANGED", pairs: { before: 1, after: 1 }, rules: [] }]);
    expect(model.ledger.some((row) => row.text.includes("edge"))).toBe(false);
    expect(model.cut).toEqual([`1 unchanged unit edge to units not drawn: at feature, ${UNITS}`, `1 unchanged unit not drawn: at feature, ${UNITS}`]);
    expect(model.warnings).toEqual([]);
    expect(buildDeltaModel(withHead({ items: [item("CHANGED", "a", { role: { before: "x", after: "y" } })], head: [["a", "b"], ["b", "c"]], unchangedEdges: 2 }, "HEAD")).cut[0]).toBe(`1 unchanged unit edge to units not drawn: ${UNITS}`);
  });

  it("excludes ADDED and CHANGED diff edges from the unchanged ones; a REMOVED edge of the same key does not hide it", () => {
    const model = buildDeltaModel(withHead({
      items: [item("ADDED", "a"), item("ADDED", "b"), item("ADDED", "c")],
      edges: [edge("ADDED", "a", "b"), edge("CHANGED", "b", "c"), edge("REMOVED", "c", "a")],
      head: [["a", "b"], ["b", "c"], ["c", "a"]], unchangedEdges: 1,
    }));
    expect(model.edges.filter((candidate) => candidate.status === "UNCHANGED").map((candidate) => `${candidate.from}->${candidate.to}`)).toEqual(["c->a"]);
  });

  it("fills only the free slots, never above MAX_DELTA_UNITS, ranked by links to drawn units then pairs then key", () => {
    const items = Array.from({ length: 30 }, (_, index) => item("ADDED", `a${String(index).padStart(2, "0")}`));
    const head: [string, string, number?][] = Array.from({ length: 30 }, (_, index) => ["a00", `ctx${String(index).padStart(2, "0")}`, index === 29 ? 9 : 1]);
    head.push(["a01", "ctx05"]);
    const model = buildDeltaModel(withHead({ items, head, unchangedEdges: head.length }));
    expect(model.nodes).toHaveLength(MAX_DELTA_UNITS);
    const context = model.nodes.filter((node) => node.status === "UNCHANGED").map((node) => node.id);
    expect(context).toEqual(["ctx00", "ctx01", "ctx02", "ctx03", "ctx04", "ctx05", "ctx06", "ctx07", "ctx08", "ctx29"].toSorted());
    expect(model.cut).toContain(`20 unchanged units not drawn: at feature, ${UNITS}`);
    expect(buildDeltaModel(deltaSource({ items })).nodes).toHaveLength(30);
  });

  it("fills context after the fold: a fold counts as one unit, and its members link the context to it", () => {
    const members = siblings("ADDED", "pkg", MIN_FOLD);
    const head: [string, string][] = [["pkg/p0", "ctx"], ["pkg/p1", "ctx"]];
    const model = buildDeltaModel(withHead({ items: members, head, unchangedEdges: head.length }));
    expect(model.nodes.map((node) => node.id)).toEqual(["ADDED:pkg/*", "ctx"]);
    expect(model.edges).toEqual([{ from: "ADDED:pkg/*", to: "ctx", status: "UNCHANGED", pairs: { before: 2, after: 2 }, rules: [] }]);
  });

  it("draws the changed edges before the unchanged ones under the cap and counts the cut unchanged ones", () => {
    const keys = Array.from({ length: 10 }, (_, index) => `u${index}`);
    const combos = keys.flatMap((from) => keys.filter((to) => to !== from).map((to): [string, string] => [from, to]));
    const changed = combos.slice(0, 50);
    const unchanged = combos.slice(50, 80);
    const model = buildDeltaModel(withHead({ items: keys.map((key) => item("ADDED", key)), edges: changed.map(([from, to]) => edge("ADDED", from, to)), head: [...changed, ...unchanged], unchangedEdges: 30 }));
    expect(model.edges).toHaveLength(MAX_DELTA_EDGES);
    expect(model.edges.filter((candidate) => candidate.status === "ADDED")).toHaveLength(50);
    expect(model.cut).toContain(`20 unchanged unit edges between drawn units not drawn (cap ${MAX_DELTA_EDGES}): at feature, ${UNITS}`);
  });

  it("drops a filled context unit whose every edge the cap cut, and counts it as not drawn", () => {
    const keys = Array.from({ length: 10 }, (_, index) => `u${index}`);
    const changed = keys.flatMap((from) => keys.filter((to) => to !== from).map((to): [string, string] => [from, to])).slice(0, MAX_DELTA_EDGES);
    // `u9 -> zz` is the lightest, so the cap cuts it and the context unit `zz` it names keeps no edge.
    const parts = { items: keys.map((key) => item("ADDED", key)), edges: [...changed.map(([from, to]) => edge("ADDED", from, to)), edge("CHANGED", "u9", "zz", { pairs: { before: 1, after: 1 } })] };
    const model = buildDeltaModel(withHead({ ...parts, head: [...changed, ["u9", "zz"], ["u0", "ctx"]], unchangedEdges: 1 }));
    expect(model.nodes.map((node) => node.id)).not.toContain("ctx");
    expect(model.nodes.map((node) => node.id)).not.toContain("zz");
    expect(model.edges).toHaveLength(MAX_DELTA_EDGES);
    expect(model.cut).toContain(`1 unchanged unit edge to units not drawn: at feature, ${UNITS}`);
    expect(model.cut).toContain(`2 unchanged units not drawn: at feature, ${UNITS}`);
    // Without a head snapshot the drawing stays as before #843: the bare context box is kept.
    expect(buildDeltaModel(deltaSource(parts)).nodes.map((node) => node.id)).toContain("zz");
  });

  it("marks a violation on an unchanged edge (a rules-only change) without counting its ends twice", () => {
    const model = buildDeltaModel(withHead({ rules: [rule("no-ui-db", { new: [["ui", "db"]] })], head: [["ui", "db"]], unchangedEdges: 1 }));
    expect(model.edges).toEqual([{ from: "ui", to: "db", status: "UNCHANGED", pairs: { before: 1, after: 1 }, rules: ["no-ui-db"], violation: "new" }]);
    expect(model.nodes.map((node) => [node.id, node.violations.new])).toEqual([["db", 1], ["ui", 1]]);
  });

  it("keeps a context unit with no drawn edge when its cycle is drawn", () => {
    const model = buildDeltaModel(withHead({ items: [item("ADDED", "a")], cycles: [{ status: "ADDED", members: ["a", "b"] }], head: [], unchangedEdges: 0 }));
    expect(model.nodes.map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("counts an unchanged edge as a drawn cycle edge: no hidden-edges note", () => {
    const hidden = (head?: [string, string][]) => buildDeltaModel(withHead({ items: [item("ADDED", "a"), item("ADDED", "b")], edges: [edge("ADDED", "a", "b")], cycles: [{ status: "ADDED", members: ["a", "b"] }], ...(head ? { head, unchangedEdges: head.length } : {}) })).nodes.map((node) => node.cycleEdgesHidden);
    expect(hidden([["b", "a"]])).toEqual([undefined, undefined]);
    expect(hidden()).toEqual([true, true]);
  });

  it("warns, never drops silently, when the head map and the comparison disagree on the unchanged edge count", () => {
    const model = buildDeltaModel(withHead({ items: [item("ADDED", "a")], head: [["a", "b"]], unchangedEdges: 5 }));
    expect(model.warnings).toEqual(["The head snapshot holds 1 unchanged unit edge, the comparison 5: the unchanged edges drawn may be incomplete."]);
  });

  it("without the head map keeps every node and says why the unchanged edges are not drawn", () => {
    const model = buildDeltaModel(deltaSource({ items: [item("CHANGED", "a")], unchangedEdges: 2, edges: [edge("ADDED", "a", "b")] }));
    expect(model.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(model.cut).toEqual(["2 unchanged unit edges not drawn: the review passed no head snapshot"]);
  });
});
