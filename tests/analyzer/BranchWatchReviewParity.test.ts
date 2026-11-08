import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BranchWatchAnalyzer } from "@/analyzer/BranchWatchAnalyzer";
import { ReviewGateAnalyzer, type ReviewGateResult } from "@/analyzer/ReviewGateAnalyzer";
import { Spider } from "@/analyzer/Spider";
import { createSpiderDependentsProvider } from "@/mcp/tools/impact";
import { REACT_CORPUS, REACT_REVIEW_BASE, REACT_REVIEW_FILE } from "./react/reactCorpus";

type Files = Record<string, string | null>;

const roots: string[] = [];
const spiders: Spider[] = [];
afterEach(async () => {
  await Promise.all(spiders.splice(0).map((spider) => spider.dispose()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function write(root: string, files: Files): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    if (content === null) {
      await fs.rm(target);
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
}

/** A branch off `main` with `head` saved but not committed, as Branch Watch sees an editor session. */
async function scratch(base: Files, head: Files): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-parity-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "--initial-branch=main");
  git("config", "user.email", "parity@example.com");
  git("config", "user.name", "Parity");
  await write(root, base);
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  await write(root, head);
  return root;
}

/** What both surfaces must agree on; cycles are Branch Watch's own extra, so their limitations are left out. */
function comparable(review: ReviewGateResult) {
  return {
    changedFiles: review.changedFiles,
    symbols: review.symbols.map((symbol) => ({
      name: symbol.name, filePath: symbol.filePath, score: symbol.score,
      changes: symbol.breakingChanges.map((change) => `${change.type}:${change.severity}`),
      consumers: symbol.consumers, exhaustiveConsumers: symbol.exhaustiveConsumers, testCandidates: symbol.testCandidates,
      evidence: symbol.evidence,
    })),
    limitations: review.limitations.filter((limitation) => !/import[- ]cycle/i.test(limitation)),
    isPartial: review.limitations.some((limitation) => !/import[- ]cycle/i.test(limitation)),
  };
}

async function bothReviews(base: Files, head: Files) {
  const root = await scratch(base, head);
  const spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true });
  spiders.push(spider);
  await spider.buildFullIndex();
  const reviewPr = await new ReviewGateAnalyzer(root, createSpiderDependentsProvider(spider, root, process.cwd())).analyze({ baseRef: "main" });
  const branchWatch = new BranchWatchAnalyzer(root, spider, process.cwd());
  const watched = await branchWatch.analyze(await branchWatch.capture("main"));
  return { reviewPr: comparable(reviewPr), branchWatch: comparable(watched.review) };
}

const API_TS = "export function value(n: number): number { return n; }\n";

