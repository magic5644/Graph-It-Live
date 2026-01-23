import {
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  type ClassDeclaration,
  type VariableStatement,
} from "ts-morph";
import { FileReader } from "./FileReader";
import { ISymbolAnalyzer, SymbolDependency, SymbolInfo } from "./types";

/** Map ts-morph kind names to category */
function getCategory(
  kind: string,
): "function" | "class" | "variable" | "interface" | "type" | "other" {
  switch (kind) {
    case "FunctionDeclaration":
    case "ArrowFunction":
    case "MethodDeclaration":
    case "GetAccessor":
    case "SetAccessor":
      return "function";
    case "ClassDeclaration":
      return "class";
    case "InterfaceDeclaration":
      return "interface";
    case "TypeAliasDeclaration":
      return "type";
    case "VariableDeclaration":
    case "PropertyDeclaration":
    case "EnumDeclaration":
      return "variable";
    default:
      return "other";
  }
}

import { getLogger } from "../shared/logger";

const log = getLogger("SymbolAnalyzer");

/** Configuration for SymbolAnalyzer memory management */
export interface SymbolAnalyzerOptions {
  /** Maximum number of source files to keep in memory (default: 100) */
  maxFiles?: number;
}

export class SymbolAnalyzer implements ISymbolAnalyzer {
  private project: Project;
  private readonly maxFiles: number;
  private fileCount = 0;
  private readonly fileReader: FileReader;

