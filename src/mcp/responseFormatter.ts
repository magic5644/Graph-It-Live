/**
 * Response Formatter for MCP Tools
 * 
 * Handles formatting of tool responses based on requested output format (JSON, TOON, or Markdown).
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { jsonToToon, estimateTokenSavings } from '../shared/toon';
import { collectScalarFields, collectToonSections, encodeToonSections } from '../shared/toonSections';
import { sessionStats } from '../shared/sessionStats';
import { getLogger } from '../shared/logger';
import { normalizePath } from '../shared/path';
import path from 'node:path';
import type { McpToolResponse, OutputFormat } from './types';
import type { GraphContextResponse } from '../shared/graph-context-types';
import { projectGraphContextOutput } from '../shared/graph-context-output';
import { compactOutput } from '../shared/compactOutput';
import type { GraphContextDetail } from '../shared/graph-context-types';

const log = getLogger('responseFormatter');

export type ResponseFormat = 'json' | 'markdown' | 'toon';

/**
 * Format a tool response for MCP protocol (legacy interface)
 * 
 * @param response - The full MCP tool response
 * @param responseFormat - The requested response format
 * @param toolName - Name of the MCP tool producing this response (session stats attribution)
 * @returns Formatted response with content and structured data
 */
export function formatToolResponse<T>(
  response: McpToolResponse<T>,
  responseFormat: ResponseFormat,
  toolName?: string,
  detail?: GraphContextDetail,
): { content: { type: 'text'; text: string }[]; structuredContent: McpToolResponse<T>; isError?: true } {
  // Paths become workspace-relative first, so duplicated path keys compare equal.
  const redactedResponse = compactOutput(redactAbsolutePaths(response, response.metadata.workspaceRoot));
  let publicResponse: McpToolResponse<T> = redactedResponse;
  if (toolName === 'graphitlive_graph_context' && isGraphContextResponse(redactedResponse.data)) {
    publicResponse = {
      ...redactedResponse,
      data: projectGraphContextOutput(redactedResponse.data, detail),
    } as McpToolResponse<T>;
  }
  let text: string;

  if (responseFormat === 'toon') {
    let formatted: { content: string };
    if (toolName === 'graphitlive_graph_context') {
      formatted = formatGraphContextAsToon(publicResponse, toolName);
    } else if (toolName === 'graphitlive_query_natural_language' && isQueryToonResult(publicResponse.data)) {
      formatted = { content: formatQueryAsToon(publicResponse.data) };
    } else {
      formatted = formatDataAsToon(publicResponse.data, inferObjectNameFromResponse(publicResponse), toolName);
    }
    // graph_context already reports its own errors and freshness.
    text = toolName === 'graphitlive_graph_context'
      ? formatted.content
      : formatToonEnvelope(publicResponse, formatted.content);
  } else if (responseFormat === 'markdown') {
    text = formatMarkdown(publicResponse);
  } else {
    text = JSON.stringify(publicResponse, null, 2);
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: publicResponse,
    // MCP clients read isError, not structuredContent.success, to detect failures.
    ...(publicResponse.success ? {} : { isError: true as const }),
  };
}

/**
 * TOON text only carries `data`: prepend the error of a failed call and the
 * metadata needed to read the result (freshness, pagination). A failure with
 * no data keeps only the error, not an empty `data()` section.
 */
function formatToonEnvelope<T>(response: McpToolResponse<T>, dataContent: string): string {
  const sections: string[] = [];
  if (!response.success) {
    sections.push(jsonToToon([{ message: response.error ?? 'Unknown error' }], { objectName: 'errors' }));
  }
  const { indexedAt, stale } = response.metadata;
  const meta = {
    ...(indexedAt === undefined ? {} : { indexedAt: indexedAt ?? '' }),
    ...(stale === undefined ? {} : { stale }),
    ...response.pagination,
  };
  if (Object.keys(meta).length > 0) {
    sections.push(jsonToToon([meta], { objectName: 'meta' }));
  }
  if (response.success || (response.data !== null && response.data !== undefined)) {
    sections.push(dataContent);
  }
  return sections.join('\n');
}

