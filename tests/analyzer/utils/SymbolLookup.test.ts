import { describe, expect, it, vi } from "vitest";
import {
  checkSymbolInFile,
  closestNames,
  symbolNotFoundMessage,
} from "../../../src/analyzer/utils/SymbolLookup";
import type { SymbolInfo } from "../../../src/analyzer/types";

const symbol = (name: string): SymbolInfo => ({
  name,
  kind: "Function",
  line: 1,
  isExported: true,
  id: `/ws/a.ts:${name}`,
  category: "function",
});

const spiderWith = (names: string[]) => ({
  getSymbolGraph: vi.fn(async () => ({ symbols: names.map(symbol) })),
});

describe("checkSymbolInFile", () => {
  it("finds a declared symbol", async () => {
    await expect(checkSymbolInFile(spiderWith(["greet", "Options"]), "/ws/a.ts", "greet")).resolves.toEqual({
      status: "found",
    });
  });

  it("finds a method by its full or member name", async () => {
    const spider = spiderWith(["Greeter", "Greeter.hello"]);
    await expect(checkSymbolInFile(spider, "/ws/a.ts", "Greeter.hello")).resolves.toEqual({ status: "found" });
    await expect(checkSymbolInFile(spider, "/ws/a.ts", "hello")).resolves.toEqual({ status: "found" });
  });

  it("does not match a name that only ends with the requested text", async () => {
    const result = await checkSymbolInFile(spiderWith(["sayHello"]), "/ws/a.ts", "Hello");
    expect(result.status).toBe("missing");
  });

  it("reports a missing symbol with close matches", async () => {
    const result = await checkSymbolInFile(spiderWith(["greet", "greeting", "farewell"]), "/ws/a.ts", "gret");
    expect(result).toEqual({ status: "missing", suggestions: ["greet"] });
  });

  it("is case-sensitive for the match but not for suggestions", async () => {
    const result = await checkSymbolInFile(spiderWith(["Greet"]), "/ws/a.ts", "greet");
    expect(result).toEqual({ status: "missing", suggestions: ["Greet"] });
  });

  it("cannot verify a file without listed symbols", async () => {
    await expect(checkSymbolInFile(spiderWith([]), "/ws/a.go", "Main")).resolves.toEqual({ status: "unverified" });
  });

  it("cannot verify a file whose symbols fail to load", async () => {
    const spider = { getSymbolGraph: vi.fn(async () => { throw new Error("parse error"); }) };
    await expect(checkSymbolInFile(spider, "/ws/a.ts", "x")).resolves.toEqual({ status: "unverified" });
  });
});

describe("closestNames", () => {
  it("orders by distance, then name, and caps the list", () => {
    expect(closestNames(["abcd", "abce", "abcf", "abc", "zzzz"], "abc", 3)).toEqual(["abc", "abcd", "abce"]);
  });

  it("allows more edits for longer names", () => {
    expect(closestNames(["executeGetImpactAnalysis"], "executeGetImpactAnalysys")).toEqual(["executeGetImpactAnalysis"]);
    expect(closestNames(["completelyDifferentName"], "executeGetImpactAnalysis")).toEqual([]);
  });

  it("returns nothing for an empty list", () => {
    expect(closestNames([], "anything")).toEqual([]);
  });
});

describe("symbolNotFoundMessage", () => {
  it("lists suggestions", () => {
    expect(symbolNotFoundMessage("gret", "src/a.ts", ["greet"])).toBe(
      "Symbol 'gret' not found in src/a.ts. Did you mean: greet?",
    );
  });

  it("says when nothing is close", () => {
    expect(symbolNotFoundMessage("zzz", "src/a.ts", [])).toBe(
      "Symbol 'zzz' not found in src/a.ts. No symbol with a similar name is declared in this file.",
    );
  });
});
