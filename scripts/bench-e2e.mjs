import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { closeSession, startMcpSession } from '../tests/cli/mcpSession.ts';

// End-to-end benchmarks of the built CLI and MCP server on frozen corpora (#294).
// Unlike the vitest benches, each sample is a real process: wall time includes
// Node startup, and the peak RSS of every process is recorded at exit.
// The VS Code surface runs tests/vscode-e2e/bench in a fresh VS Code instance per sample.
// Open-source corpora (#320) are fetched at a pinned commit into --corpora-dir, never committed.
// Usage: node scripts/bench-e2e.mjs [--runs 5] [--corpus self,generated,...] [--files 10000] [--cycles 20] [--no-vscode] [--corpora-dir <dir>] [--out <dir>]

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'graph-it.js');
const VSCODE_BENCH = path.join(REPO_ROOT, 'tests', 'vscode-e2e', 'bench', 'index.js');
export const SELF_REF = 'v1.18.0';
const MCP_QUERIES_PER_RUN = 5;
const CONCURRENT_CALLS = 5;
const MB = 1024 * 1024;
// The server accepts 5 rebuild_index calls per 10 s (RATE_LIMIT_MAX_CALLS in src/mcp/mcpServer.ts).
const REBUILD_INTERVAL_MS = 2_100;
// ponytail: fixed wait for every thread to answer a heap probe (preload polls every 50 ms);
// count per-thread acknowledgements if a probe ever misses a thread.
const HEAP_PROBE_WAIT_MS = 1_000;

/** One medium open-source project per supported language: repository, tag, pinned commit, license. */
export const OSS_CORPORA = JSON.parse(readFileSync(path.join(REPO_ROOT, 'scripts', 'bench-corpora.json'), 'utf8'));

/** Each corpus names one file to edit and one hub symbol to query. */
const TARGETS = {
  self: { edit: 'src/shared/path.ts', file: 'src/shared/path.ts', symbol: 'normalizePath' },
  generated: { edit: 'src/d0/m1.ts', file: 'src/hub.ts', symbol: 'hub' },
  ...OSS_CORPORA,
};

// Loaded with --require (and --expose-gc) by every thread of every benchmarked
// process (CLI, MCP server). The main thread writes the process peak RSS (KB,
// worker threads included) to BENCH_RSS_DIR at exit. A worker thread shares that
// RSS, so each thread also samples its own V8 heap every 50 ms; when the `probe`
// file names a new cycle, it collects garbage and writes its heap and peak heap.
const PRELOAD = `const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { isMainThread, threadId } = require('node:worker_threads');
const dir = process.env.BENCH_RSS_DIR;
if (isMainThread) process.on('exit', () => {
  fs.writeFileSync(path.join(dir, process.pid + '.kb'), String(process.resourceUsage().maxRSS));
});
let peak = 0;
let answered = '';
setInterval(() => {
  peak = Math.max(peak, v8.getHeapStatistics().used_heap_size);
  let cycle = '';
  try { cycle = fs.readFileSync(path.join(dir, 'probe'), 'utf8'); } catch {}
  if (cycle === '' || cycle === answered) return;
  answered = cycle;
  globalThis.gc();
  const heap = v8.getHeapStatistics().used_heap_size;
  fs.writeFileSync(path.join(dir, 'heap-' + cycle + '-' + process.pid + '-' + threadId + '.json'),
    JSON.stringify({ main: isMainThread, heap, peak: Math.max(peak, heap) }));
}, 50).unref();
`;

/** Nearest-rank percentile of a non-empty list. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarize(samples) {
  const wall = samples.map((sample) => sample.wallMs);
  const rss = samples.map((sample) => sample.rssMB).filter(Number.isFinite);
  return {
    runs: samples.length,
    p50Ms: Math.round(percentile(wall, 50)),
    p95Ms: Math.round(percentile(wall, 95)),
    peakRssMB: rss.length > 0 ? Math.round(Math.max(...rss)) : undefined,
  };
}

/**
 * Neutral TypeScript workspace of `files` modules plus a hub, 100 per directory.
 * Every module imports the hub, its predecessor (relative) and one far module
 * through the `@/` alias. Deterministic: the same count gives the same files.
 */
