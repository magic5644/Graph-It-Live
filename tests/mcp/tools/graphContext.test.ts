import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Parser } from '../../../src/analyzer/Parser';
import { Spider } from '../../../src/analyzer/Spider';
import { SpiderBuilder } from '../../../src/analyzer/SpiderBuilder';
import {
  CallGraphIndexer,
  type CallGraphEdge,
  type CallGraphNode,
} from '../../../src/analyzer/callgraph/CallGraphIndexer';
import {
  createGraphContextCursor,
  createGraphContextRequestHash,
} from '../../../src/analyzer/graph-context/GraphContextCursor';
import { PathResolver } from '../../../src/analyzer/utils/PathResolver';
import { formatToolResponse } from '../../../src/mcp/responseFormatter';
import { workerState } from '../../../src/mcp/shared/state';
import { executeGraphContext } from '../../../src/mcp/tools/graphContext';
import {
  createErrorResponse,
  createSuccessResponse,
  GraphContextParamsSchema,
  validateToolParams,
} from '../../../src/mcp/types';
import { invokeTool } from '../../../src/mcp/worker/invokeTool';
import { normalizePath } from '../../../src/shared/path';
import type { GraphContextResponse } from '../../../src/shared/graph-context-types';

const require = createRequire(import.meta.url);
const SQL_WASM_PATH: string = require.resolve('sql.js/dist/sql-wasm.wasm');