/**
 * Readable Markdown with the same content as TOON: the error, freshness and
 * pagination, scalar fields as a list, then one table per array.
 */
function formatMarkdown<T>(response: McpToolResponse<T>): string {
  const blocks: string[] = [];
  if (!response.success) blocks.push(`**Error:** ${markdownText(response.error ?? 'Unknown error')}`);

  const { indexedAt, stale } = response.metadata;
  const data: unknown = response.data;
  const sections = collectToonSections(data);
  const fields: Array<[string, unknown]> = [
    ...(indexedAt === undefined || indexedAt === null ? [] : [['indexedAt', indexedAt] as [string, unknown]]),
    ...(stale === undefined ? [] : [['stale', stale] as [string, unknown]]),
    ...Object.entries(response.pagination ?? {}),
    ...collectScalarFields(data, sections),
  ];
  if (fields.length > 0) blocks.push(fields.map(([key, value]) => formatMarkdownField(key, value)).join('\n'));

  for (const section of sections) blocks.push(formatMarkdownTable(section.name, section.items));
  if (isPrimitive(data)) blocks.push(markdownText(String(data)));
  return blocks.length === 0 ? '_No results._' : blocks.join('\n\n');
}

function formatMarkdownField(key: string, value: unknown): string {
  const text = isPrimitive(value) ? String(value) : JSON.stringify(value);
  if (!text.includes('\n')) return `- **${markdownCell(key)}**: ${markdownCell(text)}`;
  // Multi-line strings such as the query tool's TOON subgraph stay verbatim, in a
  // fence longer than any backtick run they contain.
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `- **${markdownCell(key)}**:\n\n${fence}text\n${text}\n${fence}`;
}

