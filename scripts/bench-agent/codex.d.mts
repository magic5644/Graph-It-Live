import type { BenchTask, RecordedRun, RunMetrics, RunStatus } from './harness.mjs';
import type { ArmSpec } from './live.mjs';

export interface CodexParserState {
  serverNames: string[];
  started: boolean;
  toolCalls: number;
  toolTrace: string[];
  turns: number;
  usage: { input: number; cached: number; cacheWrite: number; output: number } | null;
  lastMessage: string | null;
  errors: string[];
  failed: boolean;
  stop: { status: RunStatus; error: string } | null;
}

export const CODEX_MODEL: string;
export const CODEX_EFFORT: string;
export const RUN_TIMEOUT_MS: number;
export const CODEX_AGENT_FILES: string[];
export const DISABLED_FEATURES: string[];
export function codexEnv(env: NodeJS.ProcessEnv, codexHome: string, home: string): Record<string, string>;
export function verifyCodexLogin(login: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error }): { ok: true; route: string } | { ok: false; reason: string };
export function codexConfig(armSpec: ArmSpec, worktree: string): string;
export function codexArgs(worktree: string): string[];
export function createCodexParser(serverNames: string[]): { onLine: (line: string) => boolean; state: CodexParserState };
export function codexMetrics(state: CodexParserState, latencyMs: number): Required<RunMetrics>;
export function finishCodexRun(
  state: CodexParserState,
  outcome: { code: number | null; timedOut: boolean; stderr: string },
  latencyMs: number,
): { status: RunStatus; error?: string; response?: string; metrics: Required<RunMetrics>; toolTrace: string[]; stopBench: string | null };
export function renderCodexDryRun(input: { tasks: BenchTask[]; arms: string[]; armSpecs: Record<string, ArmSpec>; buildPrompt: (task: BenchTask) => string; removedEnv: string[] }): string;
export function runCodexBench(input: {
  tasks: BenchTask[];
  arms: string[];
  armSpecs: Record<string, ArmSpec>;
  agentFiles: string[];
  buildPrompt: (task: BenchTask) => string;
  commit: string;
  /** Harness checkout (built dist/). */
  repoRoot: string;
  /** Git repository holding the corpus commit; default repoRoot. */
  corpusGit?: string;
  /** Name of the corpus copy directory; default Graph-It-Live. */
  dirName?: string;
  /** Reruns left for this call; default MAX_RERUNS. */
  rerunBudget?: number;
  env?: NodeJS.ProcessEnv;
  log?: (text: string) => void;
}): Promise<{ runs: RecordedRun[]; meta: Record<string, unknown> }>;