export function generateCorpus(root, files) {
  const write = (relPath, content) => {
    mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    writeFileSync(path.join(root, relPath), content);
  };
  write('package.json', '{}\n');
  write('tsconfig.json', `${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })}\n`);
  write('src/hub.ts', 'export function hub() { return 0; }\n');
  for (let i = 0; i < files; i++) {
    const far = (i * 13 + 5) % files;
    const hasPrevious = i % 100 > 0;
    const lines = ['import { hub } from "../hub";', `import { m${far} as far } from "@/d${Math.floor(far / 100)}/m${far}";`];
    if (hasPrevious) lines.push(`import { m${i - 1} as previous } from "./m${i - 1}";`);
    lines.push(`export function m${i}() { return hub() + far()${hasPrevious ? ' + previous()' : ''}; }`, '');
    write(`src/d${Math.floor(i / 100)}/m${i}.ts`, lines.join('\n'));
  }
}

// core.autocrlf=false: `git archive` would otherwise write CRLF on Windows, and the corpus must be the same bytes on every OS.
const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); // NOSONAR S4036: developer and CI tool, trusted PATH

/** Extracts `ref` of the repository `gitDir` into `root`, without its history. */
function extract(root, gitDir, ref) {
  const archive = `${root}.tar`;
  git('-C', gitDir, 'archive', '--format=tar', '-o', archive, ref);
  mkdirSync(root, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', root]); // NOSONAR S4036: developer and CI tool, trusted PATH
  rmSync(archive);
}

/**
 * Extracts an open-source corpus at its pinned commit. The commit is fetched once
 * (shallow) into a bare repository under `corporaDir`, which CI caches.
 */
export function fetchCorpus(name, corpus, corporaDir, root) {
  const gitDir = path.join(corporaDir, `${name}.git`);
  try {
    git('--git-dir', gitDir, 'cat-file', '-e', `${corpus.commit}^{commit}`);
  } catch {
    rmSync(gitDir, { recursive: true, force: true });
    git('init', '--bare', '-q', gitDir);
    git('--git-dir', gitDir, 'fetch', '-q', '--depth', '1', corpus.url, `${corpus.commit}:refs/bench/${name}`);
  }
  extract(root, gitDir, corpus.commit);
}

/** Label of a corpus in the report: the tag of this repository or of the open-source project. */
function corpusRef(name) {
  if (name === 'self') return SELF_REF;
  const corpus = OSS_CORPORA[name];
  return corpus && `${new URL(corpus.url).pathname.slice(1)}@${corpus.tag}`;
}

/** Points the next benchmarked processes at an empty RSS directory. */
function freshRssDir(scratch) {
  process.env.BENCH_RSS_DIR = mkdtempSync(path.join(scratch, 'rss-'));
  return process.env.BENCH_RSS_DIR;
}

/** Largest peak RSS (MB) written by the processes of one sample. */
export function readPeakRss(dir) {
  const kilobytes = readdirSync(dir).filter((name) => name.endsWith('.kb'))
    .map((name) => Number(readFileSync(path.join(dir, name), 'utf8')));
  return kilobytes.length > 0 ? Math.max(...kilobytes) / 1024 : undefined;
}

async function runCli(args, scratch) {
  const rssDir = freshRssDir(scratch);
  const started = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [ENTRY, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return { wallMs: performance.now() - started, rssMB: readPeakRss(rssDir), stdout };
}

async function sample(runs, measure, before = () => {}) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    before(run);
    samples.push(await measure()); // NOSONAR S9382: samples run one at a time, parallel runs would skew timings
  }
  return summarize(samples);
}