function formatMarkdownTable(name: string, rows: unknown[]): string {
  const records = rows as Array<Record<string, unknown>>;
  const columns = [...new Set(records.flatMap(row => Object.keys(row)))];
  const heading = `### ${markdownCell(name)}`;
  if (columns.length === 0) return `${heading}\n\n_${rows.length} empty rows_`;
  const cell = (value: unknown): string => {
    if (value === undefined || value === null) return '';
    return markdownCell(isPrimitive(value) ? String(value) : JSON.stringify(value));
  };
  return [
    heading,
    '',
    `| ${columns.map(markdownCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...records.map(row => `| ${columns.map(column => cell(row[column])).join(' | ')} |`),
  ].join('\n');
}

function isPrimitive(value: unknown): value is string | number | boolean | bigint {
  return ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
}

/** One line of text: newlines and other control characters would end a list item or a table row. */
function markdownText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/[\x00-\x1F\x7F]+/g, ' ');
}

/** Single-line text that cannot break a table: backslashes go first so `\|` stays an escaped pipe. */
function markdownCell(text: string): string {
  return markdownText(text).replaceAll('\\', '\\\\').replaceAll('|', String.raw`\|`);
}

function formatGraphContextAsToon<T>(
  response: McpToolResponse<T>,
  toolName: string,
): ReturnType<typeof formatDataAsToon> {
  const data = response.data;
  const sections: string[] = [];

  if (response.success && isGraphContextResponse(data)) {
    sections.push(jsonToToon([{
      indexRevision: data.indexRevision,
      fresh: data.fresh,
      mode: data.mode,
      tokenEstimate: data.tokenEstimate,
      truncated: data.truncated,
      nextCursor: data.nextCursor ?? '',
    }], { objectName: 'graph_context' }));
    // No `seeds` section: every seed is in `nodes`, flagged isSeed.
    sections.push(jsonToToon(data.nodes, { objectName: 'nodes' }));
    sections.push(jsonToToon(data.edges, { objectName: 'edges' }));
    sections.push(jsonToToon(data.paths, { objectName: 'paths' }));
    sections.push(jsonToToon(data.ambiguous, { objectName: 'ambiguous' }));
    sections.push(jsonToToon([data.omitted], { objectName: 'omitted' }));
    sections.push(jsonToToon(
      data.nextQueries.map(query => ({ query })),
      { objectName: 'nextQueries' },
    ));
    sections.push(jsonToToon([], { objectName: 'errors' }));
  } else {
    sections.push(jsonToToon(
      [{ message: response.error ?? 'Unknown graph-context error' }],
      { objectName: 'errors' },
    ));
  }

  const content = sections.map(section => section.trimEnd()).join('\n');
  const jsonContent = JSON.stringify(response.success ? data : response, null, 2);
  const savings = estimateTokenSavings(jsonContent, content);
  sessionStats.record({
    toolName,
    jsonTokens: savings.jsonTokens,
    toonTokens: savings.toonTokens,
    savings: savings.savings,
    truncated: isGraphContextResponse(data) && data.truncated,
    timestamp: Date.now(),
  });

  return {
    content,
    format: 'toon',
    tokenSavings: savings,
  };
}

interface QueryToonResult {
  question: string;
  extractedKeywords: string[];
  toon: string;
  meta: { llmProvider: string; totalMs: number; tokenEstimate: number; truncated: boolean };
}

function isQueryToonResult(value: unknown): value is QueryToonResult {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<QueryToonResult>).toon === 'string';
}

/**
 * The query tool already encodes its subgraph as TOON. Emit that string as-is
 * behind a one-row header, instead of escaping it into a cell of another TOON row.
 */
function formatQueryAsToon(data: QueryToonResult): string {
  const header = jsonToToon([{
    question: data.question,
    keywords: data.extractedKeywords,
    llmProvider: data.meta.llmProvider,
    totalMs: data.meta.totalMs,
    tokenEstimate: data.meta.tokenEstimate,
  }], { objectName: 'query' });
  const content = `${header}\n${data.toon}`;
  const savings = estimateTokenSavings(JSON.stringify(data, null, 2), content);
  sessionStats.record({
    toolName: 'graphitlive_query_natural_language',
    jsonTokens: savings.jsonTokens,
    toonTokens: savings.toonTokens,
    savings: savings.savings,
    truncated: data.meta.truncated,
    timestamp: Date.now(),
  });
  return content;
}

function isGraphContextResponse(value: unknown): value is GraphContextResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GraphContextResponse>;
  return typeof candidate.indexRevision === 'string'
    && typeof candidate.mode === 'string'
    && Array.isArray(candidate.seeds)
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges)
    && Array.isArray(candidate.paths)
    && Array.isArray(candidate.ambiguous)
    && typeof candidate.omitted === 'object'
    && candidate.omitted !== null
    && Array.isArray(candidate.nextQueries);
}

function redactAbsolutePaths<T>(
  response: McpToolResponse<T>,
  workspaceRoot: string,
): McpToolResponse<T> {
  const normalizedRoot = normalizePath(workspaceRoot);

  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const normalizedValue = normalizePath(value);
      if (normalizedRoot && normalizedValue === normalizedRoot) return '.';
      if (normalizedRoot && normalizedValue.startsWith(`${normalizedRoot}/`)) {
        return normalizedValue.slice(normalizedRoot.length + 1);
      }
      if (path.isAbsolute(value)) return `[external:${path.basename(value)}]`;
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redact(child)]),
    );
  };

  return redact(response) as McpToolResponse<T>;
}

/**
 * Format data as TOON
 * 
 * @param data - The raw data to format
 * @param objectName - The name to use for TOON format
 * @param toolName - Name of the MCP tool producing this data (session stats attribution)
 * @returns Formatted response with token savings info
 */
export function formatDataAsToon(
  data: unknown,
  objectName = 'data',
  toolName?: string
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

  try {
    // One section per array plus a scalar header; a payload with no array stays
    // a single row, and a primitive is wrapped as { value }.
    const toonContent = encodeToonSections(data, objectName)?.content
      ?? jsonToToon([typeof data === 'object' ? data : { value: data }], { objectName });
    const jsonContent = JSON.stringify(data, null, 2);
    const savings = estimateTokenSavings(jsonContent, toonContent);

    // Session stats: TOON encoding size vs JSON equivalent (estimated, chars/4 heuristic).
    // truncated stays false here: truncation metadata is not visible at this layer.
    sessionStats.record({
      toolName: toolName ?? 'unknown',
      jsonTokens: savings.jsonTokens,
      toonTokens: savings.toonTokens,
      savings: savings.savings,
      truncated: false,
      timestamp: Date.now(),
    });

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
