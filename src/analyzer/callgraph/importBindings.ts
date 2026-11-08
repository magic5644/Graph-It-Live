import { DEFAULT_ONLY, findDeclaration, type DeclarationReads } from "@/analyzer/utils/declarations";
import type { PathResolver } from "@/analyzer/utils/PathResolver";
import type { ReExportTarget } from "@/analyzer/utils/reExports";
import { mapWithConcurrency } from "@/shared/concurrency";
import { normalizePath } from "@/shared/path";
import type { Node as TreeNode } from "web-tree-sitter";
import { objectType } from "./receiverTypes";
import { chainNames, importedNames, returnedReceiverStub, resolveName, type ChainContext, type ChainMemo } from "./returnedTypes";

const NAMESPACE_CALL_CONCURRENCY = 8;

const FUNCTION_SCOPES = new Set([
  "function_declaration", "function_expression", "arrow_function",
  "generator_function_declaration", "generator_function", "method_definition",
]);
const BLOCK_SCOPES = new Set([
  "statement_block", "for_statement", "for_in_statement", "catch_clause", "switch_body",
]);

function bindingNames(node: TreeNode | null): TreeNode[] {
  if (!node) return [];
  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "shorthand_property_identifier_pattern":
      return [node];
    case "pair_pattern":
      return bindingNames(node.childForFieldName("value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return bindingNames(node.childForFieldName("left"));
    case "required_parameter":
    case "optional_parameter":
      return bindingNames(node.childForFieldName("pattern"));
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
    case "formal_parameters":
      return node.namedChildren.flatMap(bindingNames);
    default:
      return [];
  }
}

function enclosingScope(node: TreeNode, functionOnly: boolean): TreeNode {
  let scope = node.parent ?? node;
  while (scope.parent && !FUNCTION_SCOPES.has(scope.type) &&
    (functionOnly || !BLOCK_SCOPES.has(scope.type))) {
    scope = scope.parent;
  }
  return scope;
}

/** Where `name` imported from `modulePath` is declared (the barrel's real declaration); null when nothing is exported under it. */
function declarationOf(declared: ReExportTarget | typeof DEFAULT_ONLY | null, modulePath: string, name: string): ReExportTarget | null {
  return declared === DEFAULT_ONLY ? null : { filePath: declared?.filePath ?? normalizePath(modulePath), name: declared?.name ?? name };
}

/** `@@import:` stub reaching `name` in `modulePath` (or the barrel's real declaration); null when nothing is exported under it. */
function importStub(declared: ReExportTarget | typeof DEFAULT_ONLY | null, modulePath: string, name: string): string | null {
  const declaration = declarationOf(declared, modulePath, name);
  return declaration && `@@import:${JSON.stringify([declaration.filePath, declaration.name])}`;
}

/** A named or default import: where it is declared, and whether only its type is imported (`import type`). */
interface ImportedDeclaration extends ReExportTarget { typeOnly: boolean }

/**
 * Named and default import bindings: local name -> its declaration, or null when it links nowhere. Only bindings
 * that a capture or a receiver type names (`used`) are resolved: the others stay null, so a module nothing calls is
 * never resolved.
 */
async function collectNamedImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
  reads: DeclarationReads,
  used: Set<string>,
): Promise<Map<string, ImportedDeclaration | null>> {
  const statements = root.namedChildren.filter(node => node.type === "import_statement");
  const bindings = await Promise.all(statements.map(async (statement): Promise<Array<[string, ImportedDeclaration | null]>> => {
    const names = importedNames(statement);
    const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
    const typeOnly = statement.children.some(node => node.type === "type");
    const needed = moduleName && names.some(({ local }) => used.has(local.text));
    const targetPath = needed ? await resolver.resolve(filePath, moduleName) : null;
    // Bindings are independent (own visited set, shared read cache): resolve them concurrently, in order.
    return Promise.all(names.map(async ({ local, imported, isType }): Promise<[string, ImportedDeclaration | null]> => {
      if (!targetPath || !used.has(local.text)) return [local.text, null];
      const declaration = declarationOf(await findDeclaration(targetPath, imported, resolver, reads), targetPath, imported);
      return [local.text, declaration && { ...declaration, typeOnly: typeOnly || isType }];
    }));
  }));
  return new Map(bindings.flat());
}

