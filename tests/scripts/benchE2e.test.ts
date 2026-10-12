/**
 * End-to-end benchmark tests
 *
 * scripts/bench-e2e.mjs times the built CLI and MCP server as real processes on
 * frozen corpora (#294) and renders a Markdown report.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OSS_CORPORA,
  SELF_REF,
  fetchCorpus,
  generateCorpus,
  main,
  parseOptions,
  percentile,
  queueWaits,
  readHeapProbe,
  readPeakRss,
  renderReport,
  summarize,
  summarizeMemory,
  type BenchReport,
} from '../../scripts/bench-e2e.mjs';
import { REPO_ROOT, wasmBuilt } from '../mcp/tools/callGraphWorkspace';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-e2e-test-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('percentile', () => {
  it('returns the nearest-rank value without sorting the input in place', () => {
    const values = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 100)).toBe(20);
    expect(values[0]).toBe(20);
  });

  it('returns the only value of a single sample', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([7], 0)).toBe(7);
  });
});

describe('summarize', () => {
  it('rounds wall-time percentiles and keeps the largest peak RSS', () => {
    expect(summarize([{ wallMs: 10.4, rssMB: 100.2 }, { wallMs: 30.6, rssMB: 250.7 }, { wallMs: 20, rssMB: 90 }])).toEqual({
      runs: 3, p50Ms: 20, p95Ms: 31, peakRssMB: 251,
    });
  });

  it('leaves the peak RSS undefined when no sample recorded one', () => {
    expect(summarize([{ wallMs: 3 }, { wallMs: 5, rssMB: undefined }]).peakRssMB).toBeUndefined();
  });
});

describe('generateCorpus', () => {
  const read = (root: string, relPath: string) => readFileSync(path.join(root, relPath), 'utf8');

  it('writes the hub, the configuration and one module per file, 100 per directory', () => {
    const root = tempDir();
    generateCorpus(root, 150);
    expect(readdirSync(path.join(root, 'src', 'd0'))).toHaveLength(100);
    expect(readdirSync(path.join(root, 'src', 'd1'))).toHaveLength(50);
    expect(JSON.parse(read(root, 'tsconfig.json')).compilerOptions.paths).toEqual({ '@/*': ['src/*'] });
    expect(read(root, 'src/hub.ts')).toContain('export function hub()');
  });

  it('chains modules inside a directory and links one far module through the alias', () => {
    const root = tempDir();
    generateCorpus(root, 150);
    const first = read(root, 'src/d1/m100.ts');
    expect(first).toContain('from "../hub"');
    expect(first).toContain('from "@/d1/m105"');
    expect(first).not.toContain('previous');
    expect(read(root, 'src/d1/m101.ts')).toContain('import { m100 as previous } from "./m100";');
  });

  it('produces the same files for the same count', () => {
    const [a, b] = [tempDir(), tempDir()];
    generateCorpus(a, 120);
    generateCorpus(b, 120);
    for (const relPath of ['src/d0/m42.ts', 'src/d1/m119.ts', 'tsconfig.json']) {
      expect(read(b, relPath)).toBe(read(a, relPath));
    }
  });
});

describe('OSS_CORPORA', () => {
  it('pins one public project per supported language to a full commit, with its license', () => {
    expect(Object.keys(OSS_CORPORA)).toEqual(['typescript', 'python', 'rust', 'go', 'java', 'csharp']);
    for (const corpus of Object.values(OSS_CORPORA)) {
      expect(corpus.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      expect(corpus.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(corpus.tag).not.toBe('');
      expect(corpus.license).toMatch(/^\S.*, \S+$/);
      expect([corpus.edit, corpus.file, corpus.symbol].every(Boolean)).toBe(true);
    }
  });
});

describe('fetchCorpus', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

  /** A local upstream with two commits: the first one pinned, the second one moved past it. */
  const upstream = () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'hub.ts'), 'export const v = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'pinned');
    const commit = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'src', 'hub.ts'), 'export const v = 2;\n');
    git(dir, 'commit', '-q', '-am', 'later');
    git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    return { url: pathToFileURL(dir).href, tag: 'v1', commit, license: 'MIT, LICENSE', edit: 'src/hub.ts', file: 'src/hub.ts', symbol: 'v' };
  };

  it('extracts the pinned commit without its history, then reuses the cached repository', () => {
    const corpus = upstream();
    const cache = path.join(tempDir(), 'corpora');
    const [first, second] = [path.join(tempDir(), 'ws'), path.join(tempDir(), 'ws')];

    fetchCorpus('demo', corpus, cache, first);
    rmSync(new URL(corpus.url), { recursive: true, force: true });
    fetchCorpus('demo', corpus, cache, second);

    for (const root of [first, second]) {
      expect(readFileSync(path.join(root, 'src', 'hub.ts'), 'utf8')).toBe('export const v = 1;\n');
      expect(existsSync(path.join(root, '.git'))).toBe(false);
    }
  });

  it('fetches again when the cached repository lacks the pinned commit', () => {
    const corpus = upstream();
    const cache = tempDir();
    mkdirSync(path.join(cache, 'demo.git'));
    writeFileSync(path.join(cache, 'demo.git', 'stale'), '');
    const root = path.join(tempDir(), 'ws');

    fetchCorpus('demo', corpus, cache, root);

    expect(readFileSync(path.join(root, 'src', 'hub.ts'), 'utf8')).toBe('export const v = 1;\n');
    expect(existsSync(path.join(cache, 'demo.git', 'stale'))).toBe(false);
  });

  it('throws when the commit cannot be fetched', () => {
    const corpus = { ...upstream(), commit: '0'.repeat(40) };
    expect(() => fetchCorpus('demo', corpus, tempDir(), path.join(tempDir(), 'ws'))).toThrow();
  });
});