function cacheDir(workspace) {
  return path.join(workspace, '.graph-it', 'cache');
}

/** Appends a comment and moves the mtime forward, so coarse clocks cannot hide the edit. */
function edit(filePath, run) {
  appendFileSync(filePath, `// bench edit ${run}\n`);
  const changedAt = new Date(Date.now() + 2_000 * (run + 1));
  utimesSync(filePath, changedAt, changedAt);
}

async function measureCli(workspace, target, runs, scratch) {
  const cli = (...args) => () => runCli([...args, '--workspace', workspace, '--format', 'json'], scratch);
  const scan = cli('scan');
  const callers = cli('tool', 'query_call_graph', '--filePath', target.file,
    '--symbolName', target.symbol, '--direction', 'callers');
  const metrics = {
    'cli.coldStart': await sample(runs, () => runCli(['--version'], scratch)),
    'scan.cold': await sample(runs, scan, () => rmSync(cacheDir(workspace), { recursive: true, force: true })),
    'scan.warm': await sample(runs, scan),
    'scan.afterEdit': await sample(runs, scan, (run) => edit(path.join(workspace, target.edit), run)),
    'callGraph.cold': await sample(runs, callers, () => rmSync(path.join(cacheDir(workspace), 'callgraph.db'), { force: true })),
    'callGraph.warm': await sample(runs, callers),
  };
  const status = JSON.parse((await cli('tool', 'get_index_status')()).stdout);
  return { metrics, cache: status.cacheFiles };
}

async function timed(call) {
  const started = performance.now();
  await call();
  return { wallMs: performance.now() - started };
}

/**
 * One MCP session from an empty cache: the first response includes server
 * startup and the index build. Its peak RSS covers the whole session.
 */
async function measureMcp(workspace, target, runs, scratch) {
  rmSync(cacheDir(workspace), { recursive: true, force: true });
  const rssDir = freshRssDir(scratch);
  const targetPath = path.join(workspace, target.file);
  const callers = { filePath: targetPath, symbolName: target.symbol, direction: 'callers' };
  const started = performance.now();
  const session = await startMcpSession(ENTRY, workspace, workspace);
  try {
    await session.callTool('graphitlive_find_referencing_files', { targetPath });
    const firstResponse = { wallMs: performance.now() - started };
    await session.callTool('graphitlive_query_call_graph', callers);
    const queries = runs * MCP_QUERIES_PER_RUN;
    const references = await sample(queries, () => timed(() => session.callTool('graphitlive_find_referencing_files', { targetPath })));
    const callGraph = await sample(queries, () => timed(() => session.callTool('graphitlive_query_call_graph', callers)));
    const bursts = [];
    for (let run = 0; run < runs; run++) bursts.push(await burst(session, 'graphitlive_query_call_graph', callers)); // NOSONAR S9382: one burst at a time, overlapping bursts would merge their queues
    await closeSession(session.child);
    return {
      'mcp.firstResponse': summarize([{ ...firstResponse, rssMB: readPeakRss(rssDir) }]),
      'mcp.findReferencingFiles': references,
      'mcp.queryCallGraph': callGraph,
      [`mcp.concurrent${CONCURRENT_CALLS}`]: summarize(bursts.flat().map((wallMs) => ({ wallMs }))),
      [`mcp.concurrent${CONCURRENT_CALLS}.queueWait`]: summarize(bursts.flatMap(queueWaits).map((wallMs) => ({ wallMs }))),
    };
  } finally {
    session.child.kill();
  }
}

/** Latency of each of CONCURRENT_CALLS identical calls sent at once. */
function burst(session, name, args) {
  const started = performance.now();
  return Promise.all(Array.from({ length: CONCURRENT_CALLS }, () =>
    session.callTool(name, args).then(() => performance.now() - started)));
}

