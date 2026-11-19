import { type Dirent, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { normalizePath } from "../../shared/path";
import { isPathWithinRootCanonical } from "../../shared/pathSecurity";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { ReportReads } from "../utils/ReportReads";
import { createIgnoreMatcher, shouldSkipDirectory } from "../SourceFileFilters";
import { WasmParserFactory } from "./WasmParserFactory";

/** A listed .java file: normalized path, and its depth below the workspace root (1 = in the root). */
interface JavaFile {
  file: string;
  depth: number;
}

/** How old the .java file list may be when an import is found nowhere: a file created since may be the one (#774). */
const LISTING_TTL_MS = 5000;

/** The depth searched for a class file by name alone, whatever its folder (a layout not matching packages). */
const MAX_LAYOUT_DEPTH = 4;

/**
 * Java import parser backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class JavaParser implements ILanguageAnalyzer {
  private parser: Parser | null = null;
  private readonly fileReader: FileReader;
    private readonly rootDir: string;
  private readonly extensionPath?: string;
  private initPromise: Promise<void> | null = null;

    constructor(rootDir?: string, extensionPath?: string) {
    this.fileReader = new FileReader();
      this.rootDir = rootDir ?? process.cwd();
    this.extensionPath = extensionPath;
  }

  /** Lazily initializes the WASM parser and reuses a single init promise. */
  private async ensureInitialized(): Promise<void> {
    if (this.parser) {
      return;
    }

    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const extensionPath = this.extensionPath;
      if (!extensionPath) {
        throw new Error(
          "Extension path required for WASM parser initialization. " +
          "Ensure JavaParser is constructed with extensionPath parameter."
        );
      }

      try {
        const factory = WasmParserFactory.getInstance();

        const treeSitterWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter.wasm");
        await factory.init(treeSitterWasmPath);

        const javaWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter-java.wasm");
        this.parser = await factory.getParser("java", javaWasmPath);
      } catch (error) {
        this.initPromise = null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize Java WASM parser: ${errorMessage}`,
          { cause: error }
        );
      }
    })();

    return this.initPromise;
  }

  async parseImports(filePath: string): Promise<Dependency[]> {
    const actualPath = extractFilePath(filePath);

    let content: string;
    try {
      content = await this.fileReader.readFile(actualPath);
    } catch (error) {
      throw SpiderError.fromError(error, actualPath);
    }

    await this.ensureInitialized();

    if (!this.parser) {
      return [];
    }

    const tree = this.parser.parse(content);
    if (!tree) {
      return [];
    }
    try {
      const deps: Dependency[] = [];
      this.extractImports(tree.rootNode, actualPath, deps);
      return deps;
    } finally {
      tree.delete();
    }
  }

  /**
   * Extracts `import com.example.Class;` and `import static ...;` declarations.
   */
  private extractImports(node: Node, filePath: string, deps: Dependency[]): void {
    if (node.type === "import_declaration") {
      // import_declaration contains an identifier or scoped_identifier as the package path
      const nameNode = node.children.find(
        (c) => c.type === "identifier" || c.type === "scoped_identifier"
      );
      if (nameNode) {
        const specifier = nameNode.text.trim();
        if (specifier) {
          deps.push({
            path: normalizePath(filePath),
            type: "import",
            line: nameNode.startPosition.row + 1,
            module: specifier,
          });
        }
      }
    }

    for (const child of node.children) {
      this.extractImports(child, filePath, deps);
    }
  }

    /**
     * The class file an import names when its package is a folder of a source root above the importing file
     * (`src/main/java/com/acme/app` for `com.acme.app.Missing`), existing or not (#774). Null for the standard library,
     * package wildcards, lower-case class names, and packages the workspace lacks. A static import or a nested class
     * names its top-level class file.
     */
    async localTargetOf(fromFile: string, moduleSpecifier: string, reads = new ReportReads()): Promise<string | null> {
        const segments = this.classSegments(moduleSpecifier);
        // A class name starts upper case; a lower-case last segment is a package (`a.b.util`).
        if (!segments || segments.length < 2 || !/^[A-Z]/.test(segments.at(-1) ?? '')) {
            return null;
        }
        const packagePath = segments.slice(0, -1).join('/');
        const fromDir = this.folderInRoot(fromFile);
        if (fromDir === null) return null;
        // The files of a folder import the same packages: each folder climbs once per package and report.
        let packageDirs = this.packageDirs.get(reads);
        if (!packageDirs) {
            packageDirs = new Map();
            this.packageDirs.set(reads, packageDirs);
        }
        const key = `${fromDir}\0${packagePath}`;
        let packageDir = packageDirs.get(key);
        if (packageDir === undefined) {
            packageDir = this.foldersUpToRoot(fromDir).map((dir) => this.under(dir, packagePath)).find((dir) => reads.isDirectory(dir)) ?? null;
            packageDirs.set(key, packageDir);
        }
        return packageDir === null ? null : `${packageDir}/${segments.at(-1)}.java`;
    }

    /** The workspace root, normalized: computed once, not per import. */
    private normalizedRoot?: string;

    /** Per report, the nearest package folder found from a folder (`<folder>\0<package path>`). */
    private readonly packageDirs = new WeakMap<ReportReads, Map<string, string | null>>();

    private root(): string {
        this.normalizedRoot ??= normalizePath(path.resolve(this.rootDir));
        return this.normalizedRoot;
    }

    /** `relative` below `dir`, by string: no path resolution per import. */
    private under(dir: string, relative: string): string {
        return dir.endsWith('/') ? dir + relative : `${dir}/${relative}`;
    }

    /**
     * The normalized folder of `fromFile` when it lies in the workspace root, else null. String comparison: the
     * importing file is indexed, so no realpath, and no path resolution, for each of thousands of imports (#774).
     */
    private folderInRoot(fromFile: string): string | null {
        const root = this.root();
        const file = extractFilePath(fromFile);
        const fromDir = normalizePath(path.dirname(path.isAbsolute(file) ? file : path.resolve(file)));
        return fromDir === root || fromDir.startsWith(this.under(root, '')) ? fromDir : null;
    }

    /** `dir` and its parent folders up to the workspace root, nearest first; `dir` is in the root. */
    private foldersUpToRoot(dir: string): string[] {
        const root = this.root();
        const rootPrefix = this.under(root, '');
        const dirs = [dir];
        while (dir !== root) {
            const parent = dir.slice(0, dir.lastIndexOf('/'));
            dir = parent.startsWith(rootPrefix) ? parent : root;
            dirs.push(dir);
        }
        return dirs;
    }

    /**
     * The path segments of the class file an import names: up to its first upper-case segment, so a static import
     * (`a.b.Util.method`, `a.b.Util.*`) and a nested class (`a.b.Outer.Inner`) name their top-level class. Null for the
     * standard library, a package wildcard (`a.b.*`) and unsafe segments (path traversal).
     */
    private classSegments(moduleSpecifier: string): string[] | null {
        if (this.isJavaStdlibImport(moduleSpecifier)) return null;
        const wildcard = moduleSpecifier.endsWith('.*');
        const segments = (wildcard ? moduleSpecifier.slice(0, -2) : moduleSpecifier).split('.');
        if (segments.some(s => s === '' || s === '..' || s.includes('/') || s.includes('\\'))) return null;
        const classIndex = segments.findIndex((s) => /^[A-Z]/.test(s));
        if (classIndex < 0) return wildcard ? null : segments;
        return segments.slice(0, classIndex + 1);
    }

    async resolvePath(fromFile: string, moduleSpecifier: string): Promise<string | null> {
        try {
            const segments = this.classSegments(moduleSpecifier);
            if (!segments) return null;
            const relative = `${segments.join('/')}.java`;

            // Try 1: the package path from the importing file's folders up to the workspace root, and from their
            // Maven/Gradle main source root: a class of the same source root, or a test importing its module's
            // src/main/java (#774). Checked on disk, so a class created a moment ago is found.
            const fromDir = this.folderInRoot(fromFile);
            const folders = fromDir === null ? [this.root()] : this.foldersUpToRoot(fromDir);
            const nearest = folders
                .flatMap((dir) => [this.under(dir, relative), this.under(dir, `src/main/java/${relative}`)])
                .find((candidate) => this.isFile(candidate));
            if (nearest) return this.isWithinRoot(nearest) ? nearest : null;

            // Try 2: the workspace's .java files, listed once: a class of another module, or any layout (#774)
            return this.listed(await this.javaFiles(false), relative) ?? this.listed(await this.javaFiles(true), relative);
        } catch {
            return null;
        }
    }

    /** The .java files of the workspace by file name, with when they were listed. */
    private javaFileList?: { listedAt: number; byName: Promise<Map<string, JavaFile[]>> };

    /**
     * The workspace's .java files by name, listed once and shared by all imports. `refresh` lists them again when the
     * list is older than LISTING_TTL_MS: an import found nowhere may name a file created since.
     */
    private javaFiles(refresh: boolean): Promise<Map<string, JavaFile[]>> {
        if (!this.javaFileList || (refresh && Date.now() - this.javaFileList.listedAt > LISTING_TTL_MS)) {
            this.javaFileList = { listedAt: Date.now(), byName: this.listJavaFiles() };
        }
        return this.javaFileList.byName;
    }

    /**
     * The listed file of `relative` (`com/acme/App.java`): one whose path ends with it (another module's source
     * root), else one named like it at most four folders deep, whatever its folder (a layout not matching packages).
     */
    private listed(byName: Map<string, JavaFile[]>, relative: string): string | null {
        const files = byName.get(path.posix.basename(relative)) ?? [];
        const match = files.find(({ file }) => file.endsWith(`/${relative}`)) ?? files.find(({ depth }) => depth <= MAX_LAYOUT_DEPTH);
        return match?.file ?? null;
    }

    /** Every .java file below the root (no symbolic link followed, so all inside it), shallowest first. */
    private async listJavaFiles(): Promise<Map<string, JavaFile[]>> {
        const byName = new Map<string, JavaFile[]>();
        // The files the index reads: build outputs and ignored folders hold copies that must not win (#774).
        const isIgnored = createIgnoreMatcher(this.root());
        const walk = async (dir: string, depth: number): Promise<void> => {
            let entries: Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return; // Directory not accessible
            }
            await Promise.all(entries.map(async (entry) => {
                const file = this.under(dir, entry.name);
                const relative = path.relative(this.root(), file);
                if (entry.isDirectory() && !shouldSkipDirectory(entry.name, true) && !isIgnored(relative, true)) {
                    await walk(file, depth + 1);
                } else if (entry.isFile() && entry.name.endsWith('.java') && !isIgnored(relative, false)) {
                    const files = byName.get(entry.name) ?? [];
                    files.push({ file, depth });
                    byName.set(entry.name, files);
                }
            }));
        };
        await walk(this.root(), 1);
        for (const files of byName.values()) files.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
        return byName;
    }

    private isFile(file: string): boolean {
        try {
            // No exception for the common miss: most probed paths do not exist.
            return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
        } catch {
            return false;
        }
    }

    /** Verify that a resolved path remains inside the workspace root (prevent path traversal). */
    private isWithinRoot(resolvedPath: string): boolean {
      return isPathWithinRootCanonical(resolvedPath, this.rootDir);
    }

    private isJavaStdlibImport(moduleSpecifier: string): boolean {
        const stdPrefixes = [
            'java.', 'javax.', 'sun.', 'com.sun.',
            'org.w3c.', 'org.xml.', 'org.ietf.',
            'org.omg.', 'jdk.', 'javafx.',
        ];
        return stdPrefixes.some(prefix => moduleSpecifier.startsWith(prefix));
    }
}
