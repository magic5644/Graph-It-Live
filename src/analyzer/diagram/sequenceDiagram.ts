/**
 * The sequence diagram of one entry symbol (#798): its sequence model (sequenceModel.ts) on a fixed grid, one column
 * per lifeline and one row per message in call order, fragments framing their rows; diagramSvg.ts draws it. Also its
 * texts (header lines, counts, the notes on what was left out, each message's label) and its Mermaid text.
 *
 * No ELK: a sequence is a grid by nature, so the layout is deterministic by construction. Each callee is active from
 * its message to its last sub-call; a self-call nests its bar 4 px to the right of the caller's.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { fitLabel, fitName, legendHeight, textBound, textWidth, workspaceName, type Box, type DiagramText, type LegendOptions } from "./architectureDiagram";
import { MAX_SEQUENCE_MESSAGES, MAX_SEQUENCE_PARTICIPANTS, SIZES, snap, type LegendKind } from "./diagramStyle";
import type { Point } from "./flowDiagram";
import type { SequenceFragment, SequenceMessage, SequenceModel } from "./sequenceModel";

/** Most cells drawn of a message label, of a lifeline title and of a fragment's guard: longer ones end with "…". */
export const SEQUENCE_LABEL_CHARS = 28;
export const SEQUENCE_TITLE_CHARS = 24;
export const SEQUENCE_GUARD_CHARS = 40;

/** Row of a message, of a self-message (out and back), and of a fragment header or operand separator. */
const ROW = 32;
const SELF_ROW = 48;
const HEADER = 24;
/** Arrow below the top of its row; the return leg of a self-message below the arrow. */
const ARROW_Y = 20;
const SELF_DROP = 16;
const ACTIVATION = 10;
/** Shift of a nested activation bar, and how far a self-message loops right of its lifeline. */
const NEST = 4;
const SELF_LOOP = 28;
/** Space between a fragment frame and the bars it holds, and between two nested frames. */
const FRAME_PAD = 8;
const INSET = 8;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The text a message carries before any annotation: the called name, `await` and `ref` marked. */
export function defaultMessageLabel(message: SequenceMessage): string {
  const prefix = message.relation === "REFERENCES" ? "ref " : "";
  return `${prefix}${message.await ? "await " : ""}${message.name}`;
}

/** The header lines, counts and notes of a sequence; an annotated spec's caption replaces the title and caption lines. */
export function sequenceText(model: SequenceModel, workspace: string): DiagramText {
  const [file, name] = model.entry.split("#");
  const { depth, messages, participants } = model.omitted;
  const references = model.messages.filter((message) => message.relation === "REFERENCES").length;
  const lifelines = model.participantsBy === "class" ? "rerun with --participants file" : "rerun with a smaller --depth";
  const more = model.maxMessages >= MAX_SEQUENCE_MESSAGES
    ? `${MAX_SEQUENCE_MESSAGES} messages is the most a sequence draws: rerun with a smaller --depth`
    : `rerun with --maxMessages ${Math.min(MAX_SEQUENCE_MESSAGES, model.messages.length + messages)}`;
  return {
    title: model.caption?.title ?? `Sequence · ${fitName(name ?? model.entry)}`,
    caption: model.caption?.caption ?? [fitLabel(workspaceName(workspace), 48), fitName(file, 64), model.language].join(" · "),
    counts: [
      plural(model.participants.length, "lifeline"),
      plural(model.messages.length - references, "call"),
      plural(references, "reference"),
      plural(model.fragments.length, "fragment"),
    ].join(" · "),
    hidden: [
      ...(depth > 0 ? [`${plural(depth, "call")} past depth ${model.depth} left out: rerun with --depth ${model.depth + 1}`] : []),
      ...(messages > 0 ? [`at least ${plural(messages, "call")} past ${model.maxMessages} messages left out: ${more}`] : []),
      ...(participants > 0 ? [`${plural(participants, "call")} into lifelines past ${MAX_SEQUENCE_PARTICIPANTS} left out: ${lifelines}`] : []),
      ...(model.messages.some((message) => message.repeat) ? ["a callee drawn again is not expanded twice: its calls are under its first message"] : []),
      ...(model.fragmentDetection === "unsupported" ? [`fragments not read for ${model.language}: messages in call order`] : []),
    ],
    rules: undefined,
  };
}

