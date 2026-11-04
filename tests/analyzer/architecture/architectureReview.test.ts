import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareArchitecture,
  renderArchitectureMarkdown,
  readReviewTrees,
  reviewArchitecture,
  treeAnalyzer,
  type ArchitectureReviewHost,
  type ArchitectureSide,
} from "@/analyzer/architecture/architectureReview";
import { parseArchitectureConfig, type ArchitectureViolation } from "@/analyzer/architecture/architectureRules";
import { BranchWatchAnalyzer } from "@/analyzer/BranchWatchAnalyzer";
import type { ArchitectureRuleSummary } from "@/shared/architecture-model";
import { normalizePath } from "@/shared/path";

const rule = (name: string, severity: ArchitectureRuleSummary["severity"] = "error"): ArchitectureRuleSummary =>
  ({ name, kind: "forbid", severity, violations: 0, newViolations: 0, elementPairs: [] });
const violation = (name: string, source: string, target: string, extra: Partial<ArchitectureViolation> = {}): ArchitectureViolation =>
  ({ rule: name, severity: "error", source, target, from: "frontend", to: "backend", new: true, ...extra });
const side = (rules: ArchitectureRuleSummary[], violations: ArchitectureViolation[], extra: Partial<ArchitectureSide> = {}): ArchitectureSide =>
  ({ check: { rules, violations, unitCycles: [] }, ...extra });

