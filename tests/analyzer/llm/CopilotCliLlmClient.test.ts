/// <reference types="node" />

/**
 * Unit tests for CopilotCliLlmClient.
 *
 * The CLI itself is never invoked for real: availability is probed with
 * /bin/echo, and the parsing helpers are tested against captured output.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCopilotPrompt,
  cleanCopilotOutput,
  CopilotCliLlmClient,
} from '../../../src/analyzer/llm/CopilotCliLlmClient';

describe('cleanCopilotOutput', () => {
  it('strips the session trailer and code fences, keeping the answer', () => {
    const raw = [
      '```json',
      '["call graph", "indexer"]',
      '```',
      '',
      'Changes    +0 -0',
      'AI Credits 2.47 (5s)',
      'Tokens     ↑ 20.7k • ↓ 310',
      'Resume     copilot --resume=b0102fdc',
    ].join('\n');

    expect(cleanCopilotOutput(raw)).toBe('["call graph", "indexer"]');
  });

  it('leaves plain output untouched apart from trimming', () => {
    expect(cleanCopilotOutput('  hello world \n')).toBe('hello world');
  });

  it('does not strip answer lines that merely mention a trailer word', () => {
    // "Tokens" only starts a trailer line; inside a sentence it must survive.
    expect(cleanCopilotOutput('The Tokens are counted here.')).toBe(
      'The Tokens are counted here.',
    );
  });
});

describe('buildCopilotPrompt', () => {
  it('flattens messages, tagging non-user roles', () => {
    const prompt = buildCopilotPrompt([
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'Question: how does X work' },
    ]);

    expect(prompt).toBe('[system] Return JSON only.\n\nQuestion: how does X work');
  });

  it('returns an empty string for no messages', () => {
    expect(buildCopilotPrompt([])).toBe('');
  });
});

describe('CopilotCliLlmClient.isAvailable', () => {
  it('is true when the configured binary runs', async () => {
    const client = new CopilotCliLlmClient('/bin/echo');
    expect(await client.isAvailable()).toBe(true);
  });

  it('is false when the binary is missing', async () => {
    const client = new CopilotCliLlmClient('/nonexistent/graph-it-copilot');
    expect(await client.isAvailable()).toBe(false);
  });

  it('exposes the copilot-cli provider name', () => {
    expect(new CopilotCliLlmClient('/bin/echo').providerName).toBe('copilot-cli');
  });
});

describe('CopilotCliLlmClient.complete', () => {
  it('returns the cleaned stdout of the binary', async () => {
    // /bin/echo prints its arguments back, so stdout is the flattened prompt.
    const client = new CopilotCliLlmClient('/bin/echo');
    const result = await client.complete([{ role: 'user', content: '["a","b"]' }]);

    expect(result.text).toContain('["a","b"]');
    expect(result.tokensUsed).toBeUndefined();
  });

  it('rejects when the binary cannot be spawned', async () => {
    const client = new CopilotCliLlmClient('/nonexistent/graph-it-copilot');
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });
});
