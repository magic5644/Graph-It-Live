/**
 * Extracts control-flow Mermaid diagrams from TypeScript source files.
 * Uses the TypeScript compiler API directly — no ts-morph project, no WASM.
 */

import * as fs from "node:fs";
import ts from "typescript";
import type { MermaidDiagram } from "../../shared/wiki-types.js";

const MAX_NODES_PER_DIAGRAM = 50;
const MAX_FUNCTIONS_PER_FILE = 999;
const MIN_COMPLEXITY = 2;

interface FunctionInfo {
  name: string;
  complexity: number;
  body: ts.Block;
}

// ---------------------------------------------------------------------------
// Complexity counting (cyclomatic-ish: branches only)
// ---------------------------------------------------------------------------

function countComplexity(node: ts.Node): number {
  let n = 0;
  if (ts.isIfStatement(node)) n += node.elseStatement ? 2 : 1;
  else if (ts.isSwitchStatement(node)) n += node.caseBlock.clauses.length;
  else if (
    ts.isForStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isDoStatement(node)
  ) n += 1;
  else if (ts.isTryStatement(node))
    n += (node.catchClause ? 1 : 0) + (node.finallyBlock ? 1 : 0);
  else if (ts.isConditionalExpression(node)) n += 1;

  ts.forEachChild(node, (child) => { n += countComplexity(child); });
  return n;
}

// ---------------------------------------------------------------------------
// Exported function discovery
// ---------------------------------------------------------------------------

