/**
 * The flow model of one entry symbol (#792): its callees from the call graph index, collapsed into at most
 * `maxSteps` steps in call order, each step and call on the main, alternative or error lane read from the call
 * site's AST (TypeScript/JavaScript and Python). It is the data every flow surface draws; drawing is theirs.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Database, Statement } from "sql.js";
import type { Node as TreeNode } from "web-tree-sitter";
import { lookupCallGraphSymbol, symbolNamesInFile, type CallGraphSymbol } from "@/analyzer/callgraph/CallGraphSymbolLookup";
import type { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { closestNames, closestPathsHint, symbolNotFoundMessage } from "@/analyzer/utils/SymbolLookup";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

export const DEFAULT_FLOW_STEPS = 8;

export type FlowLane = "main" | "alternative" | "error";

export interface FlowNode {
  /** Workspace-relative file and symbol name (`src/a.ts#run`), `@line` added only to tell homonyms apart. */
  id: string;
  title: string;
  /** First sentence of the symbol's doc comment, when it has one. */
  subtitle?: string;
  /** Workspace-relative file and 1-based declaration line. */
  file: string;
  line: number;
  lane: FlowLane;
  /** Symbols of the step's file the step folds in, its entry symbol included. */
  symbolCount: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** Call site: workspace-relative file and 1-based line. */
  file: string;
  line: number;
  relation: "CALLS" | "REFERENCES";
  lane: FlowLane;
  /** The condition the call site sits under, when it is short. */
  condition?: string;
  /** Text drawn on the edge, from an annotated spec (#794); else the condition or the call line. */
  label?: string;
}

export interface FlowModel {
  entry: string;
  /** Language of the entry symbol. */
  language: string;
  /** "unsupported": lanes are not read for this language, so every step is on main, in call order. */
  lanes: "detected" | "unsupported";
  maxSteps: number;
  /** Steps in call order, the entry first. */
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Symbols of other files the shown steps call that the step cap left out (not walked further). */
  omittedSteps: number;
  /** Header lines from an annotated spec (#794); else built from the entry step. */
  caption?: { title: string; caption: string };
}

export interface FlowModelRequest {
  /** Absolute path of the entry symbol's file. */
  filePath: string;
  symbolName: string;
  /** Declaration line, 1-based (the editor line): selects one of several homonyms. */
  startLine?: number;
  maxSteps?: number;
}

export interface FlowModelSources {
  rootDir: string;
  extractor: Pick<GraphExtractor, "parseTree">;
  readFile?: (filePath: string) => Promise<string>;
}

export const LANE_LANGUAGES: ReadonlySet<string> = new Set(["typescript", "javascript", "python"]);
const LANE_RANK: Record<FlowLane, number> = { main: 0, alternative: 1, error: 2 };
const MAX_CONDITION = 60;
const MAX_SUBTITLE = 120;

export const CALLEES_SQL = `SELECT e.target_id, t.name, t.path, t.start_line, t.lang, e.source_line, e.type_relation
  FROM edges e JOIN nodes t ON t.id = e.target_id
  WHERE e.source_id = ? AND e.type_relation IN ('CALLS', 'REFERENCES')
  ORDER BY e.source_line, e.target_id`;

export interface FlowSymbol {
  id: string;
  name: string;
  path: string;
  startLine: number;
  lang: SupportedLang;
}

/** The call into a symbol: the caller's file, the 0-based call line and the called name. */
export interface CallSite {
  file: string;
  row: number;
  name: string;
}

interface Visit {
  symbol: FlowSymbol;
  step: number;
  /** Call order: the parent's key, then the call's rank among the parent's calls (sorted by call line). */
  key: number[];
}

/** One call between two placed symbols: the lanes are read from all of them. */
interface PlacedCall {
  caller: number;
  callee: number;
  site: CallSite;
  relation: FlowEdge["relation"];
}

/** Two steps one or more calls join; the model draws the most direct of those calls. */
interface StepEdge {
  from: number;
  to: number;
}

