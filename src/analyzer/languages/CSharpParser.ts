import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { WasmParserFactory } from "./WasmParserFactory";

/**
 * C# import parser backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class CSharpParser implements ILanguageAnalyzer {
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
          "Ensure CSharpParser is constructed with extensionPath parameter."
        );
      }

      try {
        const factory = WasmParserFactory.getInstance();

        const treeSitterWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter.wasm");
        await factory.init(treeSitterWasmPath);

        const csharpWasmPath = path.join(extensionPath, "dist", "wasm", "tree-sitter-c_sharp.wasm");
        this.parser = await factory.getParser("c_sharp", csharpWasmPath);
      } catch (error) {
        this.initPromise = null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize C# WASM parser: ${errorMessage}`,
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
    this.extractUsings(tree.rootNode, actualPath, deps);
    return deps;
  }

  /**
   * Extracts `using Namespace;` and `using static Type;` declarations from the AST.
   */
  private extractUsings(node: Node, filePath: string, deps: Dependency[]): void {
    if (node.type === "using_directive") {
      // The name child contains the namespace/type path
      const nameNode = node.children.find(
        (c) => c.type === "identifier" || c.type === "qualified_name" || c.type === "member_access_expression"
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
      this.extractUsings(child, filePath, deps);
    }
  }

    async resolvePath(_fromFile: string, moduleSpecifier: string): Promise<string | null> {
        if (this.isFrameworkNamespace(moduleSpecifier)) return null;
        const segments = moduleSpecifier.split('.');
        if (segments.length < 2) return null;
        // Guard against path traversal: reject empty, dot-only, or slash-containing segments
        if (segments.some(CSharpParser.isUnsafeSegment)) return null;
        return this.resolveNamespace(segments);
    }

    /** Wraps namespace resolution in try/catch so no errors propagate from the async helpers. */
    private async resolveNamespace(segments: string[]): Promise<string | null> {
        try {
            return await this.resolveViaSuffix(segments) ?? await this.resolveViaLastSegment(segments);
        } catch {
            return null;
        }
    }

    /** Rejects segments that are empty, parent-directory refs, or contain path separators. */
    private static isUnsafeSegment(segment: string): boolean {
        return segment === '' || segment === '..' || segment.includes('/');
    }

    /** Try progressively shorter namespace suffixes as directory paths. */
    private async resolveViaSuffix(segments: string[]): Promise<string | null> {
        for (let i = segments.length - 1; i >= 1; i--) {
            const targetDir = path.resolve(this.rootDir, segments.slice(i).join(path.sep));
            if (!this.isWithinRoot(targetDir)) continue;
            const csFile = await this.findFirstCsFile(targetDir);
            if (csFile) return normalizePath(csFile);
        }
        return null;
    }

    /** Fallback: search for a directory matching the last segment name. */
    private async resolveViaLastSegment(segments: string[]): Promise<string | null> {
        const lastSegment = segments.at(-1) ?? '';
        if (!lastSegment) return null;
        const foundDir = await this.findDirectory(this.rootDir, lastSegment, 3);
        if (!foundDir || !this.isWithinRoot(foundDir)) return null;
        const csFile = await this.findFirstCsFile(foundDir);
        return csFile ? normalizePath(csFile) : null;
    }

    /** Verify that a resolved path remains inside the workspace root (prevent path traversal). */
    private isWithinRoot(resolvedPath: string): boolean {
        const target = normalizePath(path.resolve(resolvedPath));
        const root = normalizePath(path.resolve(this.rootDir));
        return target === root || target.startsWith(root + '/');
    }

    private isFrameworkNamespace(ns: string): boolean {
        const prefixes = [
            'System', 'Microsoft', 'Newtonsoft', 'NUnit', 'Xunit', 'MSTest',
            'AutoMapper', 'FluentValidation', 'MediatR', 'Serilog',
        ];
        return prefixes.some(p => ns === p || ns.startsWith(p + '.'));
    }

    /** Return the first .cs file in a directory (alphabetically), non-recursive. */
    private async findFirstCsFile(dir: string): Promise<string | null> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const csFiles = entries
                .filter(e => e.isFile() && e.name.endsWith('.cs'))
                .sort((a, b) => a.name.localeCompare(b.name));
            return csFiles.length > 0 ? path.join(dir, csFiles[0].name) : null;
        } catch {
            return null;
        }
    }

    /** Recursively find a directory by name within dir (depth-limited). */
    private async findDirectory(dir: string, dirName: string, maxDepth: number): Promise<string | null> {
        if (maxDepth <= 0) return null;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const subdirs = entries.filter(CSharpParser.isTraversableDir);
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
