import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      tokenBudget: 4_000,
    });
    const response = createSuccessResponse(result, 1, workspaceRoot);
    const formatted = formatToolResponse(response, 'toon', 'graphitlive_graph_context');

    expect(formatted.content[0].text).toMatch(/^data\(/);
    expect(formatted.content[0].text).not.toContain(workspaceRoot);
    expect(formatted.structuredContent.data).toEqual(result);
    expect(formatted.structuredContent.metadata.workspaceRoot).toBe('.');
    expectPublicPathsToBeRelative(formatted.structuredContent.data);
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
