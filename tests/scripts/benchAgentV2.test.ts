/**
 * Agent benchmark hypotheses v2 tests (#685)
 *
 * The v2 pack runs on several pinned corpora: schema, per-corpus key check
 * (corpus repositories from bench-e2e, mocked), scoring of the new answer
 * shapes, verdicts with the correctness gain, report, and the live loop over
 * corpora with one shared rerun budget. git is emulated and the client run is
 * mocked: no process is spawned, nothing is fetched.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  const refuse = (name: string) => () => {
    throw new Error(`benchAgentV2 tests must not spawn a process (${name})`);
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

// The real pins of scripts/bench-corpora.json, without loading bench-e2e (VS Code test runner, MCP session).
const benchE2e = vi.hoisted(() => ({
  CORPORA_DIR: '/corpora',
  OSS_CORPORA: {} as Record<string, { commit: string; url: string }>,
  fetchCorpusGit: vi.fn((name: string) => `/corpora/${name}.git`),
}));
vi.mock('../../scripts/bench-e2e.mjs', () => benchE2e);

const claudeRun = vi.hoisted(() => vi.fn());
vi.mock('../../scripts/bench-agent/claude.mjs', async (importOriginal) => ({ ...(await importOriginal<object>()), runClaudeBench: claudeRun }));

import { buildReport, corpusOf, renderMarkdown, scoreAnswer, validateTasks, type BenchTask, type Hypotheses, type RecordedRun } from '../../scripts/bench-agent/harness.mjs';
import { DATA_DIR, buildPrompt, loadDataset, main, parseOptions } from '../../scripts/bench-agent/index.mjs';
import { MAX_RERUNS } from '../../scripts/bench-agent/live.mjs';

const V2_DIR = path.join(DATA_DIR, 'v2');
const v1 = loadDataset(DATA_DIR);
const { hypotheses, allTasks: tasks } = loadDataset(V2_DIR);
const corpora = hypotheses.corpora as NonNullable<Hypotheses['corpora']>;
const pinned = JSON.parse(readFileSync(path.join(DATA_DIR, '..', '..', '..', 'scripts', 'bench-corpora.json'), 'utf8')) as Record<string, { commit: string; url: string }>;
const task = (id: string) => tasks.find((candidate) => candidate.id === id) as BenchTask;
const REPO = '/repo';
const TREE = 'a'.repeat(40);

/** Git repository of each corpus as the harness sees it: this checkout for `self`, the bare corpus repository otherwise. */
const gitDirOf = (name: string) => (name === 'self' ? REPO : `/corpora/${name}.git`);

/** Files of each corpus repository holding every key path and evidence symbol of its v2 tasks. */
function corpusRepos(): Map<string, { commit: string; files: Map<string, string> }> {
  const repos = new Map(Object.entries(corpora).map(([name, corpus]) => [gitDirOf(name), { commit: corpus.commit, files: new Map<string, string>() }]));
  for (const t of tasks) {
    const { files } = repos.get(gitDirOf(t.corpus as string))!;
    const add = (file: string, symbols: string[] = []) => files.set(file, `${files.get(file) ?? ''}\n${symbols.join(' ')}`);
    for (const [field, type] of Object.entries(t.answerShape)) {
      if (type === 'path') add(t.key[field] as string);
      if (type === 'path[]') (t.key[field] as string[]).forEach((file) => add(file));
      if (type === 'string[]') {
        for (const item of t.key[field] as string[]) {
          const [file, symbol] = item.split(':');
          if (symbol) add(file, symbol.split('.'));
        }
      }
    }
    t.evidence.forEach((entry) => add(entry.path, entry.symbols));
  }
  return repos;
}

