// Automated Claude Code run of the agent benchmark (#399 b, #676), on the
// claude.ai subscription only: `claude -p --output-format stream-json` per task
// and arm, in an isolated corpus copy, with only the arm's MCP servers and no user
// settings, hooks, plugins or memories. Refuses an API-key route and stops at the
// first rate-limit or allowance message without retrying.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { childEnv, exportCorpus, isLimitMessage, planReruns, removeCorpus, runProcess } from './live.mjs';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
export const CLAUDE_EFFORT = 'low';
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;

const NATIVE_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
/** Same built-in tools in both arms; the graph arm also gets every tool of its MCP server. */
export const ALLOWED_TOOLS = {
  native: NATIVE_TOOLS,
  graph: [...NATIVE_TOOLS, 'mcp__graph-it-live'],
};

/** Child environment: no key or billing route, no auto memory, and no client-side retry on a 429. */
export function claudeEnv(env) {
  return { ...childEnv(env), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
}

/** Accepts only a verified claude.ai subscription login (`claude auth status --json`). */
export function verifySubscription(status) {
  if (status?.loggedIn !== true) return { ok: false, reason: 'not logged in; run `claude auth login` with the subscription account' };
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
    return { ok: false, reason: `auth route is ${status.authMethod ?? 'unknown'} / ${status.apiProvider ?? 'unknown'}, not a claude.ai subscription` };
  }
  if (typeof status.subscriptionType !== 'string' || status.subscriptionType === '') return { ok: false, reason: 'subscription type cannot be verified' };
  return { ok: true, route: `claude.ai subscription (${status.subscriptionType})` };
}

/** Reads the auth route with the child environment; throws unless it is a verified subscription. */
export function checkClaudeRoute(env) {
  let status;
  try {
    status = JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })); // NOSONAR S4036: developer tool, trusted PATH
  } catch (error) {
    throw new Error(`refusing to start: Claude Code auth route cannot be verified (${error.message})`, { cause: error });
  }
  const check = verifySubscription(status);
  if (!check.ok) throw new Error(`refusing to start: ${check.reason}`);
  return check.route;
}

/** Arguments of one headless run; the prompt goes to stdin so no variadic flag can swallow it. */
export function claudeArgs(arm, mcpConfigPath) {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence',
    '--model', CLAUDE_MODEL,
    '--effort', CLAUDE_EFFORT,
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--tools', NATIVE_TOOLS.join(','),
    '--allowedTools', ALLOWED_TOOLS[arm].join(','),
    '--permission-mode', 'dontAsk',
  ];
}

// The pinned model, optionally with a date suffix or a context-window tag.
const MODEL_ID = new RegExp(String.raw`^${CLAUDE_MODEL}(?:-\d{8})?(?:\[\w+\])?$`);
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
const ACCOUNT_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold']);

/** Init checks: subscription route, no plugin, exactly the arm's MCP servers connected, pinned model and effort. */
function initProblem(init, serverNames) {
  if (init.apiKeySource !== 'none') return `API key route (${init.apiKeySource}) instead of the subscription`;
  if ((init.plugins ?? []).length > 0) return `plugins loaded: ${init.plugins.map((plugin) => plugin.name).join(', ')}`;
  const servers = init.mcp_servers ?? [];
  const names = servers.map((server) => server.name).sort((a, b) => a.localeCompare(b));
  if (names.join(',') !== [...serverNames].sort((a, b) => a.localeCompare(b)).join(',')) return `MCP servers [${names.join(', ')}] instead of [${serverNames.join(', ')}]`;
  const down = servers.find((server) => server.status !== 'connected');
  if (down) return `MCP server ${down.name} is ${down.status}`;
  if (typeof init.model !== 'string' || !MODEL_ID.test(init.model)) return `model ${init.model} instead of ${CLAUDE_MODEL}`;
  if (init.effort !== undefined && init.effort !== CLAUDE_EFFORT) return `effort ${init.effort} instead of ${CLAUDE_EFFORT}`;
  return null;
}

function onRateLimit(state, info) {
  if (info?.status === 'rejected' || info?.isUsingOverage === true) {
    const details = [info.status, info.errorCode && `(${info.errorCode})`].filter(Boolean).join(' ');
    return { status: 'rate-limited', error: `rate limit: ${details}${info.isUsingOverage ? ', overage' : ''}` };
  }
  // Still inside the allowance: finish this run, start no other.
  if (info?.status === 'allowed_warning') state.stopAfter = 'allowance warning: usage close to the subscription limit';
  return null;
}

