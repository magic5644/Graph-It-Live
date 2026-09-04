import path from 'node:path';
import { QueryEngine } from '../../analyzer/QueryEngine';
import type { CallGraphIndexer } from '../../analyzer/callgraph/CallGraphIndexer';
import type { Spider } from '../../analyzer/Spider';
import { GraphContextFederator } from '../../analyzer/graph-context/GraphContextFederator';
import { applyGraphContextBudgetPage } from '../../analyzer/graph-context/GraphContextBudget';
import {
  createGraphContextCursor,
  createGraphContextRequestHash,
  parseGraphContextCursor,
  type GraphContextCursorBinding,
} from '../../analyzer/graph-context/GraphContextCursor';
import { GraphContextRetriever } from '../../analyzer/graph-context/GraphContextRetriever';
import type {
  GraphContextRequest,
  GraphContextResponse,
  GraphContextSeed,
} from '../../shared/graph-context-types';
import { normalizePath } from '../../shared/path';
import { workerState } from '../shared/state';
import { validateFilePath, type GraphContextParams } from '../types';
import { ensureCallGraphReady } from './callgraph';

const DEFAULT_TOKEN_BUDGET = 4_000;
const DEFAULT_MAX_NODES = 200;
const MAX_CURSOR_STABILIZATION_ATTEMPTS = 16;

/** Executes the unified graph-context service against the worker's existing indexes. */
export async function executeGraphContext(
  params: GraphContextParams,
): Promise<GraphContextResponse> {
  const config = workerState.getConfig();
  validateRequestPaths(params, config.rootDir);

  const callGraphIndexer = await getCallGraphIndexer();
  return executeGraphContextWithIndexes(params, {
    rootDir: config.rootDir,
    spider: workerState.getSpider(),
    callGraphIndexer,
  });
}

export interface GraphContextIndexes {
  rootDir: string;
  spider: Spider;
  callGraphIndexer: CallGraphIndexer;
}

/** Runs the shared retrieval against an already-initialized extension index. */
export async function executeGraphContextWithIndexes(
  params: GraphContextParams,
  indexes: GraphContextIndexes,
): Promise<GraphContextResponse> {
  validateRequestPaths(params, indexes.rootDir);

  const request = normalizeRequest(params, indexes.rootDir);
  const incomingCursor = request.cursor === undefined
    ? undefined
    : parseGraphContextCursor(request.cursor);
  const queryEngine = new QueryEngine(indexes.callGraphIndexer.getDb(), null);
  const retriever = new GraphContextRetriever({
    snapshotProvider: new GraphContextFederator(indexes.spider, indexes.callGraphIndexer),
    queryEngine,
    dependentsProvider: indexes.spider,
    workspaceRoot: normalizePath(indexes.rootDir),
    collectAllCandidates: true,
  });
  const unbudgetedResponse = await retriever.retrieve(request);
  const binding = createCursorBinding(request, indexes.rootDir, unbudgetedResponse.indexRevision);
  const offset = incomingCursor === undefined
    ? 0
    : parseGraphContextCursor(request.cursor as string, binding).offset;

  return applyBudgetWithCursor(
    unbudgetedResponse,
    request.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    offset,
    binding,
    request.maxNodes ?? DEFAULT_MAX_NODES,
  );
}

async function getCallGraphIndexer(): Promise<CallGraphIndexer> {
  const config = workerState.getConfig();
  const workspaceRoot = normalizePath(config.rootDir);
  if (
    workerState.callGraphIndexer
    && normalizePath(workerState.callGraphIndexedRoot ?? '') === workspaceRoot
  ) {
    return workerState.callGraphIndexer;
  }

  await ensureCallGraphReady();

  const indexer = workerState.callGraphIndexer;
  if (!indexer || normalizePath(workerState.callGraphIndexedRoot ?? '') !== workspaceRoot) {
    throw new Error('Call graph indexer not initialized for the current workspace.');
  }
  return indexer;
}

function validateRequestPaths(params: GraphContextParams, workspaceRoot: string): void {
  for (const seed of params.seeds ?? []) validateSeedPath(seed, workspaceRoot);
  if (params.from !== undefined) validateSeedPath(params.from, workspaceRoot);
  if (params.to !== undefined) validateSeedPath(params.to, workspaceRoot);
  if (params.scope !== undefined) validateFilePath(params.scope || '**', workspaceRoot);
}

