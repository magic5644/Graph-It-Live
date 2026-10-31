import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkText, isMissingFile, MAX_TEXT_FILE_BYTES, readWorkspaceText, resolveRegularFile } from "@/analyzer/utils/workspaceText";

describe("workspaceText", () => {
  let root: string;
  let outside: string;
  let symlinks = true;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-text-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-text-outside-"));
    await fs.mkdir(path.join(root, "src", "folder"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "ok.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(root, "src", "binary.ts"), "export const b = 1;\0");
    await fs.writeFile(path.join(root, "src", "big.ts"), "x".repeat(MAX_TEXT_FILE_BYTES + 1));
    await fs.writeFile(path.join(root, "src", "limit.ts"), "x".repeat(MAX_TEXT_FILE_BYTES));
    await fs.writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    try {
      await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src", "out.ts"));
      await fs.symlink(path.join(root, "src", "ok.ts"), path.join(root, "src", "in.ts"));
      await fs.symlink(path.join(root, "src", "missing-target.ts"), path.join(root, "src", "dangling.ts"));
    } catch {
      symlinks = false; // Windows runners may lack the symlink privilege.
    }
  });

  afterAll(async () => {
    await Promise.all([root, outside].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it("reads a regular text file, up to the size limit included", async () => {
    await expect(readWorkspaceText(root, path.join(root, "src", "ok.ts"))).resolves.toBe("export const ok = 1;\n");
    await expect(readWorkspaceText(root, path.join(root, "src", "limit.ts"))).resolves.toHaveLength(MAX_TEXT_FILE_BYTES);
    await expect(resolveRegularFile(root, path.join(root, "src", "ok.ts"))).resolves.toBe(path.join(root, "src", "ok.ts"));
  });

  it.each([
    ["a binary file", ["src", "binary.ts"], "File is binary."],
    ["an oversized file", ["src", "big.ts"], "File exceeds the 2 MiB size limit."],
    ["a folder", ["src", "folder"], "File is not a regular file."],
  ])("refuses %s", async (_case, segments, message) => {
    await expect(readWorkspaceText(root, path.join(root, ...segments))).rejects.toThrow(message);
  });

  it.each([
    ["out.ts", "a link leaving the workspace"],
    ["in.ts", "a link staying inside it"],
    ["dangling.ts", "a link whose target is missing, which is not a missing file"],
  ])("refuses the symbolic link %s (%s)", async (file) => {
    if (!symlinks) return;
    await expect(readWorkspaceText(root, path.join(root, "src", file))).rejects.toThrow("File is a symbolic link or resolves outside the workspace.");
  });

  it("refuses a file outside the workspace", async () => {
    await expect(resolveRegularFile(root, path.join(outside, "secret.ts"))).rejects.toThrow("resolves outside the workspace");
  });

  it.each([
    ["a missing file", ["src", "missing.ts"], true],
    ["a path under a file", ["src", "ok.ts", "child.ts"], true],
    ["a binary file", ["src", "binary.ts"], false],
  ])("tells %s apart as missing or not", async (_case, segments, missing) => {
    const error = await readWorkspaceText(root, path.join(root, ...segments)).catch((caught: unknown) => caught);
    expect(isMissingFile(error)).toBe(missing);
  });

  it.each([
    [null, false],
    [undefined, false],
    [new Error("plain"), false],
    [Object.assign(new Error("gone"), { code: "ENOENT" }), true],
    [Object.assign(new Error("not a folder"), { code: "ENOTDIR" }), true],
    [Object.assign(new Error("denied"), { code: "EACCES" }), false],
  ])("isMissingFile(%s) is %s", (error, expected) => {
    expect(isMissingFile(error)).toBe(expected);
  });

  it.each([
    ["text", "export const a = 1;\n", undefined],
    ["multi-byte text at the limit", "é".repeat(MAX_TEXT_FILE_BYTES / 2), undefined],
    ["multi-byte text past the limit in bytes, not in characters", "é".repeat(MAX_TEXT_FILE_BYTES / 2 + 1), "File exceeds the 2 MiB size limit."],
    ["binary content", "a\0b", "File is binary."],
  ])("checkText accepts or refuses %s", (_case, content, error) => {
    if (error) expect(() => checkText(content)).toThrow(error);
    else expect(checkText(content)).toBe(content);
  });
});
