import type { BenchTask, Hypotheses, Report } from './harness.mjs';

export interface Options {
  mode: 'print-pack' | 'score';
  answers: string | null;
  tasks: string[] | null;
  arms: string[];
  out: string;
}

export const DATA_DIR: string;
export const AGENT_FILES: string[];
export const ARMS: Record<string, { setup: string; mcpServers: Record<string, unknown> }>;
export function parseOptions(argv: string[]): Options;
export function loadDataset(dataDir?: string, selected?: string[] | null): { hypotheses: Hypotheses; allTasks: BenchTask[]; tasks: BenchTask[] };
export function buildPrompt(task: BenchTask, hypotheses: Hypotheses): string;
export function renderPack(input: { tasks: BenchTask[]; hypotheses: Hypotheses; arms: string[]; corpusHash: string | null }): string;
export function scoreAnswers(input: {
  answersFile: string;
  allTasks: BenchTask[];
  tasks: BenchTask[];
  hypotheses: Hypotheses;
  arms: string[];
  corpusHash: string | null;
  repoRoot: string;
  out: string;
  now?: Date;
}): { report: Report; markdown: string };
export function main(argv: string[], options?: { repoRoot?: string; dataDir?: string; stdout?: { write(text: string): unknown } }): string;
