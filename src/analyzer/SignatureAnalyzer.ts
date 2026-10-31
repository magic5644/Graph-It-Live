/**
 * SignatureAnalyzer - Detects breaking changes in function/method signatures
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 *
 * This analyzes function, method, class, and interface signatures to detect:
 * - New required parameters
 * - Removed parameters
 * - Type changes in parameters or return types
 * - Visibility changes (public → private)
 * - Optional → required parameter changes
 */

import { Node, Project, SourceFile, SyntaxKind, type InterfaceDeclaration, type ParameterDeclaration, type TypeLiteralNode } from 'ts-morph';
import * as path from 'node:path';
import { mapWithConcurrency } from '../shared/concurrency';
import { normalizePath } from '../shared/path';
import { closestNames, symbolNotFoundMessage } from './utils/SymbolLookup';
import { pythonImportBindings, pythonReExports, pythonStarExports } from './utils/pyRsImports';
import { isPublicPythonName, pythonDeclarations, type PythonDeclarationKind } from './utils/pythonSignatures';

/** Export name `export * from '<module>'` is reported under. */
const wildcardExport = (specifier: string | undefined): string => `* from '${specifier}'`;

/** Python modules are compared by the text scan in pythonSignatures.ts, never parsed as TypeScript. */
const isPythonFile = (filePath: string): boolean => /\.py(?:\.(?:old|new))?$/i.test(filePath);

const PYTHON_KIND_LABELS: Record<PythonDeclarationKind, string> = { function: 'Function', class: 'Class', variable: 'Variable' };

/** Scratch in-memory file used to parse a parameter's declared type text. */
const PARAMETER_TYPE_FILE = '__parameter_type__.ts';

/**
 * Represents a function/method parameter
 */
export interface ParameterInfo {
  name: string;
  type: string;
  isOptional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  position: number;
}

/**
 * Represents a function/method signature
 */
export interface SignatureInfo {
  name: string;
  kind: 'function' | 'method' | 'constructor' | 'arrow';
  isExported?: boolean;
  parameters: ParameterInfo[];
  returnType: string;
  isAsync: boolean;
  isStatic?: boolean;
  visibility?: 'public' | 'private' | 'protected';
  typeParameters?: string[];
  line: number;
}

/**
 * Represents an interface property or method
 */
export interface InterfaceMemberInfo {
  name: string;
  kind: 'property' | 'method' | 'index';
  type: string;
  isOptional: boolean;
  isReadonly: boolean;
}

/**
 * Represents a type alias definition
 */
export interface TypeAliasInfo {
  name: string;
  type: string;
  typeParameters?: string[];
  /** Members of a union alias, as written; absent for any other type. */
  unionMembers?: string[];
}

/**
 * Types of breaking changes that can be detected
 */
export type BreakingChangeType =
  | 'parameter-added-required'     // New required parameter added
  | 'parameter-removed'            // Parameter removed
  | 'parameter-type-changed'       // Parameter type changed
  | 'parameter-optional-to-required' // Optional param became required
  | 'return-type-changed'          // Return type changed
  | 'visibility-reduced'           // public → private/protected
  | 'member-removed'               // Interface/class member removed
  | 'member-renamed'               // Interface/class member renamed
  | 'member-type-changed'          // Interface/class member type changed
  | 'member-optional-to-required'  // Optional member became required
  | 'type-alias-changed'           // Type alias definition changed
  | 'member-added'                 // Union or enum gained members: exhaustive consumers stop compiling
  | 'symbol-moved';                // Removed here, declared by another changed file (review_pr)

/**
 * Represents a detected breaking change
 */
export interface BreakingChange {
  type: BreakingChangeType;
  symbolName: string;
  description: string;
  severity: 'error' | 'warning';
  oldValue?: string;
  newValue?: string;
  line?: number;
  /**
   * Set when the removed parameter could be omitted (optional, defaulted or rest):
   * only a call passing at least this many arguments breaks.
   */
  breaksCallsWithArgs?: number;
}

/**
 * Result of signature comparison
 */
export interface SignatureComparisonResult {
  symbolName: string;
  hasBreakingChanges: boolean;
  breakingChanges: BreakingChange[];
  nonBreakingChanges: string[];
}

/** A module a re-export points to, loaded by the caller (it owns resolution, workspace bounds and the ref read). */
export interface ReexportedModule {
  filePath: string;
  content: string;
}

export type ReexportModuleLoader = (fromFile: string, specifier: string) => Promise<ReexportedModule | null>;

/** Where an exported name now comes from: `importedName` is its name in the declaring module. */
interface MovedDeclaration extends ReexportedModule {
  importedName: string;
}

/**
 * SignatureAnalyzer extracts and compares signatures to detect breaking changes.
 */
export class SignatureAnalyzer {
  private readonly project: Project;

