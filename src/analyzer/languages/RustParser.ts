import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { firstNonNull } from "../../shared/concurrency";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { rustGlobPrefixes } from "../utils/pyRsImports";
import { WasmParserFactory } from "./WasmParserFactory";

/**
 * Rust import parser backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class RustParser implements ILanguageAnalyzer {
  private parser: Parser | null = null;
  private readonly fileReader: FileReader;
  private readonly rootDir: string;
  private readonly extensionPath?: string;
  private initPromise: Promise<void> | null = null;

  constructor(rootDir?: string, extensionPath?: string) {
    this.fileReader = new FileReader();
    this.rootDir = rootDir || process.cwd();
    this.extensionPath = extensionPath;
  }

  /** Lazily initializes the WASM parser and reuses a single init promise. */
  private async ensureInitialized(): Promise<void> {
    // If parser is already initialized, return immediately
    if (this.parser) {
      return;
    }

    // Start initialization if not already in progress
    this.initPromise ??= (async () => {
      const extensionPath = await this.resolveExtensionPath();
      if (!extensionPath) {
        throw new Error(
          "Extension path required for WASM parser initialization. " +
          "Ensure RustParser is constructed with extensionPath parameter."
        );
      }

      try {
        const factory = WasmParserFactory.getInstance();

        // Initialize web-tree-sitter with core WASM file
        const treeSitterWasmPath = path.join(
          extensionPath,
          "dist",
          "wasm",
          "tree-sitter.wasm"
        );
        await factory.init(treeSitterWasmPath);

        // Load Rust language WASM and get parser
        const rustWasmPath = path.join(
          extensionPath,
          "dist",
          "wasm",
          "tree-sitter-rust.wasm"
        );
        this.parser = await factory.getParser("rust", rustWasmPath);
      } catch (error) {
        // Clear the promise so retry is possible
        this.initPromise = null;
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize Rust WASM parser: ${errorMessage}`,
          { cause: error }
        );
      }
    })();

    await this.initPromise;
  }

  private async resolveExtensionPath(): Promise<string | undefined> {
    if (this.extensionPath) {
      return this.extensionPath;
    }

    // Test/dev fallback: if running from repository root, use local dist/wasm.
    const cwdExtensionPath = process.cwd();
    const fallbackWasmPath = path.join(cwdExtensionPath, "dist", "wasm", "tree-sitter.wasm");

    try {
      await fs.access(fallbackWasmPath);
      return cwdExtensionPath;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse Rust imports from a file
   */
  async parseImports(filePath: string): Promise<Dependency[]> {
    try {
      // Ensure WASM parser is initialized
      await this.ensureInitialized();

      // Extract file path from potential symbol ID
      const actualPath = extractFilePath(filePath);
      const content = await this.fileReader.readFile(actualPath);
      const tree = this.parser?.parse(content);
      if (!tree) {
        throw new Error(`Failed to parse Rust file: ${actualPath}`);
      }
      const dependencies: Dependency[] = [];
      const seen = new Set<string>();
      const expressionPaths: Node[] = [];

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
        // Handle: m::f() without a `use`
        else if (isExpressionPath(node)) {
          expressionPaths.push(node);
        }
      });

      // `crate::`/`self::`/`super::` paths are local; another path is local only through a glob import
      // (`use super::*;` then `inner::f()`), so it is looked up under each glob's module.
      const globs = expressionPaths.some((node) => !LOCAL_PATH.test(node.text)) ? rustGlobPrefixes(content) : [];
      for (const node of expressionPaths) {
        const scopes = LOCAL_PATH.test(node.text)
          ? [fromFileModule(node.text, inlineModuleDepth(node)) ?? ""]
          : globs.map((glob) => `${glob}::${node.text}`);
        for (const scope of scopes) this.addDependency(scope, node, dependencies, seen);
      }

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
      // Ensure WASM parser is initialized
      await this.ensureInitialized();

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

      // Handle relative modules (self, super, crate); a bare `crate` is the module of `use crate::f`
      if (LOCAL_PATH.test(moduleSpecifier)) {
        return await this.resolveRelativeModule(actualFromFile, moduleSpecifier);
      }

      // `mod m;` / `use m::x` name a child module, which lives in the file's module directory. Loose files
      // outside any crate (no Cargo.toml) also try their own directory, as before crates were located.
      const segments = moduleSpecifier.split("::");
      const resolved = await this.resolveLongestModule(moduleDir(actualFromFile), segments);
      if (resolved) return resolved;
      if (await this.crateDir(actualFromFile)) return await this.resolvePackagePath(actualFromFile, segments);
      return await this.resolveLongestModule(path.dirname(actualFromFile), segments);
    } catch {
      // Resolution failures are not critical - return null
      return null;
    }
  }

  /**
   * Extract use declaration: use path::to::module;
   */
  private extractUseDeclaration(
    node: Node,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
  ): void {
    // Find scoped_identifier or identifier nodes
    const identifiers = this.collectIdentifiers(node, content);
    const depth = inlineModuleDepth(node);

    for (const written of identifiers) {
      const module = fromFileModule(written, depth);
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
    node: Node,
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
    node: Node,
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
    node: Node,
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

    identifiers.push(...this.findAllByType(node, "use_list").flatMap(useListPaths));
    return identifiers;
  }

  /**
   * Resolve relative module paths: `crate::` from the crate's `src/`, `self::` from the file's module
   * directory, each `super::` one module up. A direct item with no module file (`crate::used`, `super::f`,
   * bare `crate` of `use crate::{f}`) resolves to the module's own file, so a `pub use` there is followed.
   * Deeper paths (`super::Foo::new`, a glob-scoped guess) and inner prefixes keep needing a module file.
   */
  private async resolveRelativeModule(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    const segments = moduleSpecifier.split("::");
    const sourceDir = await this.crateSourceDir(fromFile);
    let dir: string;
    let i: number;
    if (segments[0] === "crate") {
      dir = sourceDir;
      i = 1;
    } else {
      dir = moduleDir(fromFile);
      for (i = segments[0] === "self" ? 1 : 0; segments[i] === "super"; i++) {
        dir = path.dirname(dir);
      }
    }
    if (!isInsideDir(dir, path.resolve(this.rootDir))) return null;
    const rest = segments.slice(i);
    const resolved = await this.resolveLongestModule(dir, rest);
    // Only a direct item (`crate::f`) or a bare module (`crate`): an inner prefix like `super::super` is no use.
    if (resolved || (rest.length !== 1 && segments.length > 1)) return resolved;
    const owner = await this.moduleFileOf(dir, dir === sourceDir);
    // `self::item` names the file itself, which is no dependency.
    return owner && owner !== normalizePath(path.resolve(fromFile)) ? owner : null;
  }

  /**
   * The file of the module whose children live in `dir`: the crate root (`lib.rs`, then `main.rs`, whose binary
   * uses the library of its package), else `mod.rs` or `<dir>.rs`.
   */
  private moduleFileOf(dir: string, isCrateRoot: boolean): Promise<string | null> {
    const root = path.resolve(this.rootDir);
    const candidates = (isCrateRoot ? ["lib.rs", "main.rs"].map((file) => path.join(dir, file)) : [path.join(dir, "mod.rs"), `${dir}.rs`])
      .filter((candidate) => isInsideDir(candidate, root));
    return firstNonNull(candidates, async (candidate) => ((await this.fileExists(candidate)) ? normalizePath(candidate) : null));
  }

  /**
   * The file of the longest module prefix of `segments` under `dir`: `inner::imp::one` is `inner/imp.rs`
   * when `one` is an item, not a module. Lookups run concurrently; the longest hit wins.
   */
  private async resolveLongestModule(dir: string, segments: string[]): Promise<string | null> {
    const prefixes = segments.map((_, i) => segments.slice(0, segments.length - i).join("::")).filter(Boolean);
    return firstNonNull(prefixes, (prefix) => this.resolveModDeclaration(dir, prefix));
  }

  /** `use my_crate::f` from the package's binary or tests names its library: resolve it as `crate::f`. */
  private async resolvePackagePath(fromFile: string, segments: string[]): Promise<string | null> {
    const crateDir = await this.crateDir(fromFile);
    if (!crateDir) return null;
    const cargo = await fs.readFile(path.join(crateDir, "Cargo.toml"), "utf-8").catch(() => "");
    return segments[0] === libraryName(cargo) ? this.resolveRelativeModule(fromFile, ["crate", ...segments.slice(1)].join("::")) : null;
  }

  /** Directory of the nearest `Cargo.toml` at or above `fromFile` inside the workspace, if any. */
  private async crateDir(fromFile: string): Promise<string | undefined> {
    const root = path.resolve(this.rootDir);
    const ancestors: string[] = [];
    for (let dir = path.dirname(path.resolve(fromFile)); isInsideDir(dir, root); dir = path.dirname(dir)) {
      ancestors.push(dir);
      if (dir === root) break;
    }
    return (await firstNonNull(ancestors, async (dir) => ((await this.fileExists(path.join(dir, "Cargo.toml"))) ? dir : null))) ?? undefined;
  }

  /** `src/` of the file's crate when the file is under it; otherwise the workspace root, as before crates were located. */
  private async crateSourceDir(fromFile: string): Promise<string> {
    const crateDir = await this.crateDir(fromFile);
    const sourceDir = crateDir && path.join(crateDir, "src");
    return sourceDir && isInsideDir(path.resolve(fromFile), sourceDir) ? sourceDir : this.rootDir;
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

    return firstNonNull(candidates, async (candidate) => ((await this.fileExists(candidate)) ? normalizePath(candidate) : null));
  }

  /** One dependency per module string; resolution keeps the longest module prefix of the path. */
  private addDependency(module: string, node: Node, dependencies: Dependency[], seen: Set<string>): void {
    if (!module || seen.has(module)) return;
    seen.add(module);
    dependencies.push({ path: "", type: "import", line: node.startPosition.row + 1, module });
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
    node: Node,
    visitor: (node: Node) => void,
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
    node: Node,
    type: string,
  ): Node | null {
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
    node: Node,
    type: string,
  ): Node[] {
    const results: Node[] = [];

    const traverse = (n: Node) => {
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
  private getNodeText(node: Node, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }
}

/** Crate roots keep their child modules next to them; so does `mod.rs`. */
const MODULE_DIR_FILES = new Set(["mod.rs", "lib.rs", "main.rs", "build.rs"]);
/** Cargo's other crate roots: each file directly in these folders is its own crate. */
const CRATE_ROOT_DIRS = new Set(["bin", "tests", "examples", "benches"]);

/** Directory of the child modules of `filePath`: its own for `mod.rs` and crate roots, else `<dir>/<stem>`. */
export function moduleDir(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const isRoot = MODULE_DIR_FILES.has(base) || CRATE_ROOT_DIRS.has(path.basename(dir));
  return isRoot ? dir : path.join(dir, path.basename(base, ".rs"));
}

/** Whether `filePath` is `dir` or below it; `pathApi` lets tests check Windows paths on any OS. */
export function isInsideDir(filePath: string, dir: string, pathApi: typeof path = path): boolean {
  const relative = pathApi.relative(dir, filePath);
  return relative === "" || (relative.split(pathApi.sep)[0] !== ".." && !pathApi.isAbsolute(relative));
}

/** Path of the groups around a `use_list`: `use a::b::{c}`, `use crate::{m::{c}}`, outermost first. */
export function useListBase(useList: Node): string {
  const segments: string[] = [];
  for (let current = useList.parent; current; current = current.parent) {
    const pathNode = current.type === "scoped_use_list" ? current.childForFieldName("path") : null;
    if (pathNode) segments.unshift(pathNode.text);
  }
  return segments.join("::");
}

/** The library's crate name in a `Cargo.toml`: `[lib] name`, else `[package] name`, `-` read as `_`. */
export function libraryName(cargoToml: string): string | undefined {
  const names = new Map<string, string>();
  let section = "";
  for (const line of cargoToml.split("\n").map((text) => text.trim())) {
    if (line.startsWith("[")) section = line;
    const name = /^name\s*=\s*"([^"]+)"/.exec(line)?.[1];
    if (name && !names.has(section)) names.set(section, name);
  }
  return (names.get("[lib]") ?? names.get("[package]"))?.replaceAll("-", "_");
}

/** `use crate::{f, m::g, h as k, self}`: each list item is a path under the list's base (`crate::f`), not a child module. */
function useListPaths(useList: Node): string[] {
  const base = useListBase(useList);
  return useList.namedChildren
    .map((child) => (child?.type === "use_as_clause" ? child.childForFieldName("path") : child))
    .filter((item): item is Node => item?.type === "identifier" || item?.type === "scoped_identifier" || item?.type === "self")
    .map((item) => (item.type === "self" ? base : `${base}::${item.text}`));
}

/** Number of inline `mod m { ... }` blocks around `node`: `self` and `super` there start inside the file. */
export function inlineModuleDepth(node: Node): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "mod_item") depth++;
  }
  return depth;
}

/**
 * `specifier`, written inside `depth` inline modules, as seen from the file's own module: the first `depth`
 * `super`s climb back to the file (`super::helper` in `mod tests` is `self::helper`); a path that stays inside
 * the inline modules (`self::x`, fewer `super`s) names this file, so it is no dependency (null).
 */
export function fromFileModule(specifier: string, depth: number): string | null {
  const segments = specifier.split("::");
  let supers = 0;
  while (segments[supers] === "super") supers++;
  if (depth === 0 || (supers === 0 && segments[0] !== "self")) return specifier;
  if (supers < depth) return null;
  return ["self", ...segments.slice(depth)].join("::");
}

/** A path inside the current crate: `crate`, `self` or `super`, alone or followed by `::`. */
export const LOCAL_PATH = /^(?:crate|self|super)(?:::|$)/;

/** Outermost path in an expression (`a::b::f`), outside `use` declarations. */
function isExpressionPath(node: Node): boolean {
  if (node.type !== "scoped_identifier" || node.parent?.type === "scoped_identifier") return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "use_declaration") return false;
  }
  return true;
}
