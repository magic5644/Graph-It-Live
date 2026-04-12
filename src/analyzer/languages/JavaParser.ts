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
  private readonly extensionPath?: string;
  private initPromise: Promise<void> | null = null;

  constructor(_rootDir?: string, extensionPath?: string) {
    this.fileReader = new FileReader();
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

  async resolvePath(_fromFile: string, _moduleSpecifier: string): Promise<string | null> {
    // Java import paths are fully-qualified class names (e.g. "com.example.Foo").
    // File-level resolution requires a classpath/project model — beyond Spider's scope.
    return null;
  }
}