describe("compareArchitecture", () => {
  it("is degraded by a new violation, counting only unaccepted errors", () => {
    const review = compareArchitecture(
      side([rule("r")], []),
      side([rule("r"), rule("w", "warning")], [
        violation("r", "frontend/a.ts", "backend/db.ts", { line: 3 }),
        violation("r", "frontend/b.ts", "backend/db.ts", { new: false }),
        violation("w", "frontend/a.ts", "backend/db.ts", { severity: "warning" }),
      ]),
      false,
    );
    expect(review.verdict).toBe("degraded");
    expect(review.newErrors).toBe(1);
    expect(review.rules[0].newViolations).toEqual([
      { source: "frontend/a.ts", target: "backend/db.ts", line: 3, from: "frontend", to: "backend", accepted: false },
      { source: "frontend/b.ts", target: "backend/db.ts", from: "frontend", to: "backend", accepted: true },
    ]);
    expect(review.rules[1]).toMatchObject({ name: "w", severity: "warning", unchanged: 0 });
    expect(review.configChange).toBeUndefined();
  });

  it("is improved by resolved violations when none is new, and unchanged otherwise", () => {
    const both = violation("r", "frontend/a.ts", "backend/db.ts");
    const improved = compareArchitecture(side([rule("r")], [both, violation("r", "frontend/b.ts", "backend/db.ts")]), side([rule("r")], [both]), false);
    expect(improved).toMatchObject({ verdict: "improved", newErrors: 0 });
    expect(improved.rules[0]).toMatchObject({ unchanged: 1, resolvedViolations: [{ source: "frontend/b.ts", target: "backend/db.ts" }] });
    const unchanged = compareArchitecture(side([rule("r")], [both]), side([rule("r")], [both]), false);
    expect(unchanged).toMatchObject({ verdict: "unchanged", newErrors: 0, rules: [{ unchanged: 1, newViolations: [], resolvedViolations: [] }] });
  });

  it("matches file pairs written with Windows separators on either side", () => {
    const review = compareArchitecture(
      side([rule("r")], [violation("r", String.raw`frontend\a.ts`, String.raw`backend\db.ts`)]),
      side([rule("r")], [violation("r", "frontend/a.ts", "backend/db.ts")]),
      true,
    );
    expect(review.rules[0]).toMatchObject({ unchanged: 1, newViolations: [] });
    const baseline = compareArchitecture(
      side([], [], { baseline: [{ rule: "r", source: String.raw`frontend\a.ts`, target: "backend/db.ts" }] }),
      side([], [], { baseline: [{ rule: "r", source: "frontend/a.ts", target: String.raw`backend\db.ts` }] }),
      true,
    );
    expect(baseline.configChange?.baseline).toEqual({ added: [], removed: [] });
  });

  it("counts a violation the head baseline no longer accepts as new again, as check-architecture fails on it", () => {
    const accepted = violation("r", "frontend/a.ts", "backend/db.ts", { new: false });
    const review = compareArchitecture(side([rule("r")], [accepted]), side([rule("r")], [{ ...accepted, new: true }]), true);
    expect(review).toMatchObject({ verdict: "degraded", newErrors: 1 });
    expect(review.rules[0]).toMatchObject({ unchanged: 0, newViolations: [{ source: "frontend/a.ts", accepted: false }] });
    // Still accepted, or never accepted: unchanged.
    expect(compareArchitecture(side([rule("r")], [accepted]), side([rule("r")], [accepted]), false)).toMatchObject({ verdict: "unchanged", newErrors: 0 });
  });

  it("does not report a rules file whose keys only moved as changed", () => {
    const read = (text: string): ArchitectureSide => ({ config: parseArchitectureConfig(text) });
    const review = compareArchitecture(
      read('{ "elements": { "a": { "path": "a/", "each": true } }, "rules": [{ "name": "r", "noCycles": "a", "severity": "warning" }] }'),
      read('{ "rules": [{ "severity": "warning", "noCycles": "a", "name": "r" }], "elements": { "a": { "each": true, "path": "a/" } } }'),
      true,
    );
    expect(review.configChange).toMatchObject({ rules: { added: [], removed: [], changed: [] }, elements: { added: [], removed: [], changed: [] }, roles: false });
  });

  it("compares only the rules the head checks: a removed or switched-off rule resolves nothing", () => {
    const base = side([rule("gone"), rule("off")], [violation("gone", "a.ts", "b.ts"), violation("off", "a.ts", "b.ts")]);
    const review = compareArchitecture(base, side([rule("off", "off")], []), false);
    expect(review).toMatchObject({ verdict: "unchanged", rules: [] });
    // Switched on by the diff: what the base had is new.
    const on = compareArchitecture(side([rule("r", "off")], []), side([rule("r")], [violation("r", "a.ts", "b.ts")]), false);
    expect(on).toMatchObject({ verdict: "degraded", newErrors: 1 });
  });

  it("reports unit cycles added or removed the same way", () => {
    const cycle = { source: "ui/a.ts", target: "core/b.ts", line: 2, from: "ui", to: "core" };
    const added = compareArchitecture(side([], []), { check: { rules: [], violations: [], unitCycles: [cycle] } }, false);
    expect(added).toMatchObject({ verdict: "degraded", newErrors: 0, unitCycles: { newViolations: [cycle], resolvedViolations: [], unchanged: 0 } });
    const removed = compareArchitecture({ check: { rules: [], violations: [], unitCycles: [cycle] } }, side([], []), false);
    expect(removed).toMatchObject({ verdict: "improved", unitCycles: { resolvedViolations: [cycle] } });
  });

  it("lists the rules, elements, roles and baseline entries a rules-file edit changes", () => {
    const base = side([], [], {
      config: { elements: { a: { path: "a/" }, gone: { path: "g/" } }, rules: [{ name: "kept", noCycles: "units" }, { name: "edited", noCycles: "units" }, { name: "dropped", noCycles: "units" }] },
      baseline: [{ rule: "edited", source: "a/x.ts", target: "b/y.ts" }],
    });
    const head = side([], [], {
      // Parsed like a config file: "__proto__" is an own key there, not the prototype.
      config: { elements: JSON.parse('{ "a": { "path": "a/*" }, "__proto__": { "path": "p/" } }'), rules: [{ name: "kept", noCycles: "units" }, { name: "edited", noCycles: "units", severity: "warning" }, { name: "new", noCycles: "units" }], roles: { "a/*": "app" } },
      baseline: [{ rule: "new", source: "a/x.ts", target: "b/y.ts" }],
    });
    expect(compareArchitecture(base, head, true).configChange).toEqual({
      rules: { added: ["new"], removed: ["dropped"], changed: ["edited"] },
      elements: { added: ["__proto__"], removed: ["gone"], changed: ["a"] },
      roles: true,
      baseline: { added: [{ rule: "new", source: "a/x.ts", target: "b/y.ts" }], removed: [{ rule: "edited", source: "a/x.ts", target: "b/y.ts" }] },
    });
    // The config file deleted: the head has nothing to compare.
    expect(compareArchitecture(base, {}, true)).toMatchObject({ verdict: "unchanged", rules: [], configChange: { rules: { removed: ["dropped", "edited", "kept"] } } });
  });
});

