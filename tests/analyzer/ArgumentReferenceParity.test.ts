/**
 * The symbol analyzers (ts-morph for TS/JS, the Python and Rust analyzers) report a function passed as an
 * argument like the call graph does (#575): same targets, REFERENCES vs CALLS, same lines.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Spider } from "@/analyzer/Spider";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { LanguageService } from "@/analyzer/LanguageService";
import { normalizePath } from "@/shared/path";
import { ARGUMENT_CASES } from "./callgraph/argumentCorpus";
import { writeFiles } from "./callgraph/treeSitterHarness";

/** `file#name` of an absolute symbol id inside `root`, or null outside it. */
function keyOf(root: string, symbolId: string): string | null {
  const colon = symbolId.lastIndexOf(":");
  const file = normalizePath(symbolId.slice(0, colon));
  if (!file.startsWith(`${normalizePath(root)}/`)) return null;
  return `${path.relative(root, file).replaceAll("\\", "/")}#${symbolId.slice(colon + 1)}`;
}

describe("function references passed as arguments: symbol analyzers agree with the call graph", () => {
  let root: string | undefined;
  let spider: Spider | undefined;

  afterEach(async () => {
    await spider?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it.each(ARGUMENT_CASES.filter((c) => c.symbolPipeline))("$lang", async ({ files, source, expected }) => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-args-parity-")));
    await writeFiles(root, files);
    LanguageService.reset();
    spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    await spider.buildFullIndex();
    const [sourceFile] = source.split("#");

    const { symbols } = await spider.getSymbolGraph(path.join(root, sourceFile));
    const edges: string[] = [];
    for (const symbol of symbols) {
      const { callChain } = await spider.traceFunctionExecution(path.join(root, sourceFile), symbol.name, 1);
      for (const entry of callChain) {
        const target = entry.resolvedFilePath && keyOf(root, `${entry.resolvedFilePath}:${entry.calledSymbolId.split(":").pop()}`);
        if (target) edges.push(`${keyOf(root, entry.callerSymbolId)} -${entry.relation ?? "CALLS"}@${(entry.line ?? 0) - 1}-> ${target}`);
      }
    }

    expect(edges.filter((edge) => edge.startsWith(source)).sort()).toEqual([...expected].sort());
  });
});
