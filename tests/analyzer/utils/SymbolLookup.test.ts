import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkSymbolInFile,
  closestFileNames,
  closestNames,
  closestPathsHint,
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

describe("closestFileNames (#803)", () => {
  it("rejects a short name that only shares the extension", () => {
    expect(closestFileNames(["COM.json"], "flow.json")).toEqual([]);
  });

  it("tolerates one edit on a short base name, a swap included", () => {
    expect(closestFileNames(["flow.json", "COM.json"], "flw.json")).toEqual(["flow.json"]);
    expect(closestFileNames(["flow.json"], "flwo.json")).toEqual(["flow.json"]);
    expect(closestFileNames(["flow.json"], "fl.json")).toEqual([]);
  });

  it("suggests only files with the same extension, ignoring its case", () => {
    expect(closestFileNames(["utils.js", "util.ts"], "utils.ts")).toEqual(["util.ts"]);
    expect(closestFileNames(["util.TS"], "utils.ts")).toEqual(["util.TS"]);
  });

  it("still suggests a name that differs only in case", () => {
    expect(closestFileNames(["README.md"], "Readme.md")).toEqual(["README.md"]);
  });

  it("allows more edits for a longer base name", () => {
    expect(closestFileNames(["SymbolLookup.ts"], "SymbloLokup.ts")).toEqual(["SymbolLookup.ts"]);
    expect(closestFileNames(["ArchitectureExplorer.ts"], "SymbolLookup.ts")).toEqual([]);
  });

  it("compares names without an extension together", () => {
    expect(closestFileNames(["Makefile", "Makefile.am"], "Makefle")).toEqual(["Makefile"]);
  });

  it("measures a workspace-relative path without its extension", () => {
    expect(closestFileNames(["src/flow.ts", "src/com.ts"], "scr/flow.ts")).toEqual(["src/flow.ts"]);
    expect(closestFileNames(["a/b/com.ts"], "a/b/flow.ts")).toEqual([]);
  });

  it("caps the list at three, closest first", () => {
    expect(closestFileNames(["abcd.ts", "abce.ts", "abcf.ts", "abc.ts", "abcg.ts"], "abc.ts")).toEqual(["abc.ts", "abcd.ts", "abce.ts"]);
  });
});

describe("closestPathsHint (#803)", () => {
  const workspace = (files: string[]): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "closest-hint-"));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "");
    }
    return root;
  };

  it("gives no hint when only unrelated files share the extension", () => {
    const root = workspace(["a/b/2023/COM.json", "a/b/2024/COM.json", "COM.json"]);
    expect(closestPathsHint(path.join(root, "flow.json"), root)).toBe("");
  });

  it("suggests the close file in the same folder", () => {
    const root = workspace(["flow.json", "COM.json"]);
    expect(closestPathsHint(path.join(root, "flw.json"), root)).toBe(" Did you mean: flow.json?");
  });

  it("finds a moved file in another folder (#801)", () => {
    const root = workspace(["docs/flow.json", "other/COM.json"]);
    expect(closestPathsHint(path.join(root, "specs", "flow.json"), root)).toBe(" Did you mean: docs/flow.json?");
  });

  it("suggests the same extension only", () => {
    const root = workspace(["src/utils.js", "src/util.ts"]);
    expect(closestPathsHint(path.join(root, "src", "utils.ts"), root)).toBe(" Did you mean: src/util.ts?");
  });

  it("suggests a name that differs only in case", () => {
    const root = workspace(["README.md"]);
    expect(closestPathsHint(path.join(root, "Readme.md"), root)).toBe(" Did you mean: README.md?");
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