  constructor(_rootDir?: string, options: SymbolAnalyzerOptions = {}) {
    this.maxFiles = options.maxFiles ?? 100;
    this.project = this.createProject();
    this.fileReader = new FileReader();
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
      },
    });
  }

  /**
   * Reset the project if it has too many files to prevent memory bloat
   */
  private maybeResetProject(): void {
    if (this.fileCount >= this.maxFiles) {
      log.debug(
        `Resetting ts-morph project (${this.fileCount} files in memory)`,
      );
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
    log.debug("Forcing ts-morph project reset");
    this.project = this.createProject();
    this.fileCount = 0;
  }

  /**
   * Analyze a file to extract exported symbols and their dependencies
   * Internal method that works with file content directly
   */
  public analyzeFileContent(
    filePath: string,
    content: string,
  ): {
    symbols: SymbolInfo[];
    dependencies: SymbolDependency[];
  } {
    this.maybeResetProject();
    const sourceFile = this.getOrCreateSourceFile(filePath, content);

    const symbols: SymbolInfo[] = [];
    const dependencies: SymbolDependency[] = [];

    // Extract all symbols (exported and non-exported)
    const exportedNames = this.extractExportedSymbols(
      sourceFile,
      filePath,
      symbols,
    );
    this.extractNonExportedSymbols(
      sourceFile,
      filePath,
      exportedNames,
      symbols,
    );

    // Build dependencies
    this.buildDependencies(sourceFile, dependencies);

    return { symbols, dependencies };
  }

  /**
   * Get or create source file in the project
   */
  private getOrCreateSourceFile(filePath: string, content: string): SourceFile {
    let sourceFile = this.project.getSourceFile(filePath);
    if (sourceFile) {
      sourceFile.replaceWithText(content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content);
      this.fileCount++;
    }
    return sourceFile;
  }

  /**
   * Extract exported symbols and return their names
   */
  private extractExportedSymbols(
    sourceFile: SourceFile,
    filePath: string,
    symbols: SymbolInfo[],
  ): Set<string> {
    const exportedDeclarations = sourceFile.getExportedDeclarations();
    const exportedNames = new Set<string>(exportedDeclarations.keys());

    for (const [name, declarations] of exportedDeclarations) {
      for (const decl of declarations) {
        this.addSymbol(
          symbols,
          name,
          decl.getKindName(),
          decl.getStartLineNumber(),
          filePath,
          true,
        );

        if (
          decl.getKindName() === "ClassDeclaration" &&
          Node.isClassDeclaration(decl)
        ) {
          this.extractClassMembers(decl, filePath, symbols);
        }
      }
    }

    return exportedNames;
  }

  /**
   * Extract non-exported top-level symbols
   */
  private extractNonExportedSymbols(
    sourceFile: SourceFile,
    filePath: string,
    exportedNames: Set<string>,
    symbols: SymbolInfo[],
  ): void {
    const statements = sourceFile.getStatements();

    for (const statement of statements) {
      if (Node.isVariableStatement(statement)) {
        this.extractVariableDeclarations(
          statement,
          filePath,
          exportedNames,
          symbols,
        );
      } else {
        this.extractOtherDeclarations(
          statement,
          filePath,
          exportedNames,
          symbols,
        );
      }
    }
  }

  /**
   * Extract variable declarations from a variable statement
   */
  private extractVariableDeclarations(
    statement: VariableStatement,
    filePath: string,
    exportedNames: Set<string>,
    symbols: SymbolInfo[],
  ): void {
    const declarations = statement.getDeclarations();
    for (const varDecl of declarations) {
      const varName = varDecl.getName();
      if (!exportedNames.has(varName)) {
        this.addSymbol(
          symbols,
          varName,
          "VariableDeclaration",
          varDecl.getStartLineNumber(),
          filePath,
          false,
        );
      }
    }
  }

  /**
   * Extract non-variable declarations (class, function, interface, type, enum)
   */
  private extractOtherDeclarations(
    statement: Node,
    filePath: string,
    exportedNames: Set<string>,
    symbols: SymbolInfo[],
  ): void {
    const declarationInfo = this.getDeclarationInfo(statement);
    if (!declarationInfo || exportedNames.has(declarationInfo.name)) {
      return;
    }

    this.addSymbol(
      symbols,
      declarationInfo.name,
      declarationInfo.kind,
      statement.getStartLineNumber(),
      filePath,
      false,
    );

    if (declarationInfo.isClass && Node.isClassDeclaration(statement)) {
      this.extractClassMembers(statement, filePath, symbols);
    }
  }

  /**
   * Get declaration information from a node
   */
  private getDeclarationInfo(statement: Node): {
    name: string;
    kind: string;
    isClass: boolean;
  } | null {
    if (Node.isClassDeclaration(statement)) {
      const name = statement.getName();
      if (name) return { name, kind: "ClassDeclaration", isClass: true };
    } else if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName();
      if (name) return { name, kind: "FunctionDeclaration", isClass: false };
    } else if (Node.isInterfaceDeclaration(statement)) {
      return {
        name: statement.getName(),
        kind: "InterfaceDeclaration",
        isClass: false,
      };
    } else if (Node.isTypeAliasDeclaration(statement)) {
      return {
        name: statement.getName(),
        kind: "TypeAliasDeclaration",
        isClass: false,
      };
    } else if (Node.isEnumDeclaration(statement)) {
      return {
        name: statement.getName(),
        kind: "EnumDeclaration",
        isClass: false,
      };
    }
    return null;
  }

  /**
   * Add a symbol to the symbols array
   */
  private addSymbol(
    symbols: SymbolInfo[],
    name: string,
    kind: string,
    line: number,
    filePath: string,
    isExported: boolean,
  ): void {
    symbols.push({
      name,
      kind,
      line,
      isExported,
      id: `${filePath}:${name}`,
      category: getCategory(kind),
    });
  }

  /**
   * Build dependencies from source file
   */
  private buildDependencies(
    sourceFile: SourceFile,
    dependencies: SymbolDependency[],
  ): void {
    const importMap = this.buildImportMap(sourceFile);
    const symbolUsage = this.findSymbolUsage(sourceFile, importMap);

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
    content: string,
  ): Map<string, Set<string>> {
    this.maybeResetProject();

    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const exportedDeclarations = sourceFile.getExportedDeclarations();
    const exportedNames = new Set<string>(exportedDeclarations.keys());

    const graph = new Map<string, Set<string>>();

    for (const [exportName, declarations] of exportedDeclarations) {
      const sourceId = `${filePath}:${exportName}`;
      const deps = this.getOrCreateDependencySet(graph, sourceId);

      this.collectExportDependencies(
        declarations,
        exportName,
        exportedNames,
        filePath,
        deps,
      );
    }

    return graph;
  }

  /**
   * Get or create a dependency set for a source ID
   */
  private getOrCreateDependencySet(
    graph: Map<string, Set<string>>,
    sourceId: string,
  ): Set<string> {
    let deps = graph.get(sourceId);
    if (!deps) {
      deps = new Set<string>();
      graph.set(sourceId, deps);
    }
    return deps;
  }

  /**
   * Collect dependencies from declarations for an exported symbol
   */
  private collectExportDependencies(
    declarations: Node[],
    exportName: string,
    exportedNames: Set<string>,
    filePath: string,
    deps: Set<string>,
  ): void {
    for (const decl of declarations) {
      const identifiers = decl.getDescendantsOfKind(SyntaxKind.Identifier);

      for (const identifier of identifiers) {
        const usedName = identifier.getText();

        if (this.isValidDependency(usedName, exportName, exportedNames)) {
          deps.add(`${filePath}:${usedName}`);
        }
      }
    }
  }

  /**
   * Check if a used name is a valid dependency (exported and not self-referencing)
   */
  private isValidDependency(
    usedName: string,
    exportName: string,
    exportedNames: Set<string>,
  ): boolean {
    return exportedNames.has(usedName) && usedName !== exportName;
  }

  /**
   * Build a map of all imports in the file
   * Maps local name -> { originalName, modulePath, isType }
   */
  private buildImportMap(sourceFile: SourceFile): Map<
    string,
    {
      originalName: string;
      modulePath: string;
      isType: boolean;
    }
  > {
    const importMap = new Map<
      string,
      {
        originalName: string;
        modulePath: string;
        isType: boolean;
      }
    >();

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
          originalName: "default",
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
          originalName: "*",
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
    importMap: Map<
      string,
      { originalName: string; modulePath: string; isType: boolean }
    >,
  ): Record<
    string,
    Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }>
  > {
    const usage: Record<
      string,
      Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }>
    > = {};
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
    const fileScopeUsages: Array<{
      symbolId: string;
      filePath: string;
      isTypeOnly: boolean;
    }> = [];

    for (const stmt of statements) {
      // Skip declarations we already processed
      if (
        Node.isFunctionDeclaration(stmt) ||
        Node.isClassDeclaration(stmt) ||
        Node.isVariableStatement(stmt) ||
        Node.isInterfaceDeclaration(stmt) ||
        Node.isTypeAliasDeclaration(stmt) ||
        Node.isEnumDeclaration(stmt)
      ) {
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
    importMap: Map<
      string,
      { originalName: string; modulePath: string; isType: boolean }
    >,
  ): Array<{ symbolId: string; filePath: string; isTypeOnly: boolean }> {
    const dependencies: Array<{
      symbolId: string;
      filePath: string;
      isTypeOnly: boolean;
    }> = [];

    // Extract dependencies from static imports
    this.extractStaticImportDependencies(node, importMap, dependencies);

    // Extract dependencies from dynamic import() calls
    this.extractDynamicImportDependencies(node, dependencies);

    return dependencies;
  }

  /**
   * Extract dependencies from static import declarations
   */
  private extractStaticImportDependencies(
    node: Node,
    importMap: Map<
      string,
      { originalName: string; modulePath: string; isType: boolean }
    >,
    dependencies: Array<{
      symbolId: string;
      filePath: string;
      isTypeOnly: boolean;
    }>,
  ): void {
    const identifiers = node.getDescendantsOfKind(SyntaxKind.Identifier);

    for (const identifier of identifiers) {
      const importInfo = importMap.get(identifier.getText());
      if (!importInfo) continue;

      const targetSymbolId = this.buildTargetSymbolId(importInfo);

      if (!dependencies.some((d) => d.symbolId === targetSymbolId)) {
        dependencies.push({
          symbolId: targetSymbolId,
          filePath: importInfo.modulePath,
          isTypeOnly: importInfo.isType,
        });
      }
    }
  }

  /**
   * Extract dependencies from dynamic import() calls
   */
  private extractDynamicImportDependencies(
    node: Node,
    dependencies: Array<{
      symbolId: string;
      filePath: string;
      isTypeOnly: boolean;
    }>,
  ): void {
    const callExpressions = node.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    );

    for (const callExpr of callExpressions) {
      const modulePath = this.extractDynamicImportPath(callExpr);
      if (!modulePath) continue;

      const targetSymbolId = `${modulePath}:default`;

      if (!dependencies.some((d) => d.symbolId === targetSymbolId)) {
        dependencies.push({
          symbolId: targetSymbolId,
          filePath: modulePath,
          isTypeOnly: false,
        });
      }
    }
  }

  /**
   * Extract module path from dynamic import() call expression
   */
  private extractDynamicImportPath(callExpr: Node): string | null {
    if (!Node.isCallExpression(callExpr)) return null;

    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.ImportKeyword) return null;

    const args = callExpr.getArguments();
    if (args.length === 0) return null;

    const firstArg = args[0];
    if (!Node.isStringLiteral(firstArg)) return null;

    return firstArg.getLiteralValue();
  }

  /**
   * Build target symbol ID from import info
   */
  private buildTargetSymbolId(importInfo: {
    originalName: string;
    modulePath: string;
  }): string {
    return importInfo.originalName === "default"
      ? `${importInfo.modulePath}:default`
      : `${importInfo.modulePath}:${importInfo.originalName}`;
  }

  /**
   * Extract methods and properties from a class declaration
   */
  private extractClassMembers(
    classDecl: ClassDeclaration,
    filePath: string,
    symbols: SymbolInfo[],
  ): void {
    const className = classDecl.getName();
    if (!className) return;

    const parentSymbolId = `${filePath}:${className}`;
    const members = classDecl.getMembers();

    for (const member of members) {
      const memberKind = member.getKindName();

      // Only extract methods and properties with names
      if (
        !Node.isMethodDeclaration(member) &&
        !Node.isPropertyDeclaration(member) &&
        !Node.isGetAccessorDeclaration(member) &&
        !Node.isSetAccessorDeclaration(member)
      ) {
        continue;
      }

      // After the type guards above, TypeScript knows member has getName() and isStatic()
      const memberName = member.getName();
      if (!memberName) continue;

      const isStatic = member.isStatic() ?? false;
      const fullName = `${className}.${memberName}`;
      const memberKindForCategory = isStatic
        ? `Static${memberKind}`
        : memberKind;

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
      "InterfaceDeclaration",
      "TypeAliasDeclaration",
      "TypeParameter",
    ]);

    return symbols.filter((s) => !typeOnlyKinds.has(s.kind));
  }

  /**
   * ISymbolAnalyzer implementation: Analyze file and return symbol map
   */
  async analyzeFile(filePath: string): Promise<Map<string, SymbolInfo>> {
    const content = await this.fileReader.readFile(filePath);
    const result = this.analyzeFileContent(filePath, content);

    const symbolMap = new Map<string, SymbolInfo>();
    for (const symbol of result.symbols) {
      symbolMap.set(symbol.id, symbol);
    }
    return symbolMap;
  }

  /**
   * ISymbolAnalyzer implementation: Get symbol dependencies
   */
  async getSymbolDependencies(filePath: string): Promise<SymbolDependency[]> {
    const content = await this.fileReader.readFile(filePath);
    const result = this.analyzeFileContent(filePath, content);
    return result.dependencies;
  }
}
