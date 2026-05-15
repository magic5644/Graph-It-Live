import * as vscode from "vscode";

type DocumentSymbolOrInformation = vscode.DocumentSymbol | vscode.SymbolInformation;

type CallableSymbolCandidate = {
  name: string;
  fullName: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  depth: number;
};

function isCallableSymbolKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor
  );
}

function isDocumentSymbol(
  symbol: DocumentSymbolOrInformation,
): symbol is vscode.DocumentSymbol {
  return "children" in symbol;
}

function isRangeLike(
  range: vscode.Range | undefined,
): range is vscode.Range {
  return Boolean(range?.start && range?.end);
}

function includesCursorLine(range: vscode.Range, cursor: vscode.Position): boolean {
  return cursor.line >= range.start.line && cursor.line <= range.end.line;
}

function rangeSpan(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 10000 +
    (range.end.character - range.start.character);
}

function toIdentifierToken(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const directMatch = trimmed.match(/[$_A-Za-z][$_A-Za-z0-9]*/g);
  if (!directMatch || directMatch.length === 0) return null;
  return directMatch.at(-1) ?? null;
}

function buildCallableCandidatesFromDocumentSymbol(
  symbol: vscode.DocumentSymbol,
  depth: number,
  parentPath: string,
  out: CallableSymbolCandidate[],
): void {
  const fullName = parentPath ? `${parentPath}.${symbol.name}` : symbol.name;
  if (isCallableSymbolKind(symbol.kind) && isRangeLike(symbol.range)) {
    out.push({
      name: symbol.name,
      fullName,
      kind: symbol.kind,
      range: symbol.range,
      depth,
    });
  }

  for (const child of symbol.children) {
    buildCallableCandidatesFromDocumentSymbol(child, depth + 1, fullName, out);
  }
}

function buildCallableCandidates(
  symbols: DocumentSymbolOrInformation[],
): CallableSymbolCandidate[] {
  const candidates: CallableSymbolCandidate[] = [];

  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      buildCallableCandidatesFromDocumentSymbol(symbol, 0, "", candidates);
      continue;
    }

    if (!isCallableSymbolKind(symbol.kind) || !isRangeLike(symbol.location?.range)) {
      continue;
    }

    const containerName = symbol.containerName?.trim();
    const fullName = containerName ? `${containerName}.${symbol.name}` : symbol.name;
    candidates.push({
      name: symbol.name,
      fullName,
      kind: symbol.kind,
      range: symbol.location.range,
      depth: containerName ? containerName.split(".").length : 0,
    });
  }

  return candidates;
}

function symbolNameMatches(candidate: CallableSymbolCandidate, symbolName: string): boolean {
  const trimmed = symbolName.trim();
  if (trimmed.length === 0) return false;

  return (
    candidate.name === trimmed ||
    candidate.fullName === trimmed ||
    candidate.fullName.endsWith(`.${trimmed}`)
  );
}

function chooseMostSpecific(
  candidates: CallableSymbolCandidate[],
): CallableSymbolCandidate | null {
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    const spanDiff = rangeSpan(a.range) - rangeSpan(b.range);
    if (spanDiff !== 0) return spanDiff;
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  return sorted[0] ?? null;
}

function pickBestByToken(
  candidates: CallableSymbolCandidate[],
  token: string,
  cursor: vscode.Position,
): CallableSymbolCandidate | null {
  const matching = candidates.filter((candidate) =>
    symbolNameMatches(candidate, token),
  );

  if (matching.length === 0) return null;

  const sorted = [...matching].sort((a, b) => {
    const aDist = Math.abs(a.range.start.line - cursor.line);
    const bDist = Math.abs(b.range.start.line - cursor.line);
    if (aDist !== bDist) return aDist - bDist;

    const aCharDist = Math.abs(a.range.start.character - cursor.character);
    const bCharDist = Math.abs(b.range.start.character - cursor.character);
    if (aCharDist !== bCharDist) return aCharDist - bCharDist;

    return b.depth - a.depth;
  });

  return sorted[0] ?? null;
}

async function getDocumentSymbols(
  editor: vscode.TextEditor,
): Promise<DocumentSymbolOrInformation[]> {
  const raw = await vscode.commands.executeCommand<
    DocumentSymbolOrInformation[] | undefined
  >("vscode.executeDocumentSymbolProvider", editor.document.uri);

  return raw ?? [];
}

