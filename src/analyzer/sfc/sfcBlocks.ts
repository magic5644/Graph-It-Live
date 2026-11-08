import type { ElementNode } from "@vue/compiler-dom";
import { ts } from "ts-morph";
import { normalizePath } from "@/shared/path";

/** Script language of an SFC block, normalized from its `lang` attribute. */
export type ScriptLang = "ts" | "tsx" | "js" | "jsx";

/** Offsets of a block's inner content in the SFC (`end` exclusive). */
export interface SfcRange {
  start: number;
  end: number;
}

export interface SfcScript {
  lang: ScriptLang;
  setup: boolean;
  loc: SfcRange;
  src?: string;
}

export interface SfcTemplate {
  loc: SfcRange;
  /** Offsets of the whole `<template>` element, tags included. */
  element: SfcRange;
  src?: string;
  content: string;
}

/**
 * Vue compiler macros: compiled away, never runtime calls, so they are no call target even when a workspace
 * declares a function of the same name.
 */
export const VUE_COMPILER_MACROS: ReadonlySet<string> = new Set([
  "defineProps", "defineEmits", "defineExpose", "defineModel", "defineSlots", "defineOptions", "withDefaults",
]);

export interface SfcDescriptor {
  /**
   * The SFC with every character outside `<script>` blocks turned into a space (line breaks kept): same length,
   * so offsets, lines and columns read in it are those of the `.vue`/`.svelte` file.
   */
  scriptView: string;
  scripts: SfcScript[];
  template?: SfcTemplate;
  errors: string[];
}

type CompilerDom = typeof import("@vue/compiler-dom");

let compilerDom: CompilerDom | undefined;

/**
 * Loaded on the first `.vue` only, so a workspace without Vue never pays its startup time or memory. A synchronous
 * `require` keeps every caller synchronous; esbuild bundles the module and defers its initialization to this call.
 */
export function loadCompilerDom(): CompilerDom {
  compilerDom ??= require("@vue/compiler-dom") as CompilerDom; // eslint-disable-line @typescript-eslint/no-require-imports
  return compilerDom;
}

/** True once a `.vue` file has loaded the Vue compiler in this thread. */
export function isVueCompilerLoaded(): boolean {
  return compilerDom !== undefined;
}

const SFC_FILE = /\.(?:vue|svelte)$/i;

/** True for the single-file component extensions routed through `parseSfc`. */
export function isSfcFile(filePath: string): boolean {
  return SFC_FILE.test(filePath);
}

const CACHE_LIMIT = 64;
// Parser, GraphExtractor, SymbolAnalyzer and SignatureAnalyzer of one thread share each parse.
const cache = new Map<string, { content: string; descriptor: SfcDescriptor }>();

/**
 * Splits a Vue or Svelte SFC into its blocks. Never throws: a malformed or incomplete SFC gives the blocks that
 * could be read plus `errors`. A `.svelte` file is split by regex (compiler-dom does not parse Svelte markup); any
 * other path, `.vue` and the `.vue.old`/`.vue.new` names of SignatureAnalyzer included, goes to compiler-dom.
 */
export function parseSfc(filePath: string, content: string): SfcDescriptor {
  const key = normalizePath(filePath);
  const cached = cache.get(key);
  if (cached?.content === content) return cached.descriptor;
  const descriptor = /\.svelte$/i.test(filePath) ? parseSvelte(content) : parseVue(content);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { content, descriptor });
  return descriptor;
}

function normalizeLang(lang: string | undefined): ScriptLang {
  switch (lang?.toLowerCase()) {
    case "ts":
    case "typescript":
      return "ts";
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    default:
      return "js";
  }
}

function attribute(node: ElementNode, name: string): string | undefined {
  for (const prop of node.props) {
    if (prop.type === 6 /* NodeTypes.ATTRIBUTE */ && prop.name === name) return prop.value?.content ?? "";
  }
  return undefined;
}

/** Adds a root `<script>` or the first root `<template>` to `blocks`; other root nodes are ignored. */
function addVueBlock(node: ElementNode, content: string, blocks: { scripts: SfcScript[]; template?: SfcTemplate }): void {
  if (!node.innerLoc) return;
  // A block missing its end tag has an empty innerLoc, but its text child still runs to the end of the file.
  const end = Math.max(node.innerLoc.end.offset, node.children.at(-1)?.loc.end.offset ?? 0);
  const loc = { start: node.innerLoc.start.offset, end };
  const src = attribute(node, "src");
  const external = src === undefined ? {} : { src };
  if (node.tag === "script") {
    blocks.scripts.push({ lang: normalizeLang(attribute(node, "lang")), setup: attribute(node, "setup") !== undefined, loc, ...external });
  } else if (node.tag === "template" && !blocks.template) {
    const element = { start: node.loc.start.offset, end: Math.max(node.loc.end.offset, end) };
    blocks.template = { loc, element, content: content.slice(loc.start, loc.end), ...external };
  }
}

function parseVue(content: string): SfcDescriptor {
  const errors: string[] = [];
  const blocks: { scripts: SfcScript[]; template?: SfcTemplate } = { scripts: [] };
  try {
    const root = loadCompilerDom().parse(content, { parseMode: "sfc", onError: (error) => errors.push(error.message) });
    for (const node of root.children) {
      if (node.type === 1 /* NodeTypes.ELEMENT */) addVueBlock(node, content, blocks);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const { scripts, template } = blocks;
  return { scriptView: maskOutside(content, scripts), scripts, ...(template ? { template } : {}), errors };
}

// The Svelte block regex the import parser has always used; `d` gives the content offsets.
// NOSONAR: the lazy body stops at the first `</script`, so matching stays linear in the file size.
const SVELTE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*[^>]*>/dgi; //NOSONAR
const LANG_ATTRIBUTE = /\blang\s*=\s*["']?([\w-]+)/i;

function parseSvelte(content: string): SfcDescriptor {
  const scripts: SfcScript[] = [];
  for (const match of content.matchAll(SVELTE_SCRIPT)) {
    const [start, end] = match.indices?.[2] ?? [0, 0];
    scripts.push({ lang: normalizeLang(LANG_ATTRIBUTE.exec(match[1])?.[1]), setup: false, loc: { start, end } });
  }
  return { scriptView: maskOutside(content, scripts), scripts, errors: [] };
}

/** Keeps the script blocks in place and blanks the rest, line breaks kept (blocks are in document order). */
function maskOutside(content: string, scripts: readonly SfcScript[]): string {
  const blank = (text: string) => text.replaceAll(/[^\r\n]/g, " ");
  const parts: string[] = [];
  let copied = 0;
  for (const { loc } of scripts) {
    parts.push(blank(content.slice(copied, loc.start)), content.slice(loc.start, loc.end));
    copied = loc.end;
  }
  parts.push(blank(content.slice(copied)));
  return parts.join("");
}

/** One language for all blocks: TypeScript when any block is TypeScript, JSX when any block allows JSX. */
export function langOf(scripts: readonly SfcScript[]): ScriptLang {
  const typed = scripts.some((script) => script.lang === "ts" || script.lang === "tsx");
  const jsx = scripts.some((script) => script.lang === "tsx" || script.lang === "jsx");
  if (typed) return jsx ? "tsx" : "ts";
  return jsx ? "jsx" : "js";
}

const SCRIPT_KINDS: Record<ScriptLang, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

/** The ts-morph script kind of an SFC's script view. */
export function scriptKindOf(scripts: readonly SfcScript[]): ts.ScriptKind {
  return SCRIPT_KINDS[langOf(scripts)];
}
