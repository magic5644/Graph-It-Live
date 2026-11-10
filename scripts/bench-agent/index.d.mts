import type { BenchTask, CorpusPin, Hypotheses, Report } from './harness.mjs';
import type { ArmSpec } from './live.mjs';

export interface Options {
  mode: 'print-pack' | 'score' | 'client';
  answers: string | null;
  client: string | null;
  dryRun: boolean;
  pack: string;
  tasks: string[] | null;
  arms: string[];
  out: string;
}

/** A corpus of the selected tasks after its key check: tree hash, git repository and its tasks. */
export interface CheckedCorpus extends CorpusPin { name: string; tree: string | null; gitDir: string; tasks: BenchTask[] }

export const DATA_DIR: string;
export const PACKS: Record<string, string>;
export function repositoryName(corpus: { repository: string }): string;
export const AGENT_FILES: string[];
export const ARMS: Record<string, ArmSpec>;
export function parseOptions(argv: string[]): Options;
export function loadDataset(dataDir?: string, selected?: string[] | null): { hypotheses: Hypotheses; allTasks: BenchTask[]; tasks: BenchTask[] };
export function buildPrompt(task: BenchTask, hypotheses: Hypotheses): string;
export function renderPack(input: { tasks: BenchTask[]; hypotheses: Hypotheses; arms: string[]; corpora: CheckedCorpus[]; repoRoot?: string }): string;
export function scoreAnswers(input: {
  answersFile: string;
  allTasks: BenchTask[];
  tasks: BenchTask[];
  hypotheses: Hypotheses;
  arms: string[];
  corpora: CheckedCorpus[];
  repoRoot: string;
  out: string;
  now?: Date;
}): { report: Report; markdown: string };
export function main(argv: string[], options?: { repoRoot?: string; dataDir?: string; stdout?: { write(text: string): unknown }; env?: NodeJS.ProcessEnv }): Promise<string>;
