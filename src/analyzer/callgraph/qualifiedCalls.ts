import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import type { Node as TreeNode } from "web-tree-sitter";

/**
 * Call target for a qualified call (`pkg.F()`, `Type::f()`, `Util.f()`) whose qualifier is a
 * static package, module or type: the stub names the container so the index never matches a
 * same-named declaration of another container (#507).
 */
export const QUALIFIED_PREFIX = "@@qualified:";

/** `folder`: Go package directory; `type`: enclosing class (Java, C#); `module`: Rust module file or impl type. */
type Mode = "folder" | "type" | "module";

function stub(mode: Mode, key: string, name: string): string {
  return `${QUALIFIED_PREFIX}${JSON.stringify([mode, key, name])}`;
}

/** Name of the `call` node when it is the `field` of a member node and the member's receiver node. */
function receiverOf(call: TreeNode, memberType: string, nameField: string, receiverField: string): TreeNode | null {
  const member = call.parent;
  if (member?.type !== memberType || member.childForFieldName(nameField)?.id !== call.id) return null;
  return member.childForFieldName(receiverField);
}

/** `a.B` -> `B`, `B` -> `B`: the type segment a qualified receiver ends with. */
function lastSegment(node: TreeNode | null, qualifiedType: string, nameField: string): TreeNode | null {
  if (node?.type === "identifier") return node;
  return node?.type === qualifiedType ? node.childForFieldName(nameField) : null;
}

/** Identifiers a declaration field holds: Go `a, b := ...` and `for k, v := range` use an expression_list. */
function namesOf(child: TreeNode): TreeNode[] {
  return (child.type === "expression_list" ? child.namedChildren : [child]).filter(name => name.type === "identifier");
}

