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
  let originalProvider: string | undefined;
  let originalCopilotBin: string | undefined;

  beforeEach(() => {
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalProvider = process.env.GRAPH_IT_LLM_PROVIDER;
    originalCopilotBin = process.env.GRAPH_IT_COPILOT_BIN;
    // Clear keys and provider pinning before each test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GRAPH_IT_LLM_PROVIDER;
    delete process.env.GRAPH_IT_COPILOT_BIN;
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
    if (originalProvider !== undefined) {
      process.env.GRAPH_IT_LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.GRAPH_IT_LLM_PROVIDER;
    }
    if (originalCopilotBin !== undefined) {
      process.env.GRAPH_IT_COPILOT_BIN = originalCopilotBin;
    } else {
      delete process.env.GRAPH_IT_COPILOT_BIN;
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

  // -------------------------------------------------------------------------
  // GRAPH_IT_LLM_PROVIDER pinning
  // -------------------------------------------------------------------------

  it('pins the provider named by GRAPH_IT_LLM_PROVIDER, ignoring preference order', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.OPENAI_API_KEY = 'sk-openai-test-key';
    process.env.GRAPH_IT_LLM_PROVIDER = 'openai-compatible';
    const client = await resolveLlmClient();
    expect(client?.providerName).toBe('openai-compatible');
  });

  it('accepts "openai" as an alias for openai-compatible', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test-key';
    process.env.GRAPH_IT_LLM_PROVIDER = 'OpenAI';
    const client = await resolveLlmClient();
    expect(client?.providerName).toBe('openai-compatible');
  });

  it('returns the Copilot CLI client when pinned and the binary responds', async () => {
    // `echo --version` exits 0, which is all isAvailable() checks.
    process.env.GRAPH_IT_COPILOT_BIN = '/bin/echo';
    process.env.GRAPH_IT_LLM_PROVIDER = 'copilot-cli';
    const client = await resolveLlmClient();
    expect(client?.providerName).toBe('copilot-cli');
  });

  it('returns null when the pinned provider is unusable, without falling back', async () => {
    // A usable Anthropic key must NOT rescue an explicitly pinned provider.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.GRAPH_IT_COPILOT_BIN = '/nonexistent/graph-it-copilot';
    process.env.GRAPH_IT_LLM_PROVIDER = 'copilot-cli';
    const client = await resolveLlmClient();
    expect(client).toBeNull();
  });

  it('ignores an unknown GRAPH_IT_LLM_PROVIDER and uses the normal order', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.GRAPH_IT_LLM_PROVIDER = 'not-a-provider';
    const client = await resolveLlmClient();
    expect(client?.providerName).toBe('anthropic');
  });

  it('still honours an explicit override over GRAPH_IT_LLM_PROVIDER', async () => {
    process.env.GRAPH_IT_LLM_PROVIDER = 'copilot-cli';
    const override = new MockOverrideLlmClient();
    expect(await resolveLlmClient({ override })).toBe(override);
  });
});
