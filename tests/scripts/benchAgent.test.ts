/**
 * Agent benchmark offline foundation tests (#399, #675)
 *
 * scripts/bench-agent/ holds the task schema, the answer-key check against the
 * pinned corpus commit, the scorer, the verdicts, the report and the manual
 * modes (--print-pack, --score). git is emulated: no process is spawned, no
 * client binary, network, worktree or index is needed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  const refuse = (name: string) => () => {
    throw new Error(`benchAgent tests must not spawn a process (${name})`);
  };
  return {
    execFileSync: vi.fn(),
    spawn: vi.fn(refuse('spawn')),
    spawnSync: vi.fn(refuse('spawnSync')),
    exec: vi.fn(refuse('exec')),
    execSync: vi.fn(refuse('execSync')),
    execFile: vi.fn(refuse('execFile')),
    fork: vi.fn(refuse('fork')),
  };
});
vi.mock('node:child_process', () => ({ ...childProcess, default: childProcess }));

import {
  buildReport,
  checkAnswerKeys,
  computeVerdicts,
  isSafeRelativePath,
  parseAnswer,
  providerTokens,
  reduction,
  renderMarkdown,
  sanitize,
  scoreAnswer,
  validateRuns,
  validateTasks,
  type BenchTask,
  type Hypotheses,
  type RecordedRun,
} from '../../scripts/bench-agent/harness.mjs';
import { DATA_DIR, buildPrompt, loadDataset, main, parseOptions, renderPack } from '../../scripts/bench-agent/index.mjs';

const hypotheses = JSON.parse(readFileSync(path.join(DATA_DIR, 'hypotheses.json'), 'utf8')) as Hypotheses;
const pack = JSON.parse(readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf8')) as { tasks: BenchTask[] };
const example = JSON.parse(readFileSync(path.join(DATA_DIR, 'answers.example.json'), 'utf8')) as { meta: Record<string, string>; runs: RecordedRun[] };
const tasks = pack.tasks;
const COMMIT = hypotheses.corpus.commit;
const TREE = 'a'.repeat(40);
const ARMS = ['native', 'graph'];
const task = (id: string) => tasks.find((candidate) => candidate.id === id) as BenchTask;

/** Corpus files holding every key path and evidence symbol of the real task pack. */
function corpusFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const add = (file: string, symbols: string[] = []) => files.set(file, `${files.get(file) ?? ''}\n${symbols.join(' ')}`);
  for (const t of tasks) {
    for (const [field, type] of Object.entries(t.answerShape)) {
      if (type === 'path') add(t.key[field] as string);
      if (type === 'path[]') (t.key[field] as string[]).forEach((file) => add(file));
    }
    t.evidence.forEach((entry) => add(entry.path, entry.symbols));
  }
  return files;
}

/** Emulates the git commands the harness runs, from an in-memory corpus. */
function emulateGit(files: Map<string, string>, { commits = [COMMIT], head = 'f'.repeat(40) as string | null } = {}) {
  childProcess.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command !== 'git') throw new Error(`unexpected command ${command}`);
    const [sub, ...rest] = args;
    const spec = rest.at(-1) as string;
    const [rev, file] = spec.split(/:(.*)/s);
    if (sub === 'rev-parse' && spec === 'HEAD') {
      if (head === null) throw new Error('not a git repository');
      return `${head}\n`;
    }
    if (sub === 'rev-parse') return `${TREE}\n`;
    if (sub === 'cat-file' && spec.endsWith('^{commit}')) {
      if (!commits.includes(spec.replace('^{commit}', ''))) throw new Error('missing commit');
      return '';
    }
    if (!commits.includes(rev) || !files.has(file)) throw new Error(`fatal: path ${file} does not exist`);
    return sub === 'show' ? files.get(file) : '';
  });
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-agent-test-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.clearAllMocks();
  emulateGit(corpusFiles());
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  // Every child_process call went through the git emulator; none of the spawn family ran.
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork'] as const) {
    expect(childProcess[name]).not.toHaveBeenCalled();
  }
});

