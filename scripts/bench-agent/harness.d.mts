/** A class name of the hypotheses (v1: known-file, localization, callers-impact, multi-file-contract). */
export type TaskClass = string;
export type FieldType = 'string' | 'string[]' | 'path' | 'path[]' | 'number' | 'boolean';
export type RunStatus = 'completed' | 'failed' | 'timeout' | 'rate-limited' | 'incomplete';
export type Verdict = 'confirmed' | 'not confirmed' | 'refuted';

export interface BenchTask {
  id: string;
  class: TaskClass;
  /** v2: name of the task's corpus in Hypotheses.corpora. */
  corpus?: string;
  prompt: string;
  answerShape: Record<string, FieldType>;
  key: Record<string, unknown>;
  evidence: { path: string; symbols?: string[] }[];
}

export interface ClassSpec {
  tasks: number;
  hypothesis: string;
  negativeControl?: boolean;
  minCorrectnessDelta?: number;
  minRecallDelta?: number;
  minCorrectnessGain?: number;
  minReduction?: number;
  reductionMetrics?: ('toolCalls' | 'providerTokens')[];
  maxExtraToolCallsPerTask?: number;
  maxTokenIncrease?: number;
}

export interface CorpusPin { repository: string; commit: string; tag: string }

export interface Hypotheses {
  version: number;
  /** v1: the single corpus (this repository). */
  corpus?: CorpusPin;
  /** v2: corpora by name (`self` is this repository, others are keys of scripts/bench-corpora.json). */
  corpora?: Record<string, CorpusPin>;
  classes: Record<string, ClassSpec>;
  limits?: string[];
}

export type RunMetrics = Partial<Record<'toolCalls' | 'turns' | 'latencyMs' | 'inputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'outputTokens' | 'notionalCostUsd', number | null>>;
export type RetrievalMetrics = Partial<Record<'cl100kTokens' | 'jsonChars' | 'toonChars', number | null>>;

export interface RecordedRun {
  taskId: string;
  arm: string;
  repetition?: number;
  status?: RunStatus;
  prompt?: string | null;
  response?: string | null;
  error?: string | null;
  metrics?: RunMetrics;
  retrieval?: RetrievalMetrics;
  toolTrace?: string[] | null;
}

export interface FieldScore { score: number; precision?: number; recall?: number }
export interface Scoring { score: number; recall: number | null; malformed: boolean; error?: string; fields: Record<string, FieldScore> }

export interface Cell {
  taskId: string;
  class: TaskClass;
  arm: string;
  runs: number;
  completed: number;
  statuses: RunStatus[];
  correctness: number | null;
  recall: number | null;
  metrics: Record<string, number | null>;
  providerTokens: number | null;
  retrieval: Record<string, number | null>;
}

export interface ClassTotals { correctness: number | null; recall: number | null; toolCalls: number | null; providerTokens: number | null }

export interface ClassVerdict {
  class: string;
  client: string | undefined;
  hypothesis: string;
  verdict: Verdict;
  reason: string;
  sample: { tasks: number; runs: { native: number; graph: number }; note: string };
  totals: { native: ClassTotals; graph: ClassTotals } | null;
  reductions: Record<string, number | null> | null;
}

export interface Report {
  meta: Record<string, unknown> & { repetitions: number };
  verdicts: ClassVerdict[];
  cells: Cell[];
  runs: (Omit<RecordedRun, 'metrics' | 'retrieval'> & { class: TaskClass; repetition: number; status: RunStatus; metrics: Record<string, number | null>; retrieval: Record<string, number | null>; toolTrace: string[] | null; scoring: Scoring | null })[];
  limits: string[];
}

export const FIELD_TYPES: FieldType[];
export const RUN_STATUSES: RunStatus[];
export const METRICS: string[];
export const RETRIEVAL_METRICS: string[];
export function isSafeRelativePath(value: unknown): boolean;
export function corpusOf(task: BenchTask, hypotheses: Hypotheses): CorpusPin & { name: string };
export function validateTasks(pack: unknown, hypotheses: unknown): string[];
export function checkAnswerKeys(tasks: BenchTask[], commit: string, repoRoot: string): { ok: boolean; errors: string[]; corpusHash: string | null };
export function parseAnswer(text: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
export function scoreAnswer(task: BenchTask, text: unknown): Scoring;
export function providerTokens(metrics: RunMetrics | undefined): number | null;
export function reduction(native: number | null | undefined, graph: number | null | undefined): number | null;
export function computeVerdicts(hypotheses: Hypotheses, cells: Cell[], client: string | undefined): ClassVerdict[];
export function sanitize<T>(text: T, home?: string): T;
export function validateRuns(runs: unknown, tasks: BenchTask[], arms: string[]): string[];
export function buildReport(input: { meta: Record<string, unknown> & { client?: string }; tasks: BenchTask[]; hypotheses: Hypotheses; arms: string[]; runs: RecordedRun[] }): Report;
export function renderMarkdown(report: Report): string;
