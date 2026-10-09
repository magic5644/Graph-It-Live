import { describe, it, expect, beforeEach } from 'vitest';
import { createErrorResponse, createSuccessResponse } from '../../src/mcp/types';
import { sessionStats } from '../../src/shared/sessionStats';
import { formatToolResponse, formatDataAsToon, suggestFormat, extractArrayData, inferObjectName } from '../../src/mcp/responseFormatter';

describe('formatToolResponse', () => {
  it('includes structuredContent for json output', () => {
    const response = createSuccessResponse({ ok: true }, 5, '/workspace');
    const result = formatToolResponse(response, 'json');

    expect(result.structuredContent).not.toBe(response);
    expect(result.structuredContent.metadata.workspaceRoot).toBe('.');
    expect(result.content[0].text).toContain('"success": true');
  });

  it('includes structuredContent for markdown output', () => {
    const response = createSuccessResponse({ ok: true }, 5, '/workspace');
    const result = formatToolResponse(response, 'markdown');

    expect(result.structuredContent).not.toBe(response);
    expect(result.content[0].text).toBe('- **ok**: true');
  });

  it('formats response as TOON when requested', () => {
    const data = [
      { file: 'main.ts', line: 10 },
      { file: 'utils.ts', line: 20 },
    ];
    const response = createSuccessResponse(data, 5, '/workspace');
    const result = formatToolResponse(response, 'toon');

    expect(result.structuredContent).not.toBe(response);
    // inferObjectName detects 'file' key and uses 'files' as object name
    expect(result.content[0].text).toContain('files(');
    expect(result.content[0].text).toContain('[main.ts,10]');
    expect(result.content[0].text).toContain('[utils.ts,20]');
  });

  it('omits token savings from TOON output while recording session stats', () => {
    sessionStats.reset();
    const data = Array.from({ length: 20 }, (_, i) => ({
      file: `file${i}.ts`,
      deps: ['dep1', 'dep2'],
    }));
    const response = createSuccessResponse(data, 5, '/workspace');
    const result = formatToolResponse(response, 'toon');

    expect(result.content[0].text).not.toContain('Token Savings');
    expect(result.content[0].text).not.toContain('JSON:');
    expect(result.content[0].text).not.toContain('TOON:');
    expect(result.content[0].text).not.toContain('Savings:');
    expect(sessionStats.snapshot().totals.calls).toBe(1);
  });

  it('drops path keys that duplicate a sibling once paths are relative', () => {
    const response = createSuccessResponse({
      nodes: [{ id: '/workspace/src/a.ts', path: '/workspace/src/a.ts', relativePath: 'src/a.ts' }],
      edges: [{ source: '/workspace/src/a.ts', target: '/workspace/src/b.ts', sourceRelative: 'src/a.ts', targetRelative: 'src/b.ts' }],
    }, 5, '/workspace');

    const result = formatToolResponse(response, 'toon');

    expect(result.structuredContent.data).toEqual({
      nodes: [{ path: 'src/a.ts' }],
      edges: [{ source: 'src/a.ts', target: 'src/b.ts' }],
    });
    expect(result.content[0].text).not.toContain('relativePath');
  });

  it('redacts internal and external absolute paths in public output', () => {
    const response = createSuccessResponse({
      filePath: '/workspace/src/main.ts',
      externalPath: '/private/secret.ts',
    }, 5, '/workspace');

    const result = formatToolResponse(response, 'json');

    expect(result.structuredContent.data).toEqual({
      filePath: 'src/main.ts',
      externalPath: '[external:secret.ts]',
    });
    expect(result.content[0].text).not.toContain('/private/secret.ts');
  });

  it('emits the query tool TOON subgraph directly instead of escaping it into a row', () => {
    sessionStats.reset();
    const toon = '# nodeCount=1 edgeCount=0 truncated=false\nnodes(id,n)\n[src/a.ts:main,main]\nedges()';
    const response = createSuccessResponse({
      question: 'How does main work?',
      extractedKeywords: ['main', 'work'],
      nodeCount: 1,
      edgeCount: 0,
      toon,
      meta: { llmProvider: 'none', keywordExtractionMs: 1, bfsMs: 1, totalMs: 3, tokenEstimate: 20, truncated: false },
    }, 5, '/workspace');

    const text = formatToolResponse(response, 'toon', 'graphitlive_query_natural_language').content[0].text;

    expect(text).toBe(
      'query(question,keywords,llmProvider,totalMs,tokenEstimate)\n'
        + '[How does main work?,main|work,none,3,20]\n'
        + toon,
    );
    expect(sessionStats.snapshot().totals.calls).toBe(1);
  });

  it('falls back to generic TOON for a query result without a toon field', () => {
    const response = createSuccessResponse({
      question: 'q',
      nodes: [{ id: 'src/a.ts:main', name: 'main' }],
      edges: [],
    }, 5, '/workspace');

    const text = formatToolResponse(response, 'toon', 'graphitlive_query_natural_language').content[0].text;

    expect(text).not.toContain('query(');
    expect(text).toContain('[src/a.ts:main,main]');
  });
});

