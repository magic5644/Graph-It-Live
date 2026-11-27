import { describe, expect, it } from "vitest";
import { compactOutput } from "@/shared/compactOutput";
import { encodeToonSections } from "@/shared/toonSections";
import {
  compareStructure,
  MATCH_MIN_DICE,
  matchLevel,
  RENAME_LIMIT_REASON,
  renderStructureMarkdown,
  type CompareStructureOptions,
  type RenameInfo,
  type StructureSnapshot,
} from "@/analyzer/architecture/architectureStructure";

type Level = StructureSnapshot["units"];

/** A level from `key -> files`; edges `from>to -> pairs`; `units` gives each group its owning unit. */
function level(items: Record<string, string[]>, extra: { edges?: Record<string, number>; cycles?: string[][]; units?: Record<string, string>; roles?: Record<string, string> } = {}): Level {
  return {
    items: new Map(Object.entries(items).map(([key, files]) => [key, {
      name: key, fileCount: files.length,
      ...(extra.units?.[key] === undefined ? {} : { unit: extra.units[key] }),
      ...(extra.roles?.[key] === undefined ? {} : { role: extra.roles[key] }),
    }])),
    fileItem: new Map(Object.entries(items).flatMap(([key, files]) => files.map((file): [string, string] => [file, key]))),
    edges: new Map(Object.entries(extra.edges ?? {}).map(([pair, pairs]) => [pair.replace(">", "\0"), pairs])),
    cycles: extra.cycles ?? [],
  };
}

const files = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, index) => `${prefix}/f${from + index}.ts`);
const total = (items: Record<string, string[]>) => Object.values(items).reduce((sum, list) => sum + list.length, 0);

function snapshot(units: Record<string, string[]>, groups: Record<string, string[]> = units, extra: Partial<StructureSnapshot> = {}): StructureSnapshot {
  return { configFrom: "none", files: total(units), units: level(units), groups: level(groups), ...extra };
}

const OPTIONS: CompareStructureOptions = { refs: { base: "main", head: "HEAD" }, renames: { moves: new Map(), complete: true } };
const compare = (base: StructureSnapshot, head: StructureSnapshot, options: Partial<CompareStructureOptions> = {}) => compareStructure(base, head, { ...OPTIONS, ...options });

describe("matchLevel", () => {
  const sized = (shared: number, baseSize: number, headSize: number) => ({
    base: level({ a: [...files("s", shared), ...files("b", baseSize - shared)] }),
    head: level({ a: [...files("s", shared), ...files("h", headSize - shared)] }),
  });

  it.each([
    [49, 100, 100, false],
    [50, 100, 100, true],
    [1, 2, 2, true],
    [1, 1, 3, true],
    [1, 2, 3, false],
  ])("overlap %i of %i and %i files matches: %s (threshold %s)", (shared, baseSize, headSize, matches) => {
    const { base, head } = sized(shared, baseSize, headSize);
    expect(MATCH_MIN_DICE).toBe(0.5);
    expect(matchLevel(base, head, new Map()).size).toBe(matches ? 1 : 0);
  });

  it("never matches by key alone: a same-key item with no shared file is another item", () => {
    const diff = compare(snapshot({ a: ["x.ts", "y.ts"] }), snapshot({ a: ["p.ts", "q.ts"] }));
    expect(diff.units.items).toHaveLength(2);
    expect(new Set(diff.units.items.map((item) => item.status))).toEqual(new Set(["ADDED", "REMOVED"]));
  });

  it("is independent of the order of the maps (ties: dice, overlap, same key, then keys)", () => {
    const base = { a: ["1", "2"], b: ["3", "4"] };
    const head = { x: ["1", "3"], y: ["2", "4"] };
    const shuffled = (input: Record<string, string[]>) => Object.fromEntries(Object.entries(input).reverse());
    const first = matchLevel(level(base), level(head), new Map());
    const second = matchLevel(level(shuffled(base)), level(shuffled(head)), new Map());
    expect([...first].sort()).toEqual([...second].sort());
    // Both candidates tie everywhere: the smallest base key then head key wins.
    expect([...first].sort()).toEqual([["a", "x"], ["b", "y"]]);
  });

  it("prefers the same key on a tie", () => {
    const pairs = matchLevel(level({ a: ["1", "2"], b: ["3", "4"] }), level({ a: ["1", "3"], b: ["2", "4"] }), new Map());
    expect([...pairs].sort()).toEqual([["a", "a"], ["b", "b"]]);
  });

  it("maps base files through the renames", () => {
    const base = level({ old: ["o1.ts", "o2.ts"] });
    const head = level({ fresh: ["n1.ts", "n2.ts"] });
    expect(matchLevel(base, head, new Map()).size).toBe(0);
    expect(matchLevel(base, head, new Map([["o1.ts", "n1.ts"], ["o2.ts", "n2.ts"]]))).toEqual(new Map([["old", "fresh"]]));
  });
});