/** The text on a fragment's tab: its keyword and guard; a catch clause names itself (`catch (error)`, `except OSError`). */
export const fragmentTitle = (fragment: SequenceFragment) =>
  fitLabel(fragment.kind === "catch" ? fragment.operands[0].guard : `${fragment.kind} [${fragment.operands[0].guard}]`, SEQUENCE_GUARD_CHARS);

export interface SequenceLifeline extends Box {
  id: string;
  /** Title and meta line (file, or file:line of a class), each cut to fit the box. */
  text: string;
  meta: string;
  /** x of the dashed lifeline, and where it ends. */
  centre: number;
  bottom: number;
  entry: boolean;
  /** Tooltip: the participant id and kind. */
  title: string;
}

export interface SequencePlacedMessage {
  /** Index in `model.messages`. */
  message: number;
  kind: LegendKind;
  points: Point[];
  /** Tooltip: `from → to: name, file:line (relation, level n)`. */
  title: string;
  label: Point & { text: string };
}

export interface SequencePlacedFragment extends Box {
  id: string;
  kind: SequenceFragment["kind"];
  /** The tab text (keyword and guard) and where it sits. */
  label: Point & { text: string };
  /** One dashed line per operand after the first, with its guard. */
  separators: { y: number; label: Point & { text: string } }[];
}

export interface SequenceLayout {
  text: DiagramText;
  width: number;
  height: number;
  top: number;
  lifelines: SequenceLifeline[];
  /** Activation bars, outer ones first, so a nested bar is drawn on top. */
  activations: (Box & { participant: string })[];
  messages: SequencePlacedMessage[];
  /** Enclosing frames first. */
  fragments: SequencePlacedFragment[];
  legend: LegendOptions;
}

/** One activation bar: the lifeline, the messages it spans (first = -1 for the entry's) and its nesting on that lifeline. */
interface Bar {
  participant: string;
  first: number;
  last: number;
  nest: number;
}

/** Index of each message's last sub-call: in a depth-first order a call's sub-calls follow it, all deeper. */
function lastDescendants(messages: readonly SequenceMessage[]): number[] {
  return messages.map((message, index) => {
    let last = index;
    while (last + 1 < messages.length && messages[last + 1].level > message.level) last++;
    return last;
  });
}

/** The entry's bar over every message, then one per call (a reference starts none), nested by the bars already open. */
function activationBars(model: SequenceModel, last: readonly number[]): { bars: Bar[]; started: (Bar | undefined)[] } {
  const bars: Bar[] = model.messages.length > 0 ? [{ participant: model.entryParticipant, first: -1, last: model.messages.length - 1, nest: 0 }] : [];
  const started = model.messages.map((message, index) => {
    if (message.relation === "REFERENCES") return undefined;
    const nest = bars.filter((bar) => bar.participant === message.to && bar.first < index && bar.last >= index).length;
    const bar = { participant: message.to, first: index, last: last[index], nest };
    bars.push(bar);
    return bar;
  });
  return { bars, started };
}

/** The bar a message leaves from: the innermost open bar of its caller's lifeline. */
const callerBar = (bars: readonly Bar[], message: SequenceMessage, index: number) =>
  bars.findLast((bar) => bar.participant === message.from && bar.first < index && bar.last >= index);

/** Rows top to bottom: fragment headers and separators before their first message, frame bottoms after their last. */
interface Rows {
  arrowY: number[];
  frames: Map<SequenceFragment, { top: number; bottom: number; separators: number[] }>;
  bottom: number;
}

function placeRows(model: SequenceModel, top: number): Rows {
  const index = new Map(model.messages.map((message, position) => [message.id, position]));
  const frames: Rows["frames"] = new Map(model.fragments.map((fragment) => [fragment, { top, bottom: top, separators: [] }]));
  const arrowY: number[] = [];
  let y = top;
  model.messages.forEach((message, position) => {
    for (const fragment of model.fragments) {
      const operand = fragment.operands.findIndex((item) => index.get(item.first) === position);
      if (operand < 0) continue;
      const frame = frames.get(fragment)!;
      if (operand === 0) frame.top = y;
      else frame.separators.push(y);
      y += HEADER;
    }
    arrowY.push(y + ARROW_Y);
    y += message.from === message.to ? SELF_ROW : ROW;
    // Inner frames close first: fragments list the enclosing ones first.
    for (const fragment of model.fragments.toReversed()) {
      if (index.get(fragment.operands.at(-1)!.last) !== position) continue;
      y += FRAME_PAD;
      frames.get(fragment)!.bottom = y;
    }
  });
  return { arrowY, frames, bottom: y };
}

