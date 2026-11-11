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

  it("lists the Python files that read attributes by computed name", async () => {
    await write("py/reader.py", "x = getattr(mod, name)\n");
    await write("py/plain.py", "x = getattr(mod, 'static')\n");

    const { computedAttributeReaders } = await index.collect(root, true);

    expect([...computedAttributeReaders]).toEqual([normalizePath(path.join(root, "py/reader.py"))]);
  });
});
