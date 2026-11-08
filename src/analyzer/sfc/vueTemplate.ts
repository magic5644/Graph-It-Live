import type { Node as BabelNode } from "@babel/types";
import type { DirectiveNode, ElementNode, ExpressionNode, RootNode, SimpleExpressionNode, TemplateChildNode } from "@vue/compiler-dom";
import { loadCompilerDom, parseSfc, type SfcDescriptor } from "./sfcBlocks";

/** `component`: a tag naming a component; `call`: `save()`; `reference`: any other use (`save`, `{{ total }}`). */
export type TemplateUsageKind = "component" | "reference" | "call";

/** A position in the `.vue` file: 1-based line, 0-based column. */
export interface TemplatePosition {
  line: number;
  column: number;
}

export interface TemplateUsage extends TemplatePosition {
  kind: TemplateUsageKind;
  /** The script binding used: an import, a top-level declaration or an Options API `components` entry's value. */
  name: string;
}

export interface VueTemplateAnalysis {
  /** The `<template>` element, absent for an SFC without one or with an external `src` template. */
  template?: TemplatePosition & { endLine: number };
  usages: TemplateUsage[];
  /**
   * Components no script binding proves (global, auto-imported or plugin registration) and `:is` values that are
   * not a literal or a binding: never linked, so the analysis of this template is partial for them.
   */
  unresolved: Array<TemplatePosition & { name: string }>;
  /**
   * False when some uses may be missing: an external `src` or non-HTML (`pug`) template, a template or expression
   * the compiler could not read, or a dynamic `:is`. A usage verdict must then count every script binding as used.
   */
  complete: boolean;
}

/** A template use before resolution: `names` are the binding names it may use, the first bound one wins. */
interface RawUsage extends TemplatePosition {
  kind: TemplateUsageKind;
  names: string[];
  /** Shown when nothing binds it; absent for an expression identifier (an unbound one is a global or a typo). */
  unresolvedAs?: string;
}

interface RawTemplate {
  complete: boolean;
  /** An expression Babel could not parse: its uses are unknown. */
  malformed?: boolean;
  template?: VueTemplateAnalysis["template"];
  usages: RawUsage[];
  dynamic: Array<TemplatePosition & { name: string }>;
  aliases: Map<string, string>;
}

const NODE_ELEMENT = 1;
const NODE_SIMPLE_EXPRESSION = 4;
const NODE_INTERPOLATION = 5;
const NODE_ATTRIBUTE = 6;
const NODE_DIRECTIVE = 7;
const TAG_COMPONENT = 1;

/** Built-in components win over any binding of the same name in Vue's resolution: never a workspace target. */
const BUILT_IN_COMPONENTS = new Set(["Transition", "TransitionGroup", "KeepAlive", "Teleport", "Suspense", "Component", "BaseTransition"]);
/** Directives of Vue itself; any other `v-name` is a custom directive bound as `vName` in `<script setup>`. */
const BUILT_IN_DIRECTIVES = new Set(["bind", "on", "if", "else-if", "else", "for", "show", "model", "slot", "html", "text", "once", "memo", "cloak", "pre", "is"]);

