// Agent benchmark command (#399). Manual modes (#675) start no agent client and
// call no model (git object reads only); the live modes run Claude Code on the
// claude.ai subscription (#676) or Codex on the ChatGPT subscription (#677):
//   npm run bench:agent -- --print-pack [--pack v1|v2] [--tasks <ids>] [--arms <ids>]
//   npm run bench:agent -- --score <answers.json> [--pack v1|v2] [--out <dir>]
//   npm run bench:agent -- --client claude|codex [--pack v1|v2] [--dry-run] [--tasks <ids>] [--arms <ids>] [--out <dir>]
// v1 (default, #399) runs on this repository; v2 (#685) adds the pinned open-source
// corpora of scripts/bench-corpora.json, fetched by scripts/bench-e2e.mjs. Every mode
// checks the answer keys against each task's corpus commit first, so a bad key costs
// no tokens. Unlike tests/evals/toolSelection.eval.test.ts, nothing
// here goes through LlmClientFactory or an API key: subscriptions only.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPORA_DIR, OSS_CORPORA, fetchCorpusGit } from '../bench-e2e.mjs';
import { renderDryRun, runClaudeBench } from './claude.mjs';
import { renderCodexDryRun, runCodexBench } from './codex.mjs';
import { buildReport, checkAnswerKeys, corpusOf, renderMarkdown, sanitize, validateRuns, validateTasks } from './harness.mjs';
import { MAX_RERUNS, removedEnvNames } from './live.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'tests', 'evals', 'agent-bench');

/** Agent instruction files removed from the corpus worktree so repository guidance leaks into neither arm. */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude', '.github/copilot-instructions.md', 'plugins'];

export const ARMS = {
  native: {
    setup: 'No MCP server. Shell, file read and search tools only.',
    mcpServers: {},
  },
  graph: {
    setup: 'Graph-It-Live MCP server only (built from this checkout), plus the same native tools.',
    mcpServers: {
      'graph-it-live': { command: 'node', args: [path.join(REPO_ROOT, 'dist', 'mcpServer.mjs')], env: { WORKSPACE_ROOT: '<worktree>' } },
    },
  },
};

const USAGE = 'usage: npm run bench:agent -- (--print-pack | --score <answers.json> | --client claude|codex [--dry-run]) [--pack v1|v2] [--tasks <ids>] [--arms <ids>] [--out <dir>]';
/** Task pack directory per hypotheses version, under the data directory. */
export const PACKS = { v1: '.', v2: 'v2' };
const CLIENTS = {
  claude: { renderDryRun, run: runClaudeBench },
  codex: { renderDryRun: renderCodexDryRun, run: runCodexBench },
};

const list = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function parseOptions(argv) {
  /** @type {{ mode: 'print-pack' | 'score' | 'client' | null, answers: string | null, client: string | null, dryRun: boolean, pack: string, tasks: string[] | null, arms: string[], out: string }} */
  const options = { mode: null, answers: null, client: null, dryRun: false, pack: 'v1', tasks: null, arms: Object.keys(ARMS), out: path.join(REPO_ROOT, '.reports', 'agent-bench') };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      return value;
    };
    const setMode = (mode) => {
      if (options.mode && options.mode !== mode) throw new Error(`--print-pack, --score and --client exclude each other\n${USAGE}`);
      options.mode = mode;
    };
    if (arg === '--print-pack') setMode('print-pack');
    else if (arg === '--score') { setMode('score'); options.answers = next(); }
    else if (arg === '--client') { setMode('client'); options.client = next(); }
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--pack') options.pack = next();
    else if (arg === '--tasks') options.tasks = list(next());
    else if (arg === '--arms') options.arms = list(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  validateSelection(options);
  return options;
}

