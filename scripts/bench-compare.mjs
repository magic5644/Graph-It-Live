import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fetchJsonOrThrow,
  findStickyComment,
  upsertReviewComment,
} from '../.github/actions/graph-it-review-gate/commentHelpers.mjs';

// Same-runner A/B benchmark comparison for pull requests (#293).
// Reads the `vitest bench --outputJson` reports of interleaved base and head
// runs (`base-*.json`, `head-*.json`), compares each benchmark's median across
// runs and prints a Markdown summary. With GITHUB_TOKEN, GITHUB_REPOSITORY and
// PR_NUMBER set, it also creates or updates one sticky pull-request comment.
// Usage: node scripts/bench-compare.mjs <report-dir> [threshold-percent]

export const MARKER = '<!-- graph-it-bench-ab -->';
const DEFAULT_THRESHOLD_PERCENT = 10;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function benchmarkMedians(report) {
  return (report?.files ?? []).flatMap((file) =>
    (file.groups ?? []).flatMap((group) =>
      (group.benchmarks ?? []).map((bench) => [`${group.fullName} > ${bench.name}`, bench.median]),
    ),
  );
}

/** Maps each benchmark to its median of every run, keyed by a checkout-independent name. */
export function collectSamples(reports) {
  const samples = new Map();
  for (const report of reports) {
    for (const [name, value] of benchmarkMedians(report)) {
      if (Number.isFinite(value)) samples.set(name, [...(samples.get(name) ?? []), value]);
    }
  }
  return samples;
}

/**
 * A change counts only beyond the threshold and when the run ranges do not
 * overlap: one slow run on either side stays noise.
 */
export function classify(base, head, threshold) {
  if (!base) return 'added';
  if (!head) return 'removed';
  const change = median(head) / median(base) - 1;
  if (change >= threshold && Math.min(...head) > Math.max(...base)) return 'regression';
  if (change <= -threshold && Math.max(...head) < Math.min(...base)) return 'gain';
  return 'noise';
}

export function compareBenchmarks(baseReports, headReports, threshold) {
  const base = collectSamples(baseReports);
  const head = collectSamples(headReports);
  const names = [...new Set([...base.keys(), ...head.keys()])].sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const baseRuns = base.get(name);
    const headRuns = head.get(name);
    return {
      name,
      base: baseRuns && median(baseRuns),
      head: headRuns && median(headRuns),
      status: classify(baseRuns, headRuns, threshold),
    };
  });
}

function cell(text) {
  return String(text)
    .replace(/^tests\/benchmarks\//, '')
    .replaceAll(/[\r\n]/g, ' ')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('<', '&lt;');
}

function ms(value) {
  return value === undefined ? '—' : String(Number(value.toPrecision(3)));
}

function table(rows) {
  return [
    '| Benchmark | Base (ms) | Head (ms) | Change |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map((row) => {
      const change = (row.head / row.base - 1) * 100;
      return `| ${cell(row.name)} | ${ms(row.base)} | ${ms(row.head)} | ${change > 0 ? '+' : ''}${change.toFixed(1)}% |`;
    }),
  ];
}

export function renderBenchComment(rows, { threshold, runs }) {
  const of = (status) => rows.filter((row) => row.status === status);
  const regressions = of('regression');
  const gains = of('gain');
  const oneSided = [...of('added'), ...of('removed')];
  const section = (title, items) => (items.length > 0 ? ['', `### ${title}`, ...table(items)] : []);
  return [
    MARKER,
    `## Benchmark A/B: ${regressions.length} regression(s), ${gains.length} gain(s)`,
    '',
    `Base and head ran interleaved on the same Linux runner, ${runs} run(s) each. ` +
      `A benchmark changes only beyond ±${Math.round(threshold * 100)}% of its median ` +
      'and when its base and head run ranges do not overlap. Informational, not blocking.',
    ...section('Regressions', regressions),
    ...section('Gains', gains),
    ...(oneSided.length > 0
      ? ['', '### Only on one side', ...oneSided.map((row) => `- ${row.status}: ${cell(row.name)}`)]
      : []),
    '',
    `${of('noise').length} benchmark(s) within noise.`,
  ].join('\n');
}

/** Creates or updates the sticky comment; `env` carries the GitHub Actions variables. */
export async function postComment(fetchImpl, env, body) {
  const [owner, repo, ...extra] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  const pullNumber = Number(env.PR_NUMBER);
  if (!owner || !repo || extra.length > 0 || !Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error('Invalid GitHub repository or pull request number');
  }
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`;
  const comments = await fetchJsonOrThrow(fetchImpl, endpoint, { headers }, 'list comments');
  const existing = findStickyComment(comments, MARKER);
  return upsertReviewComment(fetchImpl, endpoint, headers, existing, body);
}

function loadReports(dir, prefix) {
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
}

export async function main([dir, thresholdPercent = String(DEFAULT_THRESHOLD_PERCENT)], env = process.env, fetchImpl = fetch) {
  const threshold = Number(thresholdPercent) / 100;
  if (!dir || !(threshold > 0)) {
    throw new Error('Usage: node scripts/bench-compare.mjs <report-dir> [threshold-percent]');
  }
  const base = loadReports(dir, 'base-');
  const head = loadReports(dir, 'head-');
  if (base.length === 0 || head.length === 0) {
    throw new Error(`Expected base-*.json and head-*.json reports in ${dir}`);
  }
  const body = renderBenchComment(compareBenchmarks(base, head, threshold), {
    threshold,
    runs: Math.min(base.length, head.length),
  });
  process.stdout.write(`${body}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  if (env.GITHUB_TOKEN) await postComment(fetchImpl, env, body);
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
