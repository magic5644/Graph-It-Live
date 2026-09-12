/**
 * LlmClientFactory — resolves the best available LlmClient per-request.
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Resolution order:
 *   1. options.override (if provided)
 *   2. GRAPH_IT_LLM_PROVIDER, when set, pins the provider (no auto-detection)
 *   3. AnthropicLlmClient if ANTHROPIC_API_KEY is set and isAvailable() = true
 *   4. OpenAiCompatibleLlmClient if OPENAI_API_KEY is set and isAvailable() = true
 *   5. null (fallback heuristic mode)
 *
 * copilot-cli is never auto-detected: it spends the user's Copilot premium
 * request credits, so it must be requested explicitly.
 *
 * Logs a WARN once per session when fallback is triggered.
 */

import { getLogger } from '@/shared/logger';
import type { LlmProviderName } from '@/shared/query-types';
import { AnthropicLlmClient } from './AnthropicLlmClient';
import { CopilotCliLlmClient } from './CopilotCliLlmClient';
import type { LlmClient } from './LlmClient';
import { OpenAiCompatibleLlmClient } from './OpenAiCompatibleLlmClient';

const logger = getLogger('LlmClientFactory');

// Module-level flag — log fallback warning only once per session
let _fallbackWarned = false;

/** Providers that can be pinned through GRAPH_IT_LLM_PROVIDER. */
const SELECTABLE_PROVIDERS = new Set<LlmProviderName>([
  'anthropic',
  'openai-compatible',
  'copilot-cli',
]);

export interface LlmClientFactoryOptions {
  override?: LlmClient;
}

function instantiate(provider: LlmProviderName): LlmClient | null {
  switch (provider) {
    case 'anthropic':
      return new AnthropicLlmClient();
    case 'openai-compatible':
      return new OpenAiCompatibleLlmClient();
    case 'copilot-cli':
      return new CopilotCliLlmClient();
    default:
      return null;
  }
}

/** Read and validate GRAPH_IT_LLM_PROVIDER. Returns null when unset or unknown. */
function readPinnedProvider(): LlmProviderName | null {
  const raw = process.env.GRAPH_IT_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  // Accept the friendly alias "openai" for the OpenAI-compatible client.
  const normalized = raw === 'openai' ? 'openai-compatible' : raw;
  if (SELECTABLE_PROVIDERS.has(normalized as LlmProviderName)) {
    return normalized as LlmProviderName;
  }
  logger.warn(
    `Unknown GRAPH_IT_LLM_PROVIDER="${raw}". ` +
    `Expected one of: ${[...SELECTABLE_PROVIDERS].join(', ')}. Ignoring.`,
  );
  return null;
}

async function tryClient(client: LlmClient | null): Promise<LlmClient | null> {
  if (client === null) {
    return null;
  }
  try {
    return (await client.isAvailable()) ? client : null;
  } catch {
    // Network or config error — treat as unavailable
    return null;
  }
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

  // 2. Pinned provider — no fallback to the other providers when it fails,
  //    so a typo in the endpoint surfaces instead of being silently replaced.
  const pinned = readPinnedProvider();
  if (pinned !== null) {
    const client = await tryClient(instantiate(pinned));
    if (client !== null) {
      return client;
    }
    logger.warn(
      `GRAPH_IT_LLM_PROVIDER="${pinned}" is not usable ` +
      '(missing credentials, or `copilot` not on PATH). Falling back to heuristic extraction.',
    );
    return null;
  }

  // 3. Anthropic
  const anthropic = await tryClient(instantiate('anthropic'));
  if (anthropic !== null) {
    return anthropic;
  }

  // 4. OpenAI-compatible
  const openai = await tryClient(instantiate('openai-compatible'));
  if (openai !== null) {
    return openai;
  }

  // 5. No LLM available
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    logger.warn(
      'No LLM provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / GRAPH_IT_LLM_PROVIDER). ' +
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
