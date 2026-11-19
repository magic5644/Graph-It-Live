import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDeadCode, scanUnreferencedFiles } from "@/analyzer/deadcode/DeadCodeScanner";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { normalizePath } from "@/shared/path";

const FIXTURE = path.resolve(__dirname, "../../fixtures/unresolved-generated-import");
const GENERATED = "src/resolvers.generated.ts";

/**
 * #774: a loader imports a git-ignored generated file that a fresh clone does not have. The import is reported,
 * and the files the missing file would import keep their verdict at a lower confidence, with the reason.
 */
describe("unresolved import of a generated file (#774)", () => {
  let root: string;
  const spiders: Array<{ dispose(): Promise<void> }> = [];

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

  it("reports the relative import of the absent file, never the packages, on every scan", async () => {
    const spider = await indexed();

    expect(await spider.getUnresolvedImports()).toEqual([
      { importer: normalizePath(path.join(root, "src/loader.ts")), specifier: "./resolvers.generated", reach: normalizePath(path.join(root, "src")) },
    ]);
    const report = {
      count: 1,
      examples: [{ file: "src/loader.ts", specifier: "./resolvers.generated" }],
      next: "Run the build or codegen that emits the missing files, or add the importing files to .graphitignore.",
    };
    const files = await scanUnreferencedFiles(spider, root, {});
    expect(files.unresolvedImports).toEqual(report);
    expect((await scanDeadCode(spider, root, {})).unresolvedImports).toEqual(report);
    // The dead-file count stays: only the confidence and the reasons say why it may be wrong.
    expect(files.unreferencedFiles.map(({ relativePath, confidence, reasons }) => ({ relativePath, confidence, reasons }))).toEqual([
      { relativePath: "src/resolvers/orders.ts", confidence: "low", reasons: ["no-importer", "unresolved-import-in-workspace"] },
      { relativePath: "src/resolvers/users.ts", confidence: "low", reasons: ["no-importer", "unresolved-import-in-workspace"] },
    ]);
  }, 60_000);

  it("reports nothing, and lists no dead resolver, once the codegen has emitted the file", async () => {
    fs.writeFileSync(
      path.join(root, GENERATED),
      'export async function resolvers() {\n  return { orders: (await import("./resolvers/orders")).orders, users: (await import("./resolvers/users")).users };\n}\n',
    );
    const spider = await indexed();

    expect(await spider.getUnresolvedImports()).toEqual([]);
    const files = await scanUnreferencedFiles(spider, root, {});
    expect(files.unresolvedImports).toEqual({ count: 0, examples: [] });
    expect(files.unreferencedFiles).toEqual([]);
  }, 60_000);

  it("re-resolves the unchanged importer on a warm run, when the file appears or disappears", async () => {
    const spider = await indexed();
    const sources = () => ["src/server.ts", "src/loader.ts", "src/resolvers/orders.ts", "src/resolvers/users.ts", GENERATED]
      .map((file) => path.join(root, file))
      .filter((file) => fs.existsSync(file));

    fs.writeFileSync(path.join(root, GENERATED), 'export const resolvers = async () => ({ users: (await import("./resolvers/users")).users });\n');
    const added = await spider.validateReverseIndex(1, sources());
    expect(added?.staleFiles.map(normalizePath)).toEqual(expect.arrayContaining([GENERATED, "src/loader.ts"].map((file) => normalizePath(path.join(root, file)))));
    await spider.reindexStaleFiles(added!.staleFiles);
    expect(await spider.getUnresolvedImports()).toEqual([]);

    fs.rmSync(path.join(root, GENERATED));
    const removed = await spider.validateReverseIndex(1, sources());
    expect(removed?.staleFiles.map(normalizePath)).toEqual([normalizePath(path.join(root, "src/loader.ts"))]);
    for (const deleted of removed!.missingFiles) spider.handleFileDeleted(deleted);
    await spider.reindexStaleFiles(removed!.staleFiles);
    expect((await spider.getUnresolvedImports())?.map(({ specifier }) => specifier)).toEqual(["./resolvers.generated"]);
  }, 60_000);

  it("is unknown (null) without a reverse index", async () => {
    const spider = new SpiderBuilder().withRootDir(root).withReverseIndex(false).build();

    expect(await spider.getUnresolvedImports()).toBeNull();
  });
});
