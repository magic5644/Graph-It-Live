import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReviewTrees, reviewArchitecture, treeAnalyzer } from "@/analyzer/architecture/architectureReview";
import { BranchWatchAnalyzer } from "@/analyzer/BranchWatchAnalyzer";
import { buildDeltaModel } from "@/analyzer/diagram/architectureDelta";
import { renderArchitectureDelta } from "@/analyzer/diagram/deltaSvg";
import { ReviewGateAnalyzer, type SymbolDependentsProvider } from "@/analyzer/ReviewGateAnalyzer";

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const pad = (name: string) => `// ${name.repeat(12)}\n`;
const write = (root: string, files: Record<string, string | null>) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    if (content === null) fs.rmSync(target, { force: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
};
const config = (elements: string[]) => JSON.stringify({
  elements: Object.fromEntries(elements.map((name) => [name, { path: `src/${name}/` }])),
  rules: [{ name: "no-ui-db", from: "ui", forbid: "db" }],
});

/** The provider the CLI builds: the review of both trees, read from Git. */
function provider(root: string): Pick<SymbolDependentsProvider, "reviewArchitecture"> {
  const branch = new BranchWatchAnalyzer(root);
  return {
    reviewArchitecture: async (changedFiles, baseRef, headRef) => reviewArchitecture(await readReviewTrees({
      workspaceRoot: root, analyzeFile: treeAnalyzer(root),
      withRefTree: (ref, read) => branch.withRefTree(ref, read),
      mergeBase: (base, head) => branch.mergeBase(base, head),
      renames: (from, to) => branch.renames(from, to),
    }, baseRef, headRef), changedFiles, { base: baseRef, head: headRef }),
  };
}

function repository(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delta-git-")));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  write(root, {
    "graphit.architecture.json": config(["api", "core", "ui", "db", "legacy", "lib"]),
    "src/db/db.ts": `export const db = 1;\n${pad("db")}`,
    "src/core/core.ts": `export const core = 1;\n${pad("core")}`,
    "src/api/api.ts": `import { db } from "../db/db";\nimport { core } from "../core/core";\nexport const api = db + core;\n${pad("api")}`,
    "src/ui/ui.ts": `import { db } from "../db/db";\nexport const ui = db;\n${pad("ui")}`,
    "src/legacy/l0.ts": `import { core } from "../core/core";\nexport const l0 = core;\n${pad("l0")}`,
    "src/lib/lib0.ts": `export const lib0 = 0;\n${pad("lib0")}${pad("same")}`,
    "src/lib/lib1.ts": `export const lib1 = 1;\n${pad("lib1")}${pad("same")}`,
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature");
  git(root, "mv", "src/lib", "src/utils");
  git(root, "rm", "-q", "src/legacy/l0.ts");
  write(root, {
    "graphit.architecture.json": config(["api", "core", "ui", "db", "billing", "legacy", "utils"]),
    // the api -> db edge is removed, api <-> billing is a new cycle
    "src/api/api.ts": `import { core } from "../core/core";\nimport { billing } from "../billing/billing";\nexport const api = core + billing;\n${pad("api")}`,
    "src/billing/billing.ts": `import { api } from "../api/api";\nexport const billing = api;\n${pad("billing")}`,
    // the ui -> db violation is resolved
    "src/ui/ui.ts": `export const ui = 1;\n${pad("ui")}`,
    // another legacy unit, unrelated to the removed one: REMOVED legacy next to ADDED legacy
    "src/legacy/n0.ts": `import { core } from "../core/core";\nexport const n0 = core;\n${pad("n0 other")}`,
  });
  git(root, "add", "-A");
  git(root, "commit", "-m", "change");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("architecture delta on a real Git repository", { timeout: 120_000 }, () => {
  it("draws the added unit, the removed edge, the new cycle, the resolved violation, the rename and the key collision", async () => {
    const root = repository();
    const source = await new ReviewGateAnalyzer(root, provider(root)).analyzeArchitecture({ baseRef: "main", headRef: "feature" });
    expect(source).toMatchObject({ baseRef: "main", headRef: "feature" });
    const model = buildDeltaModel(source);
    const status = Object.fromEntries(model.nodes.map((node) => [node.id, node.status]));
    expect(status).toMatchObject({ billing: "ADDED", "-legacy": "REMOVED", legacy: "ADDED", utils: "RENAMED" });
    expect(model.nodes.find((node) => node.id === "utils")!.label).toBe("utils (was lib)");
    const edges = model.edges.map((edge) => `${edge.status} ${edge.from}->${edge.to}`);
    expect(edges).toEqual(expect.arrayContaining(["REMOVED api->db", "ADDED api->billing", "ADDED billing->api", "REMOVED -legacy->core", "ADDED legacy->core"]));
    const texts = model.ledger.map((row) => row.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/^ADDED cycle api, billing/), expect.stringMatching(/^RESOLVED violation no-ui-db: ui -> db/)]));
    expect(new Set(model.ledger.map((row) => `${row.target}|${row.change}`)).size).toBe(model.ledger.length);

    const { markup, counts } = await renderArchitectureDelta(source);
    expect(markup).toContain('data-diagram="architecture-delta"');
    expect(markup).toContain("RESOLVED violation no-ui-db");
    expect(counts).toContain("1 renamed");
    // Set DELTA_SCRATCH to keep the SVG for a visual check.
    if (process.env.DELTA_SCRATCH) fs.writeFileSync(path.join(process.env.DELTA_SCRATCH, "delta-fixture.svg"), markup);
  });

  it("refuses an unknown ref and an unsafe ref, and reads an unchanged pair as unchanged", async () => {
    const root = repository();
    const analyzer = new ReviewGateAnalyzer(root, provider(root));
    await expect(analyzer.analyzeArchitecture({ baseRef: "nope" })).rejects.toThrow();
    await expect(analyzer.analyzeArchitecture({ baseRef: "--output=x" })).rejects.toThrow();
    const same = await analyzer.analyzeArchitecture({ baseRef: "feature", headRef: "feature" });
    expect(same.structure?.verdict).toBe("unchanged");
  });

  it("returns no review nor structure without a provider, and limitations as an array", async () => {
    const root = repository();
    const result = await new ReviewGateAnalyzer(root).analyzeArchitecture({ baseRef: "main", headRef: "feature" });
    expect(result).toEqual({ baseRef: "main", headRef: "feature", limitations: [] });
  });
});
