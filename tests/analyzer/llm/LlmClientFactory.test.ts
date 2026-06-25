/// <reference types="node" />

/**
 * Unit tests for LlmClientFactory.resolveLlmClient.
 *
 * Tests env-based resolution without network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetFallbackWarned, resolveLlmClient } from '../../../src/analyzer/llm/LlmClientFactory';
import type { LlmClient, LlmCompletionOptions, LlmCompletionResult, LlmMessage } from '../../../src/analyzer/llm/LlmClient';

// ---------------------------------------------------------------------------
// Mock LlmClient for override test
// ---------------------------------------------------------------------------

class MockOverrideLlmClient implements LlmClient {
  readonly providerName = 'vscode-lm' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async complete(
    _messages: LlmMessage[],
    _options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    return { text: 'mock' };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLlmClient', () => {
  // Save original env values
  let originalAnthropicKey: string | undefined;
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    // Clear keys before each test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Reset the module-level flag so warnings can fire again
    _resetFallbackWarned();
  });

  afterEach(() => {
    // Restore original env
    if (originalAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalOpenAiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('returns AnthropicLlmClient when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const client = await resolveLlmClient();
    expect(client).not.toBeNull();
    expect(client?.providerName).toBe('anthropic');
  });

  it('returns OpenAiCompatibleLlmClient when OPENAI_API_KEY is set', async () => {
    // No ANTHROPIC_API_KEY, only OPENAI
    process.env.OPENAI_API_KEY = 'sk-openai-test-key';
    const client = await resolveLlmClient();
    expect(client).not.toBeNull();
    expect(client?.providerName).toBe('openai-compatible');
  });

  it('returns null when no keys are set', async () => {
    const client = await resolveLlmClient();
    expect(client).toBeNull();
  });

  it('returns override when provided, ignoring env', async () => {
    // Even with no env keys, override should be returned
    const override = new MockOverrideLlmClient();
    const client = await resolveLlmClient({ override });
    expect(client).toBe(override);
    expect(client?.providerName).toBe('vscode-lm');
  });

  it('prefers ANTHROPIC_API_KEY over OPENAI_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.OPENAI_API_KEY = 'sk-openai-test-key';
    const client = await resolveLlmClient();
    expect(client?.providerName).toBe('anthropic');
  });
});