describe("renderArchitectureMarkdown", () => {
  it("sanitizes the report, caps long lists and shows rules-file changes", () => {
    const head = side([rule("r|x")], Array.from({ length: 22 }, (_, index) => violation("r|x", `src/f${index}.ts`, "backend/db.ts", { line: index + 1, new: index > 0 })));
    const review = compareArchitecture(side([], [], { config: { elements: {}, rules: [] } }), { ...head, config: { elements: {}, rules: [{ name: "r|x", noCycles: "units" }] } }, true);
    const markdown = renderArchitectureMarkdown(review, (value) => value.replaceAll("|", " ")).join("\n");
    expect(markdown).toContain("### Architecture rules: DEGRADED");
    expect(markdown).toContain("| r x | error | 22 | 0 | 0 |");
    expect(markdown).toContain("- r x: src/f0.ts:1 -> backend/db.ts (frontend -> backend) — accepted by the baseline");
    expect(markdown).toContain("- … 2 more");
    expect(markdown).toContain("- Rules added: r x");
    expect(markdown).not.toContain("#### Resolved violations");
  });
});

const CONFIG = {
  elements: { frontend: { path: "frontend/" }, backend: { path: "backend/" } },
  rules: [
    { name: "frontend-not-backend", from: "frontend", forbid: "backend" },
    { name: "backend-not-frontend", from: "backend", forbid: "frontend", severity: "warning" },
  ],
};
const IMPORTS_BACKEND = 'import { db } from "../backend/db";\nexport const app = db;\n';

