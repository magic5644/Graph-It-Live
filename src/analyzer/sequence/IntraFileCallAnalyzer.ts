import * as fs from "node:fs";
import * as path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { Node, MethodDeclaration, FunctionDeclaration } from "ts-morph";

const PYTHON_RESERVED = new Set([
  "if", "else", "elif", "for", "while", "not", "and", "or", "in", "is",
  "del", "pass", "break", "continue", "return", "raise", "from", "import",
  "as", "with", "assert", "lambda", "yield", "True", "False", "None",
  "class", "def", "global", "nonlocal", "except", "finally", "try",
  "async", "await", "print", "len", "range", "type", "super",
]);

const RUST_RESERVED = new Set([
  "if", "else", "for", "while", "loop", "match", "return", "break", "continue",
  "let", "mut", "ref", "in", "as", "use", "mod", "pub", "fn", "struct",
  "enum", "trait", "impl", "where", "type", "const", "static", "extern",
  "crate", "self", "Self", "super", "true", "false", "move", "unsafe",
  "async", "await", "dyn", "println", "eprintln", "vec",
]);

export interface IntraFileCall {
  calleeName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  order: number;
}

export class IntraFileCallAnalyzer {
  async extractCallsFromMethod(
    filePath: string,
    methodName: string,
  ): Promise<IntraFileCall[]> {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const ext = path.extname(filePath).toLowerCase();

    // Dispatch to language-specific extractors
    if (ext === ".py" || ext === ".pyi") {
      const content = fs.readFileSync(filePath, "utf-8");
      return extractCallsFromMethodPython(content, methodName);
    }
    if (ext === ".rs") {
      const content = fs.readFileSync(filePath, "utf-8");
      return extractCallsFromMethodRust(content, methodName);
    }

    try {
      const sourceCode = fs.readFileSync(filePath, "utf-8");
      const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 7, module: 99 }, // ES2020 = 7, ESNext = 99
      });

      const sourceFile = project.createSourceFile("temp.ts", sourceCode);
      const calls: IntraFileCall[] = [];

      // Find the target method
      let targetMethod: MethodDeclaration | FunctionDeclaration | undefined;

      // Check top-level functions
      for (const func of sourceFile.getFunctions()) {
        if (func.getName() === methodName) {
          targetMethod = func;
          break;
        }
      }

      // Check methods in classes
      if (!targetMethod) {
        for (const cls of sourceFile.getClasses()) {
          const method = cls.getMethods().find((m) => m.getName() === methodName);
          if (method) {
            targetMethod = method;
            break;
          }
        }
      }

      if (targetMethod) {
        extractCallsFromBody(targetMethod, calls);
      }

      return calls;
    } catch {
      return [];
    }
  }
}

function extractCallsFromBody(
  methodNode: MethodDeclaration | FunctionDeclaration,
  calls: IntraFileCall[],
): void {
  let order = 0;
  const body = methodNode.getBody?.();

  if (!body) {
    return;
  }

  const visitNode = (node: Node): void => {
    const kind = node.getKind();

    // Extract call expressions
    if (kind === SyntaxKind.CallExpression) {
      try {
        const callNode = node as any; // Safe cast for CallExpression
        const callee = callNode.getExpression?.();
        let calleeName = "";

        if (callee) {
          const calleeKind = callee.getKind();

          if (calleeKind === SyntaxKind.PropertyAccessExpression) {
            // obj.method() or this.method()
            const lastChild = callee.getLastChild();
            calleeName = lastChild?.getText() || callee.getText();
          } else if (calleeKind === SyntaxKind.Identifier) {
            // method() or function()
            calleeName = callee.getText();
          } else {
            calleeName = callee.getText();
          }
        }

        if (calleeName) {
          const pos = node.getStart() || 0;
          const sourceFile = node.getSourceFile();
          const lineAndColumn = sourceFile?.getLineAndColumnAtPos(pos) || {
            line: 0,
            column: 0,
          };
          const endPos = node.getEnd() || pos;
          const endLineAndColumn = sourceFile?.getLineAndColumnAtPos(endPos) || {
            line: 0,
            column: 0,
          };

          calls.push({
            calleeName,
            line: lineAndColumn.line || 0,
            column: lineAndColumn.column || 0,
            endLine: endLineAndColumn.line || 0,
            endColumn: endLineAndColumn.column || 0,
            order: order++,
          });
        }
      } catch {
        // Ignore errors during call extraction
      }
    }

    // Recurse into children
    node.forEachChild((child) => visitNode(child));
  };

  visitNode(body);
}

