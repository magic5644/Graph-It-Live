/**
 * The sequence model of one entry symbol (#798): its calls depth-first in call order, one message each, between
 * lifelines (files, or classes), with the alt / opt / loop / catch fragments each call sits in, read from the call
 * site's AST (TypeScript/JavaScript and Python). It is the data every sequence surface draws; drawing is theirs.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import fs from "node:fs/promises";
import type { Database, Statement } from "sql.js";
import type { Node as TreeNode } from "web-tree-sitter";
import type { SupportedLang } from "@/shared/callgraph-types";
import {
  CALLEES_SQL,
  CATCHES,
  clauseHead,
  findEntry,
  LANE_LANGUAGES,
  readSource,
  relativeTo,
  SCOPES,
  siteNode,
  type CallSite,
  type FlowModelSources,
  type FlowSymbol,
} from "./flowModel";

export const DEFAULT_SEQUENCE_DEPTH = 3;
export const DEFAULT_SEQUENCE_MESSAGES = 30;
export const MAX_SEQUENCE_MESSAGES = 60;
export const MAX_SEQUENCE_PARTICIPANTS = 12;

export type SequenceParticipants = "file" | "class";
export type SequenceFragmentKind = "alt" | "opt" | "loop" | "catch";

export interface SequenceParticipant {
  /** Workspace-relative file (`src/a.ts`), or file and class (`src/a.ts#Cart`). */
  id: string;
  title: string;
  kind: "file" | "class";
  file: string;
  /** 1-based declaration line of the class; a file lifeline has none. */
  line?: number;
}

export interface SequenceMessage {
  /** `m1`, `m2`… in call order. */
  id: string;
  /** Participant ids: the caller's lifeline and the callee's (the same one for a self-message). */
  from: string;
  to: string;
  /** Called symbol: its name, workspace-relative file and 1-based declaration line. */
  name: string;
  targetFile: string;
  targetLine: number;
  /** Call site: workspace-relative file and 1-based line. */
  file: string;
  line: number;
  relation: "CALLS" | "REFERENCES";
  /** Call depth: 1 for the entry's own calls. */
  level: number;
  /** Id of the message whose callee makes this call; absent for the entry's own calls. */
  parent?: string;
  await?: true;
  /** The callee was expanded by an earlier message: drawn without its sub-calls. */
  repeat?: true;
  /** The callee is already on the call stack: drawn, not expanded. */
  recursive?: true;
  /** Text drawn on the message, from an annotated spec (#798 b); else built from the name. */
  label?: string;
}

export interface SequenceOperand {
  /** The condition, `else`, the case, the loop head or the catch clause. */
  guard: string;
  /** Ids of the first and last message the operand holds (its callees' messages included). */
  first: string;
  last: string;
}

export interface SequenceFragment {
  /** Workspace-relative file, 1-based line and column of the construct (`src/a.ts:12:5`). */
  id: string;
  kind: SequenceFragmentKind;
  operands: SequenceOperand[];
}

export interface SequenceModel {
  /** Symbol id of the entry: workspace-relative file and name (`src/a.ts#run`). */
  entry: string;
  /** Lifeline of the entry, the first participant. */
  entryParticipant: string;
  language: string;
  /** "unsupported": fragments are not read for this language, so messages come in call order only. */
  fragmentDetection: "detected" | "unsupported";
  participantsBy: SequenceParticipants;
  depth: number;
  maxMessages: number;
  /** Lifelines in order of first appearance, the entry's first. */
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  /** By first message, an enclosing fragment before the ones it holds. */
  fragments: SequenceFragment[];
  /** Calls left out: past `depth`, past `maxMessages`, or into a lifeline past the 12-lifeline cap. */
  omitted: { depth: number; messages: number; participants: number };
  /** Header lines from an annotated spec (#798 b); else built from the entry. */
  caption?: { title: string; caption: string };
}

export interface SequenceModelRequest {
  /** Absolute path of the entry symbol's file. */
  filePath: string;
  symbolName: string;
  /** Declaration line, 1-based (the editor line): selects one of several homonyms. */
  startLine?: number;
  depth?: number;
  maxMessages?: number;
  participants?: SequenceParticipants;
}

/** Same-symbol lookup the walk uses to place a callee on a lifeline. */
const OWNER_SQL = `SELECT n.type, n.owner, c.name, c.start_line FROM nodes n
  LEFT JOIN nodes c ON c.path = n.path AND c.type = 'class' AND c.id <> n.id AND c.start_line <= n.start_line AND c.end_line >= n.end_line
  WHERE n.id = ? ORDER BY c.start_line DESC LIMIT 1`;

