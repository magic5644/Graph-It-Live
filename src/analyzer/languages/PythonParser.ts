import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ILanguageAnalyzer, Dependency, SpiderError } from '../types';
import { FileReader } from '../FileReader';
import { normalizePath } from '../../shared/path';

/**
 * Python import parser using tree-sitter-python
 * Handles: import x, from y import z, relative imports (., ..)
 */
export class PythonParser implements ILanguageAnalyzer {
  private readonly parser: Parser;
  private readonly fileReader: FileReader;
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.parser = new Parser();
    this.parser.setLanguage(Python as unknown as Parser.Language);
    this.fileReader = new FileReader();
    this.rootDir = rootDir || process.cwd();
  }

  /**
   * Parse Python imports from a file
   */
  async parseImports(filePath: string): Promise<Dependency[]> {
    try {
      const content = await this.fileReader.readFile(filePath);
      const tree = this.parser.parse(content);
      const dependencies: Dependency[] = [];
      const seen = new Set<string>();

      this.traverseTree(tree.rootNode, (node) => {
        // Handle: import module [as alias]
        if (node.type === 'import_statement') {
          this.extractImportStatement(node, dependencies, seen, content);
        }
        // Handle: from module import name [as alias]
        else if (node.type === 'import_from_statement') {
          this.extractImportFromStatement(node, dependencies, seen, content);
        }
      });

      return dependencies;
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Resolve Python module path to absolute file path
   */
  async resolvePath(fromFile: string, moduleSpecifier: string): Promise<string | null> {
    try {
      const fromDir = path.dirname(fromFile);

      // Handle relative imports (., ..)
      if (moduleSpecifier.startsWith('.')) {
        return await this.resolveRelativeImport(fromDir, moduleSpecifier);
      }

      // Handle absolute imports (workspace-relative)
      return await this.resolveAbsoluteImport(fromDir, moduleSpecifier);
    } catch {
      // Resolution failures are not critical - return null
      return null;
    }
  }

  /**
   * Extract import statement: import x, import x as y
   */
  private extractImportStatement(
    node: Parser.SyntaxNode,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string
  ): void {
    // Find dotted_name nodes (the module being imported)
    const dottedNames = this.findChildrenByType(node, 'dotted_name');
    
    for (const dottedName of dottedNames) {
      const module = this.getNodeText(dottedName, content);
      if (module && !seen.has(module)) {
        seen.add(module);
        dependencies.push({
          path: '',
          type: 'import',
          line: dottedName.startPosition.row + 1,
          module,
        });
      }
    }
  }

  /**
   * Extract from...import statement: from x import y
   */
  private extractImportFromStatement(
    node: Parser.SyntaxNode,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string
  ): void {
    // Find the module path (can be dotted_name or relative_import)
    let module: string | null = null;
    
    // Check for relative imports (., .., .module)
    const relativeImport = this.findChildByType(node, 'relative_import');
    if (relativeImport) {
      module = this.getNodeText(relativeImport, content);
    } else {
      // Absolute import
      const dottedName = this.findChildByType(node, 'dotted_name');
      if (dottedName) {
        module = this.getNodeText(dottedName, content);
      }
    }

    if (module && !seen.has(module)) {
      seen.add(module);
      dependencies.push({
        path: '',
        type: 'import',
        line: node.startPosition.row + 1,
        module,
      });
    }
  }

  /**
   * Resolve relative import (., .., .module)
   */
  private async resolveRelativeImport(fromDir: string, moduleSpecifier: string): Promise<string | null> {
    // Count leading dots
    const dotsMatch = /^\.*/u.exec(moduleSpecifier);
    const dots = dotsMatch ? dotsMatch[0].length : 0;
    const modulePath = moduleSpecifier.slice(dots).replaceAll('.', '/');

    // Navigate up directories based on dot count
    let currentDir = fromDir;
    for (let i = 1; i < dots; i++) {
      currentDir = path.dirname(currentDir);
    }

    // Try different file patterns
    const candidates = [
      path.join(currentDir, modulePath + '.py'),
      path.join(currentDir, modulePath + '.pyi'),
      path.join(currentDir, modulePath, '__init__.py'),
      path.join(currentDir, modulePath, '__init__.pyi'),
    ];

    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) {
        return normalizePath(candidate);
      }
    }

    return null;
  }

  /**
   * Resolve absolute import (workspace-relative)
   */
  private async resolveAbsoluteImport(fromDir: string, moduleSpecifier: string): Promise<string | null> {
    // Convert module.submodule to module/submodule
    const modulePath = moduleSpecifier.replaceAll('.', '/');
    const normalizedRoot = normalizePath(this.rootDir);
    const visited = new Set<string>();

    const tryDirectory = async (dir: string): Promise<string | null> => {
      const normalizedDir = normalizePath(dir);
      if (visited.has(normalizedDir)) {
        return null;
      }

      visited.add(normalizedDir);

      const candidates = [
        path.join(dir, modulePath + '.py'),
        path.join(dir, modulePath + '.pyi'),
        path.join(dir, modulePath, '__init__.py'),
        path.join(dir, modulePath, '__init__.pyi'),
      ];

      for (const candidate of candidates) {
        if (await this.fileExists(candidate)) {
          return normalizePath(candidate);
        }
      }

      return null;
    };

    // Walk up from the importing file's directory to the workspace root (or filesystem root)
    let currentDir = fromDir;
    while (true) {
      const resolved = await tryDirectory(currentDir);
      if (resolved) {
        return resolved;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }

      // Stop after checking the workspace root to avoid scanning unrelated paths
      if (normalizePath(parentDir) === normalizedRoot) {
        const resolvedAtRoot = await tryDirectory(parentDir);
        if (resolvedAtRoot) {
          return resolvedAtRoot;
        }
        break;
      }

      currentDir = parentDir;
    }

    // Fallback: try the configured root if it was not part of the climb
    if (!visited.has(normalizedRoot)) {
      const resolvedAtRoot = await tryDirectory(this.rootDir);
      if (resolvedAtRoot) {
        return resolvedAtRoot;
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
  private traverseTree(node: Parser.SyntaxNode, visitor: (node: Parser.SyntaxNode) => void): void {
    visitor(node);
    for (const child of node.children) {
      this.traverseTree(child, visitor);
    }
  }

  /**
   * Find all children of a specific type
   */
  private findChildrenByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    for (const child of node.children) {
      if (child.type === type) {
        results.push(child);
      }
    }
    return results;
  }

  /**
   * Find first child of a specific type
   */
  private findChildByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }

  /**
   * Get text content of a node
   */
  private getNodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }
}