// Regex used by Python/Rust extractors (compiled once, reused)
const PYTHON_CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const PYTHON_DEF_RE = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PYTHON_INDENT_RE = /^(\s*)/;
const RUST_CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const RUST_FN_DECL_RE = /\bfn\s+(\w+)\b/;

function findPythonDef(lines: string[], methodName: string): { line: number; indent: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = PYTHON_DEF_RE.exec(lines[i]);
    if (m?.[2] === methodName) return { line: i, indent: m[1].length };
  }
  return null;
}

function getPythonBodyIndent(lines: string[], defLine: number, defIndent: number): number {
  for (let i = defLine + 1; i < Math.min(defLine + 6, lines.length); i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    const indent = (PYTHON_INDENT_RE.exec(lines[i])?.[1] ?? "").length;
    if (indent > defIndent) return indent;
    break;
  }
  return defIndent + 1;
}

function collectPythonCalls(lines: string[], defLine: number, bodyIndent: number, defIndent: number): IntraFileCall[] {
  const calls: IntraFileCall[] = [];
  let order = 0;
  for (let i = defLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const currentIndent = (PYTHON_INDENT_RE.exec(line)?.[1] ?? "").length;
    if (currentIndent < bodyIndent && currentIndent <= defIndent) break;
    if (trimmed.startsWith("#")) continue;
    PYTHON_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PYTHON_CALL_RE.exec(line)) !== null) {
      const callee = m[1];
      if (!PYTHON_RESERVED.has(callee)) {
        calls.push({ calleeName: callee, line: i, column: m.index, endLine: i, endColumn: m.index + callee.length, order: order++ });
      }
    }
  }
  return calls;
}

function extractCallsFromMethodPython(content: string, methodName: string): IntraFileCall[] {
  const lines = content.split("\n");
  const defInfo = findPythonDef(lines, methodName);
  if (!defInfo) return [];
  const bodyIndent = getPythonBodyIndent(lines, defInfo.line, defInfo.indent);
  return collectPythonCalls(lines, defInfo.line, bodyIndent, defInfo.indent);
}

function findRustFnLine(lines: string[], fnName: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (RUST_FN_DECL_RE.exec(lines[i])?.[1] === fnName) return i;
  }
  return -1;
}

function countBraceChange(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function scanRustLine(line: string, startOrder: number, lineIdx: number): IntraFileCall[] {
  const found: IntraFileCall[] = [];
  RUST_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let ord = startOrder;
  while ((m = RUST_CALL_RE.exec(line)) !== null) {
    const callee = m[1];
    if (!RUST_RESERVED.has(callee)) {
      found.push({ calleeName: callee, line: lineIdx, column: m.index, endLine: lineIdx, endColumn: m.index + callee.length, order: ord++ });
    }
  }
  return found;
}

function collectRustCalls(lines: string[], fnLine: number): IntraFileCall[] {
  const calls: IntraFileCall[] = [];
  let depth = 0;
  let inBody = false;
  let order = 0;
  for (let i = fnLine; i < lines.length; i++) {
    depth += countBraceChange(lines[i]);
    if (!inBody) {
      if (depth > 0) inBody = true;
      continue;
    }
    if (depth === 0) break;
    const lineCalls = scanRustLine(lines[i], order, i);
    order += lineCalls.length;
    calls.push(...lineCalls);
  }
  return calls;
}

function extractCallsFromMethodRust(content: string, methodName: string): IntraFileCall[] {
  const lines = content.split("\n");
  const fnLine = findRustFnLine(lines, methodName);
  if (fnLine < 0) return [];
  return collectRustCalls(lines, fnLine);
}
