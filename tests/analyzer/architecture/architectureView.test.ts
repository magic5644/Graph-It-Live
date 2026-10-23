import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { capGroups, findHiddenGroups, levelViolations, viewDependents } from "@/analyzer/architecture/architectureView";
import { DEFAULT_RENDERED_GROUPS, MAX_RENDERED_GROUPS } from "@/shared/architecture-types";

type Groups = Parameters<typeof capGroups>[0];
type Edges = Parameters<typeof capGroups>[1];

/** `count` groups, largest first, ids from `first`: what overviewArchitecture hands to the cap. */
const groupsOf = (count: number, first = 1) =>
  Array.from({ length: count }, (_, index) => ({
    id: first + index, key: `g${first + index}`, label: `g${first + index}`, fileCount: count - index, internalEdgeCount: 0,
  })) as unknown as Groups;
const edge = (from: number, to: number) => ({ from, to, fileEdgeCount: 1, fromLabel: "", toLabel: "" }) as Edges[number];

/** A graph of files with their group (communityId 0 = unassigned) and imports; the cap and dependents read nodes and edges only. */
function graphOf(files: Record<string, { group: number; imports?: string[] }>): ArchitectureGraph {
  const nodes = Object.entries(files).map(([relativePath, { group }]) => ({ relativePath, communityId: group, communityKey: `k${group}` }));
  const edges = Object.entries(files).flatMap(([source, { imports = [] }]) =>
    imports.map((target) => ({ source, target, sourceRelative: source, targetRelative: target })));
  return { nodes, edges } as unknown as ArchitectureGraph;
}

describe("capGroups", () => {
  it.each([
    [DEFAULT_RENDERED_GROUPS, 200],
    [MAX_RENDERED_GROUPS, 200],
    [DEFAULT_RENDERED_GROUPS, 30],
  ])("keeps the %i largest of %i groups and counts the others", (maxGroups, count) => {
    const capped = capGroups(groupsOf(count), [], maxGroups, () => "", false);
    const kept = Math.min(maxGroups, count);
    expect(capped.groups.map((group) => group.id)).toEqual(Array.from({ length: kept }, (_, index) => index + 1));
    expect(capped.hidden).toHaveLength(count - kept);
    expect(capped.groupsByUnit).toEqual({ "": { totalGroups: count, hiddenGroups: count - kept, hiddenGroupEdges: 0 } });
    // No edge: every kept group is drawn apart.
    expect(capped.isolatedGroups).toHaveLength(kept);
  });

  it("caps each unit apart and counts only the hidden edges inside a unit", () => {
    // Units: a holds 1..60, b holds 61..62. 1 → 2 and 1 → 60 stay in a; 60 → 61 crosses units.
    const groups = [...groupsOf(60), ...groupsOf(2, 61)];
    const unitOf = (id: number) => (id <= 60 ? "a" : "b");
    const capped = capGroups(groups, [edge(1, 2), edge(1, 60), edge(60, 61)], DEFAULT_RENDERED_GROUPS, unitOf, false);
    expect(capped.groups).toHaveLength(DEFAULT_RENDERED_GROUPS + 2);
    expect(capped.groupEdges).toEqual([edge(1, 2)]);
    expect(capped.groupsByUnit).toEqual({
      a: { totalGroups: 60, hiddenGroups: 10, hiddenGroupEdges: 1 },
      b: { totalGroups: 2, hiddenGroups: 0, hiddenGroupEdges: 0 },
    });
    expect(capped.hidden[0]).toEqual({ key: "g51", label: "g51", unit: "a" });
    expect(capped.isolatedGroups).not.toContain(1);
    expect(capped.isolatedGroups).not.toContain(2);
  });

  it("always keeps the unassigned files, drawn apart without an edge", () => {
    const capped = capGroups(groupsOf(2), [edge(1, 2)], 1, () => "", true);
    expect(capped.groups.map((group) => group.id)).toEqual([1]);
    expect(capped.isolatedGroups).toEqual([1, 0]);
    expect(capped.groupsByUnit[""]).toEqual({ totalGroups: 2, hiddenGroups: 1, hiddenGroupEdges: 1 });
  });
});

describe("findHiddenGroups", () => {
  const hidden = Array.from({ length: 12 }, (_, index) => ({ key: `apps/web/f${index}`, label: `F${index}`, unit: index < 11 ? "apps/web" : "tool" }));

  it("matches label or key, case-insensitive, and returns the first labels with the full count", () => {
    expect(findHiddenGroups(hidden, "  WEB ")).toMatchObject({ total: 12 });
    expect(findHiddenGroups(hidden, "web").matches).toHaveLength(10);
    expect(findHiddenGroups(hidden, "f1", "apps/web")).toEqual({ matches: ["F1", "F10"], total: 2 });
  });

  it("matches nothing for a blank query or another unit", () => {
    expect(findHiddenGroups(hidden, "   ")).toEqual({ matches: [], total: 0 });
    expect(findHiddenGroups(hidden, "f1", "nowhere")).toEqual({ matches: [], total: 0 });
  });
});

describe("levelViolations", () => {
  const graph = graphOf({ "a.ts": { group: 1 }, "b.ts": { group: 2 }, "c.ts": { group: 2 } });
  const violations = [
    { rule: "no-up", source: "a.ts", target: "b.ts" },
    { rule: "inside", source: "b.ts", target: "c.ts" },
    { rule: "outside", source: "a.ts", target: "gone.ts" },
  ];

  it("keys group edges by the level's group ids, and unit edges by unit key", () => {
    const unitOf = new Map([["a.ts", "web"], ["b.ts", "core"], ["c.ts", "web"]]);
    expect(levelViolations(violations, graph, unitOf)).toEqual({
      unitEdges: { "web>core": ["no-up"], "core>web": ["inside"] },
      groupEdges: { "1>2": ["no-up"] },
    });
  });

  it("has no unit edges without units", () => {
    expect(levelViolations(violations, graph).unitEdges).toEqual({});
  });
});

describe("viewDependents", () => {
  const graph = graphOf({
    "core/a.ts": { group: 1 },
    "core/b.ts": { group: 1, imports: ["core/a.ts"] },
    "app/main.ts": { group: 2, imports: ["core/b.ts"] },
    "app/other.ts": { group: 2, imports: ["app/main.ts"] },
  });

  it("totals the reached files and groups outside the seed's group", () => {
    const dependents = viewDependents(graph, graph, undefined, { kind: "file", relativePath: "core/a.ts" }, false);
    expect(dependents).toMatchObject({
      seedLabel: "core/a.ts",
      reachedFiles: 3,
      totals: { files: 2, groups: 1 },
      insideSeedGroup: { directFiles: 1, transitiveFiles: 1 },
      groups: [{ key: "k2", label: "k2", directFiles: 0, transitiveFiles: 2, minDepth: 2 }],
    });
    expect(dependents.filesOf("k2").page.total).toBe(2);
  });

  it("names an unknown group, and refuses a unit without units or an unknown seed", () => {
    expect(viewDependents(graph, graph, undefined, { kind: "group", groupId: 99 }, false)).toMatchObject({
      seedLabel: "group 99", reachedFiles: 0, totals: { files: 0, groups: 0 },
    });
    expect(() => viewDependents(graph, graph, undefined, { kind: "unit", key: "core" }, true)).toThrow("unknown dependents seed");
    expect(() => viewDependents(graph, graph, undefined, undefined, false)).toThrow("unknown dependents seed");
  });
});