describe("compareStructure", () => {
  it("reports unchanged with the compared sizes, and lists nothing", () => {
    const state = { a: files("a", 3), b: files("b", 2) };
    const diff = compare(snapshot(state), snapshot(state));
    expect(diff.verdict).toBe("unchanged");
    expect(diff.units).toMatchObject({ items: [], edges: [], cycles: [], movedFiles: [], compared: { items: { before: 2, after: 2 }, unchangedItems: 2 } });
    expect(diff.files).toEqual({ before: 5, after: 5 });
    expect(diff.warnings).toEqual([]);
  });

  it("reports empty when neither side has a file", () => {
    const diff = compare(snapshot({}), snapshot({}));
    expect(diff).toMatchObject({ verdict: "empty", files: { before: 0, after: 0 } });
    expect(diff.warnings).toEqual([]);
  });

  it("warns when one side has no analyzable file, naming the side", () => {
    const some = snapshot({ a: files("a", 2) });
    expect(compare(snapshot({}), some).warnings).toContain("No analyzable file at main: every unit and group reads as added.");
    expect(compare(some, snapshot({})).warnings).toContain("No analyzable file at HEAD: every unit and group reads as removed.");
    expect(compare(snapshot({}), some).units.items.map((item) => item.status)).toEqual(["ADDED"]);
  });

  it("renames an item and adds no edge noise", () => {
    const base = snapshot({ a: files("a", 4), c: files("c", 2) }, undefined, {});
    base.units.edges.set("c\0a", 3);
    const head = snapshot({ b: files("b", 4), c: files("c", 2) });
    head.units.edges.set("c\0b", 3);
    const diff = compare(base, head, { renames: { moves: new Map(files("a", 4).map((file, index) => [file, files("b", 4)[index]])), complete: true } });
    expect(diff.units.items).toEqual([expect.objectContaining({ status: "RENAMED", key: "b", previousKey: "a" })]);
    expect(diff.units.edges).toEqual([]);
    expect(diff.units.movedFiles).toEqual([]);
    expect(diff.units.compared.unchangedEdges).toBe(1);
  });

  it("splits at dice 0.6: the best half is renamed, the other is added, its files moved", () => {
    const base = snapshot({ A: files("a", 5) });
    const head = snapshot({ A1: [...files("a", 3), ...files("n", 2)], A2: files("a", 2, 3) });
    const diff = compare(base, head);
    expect(diff.units.items.map(({ status, key, previousKey }) => ({ status, key, previousKey }))).toEqual([
      { status: "RENAMED", key: "A1", previousKey: "A" },
      { status: "ADDED", key: "A2", previousKey: undefined },
    ]);
    expect(diff.units.movedFiles).toEqual([{ file: "a/f3.ts", from: "A", to: "A2" }, { file: "a/f4.ts", from: "A", to: "A2" }]);
  });

  it("merges at dice 0.4: the merged item is removed, the target changed, its files moved", () => {
    const base = snapshot({ B: files("b", 5), C: files("c", 15) });
    const head = snapshot({ C: [...files("c", 15), ...files("b", 5)] });
    const diff = compare(base, head);
    expect(diff.units.items.map(({ status, key }) => [status, key])).toEqual([["REMOVED", "B"], ["CHANGED", "C"]]);
    expect(diff.units.movedFiles).toHaveLength(5);
    expect(diff.units.movedFiles[0]).toEqual({ file: "b/f0.ts", from: "B", to: "C" });
  });

  it("sees a group move to another unit, and keeps the match through a renamed unit", () => {
    const base = snapshot({ u: files("g", 4), v: files("h", 2) }, { g: files("g", 4), h: files("h", 2) });
    base.groups = level({ g: files("g", 4), h: files("h", 2) }, { units: { g: "u", h: "v" } });
    const head = snapshot({ u: files("g", 4), v: files("h", 2) });
    head.groups = level({ g: files("g", 4), h: files("h", 2) }, { units: { g: "v", h: "v" } });
    const diff = compare(base, head);
    expect(diff.units.items).toEqual([]);
    expect(diff.groups.items).toEqual([expect.objectContaining({ status: "CHANGED", key: "g", previousKey: "g", unit: "v", previousUnit: "u" })]);
    // The PR comment says why the group changed: it moved to another unit.
    expect(renderStructureMarkdown(diff, (value) => value)).toContain("- g (4 files, unit u -> v)");
    // A unit renamed with all its files does not move its groups.
    const renamed = snapshot({ w: files("g", 4), v: files("h", 2) });
    renamed.groups = level({ g: files("g", 4), h: files("h", 2) }, { units: { g: "w", h: "v" } });
    const same = compare(base, renamed);
    expect(same.units.items).toEqual([expect.objectContaining({ status: "RENAMED", key: "w", previousKey: "u" })]);
    expect(same.groups.items).toEqual([]);
  });

  it("changes an item on file count or role, and an edge on its pair count", () => {
    const base = snapshot({ a: files("a", 2), b: files("b", 2) });
    base.units = level({ a: files("a", 2), b: files("b", 2) }, { edges: { "a>b": 2, "b>a": 1 }, roles: { a: "library", b: "library" } });
    const head = snapshot({ a: [...files("a", 2), "a/new.ts"], b: files("b", 2) });
    head.units = level({ a: [...files("a", 2), "a/new.ts"], b: files("b", 2) }, { edges: { "a>b": 5 }, roles: { a: "service", b: "library" } });
    const diff = compare(base, head);
    expect(diff.units.items).toEqual([expect.objectContaining({ status: "CHANGED", key: "a", fileCount: { before: 2, after: 3 }, role: { before: "library", after: "service" } })]);
    expect(diff.units.edges).toEqual([
      { status: "CHANGED", from: "a", to: "b", pairs: { before: 2, after: 5 } },
      { status: "REMOVED", from: "b", to: "a", pairs: { before: 1 } },
    ]);
  });

  it("lists cycles that appear and cycles that are resolved, by their members in the head key space", () => {
    const state = { a: files("a", 2), b: files("b", 2), c: files("c", 2) };
    const base = snapshot(state);
    base.units = level(state, { cycles: [["a", "b"]] });
    const head = snapshot(state);
    head.units = level(state, { cycles: [["c", "b"]] });
    const diff = compare(base, head);
    expect(diff.units.cycles).toEqual([{ status: "REMOVED", members: ["a", "b"] }, { status: "ADDED", members: ["b", "c"] }]);
    expect(diff.verdict).toBe("changed");
    expect(compare(base, base).units.cycles).toEqual([]);
  });

  it("is deterministic whatever the order of the input maps", () => {
    const state = (reverse: boolean) => {
      const entries = Object.entries({ a: files("a", 3), b: files("b", 3), c: files("c", 3) });
      return Object.fromEntries(reverse ? entries.reverse() : entries);
    };
    const head = { x: [...files("a", 2), ...files("b", 1)], y: [...files("b", 2, 1), ...files("c", 3)], z: files("a", 1, 2) };
    const first = compare(snapshot(state(false)), snapshot(head));
    const second = compare(snapshot(state(true)), snapshot(Object.fromEntries(Object.entries(head).reverse())));
    expect(second).toEqual(first);
  });

  it("moves files by raw base path, and maps case-only renames like any rename", () => {
    const base = snapshot({ only: ["src/Foo.ts"] });
    const head = snapshot({ only: ["src/foo.ts"] });
    expect(compare(base, head).units.items.map((item) => item.status).sort()).toEqual(["ADDED", "REMOVED"]);
    const mapped = compare(base, head, { renames: { moves: new Map([["src/Foo.ts", "src/foo.ts"]]), complete: true } });
    expect(mapped).toMatchObject({ verdict: "unchanged", renames: { mapped: 1, complete: true } });
  });

  describe("warnings", () => {
    const base = snapshot({ a: files("a", 2) }, undefined, { configFrom: "own", definition: { elements: { a: { path: "a/" }, gone: { path: "g/" }, edited: { path: "e/" } }, roles: {} } });
    const sameFiles = { a: files("a", 2) };

    it.each([
      ["head none", { configFrom: "none" as const }, "head has no graphit.architecture.json: detected projects"],
      ["elements", { configFrom: "own" as const, definition: { elements: { a: { path: "a/" }, edited: { path: "x/" }, fresh: { path: "f/" } }, roles: { a: "library" } } }, "elements added: fresh; elements removed: gone; elements changed: edited; roles changed"],
    ])("explains a definition difference: %s", (_name, extra, detail) => {
      const head = snapshot(sameFiles, undefined, extra);
      expect(compare(base, head).warnings).toEqual([`Units differ in definition between base and head (${detail}): units are matched by file overlap, not by name.`]);
    });

    it("explains a base built from the head config, missing or invalid", () => {
      const head = snapshot(sameFiles, undefined, { configFrom: "own", definition: { elements: {}, roles: {} } });
      const missing = snapshot(sameFiles, undefined, { configFrom: "head" });
      expect(compare(missing, head).warnings[0]).toContain("(base has no graphit.architecture.json: built with the head's)");
      const invalid = snapshot(sameFiles, undefined, { configFrom: "head", configError: "$: not valid JSON" });
      expect(compare(invalid, head).warnings[0]).toContain("(base graphit.architecture.json is invalid ($: not valid JSON): built with the head's)");
      expect(compare(invalid, snapshot(sameFiles)).warnings[0]).toContain("invalid ($: not valid JSON): detected projects");
    });

    it("says nothing about the definition when neither side has a config, or both define the same", () => {
      expect(compare(snapshot(sameFiles), snapshot(sameFiles)).warnings).toEqual([]);
      expect(compare(base, snapshot(sameFiles, undefined, { configFrom: "own", definition: base.definition })).warnings).toEqual([]);
    });

    it.each<[string, RenameInfo | undefined, string]>([
      ["stopped", { moves: new Map(), complete: false, reason: RENAME_LIMIT_REASON }, "Git rename detection stopped at diff.renameLimit: files Git did not pair count as removed + added."],
      ["failed", { moves: new Map(), complete: false, reason: "git exploded" }, "Git rename detection failed (git exploded): files Git did not pair count as removed + added."],
      ["unavailable", undefined, "Git rename detection is unavailable: files Git did not pair count as removed + added."],
    ])("flags incomplete rename detection: %s", (_name, renames, warning) => {
      const diff = compare(snapshot(sameFiles), snapshot(sameFiles), { renames });
      expect(diff.warnings).toEqual([warning]);
      expect(diff.renames).toEqual({ mapped: 0, complete: false });
    });

    it("warns about moves Git cannot see only when a level has both a removed and an added item", () => {
      const moved = compare(snapshot({ a: ["a/1.ts", "a/2.ts", "a/3.ts"], b: ["b/1.ts"] }), snapshot({ a: ["a/1.ts", "a/2.ts"], b: ["b/1.ts", "b/3.ts"] }));
      expect(moved.verdict).toBe("changed");
      expect(moved.warnings).toEqual([]);
      const renamed = compare(snapshot({ a: ["a/1.ts", "a/2.ts"], b: ["b/1.ts"] }), snapshot({ c: ["c/1.ts", "c/2.ts"], b: ["b/1.ts"] }));
      expect(renamed.warnings).toEqual(["Renames and moved files cover only what Git detects (git diff -M, 50 % similarity): a file moved and heavily edited counts as removed + added."]);
      const tree = compare(snapshot({ a: ["a/1.ts", "a/2.ts"], b: ["b/1.ts"] }), snapshot({ c: ["c/1.ts", "c/2.ts"], b: ["b/1.ts"] }), { workingTree: true });
      expect(tree.warnings[0]).toContain("(git diff -M, 50 % similarity); untracked working-tree files count as added:");
    });
  });
});

