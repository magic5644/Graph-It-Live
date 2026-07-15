import { describe, it, expect, beforeEach } from 'vitest';
import { createSuccessResponse } from '../../src/mcp/types';
import { sessionStats } from '../../src/shared/sessionStats';
import { formatToolResponse, formatDataAsToon, suggestFormat, extractArrayData, inferObjectName } from '../../src/mcp/responseFormatter';

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

  it('formats response as TOON when requested', () => {
    const data = [
      { file: 'main.ts', line: 10 },
      { file: 'utils.ts', line: 20 },
    ];
    const response = createSuccessResponse(data, 5, '/workspace');
    const result = formatToolResponse(response, 'toon');

    expect(result.structuredContent).toBe(response);
    // inferObjectName detects 'file' key and uses 'files' as object name
    expect(result.content[0].text).toContain('files(');
    expect(result.content[0].text).toContain('[main.ts,10]');
    expect(result.content[0].text).toContain('[utils.ts,20]');
  });

  it('includes token savings metadata for TOON format', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      file: `file${i}.ts`,
      deps: ['dep1', 'dep2'],
    }));
    const response = createSuccessResponse(data, 5, '/workspace');
    const result = formatToolResponse(response, 'toon');

    expect(result.content[0].text).toContain('Token Savings');
    expect(result.content[0].text).toContain('JSON:');
    expect(result.content[0].text).toContain('TOON:');
    expect(result.content[0].text).toContain('Savings:');
  });
});

describe('formatDataAsToon', () => {
  it('formats simple array as TOON', () => {
    const data = [
      { file: 'main.ts', line: 10 },
      { file: 'utils.ts', line: 20 },
    ];

    const result = formatDataAsToon(data, 'files');

    expect(result.format).toBe('toon');
    expect(result.content).toBe('files(file,line)\n[main.ts,10]\n[utils.ts,20]');
  });

  it('extracts array from object with data property', () => {
    const data = {
      data: [
        { id: 1, name: 'test' },
        { id: 2, name: 'demo' },
      ],
    };

    const result = formatDataAsToon(data, 'items');

    expect(result.format).toBe('toon');
    expect(result.content).toContain('items(id,name)');
  });

  it('handles null data', () => {
    const result = formatDataAsToon(null, 'items');

    expect(result.format).toBe('toon');
    expect(result.content).toBe('items()\n');
  });

  it('wraps non-array object in array', () => {
    const data = { file: 'main.ts', line: 10 };

    const result = formatDataAsToon(data, 'files');

    expect(result.format).toBe('toon');
    expect(result.content).toContain('[main.ts,10]');
  });

  it('includes token savings for large datasets', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      file: `file${i}.ts`,
      deps: ['dep1', 'dep2', 'dep3'],
    }));

    const result = formatDataAsToon(data, 'files');

    expect(result.tokenSavings).toBeDefined();
    expect(result.tokenSavings!.savingsPercent).toBeGreaterThan(0);
  });

  it('falls back to JSON on conversion error', () => {
    // Mock invalid data that would cause TOON conversion to fail
    const data = [Symbol('invalid')];

    const result = formatDataAsToon(data as never, 'items');

    // Should fallback to JSON format
    expect(result.format).toBe('json');
  });
});

describe('suggestFormat', () => {
  it('suggests json for small arrays', () => {
    const data = [{ id: 1 }, { id: 2 }];

    expect(suggestFormat(data)).toBe('json');
  });

  it('suggests toon for large arrays', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i }));

    expect(suggestFormat(data)).toBe('toon');
  });

  it('suggests json for non-arrays', () => {
    const data = { id: 1, name: 'test' };

    expect(suggestFormat(data)).toBe('json');
  });

  it('suggests json for empty arrays', () => {
    expect(suggestFormat([])).toBe('json');
  });
});

describe('extractArrayData', () => {
  it('returns array as-is', () => {
    const data = [{ id: 1 }, { id: 2 }];

    expect(extractArrayData(data)).toBe(data);
  });

  it('extracts items property', () => {
    const data = { items: [{ id: 1 }, { id: 2 }] };

    expect(extractArrayData(data)).toBe(data.items);
  });

  it('extracts nodes property', () => {
    const data = { nodes: [{ id: 1 }, { id: 2 }] };

    expect(extractArrayData(data)).toBe(data.nodes);
  });

  it('extracts dependencies property', () => {
    const data = { dependencies: [{ file: 'main.ts' }] };

    expect(extractArrayData(data)).toBe(data.dependencies);
  });

  it('returns original for non-extractable data', () => {
    const data = { id: 1, name: 'test' };

    expect(extractArrayData(data)).toBe(data);
  });
});

