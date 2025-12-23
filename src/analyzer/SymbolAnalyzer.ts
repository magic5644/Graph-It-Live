import { Project, SourceFile, SyntaxKind, Node, type FunctionDeclaration, type ClassDeclaration, type VariableDeclaration } from 'ts-morph';
import { SymbolInfo, SymbolDependency } from './types';

/** Type for declarations that can have descendants (functions, classes, variables) */
type SymbolDeclaration = FunctionDeclaration | ClassDeclaration | VariableDeclaration;

/** Map ts-morph kind names to category */
function getCategory(kind: string): 'function' | 'class' | 'variable' | 'interface' | 'type' | 'other' {
  switch (kind) {
    case 'FunctionDeclaration':
    case 'ArrowFunction':
    case 'MethodDeclaration':
    case 'GetAccessor':
    case 'SetAccessor':
      return 'function';
    case 'ClassDeclaration':
      return 'class';
    case 'InterfaceDeclaration':
      return 'interface';
    case 'TypeAliasDeclaration':
      return 'type';
    case 'VariableDeclaration':
    case 'PropertyDeclaration':
    case 'EnumDeclaration':
      return 'variable';
    default:
      return 'other';
  }
}

import { getLogger } from '../shared/logger';

const log = getLogger('SymbolAnalyzer');

/** Configuration for SymbolAnalyzer memory management */
export interface SymbolAnalyzerOptions {
  /** Maximum number of source files to keep in memory (default: 100) */
  maxFiles?: number;
}

export class SymbolAnalyzer {
  private project: Project;
  private readonly maxFiles: number;
  private fileCount = 0;

  constructor(options: SymbolAnalyzerOptions = {}) {
    this.maxFiles = options.maxFiles ?? 100;
    this.project = this.createProject();
  }

