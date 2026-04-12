import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { WasmParserFactory } from "./WasmParserFactory";

/**
 * Go import parser backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class GoParser implements ILanguageAnalyzer {
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
          "Ensure GoParser is constructed with extensionPath parameter."
        );
      }

      try {
        const factory = WasmParserFactory.getInstance();

        const treeSitterWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter.wasm");
        await factory.init(treeSitterWasmPath);

        const goWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter-go.wasm");
        this.parser = await factory.getParser("go", goWasmPath);
      } catch (error) {
        this.initPromise = null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize Go WASM parser: ${errorMessage}`,
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
    const deps: Dependency[] = [];
    this.extractImports(tree.rootNode, actualPath, deps);
    return deps;
  }

  /**
   * Extracts `import "path"` and `import ( "path" )` declarations from the AST.
   */
  private extractImports(node: Node, filePath: string, deps: Dependency[]): void {
    if (node.type === "import_spec") {
      // import_spec has a "path" child containing the string literal
      const pathNode = node.children.find((c) => c.type === "interpreted_string_literal" || c.type === "raw_string_literal");
      if (pathNode) {
        // Strip surrounding quotes
        const specifier = pathNode.text.replaceAll(/^["`]|["`]$/g, "").trim();
        if (specifier) {
          deps.push({
            path: normalizePath(filePath),
            type: "import",
            line: pathNode.startPosition.row + 1,
            module: specifier,
          });
        }
      }
    }

    for (const child of node.children) {
      this.extractImports(child, filePath, deps);
    }
  }

    async resolvePath(fromFile: string, moduleSpecifier: string): Promise<string | null> {
        if (this.isGoStdlibImport(moduleSpecifier)) return null;
        // Guard against path traversal: reject any empty or '..' segment
        const specParts = moduleSpecifier.split('/');
        if (specParts.some(GoParser.isUnsafePart)) return null;
        return this.resolveGoImport(extractFilePath(fromFile), moduleSpecifier, specParts);
    }

    /** Wraps resolution in try/catch so no errors propagate from the async helpers. */
    private async resolveGoImport(
        fromFile: string,
        moduleSpecifier: string,
        specParts: string[],
    ): Promise<string | null> {
        try {
            const goFile =
                await this.resolveViaGoMod(fromFile, moduleSpecifier) ??
                await this.resolveViaLastSegment(specParts);
            return goFile ? normalizePath(goFile) : null;
        } catch {
            return null;
        }
    }

    /** Rejects path parts that are empty or represent parent-directory traversal. */
    private static isUnsafePart(part: string): boolean {
        return part === '..' || part === '';
    }

    /** Try to resolve using go.mod module prefix. */
    private async resolveViaGoMod(fromFile: string, moduleSpecifier: string): Promise<string | null> {
        const moduleInfo = await this.findGoModuleInfo(path.dirname(fromFile));
        if (!moduleInfo) return null;
        if (!moduleSpecifier.startsWith(moduleInfo.moduleName + '/')) return null;

        const relPath = moduleSpecifier.slice(moduleInfo.moduleName.length + 1);
        const relParts = relPath.split('/');
        if (relParts.some(GoParser.isUnsafePart)) return null;

        const pkgDir = path.resolve(moduleInfo.moduleDir, ...relParts);
        if (!this.isWithinRoot(pkgDir)) return null;
        return this.findFirstGoFile(pkgDir);
    }

    /** Fallback: match last path segment to a directory name within rootDir. */
    private async resolveViaLastSegment(specParts: string[]): Promise<string | null> {
        const pkgDirName = specParts.at(-1) ?? '';
        if (!pkgDirName) return null;

        const foundDir = await this.findDirectory(this.rootDir, pkgDirName, 3);
        if (!foundDir || !this.isWithinRoot(foundDir)) return null;
        return this.findFirstGoFile(foundDir);
    }

    /** Verify that a resolved path remains inside the workspace root (prevent path traversal). */
    private isWithinRoot(resolvedPath: string): boolean {
        const target = normalizePath(path.resolve(resolvedPath));
        const root = normalizePath(path.resolve(this.rootDir));
        return target === root || target.startsWith(root + '/');
    }

    private isGoStdlibImport(moduleSpecifier: string): boolean {
        // Stdlib paths have no dot in the first path component (e.g. "fmt", "net", "encoding")
        const firstPart = moduleSpecifier.split('/')[0] ?? '';
        return !firstPart.includes('.');
    }

    /** Walk up from startDir to find the nearest go.mod within rootDir. */
    private async findGoModuleInfo(
        startDir: string,
    ): Promise<{ moduleDir: string; moduleName: string } | null> {
        let currentDir = startDir;
        const rootNorm = normalizePath(this.rootDir);

        while (true) {
            const moduleName = await this.readGoModuleName(path.join(currentDir, 'go.mod'));
            if (moduleName) return { moduleDir: currentDir, moduleName };

            const parent = path.dirname(currentDir);
            if (parent === currentDir) break; // filesystem root
            if (!normalizePath(parent).startsWith(rootNorm)) break; // left workspace
            currentDir = parent;
        }
        return null;
    }

    /** Read the module name from a go.mod file; returns null if missing or unreadable. */
    private async readGoModuleName(goModPath: string): Promise<string | null> {
        try {
            const content = await fs.readFile(goModPath, 'utf-8');
            const match = /^module\s+(\S+)/mu.exec(content);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    /** Return the first non-test .go file in a directory, sorted alphabetically. */
    private async findFirstGoFile(dir: string): Promise<string | null> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const goFiles = entries
                .filter(e => e.isFile() && e.name.endsWith('.go') && !e.name.endsWith('_test.go'))
                .sort((a, b) => a.name.localeCompare(b.name));
            return goFiles.length > 0 ? path.join(dir, goFiles[0].name) : null;
        } catch {
            return null;
        }
    }

    /** Recursively find a directory by name within dir (depth-limited). */
    private async findDirectory(dir: string, dirName: string, maxDepth: number): Promise<string | null> {
        if (maxDepth <= 0) return null;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const subdirs = entries.filter(GoParser.isTraversableDir);
            for (const entry of subdirs) {
                if (entry.name === dirName) return path.join(dir, entry.name);
                const found = await this.findDirectory(path.join(dir, entry.name), dirName, maxDepth - 1);
                if (found) return found;
            }
        } catch {
            // Directory not accessible
        }
        return null;
    }

    private static isTraversableDir(entry: { isDirectory(): boolean; name: string }): boolean {
        return entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules';
    }

}
