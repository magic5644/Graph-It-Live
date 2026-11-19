import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * The file-system reads of one unresolved-import report, each made once: a workspace's imports point into the
 * same folders and files, read thousands of times otherwise (#774). Lives for one report only, so it never serves
 * a stale read.
 */
export class ReportReads {
  private readonly names = new Map<string, string[]>();
  private readonly folders = new Map<string, boolean>();
  private readonly texts = new Map<string, Promise<string | null>>();

  /** The file names of `dir`, none when it cannot be read. */
  fileNames(dir: string): readonly string[] {
    let names = this.names.get(dir);
    if (names === undefined) {
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch {
        names = [];
      }
      this.names.set(dir, names);
    }
    return names;
  }

  /** Whether `dir` is a readable folder; any stat error (ENOENT, ENOTDIR, EACCES) means no. */
  isDirectory(dir: string): boolean {
    let found = this.folders.get(dir);
    if (found === undefined) {
      try {
        // No exception for the common miss: most probed folders do not exist.
        found = fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
      } catch {
        found = false;
      }
      this.folders.set(dir, found);
    }
    return found;
  }

  /** The text of `file`, null when it cannot be read; one copy however many imports it holds. */
  text(file: string): Promise<string | null> {
    let text = this.texts.get(file);
    if (text === undefined) {
      text = fsp.readFile(file, "utf8").catch(() => null);
      this.texts.set(file, text);
    }
    return text;
  }
}
