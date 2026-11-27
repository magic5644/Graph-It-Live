import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readReviewTrees,
  reviewArchitecture,
  treeAnalyzer,
  ArchitectureReviewError,
  type ArchitectureReviewHost,
} from "@/analyzer/architecture/architectureReview";
import * as rules from "@/analyzer/architecture/architectureRules";
import { BranchWatchAnalyzer } from "@/analyzer/BranchWatchAnalyzer";

const roots: string[] = [];
const CONFIG = { elements: { core: { path: "src/" } }, rules: [] };

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const move = (root: string, from: string, to: string) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  git(root, "mv", from, to);
};


/** A file whose content is unique to `name`, so that Git pairs it with itself and with nothing else. */
const source = (name: string, extra = "") => `export const ${name.replaceAll(/\W/g, "_")} = "${name}";\n// ${name.repeat(8)}\n${extra}`;

function write(root: string, files: Record<string, string | null>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

const many = (folder: string, count: number, from = 0): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`src/${folder}/f${from + index}.ts`, source(`${folder}${from + index}`)]));

/** Keeps `src` the common folder of the unit, so that the groups stay `core/<folder>`. */
const ANCHOR = many("keep", 2);

/** Base commit on main, then a `feature` branch whose commit applies `change`. */
function repository(base: Record<string, string | null>, change: (root: string) => void): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "structure-golden-")));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  write(root, { "graphit.architecture.json": JSON.stringify(CONFIG), ...ANCHOR, ...base });
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature");
  change(root);
  git(root, "add", "-A");
  git(root, "commit", "-m", "change", "--allow-empty");
  return root;
}

function host(root: string, renames = true): ArchitectureReviewHost {
  const branch = new BranchWatchAnalyzer(root);
  return {
    workspaceRoot: root,
    analyzeFile: treeAnalyzer(root),
    withRefTree: (ref, read) => branch.withRefTree(ref, read),
    mergeBase: (base, head) => branch.mergeBase(base, head),
    ...(renames ? { renames: (from, to) => branch.renames(from, to) } : {}),
  };
}

async function structureOf(root: string, head = "feature", changed: string[] = [], hostOverride = host(root)) {
  const { structure } = reviewArchitecture(await readReviewTrees(hostOverride, "main", head), changed, { base: "main", head });
  return structure!;
}