/** Emulates the git commands of the key check and the report metadata, per repository (cwd). */
function emulateGit(repos = corpusRepos()) {
  childProcess.execFileSync.mockImplementation((command: string, args: string[], options: { cwd: string }) => {
    if (command !== 'git') throw new Error(`unexpected command ${command}`);
    const [sub, ...rest] = args;
    const spec = rest.at(-1) as string;
    if (sub === 'rev-parse' && spec === 'HEAD') return `${'f'.repeat(40)}\n`;
    if (sub === 'describe') return 'v1.24.2-9-gffffffff\n';
    const repo = repos.get(options.cwd);
    const [rev, file] = spec.split(/:(.*)/s);
    if (sub === 'rev-parse') return `${TREE}\n`;
    if (sub === 'cat-file' && spec.endsWith('^{commit}')) {
      if (repo?.commit !== spec.replace('^{commit}', '')) throw new Error('missing commit');
      return '';
    }
    if (repo?.commit !== rev || !repo.files.has(file)) throw new Error(`fatal: path ${file} does not exist ${JSON.stringify(args)} ${options.cwd}`);
    return sub === 'show' ? repo.files.get(file) : '';
  });
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-agent-v2-test-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.clearAllMocks();
  benchE2e.OSS_CORPORA = structuredClone(pinned);
  emulateGit();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork'] as const) {
    expect(childProcess[name]).not.toHaveBeenCalled();
  }
});

describe('v2 task pack schema', () => {
  it('accepts the v2 pack: 5 tasks one search cannot answer, 2 controls on this repository, 3 open-source corpora', () => {
    expect(validateTasks({ tasks }, hypotheses)).toEqual([]);
    expect(hypotheses.version).toBe(2);
    expect(tasks.map((t) => t.class).sort()).toEqual(['call-path', 'global-structure', 'greppable-name', 'known-file', 'transitive-impact', 'transitive-impact', 'transitive-impact']);
    expect(new Set(tasks.map((t) => t.corpus))).toEqual(new Set(['self', 'typescript-large', 'python', 'vue']));
    expect(tasks.filter((t) => t.corpus === 'self').map((t) => t.class).sort()).toEqual(['greppable-name', 'known-file']);
  });

  it('pins the same open-source commits as scripts/bench-corpora.json, and this repository at the v1 commit', () => {
    for (const [name, corpus] of Object.entries(corpora)) {
      expect(corpus.commit).toBe(name === 'self' ? v1.hypotheses.corpus?.commit : pinned[name].commit);
    }
  });

  it('keeps the v1 controls word for word, so the routing of #401 compares with the v1 baseline', () => {
    for (const control of tasks.filter((t) => t.corpus === 'self')) {
      const { class: _v2Class, corpus: _corpus, ...rest } = control;
      const { class: _v1Class, ...original } = v1.allTasks.find((t) => t.id === control.id) as BenchTask;
      expect(rest).toEqual(original);
      expect(buildPrompt(control, hypotheses)).toBe(buildPrompt(original as BenchTask, v1.hypotheses));
    }
  });

  it('only uses list answers or bare identifiers, never free text', () => {
    for (const t of tasks.filter((candidate) => candidate.corpus !== 'self')) {
      expect(Object.values(t.answerShape).some((type) => type.endsWith('[]'))).toBe(true);
      for (const [field, type] of Object.entries(t.answerShape)) {
        if (type === 'string') expect(t.key[field]).toMatch(/^\w+$/);
      }
    }
  });

  const base = task('impact-nest-module-keys');
  it.each([
    ['an unknown corpus', { ...base, corpus: 'cobol' }, 'corpus must be one of self, typescript-large, python, vue'],
    ['a task without corpus', { ...base, corpus: undefined }, 'corpus must be one of'],
    ['a v1 class', { ...base, class: 'localization' }, 'class must be one of transitive-impact, call-path, global-structure, known-file, greppable-name'],
  ])('rejects %s', (_label, broken, message) => {
    expect(validateTasks({ tasks: tasks.map((t) => (t === base ? broken : t)) }, hypotheses).join('\n')).toContain(message);
  });

  it.each([
    ['a bare method name no evidence lists', 'callpath-nest-scan-imports', 'methods', ['initialize', 'bootstrap'], 'key.methods item bootstrap is neither <safe path>:<symbol> nor an evidence symbol'],
    ['a qualified caller outside the corpus', 'impact-flask-make-response', 'callers', ['../outside.py:run'], 'key.callers item ../outside.py:run is neither'],
  ])('rejects a string-list key with %s', (_label, id, field, items, message) => {
    const broken = { ...task(id), key: { ...task(id).key, [field]: items } };
    expect(validateTasks({ tasks: tasks.map((t) => (t.id === id ? broken : t)) }, hypotheses).join('\n')).toContain(message);
  });

  it('rejects a corpus pinned by a short SHA', () => {
    const short = { ...hypotheses, corpora: { ...corpora, python: { ...corpora.python, commit: 'ab814966' } } };
    expect(validateTasks({ tasks }, short)).toEqual(['hypotheses corpora.python.commit must be a full 40-character SHA']);
  });
});