/**
 * Queue wait of each call of one burst. The server runs one call at a time, in
 * arrival order (FIFO in McpWorkerHost, `queuedAhead`), so a call starts when the
 * one ahead of it ends: its wait is the latency of its predecessor.
 */
export function queueWaits(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted.map((_, index) => (index === 0 ? 0 : sorted[index - 1]));
}

/** Sums the answers to one heap probe into the server (main) thread and its worker threads, in MB. */
export function readHeapProbe(dir, cycle) {
  const totals = { server: { heapMB: 0, peakHeapMB: 0 }, workers: { heapMB: 0, peakHeapMB: 0 } };
  for (const name of readdirSync(dir).filter((file) => file.startsWith(`heap-${cycle}-`))) {
    const answer = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    const total = answer.main ? totals.server : totals.workers;
    total.heapMB += answer.heap / MB;
    total.peakHeapMB += answer.peak / MB;
  }
  return totals;
}

/** Heap of each thread group after every cycle, its peak, and the process peak RSS. */
export function summarizeMemory(probes, peakRssMB) {
  const round = (value) => Math.round(value * 10) / 10;
  const group = (name) => ({
    heapMB: probes.map((probe) => round(probe[name].heapMB)),
    peakHeapMB: round(Math.max(...probes.map((probe) => probe[name].peakHeapMB))),
  });
  return {
    cycles: probes.length,
    peakRssMB: peakRssMB === undefined ? undefined : Math.round(peakRssMB),
    server: group('server'),
    workers: group('workers'),
  };
}