/** Regression (#546): Branch Watch filtered the diff before the review, so it reviewed less than review-pr. */
describe("Branch Watch and review-pr review the same diff alike (#546)", { timeout: 60_000 }, () => {
  it("retains proven JSX consumers when a component loses an optional parameter (#576)", async () => {
    const { reviewPr, branchWatch } = await bothReviews(REACT_REVIEW_BASE, { [REACT_REVIEW_FILE]: REACT_CORPUS[REACT_REVIEW_FILE] });
    expect(branchWatch).toEqual(reviewPr);
    const card = reviewPr.symbols.find((s) => s.name === "Card")!;
    expect(card.consumers.unverified.sort()).toEqual(["src/Fancy.tsx", "src/Old.jsx", "src/Page.tsx"]);
    expect(card.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "impact", detail: expect.stringContaining("src/Page.tsx:14") }),
      expect.objectContaining({ kind: "partial", detail: expect.stringContaining("props-contract compatibility is not checked") }),
    ]));
    expect(card.evidence.some((e) => e.kind === "unused-export")).toBe(false);
    expect(card.evidence.find((e) => e.kind === "consumers")?.detail).toContain("require manual review");
  });

  it("retains Vue template-only consumers when a handler loses an optional parameter (#645)", async () => {
    const base = {
      "src/format.ts": "export function format(n = 0): string { return String(n); }\n",
      "src/Page.vue": '<script setup lang="ts">\nimport { format } from "./format";\n</script>\n\n<template>\n  <button @click="format">x</button>\n</template>\n',
      "src/Total.vue": '<template>\n  <p>{{ format(1) }}</p>\n</template>\n<script setup lang="ts">\nimport { format } from "./format";\n</script>\n',
    };
    const { reviewPr, branchWatch } = await bothReviews(base, { "src/format.ts": "export function format(): string { return \"\"; }\n" });
    expect(branchWatch).toEqual(reviewPr);
    const format = reviewPr.symbols.find((s) => s.name === "format")!;
    expect([...format.consumers.updated, ...format.consumers.covered, ...format.consumers.unverified].sort()).toEqual(["src/Page.vue", "src/Total.vue"]);
    expect(format.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "impact", detail: expect.stringContaining("src/Page.vue:6") }),
      expect.objectContaining({ kind: "partial", detail: expect.stringContaining("Vue props/emits compatibility is not checked") }),
    ]));
    expect(reviewPr.limitations.join(" ")).toContain("Vue props/emits");
  });

  describe("Vue props/emits contract evidence (#646)", () => {
    const child = (script: string) => `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n  <p>{{ label }}</p>\n</template>\n`;
    const base = {
      "src/Child.vue": child("defineProps(['label', 'size']);\ndefineEmits(['save']);"),
      "src/Parent.vue": '<script setup lang="ts">\nimport Child from "./Child.vue";\nfunction onSave(): void {}\n</script>\n\n<template>\n  <Child label="x" :size="1" @save="onSave" />\n</template>\n',
    };

    it("names the props and events added or removed, and the template consumers, alike on both surfaces", async () => {
      const { reviewPr, branchWatch } = await bothReviews(base, { "src/Child.vue": child("defineModel('size');\ndefineProps(['label']);\ndefineEmits(['save', 'close']);") });
      expect(branchWatch).toEqual(reviewPr);
      const contract = reviewPr.symbols.find((s) => s.name === "Child.props")!;
      // `size` stays a prop through defineModel, which adds its `update:size` event.
      expect(contract.changes).toEqual([]);
      expect(contract.evidence.filter((e) => e.kind === "impact" && e.detail.endsWith(" added")).map((e) => e.detail)).toEqual(["event 'close' added", "event 'update:size' added"]);

      const removed = await bothReviews(base, { "src/Child.vue": child("defineProps<{ label: string }>();\ndefineEmits<{ (e: 'close'): void }>();") });
      expect(removed.branchWatch).toEqual(removed.reviewPr);
      const symbol = removed.reviewPr.symbols.find((s) => s.name === "Child.props")!;
      // The typed head form is also compared member by member by the signature analysis.
      expect(symbol.evidence.filter((e) => e.kind === "breaking-change").map((e) => e.detail)).toEqual(expect.arrayContaining(["prop 'size' removed", "event 'save' removed"]));
      expect(symbol.evidence.filter((e) => e.kind === "impact" && e.detail.endsWith(" added")).map((e) => e.detail)).toEqual(["event 'close' added"]);
      expect(symbol.consumers.unverified).toEqual(["src/Parent.vue"]);
      expect(symbol.evidence.find((e) => e.kind === "consumers")?.detail).toContain("src/Parent.vue");
      expect(removed.reviewPr.isPartial).toBe(false);
    });

    it("marks a contract typed by an imported type as partial, and ignores an unchanged contract", async () => {
      const partial = await bothReviews({ ...base, "src/props.ts": "export interface ChildProps { label: string }\n" }, {
        "src/Child.vue": child("import type { ChildProps } from './props';\ndefineProps<ChildProps>();\ndefineEmits(['save']);"),
      });
      expect(partial.branchWatch).toEqual(partial.reviewPr);
      expect(partial.reviewPr.limitations.join(" ")).toContain("src/Child.vue: Vue props/emits contract read in part (props are typed by 'ChildProps', not declared in this file)");
      expect(partial.reviewPr.symbols.find((s) => s.name === "Child.props")?.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "partial", detail: expect.stringContaining("read in part") }),
      ]));

      const unchanged = await bothReviews(base, { "src/Child.vue": child("defineProps(['label', 'size']);\ndefineEmits(['save']);\nconst local = 1;") });
      expect(unchanged.reviewPr.symbols.some((s) => s.name === "Child.props")).toBe(false);
    });
  });

  it.each<{
    name: string; base: Files; head: Files;
    expected: { name: string; consumers?: string[]; exhaustive?: string[]; tests?: string[]; limitation?: string };
  }>([
    ...["js", "ts"].map((extension) => ({
      name: `a ${extension} callback with a removed optional parameter`,
      base: { [`src/api.${extension}`]: `export function value(n=0) { return n; }\n`, [`src/consumer.${extension}`]: `import { value } from './api';\nregister(value);\n` },
      head: { [`src/api.${extension}`]: `export function value() { return 0; }\n` },
      expected: { name: "value", consumers: [`src/consumer.${extension}`] },
    })),
    {
      name: "a TypeScript signature change",
      base: { "src/api.ts": API_TS, "src/consumer.ts": 'import { value } from "./api";\nexport const result = value(1);\n' },
      head: { "src/api.ts": "export function value(n: string): number { return n.length; }\n" },
      expected: { name: "value", consumers: ["src/consumer.ts"] },
    },
    {
      name: "a widened union",
      base: {
        "src/lang.ts": 'export type Lang = "a" | "b";\n',
        "src/use.ts": 'import type { Lang } from "./lang";\nexport const names: Record<Lang, string> = { a: "A", b: "B" };\n',
        "tests/use.test.ts": 'import { names } from "../src/use";\nexport const first = names.a;\n',
      },
      head: { "src/lang.ts": 'export type Lang = "a" | "b" | "c";\n' },
      expected: { name: "Lang", consumers: ["src/use.ts"], exhaustive: ["src/use.ts"], tests: ["tests/use.test.ts"] },
    },
    {
      name: "a Python callback with a removed optional parameter",
      base: { "pkg/__init__.py": "", "pkg/api.py": `def value(n=0):\n    return n\n`, "pkg/consumer.py": `from .api import value\nregister(value)\n` },
      head: { "pkg/api.py": `def value():\n    return 0\n` },
      expected: { name: "value", consumers: ["pkg/consumer.py"] },
    },
    {
      name: "a Python-only signature change",
      base: { "pkg/__init__.py": "", "pkg/api.py": "def value(n):\n    return n\n", "pkg/consumer.py": "from .api import value\nresult = value(1)\n" },
      head: { "pkg/api.py": "def value(n, m):\n    return n\n" },
      expected: { name: "value", consumers: ["pkg/consumer.py"] },
    },
    {
      name: "a deleted module",
      base: { "src/api.ts": API_TS, "src/consumer.ts": 'import { value } from "./api";\nexport const result = value(1);\n' },
      head: { "src/api.ts": null },
      expected: { name: "value", consumers: ["src/consumer.ts"] },
    },
    {
      name: "an unreadable file beside a readable change",
      base: { "src/api.ts": API_TS, "src/odd.ts": "export const odd = 1;\n" },
      head: { "src/api.ts": "export function value(n: string): number { return n.length; }\n", "src/odd.ts": "export const odd = 1;\0\n" },
      expected: { name: "value", limitation: "Could not compare src/odd.ts; File is binary." },
    },
  ])("$name", async ({ base, head, expected }) => {
    const { reviewPr, branchWatch } = await bothReviews(base, head);
    expect(branchWatch).toEqual(reviewPr);
    expect(reviewPr.limitations.join(" ")).not.toContain("props-contract");
    // Parity on an empty review would prove nothing: each case must find what it is about.
    const symbol = reviewPr.symbols.find((candidate) => candidate.name === expected.name);
    expect(symbol).toBeDefined();
    if (expected.consumers) {
      expect([...symbol!.consumers.updated, ...symbol!.consumers.covered, ...symbol!.consumers.unverified]).toEqual(expected.consumers);
    }
    if (expected.limitation) expect(reviewPr.limitations).toContain(expected.limitation);
    if (expected.exhaustive) expect(symbol!.exhaustiveConsumers).toEqual(expected.exhaustive);
    if (expected.tests) expect(symbol!.testCandidates).toEqual(expected.tests);
  });
});

