import fs from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";

/**
 * Rust import parser using tree-sitter-rust
 * Handles: use, mod, extern crate
 */
export class RustParser implements ILanguageAnalyzer {
  private readonly parser: Parser;
  private readonly fileReader: FileReader;
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.parser = new Parser();
    this.parser.setLanguage(Rust as unknown as Parser.Language);
    this.fileReader = new FileReader();
    this.rootDir = rootDir || process.cwd();
  }

  /**
   * Parse Rust imports from a file
   */
  async parseImports(filePath: string): Promise<Dependency[]> {
    try {
      // Extract file path from potential symbol ID
      const actualPath = extractFilePath(filePath);
      const content = await this.fileReader.readFile(actualPath);
      const tree = this.parser.parse(content);
      const dependencies: Dependency[] = [];
      const seen = new Set<string>();

      this.traverseTree(tree.rootNode, (node) => {
        // Handle: use path::to::module;
        if (node.type === "use_declaration") {
          this.extractUseDeclaration(node, dependencies, seen, content);
        }
        // Handle: mod module_name;
        else if (node.type === "mod_item") {
          this.extractModItem(node, dependencies, seen, content, filePath);
        }
        // Handle: extern crate crate_name;
        else if (node.type === "extern_crate_declaration") {
          this.extractExternCrate(node, dependencies, seen, content);
        }
      });

      return dependencies;
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Resolve Rust module path to absolute file path
   * IMPORTANT: Filters out external crates (std, serde, rustpython_vm, etc.)
   * Only resolves local modules to prevent false cycles
   */
  async resolvePath(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    try {
      // Extract first component - if it's an external crate, return null
      const firstComponent = moduleSpecifier.split("::")[0];
      const externalCrates = new Set([
        "std", "core", "alloc", "proc_macro", "test",
        "serde", "tokio", "async_std", "futures",
        "vm", "rustpython_vm", "rustpython",
        "rustpython_parser", "rustpython_compiler",
        "num_traits", "enum_dispatch", "dashmap",
      ]);

      // External crates don't map to local files
      if (externalCrates.has(firstComponent)) {
        return null;
      }

      // Extract file path from potential symbol ID
      const actualFromFile = extractFilePath(fromFile);
      const fromDir = path.dirname(actualFromFile);

      // Handle relative modules (self, super, crate)
      if (
        moduleSpecifier.startsWith("self::") ||
        moduleSpecifier.startsWith("super::") ||
        moduleSpecifier.startsWith("crate::")
      ) {
        return await this.resolveRelativeModule(fromFile, moduleSpecifier);
      }

      // Handle mod declarations (module_name)
      return await this.resolveModDeclaration(fromDir, moduleSpecifier);
    } catch {
      // Resolution failures are not critical - return null
      return null;
    }
  }

  /**
   * Extract use declaration: use path::to::module;
   */
  private extractUseDeclaration(
    node: Parser.SyntaxNode,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
  ): void {
    // Find scoped_identifier or identifier nodes
    const identifiers = this.collectIdentifiers(node, content);

    for (const module of identifiers) {
      if (!module) continue;
      
      // IMPORTANT: Detect external crates vs local modules
      // External crates are NEVER treated as file dependencies
      // Only the first component matters (e.g., "vm::Settings" → "vm" is external)
      const firstComponent = module.split("::")[0];
      
      // List of known external crates to skip (common Rust/Python crates)
      const externalCrates = new Set([
        "std", "core", "alloc", "proc_macro", "test",
        "serde", "tokio", "async_std", "futures",
        "vm", "rustpython_vm", "rustpython",
        "rustpython_parser", "rustpython_compiler",
        "num_traits", "enum_dispatch", "dashmap",
      ]);
      
      // Skip external crates - they don't map to local files
      if (externalCrates.has(firstComponent)) {
        continue;
      }
      
      // For local modules, normalize to lowercase (Rust convention: file names are lowercase)
      const normalizedModule = module.toLowerCase();
      
      if (!seen.has(normalizedModule)) {
        seen.add(normalizedModule);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module: normalizedModule, // Use lowercase for local modules
        });
      }
    }
  }

  /**
   * Extract mod item: mod module_name;
   */
  private extractModItem(
    node: Parser.SyntaxNode,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
    _filePath: string,
  ): void {
    // Check if this is a mod declaration (not an inline mod { ... })
    const hasBody = this.findChildByType(node, "declaration_list");
    if (hasBody) {
      return; // Inline module, not an import
    }

    // Find the module name
    const nameNode = this.findChildByType(node, "identifier");
    if (nameNode) {
      let module = this.getNodeText(nameNode, content);
      // Normalize: Rust module file names are always lowercase
      module = module.toLowerCase();
      
      if (module && !seen.has(module)) {
        seen.add(module);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module,
        });
      }
    }
  }

  /**
   * Extract extern crate declaration: extern crate crate_name;
   * IMPORTANT: External crates are not file dependencies, skip them
   */
  private extractExternCrate(
    node: Parser.SyntaxNode,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
  ): void {
    const nameNode = this.findChildByType(node, "identifier");
    if (nameNode) {
      const module = this.getNodeText(nameNode, content);
      if (!module) return;

      // List of known external crates to skip
      const externalCrates = new Set([
        "std", "core", "alloc", "proc_macro", "test",
        "serde", "tokio", "async_std", "futures",
        "vm", "rustpython_vm", "rustpython",
        "rustpython_parser", "rustpython_compiler",
        "num_traits", "enum_dispatch", "dashmap",
      ]);

      // Skip external crates - they don't map to local files
      if (externalCrates.has(module)) {
        return;
      }

      // For any remaining module declarations, normalize to lowercase
      const normalizedModule = module.toLowerCase();
      if (!seen.has(normalizedModule)) {
        seen.add(normalizedModule);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module: normalizedModule,
        });
      }
    }
  }

  /**
   * Collect all identifiers from use declaration
   * IMPORTANT: Only collect module paths (snake_case), not type names (PascalCase)
   */
  private collectIdentifiers(
    node: Parser.SyntaxNode,
    content: string,
  ): string[] {
    const identifiers: string[] = [];

    // Find scoped_identifier (e.g., std::collections::HashMap or crate::interpreter::func)
    const scopedIds = this.findAllByType(node, "scoped_identifier");
    for (const scopedId of scopedIds) {
      const text = this.getNodeText(scopedId, content);
      if (text) {
        identifiers.push(text);
      }
    }

    // Also collect simple identifiers, but ONLY if they're snake_case (module names)
    // Reject PascalCase names which are types/structs/functions, not modules
    const simpleIds = this.findAllByType(node, "identifier");
    for (const id of simpleIds) {
      const text = this.getNodeText(id, content);
      if (!text || text === "self" || text === "super" || text === "crate") {
        continue;
      }

      // CRITICAL: Reject PascalCase identifiers - they are types/symbols, not modules
      // Rust modules are always snake_case (lowercase with underscores)
      const firstChar = text.charAt(0);
      if (firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
        // Starts with uppercase = type/struct/trait/function, not a module
        continue;
      }

      identifiers.push(text);
    }

    return identifiers;
  }

  /**
   * Resolve relative module (self::, super::, crate::)
   */
  private async resolveRelativeModule(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    const fromDir = path.dirname(fromFile);

    // Handle crate::module -> go to project root
    if (moduleSpecifier.startsWith("crate::")) {
      const relativePath = moduleSpecifier.slice(7).replaceAll("::", "/");
      return await this.resolveModDeclaration(this.rootDir, relativePath);
    }

    // Handle super::module -> go up one directory
    if (moduleSpecifier.startsWith("super::")) {
      const parentDir = path.dirname(fromDir);
      const relativePath = moduleSpecifier.slice(7).replaceAll("::", "/");
      return await this.resolveModDeclaration(parentDir, relativePath);
    }

    // Handle self::module -> same directory
    if (moduleSpecifier.startsWith("self::")) {
      const relativePath = moduleSpecifier.slice(6).replaceAll("::", "/");
      return await this.resolveModDeclaration(fromDir, relativePath);
    }

    return null;
  }

  /**
   * Resolve mod declaration (module_name)
   * IMPORTANT: Rust file names are always lowercase, regardless of how they're referenced
   * If the module name has uppercase letters, it's likely a type/symbol name from an external crate
   */
  private async resolveModDeclaration(
    fromDir: string,
    moduleName: string,
  ): Promise<string | null> {
    // Rust convention: module file names are ALWAYS lowercase (snake_case)
    // If requested module has uppercase letters, it's likely a symbol/type name, not a file
    // This prevents false matches like "Settings" (external crate) → "settings.rs" (local file)
    if (moduleName !== moduleName.toLowerCase()) {
      // Contains uppercase - likely an external symbol/type, not a local file
      return null;
    }

    // Convert :: to / for path resolution
    let modulePath = moduleName.replaceAll("::", "/");
    // Normalize to lowercase: Rust file names follow snake_case convention
    modulePath = modulePath.toLowerCase();

    // Try different file patterns
    const candidates = [
      path.join(fromDir, modulePath + ".rs"),
      path.join(fromDir, modulePath, "mod.rs"),
    ];

    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) {
        return normalizePath(candidate);
      }
    }

    return null;
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Traverse tree and call visitor for each node
   */
  private traverseTree(
    node: Parser.SyntaxNode,
    visitor: (node: Parser.SyntaxNode) => void,
  ): void {
    visitor(node);
    for (const child of node.children) {
      this.traverseTree(child, visitor);
    }
  }

  /**
   * Find first child of a specific type
   */
  private findChildByType(
    node: Parser.SyntaxNode,
    type: string,
  ): Parser.SyntaxNode | null {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }

  /**
   * Find all nodes of a specific type
   */
  private findAllByType(
    node: Parser.SyntaxNode,
    type: string,
  ): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];

    const traverse = (n: Parser.SyntaxNode) => {
      if (n.type === type) {
        results.push(n);
      }
      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(node);
    return results;
  }

  /**
   * Get text content of a node
   */
  private getNodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }
}
