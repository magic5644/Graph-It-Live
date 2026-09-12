import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectChangedFiles,
  getQueryFreshnessCutoffs,
  type IndexedFileRecord,
} from "@/analyzer/callgraph/GraphExtractor";
import type { SupportedLang } from "@/shared/callgraph-types";

const noCutoffs = {
  typescript: 0,
  javascript: 0,
  python: 0,
  rust: 0,
  csharp: 0,
  go: 0,
  java: 0,
} satisfies Record<SupportedLang, number>;

describe("getQueryFreshnessCutoffs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cutoffs-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports each language's query file mtime", () => {
    const queryDir = path.join(tmpDir, "dist", "queries");
    fs.mkdirSync(queryDir, { recursive: true });
    fs.writeFileSync(path.join(queryDir, "python.scm"), "(x)");

    return getQueryFreshnessCutoffs(tmpDir).then((cutoffs) => {
      expect(cutoffs.python).toBeGreaterThan(0);
      // JavaScript shares the TypeScript query file.
      expect(cutoffs.javascript).toBe(cutoffs.typescript);
    });
  });

  it("falls back to 0 for a missing query file instead of throwing", async () => {
    const cutoffs = await getQueryFreshnessCutoffs(tmpDir);

    expect(cutoffs.typescript).toBe(0);
    expect(cutoffs.rust).toBe(0);
  });
});

describe("collectChangedFiles", () => {
  let tmpDir: string;

  const write = (name: string): string => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, "export const x = 1;\n");
    return filePath;
  };

  const freshRecord = (filePath: string, indexedAt = Date.now()): IndexedFileRecord => ({
    lastModified: Math.floor(fs.statSync(filePath).mtimeMs),
    indexedAt,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-changed-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("queues a file that was never indexed", async () => {
    const filePath = write("a.ts");

    const { jobs, skipped } = await collectChangedFiles([filePath], () => null, noCutoffs);

    expect(jobs).toEqual([expect.objectContaining({ filePath, lang: "typescript" })]);
    expect(skipped).toBe(0);
  });

  it("skips a file whose record is still fresh", async () => {
    const filePath = write("a.ts");
    const record = freshRecord(filePath);

    const { jobs, skipped } = await collectChangedFiles([filePath], () => record, noCutoffs);

    expect(jobs).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("queues a file modified since it was indexed", async () => {
    const filePath = write("a.ts");
    const record = { lastModified: 0, indexedAt: Date.now() };

    const { jobs } = await collectChangedFiles([filePath], () => record, noCutoffs);

    expect(jobs).toHaveLength(1);
  });

  it("queues a fresh file whose language query has since been updated", async () => {
    const filePath = write("a.ts");
    const record = freshRecord(filePath, 1_000);

    const { jobs } = await collectChangedFiles([filePath], () => record, {
      ...noCutoffs,
      typescript: 2_000,
    });

    expect(jobs).toHaveLength(1);
  });

  it("skips unsupported extensions and unreadable paths", async () => {
    const unsupported = path.join(tmpDir, "notes.md");
    fs.writeFileSync(unsupported, "# hi");
    const missing = path.join(tmpDir, "gone.ts");

    const { jobs, skipped } = await collectChangedFiles(
      [unsupported, missing],
      () => null,
      noCutoffs,
    );

    expect(jobs).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("honors a custom language resolver", async () => {
    const filePath = write("a.ts");

    const { jobs } = await collectChangedFiles([filePath], () => null, noCutoffs, () => "python");

    expect(jobs[0].lang).toBe("python");
  });

  it("processes more files than a single stat batch", async () => {
    const files = Array.from({ length: 70 }, (_, i) => write(`f${i}.ts`));

    const { jobs } = await collectChangedFiles(files, () => null, noCutoffs);

    expect(jobs).toHaveLength(70);
  });
});
