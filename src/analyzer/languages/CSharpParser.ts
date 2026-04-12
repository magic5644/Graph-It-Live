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

  async resolvePath(_fromFile: string, _moduleSpecifier: string): Promise<string | null> {
    // C# using directives reference namespaces, not relative file paths.
    // File-level resolution is handled at the project/solution level (beyond Spider's scope).
    return null;
  }
}