describe('v2 prompts', () => {
  it('names the corpus repository and its commit in the shared prefix', () => {
    expect(buildPrompt(task('impact-nest-module-keys'), hypotheses).split('\n')[0]).toBe('You are answering a question about the repository in the current directory (nest at commit d0fb875e23e3).');
    expect(buildPrompt(task('impact-flask-make-response'), hypotheses)).toContain('(flask at commit ab8149664182)');
    expect(buildPrompt(task('impact-vitepress-switch'), hypotheses)).toContain('(vitepress at commit 867b256e1485)');
    expect(corpusOf(task('known-file-toon'), v1.hypotheses)).toMatchObject({ name: 'self', repository: 'magic5644/Graph-It-Live' });
  });
});

describe('v2 key check', () => {
  it('checks each task against its own corpus commit, fetching only the open-source corpora', async () => {
    const printed = await main(['--print-pack', '--pack', 'v2', '--arms', 'native'], { repoRoot: REPO, stdout: { write: vi.fn() } });
    expect(benchE2e.fetchCorpusGit.mock.calls.map(([name]) => name).sort()).toEqual(['python', 'typescript-large', 'vue']);
    expect(benchE2e.fetchCorpusGit).toHaveBeenCalledWith('vue', pinned.vue, '/corpora');
    expect(printed).toContain(`Corpus nestjs/nest (v10.4.15): commit \`${corpora['typescript-large'].commit}\`, tree \`${TREE}\`, tasks impact-nest-module-keys, callpath-nest-scan-imports, cycle-nest-testing-builder.`);
    expect(printed).toContain(`git -C . archive ${corpora.self.commit} | tar -x -C <worktree>`);
    expect(printed).toContain(`git -C ../corpora/python.git archive ${corpora.python.commit}`);
  });

  it('fetches nothing for tasks of this repository only', async () => {
    await main(['--print-pack', '--pack', 'v2', '--tasks', 'known-file-toon'], { repoRoot: REPO, stdout: { write: vi.fn() } });
    expect(benchE2e.fetchCorpusGit).not.toHaveBeenCalled();
  });

  it('stops when a key path is missing at the corpus commit', async () => {
    const repos = corpusRepos();
    repos.get(gitDirOf('vue'))!.files.delete('src/client/theme-default/Layout.vue');
    emulateGit(repos);
    await expect(main(['--print-pack', '--pack', 'v2'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow(`answer keys do not match corpus commit ${corpora.vue.commit}:\n- src/client/theme-default/Layout.vue does not exist at 867b256e1485`);
  });

  it('stops when an evidence symbol is missing at the corpus commit', async () => {
    const repos = corpusRepos();
    repos.get(gitDirOf('python'))!.files.set('src/flask/helpers.py', 'make_response');
    emulateGit(repos);
    await expect(main(['--print-pack', '--pack', 'v2', '--tasks', 'impact-flask-make-response'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow('current_app not found in src/flask/helpers.py');
  });

  it('checks each <path>:<symbol> caller of a string-list key in its file at the corpus commit', async () => {
    const repos = corpusRepos();
    repos.get(gitDirOf('python'))!.files.set('src/flask/app.py', 'Flask make_response finalize_request full_dispatch_request handle_exception __call__');
    emulateGit(repos);
    await expect(main(['--print-pack', '--pack', 'v2', '--tasks', 'impact-flask-make-response'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow('wsgi_app not found in src/flask/app.py');
    repos.get(gitDirOf('python'))!.files.delete('src/flask/helpers.py');
    await expect(main(['--print-pack', '--pack', 'v2', '--tasks', 'impact-flask-make-response'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow('src/flask/helpers.py does not exist at ab8149664182');
  });

  it('refuses a corpus whose bench-corpora.json pin moved away from the frozen hypotheses', async () => {
    benchE2e.OSS_CORPORA.python = { ...pinned.python, commit: 'b'.repeat(40) };
    await expect(main(['--print-pack', '--pack', 'v2', '--tasks', 'impact-flask-make-response'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow(`corpus python: hypotheses pin ${corpora.python.commit}, scripts/bench-corpora.json pins ${'b'.repeat(40)}`);
    delete benchE2e.OSS_CORPORA.python;
    await expect(main(['--print-pack', '--pack', 'v2', '--tasks', 'impact-flask-make-response'], { repoRoot: REPO, stdout: { write: vi.fn() } }))
      .rejects.toThrow('scripts/bench-corpora.json pins nothing');
  });

  it('parses --pack, keeps v1 as the default and refuses an unknown pack', () => {
    expect(parseOptions(['--print-pack']).pack).toBe('v1');
    expect(parseOptions(['--print-pack', '--pack', 'v2']).pack).toBe('v2');
    expect(() => parseOptions(['--print-pack', '--pack', 'v3'])).toThrow('unknown pack v3; known: v1, v2');
  });
});

const answer = (id: string, overrides: Record<string, unknown> = {}) => JSON.stringify({ ...task(id).key, ...overrides });

describe('v2 answer shapes', () => {
  it('scores the caller list of the Python task as strings, and its method name exactly', () => {
    const t = task('impact-flask-make-response');
    expect(scoreAnswer(t, answer(t.id)).score).toBe(1);
    // Direct callers only: 2 of 6 found, no wrong one.
    const direct = scoreAnswer(t, answer(t.id, { callers: ['src/flask/app.py:Flask.finalize_request', 'src/flask/helpers.py:make_response'] }));
    expect(direct.fields.callers).toMatchObject({ precision: 1, recall: 2 / 6 });
    expect(direct.fields.method.score).toBe(1);
    expect(scoreAnswer(t, answer(t.id, { method: 'Flask.make_response' })).fields.method.score).toBe(0);
  });

  it('normalizes the component paths of the Vue task and scores extra components as lower precision', () => {
    const t = task('impact-vitepress-switch');
    const key = t.key.components as string[];
    const given = [...key.map((file) => `./${file.replaceAll('/', '\\')}`), 'src/client/theme-default/components/VPSwitch.vue'];
    expect(scoreAnswer(t, JSON.stringify({ components: given })).fields.components).toMatchObject({ precision: 8 / 9, recall: 1 });
  });

  it('scores a list answer that is not a list as 0', () => {
    expect(scoreAnswer(task('impact-vitepress-switch'), JSON.stringify({ components: 'src/client/theme-default/Layout.vue' }))).toMatchObject({ score: 0, recall: 0 });
  });

  it('scores the call path as an unordered list of bare method names', () => {
    const t = task('callpath-nest-scan-imports');
    expect(scoreAnswer(t, JSON.stringify({ methods: ['reflectImports', 'scanModulesForDependencies', 'scan', 'initialize'] })).score).toBe(1);
    expect(scoreAnswer(t, JSON.stringify({ methods: ['scan', 'reflectImports'] })).recall).toBe(0.5);
  });

  it('scores the cycle and the transitive files as path lists', () => {
    const cycle = task('cycle-nest-testing-builder');
    expect(scoreAnswer(cycle, JSON.stringify({ files: ['packages/testing/interfaces/index.ts'] })).recall).toBe(0.2);
    const impact = task('impact-nest-module-keys');
    expect(scoreAnswer(impact, answer(impact.id, { files: ['packages/common/decorators/modules/module.decorator.ts'] })).fields).toMatchObject({ function: { score: 1 }, files: { precision: 1, recall: 1 / 7 } });
  });
});

/** One completed run per task and arm: native finds the direct callers only; graph per the given answers and costs. */
function runsFor(graph: { answers?: Record<string, string>; toolCalls?: number; tokens?: number } = {}): RecordedRun[] {
  const metrics = (toolCalls: number, inputTokens: number) => ({ toolCalls, inputTokens, cacheWriteTokens: 0, outputTokens: 100 });
  const nativeAnswers: Record<string, string> = {
    'impact-nest-module-keys': answer('impact-nest-module-keys', { files: ['packages/common/decorators/modules/module.decorator.ts'] }),
    'impact-flask-make-response': answer('impact-flask-make-response', { callers: ['src/flask/app.py:Flask.finalize_request', 'src/flask/helpers.py:make_response'] }),
    'impact-vitepress-switch': JSON.stringify({ components: ['src/client/theme-default/components/VPSwitchAppearance.vue'] }),
  };
  return tasks.flatMap((t) => [
    { taskId: t.id, arm: 'native', status: 'completed' as const, response: nativeAnswers[t.id] ?? answer(t.id), metrics: metrics(4, 1000) },
    { taskId: t.id, arm: 'graph', status: 'completed' as const, response: graph.answers?.[t.id] ?? answer(t.id), metrics: metrics(graph.toolCalls ?? 4, graph.tokens ?? 1000) },
  ]);
}

const report = (runs: RecordedRun[]) => buildReport({ meta: { client: 'claude' }, tasks, hypotheses, arms: ['native', 'graph'], runs });
const verdictOf = (runs: RecordedRun[], name: string) => report(runs).verdicts.find((verdict) => verdict.class === name);

describe('v2 verdicts', () => {
  it('confirms transitive impact on a correctness gain, even at a higher cost', () => {
    const verdict = verdictOf(runsFor({ toolCalls: 9, tokens: 3000 }), 'transitive-impact');
    expect(verdict).toMatchObject({ verdict: 'confirmed', sample: { tasks: 3, runs: { native: 3, graph: 3 } } });
    expect(verdict?.reason).toMatch(/^correctness gain 0\.\d\d per task \(>= 0\.25\)$/);
    expect(verdict?.reductions?.providerTokens).toBeLessThan(0);
  });

  it('does not confirm a gain below 0.25 per task without a cost reduction', () => {
    // Graph finds 2 of 7 files instead of 1: +0.06 on one task, nothing on the others.
    const answers = {
      'impact-flask-make-response': answer('impact-flask-make-response', { callers: ['src/flask/app.py:Flask.finalize_request', 'src/flask/helpers.py:make_response'] }),
      'impact-vitepress-switch': JSON.stringify({ components: ['src/client/theme-default/components/VPSwitchAppearance.vue'] }),
      'impact-nest-module-keys': answer('impact-nest-module-keys', { files: ['packages/common/decorators/modules/module.decorator.ts', 'packages/core/router/router-module.ts'] }),
    };
    expect(verdictOf(runsFor({ answers }), 'transitive-impact')).toMatchObject({ verdict: 'not confirmed', reason: 'reduction below 20 %' });
  });

  it('confirms on the efficiency rule when correctness ties and the graph arm is cheaper', () => {
    expect(verdictOf(runsFor({ toolCalls: 2 }), 'call-path')).toMatchObject({ verdict: 'confirmed', reason: 'toolCalls reduced by >= 20 %' });
  });

  it('refutes when the graph answer is worse, even when cheaper', () => {
    const answers = { 'cycle-nest-testing-builder': JSON.stringify({ files: ['packages/testing/testing-injector.ts'] }) };
    expect(verdictOf(runsFor({ answers, toolCalls: 1 }), 'global-structure')).toMatchObject({ verdict: 'refuted', reason: 'lower correctness than native' });
  });

  it('judges the greppable-name control like the known-file control', () => {
    expect(verdictOf(runsFor(), 'greppable-name')).toMatchObject({ verdict: 'confirmed', reason: 'same correctness, within +1 tool call(s) and +25 % provider tokens' });
    expect(verdictOf(runsFor({ toolCalls: 6 }), 'greppable-name')).toMatchObject({ verdict: 'refuted', reason: 'control limit exceeded: callers-ignored-directory: +2 tool calls (limit +1)' });
  });

  it('reports the v2 limits and one line per corpus', () => {
    const built = buildReport({
      meta: { client: 'claude', corpora: Object.entries(corpora).map(([name, corpus]) => ({ name, ...corpus, tree: TREE })) },
      tasks, hypotheses, arms: ['native', 'graph'], runs: runsFor(),
    });
    expect(built.limits).toEqual(hypotheses.limits);
    const markdown = renderMarkdown(built);
    expect(markdown).toContain(`- Corpus pallets/flask: \`${corpora.python.commit}\` (3.1.0), tree \`${TREE}\``);
    expect(markdown).toContain('- Corpora: three public open-source projects at pinned commits');
  });
});

describe('v2 live run over corpora', () => {
  const run = (taskId: string): RecordedRun => ({ taskId, arm: 'native', status: 'completed', response: answer(taskId), metrics: { toolCalls: 1 } });
  const result = (corpusTasks: BenchTask[], meta: Record<string, unknown>) => ({ runs: corpusTasks.map((t) => run(t.id)), meta: { client: 'claude', clientVersion: '2.1', reruns: 0, coldIndexMs: null, stopReason: null, ...meta } });

  it('runs each corpus in turn with its own commit, repository and copy name, and one shared rerun budget', async () => {
    claudeRun.mockImplementation(async ({ tasks: corpusTasks, commit }) => result(corpusTasks, { reruns: commit === corpora.self.commit ? 2 : 1, coldIndexMs: 100 }));
    const out = tempDir();
    await main(['--client', 'claude', '--pack', 'v2', '--arms', 'native', '--out', out], { repoRoot: REPO, stdout: { write: vi.fn() }, env: {} });

    const calls = claudeRun.mock.calls.map(([input]) => input);
    expect(calls.map((input) => [input.dirName, input.commit, input.corpusGit, input.repoRoot, input.rerunBudget])).toEqual([
      ['Graph-It-Live', corpora.self.commit, REPO, REPO, MAX_RERUNS],
      ['nest', corpora['typescript-large'].commit, '/corpora/typescript-large.git', REPO, MAX_RERUNS - 2],
      ['flask', corpora.python.commit, '/corpora/python.git', REPO, MAX_RERUNS - 3],
      ['vitepress', corpora.vue.commit, '/corpora/vue.git', REPO, MAX_RERUNS - 4],
    ]);
    expect(calls[1].tasks.map((t: BenchTask) => t.id)).toEqual(['impact-nest-module-keys', 'callpath-nest-scan-imports', 'cycle-nest-testing-builder']);
    expect(calls[1].buildPrompt(task('impact-nest-module-keys'))).toBe(buildPrompt(task('impact-nest-module-keys'), hypotheses));

    const written = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(written.runs).toHaveLength(tasks.length);
    expect(written.meta).toMatchObject({ hypothesesVersion: 2, reruns: 5, coldIndexMs: 400 });
    expect(written.meta.corpora.map((corpus: { name: string }) => corpus.name)).toEqual(['self', 'typescript-large', 'python', 'vue']);
  });

  it('stops at the first corpus that hits a limit: no later corpus starts', async () => {
    claudeRun.mockImplementation(async ({ tasks: corpusTasks, commit }) => result(corpusTasks, { stopReason: commit === corpora['typescript-large'].commit ? 'usage limit reached' : null }));
    const out = tempDir();
    const markdown = await main(['--client', 'claude', '--pack', 'v2', '--arms', 'native', '--out', out], { repoRoot: REPO, stdout: { write: vi.fn() }, env: {} });
    expect(claudeRun).toHaveBeenCalledTimes(2);
    expect(markdown).toContain('- Stopped early: usage limit reached');
    expect(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')).runs).toHaveLength(5);
  });
});