/** #605: Branch Watch read cycles in a walk bounded by maxFiles; it now reads the same whole graphs as review-pr. */
describe("Branch Watch and review-pr report the same import cycles (#605)", { timeout: 60_000 }, () => {
  const ring = (from: string, to: string) => `import { ${to} } from "./${to}";\nexport const ${from} = ${to};\n`;
  it.each<{ name: string; base: Files; head: Files; expected: string }>([
    {
      name: "a cycle introduced across more files than maxFiles",
      base: { "src/a.ts": ring("a", "b"), "src/b.ts": ring("b", "c"), "src/c.ts": "export const c = 1;\n" },
      head: { "src/c.ts": ring("c", "a") },
      expected: "introduced",
    },
    {
      name: "an existing cycle aggravated by a modified file",
      base: { "src/a.ts": ring("a", "b"), "src/b.ts": ring("b", "a"), "src/c.ts": "export const c = 1;\n" },
      head: { "src/b.ts": `import { a } from "./a";\nimport { c } from "./c";\nexport const b = a + c;\n`, "src/c.ts": ring("c", "b") },
      expected: "aggravated",
    },
  ])("$name", async ({ base, head, expected }) => {
    const root = await scratch(base, head);
    const spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true });
    spiders.push(spider);
    await spider.buildFullIndex();
    const reviewPr = await new ReviewGateAnalyzer(root, createSpiderDependentsProvider(spider, root, process.cwd())).analyze({ baseRef: "main" });
    const branchWatch = new BranchWatchAnalyzer(root, spider, process.cwd(), "git", 1);
    const watched = await branchWatch.analyze(await branchWatch.capture("main"));
    const watchedCycles = watched.cycles.filter((cycle) => cycle.classification !== "existing-touched")
      .map(({ classification, nodePaths, changedPaths }) => ({ classification, files: nodePaths, changedFiles: changedPaths }));
    expect(watchedCycles).toEqual(reviewPr.cycles);
    expect(reviewPr.cycles.map((cycle) => cycle.classification)).toEqual([expected]);
    expect(watched.cycleSummary).toEqual({ detected: 1, scopeComplete: true });
    expect(watched.limitations.join(" ")).not.toMatch(/affected-scope limit|baseline limit/);
  });
});
