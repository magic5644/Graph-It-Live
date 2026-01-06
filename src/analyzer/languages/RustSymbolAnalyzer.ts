import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import { ISymbolAnalyzer, SymbolInfo, SymbolDependency, SpiderError } from '../types';
import { FileReader } from '../FileReader';
import { normalizePath } from '../../shared/path';

/**
 * Rust symbol analyzer using tree-sitter-rust
 * Extracts functions, structs, traits, impls and their dependencies
 */
export class RustSymbolAnalyzer implements ISymbolAnalyzer {
  private readonly parser: Parser;
  private readonly fileReader: FileReader;

  constructor(_rootDir?: string) {
    this.parser = new Parser();
    this.parser.setLanguage(Rust as unknown as Parser.Language);
    this.fileReader = new FileReader();
  }

  /**
   * Analyze a Rust file and extract symbols
   */
  async analyzeFile(filePath: string): Promise<Map<string, SymbolInfo>> {
    try {
      const content = await this.fileReader.readFile(filePath);
      return this.analyzeFileFromContent(filePath, content);
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Synchronously analyze Rust content and extract symbols
   * Used by AstWorker when content is already loaded
   */
  analyzeFileFromContent(filePath: string, content: string): Map<string, SymbolInfo> {
    const tree = this.parser.parse(content);
    const symbols = new Map<string, SymbolInfo>();
    const normalizedPath = normalizePath(filePath);

    this.extractSymbols(tree.rootNode, normalizedPath, content, symbols);

    return symbols;
  }

  /**
   * Synchronously analyze Rust content and extract both symbols and dependencies
   * Used by AstWorker when content is already loaded
   * @returns Object with symbols and dependencies arrays
   */
  analyzeFileContent(filePath: string, content: string): {
    symbols: SymbolInfo[];
    dependencies: SymbolDependency[];
  } {
    const tree = this.parser.parse(content);
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    // impl blocks don't have a name themselves, extract methods inside
    this.extractSymbolsFromChildren(node, filePath, content, symbols, parentSymbolId);
  }

  private extractSymbolsFromChildren(
    node: Parser.SyntaxNode,
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
  private buildImportMap(node: Parser.SyntaxNode, content: string): Map<string, string> {
    const importMap = new Map<string, string>();

    const traverse = (n: Parser.SyntaxNode) => {
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
  private findBaseModuleForUseList(useList: Parser.SyntaxNode, content: string): string {
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
  private findScopedIdentifierInChildren(node: Parser.SyntaxNode, content: string): string {
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
    useList: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
    node: Parser.SyntaxNode,
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
  private extractModuleAndSymbolName(funcNode: Parser.SyntaxNode, content: string): {
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
  private hasVisibilityModifier(node: Parser.SyntaxNode, _modifier: string): boolean {
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
  private hasAncestorOfType(node: Parser.SyntaxNode, ancestorType: string): boolean {
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
  private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
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
  private findAllByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
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
