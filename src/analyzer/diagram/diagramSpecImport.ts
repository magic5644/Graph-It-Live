/**
 * Re-import of an annotated diagram spec (#794): `graph-it diagram --spec <file>` and the `spec` parameter of
 * export_architecture_diagram. The spec names what it draws (a flow's entry symbol, an architecture level); the
 * caller rebuilds that spec from the current index, and `annotateSpec` compares the two field by field. Only the
 * texts an agent may rewrite (titles, subtitles, labels, caption title and caption) are taken from the file;
 * any other difference is refused with its JSON path, so Graph-It-Live stays the source of truth for nodes and edges.
 * The rebuilt spec follows schemas/diagram-spec.schema.json, so matching it validates the file against the schema.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { closestNames, closestPathsHint } from "../utils/SymbolLookup";
import { fitLabel, sanitizeText } from "./architectureDiagram";
import { DIAGRAM_SPEC_VERSION } from "./diagramSpec";
import { MAX_FLOW_STEPS, MAX_SEQUENCE_MESSAGES, SIZES } from "./diagramStyle";
import { FLOW_LABEL_CHARS, FLOW_SUBTITLE_CHARS } from "./flowDiagram";
import type { FlowModelRequest } from "./flowModel";
import { SEQUENCE_GUARD_CHARS, SEQUENCE_LABEL_CHARS, SEQUENCE_TITLE_CHARS } from "./sequenceDiagram";
import type { SequenceModelRequest } from "./sequenceModel";

/** A spec file larger than this is refused unread: an architecture spec of thousands of units stays far below. */
export const MAX_SPEC_BYTES = 8 * 1024 * 1024;
/** Most cells kept of an annotated title or caption line: the canvas widens to fit it. */
const CAPTION_CHARS = 96;

export type SpecKind = "flow" | "sequence" | "architecture";
type Json = Record<string, unknown>;

/** A spec read from disk: its kind and its JSON object, not yet compared with the index. */
export interface LoadedSpec {
  kind: SpecKind;
  /** The file as the user spelled it, for the messages. */
  file: string;
  /** Its resolved path in the workspace: an output there would replace it. */
  absolute: string;
  data: Json;
}

/** The editable texts of each kind, as paths with `[]` for any index, and the most cells drawn of each. */
const EDITABLE: Record<SpecKind, Record<string, number>> = {
  flow: {
    "nodes[].title": SIZES.maxLabelChars,
    "nodes[].subtitle": FLOW_SUBTITLE_CHARS,
    "edges[].label": FLOW_LABEL_CHARS,
    "caption.title": CAPTION_CHARS,
    "caption.caption": CAPTION_CHARS,
  },
  sequence: {
    "participants[].title": SEQUENCE_TITLE_CHARS,
    "messages[].label": SEQUENCE_LABEL_CHARS,
    "fragments[].operands[].guard": SEQUENCE_GUARD_CHARS,
    "caption.title": CAPTION_CHARS,
    "caption.caption": CAPTION_CHARS,
  },
  architecture: { "nodes[].label": SIZES.maxLabelChars, "caption.title": CAPTION_CHARS, "caption.caption": CAPTION_CHARS },
};
/** Optional texts: removing one draws none. */
const OPTIONAL = new Set(["nodes[].subtitle"]);
/** Not compared: the day of the index (a rescan changes it, the revision does not). */
const IGNORED: Record<SpecKind, ReadonlySet<string>> = { flow: new Set(), sequence: new Set(), architecture: new Set(["date"]) };
const EDITABLE_WORDS: Record<SpecKind, string> = {
  flow: "node title and subtitle, edge label, caption title and caption",
  sequence: "lifeline title, message label, operand guard, caption title and caption",
  architecture: "node label, caption title and caption",
};

/** A value in a message, cut to 80 characters: a huge field never floods the error line. */
const show = (value: unknown) => (value === undefined ? "absent" : fitLabel(String(JSON.stringify(value)), 80));
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const pattern = (at: string) => at.replaceAll(/\[\d+\]/g, "[]");

