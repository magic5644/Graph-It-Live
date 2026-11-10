import type { BenchTask, RecordedRun } from './harness.mjs';

export function childEnv(env: NodeJS.ProcessEnv): Record<string, string>;
export function removedEnvNames(env: NodeJS.ProcessEnv): string[];
export function isLimitMessage(text: unknown): boolean;
export function exportCorpus(repoRoot: string, commit: string, agentFiles: string[]): string;
export function removeCorpus(dir: string): void;
export const KILL_GRACE_MS: number;
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; input: string; timeoutMs: number; onLine: (line: string) => boolean },
): Promise<{ code: number | null; timedOut: boolean; stopped: boolean; stderr: string }>;
export const MAX_RERUNS: number;
export function planReruns(runs: RecordedRun[], tasks: BenchTask[], arms: string[], budget?: number): { taskId: string; arm: string }[];