function collectExportedFunctions(sf: ts.SourceFile): FunctionInfo[] {
  const result: FunctionInfo[] = [];

  function visit(node: ts.Node) {
    // export function foo() {}
    if (ts.isFunctionDeclaration(node) && node.body && hasExportModifier(node)) {
      const name = node.name?.text ?? "(anonymous)";
      result.push({ name, body: node.body, complexity: countComplexity(node.body) });
    }

    // export class Foo { method() {} }
    if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
      const className = node.name?.text ?? "Class";
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          const methodName = `${className}.${member.name.getText(sf)}`;
          result.push({
            name: methodName,
            body: member.body,
            complexity: countComplexity(member.body),
          });
        }
      }
    }

    // export const foo = () => {} or export const foo = function() {}
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = ts.isIdentifier(decl.name) ? decl.name.text : "(var)";
        if (decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) && ts.isBlock(decl.initializer.body)) {
            result.push({
              name,
              body: decl.initializer.body,
              complexity: countComplexity(decl.initializer.body),
            });
          } else if (ts.isFunctionExpression(decl.initializer) && decl.initializer.body) {
            result.push({
              name,
              body: decl.initializer.body,
              complexity: countComplexity(decl.initializer.body),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
  return text
    .replace(/['\n\r`"]/g, "")       // remove quotes, backticks, newlines
    .replace(/\|/g, " or ")          // | breaks Mermaid diamond syntax
    .replace(/&&/g, " and ")         // && before & to avoid double-replace
    .replace(/&/g, " and ")          // remaining &
    .replace(/[{}[\]()<>]/g, "")     // remove all brackets
    .replace(/[#;@!%^*=\\]/g, "")    // remove other special chars
    .replace(/\s+/g, " ")            // normalize whitespace
    .trim()
    .substring(0, 80);
}

function buildControlFlowMermaid(
  sf: ts.SourceFile,
  fn: FunctionInfo,
): { mermaid: string; nodeCount: number; truncated: boolean } {
  const lines: string[] = ["flowchart TD"];
  let counter = 0;
  let truncated = false;

  const newId = () => `n${counter++}`;

  const startId = newId();
  lines.push(`  ${startId}([${sanitize(fn.name)}])`);
  let prev = startId;

  function connect(from: string, to: string, label?: string) {
    lines.push(label ? `  ${from} -- ${label} --> ${to}` : `  ${from} --> ${to}`);
  }

  // Returns the "exit" node id to chain next statement onto
  function processStatement(stmt: ts.Statement, prevId: string): string {
    if (counter >= MAX_NODES_PER_DIAGRAM) {
      truncated = true;
      return prevId;
    }

    if (ts.isReturnStatement(stmt)) {
      const retId = newId();
      const label = stmt.expression
        ? sanitize(stmt.expression.getText(sf)).substring(0, 20)
        : "void";
      lines.push(`  ${retId}([return: ${label}])`);
      connect(prevId, retId);
      return retId;
    }

    if (ts.isThrowStatement(stmt)) {
      const throwId = newId();
      lines.push(`  ${throwId}[/throw/]`);
      connect(prevId, throwId);
      return throwId;
    }

    if (ts.isIfStatement(stmt)) {
      const condId = newId();
      const condText = sanitize(stmt.expression.getText(sf));
      lines.push(`  ${condId}{${condText}?}`);
      connect(prevId, condId);

      // YES branch
      const thenId = newId();
      lines.push(`  ${thenId}[then]`);
      connect(condId, thenId, "yes");
      const thenExit = ts.isBlock(stmt.thenStatement)
        ? processBlock(stmt.thenStatement, thenId)
        : thenId;

      // NO branch
      let noExit = condId;
      if (stmt.elseStatement && !truncated) {
        const elseId = newId();
        lines.push(`  ${elseId}[else]`);
        connect(condId, elseId, "no");
        noExit = ts.isBlock(stmt.elseStatement)
          ? processBlock(stmt.elseStatement, elseId)
          : elseId;
      }

      // Merge node
      if (!truncated) {
        const mergeId = newId();
        lines.push(`  ${mergeId}[ ]`);
        connect(thenExit, mergeId);
        if (noExit !== condId) connect(noExit, mergeId);
        else connect(condId, mergeId, "no");
        return mergeId;
      }
      return thenExit;
    }

    if (ts.isSwitchStatement(stmt)) {
      const switchId = newId();
      const switchText = sanitize(stmt.expression.getText(sf));
      lines.push(`  ${switchId}{switch: ${switchText}}`);
      connect(prevId, switchId);

      const exits: string[] = [];
      const maxCases = Math.min(stmt.caseBlock.clauses.length, 4);
      for (let i = 0; i < maxCases && !truncated; i++) {
        const clause = stmt.caseBlock.clauses[i];
        const caseId = newId();
        const caseLabel =
          ts.isCaseClause(clause)
            ? sanitize(clause.expression.getText(sf))
            : "default";
        lines.push(`  ${caseId}[${caseLabel}]`);
        connect(switchId, caseId, caseLabel);
        exits.push(caseId);
      }

      if (stmt.caseBlock.clauses.length > maxCases && !truncated) {
        const moreId = newId();
        lines.push(`  ${moreId}[...${stmt.caseBlock.clauses.length - maxCases} more]`);
        connect(switchId, moreId);
        exits.push(moreId);
      }

      if (!truncated && exits.length > 0) {
        const mergeId = newId();
        lines.push(`  ${mergeId}[ ]`);
        for (const e of exits) connect(e, mergeId);
        return mergeId;
      }
      return switchId;
    }

    if (
      ts.isForStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isDoStatement(stmt)
    ) {
      const loopId = newId();
      let loopLabel = "loop";
      if (ts.isForOfStatement(stmt)) {
        loopLabel = `forEach ${sanitize(stmt.expression.getText(sf))}`;
      } else if (ts.isForInStatement(stmt)) {
        loopLabel = `for...in ${sanitize(stmt.expression.getText(sf))}`;
      } else if (ts.isWhileStatement(stmt)) {
        loopLabel = `while ${sanitize(stmt.expression.getText(sf))}`;
      } else if (ts.isDoStatement(stmt)) {
        loopLabel = `do...while`;
      }
      lines.push(`  ${loopId}["${loopLabel}"]`);
      connect(prevId, loopId);
      return loopId;
    }

    if (ts.isTryStatement(stmt)) {
      const tryId = newId();
      lines.push(`  ${tryId}[try block]`);
      connect(prevId, tryId);

      if (stmt.catchClause && !truncated) {
        const catchId = newId();
        const catchLabel = stmt.catchClause.variableDeclaration
          ? `catch ${sanitize(stmt.catchClause.variableDeclaration.name.getText(sf))}`
          : "catch";
        lines.push(`  ${catchId}[${catchLabel}]`);
        connect(tryId, catchId, "error");
      }

      if (stmt.finallyBlock && !truncated) {
        const finallyId = newId();
        lines.push(`  ${finallyId}[finally]`);
        connect(tryId, finallyId);
        return finallyId;
      }
      return tryId;
    }

    // Generic expression statement — show if it's an await call (usually important)
    if (ts.isExpressionStatement(stmt)) {
      const expr = stmt.expression;
      if (ts.isAwaitExpression(expr) || ts.isCallExpression(expr)) {
        const exprId = newId();
        const text = sanitize(stmt.expression.getText(sf));
        lines.push(`  ${exprId}[${text}]`);
        connect(prevId, exprId);
        return exprId;
      }
    }

    return prevId;
  }

  function processBlock(block: ts.Block, prevId: string): string {
    let cur = prevId;
    for (const stmt of block.statements) {
      if (truncated) break;
      cur = processStatement(stmt, cur);
    }
    return cur;
  }

  prev = processBlock(fn.body, prev);

  // End node (only if we didn't end on a return/throw)
  const endId = newId();
  lines.push(`  ${endId}([end])`);
  lines.push(`  ${prev} --> ${endId}`);

  return {
    mermaid: lines.join("\n"),
    nodeCount: counter,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeControlFlow(filePath: string): MermaidDiagram[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const functions = collectExportedFunctions(sf);

  const candidates = functions
    .filter((f) => f.complexity >= MIN_COMPLEXITY)
    .sort((a, b) => b.complexity - a.complexity);

  const top = candidates.slice(0, MAX_FUNCTIONS_PER_FILE);
  const totalComplex = candidates.length;

  return top.map((fn, idx) => {
    const { mermaid, nodeCount, truncated } = buildControlFlowMermaid(sf, fn);

    const notes: string[] = [];
    if (truncated) notes.push(`Diagram truncated at ${MAX_NODES_PER_DIAGRAM} nodes — function too complex to render fully.`);
    if (idx === 0 && totalComplex > MAX_FUNCTIONS_PER_FILE)
      notes.push(`Showing ${top.length} of ${totalComplex} complex functions`);

    return {
      title: `Control flow: \`${fn.name}()\``,
      type: "control-flow" as const,
      mermaid,
      truncated: truncated || (idx === 0 && totalComplex > MAX_FUNCTIONS_PER_FILE),
      truncationNote: notes.length > 0 ? notes.join("; ") : undefined,
    };
  });
}