interface Walk {
  visits: Visit[];
  /** Index of each step's entry visit, in the order the steps were opened. */
  steps: number[];
  edges: StepEdge[];
  calls: PlacedCall[];
  omittedSteps: number;
}

/** The flow model of `request`'s symbol; an unknown file or symbol, or an ambiguous one, is an error naming candidates. */
export async function buildFlowModel(db: Database, request: FlowModelRequest, sources: FlowModelSources): Promise<FlowModel> {
  const root = findEntry(db, request, sources.rootDir);
  const maxSteps = request.maxSteps ?? DEFAULT_FLOW_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error(`maxSteps must be an integer of at least 1, got ${maxSteps}.`);
  const walk = walkCallees(db, root, maxSteps);
  const lanes = LANE_LANGUAGES.has(root.lang) ? "detected" : "unsupported";
  const readFile = sources.readFile ?? ((file: string) => fs.readFile(file, "utf8"));
  const stepFiles = [...new Set(walk.steps.map((visit) => walk.visits[visit].symbol.path))];
  const lines = new Map(await Promise.all(stepFiles.map(async (file) => [file, (await readSource(readFile, file, sources.rootDir)).split("\n")] as const)));
  const siteLanes = lanes === "detected" ? await readSiteLanes(walk, lines, sources) : new Map<CallSite, SiteLane>();
  return toModel(walk, { root, maxSteps, lanes, lines, siteLanes, rootDir: sources.rootDir });
}

export function findEntry(db: Database, request: FlowModelRequest, rootDir: string): FlowSymbol {
  const label = relativeTo(rootDir, request.filePath);
  const indexed = db.exec("SELECT 1 FROM file_index WHERE path = ?", [normalizePath(request.filePath)]);
  if (!indexed[0]) throw new Error(`File '${label}' is not in the call graph index.${closestPathsHint(request.filePath, rootDir)}`);
  const lookup = lookupCallGraphSymbol(db, request);
  if (lookup.symbol) {
    const { id, name, filePath, startLine, lang } = lookup.symbol;
    // The walk reads 0-based rows from the call graph; the lookup speaks editor lines.
    return { id, name, path: filePath, startLine: startLine - 1, lang: lang as SupportedLang };
  }
  const candidates = lookup.candidates.map(candidateLabel).join(", ");
  if (lookup.reason === "ambiguous") {
    throw new Error(`Symbol '${request.symbolName}' is ambiguous in ${label}: ${candidates}. Pass startLine to select one.`);
  }
  if (lookup.reason === "stale_selector") {
    throw new Error(`No symbol '${request.symbolName}' starts at line ${request.startLine} in ${label}. Candidates: ${candidates}. Pass startLine to select one.`);
  }
  const names = closestNames(symbolNamesInFile(db, request.filePath), request.symbolName);
  throw new Error(symbolNotFoundMessage(request.symbolName, label, names));
}

const candidateLabel = (symbol: CallGraphSymbol) => `${symbol.name} (${symbol.type}, line ${symbol.startLine})`;

/**
 * Opens steps nearest first (0-1 breadth-first: a callee in the caller's step file folds into that step and is
 * walked at once, one in another file opens a step after the current level), so the cap keeps the entry's own
 * calls before deeper helpers. Past `maxSteps` a callee of another file is counted, never walked: the work stays
 * within the shown steps' files. The model then sorts the steps back into call order.
 */
function walkCallees(db: Database, root: FlowSymbol, maxSteps: number): Walk {
  const statement = db.prepare(CALLEES_SQL);
  const state: WalkState = {
    walk: { visits: [{ symbol: root, step: 0, key: [] }], steps: [0], edges: [], calls: [], omittedSteps: 0 },
    visitOf: new Map([[root.id, 0]]),
    linked: new Set(),
    omitted: new Set(),
    front: [],
    back: [],
    head: 0,
  };
  try {
    queueCallees(state, statement, 0);
    for (let call = nextCall(state); call; call = nextCall(state)) {
      const index = place(state, call, maxSteps);
      if (index !== undefined) queueCallees(state, statement, index);
    }
  } finally {
    statement.free();
  }
  // No symbol is placed once the cap is reached (the last step's same-file chain is walked before any queued
  // call), so a symbol left out is never placed later.
  state.walk.omittedSteps = state.omitted.size;
  return state.walk;
}

