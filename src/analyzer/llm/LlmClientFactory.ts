/**
 * LlmClientFactory — resolves the best available LlmClient per-request.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Resolution order:
 *   1. options.override (if provided)
 *   2. AnthropicLlmClient if ANTHROPIC_API_KEY is set and isAvailable() = true
 *   3. OpenAiCompatibleLlmClient if OPENAI_API_KEY is set and isAvailable() = true
 *   4. null (fallback heuristic mode)
 *
 * Logs a WARN once per session when fallback is triggered.
 */

import { getLogger } from '@/shared/logger';
import { AnthropicLlmClient } from './AnthropicLlmClient';
import type { LlmClient } from './LlmClient';
import { OpenAiCompatibleLlmClient } from './OpenAiCompatibleLlmClient';

const logger = getLogger('LlmClientFactory');

// Module-level flag — log fallback warning only once per session
let _fallbackWarned = false;

export interface LlmClientFactoryOptions {
  override?: LlmClient;
}

/**
 * Resolves the best available LlmClient.
 * Called per-query (lazy, not at startup).
 * Returns null when no LLM is available → heuristic keyword extraction is used.
 */
export async function resolveLlmClient(
  options?: LlmClientFactoryOptions,
): Promise<LlmClient | null> {
  // 1. Explicit override
  if (options?.override) {
    return options.override;
  }

  // 2. Anthropic
  try {
    const anthropic = new AnthropicLlmClient();
    if (await anthropic.isAvailable()) {
      return anthropic;
    }
  } catch {
    // Network or config error — fall through
  }

  // 3. OpenAI-compatible
  try {
    const openai = new OpenAiCompatibleLlmClient();
    if (await openai.isAvailable()) {
      return openai;
    }
  } catch {
    // Network or config error — fall through
  }

  // 4. No LLM available
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    logger.warn(
      'No LLM provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY). ' +
      'Falling back to heuristic keyword extraction.',
    );
  }

  return null;
}

/**
 * Reset the fallback-warned flag (for testing only).
 * @internal
 */
export function _resetFallbackWarned(): void {
  _fallbackWarned = false;
}
