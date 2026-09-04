#!/usr/bin/env node
/** Deterministic, local-only corpus for comparing bounded graph context retrieval. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateTokens, estimateTokenSavings } from '../src/shared/toon.ts';

export const BENCHMARK_VERSION = 1;
export const REFERENCE_WORKFLOWS = Object.freeze([
  { id: 'locate-concept', question: 'where is idempotency policy defined?', mode: 'search', expected: ['file:src/ts/controller.ts', 'document:docs/ADR-001.md'] },
  { id: 'explain-file', question: 'explain the user controller file', mode: 'overview', expected: ['file:src/ts/controller.ts', 'symbol:src/ts/controller.ts:handleUser:4'] },
  { id: 'callers-callees', question: 'find callers and callees of handleUser', mode: 'neighbors', seeds: ['src/ts/controller.ts#handleUser'], expected: ['symbol:src/ts/controller.ts:handleUser:4'] },
  { id: 'controller-database', question: '', mode: 'path', from: 'src/ts/controller.ts#handleUser', to: 'src/ts/repository.ts#saveUser', expected: ['symbol:src/ts/controller.ts:handleUser:4', 'symbol:src/ts/repository.ts:saveUser:2'] },
  { id: 'refactor-interface', question: 'what depends on UserService?', mode: 'refactor', seeds: ['src/ts/controller.ts#UserService'], expected: ['symbol:src/ts/controller.ts:UserService:3'] },
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

export function notSupportedGraphifyResult(capability) {
  return { status: 'not-supported', capability };
}

export function measureComparableMetrics({ response, expectedNodeIds, expectedPath, request, responseText, continuationText, toolCalls, latenciesMs }) {
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
    mcpInitializationTokens: 0,
    requestTokens: estimateTokens(request),
    responseTokens: estimateTokens(responseText),
    continuationTokens: estimateTokens(continuationText),
    providerBillingTokens: null,
    toolCalls,
    coldLatencyMs: latenciesMs.cold,
    warmLatencyMs: latenciesMs.warm,
    incrementalUpdateLatencyMs: latenciesMs.incrementalUpdate,
  };
}

function writeCorpus(root, corpus) {
  for (const [filePath, content] of Object.entries(corpus.files)) {
    const absolutePath = join(root, filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
}

function childEnv(statsHome) {
  const env = { ...process.env, HOME: statsHome, GRAPH_IT_NO_STATS: '0', GRAPH_IT_DISABLE_UPDATE_CHECK: '1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  return env;
}

function cliArgs(workflow, workspaceRoot, format) {
  const args = ['--workspace', workspaceRoot, '--format', format, '--mode', workflow.mode, '--scope', '**', '--depth', '3', '--max-nodes', '10', '--token-budget', '2000'];
  if (workflow.question) args.push(workflow.question);
  if (workflow.from) args.push('--from', workflow.from);
  if (workflow.to) args.push('--to', workflow.to);
  for (const seed of workflow.seeds ?? []) args.push('--seeds', seed);
  return args;
}

function runCli(cliPath, workflow, workspaceRoot, format, env) {
  const started = performance.now();
  const output = execFileSync(process.execPath, [cliPath, 'context', ...cliArgs(workflow, workspaceRoot, format)], {
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

function runGraphify(workflow, workspaceRoot, env) {
  const graphify = process.env.GRAPHIFY_CLI;
  if (!graphify) return notSupportedGraphifyResult('cli');
  try {
    const args = [workflow.question, '--workspace', workspaceRoot, '--scope', '**', '--depth', '3', '--token-budget', '2000'];
    if (workflow.from) args.push('--from', workflow.from);
    if (workflow.to) args.push('--to', workflow.to);
    for (const seed of workflow.seeds ?? []) args.push('--seed', seed);
    const output = execFileSync(graphify, args, { cwd: workspaceRoot, env, encoding: 'utf8' });
    return { status: 'available', output };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

export function runBenchmark({ cliPath, outputRoot } = {}) {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const resolvedCliPath = cliPath ?? join(repoRoot, 'dist', 'graph-it.js');
  if (!existsSync(resolvedCliPath)) throw new Error('Missing dist/graph-it.js. Run npm run build:cli before this corpus.');
  const corpus = buildSharedCorpus();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'graph-it-context-corpus-'));
  const statsHome = mkdtempSync(join(tmpdir(), 'graph-it-context-stats-'));
  const reportRoot = resolve(outputRoot ?? join(repoRoot, '.reports', 'context-economy'));
  const runDir = join(reportRoot, 'latest');
  const env = childEnv(statsHome);
  writeCorpus(workspaceRoot, corpus);
  mkdirSync(runDir, { recursive: true });
  try {
    const workflows = REFERENCE_WORKFLOWS.map(workflow => {
      const cold = runCli(resolvedCliPath, workflow, workspaceRoot, 'json', env);
      const warm = runCli(resolvedCliPath, workflow, workspaceRoot, 'json', env);
      writeFileSync(join(workspaceRoot, corpus.changedFile), `${corpus.files[corpus.changedFile]}\n// deterministic incremental-update marker\n`, 'utf8');
      const incremental = runCli(resolvedCliPath, workflow, workspaceRoot, 'json', env);
      const toon = runCli(resolvedCliPath, workflow, workspaceRoot, 'toon', env);
      const response = JSON.parse(cold.output);
      const rawOutputs = join(runDir, workflow.id);
      mkdirSync(rawOutputs, { recursive: true });
      writeFileSync(join(rawOutputs, 'json.txt'), cold.output, 'utf8');
      writeFileSync(join(rawOutputs, 'toon.txt'), toon.output, 'utf8');
      const request = JSON.stringify(workflow);
      return {
        id: workflow.id,
        request: workflow,
        graphItLive: {
          metrics: measureComparableMetrics({ response, expectedNodeIds: workflow.expected, expectedPath: expectedPath(workflow), request, responseText: cold.output, continuationText: response.nextCursor ? toon.output : '', toolCalls: 1, latenciesMs: { cold: cold.elapsedMs, warm: warm.elapsedMs, incrementalUpdate: incremental.elapsedMs } }),
          encoding: { ...estimateTokenSavings(cold.output, toon.output), providerBillingTokens: null },
        },
        graphify: runGraphify(workflow, workspaceRoot, env),
      };
    });
    const snapshots = readStats(statsHome);
    if (snapshots.some(snapshot => snapshot.llmUsage?.calls !== 0 || snapshot.llmUsage?.tokensUsed !== 0)) throw new Error('The local corpus recorded LLM usage.');
    const report = {
      schemaVersion: BENCHMARK_VERSION,
      corpus: { files: Object.keys(corpus.files), expectedNodeIds: corpus.expectedNodeIds, changedFile: corpus.changedFile },
      workflows,
      persistedStats: snapshots,
      notes: [
        'Representation tokens use the shared cl100k_base tokenizer on serialized request/response payloads.',
        'providerBillingTokens is null: local CLI retrieval makes no provider request, so representation tokens are not billing tokens.',
        'Graphify capabilities unavailable in this environment are reported as not-supported.',
        'Published Graphify ERPNext numbers are intentionally not compared with this local corpus.',
      ],
    };
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(statsHome, { recursive: true, force: true });
  }
}

function readStats(statsHome) {
  const statsDir = join(statsHome, '.graph-it', 'stats');
  return existsSync(statsDir)
    ? readdirSync(statsDir).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(readFileSync(join(statsDir, file), 'utf8')))
    : [];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = runBenchmark({ outputRoot: process.argv[3] });
  console.log(`Context-economy corpus written to ${resolve(process.argv[3] ?? join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.reports', 'context-economy'), 'latest')}`);
  console.log(`Verified ${report.workflows.length} workflows with zero provider LLM usage.`);
}
