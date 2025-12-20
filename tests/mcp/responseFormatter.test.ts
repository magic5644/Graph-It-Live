import { describe, it, expect } from 'vitest';
import { createSuccessResponse } from '../../src/mcp/types';
import { formatToolResponse } from '../../src/mcp/responseFormatter';

describe('formatToolResponse', () => {
  it('includes structuredContent for json output', () => {
    const response = createSuccessResponse({ ok: true }, 5, '/workspace');
    const result = formatToolResponse(response, 'json');

    expect(result.structuredContent).toBe(response);
    expect(result.content[0].text).toContain('"success": true');
  });

  it('includes structuredContent for markdown output', () => {
    const response = createSuccessResponse({ ok: true }, 5, '/workspace');
    const result = formatToolResponse(response, 'markdown');

    expect(result.structuredContent).toBe(response);
    expect(result.content[0].text).toMatch(/```json/);
  });
});