interface Call {
  callee: FlowSymbol;
  site: CallSite;
  relation: SequenceMessage["relation"];
}

/** One drawn call, before its fragments are read. */
interface Placed extends Call {
  from: string;
  to: string;
  callerLang: SupportedLang;
  level: number;
  parent?: number;
  repeat?: true;
  recursive?: true;
}

interface WalkState {
  statement: Statement;
  owners: Statement;
  depth: number;
  maxMessages: number;
  participantsBy: SequenceParticipants;
  rootDir: string;
  participants: Map<string, SequenceParticipant>;
  lifelineOf: Map<string, SequenceParticipant>;
  messages: Placed[];
  expanded: Set<string>;
  stack: Set<string>;
  /** Calls of each callee the depth bound kept from expanding; dropped if a shallower call expands it later. */
  cutByDepth: Map<string, number>;
  omitted: SequenceModel["omitted"];
}

/** The sequence model of `request`'s symbol; an unknown file or symbol, or an ambiguous one, is an error naming candidates. */
export async function buildSequenceModel(db: Database, request: SequenceModelRequest, sources: FlowModelSources): Promise<SequenceModel> {
  const root = findEntry(db, request, sources.rootDir);
  const depth = request.depth ?? DEFAULT_SEQUENCE_DEPTH;
  const maxMessages = request.maxMessages ?? DEFAULT_SEQUENCE_MESSAGES;
  const participantsBy = request.participants ?? "file";
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`depth must be an integer of at least 1, got ${depth}.`);
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_SEQUENCE_MESSAGES) {
    throw new Error(`maxMessages must be an integer from 1 to ${MAX_SEQUENCE_MESSAGES}, got ${maxMessages}.`);
  }
  if (participantsBy !== "file" && participantsBy !== "class") throw new Error(`participants must be "file" or "class", got "${String(participantsBy)}".`);
  const state: WalkState = {
    statement: db.prepare(CALLEES_SQL),
    owners: db.prepare(OWNER_SQL),
    depth,
    maxMessages,
    participantsBy,
    rootDir: sources.rootDir,
    participants: new Map(),
    lifelineOf: new Map(),
    messages: [],
    expanded: new Set([root.id]),
    stack: new Set([root.id]),
    cutByDepth: new Map(),
    omitted: { depth: 0, messages: 0, participants: 0 },
  };
  let entryParticipant: SequenceParticipant;
  try {
    entryParticipant = lifeline(state, root);
    state.participants.set(entryParticipant.id, entryParticipant);
    walk(state, root, 1, undefined);
    state.omitted.depth = [...state.cutByDepth.values()].reduce((sum, count) => sum + count, 0);
  } finally {
    state.statement.free();
    state.owners.free();
  }
  const fragmentDetection = LANE_LANGUAGES.has(root.lang) ? "detected" : "unsupported";
  const frames = fragmentDetection === "detected" ? await readFrames(state.messages, sources) : new Map<CallSite, SiteFrames>();
  return toModel(state, { root, entryParticipant, fragmentDetection, frames });
}

/** The callees of `caller` in call-line order. */
function calleesOf(state: WalkState, caller: FlowSymbol): Call[] {
  const calls: Call[] = [];
  state.statement.bind([caller.id]);
  while (state.statement.step()) {
    const [targetId, name, file, startLine, lang, sourceLine, relation] = state.statement.get();
    calls.push({
      callee: { id: String(targetId), name: String(name), path: String(file), startLine: Number(startLine), lang: String(lang) as SupportedLang },
      site: { file: caller.path, row: Number(sourceLine), name: String(name) },
      relation: relation as SequenceMessage["relation"],
    });
  }
  state.statement.reset();
  return calls;
}

/**
 * Draws the calls of `caller` depth-first: each callee is expanded under its first call only, a callee on the call
 * stack is a recursive message, never expanded. Past a bound, the calls left out are counted, never walked.
 */
function walk(state: WalkState, caller: FlowSymbol, level: number, parent: number | undefined): void {
  const from = lifeline(state, caller).id;
  for (const call of calleesOf(state, caller)) {
    const to = admit(state, call);
    if (!to) continue;
    const id = call.callee.id;
    const recursive = state.stack.has(id);
    const repeat = !recursive && state.expanded.has(id);
    const index = state.messages.length;
    state.messages.push({ ...call, from, to: to.id, callerLang: caller.lang, level, parent, ...(recursive ? { recursive } : {}), ...(repeat ? { repeat } : {}) });
    if (recursive || repeat) continue;
    if (level >= state.depth) {
      state.cutByDepth.set(id, calleesOf(state, call.callee).length);
      continue;
    }
    state.cutByDepth.delete(id);
    state.expanded.add(id);
    state.stack.add(id);
    walk(state, call.callee, level + 1, index);
    state.stack.delete(id);
  }
}