  constructor() {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // ESNext
        module: 99, // ESNext
        strict: true,
      },
    });
  }

  /**
   * Extract all function/method signatures from a file
   */
  public extractSignatures(filePath: string, content: string): SignatureInfo[] {
    if (isPythonFile(filePath)) return pythonDeclarations(content).functions;
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const signatures: SignatureInfo[] = [];

    // Extract top-level functions
    for (const func of sourceFile.getFunctions()) {
      const sig = this.extractFunctionSignature(func);
      if (sig) signatures.push(sig);
    }

    // Extract class methods
    for (const classDecl of sourceFile.getClasses()) {
      const className = classDecl.getName() ?? 'Anonymous';
      
      // Constructor
      const ctor = classDecl.getConstructors()[0];
      if (ctor) {
        signatures.push({
          name: `${className}.constructor`,
          kind: 'constructor',
          isExported: classDecl.isExported(),
          parameters: this.extractParameters(ctor.getParameters()),
          returnType: className,
          isAsync: false,
          line: ctor.getStartLineNumber(),
        });
      }

      // Methods
      for (const method of classDecl.getMethods()) {
        const methodName = method.getName();
        const visibility = this.getVisibility(method);
        signatures.push({
          name: `${className}.${methodName}`,
          kind: 'method',
          isExported: classDecl.isExported() && visibility !== 'private',
          parameters: this.extractParameters(method.getParameters()),
          returnType: this.safeGetTypeNodeText(method.getReturnTypeNode(), 'void'),
          isAsync: method.isAsync(),
          isStatic: method.isStatic(),
          visibility,
          typeParameters: method.getTypeParameters().map(tp => this.safeGetText(tp)),
          line: method.getStartLineNumber(),
        });
      }
    }

    // Extract arrow functions in variable declarations
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const initializer = varDecl.getInitializer();
      if (initializer?.getKind() === SyntaxKind.ArrowFunction) {
        const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
        signatures.push({
          name: varDecl.getName(),
          kind: 'arrow',
          isExported: varDecl.getVariableStatement()?.isExported() ?? false,
          parameters: this.extractParameters(arrowFunc.getParameters()),
          returnType: this.safeGetTypeNodeText(arrowFunc.getReturnTypeNode(), 'unknown'),
          isAsync: arrowFunc.isAsync(),
          line: varDecl.getStartLineNumber(),
        });
      }
    }

    return signatures;
  }

  /**
   * Extract interface members for comparison
   */
  public extractInterfaceMembers(filePath: string, content: string): Map<string, InterfaceMemberInfo[]> {
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const result = new Map<string, InterfaceMemberInfo[]>();

    for (const iface of sourceFile.getInterfaces().filter((candidate) => candidate.isExported())) {
      result.set(iface.getName(), this.membersOf(iface));
    }

    return result;
  }

  /** Members of an interface or of an object literal type. */
  private membersOf(declaration: InterfaceDeclaration | TypeLiteralNode): InterfaceMemberInfo[] {
    const members: InterfaceMemberInfo[] = [];

    // Properties
    for (const prop of declaration.getProperties()) {
      members.push({
        name: prop.getName(),
        kind: 'property',
        type: this.safeGetTypeNodeText(prop.getTypeNode(), 'unknown'),
        isOptional: prop.hasQuestionToken(),
        isReadonly: prop.isReadonly(),
      });
    }

    // Methods
    for (const method of declaration.getMethods()) {
      const params = method.getParameters().map(p => `${p.getName()}: ${this.safeGetTypeNodeText(p.getTypeNode(), 'unknown')}`).join(', ');
      const returnType = this.safeGetTypeNodeText(method.getReturnTypeNode(), 'unknown');
      members.push({
        name: method.getName(),
        kind: 'method',
        type: `(${params}) => ${returnType}`,
        isOptional: method.hasQuestionToken(),
        isReadonly: false,
      });
    }

    return members;
  }

  /** Members of a type alias whose type is an object literal; undefined for any other alias type. */
  private aliasMembers(filePath: string, content: string, name: string): InterfaceMemberInfo[] | undefined {
    const typeNode = this.getOrCreateSourceFile(filePath, content).getTypeAlias(name)?.getTypeNode();
    return Node.isTypeLiteral(typeNode) ? this.membersOf(typeNode) : undefined;
  }

  /**
   * Extract type alias definitions
   */
  public extractTypeAliases(filePath: string, content: string): TypeAliasInfo[] {
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const types: TypeAliasInfo[] = [];

    for (const typeAlias of sourceFile.getTypeAliases().filter((candidate) => candidate.isExported())) {
      const typeNode = typeAlias.getTypeNode();
      types.push({
        name: typeAlias.getName(),
        type: this.safeGetTypeNodeText(typeNode, 'unknown'),
        typeParameters: typeAlias.getTypeParameters().map(tp => this.safeGetText(tp)),
        ...(Node.isUnionTypeNode(typeNode) ? { unionMembers: typeNode.getTypeNodes().map((member) => this.safeGetText(member)) } : {}),
      });
    }

    return types;
  }

  /**
   * Compare two signatures and detect breaking changes
   */
  public compareSignatures(
    oldSig: SignatureInfo,
    newSig: SignatureInfo
  ): SignatureComparisonResult {
    const breakingChanges: BreakingChange[] = [];
    const nonBreakingChanges: string[] = [];

    // Check for parameter changes
    this.compareParameters(oldSig, newSig, breakingChanges, nonBreakingChanges);

    // Check return type
    if (oldSig.returnType !== newSig.returnType) {
      // Widening return type is a breaking change for consumers
      breakingChanges.push({
        type: 'return-type-changed',
        symbolName: newSig.name,
        description: `Return type changed from '${oldSig.returnType}' to '${newSig.returnType}'`,
        severity: 'error',
        oldValue: oldSig.returnType,
        newValue: newSig.returnType,
        line: newSig.line,
      });
    }

    // Check visibility
    if (oldSig.visibility && newSig.visibility) {
      const visibilityOrder = { public: 3, protected: 2, private: 1 };
      const oldLevel = visibilityOrder[oldSig.visibility];
      const newLevel = visibilityOrder[newSig.visibility];
      
      if (newLevel < oldLevel) {
        breakingChanges.push({
          type: 'visibility-reduced',
          symbolName: newSig.name,
          description: `Visibility reduced from '${oldSig.visibility}' to '${newSig.visibility}'`,
          severity: 'error',
          oldValue: oldSig.visibility,
          newValue: newSig.visibility,
          line: newSig.line,
        });
      }
    }

    return {
      symbolName: newSig.name,
      hasBreakingChanges: breakingChanges.length > 0,
      breakingChanges,
      nonBreakingChanges,
    };
  }

  /**
   * Compare interface definitions and detect breaking changes
   */
  public compareInterfaces(
    interfaceName: string,
    oldMembers: InterfaceMemberInfo[],
    newMembers: InterfaceMemberInfo[]
  ): SignatureComparisonResult {
    const breakingChanges: BreakingChange[] = [];
    const nonBreakingChanges: string[] = [];

    const oldMemberMap = new Map(oldMembers.map(m => [m.name, m]));
    const newMemberMap = new Map(newMembers.map(m => [m.name, m]));
    const renamed = this.detectRenamedMembers(
      interfaceName,
      oldMembers,
      newMembers,
      oldMemberMap,
      newMemberMap,
      breakingChanges,
    );

    this.detectRemovedMembers(interfaceName, oldMemberMap, newMemberMap, renamed, breakingChanges);
    this.detectAddedAndChangedMembers(
      interfaceName,
      newMemberMap,
      oldMemberMap,
      renamed,
      breakingChanges,
      nonBreakingChanges,
    );

    return {
      symbolName: interfaceName,
      hasBreakingChanges: breakingChanges.length > 0,
      breakingChanges,
      nonBreakingChanges,
    };
  }

  private detectRenamedMembers(
    interfaceName: string,
    oldMembers: InterfaceMemberInfo[],
    newMembers: InterfaceMemberInfo[],
    oldMemberMap: Map<string, InterfaceMemberInfo>,
    newMemberMap: Map<string, InterfaceMemberInfo>,
    breakingChanges: BreakingChange[],
  ): Map<string, string> {
    const renamed = new Map<string, string>();
    const availableNew = new Set(newMembers
      .filter(member => !oldMemberMap.has(member.name))
      .map(member => member.name));

    for (const oldMember of oldMembers) {
      if (newMemberMap.has(oldMember.name)) continue;
      const candidate = newMembers.find(member => availableNew.has(member.name)
        && this.areEquivalentMembers(oldMember, member));
      if (!candidate) continue;

      renamed.set(oldMember.name, candidate.name);
      availableNew.delete(candidate.name);
      breakingChanges.push({
        type: 'member-renamed',
        symbolName: `${interfaceName}.${candidate.name}`,
        description: `Member '${oldMember.name}' was renamed to '${candidate.name}' in interface '${interfaceName}'`,
        severity: 'error',
        oldValue: oldMember.name,
        newValue: candidate.name,
      });
    }
    return renamed;
  }

  private areEquivalentMembers(oldMember: InterfaceMemberInfo, newMember: InterfaceMemberInfo): boolean {
    return oldMember.type === newMember.type
      && oldMember.kind === newMember.kind
      && oldMember.isOptional === newMember.isOptional
      && oldMember.isReadonly === newMember.isReadonly;
  }

  private detectRemovedMembers(
    interfaceName: string,
    oldMemberMap: Map<string, InterfaceMemberInfo>,
    newMemberMap: Map<string, InterfaceMemberInfo>,
    renamed: Map<string, string>,
    breakingChanges: BreakingChange[],
  ): void {
    for (const [name, oldMember] of oldMemberMap) {
      if (newMemberMap.has(name) || renamed.has(name)) continue;
      breakingChanges.push({
        type: 'member-removed',
        symbolName: `${interfaceName}.${name}`,
        description: `Member '${name}' was removed from interface '${interfaceName}'`,
        severity: 'error',
        oldValue: oldMember.type,
      });
    }
  }

  private detectAddedAndChangedMembers(
    interfaceName: string,
    newMemberMap: Map<string, InterfaceMemberInfo>,
    oldMemberMap: Map<string, InterfaceMemberInfo>,
    renamed: Map<string, string>,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[],
  ): void {
    const renamedNames = new Set(renamed.values());
    for (const [name, newMember] of newMemberMap) {
      if (renamedNames.has(name)) continue;
      const oldMember = oldMemberMap.get(name);
      if (!oldMember) {
        this.handleAddedMember(interfaceName, newMember, breakingChanges, nonBreakingChanges);
        continue;
      }
      this.handleChangedMember(interfaceName, oldMember, newMember, breakingChanges);
    }
  }

  private handleAddedMember(
    interfaceName: string,
    member: InterfaceMemberInfo,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[],
  ): void {
    if (member.isOptional) {
      nonBreakingChanges.push(`New optional member '${member.name}' added`);
      return;
    }
    breakingChanges.push({
      type: 'member-optional-to-required',
      symbolName: `${interfaceName}.${member.name}`,
      description: `New required member '${member.name}' added to interface '${interfaceName}'`,
      severity: 'error',
      newValue: member.type,
    });
  }

  private handleChangedMember(
    interfaceName: string,
    oldMember: InterfaceMemberInfo,
    newMember: InterfaceMemberInfo,
    breakingChanges: BreakingChange[],
  ): void {
    if (oldMember.type !== newMember.type) {
      breakingChanges.push({
        type: 'member-type-changed',
        symbolName: `${interfaceName}.${newMember.name}`,
        description: `Type of member '${newMember.name}' changed from '${oldMember.type}' to '${newMember.type}'`,
        severity: 'error',
        oldValue: oldMember.type,
        newValue: newMember.type,
      });
    }
    if (oldMember.isOptional && !newMember.isOptional) {
      breakingChanges.push({
        type: 'member-optional-to-required',
        symbolName: `${interfaceName}.${newMember.name}`,
        description: `Member '${newMember.name}' changed from optional to required`,
        severity: 'error',
      });
    }
  }

  /**
   * Compare type aliases and detect breaking changes
   */
  public compareTypeAliases(
    oldType: TypeAliasInfo,
    newType: TypeAliasInfo
  ): SignatureComparisonResult {
    const breakingChanges: BreakingChange[] = [];
    const nonBreakingChanges: string[] = [];

    const added = addedUnionMembers(oldType, newType);
    if (added) {
      breakingChanges.push(memberAddedChange(`Union '${newType.name}'`, newType.name, added, oldType.type, newType.type));
    } else if (oldType.type !== newType.type) {
      breakingChanges.push({
        type: 'type-alias-changed',
        symbolName: newType.name,
        description: `Type alias '${newType.name}' changed from '${oldType.type}' to '${newType.type}'`,
        severity: 'warning', // Type changes might be intentional refinements
        oldValue: oldType.type,
        newValue: newType.type,
      });
    }

    return {
      symbolName: newType.name,
      hasBreakingChanges: breakingChanges.length > 0,
      breakingChanges,
      nonBreakingChanges,
    };
  }

  /**
   * Analyze a file for potential breaking changes compared to an old version.
   * With `symbolName`, only that symbol (or the members of that class) is reported,
   * and a symbol that cannot be compared throws instead of returning an empty, "safe" result.
   */
  public analyzeBreakingChanges(
    filePath: string,
    oldContent: string,
    newContent: string,
    symbolName?: string
  ): SignatureComparisonResult[] {
    const results = this.analyzeAllBreakingChanges(filePath, oldContent, newContent);
    if (!symbolName) return results;

    const matches = (name: string) =>
      name === symbolName || name.startsWith(`${symbolName}.`) || name.endsWith(`.${symbolName}`);
    // A Python module exports what it declares: there is no export syntax to add.
    const exportsOf = (side: string, content: string) => (isPythonFile(filePath) ? [] : [...this.exportNames(`${filePath}.${side}`, content)]);
    const oldNames = [...this.declaredNames(filePath, 'old', oldContent), ...exportsOf('old', oldContent)];
    const newNames = [...this.declaredNames(filePath, 'new', newContent), ...exportsOf('new', newContent)];
    if (oldNames.some(matches)) {
      return results.filter((r) => matches(r.symbolName));
    }
    if (!newNames.some(matches)) {
      const names = [...new Set([...oldNames, ...newNames])];
      throw new Error(symbolNotFoundMessage(symbolName, 'oldContent or newContent', closestNames(names, symbolName)));
    }
    // An old version that declares nothing (e.g. a placeholder) is not a baseline: a
    // blank one is a new file, but anything else means the real content was not passed.
    if (oldNames.length === 0 && oldContent.trim() !== '') {
      throw new Error(
        `Symbol '${symbolName}' is not declared in oldContent; cannot compare. Pass the full previous file content.`,
      );
    }
    return [{
      symbolName,
      hasBreakingChanges: false,
      breakingChanges: [],
      nonBreakingChanges: [`'${symbolName}' is new: it is not declared in oldContent, so no existing caller can break`],
    }];
  }

  private analyzeAllBreakingChanges(
    filePath: string,
    oldContent: string,
    newContent: string
  ): SignatureComparisonResult[] {
    if (isPythonFile(filePath)) return this.comparePythonModules(oldContent, newContent);
    const results: SignatureComparisonResult[] = [];

    // Compare functions
    this.compareFunctions(filePath, oldContent, newContent, results);

    // Compare interfaces
    this.compareInterfaceDefinitions(filePath, oldContent, newContent, results);

    // Compare type aliases
    this.compareTypeAliasDefinitions(filePath, oldContent, newContent, results);

    // An enum keeps its name when it gains or loses members: compare them.
    this.compareEnumDefinitions(filePath, oldContent, newContent, results);

    // A declaration that stays in the file but leaves its export set is compared by none of the above.
    this.compareExportSets(filePath, oldContent, newContent, results);

    // Vue component props are the public contract between a child component and
    // its parents, even though they are declared inside an SFC script block.
    if (this.isVueFile(filePath)) {
      this.compareVueProps(filePath, oldContent, newContent, results);
    }

    return results;
  }

  /**
   * Re-checks symbols reported as removed against the new file's re-exports
   * (`export { x } from`, `import { x }; export { x }`, `export *`): a declaration that
   * moved to another module but is still exported here breaks no import site, so it is
   * compared with its new declaration instead. A re-export target `loadModule` cannot
   * load keeps the removal and is listed in `limitations`.
   */
  public async resolveReexportedRemovals(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[],
    loadModule: ReexportModuleLoader,
  ): Promise<{ results: SignatureComparisonResult[]; limitations: string[] }> {
    const newNames = new Set(this.declaredNames(filePath, 'new', newContent));
    // Limitations are collected per result and merged in input order, so output stays deterministic.
    const resolutions = await Promise.all(results.map(async (result) => {
      const limitations = new Set<string>();
      const isRemoval = result.breakingChanges.length === 1 && !newNames.has(result.symbolName);
      const moved = isRemoval
        ? await this.findMovedDeclaration(filePath, newContent, result.symbolName.split('.')[0], loadModule, limitations, new Set())
        : undefined;
      return { result, limitations, comparison: moved && this.compareMovedSymbol(filePath, oldContent, result.symbolName, moved) };
    }));
    return {
      results: resolutions.flatMap(({ result, comparison }) => {
        if (!comparison) return [result];
        return comparison.hasBreakingChanges || comparison.nonBreakingChanges.length > 0 ? [comparison] : [];
      }),
      limitations: [...new Set(resolutions.flatMap(({ limitations }) => [...limitations]))],
    };
  }

  /** Names of the top-level declarations `content` exports directly (re-exports excluded). */
  public exportedDeclarationNames(filePath: string, content: string): Set<string> {
    if (isPythonFile(filePath)) return new Set([...pythonDeclarations(content).names.keys()].filter(isPublicPythonName));
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const names = new Set<string>();
    for (const declaration of [
      ...sourceFile.getFunctions(),
      ...sourceFile.getClasses(),
      ...sourceFile.getEnums(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ]) {
      const name = declaration.getName();
      if (name && declaration.isExported()) names.add(name);
    }
    for (const statement of sourceFile.getVariableStatements().filter((candidate) => candidate.isExported())) {
      for (const declaration of statement.getDeclarations()) names.add(declaration.getName());
    }
    return names;
  }

  /**
   * Compares a symbol removed from `filePath` with the declaration of the same name in `target`.
   * Undefined when `target` declares no comparable function, member, interface or type alias.
   */
  public compareMovedRemoval(
    filePath: string,
    oldContent: string,
    symbolName: string,
    target: ReexportedModule,
  ): SignatureComparisonResult | undefined {
    return this.compareMovedSymbol(filePath, oldContent, symbolName, { ...target, importedName: symbolName.split('.')[0] });
  }

  /**
   * Module specifiers through which `content` may reach `name`: named imports and re-exports
   * of `name` (any import when `name` is omitted), plus every form whose use of a name is not followed — default and namespace
   * imports, `export *`, dynamic `import()`, `require()`, `import x = require()` and `import()` types.
   */
  public specifiersThatMayImport(filePath: string, content: string, name?: string): string[] {
    if (isPythonFile(filePath)) {
      // `import m` and `from m import *` bind the whole module, and `from . import m` may bind a submodule:
      // whether `name` is used through them is not followed.
      const bindings = pythonImportBindings(content)
        .filter((binding) => name === undefined || binding.imported === name || binding.imported === '*')
        .map((binding) => binding.specifier);
      return [...new Set([...bindings, ...pythonReExports(content).namespaces.map((namespace) => namespace.specifier)])];
    }
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const imports = sourceFile.getImportDeclarations()
      .filter((declaration) => name === undefined
        || declaration.getDefaultImport() !== undefined
        || declaration.getNamespaceImport() !== undefined
        || declaration.getNamedImports().some((specifier) => specifier.getName() === name))
      .map((declaration) => declaration.getModuleSpecifierValue());
    const reexports = sourceFile.getExportDeclarations()
      .filter((declaration) => name === undefined
        || !declaration.hasNamedExports()
        || declaration.getNamedExports().some((specifier) => specifier.getName() === name))
      .map((declaration) => declaration.getModuleSpecifierValue());
    return [...imports, ...reexports, ...dynamicSpecifiers(sourceFile)]
      .filter((specifier): specifier is string => Boolean(specifier));
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Follows the re-exports of `name` (through barrels) to the module that declares it.
   * ponytail: each removed symbol re-parses its chain (the caller memoizes loads); cache the
   * parsed modules per call if a file moving many symbols behind deep barrels gets slow.
   */
  private async findMovedDeclaration(
    fromFile: string,
    content: string,
    name: string,
    loadModule: ReexportModuleLoader,
    limitations: Set<string>,
    visited: Set<string>,
  ): Promise<MovedDeclaration | undefined> {
    const reexports = isPythonFile(fromFile)
      ? pythonReexportsOf(content, name)
      : this.reexportsOf(this.getOrCreateSourceFile(fromFile, content), name);
    // Load every candidate up front (bounded); the walk below stays in order, so results do not change.
    const targets = await mapWithConcurrency(reexports, 8, ({ specifier }) => loadModule(fromFile, specifier).catch(() => null));
    for (const [index, { specifier, importedName, wildcard }] of reexports.entries()) {
      const target = targets[index];
      if (!target) {
        // An `export *` may not re-export this name at all: report the module once, not per name.
        limitations.add(wildcard
          ? `Re-exports from '${specifier}' could not be resolved; removals behind them are unverified.`
          : `Re-export of '${name}' from '${specifier}' could not be resolved; its removal is unverified.`);
        continue;
      }
      const key = normalizePath(target.filePath);
      if (visited.has(key)) continue;
      visited.add(key);
      if (this.declaresReachable(target, importedName, wildcard)) return { ...target, importedName };
      // eslint-disable-next-line no-await-in-loop -- depth-first walk: the shared visited set and the first match decide the result
      const moved = await this.findMovedDeclaration(target.filePath, target.content, importedName, loadModule, limitations, visited);
      if (moved) return moved;
    }
    return undefined;
  }

  /**
   * Module specifiers that may export `name`, with the name it has there.
   * `export * as ns` is skipped: it exports a namespace object, not the name itself.
   * ponytail: a default import re-exported by name (`import x from`; `export { x }`) is not
   * followed, so its removal stays reported; follow it if barrels use that form.
   */
  private reexportsOf(sourceFile: SourceFile, name: string): Array<{ specifier: string; importedName: string; wildcard?: boolean }> {
    const reexports: Array<{ specifier: string; importedName: string; wildcard?: boolean }> = [];
    for (const declaration of sourceFile.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier && declaration.isNamespaceExport() && !declaration.getNamespaceExport()) {
        reexports.push({ specifier, importedName: name, wildcard: true });
        continue;
      }
      const exported = declaration.getNamedExports()
        .find((specifierNode) => (specifierNode.getAliasNode()?.getText() ?? specifierNode.getName()) === name);
      if (!exported) continue;
      const reexport = specifier
        ? { specifier, importedName: exported.getName() }
        : this.importedBinding(sourceFile, exported.getName());
      if (reexport) reexports.push(reexport);
    }
    return reexports;
  }

  private importedBinding(sourceFile: SourceFile, localName: string): { specifier: string; importedName: string } | undefined {
    for (const declaration of sourceFile.getImportDeclarations()) {
      const imported = declaration.getNamedImports()
        .find((specifierNode) => (specifierNode.getAliasNode()?.getText() ?? specifierNode.getName()) === localName);
      if (imported) return { specifier: declaration.getModuleSpecifierValue(), importedName: imported.getName() };
    }
    return undefined;
  }

  /** Whether `module` declares `name` where the re-export reaches it: a Python star import skips names left out of `__all__`. */
  private declaresReachable(module: ReexportedModule, name: string, wildcard: boolean | undefined): boolean {
    return !(wildcard && hiddenFromPythonStar(module, name)) && this.declaresTopLevel(module, name);
  }

  private declaresTopLevel(module: ReexportedModule, name: string): boolean {
    if (isPythonFile(module.filePath)) return pythonDeclarations(module.content).names.has(name);
    const sourceFile = this.getOrCreateSourceFile(module.filePath, module.content);
    return [
      ...sourceFile.getFunctions(),
      ...sourceFile.getClasses(),
      ...sourceFile.getEnums(),
      ...sourceFile.getVariableDeclarations(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ].some((declaration) => declaration.getName() === name);
  }

  /**
   * Compares the old declaration of `symbolName` with the one it moved to, under the old name.
   * Undefined when the moved declaration has no such function, member, interface or type alias.
   */
  private compareMovedSymbol(
    filePath: string,
    oldContent: string,
    symbolName: string,
    moved: MovedDeclaration,
  ): SignatureComparisonResult | undefined {
    const exportedName = symbolName.split('.')[0];
    const toOldName = (name: string) => exportedName + name.slice(moved.importedName.length);
    const oldPath = `${filePath}.old`;

    const oldSig = this.extractSignatures(oldPath, oldContent).find((s) => s.name === symbolName);
    if (isPythonFile(filePath) && !oldSig) {
      // A Python class or variable has no comparable signature: declaring it is all its importers need.
      return this.declaresTopLevel(moved, moved.importedName) ? { symbolName, hasBreakingChanges: false, breakingChanges: [], nonBreakingChanges: [] } : undefined;
    }
    if (oldSig) {
      const newSig = this.extractSignatures(moved.filePath, moved.content)
        .find((s) => toOldName(s.name) === symbolName && (s.name === moved.importedName || s.name.startsWith(`${moved.importedName}.`)));
      return newSig && this.compareSignatures(oldSig, { ...newSig, name: symbolName });
    }
    const oldMembers = this.extractInterfaceMembers(oldPath, oldContent).get(symbolName);
    const newMembers = this.extractInterfaceMembers(moved.filePath, moved.content).get(moved.importedName);
    const oldType = this.extractTypeAliases(oldPath, oldContent).find((t) => t.name === symbolName);
    const newType = this.extractTypeAliases(moved.filePath, moved.content).find((t) => t.name === moved.importedName);
    if (oldMembers && newMembers) return this.compareInterfaces(symbolName, oldMembers, newMembers);
    if (oldType && newType) return this.compareTypeAliases(oldType, { ...newType, name: symbolName });
    if (oldMembers && newType) {
      const newAlias = this.aliasMembers(moved.filePath, moved.content, moved.importedName);
      return this.compareAcrossKinds(symbolName, oldMembers, newAlias, 'an interface', 'a type alias');
    }
    if (!oldType || !newMembers) return undefined;
    const oldAlias = this.aliasMembers(oldPath, oldContent, symbolName);
    // An inferred alias (`ReturnType<typeof f>`) has no member list in the source, so
    // spelling the inferred shape out as an interface has nothing to lose that could be compared.
    if (!oldAlias && /^ReturnType\s*</.test(oldType.type)) {
      return this.kindChangeResult(symbolName, [], `'${symbolName}' changed from an inferred type alias to an interface; the inferred shape is not compared`, 'warning');
    }
    return this.compareAcrossKinds(symbolName, oldAlias, newMembers, 'a type alias', 'an interface');
  }

  /**
   * An interface that became an object literal type alias, or the reverse: members compare as
   * between two interfaces, plus a warning for the kind. Any other alias type has no member
   * list to compare, so the change stays breaking.
   */
  private compareAcrossKinds(
    symbolName: string,
    oldMembers: InterfaceMemberInfo[] | undefined,
    newMembers: InterfaceMemberInfo[] | undefined,
    oldKind: string,
    newKind: string,
  ): SignatureComparisonResult {
    if (!oldMembers || !newMembers) {
      return this.kindChangeResult(symbolName, [], `'${symbolName}' changed from ${oldKind} to ${newKind} whose members cannot be compared`, 'error');
    }
    const members = this.compareInterfaces(symbolName, oldMembers, newMembers);
    return this.kindChangeResult(symbolName, members.breakingChanges, `'${symbolName}' changed from ${oldKind} to ${newKind}`, 'warning');
  }

  private kindChangeResult(
    symbolName: string,
    memberChanges: BreakingChange[],
    description: string,
    severity: BreakingChange['severity'],
  ): SignatureComparisonResult {
    return {
      symbolName,
      hasBreakingChanges: true,
      breakingChanges: [...memberChanges, { type: 'type-alias-changed', symbolName, description, severity }],
      nonBreakingChanges: [],
    };
  }

  /**
   * Compare functions between old and new content
   */
  private compareFunctions(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[]
  ): void {
    const oldSigs = this.extractSignatures(`${filePath}.old`, oldContent);
    const newSigs = this.extractSignatures(`${filePath}.new`, newContent);
    
    const oldSigMap = new Map(oldSigs.map(s => [s.name, s]));
    const newSigMap = new Map(newSigs.map(s => [s.name, s]));

    for (const [name, oldSig] of oldSigMap) {
      if (oldSig.isExported === false) continue;
      const newSig = newSigMap.get(name);
      if (newSig) {
        const result = this.compareSignatures(oldSig, newSig);
        if (result.hasBreakingChanges || result.nonBreakingChanges.length > 0) {
          results.push(result);
        }
      } else {
        results.push(this.createRemovedResult(name, 'member-removed', `Function '${name}' was removed`, oldSig.line));
      }
    }
  }

  /**
   * Compare interface definitions between old and new content
   */
  private compareInterfaceDefinitions(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[]
  ): void {
    const oldInterfaces = this.extractInterfaceMembers(`${filePath}.old`, oldContent);
    const newInterfaces = this.extractInterfaceMembers(`${filePath}.new`, newContent);

    for (const [name, oldMembers] of oldInterfaces) {
      const newMembers = newInterfaces.get(name);
      if (newMembers) {
        const result = this.compareInterfaces(name, oldMembers, newMembers);
        if (result.hasBreakingChanges || result.nonBreakingChanges.length > 0) {
          results.push(result);
        }
      } else {
        results.push(this.createRemovedResult(name, 'member-removed', `Interface '${name}' was removed`));
      }
    }
  }

  /**
   * Compare type alias definitions between old and new content
   */
  private compareTypeAliasDefinitions(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[]
  ): void {
    const oldTypes = this.extractTypeAliases(`${filePath}.old`, oldContent);
    const newTypes = this.extractTypeAliases(`${filePath}.new`, newContent);
    
    const oldTypeMap = new Map(oldTypes.map(t => [t.name, t]));
    const newTypeMap = new Map(newTypes.map(t => [t.name, t]));

    for (const [name, oldType] of oldTypeMap) {
      const newType = newTypeMap.get(name);
      if (newType) {
        const result = this.compareTypeAliases(oldType, newType);
        if (result.hasBreakingChanges) {
          results.push(result);
        }
      } else {
        results.push(this.createRemovedResult(name, 'type-alias-changed', `Type alias '${name}' was removed`));
      }
    }
  }

  /** Exported enums kept by the new content, member by member; a removed enum leaves the export set, see compareExportSets. */
  private compareEnumDefinitions(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[]
  ): void {
    const newEnums = this.enumMembers(`${filePath}.new`, newContent);
    for (const [name, oldMembers] of this.enumMembers(`${filePath}.old`, oldContent)) {
      const newMembers = newEnums.get(name);
      if (!newMembers) continue;
      const breakingChanges: BreakingChange[] = [];
      for (const [member, oldValue] of oldMembers) {
        const newValue = newMembers.get(member);
        if (!newMembers.has(member)) {
          breakingChanges.push({ type: 'member-removed', symbolName: `${name}.${member}`, severity: 'error', description: `Member '${member}' removed from enum '${name}'` });
        } else if (newValue !== oldValue) {
          // Compiles everywhere, but a value stored or sent elsewhere no longer maps to this member.
          breakingChanges.push({
            type: 'member-type-changed', symbolName: `${name}.${member}`, severity: 'warning',
            description: `Value of enum member '${name}.${member}' changed from ${oldValue} to ${newValue}`, oldValue, newValue,
          });
        }
      }
      const added = [...newMembers.keys()].filter((member) => !oldMembers.has(member));
      if (added.length > 0) breakingChanges.push(memberAddedChange(`Enum '${name}'`, name, added));
      if (breakingChanges.length > 0) results.push({ symbolName: name, hasBreakingChanges: true, breakingChanges, nonBreakingChanges: [] });
    }
  }

  /**
   * Members of each exported enum with their value as written: the initializer, or the
   * implicit number following the previous numeric one ('?' after a computed member).
   */
  private enumMembers(filePath: string, content: string): Map<string, Map<string, string>> {
    const enums = new Map<string, Map<string, string>>();
    for (const declaration of this.getOrCreateSourceFile(filePath, content).getEnums()) {
      if (!declaration.isExported()) continue;
      const members = new Map<string, string>();
      let next: number | undefined = 0;
      for (const member of declaration.getMembers()) {
        const initializer = member.getInitializer()?.getText();
        const value: string = initializer ?? (next === undefined ? '?' : String(next));
        const numeric: number = Number(value);
        next = Number.isFinite(numeric) && value.trim() !== '' ? numeric + 1 : undefined;
        members.set(member.getName(), value);
      }
      enums.set(declaration.getName(), members);
    }
    return enums;
  }

  /**
   * Reports each name the old file exports that the new one no longer does, however it was
   * exported (keyword, `export { x as y }`, default, `export =`, `export *`). A name whose
   * declaration is gone and that a comparison above already reports is not repeated, and a
   * file emptied or deleted is left to those comparisons. A re-export keeps a name exported,
   * and so does an `export *` from the module the name was re-exported from.
   */
  private compareExportSets(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[]
  ): void {
    if (newContent.trim() === '') return;
    const newExports = this.exportNames(`${filePath}.new`, newContent);
    const stillDeclared = new Set(this.declaredNames(filePath, 'new', newContent));
    const reported = new Set(results.map((result) => result.symbolName.split('.')[0]));
    const oldSource = this.getOrCreateSourceFile(`${filePath}.old`, oldContent);
    const reexportedFrom = new Map(this.exportClauseNames(oldSource).map(({ name, from }) => [name, from]));
    for (const name of this.exportNames(`${filePath}.old`, oldContent)) {
      const from = reexportedFrom.get(name);
      if (newExports.has(name) || (from !== undefined && newExports.has(wildcardExport(from)))) continue;
      if (reported.has(name) && !stillDeclared.has(name)) continue;
      results.push(this.createRemovedResult(name, 'member-removed', `Export '${name}' was removed`));
    }
  }

  /** Names `content` exports to importers: 'default' and 'export=' for those forms, `* from '<module>'` for `export *`. */
  private exportNames(filePath: string, content: string): Set<string> {
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const names = new Set([
      ...this.exportedDeclarationExportNames(sourceFile),
      ...this.exportClauseNames(sourceFile).map(({ name }) => name),
    ]);
    for (const assignment of sourceFile.getExportAssignments()) names.add(assignment.isExportEquals() ? 'export=' : 'default');
    return names;
  }

  private exportedDeclarationExportNames(sourceFile: SourceFile): string[] {
    const exported = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getClasses(),
      ...sourceFile.getEnums(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ].filter((declaration) => declaration.isExported());
    return [
      ...exported.map((declaration) => (declaration.isDefaultExport() ? 'default' : declaration.getName() ?? 'default')),
      ...sourceFile.getVariableStatements()
        .filter((statement) => statement.isExported())
        .flatMap((statement) => statement.getDeclarations().flatMap((declaration) => this.boundNames(declaration.getNameNode()))),
    ];
  }

  /** Identifiers a declaration binds: one name, or every element of a destructuring pattern. */
  private boundNames(nameNode: Node): string[] {
    if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
    return nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)
      .map((element) => element.getNameNode())
      .filter((node) => Node.isIdentifier(node))
      .map((node) => node.getText());
  }

  /** Names of `export { x as y }`, `export { x } from`, `export * as ns` and `export *` clauses, with their source module. */
  private exportClauseNames(sourceFile: SourceFile): Array<{ name: string; from?: string }> {
    return sourceFile.getExportDeclarations().flatMap((declaration) => {
      const from = declaration.getModuleSpecifierValue();
      if (!declaration.isNamespaceExport()) {
        return declaration.getNamedExports().map((specifier) => ({ name: specifier.getAliasNode()?.getText() ?? specifier.getName(), from }));
      }
      return [{ name: declaration.getNamespaceExport()?.getName() ?? wildcardExport(from), from }];
    });
  }

  /**
   * Top-level declarations plus the member names results use (`Class.method`, `Component.props`),
   * so a declared symbol with nothing comparable (an enum, a constant) is not reported as unknown.
   */
  private declaredNames(filePath: string, side: 'old' | 'new', content: string): string[] {
    if (isPythonFile(filePath)) return [...pythonDeclarations(content).names.keys()];
    const sideFilePath = `${filePath}.${side}`;
    const names = [
      ...this.extractSignatures(sideFilePath, content).map((s) => s.name),
      ...this.extractInterfaceMembers(sideFilePath, content).keys(),
      ...this.extractTypeAliases(sideFilePath, content).map((t) => t.name),
    ];
    const sourceFile = this.getOrCreateSourceFile(sideFilePath, content);
    for (const declaration of [
      ...sourceFile.getClasses(),
      ...sourceFile.getEnums(),
      ...sourceFile.getVariableDeclarations(),
      ...sourceFile.getInterfaces(),
      ...sourceFile.getTypeAliases(),
    ]) {
      const name = declaration.getName();
      if (name) names.push(name);
    }
    if (this.isVueFile(filePath) && this.extractVueProps(sideFilePath, content).length > 0) {
      names.push(this.vuePropsName(filePath));
    }
    return names;
  }

  private vuePropsName(filePath: string): string {
    return `${path.basename(filePath, path.extname(filePath))}.props`;
  }

  /**
   * Public top-level names of a Python module that are gone or whose function signature changed. A name that
   * changed kind (a function turned into a class) is still importable, so it is not reported as removed.
   */
  private comparePythonModules(oldContent: string, newContent: string): SignatureComparisonResult[] {
    const before = pythonDeclarations(oldContent);
    const after = pythonDeclarations(newContent);
    const newFunctions = new Map(after.functions.map((fn) => [fn.name, fn]));
    const results: SignatureComparisonResult[] = [];
    for (const oldFn of before.functions) {
      const newFn = newFunctions.get(oldFn.name);
      if (!oldFn.isExported || !newFn) continue;
      const result = this.comparePythonFunctions(oldFn, newFn);
      if (result.hasBreakingChanges || result.nonBreakingChanges.length > 0) results.push(result);
    }
    for (const [name, { kind, line }] of before.names) {
      if (isPublicPythonName(name) && !after.names.has(name)) {
        results.push(this.createRemovedResult(name, 'member-removed', `${PYTHON_KIND_LABELS[kind]} '${name}' was removed`, line));
      }
    }
    return results;
  }

  /**
   * `compareSignatures`, except that adding or dropping an annotation is not a contract change (Python does not
   * check it at a call), and switching between `def` and `async def` is: callers then get, or stop getting, a coroutine.
   */
  private comparePythonFunctions(oldSig: SignatureInfo, newSig: SignatureInfo): SignatureComparisonResult {
    const result = this.compareSignatures(oldSig, newSig);
    const annotationOnly = (change: BreakingChange) =>
      (change.type === 'parameter-type-changed' || change.type === 'return-type-changed') && (change.oldValue === '' || change.newValue === '');
    const breakingChanges = result.breakingChanges.filter((change) => !annotationOnly(change));
    const nonBreakingChanges = [
      ...result.nonBreakingChanges,
      ...result.breakingChanges.filter(annotationOnly).map((change) => `${change.description} (annotation added or removed)`),
    ];
    if (oldSig.isAsync !== newSig.isAsync) {
      breakingChanges.push({
        type: 'return-type-changed', symbolName: newSig.name, severity: 'error', line: newSig.line,
        description: newSig.isAsync ? `'${newSig.name}' became async: callers now get a coroutine` : `'${newSig.name}' is no longer async: callers no longer get a coroutine`,
        oldValue: oldSig.isAsync ? 'async' : 'sync', newValue: newSig.isAsync ? 'async' : 'sync',
      });
    }
    return { ...result, hasBreakingChanges: breakingChanges.length > 0, breakingChanges, nonBreakingChanges };
  }

  /**
   * Create a result for a removed symbol
   */
  private createRemovedResult(
    name: string,
    type: BreakingChangeType,
    description: string,
    line?: number
  ): SignatureComparisonResult {
    return {
      symbolName: name,
      hasBreakingChanges: true,
      breakingChanges: [{
        type,
        symbolName: name,
        description,
        severity: 'error',
        line,
      }],
      nonBreakingChanges: [],
    };
  }

  private getOrCreateSourceFile(filePath: string, content: string): SourceFile {
    // Always remove existing file to avoid stale type references
    const existing = this.project.getSourceFile(filePath);
    if (existing) {
      this.project.removeSourceFile(existing);
    }
    return this.project.createSourceFile(filePath, this.isVueFile(filePath) ? this.extractVueScript(content) : content);
  }

  private isVueFile(filePath: string): boolean {
    return /\.vue(?:\.(?:old|new))?$/i.test(filePath);
  }

  private extractVueScript(content: string): string {
    // Vue SFC closing tags may contain whitespace or parser-tolerated attributes.
    const scripts = [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*[^>]*>/gi)].map(match => match[1]); // NOSONAR
    return scripts.length > 0 ? scripts.join('\n') : content;
  }

  private compareVueProps(
    filePath: string,
    oldContent: string,
    newContent: string,
    results: SignatureComparisonResult[],
  ): void {
    const oldProps = this.extractVueProps(`${filePath}.old`, oldContent);
    const newProps = this.extractVueProps(`${filePath}.new`, newContent);
    const componentName = this.vuePropsName(filePath);
    const oldMembers = oldProps;
    const newMembers = newProps;
    if (oldMembers.length === 0 && newMembers.length === 0) return;

    const comparison = this.compareInterfaces(componentName, oldMembers, newMembers);
    if (comparison.hasBreakingChanges || comparison.nonBreakingChanges.length > 0) {
      results.push(comparison);
    }
  }

  private extractVueProps(filePath: string, content: string): InterfaceMemberInfo[] {
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const defineProps = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .find(call => call.getExpression().getText() === 'defineProps');
    if (!defineProps) return this.extractDecoratedVueProps(sourceFile);

    const typeArgument = defineProps.getTypeArguments()[0];
    if (typeArgument?.getKind() === SyntaxKind.TypeLiteral) {
      return this.extractTypeLiteralProperties(typeArgument.asKindOrThrow(SyntaxKind.TypeLiteral));
    }
    if (typeArgument?.getKind() === SyntaxKind.TypeReference) {
      const typeName = typeArgument.getText().split('<', 1)[0];
      const interfaceDeclaration = sourceFile.getInterface(typeName)?.getMembers();
      const typeAliasNode = sourceFile.getTypeAlias(typeName)?.getTypeNode();
      const declaration = interfaceDeclaration
        ?? typeAliasNode?.asKind(SyntaxKind.TypeLiteral)?.getMembers();
      if (declaration) {
        return declaration
        .filter(member => member.getKind() === SyntaxKind.PropertySignature)
        .map(member => {
          const property = member.asKindOrThrow(SyntaxKind.PropertySignature);
          return {
            name: property.getName(),
            kind: 'property' as const,
            type: this.safeGetTypeNodeText(property.getTypeNode(), 'unknown'),
            isOptional: property.hasQuestionToken(),
            isReadonly: property.isReadonly(),
          };
        });
      }
    }

    const runtimeObject = defineProps.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!runtimeObject) return [];
    return runtimeObject.getProperties()
      .filter(property => property.getKind() === SyntaxKind.PropertyAssignment)
      .map(property => {
        const assignment = property.asKindOrThrow(SyntaxKind.PropertyAssignment);
        const initializer = assignment?.getInitializer()?.asKind(SyntaxKind.ObjectLiteralExpression);
        const required = initializer?.getProperty('required')?.getText().includes('true') ?? false;
        const type = initializer?.getProperty('type')?.getText() ?? 'unknown';
        return {
          name: assignment.getName(),
          kind: 'property' as const,
          type,
          isOptional: !required,
          isReadonly: false,
        };
      });
  }

  private extractDecoratedVueProps(sourceFile: SourceFile): InterfaceMemberInfo[] {
    const props: InterfaceMemberInfo[] = [];
    for (const classDeclaration of sourceFile.getClasses()) {
      for (const property of classDeclaration.getProperties()) {
        const decorator = property.getDecorators().find(candidate => {
          const name = candidate.getName();
          return name === 'Prop' || name === 'Model';
        });
        if (!decorator) continue;
        const argument = decorator.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
        const required = argument?.getProperty('required')?.getText().includes('true') ?? false;
        props.push({
          name: property.getName(),
          kind: 'property',
          type: this.safeGetTypeNodeText(property.getTypeNode(), 'unknown'),
          isOptional: !required,
          isReadonly: property.isReadonly(),
        });
      }
    }
    return props;
  }

  /**
   * Whether an object-literal parameter type only gained optional properties.
   * The types differ as text, yet every argument that fitted the old type still
   * fits the new one, so no call site breaks.
   */
  private isOptionalPropertyWidening(oldType: string, newType: string): boolean {
    const oldProperties = this.parseTypeLiteralProperties(oldType);
    const newProperties = this.parseTypeLiteralProperties(newType);
    return oldProperties !== null && newProperties !== null
      && !this.compareInterfaces('parameter', oldProperties, newProperties).hasBreakingChanges;
  }

  /** Properties of a `{ ... }` type, or null when the type is anything else or has non-property members. */
  private parseTypeLiteralProperties(typeText: string): InterfaceMemberInfo[] | null {
    const typeLiteral = this.getOrCreateSourceFile(PARAMETER_TYPE_FILE, `type T = ${typeText};`)
      .getTypeAlias('T')?.getTypeNode()?.asKind(SyntaxKind.TypeLiteral);
    if (!typeLiteral) return null;
    const properties = this.extractTypeLiteralProperties(typeLiteral);
    return properties.length === typeLiteral.getMembers().length ? properties : null;
  }

  private extractTypeLiteralProperties(typeLiteral: TypeLiteralNode): InterfaceMemberInfo[] {
    return typeLiteral.getMembers()
      .filter(member => member.getKind() === SyntaxKind.PropertySignature)
      .map(member => {
        const property = member.asKindOrThrow(SyntaxKind.PropertySignature);
        return {
          name: property.getName(),
          kind: 'property' as const,
          type: this.safeGetTypeNodeText(property.getTypeNode(), 'unknown'),
          isOptional: property.hasQuestionToken(),
          isReadonly: property.isReadonly(),
        };
      });
  }

  private extractFunctionSignature(func: import('ts-morph').FunctionDeclaration): SignatureInfo | null {
    const name = func.getName();
    if (!name) return null;

    return {
      name,
      kind: 'function',
      isExported: func.isExported(),
      parameters: this.extractParameters(func.getParameters()),
      returnType: this.safeGetTypeNodeText(func.getReturnTypeNode(), 'void'),
      isAsync: func.isAsync(),
      typeParameters: func.getTypeParameters().map(tp => this.safeGetText(tp)),
      line: func.getStartLineNumber(),
    };
  }

  private extractParameters(params: ParameterDeclaration[]): ParameterInfo[] {
    return params.map((param, index) => ({
      name: param.getName(),
      type: this.safeGetTypeNodeText(param.getTypeNode(), 'unknown'),
      isOptional: param.isOptional(),
      hasDefault: param.hasInitializer(),
      isRest: param.isRestParameter(),
      position: index,
    }));
  }

  /**
   * Read the declared syntax instead of asking TypeScript's semantic checker.
   * A review diff commonly omits the full project context, so semantic type
   * resolution can throw for unresolved imports even when the declaration is valid.
   */
  private safeGetTypeNodeText(typeNode: { getText?: () => string } | undefined, fallback: string): string {
    if (!typeNode) return fallback;
    try {
      const text = typeNode.getText?.() ?? '';
      return text.length <= 200 ? text || fallback : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Safely get text from a node
   */
  private safeGetText(node: { getText?: () => string } | undefined): string {
    if (!node) return '';
    try {
      return node.getText?.() ?? '';
    } catch {
      return '';
    }
  }

  private getVisibility(
    node: { getScope?: () => import('ts-morph').Scope }
  ): 'public' | 'private' | 'protected' {
    const scope = node.getScope?.();
    if (!scope) return 'public';
    
    const scopeText = scope.toString().toLowerCase();
    if (scopeText.includes('private')) return 'private';
    if (scopeText.includes('protected')) return 'protected';
    return 'public';
  }

  private compareParameters(
    oldSig: SignatureInfo,
    newSig: SignatureInfo,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[]
  ): void {
    const oldParams = oldSig.parameters;
    const newParams = newSig.parameters;

    // Build maps for comparison
    const oldParamMap = new Map(oldParams.map(p => [p.name, p]));
    const newParamMap = new Map(newParams.map(p => [p.name, p]));

    // Check for removed parameters
    this.detectRemovedParameters(oldParams, newParamMap, newSig, breakingChanges);

    // Check each new parameter
    this.detectNewAndChangedParameters(newParams, oldParamMap, newSig, breakingChanges, nonBreakingChanges);

    // Check for position changes (can break positional calls)
    this.detectPositionChanges(oldParams, newParams, nonBreakingChanges);
  }

  /**
   * Detect parameters that were removed
   */
  private detectRemovedParameters(
    oldParams: ParameterInfo[],
    newParamMap: Map<string, ParameterInfo>,
    newSig: SignatureInfo,
    breakingChanges: BreakingChange[]
  ): void {
    for (const oldParam of oldParams) {
      if (!newParamMap.has(oldParam.name)) {
        breakingChanges.push({
          type: 'parameter-removed',
          symbolName: newSig.name,
          description: `Parameter '${oldParam.name}' was removed`,
          severity: 'error',
          oldValue: `${oldParam.name}: ${oldParam.type}`,
          line: newSig.line,
          ...(oldParam.isOptional || oldParam.hasDefault || oldParam.isRest
            ? { breaksCallsWithArgs: oldParam.position + 1 }
            : {}),
        });
      }
    }
  }

  /**
   * Detect new parameters and changes to existing parameters
   */
  private detectNewAndChangedParameters(
    newParams: ParameterInfo[],
    oldParamMap: Map<string, ParameterInfo>,
    newSig: SignatureInfo,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[]
  ): void {
    for (const newParam of newParams) {
      const oldParam = oldParamMap.get(newParam.name);

      if (!oldParam) {
        this.handleNewParameter(newParam, newSig, breakingChanges, nonBreakingChanges);
        continue;
      }

      this.handleChangedParameter(oldParam, newParam, newSig, breakingChanges, nonBreakingChanges);
    }
  }

  /**
   * Handle a newly added parameter
   */
  private handleNewParameter(
    newParam: ParameterInfo,
    newSig: SignatureInfo,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[]
  ): void {
    const isOptionalOrDefault = newParam.isOptional || newParam.hasDefault;
    if (isOptionalOrDefault) {
      nonBreakingChanges.push(`New optional parameter '${newParam.name}' added`);
    } else {
      breakingChanges.push({
        type: 'parameter-added-required',
        symbolName: newSig.name,
        description: `New required parameter '${newParam.name}' added`,
        severity: 'error',
        newValue: `${newParam.name}: ${newParam.type}`,
        line: newSig.line,
      });
    }
  }

  /**
   * Handle changes to an existing parameter
   */
  private handleChangedParameter(
    oldParam: ParameterInfo,
    newParam: ParameterInfo,
    newSig: SignatureInfo,
    breakingChanges: BreakingChange[],
    nonBreakingChanges: string[]
  ): void {
    // Check type change
    if (oldParam.type !== newParam.type && this.isOptionalPropertyWidening(oldParam.type, newParam.type)) {
      nonBreakingChanges.push(`Parameter '${newParam.name}' gained optional properties`);
    } else if (oldParam.type !== newParam.type) {
      breakingChanges.push({
        type: 'parameter-type-changed',
        symbolName: newSig.name,
        description: `Type of parameter '${newParam.name}' changed from '${oldParam.type}' to '${newParam.type}'`,
        severity: 'error',
        oldValue: oldParam.type,
        newValue: newParam.type,
        line: newSig.line,
      });
    }

    // Check optional → required
    const wasOptional = oldParam.isOptional || oldParam.hasDefault;
    const isNowRequired = !newParam.isOptional && !newParam.hasDefault;
    if (wasOptional && isNowRequired) {
      breakingChanges.push({
        type: 'parameter-optional-to-required',
        symbolName: newSig.name,
        description: `Parameter '${newParam.name}' changed from optional to required`,
        severity: 'error',
        line: newSig.line,
      });
    }
  }

  /**
   * Detect parameter position changes
   */
  private detectPositionChanges(
    oldParams: ParameterInfo[],
    newParams: ParameterInfo[],
    nonBreakingChanges: string[]
  ): void {
    const minLength = Math.min(oldParams.length, newParams.length);
    for (let i = 0; i < minLength; i++) {
      if (oldParams[i].name !== newParams[i].name) {
        nonBreakingChanges.push(
          `Parameter order changed at position ${i}: '${oldParams[i].name}' → '${newParams[i].name}'`
        );
      }
    }
  }
}

/**
 * Python counterpart of `reexportsOf`: every `from m import x [as name]` binds `name` in the module, so importers
 * still find it; `from m import *` may, unless `name` is private.
 */
function pythonReexportsOf(content: string, name: string): Array<{ specifier: string; importedName: string; wildcard?: boolean }> {
  return pythonReExports(content).reExports.flatMap(({ specifier, names }) => {
    if (names === 'all') return pythonStarExports(name, undefined) ? [{ specifier, importedName: name, wildcard: true }] : [];
    const exported = names.find((pair) => pair.exported === name);
    return exported ? [{ specifier, importedName: exported.imported }] : [];
  });
}

/** Whether `from target import *` leaves `name` out: a Python target whose `__all__` does not list it. */
function hiddenFromPythonStar(target: ReexportedModule, name: string): boolean {
  return isPythonFile(target.filePath) && !pythonStarExports(name, pythonReExports(target.content).starNames);
}

/** Specifiers of `import()` calls and types, `require()` calls and `import x = require()`. */
function dynamicSpecifiers(sourceFile: SourceFile): string[] {
  const specifiers: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const [argument] = call.getArguments();
    const isLoader = callee.getKind() === SyntaxKind.ImportKeyword || callee.getText() === 'require';
    if (isLoader && Node.isStringLiteral(argument)) specifiers.push(argument.getLiteralValue());
  }
  for (const importType of sourceFile.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const literal = importType.getArgument().getFirstDescendantByKind(SyntaxKind.StringLiteral);
    if (literal) specifiers.push(literal.getLiteralValue());
  }
  for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.ExternalModuleReference)) {
    const expression = reference.getExpression();
    if (Node.isStringLiteral(expression)) specifiers.push(expression.getLiteralValue());
  }
  return specifiers;
}

/** Members `newType` adds to the union `oldType` (a lone type counts as a one-member union); undefined unless it only adds. */
function addedUnionMembers(oldType: TypeAliasInfo, newType: TypeAliasInfo): string[] | undefined {
  if (!newType.unionMembers) return undefined;
  const before = oldType.unionMembers ?? [oldType.type];
  const after = new Set(newType.unionMembers);
  if (!before.every((member) => after.has(member))) return undefined;
  const added = newType.unionMembers.filter((member) => !before.includes(member));
  return added.length > 0 ? added : undefined;
}

/** A union or enum that gained members: compatible for its producers, breaking for consumers that handle every member. */
function memberAddedChange(subject: string, symbolName: string, added: string[], oldValue?: string, newValue?: string): BreakingChange {
  return {
    type: 'member-added', symbolName, severity: 'warning', oldValue, newValue,
    description: `${subject} gained member(s) ${added.join(', ')}: consumers that handle every member (exhaustive switch, Record, mapped type) must handle them too`,
  };
}
