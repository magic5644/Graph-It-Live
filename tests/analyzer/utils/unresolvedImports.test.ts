import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withUnresolvedImports } from "@/analyzer/deadcode/DeadCodeScanner";
import type { UnreferencedFile } from "@/analyzer/deadcode/deadCodeConfidence";
import {
  describeUnresolvedImports,
  nearestExistingDir,
  reportUnresolvedImports,
  EXCLUDED_IMPORTS_NEXT,
  locateUnfollowedImports,
  UNRESOLVED_IMPORTS_NEXT,
  unresolvedImportsField,
  unresolvedImportsReaching,
  type UnresolvedImport,
} from "@/analyzer/utils/unresolvedImports";
import { normalizePath } from "@/shared/path";

const ROOT = "/repo";
const loader: UnresolvedImport = { importer: "/repo/src/loader.ts", specifier: "./gen", reach: "/repo/src" };

describe("unresolvedImports (#774)", () => {
  describe("nearestExistingDir", () => {
    let root: string;
    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "graph-it-reach-")));
      fs.mkdirSync(path.join(root, "src", "a"), { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("is the target's folder when it exists", () => {
      expect(nearestExistingDir(path.join(root, "src/a/x.generated"), root)).toBe(normalizePath(path.join(root, "src/a")));
    });

    it("climbs out of missing folders, never above the root", () => {
      expect(nearestExistingDir(path.join(root, "src/__generated__/deep/index"), root)).toBe(normalizePath(path.join(root, "src")));
      expect(nearestExistingDir(path.join(root, "gone/x"), root)).toBe(normalizePath(root));
      expect(nearestExistingDir(path.join(root, "x"), root)).toBe(normalizePath(root));
    });
  });

  it("reports the count, examples sorted and capped at 5, and what to do", () => {
    const imports = ["f", "e", "d", "c", "b", "a"].map((name) => ({ ...loader, importer: `/repo/src/${name}.ts` }));

    const report = reportUnresolvedImports(imports, ROOT);

    expect(report.count).toBe(6);
    expect(report.examples.map(({ file }) => file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(report.next).toBe(UNRESOLVED_IMPORTS_NEXT);
  });

  it("ranks the examples by the files each import may hide, most first", () => {
    const imports = [
      { importer: "/repo/a/template.ts", specifier: "../../vitest.config" },
      { ...loader, reachFiles: 965 },
      { importer: "/repo/b/x.ts", specifier: "./small", reach: "/repo/b", reachFiles: 2 },
    ];

    expect(reportUnresolvedImports(imports, ROOT).examples.map(({ specifier }) => specifier)).toEqual(["./gen", "./small", "../../vitest.config"]);
  });

  it("reports 0 with no examples and no next when everything resolves", () => {
    const empty = { count: 0, examples: [], excludedCount: 0, excludedExamples: [] };
    expect(reportUnresolvedImports([], ROOT)).toEqual(empty);
    expect(describeUnresolvedImports(empty)).toBeNull();
  });

  it("describes one or several imports in one line, with the importing files", () => {
    expect(describeUnresolvedImports(reportUnresolvedImports([loader], ROOT))).toBe(
      "1 import of workspace files resolves to no file (e.g. src/loader.ts imports ./gen). Dead-file and unused-export " +
        `results may list files they would import. ${UNRESOLVED_IMPORTS_NEXT}`,
    );
    const two = describeUnresolvedImports(reportUnresolvedImports([loader, { ...loader, specifier: "@/gen/x" }], ROOT));
    expect(two).toContain("2 imports of workspace files resolve to no file (e.g. src/loader.ts imports ./gen, src/loader.ts imports @/gen/x)");
  });

  it("counts and describes the imports of excluded files apart, with their own next step", () => {
    const report = reportUnresolvedImports([loader, { ...loader, specifier: "./ignored", excluded: true }], ROOT);

    expect(report).toEqual({
      count: 1,
      examples: [{ file: "src/loader.ts", specifier: "./gen" }],
      excludedCount: 1,
      excludedExamples: [{ file: "src/loader.ts", specifier: "./ignored" }],
      next: `${UNRESOLVED_IMPORTS_NEXT} ${EXCLUDED_IMPORTS_NEXT}`,
    });
    expect(describeUnresolvedImports(report)).toContain(
      "1 import resolves to a file excluded from the analysis (.gitignore, .graphitignore or a default exclusion), whose own imports are not followed (e.g. src/loader.ts imports ./ignored).",
    );
    const onlyExcluded = reportUnresolvedImports([{ ...loader, excluded: true }], ROOT);
    expect(onlyExcluded.next).toBe(EXCLUDED_IMPORTS_NEXT);
    expect(describeUnresolvedImports(onlyExcluded)).not.toContain("to no file");
  });

  describe("locateUnfollowedImports", () => {
    let root: string;
    beforeEach(() => {
      root = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "graph-it-locate-"))));
      fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectOf = () => `${root}/app`;
    const indexed = () => [`${root}/app/src/a.ts`, `${root}/app/src/b.ts`, `${root}/app/x.ts`];

    it("reaches the nearest existing folder inside the importer's project, and counts the files below it", () => {
      const located = locateUnfollowedImports([{ importer: `${root}/app/src/a.ts`, specifier: "./gen/x", target: `${root}/app/src/gen/x` }], root, indexed(), projectOf);

      expect(located).toEqual([{ importer: `${root}/app/src/a.ts`, specifier: "./gen/x", reach: `${root}/app/src`, reachFiles: 2 }]);
    });

    it("never reaches for data or asset files, nor above the importer's project folder", () => {
      const located = locateUnfollowedImports([
        { importer: `${root}/app/src/a.ts`, specifier: "./seed.json", target: `${root}/app/src/seed.json` },
        { importer: `${root}/app/src/a.ts`, specifier: "./logo.SVG", target: `${root}/app/src/logo.SVG` },
        { importer: `${root}/app/src/a.ts`, specifier: "../../vitest.config", target: `${root}/vitest.config` },
      ], root, indexed(), projectOf);

      expect(located.map((item) => item.reach)).toEqual([undefined, undefined, undefined]);
    });

    it("reaches the folder of an excluded file", () => {
      const located = locateUnfollowedImports([{ importer: `${root}/app/src/a.ts`, specifier: "./b.gen", target: `${root}/app/src/b.gen.ts`, excluded: true }], root, indexed(), projectOf);

      expect(located).toEqual([{ importer: `${root}/app/src/a.ts`, specifier: "./b.gen", excluded: true, reach: `${root}/app/src`, reachFiles: 2 }]);
    });
  });

  it("is a field only when tracked: none without a reverse index", () => {
    expect(unresolvedImportsField(null, ROOT)).toEqual({});
    expect(unresolvedImportsField([loader], ROOT).unresolvedImports?.count).toBe(1);
  });

  it("reaches the files below the missing target's folder, not the importer, nor a sibling folder sharing a prefix", () => {
    expect(unresolvedImportsReaching("/repo/src/resolvers/users.ts", [loader])).toEqual([loader]);
    expect(unresolvedImportsReaching("/repo/src/loader.ts", [loader])).toEqual([]);
    expect(unresolvedImportsReaching("/repo/src-old/users.ts", [loader])).toEqual([]);
    expect(unresolvedImportsReaching("/repo/lib/users.ts", [loader])).toEqual([]);
    expect(unresolvedImportsReaching("/repo/src/resolvers/users.ts", [{ ...loader, reach: undefined }])).toEqual([]);
  });

  it("matches Windows paths once normalized", () => {
    const win: UnresolvedImport = { importer: normalizePath(String.raw`C:\repo\src\loader.ts`), specifier: "./gen", reach: normalizePath(String.raw`C:\repo\src`) };

    expect(unresolvedImportsReaching(String.raw`C:\repo\src\resolvers\users.ts`, [win])).toEqual([win]);
  });

  describe("withUnresolvedImports", () => {
    const file = (confidence: UnreferencedFile["confidence"], filePath = "/repo/src/resolvers/users.ts"): UnreferencedFile => ({
      filePath,
      exports: 1,
      confidence,
      reasons: ["no-importer"],
      evidence: { importers: 0, firstImporters: [] },
    });

    it.each([["high", "medium"], ["medium", "low"], ["low", "low"]] as const)("lowers %s to %s and gives the reason", (from, to) => {
      expect(withUnresolvedImports(file(from), [loader])).toMatchObject({ confidence: to, reasons: ["no-importer", "unresolved-import-in-workspace"] });
    });

    it("gives the excluded-importer reason for an excluded file, both when both reach it", () => {
      expect(withUnresolvedImports(file("low"), [{ ...loader, excluded: true }]).reasons).toEqual(["no-importer", "excluded-importer-in-workspace"]);
      expect(withUnresolvedImports(file("medium"), [loader, { ...loader, excluded: true }])).toMatchObject({
        confidence: "low",
        reasons: ["no-importer", "unresolved-import-in-workspace", "excluded-importer-in-workspace"],
      });
    });

    it("leaves a file no missing target may import unchanged", () => {
      const outside = file("medium", "/repo/lib/x.ts");

      expect(withUnresolvedImports(outside, [loader])).toBe(outside);
      expect(withUnresolvedImports(outside, [])).toBe(outside);
    });
  });
});