interface PendingCall {
  callee: FlowSymbol;
  parent: number;
  rank: number;
  sameFile: boolean;
  site: CallSite;
  relation: FlowEdge["relation"];
}

interface WalkState {
  walk: Walk;
  visitOf: Map<string, number>;
  /** `from>to` step pairs already joined by an edge. */
  linked: Set<string>;
  omitted: Set<string>;
  /** Same-file calls, walked first (a stack, next on top). */
  front: PendingCall[];
  /** Calls into other files, a queue read from `head`. */
  back: PendingCall[];
  head: number;
}

const nextCall = (state: WalkState): PendingCall | undefined => state.front.pop() ?? state.back[state.head++];

/** Places one call: a new visit's index, or undefined for a callee already placed or left out. */
function place(state: WalkState, call: PendingCall, maxSteps: number): number | undefined {
  const { walk } = state;
  const from = walk.visits[call.parent].step;
  const known = state.visitOf.get(call.callee.id);
  if (known !== undefined) {
    walk.calls.push({ caller: call.parent, callee: known, site: call.site, relation: call.relation });
    link(state, from, walk.visits[known].step);
    return undefined;
  }
  if (!call.sameFile && walk.steps.length >= maxSteps) {
    state.omitted.add(call.callee.id);
    return undefined;
  }
  const index = walk.visits.length;
  const step = call.sameFile ? from : walk.steps.length;
  walk.visits.push({ symbol: call.callee, step, key: [...walk.visits[call.parent].key, call.rank] });
  state.visitOf.set(call.callee.id, index);
  walk.calls.push({ caller: call.parent, callee: index, site: call.site, relation: call.relation });
  if (!call.sameFile) {
    walk.steps.push(index);
    link(state, from, step);
  }
  return index;
}

function link(state: WalkState, from: number, to: number): void {
  const key = `${from}>${to}`;
  if (from === to || state.linked.has(key)) return;
  state.linked.add(key);
  state.walk.edges.push({ from, to });
}

/** Queues the callees of a visit in call-line order: same-file ones on the front stack, the others at the back. */
function queueCallees(state: WalkState, statement: Statement, index: number): void {
  const { visits, steps } = state.walk;
  const caller = visits[index].symbol;
  const stepFile = visits[steps[visits[index].step]].symbol.path;
  const sameFile: PendingCall[] = [];
  const queued = state.back.length;
  statement.bind([caller.id]);
  while (statement.step()) {
    const rank = sameFile.length + state.back.length - queued;
    const [targetId, name, file, startLine, lang, sourceLine, relation] = statement.get();
    const call: PendingCall = {
      callee: { id: String(targetId), name: String(name), path: String(file), startLine: Number(startLine), lang: String(lang) as SupportedLang },
      parent: index,
      rank,
      sameFile: String(file) === stepFile,
      site: { file: caller.path, row: Number(sourceLine), name: String(name) },
      relation: relation as FlowEdge["relation"],
    };
    (call.sameFile ? sameFile : state.back).push(call);
  }
  statement.reset();
  state.front.push(...sameFile.toReversed());
}

export async function readSource(readFile: (file: string) => Promise<string>, file: string, rootDir: string): Promise<string> {
  try {
    return await readFile(file);
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
    throw new Error(`${relativeTo(rootDir, file)} is in the call graph index but cannot be read (${reason}): re-index the workspace.`, { cause: error });
  }
}

interface SiteLane {
  lane: FlowLane;
  condition?: string;
}

