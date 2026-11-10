// Shared guards and plumbing of the live agent benchmark runs (#399, #676; reused by
// the Codex run of #677): child environment without API keys or billing routes,
// rate-limit / allowance detection, the isolated corpus copies per arm with their warm
// index, one client process with a timeout, and the cell loop with its rerun plan.
// Subscription routes only: nothing here retries a limit.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scoreAnswer } from './harness.mjs';

/**
 * Variables that select a metered API, a key, a gateway or another provider, plus the
 * parent Claude Code session (nested-session markers, plugin dirs, effort override).
 * CLAUDE_CONFIG_DIR stays: it locates the subscription login.
 */
const BILLING_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|OPENAI_|AZURE_OPENAI_|CODEX_API_KEY$|AWS_BEARER_TOKEN_BEDROCK$|GEMINI_API_KEY$|GOOGLE_API_KEY$|GOOGLE_GENAI_|GRAPH_IT_LLM_)/i;

/** Copy of env without any API key, auth token, base URL, provider switch or parent-session variable. */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !BILLING_ENV.test(name)));
}

/** Names childEnv removes from env, for the dry-run and the report (values are never printed). */
export function removedEnvNames(env) {
  return Object.keys(env).filter((name) => BILLING_ENV.test(name)).sort((a, b) => a.localeCompare(b));
}

const LIMIT_TEXT = /rate.?limit|usage limit|limit reached|hit your (?:usage )?limit|allowance|out of (?:extra )?usage|credits? (?:required|exhausted)|overage|quota|\b429\b/i;

/** True for a rate-limit, usage-limit, allowance, credits or overage message. */
export function isLimitMessage(text) {
  return typeof text === 'string' && LIMIT_TEXT.test(text);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); // NOSONAR S4036: developer tool, trusted PATH
}

/**
 * Copy of the corpus commit (`git archive`, so no `.git`: no later commit to read) in a
 * new temporary directory, named like the repository so the working directory does not
 * reveal the arm, then without the agent instruction files. Answer keys and reports stay
 * in repoRoot, outside the copy.
 */
export function exportCorpus(repoRoot, commit, agentFiles) {
  const parent = mkdtempSync(path.join(tmpdir(), 'agent-bench-'));
  const dir = path.join(parent, 'Graph-It-Live');
  const archive = path.join(parent, 'corpus.tar');
  try {
    git(repoRoot, ['archive', '--format=tar', '-o', archive, commit]);
    mkdirSync(dir);
    execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'ignore' }); // NOSONAR S4036: developer tool, trusted PATH
    rmSync(archive, { force: true });
    for (const file of agentFiles) rmSync(path.join(dir, file), { recursive: true, force: true });
  } catch (error) {
    removeCorpus(dir);
    throw error;
  }
  return dir;
}

/** Removes a copy made by exportCorpus with its temporary parent. Never throws. */
export function removeCorpus(dir) {
  rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Runs one client process: writes input to stdin, passes each stdout line to onLine,
 * and kills the process when onLine returns true or timeoutMs elapses (SIGTERM, then
 * SIGKILL after KILL_GRACE_MS). Resolves once, never rejects; a grandchild that keeps
 * stdout open cannot hold it past KILL_GRACE_MS after the exit.
 */
export const KILL_GRACE_MS = 5000;

export function runProcess(command, args, { cwd, env, input, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); // NOSONAR S4036: developer tool, trusted PATH
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    let spawnError = null;
    let settled = false;
    const timers = [];
    const later = (ms, action) => timers.push(setTimeout(action, ms));
    const settle = (code) => {
      if (settled) return;
      handle(buffer);
      settled = true;
      timers.forEach(clearTimeout);
      resolve({ code, timedOut, stopped, stderr: spawnError ?? stderr });
    };
    const kill = () => {
      child.kill('SIGTERM');
      later(KILL_GRACE_MS, () => child.kill('SIGKILL'));
    };
    const handle = (line) => {
      if (!stopped && !settled && line.trim() !== '' && onLine(line)) {
        stopped = true;
        kill();
      }
    };
    later(timeoutMs, () => {
      timedOut = true;
      kill();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      lines.forEach(handle);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (error) => {
      spawnError = error.message;
      later(KILL_GRACE_MS, () => settle(null));
    });
    child.on('exit', (code) => later(KILL_GRACE_MS, () => settle(code)));
    child.on('close', (code) => settle(code));
    child.stdin.on('error', () => {
      // The process exited before reading stdin; close reports it.
    });
    child.stdin.end(input);
  });
}

export const MAX_RERUNS = 6;

/**
 * Second runs (#399: at most 6): first each cell whose run failed or timed out, then
 * both cells of a task whose arms disagree on correctness. A rate limit stops the whole
 * benchmark instead, so it never gets here.
 */
export function planReruns(runs, tasks, arms, budget = MAX_RERUNS) {
  const plan = [];
  const add = (taskId, arm) => {
    if (!plan.some((cell) => cell.taskId === taskId && cell.arm === arm)) plan.push({ taskId, arm });
  };
  for (const run of runs) if (run.status === 'failed' || run.status === 'timeout') add(run.taskId, run.arm);
  for (const task of tasks) {
    const scores = arms.map((arm) => runs.find((run) => run.taskId === task.id && run.arm === arm && run.status === 'completed'))
      .map((run) => (run ? scoreAnswer(task, run.response).score : null));
    if (scores.every((score) => score !== null) && new Set(scores).size > 1) arms.forEach((arm) => add(task.id, arm));
  }
  return plan.slice(0, budget);
}