describe('graph_context MCP contract', () => {
  let workspaceRoot: string;
  let spider: Spider;
  let indexer: CallGraphIndexer;

  beforeEach(async () => {
    workspaceRoot = normalizePath(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-context-mcp-')));
    await writeFixture(workspaceRoot);

    spider = new SpiderBuilder()
      .withRootDir(workspaceRoot)
      .withMaxDepth(3)
      .withReverseIndex(true)
      .build();
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
    await indexFixture(indexer, workspaceRoot);

    workerState.spider = spider;
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, workspaceRoot);
    workerState.config = {
      rootDir: workspaceRoot,
      excludeNodeModules: true,
      maxDepth: 3,
    };
    workerState.callGraphIndexer = indexer;
    workerState.callGraphIndexedRoot = workspaceRoot;
    workerState.isReady = true;
  });

  afterEach(async () => {
    await spider.dispose();
    workerState.spider = null;
    workerState.reset();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('accepts search, path, and impact request shapes', () => {
    const requests = [
      { question: 'Where is UserService?', mode: 'search' as const },
      {
        mode: 'path' as const,
        from: { filePath: 'src/controllers/UserController.ts', symbolName: 'UserController' },
        to: { filePath: 'src/data/UserRepository.ts', symbolName: 'UserRepository' },
      },
      {
        mode: 'impact' as const,
        seeds: [{ filePath: 'src/services/UserService.ts', symbolName: 'UserService' }],
      },
    ];

    for (const request of requests) {
      expect(GraphContextParamsSchema.safeParse(request).success).toBe(true);
    }
    expect(GraphContextParamsSchema.safeParse({ question: 'UserService', detail: 'compact' }).success).toBe(true);
    expect(GraphContextParamsSchema.safeParse({ question: 'UserService', detail: 'verbose' }).success).toBe(false);
  });

  it('infers path mode for endpoint-only requests', async () => {
    const request = {
      from: { filePath: 'src/controllers/UserController.ts', symbolName: 'UserController' },
      to: { filePath: 'src/data/UserRepository.ts', symbolName: 'UserRepository' },
      relations: ['CALLS'] as const,
      depth: 3,
      directed: true,
      tokenBudget: 1_000,
    };
    const parsed = GraphContextParamsSchema.parse(request);

    expect(parsed.mode).toBe('path');
    await expect(executeGraphContext(parsed)).resolves.toMatchObject({
      mode: 'path',
      paths: [expect.objectContaining({ hops: 2 })],
    });
  });

  it('rejects a pre-aborted shared request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeGraphContext(
      { question: 'UserService' },
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects path mode without both endpoints and endpoints in non-path modes', () => {
    expect(GraphContextParamsSchema.safeParse({
      question: 'Find a path',
      mode: 'path',
    }).success).toBe(false);
    expect(GraphContextParamsSchema.safeParse({
      mode: 'path',
      from: { label: 'start' },
    }).success).toBe(false);
    expect(GraphContextParamsSchema.safeParse({
      mode: 'search',
      from: { label: 'start' },
      to: { label: 'end' },
    }).success).toBe(false);
    expect(GraphContextParamsSchema.safeParse({
      question: 'Find related code',
      from: { label: 'start' },
      to: { label: 'end' },
    }).success).toBe(false);
  });

  it('bounds seeds and accepts at most twelve unique relations', () => {
    const allRelations = [
      'CONTAINS',
      'IMPORTS',
      'CALLS',
      'INHERITS',
      'IMPLEMENTS',
      'USES',
      'TESTED_BY',
      'IMPACTED_BY',
      'BELONGS_TO',
      'REFERENCES',
      'EXPLAINS',
      'DOCUMENTS',
    ];

    expect(GraphContextParamsSchema.safeParse({
      seeds: Array.from({ length: 501 }, (_, index) => ({ label: `seed-${index}` })),
    }).success).toBe(false);
    expect(GraphContextParamsSchema.safeParse({
      question: 'relationships',
      relations: allRelations,
    }).success).toBe(true);
    expect(GraphContextParamsSchema.safeParse({
      question: 'relationships',
      relations: [...allRelations, 'CALLS'],
    }).success).toBe(false);
    expect(GraphContextParamsSchema.safeParse({
      question: 'relationships',
      relations: ['CALLS', 'CALLS'],
    }).success).toBe(false);
  });

  it('rejects empty and one-sided path requests through the shared tool schema', () => {
    expect(validateToolParams('graph_context', {}).success).toBe(false);
    expect(validateToolParams('graph_context', { from: { label: 'start' } }).success).toBe(false);
    expect(validateToolParams('graph_context', { to: { label: 'end' } }).success).toBe(false);
    expect(validateToolParams('graph_context', { seeds: [] }).success).toBe(false);
  });

  it('retrieves scoped search results from the existing worker indexes', async () => {
    const originalIndexer = workerState.callGraphIndexer;
    const result = await executeGraphContext({
      question: 'UserService',
      mode: 'search',
      scope: 'src/services/**',
      tokenBudget: 500,
    });

    expect(workerState.callGraphIndexer).toBe(originalIndexer);
    expect(result.mode).toBe('search');
    expect(result.seeds.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.every(node => node.path?.startsWith('src/services/') ?? true)).toBe(true);
  });

  it('returns a directed controller-to-repository path', async () => {
    const result = await executeGraphContext({
      mode: 'path',
      from: { filePath: 'src/controllers/UserController.ts', symbolName: 'UserController' },
      to: { filePath: 'src/data/UserRepository.ts', symbolName: 'UserRepository' },
      relations: ['CALLS'],
      depth: 3,
      directed: true,
      tokenBudget: 1_000,
    });

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].hops).toBe(2);
    expect(result.edges.map(edge => edge.relation)).toEqual(['CALLS', 'CALLS']);
  });

  it('returns direct incoming callers for impact requests', async () => {
    const result = await executeGraphContext({
      mode: 'impact',
      seeds: [{ filePath: 'src/services/UserService.ts', symbolName: 'UserService' }],
      relations: ['CALLS'],
      depth: 1,
      tokenBudget: 4_000,
    });

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'UserController', path: 'src/controllers/UserController.ts' }),
      expect.objectContaining({ name: 'UserServiceTest', path: 'tests/UserService.test.ts' }),
    ]));
  });

  it('returns a compact overview with internal hubs and deterministic communities', async () => {
    const snapshotRead = vi.spyOn(spider, 'getReadOnlyDependencyGraph');
    const result = await executeGraphContext({
      question: 'Give me a graph overview',
      mode: 'overview',
      maxNodes: 20,
      tokenBudget: 4_000,
    });
    const formatted = formatToolResponse(
      createSuccessResponse(result, 1, workspaceRoot),
      'toon',
      'graphitlive_graph_context',
    );

    expect(result.seeds[0]?.id).toBe('file:src/services/UserService.ts');
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file:src/services/UserService.ts', score: 4 }),
      expect.objectContaining({ kind: 'community', name: expect.stringMatching(/^Community \d+ \(\d+ nodes\)$/) }),
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'BELONGS_TO', confidence: 'INFERRED' }),
    ]));
    expect(result.nextQueries).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Inspect community \d+ \(\d+ nodes\)$/),
    ]));
    expect(snapshotRead).toHaveBeenCalledTimes(4);
    expect([...formatted.content[0].text.matchAll(/^([a-zA-Z_]+)\(/gm)].map(match => match[1])).toEqual([
      'graph_context',
      'seeds',
      'nodes',
      'edges',
      'paths',
      'ambiguous',
      'omitted',
      'nextQueries',
      'errors',
    ]);
    expect(formatted.content[0].text).not.toMatch(/assignments|graphStats|topHubs/);
  });

  it('continues maxNodes-truncated traversal without duplicates or lost candidates', async () => {
    const request = {
      mode: 'neighbors' as const,
      seeds: [{ filePath: 'src/services/UserService.ts', symbolName: 'UserService' }],
      relations: ['CALLS'] as const,
      maxNodes: 1,
      tokenBudget: 4_000,
    };
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const page = await executeGraphContext({ ...request, cursor });
      expect(page.nodes).toHaveLength(1);
      for (const node of page.nodes) {
        expect(seenIds.has(node.id)).toBe(false);
        seenIds.add(node.id);
        seenNames.add(node.name);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }

    expect(cursor).toBeUndefined();
    expect(seenNames).toEqual(new Set([
      'UserController',
      'UserRepository',
      'UserService',
      'UserServiceTest',
    ]));
  });

  it('rejects seed path traversal before executing the tool', async () => {
    const responses: import('../../../src/mcp/types').McpWorkerResponse[] = [];

    await invokeTool(
      'traversal-request',
      'graph_context',
      { seeds: [{ filePath: '../secret.ts' }] },
      response => responses.push(response),
    );

    expect(responses).toEqual([
      expect.objectContaining({
        type: 'error',
        requestId: 'traversal-request',
        code: 'SECURITY_ERROR',
        error: expect.stringMatching(/outside workspace/i),
      }),
    ]);
  });

  it('rejects a scope that escapes the workspace', async () => {
    await expect(executeGraphContext({
      question: 'UserService',
      scope: '../outside/**',
    })).rejects.toThrow(/workspace/i);
  });

  it('rejects a cursor bound to a stale index revision', async () => {
    const request = {
      question: 'UserService',
      mode: 'search' as const,
      scope: 'src/**',
      tokenBudget: 500,
    };
    const cursor = createGraphContextCursor({
      revision: 'stale-revision',
      requestHash: createGraphContextRequestHash(request, workspaceRoot),
      offset: 1,
      scope: 'src/**',
      mode: 'search',
    });

    await expect(executeGraphContext({ ...request, cursor })).rejects.toThrow(/revision/i);
  });

  it('formats public text as TOON while preserving structured JSON and relative paths', async () => {
    const result = await executeGraphContext({
      question: 'UserService',
      scope: 'src/**',
      maxNodes: 1,
      tokenBudget: 4_000,
    });
    const response = createSuccessResponse(result, 1, workspaceRoot);
    const formatted = formatToolResponse(response, 'toon', 'graphitlive_graph_context');

    expect(formatted.content[0].text).toMatch(/^graph_context\(/);
    expect(formatted.content[0].text).toContain('\nnodes(');
    expect(formatted.content[0].text).toContain('\nedges(');
    expect(formatted.content[0].text).toContain('\npaths(');
    expect(formatted.content[0].text).toContain('\nambiguous(');
    expect(formatted.content[0].text).toContain('\nomitted(nodes,edges)');
    expect(result.nextCursor).toBeDefined();
    expect(formatted.content[0].text).toContain(result.nextCursor as string);
    expect(formatted.content[0].text).not.toContain(workspaceRoot);
    expect(formatted.structuredContent.data).toEqual(result);
    expect(formatted.structuredContent.metadata.workspaceRoot).toBe('.');
    expectPublicPathsToBeRelative(formatted.structuredContent.data);
  });

  it('preserves graph-context errors in TOON text', () => {
    const formatted = formatToolResponse(
      createErrorResponse<GraphContextResponse>('Invalid graph request', 1, workspaceRoot),
      'toon',
      'graphitlive_graph_context',
    );

    expect(formatted.content[0].text).toContain('errors(message)');
    expect(formatted.content[0].text).toContain('Invalid graph request');
  });

  it('projects compact graph-context output for LLM consumers', async () => {
    const result = await executeGraphContext({
      question: 'UserService',
      scope: 'src/**',
      tokenBudget: 4_000,
    });
    const formatted = formatToolResponse(
      createSuccessResponse(result, 1, workspaceRoot),
      'json',
      'graphitlive_graph_context',
      'compact',
    );
    const compact = formatted.structuredContent.data as GraphContextResponse;

    expect(compact.nodes.length).toBeLessThanOrEqual(8);
    expect(compact.nextCursor).toBeUndefined();
    expect(compact.nodes[0]).not.toHaveProperty('language');
    expect(compact.nodes[0]).not.toHaveProperty('score');
  });

  it('formats public text as JSON when requested', async () => {
    const result = await executeGraphContext({
      question: 'UserService',
      format: 'json',
      tokenBudget: 4_000,
    });
    const formatted = formatToolResponse(
      createSuccessResponse(result, 1, workspaceRoot),
      'json',
      'graphitlive_graph_context',
    );
    const parsed = JSON.parse(formatted.content[0].text) as {
      success: boolean;
      data: GraphContextResponse;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.data.mode).toBe('search');
    expect(parsed.data.nodes).toEqual(result.nodes);
  });
});

