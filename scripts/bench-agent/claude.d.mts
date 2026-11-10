import type { BenchTask, RecordedRun, RunMetrics, RunStatus } from './harness.mjs';

export interface ArmSpec { setup: string; mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }
export interface ParserState { toolCalls: number; init: boolean; plugins: string[]; result: Record<string, unknown> | null; stop: { status: RunStatus; error: string } | null; stopAfter: string | null }

export const CLAUDE_MODEL: string;
export const BUILTIN_PLUGINS: string[];
export const CLAUDE_EFFORT: string;
export const RUN_TIMEOUT_MS: number;
export const ALLOWED_TOOLS: Record<string, string[]>;
export function claudeEnv(env: NodeJS.ProcessEnv): Record<string, string>;
export function verifySubscription(status: unknown): { ok: true; route: string } | { ok: false; reason: string };
export function checkClaudeRoute(env: Record<string, string>): string;
export function claudeArgs(arm: string, mcpConfigPath: string): string[];
export function createClaudeParser(serverNames: string[]): { onLine: (line: string) => boolean; state: ParserState };
export function claudeMetrics(result: Record<string, unknown> | null, toolCalls: number): Required<RunMetrics>;
export function finishRun(
  state: ParserState,
  outcome: { timedOut: boolean; stderr: string },
): { status: RunStatus; error?: string; response?: string; metrics: Required<RunMetrics>; stopBench: string | null | undefined };
export function armMcpConfig(armSpec: ArmSpec, worktree: string): { mcpServers: ArmSpec['mcpServers'] };
export function renderDryRun(input: { tasks: BenchTask[]; arms: string[]; armSpecs: Record<string, ArmSpec>; buildPrompt: (task: BenchTask) => string; removedEnv: string[] }): string;
export function runClaudeBench(input: {
  tasks: BenchTask[];
  arms: string[];
  armSpecs: Record<string, ArmSpec>;
  agentFiles: string[];
  buildPrompt: (task: BenchTask) => string;
  commit: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  log?: (text: string) => void;
}): Promise<{ runs: RecordedRun[]; meta: Record<string, unknown> }>;