  /**
   * Create a new ts-morph Project instance
   */
  private createProject(): Project {
    // Don't pass tsConfigFilePath to avoid ts-morph trying to read files
    // Even with useInMemoryFileSystem, ts-morph still tries to read the tsconfig
    // We'll work without tsconfig for now - symbol extraction doesn't strictly need it
    return new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
      compilerOptions: {
        // Provide basic compiler options instead of reading from tsconfig
        target: 99, // ESNext
        module: 99, // ESNext
      }
    });
  }

  /**
   * Reset the project if it has too many files to prevent memory bloat
   */
  private maybeResetProject(): void {
    if (this.fileCount >= this.maxFiles) {
      log.debug(`Resetting ts-morph project (${this.fileCount} files in memory)`);
      this.project = this.createProject();
      this.fileCount = 0;
    }
  }

  /**
   * Get the number of files currently in memory
   */
  public getFileCount(): number {
    return this.fileCount;
  }

  /**
   * Force reset the project to free memory
   */
  public reset(): void {
    log.debug('Forcing ts-morph project reset');
    this.project = this.createProject();
    this.fileCount = 0;
  }

  /**
   * Analyze a file to extract exported symbols and their dependencies
   */
  public analyzeFile(filePath: string, content: string): {
    symbols: SymbolInfo[];
    dependencies: SymbolDependency[];
  } {
    // Check if we need to reset the project
    this.maybeResetProject();

    // Create or update source file in the project
    let sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      sourceFile.replaceWithText(content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content);
      this.fileCount++;
    }

    const symbols: SymbolInfo[] = [];
    const dependencies: SymbolDependency[] = [];

    // 1. Extract Exported Symbols (including class members)
    const exportedDeclarations = sourceFile.getExportedDeclarations();
    
    for (const [name, declarations] of exportedDeclarations) {
      for (const decl of declarations) {
        const kind = decl.getKindName();
        const line = decl.getStartLineNumber();
        
        const symbolInfo: SymbolInfo = {
          name,
          kind,
          line,
          isExported: true,
          id: `${filePath}:${name}`,
          category: getCategory(kind),
        };
        
        symbols.push(symbolInfo);
        
        // If it's a class, extract its methods and properties
        if (kind === 'ClassDeclaration' && Node.isClassDeclaration(decl)) {
          this.extractClassMembers(decl, filePath, symbols);
        }
      }
    }

    // 2. Build import map (name -> original name and file path)
    const importMap = this.buildImportMap(sourceFile);

    // 3. Find symbol usage and build dependencies
    const symbolUsage = this.findSymbolUsage(sourceFile, importMap);
    
    // 4. Create dependency edges
    for (const [symbolId, usedSymbols] of Object.entries(symbolUsage)) {
      for (const usedSymbol of usedSymbols) {
        dependencies.push({
          sourceSymbolId: symbolId,
          targetSymbolId: usedSymbol.symbolId,
          targetFilePath: usedSymbol.filePath,
          isTypeOnly: usedSymbol.isTypeOnly,
        });
      }
    }

    return { symbols, dependencies };
  }

  /**
   * Build a dependency graph between exported symbols in the same file.
   * This is used to avoid reporting exported types/helpers as "unused" when
   * they are part of the public API surface (e.g. referenced in the signature
   * of an exported function) or used by another exported symbol.
   *
   * Note: This is a syntactic scan (identifier matching), not a full type-check,
   * but it's sufficient to capture the common "exported type used in exported signature"
   * and "exported helper used by exported function" cases.
   */
  public getInternalExportDependencyGraph(
    filePath: string,
    content: string
  ): Map<string, Set<string>> {
    this.maybeResetProject();

    let sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      sourceFile.replaceWithText(content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content);
      this.fileCount++;
    }

    const exportedDeclarations = sourceFile.getExportedDeclarations();
    const exportedNames = new Set<string>(exportedDeclarations.keys());

    const graph = new Map<string, Set<string>>();

    for (const [exportName, declarations] of exportedDeclarations) {
      const sourceId = `${filePath}:${exportName}`;
      let deps = graph.get(sourceId);
      if (!deps) {
        deps = new Set<string>();
        graph.set(sourceId, deps);
      }

      for (const decl of declarations) {
        const identifiers = decl.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const identifier of identifiers) {
          const usedName = identifier.getText();
          if (!exportedNames.has(usedName)) continue;
          if (usedName === exportName) continue;
          deps.add(`${filePath}:${usedName}`);
        }
      }
    }

    return graph;
  }
  
  /**
   * Build a map of all imports in the file
   * Maps local name -> { originalName, modulePath, isType }
   */
  private buildImportMap(sourceFile: SourceFile): Map<string, {
    originalName: string;
    modulePath: string;
    isType: boolean;
  }> {
    const importMap = new Map<string, {
      originalName: string;
      modulePath: string;
      isType: boolean;
    }>();

    // Process import declarations
    const importDeclarations = sourceFile.getImportDeclarations();
    
    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const isTypeOnly = importDecl.isTypeOnly();
      
      // Handle default imports: import Foo from './foo'
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        const localName = defaultImport.getText();
        importMap.set(localName, {
          originalName: 'default',
          modulePath: moduleSpecifier,
          isType: isTypeOnly,
        });
      }

      // Handle named imports: import { foo, bar as baz } from './module'
      const namedImports = importDecl.getNamedImports();
      for (const namedImport of namedImports) {
        // For 'bar as baz':
        // - getNameNode().getText() returns 'bar' (original name from module)
        // - getAliasNode().getText() returns 'baz' (local name in this file)
        // For 'foo' (no alias):
        // - getNameNode().getText() returns 'foo'
        // - getAliasNode() returns undefined
        
        const originalName = namedImport.getNameNode().getText(); // Original exported name
        const aliasNode = namedImport.getAliasNode();
        const localName = aliasNode ? aliasNode.getText() : originalName; // Local name used in code
        
        importMap.set(localName, {
          originalName,
          modulePath: moduleSpecifier,
          isType: isTypeOnly || namedImport.isTypeOnly(),
        });
      }

      // Handle namespace imports: import * as Utils from './utils'
      const namespaceImport = importDecl.getNamespaceImport();
      if (namespaceImport) {
        const localName = namespaceImport.getText();
        importMap.set(localName, {
          originalName: '*',
          modulePath: moduleSpecifier,
          isType: isTypeOnly,
        });
      }
    }

    return importMap;
  }

  /**
   * Find which imported symbols are actually used in the code
   * Returns a map of symbolId -> array of used imports
   */
  private findSymbolUsage(
    sourceFile: SourceFile,
    importMap: Map<string, { originalName: string; modulePath: string; isType: boolean }>
  ): Record<string, Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }>> {
    const usage: Record<string, Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }>> = {};
    const filePath = sourceFile.getFilePath();

    // Get all top-level declarations (functions, classes, etc.)
    const declarations = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getClasses(),
      ...sourceFile.getVariableDeclarations(),
    ];

    for (const decl of declarations) {
      const symbolName = decl.getName();
      if (!symbolName) continue;

      const symbolId = `${filePath}:${symbolName}`;
      usage[symbolId] = this.extractSymbolDependencies(decl, importMap);
    }

    // New: Scan top-level statements for usage (expressions, export assignments, etc.)
    const statements = sourceFile.getStatements();
    const fileScopeUsages: Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }> = [];
    
    for (const stmt of statements) {
      // Skip declarations we already processed
      if (Node.isFunctionDeclaration(stmt) || 
          Node.isClassDeclaration(stmt) || 
          Node.isVariableStatement(stmt) || 
          Node.isInterfaceDeclaration(stmt) || 
          Node.isTypeAliasDeclaration(stmt) ||
          Node.isEnumDeclaration(stmt)) {
        continue; 
      }
      
      // Skip import declarations (definitions, not usage)
      if (Node.isImportDeclaration(stmt)) continue;

      // Extract dependencies from this statement
      const deps = this.extractSymbolDependencies(stmt, importMap);
      fileScopeUsages.push(...deps);
    }

    if (fileScopeUsages.length > 0) {
      // Use a special ID for file-scope usage
      const fileScopeId = `${filePath}:(file)`;
      usage[fileScopeId] = fileScopeUsages;
    }

    return usage;
  }

  /**
   * Extract dependencies for a single symbol declaration
   * Now includes type-only imports with isTypeOnly flag
   */
  /**
   * Extract dependencies for a single symbol declaration or node
   * Now includes type-only imports with isTypeOnly flag
   */
  private extractSymbolDependencies(
    node: Node,
    importMap: Map<string, { originalName: string; modulePath: string; isType: boolean }>
  ): Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }> {
    const dependencies: Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }> = [];
    
    // Find all identifiers used within this symbol's body
    const identifiers = node.getDescendantsOfKind(SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      const name = identifier.getText();
      
      // Check if this identifier is an imported symbol
      const importInfo = importMap.get(name);
      if (!importInfo) continue;

      // Include both runtime and type-only imports, marking them appropriately
      const targetSymbolId = importInfo.originalName === 'default'
        ? `${importInfo.modulePath}:default`
        : `${importInfo.modulePath}:${importInfo.originalName}`;
      
      // Avoid duplicates
      if (!dependencies.some(d => d.symbolId === targetSymbolId)) {
        dependencies.push({
          symbolId: targetSymbolId,
          filePath: importInfo.modulePath,
          isTypeOnly: importInfo.isType,
        });
      }
    }

    return dependencies;
  }

  /**
   * Extract methods and properties from a class declaration
   */
  private extractClassMembers(
    classDecl: ClassDeclaration,
    filePath: string,
    symbols: SymbolInfo[]
  ): void {
    
    const className = classDecl.getName();
    if (!className) return;
    
    const parentSymbolId = `${filePath}:${className}`;
    const members = classDecl.getMembers();
    
    for (const member of members) {
      const memberKind = member.getKindName();
      
      // Only extract methods and properties with names
      if (!Node.isMethodDeclaration(member) && 
          !Node.isPropertyDeclaration(member) &&
          !Node.isGetAccessorDeclaration(member) &&
          !Node.isSetAccessorDeclaration(member)) {
        continue;
      }
      
      // After the type guards above, TypeScript knows member has getName() and isStatic()
      const memberName = member.getName();
      if (!memberName) continue;
      
      const isStatic = member.isStatic() ?? false;
      const fullName = `${className}.${memberName}`;
      const memberKindForCategory = isStatic ? `Static${memberKind}` : memberKind;
      
      symbols.push({
        name: fullName,
        kind: memberKindForCategory,
        line: member.getStartLineNumber(),
        isExported: false, // Methods are not directly exported
        id: `${filePath}:${fullName}`,
        parentSymbolId,
        category: getCategory(memberKind), // Use base kind for category
      });
    }
  }

  /**
   * Get all exported symbols from a file (simplified version)
   */
  public getExportedSymbols(filePath: string, content: string): SymbolInfo[] {
    let sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      sourceFile.replaceWithText(content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content);
    }

    const symbols: SymbolInfo[] = [];
    const exportedDeclarations = sourceFile.getExportedDeclarations();

    for (const [name, declarations] of exportedDeclarations) {
      for (const decl of declarations) {
        const kind = decl.getKindName();
        symbols.push({
          name,
          kind,
          line: decl.getStartLineNumber(),
          isExported: true,
          id: `${filePath}:${name}`,
          category: getCategory(kind),
        });
      }
    }
    return symbols;
  }
  
  /**
   * Filter out type-only symbols (interfaces, types)
   * Useful for focusing on executable code
   */
  public filterRuntimeSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
    const typeOnlyKinds = new Set([
      'InterfaceDeclaration',
      'TypeAliasDeclaration',
      'TypeParameter',
    ]);
    
    return symbols.filter(s => !typeOnlyKinds.has(s.kind));
  }
}