/** Arm MCP servers with concrete paths: the graph server indexes this arm's worktree. */
export function armMcpConfig(armSpec, worktree) {
  const mcpServers = Object.fromEntries(Object.entries(armSpec.mcpServers).map(([name, server]) => [
    name,
    { ...server, env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, value === '<worktree>' ? worktree : value])) },
  ]));
  return { mcpServers };
}

const QUOTE_ESCAPE = String.raw`'\''`;
/** POSIX shell quoting for the dry-run listings. */
const shellQuote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", QUOTE_ESCAPE)}'`);

/**
 * Dry-run page shared by the clients: intro lines, then per arm the corpus copy, the
 * client's arm config (`config` = { lang, text }) and command, then the prompts.
 */
export function renderDryRunPage({ client, intro, tasks, arms, armSpecs, buildPrompt, config, command }) {
  return [
    `# Agent benchmark dry run: ${client} (nothing is started)`,
    '',
    ...intro,
    '',
    ...arms.flatMap((arm) => [
      `## Arm ${arm}`,
      '',
      `Corpus: <tmp>/Graph-It-Live, \`git archive\` of the corpus commit (no .git), without agent instruction files${Object.keys(armSpecs[arm].mcpServers).length > 0 ? '; warm index built once (`graph-it scan`)' : ''}.`,
      '',
      `\`\`\`${config(arm).lang}`,
      config(arm).text,
      '```',
      '',
      '```sh',
      `${client} ${command(arm).map((arg) => shellQuote(arg)).join(' ')} < <prompt>`,
      '```',
      '',
    ]),
    '## Prompts (same for every arm)',
    '',
    ...tasks.flatMap((task) => [`### ${task.id}`, '', '```text', buildPrompt(task), '```', '']),
  ].join('\n');
}

/** Builds the graph arm index once and returns its cold time; per-task runs then start warm. */
function buildIndex(repoRoot, worktree, env) {
  const started = Date.now();
  execFileSync(process.execPath, [path.join(repoRoot, 'dist', 'graph-it.js'), 'scan', '--workspace', worktree], { env, stdio: 'ignore', timeout: 10 * 60 * 1000 }); // NOSONAR S4036: absolute node path
  return Date.now() - started;
}

/**
 * Prepares one corpus copy per arm (configure(arm, worktree) adds the client's arm
 * config to its setup), builds the index of MCP arms once, calls run with the setups,
 * and removes every copy afterwards, even when preparing or running fails.
 */
export async function withArmCopies({ arms, armSpecs, agentFiles, commit, repoRoot, env, configure }, run) {
  const needsIndex = arms.some((arm) => Object.keys(armSpecs[arm].mcpServers).length > 0);
  if (needsIndex && !existsSync(path.join(repoRoot, 'dist', 'mcpServer.mjs'))) throw new Error('dist/mcpServer.mjs is missing: run `npm run build` first');
  const setup = {};
  try {
    let coldIndexMs = null;
    for (const arm of arms) {
      // Assigned before configure and the index build so finally removes it when they fail.
      setup[arm] = { worktree: exportCorpus(repoRoot, commit, agentFiles), serverNames: Object.keys(armSpecs[arm].mcpServers) };
      Object.assign(setup[arm], configure(arm, setup[arm].worktree));
      if (setup[arm].serverNames.length > 0) coldIndexMs = buildIndex(repoRoot, setup[arm].worktree, env);
    }
    return await run({ setup, indexState: needsIndex ? 'warm' : 'none', coldIndexMs });
  } finally {
    for (const { worktree } of Object.values(setup)) removeCorpus(worktree);
  }
}

/**
 * Runs every task and arm once, then the planned reruns, one cell at a time.
 * runCell({ task, arm, repetition }) resolves to { record, stopBench }; the first
 * stopBench (rate limit, refused route) ends the benchmark: no later cell, no rerun.
 */
export async function runAllCells(tasks, arms, runCell) {
  const runs = [];
  const runList = async (cells) => {
    for (const cell of cells) {
      const repetition = runs.filter((run) => run.taskId === cell.task.id && run.arm === cell.arm).length + 1;
      // One subscription session at a time, and nothing starts after the first limit.
      const { record, stopBench } = await runCell({ ...cell, repetition }); // eslint-disable-line no-await-in-loop -- NOSONAR S9382: sequential on purpose
      runs.push(record);
      if (stopBench) return stopBench;
    }
    return null;
  };
  let stopReason = await runList(tasks.flatMap((task) => arms.map((arm) => ({ task, arm }))));
  const reruns = stopReason ? [] : planReruns(runs, tasks, arms);
  if (reruns.length > 0) stopReason = await runList(reruns.map(({ taskId, arm }) => ({ task: tasks.find((task) => task.id === taskId), arm })));
  return { runs, reruns: reruns.length, stopReason };
}
