import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { closeSession, startMcpSession } from '../tests/cli/mcpSession.ts';

// End-to-end benchmarks of the built CLI and MCP server on frozen corpora (#294).
// Unlike the vitest benches, each sample is a real process: wall time includes
// Node startup, and the peak RSS of every process is recorded at exit.
// Usage: node scripts/bench-e2e.mjs [--runs 5] [--corpus self,generated] [--files 10000] [--out <dir>]

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO_ROOT, 'dist', 'graph-it.js');
export const SELF_REF = 'v1.18.0';
const MCP_QUERIES_PER_RUN = 5;

/** Each corpus names one file to edit and one hub symbol to query. */
const TARGETS = {
  self: { edit: 'src/shared/path.ts', file: 'src/shared/path.ts', symbol: 'normalizePath' },
  generated: { edit: 'src/d0/m1.ts', file: 'src/hub.ts', symbol: 'hub' },
};

// Loaded with --require by every benchmarked process (CLI, MCP server): writes
// the process peak RSS (KB, worker threads included) to BENCH_RSS_DIR at exit.
const RSS_PRELOAD = `if (require('node:worker_threads').isMainThread) process.on('exit', () => {
  require('node:fs').writeFileSync(require('node:path').join(process.env.BENCH_RSS_DIR, process.pid + '.kb'), String(process.resourceUsage().maxRSS));
});
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

/** This repository at a fixed tag: a real, public, multi-language workspace. */
function extractSelf(root) {
  const archive = path.join(root, '..', 'self.tar');
  execFileSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', archive, SELF_REF]);
  mkdirSync(root, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', root]);
  rmSync(archive);
}

/** Points the next benchmarked processes at an empty RSS directory. */
function freshRssDir(scratch) {
  process.env.BENCH_RSS_DIR = mkdtempSync(path.join(scratch, 'rss-'));
  return process.env.BENCH_RSS_DIR;
}

/** Largest peak RSS (MB) written by the processes of one sample. */
export function readPeakRss(dir) {
  const kilobytes = readdirSync(dir).map((name) => Number(readFileSync(path.join(dir, name), 'utf8')));
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
    samples.push(await measure());
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
    await closeSession(session.child);
    return {
      'mcp.firstResponse': summarize([{ ...firstResponse, rssMB: readPeakRss(rssDir) }]),
      'mcp.findReferencingFiles': references,
      'mcp.queryCallGraph': callGraph,
    };
  } finally {
    session.child.kill();
  }
}

function countFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

async function benchCorpus(name, options, scratch) {
  const workspace = path.join(scratch, name);
  if (name === 'self') extractSelf(workspace);
  else generateCorpus(workspace, options.files);
  const files = countFiles(workspace);
  const target = TARGETS[name];
  const cli = await measureCli(workspace, target, options.runs, scratch);
  const mcp = await measureMcp(workspace, target, options.runs, scratch);
  return { name, ref: name === 'self' ? SELF_REF : undefined, files, cache: cli.cache, metrics: { ...cli.metrics, ...mcp } };
}

const cellMB = (value) => (value === undefined ? '—' : String(value));
const cellBytes = (value) => (value === undefined ? '—' : `${(value / 1024 / 1024).toFixed(1)} MB`);

export function renderReport(report) {
  const lines = [
    `## End-to-end benchmarks (${report.platform}-${report.arch}, Node ${report.node}, ${report.cpus} CPUs)`,
    '',
    `Each CLI sample is one process (Node startup included), ${report.runs} run(s) per metric. ` +
      'Peak RSS is the largest process of the sample; for MCP, the whole session.',
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
    );
  }
  return lines.join('\n');
}

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      runs: { type: 'string', default: '5' },
      corpus: { type: 'string', default: 'self,generated' },
      files: { type: 'string', default: '10000' },
      out: { type: 'string', default: path.join(REPO_ROOT, '.reports', 'bench-e2e', 'latest') },
    },
  });
  const options = { runs: Number(values.runs), files: Number(values.files), corpora: values.corpus.split(','), out: path.resolve(values.out) };
  const unknown = options.corpora.filter((name) => !(name in TARGETS));
  if (!Number.isInteger(options.runs) || options.runs < 1 || !Number.isInteger(options.files) || options.files < 2 || unknown.length > 0) {
    throw new Error('Usage: node scripts/bench-e2e.mjs [--runs <n ≥ 1>] [--corpus self,generated] [--files <n ≥ 2>] [--out <dir>]');
  }
  return options;
}

export async function main(args, env = process.env) {
  const options = parseOptions(args);
  const scratch = mkdtempSync(path.join(tmpdir(), 'graph-it-bench-e2e-'));
  const preload = path.join(scratch, 'rss-preload.cjs');
  writeFileSync(preload, RSS_PRELOAD);
  const { NODE_OPTIONS, GRAPH_IT_DISABLE_UPDATE_CHECK, LOG_LEVEL } = process.env;
  const saved = { NODE_OPTIONS, GRAPH_IT_DISABLE_UPDATE_CHECK, LOG_LEVEL };
  // Children inherit process.env. NODE_OPTIONS reads `\` as an escape: use `/`.
  Object.assign(process.env, {
    NODE_OPTIONS: `${NODE_OPTIONS ?? ''} --require "${preload.replaceAll('\\', '/')}"`.trim(),
    GRAPH_IT_DISABLE_UPDATE_CHECK: '1',
    LOG_LEVEL: 'error',
  });
  try {
    const report = { version: 1, node: process.versions.node, platform: process.platform, arch: process.arch, cpus: cpus().length, runs: options.runs, corpora: [] };
    for (const name of options.corpora) report.corpora.push(await benchCorpus(name, options, scratch));
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
    rmSync(scratch, { recursive: true, force: true });
  }
}

// An error propagates: Node prints it and exits with code 1.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
