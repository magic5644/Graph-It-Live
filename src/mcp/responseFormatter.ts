/**
 * Response Formatter for MCP Tools
 * 
 * Handles formatting of tool responses based on requested output format (JSON, TOON, or Markdown).
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { jsonToToon, estimateTokenSavings } from '../shared/toon';
import { getLogger } from '../shared/logger';
import type { McpToolResponse, OutputFormat } from './types';

const log = getLogger('responseFormatter');

export type ResponseFormat = 'json' | 'markdown' | 'toon';

/**
 * Format a tool response for MCP protocol (legacy interface)
 * 
 * @param response - The full MCP tool response
 * @param responseFormat - The requested response format
 * @returns Formatted response with content and structured data
 */
export function formatToolResponse<T>(
  response: McpToolResponse<T>,
  responseFormat: ResponseFormat
): { content: { type: 'text'; text: string }[]; structuredContent: McpToolResponse<T> } {
  let text: string;

  if (responseFormat === 'toon') {
    // Try to format the data as TOON
    const formatted = formatDataAsToon(response.data, inferObjectNameFromResponse(response));
    text = formatted.content;

    // Add metadata if available
    if (formatted.tokenSavings) {
      text += `\n\n# Token Savings\n`;
      text += `JSON: ${formatted.tokenSavings.jsonTokens} tokens\n`;
      text += `TOON: ${formatted.tokenSavings.toonTokens} tokens\n`;
      text += `Savings: ${formatted.tokenSavings.savings} tokens (${formatted.tokenSavings.savingsPercent.toFixed(1)}%)\n`;
    }
  } else if (responseFormat === 'markdown') {
    text = `\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``;
  } else {
    text = JSON.stringify(response, null, 2);
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: response,
  };
}

/**
 * Helper function to extract array data from various response structures
 */
function extractArrayFromData(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }

  if (typeof data === 'object' && data !== null) {
    const dataObj = data as Record<string, unknown>;
    
    // Try common patterns: items, results, data, nodes, edges, etc.
    const arrayKeys = ['items', 'results', 'data', 'nodes', 'edges', 'dependencies', 'symbols', 'callers'];
    
    for (const key of arrayKeys) {
      if (Array.isArray(dataObj[key])) {
        return dataObj[key] as unknown[];
      }
    }
    
    // If no array found, wrap the object itself
    return [data];
  }

  // Primitive value, wrap it
  return [{ value: data }];
}

/**
 * Format data as TOON
 * 
 * @param data - The raw data to format
 * @param objectName - The name to use for TOON format
 * @returns Formatted response with token savings info
 */
export function formatDataAsToon(
  data: unknown,
  objectName = 'data'
): {
  content: string;
  format: OutputFormat;
  tokenSavings?: {
    jsonTokens: number;
    toonTokens: number;
    savings: number;
    savingsPercent: number;
  };
} {
  // Handle empty or null data
  if (data === null || data === undefined) {
    return {
      content: `${objectName}()\n`,
      format: 'toon',
    };
  }

  // Extract or wrap array data
  const arrayData = extractArrayFromData(data);

  // Generate TOON format
  try {
    const toonContent = jsonToToon(arrayData, { objectName });
    const jsonContent = JSON.stringify(data, null, 2);
    const savings = estimateTokenSavings(jsonContent, toonContent);

    return {
      content: toonContent,
      format: 'toon',
      tokenSavings: savings,
    };
  } catch (error) {
    // Fallback to JSON if TOON conversion fails
    log.error('[formatDataAsToon] TOON conversion failed:', error);
    return {
      content: JSON.stringify(data, null, 2),
      format: 'json',
    };
  }
}

/**
 * Auto-detect the best format based on data size
 * Suggests TOON for arrays with > 10 items to save tokens
 * 
 * @param data - The data to analyze
 * @returns Recommended format
 */
export function suggestFormat(data: unknown): OutputFormat {
  if (!Array.isArray(data)) {
    return 'json'; // Non-arrays are typically small
  }

  // Suggest TOON for large datasets
  if (data.length > 10) {
    return 'toon';
  }

  return 'json';
}

/**
 * Extract array data from a response object for TOON formatting
 * Handles common response structures like { data: [...], nodes: [...], etc. }
 * 
 * @param response - The response object
 * @returns Array data or the original response
 */
export function extractArrayData(response: unknown): unknown {
  if (Array.isArray(response)) {
    return response;
  }

  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    
    // Check for common array properties
    const arrayKeys = ['items', 'results', 'data', 'nodes', 'edges', 'dependencies', 'symbols', 'callers'];
    
    for (const key of arrayKeys) {
      if (Array.isArray(obj[key])) {
        return obj[key];
      }
    }
  }

  return response;
}

/**
 * Determine the object name for TOON format based on data structure
 * 
 * @param data - The data to analyze
 * @returns Suggested object name
 */
export function inferObjectName(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) {
    return 'data';
  }

  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) {
    return 'data';
  }

  // Infer from object keys
  const keys = Object.keys(firstItem);
  
  // Common patterns
  if (keys.includes('file') || keys.includes('filePath')) {
    return 'files';
  }
  if (keys.includes('symbolName') || keys.includes('symbol')) {
    return 'symbols';
  }
  if (keys.includes('source') && keys.includes('target')) {
    return 'edges';
  }
  if (keys.includes('node') || keys.includes('id')) {
    return 'nodes';
  }
  if (keys.includes('dependency') || keys.includes('dependencies')) {
    return 'dependencies';
  }
  if (keys.includes('caller') || keys.includes('callers')) {
    return 'callers';
  }

  return 'data';
}

/**
 * Infer object name from MCP response structure
 * 
 * @param response - The MCP tool response
 * @returns Suggested object name
 */
function inferObjectNameFromResponse<T>(response: McpToolResponse<T>): string {
  // Try to extract from data
  return inferObjectName(response.data);
}
