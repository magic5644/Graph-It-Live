import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { WasmParserFactory } from "./WasmParserFactory";

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
    const deps: Dependency[] = [];
    this.extractImports(tree.rootNode, actualPath, deps);
    return deps;
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

    async resolvePath(_fromFile: string, moduleSpecifier: string): Promise<string | null> {
        try {
            // Skip Java standard library and well-known javax/sun packages
            if (this.isJavaStdlibImport(moduleSpecifier)) {
                return null;
            }
            // Skip wildcard imports — cannot resolve to a single file
            if (moduleSpecifier.endsWith('.*')) {
                return null;
            }

            const segments = moduleSpecifier.split('.');
            // Guard against path traversal: reject empty, dot-only, or slash-containing segments
            if (segments.some(s => s === '' || s === '..' || s.includes('/'))) {
                return null;
            }

            const className = segments.at(-1) ?? '';

            // Try 1: Standard Maven layout — full package path from rootDir
            // e.g., com.example.myapp.UserService → rootDir/com/example/myapp/UserService.java
            const packagePath = segments.join(path.sep) + '.java';
            const directPath = path.resolve(this.rootDir, packagePath);
            if (this.isWithinRoot(directPath) && await this.fileExists(directPath)) {
                return normalizePath(directPath);
            }

            // Try 2: Search for ClassName.java anywhere within rootDir (handles non-standard layouts)
            const found = await this.findFile(this.rootDir, className + '.java', 4);
            return found ? normalizePath(found) : null;
        } catch {
            return null;
        }
    }

    /** Verify that a resolved path remains inside the workspace root (prevent path traversal). */
    private isWithinRoot(resolvedPath: string): boolean {
        const target = normalizePath(path.resolve(resolvedPath));
        const root = normalizePath(path.resolve(this.rootDir));
        return target === root || target.startsWith(root + '/');
    }

    private isJavaStdlibImport(moduleSpecifier: string): boolean {
        const stdPrefixes = [
            'java.', 'javax.', 'sun.', 'com.sun.',
            'org.w3c.', 'org.xml.', 'org.ietf.',
            'org.omg.', 'jdk.', 'javafx.',
        ];
        return stdPrefixes.some(prefix => moduleSpecifier.startsWith(prefix));
    }

    /** Recursively search for a file by exact name within a directory tree (depth-limited). */
    private async findFile(dir: string, fileName: string, maxDepth: number): Promise<string | null> {
        if (maxDepth <= 0) return null;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name === fileName) {
                    return path.join(dir, entry.name);
                }
            }
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    const found = await this.findFile(path.join(dir, entry.name), fileName, maxDepth - 1);
                    if (found) return found;
                }
            }
        } catch {
            // Directory not accessible
        }
    return null;
  }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
