import fs from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../../shared/concurrency";
import { getRelativePath, normalizePath } from "../../shared/path";
import type { FileReader } from "../FileReader";
import { SourceFileCollector } from "../SourceFileCollector";
import {
  findDynamicLoads,
  mayLoadDynamically,
  readsComputedAttribute,
  rustQualifiedPaths,
  type DynamicLoad,
} from "./deadCodeConfidence";

const READ_CONCURRENCY = 16;
const RUST_FILE = /\.rs$/i;
const PYTHON_FILE = /\.pyi?$/i;

interface FileFacts {
  mtimeMs: number;
  size: number;
  loads: DynamicLoad[];
  rustPaths: string[];
  rustTokens: string[];
  readsComputedAttribute: boolean;
}

/** What the dead-code scan reads as text across the workspace. */
export interface WorkspaceTextFacts {
  /** Modules loaded by computed path */
  loads: DynamicLoad[];
  /** Every `qualifier::name` pair written in a Rust file */
  rustPaths: ReadonlySet<string>;
  /** How many Rust files write each identifier */
  rustTokenFiles: ReadonlyMap<string, number>;
  /** Python files that read attributes by computed name (`getattr(mod, name)`), absolute normalized */
  computedAttributeReaders: ReadonlySet<string>;
}

/**
 * Facts the dead-code scan reads from the text of every workspace file, no parse: modules loaded by computed
 * path, and Rust identifiers and qualified paths. The Rust symbol analysis follows calls through `use` and
 * `mod` only: a type used in a signature, `Type::new()`, a nested grouped `use` or a path such as
 * `complete::bash::generate()` from a file that never imports bash.rs leave no edge, so the scan keeps a Rust
 * export whose name another Rust file writes at medium confidence at most.
 * A file is read again only when its mtime or size changed, so a single-file check does not reread the workspace.
 */
export class DeadCodeTextIndex {
  private rootDir = "";
  private perFile = new Map<string, FileFacts>();

  constructor(private readonly fileReader: FileReader) {}

  async collect(rootDir: string, excludeNodeModules: boolean): Promise<WorkspaceTextFacts> {
    const root = normalizePath(path.resolve(rootDir));
    // Evidence paths are relative to this root: another root starts over.
    if (root !== this.rootDir) {
      this.rootDir = root;
      this.perFile = new Map();
    }
    const files = (await new SourceFileCollector({ excludeNodeModules }).collectAllSourceFiles(rootDir)).map(normalizePath);
    const next = new Map<string, FileFacts>();
    const facts = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
      const entry = await this.factsOf(file);
      if (entry) next.set(file, entry);
      return entry;
    });
    this.perFile = next;
    const present = facts.filter((entry): entry is FileFacts => entry !== null);
    const computedAttributeReaders = new Set([...next].filter(([, entry]) => entry.readsComputedAttribute).map(([file]) => file));
    const rustTokenFiles = new Map<string, number>();
    for (const token of present.flatMap((entry) => entry.rustTokens)) rustTokenFiles.set(token, (rustTokenFiles.get(token) ?? 0) + 1);
    return { loads: present.flatMap((entry) => entry.loads), rustPaths: new Set(present.flatMap((entry) => entry.rustPaths)), rustTokenFiles, computedAttributeReaders };
  }

  private async factsOf(file: string): Promise<FileFacts | null> {
    try {
      const { mtimeMs, size } = await fs.stat(file);
      const cached = this.perFile.get(file);
      if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached;
      // No size cap: a large file's loads and names count as much as any other's (read once, then cached).
      const content = await this.fileReader.readFile(file, { maxSize: Number.POSITIVE_INFINITY });
      const loads = mayLoadDynamically(content) ? findDynamicLoads(file, getRelativePath(file, this.rootDir), content, this.rootDir) : [];
      const rust = RUST_FILE.test(file);
      return {
        mtimeMs,
        size,
        loads,
        rustPaths: rust ? rustQualifiedPaths(content) : [],
        rustTokens: rust ? [...new Set(content.match(/\b[A-Za-z_]\w*\b/g))] : [],
        readsComputedAttribute: PYTHON_FILE.test(file) && readsComputedAttribute(content),
      };
    } catch {
      // Deleted or unreadable: it holds no code the scan could miss.
      return null;
    }
  }
}