/** The callee's lifeline, or undefined for a call the message or lifeline cap leaves out (counted). */
function admit(state: WalkState, call: Call): SequenceParticipant | undefined {
  if (state.messages.length >= state.maxMessages) {
    state.omitted.messages++;
    return undefined;
  }
  const to = lifeline(state, call.callee);
  if (state.participants.has(to.id)) return to;
  if (state.participants.size >= MAX_SEQUENCE_PARTICIPANTS) {
    state.omitted.participants++;
    return undefined;
  }
  state.participants.set(to.id, to);
  return to;
}

/** The lifeline of a symbol: its file, or with participants "class" the class a method belongs to. */
function lifeline(state: WalkState, symbol: FlowSymbol): SequenceParticipant {
  const known = state.lifelineOf.get(symbol.id);
  if (known) return known;
  const file = relativeTo(state.rootDir, symbol.path);
  let participant: SequenceParticipant = { id: file, title: file.split("/").at(-1) ?? file, kind: "file", file };
  if (state.participantsBy === "class") {
    state.owners.bind([symbol.id]);
    const row = state.owners.step() ? state.owners.get() : [];
    state.owners.reset();
    const [type, owner, className, classLine] = row;
    // TS/JS, Python, Java, C#: the class around the method; Go and Rust methods sit outside it and keep its name in owner.
    const name = className ? String(className) : String(owner ?? "").split(",")[0].split(".").at(-1);
    if (type === "method" && name) {
      participant = { id: `${file}#${name}`, title: name, kind: "class", file, ...(className ? { line: Number(classLine) + 1 } : {}) };
    }
  }
  state.lifelineOf.set(symbol.id, participant);
  return participant;
}

/** One fragment operand a call site sits in, innermost last once reversed. */
interface Frame {
  /** The construct's AST position, unique in its file. */
  key: string;
  kind: SequenceFragmentKind;
  /** Orders the operands of one fragment. */
  operand: number;
  guard: string;
  file: string;
  row: number;
  column: number;
}

interface SiteFrames {
  frames: Frame[];
  awaited: boolean;
}

