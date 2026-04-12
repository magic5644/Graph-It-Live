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

  async resolvePath(_fromFile: string, _moduleSpecifier: string): Promise<string | null> {
    // Go import paths are module paths (e.g. "github.com/user/repo/pkg").
    // File-level resolution requires the module graph — beyond Spider's file-crawl scope.
    return null;
  }
}