/** The lane of every call site the model draws, each step file parsed once. */
async function readSiteLanes(walk: Walk, lines: Map<string, string[]>, { extractor, rootDir }: FlowModelSources): Promise<Map<CallSite, SiteLane>> {
  const sites = walk.calls.map((call) => call.site);
  const langOf = new Map(walk.visits.map((visit) => [visit.symbol.path, visit.symbol.lang]));
  // shortcut: a step file in a language without lane detection (a Rust file a Python entry calls) reads its own
  // call sites as main; the lane it inherits from its callers still applies. Upgrade when such mixes need lanes.
  const files = [...langOf].filter(([file, lang]) => LANE_LANGUAGES.has(lang) && sites.some((site) => site.file === file));
  const lanes = new Map<CallSite, SiteLane>();
  await Promise.all(files.map(async ([file, lang]) => {
    const fileLines = lines.get(file) ?? [];
    const tree = await extractor.parseTree(file, lang, fileLines.join("\n"));
    if (!tree) throw new Error(`${relativeTo(rootDir, file)} could not be parsed to read its call sites' lanes.`);
    try {
      for (const site of sites) if (site.file === file) lanes.set(site, laneAt(tree.rootNode, fileLines[site.row] ?? "", site));
    } finally {
      tree.delete();
    }
  }));
  return lanes;
}

