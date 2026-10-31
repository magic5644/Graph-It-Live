/**
 * Masks what is not code in JavaScript/TypeScript source: comments, and the text inside
 * quotes, template literals and regex literals become spaces. Delimiters, line breaks and
 * `${...}` template expressions are kept, so the result has the same length and lines as
 * the input and a match index in it maps back to the source.
 *
 * shortcut: JSX text is read as code (an apostrophe in `<p>it's</p>` masks the rest of its
 * line only); upgrade with a real JSX-aware tokenizer if that ever hides an import.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

/** Keywords after which `/` starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/** Punctuators after which `/` starts a regex literal. `)` and `]` end a value, so `/` divides. */
const REGEX_AFTER_PUNCTUATORS = new Set("(,=:[!&|?{};~+-*%<>^");

interface Scanner {
  readonly src: string;
  /** Output pieces; `src.slice(copied)` is still to be emitted */
  readonly parts: string[];
  copied: number;
  i: number;
  braceDepth: number;
  /** braceDepth at which each open `${` of a template literal resumes its template text */
  readonly templates: number[];
  /** Range of the last masked comment, skipped when looking back for the previous token */
  commentStart: number;
  commentEnd: number;
}

function isWordCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isSpaceCode(code: number | undefined): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Emits `src[copied..from)` as is and `src[from..to)` as spaces, line breaks kept. */
function mask(scanner: Scanner, from: number, to: number): void {
  if (to <= from) return;
  scanner.parts.push(scanner.src.slice(scanner.copied, from), scanner.src.slice(from, to).replaceAll(/[^\n\r]/g, " "));
  scanner.copied = to;
}

/** Last code token before `scanner.i`: "" at the start, a word, or one punctuator. */
function previousToken(scanner: Scanner): string {
  const { src } = scanner;
  let k = scanner.i - 1;
  while (k >= 0) {
    if (k < scanner.commentEnd && k >= scanner.commentStart) k = scanner.commentStart - 1;
    else if (isSpaceCode(src.codePointAt(k))) k--;
    else break;
  }
  if (k < 0) return "";
  if (!isWordCode(src.codePointAt(k))) return src[k];
  let start = k;
  while (start > 0 && isWordCode(src.codePointAt(start - 1))) start--;
  return src.slice(start, k + 1);
}

function regexAllowed(token: string): boolean {
  return token === "" || REGEX_AFTER_PUNCTUATORS.has(token) || REGEX_AFTER_KEYWORDS.has(token);
}

/** Index after the closing quote, or of the line end when the string is unterminated. */
function quotedEnd(src: string, start: number): number {
  const quote = src[start];
  let k = start + 1;
  while (k < src.length && src[k] !== quote && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
  return src[k] === quote ? k + 1 : Math.min(k, src.length);
}

/** Index after the closing `/` of a regex literal starting at `start`, or -1 when none on the line. */
function regexEnd(src: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < src.length; k++) {
    const ch = src[k];
    if (ch === "\n") return -1;
    if (ch === "\\") k++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return k + 1;
  }
  return -1;
}

/** Masks template text from `scanner.i` up to its closing backtick or next `${`. */
function scanTemplateText(scanner: Scanner): void {
  const { src } = scanner;
  let k = scanner.i;
  while (k < src.length && src[k] !== "`" && !(src[k] === "$" && src[k + 1] === "{")) k += src[k] === "\\" ? 2 : 1;
  k = Math.min(k, src.length);
  mask(scanner, scanner.i, k);
  if (src[k] === "$") {
    scanner.templates.push(scanner.braceDepth);
    scanner.braceDepth++;
    scanner.i = k + 2;
  } else {
    scanner.i = k + 1;
  }
}

/** Comment at `scanner.i`: masked whole. Returns false when there is none. */
function scanComment(scanner: Scanner): boolean {
  const { src, i } = scanner;
  if (src[i] !== "/" || (src[i + 1] !== "/" && src[i + 1] !== "*")) return false;
  let end: number;
  if (src[i + 1] === "/") {
    end = src.indexOf("\n", i);
  } else {
    end = src.indexOf("*/", i + 2);
    if (end !== -1) end += 2;
  }
  if (end === -1) end = src.length;
  mask(scanner, i, end);
  scanner.commentStart = i;
  scanner.commentEnd = end;
  scanner.i = end;
  return true;
}

/** String, template or regex literal at `scanner.i`: its text masked. Returns false when there is none. */
function scanLiteral(scanner: Scanner): boolean {
  const { src, i } = scanner;
  const ch = src[i];
  if (ch === "`") {
    scanner.i = i + 1;
    scanTemplateText(scanner);
    return true;
  }
  let end = -1;
  if (ch === "'" || ch === '"') end = quotedEnd(src, i);
  else if (ch === "/" && regexAllowed(previousToken(scanner))) end = regexEnd(src, i);
  if (end === -1) return false;
  const closed = end - 1 > i && src[end - 1] === ch;
  mask(scanner, i + 1, closed ? end - 1 : end);
  scanner.i = end;
  return true;
}

/** A brace or a division slash at `scanner.i`; a `}` closing a `${` resumes the template text. */
function scanBrace(scanner: Scanner): void {
  const ch = scanner.src[scanner.i];
  scanner.i++;
  if (ch === "{") {
    scanner.braceDepth++;
  } else if (ch === "}" && scanner.templates.at(-1) === scanner.braceDepth - 1) {
    scanner.templates.pop();
    scanner.braceDepth--;
    scanTemplateText(scanner);
  } else if (ch === "}") {
    scanner.braceDepth = Math.max(0, scanner.braceDepth - 1);
  }
}

/** `src` with comments and literal text masked; same length and line breaks. */
export function maskNonCode(src: string): string {
  const scanner: Scanner = { src, parts: [], copied: 0, i: 0, braceDepth: 0, templates: [], commentStart: 0, commentEnd: 0 };
  // Characters where scanning has something to decide; everything between them is plain code.
  const special = /[/'"`{}]/g;
  let match = special.exec(src);
  while (match !== null) {
    scanner.i = match.index;
    if (!scanComment(scanner) && !scanLiteral(scanner)) scanBrace(scanner);
    special.lastIndex = scanner.i;
    match = special.exec(src);
  }
  scanner.parts.push(src.slice(scanner.copied));
  return scanner.parts.join("");
}
