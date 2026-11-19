import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDeadCode, scanUnreferencedFiles } from "@/analyzer/deadcode/DeadCodeScanner";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
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

  // An extensionless import of a data file, and a case variant of a source file, resolve to an existing file.
  it("never reports an import whose base name exists with another extension or case", async () => {
    fs.writeFileSync(path.join(root, "backend/src/settings.json"), "{}\n");
    fs.writeFileSync(path.join(root, "backend/src/extra.ts"), 'import cfg from "./settings";\nimport { users } from "./resolvers/Users";\nexport const x = [cfg, users];\n');
    const spider = await indexed();

    const specifiers = (await spider.getUnresolvedImports())?.map(({ specifier }) => specifier);
    expect(specifiers).not.toContain("./settings");
    expect(specifiers).not.toContain("./resolvers/Users");
  }, 60_000);

  it("is unknown (null) without a reverse index", async () => {
    const spider = new SpiderBuilder().withRootDir(root).withReverseIndex(false).build();

    expect(await spider.getUnresolvedImports()).toBeNull();
  });
});
