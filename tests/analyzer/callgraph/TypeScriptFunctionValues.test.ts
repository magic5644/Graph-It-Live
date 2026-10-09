/**
 * Runs resources/queries/typescript.scm against the real tree-sitter WASM grammar
 * (from node_modules, so no build is needed): a pattern the shipped grammar does
 * not know would fail to compile here.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";

const ROOT = process.cwd();

describe("TypeScript call graph: function-valued declarations", () => {
  let extensionPath: string;
  let extractor: GraphExtractor;

  beforeAll(async () => {
    extensionPath = await fs.mkdtemp(path.join(os.tmpdir(), "gil-fnvalues-"));
    const wasmDir = path.join(extensionPath, "dist", "wasm");
    const queryDir = path.join(extensionPath, "dist", "queries");
    await fs.mkdir(wasmDir, { recursive: true });
    await fs.mkdir(queryDir, { recursive: true });
    await fs.copyFile(
      path.join(ROOT, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
      path.join(wasmDir, "tree-sitter.wasm"),
    );
    await fs.copyFile(
      path.join(ROOT, "node_modules", "tree-sitter-wasms", "out", "tree-sitter-typescript.wasm"),
      path.join(wasmDir, "tree-sitter-typescript.wasm"),
    );
    await fs.copyFile(
      path.join(ROOT, "resources", "queries", "typescript.scm"),
      path.join(queryDir, "typescript.scm"),
    );
    extractor = new GraphExtractor({ extensionPath, workspaceRoot: extensionPath });
  });

  afterAll(async () => {
    extractor.dispose();
    await fs.rm(extensionPath, { recursive: true, force: true });
  });

  const source = `
export const g = async function () { return x(); };
export const f = () => x();
var legacy = function named() { return 1; };
export const k = 42;
export function x() { return 1; }
export function d() { return g() + f() + legacy(); }
`;

  it("defines arrow functions and function expressions as function nodes", async () => {
    const { nodes } = await extractor.extractSource(path.join(extensionPath, "a.ts"), "typescript", source);
    const types = Object.fromEntries(nodes.map((n) => [n.name, n.type]));

    expect(types).toEqual({ g: "function", f: "function", legacy: "function", x: "function", d: "function" });
  });

  it("keeps edges into and out of a function expression", async () => {
    const { nodes, edges } = await extractor.extractSource(path.join(extensionPath, "a.ts"), "typescript", source);
    const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
    const calls = edges
      .filter((e) => e.typeRelation === "CALLS")
      .map((e) => `${nameOf.get(e.sourceId)}->${nameOf.get(e.targetId) ?? e.targetId}`);

    expect(calls).toEqual(expect.arrayContaining(["g->x", "f->x", "d->g", "d->f", "d->legacy"]));
  });
});
