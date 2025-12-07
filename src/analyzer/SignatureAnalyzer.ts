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

import { Project, SourceFile, SyntaxKind, type ParameterDeclaration } from 'ts-morph';

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
  | 'member-type-changed'          // Interface/class member type changed
  | 'member-optional-to-required'  // Optional member became required
  | 'type-alias-changed';          // Type alias definition changed

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
          parameters: this.extractParameters(ctor.getParameters()),
          returnType: className,
          isAsync: false,
          line: ctor.getStartLineNumber(),
        });
      }

      // Methods
      for (const method of classDecl.getMethods()) {
        const methodName = method.getName();
        signatures.push({
          name: `${className}.${methodName}`,
          kind: 'method',
          parameters: this.extractParameters(method.getParameters()),
          returnType: this.safeGetTypeText(method.getReturnType(), 'void'),
          isAsync: method.isAsync(),
          isStatic: method.isStatic(),
          visibility: this.getVisibility(method),
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
          parameters: this.extractParameters(arrowFunc.getParameters()),
          returnType: this.safeGetTypeText(arrowFunc.getReturnType(), 'unknown'),
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

    for (const iface of sourceFile.getInterfaces()) {
      const name = iface.getName();
      const members: InterfaceMemberInfo[] = [];

      // Properties
      for (const prop of iface.getProperties()) {
        members.push({
          name: prop.getName(),
          kind: 'property',
          type: this.safeGetTypeText(prop.getType(), 'unknown'),
          isOptional: prop.hasQuestionToken(),
          isReadonly: prop.isReadonly(),
        });
      }

      // Methods
      for (const method of iface.getMethods()) {
        const params = method.getParameters().map(p => `${p.getName()}: ${this.safeGetTypeText(p.getType(), 'unknown')}`).join(', ');
        const returnType = this.safeGetTypeText(method.getReturnType(), 'unknown');
        members.push({
          name: method.getName(),
          kind: 'method',
          type: `(${params}) => ${returnType}`,
          isOptional: method.hasQuestionToken(),
          isReadonly: false,
        });
      }

      result.set(name, members);
    }

    return result;
  }

  /**
   * Extract type alias definitions
   */
  public extractTypeAliases(filePath: string, content: string): TypeAliasInfo[] {
    const sourceFile = this.getOrCreateSourceFile(filePath, content);
    const types: TypeAliasInfo[] = [];

    for (const typeAlias of sourceFile.getTypeAliases()) {
      types.push({
        name: typeAlias.getName(),
        type: this.safeGetTypeText(typeAlias.getType(), 'unknown'),
        typeParameters: typeAlias.getTypeParameters().map(tp => this.safeGetText(tp)),
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

    // Check for removed members
    for (const [name, oldMember] of oldMemberMap) {
      if (!newMemberMap.has(name)) {
        breakingChanges.push({
          type: 'member-removed',
          symbolName: `${interfaceName}.${name}`,
          description: `Member '${name}' was removed from interface '${interfaceName}'`,
          severity: 'error',
          oldValue: oldMember.type,
        });
      }
    }

    // Check for type changes and optional → required
    for (const [name, newMember] of newMemberMap) {
      const oldMember = oldMemberMap.get(name);
      
      if (!oldMember) {
        if (newMember.isOptional) {
          nonBreakingChanges.push(`New optional member '${name}' added`);
        } else {
          // New required member is a breaking change
          breakingChanges.push({
            type: 'member-optional-to-required',
            symbolName: `${interfaceName}.${name}`,
            description: `New required member '${name}' added to interface '${interfaceName}'`,
            severity: 'error',
            newValue: newMember.type,
          });
        }
        continue;
      }

      // Check type change
      if (oldMember.type !== newMember.type) {
        breakingChanges.push({
          type: 'member-type-changed',
          symbolName: `${interfaceName}.${name}`,
          description: `Type of member '${name}' changed from '${oldMember.type}' to '${newMember.type}'`,
          severity: 'error',
          oldValue: oldMember.type,
          newValue: newMember.type,
        });
      }

      // Check optional → required
      if (oldMember.isOptional && !newMember.isOptional) {
        breakingChanges.push({
          type: 'member-optional-to-required',
          symbolName: `${interfaceName}.${name}`,
          description: `Member '${name}' changed from optional to required`,
          severity: 'error',
        });
      }
    }

    return {
      symbolName: interfaceName,
      hasBreakingChanges: breakingChanges.length > 0,
      breakingChanges,
      nonBreakingChanges,
    };
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

    if (oldType.type !== newType.type) {
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
   * Analyze a file for potential breaking changes compared to an old version
   */
  public analyzeBreakingChanges(
    filePath: string,
    oldContent: string,
    newContent: string
  ): SignatureComparisonResult[] {
    const results: SignatureComparisonResult[] = [];

    // Compare functions
    this.compareFunctions(filePath, oldContent, newContent, results);

    // Compare interfaces
    this.compareInterfaceDefinitions(filePath, oldContent, newContent, results);

    // Compare type aliases
    this.compareTypeAliasDefinitions(filePath, oldContent, newContent, results);

    return results;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

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
    return this.project.createSourceFile(filePath, content);
  }

  private extractFunctionSignature(func: import('ts-morph').FunctionDeclaration): SignatureInfo | null {
    const name = func.getName();
    if (!name) return null;

    return {
      name,
      kind: 'function',
      parameters: this.extractParameters(func.getParameters()),
      returnType: this.safeGetTypeText(func.getReturnType(), 'void'),
      isAsync: func.isAsync(),
      typeParameters: func.getTypeParameters().map(tp => this.safeGetText(tp)),
      line: func.getStartLineNumber(),
    };
  }

  private extractParameters(params: ParameterDeclaration[]): ParameterInfo[] {
    return params.map((param, index) => ({
      name: param.getName(),
      type: this.safeGetTypeText(param.getType(), 'unknown'),
      isOptional: param.isOptional(),
      hasDefault: param.hasInitializer(),
      isRest: param.isRestParameter(),
      position: index,
    }));
  }

  /**
   * Safely get type text, handling edge cases where getText() may fail
   */
  private safeGetTypeText(type: import('ts-morph').Type | undefined, fallback: string): string {
    if (!type) return fallback;
    try {
      const text = type.getText();
      // Avoid overly complex type representations
      if (text.length > 200) {
        return type.getBaseTypeOfLiteralType()?.getText() ?? fallback;
      }
      return text || fallback;
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
    
    const scopeText = scope.toString();
    if (scopeText.includes('Private')) return 'private';
    if (scopeText.includes('Protected')) return 'protected';
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

      this.handleChangedParameter(oldParam, newParam, newSig, breakingChanges);
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
    breakingChanges: BreakingChange[]
  ): void {
    // Check type change
    if (oldParam.type !== newParam.type) {
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
