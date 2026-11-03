/**
 * Same-file type of a call receiver and type owning a method, read from the tree-sitter AST of every
 * call graph grammar, so a call reaches the method of its receiver's type, not the first homonym (#505).
 *
 * NO vscode imports — this module is VS Code-agnostic.
 */

import type { Node as TreeNode } from "web-tree-sitter";

/** Declarations whose name owns the methods they hold and that `this`/`self`/`Self` stand for, per grammar. */
export const TYPE_SCOPES = new Set([
  "class_declaration", "abstract_class_declaration", "class", "class_definition", "interface_declaration",
  "struct_declaration", "record_declaration", "record_struct_declaration", "enum_declaration", "impl_item", "trait_item",
]);

/** Function bodies: a function declared inside one is local to it, owned by no type. */
const FUNCTION_SCOPES = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "function", "arrow_function",
  "method_definition", "function_definition", "lambda", "method_declaration", "constructor_declaration",
  "local_function_statement", "function_item", "closure_expression", "func_literal",
]);

/** Nodes that give a variable or parameter its type, through a type, an initial value or both. */
const VARIABLE_DECLARATIONS = [
  "variable_declarator", "required_parameter", "optional_parameter", // TS/JS (variable_declarator also Java, C#)
  "formal_parameter", "parameter", // Java, C#, Rust
  "assignment", "typed_parameter", "typed_default_parameter", // Python
  "short_var_declaration", "var_spec", "parameter_declaration", // Go
  "let_declaration", // Rust
];

/** Nodes holding a type or a value whose type is the one inside: `: B`, `*B`, `&B`, `B<T>`, `B?`, `(new B())`, `= new B()`. */
const WRAPPERS = new Set([
  "type_annotation", "type", "pointer_type", "reference_type", "generic_type", "generic_name", "nullable_type",
  "parenthesized_expression", "equals_value_clause",
]);

/** Field holding the type name of a constructing expression: `new B()`, `B()` (Python), `B{}` (Go, Rust), `&B{}`. */
const CONSTRUCTED_TYPE_FIELD: Record<string, string> = {
  new_expression: "constructor",
  object_creation_expression: "type",
  call: "function",
  composite_literal: "type",
  struct_expression: "name",
  unary_expression: "operand",
  reference_expression: "value",
};

/**
 * Name of the type a type node or a constructing expression denotes; null for anything else (a call of a
 * function, a member, a qualified `ns.B`), whose type is not read without type inference.
 */
export function typeNameOf(node: TreeNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (WRAPPERS.has(node.type)) {
    return typeNameOf(node.childForFieldName("type") ?? node.childForFieldName("name") ?? node.firstNamedChild);
  }
  const field = CONSTRUCTED_TYPE_FIELD[node.type];
  return field ? typeNameOf(node.childForFieldName(field)) : null;
}

/** Name of a type declaration: `B` of `class B`, of `impl B` and of `impl Tr for B`. */
function scopeName(scope: TreeNode): string | null {
  return scope.type === "impl_item" ? typeNameOf(scope.childForFieldName("type")) : scope.childForFieldName("name")?.text ?? null;
}

/** Type that `this`/`self`/`Self` names at `node`: its nearest enclosing type declaration. */
export function enclosingType(node: TreeNode): string | null {
  for (let up = node.parent; up; up = up.parent) {
    if (TYPE_SCOPES.has(up.type)) return scopeName(up);
  }
  return null;
}

/** Type a definition (its name node) is a method of: its class, impl or Go receiver; null for a function. */
export function methodOwner(name: TreeNode): string | null {
  const declaration = name.parent;
  const receiver = declaration?.childForFieldName("receiver"); // Go: func (b *B) m()
  if (receiver) return typeNameOf(receiver.namedChildren[0]?.childForFieldName("type"));
  for (let up = declaration?.parent; up; up = up.parent) {
    if (TYPE_SCOPES.has(up.type)) return scopeName(up);
    if (FUNCTION_SCOPES.has(up.type)) return null;
  }
  return null;
}

/** Items of a Go `a, b := x, y` list; the node itself elsewhere. */
function itemsOf(node: TreeNode | null | undefined): TreeNode[] {
  if (!node) return [];
  return node.type === "expression_list" ? node.namedChildren.filter(item => item !== null) : [node];
}

/** Types a declaration gives `name`: its declared type, else (`var`, none) the type its value constructs. */
function declaredTypes(declaration: TreeNode, name: string): (string | null)[] {
  const names = ["name", "pattern", "left"].flatMap(field => declaration.childrenForFieldName(field)).flatMap(itemsOf);
  // C# variable_declarator and Python typed_parameter name no field: their first child is the identifier.
  const first = declaration.firstNamedChild;
  if (names.length === 0 && first?.type === "identifier") names.push(first);
  const index = names.findIndex(node => node.text.replace(/^mut\s+/, "") === name);
  if (index < 0) return [];
  // Java and C# declare the type once for every declarator: `B a = x, b = y;`.
  const declared = typeNameOf(declaration.childForFieldName("type") ?? declaration.parent?.childForFieldName("type"));
  if (declared && declared !== "var") return [declared];
  const values = itemsOf(declaration.childForFieldName("value") ?? declaration.childForFieldName("right")
    ?? declaration.namedChildren.find(child => child?.type === "equals_value_clause"));
  return [typeNameOf(values.length === names.length ? values[index] : values[0])];
}

/**
 * Type of the variable `receiver` names, from the declarations of its enclosing functions, innermost
 * first, then of the file; the name itself when nothing declares it (a type: `B.m()`, a Rust unit struct).
 * shortcut: a scope's nested functions count as the scope, so one name declared with two types in them is
 * unresolved; fields (`this.b.m()`) and inferred values (`make().m()`) are not typed; upgrade with #499.
 */
export function variableType(receiver: TreeNode): string | null {
  for (let scope = receiver.parent; scope; scope = scope.parent) {
    if (scope.parent && !FUNCTION_SCOPES.has(scope.type)) continue;
    const types = new Set(scope.descendantsOfType(VARIABLE_DECLARATIONS)
      .flatMap(declaration => (declaration ? declaredTypes(declaration, receiver.text) : [])));
    if (types.size > 0) return types.size === 1 ? [...types][0] : null;
  }
  return receiver.text;
}
