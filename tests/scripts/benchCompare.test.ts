/**
 * Benchmark A/B comparison tests
 *
 * scripts/bench-compare.mjs compares the `vitest bench --outputJson` reports of
 * interleaved base and head runs on one runner and renders the sticky PR comment.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKER,
  classify,
  collectSamples,
  compareBenchmarks,
  main,
  median,
  postComment,
  renderBenchComment,
} from '../../scripts/bench-compare.mjs';

const GROUP = 'tests/benchmarks/reverseIndex.bench.ts > ReverseIndex';

/** One `--outputJson` report: benchmark name → median (ms). */
function report(medians: Record<string, number>, filepath = '/checkout/tests/benchmarks/reverseIndex.bench.ts') {
  return {
    files: [{
      filepath,
      groups: [{ fullName: GROUP, benchmarks: Object.entries(medians).map(([name, value]) => ({ name, median: value })) }],
    }],
  };
}

const reports = (name: string, values: number[]) => values.map((value) => report({ [name]: value }));
const okResponse = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body) });

describe('median', () => {
  it('returns the middle value or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('collectSamples', () => {
  it('keys benchmarks by group and name, independently of the checkout path', () => {
    const samples = collectSamples([
      report({ lookup: 1 }, '/base/tests/benchmarks/reverseIndex.bench.ts'),
      report({ lookup: 2 }, '/head/tests/benchmarks/reverseIndex.bench.ts'),
    ]);
    expect([...samples]).toEqual([[`${GROUP} > lookup`, [1, 2]]]);
  });

  it('skips missing medians and malformed reports', () => {
    expect(collectSamples([report({ lookup: Number.NaN }), {}, null, { files: [{}] }]).size).toBe(0);
  });
});

describe('classify', () => {
  it('flags a regression beyond the threshold with disjoint run ranges', () => {
    expect(classify([10, 10.2, 9.9], [13, 12.8, 13.1], 0.1)).toBe('regression');
  });

  it('flags a gain beyond the threshold with disjoint run ranges', () => {
    expect(classify([10, 10.2, 9.9], [7, 7.1, 6.9], 0.1)).toBe('gain');
  });

  it('keeps a change below the threshold as noise', () => {
    expect(classify([10, 10.1, 9.9], [10.5, 10.6, 10.4], 0.1)).toBe('noise');
  });

  it('keeps a large median change with overlapping run ranges as noise', () => {
    expect(classify([10, 10, 20], [13, 13, 9], 0.1)).toBe('noise');
    expect(classify([10, 10, 5], [7, 7, 11], 0.1)).toBe('noise');
  });

  it('reports a benchmark missing on one side', () => {
    expect(classify(undefined, [1], 0.1)).toBe('added');
    expect(classify([1], undefined, 0.1)).toBe('removed');
  });
});

describe('compareBenchmarks', () => {
  it('compares medians across runs and sorts by name', () => {
    const base = [report({ slow: 10, fast: 10, same: 5, gone: 1 }), report({ slow: 10, fast: 10, same: 5, gone: 1 })];
    const head = [report({ slow: 20, fast: 5, same: 5, fresh: 1 }), report({ slow: 22, fast: 5, same: 5.1, fresh: 1 })];
    expect(compareBenchmarks(base, head, 0.1)).toEqual([
      { name: `${GROUP} > fast`, base: 10, head: 5, status: 'gain' },
      { name: `${GROUP} > fresh`, base: undefined, head: 1, status: 'added' },
      { name: `${GROUP} > gone`, base: 1, head: undefined, status: 'removed' },
      { name: `${GROUP} > same`, base: 5, head: 5.05, status: 'noise' },
      { name: `${GROUP} > slow`, base: 10, head: 21, status: 'regression' },
    ]);
  });
});

describe('renderBenchComment', () => {
  it('lists regressions, gains and one-sided benchmarks under the sticky marker', () => {
    const rows = compareBenchmarks(
      [report({ slow: 10, fast: 10, same: 5, gone: 1 })],
      [report({ slow: 20, fast: 5, same: 5, fresh: 1 })],
      0.1,
    );
    const body = renderBenchComment(rows, { threshold: 0.1, runs: 3 });
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('## Benchmark A/B: 1 regression(s), 1 gain(s)');
    expect(body).toContain('3 run(s) each');
    expect(body).toContain('±10%');
    expect(body).toContain('### Regressions\n| Benchmark | Base (ms) | Head (ms) | Change |');
    expect(body).toContain('| reverseIndex.bench.ts > ReverseIndex > slow | 10 | 20 | +100.0% |');
    expect(body).toContain('| reverseIndex.bench.ts > ReverseIndex > fast | 10 | 5 | -50.0% |');
    expect(body).toContain('- added: reverseIndex.bench.ts > ReverseIndex > fresh');
    expect(body).toContain('- removed: reverseIndex.bench.ts > ReverseIndex > gone');
    expect(body).toContain('1 benchmark(s) within noise.');
  });

  it('omits empty sections and escapes table cells', () => {
    const body = renderBenchComment(
      [{ name: 'a|b <script>\nc', base: 0.000123456, head: 0.000124, status: 'noise' }],
      { threshold: 0.1, runs: 1 },
    );
    expect(body).not.toContain('###');
    expect(renderBenchComment(
      [{ name: 'a|b <x>', base: 0.000123456, head: 1, status: 'regression' }],
      { threshold: 0.1, runs: 1 },
    )).toContain(String.raw`| a\|b &lt;x> | 0.000123 | 1 |`);
  });
});

describe('postComment', () => {
  const env = { GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '42', GITHUB_TOKEN: 'token' };
  const endpoint = 'https://api.github.com/repos/owner/repo/issues/42/comments';

  it('creates the comment when no sticky comment exists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse([{ id: 1, user: { type: 'Bot' }, body: '<!-- graph-it-review-gate -->' }]))
      .mockResolvedValueOnce(okResponse({ id: 2 }));
    await expect(postComment(fetchMock, env, 'body')).resolves.toEqual({ id: 2 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, endpoint, expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer token' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, endpoint, expect.objectContaining({ method: 'POST' }));
  });

  it('updates its own sticky comment in place', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse([{ id: 7, user: { type: 'Bot' }, body: `${MARKER} old` }]))
      .mockResolvedValueOnce(okResponse({ id: 7 }));
    await postComment(fetchMock, env, 'body');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/owner/repo/issues/comments/7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ body: 'body' }) }),
    );
  });

  it('rejects an invalid repository or pull request number before calling GitHub', async () => {
    const fetchMock = vi.fn();
    await expect(postComment(fetchMock, { ...env, PR_NUMBER: '' }, 'body')).rejects.toThrow('Invalid GitHub repository');
    await expect(postComment(fetchMock, { ...env, GITHUB_REPOSITORY: 'a/b/c' }, 'body')).rejects.toThrow('Invalid GitHub repository');
    await expect(postComment(fetchMock, {}, 'body')).rejects.toThrow('Invalid GitHub repository');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeReports() {
    dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    reports('lookup', [10, 10.1, 9.9]).forEach((r, i) => writeFileSync(path.join(dir, `base-${i}.json`), JSON.stringify(r)));
    reports('lookup', [15, 15.2, 14.9]).forEach((r, i) => writeFileSync(path.join(dir, `head-${i}.json`), JSON.stringify(r)));
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  }

  it('prints the summary, appends it to the step summary and posts the comment', async () => {
    writeReports();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const summary = path.join(dir, 'summary.md');
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse([])).mockResolvedValueOnce(okResponse({ id: 1 }));
    const body = await main([dir], { GITHUB_STEP_SUMMARY: summary, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '3' }, fetchMock);
    expect(body).toContain('1 regression(s), 0 gain(s)');
    expect(body).toContain('3 run(s) each');
    expect(stdout).toHaveBeenCalledWith(`${body}\n`);
    expect(readFileSync(summary, 'utf8')).toBe(`${body}\n`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('applies a custom threshold and does not post without a token', async () => {
    writeReports();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetchMock = vi.fn();
    const body = await main([dir, '60'], {}, fetchMock);
    expect(body).toContain('0 regression(s)');
    expect(body).toContain('±60%');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects bad arguments and a missing side', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bench-compare-'));
    await expect(main([], {})).rejects.toThrow('Usage');
    await expect(main([dir, 'abc'], {})).rejects.toThrow('Usage');
    await expect(main([dir, '0'], {})).rejects.toThrow('Usage');
    await expect(main([dir, 'Infinity'], {})).rejects.toThrow('Usage');
    writeFileSync(path.join(dir, 'base-1.json'), JSON.stringify(report({ lookup: 1 })));
    await expect(main([dir], {})).rejects.toThrow('Expected base-*.json and head-*.json');
  });
});