const MAX_GUARD = 60;
const LOOPS = new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]);
const COMPREHENSIONS = new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]);
const CALL_NODES = new Set(["call_expression", "call", "new_expression"]);
const ANONYMOUS = new Set(["arrow_function", "function_expression", "function", "lambda"]);
const ITERATORS = new Set(["map", "flatMap", "forEach", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast", "findLastIndex"]);

/** The frames and await of every drawn call site, each caller file parsed once. */
async function readFrames(messages: Placed[], { extractor, rootDir, readFile }: FlowModelSources): Promise<Map<CallSite, SiteFrames>> {
  const read = readFile ?? ((file: string) => fs.readFile(file, "utf8"));
  const byFile = new Map<string, Placed[]>();
  for (const message of messages) byFile.set(message.site.file, [...(byFile.get(message.site.file) ?? []), message]);
  const frames = new Map<CallSite, SiteFrames>();
  // shortcut: a caller file in a language without fragment detection (a Rust file a Python entry calls) gets no
  // frames of its own; it still inherits its caller's. Upgrade when such mixes need fragments.
  const files = [...byFile].filter(([, placed]) => LANE_LANGUAGES.has(placed[0].callerLang));
  await Promise.all(files.map(async ([file, placed]) => {
    const source = await readSource(read, file, rootDir);
    const lines = source.split("\n");
    const tree = await extractor.parseTree(file, placed[0].callerLang, source);
    if (!tree) throw new Error(`${relativeTo(rootDir, file)} could not be parsed to read its call sites' fragments.`);
    try {
      for (const { site } of placed) frames.set(site, framesAt(tree.rootNode, lines[site.row] ?? "", site, relativeTo(rootDir, file)));
    } finally {
      tree.delete();
    }
  }));
  return frames;
}

/**
 * The fragments a call site sits in, outermost first, from its ancestors up to the enclosing declaration: an if /
 * elif / else, ternary or switch / match branch (alt, or opt for an if with no else), a loop body or an iterator
 * callback (loop), a catch / except clause (catch). An anonymous callback is crossed, as its calls are its declaration's.
 */
export function framesAt(root: TreeNode, line: string, site: CallSite, file: string): SiteFrames {
  const start = siteNode(root, line, site);
  let call: TreeNode | null = start;
  while (call && !CALL_NODES.has(call.type)) call = call.parent;
  let wrapper = call?.parent;
  while (wrapper?.type === "parenthesized_expression") wrapper = wrapper.parent;
  const awaited = wrapper?.type === "await_expression" || wrapper?.type === "await";
  const frames: Frame[] = [];
  let child = start;
  for (let parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (SCOPES.has(child.type) && !(ANONYMOUS.has(child.type) && isArgument(child))) break;
    const frame = frameOf(child, parent);
    if (frame) frames.push({ ...frame, file, row: frame.at.startPosition.row, column: frame.at.startPosition.column, key: `${frame.at.type}:${frame.at.startIndex}:${frame.at.endIndex}` });
  }
  return { frames: frames.toReversed(), awaited };
}

const isArgument = (node: TreeNode) => node.parent?.type === "arguments" || node.parent?.type === "argument_list";

type FrameHit = Pick<Frame, "kind" | "operand" | "guard"> & { at: TreeNode };

/** The fragment operand `child` opens in `parent`, if any. */
function frameOf(child: TreeNode, parent: TreeNode): FrameHit | null {
  if (CATCHES.has(child.type)) return { kind: "catch", operand: 0, guard: guardOf(clauseHead(child.text)), at: child };
  if (ANONYMOUS.has(child.type) && isArgument(child)) return iteratorFrame(child);
  if (COMPREHENSIONS.has(parent.type) && child.type !== "for_in_clause" && parent.namedChildren[0]?.id === child.id) {
    const clause = parent.namedChildren.find((node) => node?.type === "for_in_clause");
    return { kind: "loop", operand: 0, guard: guardOf(clause?.text ?? "for"), at: parent };
  }
  if (LOOPS.has(parent.type) && parent.childForFieldName("body")?.id === child.id) {
    const condition = parent.childForFieldName("condition")?.text ?? "";
    return { kind: "loop", operand: 0, guard: guardOf(parent.type === "do_statement" ? `while ${condition}` : clauseHead(parent.text)), at: parent };
  }
  return branchFrame(child, parent);
}

/** `xs.map(x => f(x))`: a loop over the callback; any other callback opens no fragment. */
function iteratorFrame(callback: TreeNode): FrameHit | null {
  const call = callback.parent?.parent;
  const callee = call?.childForFieldName("function");
  const method = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
  const python = callee?.type === "identifier" && (method === "map" || method === "filter");
  if (!call || !method || !(ITERATORS.has(method) && callee?.type === "member_expression") && !python) return null;
  return { kind: "loop", operand: 0, guard: python ? method : `.${method}`, at: call };
}

/** An if / elif / else, ternary or case branch `child` is, as an operand of the construct. */
function branchFrame(child: TreeNode, parent: TreeNode): FrameHit | null {
  if (parent.type === "if_statement" && parent.childForFieldName("consequence")?.id === child.id) {
    const kind = parent.childForFieldName("alternative") ? "alt" : "opt";
    return { kind, operand: child.startIndex, guard: guardOf(parent.childForFieldName("condition")?.text ?? ""), at: parent };
  }
  if ((parent.type === "else_clause" || parent.type === "elif_clause") && parent.parent?.type === "if_statement") {
    const guard = parent.type === "else_clause" ? "else" : guardOf(parent.childForFieldName("condition")?.text ?? "");
    // An elif's own condition runs whenever the if's is false: only its body is the operand.
    if (parent.type === "elif_clause" && parent.childForFieldName("consequence")?.id !== child.id) return null;
    return { kind: "alt", operand: parent.startIndex, guard, at: parent.parent };
  }
  if (parent.type === "ternary_expression" || parent.type === "conditional_expression") return ternaryFrame(child, parent);
  if (parent.type === "switch_case" || parent.type === "switch_default" || parent.type === "case_clause") return caseFrame(child, parent);
  return null;
}

/** `c ? a() : b()` (TS/JS) or `a() if c else b()` (Python): an alt of the two outcomes; the condition runs either way. */
function ternaryFrame(child: TreeNode, parent: TreeNode): FrameHit | null {
  const python = parent.type === "conditional_expression";
  const [first, condition, second] = python ? parent.namedChildren : [parent.childForFieldName("consequence"), parent.childForFieldName("condition"), parent.childForFieldName("alternative")];
  const guard = guardOf(condition?.text ?? "");
  if (first?.id === child.id) return { kind: "alt", operand: 0, guard, at: parent };
  if (second?.id === child.id) return { kind: "alt", operand: 1, guard: "else", at: parent };
  return null;
}

/** A switch case (TS/JS) or match case (Python) body: an operand of the switch's alt. */
function caseFrame(child: TreeNode, parent: TreeNode): FrameHit | null {
  const value = parent.childForFieldName("value");
  if (value?.id === child.id) return null;
  // A Python case's pattern and guard run before the case is chosen: only its body is the operand.
  if (parent.type === "case_clause" && parent.childForFieldName("consequence")?.id !== child.id) return null;
  const construct = parent.parent?.parent;
  if (!construct) return null;
  const head = value ? `case ${value.text}` : clauseHead(parent.text);
  const guard = parent.type === "switch_default" ? "default" : guardOf(head);
  return { kind: "alt", operand: parent.startIndex, guard, at: construct };
}

function guardOf(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  const bare = flat.startsWith("(") && flat.endsWith(")") ? flat.slice(1, -1).trim() : flat;
  return bare.length > MAX_GUARD ? `${bare.slice(0, MAX_GUARD - 1)}…` : bare;
}

interface ModelContext {
  root: FlowSymbol;
  entryParticipant: SequenceParticipant;
  fragmentDetection: SequenceModel["fragmentDetection"];
  frames: Map<CallSite, SiteFrames>;
}

function toModel(state: WalkState, context: ModelContext): SequenceModel {
  const { rootDir } = state;
  const id = (index: number) => `m${index + 1}`;
  // A call inherits the fragments of the call that reached its caller: it only runs when that one does.
  const inherited: Frame[][] = [];
  const messages = state.messages.map((placed, index): SequenceMessage => {
    const site = context.frames.get(placed.site);
    inherited.push([...(placed.parent === undefined ? [] : inherited[placed.parent]), ...(site?.frames ?? [])]);
    return {
      id: id(index),
      from: placed.from,
      to: placed.to,
      name: placed.callee.name,
      targetFile: relativeTo(rootDir, placed.callee.path),
      targetLine: placed.callee.startLine + 1,
      file: relativeTo(rootDir, placed.site.file),
      line: placed.site.row + 1,
      relation: placed.relation,
      level: placed.level,
      ...(placed.parent === undefined ? {} : { parent: id(placed.parent) }),
      // A reference sits inside the call it is passed to: that call's await is not its own.
      ...(site?.awaited && placed.relation === "CALLS" ? { await: true as const } : {}),
      ...(placed.repeat ? { repeat: true as const } : {}),
      ...(placed.recursive ? { recursive: true as const } : {}),
    };
  });
  return {
    entry: `${relativeTo(rootDir, context.root.path)}#${context.root.name}`,
    entryParticipant: context.entryParticipant.id,
    language: context.root.lang,
    fragmentDetection: context.fragmentDetection,
    participantsBy: state.participantsBy,
    depth: state.depth,
    maxMessages: state.maxMessages,
    participants: [...state.participants.values()],
    messages,
    fragments: fragmentsOf(inherited, id),
    omitted: state.omitted,
  };
}

/** Groups the frames of every message into fragments; one construct's messages are consecutive in a depth-first walk. */
function fragmentsOf(frames: Frame[][], id: (index: number) => string): SequenceFragment[] {
  const found = new Map<string, { frame: Frame; first: number; nesting: number; operands: Map<number, SequenceOperand & { order: number }> }>();
  frames.forEach((list, index) => list.forEach((frame, nesting) => {
    const key = `${frame.file}:${frame.key}`;
    const fragment = found.get(key) ?? { frame, first: index, nesting, operands: new Map() };
    found.set(key, fragment);
    const operand = fragment.operands.get(frame.operand);
    if (operand) operand.last = id(index);
    else fragment.operands.set(frame.operand, { guard: frame.guard, first: id(index), last: id(index), order: frame.operand });
  }));
  return [...found.values()]
    .toSorted((left, right) => left.first - right.first || left.nesting - right.nesting)
    .map(({ frame, operands }) => ({
      id: `${frame.file}:${frame.row + 1}:${frame.column + 1}`,
      kind: frame.kind,
      operands: [...operands.values()].toSorted((left, right) => left.order - right.order).map(({ guard, first, last }) => ({ guard, first, last })),
    }));
}