/** Names that a file declares as variables, parameters or properties, whatever their scope. */
function declaredNames(root: TreeNode, types: string[], fields: string[]): Set<string> {
  const names = new Set<string>();
  for (const node of root.descendantsOfType(types)) {
    // C# `variable_declarator` has no `name` field: its first child is the identifier.
    const declared = node.type === "variable_declarator" && node.namedChildren[0] ? [node.namedChildren[0]] : [];
    for (const child of [...declared, ...fields.flatMap(field => node.childrenForFieldName(field))]) {
      for (const name of namesOf(child)) names.add(name.text);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Java and C#: Util.f() where Util is a class
// ---------------------------------------------------------------------------

const TYPE_NAME = /^[A-Z]/;

/** `using C = N.Calc;` -> `C` = `Calc`. */
function csharpUsingAliases(root: TreeNode): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const using of root.descendantsOfType("using_directive")) {
    const [equals, type] = using.namedChildren;
    const original = lastSegment(type ?? null, "qualified_name", "name");
    const alias = equals?.type === "name_equals" ? equals.namedChildren[0] : null;
    if (alias && original) aliases.set(alias.text, original.text);
  }
  return aliases;
}

/**
 * Qualifier of a Java/C# call when it names a static type: capitalised and not declared as a
 * variable of the file. A lowercase or declared qualifier is a receiver, which needs its type (#499).
 * shortcut: scope-insensitive (a variable named like a type anywhere in the file blocks the
 * call), the namespace/import of the type is not checked; upgrade with a real symbol table.
 */
function typeTargets(root: TreeNode, calls: TreeNode[], lang: "java" | "csharp"): Map<number, string | null> {
  const java = lang === "java";
  const declared = declaredNames(
    root,
    java
      ? ["variable_declarator", "formal_parameter", "spread_parameter", "catch_formal_parameter", "enhanced_for_statement"]
      : ["variable_declarator", "parameter", "property_declaration", "foreach_statement"],
    ["name", "left"],
  );
  const aliases = java ? new Map<string, string>() : csharpUsingAliases(root);
  const targets = new Map<number, string | null>();
  for (const call of calls) {
    const receiver = java
      ? receiverOf(call, "method_invocation", "name", "object")
      : receiverOf(call, "member_access_expression", "name", "expression");
    const qualifier = java
      ? lastSegment(receiver, "field_access", "field")
      : lastSegment(receiver, "member_access_expression", "name");
    if (!qualifier || !TYPE_NAME.test(qualifier.text)) continue;
    targets.set(call.id, declared.has(qualifier.text) ? null : stub("type", aliases.get(qualifier.text) ?? qualifier.text, call.text));
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Rust: module::f() and Type::f()
// ---------------------------------------------------------------------------

const RUST_SELF_PATHS = new Set(["Self", "self", "super", "crate"]);

/** `Foo`, `&mut Foo`, `a::Foo`, `Foo<T>` -> `Foo`; anything else (`Vec<Foo>` is `Vec`, tuples, `dyn`) is not a plain type. */
function rustTypeName(node: TreeNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "type_identifier": return node.text;
    case "scoped_type_identifier": return node.childForFieldName("name")?.text ?? null;
    case "reference_type":
    case "generic_type": return rustTypeName(node.childForFieldName("type"));
    default: return null;
  }
}

/**
 * Names a method definition (its name node) answers to: the type of its `impl` block and the trait it
 * implements (`impl Tr for Foo` -> `Foo,Tr`, so `Tr::f(&x)` and `Foo::f()` both find it), or the trait declaring it.
 */
export function rustImplOwner(methodName: TreeNode): string | null {
  const container = methodName.parent?.parent?.parent;
  if (container?.type === "trait_item") return container.childForFieldName("name")?.text ?? null;
  if (container?.type !== "impl_item") return null;
  return [container.childForFieldName("type"), container.childForFieldName("trait")].map(rustTypeName).filter(Boolean).join(",") || null;
}

/** What a `use` clause binds: the original name and the module it is read from (null when `crate`, `self`, `super` or bare). */
interface UseAlias { name: string; module: string | null }

/** `use a::b::f as g;` and `use a::b::{f as g};` -> `g` = { f, module b }. */
function rustUseAliases(root: TreeNode): Map<string, UseAlias> {
  const aliases = new Map<string, UseAlias>();
  for (const clause of root.descendantsOfType("use_as_clause")) {
    const path = clause.childForFieldName("path");
    const original = lastSegment(path, "scoped_identifier", "name");
    const alias = clause.childForFieldName("alias");
    if (!original || !alias) continue;
    let scope = path?.type === "scoped_identifier" ? path.childForFieldName("path") : null;
    for (let up = clause.parent; !scope && up; up = up.parent) {
      if (up.type === "scoped_use_list") scope = up.childForFieldName("path");
    }
    aliases.set(alias.text, { name: original.text, module: lastSegment(scope, "scoped_identifier", "name")?.text ?? null });
  }
  return aliases;
}

/**
 * Type of the receiver of `recv.f()`: the type the enclosing function declares for it (parameter or
 * annotated `let`), or the receiver itself when it is a capitalised name nothing declares (unit struct).
 * shortcut: no inference (`let c = Calc::new()`, closures, fields, `self`) and a name declared with
 * two types in one function is skipped; upgrade with receiver types (#499).
 */
function rustReceiverType(receiver: TreeNode | null, call: TreeNode): string | null {
  if (receiver?.type !== "identifier") return null;
  let fn: TreeNode | null = call;
  while (fn && fn.type !== "function_item") fn = fn.parent;
  const types = new Set<string | null>();
  for (const decl of fn?.descendantsOfType(["parameter", "let_declaration"]) ?? []) {
    if (decl.childForFieldName("pattern")?.text.replace(/^mut\s+/, "") === receiver.text) types.add(rustTypeName(decl.childForFieldName("type")));
  }
  if (types.size === 0) return TYPE_NAME.test(receiver.text) ? receiver.text : null;
  return types.size === 1 ? [...types][0] : null;
}

/**
 * `Self::`, `self::`, `super::` and `crate::` paths and modules declared inline in this file keep
 * the in-file name match (the `RUST_SELF_PATHS` and `inline` skips below).
 * shortcut: a module declared inline in another file (`mod b { pub fn f() {} }` in `a.rs`) has no
 * node, so `b::f()` links nowhere; `super::f()` / `crate::f()` still match by name, and so does a
 * function aliased from them (`use crate::f as g` links nowhere). Upgrade: index `mod` as nodes.
 */
function rustTargets(root: TreeNode, calls: TreeNode[]): Map<number, string | null> {
  const aliases = rustUseAliases(root);
  // shortcut: file-wide, a parameter or `let` named like an alias in one function blocks the alias in every function.
  const declared = declaredNames(root, ["parameter", "let_declaration"], ["pattern"]);
  // A module declared in this very file keeps the in-file name match.
  const inline = new Set(root.descendantsOfType("mod_item").filter(mod => mod.childForFieldName("body")).map(mod => mod.childForFieldName("name")?.text ?? ""));
  const targets = new Map<number, string | null>();
  for (const call of calls) {
    const alias = call.type === "identifier" && call.parent?.type === "call_expression" && !declared.has(call.text) ? aliases.get(call.text) : undefined;
    if (alias) {
      targets.set(call.id, alias.module ? stub("module", alias.module, alias.name) : null);
      continue;
    }
    const scoped = lastSegment(receiverOf(call, "scoped_identifier", "name", "path"), "scoped_identifier", "name")?.text;
    const key = scoped ?? rustReceiverType(receiverOf(call, "field_expression", "field", "value"), call);
    if (!key || RUST_SELF_PATHS.has(key) || (scoped && inline.has(key))) continue;
    targets.set(call.id, stub("module", aliases.get(key)?.name ?? key, call.text));
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Go: pkg.F() where pkg is an imported package
// ---------------------------------------------------------------------------

/** Name an import binds: its alias, else the last path segment without a `/vN` major-version suffix. */
function goImports(root: TreeNode): Map<string, string> {
  const imports = new Map<string, string>();
  for (const spec of root.descendantsOfType("import_spec")) {
    const importPath = spec.childForFieldName("path")?.text.slice(1, -1);
    if (!importPath) continue;
    const alias = spec.childForFieldName("name");
    if (alias && alias.type !== "package_identifier") continue; // `.` and `_` bind no qualifier
    const segments = importPath.split("/");
    if (segments.length > 1 && /^v\d+$/.test(segments.at(-1) ?? "")) segments.pop();
    imports.set(alias?.text ?? segments.at(-1) ?? "", importPath);
  }
  return imports;
}

/** Nearest `go.mod` at or above `dir` inside the workspace: its directory and module path. */
async function findGoModule(dir: string, root: string): Promise<{ dir: string; module: string } | null> {
  if (dir !== root && !dir.startsWith(`${root.replace(/\/$/, "")}/`)) return null;
  const module = (await fs.readFile(path.join(dir, "go.mod"), "utf8").catch(() => null))?.match(/^module\s+(\S+)/m)?.[1];
  if (module) return { dir, module };
  const parent = path.posix.dirname(dir);
  return parent === dir ? null : findGoModule(parent, root);
}

/** Workspace-relative directory of a package of the workspace's Go module; null for stdlib and third-party packages. */
async function goPackageFolder(importPath: string, filePath: string, workspaceRoot: string): Promise<string | null> {
  const root = normalizePath(workspaceRoot);
  const found = await findGoModule(path.posix.dirname(filePath), root);
  if (!found) return null;
  const { dir, module } = found;
  let sub: string | null = null;
  if (importPath === module) sub = "";
  else if (importPath.startsWith(`${module}/`)) sub = importPath.slice(module.length + 1);
  if (sub === null || sub.split("/").includes("..")) return null;
  return normalizePath(path.join(dir, sub)).slice(root.length).replace(/^\//, "");
}

/**
 * shortcut: the package name is taken from the import path (alias or last segment), not from the
 * package clause of the imported files, and `replace`/`go.work` redirects are not followed.
 */
async function goTargets(root: TreeNode, calls: TreeNode[], filePath: string, workspaceRoot: string): Promise<Map<number, string | null>> {
  const targets = new Map<number, string | null>();
  const imports = goImports(root);
  if (imports.size === 0) return targets;
  // shortcut: file-wide, a local `pkg := ...` in one function blocks the package in every function.
  const declared = declaredNames(root, ["var_spec", "const_spec", "parameter_declaration", "short_var_declaration", "range_clause"], ["name", "left"]);
  const used = calls.flatMap((call) => {
    const operand = receiverOf(call, "selector_expression", "field", "operand");
    const importPath = operand?.type === "identifier" ? imports.get(operand.text) : undefined;
    return operand && importPath !== undefined ? [{ call, operand, importPath }] : [];
  });
  const folders = new Map(await Promise.all([...new Set(used.map(({ importPath }) => importPath))]
    .map(async (importPath) => [importPath, await goPackageFolder(importPath, filePath, workspaceRoot)] as const)));
  for (const { call, operand, importPath } of used) {
    const folder = folders.get(importPath) ?? null;
    targets.set(call.id, declared.has(operand.text) || folder === null ? null : stub("folder", folder, call.text));
  }
  return targets;
}

/**
 * Resolve qualified calls of Go, Rust, Java and C# before the AST is freed. A qualifier proven
 * static but unresolvable yields null (no edge); other calls get no entry and keep the extractor's rules.
 */
export async function resolveQualifiedCalls(
  root: TreeNode,
  calls: TreeNode[],
  lang: string,
  filePath: string,
  workspaceRoot: string,
): Promise<Map<number, string | null>> {
  if (calls.length === 0) return new Map();
  switch (lang) {
    case "go": return goTargets(root, calls, filePath, workspaceRoot);
    case "rust": return rustTargets(root, calls);
    case "java":
    case "csharp": return typeTargets(root, calls, lang);
    default: return new Map();
  }
}

// ---------------------------------------------------------------------------
// Index side
// ---------------------------------------------------------------------------

export interface QualifiedMember { id: string; path: string; folder: string; startLine: number; endLine: number; isExported: number; owner: string }
export interface QualifiedType { path: string; startLine: number; endLine: number }

/** File stem a Rust module is declared in: `a.rs` and `a/mod.rs` both declare module `a`. */
function rustModuleName(filePath: string): string {
  const stem = path.posix.basename(filePath).replace(/\.[^.]+$/, "");
  return stem === "mod" ? path.posix.basename(path.posix.dirname(filePath)) : stem;
}

/** Members a `@@qualified:` stub can reach: those declared by its container; empty when none does. */
export function qualifiedCandidates(
  target: string,
  members: (name: string) => QualifiedMember[],
  types: (name: string) => QualifiedType[],
): QualifiedMember[] {
  const [mode, key, name] = JSON.parse(target.slice(QUALIFIED_PREFIX.length)) as [Mode, string, string];
  const candidates = members(name);
  if (mode === "folder") return candidates.filter(member => member.folder === key);
  // A Rust method belongs to the type of its `impl` block, wherever that block is; a function, to its file's module.
  if (mode === "module") return candidates.filter(member => member.owner ? member.owner.split(",").includes(key) : rustModuleName(member.path) === key);
  const declaring = types(key);
  return candidates.filter(member => declaring.some(type => type.path === member.path &&
    type.startLine <= member.startLine && member.endLine <= type.endLine));
}