describe('formatToolResponse failures and metadata (#238)', () => {
  const missing = () => createErrorResponse('File not found: src/missing.ts', 5, '/workspace');

  it.each(['toon', 'json', 'markdown'] as const)('sets isError and states the error in %s text', (format) => {
    const result = formatToolResponse(missing(), format, 'graphitlive_analyze_dependencies');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found: src/missing.ts');
    expect(result.structuredContent.success).toBe(false);
  });

  it('gives a failed TOON call an errors section instead of an empty data section', () => {
    const text = formatToolResponse(missing(), 'toon').content[0].text;

    expect(text).toBe('errors(message)\n[File not found: src/missing.ts]');
    expect(text).not.toContain('data()');
  });

  it('keeps the data of a failed call that carries some', () => {
    const response = { ...createErrorResponse<{ files: string[] }>('partial', 5, '/workspace'), data: { files: ['a.ts'] } };

    const text = formatToolResponse(response, 'toon').content[0].text;

    expect(text).toContain('errors(message)\n[partial]');
    expect(text).toContain('a.ts');
  });

  it('falls back to a generic message when a failure has no error text', () => {
    const response = { ...missing(), error: undefined };

    expect(formatToolResponse(response, 'toon').content[0].text).toContain('[Unknown error]');
  });

  it('leaves isError unset on success', () => {
    const result = formatToolResponse(createSuccessResponse({ ok: true }, 5, '/workspace'), 'toon');

    expect(result).not.toHaveProperty('isError');
  });

  it('keeps freshness metadata in TOON text', () => {
    const response = createSuccessResponse([{ file: 'a.ts' }], 5, '/workspace', undefined, {
      indexedAt: '2026-10-02T10:00:00.000Z',
      stale: true,
    });

    const text = formatToolResponse(response, 'toon').content[0].text;

    expect(text.startsWith('meta(indexedAt,stale)\n[2026-10-02T10:00:00.000Z,true]\n')).toBe(true);
    expect(text).toContain('[a.ts]');
  });

  it('writes an unknown index time as an empty cell', () => {
    const response = createSuccessResponse([{ file: 'a.ts' }], 5, '/workspace', undefined, {
      indexedAt: null,
      stale: false,
    });

    expect(formatToolResponse(response, 'toon').content[0].text).toContain('meta(indexedAt,stale)\n[,false]');
  });

  it('keeps pagination in TOON text', () => {
    const response = createSuccessResponse([{ file: 'a.ts' }], 5, '/workspace', {
      total: 30, limit: 10, offset: 0, hasMore: true,
    });

    expect(formatToolResponse(response, 'toon').content[0].text).toContain('meta(total,limit,offset,hasMore)\n[30,10,0,true]');
  });

  it('does not add a second errors section to a failed graph_context call', () => {
    const text = formatToolResponse(createErrorResponse('bad seed', 5, '/workspace'), 'toon', 'graphitlive_graph_context').content[0].text;

    expect(text.match(/errors\(/g)).toHaveLength(1);
    expect(text).toContain('bad seed');
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
    // A nested array is named after its key; objectName only names a root array.
    expect(result.content).toBe('data(id,name)\n[1,test]\n[2,demo]');
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

  it('keeps every array and the scalar fields of a multi-array result', () => {
    const data = {
      nodeCount: 2,
      nodes: [{ path: 'a.ts' }, { path: 'b.ts' }],
      edges: [{ source: 'a.ts', target: 'b.ts' }],
      circularDependencies: [],
    };

    const result = formatDataAsToon(data, 'nodes');

    expect(result.format).toBe('toon');
    expect(result.content).toBe(
      '# nodeCount=2\nnodes(path)\n[a.ts]\n[b.ts]\nedges(source,target)\n[a.ts,b.ts]',
    );
  });

  it('wraps a primitive value in a value row', () => {
    const result = formatDataAsToon(42, 'items');

    expect(result.format).toBe('toon');
    expect(result.content).toBe('items(value)\n[42]');
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

describe('formatToolResponse markdown (#269)', () => {
  const markdown = (data: unknown, extra: Record<string, unknown> = {}) =>
    formatToolResponse({ ...createSuccessResponse(data, 5, '/workspace'), ...extra }, 'markdown').content[0].text;

  it('renders scalars as a list and each array as a table, not JSON', () => {
    const text = markdown({
      filePath: '/workspace/src/a.ts',
      dependencyCount: 1,
      dependencies: [{ path: '/workspace/src/b.ts', type: 'import', line: 1 }],
    });

    expect(text).toBe([
      '- **filePath**: src/a.ts',
      '- **dependencyCount**: 1',
      '',
      '### dependencies',
      '',
      '| path | type | line |',
      '| --- | --- | --- |',
      '| src/b.ts | import | 1 |',
    ].join('\n'));
    expect(text).not.toContain('```');
    expect(text).not.toContain('"success"');
  });

  it('keeps the same content as TOON for every array section', () => {
    const text = markdown({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }], truncated: false });

    expect(text).toContain('- **truncated**: false');
    expect(text).toContain('### nodes');
    expect(text).toContain('### edges');
    expect(text).toContain('| a | b |');
  });

  it('escapes pipes and flattens control characters inside cells', () => {
    const text = markdown({ items: [{ name: 'a|b', note: 'line1\nline2\u0007', meta: { k: 1 }, empty: null }] });

    expect(text).toContain(String.raw`| a\|b | line1 line2  | {"k":1} |  |`);
  });

  it('uses the union of row keys as columns', () => {
    const text = markdown({ items: [{ a: 1 }, { b: 2 }] });

    expect(text).toContain('| a | b |');
    expect(text).toContain('| 1 |  |');
    expect(text).toContain('|  | 2 |');
  });

  it('states rows that carry no field', () => {
    expect(markdown({ items: [{}, {}] })).toBe('### items\n\n_2 empty rows_');
  });

  it('keeps a multi-line string field verbatim in a fenced block', () => {
    const text = markdown({ question: 'q', toon: 'nodes(id)\n[a]' });

    expect(text).toContain('- **question**: q');
    expect(text).toContain('- **toon**:\n\n```text\nnodes(id)\n[a]\n```');
  });

  it('sizes the fence past any backtick run in a multi-line value', () => {
    expect(markdown({ note: 'a\n````\nb' })).toBe('- **note**:\n\n`````text\na\n````\nb\n`````');
  });

  it('escapes backslashes before pipes, and pipes in keys, headers and section names', () => {
    const text = markdown({ 'a|b': 'x', 'my|rows': [{ 'c|d': 'e\\' }] });

    expect(text).toContain(String.raw`- **a\|b**: x`);
    expect(text).toContain(String.raw`### my\|rows`);
    expect(text).toContain(String.raw`| c\|d |`);
    expect(text).toContain(String.raw`| e\\ |`);
  });

  it('renders freshness and pagination before the data', () => {
    const text = markdown([{ file: 'a.ts' }], {
      metadata: { ...createSuccessResponse(null, 5, '/workspace').metadata, indexedAt: '2026-10-09T00:00:00Z', stale: true },
      pagination: { total: 3, limit: 1, offset: 0, hasMore: true },
    });

    expect(text.split('\n\n')[0]).toBe([
      '- **indexedAt**: 2026-10-09T00:00:00Z',
      '- **stale**: true',
      '- **total**: 3',
      '- **limit**: 1',
      '- **offset**: 0',
      '- **hasMore**: true',
    ].join('\n'));
    expect(text).toContain('### files');
  });

  it('renders a primitive payload as text and an empty payload explicitly', () => {
    expect(markdown('done\nnow')).toBe('done now');
    expect(markdown(null)).toBe('_No results._');
    expect(markdown({})).toBe('_No results._');
  });

  it('states the error of a failed call first, without a data section', () => {
    const text = formatToolResponse(createErrorResponse('File not found:\nsrc/x.ts', 5, '/workspace'), 'markdown').content[0].text;

    expect(text).toBe('**Error:** File not found: src/x.ts');
  });

  it('falls back to a generic error message', () => {
    const response = { ...createErrorResponse('x', 5, '/workspace'), error: undefined };

    expect(formatToolResponse(response, 'markdown').content[0].text).toBe('**Error:** Unknown error');
  });

  it('leaves json and toon output unchanged', () => {
    const response = createSuccessResponse({ items: [{ a: 1 }] }, 5, '/workspace');

    expect(formatToolResponse(response, 'json').content[0].text).toContain('"items": [');
    expect(formatToolResponse(response, 'toon').content[0].text).toContain('items(a)');
  });
});