describe('readPeakRss', () => {
  it('returns the largest process peak in MB', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, '1.kb'), '102400');
    writeFileSync(path.join(dir, '2.kb'), '307200');
    expect(readPeakRss(dir)).toBe(300);
  });

  it('returns undefined when no process wrote its peak', () => {
    expect(readPeakRss(tempDir())).toBeUndefined();
  });

  it('ignores the heap probe files written next to the peaks', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, '1.kb'), '102400');
    writeFileSync(path.join(dir, 'probe'), '3');
    writeFileSync(path.join(dir, 'heap-3-1-0.json'), '{}');
    expect(readPeakRss(dir)).toBe(100);
  });
});

describe('queueWaits', () => {
  it('charges each call the latency of the call served before it', () => {
    expect(queueWaits([30, 10, 50, 20, 40])).toEqual([0, 10, 20, 30, 40]);
  });

  it('gives a single call no wait', () => {
    expect(queueWaits([12])).toEqual([0]);
  });
});

describe('readHeapProbe', () => {
  const answer = (dir: string, name: string, main: boolean, heapMB: number, peakMB: number) =>
    writeFileSync(path.join(dir, name), JSON.stringify({ main, heap: heapMB * 1024 * 1024, peak: peakMB * 1024 * 1024 }));

  it('splits the main thread from the sum of the worker threads, in MB', () => {
    const dir = tempDir();
    answer(dir, 'heap-1-42-0.json', true, 100, 120);
    answer(dir, 'heap-1-42-1.json', false, 200, 400);
    answer(dir, 'heap-1-42-2.json', false, 30, 50);
    answer(dir, 'heap-10-42-1.json', false, 999, 999);
    expect(readHeapProbe(dir, 1)).toEqual({
      server: { heapMB: 100, peakHeapMB: 120 },
      workers: { heapMB: 230, peakHeapMB: 450 },
    });
  });

  it('reports zero when no thread answered the probe', () => {
    expect(readHeapProbe(tempDir(), 1)).toEqual({ server: { heapMB: 0, peakHeapMB: 0 }, workers: { heapMB: 0, peakHeapMB: 0 } });
  });
});

describe('summarizeMemory', () => {
  const probe = (server: number, workers: number, peak: number) => ({
    server: { heapMB: server, peakHeapMB: peak },
    workers: { heapMB: workers, peakHeapMB: peak * 2 },
  });

  it('keeps the heap after every cycle and the largest peak, rounded to 0.1 MB', () => {
    expect(summarizeMemory([probe(100.04, 200.26, 120), probe(100.31, 201, 130.04)], 800.6)).toEqual({
      cycles: 2,
      peakRssMB: 801,
      server: { heapMB: [100, 100.3], peakHeapMB: 130 },
      workers: { heapMB: [200.3, 201], peakHeapMB: 260.1 },
    });
  });

  it('leaves the peak RSS undefined when the server did not write it', () => {
    expect(summarizeMemory([probe(1, 2, 3)], undefined).peakRssMB).toBeUndefined();
  });
});

describe('renderReport', () => {
  const report: BenchReport = {
    version: 1, node: '22.0.0', platform: 'linux', arch: 'x64', cpus: 4, runs: 3,
    corpora: [
      {
        name: 'self', ref: SELF_REF, files: 900,
        cache: { reverseIndexBytes: 3 * 1024 * 1024, callGraphBytes: 9.5 * 1024 * 1024 },
        metrics: { 'scan.cold': { runs: 3, p50Ms: 2000, p95Ms: 2100, peakRssMB: 600 } },
      },
      {
        name: 'generated', ref: undefined, files: 10_003, cache: undefined,
        memory: {
          cycles: 20, peakRssMB: undefined,
          server: { heapMB: [100, 101.5], peakHeapMB: 130 },
          workers: { heapMB: [250, 249.2], peakHeapMB: 480 },
        },
        metrics: { 'mcp.queryCallGraph': { runs: 15, p50Ms: 12, p95Ms: 14, peakRssMB: undefined } },
      },
    ],
  };

  it('renders the environment, the cache sizes and one row per metric', () => {
    const markdown = renderReport(report);
    expect(markdown).toContain('## End-to-end benchmarks (linux-x64, Node 22.0.0, 4 CPUs)');
    expect(markdown).toContain(`### self (${SELF_REF}, 900 files)`);
    expect(markdown).toContain('reverse index 3.0 MB, call graph 9.5 MB');
    expect(markdown).toContain('| scan.cold | 3 | 2000 | 2100 | 600 |');
    expect(markdown).toContain("its RSS is the extension host's");
  });

  it('renders the heap of the server and worker threads across the cycles', () => {
    const markdown = renderReport(report);
    expect(markdown).toContain('Memory over 20 index/query cycle(s)');
    expect(markdown).toContain('| server (main) | 100 | 101.5 | 1.5 | 130 |');
    expect(markdown).toContain('| workers | 250 | 249.2 | -0.8 | 480 |');
    expect(markdown.match(/Memory over/g)).toHaveLength(1);
  });

  it('marks missing values instead of printing undefined', () => {
    const markdown = renderReport(report);
    expect(markdown).toContain('### generated (10003 files)');
    expect(markdown).toContain('reverse index —, call graph —');
    expect(markdown).toContain('| mcp.queryCallGraph | 15 | 12 | 14 | — |');
    expect(markdown).toContain('peak RSS (worker threads included): — MB');
    expect(markdown).not.toContain('undefined');
  });
});

