import type { McpToolResponse } from './types';

export type ResponseFormat = 'json' | 'markdown';

export function formatToolResponse<T>(
  response: McpToolResponse<T>,
  responseFormat: ResponseFormat
): { content: { type: 'text'; text: string }[]; structuredContent: McpToolResponse<T> } {
  const text =
    responseFormat === 'markdown'
      ? `\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``
      : JSON.stringify(response, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: response,
  };
}
