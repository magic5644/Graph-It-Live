import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReverseIndex } from "../../src/analyzer/ReverseIndex";
import type { Dependency } from "../../src/analyzer/types";
import { normalizePath } from "../../src/shared/path";

/**
 * validateIndex() historically only checked files it had already indexed, so a
 * file created on disk since the index was written stayed invisible. The CLI has
 * no file watcher to compensate, so it passes the on-disk file list explicitly.
 */
describe("ReverseIndex.validateIndex with filesOnDisk", () => {
  let tmpDir: string;
  let index: ReverseIndex;

  const write = (name: string, content = "export const x = 1;\n"): string => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const deps = (targetPath: string): Dependency[] => [
    { path: targetPath, type: "import", line: 1, module: "./target" },
  ];

  /** Index a file the way SpiderDependencyAnalyzer does: with its on-disk hash. */
  const indexFile = async (filePath: string, targetPath: string): Promise<void> => {
    const hash = await ReverseIndex.getFileHashFromDisk(filePath);
    index.addDependencies(filePath, deps(targetPath), hash ?? undefined);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-validate-"));
    index = new ReverseIndex(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a never-indexed file on disk as stale", async () => {
    const target = write("target.ts");
    const indexed = write("a.ts");
    await indexFile(indexed, target);
    const created = write("brand-new.ts");

    const result = await index.validateIndex(0.6, [indexed, created]);

    // The index stores normalized paths: forward slashes and a lowercased
    // Windows drive letter. Compare in that form, not in the raw OS form.
    expect(result.staleFiles).toContain(normalizePath(created));
    expect(result.missingFiles).toHaveLength(0);
  });

  it("leaves already-indexed unchanged files out of staleFiles", async () => {
    const target = write("target.ts");
    const indexed = write("a.ts");
    await indexFile(indexed, target);

    const result = await index.validateIndex(0.2, [indexed]);

    expect(result.staleFiles).toHaveLength(0);
    expect(result.isValid).toBe(true);
    expect(result.stalePercentage).toBe(0);
  });

  it("counts new files in the denominator instead of inflating the ratio", async () => {
    const target = write("target.ts");
    const onDisk: string[] = [];
    for (let i = 0; i < 9; i++) {
      const filePath = write(`f${i}.ts`);
      await indexFile(filePath, target);
      onDisk.push(filePath);
    }
    onDisk.push(write("new.ts"));

    const result = await index.validateIndex(0.2, onDisk);

    // 1 new file out of 10 considered — under the 20% threshold.
    expect(result.stalePercentage).toBeCloseTo(0.1, 5);
    expect(result.isValid).toBe(true);
  });

  it("rejects the index when too many files are new", async () => {
    const target = write("target.ts");
    const indexed = write("a.ts");
    await indexFile(indexed, target);

    const result = await index.validateIndex(0.2, [indexed, write("b.ts"), write("c.ts")]);

    expect(result.isValid).toBe(false);
    expect(result.staleFiles).toHaveLength(2);
  });

  it("still reports deleted files as missing", async () => {
    const target = write("target.ts");
    const gone = write("gone.ts");
    await indexFile(gone, target);
    fs.rmSync(gone);

    const result = await index.validateIndex(0.2, []);

    expect(result.missingFiles).toEqual([normalizePath(gone)]);
  });

  // Windows path handling, runnable on every OS: filesOnDisk comes straight from
  // the caller, so the drive-letter case and the separator style must not decide
  // whether a file counts as already indexed. These cases need no filesystem —
  // the "already indexed?" check is a pure lookup against the normalized keys.
  describe("Windows-shaped input paths", () => {
    const WIN_ROOT = "C:\\proj";
    let winIndex: ReverseIndex;

    beforeEach(() => {
      winIndex = new ReverseIndex(WIN_ROOT);
      winIndex.addDependencies(
        "C:\\proj\\src\\a.ts",
        [{ path: "C:\\proj\\src\\target.ts", type: "import", line: 1, module: "./target" }],
        { mtime: 1, size: 1 },
      );
    });

    it("treats a backslash path as the file already indexed under its normalized key", async () => {
      const result = await winIndex.validateIndex(1, ["C:\\proj\\src\\a.ts"]);

      expect(result.staleFiles).not.toContain("c:/proj/src/a.ts");
      expect(result.staleFiles).toHaveLength(0);
    });

    it("matches whatever the case of the drive letter is", async () => {
      // The index was populated through an uppercase "C:"; a lowercase "c:" must
      // resolve to the same entry. Only the drive letter is case-folded — the rest
      // of the path is left alone, which is what normalizePath() guarantees.
      const result = await winIndex.validateIndex(1, ["c:\\proj\\src\\a.ts"]);

      expect(result.staleFiles).toHaveLength(0);
    });

    it("reports an unknown Windows path as stale in normalized form", async () => {
      const result = await winIndex.validateIndex(1, ["C:\\proj\\src\\b.ts"]);

      expect(result.staleFiles).toEqual(["c:/proj/src/b.ts"]);
    });

    it("accepts forward-slash input for the same file", async () => {
      const result = await winIndex.validateIndex(1, ["c:/proj/src/a.ts"]);

      expect(result.staleFiles).toHaveLength(0);
    });
  });

  it("behaves exactly as before when filesOnDisk is omitted", async () => {
    const target = write("target.ts");
    const indexed = write("a.ts");
    await indexFile(indexed, target);
    write("invisible-without-the-list.ts");

    const result = await index.validateIndex(0.2);

    expect(result.staleFiles).toHaveLength(0);
    expect(result.isValid).toBe(true);
  });
});