/** Reads and parses a spec file of the workspace; outside it, the message says so (exit 5 on the CLI). */
export async function readDiagramSpec(rootDir: string, file: string): Promise<LoadedSpec> {
  let absolute: string;
  try {
    // `\` accepted on every OS, as a diagram directory is.
    absolute = validateWorkspacePath(path.resolve(rootDir, file.replaceAll("\\", "/")), rootDir);
  } catch {
    throw new Error(`Spec file outside workspace: ${file}. Pass a file of the workspace.`);
  }
  const stats = await fs.stat(absolute).catch(() => undefined);
  if (!stats?.isFile()) throw new Error(`Spec file not found: ${file}.${closestPathsHint(absolute, rootDir)}`);
  if (stats.size > MAX_SPEC_BYTES) throw new Error(`Spec file ${file} is ${stats.size} bytes; a diagram spec is at most ${MAX_SPEC_BYTES}.`);
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}): export it again in format diagram-spec.`, { cause: error });
  }
  return { kind: specKind(data, file), file, absolute, data: data as Json };
}

function specKind(data: unknown, file: string): SpecKind {
  if (!isObject(data)) throw new Error(`${file} is not a diagram spec: expected a JSON object in format diagram-spec.`);
  if (data.version !== DIAGRAM_SPEC_VERSION) {
    throw new Error(`${file}: version ${show(data.version)} is not supported; this graph-it reads diagram-spec version ${DIAGRAM_SPEC_VERSION}.`);
  }
  if (data.kind === "flow" || data.kind === "sequence") return data.kind;
  if (data.kind === undefined) return "architecture";
  throw new Error(`${file}: kind ${show(data.kind)} is not a diagram-spec kind; expected "flow", "sequence", or no kind for an architecture level.`);
}

function schemaError(spec: LoadedSpec, at: string, expected: string): never {
  throw new Error(`${spec.file}: ${at} must be ${expected} (schemas/diagram-spec.schema.json).`);
}

/** The architecture level a spec draws: every unit, or the groups of one unit or folder. */
export function specLevel(spec: LoadedSpec): { view: "units" } | { view: "folder"; folder: string } {
  const { level, scope } = spec.data;
  if (level === "units" && scope === "units") return { view: "units" };
  if (level !== "groups" && level !== "units") schemaError(spec, "level", `"units" or "groups", not ${show(level)}`);
  if (level === "units") schemaError(spec, "scope", `"units" for level "units", not ${show(scope)}`);
  if (typeof scope !== "string" || scope === "") schemaError(spec, "scope", "the unit or folder key whose groups are drawn");
  return { view: "folder", folder: scope };
}

/** `src/a.ts#run@12` → file and symbol name, the homonym's `@line` dropped; no regex, so no backtracking on a long id. */
function splitStepId(id: string): [string, string] {
  const hash = id.lastIndexOf("#");
  const name = id.slice(hash + 1);
  const at = name.lastIndexOf("@");
  const isLine = at > 0 && /^\d+$/.test(name.slice(at + 1));
  return [hash > 0 ? id.slice(0, hash) : "", isLine ? name.slice(0, at) : name];
}

/**
 * The entry symbol and step cap a flow spec draws: its entry id (`file#symbol`, `@line` for a homonym among the
 * steps), the entry step's line, which also tells apart a homonym of the file outside the flow, and maxSteps.
 */
export function specFlowRequest(spec: LoadedSpec, rootDir: string): FlowModelRequest {
  const { entry, maxSteps, nodes } = spec.data;
  const [file, symbolName] = typeof entry === "string" ? splitStepId(entry) : [];
  if (!file || !symbolName) schemaError(spec, "entry", `the entry step's id, file#symbol, not ${show(entry)}`);
  if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_FLOW_STEPS) {
    schemaError(spec, "maxSteps", `an integer from 1 to ${MAX_FLOW_STEPS}, not ${show(maxSteps)}`);
  }
  const line = Array.isArray(nodes) ? (nodes.find((node) => isObject(node) && node.id === entry) as Json | undefined)?.line : undefined;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error(`${spec.file}: nodes must hold the entry step ${entry} with its 1-based line (schemas/diagram-spec.schema.json).`);
  }
  return { filePath: entryFile(spec, rootDir, file), symbolName, startLine: line, maxSteps };
}

/** The entry's file, resolved in the workspace and refused outside it. */
function entryFile(spec: LoadedSpec, rootDir: string, file: string): string {
  try {
    return validateWorkspacePath(path.resolve(rootDir, file), rootDir);
  } catch {
    throw new Error(`${spec.file}: entry ${String(spec.data.entry)} names a file outside workspace.`);
  }
}

const isCount = (value: unknown, max = Infinity): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

