/**
 * LlmClient — abstract interface for LLM completions.
 *
 * NO vscode import — pure Node.js analyzer layer.
 */

import type { LlmProviderName } from '@/shared/query-types';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionOptions {
  maxTokens?: number;    // default: 256
  temperature?: number;  // default: 0.0
}

export interface LlmCompletionResult {
  text: string;
  tokensUsed?: number;
}

export interface LlmClient {
  readonly providerName: LlmProviderName;
  isAvailable(): Promise<boolean>;
  complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmCompletionResult>;
}