/** Nesting of each fragment: how many earlier fragments span its messages. */
function fragmentNesting(model: SequenceModel): Map<SequenceFragment, number> {
  const index = new Map(model.messages.map((message, position) => [message.id, position]));
  const span = (fragment: SequenceFragment) => [index.get(fragment.operands[0].first) ?? 0, index.get(fragment.operands.at(-1)!.last) ?? 0];
  return new Map(model.fragments.map((fragment, position) => {
    const [first, last] = span(fragment);
    const nest = model.fragments.slice(0, position).filter((outer) => {
      const [from, to] = span(outer);
      return from <= first && to >= last;
    }).length;
    return [fragment, nest];
  }));
}

/** The style of a message: a reference dotted, a call inside a catch operand in the error colour. */
function messageKind(model: SequenceModel, position: number): LegendKind {
  const message = model.messages[position];
  if (message.relation === "REFERENCES") return "reference";
  const index = new Map(model.messages.map((item, at) => [item.id, at]));
  const inCatch = model.fragments.some((fragment) => fragment.kind === "catch" &&
    fragment.operands.some((operand) => (index.get(operand.first) ?? Infinity) <= position && position <= (index.get(operand.last) ?? -1)));
  return inCatch ? "catch-call" : "call";
}

const messageLabel = (message: SequenceMessage) => fitLabel(message.label ?? defaultMessageLabel(message), SEQUENCE_LABEL_CHARS);

interface Columns {
  width: number;
  centre: (participant: string) => number;
  boxes: Omit<SequenceLifeline, "x" | "y" | "centre" | "bottom">[];
}

/** One column per lifeline, all as wide as the widest box, label or self-message needs, with room for the frames. */
function placeColumns(model: SequenceModel, depth: number): Columns {
  const boxes = model.participants.map((participant) => {
    const text = fitName(participant.title, SEQUENCE_TITLE_CHARS);
    const meta = participant.line === undefined ? fitName(participant.file, SEQUENCE_TITLE_CHARS) : `${fitName(participant.file, SEQUENCE_TITLE_CHARS - 6)}:${participant.line}`;
    const widest = Math.max(textWidth(text, SIZES.label), textWidth(meta, SIZES.meta));
    return {
      id: participant.id,
      text,
      meta,
      entry: participant.id === model.entryParticipant,
      title: `${participant.id} (${participant.kind})`,
      width: snap(Math.max(SIZES.minNodeWidth, widest + 2 * SIZES.nodePaddingX)),
      height: SIZES.nodeHeight,
    };
  });
  const frames = 2 * (ACTIVATION + FRAME_PAD + INSET * depth);
  const label = Math.max(0, ...model.messages.map((message) => textWidth(messageLabel(message), SIZES.meta) + (message.from === message.to ? SELF_LOOP + 8 : 0)));
  const width = snap(Math.max(...boxes.map((box) => box.width + 24), label + frames + 16));
  const column = new Map(model.participants.map((participant, position) => [participant.id, position]));
  return { width, boxes, centre: (participant) => SIZES.margin + width * (column.get(participant) ?? 0) + width / 2 };
}

/** The x of a bar's side facing `towards`. */
const barSide = (centre: number, bar: Bar | undefined, right: boolean) => {
  if (bar === undefined) return centre;
  const middle = centre + bar.nest * NEST;
  return right ? middle + ACTIVATION / 2 : middle - ACTIVATION / 2;
};

