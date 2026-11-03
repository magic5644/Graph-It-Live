/**
 * The real CLI binary reports the React corpus like the MCP and LM tools (#575): `graph-it trace` and
 * `graph-it tool query_call_graph` return the same targets, relations and lines.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REACT_CORPUS, REACT_CORPUS_EDGES, REACT_REVIEW_BASE, REACT_REVIEW_FILE } from "../analyzer/react/reactCorpus";
import type { ReviewGateResult } from "@/analyzer/ReviewGateAnalyzer";
import type { DeadCodeScanResult } from "@/analyzer/deadcode/DeadCodeScanner";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const SOURCES = [...new Set(REACT_CORPUS_EDGES.map((edge) => edge.split(" ")[0]))];

describe.skipIf(!fs.existsSync(DIST_ENTRY))("React resolution through the CLI (E2E)", { timeout: 180_000 }, () => {
  let root: string;

  const json = <T>(...args: string[]): T => {
    const out = execFileSync(process.execPath, [DIST_ENTRY, ...args, "-w", root, "--format", "json"], {
      cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out.slice(out.indexOf("{"))) as T;
  };
  const rel = (file: string) => path.relative(root, file).replaceAll("\\", "/");

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-575-")));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    for (const [name, source] of Object.entries(REACT_REVIEW_BASE)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), source);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "--initial-branch=main");
    git("config", "user.email", "react@example.com");
    git("config", "user.name", "React fixture");
    git("add", ".");
    git("commit", "-m", "base");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("keeps JSX-only consumers in review evidence and out of check's dead-code report (#576)", () => {
    fs.writeFileSync(path.join(root, REACT_REVIEW_FILE), REACT_CORPUS[REACT_REVIEW_FILE]);
    const review = json<ReviewGateResult>("review-pr", "--base", "main");
    const card = review.symbols.find((s) => s.name === "Card")!;
    expect(card.consumers.unverified.sort()).toEqual(["src/Fancy.tsx", "src/Old.jsx", "src/Page.tsx"]);
    expect(card.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "impact", detail: expect.stringContaining("src/Old.jsx:2") }),
      expect.objectContaining({ kind: "partial", detail: expect.stringContaining("props-contract compatibility is not checked") }),
    ]));
    expect(card.unusedExportEvidence).toBe(false);
    expect(review.limitations.join(" ")).toContain("props-contract compatibility is not checked");
    const markdown = execFileSync(process.execPath, [DIST_ENTRY, "review-pr", "--base", "main", "-w", root, "--format", "markdown"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(markdown).toContain("src/Old.jsx:2");
    expect(markdown).toContain("props-contract compatibility is not checked");
    const scan = json<DeadCodeScanResult>("check");
    expect(scan.entries.flatMap((e) => e.unusedSymbols).map((s) => s.name)).not.toContain("Card");
    expect(scan.entries.flatMap((e) => e.unusedSymbols).map((s) => s.name)).toContain("Missing");
  });

  it("traces and queries the corpus edges with the same relations and lines", () => {
    const trace: string[] = [];
    const callGraph: string[] = [];
    for (const key of SOURCES) {
      const [file, symbolName] = key.split("#");
      const { callChain } = json<{ callChain: Array<{ calledSymbolId: string; resolvedRelativePath: string | null; line?: number; relation?: string }> }>(
        "trace", `${file}#${symbolName}`, "--maxDepth", "1");
      for (const e of callChain.filter((c) => c.resolvedRelativePath?.startsWith("src/"))) {
        trace.push(`${key} -${e.relation ?? "CALLS"}@${e.line}-> ${e.resolvedRelativePath}#${e.calledSymbolId.split(":").pop()}`);
      }
      const { callees } = json<{ callees: Array<{ relation: string; sourceLine: number; sourceName: string; sourceFile: string; targetName: string; targetFile: string }> }>(
        "tool", "query_call_graph", `--filePath=${path.join(root, file)}`, `--symbolName=${symbolName}`, "--direction=callees", "--depth=1");
      for (const e of callees) callGraph.push(`${rel(e.sourceFile)}#${e.sourceName} -${e.relation}@${e.sourceLine + 1}-> ${rel(e.targetFile)}#${e.targetName}`);
    }

    expect(trace.sort()).toEqual([...REACT_CORPUS_EDGES].sort());
    expect(callGraph.sort()).toEqual([...REACT_CORPUS_EDGES].sort());
  });
});
