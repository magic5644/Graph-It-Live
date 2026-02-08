import path from "node:path";
import fs from "node:fs/promises";
import { Node, Parser } from "web-tree-sitter";
import { ISymbolAnalyzer, SymbolInfo, SymbolDependency, SpiderError } from '../types';
import { FileReader } from '../FileReader';
import { normalizePath } from '../../shared/path';
import { WasmParserFactory } from './WasmParserFactory';

/**
 * Rust symbol analyzer backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class RustSymbolAnalyzer implements ISymbolAnalyzer {
  private parser: Parser | null = null;
  private readonly fileReader: FileReader;
  private initPromise: Promise<void> | null = null;
  private readonly extensionPath?: string;

  constructor(rootDirOrExtensionPath?: string, extensionPath?: string) {
    // Backward compatibility:
    // Historically some call sites passed only extensionPath as first argument.
    this.extensionPath = extensionPath ?? rootDirOrExtensionPath;
    this.fileReader = new FileReader();
  }

  /** Lazily initializes the WASM parser and reuses a single init promise. */
  async ensureInitialized(): Promise<void> {
    // If parser is already initialized, return immediately
    if (this.parser) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = (async () => {
      const extensionPath = await this.resolveExtensionPath();
      if (!extensionPath) {
        throw new Error(
          "Extension path required for WASM parser initialization. " +
          "Ensure RustSymbolAnalyzer is constructed with extensionPath parameter."
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
          `Failed to initialize Rust WASM parser for symbol analysis: ${errorMessage}`
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
   * Analyze a Rust file and extract symbols
   */
  async analyzeFile(filePath: string): Promise<Map<string, SymbolInfo>> {
    try {
      // Ensure WASM parser is initialized
      await this.ensureInitialized();
      
      const content = await this.fileReader.readFile(filePath);
      return this.analyzeFileFromContent(filePath, content);
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Synchronously analyze Rust content and extract symbols
   * Used by AstWorker when content is already loaded
   * NOTE: Parser must be initialized before calling this method (call ensureInitialized() first)
   */
  analyzeFileFromContent(filePath: string, content: string): Map<string, SymbolInfo> {
    if (!this.parser) {
      throw new Error(
        "Parser not initialized. Call ensureInitialized() before using analyzeFileFromContent()."
      );
    }
    
    const tree = this.parser.parse(content);
    if (!tree) {
      throw new Error(`Failed to parse Rust file: ${filePath}`);
    }
    const symbols = new Map<string, SymbolInfo>();
    const normalizedPath = normalizePath(filePath);

    this.extractSymbols(tree.rootNode, normalizedPath, content, symbols);

    return symbols;
  }

  /**
   * Synchronously analyze Rust content and extract both symbols and dependencies
   * Used by AstWorker when content is already loaded
   * NOTE: Parser must be initialized before calling this method (call ensureInitialized() first)
   * @returns Object with symbols and dependencies arrays
   */
  analyzeFileContent(filePath: string, content: string): {
    symbols: SymbolInfo[];
    dependencies: SymbolDependency[];
  } {
    if (!this.parser) {
      throw new Error(
        "Parser not initialized. Call ensureInitialized() before using analyzeFileContent()."
      );
    }
    
    const tree = this.parser.parse(content);
    if (!tree) {
      throw new Error(`Failed to parse Rust file: ${filePath}`);
    }
    const symbolMap = new Map<string, SymbolInfo>();
    const dependencies: SymbolDependency[] = [];
    const normalizedPath = normalizePath(filePath);

    // First pass: collect all symbols
    this.extractSymbols(tree.rootNode, normalizedPath, content, symbolMap);

    // Build import map: localName -> moduleSpecifier (for tracking external dependencies)
    const importMap = this.buildImportMap(tree.rootNode, content);

    // Second pass: extract dependencies (both internal and external)
    this.extractDependencies(tree.rootNode, normalizedPath, content, dependencies, symbolMap, undefined, importMap);

    return {
      symbols: Array.from(symbolMap.values()),
      dependencies,
    };
  }

  /**
   * Get symbol-level dependencies for a Rust file
   */
  async getSymbolDependencies(filePath: string): Promise<SymbolDependency[]> {
    try {
      // Ensure WASM parser is initialized
      await this.ensureInitialized();
      
      const content = await this.fileReader.readFile(filePath);
      const result = this.analyzeFileContent(filePath, content);
      return result.dependencies;
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Extract symbols from AST
   */
  private extractSymbols(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    if (this.tryExtractSymbolFromNode(node, filePath, content, symbols, parentSymbolId)) {
      return;
    }

    this.extractSymbolsFromChildren(node, filePath, content, symbols, parentSymbolId);
  }

  private tryExtractSymbolFromNode(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): boolean {
    if (node.type === 'function_item') {
      this.handleFunctionItem(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'struct_item') {
      this.handleStructItem(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'enum_item') {
      this.handleEnumItem(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'trait_item') {
      this.handleTraitItem(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'impl_item') {
      this.handleImplItem(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    return false;
  }

  private handleFunctionItem(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return;
    }

    const name = this.getNodeText(nameNode, content);
    const symbolId = `${filePath}:${name}`;
    const isAsync = this.hasModifier(node, 'async');
    const isPublic = this.hasVisibilityModifier(node, 'pub');

    symbols.set(symbolId, {
      name,
      kind: isAsync ? 'AsyncFunction' : 'FunctionDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: isPublic,
      id: symbolId,
      parentSymbolId,
      category: 'function',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleStructItem(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return;
    }

    const name = this.getNodeText(nameNode, content);
    const symbolId = `${filePath}:${name}`;
    const isPublic = this.hasVisibilityModifier(node, 'pub');

    symbols.set(symbolId, {
      name,
      kind: 'StructDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: isPublic,
      id: symbolId,
      parentSymbolId,
      category: 'class',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleEnumItem(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return;
    }

    const name = this.getNodeText(nameNode, content);
    const symbolId = `${filePath}:${name}`;
    const isPublic = this.hasVisibilityModifier(node, 'pub');

    symbols.set(symbolId, {
      name,
      kind: 'EnumDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: isPublic,
      id: symbolId,
      parentSymbolId,
      category: 'type',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleTraitItem(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return;
    }

    const name = this.getNodeText(nameNode, content);
    const symbolId = `${filePath}:${name}`;
    const isPublic = this.hasVisibilityModifier(node, 'pub');

    symbols.set(symbolId, {
      name,
      kind: 'InterfaceDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: isPublic,
      id: symbolId,
      parentSymbolId,
      category: 'type',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleImplItem(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    // impl blocks don't have a name themselves, extract methods inside
    this.extractSymbolsFromChildren(node, filePath, content, symbols, parentSymbolId);
  }

  private extractSymbolsFromChildren(
    node: Node,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    for (const child of node.children) {
      this.extractSymbols(child, filePath, content, symbols, parentSymbolId);
    }
  }

  /**
   * Build a map of imported names to their module specifiers
   * e.g., HashMap -> std::collections::HashMap
   */
  private buildImportMap(node: Node, content: string): Map<string, string> {
    const importMap = new Map<string, string>();

    const traverse = (n: Node) => {
      // Handle: use path::to::module;
      if (n.type === 'use_declaration') {
        this.extractUseDeclarationImports(n, content, importMap);
      }

      // Handle: mod module_name; (declare a module)
      // This is critical for Rust - mod declarations bring modules into scope
      if (n.type === 'mod_item') {
        const nameNode = n.childForFieldName('name');
        if (nameNode) {
          const moduleName = this.getNodeText(nameNode, content);
          // Map module name to itself (will be resolved to file path later)
          importMap.set(moduleName, moduleName);
        }
      }

      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(node);
    return importMap;
  }

  private extractUseDeclarationImports(
    node: Node,
    content: string,
    importMap: Map<string, string>
  ): void {
    // Handle use_list (e.g., use path::{A, B, C})
    this.extractFromUseLists(node, content, importMap);

    // Find scoped_identifier (e.g., std::collections::HashMap or utils::helpers::format_data)
    this.extractFromScopedIdentifiers(node, content, importMap);

    // Handle use_as_clause (aliasing)
    this.extractFromUseAsClauses(node, content, importMap);
  }

  /**
   * Extract imports from use_list syntax (e.g., use path::{A, B, C})
   */
  private extractFromUseLists(
    node: Node,
    content: string,
    importMap: Map<string, string>
  ): void {
    const useLists = this.findAllByType(node, 'use_list');
    for (const useList of useLists) {
      const baseModule = this.findBaseModuleForUseList(useList, content);
      this.extractIdentifiersFromUseList(useList, baseModule, content, importMap);
    }
  }

  /**
   * Find the base module path for a use_list by traversing parent nodes
   */
  private findBaseModuleForUseList(useList: Node, content: string): string {
    let current = useList.parent;
    while (current) {
      if (current.type === 'scoped_use_list') {
        const baseModule = this.findScopedIdentifierInChildren(current, content);
        if (baseModule) return baseModule;
      }
      current = current.parent;
    }
    return '';
  }

  /**
   * Find scoped_identifier in children nodes
   */
  private findScopedIdentifierInChildren(node: Node, content: string): string {
    for (const child of node.children) {
      if (child.type === 'scoped_identifier') {
        return this.getNodeText(child, content);
      }
    }
    return '';
  }

  /**
   * Extract all identifiers from a use_list and add to import map
   */
  private extractIdentifiersFromUseList(
    useList: Node,
    baseModule: string,
    content: string,
    importMap: Map<string, string>
  ): void {
    for (const child of useList.children) {
      if (child.type === 'identifier') {
        const localName = this.getNodeText(child, content);
        // Import map: localName -> module path (without the symbol name)
        // E.g., connect_db -> utils::database
        importMap.set(localName, baseModule);
      }
    }
  }

  /**
   * Extract imports from scoped_identifier nodes (e.g., std::collections::HashMap)
   */
  private extractFromScopedIdentifiers(
    node: Node,
    content: string,
    importMap: Map<string, string>
  ): void {
    const scopedIds = this.findAllByType(node, 'scoped_identifier');
    for (const scopedId of scopedIds) {
      // Skip scoped_identifiers that are part of use_list (already handled above)
      if (this.hasAncestorOfType(scopedId, 'use_list')) {
        continue;
      }

      const fullPath = this.getNodeText(scopedId, content);
      const { localName, modulePath } = this.splitModulePath(fullPath);
      // Import map: localName -> module path
      // E.g., format_data -> utils::helpers
      importMap.set(localName, modulePath);
    }
  }

  /**
   * Split a full module path into local name and module path
   * E.g., "utils::helpers::format_data" -> { localName: "format_data", modulePath: "utils::helpers" }
   */
  private splitModulePath(fullPath: string): { localName: string; modulePath: string } {
    const parts = fullPath.split('::');
    const localName = parts.at(-1)!;
    const modulePath = parts.slice(0, -1).join('::');
    return { localName, modulePath };
  }

  /**
   * Extract imports from use_as_clause (aliasing syntax)
   */
  private extractFromUseAsClauses(
    node: Node,
    content: string,
    importMap: Map<string, string>
  ): void {
    const useClauses = this.findAllByType(node, 'use_as_clause');
    for (const useClause of useClauses) {
      const pathNode = useClause.childForFieldName('path');
      const aliasNode = useClause.childForFieldName('alias');
      if (pathNode && aliasNode) {
        const path = this.getNodeText(pathNode, content);
        const alias = this.getNodeText(aliasNode, content);
        importMap.set(alias, path);
      }
    }
  }

  /**
   * Extract symbol dependencies from AST
   */
  private extractDependencies(
    node: Node,
    filePath: string,
    content: string,
    dependencies: SymbolDependency[],
    symbols: Map<string, SymbolInfo>,
    currentScope?: string,
    importMap?: Map<string, string>
  ): void {
    const newScope = this.getScopeForNode(node, filePath, content, currentScope);
    this.addCallDependencyIfAny(node, filePath, content, dependencies, symbols, newScope, importMap);

    for (const child of node.children) {
      this.extractDependencies(child, filePath, content, dependencies, symbols, newScope, importMap);
    }
  }

  private getScopeForNode(
    node: Node,
    filePath: string,
    content: string,
    currentScope?: string
  ): string | undefined {
    if (node.type !== 'function_item') {
      return currentScope;
    }

    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return currentScope;
    }

    const name = this.getNodeText(nameNode, content);
    return `${filePath}:${name}`;
  }

  private addCallDependencyIfAny(
    node: Node,
    filePath: string,
    content: string,
    dependencies: SymbolDependency[],
    symbols: Map<string, SymbolInfo>,
    scope?: string,
    importMap?: Map<string, string>
  ): void {
    if (node.type !== 'call_expression') {
      return;
    }

    const funcNode = node.childForFieldName('function');
    if (!funcNode || !scope) {
      return;
    }

    // For Rust, we need to handle qualified calls like module::function()
    // Extract both the module prefix and the function name
    const { moduleName, symbolName } = this.extractModuleAndSymbolName(funcNode, content);
    
    // Check if it's a call to a local symbol (same file)
    const localTargetSymbolId = `${filePath}:${symbolName}`;
    if (symbols.has(localTargetSymbolId)) {
      dependencies.push({
        sourceSymbolId: scope,
        targetSymbolId: localTargetSymbolId,
        targetFilePath: filePath,
        isTypeOnly: false,
      });
      return;
    }

    // Check if it's a call to an imported symbol (external file)
    // For qualified calls like helper::format_data, check if module is imported
    if (moduleName && importMap?.has(moduleName)) {
      const moduleSpecifier = importMap.get(moduleName)!;
      // Create dependency with module specifier as targetFilePath
      // This will be resolved to absolute path by SpiderSymbolService.getSymbolGraph()
      dependencies.push({
        sourceSymbolId: scope,
        targetSymbolId: `${moduleSpecifier}:${symbolName}`, // Module specifier + symbol name
        targetFilePath: moduleSpecifier, // Will be resolved by PathResolver
        isTypeOnly: false,
      });
      return;
    }

    // For unqualified calls, check if the symbol name itself is in the import map
    if (importMap?.has(symbolName)) {
      const moduleSpecifier = importMap.get(symbolName)!;
      dependencies.push({
        sourceSymbolId: scope,
        targetSymbolId: `${moduleSpecifier}:${symbolName}`,
        targetFilePath: moduleSpecifier,
        isTypeOnly: false,
      });
    }
  }

  /**
   * Extract module name and symbol name from a function node
   * Examples:
   *   helper::format_data  -> { moduleName: 'helper', symbolName: 'format_data' }
   *   format_data          -> { moduleName: undefined, symbolName: 'format_data' }
   *   obj.method           -> { moduleName: undefined, symbolName: 'method' }
   */
  private extractModuleAndSymbolName(funcNode: Node, content: string): {
    moduleName?: string;
    symbolName: string;
  } {
    // Handle field_expression (e.g., obj.method())
    if (funcNode.type === 'field_expression') {
      const fieldNode = funcNode.childForFieldName('field');
      if (fieldNode) {
        return {
          moduleName: undefined,
          symbolName: this.getNodeText(fieldNode, content),
        };
      }
    }

    // Handle scoped_identifier (e.g., module::function())
    if (funcNode.type === 'scoped_identifier') {
      const fullPath = this.getNodeText(funcNode, content);
      const parts = fullPath.split('::');
      
      if (parts.length >= 2) {
        // For helper::format_data, moduleName='helper', symbolName='format_data'
        // For std::collections::HashMap, moduleName='std::collections', symbolName='HashMap'
        const symbolName = parts.at(-1)!;
        const moduleName = parts.slice(0, -1).join('::');
        
        return {
          moduleName,
          symbolName,
        };
      }
      
      return {
        moduleName: undefined,
        symbolName: parts[0],
      };
    }

    return {
      moduleName: undefined,
      symbolName: this.getNodeText(funcNode, content),
    };
  }

  /**
   * Check if node has a visibility modifier (pub)
   */
  private hasVisibilityModifier(node: Node, _modifier: string): boolean {
    // Check field name first
    const visNode = node.childForFieldName('visibility_modifier');
    if (visNode) {
      return true; // In Rust, if visibility_modifier exists, it's 'pub'
    }
    
    // Also check direct children for 'visibility_modifier' node type
    for (const child of node.children) {
      if (child.type === 'visibility_modifier') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if node has an ancestor of a specific type
   */
  private hasAncestorOfType(node: Node, ancestorType: string): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === ancestorType) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Check if node has a specific modifier
   */
  private hasModifier(node: Node, modifier: string): boolean {
    for (const child of node.children) {
      if (child.type === modifier) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find all nodes of a specific type
   */
  private findAllByType(node: Node, type: string): Node[] {
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
