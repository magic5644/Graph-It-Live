// Shared guards and plumbing of the live agent benchmark runs (#399, #676; reused by
// the Codex run of #677): child environment without API keys or billing routes,
// rate-limit / allowance detection, the isolated corpus copy, one client process
// with a timeout, and the rerun plan. Subscription routes only: nothing here retries.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