const statuses = (items: { status: string; key: string; previousKey?: string }[]) => items.map(({ status, key, previousKey }) => (previousKey ? `${status} ${previousKey} -> ${key}` : `${status} ${key}`));

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("structure diff on a real Git repository", { timeout: 120_000 }, () => {
  it("reads a renamed folder as one renamed group, with no edge noise", async () => {
    const root = repository({ ...many("a", 4), ...many("b", 2), "src/b/user.ts": 'import { a0 } from "../a/f0";\nexport const user = a0;\n' }, (dir) => {
      git(dir, "mv", "src/a", "src/z");
      write(dir, { "src/b/user.ts": 'import { a0 } from "../z/f0";\nexport const user = a0;\n' });
    });
    const structure = await structureOf(root);
    expect(structure.verdict).toBe("changed");
    expect(statuses(structure.groups.items)).toEqual(["RENAMED core/a -> core/z"]);
    expect(structure.groups.edges).toEqual([]);
    expect(structure.groups.movedFiles).toEqual([]);
    expect(structure.units.items).toEqual([]);
    expect(structure.renames.complete).toBe(true);
    expect(structure.renames.mapped).toBe(4);
  });

  it("reads a split at dice 0.6 as a renamed group, an added group and moved files", async () => {
    const root = repository(many("a", 5), (dir) => {
      for (let index = 0; index < 3; index += 1) move(dir, `src/a/f${index}.ts`, `src/a1/f${index}.ts`);
      for (let index = 3; index < 5; index += 1) move(dir, `src/a/f${index}.ts`, `src/a2/f${index}.ts`);
      write(dir, many("a1", 2, 10));
    });
    const { groups } = await structureOf(root);
    expect(statuses(groups.items)).toEqual(["RENAMED core/a -> core/a1", "ADDED core/a2"]);
    expect(groups.movedFiles).toEqual([
      { file: "src/a2/f3.ts", from: "core/a", to: "core/a2" },
      { file: "src/a2/f4.ts", from: "core/a", to: "core/a2" },
    ]);
  });

  it("reads a merge at dice 0.4 as a removed group, a changed group and moved files", async () => {
    const root = repository({ ...many("b", 5), ...many("c", 15) }, (dir) => {
      for (let index = 0; index < 5; index += 1) move(dir, `src/b/f${index}.ts`, `src/c/m${index}.ts`);
    });
    const { groups, verdict } = await structureOf(root);
    expect(verdict).toBe("changed");
    expect(statuses(groups.items)).toEqual(["REMOVED core/b", "CHANGED core/c"]);
    expect(groups.movedFiles).toHaveLength(5);
    expect(groups.movedFiles[0]).toMatchObject({ from: "core/b", to: "core/c" });
  });

  it("counts a file moved and rewritten beyond Git's similarity as removed + added, with the warning", async () => {
    const root = repository({ ...many("a", 4), ...many("b", 4), "src/a/big.ts": source("original", "x".repeat(300)) }, (dir) => {
      git(dir, "rm", "-q", "src/a/big.ts");
      write(dir, { "src/b/big.ts": `export const other = ${JSON.stringify("completely different ".repeat(20))};\n` });
    });
    const structure = await structureOf(root);
    expect(structure.renames.mapped).toBe(0);
    expect(structure.groups.movedFiles).toEqual([]);
    expect(statuses(structure.groups.items)).toEqual(["CHANGED core/a", "CHANGED core/b"]);
    // Both groups keep their majority of files: no removed + added item, so nothing a missed move could hide.
    expect(structure.warnings).toEqual([]);
  });

  it("reads a unit renamed by the config as a renamed unit, with the definition warning and unmoved groups", async () => {
    const root = repository(many("a", 3), (dir) => write(dir, { "graphit.architecture.json": JSON.stringify({ elements: { app: { path: "src/" } }, rules: [] }) }));
    const structure = await structureOf(root, "feature", ["graphit.architecture.json"]);
    expect(statuses(structure.units.items)).toEqual(["RENAMED core -> app"]);
    // Group keys start with the unit key: they follow it, none is added, removed or moved.
    expect(statuses(structure.groups.items)).toEqual(["RENAMED core/a -> app/a", "RENAMED core/keep -> app/keep"]);
    expect(structure.groups.movedFiles).toEqual([]);
    expect(structure.warnings).toEqual(["Units differ in definition between base and head (elements added: app; elements removed: core): units are matched by file overlap, not by name."]);
  });

  it("maps a case-only rename (R100) instead of reading a removed and an added file", async () => {
    const root = repository({ "src/Only.ts": source("only") }, (dir) => {
      git(dir, "mv", "src/Only.ts", "src/tmp.ts");
      git(dir, "mv", "src/tmp.ts", "src/only.ts");
    });
    const structure = await structureOf(root);
    expect(structure.renames).toEqual({ mapped: 1, complete: true });
    expect(structure.verdict).toBe("unchanged");
    // Without rename information the same branch reads as another folder group.
    const blind = await structureOf(root, "feature", [], host(root, false));
    expect(blind.verdict).toBe("changed");
    expect(blind.warnings[0]).toContain("Git rename detection is unavailable");
  });

  it("reports a rename-only working tree, and an untracked file as added", async () => {
    const root = repository(many("a", 4), () => undefined);
    git(root, "checkout", "-q", "main");
    git(root, "mv", "src/a", "src/q");
    write(root, { "src/q/untracked.ts": source("untracked") });
    const structure = await structureOf(root, "HEAD");
    expect(statuses(structure.groups.items)).toEqual(["RENAMED core/a -> core/q"]);
    expect(structure.groups.items[0].fileCount).toEqual({ before: 4, after: 5 });
  });

  it("keeps the structure of a branch with no structural change, unchanged, with compared sizes", async () => {
    const root = repository(many("a", 3), (dir) => write(dir, { "README.md": "docs\n" }));
    const structure = await structureOf(root);
    expect(structure.verdict).toBe("unchanged");
    expect(structure.groups.compared).toMatchObject({ items: { before: 2, after: 2 }, unchangedItems: 2 });
    expect(structure.warnings).toEqual([]);
  });

  it("is present without any config, and leaves the architecture review absent", async () => {
    const root = repository({ ...many("a", 3), "graphit.architecture.json": null }, (dir) => write(dir, many("b", 2)));
    const result = reviewArchitecture(await readReviewTrees(host(root), "main", "feature"), [], { base: "main", head: "feature" });
    expect(result.review).toBeUndefined();
    expect(result.structure?.verdict).toBeDefined();
  });

  it("does not run the rules check a second time to read the structure", async () => {
    const root = repository(many("a", 3), (dir) => write(dir, many("b", 1)));
    const spy = vi.spyOn(rules, "checkArchitecture");
    await readReviewTrees(host(root), "main", "feature");
    // The rules are checked once per side that has a config, through checkGraphArchitecture.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });

  it("explains a base built from the head config when the base config is invalid, and fails on an invalid head", async () => {
    const invalidBase = repository({ ...many("a", 3), "graphit.architecture.json": "{ not json" }, (dir) => write(dir, { "graphit.architecture.json": JSON.stringify(CONFIG) }));
    const structure = await structureOf(invalidBase, "feature", ["graphit.architecture.json"]);
    expect(structure.warnings[0]).toContain("base config refused (graphit.architecture.json: $: not valid JSON");
    expect(structure.verdict).toBe("unchanged");

    const invalidHead = repository(many("a", 3), (dir) => write(dir, { "graphit.architecture.json": "{ not json" }));
    await expect(readReviewTrees(host(invalidHead), "main", "feature")).rejects.toBeInstanceOf(ArchitectureReviewError);
    await expect(readReviewTrees(host(invalidHead), "main", "feature")).rejects.toThrow(/^feature: graphit\.architecture\.json: \$: not valid JSON/);
  });

  it("fails on a corrupt baseline at the head, and tolerates one at the base", async () => {
    const corruptHead = repository(many("a", 2), (dir) => write(dir, { "graphit.architecture.baseline.json": "{ nope" }));
    await expect(readReviewTrees(host(corruptHead), "main", "feature")).rejects.toThrow(/^feature: graphit\.architecture\.baseline\.json/);
    const corruptBase = repository({ ...many("a", 2), "graphit.architecture.baseline.json": "{ nope" }, (dir) => write(dir, { "graphit.architecture.baseline.json": JSON.stringify({ version: 1, violations: [] }) }));
    const trees = await readReviewTrees(host(corruptBase), "main", "feature");
    // Only the baseline is refused: a limitation, the base config (none here) kept, no definition warning.
    expect(trees.limitations.some((line) => line.startsWith("main: graphit.architecture.baseline.json") && line.endsWith("the base baseline is ignored, so its accepted violations count as found at the base."))).toBe(true);
    expect((await structureOf(corruptBase)).warnings.some((warning) => warning.includes("config refused"))).toBe(false);
  });

  it("keeps a valid base config when only the base baseline is refused, and caps a quoted config error", async () => {
    const config = JSON.stringify({ elements: { core: { path: "src/" } }, rules: [] });
    const baselineOnly = repository({ ...many("a", 2), "graphit.architecture.json": config, "graphit.architecture.baseline.json": "{ nope" },
      (dir) => write(dir, { "graphit.architecture.baseline.json": JSON.stringify({ version: 1, violations: [] }) }));
    const trees = await readReviewTrees(host(baselineOnly), "main", "feature");
    expect(trees.base.config?.elements).toHaveProperty("core");
    expect(trees.base.structure?.configFrom).toBe("own");
    const longKey = "k".repeat(1000);
    const invalidBase = repository({ ...many("a", 2), "graphit.architecture.json": JSON.stringify({ elements: { [longKey]: 1 } }) },
      (dir) => write(dir, { "graphit.architecture.json": config }));
    const [warning] = (await structureOf(invalidBase)).warnings;
    expect(warning).toContain("base config refused (");
    expect(warning.length).toBeLessThan(500);
  });

  it("compares the same with a host that cannot read renames, and says so", async () => {
    const root = repository(many("a", 3), (dir) => git(dir, "mv", "src/a", "src/z"));
    const structure = await structureOf(root, "feature", [], host(root, false));
    expect(structure.renames.complete).toBe(false);
    expect(structure.warnings.some((warning) => warning.startsWith("Git rename detection is unavailable"))).toBe(true);
  });

  it("passes the same base to the tree read and to the rename read: an explicit head uses the merge base", async () => {
    const root = repository(many("a", 3), (dir) => write(dir, many("b", 1)));
    git(root, "checkout", "-q", "main");
    write(root, many("m", 1));
    git(root, "add", "-A");
    git(root, "commit", "-m", "main moves on");
    const base = host(root);
    const seen: { tree: string[]; renames: [string, string | undefined][] } = { tree: [], renames: [] };
    await readReviewTrees({
      ...base,
      withRefTree: (ref, read) => { seen.tree.push(ref); return base.withRefTree(ref, read); },
      renames: (from, to) => { seen.renames.push([from, to]); return base.renames!(from, to); },
    }, "main", "feature");
    const mergeBase = await base.mergeBase("main", "feature");
    expect(seen.tree).toContain(mergeBase);
    expect(seen.renames).toEqual([[mergeBase, "feature"]]);
    // The working tree head: the base ref itself, no head ref.
    seen.renames.length = 0;
    await readReviewTrees({ ...base, renames: (from, to) => { seen.renames.push([from, to]); return base.renames!(from, to); } }, "main", "HEAD");
    expect(seen.renames).toEqual([["main", undefined]]);
  });
});