function getTokenNearCursor(editor: vscode.TextEditor): string | null {
  const cursor = editor.selection.active;
  const lineLength = editor.document.lineAt(cursor.line).text.length;
  const candidates: vscode.Position[] = [cursor];

  if (cursor.character < lineLength) {
    candidates.push(new vscode.Position(cursor.line, cursor.character + 1));
  }
  if (cursor.character > 0) {
    candidates.push(new vscode.Position(cursor.line, cursor.character - 1));
  }

  for (const position of candidates) {
    const range = editor.document.getWordRangeAtPosition(position);
    if (!range) continue;
    const token = toIdentifierToken(editor.document.getText(range));
    if (token) return token;
  }

  return null;
}

/** Identifiers that should never be treated as callable symbol names. */
const RESERVED_IDENTIFIERS = new Set([
  // JS/TS
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "return", "new", "delete", "typeof", "void", "await", "yield", "throw",
  "try", "catch", "finally", "import", "export", "class", "const", "let",
  "var", "in", "of", "super", "this", "null", "undefined", "true", "false",
  // Python
  "def", "async", "lambda", "pass", "global", "nonlocal", "assert", "raise",
  "except", "with", "as", "del", "not", "and", "or", "is",
  // Rust
  "fn", "mut", "pub", "use", "mod", "crate", "self", "impl", "struct",
  "trait", "match", "loop", "unsafe", "extern",
  // Go
  "func", "go", "chan", "map", "range", "select", "defer", "package",
]);

