import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RustSymbolAnalyzer } from "@/analyzer/languages/RustSymbolAnalyzer";
import { SpiderError } from "@/analyzer/types";
import { normalizePath } from "@/shared/path";

// Real tree-sitter WASM (dist/wasm): declarations and imports the call and reference rules build on.
describe("RustSymbolAnalyzer declarations and imports", () => {
  const file = normalizePath("/ws/src/lib.rs");
  const analyzer = new RustSymbolAnalyzer(process.cwd());
  let tmp: string;

  beforeAll(async () => {
    await analyzer.ensureInitialized();
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-rust-decl-")));
  });
  afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

  it("lists structs, enums, traits and impl methods with their visibility", () => {
    const { symbols } = analyzer.analyzeFileContent(file, `pub struct Shape;
enum Kind { A, B }
pub trait Draw { fn draw(&self); }
impl Shape { pub fn area(&self) -> u32 { 0 } }
`);

    expect(symbols.map((s) => [s.name, s.category, s.isExported]).sort()).toEqual([
      ["Draw", "type", true],
      ["Kind", "type", false],
      ["Shape", "class", true],
      // A `pub fn` of an impl is reached through its type, never through `use`: not a module-level export.
      ["area", "function", false],
    ].sort());
    expect(symbols.find((s) => s.name === "area")?.parentSymbolId).toBe(`${file}:Shape`);
  });

  it("keeps module-level pub items exported and makes members of generic and trait impls, trait methods and nested functions not exported", () => {
    const { symbols } = analyzer.analyzeFileContent(file, `pub fn top() { pub fn inner() {} }
pub struct Stack<T>(Vec<T>);
impl<T> Stack<T> { pub fn push(&mut self) {} }
impl Default for Stack<u8> { fn default() -> Self { Stack(Vec::new()) } }
pub trait Run { fn run(&self) {} }
`);

    expect(symbols.filter((s) => s.isExported).map((s) => s.name).sort()).toEqual(["Run", "Stack", "top"]);
    expect(symbols.find((s) => s.name === "push")?.parentSymbolId).toBe(`${file}:Stack`);
    expect(symbols.find((s) => s.name === "default")?.parentSymbolId).toBe(`${file}:Stack`);
  });

  it.each([
    ["a grouped use", "use crate::shapes::{area, perimeter};\nfn run() { area(); perimeter(); }\n", ["crate::shapes:area", "crate::shapes:perimeter"]],
    ["a nested grouped use", "use crate::{shapes::{area}};\nfn run() { area(); }\n", ["crate::shapes:area"]],
    ["a grouped use of a single-segment path", "use utils::{area};\nfn run() { area(); }\n", ["utils:area"]],
    ["a renamed function", "use crate::shapes::area as surface;\nfn run() { surface(); register(surface); }\n", ["crate::shapes:area", "crate::shapes:area"]],
    ["a renamed module", "use crate::shapes as s;\nfn run() { s::area(); }\n", ["crate::shapes:area"]],
  ])("resolves calls through %s", (_title, source, expected) => {
    expect(analyzer.analyzeFileContent(file, source).dependencies.map((d) => d.targetSymbolId).sort()).toEqual(expected);
  });

  it("reads the file for getSymbolDependencies and wraps a missing file in a SpiderError", async () => {
    const real = path.join(tmp, "main.rs");
    await fs.writeFile(real, "fn helper() {}\nfn run() { helper(); register(helper); }\n");

    const deps = await analyzer.getSymbolDependencies(real);

    expect(deps.map((d) => `${d.targetSymbolId.split(":").pop()}:${d.relation ?? "use"}`).sort()).toEqual(["helper:REFERENCES", "helper:use"]);
    await expect(analyzer.getSymbolDependencies(path.join(tmp, "missing.rs"))).rejects.toBeInstanceOf(SpiderError);
  });
});