function validateSelection(options) {
  if (!options.mode) throw new Error(USAGE);
  if (options.mode === 'client' && !Object.hasOwn(CLIENTS, options.client)) throw new Error(`unknown client ${options.client}; known: ${Object.keys(CLIENTS).join(', ')}`);
  if (options.dryRun && options.mode !== 'client') throw new Error(`--dry-run needs --client\n${USAGE}`);
  if (!Object.hasOwn(PACKS, options.pack)) throw new Error(`unknown pack ${options.pack}; known: ${Object.keys(PACKS).join(', ')}`);
  const unknownArms = options.arms.filter((arm) => !Object.hasOwn(ARMS, arm));
  if (unknownArms.length > 0 || options.arms.length === 0) throw new Error(`unknown arm(s) ${unknownArms.join(', ')}; known: ${Object.keys(ARMS).join(', ')}`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Loads and validates the frozen hypotheses and the task pack, then keeps the selected tasks. */
export function loadDataset(dataDir = DATA_DIR, selected = null) {
  const hypotheses = readJson(path.join(dataDir, 'hypotheses.json'));
  const pack = readJson(path.join(dataDir, 'tasks.json'));
  const errors = validateTasks(pack, hypotheses);
  if (errors.length > 0) throw new Error(`invalid task pack:\n- ${errors.join('\n- ')}`);
  const unknown = (selected ?? []).filter((id) => !pack.tasks.some((task) => task.id === id));
  if (unknown.length > 0) throw new Error(`unknown task(s) ${unknown.join(', ')}`);
  return { hypotheses, allTasks: pack.tasks, tasks: selected ? pack.tasks.filter((task) => selected.includes(task.id)) : pack.tasks };
}

/** Last segment of `owner/name`: the corpus copy directory and the name used in prompts. */
export const repositoryName = (corpus) => corpus.repository.split('/').pop();

/** Same prefix for every task and arm of a corpus (cache-friendly), then the question and its fixed answer shape. */
export function buildPrompt(task, hypotheses) {
  const corpus = corpusOf(task, hypotheses);
  return [
    `You are answering a question about the repository in the current directory (${repositoryName(corpus)} at commit ${corpus.commit.slice(0, 12)}).`,
    'Do not modify any file. Paths are relative to the repository root and use "/".',
    'Reply with one JSON object only, no prose and no code fence, with exactly these fields and types:',
    JSON.stringify(task.answerShape),
    '',
    task.prompt,
  ].join('\n');
}

/**
 * Git repository holding a corpus commit: this checkout for `self`, otherwise the
 * open-source corpus pinned in scripts/bench-corpora.json, fetched (shallow, cached)
 * by bench-e2e. Both pins must name the same commit.
 */
function corpusGitDir(corpus, repoRoot) {
  if (corpus.name === 'self') return repoRoot;
  const pinned = OSS_CORPORA[corpus.name];
  if (pinned?.commit !== corpus.commit) {
    throw new Error(`corpus ${corpus.name}: hypotheses pin ${corpus.commit}, scripts/bench-corpora.json pins ${pinned?.commit ?? 'nothing'}`);
  }
  return fetchCorpusGit(corpus.name, pinned, CORPORA_DIR);
}

/** Groups the tasks by corpus and checks their keys against that corpus commit: one entry per corpus, with its tree hash. */
function verifyKeys(tasks, hypotheses, repoRoot) {
  const groups = Map.groupBy(tasks, (task) => corpusOf(task, hypotheses).name);
  return [...groups.values()].map((group) => {
    const corpus = corpusOf(group[0], hypotheses);
    const gitDir = corpusGitDir(corpus, repoRoot);
    const check = checkAnswerKeys(group, corpus.commit, gitDir);
    if (!check.ok) throw new Error(`answer keys do not match corpus commit ${corpus.commit}:\n- ${check.errors.join('\n- ')}`);
    return { ...corpus, tree: check.corpusHash, gitDir, tasks: group };
  });
}

const corpusMeta = (corpora) => corpora.map(({ name, repository, commit, tag, tree }) => ({ name, repository, commit, tag, tree }));

/** Task pack for manual runs (Copilot, Codex by hand): corpus setup, arm setup, prompts and an answers template. */
export function renderPack({ tasks, hypotheses, arms, corpora, repoRoot = REPO_ROOT }) {
  const template = {
    meta: { client: 'copilot', clientVersion: null, model: null, effort: null, indexState: 'warm' },
    runs: tasks.flatMap((task) => arms.map((arm) => ({ taskId: task.id, arm, repetition: 1, response: '', metrics: { toolCalls: null, turns: null, latencyMs: null, inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: null } }))),
  };
  const agentFiles = AGENT_FILES.map((file) => `\`${file}\``).join(', ');
  return [
    '# Agent benchmark task pack',
    '',
    ...corpora.map((corpus) => `Corpus ${corpus.repository} (${corpus.tag}): commit \`${corpus.commit}\`, tree \`${corpus.tree}\`, tasks ${corpus.tasks.map((task) => task.id).join(', ')}. Extract it: \`mkdir <worktree> && git -C ${path.relative(repoRoot, corpus.gitDir) || '.'} archive ${corpus.commit} | tar -x -C <worktree>\`, then delete ${agentFiles} in it.`),
    'Graph arm: build the index of each corpus once before its first task; report its cold time separately.',
    '',
    '## Arms',
    '',
    ...arms.flatMap((arm) => [`### ${arm}`, '', ARMS[arm].setup, '', '```json', JSON.stringify({ mcpServers: ARMS[arm].mcpServers }, null, 2), '```', '']),
    '## Tasks',
    '',
    ...tasks.flatMap((task) => [`### ${task.id} (${task.class})`, '', '```text', buildPrompt(task, hypotheses), '```', '']),
    '## Answers file',
    '',
    'Paste each JSON answer as `response` and the usage the client shows (leave `null` when unavailable; `cacheWriteTokens: 0` for a client without cache writes), then run `npm run bench:agent -- --score <answers.json>`.',
    '',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
  ].join('\n');
}

function harnessMeta(repoRoot) {
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // NOSONAR S4036: developer tool, trusted PATH
  let harnessCommit = null;
  // Not package.json: it holds a placeholder (CI sets the version); the tag distance names the build.
  let graphItLiveVersion = null;
  try {
    harnessCommit = git(['rev-parse', 'HEAD']);
    graphItLiveVersion = git(['describe', '--tags', '--always', '--dirty']);
  } catch {
    // Outside a git checkout: the report says "unknown".
  }
  return { harnessCommit, graphItLiveVersion };
}

/** Builds the report from recorded runs with the shared builder and writes report.json and report.md. */
function writeReport({ clientMeta, runs, tasks, hypotheses, arms, corpora, repoRoot, out, now }) {
  const meta = {
    ...Object.fromEntries(Object.entries(clientMeta).map(([key, value]) => [key, sanitize(value)])),
    ...harnessMeta(repoRoot),
    corpora: corpusMeta(corpora),
    hypothesesVersion: hypotheses.version,
    generatedAt: now.toISOString(),
  };
  const report = buildReport({
    meta,
    tasks,
    hypotheses,
    arms,
    runs: runs.map((run) => ({ ...run, prompt: run.prompt ?? buildPrompt(tasks.find((task) => task.id === run.taskId), hypotheses) })),
  });
  const markdown = renderMarkdown(report);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'report.md'), `${markdown}\n`);
  return { report, markdown };
}

