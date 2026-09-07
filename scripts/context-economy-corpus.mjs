#!/usr/bin/env node
/** Deterministic, local-only corpus for comparing bounded graph context retrieval. */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateTokens, estimateTokenSavings } from '../src/shared/toon.ts';

export const BENCHMARK_VERSION = 3;
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

export function normalizeOutput(output, workspaceRoot) {
  const normalizedToon = output.replace(
    /^graph_context\(([^)\r\n]*)\)\r?\n\[([^\r\n]*)\]/m,
    (match, header, row) => {
      const fields = header.split(',');
      const values = row.split(',');
      for (const field of ['indexRevision', 'revision']) {
        const index = fields.indexOf(field);
        if (index >= 0 && index < values.length) values[index] = '<revision>';
      }
      const cursorIndex = fields.indexOf('nextCursor');
      if (cursorIndex >= 0 && cursorIndex < values.length) values[cursorIndex] = '<cursor>';
      return `${match.slice(0, match.indexOf('['))}[${values.join(',')}]`;
    },
  );

  return normalizedToon
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

export function graphifyPlan(workflow, graphPath) {
  const requested = { ...BENCHMARK_BOUNDS };
  const common = { requested, enforced: { scope: 'isolated-graph', depth: null, maxNodes: null, tokenBudget: null } };
  if (workflow.mode === 'path') {
    return {
      args: ['path', workflow.from, workflow.to, '--graph', graphPath],
      comparison: 'equivalent',
      bounds: common,
      unsupported: [],
    };
  }
  if (workflow.mode === 'overview' || workflow.mode === 'neighbors') {
    return {
      args: ['explain', 'handleUser', '--graph', graphPath],
      comparison: workflow.mode === 'neighbors' ? 'partial' : 'adapted',
      bounds: common,
      unsupported: workflow.mode === 'neighbors' ? ['directional-callers-callees'] : [],
    };
  }
  if (workflow.mode === 'refactor') {
    return {
      args: ['affected', 'UserService', '--depth', String(BENCHMARK_BOUNDS.depth), '--graph', graphPath],
      comparison: 'equivalent',
      bounds: { ...common, enforced: { ...common.enforced, depth: BENCHMARK_BOUNDS.depth } },
      unsupported: [],
    };
  }
  if (workflow.id === 'document-symbol') {
    return {
      args: [],
      comparison: 'not-supported',
      bounds: common,
      unsupported: ['documentation-indexing'],
    };
  }
  const question = workflow.seeds?.length
    ? `${workflow.question} seed: ${workflow.seeds.join(', ')}`
    : workflow.question;
  return {
    args: ['query', question, '--budget', String(BENCHMARK_BOUNDS.tokenBudget), '--graph', graphPath],
    comparison: workflow.id === 'locate-concept' ? 'partial' : 'adapted',
    bounds: { ...common, enforced: { ...common.enforced, depth: 2, tokenBudget: BENCHMARK_BOUNDS.tokenBudget } },
    unsupported: workflow.id === 'locate-concept' ? ['documentation-indexing'] : [],
  };
}

function expectedNodeNeedle(nodeId) {
  const value = nodeId.replace(/^(file|symbol|document|rationale):/, '');
  const parts = value.split(':');
  if (nodeId.startsWith('symbol:')) return `${parts[0]}#${parts[1]}`;
  return parts[0];
}

function expectedNodeNeedles(nodeId) {
  const needles = [expectedNodeNeedle(nodeId)];
  if (nodeId.startsWith('symbol:')) needles.push(nodeId.split(':')[2]);
  return needles;
}

