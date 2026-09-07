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
    returnedNodeCount: returnedIds.length,
    edgeCount,
    pathLength: path.length,
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
    matchedNodeIds: returnedIds,
    metrics: {
      precisionAt10: candidateCount === 0 ? 0 : matchedCandidates.length / Math.min(10, candidateCount),
      recallAt10: expectedNodeIds.length === 0 ? 0 : returnedIds.length / expectedNodeIds.length,
      exactPathSuccess: expectedPathFound,
      nativeTokenBudgetEnforced: plan.args.includes('--budget'),
      observedTokens: estimateTokens(normalizedOutput),
      latencyMs: elapsedMs,
      candidateCount,
      matchedNodeCount: returnedIds.length,
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

function publishedValue(value) {
  return typeof value === 'boolean' ? String(value) : publishedMetric(value);
}

function markdownCell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function graphifyVersion(report) {
  return report.workflows.find(workflow => workflow.graphify?.version)?.graphify.version ?? 'not-run';
}

export function renderPublishedReport(report) {
  const measured = report.workflows.filter(workflow => workflow.graphify?.status === 'measured');
  const comparisonCounts = Object.groupBy(report.workflows, workflow => workflow.graphify?.comparison ?? 'unknown');
  const rows = report.workflows.map(workflow => {
    const graphIt = workflow.graphItLive?.metrics ?? {};
    const graphify = workflow.graphify ?? {};
    const graphifyMetrics = graphify.metrics ?? {};
    return `| ${workflow.id} | ${graphify.comparison ?? '—'} | ${workflow.graphItLive ? 'measured' : '—'} | ${graphify.status ?? '—'} | ${publishedMetric(graphIt.precisionAt10)} / ${publishedMetric(graphIt.recallAt10)} | ${publishedMetric(graphifyMetrics.precisionAt10)} / ${publishedMetric(graphifyMetrics.recallAt10)} | ${publishedMetric(graphIt.responseTokens)} | ${publishedMetric(graphifyMetrics.observedTokens)} | ${publishedMetric(graphIt.warmLatencyMs)} | ${publishedMetric(graphifyMetrics.latencyMs)} | ${(graphify.unsupported ?? []).join(', ') || '—'} |`;
  });
  const detailRows = report.workflows.map(workflow => {
    const graphify = workflow.graphify ?? {};
    const metrics = graphify.metrics ?? {};
    return `| ${workflow.id} | ${markdownCell(workflow.request?.question || 'path query')} | ${graphify.comparison ?? '—'} | ${graphify.status ?? '—'} | ${publishedValue(workflow.graphItLive?.metrics?.exactPathSuccess)} | ${publishedValue(metrics.exactPathSuccess)} | ${publishedValue(workflow.graphItLive?.metrics?.nodeBoundRespected)} | ${publishedValue(workflow.graphItLive?.metrics?.tokenBudgetRespected)} | ${publishedValue(metrics.nativeTokenBudgetEnforced)} | ${workflow.graphItLive?.metrics?.returnedNodeCount ?? '—'} | ${metrics.matchedNodeCount ?? '—'} | ${markdownCell((graphify.unsupported ?? []).join(', ') || '—')} |`;
  });
  const commandRows = report.workflows.map(workflow => {
    const graphify = workflow.graphify ?? {};
    const graphifyCommand = graphify.args?.length ? ['graphify', ...graphify.args].join(' ') : '—';
    return `| ${workflow.id} | \`${markdownCell(['graph-it', 'context', ...(workflow.graphItLive?.requestArgs ?? [])].join(' '))}\` | ${graphifyCommand === '—' ? '—' : `\`${markdownCell(graphifyCommand)}\``} | ${graphify.comparison ?? '—'} |`;
  });
  const corpusRows = report.corpus.files.map(filePath => `| \`${filePath}\` | ${filePath.startsWith('docs/') ? 'documentation' : filePath.startsWith('tests/') ? 'test' : 'source'} |`);
  const warm = report.graphItLiveWarmSession;
  const outputExcerpts = report.workflows.flatMap(workflow => {
    const gil = workflow.graphItLive?.outputPreview ?? 'not retained';
    const graphify = workflow.graphify?.output ?? workflow.graphify?.error ?? 'not executed';
    const safe = output => String(output).slice(0, 1200).replaceAll('```', "''' ");
    return [
      `### ${workflow.id}`,
      '',
      '**Graph-It-Live output (first 1,200 characters):**',
      '',
      '```text',
      safe(gil),
      '```',
      '',
      '**Graphify output or error (first 1,200 characters):**',
      '',
      '```text',
      safe(graphify),
      '```',
      '',
    ];
  });
  return [
    '# Graph context benchmark report',
    '',
    `Benchmark schema: ${report.schemaVersion}`, '',
    '## Executive summary', '',
    `- Graph-It-Live CLI: \`${report.graphItLiveCli ?? 'local bundle'}\``,
    `- Graphify: \`${graphifyVersion(report)}\``,
    `- Workflows: ${report.workflows.length}; Graphify measured: ${measured.length}; Graphify not supported: ${report.workflows.length - measured.length}`,
    `- Comparability: equivalent=${comparisonCounts.equivalent?.length ?? 0}, adapted=${comparisonCounts.adapted?.length ?? 0}, partial=${comparisonCounts.partial?.length ?? 0}, not-supported=${comparisonCounts['not-supported']?.length ?? 0}`,
    `- Warm session: ${warm?.status ?? '—'}${warm?.status === 'measured' ? `; ${warm.queryCount} queries reused one index; mean query ${publishedMetric(warm.meanQueryLatencyMs)} ms` : ''}`,
    '',
    'This report does not produce a single global winner. A shorter response that returns no matching node is not scored as better than a larger response containing the expected evidence.',
    '',
    '## Methodology', '',
    '- Both tools analyze the same deterministic temporary corpus. The corpus is recreated for every run.',
    '- Graph-It-Live is measured through the bounded `context` gateway with the shared scope, depth, node and token bounds.',
    '- Graphify is prepared once with `extract --no-cluster` and `cluster-only --no-label --no-viz`, then queried with its native command.',
    '- `equivalent` means the user intent and relevant controls are directly comparable; `adapted` means identifiers or command shape were translated; `partial` means a capability gap remains; `not-supported` means no functional equivalent was executed.',
    '- Precision and recall use the workflow oracle, not an LLM judgment. Token counts are serialized representation estimates, not provider billing tokens.',
    '- Latency columns are not interchangeable: CLI warm includes one-shot process startup, while the warm session measures six requests after one persistent index build.',
    '',
    '## Corpus and oracle', '',
    `The corpus contains ${report.corpus.files.length} files and ${report.corpus.expectedNodeIds.length} expected node records. The expected records are the minimum facts required for each workflow; extra valid graph context can affect precision when it is outside that oracle.`,
    '',
    '| File | Role |',
    '|---|---|',
    ...corpusRows,
    '',
    '**Expected node IDs:**', '',
    ...report.corpus.expectedNodeIds.map(nodeId => `- \`${nodeId}\``),
    '',
    '## Bounds and measured fields', '',
    '| Field | Graph-It-Live | Graphify | Interpretation |',
    '|---|---|---|---|',
    `| Scope | \`${report.workflows[0]?.request.scope ?? '—'}\` | isolated code graph | Same fixture scope; Graphify excludes Markdown for code-only extraction |`,
    `| Depth | ${report.workflows[0]?.request.depth ?? '—'} | per-command or unavailable | Graphify ` + '`affected`' + ` supports depth; other commands do not expose the same bound |`,
    `| Max nodes | ${report.workflows[0]?.request.maxNodes ?? '—'} | not native | Graphify output is measured without claiming native truncation |`,
    `| Token budget | ${report.workflows[0]?.request.tokenBudget ?? '—'} | ` + '`query --budget`' + ` only | Native enforcement is reported per workflow |`,
    '| Evidence | structured nodes/edges/path metadata | native text normalized by the adapter | Normalization can only match evidence present in output |',
    '',
    '## Per-workflow results', '',
    '| Workflow | Question | Comparison | Graphify status | Exact path GIL | Exact path Graphify | GIL node bound | GIL token bound | Graphify native budget | GIL nodes returned | Graphify nodes matched | Limitations |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...detailRows,
    '',
    '| Workflow | Comparison | Graph-It-Live | Graphify | Precision / recall GIL | Precision / recall Graphify | Response tokens GIL | Native tokens Graphify | CLI warm GIL (ms) | Graphify query (ms) | Limitations |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows,
    '',
    '## Native command mappings', '',
    '| Workflow | Graph-It-Live invocation | Graphify invocation | Comparison |',
    '|---|---|---|---|',
    ...commandRows,
    '',
    '## Observed output excerpts', '',
    'These excerpts make the reported result inspectable without opening the raw artifacts. They are intentionally truncated; complete normalized outputs are stored in the per-workflow directories.',
    '',
    ...outputExcerpts,
    '## Warm-session profile', '',
    warm?.status === 'measured'
      ? `Graph-It-Live reused one persistent MCP worker for ${warm.queryCount} queries. Indexing: ${publishedMetric(warm.indexingLatencyMs)} ms; query total: ${publishedMetric(warm.totalQueryLatencyMs)} ms; mean query: ${publishedMetric(warm.meanQueryLatencyMs)} ms; session total: ${publishedMetric(warm.totalSessionLatencyMs)} ms.`
      : `Warm session was not measured: ${warm?.reason ?? warm?.error ?? 'unknown reason'}.`,
    '',
    '## Interpretation and limitations', '',
    '- Do not rank tools by response tokens alone: empty or error responses can be very small.',
    '- Do not compare Graphify query latency with Graph-It-Live one-shot CLI latency as if they used the same lifecycle.',
    '- The corpus is intentionally small and deterministic; it is evidence for these workflows, not a universal language or repository benchmark.',
    '- Graphify uses name-based symbol identifiers and code-only extraction here; documentation retrieval is therefore a genuine unsupported capability in this run.',
    '- Precision is oracle-relative. The report should be supplemented with larger fixtures and manually reviewed task success before making a product-wide replacement claim.',
    '',
    'Raw JSON, normalized JSON/TOON outputs and this Markdown report are retained under `.reports/context-economy/latest/`.',
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
          requestArgs: cliArgs(workflow, '<workspace>', 'json'),
          outputPreview: normalizedJson.slice(0, 1200),
          metrics: measureComparableMetrics({ response, incrementalResponse, expectedNodeIds: workflow.expected, expectedPath: expectedPath(workflow), request: requestText, responseText: normalizedJson, latenciesMs: { cold: cold.elapsedMs, warm: warm.elapsedMs, incrementalUpdate: incremental.elapsedMs } }),
          encoding: { ...estimateTokenSavings(normalizedJson, normalizedToon), providerBillingTokens: null },
        },
      };
    });
    const graphify = graphifyResults(REFERENCE_WORKFLOWS, graphifyCli, workspaceRoot, corpus, env, execFile);
    workflows.forEach((workflow, index) => { workflow.graphify = graphify[index]; });
    const report = {
      schemaVersion: BENCHMARK_VERSION,
      graphItLiveCli: resolvedCliPath,
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
