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
    collectExportedFunctionDeclaration(node, result);
    collectExportedClassMethods(sf, node, result);
    collectExportedVariableFunctions(node, result);

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

function collectExportedFunctionDeclaration(node: ts.Node, result: FunctionInfo[]): void {
  if (!ts.isFunctionDeclaration(node) || !node.body || !hasExportModifier(node)) return;

  const name = node.name?.text ?? "(anonymous)";
  result.push({ name, body: node.body, complexity: countComplexity(node.body) });
}

function collectExportedClassMethods(
  sf: ts.SourceFile,
  node: ts.Node,
  result: FunctionInfo[],
): void {
  if (!ts.isClassDeclaration(node) || !hasExportModifier(node)) return;

  const className = node.name?.text ?? "Class";
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member) || !member.body) continue;

    const name = `${className}.${member.name.getText(sf)}`;
    result.push({ name, body: member.body, complexity: countComplexity(member.body) });
  }
}

function collectExportedVariableFunctions(node: ts.Node, result: FunctionInfo[]): void {
  if (!ts.isVariableStatement(node) || !hasExportModifier(node)) return;

  for (const decl of node.declarationList.declarations) {
    collectVariableFunction(decl, result);
  }
}

function collectVariableFunction(decl: ts.VariableDeclaration, result: FunctionInfo[]): void {
  const body = getVariableFunctionBody(decl);
  if (!body) return;

  const name = ts.isIdentifier(decl.name) ? decl.name.text : "(var)";
  result.push({ name, body, complexity: countComplexity(body) });
}

