import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Largest text file the review and Branch Watch read. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = "File exceeds the 2 MiB size limit.";

/**
 * `absolutePath` when it is a regular file inside `root`, not a symbolic link, within the size limit.
 * Throws with the reason otherwise; a missing file keeps its `ENOENT` code.
 */
export async function resolveRegularFile(root: string, absolutePath: string): Promise<string> {
  // `lstat` first: a dangling link is refused as a link, not read as a missing file by `realpath`.
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) throw new Error("File is a symbolic link or resolves outside the workspace.");
  const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(absolutePath)]);
  const relative = path.relative(rootReal, fileReal);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("File is a symbolic link or resolves outside the workspace.");
  }
  if (!stat.isFile()) throw new Error("File is not a regular file.");
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(TOO_LARGE);
  return absolutePath;
}

/** `content` when it is bounded text; throws when it is too large or binary. */
export function checkText(content: string): string {
  if (Buffer.byteLength(content) > MAX_TEXT_FILE_BYTES) throw new Error(TOO_LARGE);
  if (content.includes("\0")) throw new Error("File is binary.");
  return content;
}

/** Text of a regular workspace file (see `resolveRegularFile`); throws when unsafe, too large or binary. */
export async function readWorkspaceText(root: string, absolutePath: string): Promise<string> {
  const content = await fs.readFile(await resolveRegularFile(root, absolutePath));
  // Checked again on the bytes read: the file may have grown since `lstat`.
  if (content.length > MAX_TEXT_FILE_BYTES) throw new Error(TOO_LARGE);
  if (content.includes(0)) throw new Error("File is binary.");
  return content.toString("utf8");
}

/** Whether a read failed only because the file does not exist (`ENOTDIR`: a parent folder became a file). */
export function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