describe('inferObjectName', () => {
  it('infers files for file-related data', () => {
    const data = [{ file: 'main.ts', line: 10 }];

    expect(inferObjectName(data)).toBe('files');
  });

  it('infers files for filePath-related data', () => {
    const data = [{ filePath: '/path/to/file.ts' }];

    expect(inferObjectName(data)).toBe('files');
  });

  it('infers symbols for symbol-related data', () => {
    const data = [{ symbolName: 'myFunction' }];

    expect(inferObjectName(data)).toBe('symbols');
  });

  it('infers edges for graph edges', () => {
    const data = [{ source: 'a', target: 'b' }];

    expect(inferObjectName(data)).toBe('edges');
  });

  it('infers nodes for graph nodes', () => {
    const data = [{ node: 'a', id: 1 }];

    expect(inferObjectName(data)).toBe('nodes');
  });

  it('infers dependencies for dependency data', () => {
    const data = [{ dependency: 'lodash' }];

    expect(inferObjectName(data)).toBe('dependencies');
  });

  it('defaults to data for generic objects', () => {
    const data = [{ key: 'value', count: 100 }];

    expect(inferObjectName(data)).toBe('data');
  });

  it('defaults to data for empty arrays', () => {
    expect(inferObjectName([])).toBe('data');
  });

  it('defaults to data for non-arrays', () => {
    expect(inferObjectName({ id: 1 })).toBe('data');
  });
});

describe('session stats recording', () => {
  beforeEach(() => {
    // Shared singleton — isolate every test.
    sessionStats.reset();
  });

  const sampleData = [
    { file: 'main.ts', line: 10 },
    { file: 'utils.ts', line: 20 },
  ];

  it('records an entry with the provided toolName on formatDataAsToon', () => {
    formatDataAsToon(sampleData, 'files', 'graphitlive_generate_codemap');

    const snapshot = sessionStats.snapshot();
    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.byTool['graphitlive_generate_codemap']).toBeDefined();
    expect(snapshot.byTool['graphitlive_generate_codemap'].calls).toBe(1);
    expect(snapshot.byTool['graphitlive_generate_codemap'].jsonTokens).toBeGreaterThan(0);
    expect(snapshot.byTool['graphitlive_generate_codemap'].toonTokens).toBeGreaterThan(0);
  });

  it('records under "unknown" when no toolName is provided', () => {
    formatDataAsToon(sampleData, 'files');

    const snapshot = sessionStats.snapshot();
    expect(snapshot.byTool['unknown']).toBeDefined();
    expect(snapshot.byTool['unknown'].calls).toBe(1);
  });

  it('records with truncated=false (truncation metadata not visible at this layer)', () => {
    formatDataAsToon(sampleData, 'files', 'graphitlive_query_call_graph');

    const snapshot = sessionStats.snapshot();
    expect(snapshot.totals.truncations).toBe(0);
  });

  it('propagates toolName through formatToolResponse for toon format', () => {
    const response = createSuccessResponse(sampleData, 5, '/workspace');
    formatToolResponse(response, 'toon', 'graphitlive_analyze_dependencies');

    const snapshot = sessionStats.snapshot();
    expect(snapshot.byTool['graphitlive_analyze_dependencies']).toBeDefined();
    expect(snapshot.totals.calls).toBe(1);
  });

  it('does not record for json or markdown formats', () => {
    const response = createSuccessResponse(sampleData, 5, '/workspace');
    formatToolResponse(response, 'json', 'graphitlive_analyze_dependencies');
    formatToolResponse(response, 'markdown', 'graphitlive_analyze_dependencies');

    expect(sessionStats.snapshot().totals.calls).toBe(0);
  });

  it('does not record when TOON conversion fails (fallback to JSON)', () => {
    formatDataAsToon([Symbol('invalid')] as never, 'items', 'graphitlive_x');

    expect(sessionStats.snapshot().totals.calls).toBe(0);
  });

  it('accumulates totals across multiple calls', () => {
    formatDataAsToon(sampleData, 'files', 'tool_a');
    formatDataAsToon(sampleData, 'files', 'tool_a');
    formatDataAsToon(sampleData, 'files', 'tool_b');

    const snapshot = sessionStats.snapshot();
    expect(snapshot.totals.calls).toBe(3);
    expect(snapshot.byTool['tool_a'].calls).toBe(2);
    expect(snapshot.byTool['tool_b'].calls).toBe(1);
    expect(snapshot.totals.jsonTokens).toBe(
      snapshot.byTool['tool_a'].jsonTokens + snapshot.byTool['tool_b'].jsonTokens,
    );
  });
});