function onAssistant(state, event) {
  state.toolCalls += (event.message?.content ?? []).filter((block) => block?.type === 'tool_use').length;
  if (LIMIT_ERRORS.has(event.error)) return { status: 'rate-limited', error: `client error: ${event.error}` };
  if (ACCOUNT_ERRORS.has(event.error)) return { status: 'failed', error: `client error: ${event.error}` };
  return null;
}

/**
 * Stream-json reader of one run. onLine returns true when the run must be killed;
 * every stop it records also stops the whole benchmark.
 */
export function createClaudeParser(serverNames) {
  /** @type {{ toolCalls: number, init: boolean, result: Record<string, any> | null, stop: { status: string, error: string } | null, stopAfter: string | null }} */
  const state = { toolCalls: 0, init: false, result: null, stop: null, stopAfter: null };
  const onLine = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    let stop = null;
    if (event?.type === 'system' && event.subtype === 'init') {
      state.init = true;
      const problem = initProblem(event, serverNames);
      stop = problem ? { status: 'failed', error: `refused at init: ${problem}` } : null;
    } else if (event?.type === 'rate_limit_event') stop = onRateLimit(state, event.rate_limit_info);
    else if (event?.type === 'assistant') stop = onAssistant(state, event);
    else if (event?.type === 'result') state.result = event;
    if (stop === null) return false;
    state.stop = stop;
    return true;
  };
  return { onLine, state };
}

const numberOr = (value, fallback) => (typeof value === 'number' ? value : fallback);

/** Usage, turns, latency and tool calls of the result event; Claude Code reports cache writes, so absent means 0. */
export function claudeMetrics(result, toolCalls) {
  const usage = result?.usage;
  return {
    toolCalls: result ? toolCalls : null,
    turns: numberOr(result?.num_turns, null),
    latencyMs: numberOr(result?.duration_ms, null),
    inputTokens: numberOr(usage?.input_tokens, null),
    cacheWriteTokens: usage ? numberOr(usage.cache_creation_input_tokens, 0) : null,
    cacheReadTokens: usage ? numberOr(usage.cache_read_input_tokens, 0) : null,
    outputTokens: numberOr(usage?.output_tokens, null),
    notionalCostUsd: numberOr(result?.total_cost_usd, null),
  };
}

function runStatus(state, { timedOut, stderr }) {
  if (state.stop) return { ...state.stop, stopBench: state.stop.error };
  const { result } = state;
  // Fail closed: without init, the route, plugins and MCP servers were never checked.
  if (result && !state.init) return { status: 'failed', error: 'no init event: session route not verified', stopBench: 'no init event: session route not verified' };
  if (timedOut && result?.subtype !== 'success') return { status: 'timeout', error: `no result within ${RUN_TIMEOUT_MS} ms` };
  const errorText = result ? [result.result, ...(result.errors ?? [])].filter((text) => typeof text === 'string' && text !== '').join('; ') : stderr.trim();
  if (isLimitMessage(errorText) && (!result || result.is_error)) return { status: 'rate-limited', error: errorText, stopBench: errorText };
  if (!result) return { status: 'failed', error: errorText || 'no result event' };
  if (result.is_error || result.subtype !== 'success') return { status: 'failed', error: errorText || result.subtype };
  return { status: 'completed', response: result.result };
}

/** Run record from the process outcome and the parser state, plus stopBench when nothing else may start. */
export function finishRun(state, outcome) {
  const run = runStatus(state, outcome);
  return { ...run, metrics: claudeMetrics(state.result, state.toolCalls), stopBench: run.stopBench ?? state.stopAfter };
}

/** Arm MCP config with concrete paths: the graph server indexes this arm's worktree. */
export function armMcpConfig(armSpec, worktree) {
  const mcpServers = Object.fromEntries(Object.entries(armSpec.mcpServers).map(([name, server]) => [
    name,
    { ...server, env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, value === '<worktree>' ? worktree : value])) },
  ]));
  return { mcpServers };
}

const QUOTE_ESCAPE = String.raw`'\''`;
const shellQuote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", QUOTE_ESCAPE)}'`);

