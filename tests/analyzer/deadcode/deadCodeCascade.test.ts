import { describe, expect, it } from "vitest";
import { cascadeConfidence, deadByCascade } from "@/analyzer/deadcode/deadCodeCascade";
import type { DeadCodeConfidence } from "@/analyzer/deadcode/deadCodeConfidence";

const isTest = (file: string): boolean => file.endsWith(".test.ts");
const graph = (entries: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(entries));
const cascade = (entries: Record<string, string[]>, dead: string[], live: string[] = []): Record<string, string[]> =>
  Object.fromEntries(deadByCascade(graph(entries), new Set(dead), new Set(live), isTest));

describe("deadByCascade (#726)", () => {
  it("follows a chain from a dead file", () => {
    expect(cascade({ a: [], b: ["a"], c: ["b"] }, ["a"])).toEqual({ b: ["a"], c: ["b"] });
  });

  it("finds a cycle nothing else imports", () => {
    expect(cascade({ x: ["y"], y: ["x"] }, [])).toEqual({ x: ["y"], y: ["x"] });
  });

  it("keeps a cycle a live file imports", () => {
    expect(cascade({ x: ["y", "main"], y: ["x"] }, [])).toEqual({});
  });

  it("keeps a diamond's bottom alive through its live branch, and lists the dead branch", () => {
    const entries = { top: [], left: ["top"], right: ["top", "main"], bottom: ["left", "right"] };
    expect(cascade(entries, ["top"])).toEqual({ left: ["top"] });
  });

  it("ignores test importers: a file only dead files and tests import is dead", () => {
    expect(cascade({ hook: [], utils: ["hook", "utils.test.ts", "more.test.ts"] }, ["hook"])).toEqual({ utils: ["hook"] });
  });

  it("stops at a live file (an entry point) and at an importer the scan did not read", () => {
    expect(cascade({ dead: [], cli: ["dead"], helper: ["cli"] }, ["dead"], ["cli"])).toEqual({});
    expect(cascade({ dead: [], shared: ["dead", "outOfScope"] }, ["dead"])).toEqual({});
  });

  it("never returns dead files, live files or files with no production importer", () => {
    expect(cascade({ a: [], t: ["a.test.ts"] }, ["a"])).toEqual({});
  });
});

describe("cascadeConfidence (#726)", () => {
  const levels = (via: Record<string, string[]>, direct: Record<string, DeadCodeConfidence>, cap: Record<string, DeadCodeConfidence> = {}) =>
    Object.fromEntries(cascadeConfidence(graph(via), new Map(Object.entries(direct)), new Map(Object.entries(cap))));

  it("carries the root's level down a chain", () => {
    expect(levels({ b: ["a"], c: ["b"] }, { a: "medium" })).toEqual({ b: "medium", c: "medium" });
  });

  it("takes the lowest importer, and never goes above the file's own cap", () => {
    expect(levels({ c: ["m", "l"] }, { m: "medium", l: "low" })).toEqual({ c: "low" });
    expect(levels({ c: ["h"] }, { h: "high" }, { c: "medium" })).toEqual({ c: "medium" });
  });

  it("gives a dead cycle no direct file reaches low, and a cycle a root reaches the root's level", () => {
    expect(levels({ x: ["y"], y: ["x"] }, {})).toEqual({ x: "low", y: "low" });
    expect(levels({ x: ["y", "r"], y: ["x"] }, { r: "medium" })).toEqual({ x: "medium", y: "medium" });
  });
});