function messagePoints(message: SequenceMessage, y: number, from: { x: number; bar?: Bar }, to: { x: number; bar?: Bar }): Point[] {
  if (message.from === message.to) {
    const out = barSide(from.x, from.bar, true);
    const loop = from.x + SELF_LOOP + (to.bar?.nest ?? 0) * NEST;
    return [{ x: out, y }, { x: loop, y }, { x: loop, y: y + SELF_DROP }, { x: barSide(to.x, to.bar, true), y: y + SELF_DROP }];
  }
  const right = to.x > from.x;
  return [{ x: barSide(from.x, from.bar, right), y }, { x: barSide(to.x, to.bar, !right), y }];
}

/** Lays the sequence of `model` out; `workspace` is named by its last folder only. */
export function layoutSequence(model: SequenceModel, workspace: string): SequenceLayout {
  const nesting = fragmentNesting(model);
  const depth = Math.max(0, ...nesting.values()) + (model.fragments.length > 0 ? 1 : 0);
  const columns = placeColumns(model, depth);
  const top = SIZES.margin + SIZES.headerHeight;
  const rows = placeRows(model, top + SIZES.nodeHeight + 16);
  const last = lastDescendants(model.messages);
  const { bars, started } = activationBars(model, last);
  const rowEnd = (position: number) => rows.arrowY[position] + (model.messages[position].from === model.messages[position].to ? SELF_DROP : 0);
  const messages = model.messages.map((message, position): SequencePlacedMessage => {
    const y = rows.arrowY[position];
    const points = messagePoints(message, y, { x: columns.centre(message.from), bar: callerBar(bars, message, position) }, { x: columns.centre(message.to), bar: started[position] });
    const self = message.from === message.to;
    const labelX = self ? points[1].x + 6 : Math.min(points[0].x, points[1].x) + 6;
    const notes = [message.repeat ? "drawn before, not expanded again" : "", message.recursive ? "recursive, not expanded" : ""].filter(Boolean);
    const detail = [message.relation, `level ${message.level}`, ...notes].join(", ");
    return {
      message: position,
      kind: messageKind(model, position),
      points,
      title: `${message.from} → ${message.to}: ${message.name}, ${message.file}:${message.line} (${detail})`,
      label: { text: messageLabel(message), x: labelX, y: self ? y - 4 : y - 6 },
    };
  });
  // The entry's bar starts above the first message; a self-call's at its return leg.
  const barTop = (bar: Bar) => {
    if (bar.first < 0) return rows.arrowY[0] - 8;
    const self = model.messages[bar.first].from === bar.participant;
    return rows.arrowY[bar.first] + (self ? SELF_DROP - 4 : 0);
  };
  const activations = bars.map((bar) => ({
    participant: bar.participant,
    x: columns.centre(bar.participant) + bar.nest * NEST - ACTIVATION / 2,
    y: barTop(bar),
    width: ACTIVATION,
    height: 0,
    end: rowEnd(bar.last) + 6,
  })).map(({ end, ...box }) => ({ ...box, height: Math.max(8, end - box.y) }));
  const fragments = placeFragments(model, rows, columns, nesting, depth);
  const bottom = rows.bottom + 16;
  const lifelines = columns.boxes.map((box) => {
    const centre = columns.centre(box.id);
    return { ...box, x: centre - box.width / 2, y: top, centre, bottom };
  });
  const text = sequenceText(model, workspace);
  const legend: LegendOptions = { kinds: ["entry", ...messages.map((message) => message.kind)], weight: false, dependency: false };
  const right = SIZES.margin + columns.width * model.participants.length;
  const widest = Math.max(
    right,
    ...fragments.map((fragment) => fragment.x + fragment.width),
    // A self-call's label on the last lifeline runs past its column.
    ...messages.map(({ label }) => label.x + textWidth(label.text, SIZES.meta)),
  );
  return {
    text,
    width: snap(SIZES.margin + Math.max(widest, SIZES.margin + textBound(text, legend))),
    height: snap(bottom + SIZES.margin + legendHeight(text)),
    top,
    lifelines,
    activations,
    messages,
    fragments,
    legend,
  };
}

