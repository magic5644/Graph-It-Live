/**
 * OpenAiCompatibleLlmClient — uses native fetch to call OpenAI-compatible chat API.
 *
 * NO vscode import — pure Node.js analyzer layer.
 * Uses fetch (Node 22 native) — no SDK dependency required.
 * Compatible with OpenAI, Azure OpenAI, LM Studio, Ollama, etc.
 */

import type { LlmClient, LlmCompletionOptions, LlmCompletionResult, LlmMessage } from './LlmClient';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

interface OpenAiResponseBody {
  choices: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { total_tokens: number };
  error?: { message: string };
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly providerName = 'openai-compatible' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(apiKey?: string, baseUrl?: string, model?: string) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async complete(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const maxTokens = options?.maxTokens ?? 256;
    const temperature = options?.temperature ?? 0.0;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => String(response.status));
      throw new Error(`OpenAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as OpenAiResponseBody;

    const text = data.choices?.[0]?.message?.content ?? '';
    const tokensUsed = data.usage?.total_tokens;

    return { text, tokensUsed };
  }
}