export const SCOPES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "arrow_function", "method_definition", "function_definition", "lambda", "class_body", "class_definition"]);
const THROWS = new Set(["throw_statement", "raise_statement"]);
export const CATCHES = new Set(["catch_clause", "except_clause", "except_group_clause"]);
const BLOCKS = new Set(["statement_block", "block"]);
const EXIT_CALL = /^(?:process\.exit|sys\.exit|os\._exit|exit|quit)\s*\(/;
/** An exit code that reports success: no argument, 0, a `*SUCCESS` constant or `os.EX_OK`. */
const isSuccessCode = (code: string) => code === "" || code === "0" || code === "os.EX_OK" || code.endsWith("SUCCESS");

/**
 * The lane of a call site, from its ancestors up to the enclosing function: a catch / except, or a branch that
 * throws, raises or exits with a failure code, is the error lane; a branch that ends in return or a successful
 * exit is the alternative lane.
 */
export function laneAt(root: TreeNode, line: string, site: CallSite): SiteLane {
  let child = siteNode(root, line, site);
  let thrown = false;
  for (let parent = child.parent; parent && !SCOPES.has(child.type); child = parent, parent = parent.parent) {
    if (THROWS.has(child.type)) thrown = true;
    if (CATCHES.has(child.type)) return { lane: "error", ...conditionOf(clauseHead(child.text)) };
    const branch = branchOf(child, parent);
    const lane = branch && (thrown ? "error" : branchExit(branch.body));
    if (branch && lane) return { lane, ...conditionOf(branch.condition) };
  }
  return { lane: thrown ? "error" : "main" };
}

/** The AST node at a call site: the called name on its line, else the line's first token. */
export function siteNode(root: TreeNode, line: string, site: CallSite): TreeNode {
  // Whole word only: `e` must not match inside `values`.
  let named = line.indexOf(site.name);
  while (named >= 0 && (isWordChar(line[named - 1]) || isWordChar(line[named + site.name.length]))) named = line.indexOf(site.name, named + 1);
  const column = named >= 0 ? named : line.length - line.trimStart().length;
  return root.descendantForPosition({ row: site.row, column }) ?? root;
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\w$]/.test(char);

/** The if / elif / else branch `child` is, with its condition text. */
function branchOf(child: TreeNode, parent: TreeNode): { body: TreeNode; condition: string } | null {
  // Python `for` / `while` / `try` take an else clause too: only an if's else is a branch.
  if (parent.type === "else_clause") return parent.parent?.type === "if_statement" ? { body: child, condition: "else" } : null;
  if (parent.type !== "if_statement" && parent.type !== "elif_clause") return null;
  if (parent.childForFieldName("consequence")?.id !== child.id) return null;
  return { body: child, condition: parent.childForFieldName("condition")?.text ?? "" };
}

function branchExit(body: TreeNode): FlowLane | null {
  const statements = BLOCKS.has(body.type) ? body.namedChildren.filter((node) => node !== null && node.type !== "comment") : [body];
  if (statements.some((node) => THROWS.has(node.type))) return "error";
  // A successful exit ends the flow like a return; any other exit code is a failure.
  const exit = statements.map(exitCode).find((code) => code !== undefined);
  if (exit !== undefined) return isSuccessCode(exit) ? "alternative" : "error";
  return statements.at(-1)?.type === "return_statement" ? "alternative" : null;
}

/** The argument text of an exit call statement (`process.exit(1);` gives "1"), or undefined for any other statement. */
function exitCode(node: TreeNode): string | undefined {
  if (node.type !== "expression_statement") return undefined;
  const text = node.text.trim();
  const call = text.endsWith(";") ? text.slice(0, -1).trimEnd() : text;
  const head = EXIT_CALL.exec(call);
  return head && call.endsWith(")") ? call.slice(head[0].length, -1).trim() : undefined;
}

/** `catch (error)` of `catch (error) {…}`, `except OSError` of `except OSError:`. */
export function clauseHead(text: string): string {
  const head = text.split(/[{\n]/)[0].trimEnd();
  return head.endsWith(":") ? head.slice(0, -1) : head;
}

function conditionOf(text: string): { condition?: string } {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  const bare = flat.startsWith("(") && flat.endsWith(")") ? flat.slice(1, -1).trim() : flat;
  return bare && bare.length <= MAX_CONDITION ? { condition: bare } : {};
}

interface ModelContext {
  root: FlowSymbol;
  maxSteps: number;
  lanes: FlowModel["lanes"];
  lines: Map<string, string[]>;
  siteLanes: Map<CallSite, SiteLane>;
  rootDir: string;
}

function toModel(walk: Walk, context: ModelContext): FlowModel {
  const { visits } = walk;
  const siteLane = (site: CallSite): SiteLane => context.siteLanes.get(site) ?? { lane: "main" };
  const laneOf = visitLanes(walk, siteLane);
  const ids = stepIds(walk, context.rootDir);
  // Steps were opened nearest first; drawn in call order (depth-first order of their call keys).
  const order = walk.steps.map((_, step) => step).toSorted((left, right) => compareKeys(visits[walk.steps[left]].key, visits[walk.steps[right]].key));
  const position = new Map(order.map((step, index) => [step, index]));
  const nodes = order.map((step): FlowNode => {
    const { symbol } = visits[walk.steps[step]];
    const subtitle = docSubtitle(context.lines.get(symbol.path) ?? [], symbol.startLine, symbol.lang);
    return {
      id: ids[step],
      title: symbol.name,
      ...(subtitle ? { subtitle } : {}),
      file: relativeTo(context.rootDir, symbol.path),
      line: symbol.startLine + 1,
      lane: laneOf[walk.steps[step]],
      symbolCount: visits.filter((visit) => visit.step === step).length,
    };
  });
  const rank = (step: number) => position.get(step) ?? 0;
  const callLane = (call: PlacedCall) => widest(laneOf[call.caller], siteLane(call.site).lane);
  const edges = walk.edges.toSorted((left, right) => rank(left.from) - rank(right.from) || rank(left.to) - rank(right.to)).map((edge): FlowEdge => {
    // The most direct call between the two steps, the first met on a tie: the edge's lane agrees with the node's.
    const calls = walk.calls.filter((call) => visits[call.caller].step === edge.from && visits[call.callee].step === edge.to);
    const call = calls.reduce((best, next) => (LANE_RANK[callLane(next)] < LANE_RANK[callLane(best)] ? next : best), calls[0]);
    const { condition } = siteLane(call.site);
    return {
      from: ids[edge.from],
      to: ids[edge.to],
      file: relativeTo(context.rootDir, call.site.file),
      line: call.site.row + 1,
      relation: call.relation,
      lane: callLane(call),
      ...(condition ? { condition } : {}),
    };
  });
  return {
    entry: ids[0],
    language: context.root.lang,
    lanes: context.lanes,
    maxSteps: context.maxSteps,
    nodes,
    edges,
    omittedSteps: walk.omittedSteps,
  };
}

const LANES: readonly FlowLane[] = ["main", "alternative", "error"];

/**
 * The lane of every placed symbol: the most direct of the paths reaching it (main before alternative before
 * error), so a helper also called on the main path stays on it. A lane only goes down, so this settles in a few passes.
 */
function visitLanes(walk: Walk, siteLane: (site: CallSite) => SiteLane): FlowLane[] {
  const rank = walk.visits.map((_, index) => (index === 0 ? 0 : LANES.length));
  for (let changed = true; changed; ) {
    changed = false;
    for (const call of walk.calls) {
      const lane = Math.max(rank[call.caller], LANE_RANK[siteLane(call.site).lane]);
      if (lane < rank[call.callee]) {
        rank[call.callee] = lane;
        changed = true;
      }
    }
  }
  return rank.map((value) => LANES[value]);
}

function compareKeys(left: number[], right: number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

const widest = (left: FlowLane, right: FlowLane): FlowLane => (LANE_RANK[right] > LANE_RANK[left] ? right : left);

function stepIds(walk: Walk, rootDir: string): string[] {
  const bases = walk.steps.map((entry) => {
    const { symbol } = walk.visits[entry];
    return `${relativeTo(rootDir, symbol.path)}#${symbol.name}`;
  });
  return bases.map((base, step) => {
    const homonym = bases.indexOf(base) !== bases.lastIndexOf(base);
    return homonym ? `${base}@${walk.visits[walk.steps[step]].symbol.startLine + 1}` : base;
  });
}

/** First sentence of the doc comment above a declaration (`/** *\/`, `///`, `//`, `#`), or of a Python docstring. */
export function docSubtitle(lines: string[], startLine: number, lang: string): string | undefined {
  const text = lang === "python" ? pythonDocstring(lines, startLine) : commentAbove(lines, startLine);
  if (!text) return undefined;
  const prose = text.split("\n").map((line) => line.trim()).filter((line) => !line.startsWith("@")).join(" ").replaceAll(/\s+/g, " ").trim();
  const end = prose.search(/[.!?](?:\s|$)/);
  const sentence = end >= 0 ? prose.slice(0, end + 1) : prose;
  if (!sentence) return undefined;
  return sentence.length > MAX_SUBTITLE ? `${sentence.slice(0, MAX_SUBTITLE - 1)}…` : sentence;
}

function commentAbove(lines: string[], startLine: number): string | undefined {
  let end = startLine - 1;
  while (end >= 0 && /^\s*(?:@|#\[)/.test(lines[end])) end--;
  if (end < 0) return undefined;
  if (lines[end].trim().endsWith("*/")) {
    let start = end;
    while (start > 0 && !lines[start].includes("/*")) start--;
    const block = lines.slice(start, end + 1).join("\n");
    if (!block.includes("/*")) return undefined;
    return block.slice(block.indexOf("/*") + 2, block.lastIndexOf("*/")).replace(/^\*+/, "").replaceAll(/^[ \t]*\*/gm, "");
  }
  const marker = /^\s*(?:\/\/\/?|#)\s?/;
  let start = end;
  while (start >= 0 && marker.test(lines[start])) start--;
  if (start === end) return undefined;
  return lines.slice(start + 1, end + 1).map((line) => line.replace(marker, "")).join("\n");
}

function pythonDocstring(lines: string[], startLine: number): string | undefined {
  let header = startLine;
  while (header < lines.length && header < startLine + 10 && !lines[header].trimEnd().endsWith(":")) header++;
  const body = lines.slice(header + 1, header + 40).join("\n").trimStart();
  const quote = /^[rRuU]?("""|''')/.exec(body);
  if (!quote) return undefined;
  const rest = body.slice(quote[0].length);
  const close = rest.indexOf(quote[1]);
  return close >= 0 ? rest.slice(0, close) : undefined;
}

export const relativeTo = (rootDir: string, file: string) => normalizePath(path.relative(rootDir, file));
