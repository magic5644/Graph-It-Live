/**
 * The texts of a sequence diagram (#798): header lines, counts, the notes on what was left out, and each message's
 * label. Drawing comes with the sequence renderer.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { fitLabel, fitName, workspaceName, type DiagramText } from "./architectureDiagram";
import { MAX_SEQUENCE_MESSAGES, MAX_SEQUENCE_PARTICIPANTS, type SequenceMessage, type SequenceModel } from "./sequenceModel";

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
      ...(messages > 0 ? [`${plural(messages, "call")} past ${model.maxMessages} messages left out: ${more}`] : []),
      ...(participants > 0 ? [`${plural(participants, "call")} into lifelines past ${MAX_SEQUENCE_PARTICIPANTS} left out: ${lifelines}`] : []),
      ...(model.messages.some((message) => message.repeat) ? ["a callee drawn again is not expanded twice: its calls are under its first message"] : []),
      ...(model.fragmentDetection === "unsupported" ? [`fragments not read for ${model.language}: messages in call order`] : []),
    ],
    rules: undefined,
  };
}
