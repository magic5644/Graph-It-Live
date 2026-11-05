/**
 * Type of the value a call returns (#623), read from the return annotation of the function or method it calls,
 * so a method called on that value (`make().m()`, `b.setX(1).build().m()`, `identity(c).m()`) reaches the method
 * of the proven class. No inference: a named type, `this`/`Self` and an identity generic only, link by link.
 *
 * NO vscode imports — this module is VS Code-agnostic.
 */

import { DEFAULT_ONLY, findDeclaration, resolveOnce, type DeclarationReads } from "@/analyzer/utils/declarations";
import { isInIgnoredDirectory } from "@/analyzer/utils/PathPredicates";
import type { PathResolver } from "@/analyzer/utils/PathResolver";
import { normalizePath } from "@/shared/path";
import type { Node as TreeNode } from "web-tree-sitter";
import { enclosingType, objectType, type ScopeTypes } from "./receiverTypes";

/** Links of a chain typed at most (`a().b().c()...`): deeper chains stop, as an unknown link does. */
export const MAX_CHAIN = 8;

/** A top-level declaration: the file declaring it and its name there. */
export interface DeclarationRef { filePath: string; name: string }

/** What a call returns: a type named in the callee's file, the receiver's type (`this`, `Self`), or the type of an argument (`<T>(x: T): T`). */
export type Returned = { type: string } | { self: true } | { argument: number };

/**
 * One file's annotations, as strings: its top-level classes and declared names, the return of each function
 * (`name`) and method (`Class.name`) whose annotation types a value (none when its declarations disagree), and its imports by local name.
 */
export interface FileReturns {
  classes: Set<string>;
  declared: Set<string>;
  returns: Map<string, Returned>;
  imports: Map<string, [specifier: string, imported: string]>;
}

export type ReturnsLanguage = "typescript" | "python";

/** Grammar of the call and member nodes of a chain. */
const CHAIN_NODES: Record<ReturnsLanguage, { call: string; member: string; property: string }> = {
  typescript: { call: "call_expression", member: "member_expression", property: "property" },
  python: { call: "call", member: "attribute", property: "attribute" },
};

// ---------------------------------------------------------------------------
// Reading one file's annotations
// ---------------------------------------------------------------------------