describe('parseOptions', () => {
  it('defaults to five runs on every corpus with 10,000 generated files', () => {
    expect(parseOptions([])).toEqual({
      runs: 5, files: 10_000, cycles: 20, corpora: ['self', 'generated', ...Object.keys(OSS_CORPORA)], vscode: true,
      corporaDir: path.join(REPO_ROOT, '.reports', 'bench-e2e', 'corpora'), out: path.join(REPO_ROOT, '.reports', 'bench-e2e', 'latest'),
    });
  });

  it('reads every option', () => {
    expect(parseOptions(['--runs', '2', '--corpus', 'generated,go', '--files', '50', '--cycles', '3', '--no-vscode', '--corpora-dir', 'cache', '--out', 'out'])).toEqual({
      runs: 2, files: 50, cycles: 3, corpora: ['generated', 'go'], vscode: false, corporaDir: path.resolve('cache'), out: path.resolve('out'),
    });
  });

  it.each([
    [['--runs', '0']],
    [['--runs', '1.5']],
    [['--files', '1']],
    [['--cycles', '0']],
    [['--corpus', 'self,private']],
  ])('rejects %j', (args) => {
    expect(() => parseOptions(args)).toThrow(/^Usage:/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseOptions(['--repeat', '3'])).toThrow();
  });
});

const cliBuilt = existsSync(path.join(REPO_ROOT, 'dist', 'graph-it.js')) && existsSync(path.join(REPO_ROOT, 'dist', 'mcpServer.mjs'));

describe.runIf(cliBuilt && wasmBuilt)('main', () => {
  it('measures the CLI and MCP surfaces on a generated corpus and writes the reports', async () => {
    const out = tempDir();
    const summary = path.join(out, 'summary.md');
    mkdirSync(out, { recursive: true });
    const nodeOptions = process.env.NODE_OPTIONS;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const report = await main(['--runs', '1', '--corpus', 'generated', '--files', '20', '--cycles', '2', '--no-vscode', '--out', out], { GITHUB_STEP_SUMMARY: summary });

    stdout.mockRestore();
    const [corpus] = report.corpora;
    expect(corpus.files).toBe(23);
    expect(Object.keys(corpus.metrics)).toEqual([
      'cli.coldStart', 'scan.cold', 'scan.warm', 'scan.afterEdit', 'callGraph.cold', 'callGraph.warm',
      'mcp.firstResponse', 'mcp.findReferencingFiles', 'mcp.queryCallGraph', 'mcp.concurrent5', 'mcp.concurrent5.queueWait',
    ]);
    expect(corpus.metrics['mcp.concurrent5'].runs).toBe(5);
    expect(corpus.metrics['mcp.concurrent5.queueWait'].p50Ms).toBeLessThanOrEqual(corpus.metrics['mcp.concurrent5'].p50Ms);
    expect(corpus.memory?.cycles).toBe(2);
    expect(corpus.memory?.server.heapMB.every((heapMB) => heapMB > 0)).toBe(true);
    expect(corpus.memory?.workers.heapMB.every((heapMB) => heapMB > 0)).toBe(true);
    expect(corpus.memory?.peakRssMB).toBeGreaterThan(0);
    expect(corpus.metrics['scan.cold'].peakRssMB).toBeGreaterThan(0);
    expect(corpus.metrics['mcp.firstResponse'].peakRssMB).toBeGreaterThan(0);
    expect(corpus.metrics['mcp.queryCallGraph'].runs).toBe(5);
    expect(corpus.cache?.reverseIndexBytes).toBeGreaterThan(0);
    expect(corpus.cache?.callGraphBytes).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'))).toEqual(report);
    expect(readFileSync(path.join(out, 'report.md'), 'utf8')).toBe(readFileSync(summary, 'utf8'));
    expect(process.env.NODE_OPTIONS).toBe(nodeOptions);
    expect(process.env.BENCH_RSS_DIR).toBeUndefined();
  }, 120_000);
});
