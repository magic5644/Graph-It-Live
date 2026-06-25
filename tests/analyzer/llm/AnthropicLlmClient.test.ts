/// <reference types="node" />

/**
 * Unit tests for AnthropicLlmClient.
 *
 * All network calls are mocked via vi.stubGlobal('fetch', ...) — no real HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicLlmClient } from '../../../src/analyzer/llm/AnthropicLlmClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicLlmClient', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // -------------------------------------------------------------------------
  // providerName
  // -------------------------------------------------------------------------

  it('has providerName "anthropic"', () => {
    const client = new AnthropicLlmClient('sk-key');
    expect(client.providerName).toBe('anthropic');
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  it('isAvailable() returns true when apiKey passed in constructor', async () => {
    const client = new AnthropicLlmClient('sk-ant-test-key');
    expect(await client.isAvailable()).toBe(true);
  });

  it('isAvailable() returns true when ANTHROPIC_API_KEY env is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const client = new AnthropicLlmClient();
    expect(await client.isAvailable()).toBe(true);
  });

  it('isAvailable() returns false when no key provided and env not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const client = new AnthropicLlmClient('');
    expect(await client.isAvailable()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // complete() — nominal path
  // -------------------------------------------------------------------------

  it('complete() returns parsed text and tokensUsed from Anthropic response', async () => {
    const fakeBody = {
      content: [{ type: 'text', text: 'Hello from Anthropic' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new AnthropicLlmClient('sk-ant-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('Hello from Anthropic');
    expect(result.tokensUsed).toBe(15);
  });

  it('complete() sends correct URL, headers and body structure', async () => {
    const fakeBody = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 2, output_tokens: 1 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new AnthropicLlmClient('sk-ant-key', 'claude-test-model');
    await client.complete(
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 128, temperature: 0.5 },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe('claude-test-model');
    expect(sentBody.max_tokens).toBe(128);
    expect(sentBody.temperature).toBe(0.5);
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('complete() separates system messages into body.system field', async () => {
    const fakeBody = {
      content: [{ type: 'text', text: 'answer' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new AnthropicLlmClient('sk-ant-key');
    await client.complete([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'hello' },
    ]);

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.system).toBe('You are a helper.');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
    // system message must NOT appear in messages array
    expect(sentBody.messages.some((m: { role: string }) => m.role === 'system')).toBe(false);
  });

  it('complete() concatenates multiple system messages with newline', async () => {
    const fakeBody = {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new AnthropicLlmClient('sk-ant-key');
    await client.complete([
      { role: 'system', content: 'Rule 1.' },
      { role: 'system', content: 'Rule 2.' },
      { role: 'user', content: 'hello' },
    ]);

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.system).toBe('Rule 1.\nRule 2.');
  });

  it('complete() returns empty string when no text block in content array', async () => {
    const fakeBody = {
      content: [{ type: 'image' }],
      usage: { input_tokens: 1, output_tokens: 0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new AnthropicLlmClient('sk-ant-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('');
  });

  it('complete() returns tokensUsed=undefined when usage field is absent', async () => {
    const fakeBody = {
      content: [{ type: 'text', text: 'ok' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new AnthropicLlmClient('sk-ant-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.tokensUsed).toBeUndefined();
  });

  it('complete() handles empty content array gracefully', async () => {
    const fakeBody = { content: [], usage: { input_tokens: 1, output_tokens: 0 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new AnthropicLlmClient('sk-ant-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('');
  });

  // -------------------------------------------------------------------------
  // complete() — error paths
  // -------------------------------------------------------------------------

  it('complete() throws on HTTP 401 with status code in message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Unauthorized')));

    const client = new AnthropicLlmClient('sk-ant-bad-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('Anthropic API error 401');
  });

  it('complete() throws on HTTP 500 with status code in message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal Server Error')));

    const client = new AnthropicLlmClient('sk-ant-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('Anthropic API error 500');
  });

  it('complete() includes error body text in the thrown error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(403, 'Forbidden: quota exceeded')));

    const client = new AnthropicLlmClient('sk-ant-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('Forbidden: quota exceeded');
  });

  it('complete() falls back to status code string when response.text() throws', async () => {
    const badResponse: Response = {
      ok: false,
      status: 503,
      text: async () => { throw new Error('read error'); },
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(badResponse));

    const client = new AnthropicLlmClient('sk-ant-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('Anthropic API error 503');
  });
});