/** Scores a recorded answers file with the shared scorer and writes report.json and report.md. */
export function scoreAnswers({ answersFile, allTasks, tasks, hypotheses, arms, corpora, repoRoot, out, now = new Date() }) {
  const answers = readJson(answersFile);
  // Validated against every known task and arm; --tasks / --arms then narrow the report.
  const errors = validateRuns(answers?.runs, allTasks, Object.keys(ARMS));
  if (errors.length > 0) throw new Error(`invalid answers file:\n- ${errors.join('\n- ')}`);
  const runs = answers.runs.filter((run) => tasks.some((task) => task.id === run.taskId) && arms.includes(run.arm));
  return writeReport({ clientMeta: answers.meta ?? {}, runs, tasks, hypotheses, arms, corpora, repoRoot, out, now });
}

/**
 * Runs the client on each corpus in turn (one subscription session at a time), sharing
 * one rerun budget; the first stop (limit, skipped client) ends the whole benchmark.
 */
async function runCorpora({ client, options, corpora, prompt, repoRoot, env }) {
  const runs = [];
  let meta = {};
  let reruns = 0;
  const coldBuilds = [];
  for (const corpus of corpora) {
    const result = await client.run({ tasks: corpus.tasks, arms: options.arms, armSpecs: ARMS, agentFiles: AGENT_FILES, buildPrompt: prompt, commit: corpus.commit, repoRoot, corpusGit: corpus.gitDir, dirName: repositoryName(corpus), rerunBudget: MAX_RERUNS - reruns, env }); // eslint-disable-line no-await-in-loop -- NOSONAR S9382: sequential on purpose, one subscription session at a time
    runs.push(...result.runs);
    reruns += result.meta.reruns ?? 0;
    if (typeof result.meta.coldIndexMs === 'number') coldBuilds.push(result.meta.coldIndexMs);
    meta = { ...result.meta, reruns, coldIndexMs: coldBuilds.length > 0 ? coldBuilds.reduce((sum, ms) => sum + ms, 0) : null };
    if (result.meta.stopReason) break;
  }
  return { runs, meta };
}

/** Live client run (or its dry run), then the same report as --score; a skipped client gets a report without runs. */
async function runClient({ options, tasks, hypotheses, corpora, repoRoot, env, stdout }) {
  const prompt = (task) => buildPrompt(task, hypotheses);
  const client = CLIENTS[options.client];
  if (options.dryRun) {
    const text = client.renderDryRun({ tasks, arms: options.arms, armSpecs: ARMS, buildPrompt: prompt, removedEnv: removedEnvNames(env) });
    stdout.write(`${text}\n`);
    return text;
  }
  const { runs, meta } = await runCorpora({ client, options, corpora, prompt, repoRoot, env });
  const { markdown } = writeReport({ clientMeta: meta, runs, tasks, hypotheses, arms: options.arms, corpora, repoRoot, out: options.out, now: new Date() });
  stdout.write(`${markdown}\n\nReport written to ${options.out}\n`);
  return markdown;
}

/** Resolves to the printed text; rejects on a wrong key, a refused route or bad input. */
export async function main(argv, { repoRoot = REPO_ROOT, dataDir = DATA_DIR, stdout = process.stdout, env = process.env } = {}) {
  const options = parseOptions(argv);
  const { hypotheses, allTasks, tasks } = loadDataset(path.join(dataDir, PACKS[options.pack]), options.tasks);
  const corpora = verifyKeys(tasks, hypotheses, repoRoot);
  if (options.mode === 'client') return runClient({ options, tasks, hypotheses, corpora, repoRoot, env, stdout });
  if (options.mode === 'print-pack') {
    const pack = renderPack({ tasks, hypotheses, arms: options.arms, corpora, repoRoot });
    stdout.write(`${pack}\n`);
    return pack;
  }
  const { markdown } = scoreAnswers({ answersFile: path.resolve(options.answers), allTasks, tasks, hypotheses, arms: options.arms, corpora, repoRoot, out: options.out });
  stdout.write(`${markdown}\n\nReport written to ${options.out}\n`);
  return markdown;
}

// An error (or a rejected live run) propagates: Node prints it and exits with code 1.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
