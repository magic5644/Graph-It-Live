/**
 * CopilotCliLlmClient — uses the local GitHub Copilot CLI as an LLM provider.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Relies on the user's existing Copilot subscription instead of an API key:
 * no ANTHROPIC_API_KEY / OPENAI_API_KEY needed, just `copilot` on PATH and a
 * signed-in session (`copilot` then `/login`).
 *
 * Opt-in only: each call consumes Copilot premium request credits, so this
 * provider is never auto-detected — set GRAPH_IT_LLM_PROVIDER=copilot-cli.
 *
 * Note: GitHub Models (models.github.ai) was retired on 2026-07-30, so a plain
 * GITHUB_TOKEN is no longer a usable inference credential. For a hosted
 * OpenAI-compatible endpoint (Azure AI Foundry, OpenAI, Ollama, LM Studio…),
 * use OpenAiCompatibleLlmClient via OPENAI_BASE_URL instead.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LlmClient, LlmCompletionOptions, LlmCompletionResult, LlmMessage } from './LlmClient';

const execFileAsync = promisify(execFile);

const DEFAULT_BINARY = 'copilot';
/** Copilot CLI carries a large system prompt; keyword extraction still takes seconds. */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Trailing session report the CLI appends after the answer, e.g.
 *   Changes    +0 -0
 *   AI Credits 2.47 (5s)
 *   Tokens     ↑ 20.7k • ↓ 310
 *   Resume     copilot --resume=<id>
 */
const TRAILER_LINE = /^\s*(Changes|AI Credits|Tokens|Resume|Total duration)\b/;

/** Strip the CLI session trailer and surrounding markdown code fences. */
export function cleanCopilotOutput(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (TRAILER_LINE.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept
    .join('\n')
    .replaceAll(/^\s*```[a-zA-Z]*\s*$/gm, '')
    .trim();
}

/** Flatten chat messages into the single prompt the CLI accepts. */
export function buildCopilotPrompt(messages: LlmMessage[]): string {
  return messages
    .map(m => (m.role === 'user' ? m.content : `[${m.role}] ${m.content}`))
    .join('\n\n')
    .trim();
}

export class CopilotCliLlmClient implements LlmClient {
  readonly providerName = 'copilot-cli' as const;

  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(binary?: string, timeoutMs?: number) {
    this.binary = binary ?? process.env.GRAPH_IT_COPILOT_BIN ?? DEFAULT_BINARY;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.binary, ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async complete(
    messages: LlmMessage[],
    _options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const prompt = buildCopilotPrompt(messages);

    // `--available-tools` with no value disables every tool: the CLI only answers.
    const { stdout } = await execFileAsync(
      this.binary,
      ['-p', prompt, '--available-tools', '--no-color'],
      { timeout: this.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
    );

    // Token usage is only printed in the human-readable trailer, not machine-readable.
    return { text: cleanCopilotOutput(stdout) };
  }
}
