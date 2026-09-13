/**
 * Tests for the `graph-it query` CLI command.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../src/cli/errors.js';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that would pull in the modules
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  executeQueryNaturalLanguage: vi.fn(),
  resolveLlmClient: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeQueryNaturalLanguage: mocks.executeQueryNaturalLanguage,
}));

vi.mock('../../src/analyzer/llm/LlmClientFactory.js', () => ({
  resolveLlmClient: mocks.resolveLlmClient,
}));

import { run } from '../../src/cli/commands/query.js';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = '/workspace';

function makeRuntime(root = WORKSPACE_ROOT) {
  return {
    workspaceRoot: root,
    ensureIndexed: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function makeToonResult(overrides: Record<string, unknown> = {}) {
  return {
    question: 'how does the indexer work',
    extractedKeywords: ['indexer', 'work'],
    nodeCount: 3,
    edgeCount: 2,
    toon: 'nodes:[A,B,C] edges:[A->B,B->C]',
    meta: {
      llmProvider: 'heuristic',
      keywordExtractionMs: 5,
      bfsMs: 10,
      totalMs: 15,
      tokenEstimate: 120,
      truncated: false,
    },
    ...overrides,
  };
}

function makeJsonResult(overrides: Record<string, unknown> = {}) {
  return {
    question: 'how does the indexer work',
    extractedKeywords: ['indexer', 'work'],
    nodeCount: 2,
    edgeCount: 1,
    nodes: [
      { id: 'n1', name: 'CallGraphIndexer', type: 'class', path: '/workspace/src/analyzer/CallGraphIndexer.ts', relevanceScore: 0.9 },
      { id: 'n2', name: 'QueryEngine', type: 'class', path: '/workspace/src/analyzer/QueryEngine.ts', relevanceScore: 0.7 },
    ],
    edges: [
      { source: 'n1', target: 'n2' },
    ],
    meta: {
      llmProvider: 'heuristic',
      keywordExtractionMs: 5,
      bfsMs: 10,
      totalMs: 15,
      tokenEstimate: 200,
      truncated: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('query command', () => {
  beforeEach(() => {
    mocks.executeQueryNaturalLanguage.mockReset();
    mocks.resolveLlmClient.mockReset();
    // Default: LLM available
    mocks.resolveLlmClient.mockResolvedValue({ /* fake client */ });
  });

  // -------------------------------------------------------------------------
  // 1. Missing question → CliError
  // -------------------------------------------------------------------------
  it('throws CliError when no question is provided', async () => {
    await expect(run([], makeRuntime(), 'text')).rejects.toThrow(CliError);
    await expect(run(['--format', 'toon'], makeRuntime(), 'text')).rejects.toThrow(CliError);
  });

  it('CliError for missing question has GENERAL_ERROR exit code', async () => {
    try {
      await run([], makeRuntime(), 'text');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. --format toon → result.toon is returned
  // -------------------------------------------------------------------------
  it('returns toon string when --format toon', async () => {
    const toonResult = makeToonResult();
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(toonResult);

    const output = await run(
      ['how does the indexer work', '--format', 'toon'],
      makeRuntime(),
      'text',
    );

    expect(output).toBe(toonResult.toon);
  });

  it('uses toon as default format when no --format flag', async () => {
    const toonResult = makeToonResult();
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(toonResult);

    const output = await run(['how does the indexer work'], makeRuntime(), 'text');

    expect(output).toBe(toonResult.toon);
    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: 'toon' }),
      expect.anything(),
    );
  });

  // -------------------------------------------------------------------------
  // 3. --format json → JSON parseable output
  // -------------------------------------------------------------------------
  it('returns JSON parseable output when --format json', async () => {
    const jsonResult = makeJsonResult();
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(jsonResult);

    const output = await run(
      ['how does the indexer work', '--format', 'json'],
      makeRuntime(),
      'text',
    );

    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output) as typeof jsonResult;
    expect(parsed.question).toBe(jsonResult.question);
    expect(parsed.nodeCount).toBe(jsonResult.nodeCount);
    expect(parsed.extractedKeywords).toEqual(jsonResult.extractedKeywords);
  });

  it('passes outputFormat json to executeQueryNaturalLanguage when --format json', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeJsonResult());

    await run(
      ['how does the indexer work', '--format', 'json'],
      makeRuntime(),
      'text',
    );

    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: 'json' }),
      expect.anything(),
    );
  });

  // -------------------------------------------------------------------------
  // 4. --depth 3 → depth=3 passed to executeQueryNaturalLanguage
  // -------------------------------------------------------------------------
  it('passes depth=3 when --depth 3', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    await run(
      ['how does the indexer work', '--depth', '3'],
      makeRuntime(),
      'text',
    );

    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 3 }),
      expect.anything(),
    );
  });

  it('uses default depth=2 when --depth is not provided', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    await run(['how does the indexer work'], makeRuntime(), 'text');

    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 2 }),
      expect.anything(),
    );
  });

  it('passes --token-budget to executeQueryNaturalLanguage', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    await run(
      ['how does the indexer work', '--token-budget', '8000'],
      makeRuntime(),
      'text',
    );

    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBudget: 8000 }),
      expect.anything(),
    );
  });

  it('forwards the resolved LLM client to the query tool for keyword extraction', async () => {
    const fakeClient = { providerName: 'copilot-cli' };
    mocks.resolveLlmClient.mockResolvedValueOnce(fakeClient);
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    await run(['how does the indexer work'], makeRuntime(), 'text');

    expect(mocks.executeQueryNaturalLanguage).toHaveBeenCalledWith(
      expect.any(Object),
      fakeClient,
    );
  });

  // -------------------------------------------------------------------------
  // Workspace-relative output
  // -------------------------------------------------------------------------

  it('lists nodes as file:line so the next read is targeted', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(
      makeJsonResult({
        nodes: [
          {
            id: 'n1',
            name: 'CallGraphIndexer',
            type: 'class',
            path: '/workspace/src/analyzer/CallGraphIndexer.ts',
            startLine: 42,
            relevanceScore: 0.9,
          },
        ],
      }),
    );

    const output = await run(['how does the indexer work', '--format', 'text'], makeRuntime(), 'text');

    expect(output).toContain('CallGraphIndexer (src/analyzer/CallGraphIndexer.ts:42)');
  });

  it('omits the line suffix when the node has no known start line', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(
      makeJsonResult({
        nodes: [
          {
            id: 'n1',
            name: 'CallGraphIndexer',
            type: 'class',
            path: '/workspace/src/analyzer/CallGraphIndexer.ts',
            relevanceScore: 0.9,
          },
        ],
      }),
    );

    const output = await run(['how does the indexer work', '--format', 'text'], makeRuntime(), 'text');

    expect(output).toContain('CallGraphIndexer (src/analyzer/CallGraphIndexer.ts)');
  });

  it('strips the workspace root from TOON output', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(
      makeToonResult({
        toon: '[/workspace/src/a.ts:A:3,A,class,/workspace/src/a.ts,3,0]',
      }),
    );

    const output = await run(['how does the indexer work', '--format', 'toon'], makeRuntime(), 'text');

    expect(output).toBe('[src/a.ts:A:3,A,class,src/a.ts,3,0]');
  });

  it('strips the workspace root from JSON output', async () => {
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeJsonResult());

    const output = await run(['how does the indexer work', '--format', 'json'], makeRuntime(), 'text');

    expect(output).not.toContain('/workspace/');
    expect(JSON.parse(output).nodes[0].path).toBe('src/analyzer/CallGraphIndexer.ts');
  });

  // -------------------------------------------------------------------------
  // 5. No LLM → hint message written to stderr
  // -------------------------------------------------------------------------
  it('writes hint to stderr when no LLM is configured', async () => {
    mocks.resolveLlmClient.mockResolvedValueOnce(null);
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await run(['how does the indexer work'], makeRuntime(), 'text');

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No LLM configured'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY'),
    );

    stderrSpy.mockRestore();
  });

  it('does NOT write LLM hint to stderr when LLM is available', async () => {
    mocks.resolveLlmClient.mockResolvedValueOnce({ /* fake client */ });
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(makeToonResult());

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await run(['how does the indexer work'], makeRuntime(), 'text');

    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('No LLM configured'),
    );

    stderrSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // text format — human readable list of nodes
  // -------------------------------------------------------------------------
  it('formats text output with keywords and node names', async () => {
    const jsonResult = makeJsonResult();
    mocks.executeQueryNaturalLanguage.mockResolvedValueOnce(jsonResult);

    const output = await run(
      ['how does the indexer work', '--format', 'text'],
      makeRuntime(),
      'text',
    );

    expect(output).toContain('Keywords: indexer, work');
    expect(output).toContain('CallGraphIndexer');
    expect(output).toContain('QueryEngine');
  });
});