async function callOk(session, name, args) {
  const result = await session.callTool(name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
}

/** One full rebuild, the two queries, then a heap probe; paced under the rebuild rate limit. */
async function memoryCycle(session, targetPath, symbolName, dir, cycle) {
  const started = performance.now();
  await callOk(session, 'graphitlive_rebuild_index', {});
  await callOk(session, 'graphitlive_find_referencing_files', { targetPath });
  await callOk(session, 'graphitlive_query_call_graph', { filePath: targetPath, symbolName, direction: 'callers' });
  writeFileSync(path.join(dir, 'probe'), String(cycle));
  await sleep(Math.max(HEAP_PROBE_WAIT_MS, REBUILD_INTERVAL_MS - (performance.now() - started)));
  return readHeapProbe(dir, cycle);
}

/**
 * A second MCP session, warm cache: `cycles` index/query cycles. Heap after a
 * forced GC that grows from the first cycle to the last points to a leak.
 */
async function measureMemory(workspace, target, cycles, scratch) {
  const rssDir = freshRssDir(scratch);
  const targetPath = path.join(workspace, target.file);
  const session = await startMcpSession(ENTRY, workspace, workspace);
  try {
    const probes = [];
    for (let cycle = 1; cycle <= cycles; cycle++) probes.push(await memoryCycle(session, targetPath, target.symbol, rssDir, cycle)); // NOSONAR S9382: cycles run one after another by design
    await closeSession(session.child);
    return summarizeMemory(probes, readPeakRss(rssDir));
  } finally {
    session.child.kill();
  }
}

/**
 * One fresh VS Code instance per run, empty profile and index cache, the extension
 * loaded from source: activation, background index, the architecture view opened while
 * indexing then rebuilt once indexed, first call graph, and the extension host RSS.
 */
async function measureVscode(workspace, target, runs) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    rmSync(cacheDir(workspace), { recursive: true, force: true });
    // Short path: VS Code puts its IPC socket in the profile, and macOS caps socket paths at 104 bytes.
    const profile = mkdtempSync(path.join(tmpdir(), 'g-'));
    const out = path.join(profile, 'sample.json');
    try {
      await runTests({ // NOSONAR S9382: one VS Code instance at a time, parallel instances would skew timings
        version: process.env.VSCODE_TEST_VERSION ?? 'stable',
        cachePath: path.join(REPO_ROOT, '.vscode-test'),
        extensionDevelopmentPath: REPO_ROOT,
        extensionTestsPath: VSCODE_BENCH,
        // Electron rejects --expose-gc in NODE_OPTIONS; an undefined value unsets it.
        extensionTestsEnv: { NODE_OPTIONS: undefined, BENCH_VSCODE_FILE: target.file, BENCH_VSCODE_OUT: out },
        // An empty extensions directory instead of --disable-extensions, which would make VS Code
        // ignore --disable-extension. The built-in TypeScript service is disabled: it competes for
        // CPU, and on the generated corpus its import chain overflows tsserver's stack (crash loop).
        launchArgs: [workspace, `--extensions-dir=${path.join(profile, 'extensions')}`,
          '--disable-extension=vscode.typescript-language-features', `--user-data-dir=${path.join(profile, 'user-data')}`],
      });
      samples.push(JSON.parse(readFileSync(out, 'utf8')));
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  const metric = (name) => summarize(samples.map((sample) => sample[name]));
  return {
    'vscode.activation': metric('activation'),
    'vscode.indexReady': metric('indexReady'),
    'vscode.firstCallGraph': metric('firstCallGraph'),
    'vscode.architectureDuringIndex': metric('architectureDuringIndex'),
    'vscode.architectureIndexed': metric('architectureIndexed'),
  };
}

function countFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

async function benchCorpus(name, options, scratch) {
  const workspace = path.join(scratch, name);
  // This repository at a fixed tag: a real, public, multi-language workspace.
  if (name === 'self') extract(workspace, REPO_ROOT, SELF_REF);
  else if (name === 'generated') generateCorpus(workspace, options.files);
  else fetchCorpus(name, OSS_CORPORA[name], options.corporaDir, workspace);
  const files = countFiles(workspace);
  const target = TARGETS[name];
  const cli = await measureCli(workspace, target, options.runs, scratch);
  const mcp = await measureMcp(workspace, target, options.runs, scratch);
  const memory = await measureMemory(workspace, target, options.cycles, scratch);
  const vscode = options.vscode ? await measureVscode(workspace, target, options.runs) : {};
  return { name, ref: corpusRef(name), files, cache: cli.cache, metrics: { ...cli.metrics, ...mcp, ...vscode }, memory };
}

const cellMB = (value) => (value === undefined ? '—' : String(value));
const cellBytes = (value) => (value === undefined ? '—' : `${(value / MB).toFixed(1)} MB`);

function renderMemory(memory) {
  const row = (label, group) => {
    const [first, last] = [group.heapMB[0], group.heapMB.at(-1)];
    return `| ${label} | ${first} | ${last} | ${(last - first).toFixed(1)} | ${group.peakHeapMB} |`;
  };
  return [
    '',
    `Memory over ${memory.cycles} index/query cycle(s) in one MCP session (rebuild_index, then both queries): ` +
      `V8 heap after a forced GC at the end of each cycle. Server process peak RSS (worker threads included): ${cellMB(memory.peakRssMB)} MB.`,
    '',
    '| Threads | Heap after cycle 1 (MB) | Heap after last cycle (MB) | Growth (MB) | Peak heap (MB) |',
    '| --- | ---: | ---: | ---: | ---: |',
    row('server (main)', memory.server),
    row('workers', memory.workers),
  ];
}

export function renderReport(report) {
  const lines = [
    `## End-to-end benchmarks (${report.platform}-${report.arch}, Node ${report.node}, ${report.cpus} CPUs)`,
    '',
    `Each CLI sample is one process (Node startup included), ${report.runs} run(s) per metric. ` +
      'Peak RSS is the largest process of the sample; for MCP, the whole session. ' +
      'Each VS Code sample is one fresh instance from an empty index cache; its RSS is the extension host\'s.',
  ];
  for (const corpus of report.corpora) {
    const label = [corpus.ref, `${corpus.files} files`].filter(Boolean).join(', ');
    lines.push(
      '',
      `### ${corpus.name} (${label})`,
      '',
      `Cache on disk: reverse index ${cellBytes(corpus.cache?.reverseIndexBytes)}, call graph ${cellBytes(corpus.cache?.callGraphBytes)}.`,
      '',
      '| Metric | Runs | p50 (ms) | p95 (ms) | Peak RSS (MB) |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...Object.entries(corpus.metrics).map(([metric, value]) =>
        `| ${metric} | ${value.runs} | ${value.p50Ms} | ${value.p95Ms} | ${cellMB(value.peakRssMB)} |`),
      ...(corpus.memory ? renderMemory(corpus.memory) : []),
    );
  }
  return lines.join('\n');
}

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      runs: { type: 'string', default: '5' },
      corpus: { type: 'string', default: Object.keys(TARGETS).join(',') },
      files: { type: 'string', default: '10000' },
      cycles: { type: 'string', default: '20' },
      'no-vscode': { type: 'boolean', default: false },
      'corpora-dir': { type: 'string', default: path.join(REPO_ROOT, '.reports', 'bench-e2e', 'corpora') },
      out: { type: 'string', default: path.join(REPO_ROOT, '.reports', 'bench-e2e', 'latest') },
    },
  });
  const options = {
    runs: Number(values.runs), files: Number(values.files), cycles: Number(values.cycles),
    corpora: values.corpus.split(','), vscode: !values['no-vscode'],
    corporaDir: path.resolve(values['corpora-dir']), out: path.resolve(values.out),
  };
  const atLeast = (value, min) => Number.isInteger(value) && value >= min;
  const known = options.corpora.every((name) => name in TARGETS);
  if (!atLeast(options.runs, 1) || !atLeast(options.files, 2) || !atLeast(options.cycles, 1) || !known) {
    throw new Error(`Usage: node scripts/bench-e2e.mjs [--runs <n ≥ 1>] [--corpus ${Object.keys(TARGETS).join(',')}] [--files <n ≥ 2>] [--cycles <n ≥ 1>] [--no-vscode] [--corpora-dir <dir>] [--out <dir>]`);
  }
  return options;
}