/**
 * The entry symbol and bounds a sequence spec draws: its entry (`file#symbol`), entryLine, which tells apart a
 * homonym, depth, maxMessages and participantsBy.
 */
export function specSequenceRequest(spec: LoadedSpec, rootDir: string): SequenceModelRequest {
  const { entry, entryLine, depth, maxMessages, participantsBy } = spec.data;
  // A sequence entry has no `@line` (entryLine holds it): the name is all after the last "#".
  const hash = typeof entry === "string" ? entry.lastIndexOf("#") : -1;
  const [file, symbolName] = hash > 0 ? [(entry as string).slice(0, hash), (entry as string).slice(hash + 1)] : [];
  if (!file || !symbolName) schemaError(spec, "entry", `the entry symbol, file#symbol, not ${show(entry)}`);
  if (!isCount(entryLine)) schemaError(spec, "entryLine", `the entry's 1-based declaration line, not ${show(entryLine)}`);
  if (!isCount(depth)) schemaError(spec, "depth", `an integer of at least 1, not ${show(depth)}`);
  if (!isCount(maxMessages, MAX_SEQUENCE_MESSAGES)) schemaError(spec, "maxMessages", `an integer from 1 to ${MAX_SEQUENCE_MESSAGES}, not ${show(maxMessages)}`);
  if (participantsBy !== "file" && participantsBy !== "class") schemaError(spec, "participantsBy", `"file" or "class", not ${show(participantsBy)}`);
  return { filePath: entryFile(spec, rootDir, file), symbolName, startLine: entryLine, depth, maxMessages, participants: participantsBy };
}

/** The lists whose items a spec may not add, remove or rename, and the field naming an item of each. */
const ID_LISTS: Record<SpecKind, readonly { list: string; field: string }[]> = {
  flow: [{ list: "nodes", field: "id" }, { list: "edges", field: "from/to" }],
  sequence: [{ list: "participants", field: "id" }, { list: "messages", field: "id" }],
  architecture: [{ list: "nodes", field: "key" }, { list: "edges", field: "from/to" }],
};
const ITEM_WORDS: Record<SpecKind, string> = { flow: "nodes and edges", sequence: "lifelines and messages", architecture: "nodes and edges" };
const firstFive = (items: readonly string[]) => items.slice(0, 5).join(", ") + (items.length > 5 ? ", …" : "");

/** Id of an item in the messages: its id or key field, or an edge's ends. */
function itemId(field: string, item: Json): string | undefined {
  if (field === "from/to") return typeof item.from === "string" && typeof item.to === "string" ? `${item.from} -> ${item.to}` : undefined;
  const id = item[field];
  return typeof id === "string" ? id : undefined;
}

/** Refuses an unknown, added or removed item, by id, before any field-by-field difference. */
function compareIds(spec: LoadedSpec, list: string, field: string, rebuilt: Json[]) {
  const given = spec.data[list];
  if (!Array.isArray(given)) schemaError(spec, list, "an array");
  const known = rebuilt.map((item) => itemId(field, item)!);
  const knownIds = new Set(known);
  const seen = new Set<string>();
  given.forEach((item: unknown, index) => {
    if (!isObject(item)) schemaError(spec, `${list}[${index}]`, "an object");
    const id = itemId(field, item);
    if (id === undefined) schemaError(spec, `${list}[${index}].${field}`, "a string");
    if (!knownIds.has(id)) {
      const near = closestNames(known, id);
      const candidates = near.length > 0 ? ` Closest: ${near.join(", ")}.` : ` Known: ${firstFive(known)}.`;
      throw new Error(`${spec.file}: ${list}[${index}] ${id} is not in the current index; ${ITEM_WORDS[spec.kind]} cannot be added or renamed.${candidates}`);
    }
    if (seen.has(id)) throw new Error(`${spec.file}: ${list}[${index}] ${id} is listed twice.`);
    seen.add(id);
  });
  const missing = known.find((id) => !seen.has(id));
  if (missing !== undefined) {
    throw new Error(`${spec.file}: ${list} lacks ${missing}, which the current index has; ${ITEM_WORDS[spec.kind]} cannot be removed. ${staleHint(spec.kind)}`);
  }
}

const staleHint = (kind: SpecKind) =>
  `Only the ${EDITABLE_WORDS[kind]} may change; if the code changed since the export, export the spec again in format diagram-spec.`;