/** A copy of a node's text: V8 keeps a substring as a slice of the whole source, which the pass cache would retain. */
function own(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

function sameReturned(a: Returned | null, b: Returned | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Annotations collected from one file; overload signatures win over the implementation, which callers do not see. */
class ReturnsCollector {
  readonly file: FileReturns = { classes: new Set(), declared: new Set(), returns: new Map(), imports: new Map() };
  private readonly signatures = new Map<string, Returned | null>();
  private readonly bodies = new Map<string, Returned | null>();

  add(key: string, returned: Returned | null, signature: boolean): void {
    const found = signature ? this.signatures : this.bodies;
    const owned = returned && "type" in returned ? { type: own(returned.type) } : returned;
    found.set(own(key), found.has(key) && !sameReturned(found.get(key) ?? null, owned) ? null : owned);
  }

  declare(name: string, isClass = false): void {
    const owned = own(name);
    this.file.declared.add(owned);
    if (isClass) this.file.classes.add(owned);
  }

  import(local: string, specifier: string, imported: string): void {
    this.file.imports.set(own(local), [own(specifier), own(imported)]);
  }

  /** The file's annotations; an unproven return is left out, as absent: the pass cache keeps only what types a value. */
  done(): FileReturns {
    for (const [key, returned] of this.bodies) if (returned && !this.signatures.has(key)) this.file.returns.set(key, returned);
    for (const [key, returned] of this.signatures) if (returned) this.file.returns.set(key, returned);
    return this.file;
  }
}

/** Index of the only parameter whose type is the type parameter `name`; null when none or several are. */
function identity(types: Array<TreeNode | null | undefined>, name: string): Returned | null {
  const at = types.flatMap((type, index) => (type?.type === "type_identifier" || type?.type === "identifier") && type.text === name ? [index] : []);
  return at.length === 1 ? { argument: at[0] } : null;
}

/** `: this`, `: C`, `<T>(x: T): T` of a TS/JS function, method or signature; null for any other annotation. */
function typeScriptReturned(fn: TreeNode): Returned | null {
  const type = fn.childForFieldName("return_type")?.firstNamedChild;
  if (type?.type === "this_type") return { self: true };
  if (type?.type !== "type_identifier") return null;
  const generic = fn.childForFieldName("type_parameters")?.namedChildren.some(parameter => parameter?.childForFieldName("name")?.text === type.text);
  if (!generic) return { type: type.text };
  // A `this` parameter types `this`, it is no argument.
  const parameters = (fn.childForFieldName("parameters")?.namedChildren ?? [])
    .filter(parameter => parameter !== null && parameter.childForFieldName("pattern")?.type !== "this");
  return identity(parameters.map(parameter => parameter?.type === "required_parameter" && parameter.childForFieldName("pattern")?.type === "identifier"
    ? parameter.childForFieldName("type")?.firstNamedChild : null), type.text);
}

const TS_FUNCTIONS = new Set(["function_declaration", "function_signature"]);
const TS_CLASSES = new Set(["class_declaration", "abstract_class_declaration"]);
const TS_METHODS = new Set(["method_definition", "method_signature", "abstract_method_signature"]);
const TS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression"]);

/** Local name and imported name of each binding of an import statement: `import Panel, { Card as C } from`. */
export function importedNames(statement: TreeNode): Array<{ local: TreeNode; imported: string; isType: boolean }> {
  const clause = statement.namedChildren.find(node => node.type === "import_clause");
  const defaultBinding = clause?.namedChildren.find(node => node.type === "identifier");
  const names = defaultBinding ? [{ local: defaultBinding, imported: "default", isType: false }] : [];
  for (const specifier of statement.descendantsOfType("import_specifier")) {
    const imported = specifier.childForFieldName("name");
    if (!imported) continue;
    const isType = specifier.children.some(node => node.type === "type");
    names.push({ local: specifier.childForFieldName("alias") ?? imported, imported: imported.text, isType });
  }
  return names;
}

/** Bindings of a TS/JS `import` statement. */
function addTypeScriptImports(statement: TreeNode, collector: ReturnsCollector): void {
  const specifier = statement.childForFieldName("source")?.namedChildren[0]?.text;
  if (!specifier) return;
  for (const { local, imported } of importedNames(statement)) collector.import(local.text, specifier, imported);
}

/** A class's name and the returns of its methods, signatures included (overloads, abstract methods). */
function addTypeScriptClass(node: TreeNode, name: string, collector: ReturnsCollector): void {
  collector.declare(name, true);
  for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
    const method = member?.childForFieldName("name")?.text;
    if (member && method && TS_METHODS.has(member.type)) collector.add(`${name}.${method}`, typeScriptReturned(member), member.type !== "method_definition");
  }
}

/** Names a `const`/`let`/`var` declares, with the return of a function value (`const f = (): C => ...`). */
function addTypeScriptVariables(node: TreeNode, collector: ReturnsCollector): void {
  for (const declarator of node.namedChildren) {
    const variable = declarator?.childForFieldName("name");
    if (variable?.type !== "identifier") continue;
    collector.declare(variable.text);
    const value = declarator?.childForFieldName("value");
    if (value && TS_FUNCTION_VALUES.has(value.type)) collector.add(variable.text, typeScriptReturned(value), false);
  }
}

function collectTypeScript(root: TreeNode, collector: ReturnsCollector): void {
  for (const statement of root.namedChildren) {
    const node = statement.type === "export_statement" ? statement.childForFieldName("declaration") ?? statement.namedChildren[0] : statement;
    const name = node?.childForFieldName("name")?.text;
    if (node?.type === "import_statement") addTypeScriptImports(node, collector);
    else if (node?.type === "lexical_declaration" || node?.type === "variable_declaration") addTypeScriptVariables(node, collector);
    else if (node && name && TS_CLASSES.has(node.type)) addTypeScriptClass(node, name, collector);
    else if (node && name && TS_FUNCTIONS.has(node.type)) {
      collector.declare(name);
      collector.add(name, typeScriptReturned(node), node.type === "function_signature");
    }
  }
}

/** Name a Python annotation spells: `C`, or the forward reference `"C"`; null for any other expression. */
function pythonTypeName(type: TreeNode | null | undefined): string | null {
  if (type?.type === "identifier") return type.text;
  const text = type?.type === "string" ? type.namedChildren.find(child => child?.type === "string_content")?.text : undefined;
  return text && /^[A-Za-z_]\w*$/.test(text) ? text : null;
}

/** `-> Self`, `-> C`, `-> "C"`, `def f(x: T) -> T` with a `TypeVar` or a PEP 695 parameter; null for any other annotation. */
function pythonReturned(fn: TreeNode, typeVars: Set<string>, method: boolean): Returned | null {
  const name = pythonTypeName(fn.childForFieldName("return_type")?.firstNamedChild);
  // `async def f() -> C` returns a coroutine, not a `C`.
  if (!name || fn.firstChild?.type === "async") return null;
  if (name === "Self") return { self: true };
  const ownParameters = fn.childForFieldName("type_parameters")?.namedChildren.map(parameter => parameter?.text);
  if (!typeVars.has(name) && !ownParameters?.includes(name)) return { type: name };
  // A method's first parameter (`self`, `cls`) is its receiver, not an argument.
  const parameters = (fn.childForFieldName("parameters")?.namedChildren ?? []).slice(method ? 1 : 0);
  return identity(parameters.map(parameter => parameter?.type === "typed_parameter" && parameter.firstNamedChild?.type === "identifier"
    ? parameter.childForFieldName("type")?.firstNamedChild : null), name);
}

/** The function a definition is, and whether it is a signature (`@overload`) or a method without receiver (`@staticmethod`). */
function pythonDefinition(node: TreeNode): { fn: TreeNode | null; decorators: string[] } {
  if (node.type !== "decorated_definition") return { fn: node.type === "function_definition" ? node : null, decorators: [] };
  const fn = node.childForFieldName("definition");
  const decorators = node.namedChildren.filter(child => child?.type === "decorator").map(child => child?.text.replace(/^@\s*(?:typing\.)?/, "") ?? "");
  return { fn: fn?.type === "function_definition" ? fn : null, decorators };
}

/** Names bound by a `from m import a as b` statement. */
function addPythonImports(statement: TreeNode, collector: ReturnsCollector): void {
  const specifier = statement.childForFieldName("module_name")?.text;
  if (!specifier) return;
  for (const name of statement.childrenForFieldName("name")) {
    const imported = name.type === "aliased_import" ? name.childForFieldName("name") : name;
    if (imported) collector.import(name.childForFieldName("alias")?.text ?? imported.text, specifier, imported.text);
  }
}

/** `T = TypeVar("T")` at module level. */
function isTypeVar(statement: TreeNode): string | null {
  const assignment = statement.type === "expression_statement" ? statement.firstNamedChild : null;
  const left = assignment?.type === "assignment" ? assignment.childForFieldName("left") : null;
  const callee = assignment?.childForFieldName("right")?.childForFieldName("function")?.text;
  return left?.type === "identifier" && (callee === "TypeVar" || callee?.endsWith(".TypeVar")) ? left.text : null;
}

/** A class's name and the returns of its methods; a `@staticmethod` has no receiver parameter. */
function addPythonClass(definition: TreeNode, name: string, typeVars: Set<string>, collector: ReturnsCollector): void {
  collector.declare(name, true);
  for (const member of definition.childForFieldName("body")?.namedChildren ?? []) {
    const { fn, decorators } = member ? pythonDefinition(member) : { fn: null, decorators: [] };
    const method = fn?.childForFieldName("name")?.text;
    if (fn && method) collector.add(`${name}.${method}`, pythonReturned(fn, typeVars, !decorators.includes("staticmethod")), decorators.includes("overload"));
  }
}

/** Imports of a module statement, those of an `if TYPE_CHECKING:` block included: annotations use them. */
function addPythonStatementImports(statement: TreeNode, collector: ReturnsCollector): void {
  if (statement.type === "import_from_statement") addPythonImports(statement, collector);
  if (statement.type !== "if_statement") return;
  for (const child of statement.childForFieldName("consequence")?.namedChildren ?? []) {
    if (child?.type === "import_from_statement") addPythonImports(child, collector);
  }
}

function collectPython(root: TreeNode, collector: ReturnsCollector): void {
  const statements = root.namedChildren.filter(statement => statement !== null);
  const typeVars = new Set(statements.map(isTypeVar).filter(name => name !== null));
  for (const statement of statements) {
    addPythonStatementImports(statement, collector);
    const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
    const name = definition?.childForFieldName("name")?.text;
    if (definition && name && definition.type === "class_definition") {
      addPythonClass(definition, name, typeVars, collector);
      continue;
    }
    const { fn, decorators } = pythonDefinition(statement);
    if (!fn || !name) continue;
    collector.declare(name);
    collector.add(name, pythonReturned(fn, typeVars, false), decorators.includes("overload"));
  }
}

/** The annotations of a parsed file, as strings: nothing of the tree is kept. */
export function fileReturns(root: TreeNode, lang: ReturnsLanguage): FileReturns {
  const collector = new ReturnsCollector();
  if (lang === "python") collectPython(root, collector);
  else collectTypeScript(root, collector);
  return collector.done();
}

// ---------------------------------------------------------------------------
// Typing a chain
// ---------------------------------------------------------------------------

/** What one file of an indexing pass needs to type the values its calls return. */
export interface ChainContext {
  root: TreeNode;
  filePath: string;
  lang: ReturnsLanguage;
  resolver: PathResolver;
  /** Shared by the files of one indexing pass: the annotations read during it live and die with it. */
  reads: DeclarationReads;
  /** Annotations of another file, parsed once per pass and freed at once; null when it does not parse. */
  parse(filePath: string): Promise<FileReturns | null>;
  /** Declaration a name refers to at `node` in this file (a top-level declaration or an import); null otherwise. */
  bound(name: string, node: TreeNode): Promise<DeclarationRef | null>;
  /** Module a namespace or module qualifier names (`ns.make()`, `m.make()`); null for any other object. */
  module(object: TreeNode): string | null;
  declarations: ScopeTypes;
}

/** Per-pass caches, by the pass's `reads`: annotations by file, declarations by (file, name). */
interface PassCache { files: Map<string, Promise<FileReturns | null>>; names: Map<string, Promise<DeclarationRef | null>> }
const passes = new WeakMap<DeclarationReads, PassCache>();

function passOf(reads: DeclarationReads): PassCache {
  let pass = passes.get(reads);
  if (!pass) {
    pass = { files: new Map(), names: new Map() };
    passes.set(reads, pass);
  }
  return pass;
}

/** Annotations of `filePath`, read once per pass: from this file's own tree, else parsed by `context.parse`. */
function returnsOf(filePath: string, context: ChainContext): Promise<FileReturns | null> {
  const key = normalizePath(filePath);
  const { files } = passOf(context.reads);
  let found = files.get(key);
  if (found === undefined) {
    if (key === context.filePath) found = Promise.resolve(fileReturns(context.root, context.lang));
    else found = isInIgnoredDirectory(key) ? Promise.resolve(null) : context.parse(key).catch(() => null);
    files.set(key, found);
  }
  return found;
}

/** Python module a `from m import` specifier names, seen from `filePath`. */
async function pythonModule(filePath: string, specifier: string, context: ChainContext): Promise<string | null> {
  const resolved = await resolveOnce(filePath, specifier, context.resolver, context.reads);
  return resolved?.endsWith(".py") ? resolved : null;
}

/**
 * Declaration `name` names in `filePath`: its own top-level declaration, else the one its import reaches (TS:
 * through barrels and default exports; Python: through the re-exporting modules). Once per (file, name) and pass.
 * `visited`: the (file, name) pairs of one Python re-export walk, so an import cycle ends instead of awaiting itself.
 */
export function resolveName(filePath: string, text: string, context: ChainContext, visited = new Set<string>()): Promise<DeclarationRef | null> {
  const name = own(text);
  const key = `${normalizePath(filePath)}\0${name}`;
  if (visited.has(key)) return Promise.resolve(null);
  visited.add(key);
  const { names } = passOf(context.reads);
  let found = names.get(key);
  if (found === undefined) {
    found = lookUpName(filePath, name, context, visited);
    names.set(key, found);
  }
  return found;
}

async function lookUpName(filePath: string, name: string, context: ChainContext, visited: Set<string>): Promise<DeclarationRef | null> {
  const file = await returnsOf(filePath, context);
  if (!file) return null;
  if (file.declared.has(name)) return { filePath: normalizePath(filePath), name };
  const imported = file.imports.get(name);
  if (!imported) return null;
  const [specifier, importedName] = imported;
  if (context.lang === "python") {
    const modulePath = await pythonModule(filePath, specifier, context);
    return modulePath ? resolveName(modulePath, importedName, context, visited) : null;
  }
  const modulePath = await resolveOnce(filePath, specifier, context.resolver, context.reads);
  const declared = modulePath ? await findDeclaration(modulePath, importedName, context.resolver, context.reads) : null;
  if (declared === DEFAULT_ONLY || !modulePath) return null;
  return { filePath: declared?.filePath ?? normalizePath(modulePath), name: declared?.name ?? importedName };
}

/** Calls typed so far in one file, by call node id: a chain's links are shared by the member calls along it. */
export type ChainMemo = Map<number, Promise<DeclarationRef | null>>;

/**
 * Names a link of the chains whose last calls are `objects` may type (a chain's head and the arguments of its
 * calls): the only declarations read for them, so a file's other variables are never typed.
 */
export function chainNames(objects: TreeNode[], lang: ReturnsLanguage): Set<string> {
  const { call, member } = CHAIN_NODES[lang];
  const wanted = new Set<string>();
  const visit = (node: TreeNode | null | undefined): void => {
    if (node?.type === "identifier") wanted.add(node.text);
    if (node?.type !== call) return;
    node.childForFieldName("arguments")?.namedChildren.forEach(visit);
    const fn = node.childForFieldName("function");
    visit(fn?.type === member ? fn.childForFieldName("object") : null);
  };
  objects.forEach(visit);
  return wanted;
}

/** Calls along a chain up to `call`, from its head: `a().b().c()` is 3 at `c`, whichever call starts the typing. */
function chainLength(call: TreeNode, lang: ReturnsLanguage): number {
  const { call: callType, member } = CHAIN_NODES[lang];
  let length = 0;
  let node: TreeNode | null | undefined = call;
  while (node?.type === callType) {
    length++;
    const fn = node.childForFieldName("function");
    node = fn?.type === member ? fn.childForFieldName("object") : null;
  }
  return length;
}

/** Class of a receiver: `this`/`self`, a typed variable, a type (`C.m()`), a construction, or a returned value. */
function valueType(node: TreeNode, context: ChainContext, memo: ChainMemo): Promise<DeclarationRef | null> {
  if (node.type === CHAIN_NODES[context.lang].call) return returnedType(node, context, memo);
  const self = node.type === "this" || (context.lang === "python" && node.type === "identifier" && (node.text === "self" || node.text === "cls"));
  const name = self ? enclosingType(node) : objectType(node, context.declarations);
  return name ? context.bound(name, node) : Promise.resolve(null);
}

/** Class of the value `call` returns; null when any link of its chain is unproven or the chain is longer than `MAX_CHAIN`. */
export function returnedType(call: TreeNode, context: ChainContext, memo: ChainMemo): Promise<DeclarationRef | null> {
  let found = memo.get(call.id);
  if (found === undefined) {
    found = chainLength(call, context.lang) > MAX_CHAIN ? Promise.resolve(null) : typeReturned(call, context, memo);
    memo.set(call.id, found);
  }
  return found;
}

async function typeReturned(call: TreeNode, context: ChainContext, memo: ChainMemo): Promise<DeclarationRef | null> {
  const { callee, receiver } = await calleeOf(call.childForFieldName("function"), context, memo);
  const file = callee && await returnsOf(callee.filePath, context);
  if (!callee || !file) return null;
  // Python constructs a class by calling it: `C()` is a `C`.
  if (context.lang === "python" && file.classes.has(callee.name)) return callee;
  const returned = file.returns.get(callee.name);
  if (!returned) return null;
  if ("self" in returned) return receiver;
  // The type is named in the callee's file: its own imports bind it.
  if ("type" in returned) return resolveName(callee.filePath, returned.type, context);
  const argument = call.childForFieldName("arguments")?.namedChildren[returned.argument];
  return argument ? valueType(argument, context, memo) : null;
}

/** Function or method a call calls, with the class of its receiver for a method (`Class.method` in that class's file). */
async function calleeOf(fn: TreeNode | null, context: ChainContext, memo: ChainMemo): Promise<{ callee: DeclarationRef | null; receiver: DeclarationRef | null }> {
  if (fn?.type === "identifier") return { callee: await context.bound(fn.text, fn), receiver: null };
  const object = fn?.type === CHAIN_NODES[context.lang].member ? fn.childForFieldName("object") : null;
  const method = fn?.childForFieldName(CHAIN_NODES[context.lang].property)?.text;
  if (!object || !method) return { callee: null, receiver: null };
  const modulePath = context.module(object);
  if (modulePath) return { callee: await resolveName(modulePath, method, context), receiver: null };
  const receiver = await valueType(object, context, memo);
  return { callee: receiver && { filePath: receiver.filePath, name: `${receiver.name}.${method}` }, receiver };
}

/**
 * `@@import:` stub of a method called on a returned value (`make().m()`): the method `call` names in the class the
 * call returns; undefined when the object is no call or its type is unproven, so the extractor's rules apply.
 */
export async function returnedReceiverStub(call: TreeNode, object: TreeNode | null | undefined, context: ChainContext, memo: ChainMemo): Promise<string | undefined> {
  if (object?.type !== CHAIN_NODES[context.lang].call) return undefined;
  const type = await returnedType(object, context, memo);
  return type ? `@@import:${JSON.stringify([type.filePath, call.text, type.name])}` : undefined;
}
