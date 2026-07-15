/**
 * AnthropicLlmClient — uses native fetch to call Anthropic Messages API.
 *
 * NO vscode import — pure Node.js analyzer layer.
 * Uses fetch (Node 22 native) — no SDK dependency required.
 */

import type { LlmClient, LlmCompletionOptions, LlmCompletionResult, LlmMessage } from './LlmClient';
import { sessionStats } from '@/shared/sessionStats';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponseBody {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { message: string };
}

export class AnthropicLlmClient implements LlmClient {
  readonly providerName = 'anthropic' as const;

  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = model ?? DEFAULT_MODEL;
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

    // Separate system message from user/assistant messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map(m => m.content).join('\n');
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => String(response.status));
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as AnthropicResponseBody;

    const textBlock = data.content?.find(c => c.type === 'text' && c.text);
    const text = textBlock?.text ?? '';
    const tokensUsed = data.usage
      ? data.usage.input_tokens + data.usage.output_tokens
      : undefined;

    if (tokensUsed !== undefined) {
      sessionStats.recordLlmUsage({ provider: 'anthropic', tokensUsed, timestamp: Date.now() });
    }

    return { text, tokensUsed };
  }
}
