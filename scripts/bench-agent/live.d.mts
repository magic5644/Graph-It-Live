import type { BenchTask, RecordedRun } from './harness.mjs';

export interface ArmSpec { setup: string; mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }
export interface ArmSetup { worktree: string; serverNames: string[]; [key: string]: unknown }

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
export function armMcpConfig(armSpec: ArmSpec, worktree: string): { mcpServers: ArmSpec['mcpServers'] };
export function withArmCopies<T>(
  input: { arms: string[]; armSpecs: Record<string, ArmSpec>; agentFiles: string[]; commit: string; repoRoot: string; env: Record<string, string>; configure: (arm: string, worktree: string) => Record<string, unknown> },
  run: (prepared: { setup: Record<string, ArmSetup>; indexState: 'warm' | 'none'; coldIndexMs: number | null }) => Promise<T>,
): Promise<T>;
export function runAllCells(
  tasks: BenchTask[],
  arms: string[],
  runCell: (cell: { task: BenchTask; arm: string; repetition: number }) => Promise<{ record: RecordedRun; stopBench: string | null | undefined }>,
): Promise<{ runs: RecordedRun[]; reruns: number; stopReason: string | null }>;
export function renderDryRunPage(input: {
  client: string;
  intro: string[];
  tasks: BenchTask[];
  arms: string[];
  armSpecs: Record<string, ArmSpec>;
  buildPrompt: (task: BenchTask) => string;
  config: (arm: string) => { lang: string; text: string };
  command: (arm: string) => string[];
}): string;
