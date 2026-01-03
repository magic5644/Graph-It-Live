import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { ISymbolAnalyzer, SymbolInfo, SymbolDependency, SpiderError } from '../types';
import { FileReader } from '../FileReader';
import { normalizePath } from '../../shared/path';

/**
 * Python symbol analyzer using tree-sitter-python
 * Extracts functions, classes, methods, decorators and their dependencies
 */
export class PythonSymbolAnalyzer implements ISymbolAnalyzer {
  private readonly parser: Parser;
  private readonly fileReader: FileReader;

  constructor(_rootDir?: string) {
    this.parser = new Parser();
    this.parser.setLanguage(Python as unknown as Parser.Language);
    this.fileReader = new FileReader();
  }

  /**
   * Analyze a Python file and extract symbols
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
   * Synchronously analyze Python content and extract symbols
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
   * Synchronously analyze Python content and extract both symbols and dependencies
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
   * Get symbol-level dependencies for a Python file
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
    if (node.type === 'function_definition') {
      this.handleFunctionDefinition(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'class_definition') {
      this.handleClassDefinition(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    if (node.type === 'decorated_definition') {
      this.handleDecoratedDefinition(node, filePath, content, symbols, parentSymbolId);
      return true;
    }

    return false;
  }

  private handleFunctionDefinition(
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
    const isAsync = this.hasChild(node, 'async');

    symbols.set(symbolId, {
      name,
      kind: isAsync ? 'AsyncFunction' : 'FunctionDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: this.isExported(node, content),
      id: symbolId,
      parentSymbolId,
      category: 'function',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleClassDefinition(
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

    symbols.set(symbolId, {
      name,
      kind: 'ClassDeclaration',
      line: nameNode.startPosition.row + 1,
      isExported: this.isExported(node, content),
      id: symbolId,
      parentSymbolId,
      category: 'class',
    });

    this.extractSymbolsFromChildren(node, filePath, content, symbols, symbolId);
  }

  private handleDecoratedDefinition(
    node: Parser.SyntaxNode,
    filePath: string,
    content: string,
    symbols: Map<string, SymbolInfo>,
    parentSymbolId?: string
  ): void {
    for (const child of node.children) {
      if (child.type === 'function_definition' || child.type === 'class_definition') {
        this.extractSymbols(child, filePath, content, symbols, parentSymbolId);
      }
    }
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
   * e.g., format_result -> utils.helpers, connect_db -> utils.database
   */
  private buildImportMap(node: Parser.SyntaxNode, content: string): Map<string, string> {
    const importMap = new Map<string, string>();

    const traverse = (n: Parser.SyntaxNode) => {
      // Handle: from module import name [as alias]
      if (n.type === 'import_from_statement') {
        const moduleNode = n.childForFieldName('module_name');
        if (!moduleNode) return;
        
        const modulePath = this.getNodeText(moduleNode, content);
        
        // Extract imported names
        for (const child of n.children) {
          if (child.type === 'dotted_name' || child.type === 'identifier') {
            const nameText = this.getNodeText(child, content);
            // Skip if it's the module name itself
            if (nameText === modulePath) continue;
            // Check if this is part of aliased_import (will be handled separately)
            if (child.parent?.type === 'aliased_import') continue;
            importMap.set(nameText, modulePath);
          } else if (child.type === 'aliased_import') {
            const nameNode = child.childForFieldName('name');
            const aliasNode = child.childForFieldName('alias');
            if (nameNode) {
              const name = this.getNodeText(nameNode, content);
              const alias = aliasNode ? this.getNodeText(aliasNode, content) : name;
              importMap.set(alias, modulePath);
            }
          }
        }
      }
      // Handle: import module [as alias]
      else if (n.type === 'import_statement') {
        for (const child of n.children) {
          if (child.type === 'dotted_name' || child.type === 'identifier') {
            const modulePath = this.getNodeText(child, content);
            // Skip keywords
            if (modulePath === 'import') continue;
            importMap.set(modulePath, modulePath);
          } else if (child.type === 'aliased_import') {
            const nameNode = child.childForFieldName('name');
            const aliasNode = child.childForFieldName('alias');
            if (nameNode) {
              const modulePath = this.getNodeText(nameNode, content);
              const alias = aliasNode ? this.getNodeText(aliasNode, content) : modulePath;
              importMap.set(alias, modulePath);
            }
          }
        }
      }

      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(node);
    return importMap;
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
    if (node.type !== 'function_definition' && node.type !== 'class_definition') {
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
    if (node.type !== 'call') {
      return;
    }

    const funcNode = node.childForFieldName('function');
    if (!funcNode || !scope) {
      return;
    }

    const calledName = this.getCalledName(funcNode, content);
    
    // Check if it's a call to a local symbol (same file)
    const localTargetSymbolId = `${filePath}:${calledName}`;
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
    if (importMap?.has(calledName)) {
      const moduleSpecifier = importMap.get(calledName)!;
      // Create dependency with module specifier as targetFilePath
      // This will be resolved to absolute path by SpiderSymbolService.getSymbolGraph()
      dependencies.push({
        sourceSymbolId: scope,
        targetSymbolId: `${moduleSpecifier}:${calledName}`, // Module specifier + symbol name
        targetFilePath: moduleSpecifier, // Will be resolved by PathResolver
        isTypeOnly: false,
      });
    }
  }

  private getCalledName(funcNode: Parser.SyntaxNode, content: string): string {
    if (funcNode.type !== 'attribute') {
      return this.getNodeText(funcNode, content);
    }

    const attrNode = funcNode.childForFieldName('attribute');
    if (!attrNode) {
      return this.getNodeText(funcNode, content);
    }

    return this.getNodeText(attrNode, content);
  }

  /**
   * Check if a symbol is exported (Python doesn't have explicit exports, so we check if it's not private)
   */
  private isExported(node: Parser.SyntaxNode, content: string): boolean {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) {
      return false;
    }
    const name = this.getNodeText(nameNode, content);
    // In Python, names starting with _ are considered private
    return !name.startsWith('_');
  }

  /**
   * Check if node has a child of specific type
   */
  private hasChild(node: Parser.SyntaxNode, type: string): boolean {
    for (const child of node.children) {
      if (child.type === type) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get text content of a node
   */
  private getNodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }
}