interface Walk {
  spec: LoadedSpec;
  cut: string[];
}

/** The text drawn for an edited field: sanitized, cut to the cells the drawing holds (`cut` records it). */
function editedText(walk: Walk, at: string, value: unknown, rebuilt: unknown): string | undefined {
  const key = pattern(at);
  if (value === undefined && OPTIONAL.has(key)) return undefined;
  if (typeof value !== "string" || value.trim() === "") schemaError(walk.spec, at, "a non-empty string");
  if (value === rebuilt) return value;
  const clean = sanitizeText(value);
  const drawn = fitLabel(clean, EDITABLE[walk.spec.kind][key]);
  if (drawn !== clean) walk.cut.push(at);
  return drawn;
}

/** `given` compared with `rebuilt` at `at`: the rebuilt value with the edited texts of `given`, or a one-line error. */
function merge(walk: Walk, at: string, given: unknown, rebuilt: unknown): unknown {
  const { spec } = walk;
  if (EDITABLE[spec.kind][pattern(at)] !== undefined) return editedText(walk, at, given, rebuilt);
  if (Array.isArray(rebuilt)) return mergeArray(walk, at, given, rebuilt);
  if (isObject(rebuilt)) return mergeObject(walk, at, given, rebuilt);
  if (given !== rebuilt) {
    throw new Error(`${spec.file}: ${at} is ${show(given)} in the spec, ${show(rebuilt)} in the current index. ${staleHint(spec.kind)}`);
  }
  return rebuilt;
}

function mergeArray(walk: Walk, at: string, given: unknown, rebuilt: unknown[]): unknown[] {
  if (!Array.isArray(given)) schemaError(walk.spec, at, "an array");
  if (given.length !== rebuilt.length) {
    throw new Error(`${walk.spec.file}: ${at} has ${given.length} entries in the spec, ${rebuilt.length} in the current index. ${staleHint(walk.spec.kind)}`);
  }
  return rebuilt.map((item, index) => merge(walk, `${at}[${index}]`, given[index], item));
}

function mergeObject(walk: Walk, at: string, given: unknown, rebuilt: Json): Json {
  const { spec } = walk;
  if (!isObject(given)) schemaError(spec, at, at === "" ? "a JSON object" : "an object");
  const child = (key: string) => (at === "" ? key : `${at}.${key}`);
  const optional = (key: string) => OPTIONAL.has(pattern(child(key)));
  const ignored = (key: string) => IGNORED[spec.kind].has(child(key));
  const unknownKey = Object.keys(given).find((key) => !Object.hasOwn(rebuilt, key) && !ignored(key) && !optional(key));
  if (unknownKey !== undefined) throw new Error(`${spec.file}: ${child(unknownKey)} is not a field of a ${spec.kind} diagram spec.`);
  const merged: Json = {};
  for (const key of new Set([...Object.keys(rebuilt), ...Object.keys(given).filter(optional)])) {
    const value = ignored(key) ? rebuilt[key] : merge(walk, child(key), given[key], rebuilt[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * The rebuilt spec with the annotated texts of `spec`, and the paths of the annotated texts cut to fit their box.
 * An architecture spec of another index revision is stale; any other difference names its JSON path.
 */
export function annotateSpec<T extends object>(spec: LoadedSpec, rebuilt: T): { spec: T; cut: string[] } {
  const fresh = rebuilt as Json;
  if (spec.kind === "architecture" && spec.data.revision !== fresh.revision) {
    throw new Error(
      `${spec.file} is stale or drawn with other rules: it was exported at revision ${show(spec.data.revision)}, this level is at ${show(fresh.revision)}. ` +
        "Pass the rules, config and baseline of its export, or export the spec again in format diagram-spec and redo its annotations.",
    );
  }
  for (const { list, field } of ID_LISTS[spec.kind]) compareIds(spec, list, field, fresh[list] as Json[]);
  const walk: Walk = { spec, cut: [] };
  return { spec: merge(walk, "", spec.data, fresh) as T, cut: walk.cut };
}

/** One sentence naming the annotated texts cut to fit, or "" when none was. */
export function cutNote(cut: readonly string[]): string {
  if (cut.length === 0) return "";
  const more = cut.length > 5 ? ` and ${cut.length - 5} more` : "";
  return ` Cut to fit their box (ends with "…"): ${cut.slice(0, 5).join(", ")}${more}.`;
}