// Compiled declaration patterns — kept simple to stay under SonarQube complexity limit.
const PYTHON_DEF_RE = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const RUST_FN_RE = /\bfn\s+([A-Za-z_]\w*)/;
const GO_FUNC_RE = /^\s*func\s+([A-Za-z_]\w*)\s*\(/;
const JAVALIKE_HAS_MODIFIER = /\b(?:public|private|static|void|override|async)\b/;
const JAVALIKE_METHOD_NAME_RE = /\b([A-Za-z_$][\w$]*)\s*\(/;
const TS_FUNC_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;
const TS_HAS_ACCESS_MOD = /^\s*(?:public|private|protected|static|async|get|set|override)\s/;
const TS_IDENT_BEFORE_PAREN = /\b([A-Za-z_$][\w$]*)\s*\(/;
const TS_ARROW_RE = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;

/**
 * Extract a likely function/method name from a single source line using
 * language-specific heuristics. Returns null if no declaration is found.
 */
function extractDeclaredName(lineText: string, langId: string): string | null {
  switch (langId) {
    case "python": {
      const m = PYTHON_DEF_RE.exec(lineText);
      return m?.[1] ?? null;
    }
    case "rust": {
      const m = RUST_FN_RE.exec(lineText);
      return m?.[1] ?? null;
    }
    case "go": {
      const m = GO_FUNC_RE.exec(lineText);
      return m?.[1] ?? null;
    }
    case "java":
    case "csharp": {
      if (!JAVALIKE_HAS_MODIFIER.test(lineText)) return null;
      const m = JAVALIKE_METHOD_NAME_RE.exec(lineText);
      return m?.[1] ?? null;
    }
    default: {
      // TypeScript / JavaScript
      const funcMatch = TS_FUNC_RE.exec(lineText);
      if (funcMatch?.[1]) return funcMatch[1];

      if (TS_HAS_ACCESS_MOD.test(lineText)) {
        const identMatch = TS_IDENT_BEFORE_PAREN.exec(lineText);
        if (identMatch?.[1]) return identMatch[1];
      }

      const arrowMatch = TS_ARROW_RE.exec(lineText);
      if (arrowMatch?.[1]) return arrowMatch[1];

      return null;
    }
  }
}

/**
 * Scan backwards from cursor to find the nearest function/method declaration.
 * Fallback when the LSP symbol provider is unavailable (Python without Pylance,
 * Rust without rust-analyzer, etc.) or when cursor sits on a return-type annotation.
 */
function resolveSymbolByLineScan(editor: vscode.TextEditor): string | null {
  const cursor = editor.selection.active;
  const rawLangId = editor.document.languageId ?? "";
  const langId = rawLangId
    .replace("typescriptreact", "typescript")
    .replace("javascriptreact", "javascript");
  const scanStart = Math.max(0, cursor.line - 20);

  for (let line = cursor.line; line >= scanStart; line--) {
    const text = editor.document.lineAt(line).text;
    const name = extractDeclaredName(text, langId);
    if (name && !RESERVED_IDENTIFIERS.has(name)) {
      return name;
    }
  }

  return null;
}

/**
 * Resolve the most likely callable symbol under cursor across languages.
 *
 * Strategy:
 * 1) selected text → callable symbol match
 * 2) enclosing callable symbol by range containment (LSP)
 * 3) line-scan backwards for function/method declaration (works without LSP)
 * 4) token near cursor → callable symbol match
 * 5) raw token fallback
 */
export async function resolveBestCallableSymbolAtCursor(
  editor: vscode.TextEditor,
): Promise<string | null> {
  const symbols = await getDocumentSymbols(editor);
  const callableCandidates = buildCallableCandidates(symbols);
  const cursor = editor.selection.active;

  const selectedText = editor.document.getText(editor.selection);
  const selectedToken = toIdentifierToken(selectedText);
  if (selectedToken) {
    const selectedCandidate = pickBestByToken(callableCandidates, selectedToken, cursor);
    if (selectedCandidate) {
      return selectedCandidate.name;
    }
  }

  const enclosing = chooseMostSpecific(
    callableCandidates.filter((candidate) =>
      candidate.range.contains(cursor) || includesCursorLine(candidate.range, cursor),
    ),
  );
  if (enclosing) {
    return enclosing.name;
  }

  // Line-scan fallback: works for Python/Rust/Go without active LSP and when
  // cursor is on a return-type annotation or in the function body.
  const scannedName = resolveSymbolByLineScan(editor);
  if (scannedName) {
    return scannedName;
  }

  const token = getTokenNearCursor(editor);
  if (!token) return null;

  const tokenCandidate = pickBestByToken(callableCandidates, token, cursor);
  if (tokenCandidate) {
    return tokenCandidate.name;
  }

  return token;
}

export function resolveBestRootNodeByCursor(
  nodes: Array<{
    id: string;
    name: string;
    startLine: number;
    endLine: number;
    startCol: number;
  }>,
  cursorLine: number,
  cursorCharacter: number,
  preferredSymbolName?: string | null,
): { id: string } | null {
  if (nodes.length === 0) return null;

  const nameMatched = preferredSymbolName
    ? nodes.filter((node) =>
      node.name === preferredSymbolName ||
      node.name.endsWith(`.${preferredSymbolName}`),
    )
    : [];

  const containing = nodes.filter(
    (node) => node.startLine <= cursorLine && cursorLine <= node.endLine,
  );
  const containingPool = containing.length > 0 ? containing : nodes;

  const scopedPool = nameMatched.length > 0
    ? containingPool.filter((node) =>
      nameMatched.some((matched) => matched.id === node.id),
    )
    : containingPool;
  const finalPool = scopedPool.length > 0 ? scopedPool : containingPool;

  const sorted = [...finalPool].sort((a, b) => {
    let aLineDistance = 0;
    if (cursorLine < a.startLine) {
      aLineDistance = a.startLine - cursorLine;
    } else if (cursorLine > a.endLine) {
      aLineDistance = cursorLine - a.endLine;
    }

    let bLineDistance = 0;
    if (cursorLine < b.startLine) {
      bLineDistance = b.startLine - cursorLine;
    } else if (cursorLine > b.endLine) {
      bLineDistance = cursorLine - b.endLine;
    }

    if (aLineDistance !== bLineDistance) return aLineDistance - bLineDistance;

    const aCharDistance = Math.abs(a.startCol - cursorCharacter);
    const bCharDistance = Math.abs(b.startCol - cursorCharacter);
    if (aCharDistance !== bCharDistance) return aCharDistance - bCharDistance;

    if (a.startLine !== b.startLine) return b.startLine - a.startLine;
    return b.startCol - a.startCol;
  });

  if (sorted.length === 0) return null;
  return { id: sorted[0].id };
}