export async function main(args, env = process.env) {
  const options = parseOptions(args);
  const scratch = mkdtempSync(path.join(tmpdir(), 'graph-it-bench-e2e-'));
  const preload = path.join(scratch, 'rss-preload.cjs');
  writeFileSync(preload, PRELOAD);
  const { NODE_OPTIONS, GRAPH_IT_DISABLE_UPDATE_CHECK, LOG_LEVEL } = process.env;
  const saved = { NODE_OPTIONS, GRAPH_IT_DISABLE_UPDATE_CHECK, LOG_LEVEL };
  // Children inherit process.env. NODE_OPTIONS reads `\` as an escape: use `/`.
  Object.assign(process.env, {
    NODE_OPTIONS: `${NODE_OPTIONS ?? ''} --expose-gc --require "${preload.replaceAll('\\', '/')}"`.trim(),
    GRAPH_IT_DISABLE_UPDATE_CHECK: '1',
    LOG_LEVEL: 'error',
  });
  try {
    const report = { version: 1, node: process.versions.node, platform: process.platform, arch: process.arch, cpus: cpus().length, runs: options.runs, corpora: [] };
    for (const name of options.corpora) report.corpora.push(await benchCorpus(name, options, scratch)); // NOSONAR S9382: one corpus at a time, parallel runs would skew timings
    const markdown = renderReport(report);
    mkdirSync(options.out, { recursive: true });
    writeFileSync(path.join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(options.out, 'report.md'), `${markdown}\n`);
    process.stdout.write(`${markdown}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    return report;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.BENCH_RSS_DIR;
    // A server killed after a failure may still be writing its cache: retry, so its error is not masked.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

// An error propagates: Node prints it and exits with code 1.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