describe('task pack schema', () => {
  it('accepts the versioned task pack and frozen hypotheses', () => {
    expect(validateTasks(pack, hypotheses)).toEqual([]);
    expect(tasks.map((t) => t.class).sort()).toEqual(['callers-impact', 'known-file', 'known-file', 'localization', 'localization', 'multi-file-contract']);
  });

  const base = task('callers-ignored-directory');
  it.each([
    ['bad id', { ...base, id: 'Bad Id' }, 'id must match'],
    ['unknown class', { ...base, class: 'other' }, 'class must be one of'],
    ['empty prompt', { ...base, prompt: ' ' }, 'prompt must be a non-empty string'],
    ['no answer shape', { ...base, answerShape: {} }, 'answerShape must be a non-empty object'],
    ['no key', { ...base, key: null }, 'key must be an object'],
    ['unknown field type', { ...base, answerShape: { ...base.answerShape, extra: 'date' } }, 'unknown type date'],
    ['key of the wrong type', { ...base, key: { ...base.key, definedIn: 42 } }, 'key.definedIn must be a path'],
    ['unsafe key path', { ...base, key: { ...base.key, callers: ['../outside.ts'] } }, 'key.callers must be a path[]'],
    ['key field outside the shape', { ...base, key: { ...base.key, extra: 1 } }, 'key.extra is not in answerShape'],
    ['no evidence', { ...base, evidence: [] }, 'evidence must be a non-empty array'],
    ['unsafe evidence path', { ...base, evidence: [{ path: '/etc/passwd' }] }, 'evidence[0].path must be a safe relative path'],
    ['evidence symbol not an identifier', { ...base, evidence: [{ path: 'src/a.ts', symbols: ['a b'] }] }, 'symbols must be identifiers'],
    ['task not an object', 'task', 'must be an object'],
  ])('rejects %s', (_label, broken, message) => {
    const errors = validateTasks({ tasks: tasks.map((t) => (t === base ? broken : t)) }, hypotheses);
    expect(errors.join('\n')).toContain(message);
  });

  it('rejects duplicate ids, wrong class counts, a short corpus SHA and a missing tasks array', () => {
    const duplicated = validateTasks({ tasks: [...tasks, tasks[0]] }, hypotheses).join('\n');
    expect(duplicated).toContain('duplicate task id known-file-toon');
    expect(duplicated).toContain('class known-file needs 2 task(s), found 3');
    expect(validateTasks(pack, { ...hypotheses, corpus: { ...hypotheses.corpus, commit: '069917ca' } })).toEqual(['hypotheses corpus.commit must be a full 40-character SHA']);
    expect(validateTasks({}, hypotheses)).toEqual(['tasks file must have a tasks array']);
  });

  it.each([
    ['src/a.ts', true],
    ['src/dir/b.mjs', true],
    ['', false],
    ['/abs/a.ts', false],
    ['C:/a.ts', false],
    ['src\\a.ts', false],
    ['src/../a.ts', false],
    ['./src/a.ts', false],
    ['src//a.ts', false],
    ['-n', false],
    ['src/a\0.ts', false],
    [42, false],
  ])('isSafeRelativePath(%j) is %s', (value, expected) => {
    expect(isSafeRelativePath(value)).toBe(expected);
  });
});

