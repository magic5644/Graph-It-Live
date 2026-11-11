/**
 * The real CLI binary keeps JSX-only consumers of the React corpus in review evidence and out of dead code (#576).
 * Surface parity with the MCP and LM tools: tests/integration/reactSurfaceParity.test.ts (#591).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REACT_CORPUS, REACT_REVIEW_BASE, REACT_REVIEW_FILE } from "../analyzer/react/reactCorpus";
import type { ReviewGateResult } from "@/analyzer/ReviewGateAnalyzer";
import type { DeadCodeScanResult } from "@/analyzer/deadcode/DeadCodeScanner";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");

describe.skipIf(!fs.existsSync(DIST_ENTRY))("React resolution through the CLI (E2E)", { timeout: 180_000 }, () => {
  let root: string;

  const json = <T>(...args: string[]): T => {
    const out = execFileSync(process.execPath, [DIST_ENTRY, ...args, "-w", root, "--format", "json"], {
      cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out.slice(out.indexOf("{"))) as T;
  };

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
    const scan = json<DeadCodeScanResult>("check", "--minConfidence", "low");
    expect(scan.entries.flatMap((e) => e.unusedSymbols).map((s) => s.name)).not.toContain("Card");
    expect(scan.entries.flatMap((e) => e.unusedSymbols).map((s) => s.name)).toContain("Missing");
  });
});