function validateSeedPath(seed: GraphContextSeed, workspaceRoot: string): void {
  if (seed.filePath !== undefined) validateFilePath(seed.filePath, workspaceRoot);
}

function normalizeRequest(
  params: GraphContextParams,
  workspaceRoot: string,
): GraphContextRequest {
  const seeds = params.seeds?.map(seed => normalizeSeed(seed, workspaceRoot));
  const from = params.from === undefined ? undefined : normalizeSeed(params.from, workspaceRoot);
  const to = params.to === undefined ? undefined : normalizeSeed(params.to, workspaceRoot);
  const options = {
    mode: params.mode ?? inferEndpointOnlyMode(params),
    relations: params.relations,
    scope: normalizeScope(params.scope, workspaceRoot),
    depth: params.depth,
    maxNodes: params.maxNodes,
    tokenBudget: params.tokenBudget,
    directed: params.directed,
    cursor: params.cursor,
    format: params.format,
  };

  if (params.question !== undefined && params.question.trim().length > 0) {
    return { ...options, question: params.question, seeds, from, to };
  }
  if (seeds !== undefined && seeds.length > 0) {
    return { ...options, seeds: [seeds[0], ...seeds.slice(1)] };
  }
  if (from === undefined || to === undefined) {
    throw new Error('Graph context request must include a question, seeds, or both endpoints.');
  }
  return { ...options, from, to };
}

function inferEndpointOnlyMode(params: GraphContextParams): 'path' | undefined {
  const hasQuestion = params.question !== undefined && params.question.trim().length > 0;
  const hasSeeds = (params.seeds?.length ?? 0) > 0;
  return !hasQuestion && !hasSeeds && params.from !== undefined && params.to !== undefined
    ? 'path'
    : undefined;
}

function normalizeSeed(seed: GraphContextSeed, workspaceRoot: string): GraphContextSeed {
  return {
    ...seed,
    filePath: seed.filePath === undefined
      ? undefined
      : toWorkspaceRelativePath(seed.filePath, workspaceRoot),
  };
}

function normalizeScope(scope: string | undefined, workspaceRoot: string): string {
  if (scope === undefined || scope.length === 0) return '**';
  return toWorkspaceRelativePath(scope, workspaceRoot);
}

function toWorkspaceRelativePath(filePath: string, workspaceRoot: string): string {
  const normalizedRoot = normalizePath(path.resolve(workspaceRoot));
  const absolutePath = normalizePath(path.resolve(workspaceRoot, filePath));
  const relativePath = normalizePath(path.relative(normalizedRoot, absolutePath));
  return relativePath.length === 0 ? '.' : relativePath;
}

function createCursorBinding(
  request: GraphContextRequest,
  workspaceRoot: string,
  revision: string,
): GraphContextCursorBinding {
  return {
    revision,
    requestHash: createGraphContextRequestHash(request, workspaceRoot),
    scope: request.scope ?? '**',
    mode: request.mode ?? 'search',
  };
}

function applyBudgetWithCursor(
  response: GraphContextResponse,
  tokenBudget: number,
  offset: number,
  binding: GraphContextCursorBinding,
  maxNodes: number,
): GraphContextResponse {
  let nextCursor: string | undefined;

  for (let attempt = 0; attempt < MAX_CURSOR_STABILIZATION_ATTEMPTS; attempt += 1) {
    const source = nextCursor === undefined ? response : { ...response, nextCursor };
    const page = applyGraphContextBudgetPage(source, tokenBudget, offset, maxNodes);
    if (page.nextOffset === undefined) {
      return nextCursor === undefined
        ? page.response
        : applyGraphContextBudgetPage(response, tokenBudget, offset, maxNodes).response;
    }

    const cursor = createGraphContextCursor({ ...binding, offset: page.nextOffset });
    if (cursor === nextCursor) return page.response;
    nextCursor = cursor;
  }

  throw new Error('Graph context cursor could not be stabilized within the token budget.');
}