const workspaces: string[] = [];

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function write(root: string, files: Record<string, string | null>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    if (content === null) {
      fs.rmSync(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** A Git workspace whose base commit (main) holds `base`; the config unless `withConfig` is false. */
function createWorkspace(base: Record<string, string>, withConfig = true): string {
  // realpath: the macOS tmpdir is a symlink (/var → /private/var), which the workspace checks resolve.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "architecture-review-")));
  workspaces.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  write(root, {
    "frontend/app.ts": "export const app = 1;\n",
    "backend/db.ts": "export const db = 1;\n",
    ...(withConfig ? { "graphit.architecture.json": JSON.stringify(CONFIG) } : {}),
    ...base,
  });
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

function host(root: string): ArchitectureReviewHost {
  const branch = new BranchWatchAnalyzer(root);
  return {
    workspaceRoot: root,
    analyzeFile: treeAnalyzer(root),
    withRefTree: (ref, read) => branch.withRefTree(ref, read),
    mergeBase: (base, head) => branch.mergeBase(base, head),
  };
}

afterEach(() => {
  // Retries: on Windows, a folder Git just used can briefly fail with EBUSY.
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Spawns git and parses both trees; slow on Windows runners.
describe("reviewArchitecture", { timeout: 60_000 }, () => {
  it("reports a new violation of the working tree, with its importing line, and a new unit cycle", async () => {
    const root = createWorkspace({});
    write(root, { "frontend/app.ts": IMPORTS_BACKEND, "backend/db.ts": 'import { app } from "../frontend/app";\nexport const db = 1;\nexport const used = app;\n' });
    const { review, limitations } = reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["backend/db.ts", "frontend/app.ts"]);
    expect(limitations).toEqual([]);
    expect(review).toMatchObject({ verdict: "degraded", newErrors: 1, configFile: "graphit.architecture.json" });
    expect(review?.configChange).toBeUndefined();
    expect(review?.rules.map(({ name, newViolations }) => [name, newViolations.map(({ source, target, line }) => [normalizePath(source), normalizePath(target), line])])).toEqual([
      ["frontend-not-backend", [["frontend/app.ts", "backend/db.ts", 1]]],
      ["backend-not-frontend", [["backend/db.ts", "frontend/app.ts", 1]]],
    ]);
    expect(review?.unitCycles.newViolations.map(({ from, to }) => `${from}>${to}`).sort()).toEqual(["backend>frontend", "frontend>backend"]);
  });

  it("reports a violation the diff removes as resolved, and an untouched one as unchanged", async () => {
    const root = createWorkspace({ "frontend/app.ts": IMPORTS_BACKEND, "frontend/other.ts": 'import { db } from "../backend/db";\nexport const other = db;\n' });
    write(root, { "frontend/app.ts": "export const app = 2;\n" });
    const { review } = reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["frontend/app.ts"]);
    expect(review).toMatchObject({ verdict: "improved", newErrors: 0 });
    expect(review?.rules[0]).toMatchObject({ unchanged: 1, newViolations: [], resolvedViolations: [{ source: "frontend/app.ts", target: "backend/db.ts", line: 1 }] });
  });

  it("flags a rules edit: a baseline that accepts the new violation keeps it from counting as an error", async () => {
    const root = createWorkspace({});
    const config = { ...CONFIG, rules: [...CONFIG.rules, { name: "no-unit-cycles", noCycles: "units" }] };
    write(root, {
      "frontend/app.ts": IMPORTS_BACKEND,
      "graphit.architecture.json": JSON.stringify(config),
      "graphit.architecture.baseline.json": JSON.stringify({ version: 1, violations: [{ rule: "frontend-not-backend", source: "frontend/app.ts", target: "backend/db.ts" }] }),
    });
    const { review } = reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["frontend/app.ts", "graphit.architecture.baseline.json", "graphit.architecture.json"]);
    expect(review).toMatchObject({ verdict: "degraded", newErrors: 0 });
    expect(review?.rules[0].newViolations).toMatchObject([{ accepted: true }]);
    expect(review?.configChange).toMatchObject({
      rules: { added: ["no-unit-cycles"], removed: [], changed: [] },
      baseline: { added: [{ rule: "frontend-not-backend" }], removed: [] },
    });
  });

  it("checks a base without a config against the head config, and reads only the rules files once the head has none", async () => {
    const root = createWorkspace({ "frontend/app.ts": IMPORTS_BACKEND }, false);
    write(root, { "graphit.architecture.json": JSON.stringify(CONFIG) });
    const added = reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["graphit.architecture.json"]);
    expect(added.review).toMatchObject({ verdict: "unchanged", newErrors: 0, configChange: { rules: { added: ["backend-not-frontend", "frontend-not-backend"] } } });
    expect(added.review?.rules[0]).toMatchObject({ name: "frontend-not-backend", unchanged: 1 });

    git(root, "add", ".");
    git(root, "commit", "-m", "rules");
    write(root, { "graphit.architecture.json": null });
    const removed = reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["graphit.architecture.json"]);
    expect(removed.review).toMatchObject({ verdict: "unchanged", rules: [], configChange: { rules: { removed: ["backend-not-frontend", "frontend-not-backend"] } } });
  });

  it("returns no review when neither side has a config", async () => {
    const root = createWorkspace({}, false);
    write(root, { "frontend/app.ts": IMPORTS_BACKEND });
    expect(reviewArchitecture(await readReviewTrees(host(root), "main", "HEAD"), ["frontend/app.ts"])).toEqual({ limitations: [] });
  });

  it("reads the whole import graph of both trees, even without a config, for the import-cycle check (#603)", async () => {
    const root = createWorkspace({ "frontend/app.ts": IMPORTS_BACKEND }, false);
    write(root, { "backend/db.ts": 'import { app } from "../frontend/app";\nexport const db = app;\n' });
    const trees = await readReviewTrees(host(root), "main", "HEAD");
    const pairs = (side: ArchitectureSide) => (side.imports ?? []).map(({ source, target }) => `${normalizePath(source)}>${normalizePath(target)}`).sort();
    expect(pairs(trees.base)).toEqual(["frontend/app.ts>backend/db.ts"]);
    expect(pairs(trees.head)).toEqual(["backend/db.ts>frontend/app.ts", "frontend/app.ts>backend/db.ts"]);
    expect(trees.head.check).toBeUndefined();
    expect(trees.limitations).toEqual([]);
  });

  it("keeps an in-root Rust mod declaration as a containment edge, so the cycle check can drop its pair (#595)", async () => {
    const root = createWorkspace({}, false);
    const base = host(root);
    const analyzeFile: ArchitectureReviewHost["analyzeFile"] = async (filePath) => filePath.endsWith("app.ts")
      ? [{ path: path.join(root, "backend", "db.ts"), type: "mod", line: 1, module: "db" }, { path: path.join(root, "..", "outside.rs"), type: "mod", line: 2, module: "escape" }]
      : [];
    const { head } = await readReviewTrees({ ...base, analyzeFile }, "main", "HEAD");
    expect(head.imports?.map(({ source, target, relationType }) => [normalizePath(source), normalizePath(target), relationType])).toEqual([
      ["frontend/app.ts", "backend/db.ts", "containment"],
    ]);
  });

  it("reports the files of a tree that could not be analyzed, and fails when a ref cannot be copied", async () => {
    const root = createWorkspace({});
    const base = host(root);
    const analyzeFile: ArchitectureReviewHost["analyzeFile"] = async (filePath) => {
      if (filePath.endsWith("app.ts")) throw new Error("parse error");
      return [];
    };
    expect((await readReviewTrees({ ...base, analyzeFile }, "main", "HEAD")).limitations).toEqual(["Import graph at HEAD: 1 file(s) could not be analyzed."]);
    await expect(readReviewTrees({ ...base, withRefTree: async () => { throw new Error("no such ref"); } }, "main", "HEAD")).rejects.toThrow("no such ref");
  });

  it("compares an explicit head ref with its merge base, as git diff base...head does", async () => {
    const root = createWorkspace({});
    git(root, "checkout", "-b", "feature");
    write(root, { "frontend/app.ts": IMPORTS_BACKEND });
    git(root, "commit", "-am", "violation");
    git(root, "checkout", "main");
    // Fixed on main after the branch: invisible to the feature diff.
    write(root, { "backend/db.ts": "export const db = 2;\n" });
    git(root, "commit", "-am", "main moves on");
    const { review } = reviewArchitecture(await readReviewTrees(host(root), "main", "feature"), ["frontend/app.ts"]);
    expect(review).toMatchObject({ verdict: "degraded", newErrors: 1 });
    expect(review?.rules[0].newViolations).toMatchObject([{ source: "frontend/app.ts", target: "backend/db.ts" }]);
  });

  it("names the ref whose rules file is invalid", async () => {
    const root = createWorkspace({ "graphit.architecture.json": "{ not json" });
    write(root, { "graphit.architecture.json": JSON.stringify(CONFIG) });
    await expect(readReviewTrees(host(root), "main", "HEAD")).rejects.toThrow(/^main: graphit\.architecture\.json: \$: not valid JSON/);
  });
});