function expectPublicPathsToBeRelative(response: GraphContextResponse): void {
  for (const node of response.nodes) {
    if (node.path !== undefined) expect(path.isAbsolute(node.path)).toBe(false);
  }
  for (const edge of response.edges) {
    if (edge.sourcePath !== undefined) expect(path.isAbsolute(edge.sourcePath)).toBe(false);
    if (edge.evidence?.sourcePath !== undefined) {
      expect(path.isAbsolute(edge.evidence.sourcePath)).toBe(false);
    }
  }
}

async function writeFixture(workspaceRoot: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(workspaceRoot, 'src/controllers'), { recursive: true }),
    fs.mkdir(path.join(workspaceRoot, 'src/services'), { recursive: true }),
    fs.mkdir(path.join(workspaceRoot, 'src/data'), { recursive: true }),
    fs.mkdir(path.join(workspaceRoot, 'tests'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(workspaceRoot, 'src/controllers/UserController.ts'),
      "import { UserService } from '../services/UserService';\nexport function UserController() { return UserService(); }\n",
    ),
    fs.writeFile(
      path.join(workspaceRoot, 'src/services/UserService.ts'),
      "import { UserRepository } from '../data/UserRepository';\nexport function UserService() { return UserRepository(); }\n",
    ),
    fs.writeFile(
      path.join(workspaceRoot, 'src/data/UserRepository.ts'),
      "export function UserRepository() { return 'user'; }\n",
    ),
    fs.writeFile(
      path.join(workspaceRoot, 'tests/UserService.test.ts'),
      "import { UserService } from '../src/services/UserService';\nexport function UserServiceTest() { return UserService(); }\n",
    ),
  ]);
}

