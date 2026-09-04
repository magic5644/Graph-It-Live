#!/usr/bin/env node
/** Deterministic, local-only corpus for comparing bounded graph context retrieval. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateTokens, estimateTokenSavings } from '../src/shared/toon.ts';

export const BENCHMARK_VERSION = 2;
export const BENCHMARK_BOUNDS = Object.freeze({ scope: '**', depth: 2, maxNodes: 10, tokenBudget: 2000 });
export const REFERENCE_WORKFLOWS = Object.freeze([
  { id: 'locate-concept', question: 'where is idempotency policy defined?', mode: 'search', expected: ['file:src/ts/controller.ts', 'document:docs/ADR-001.md'] },
  { id: 'explain-file', question: 'explain the user controller file', mode: 'overview', seeds: ['src/ts/controller.ts'], expected: ['file:src/ts/controller.ts', 'symbol:src/ts/controller.ts:handleUser:3'] },
  { id: 'callers-callees', question: 'find callers and callees of handleUser', mode: 'neighbors', seeds: ['src/ts/controller.ts#handleUser'], expected: ['symbol:src/ts/controller.ts:handleUser:3'] },
  { id: 'controller-database', question: '', mode: 'path', from: 'src/ts/controller.ts#handleUser', to: 'src/ts/repository.ts#saveUser', expected: ['symbol:src/ts/controller.ts:handleUser:3', 'symbol:src/ts/repository.ts:saveUser:1'] },
  { id: 'refactor-interface', question: 'what depends on UserService?', mode: 'refactor', seeds: ['src/ts/controller.ts#UserService'], expected: ['symbol:src/ts/controller.ts:UserService:2'] },
  { id: 'document-symbol', question: 'what documentation explains handleUser?', mode: 'search', seeds: ['src/ts/controller.ts#handleUser'], expected: ['document:docs/ADR-001.md', 'rationale:docs/ADR-001.md:4'] },
]);

const FIXTURES = {
  'src/ts/types.ts': 'export type User = { id: string };\n',
  'src/ts/repository.ts': 'import type { User } from "./types";\nexport async function saveUser(user: User): Promise<void> { void user; }\n',
  'src/ts/controller.ts': 'import type { User } from "./types";\nimport { saveUser } from "./repository";\nexport interface UserService { save(user: User): Promise<void>; }\nexport async function handleUser(user: User): Promise<void> { await saveUser(user); }\nexport function loadUser(user: User): User { return user; }\n',
  'src/python/repository.py': 'def save_user(user):\n    return user\n',
  'src/rust/store.rs': 'pub fn save_user(user: &str) -> &str { user }\n',
  'tests/controller.test.ts': 'import { handleUser } from "../src/ts/controller";\ntest("handles a user", () => handleUser({ id: "1" }));\n',
  'src/cycleA.ts': 'import { cycleB } from "./cycleB";\nexport function cycleA() { return cycleB(); }\n',
  'src/cycleB.ts': 'import { cycleA } from "./cycleA";\nexport function cycleB() { return cycleA(); }\n',
  'src/ts/legacy.ts': 'export function resolveUser(user: string): string { return user; }\n',
  'src/ts/current.ts': 'export function resolveUser(user: string): string { return user.trim(); }\n',
  'src/ts/ambiguous.ts': 'export function chooseResolver(user: string): string { return resolveUser(user); }\n',
  'docs/ADR-001.md': '# Idempotency policy\n\nThe controller follows the repository write policy.\n\n<!-- WHY: retries must not create duplicate users -->\n[User controller](../src/ts/controller.ts)\n',
};

export function buildSharedCorpus() {
  const expectedNodeIds = [...new Set([
    ...Object.keys(FIXTURES).filter(filePath => /\.(ts|py|rs)$/.test(filePath)).map(filePath => `file:${filePath}`),
    ...REFERENCE_WORKFLOWS.flatMap(workflow => workflow.expected),
  ])];
  return {
    files: { ...FIXTURES },
    expectedNodeIds,
    expectedPaths: [...new Set(expectedNodeIds.map(nodeId => nodeId.split(':')[1]).filter(Boolean))],
    changedFile: 'src/ts/controller.ts',
  };
}

export function notSupportedGraphifyResult(capability, details = {}) {
  return { status: 'not-supported', capability, ...details };
}

export function measureComparableMetrics({ response, incrementalResponse, expectedNodeIds, expectedPath, request, responseText, latenciesMs }) {
  const returnedIds = (response.nodes ?? []).slice(0, 10).map(node => node.id);
  const expected = new Set(expectedNodeIds);
  const hits = returnedIds.filter(id => expected.has(id)).length;
  const edgeCount = response.edges?.length ?? 0;
  const staleEdges = response.edges?.filter(edge => edge.confidence === 'STALE').length ?? 0;
  const path = response.paths?.[0]?.nodeIds ?? [];
  return {
    precisionAt10: returnedIds.length === 0 ? 0 : hits / returnedIds.length,
    recallAt10: expected.size === 0 ? 0 : hits / expected.size,
    exactPathSuccess: expectedPath === undefined ? null : JSON.stringify(path) === JSON.stringify(expectedPath),
    ambiguityRate: (response.ambiguous?.length ?? 0) / Math.max(1, returnedIds.length),
    staleEdgeRate: staleEdges / Math.max(1, edgeCount),
    indexFresh: response.fresh ?? null,
    incrementalIndexFresh: incrementalResponse.fresh ?? null,
    incrementalRevisionChanged: response.indexRevision && incrementalResponse.indexRevision
      ? response.indexRevision !== incrementalResponse.indexRevision
      : null,
    nodeBoundRespected: (response.nodes?.length ?? 0) <= BENCHMARK_BOUNDS.maxNodes,
    tokenBudgetRespected: typeof response.tokenEstimate === 'number'
      ? response.tokenEstimate <= BENCHMARK_BOUNDS.tokenBudget
      : null,
    mcpInitializationTokens: null,
    requestTokens: estimateTokens(request),
    responseTokens: estimateTokens(responseText),
    continuationTokens: null,
    providerBillingTokens: null,
    toolCalls: null,
    cliCalls: 1,
    coldLatencyMs: latenciesMs.cold,
    warmLatencyMs: latenciesMs.warm,
    incrementalUpdateLatencyMs: latenciesMs.incrementalUpdate,
    continuationLatencyMs: null,
  };
}

function writeCorpus(root, corpus) {
  for (const [filePath, content] of Object.entries(corpus.files)) {
    const absolutePath = join(root, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
}

function childEnv() {
  const env = { ...process.env, GRAPH_IT_NO_STATS: '1', GRAPH_IT_DISABLE_UPDATE_CHECK: '1', GRAPHIFY_NO_TIPS: '1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.MOONSHOT_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  return env;
}

function cliArgs(workflow, workspaceRoot, format) {
  const args = ['--workspace', workspaceRoot, '--format', format, '--mode', workflow.mode, '--scope', BENCHMARK_BOUNDS.scope, '--depth', String(BENCHMARK_BOUNDS.depth), '--max-nodes', String(BENCHMARK_BOUNDS.maxNodes), '--token-budget', String(BENCHMARK_BOUNDS.tokenBudget)];
  if (workflow.question) args.push(workflow.question);
  if (workflow.from) args.push('--from', workflow.from);
  if (workflow.to) args.push('--to', workflow.to);
  for (const seed of workflow.seeds ?? []) args.push('--seeds', seed);
  return args;
}

function runCli(execFile, cliPath, workflow, workspaceRoot, format, env) {
  const started = performance.now();
  const output = execFile(process.execPath, [cliPath, 'context', ...cliArgs(workflow, workspaceRoot, format)], {
    cwd: workspaceRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return { output, elapsedMs: Math.round(performance.now() - started) };
}

function expectedPath(workflow) {
  return workflow.from && workflow.to ? workflow.expected : undefined;
}

function normalizeOutput(output, workspaceRoot) {
  return output
    .split(workspaceRoot).join('<workspace>')
    .replace(/("(?:indexRevision|revision)"\s*:\s*)"[^"]*"/g, '$1"<revision>"')
    .replace(/((?:indexRevision|revision)\s*:\s*)\S+/g, '$1<revision>')
    .replace(/("(?:mtime|mtimeMs|mtime_ns)"\s*:\s*)(?:"[^"]*"|[\d.]+)/g, '$1"<mtime>"')
    .replace(/((?:mtime|mtimeMs|mtime_ns)\s*:\s*)\S+/g, '$1<mtime>')
    .replace(/("nextCursor"\s*:\s*)"[^"]*"/g, '$1"<cursor>"');
}

function benchmarkRequest(workflow) {
  const { expected: _expected, ...request } = workflow;
  return { ...request, ...BENCHMARK_BOUNDS };
}

function graphifyPlan(workflow, graphPath) {
  const requested = { ...BENCHMARK_BOUNDS };
  const common = { requested, enforced: { scope: 'isolated-graph', depth: null, maxNodes: null, tokenBudget: null } };
  if (workflow.mode === 'path') {
    return {
      args: ['path', workflow.from, workflow.to, '--graph', graphPath],
      bounds: common,
      unsupported: ['depth', 'maxNodes', 'tokenBudget'],
    };
  }
  if (workflow.mode === 'overview' || workflow.mode === 'neighbors') {
    return {
      args: ['explain', workflow.seeds[0], '--graph', graphPath],
      bounds: common,
      unsupported: ['question', 'depth', 'maxNodes', 'tokenBudget'],
    };
  }
  if (workflow.mode === 'refactor') {
    return {
      args: ['affected', workflow.seeds[0], '--depth', String(BENCHMARK_BOUNDS.depth), '--graph', graphPath],
      bounds: { ...common, enforced: { ...common.enforced, depth: BENCHMARK_BOUNDS.depth } },
      unsupported: ['question', 'maxNodes', 'tokenBudget'],
    };
  }
  const question = workflow.seeds?.length
    ? `${workflow.question} seed: ${workflow.seeds.join(', ')}`
    : workflow.question;
  return {
    args: ['query', question, '--budget', String(BENCHMARK_BOUNDS.tokenBudget), '--graph', graphPath],
    bounds: { ...common, enforced: { ...common.enforced, depth: 2, tokenBudget: BENCHMARK_BOUNDS.tokenBudget } },
    unsupported: workflow.id === 'document-symbol' ? ['maxNodes', 'documentation-indexing'] : ['maxNodes'],
  };
}

function graphifyResults(workflows, graphifyCli, workspaceRoot, env, execFile) {
  const graphPath = '<workspace>/graphify-out/graph.json';
  if (!graphifyCli) {
    return workflows.map(workflow => notSupportedGraphifyResult('cli', {
      ...graphifyPlan(workflow, graphPath),
      unsupported: ['cli'],
    }));
  }
  try {
    const version = execFile(graphifyCli, ['--version'], { cwd: workspaceRoot, env, encoding: 'utf8' }).trim();
    return workflows.map(workflow => {
      const plan = graphifyPlan(workflow, graphPath);
      return notSupportedGraphifyResult(plan.unsupported[0], { version, ...plan });
    });
  } catch (error) {
    return workflows.map(() => ({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  }
}

export function runBenchmark({ cliPath, graphifyCli = process.env.GRAPHIFY_CLI, outputRoot, execFile = execFileSync } = {}) {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const resolvedCliPath = cliPath ?? join(repoRoot, 'dist', 'graph-it.js');
  if (!existsSync(resolvedCliPath)) throw new Error('Missing dist/graph-it.js. Run npm run build:cli before this corpus.');
  const corpus = buildSharedCorpus();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'graph-it-context-corpus-'));
  const reportRoot = resolve(outputRoot ?? join(repoRoot, '.reports', 'context-economy'));
  const runDir = join(reportRoot, 'latest');
  const env = childEnv();
  writeCorpus(workspaceRoot, corpus);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  try {
    const workflows = REFERENCE_WORKFLOWS.map(workflow => {
      writeFileSync(join(workspaceRoot, corpus.changedFile), corpus.files[corpus.changedFile], 'utf8');
      const cold = runCli(execFile, resolvedCliPath, workflow, workspaceRoot, 'json', env);
      const response = JSON.parse(cold.output);
      const warm = runCli(execFile, resolvedCliPath, workflow, workspaceRoot, 'json', env);
      const toon = runCli(execFile, resolvedCliPath, workflow, workspaceRoot, 'toon', env);
      writeFileSync(join(workspaceRoot, corpus.changedFile), `${corpus.files[corpus.changedFile]}\n// incremental-update marker: ${workflow.id}\n`, 'utf8');
      const incremental = runCli(execFile, resolvedCliPath, workflow, workspaceRoot, 'json', env);
      const incrementalResponse = JSON.parse(incremental.output);
      const rawOutputs = join(runDir, workflow.id);
      mkdirSync(rawOutputs, { recursive: true });
      const normalizedJson = normalizeOutput(cold.output, workspaceRoot);
      const normalizedToon = normalizeOutput(toon.output, workspaceRoot);
      writeFileSync(join(rawOutputs, 'json.txt'), normalizedJson, 'utf8');
      writeFileSync(join(rawOutputs, 'toon.txt'), normalizedToon, 'utf8');
      const request = benchmarkRequest(workflow);
      const requestText = JSON.stringify(request);
      return {
        id: workflow.id,
        request,
        graphItLive: {
          metrics: measureComparableMetrics({ response, incrementalResponse, expectedNodeIds: workflow.expected, expectedPath: expectedPath(workflow), request: requestText, responseText: normalizedJson, latenciesMs: { cold: cold.elapsedMs, warm: warm.elapsedMs, incrementalUpdate: incremental.elapsedMs } }),
          encoding: { ...estimateTokenSavings(normalizedJson, normalizedToon), providerBillingTokens: null },
        },
      };
    });
    const graphify = graphifyResults(REFERENCE_WORKFLOWS, graphifyCli, workspaceRoot, env, execFile);
    workflows.forEach((workflow, index) => { workflow.graphify = graphify[index]; });
    const report = {
      schemaVersion: BENCHMARK_VERSION,
      corpus: { files: Object.keys(corpus.files), expectedNodeIds: corpus.expectedNodeIds, changedFile: corpus.changedFile },
      workflows,
      providerUsage: notSupportedGraphifyResult('per-run-cli-billing-metrics'),
      notes: [
        'Representation tokens use the shared cl100k_base tokenizer on serialized request/response payloads.',
        'MCP initialization, MCP tool-call, provider billing, and absent continuation metrics are null because this runner invokes CLIs and does not observe those values.',
        'Graphify workflows are not executed when its documented CLI cannot preserve every requested bound; unsupported semantics are listed per workflow.',
        'Published Graphify ERPNext numbers are intentionally not compared with this local corpus.',
      ],
    };
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = runBenchmark({ outputRoot: process.argv[3] });
  console.log(`Context-economy corpus written to ${resolve(process.argv[3] ?? join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.reports', 'context-economy'), 'latest')}`);
  console.log(`Measured ${report.workflows.length} workflows; unobserved provider and MCP metrics remain null/not-supported.`);
}
