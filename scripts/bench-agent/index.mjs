// Agent benchmark command (#399). This sub-issue (#675) ships the manual modes,
// which start no agent client and call no model (git object reads only):
//   npm run bench:agent -- --print-pack [--tasks <ids>] [--arms <ids>]
//   npm run bench:agent -- --score <answers.json> [--out <dir>]
// Both check the answer keys against the pinned corpus commit first.
// Unlike tests/evals/toolSelection.eval.test.ts, nothing here goes through
// LlmClientFactory or an API key: live runs use client subscriptions only (#676, #677).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport, checkAnswerKeys, renderMarkdown, sanitize, validateRuns, validateTasks } from './harness.mjs';

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

const USAGE = 'usage: npm run bench:agent -- (--print-pack | --score <answers.json>) [--tasks <ids>] [--arms <ids>] [--out <dir>]\n'
  + '(--client claude and --client codex come with #676 and #677)';

const list = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function parseOptions(argv) {
  /** @type {{ mode: 'print-pack' | 'score' | null, answers: string | null, tasks: string[] | null, arms: string[], out: string }} */
  const options = { mode: null, answers: null, tasks: null, arms: Object.keys(ARMS), out: path.join(REPO_ROOT, '.reports', 'agent-bench') };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      return value;
    };
    if (arg === '--print-pack') options.mode = 'print-pack';
    else if (arg === '--score') { options.mode = 'score'; options.answers = next(); }
    else if (arg === '--tasks') options.tasks = list(next());
    else if (arg === '--arms') options.arms = list(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else throw new Error(`unknown option ${arg}\n${USAGE}`);
  }
  if (!options.mode) throw new Error(USAGE);
  const unknownArms = options.arms.filter((arm) => !(arm in ARMS));
  if (unknownArms.length > 0 || options.arms.length === 0) throw new Error(`unknown arm(s) ${unknownArms.join(', ')}; known: ${Object.keys(ARMS).join(', ')}`);
  return options;
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

/** Same prefix for every task and arm (cache-friendly), then the question and its fixed answer shape. */
export function buildPrompt(task, hypotheses) {
  return [
    `You are answering a question about the repository in the current directory (Graph-It-Live at commit ${hypotheses.corpus.commit.slice(0, 12)}).`,
    'Do not modify any file. Paths are relative to the repository root and use "/".',
    'Reply with one JSON object only, no prose and no code fence, with exactly these fields and types:',
    JSON.stringify(task.answerShape),
    '',
    task.prompt,
  ].join('\n');
}

function verifyKeys(tasks, hypotheses, repoRoot) {
  const check = checkAnswerKeys(tasks, hypotheses.corpus.commit, repoRoot);
  if (!check.ok) throw new Error(`answer keys do not match corpus commit ${hypotheses.corpus.commit}:\n- ${check.errors.join('\n- ')}`);
  return check.corpusHash;
}

/** Task pack for manual runs (Copilot, Codex by hand): corpus setup, arm setup, prompts and an answers template. */
export function renderPack({ tasks, hypotheses, arms, corpusHash }) {
  const template = {
    meta: { client: 'copilot', clientVersion: null, model: null, effort: null, indexState: 'warm' },
    runs: tasks.flatMap((task) => arms.map((arm) => ({ taskId: task.id, arm, repetition: 1, response: '', metrics: { toolCalls: null, turns: null, latencyMs: null, inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: null } }))),
  };
  const agentFiles = AGENT_FILES.map((file) => `\`${file}\``).join(', ');
  return [
    '# Agent benchmark task pack',
    '',
    `Corpus: commit \`${hypotheses.corpus.commit}\` (${hypotheses.corpus.tag}), tree \`${corpusHash}\`.`,
    `Prepare a worktree: \`git worktree add --detach <worktree> ${hypotheses.corpus.commit}\`, then delete ${agentFiles} in it.`,
    'Graph arm: build the index once before the first task; report its cold time separately.',
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
  let harnessCommit = null;
  try {
    harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // NOSONAR S4036: developer tool, trusted PATH
  } catch {
    // Outside a git checkout: the report says "unknown".
  }
  return { harnessCommit, graphItLiveVersion: readJson(path.join(repoRoot, 'package.json')).version };
}

/** Scores a recorded answers file with the shared scorer and writes report.json and report.md. */
export function scoreAnswers({ answersFile, allTasks, tasks, hypotheses, arms, corpusHash, repoRoot, out, now = new Date() }) {
  const answers = readJson(answersFile);
  // Validated against every known task and arm; --tasks / --arms then narrow the report.
  const errors = validateRuns(answers?.runs, allTasks, Object.keys(ARMS));
  if (errors.length > 0) throw new Error(`invalid answers file:\n- ${errors.join('\n- ')}`);
  const runs = answers.runs.filter((run) => tasks.some((task) => task.id === run.taskId) && arms.includes(run.arm));
  const meta = {
    ...Object.fromEntries(Object.entries(answers.meta ?? {}).map(([key, value]) => [key, sanitize(value)])),
    ...harnessMeta(repoRoot),
    corpusCommit: hypotheses.corpus.commit,
    corpusTag: hypotheses.corpus.tag,
    corpusHash,
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

export function main(argv, { repoRoot = REPO_ROOT, dataDir = DATA_DIR, stdout = process.stdout } = {}) {
  const options = parseOptions(argv);
  const { hypotheses, allTasks, tasks } = loadDataset(dataDir, options.tasks);
  const corpusHash = verifyKeys(tasks, hypotheses, repoRoot);
  if (options.mode === 'print-pack') {
    const pack = renderPack({ tasks, hypotheses, arms: options.arms, corpusHash });
    stdout.write(`${pack}\n`);
    return pack;
  }
  const { markdown } = scoreAnswers({ answersFile: path.resolve(options.answers), allTasks, tasks, hypotheses, arms: options.arms, corpusHash, repoRoot, out: options.out });
  stdout.write(`${markdown}\n\nReport written to ${options.out}\n`);
  return markdown;
}

// An error propagates: Node prints it and exits with code 1.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