function extractGraphifyCandidates(output) {
  return [
    ...[...output.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|md)(?:#[\w$.-]+)?/g)].map(match => match[0]),
    ...[...output.matchAll(/\b[\w$]+\(\)/g)].map(match => match[0].slice(0, -2)),
  ];
}

export function normalizeGraphifyResult({ output, elapsedMs, version, expectedNodeIds, expectedPath, workspaceRoot, plan = { comparison: 'adapted', args: [], bounds: {}, unsupported: [] } }) {
  const normalizedOutput = output.split(workspaceRoot).join('<workspace>');
  const candidates = extractGraphifyCandidates(normalizedOutput);
  const returnedIds = expectedNodeIds.filter(nodeId => candidates.some(candidate => expectedNodeNeedles(nodeId).some(needle => candidate.includes(needle))));
  const expectedPathFound = expectedPath?.every(nodeId => expectedNodeNeedles(nodeId).some(needle => normalizedOutput.includes(needle))) ?? null;
  const matchedCandidates = candidates.filter(candidate => expectedNodeIds.some(nodeId => expectedNodeNeedles(nodeId).some(needle => candidate.includes(needle))));
  const candidateCount = candidates.length;
  return {
    status: 'measured',
    comparison: plan.comparison,
    version,
    args: plan.args,
    bounds: plan.bounds,
    unsupported: plan.unsupported,
    output: normalizedOutput,
    metrics: {
      precisionAt10: candidateCount === 0 ? 0 : matchedCandidates.length / Math.min(10, candidateCount),
      recallAt10: expectedNodeIds.length === 0 ? 0 : returnedIds.length / expectedNodeIds.length,
      exactPathSuccess: expectedPathFound,
      nativeTokenBudgetEnforced: plan.args.includes('--budget'),
      observedTokens: estimateTokens(normalizedOutput),
      latencyMs: elapsedMs,
    },
  };
}

function graphifyResults(workflows, graphifyCli, workspaceRoot, corpus, env, execFile) {
  const graphifyWorkspaceRoot = mkdtempSync(join(tmpdir(), 'graphify-context-corpus-'));
  const graphPath = '<workspace>/graphify-out/graph.json';
  if (!graphifyCli) {
    rmSync(graphifyWorkspaceRoot, { recursive: true, force: true });
    return workflows.map(workflow => notSupportedGraphifyResult('cli', {
      ...graphifyPlan(workflow, graphPath),
      unsupported: ['cli'],
    }));
  }
  try {
    writeCorpus(graphifyWorkspaceRoot, {
      files: Object.fromEntries(Object.entries(corpus.files).filter(([filePath]) => !/\.md$/.test(filePath))),
    });
    const version = execFile(graphifyCli, ['--version'], { cwd: graphifyWorkspaceRoot, env, encoding: 'utf8' }).trim();
    execFile(graphifyCli, ['extract', graphifyWorkspaceRoot, '--no-cluster', '--out', graphifyWorkspaceRoot], { cwd: graphifyWorkspaceRoot, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    execFile(graphifyCli, ['cluster-only', graphifyWorkspaceRoot, '--no-viz', '--no-label'], { cwd: graphifyWorkspaceRoot, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return workflows.map(workflow => {
      const plan = graphifyPlan(workflow, graphPath);
      if (plan.comparison === 'not-supported') return { status: 'not-supported', version, ...plan };
      const started = performance.now();
      try {
        const output = execFile(graphifyCli, plan.args.map(arg => arg.replace('<workspace>', graphifyWorkspaceRoot)), { cwd: graphifyWorkspaceRoot, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        return normalizeGraphifyResult({ output, elapsedMs: Math.round(performance.now() - started), version, expectedNodeIds: workflow.expected, expectedPath: expectedPath(workflow), workspaceRoot: graphifyWorkspaceRoot, plan });
      } catch (error) {
        return { status: 'error', version, ...plan, error: error instanceof Error ? error.message : String(error) };
      }
    });
  } catch (error) {
    return workflows.map(() => ({ status: 'error', error: error instanceof Error ? error.message : String(error) }));
  } finally {
    rmSync(graphifyWorkspaceRoot, { recursive: true, force: true });
  }
}

function publishedMetric(value) {
  return typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : '—';
}

export function renderPublishedReport(report) {
  const rows = report.workflows.map(workflow => {
    const graphIt = workflow.graphItLive?.metrics ?? {};
    const graphify = workflow.graphify ?? {};
    const graphifyMetrics = graphify.metrics ?? {};
    return `| ${workflow.id} | ${graphify.comparison ?? '—'} | ${workflow.graphItLive ? 'measured' : '—'} | ${graphify.status ?? '—'} | ${publishedMetric(graphIt.precisionAt10)} / ${publishedMetric(graphIt.recallAt10)} | ${publishedMetric(graphifyMetrics.precisionAt10)} / ${publishedMetric(graphifyMetrics.recallAt10)} | ${publishedMetric(graphIt.responseTokens)} | ${publishedMetric(graphifyMetrics.observedTokens)} | ${publishedMetric(graphIt.warmLatencyMs)} | ${publishedMetric(graphifyMetrics.latencyMs)} | ${(graphify.unsupported ?? []).join(', ') || '—'} |`;
  });
  return [
    '# Graph context benchmark report',
    '',
    `Benchmark schema: ${report.schemaVersion}`, '',
    `Warm session: ${report.graphItLiveWarmSession?.status ?? '—'}${report.graphItLiveWarmSession?.status === 'measured' ? `; ${report.graphItLiveWarmSession.queryCount} queries reused one index; mean query ${publishedMetric(report.graphItLiveWarmSession.meanQueryLatencyMs)} ms` : ''}`,
    '',
    '| Workflow | Comparison | Graph-It-Live | Graphify | Precision / recall GIL | Precision / recall Graphify | Response tokens GIL | Native tokens Graphify | CLI warm GIL (ms) | Graphify query (ms) | Limitations |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows,
    '',
    'Statuses describe execution, while Comparison describes semantic comparability. Missing native limits are not treated as failed functionality; they are listed as limitations.',
    '',
  ].join('\n');
}

export function summarizeWarmSession({ indexingMs, queries }) {
  const totalQueryLatencyMs = queries.reduce((total, query) => total + query.elapsedMs, 0);
  return {
    indexReused: true,
    queryCount: queries.length,
    indexingLatencyMs: indexingMs,
    totalQueryLatencyMs,
    meanQueryLatencyMs: queries.length === 0 ? 0 : totalQueryLatencyMs / queries.length,
    totalSessionLatencyMs: indexingMs + totalQueryLatencyMs,
  };
}

function graphContextMcpParams(workflow) {
  const { expected: _expected, ...request } = benchmarkRequest(workflow);
  const parseSeed = raw => {
    const separator = raw.indexOf('#');
    return separator < 0
      ? { symbolName: raw }
      : { filePath: raw.slice(0, separator), symbolName: raw.slice(separator + 1) };
  };
  return {
    ...request,
    from: workflow.from ? parseSeed(workflow.from) : undefined,
    to: workflow.to ? parseSeed(workflow.to) : undefined,
    seeds: workflow.seeds?.map(parseSeed),
    response_format: 'json',
  };
}

function sendMcpRequest(child, id, method, params) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        child.stdout.off('data', onData);
        resolve(message);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function runWarmGraphItLiveSession({ cliPath, workspaceRoot, workflows, env, spawnProcess = spawn }) {
  const serverPath = join(dirname(cliPath), 'mcpServer.mjs');
  if (!existsSync(serverPath)) return { status: 'not-supported', reason: 'mcp-server-bundle-missing' };
  const child = spawnProcess(process.execPath, [serverPath], { cwd: workspaceRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'graph-context-benchmark', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const indexingStarted = performance.now();
    const workspaceResponse = await sendMcpRequest(child, 2, 'tools/call', {
      name: 'graphitlive_set_workspace',
      arguments: { workspacePath: workspaceRoot, response_format: 'json' },
    });
    if (workspaceResponse.error) return { status: 'error', error: workspaceResponse.error.message };
    const indexingMs = Math.round(performance.now() - indexingStarted);
    const queries = [];
    for (const [index, workflow] of workflows.entries()) {
      const started = performance.now();
      const response = await sendMcpRequest(child, index + 3, 'tools/call', {
        name: 'graphitlive_graph_context',
        arguments: graphContextMcpParams(workflow),
      });
      queries.push({ id: workflow.id, elapsedMs: Math.round(performance.now() - started), ok: !response.error });
    }
    return { status: 'measured', ...summarizeWarmSession({ indexingMs, queries }), queries };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  } finally {
    child.kill();
  }
}

export async function runBenchmark({ cliPath, graphifyCli = process.env.GRAPHIFY_CLI, outputRoot, execFile = execFileSync } = {}) {
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
    const warmSession = await runWarmGraphItLiveSession({ cliPath: resolvedCliPath, workspaceRoot, workflows: REFERENCE_WORKFLOWS, env });
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
    const graphify = graphifyResults(REFERENCE_WORKFLOWS, graphifyCli, workspaceRoot, corpus, env, execFile);
    workflows.forEach((workflow, index) => { workflow.graphify = graphify[index]; });
    const report = {
      schemaVersion: BENCHMARK_VERSION,
      corpus: { files: Object.keys(corpus.files), expectedNodeIds: corpus.expectedNodeIds, changedFile: corpus.changedFile },
      workflows,
      graphItLiveWarmSession: warmSession,
      providerUsage: notSupportedGraphifyResult('per-run-cli-billing-metrics'),
      notes: [
        'Representation tokens use the shared cl100k_base tokenizer on serialized request/response payloads.',
        'MCP initialization, MCP tool-call, provider billing, and absent continuation metrics are null because this runner invokes CLIs and does not observe those values.',
        'Graphify workflows use their documented native commands after a code-only extract and cluster-only preparation; semantic comparability and missing native bounds are reported separately.',
        'Published Graphify ERPNext numbers are intentionally not compared with this local corpus.',
      ],
    };
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(join(runDir, 'report.md'), renderPublishedReport(report), 'utf8');
    return report;
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runBenchmark({ outputRoot: process.argv[3] });
  console.log(`Context-economy corpus written to ${resolve(process.argv[3] ?? join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.reports', 'context-economy'), 'latest')}`);
  console.log(`Measured ${report.workflows.length} workflows; unobserved provider and MCP metrics remain null/not-supported.`);
}
