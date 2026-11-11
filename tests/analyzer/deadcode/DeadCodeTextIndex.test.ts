import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadCodeTextIndex } from "@/analyzer/deadcode/DeadCodeTextIndex";
import { FileReader } from "@/analyzer/FileReader";
import { normalizePath } from "@/shared/path";

describe("DeadCodeTextIndex", () => {
  let root: string;
  let reader: FileReader;
  let index: DeadCodeTextIndex;
  const write = async (relative: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "gitl-textindex-"));
    reader = new FileReader();
    index = new DeadCodeTextIndex(reader);
    await write("src/loader.ts", "export const load = (n: string) => import(`./plugins/${n}`);\n");
    await write("src/plain.ts", "export const x = 1;\n");
    await write("rs/main.rs", "mod complete;\nfn main() { complete::bash::generate(); }\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("collects computed loads, Rust qualified paths and Rust identifiers of the workspace", async () => {
    const facts = await index.collect(root, true);

    expect(facts.loads).toEqual([{ at: "src/loader.ts:1", scope: normalizePath(path.join(root, "src/plugins")) }]);
    expect([...facts.rustPaths].sort()).toEqual(["bash::generate", "complete::bash"]);
    expect(facts.rustTokenFiles.get("generate")).toBe(1);
    expect(facts.rustTokenFiles.has("load")).toBe(false);
  });

  it("reads a file again only when its mtime or size changed, and forgets deleted files", async () => {
    await index.collect(root, true);
    const read = vi.spyOn(reader, "readFile");

    await index.collect(root, true);
    expect(read).not.toHaveBeenCalled();

    await write("src/plain.ts", "export const x = await import(name);\n");
    await fs.rm(path.join(root, "src/loader.ts"));
    const facts = await index.collect(root, true);

    expect(read.mock.calls.map(([file]) => path.basename(file))).toEqual(["plain.ts"]);
    expect(facts.loads).toEqual([{ at: "src/plain.ts:1", scope: normalizePath(path.join(root, "src")) }]);
  });

  it("reads a file above the default size cap, and skips an unreadable one without failing", async () => {
    const read = vi.spyOn(reader, "readFile");
    read.mockImplementation(async (file, options) => {
      if (path.basename(file) === "plain.ts") throw new Error("EACCES");
      expect(options).toEqual({ maxSize: Number.POSITIVE_INFINITY });
      return fs.readFile(file, "utf8");
    });

    const facts = await index.collect(root, true);

    expect(facts.loads).toHaveLength(1);
  });

  it("starts over for another root, with paths relative to it", async () => {
    await index.collect(root, true);
    const other = await fs.mkdtemp(path.join(tmpdir(), "gitl-textindex-other-"));
    try {
      await fs.writeFile(path.join(other, "a.ts"), "require(name);\n");
      expect((await index.collect(other, true)).loads).toEqual([{ at: "a.ts:1", scope: normalizePath(other) }]);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("collects module.name pairs of deployment manifests only, lock files and sources aside (#698)", async () => {
    await write("deploy/serverless.yml", "functions:\n  api:\n    handler: src/handler.main\n");
    await write("Dockerfile.lambda", 'CMD ["app.lambda_handler"]\n');
    await write("Procfile", "web: uvicorn api:app\n");
    await write("pnpm-lock.yaml", "lock.only: 1\n");
    await write("src/code.ts", "export const x = other.thing;\n");

    const { deployReferences } = await index.collect(root, true);

    expect(deployReferences.has("handler.main")).toBe(true);
    expect(deployReferences.has("app.lambda_handler")).toBe(true);
    expect(deployReferences.has("api.app")).toBe(true);
    expect(deployReferences.has("lock.only")).toBe(false);
    expect(deployReferences.has("other.thing")).toBe(false);
  });

  it("marks the published packages without exports the workspace imports by deep path (#698)", async () => {
    await write("packages/kit/package.json", '{"name":"@acme/kit"}');
    await write("packages/priv/package.json", '{"name":"@acme/priv","private":true}');
    await write("packages/mapped/package.json", '{"name":"@acme/mapped","exports":"./index.js"}');
    await write("packages/lone/package.json", '{"name":"@acme/lone"}');
    await write("app/use.ts", "import '@acme/kit/util';\nimport '@acme/priv/x';\nimport '@acme/mapped/y';\nimport '@acme/lone';\n");
    await write("app/notes.py", "x = '@acme/lone/z'\n");

    const { packageDeepImport } = await index.collect(root, true);
    const dir = (relative: string) => normalizePath(path.join(root, relative));

    expect(packageDeepImport.get(dir("packages/kit"))).toBe(true);
    expect(packageDeepImport.get(dir("packages/priv"))).toBe(false);
    expect(packageDeepImport.get(dir("packages/mapped"))).toBe(false);
    expect(packageDeepImport.get(dir("packages/lone"))).toBe(false);
  });

  it("lists the Python files that read attributes by computed name", async () => {
    await write("py/reader.py", "x = getattr(mod, name)\n");
    await write("py/plain.py", "x = getattr(mod, 'static')\n");

    const { computedAttributeReaders } = await index.collect(root, true);

    expect([...computedAttributeReaders]).toEqual([normalizePath(path.join(root, "py/reader.py"))]);
  });

  it("reads package.json and tsconfig.json again when they change, and warns on a broken manifest (#696)", async () => {
    const declared = async () => [...(await index.collect(root, true)).entryPoints.keys()].map((file) => path.relative(root, file).replaceAll("\\", "/")).sort();
    await write("src/a.ts", "export const a = 1;\n");
    await write("src/b.ts", "export const b = 1;\n");
    await write("package.json", JSON.stringify({ name: "p", main: "src/a.js" }));
    expect(await declared()).toEqual(["src/a.ts"]);

    // Same size, new mtime: read again.
    await write("package.json", JSON.stringify({ name: "p", main: "src/b.js" }));
    await fs.utimes(path.join(root, "package.json"), new Date(), new Date(Date.now() + 5_000));
    expect(await declared()).toEqual(["src/b.ts"]);

    // The tsconfig layout is read on every scan.
    await write("package.json", JSON.stringify({ name: "p", main: "out/a.js" }));
    expect(await declared()).toEqual([]);
    await write("tsconfig.json", "{ // build\n \"compilerOptions\": { \"outDir\": \"out\", \"rootDir\": \"src\" } }\n");
    expect(await declared()).toEqual(["src/a.ts"]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await write("package.json", "{ broken");
    expect(await declared()).toEqual([]);
    warn.mockRestore();
  });

  it("collects __all__, pub mod and Rust entry attributes into entry points (#696)", async () => {
    await write("Cargo.toml", "[package]\nname = \"c\"\n");
    await write("src/lib.rs", "pub mod api;\n");
    await write("src/api.rs", "pub fn f() {}\n");
    await write("src/ffi.rs", "#[no_mangle]\npub fn ffi() {}\n");
    await write("py/pkg/__init__.py", "__all__ = ['x']\n");
    const { entryPoints } = await index.collect(root, true);
    const of = (relative: string) => entryPoints.get(normalizePath(path.join(root, relative)));
    expect(of("src/api.rs")?.get("*")).toBe("declared:Cargo.toml#lib");
    expect(of("src/ffi.rs")?.get("ffi")).toBe("attribute:#[no_mangle]");
    expect(of("py/pkg/__init__.py")?.get("x")).toBe("declared:py/pkg/__init__.py#__all__");
  });
});
