/// <reference types="node" />

/**
 * Unit tests for OpenAiCompatibleLlmClient.
 *
 * All network calls are mocked via vi.stubGlobal('fetch', ...) — no real HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleLlmClient } from '../../../src/analyzer/llm/OpenAiCompatibleLlmClient';
import { sessionStats } from '../../../src/shared/sessionStats';

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

describe('OpenAiCompatibleLlmClient', () => {
  let originalApiKey: string | undefined;
  let originalBaseUrl: string | undefined;
  let originalModel: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    originalBaseUrl = process.env.OPENAI_BASE_URL;
    originalModel = process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore env vars
    if (originalApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (originalBaseUrl !== undefined) {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.OPENAI_BASE_URL;
    }
    if (originalModel !== undefined) {
      process.env.OPENAI_MODEL = originalModel;
    } else {
      delete process.env.OPENAI_MODEL;
    }
  });

  // -------------------------------------------------------------------------
  // providerName
  // -------------------------------------------------------------------------

  it('has providerName "openai-compatible"', () => {
    const client = new OpenAiCompatibleLlmClient('sk-key');
    expect(client.providerName).toBe('openai-compatible');
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  it('isAvailable() returns true when apiKey passed in constructor', async () => {
    const client = new OpenAiCompatibleLlmClient('sk-openai-key');
    expect(await client.isAvailable()).toBe(true);
  });

  it('isAvailable() returns true when OPENAI_API_KEY env is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    const client = new OpenAiCompatibleLlmClient();
    expect(await client.isAvailable()).toBe(true);
  });

  it('isAvailable() returns false when no key provided', async () => {
    delete process.env.OPENAI_API_KEY;
    const client = new OpenAiCompatibleLlmClient('');
    expect(await client.isAvailable()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // complete() — nominal path
  // -------------------------------------------------------------------------

  it('complete() returns parsed text and tokensUsed from OpenAI response', async () => {
    const fakeBody = {
      choices: [{ message: { content: 'Hello from OpenAI' }, finish_reason: 'stop' }],
      usage: { total_tokens: 20 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('Hello from OpenAI');
    expect(result.tokensUsed).toBe(20);
  });

  it('complete() sends correct URL, headers and body structure', async () => {
    const fakeBody = {
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 5 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAiCompatibleLlmClient('sk-key', 'https://api.openai.com/v1', 'gpt-4o');
    await client.complete(
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 64, temperature: 0.7 },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-key');
    expect(headers['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe('gpt-4o');
    expect(sentBody.max_tokens).toBe(64);
    expect(sentBody.temperature).toBe(0.7);
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('complete() strips trailing slash from baseUrl before appending path', async () => {
    const fakeBody = {
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 3 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAiCompatibleLlmClient('sk-key', 'https://custom.local/v1/');
    await client.complete([{ role: 'user', content: 'hi' }]);

    const [url] = mockFetch.mock.calls[0] as [string];
    // Should not have double slash
    expect(url).toBe('https://custom.local/v1/chat/completions');
  });

  it('complete() uses OPENAI_BASE_URL env when no baseUrl in constructor', async () => {
    process.env.OPENAI_BASE_URL = 'https://env-custom.local/v1';
    const fakeBody = {
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 2 },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeOkResponse(fakeBody));
    vi.stubGlobal('fetch', mockFetch);

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await client.complete([{ role: 'user', content: 'hi' }]);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://env-custom.local/v1/chat/completions');
  });

  it('complete() returns tokensUsed=undefined when usage field is absent', async () => {
    const fakeBody = {
      choices: [{ message: { content: 'ok' } }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.tokensUsed).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // complete() — choices[] edge cases
  // -------------------------------------------------------------------------

  it('complete() returns empty string when choices[] is empty', async () => {
    const fakeBody = {
      choices: [],
      usage: { total_tokens: 0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('');
  });

  it('complete() returns empty string when choices[0].message.content is absent', async () => {
    const fakeBody = {
      choices: [{ message: {}, finish_reason: 'stop' }],
      usage: { total_tokens: 1 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('');
  });

  it('complete() returns empty string when choices[0].message is absent', async () => {
    const fakeBody = {
      choices: [{ finish_reason: 'stop' }],
      usage: { total_tokens: 1 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.text).toBe('');
  });

  // -------------------------------------------------------------------------
  // complete() — error paths
  // -------------------------------------------------------------------------

  it('complete() throws on HTTP 401 with status code in message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Unauthorized')));

    const client = new OpenAiCompatibleLlmClient('sk-bad-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('OpenAI API error 401');
  });

  it('complete() throws on HTTP 500 with status code in message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal Server Error')));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('OpenAI API error 500');
  });

  it('complete() includes error body text in the thrown error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(429, 'Rate limit exceeded')));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('Rate limit exceeded');
  });

  it('complete() falls back to status code string when response.text() throws', async () => {
    const badResponse: Response = {
      ok: false,
      status: 503,
      text: async () => { throw new Error('network error'); },
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(badResponse));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await expect(
      client.complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow('OpenAI API error 503');
  });

  // -------------------------------------------------------------------------
  // complete() — session stats wiring
  // -------------------------------------------------------------------------

  it('complete() records llmUsage in sessionStats when tokensUsed is defined', async () => {
    sessionStats.reset();
    const fakeBody = {
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 33 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await client.complete([{ role: 'user', content: 'hi' }]);

    const snap = sessionStats.snapshot();
    expect(snap.llmUsage).toEqual({ calls: 1, tokensUsed: 33 });
    // llmUsage stays separate from encoding totals.
    expect(snap.totals.calls).toBe(0);
    sessionStats.reset();
  });

  it('complete() does not record llmUsage when usage field is absent', async () => {
    sessionStats.reset();
    const fakeBody = { choices: [{ message: { content: 'ok' } }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(fakeBody)));

    const client = new OpenAiCompatibleLlmClient('sk-key');
    await client.complete([{ role: 'user', content: 'hi' }]);

    expect(sessionStats.snapshot().llmUsage).toEqual({ calls: 0, tokensUsed: 0 });
  });
});