/** `import * as ns from './mod'` bindings: local name -> resolved module path. Type-only imports bind nothing at runtime. */
async function collectNamespaceImports(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
): Promise<Map<string, string>> {
  const entries = await Promise.all(root.namedChildren
    .filter(node => node.type === "import_statement" && !node.children.some(child => child.type === "type"))
    .map(async (statement): Promise<[string, string] | null> => {
      const local = statement.descendantsOfType("namespace_import")[0]?.namedChildren[0];
      const moduleName = statement.childForFieldName("source")?.namedChildren[0]?.text;
      const targetPath = local && moduleName ? await resolver.resolve(filePath, moduleName) : null;
      return local && targetPath ? [local.text, targetPath] : null;
    }));
  return new Map(entries.filter(entry => entry !== null));
}

function collectShadows(root: TreeNode, imports: { has(name: string): boolean }) {
  const shadows = new Map<string, Array<{ binding: TreeNode; scope: TreeNode }>>();
  const add = (pattern: TreeNode | null, scope: TreeNode) => {
    for (const binding of bindingNames(pattern)) {
      if (!imports.has(binding.text)) continue;
      const entries = shadows.get(binding.text) ?? [];
      entries.push({ binding, scope });
      shadows.set(binding.text, entries);
    }
  };
  const visit = (node: TreeNode) => {
    if (FUNCTION_SCOPES.has(node.type)) {
      add(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"), node);
      const scope = node.type.endsWith("declaration") ? enclosingScope(node, false) : node;
      add(node.childForFieldName("name"), scope);
    } else if (node.type === "variable_declarator") {
      add(node.childForFieldName("name"), enclosingScope(node, node.parent?.type === "variable_declaration"));
    } else if (node.type === "catch_clause") {
      add(node.childForFieldName("parameter"), node);
    } else if (node.type === "for_in_statement" && node.childForFieldName("kind")) {
      add(node.childForFieldName("left"), node.childForFieldName("kind")?.text === "var" ? enclosingScope(node, true) : node);
    } else if (node.type === "class_declaration") {
      add(node.childForFieldName("name"), enclosingScope(node, false));
    }
    node.namedChildren.forEach(visit);
  };
  visit(root);
  return shadows;
}

type Shadows = ReturnType<typeof collectShadows>;

/** Innermost local declaration of `node.text` whose scope contains `node`, if any. */
function findShadow(shadows: Shadows, node: Pick<TreeNode, "text" | "startIndex" | "endIndex">) {
  return shadows.get(node.text)
    ?.filter(({ scope }) => scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex)
    .sort((a, b) => b.scope.startIndex - a.scope.startIndex || a.scope.endIndex - b.scope.endIndex)[0];
}

/** The object of a `obj.member()` call whose member is `call`, if any. */
function memberObject(call: TreeNode): TreeNode | null {
  const member = call.parent;
  if (member?.type !== "member_expression" || member.childForFieldName("property")?.id !== call.id) return null;
  return member.childForFieldName("object");
}

/** The namespace identifier of a static `ns.member()` call whose member is `call`, if any. */
function namespaceObject(call: TreeNode): TreeNode | null {
  const object = memberObject(call);
  return object?.type === "identifier" ? object : null;
}

/** `@@import:` stub for a static `ns.member()` call on an unshadowed namespace import, else null. */
async function resolveNamespaceCall(
  call: TreeNode,
  namespaces: Map<string, string>,
  shadows: Shadows,
  resolver: PathResolver,
  reads: DeclarationReads,
): Promise<string | null | undefined> {
  const object = namespaceObject(call);
  const modulePath = object && !findShadow(shadows, object) ? namespaces.get(object.text) : undefined;
  if (!modulePath) return undefined;
  const declared = await findDeclaration(modulePath, call.text, resolver, reads);
  return importStub(declared, modulePath, call.text);
}

/** `@@import:` stub for the default export of the module a `lazy(() => import('./literal'))` loads, null when it does not resolve. */
async function resolveLazyImport(specifier: TreeNode, filePath: string, resolver: PathResolver, reads: DeclarationReads): Promise<string | null> {
  const modulePath = await resolver.resolve(filePath, specifier.text).catch(() => null);
  return modulePath ? importStub(await findDeclaration(modulePath, "default", resolver, reads), modulePath, "default") : null;
}

/** `@@import:` stub of a call on an imported binding; null for a type-only import or one that links nowhere. */
function callStub(declaration: ImportedDeclaration | null | undefined): string | null {
  return declaration && !declaration.typeOnly ? `@@import:${JSON.stringify([declaration.filePath, declaration.name])}` : null;
}

/** Local names of the file's named and default import bindings. */
export function importLocalNames(root: TreeNode): string[] {
  return root.namedChildren.filter(node => node.type === "import_statement").flatMap(importedNames).map(({ local }) => local.text);
}

/**
 * `@@import:` stubs of the named and default import bindings in `names` (a Vue template's uses), by local name;
 * null for a type-only import or one that links nowhere. A name no import binds is absent.
 */
export async function resolveImportBindings(
  root: TreeNode,
  filePath: string,
  resolver: PathResolver,
  names: ReadonlySet<string>,
  reads: DeclarationReads = new Map(),
): Promise<Map<string, string | null>> {
  const imports = await collectNamedImports(root, filePath, resolver, reads, new Set(names));
  return new Map([...imports].filter(([name]) => names.has(name)).map(([name, declaration]) => [name, callStub(declaration)]));
}

/**
 * Types of the receivers of member calls that an import binds (#499): `c.compute()` with `c: Calc`,
 * `new Calc().compute()`, `Calc.create()`; by call node id.
 */
function importedReceiverTypes(root: TreeNode, members: Map<number, TreeNode>, calls: TreeNode[], declarations: { wanted: Set<string> }): Map<number, string> {
  const types = new Map<number, string>();
  const imported = new Set(root.namedChildren.filter(node => node.type === "import_statement")
    .flatMap(importedNames).map(({ local }) => local.text));
  if (imported.size === 0) return types;
  const objects = calls.flatMap(call => {
    const object = members.get(call.id);
    return object ? [{ call, object, identifier: object.type === "identifier" ? object.text : null }] : [];
  });
  for (const { identifier } of objects) if (identifier) declarations.wanted.add(identifier);
  for (const { call, object, identifier } of objects) {
    // `Calc.create()`: a local binding of that name is a shadow, checked with the stub.
    const type = identifier && imported.has(identifier) ? identifier : objectType(object, declarations);
    if (type && imported.has(type)) types.set(call.id, type);
  }
  return types;
}

/**
 * `@@import:` stub of a method call on a receiver of an imported class, alias or barrel included: the module
 * declaring the class, the method and the class's declared name. A type-only import (`import type { C }`) types a
 * receiver as well. Undefined when a local declaration shadows the type name or the import does not resolve.
 */
function classMethodStub(call: TreeNode, type: string | undefined, imports: Map<string, ImportedDeclaration | null>, shadows: Shadows): string | undefined {
  if (type === undefined || findShadow(shadows, { text: type, startIndex: call.startIndex, endIndex: call.endIndex })) return undefined;
  const declaration = imports.get(type);
  return declaration ? `@@import:${JSON.stringify([declaration.filePath, call.text, declaration.name])}` : undefined;
}

/**
 * What a file needs to type the values its calls return (#623): a name binds its innermost declaration, a
 * top-level one or an import of this file (`imports`: those already resolved for its calls); a shadowed namespace
 * is no module.
 */
function returnedChain(
  root: TreeNode,
  filePath: string,
  pass: Pick<ChainContext, "resolver" | "reads" | "parse" | "declarations">,
  bindings: { namespaces: Map<string, string>; imports: (name: string) => ImportedDeclaration | null | undefined },
  shadows: () => Shadows,
): { context: ChainContext; memo: ChainMemo } {
  const { namespaces, imports } = bindings;
  const shadowed = (node: Pick<TreeNode, "text" | "startIndex" | "endIndex">) => findShadow(shadows(), node);
  const context: ChainContext = {
    ...pass, root, filePath, lang: "typescript",
    bound: (name, node) => {
      const shadow = shadowed({ text: name, startIndex: node.startIndex, endIndex: node.endIndex });
      if (shadow && shadow.scope.id !== root.id) return Promise.resolve(null);
      // An import already resolved for this file's calls is not resolved again.
      const imported = shadow ? undefined : imports(name);
      if (imported !== undefined) return Promise.resolve(imported && { filePath: imported.filePath, name: imported.name });
      return resolveName(filePath, name, context);
    },
    module: (object) => (object.type === "identifier" && !shadowed(object) ? namespaces.get(object.text) ?? null : null),
  };
  return { context, memo: new Map() };
}

/**
 * Resolve named, default and namespace imports, and `lazy()` module specifiers (`string_fragment` nodes), before
 * the AST is freed; unknown bindings never fall back to global names. A reference (`references`: `<Card />`,
 * `register(save)`) that no import binds resolves through its scope: the innermost declaration of its name, so a
 * parameter or a local variable links nowhere, and a name declared nowhere stays unresolved.
 */
export async function resolveNamedImportCalls(
  root: TreeNode,
  calls: TreeNode[],
  filePath: string,
  resolver: PathResolver,
  { references = new Set(), declared = new Set(), parse }: {
    references?: ReadonlySet<number>;
    declared?: ReadonlySet<string>;
    /** Annotations of another file (#623); without it, a method called on a returned value is left to the extractor. */
    parse?: ChainContext["parse"];
  } = {},
  /** Shared by the files of one indexing pass, whose contents do not change during it; per call by default. */
  reads: DeclarationReads = new Map(),
): Promise<Map<number, string | null>> {
  // The object of each member call, read once for the receivers of #499 and the returned values of #623.
  const members = new Map(calls.flatMap((call): Array<[number, TreeNode]> => {
    const object = call.type === "property_identifier" ? memberObject(call) : null;
    return object ? [[call.id, object]] : [];
  }));
  // Only a file calling a method on a returned value (`make().m()`, #623) reads its own annotations.
  const chained = parse ? [...members.values()].filter(object => object.type === "call_expression") : [];
  // One read of the file's declarations serves the receivers of both.
  const declarations = { wanted: chainNames(chained, "typescript") };
  const receiverTypes = importedReceiverTypes(root, members, calls, declarations);
  const used = new Set([...calls.filter(call => call.type === "identifier").map(call => call.text), ...receiverTypes.values()]);
  const [imports, namespaces] = await Promise.all([
    collectNamedImports(root, filePath, resolver, reads, used),
    collectNamespaceImports(root, filePath, resolver),
  ]);
  const targets = new Map<number, string | null>();
  const isReference = (call: TreeNode) => call.type === "identifier" && references.has(call.id);
  // Only a passed name this file declares needs its scope: an import is bound, any other name links nowhere.
  const referenceNames = new Set(calls.filter(call => isReference(call) && declared.has(call.text)).map(call => call.text));
  const chain = parse && chained.length > 0
    ? returnedChain(root, filePath, { resolver, reads, parse, declarations }, { namespaces, imports: (name) => (used.has(name) ? imports.get(name) : undefined) }, () => shadows)
    : undefined;
  if (imports.size === 0 && namespaces.size === 0 && referenceNames.size === 0 && !chain && !calls.some(call => call.type === "string_fragment")) return targets;
  // A chain's head may be any declaration of this file: its scope tells a top-level one from a local one.
  const shadows = collectShadows(root, {
    has: (name) => imports.has(name) || namespaces.has(name) || referenceNames.has(name) || (chain !== undefined && declared.has(name)),
  });
  // Calls are independent (own visited set, shared read cache); a file can hold many, so bound the reads in flight.
  const stubs = await mapWithConcurrency(calls, NAMESPACE_CALL_CONCURRENCY, async (call): Promise<string | null | undefined> => {
    if (call.type === "string_fragment") return resolveLazyImport(call, filePath, resolver, reads);
    if (isReference(call) && !imports.has(call.text) && !referenceNames.has(call.text)) return null;
    if (call.type === "identifier" && (imports.has(call.text) || references.has(call.id))) {
      const shadow = findShadow(shadows, call);
      if (shadow) return `${filePath}:${call.text}:${shadow.binding.startPosition.row}`;
      return callStub(imports.get(call.text));
    }
    // null (a namespace member that links nowhere) is kept: only an undefined result is no namespace call.
    const namespaced = await resolveNamespaceCall(call, namespaces, shadows, resolver, reads);
    if (namespaced !== undefined) return namespaced;
    return classMethodStub(call, receiverTypes.get(call.id), imports, shadows)
      ?? (chain && returnedReceiverStub(call, members.get(call.id), chain.context, chain.memo));
  });
  calls.forEach((call, index) => {
    if (stubs[index] !== undefined) targets.set(call.id, stubs[index]);
  });
  return targets;
}