/** Frames around their messages' lifelines, an enclosing one 8 px wider on each side than what it holds. */
function placeFragments(model: SequenceModel, rows: Rows, columns: Columns, nesting: Map<SequenceFragment, number>, depth: number): SequencePlacedFragment[] {
  const index = new Map(model.messages.map((message, position) => [message.id, position]));
  return model.fragments.map((fragment) => {
    const first = index.get(fragment.operands[0].first) ?? 0;
    const last = index.get(fragment.operands.at(-1)!.last) ?? first;
    const held = model.messages.slice(first, last + 1);
    const xs = held.flatMap((message) => [columns.centre(message.from), columns.centre(message.to)]);
    const loops = held.some((message) => message.from === message.to && columns.centre(message.to) === Math.max(...xs));
    const pad = ACTIVATION + FRAME_PAD + INSET * (depth - 1 - (nesting.get(fragment) ?? 0));
    const frame = rows.frames.get(fragment)!;
    const title = fragmentTitle(fragment);
    const x = Math.min(...xs) - pad;
    const width = Math.max(Math.max(...xs) + pad + (loops ? SELF_LOOP : 0) - x, textWidth(title, SIZES.meta) + 16);
    return {
      id: fragment.id,
      kind: fragment.kind,
      x,
      y: frame.top,
      width,
      height: frame.bottom - frame.top,
      label: { text: title, x: x + 6, y: frame.top + 15 },
      separators: frame.separators.map((y, operand) => ({
        y,
        label: { text: fitLabel(`[${fragment.operands[operand + 1].guard}]`, SEQUENCE_GUARD_CHARS), x: x + 6, y: y + 15 },
      })),
    };
  });
}

/**
 * Text safe in a Mermaid sequence line: no statement separator, entity, tag, comment delimiter, quote, backtick,
 * bracket or control character (`analyzer-mcp-security.md`).
 */
export function mermaidText(text: string): string {
  return fitLabel(text, 96).replaceAll(/[;#<>%&"'`[\]{}\uFFFD]/g, " ").replaceAll(/\s+/g, " ").trim() || "_";
}

const MERMAID_FRAGMENT: Record<SequenceFragment["kind"], string> = { alt: "alt", opt: "opt", loop: "loop", catch: "break" };

/**
 * The sequence as Mermaid `sequenceDiagram` text, as GitHub renders it: lifelines by alias (P1, P2…), a call as a solid
 * arrow, a reference dotted, activations from each call to its last sub-call, fragments as alt / opt / loop and a
 * catch as break; the notes on what was left out as a note over every lifeline.
 */
export function sequenceMermaid(model: SequenceModel, workspace: string): string {
  const text = sequenceText(model, workspace);
  const alias = new Map(model.participants.map((participant, position) => [participant.id, `P${position + 1}`]));
  const index = new Map(model.messages.map((message, position) => [message.id, position]));
  const last = lastDescendants(model.messages);
  const title = mermaidText(`${text.title} · ${text.counts}`);
  const lines = ["sequenceDiagram", `  title ${title}`];
  for (const participant of model.participants) lines.push(`  participant ${alias.get(participant.id)} as ${mermaidText(participant.title)}`);
  const open: string[][] = model.messages.map(() => []);
  model.messages.forEach((message, position) => {
    for (const fragment of model.fragments) {
      fragment.operands.forEach((operand, at) => {
        if (index.get(operand.first) !== position) return;
        const keyword = at === 0 ? MERMAID_FRAGMENT[fragment.kind] : "else";
        lines.push(`  ${keyword} ${mermaidText(operand.guard)}`);
      });
    }
    const arrow = message.relation === "REFERENCES" ? "-->>" : "->>";
    lines.push(`  ${alias.get(message.from)}${arrow}${alias.get(message.to)}: ${mermaidText(message.label ?? defaultMessageLabel(message))}`);
    if (message.relation === "CALLS") {
      lines.push(`  activate ${alias.get(message.to)}`);
      open[last[position]].unshift(`  deactivate ${alias.get(message.to)}`);
    }
    lines.push(...open[position]);
    for (const fragment of model.fragments.toReversed()) {
      if (index.get(fragment.operands.at(-1)!.last) === position) lines.push("  end");
    }
  });
  const everyone = model.participants.length > 1 ? `P1,P${model.participants.length}` : "P1";
  for (const note of text.hidden) lines.push(`  Note over ${everyone}: ${mermaidText(note)}`);
  return `${lines.join("\n")}\n`;
}