const camelize = (name: string) => name.replaceAll(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
const capitalize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The component name Vue infers from an SFC file name: `my-button.vue` -> `MyButton`. */
export function sfcComponentName(filePath: string): string {
  // Both separators: a Windows path reaches here from any platform (a review or MCP payload).
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  return capitalize(camelize(base.replace(/\.[^.]*$/, "")));
}

/** Binding names a tag may name, in Vue's resolution order: as written, camelCase, PascalCase. */
function tagNames(tag: string): string[] {
  const camel = camelize(tag);
  return [...new Set([tag, camel, capitalize(camel)])];
}

/**
 * Options API `components: { MyCard: Card, 'x-row': Row }`: registered name -> local binding.
 * shortcut: one regex over a flat object literal; a computed or spread entry is skipped (stays unresolved).
 */
function componentAliases(scriptView: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const body = /\bcomponents\s*:\s*\{([^{}]*)\}/.exec(scriptView)?.[1];
  for (const entry of body?.split(",") ?? []) {
    const [key, value = key] = entry.split(":").map((part) => part.trim().replaceAll(/["'`]/g, ""));
    if (key && /^[\w$-]+$/.test(key) && /^[\w$]+$/.test(value)) aliases.set(key, value);
  }
  return aliases;
}

const cache = new WeakMap<SfcDescriptor, RawTemplate>();

/**
 * Component, binding, handler and slot uses of a Vue SFC template, at their `.vue` positions, linked to the
 * script bindings that `scriptBindings` lists (imports and top-level declarations). A name no binding proves
 * (built-in, native element, global component, template-local `v-for`/`v-slot` variable) links nowhere. Never
 * throws: a malformed template gives the uses read before the error.
 */
export function analyzeVueTemplate(filePath: string, content: string, scriptBindings: ReadonlySet<string>): VueTemplateAnalysis {
  const descriptor = parseSfc(filePath, content);
  let raw = cache.get(descriptor);
  if (!raw) {
    raw = readTemplate(content, descriptor);
    cache.set(descriptor, raw);
  }
  const { aliases } = raw;
  const bound = (name: string) => (scriptBindings.has(name) ? name : undefined);
  const usages: TemplateUsage[] = [];
  const unresolved = [...raw.dynamic];
  for (const { kind, names, unresolvedAs, line, column } of raw.usages) {
    const name = names.map((candidate) => bound(candidate) ?? (kind === "component" ? bound(aliases.get(candidate) ?? "") : undefined)).find(Boolean);
    if (name) usages.push({ kind, name, line, column });
    else if (unresolvedAs) unresolved.push({ name: unresolvedAs, line, column });
  }
  return { ...(raw.template ? { template: raw.template } : {}), usages, unresolved, complete: raw.complete };
}

function readTemplate(content: string, descriptor: SfcDescriptor): RawTemplate {
  const raw: RawTemplate = { complete: true, usages: [], dynamic: [], aliases: new Map() };
  const block = descriptor.template;
  if (!block) return raw;
  raw.complete = false;
  if (block.src !== undefined) return raw;
  const lineStarts = [0];
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const at = (offset: number): TemplatePosition => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] };
  };
  raw.template = { ...at(block.element.start), endLine: at(Math.max(block.element.start, block.element.end - 1)).line };
  raw.aliases = componentAliases(descriptor.scriptView);
  let root: RootNode;
  try {
    // The first parse (blocks) skips expressions; this one has Babel parse each non-static expression.
    root = loadCompilerDom().parse(content, { parseMode: "sfc", prefixIdentifiers: true, onError: () => undefined });
  } catch {
    return raw;
  }
  const element = root.children.find((node): node is ElementNode => node.type === NODE_ELEMENT && node.tag === "template");
  const lang = element?.props.find((prop) => prop.type === NODE_ATTRIBUTE && prop.name === "lang");
  // A `pug` (or other) template is raw text to compiler-dom: nothing to read.
  if (!element || (lang?.type === NODE_ATTRIBUTE && lang.value && lang.value.content !== "html")) return raw;
  const reader = new TemplateReader(raw, at);
  for (const child of element.children) reader.visit(child, new Set());
  raw.complete = raw.dynamic.length === 0 && !raw.malformed;
  return raw;
}

class TemplateReader {
  constructor(
    private readonly raw: RawTemplate,
    private readonly at: (offset: number) => TemplatePosition,
  ) {}

  visit(node: TemplateChildNode, locals: ReadonlySet<string>): void {
    if (node.type === NODE_INTERPOLATION) this.expression(node.content, locals);
    if (node.type !== NODE_ELEMENT) return;
    const scope = this.forScope(node, locals);
    let childScope = scope;
    for (const prop of node.props) {
      if (prop.type !== NODE_DIRECTIVE || prop.name === "for") continue;
      if (prop.arg) this.expression(prop.arg, scope);
      // `v-slot` props are local to the element's children; any other expression reads the element's scope.
      if (prop.name === "slot") childScope = new Set([...childScope, ...this.paramNames(prop.exp, scope)]);
      else this.directive(node, prop, scope);
    }
    if (node.tagType === TAG_COMPONENT) this.component(node, scope);
    for (const child of node.children) this.visit(child, childScope);
  }

  /** `v-for` aliases are local to the element itself (its other directives) and its children. */
  private forScope(node: ElementNode, locals: ReadonlySet<string>): ReadonlySet<string> {
    const loop = node.props.find((prop): prop is DirectiveNode => prop.type === NODE_DIRECTIVE && prop.name === "for");
    const parsed = loop?.forParseResult;
    if (!parsed) return locals;
    this.expression(parsed.source, locals);
    return new Set([...locals, ...[parsed.value, parsed.key, parsed.index].flatMap((alias) => this.paramNames(alias, locals))]);
  }

  private directive(node: ElementNode, prop: DirectiveNode, scope: ReadonlySet<string>): void {
    if (prop.name === "bind" && node.tag === "component" && prop.arg?.type === NODE_SIMPLE_EXPRESSION && prop.arg.content === "is") {
      this.dynamicComponent(prop.exp, scope);
      return;
    }
    if (prop.exp) this.expression(prop.exp, scope);
    if (!BUILT_IN_DIRECTIVES.has(prop.name)) {
      this.raw.usages.push({ kind: "reference", names: [`v${capitalize(camelize(prop.name))}`], ...this.at(prop.loc.start.offset) });
    }
  }

  private component(node: ElementNode, scope: ReadonlySet<string>): void {
    if (node.tag === "component") {
      const is = node.props.find((prop) => prop.type === NODE_ATTRIBUTE && prop.name === "is");
      if (is?.type === NODE_ATTRIBUTE && is.value) this.tag(is.value.content.replace(/^vue:/, ""), is.value.loc.start.offset + 1);
      return;
    }
    // A template variable named like a component (`<Row v-for="Row in rows">`) is no binding of the script.
    if (scope.has(node.tag)) return;
    this.tag(node.tag, node.loc.start.offset + 1);
  }

  private tag(tag: string, offset: number): void {
    const names = tagNames(tag);
    if (names.some((name) => BUILT_IN_COMPONENTS.has(name))) return;
    this.raw.usages.push({ kind: "component", names, unresolvedAs: tag, ...this.at(offset) });
  }

  /** `:is="Card"` or `:is="'card'"` names one component; any other expression selects it at runtime. */
  private dynamicComponent(exp: ExpressionNode | undefined, scope: ReadonlySet<string>): void {
    if (exp?.type !== NODE_SIMPLE_EXPRESSION) return;
    const ast = astOf(exp);
    const offset = exp.loc.start.offset + leadingSpace(exp.content);
    const name = exp.content.trim();
    if (ast === null && !scope.has(name)) {
      this.raw.usages.push({ kind: "component", names: [name], unresolvedAs: `:is="${name}"`, ...this.at(offset) });
      return;
    }
    if (ast?.type === "StringLiteral") {
      this.tag(ast.value, offset + 1);
      return;
    }
    this.expression(exp, scope);
    this.raw.dynamic.push({ name: `:is="${name}"`, ...this.at(offset) });
  }

  /** Free identifiers of a non-static expression; template-local names and malformed expressions give nothing. */
  private expression(exp: ExpressionNode | undefined, locals: ReadonlySet<string>): void {
    if (exp?.type !== NODE_SIMPLE_EXPRESSION || exp.isStatic) return;
    const ast = astOf(exp);
    const start = exp.loc.start.offset;
    if (ast === null) {
      const name = exp.content.trim();
      if (!locals.has(name)) this.raw.usages.push({ kind: "reference", names: [name], ...this.at(start + leadingSpace(exp.content)) });
      return;
    }
    if (!ast) {
      this.raw.malformed = true;
      return;
    }
    loadCompilerDom().walkIdentifiers(ast, (id, parent, _stack, isReference, isLocal) => {
      if (!isReference || isLocal || locals.has(id.name)) return;
      const called = (parent?.type === "CallExpression" || parent?.type === "OptionalCallExpression") && parent.callee === id;
      // Babel reads the expression wrapped in one leading character: its offsets are shifted by one.
      this.raw.usages.push({ kind: called ? "call" : "reference", names: [id.name], ...this.at(start + (id.start ?? 1) - 1) });
    });
  }

  /** Names a `v-for` alias or `v-slot` declares (`item`, `{ id, label }`, `[key, value]`); its defaults read `locals`. */
  private paramNames(exp: ExpressionNode | undefined, locals: ReadonlySet<string>): string[] {
    if (exp?.type !== NODE_SIMPLE_EXPRESSION) return [];
    const ast = astOf(exp);
    if (ast === null) return [exp.content.trim()];
    // compiler-core reads a destructured alias as the parameters of `(alias) => {}`: only bound names, never keys.
    if (ast?.type !== "ArrowFunctionExpression") return [];
    // `{ n = limit }`: the default is read in the enclosing scope; the parameters themselves are local to the walk.
    this.expression(exp, locals);
    const { extractIdentifiers } = loadCompilerDom();
    return ast.params.flatMap((param) => extractIdentifiers(param)).map((id) => id.name);
  }
}

/** Babel AST of a non-static expression: null for a simple identifier, undefined when it does not parse. */
function astOf(exp: SimpleExpressionNode): BabelNode | null | undefined {
  return exp.ast === false ? undefined : (exp.ast as BabelNode | null | undefined);
}

function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}