function getVariableFunctionBody(decl: ts.VariableDeclaration): ts.Block | undefined {
  const initializer = decl.initializer;
  if (!initializer) return undefined;
  if (ts.isFunctionExpression(initializer)) return initializer.body;
  if (ts.isArrowFunction(initializer) && ts.isBlock(initializer.body)) return initializer.body;
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function isLoopStatement(stmt: ts.Statement): boolean {
  return (
    ts.isForStatement(stmt) ||
    ts.isWhileStatement(stmt) ||
    ts.isForInStatement(stmt) ||
    ts.isForOfStatement(stmt) ||
    ts.isDoStatement(stmt)
  );
}

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
  return text
    .replace(/['\n\r`"]/g, "")       // remove quotes, backticks, newlines
    .replaceAll('|', " or ")          // | breaks Mermaid diamond syntax
    .replaceAll('&&', " and ")         // && before & to avoid double-replace
    .replaceAll('&', " and ")          // remaining &
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

  function processBlock(block: ts.Block, prevId: string): string {
    let cur = prevId;
    for (const stmt of block.statements) {
      if (truncated) break;
      cur = processStatement(stmt, cur);
    }
    return cur;
  }

  function processReturn(stmt: ts.ReturnStatement, prevId: string): string {
    const retId = newId();
    const label = stmt.expression
      ? sanitize(stmt.expression.getText(sf)).substring(0, 20)
      : "void";
    lines.push(`  ${retId}([return: ${label}])`);
    connect(prevId, retId);
    return retId;
  }

  function processThrow(prevId: string): string {
    const throwId = newId();
    lines.push(`  ${throwId}[/throw/]`);
    connect(prevId, throwId);
    return throwId;
  }

  function processIf(stmt: ts.IfStatement, prevId: string): string {
    const condId = newId();
    const condText = sanitize(stmt.expression.getText(sf));
    lines.push(`  ${condId}{${condText}?}`);
    connect(prevId, condId);

    const thenId = newId();
    lines.push(`  ${thenId}[then]`);
    connect(condId, thenId, "yes");
    const thenExit = ts.isBlock(stmt.thenStatement)
      ? processBlock(stmt.thenStatement, thenId)
      : thenId;

    let noExit = condId;
    if (stmt.elseStatement && !truncated) {
      const elseId = newId();
      lines.push(`  ${elseId}[else]`);
      connect(condId, elseId, "no");
      noExit = ts.isBlock(stmt.elseStatement)
        ? processBlock(stmt.elseStatement, elseId)
        : elseId;
    }

    return connectIfMerge(condId, thenExit, noExit);
  }

  function connectIfMerge(condId: string, thenExit: string, noExit: string): string {
    if (truncated) return thenExit;

    const mergeId = newId();
    lines.push(`  ${mergeId}[ ]`);
    connect(thenExit, mergeId);
    if (noExit === condId) {connect(condId, mergeId, "no");}
    else {connect(noExit, mergeId);}
    return mergeId;
  }

  function processSwitch(stmt: ts.SwitchStatement, prevId: string): string {
    const switchId = newId();
    const switchText = sanitize(stmt.expression.getText(sf));
    lines.push(`  ${switchId}{switch: ${switchText}}`);
    connect(prevId, switchId);

    const exits = addSwitchCases(stmt, switchId);
    if (truncated || exits.length === 0) return switchId;

    const mergeId = newId();
    lines.push(`  ${mergeId}[ ]`);
    for (const exitId of exits) connect(exitId, mergeId);
    return mergeId;
  }

  function addSwitchCases(stmt: ts.SwitchStatement, switchId: string): string[] {
    const exits: string[] = [];
    const maxCases = Math.min(stmt.caseBlock.clauses.length, 4);
    for (let i = 0; i < maxCases && !truncated; i++) {
      const clause = stmt.caseBlock.clauses[i];
      const caseId = newId();
      const caseLabel = ts.isCaseClause(clause)
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
    return exits;
  }

  function processLoop(stmt: ts.Statement, prevId: string): string {
    const loopId = newId();
    lines.push(`  ${loopId}["${getLoopLabel(stmt)}"]`);
    connect(prevId, loopId);
    return loopId;
  }

  function getLoopLabel(stmt: ts.Statement): string {
    if (ts.isForOfStatement(stmt)) return `forEach ${sanitize(stmt.expression.getText(sf))}`;
    if (ts.isForInStatement(stmt)) return `for...in ${sanitize(stmt.expression.getText(sf))}`;
    if (ts.isWhileStatement(stmt)) return `while ${sanitize(stmt.expression.getText(sf))}`;
    if (ts.isDoStatement(stmt)) return "do...while";
    return "loop";
  }

  function processTry(stmt: ts.TryStatement, prevId: string): string {
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

    if (!stmt.finallyBlock || truncated) return tryId;

    const finallyId = newId();
    lines.push(`  ${finallyId}[finally]`);
    connect(tryId, finallyId);
    return finallyId;
  }

  function processExpression(stmt: ts.ExpressionStatement, prevId: string): string {
    const expr = stmt.expression;
    if (!ts.isAwaitExpression(expr) && !ts.isCallExpression(expr)) return prevId;

    const exprId = newId();
    const text = sanitize(stmt.expression.getText(sf));
    lines.push(`  ${exprId}[${text}]`);
    connect(prevId, exprId);
    return exprId;
  }

  // Returns the "exit" node id to chain next statement onto
  function processStatement(stmt: ts.Statement, prevId: string): string {
    if (counter >= MAX_NODES_PER_DIAGRAM) {
      truncated = true;
      return prevId;
    }

    if (ts.isReturnStatement(stmt)) return processReturn(stmt, prevId);
    if (ts.isThrowStatement(stmt)) return processThrow(prevId);
    if (ts.isIfStatement(stmt)) return processIf(stmt, prevId);
    if (ts.isSwitchStatement(stmt)) return processSwitch(stmt, prevId);
    if (isLoopStatement(stmt)) return processLoop(stmt, prevId);
    if (ts.isTryStatement(stmt)) return processTry(stmt, prevId);
    if (ts.isExpressionStatement(stmt)) return processExpression(stmt, prevId);
    return prevId;
  }

  prev = processBlock(fn.body, prev);

  // End node (only if we didn't end on a return/throw)
  const endId = newId();
  lines.push(`  ${endId}([end])`, `  ${prev} --> ${endId}`);

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
    const { mermaid, truncated } = buildControlFlowMermaid(sf, fn);

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