describe('answer-key check against the pinned commit (git objects only)', () => {
  it('passes for the real keys and reports the corpus tree hash', () => {
    expect(checkAnswerKeys(tasks, COMMIT, '/repo')).toEqual({ ok: true, errors: [], corpusHash: TREE });
    const commands = childProcess.execFileSync.mock.calls.map(([, args]) => (args as string[])[0]);
    expect(new Set(commands)).toEqual(new Set(['cat-file', 'show', 'rev-parse']));
  });

  it('reports a key path missing at the commit', () => {
    const files = corpusFiles();
    files.delete('src/analyzer/utils/declarations.ts');
    emulateGit(files);
    const result = checkAnswerKeys(tasks, COMMIT, '/repo');
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([`src/analyzer/utils/declarations.ts does not exist at ${COMMIT.slice(0, 12)}`]);
  });

  it('reports an evidence symbol missing, matching whole identifiers only', () => {
    const files = corpusFiles();
    files.set('src/mcp/types.ts', 'McpWorkerResponseX warmupDuration indexedFiles resolveToolFilePaths TOOL_FILE_PATH_PARAMS');
    emulateGit(files);
    expect(checkAnswerKeys(tasks, COMMIT, '/repo').errors).toEqual([`McpWorkerResponse not found in src/mcp/types.ts at ${COMMIT.slice(0, 12)}`]);
  });

  it('matches symbols containing $', () => {
    const t = { ...task('known-file-toon'), evidence: [{ path: 'src/shared/toon.ts', symbols: ['$el'] }] };
    emulateGit(new Map([['src/shared/toon.ts', 'const $el = 1;']]));
    expect(checkAnswerKeys([t], COMMIT, '/repo').ok).toBe(true);
    emulateGit(new Map([['src/shared/toon.ts', 'const a$el = 1;']]));
    expect(checkAnswerKeys([t], COMMIT, '/repo').ok).toBe(false);
  });

  it('stops when the commit is absent or not a full SHA', () => {
    emulateGit(corpusFiles(), { commits: [] });
    expect(checkAnswerKeys(tasks, COMMIT, '/repo')).toEqual({ ok: false, errors: [`corpus commit ${COMMIT} is not in this repository (fetch it first)`], corpusHash: null });
    vi.clearAllMocks();
    expect(checkAnswerKeys(tasks, 'HEAD', '/repo').ok).toBe(false);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});

describe('scorer', () => {
  it.each([
    ['plain object', '{"a":1}', { ok: true, value: { a: 1 } }],
    ['fenced object', '```json\n{"a":1}\n```', { ok: true, value: { a: 1 } }],
    ['bare fence', '```\n{"a":1}```', { ok: true, value: { a: 1 } }],
    ['empty text', '  ', { ok: false, error: 'empty response' }],
    ['not a string', null, { ok: false, error: 'empty response' }],
    ['an array', '[1]', { ok: false, error: 'response is not a JSON object' }],
  ])('parseAnswer: %s', (_label, text, expected) => {
    expect(parseAnswer(text)).toEqual(expected);
  });

  it('parseAnswer reports malformed JSON', () => {
    const parsed = parseAnswer('{"a":');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/^malformed JSON: /);
  });

  it('scores an exact answer 1, normalizing paths', () => {
    const answer = JSON.stringify({ file: '.\\src\\analyzer\\utils\\workspaceText.ts', constant: ' MAX_TEXT_FILE_BYTES ', bytes: 2097152 });
    expect(scoreAnswer(task('localization-text-size-limit'), answer)).toMatchObject({ score: 1, recall: null, malformed: false });
  });

  it('scores each scalar field by exact match, wrong types included', () => {
    const scoring = scoreAnswer(task('localization-text-size-limit'), JSON.stringify({ file: 'src/other.ts', constant: 'MAX_TEXT_FILE_BYTES', bytes: '2097152' }));
    expect(scoring.fields).toEqual({ file: { score: 0 }, constant: { score: 1 }, bytes: { score: 0 } });
    expect(scoring.score).toBeCloseTo(1 / 3);
    expect(scoreAnswer(task('contract-mcp-worker-ready'), JSON.stringify({ ...task('contract-mcp-worker-ready').key, sentOnWarmupFailure: 'true' })).fields.sentOnWarmupFailure).toEqual({ score: 0 });
  });

  it('scores lists with precision, recall and F1, ignoring duplicates and non-strings', () => {
    const callers = task('callers-ignored-directory');
    const keyCallers = callers.key.callers as string[];
    const scoring = scoreAnswer(callers, JSON.stringify({ definedIn: callers.key.definedIn, callers: [keyCallers[0], keyCallers[0], keyCallers[1], 'src/wrong.ts', 7] }));
    expect(scoring.fields.callers).toEqual({ score: expect.closeTo(4 / 7), precision: expect.closeTo(2 / 3), recall: 0.5 });
    expect(scoring.recall).toBe(0.5);
    expect(scoring.score).toBeCloseTo((1 + 4 / 7) / 2);
    expect(scoreAnswer(callers, JSON.stringify({ definedIn: callers.key.definedIn, callers: [] })).fields.callers).toEqual({ score: 0, precision: 0, recall: 0 });
    expect(scoreAnswer(callers, JSON.stringify({ definedIn: callers.key.definedIn, callers: 'all' })).fields.callers).toEqual({ score: 0, precision: 0, recall: 0 });
    expect(scoreAnswer(callers, JSON.stringify({ definedIn: callers.key.definedIn })).recall).toBe(0);
  });

  it('scores an empty list key against an empty answer as a match', () => {
    const t = { ...task('callers-ignored-directory'), key: { definedIn: 'src/a.ts', callers: [] } };
    expect(scoreAnswer(t, '{"definedIn":"src/a.ts","callers":[]}').score).toBe(1);
  });

  it('scores malformed JSON 0, with recall 0 only for tasks with a list', () => {
    expect(scoreAnswer(task('callers-ignored-directory'), 'The callers are …')).toMatchObject({ score: 0, recall: 0, malformed: true });
    expect(scoreAnswer(task('known-file-toon'), '{oops')).toMatchObject({ score: 0, recall: null, malformed: true });
  });

  it('counts provider tokens as non-cached input, cache writes and output, never cache reads', () => {
    expect(providerTokens({ inputTokens: 100, cacheWriteTokens: 20, cacheReadTokens: 5000, outputTokens: 10 })).toBe(130);
    expect(providerTokens({ inputTokens: 100, cacheWriteTokens: 0, outputTokens: 10 })).toBe(110);
    expect(providerTokens({ inputTokens: 100, cacheWriteTokens: null, outputTokens: 10 })).toBeNull();
    expect(providerTokens({ inputTokens: 100, outputTokens: 10 })).toBeNull();
    expect(providerTokens({ inputTokens: 100, cacheWriteTokens: 0, outputTokens: null })).toBeNull();
    expect(providerTokens(undefined)).toBeNull();
  });

  it.each([
    [10, 5, 0.5],
    [10, 12, -0.2],
    [0, 5, null],
    [null, 5, null],
    [10, undefined, null],
  ])('reduction(%j, %j) is %j', (native, graph, expected) => {
    expect(reduction(native, graph)).toBe(expected);
  });
});

const meta = { client: 'example' };
const report = (runs: RecordedRun[]) => buildReport({ meta, tasks, hypotheses, arms: ARMS, runs });
const verdictOf = (runs: RecordedRun[], name: string) => report(runs).verdicts.find((verdict) => verdict.class === name);
/** The example fixture with the runs of one task and arm replaced. */
const withRuns = (taskId: string, arm: string, replacement: Partial<RecordedRun>[]) => [
  ...example.runs.filter((run) => !(run.taskId === taskId && run.arm === arm)),
  ...replacement.map((run) => ({ taskId, arm, ...run })),
];
const answerOf = (id: string) => JSON.stringify(task(id).key);

describe('automatic verdicts', () => {
  it('judges the recorded fixture per class, with its sample size', () => {
    const verdicts = report(example.runs).verdicts;
    expect(verdicts.map((v) => [v.class, v.verdict])).toEqual([
      ['localization', 'confirmed'],
      ['callers-impact', 'not confirmed'],
      ['multi-file-contract', 'confirmed'],
      ['known-file', 'confirmed'],
    ]);
    expect(verdicts[0].reductions).toEqual({ toolCalls: expect.closeTo(11 / 18), providerTokens: expect.closeTo(1 - 8600 / 15900) });
    expect(verdicts[1]).toMatchObject({ reason: 'reduction below 20 %', sample: { tasks: 1, runs: { native: 1, graph: 1 }, note: 'Not statistically significant.' } });
    expect(verdicts[2].reason).toBe('correctness >= native; provider tokens +20 %');
    expect(verdicts.every((v) => v.client === 'example')).toBe(true);
  });

  it('refutes an efficiency gain that comes with a lower score, without computing the saving', () => {
    const runs = withRuns('localization-text-size-limit', 'graph', [{ response: '{"file":"src/x.ts","constant":"X","bytes":1}', metrics: { toolCalls: 1, inputTokens: 10, cacheWriteTokens: 0, outputTokens: 1 } }]);
    expect(verdictOf(runs, 'localization')).toMatchObject({ verdict: 'refuted', reason: 'lower correctness than native', reductions: null });
  });

  it('refutes callers-impact when graph recall is lower', () => {
    const callers = task('callers-ignored-directory');
    const keyCallers = callers.key.callers as string[];
    const native = JSON.stringify({ definedIn: 'src/wrong.ts', callers: keyCallers });
    const graph = JSON.stringify({ definedIn: callers.key.definedIn, callers: keyCallers.slice(0, 3) });
    const runs = withRuns('callers-ignored-directory', 'native', [{ response: native, metrics: { toolCalls: 6, inputTokens: 5000, cacheWriteTokens: 0, outputTokens: 300 } }])
      .filter((run) => !(run.taskId === 'callers-ignored-directory' && run.arm === 'graph'))
      .concat([{ taskId: 'callers-ignored-directory', arm: 'graph', response: graph, metrics: { toolCalls: 2, inputTokens: 1000, cacheWriteTokens: 0, outputTokens: 100 } }]);
    expect(verdictOf(runs, 'callers-impact')).toMatchObject({ verdict: 'refuted', reason: 'lower caller recall than native' });
  });

  it('does not confirm callers-impact when caller recall is unavailable', () => {
    const cells = report(example.runs).cells.map((cell) => (cell.class === 'callers-impact' && cell.arm === 'graph' ? { ...cell, recall: null } : cell));
    expect(computeVerdicts(hypotheses, cells, 'x').find((v) => v.class === 'callers-impact')).toMatchObject({ verdict: 'not confirmed', reason: 'caller recall unavailable' });
  });

  it('confirms callers-impact on equal correctness and a tool-call reduction', () => {
    const runs = withRuns('callers-ignored-directory', 'native', [{ response: answerOf('callers-ignored-directory'), metrics: { toolCalls: 10, inputTokens: 4800, cacheWriteTokens: 0, outputTokens: 300 } }]);
    expect(verdictOf(runs, 'callers-impact')).toMatchObject({ verdict: 'confirmed', reason: 'toolCalls reduced by >= 20 %' });
  });

  it.each([
    ['two extra tool calls', { toolCalls: 4, inputTokens: 1000, cacheWriteTokens: 0, outputTokens: 100 }, 'known-file-toon: +2 tool calls (limit +1)'],
    ['30 % more provider tokens', { toolCalls: 2, inputTokens: 1330, cacheWriteTokens: 0, outputTokens: 100 }, 'known-file-toon: +30 % provider tokens (limit +25 %)'],
  ])('refutes a known-file control with %s', (_label, metrics, reason) => {
    const runs = withRuns('known-file-toon', 'graph', [{ response: answerOf('known-file-toon'), metrics }]);
    expect(verdictOf(runs, 'known-file')).toMatchObject({ verdict: 'refuted', reason: `control limit exceeded: ${reason}` });
  });

  it('does not confirm a known-file control whose graph correctness is higher, or whose metrics are unavailable', () => {
    const better = withRuns('known-file-toon', 'native', [{ response: '{"function":"x","encoding":"cl100k_base"}', metrics: { toolCalls: 2, inputTokens: 1000, cacheWriteTokens: 0, outputTokens: 100 } }]);
    expect(verdictOf(better, 'known-file')).toMatchObject({ verdict: 'not confirmed', reason: 'correctness differs (higher in graph arm)' });
    const unavailable = withRuns('known-file-toon', 'graph', [{ response: answerOf('known-file-toon'), metrics: { toolCalls: 3 } }]);
    expect(verdictOf(unavailable, 'known-file')).toMatchObject({ verdict: 'not confirmed', reason: 'tool calls or provider tokens unavailable' });
  });

  it('does not confirm an efficiency class when its metrics are unavailable', () => {
    const strip = (runs: RecordedRun[]) => runs.map((run) => (run.taskId.startsWith('localization') ? { ...run, metrics: {} } : run));
    expect(verdictOf(strip(example.runs), 'localization')).toMatchObject({ verdict: 'not confirmed', reason: 'efficiency metrics unavailable', reductions: { toolCalls: null, providerTokens: null } });
  });

  it('reports the multi-file token cost as unavailable without usage', () => {
    const runs = example.runs.map((run) => (run.taskId === 'contract-mcp-worker-ready' ? { ...run, metrics: {} } : run));
    expect(verdictOf(runs, 'multi-file-contract')?.reason).toBe('correctness >= native; token cost unavailable');
    const cheaper = withRuns('contract-mcp-worker-ready', 'graph', [{ response: answerOf('contract-mcp-worker-ready'), metrics: { inputTokens: 5000, cacheWriteTokens: 0, outputTokens: 300 } }]);
    expect(verdictOf(cheaper, 'multi-file-contract')?.reason).toBe('correctness >= native; provider tokens -50 %');
  });

  it('does not confirm a class with a task lacking a completed run in either arm', () => {
    const runs = withRuns('contract-mcp-worker-ready', 'graph', [{ status: 'rate-limited', error: 'usage limit reached' }]);
    expect(verdictOf(runs, 'multi-file-contract')).toMatchObject({ verdict: 'not confirmed', reason: 'contract-mcp-worker-ready has no completed run in the graph arm', totals: null });
    const noTasks = computeVerdicts({ ...hypotheses, classes: { extra: { tasks: 1, hypothesis: 'h' } } }, [], 'x');
    expect(noTasks[0]).toMatchObject({ verdict: 'not confirmed', reason: 'no task run' });
  });
});

describe('report', () => {
  it('keeps every run, failures included, and aggregates per task and arm', () => {
    const built = report(example.runs);
    expect(built.runs).toHaveLength(example.runs.length);
    expect(built.meta).toEqual({ client: 'example', repetitions: 2 });
    const callersGraph = built.cells.find((cell) => cell.taskId === 'callers-ignored-directory' && cell.arm === 'graph');
    expect(callersGraph).toMatchObject({ runs: 2, completed: 1, statuses: ['timeout', 'completed'], correctness: 1, recall: 1 });
    expect(callersGraph?.metrics.toolCalls).toBe(6);
    const toonGraph = built.cells.find((cell) => cell.taskId === 'known-file-toon' && cell.arm === 'graph');
    expect(toonGraph?.retrieval).toEqual({ cl100kTokens: 300, jsonChars: 2000, toonChars: 1200 });
    expect(toonGraph?.providerTokens).toBe(1300);
    expect(built.runs.find((run) => run.status === 'timeout')?.scoring).toBeNull();
  });

  it('marks a run without status or response incomplete and a metric missing in one run unavailable', () => {
    const built = report([
      { taskId: 'known-file-toon', arm: 'native', response: answerOf('known-file-toon'), metrics: { toolCalls: 2, turns: 3 } },
      { taskId: 'known-file-toon', arm: 'native', repetition: 2, response: answerOf('known-file-toon'), metrics: { toolCalls: 4 } },
      { taskId: 'known-file-toon', arm: 'graph', response: '' },
    ]);
    const native = built.cells.find((cell) => cell.taskId === 'known-file-toon' && cell.arm === 'native');
    expect(native?.metrics).toMatchObject({ toolCalls: 3, turns: null });
    expect(built.runs[2]).toMatchObject({ status: 'incomplete', scoring: null });
    expect(built.cells.find((cell) => cell.taskId === 'known-file-ignored-dirs' && cell.arm === 'graph')).toMatchObject({ runs: 0, correctness: null });
  });

  it('sanitizes prompts, responses and errors', () => {
    const built = report([{ taskId: 'known-file-toon', arm: 'native', status: 'failed', prompt: 'p', response: 'key sk-abcdefghijklmnop', error: 'auth for someone@example.com failed' }]);
    expect(built.runs[0]).toMatchObject({ response: 'key [REDACTED_KEY]', error: 'auth for [REDACTED_EMAIL] failed' });
  });

  it('renders verdicts, then correctness before cost, then failures and limits', () => {
    const markdown = renderMarkdown(report(example.runs));
    const order = ['## Verdicts', '## Runs per task and arm', '## Failures and incomplete runs', '## Limits'].map((heading) => markdown.indexOf(heading));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
    expect(markdown).toContain('| localization | **confirmed** | 1.67 / 2.00 | 61 % | 46 % |');
    expect(markdown).toContain('| Task | Class | Arm | Completed | Correctness |');
    expect(markdown).toContain('Notional cost USD');
    expect(markdown).toContain('- callers-ignored-directory / graph #1: timeout: no answer after 300 s');
    expect(markdown).toMatch(/- contract-mcp-worker-ready \/ native #1: completed \(malformed JSON: /);
    expect(markdown).toContain('not statistically significant');
  });

  it('renders unavailable values and an empty failure list', () => {
    const markdown = renderMarkdown(report([{ taskId: 'known-file-toon', arm: 'native', response: answerOf('known-file-toon') }]));
    expect(markdown).toContain('| known-file-toon | known-file | native | 1/1 | 1.00 | unavailable | unavailable |');
    expect(markdown).toContain('None.');
    expect(markdown).toContain('# Agent benchmark: example');
  });

  it.each([
    ['plain text', 'nothing secret', 'nothing secret'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz', '[REDACTED_TOKEN]'],
    ['bearer header', 'Authorization: Bearer abc.def-ghi_jkl', 'Authorization: Bearer [REDACTED_TOKEN]'],
    ['e-mail address but not a version pin', 'mail a.b@mail.example.org about graph-it-live@1.24.2', 'mail [REDACTED_EMAIL] about graph-it-live@1.24.2'],
    ['home directory', '/home/me/project/a.ts and /home/me', '~/project/a.ts and ~'],
  ])('sanitize: %s', (_label, input, expected) => {
    expect(sanitize(input, '/home/me')).toBe(expected);
  });

  it('sanitize leaves non-strings and a root home untouched', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize('/a', '/')).toBe('/a');
  });

  it('validates recorded runs at the trust boundary', () => {
    expect(validateRuns(example.runs, tasks, ARMS)).toEqual([]);
    expect(validateRuns('x', tasks, ARMS)).toEqual(['runs must be an array']);
    expect(validateRuns([1, { taskId: 'nope', arm: 'x', status: 'done', response: 3, metrics: [], retrieval: 'r' }], tasks, ARMS)).toEqual([
      'runs[0] must be an object',
      'runs[1].taskId nope is not a known task',
      'runs[1].arm must be one of native, graph',
      'runs[1].status must be one of completed, failed, timeout, rate-limited, incomplete',
      'runs[1].response must be a string',
      'runs[1].metrics must be an object',
      'runs[1].retrieval must be an object',
    ]);
  });
});

describe('manual modes', () => {
  it.each([
    [['--print-pack'], { mode: 'print-pack', tasks: null, arms: ['native', 'graph'] }],
    [['--score', 'a.json', '--tasks', 'a, b', '--arms', 'graph'], { mode: 'score', answers: 'a.json', tasks: ['a', 'b'], arms: ['graph'] }],
    [['--client', 'claude', '--dry-run', '--arms', 'native'], { mode: 'client', client: 'claude', dryRun: true, arms: ['native'] }],
    [['--client', 'claude'], { mode: 'client', client: 'claude', dryRun: false }],
    [['--client', 'codex', '--dry-run'], { mode: 'client', client: 'codex', dryRun: true }],
  ])('parseOptions(%j)', (argv, expected) => {
    expect(parseOptions(argv)).toMatchObject(expected);
  });

  it.each([
    [[], 'usage: npm run bench:agent'],
    [['--client', 'copilot'], 'unknown client copilot; known: claude, codex'],
    [['--client', 'toString'], 'unknown client toString'],
    [['--client'], '--client needs a value'],
    [['--print-pack', '--dry-run'], '--dry-run needs --client'],
    [['--dry-run'], 'usage: npm run bench:agent'],
    [['--score', 'a.json', '--client', 'claude'], '--print-pack, --score and --client exclude each other'],
    [['--score'], '--score needs a value'],
    [['--score', '--tasks'], '--score needs a value'],
    [['--print-pack', '--arms', 'routing'], 'unknown arm(s) routing'],
    [['--print-pack', '--arms', ','], 'unknown arm(s)'],
  ])('parseOptions(%j) fails', (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(message);
  });

  it('parseOptions resolves --out', () => {
    expect(parseOptions(['--print-pack', '--out', 'rel']).out).toBe(path.resolve('rel'));
  });

  it('loads the dataset, narrows it and rejects unknown or invalid tasks', () => {
    expect(loadDataset(DATA_DIR, ['known-file-toon']).tasks.map((t) => t.id)).toEqual(['known-file-toon']);
    expect(loadDataset().allTasks).toHaveLength(6);
    expect(() => loadDataset(DATA_DIR, ['nope'])).toThrow('unknown task(s) nope');
    const dir = tempDir();
    writeFileSync(path.join(dir, 'hypotheses.json'), JSON.stringify(hypotheses));
    writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: tasks.slice(1) }));
    expect(() => loadDataset(dir)).toThrow('class known-file needs 2 task(s), found 1');
  });

  it('builds one shared prompt prefix with the fixed answer shape', () => {
    const prompt = buildPrompt(task('known-file-toon'), hypotheses);
    expect(prompt.split('\n')[0]).toBe(buildPrompt(task('contract-mcp-worker-ready'), hypotheses).split('\n')[0]);
    expect(prompt).toContain('{"function":"string","encoding":"string"}');
    expect(prompt).toContain(COMMIT.slice(0, 12));
    expect(prompt.endsWith(task('known-file-toon').prompt)).toBe(true);
  });

  it('--print-pack checks the keys, then prints corpus setup, arms, prompts and an answers template', async () => {
    const out: string[] = [];
    const printed = await main(['--print-pack', '--tasks', 'known-file-toon', '--arms', 'graph'], { stdout: { write: (text: string) => out.push(text) } });
    expect(out.join('')).toBe(`${printed}\n`);
    expect(printed).toContain(`git worktree add --detach <worktree> ${COMMIT}`);
    expect(printed).toContain('`AGENTS.md`, `CLAUDE.md`, `.claude`, `.github/copilot-instructions.md`, `plugins`');
    expect(printed).toContain('"WORKSPACE_ROOT": "<worktree>"');
    expect(printed).not.toContain('### native');
    expect(printed).toContain(buildPrompt(task('known-file-toon'), hypotheses));
    const template = JSON.parse(printed.slice(printed.lastIndexOf('```json\n') + 8, -4));
    expect(template.runs).toEqual([expect.objectContaining({ taskId: 'known-file-toon', arm: 'graph', response: '' })]);
    expect(printed).not.toContain('estimateTokenSavings');
  });

  it('renderPack prints the native arm without MCP server', () => {
    expect(renderPack({ tasks: [task('known-file-toon')], hypotheses, arms: ['native'], corpusHash: TREE })).toContain('"mcpServers": {}');
  });

  it('stops before printing anything when a key does not match the corpus', async () => {
    emulateGit(new Map());
    const write = vi.fn();
    await expect(main(['--print-pack'], { stdout: { write } })).rejects.toThrow(`answer keys do not match corpus commit ${COMMIT}`);
    expect(write).not.toHaveBeenCalled();
  });

  it('--client claude --dry-run checks the keys, then prints prompts and commands without starting anything', async () => {
    const out: string[] = [];
    const printed = await main(['--client', 'claude', '--dry-run', '--tasks', 'known-file-toon'], { stdout: { write: (text: string) => out.push(text) }, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x' } });
    expect(out.join('')).toBe(`${printed}\n`);
    expect(printed).toContain('Child environment drops: ANTHROPIC_API_KEY;');
    expect(printed).not.toContain('sk-x');
    expect(printed).toContain(buildPrompt(task('known-file-toon'), hypotheses));
    expect(printed).toContain('## Arm native');
    expect(printed).toContain('## Arm graph');
    // Only the git object reads of the key check ran.
    expect(childProcess.execFileSync.mock.calls.every(([command]) => command === 'git')).toBe(true);
  });

  it('--client codex --dry-run prints the arm config.toml and command without starting anything', async () => {
    const printed = await main(['--client', 'codex', '--dry-run', '--tasks', 'known-file-toon', '--arms', 'graph'], { stdout: { write: vi.fn() }, env: { PATH: '/bin', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'sk-y' } });
    expect(printed).toContain('# Agent benchmark dry run: codex');
    expect(printed).toContain('Child environment drops: CODEX_API_KEY, OPENAI_API_KEY;');
    expect(printed).not.toMatch(/sk-[xy]/);
    expect(printed).toContain('[mcp_servers.graph-it-live]');
    expect(printed).toContain('codex exec --json');
    expect(printed).toContain(buildPrompt(task('known-file-toon'), hypotheses));
    expect(childProcess.execFileSync.mock.calls.every(([command]) => command === 'git')).toBe(true);
  });

  it('--client claude stops on a wrong answer key before any client command', async () => {
    emulateGit(new Map());
    const write = vi.fn();
    await expect(main(['--client', 'claude'], { stdout: { write } })).rejects.toThrow(`answer keys do not match corpus commit ${COMMIT}`);
    expect(childProcess.execFileSync.mock.calls.every(([command]) => command === 'git')).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('--client claude refuses to start when the subscription route cannot be verified', async () => {
    const write = vi.fn();
    await expect(main(['--client', 'claude', '--arms', 'native'], { stdout: { write }, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x' } }))
      .rejects.toThrow('refusing to start: Claude Code auth route cannot be verified (unexpected command claude)');
    expect(childProcess.execFileSync).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], expect.objectContaining({ env: expect.not.objectContaining({ ANTHROPIC_API_KEY: expect.anything() }) }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('--score scores the answers file and writes report.json and report.md', async () => {
    const out = tempDir();
    const write = vi.fn();
    const markdown = await main(['--score', path.join(DATA_DIR, 'answers.example.json'), '--out', out], { stdout: { write } });
    expect(markdown).toContain('| known-file | **confirmed** |');
    const written = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(written.meta).toMatchObject({ client: 'example', model: 'example-model', corpusCommit: COMMIT, corpusTag: 'v1.24.2', corpusHash: TREE, harnessCommit: 'f'.repeat(40), hypothesesVersion: 1, repetitions: 2 });
    expect(written.runs[0].prompt).toBe(buildPrompt(task('known-file-toon'), hypotheses));
    expect(readFileSync(path.join(out, 'report.md'), 'utf8')).toBe(`${markdown}\n`);
    expect(write.mock.calls[0][0]).toContain(`Report written to ${out}`);
  });

  it('--score narrows the report with --tasks and --arms, records an unknown harness commit, and rejects an invalid answers file', async () => {
    emulateGit(corpusFiles(), { head: null });
    const out = tempDir();
    await main(['--score', path.join(DATA_DIR, 'answers.example.json'), '--tasks', 'known-file-toon', '--arms', 'native', '--out', out], { stdout: { write: vi.fn() } });
    const written = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(written.runs.map((run: RecordedRun) => `${run.taskId}/${run.arm}`)).toEqual(['known-file-toon/native']);
    expect(written.meta.harnessCommit).toBeNull();
    expect(written.verdicts.find((v: { class: string }) => v.class === 'known-file')).toMatchObject({ verdict: 'not confirmed', reason: 'known-file-toon has no completed run in the graph arm' });
    const bad = path.join(tempDir(), 'answers.json');
    writeFileSync(bad, JSON.stringify({ runs: [{ taskId: 'nope', arm: 'native' }] }));
    await expect(main(['--score', bad, '--out', out], { stdout: { write: vi.fn() } })).rejects.toThrow('invalid answers file:\n- runs[0].taskId nope is not a known task');
  });
});