/** What a live run would do, without spawning anything. */
export function renderDryRun({ tasks, arms, armSpecs, buildPrompt, removedEnv }) {
  return [
    '# Agent benchmark dry run: claude (nothing is started)',
    '',
    `Child environment drops: ${removedEnv.length > 0 ? removedEnv.join(', ') : '(none set)'}; sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, CLAUDE_CODE_MAX_RETRIES=0.`,
    'Before the first task: `claude auth status --json` must report a claude.ai subscription.',
    '',
    ...arms.flatMap((arm) => [
      `## Arm ${arm}`,
      '',
      `Corpus: <tmp>/Graph-It-Live, \`git archive\` of the corpus commit (no .git), without agent instruction files${Object.keys(armSpecs[arm].mcpServers).length > 0 ? '; warm index built once (`graph-it scan`)' : ''}.`,
      '',
      '```json',
      JSON.stringify(armMcpConfig(armSpecs[arm], '<worktree>'), null, 2),
      '```',
      '',
      '```sh',
      `claude ${claudeArgs(arm, '<tmp>/mcp-' + arm + '.json').map(shellQuote).join(' ')} < <prompt>`,
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

async function runOne({ task, arm, repetition, setup, buildPrompt, env, log }) {
  const prompt = buildPrompt(task);
  const parser = createClaudeParser(setup[arm].serverNames);
  log(`${task.id} / ${arm} #${repetition}...`);
  // shortcut: spawns `claude` without a shell, so a Windows npm `claude.cmd` shim is not found; use the native installer there.
  const outcome = await runProcess('claude', claudeArgs(arm, setup[arm].mcpConfig), { cwd: setup[arm].worktree, env, input: prompt, timeoutMs: RUN_TIMEOUT_MS, onLine: parser.onLine });
  const { stopBench, ...run } = finishRun(parser.state, outcome);
  log(` ${run.status}\n`);
  return { record: { taskId: task.id, arm, repetition, prompt, response: run.response ?? null, ...run }, stopBench };
}

async function runCells(cells, context, runs) {
  for (const cell of cells) {
    const repetition = runs.filter((run) => run.taskId === cell.task.id && run.arm === cell.arm).length + 1;
    // One subscription session at a time, and nothing starts after the first limit.
    const { record, stopBench } = await runOne({ ...context, ...cell, repetition }); // eslint-disable-line no-await-in-loop -- NOSONAR S9382: sequential on purpose
    runs.push(record);
    if (stopBench) return stopBench;
  }
  return null;
}

/**
 * Live run: verifies the subscription route, prepares one corpus copy per arm (warm index
 * for MCP arms), runs every task and arm once, then the planned reruns, and returns the
 * recorded runs and metadata for the shared report builder. Answer keys were checked first.
 */
export async function runClaudeBench({ tasks, arms, armSpecs, agentFiles, buildPrompt, commit, repoRoot, env = process.env, log = (text) => process.stderr.write(text) }) {
  const childEnvironment = claudeEnv(env);
  const authRoute = checkClaudeRoute(childEnvironment);
  const clientVersion = execFileSync('claude', ['--version'], { env: childEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim(); // NOSONAR S4036: developer tool, trusted PATH
  const needsIndex = arms.some((arm) => Object.keys(armSpecs[arm].mcpServers).length > 0);
  if (needsIndex && !existsSync(path.join(repoRoot, 'dist', 'mcpServer.mjs'))) throw new Error('dist/mcpServer.mjs is missing: run `npm run build` first');
  const configDir = mkdtempSync(path.join(tmpdir(), 'agent-bench-mcp-'));
  const setup = {};
  try {
    let coldIndexMs = null;
    for (const arm of arms) {
      // Assigned before the index build so finally removes it even when the build fails.
      const worktree = exportCorpus(repoRoot, commit, agentFiles);
      const config = armMcpConfig(armSpecs[arm], worktree);
      const mcpConfig = path.join(configDir, `mcp-${arm}.json`);
      writeFileSync(mcpConfig, JSON.stringify(config));
      setup[arm] = { worktree, mcpConfig, serverNames: Object.keys(config.mcpServers) };
      if (setup[arm].serverNames.length > 0) coldIndexMs = buildIndex(repoRoot, worktree, childEnvironment);
    }
    const runs = [];
    const context = { setup, buildPrompt, env: childEnvironment, log };
    let stopReason = await runCells(tasks.flatMap((task) => arms.map((arm) => ({ task, arm }))), context, runs);
    const reruns = stopReason ? [] : planReruns(runs, tasks, arms);
    if (reruns.length > 0) stopReason = await runCells(reruns.map(({ taskId, arm }) => ({ task: tasks.find((task) => task.id === taskId), arm })), context, runs);
    return {
      runs,
      meta: { client: 'claude', clientVersion, model: CLAUDE_MODEL, effort: CLAUDE_EFFORT, authRoute, indexState: needsIndex ? 'warm' : 'none', coldIndexMs, reruns: reruns.length, stopReason },
    };
  } finally {
    for (const { worktree } of Object.values(setup)) removeCorpus(worktree);
    rmSync(configDir, { recursive: true, force: true });
  }
}
