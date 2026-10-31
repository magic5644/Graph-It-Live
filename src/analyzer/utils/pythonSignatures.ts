import { pythonCode } from './pyRsImports';

/*
 * Top-level declarations of a Python module, for review_pr signature comparison (#524). A linear scan of the
 * code with strings and comments blanked, like pyRsImports: the review reads both sides of every changed file
 * synchronously, and a WASM parse per side would cost far more.
 * shortcut: only column-0 statements count, so class methods and definitions inside `if`/`try` blocks are not
 * compared; walk indented bodies if method-level review of Python is needed.
 */

/** Same shape as `ParameterInfo` in SignatureAnalyzer.ts (structural, so the two modules do not import each other). */
export interface PythonParameter {
  name: string;
  /** Annotation text, or '' when the parameter is not annotated. */
  type: string;
  isOptional: boolean;
  hasDefault: boolean;
  isRest: boolean;
  position: number;
}

/** Same shape as a function `SignatureInfo` in SignatureAnalyzer.ts. */
export interface PythonFunction {
  name: string;
  kind: 'function';
  isExported: boolean;
  parameters: PythonParameter[];
  /** `-> X` annotation text, or '' when absent. */
  returnType: string;
  isAsync: boolean;
  line: number;
}

export type PythonDeclarationKind = 'function' | 'class' | 'variable';

export interface PythonDeclarations {
  functions: PythonFunction[];
  /** Every top-level name the module binds by `def`, `class` or assignment, with the line it is bound on. */
  names: Map<string, { kind: PythonDeclarationKind; line: number }>;
}

/** `def`/`async def`/`class` at column 0; the name ends the match, so the scan resumes at the parameters. */
const PY_DEF = /^(async[ \t]+def|def|class)[ \t]+([A-Za-z_]\w*)/;
/** `NAME = ...` or `NAME: T = ...` at column 0, not `==`. */
const PY_ASSIGN = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=(?!=)/;

/** Whether the module's importers are meant to use `name`: not `_private`, dunder names included. */
export function isPublicPythonName(name: string): boolean {
  return !name.startsWith('_') || (name.startsWith('__') && name.endsWith('__'));
}

export function pythonDeclarations(content: string): PythonDeclarations {
  const code = pythonCode(content);
  const functions: PythonFunction[] = [];
  const names: PythonDeclarations['names'] = new Map();
  let offset = 0;
  let line = 1;
  while (offset < code.length) {
    const end = lineEndOf(code, offset);
    const text = code.slice(offset, end);
    const declared = PY_DEF.exec(text);
    if (declared) {
      const [header, keyword, name] = declared;
      const kind = keyword === 'class' ? 'class' : 'function';
      names.set(name, { kind, line });
      if (kind === 'function') {
        const fn = parseFunction(code, offset + header.length, { name, line, isAsync: keyword !== 'def' });
        if (fn) functions.push(fn);
      }
    } else {
      const assigned = PY_ASSIGN.exec(text);
      if (assigned && !names.has(assigned[1])) names.set(assigned[1], { kind: 'variable', line });
    }
    offset = end + 1;
    line++;
  }
  return { functions, names };
}

function lineEndOf(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline < 0 ? text.length : newline;
}

/** The function whose parameter list opens at the first `(` after `start`; undefined when the header is malformed. */
function parseFunction(code: string, start: number, header: { name: string; line: number; isAsync: boolean }): PythonFunction | undefined {
  const open = code.indexOf('(', start);
  if (open < 0 || code.slice(start, open).trim() !== '') return undefined;
  const close = matchingParen(code, open);
  if (close < 0) return undefined;
  const colon = depthZeroIndex(code, close + 1, ':');
  const tail = code.slice(close + 1, colon < 0 ? lineEndOf(code, close) : colon).trim();
  return {
    ...header,
    kind: 'function',
    isExported: isPublicPythonName(header.name),
    parameters: parseParameters(code.slice(open + 1, close)),
    returnType: tail.startsWith('->') ? tail.slice(2).trim() : '',
  };
}

/** Index of the `)` closing the `(` at `open`, or -1 when the file ends first. */
function matchingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    depth += bracketDelta(code[i]);
    if (depth === 0) return i;
  }
  return -1;
}

function bracketDelta(char: string): number {
  if ('([{'.includes(char)) return 1;
  if (')]}'.includes(char)) return -1;
  return 0;
}

/** First `target` at bracket depth 0 from `start`, or -1. */
function depthZeroIndex(text: string, start: number, target: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (depth === 0 && text[i] === target) return i;
    depth += bracketDelta(text[i]);
    if (depth < 0) return -1;
  }
  return -1;
}

/** `text` split on its depth-0 commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (depth === 0 && text[i] === ',') {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
    depth += bracketDelta(text[i]);
  }
  parts.push(text.slice(last));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Parameters in order; the bare `*` and `/` markers bind no name, so they are skipped. */
function parseParameters(list: string): PythonParameter[] {
  const parameters: PythonParameter[] = [];
  for (const part of splitTopLevel(list)) {
    if (part === '*' || part === '/') continue;
    const stars = part.startsWith('**') ? 2 : Number(part.startsWith('*'));
    const equals = depthZeroIndex(part, 0, '=');
    const declaration = equals < 0 ? part.slice(stars) : part.slice(stars, equals);
    const colon = declaration.indexOf(':');
    parameters.push({
      name: (colon < 0 ? declaration : declaration.slice(0, colon)).trim(),
      type: colon < 0 ? '' : declaration.slice(colon + 1).trim(),
      // `*args`/`**kwargs` take any number of arguments, none included.
      isOptional: stars > 0,
      hasDefault: equals >= 0,
      isRest: stars > 0,
      position: parameters.length,
    });
  }
  return parameters;
}
