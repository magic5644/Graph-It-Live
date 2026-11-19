import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanDeadCode, scanUnreferencedFiles } from "@/analyzer/deadcode/DeadCodeScanner";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { EXCLUDED_IMPORTS_NEXT, UNRESOLVED_IMPORTS_NEXT } from "@/analyzer/utils/unresolvedImports";
import { normalizePath } from "@/shared/path";

const FIXTURE = path.resolve(__dirname, "../../fixtures/unresolved-generated-import");
const GENERATED = "backend/src/resolvers.generated.ts";
const LOADER = "backend/src/loader.ts";
const GENERATED_CONTENT =
  'export async function resolvers() {\n  return { orders: (await import("./resolvers/orders")).orders, users: (await import("./resolvers/users")).users };\n}\n';

/**
 * #774: a loader imports a git-ignored generated file that a fresh clone does not have. The import is reported,
 * and the files the missing file would import keep their verdict at a lower confidence, with the reason. A template's
 * import escaping its project and a missing JSON file are counted, but flag no dead file.
 */
describe("unresolved import of a generated file (#774)", () => {
  let root: string;
  const spiders: Array<{ dispose(): Promise<void> }> = [];
  const at = (file: string) => normalizePath(path.join(root, file));

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "graph-it-unresolved-")));
    fs.cpSync(FIXTURE, root, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(spiders.splice(0).map((spider) => spider.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function indexed() {
    const spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    spiders.push(spider);
    await spider.buildFullIndex();
    return spider;
  }

  const verdicts = async (spider: Awaited<ReturnType<typeof indexed>>) =>
    (await scanUnreferencedFiles(spider, root, {})).unreferencedFiles.map(({ relativePath, confidence, reasons }) => ({ relativePath, confidence, reasons }));

  it("reports the missing imports, never the packages, and flags only the generated loader's folder", async () => {
    const spider = await indexed();

    expect(await spider.getUnresolvedImports()).toEqual([
      { importer: at(LOADER), specifier: "./resolvers.generated", reach: at("backend/src"), reachFiles: 4 },
      { importer: at("backend/template/setup.ts"), specifier: "../../vitest.config" },
      { importer: at("backend/template/setup.ts"), specifier: "./data/seed.json" },
    ]);
    const report = {
      count: 3,
      // The loader may hide the most files: first.
      examples: [
        { file: LOADER, specifier: "./resolvers.generated" },
        { file: "backend/template/setup.ts", specifier: "../../vitest.config" },
        { file: "backend/template/setup.ts", specifier: "./data/seed.json" },
      ],
      excludedCount: 0,
      excludedExamples: [],
      caseMismatchCount: 0,
      caseMismatchExamples: [],
      notAnalyzedCount: 0,
      notAnalyzedExamples: [],
      next: UNRESOLVED_IMPORTS_NEXT,
    };
    const files = await scanUnreferencedFiles(spider, root, {});
    expect(files.unresolvedImports).toEqual(report);
    expect((await scanDeadCode(spider, root, {})).unresolvedImports).toEqual(report);
    // The dead-file count stays: only the confidence and the reasons say why it may be wrong.
    expect(await verdicts(spider)).toEqual([
      { relativePath: "backend/src/resolvers/orders.ts", confidence: "low", reasons: ["no-importer", "unresolved-import-in-workspace"] },
      { relativePath: "backend/src/resolvers/users.ts", confidence: "low", reasons: ["no-importer", "unresolved-import-in-workspace"] },
      { relativePath: "backend/template/setup.ts", confidence: "low", reasons: ["no-importer"] },
    ]);
  }, 60_000);

  it("lists no dead resolver once the codegen has emitted the file", async () => {
    fs.writeFileSync(path.join(root, GENERATED), GENERATED_CONTENT);
    const spider = await indexed();

    expect((await spider.getUnresolvedImports())?.map(({ specifier }) => specifier)).toEqual(["../../vitest.config", "./data/seed.json"]);
    expect(await verdicts(spider)).toEqual([{ relativePath: "backend/template/setup.ts", confidence: "low", reasons: ["no-importer"] }]);
  }, 60_000);

  it("reports an import of a file the root .gitignore excludes, and flags what that file may import", async () => {
    fs.writeFileSync(path.join(root, GENERATED), GENERATED_CONTENT);
    fs.writeFileSync(path.join(root, ".gitignore"), "*.generated.ts\n");
    const spider = await indexed();

    const report = (await scanUnreferencedFiles(spider, root, {})).unresolvedImports;
    expect(report).toMatchObject({ count: 2, excludedCount: 1, excludedExamples: [{ file: LOADER, specifier: "./resolvers.generated" }] });
    expect(report?.next).toBe(`${UNRESOLVED_IMPORTS_NEXT} ${EXCLUDED_IMPORTS_NEXT}`);
    expect((await verdicts(spider)).filter(({ relativePath }) => relativePath.includes("resolvers/"))).toEqual([
      { relativePath: "backend/src/resolvers/orders.ts", confidence: "low", reasons: ["no-importer", "excluded-importer-in-workspace"] },
      { relativePath: "backend/src/resolvers/users.ts", confidence: "low", reasons: ["no-importer", "excluded-importer-in-workspace"] },
    ]);
  }, 60_000);

  it("re-resolves the unchanged importer on a warm run, when the file appears or disappears", async () => {
    const spider = await indexed();
    const sources = () => ["backend/src/server.ts", LOADER, "backend/src/resolvers/orders.ts", "backend/src/resolvers/users.ts", "backend/template/setup.ts", GENERATED]
      .map((file) => path.join(root, file))
      .filter((file) => fs.existsSync(file));
    const generatedMissing = async () => (await spider.getUnresolvedImports())?.some(({ specifier }) => specifier === "./resolvers.generated");

    fs.writeFileSync(path.join(root, GENERATED), 'export const resolvers = async () => ({ users: (await import("./resolvers/users")).users });\n');
    const added = await spider.validateReverseIndex(1, sources());
    expect(added?.staleFiles.map(normalizePath)).toEqual(expect.arrayContaining([at(GENERATED), at(LOADER)]));
    await spider.reindexStaleFiles(added!.staleFiles);
    expect(await generatedMissing()).toBe(false);

    fs.rmSync(path.join(root, GENERATED));
    const removed = await spider.validateReverseIndex(1, sources());
    expect(removed?.staleFiles.map(normalizePath)).toEqual([at(LOADER)]);
    for (const deleted of removed!.missingFiles) spider.handleFileDeleted(deleted);
    await spider.reindexStaleFiles(removed!.staleFiles);
    expect(await generatedMissing()).toBe(true);
  }, 60_000);

  // Neither import gets an indexed edge on any OS. `./settings` with settings.json: no edge (JSON is no analysed
  // source). `./resolvers/Users` with users.ts: an edge to a path the index lacks on macOS/Windows, none on Linux.
  // Both are reported, each with its own wording, the same on every OS.
  it("reports an import matching only a file not analyzed, and one differing only in letter case", async () => {
    fs.writeFileSync(path.join(root, "backend/src/settings.json"), "{}\n");
    fs.writeFileSync(path.join(root, "backend/src/extra.ts"), 'import cfg from "./settings";\nimport { users } from "./resolvers/Users";\nexport const x = [cfg, users];\n');
    const spider = await indexed();

    const report = (await scanUnreferencedFiles(spider, root, {})).unresolvedImports;
    expect(report).toMatchObject({
      notAnalyzedCount: 1,
      notAnalyzedExamples: [{ file: "backend/src/extra.ts", specifier: "./settings", existing: "backend/src/settings.json" }],
      caseMismatchCount: 1,
      caseMismatchExamples: [{ file: "backend/src/extra.ts", specifier: "./resolvers/Users", existing: "backend/src/resolvers/users.ts" }],
    });
    expect(report && "next" in report ? report.next : "").toContain("letter case");
  }, 60_000);

  // Regression (#774 bench): init asks for the report twice (unused exports, then dead files); it was computed twice,
  // with a resolution per import and file each time. One run per index state now, and no file is parsed again.
  it("computes the report once per index state, without parsing a file again", async () => {
    const spider = await indexed();
    const resolve = vi.spyOn(PathResolver.prototype, "localTargetOf");
    const parse = vi.spyOn(Parser.prototype, "parseImports");

    await scanDeadCode(spider, root, {});
    const once = resolve.mock.calls.length;
    await scanUnreferencedFiles(spider, root, {});
    expect(once).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledTimes(once);
    expect(parse).not.toHaveBeenCalled();

    // A new index state is a new report: the emitted file resolves the loader's import.
    fs.writeFileSync(path.join(root, GENERATED), GENERATED_CONTENT);
    const stale = await spider.validateReverseIndex(1, [path.join(root, GENERATED)]);
    await spider.reindexStaleFiles(stale!.staleFiles);
    expect((await spider.getUnresolvedImports())?.some(({ specifier }) => specifier === "./resolvers.generated")).toBe(false);
    expect(resolve.mock.calls.length).toBeGreaterThan(once);
  }, 60_000);

  it("computes a failed report again on the next call", async () => {
    const spider = await indexed();
    vi.spyOn(PathResolver.prototype, "localTargetOf").mockRejectedValueOnce(new Error("disk gone"));

    await expect(spider.getUnresolvedImports()).rejects.toThrow("disk gone");
    expect((await spider.getUnresolvedImports())?.length).toBe(3);
  }, 60_000);

  it("is unknown (null) without a reverse index", async () => {
    const spider = new SpiderBuilder().withRootDir(root).withReverseIndex(false).build();

    expect(await spider.getUnresolvedImports()).toBeNull();
  });
});