async function indexFixture(indexer: CallGraphIndexer, workspaceRoot: string): Promise<void> {
  const controllerPath = normalizePath(path.join(workspaceRoot, 'src/controllers/UserController.ts'));
  const servicePath = normalizePath(path.join(workspaceRoot, 'src/services/UserService.ts'));
  const repositoryPath = normalizePath(path.join(workspaceRoot, 'src/data/UserRepository.ts'));
  const testPath = normalizePath(path.join(workspaceRoot, 'tests/UserService.test.ts'));
  const controller = makeNode(controllerPath, 'UserController', 2);
  const service = makeNode(servicePath, 'UserService', 2);
  const repository = makeNode(repositoryPath, 'UserRepository', 1);
  const test = makeNode(testPath, 'UserServiceTest', 2);

  await Promise.all([
    indexFile(indexer, controllerPath, [controller], [makeEdge(controller, service, 2)]),
    indexFile(indexer, servicePath, [service], [makeEdge(service, repository, 2)]),
    indexFile(indexer, repositoryPath, [repository]),
    indexFile(indexer, testPath, [test], [makeEdge(test, service, 2)]),
  ]);
}

async function indexFile(
  indexer: CallGraphIndexer,
  filePath: string,
  nodes: CallGraphNode[],
  edges: CallGraphEdge[] = [],
): Promise<void> {
  const mtime = (await fs.stat(filePath)).mtimeMs;
  indexer.indexFile(nodes, edges, filePath, 'typescript', mtime);
}

function makeNode(filePath: string, name: string, startLine: number): CallGraphNode {
  return {
    id: `${filePath}:${name}:${startLine}`,
    name,
    type: 'function',
    lang: 'typescript',
    path: filePath,
    folder: normalizePath(path.dirname(filePath)),
    startLine,
    endLine: startLine,
    startCol: 0,
    isExported: true,
  };
}

function makeEdge(source: CallGraphNode, target: CallGraphNode, sourceLine: number): CallGraphEdge {
  return {
    sourceId: source.id,
    targetId: target.id,
    typeRelation: 'CALLS',
    sourceLine,
  };
}