describe("renderStructureMarkdown", () => {
  const safe = (value: string) => value.replaceAll(/[\r\n|<>]/g, " ").replaceAll("`", "'").trim();

  it("renders nothing when unchanged without warning", () => {
    const state = { a: files("a", 2) };
    expect(renderStructureMarkdown(compare(snapshot(state), snapshot(state)), safe)).toEqual([]);
  });

  it("renders only the warnings of an unchanged structure", () => {
    const state = { a: files("a", 2) };
    const lines = renderStructureMarkdown(compare(snapshot(state), snapshot(state), { renames: undefined }), safe);
    expect(lines).toContain("### Architecture structure: UNCHANGED");
    expect(lines.some((line) => line.startsWith("- warning: Git rename detection is unavailable"))).toBe(true);
    expect(lines.some((line) => line.startsWith("####"))).toBe(false);
  });

  it("caps every list at 20 lines then `… N more`, with at least 50 units and 50 groups", () => {
    const base = snapshot({});
    const head = snapshot(Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`unit${String(index).padStart(2, "0")}`, [`u${index}/a.ts`]])));
    const lines = renderStructureMarkdown(compare(base, head), safe);
    const added = lines.slice(lines.indexOf("#### Units added") + 1);
    expect(added.slice(0, 20).every((line) => line.startsWith("- unit"))).toBe(true);
    expect(added[20]).toBe("- … 35 more");
    expect(lines).toContain("#### Groups added");
    expect(lines.filter((line) => line === "- … 35 more")).toHaveLength(2);
  });

  it("sanitizes keys: pipe, newline, backtick, and carriage return never reach the report", () => {
    const hostile = "evil|key\n`tick`\r<b>";
    const diff = compare(snapshot({}), snapshot({ [hostile]: ["x/a.ts"] }));
    const text = renderStructureMarkdown(diff, safe).join("\n");
    expect(text).toContain("- evil key 'tick'  b (1 files)");
    expect(text).not.toMatch(/evil\|key/);
    expect(text).not.toContain("`tick`");
  });

  it("renders every section: renamed, moved files, edges, cycles", () => {
    const base = snapshot({ a: files("a", 4), c: files("c", 2) });
    base.units = level({ a: files("a", 4), c: files("c", 2) }, { edges: { "c>a": 1 }, cycles: [["a", "c"]] });
    const head = snapshot({ b: [...files("a", 3), "x.ts"], c: [...files("c", 2), "a/f3.ts"] });
    head.units = level({ b: [...files("a", 3), "x.ts"], c: [...files("c", 2), "a/f3.ts"] }, { edges: { "c>b": 2, "b>c": 1 } });
    const text = renderStructureMarkdown(compare(base, head), safe).join("\n");
    expect(text).toContain("### Architecture structure: CHANGED");
    expect(text).toContain("- a -> b (4 files)");
    expect(text).toContain("#### Files moved between units\n- a/f3.ts: a -> c");
    expect(text).toContain("#### Unit edges changed\n- c -> b (2 pairs, was 1)");
    expect(text).toContain("#### Unit edges added\n- b -> c (1 pairs)");
    expect(text).toContain("#### Cycles resolved (units)\n- b, c");
  });
});

describe("structure in TOON", () => {
  // TOON encodes the arrays of the top level only (toonSections): the nested lists of `structure` stay in JSON.
  it("carries the verdict in the scalar header", () => {
    const diff = compareStructure(snapshot({ a: files("a", 2) }), snapshot({ b: files("a", 2) }), { refs: { base: "main", head: "HEAD" } });
    const toon = encodeToonSections({ structure: compactOutput(diff), changedFiles: ["a.ts"] });
    expect(toon?.content).toContain("structure.verdict=changed");
  });
});
