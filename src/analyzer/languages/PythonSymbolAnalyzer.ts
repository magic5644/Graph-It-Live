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
    this.parser.setLanguage(Python as any);
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

    // Second pass: extract dependencies
    this.extractDependencies(tree.rootNode, normalizedPath, content, dependencies, symbolMap);

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
    // Extract function definitions
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
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

        // Extract nested functions recursively
        for (const child of node.children) {
          this.extractSymbols(child, filePath, content, symbols, symbolId);
        }
      }
      return; // Don't process children again
    }
    // Extract class definitions
    else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
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

        // Extract class methods recursively
        for (const child of node.children) {
          this.extractSymbols(child, filePath, content, symbols, symbolId);
        }
      }
      return; // Don't process children again
    }
    // Extract decorated definitions (functions/classes with decorators)
    else if (node.type === 'decorated_definition') {
      // Process the actual definition inside
      for (const child of node.children) {
        if (child.type === 'function_definition' || child.type === 'class_definition') {
          this.extractSymbols(child, filePath, content, symbols, parentSymbolId);
        }
      }
      return; // Don't process children again
    }

    // Recursively process all children for other node types
    for (const child of node.children) {
      this.extractSymbols(child, filePath, content, symbols, parentSymbolId);
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
    currentScope?: string
  ): void {
    // Track when entering function/class scope
    let newScope = currentScope;

    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const name = this.getNodeText(nameNode, content);
        newScope = `${filePath}:${name}`;
      }
    }

    // Extract function/method calls
    if (node.type === 'call') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        let calledName = this.getNodeText(funcNode, content);
        
        // Handle method calls like self.method() or obj.method()
        // Extract just the method name after the dot
        if (funcNode.type === 'attribute') {
          const attrNode = funcNode.childForFieldName('attribute');
          if (attrNode) {
            calledName = this.getNodeText(attrNode, content);
          }
        }
        
        const targetSymbolId = `${filePath}:${calledName}`;
        
        // Only add if the target symbol exists in our symbol table
        if (symbols.has(targetSymbolId) && newScope) {
          dependencies.push({
            sourceSymbolId: newScope,
            targetSymbolId,
            targetFilePath: filePath,
            isTypeOnly: false,
          });
        }
      }
    }

    // Recursively process children
    for (const child of node.children) {
      this.extractDependencies(child, filePath, content, dependencies, symbols, newScope);
    }
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
