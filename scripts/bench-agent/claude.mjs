// Automated Claude Code run of the agent benchmark (#399 b, #676), on the
// claude.ai subscription only: `claude -p --output-format stream-json` per task
// and arm, in an isolated corpus copy, with only the arm's MCP servers and no user
// settings, hooks, plugins or memories. Refuses an API-key route and stops at the
// first rate-limit or allowance message without retrying.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { armMcpConfig, childEnv, isLimitMessage, renderDryRunPage, runAllCells, runProcess, withArmCopies } from './live.mjs';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
export const CLAUDE_EFFORT = 'low';
export const RUN_TIMEOUT_MS = 2 * 60 * 1000;

const NATIVE_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
/** Same built-in tools in both arms; the graph arm also gets every tool of its MCP server. */
export const ALLOWED_TOOLS = {
  native: NATIVE_TOOLS,
  graph: [...NATIVE_TOOLS, 'mcp__graph-it-live'],
};

/** Child environment: no key or billing route, no auto memory or bundled skills, and no client-side retry on a 429. */
export function claudeEnv(env) {
  return { ...childEnv(env), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_MAX_RETRIES: '0' };
}

/**
 * `@builtin` plugins shipped inside Claude Code 2.1.322: --setting-sources cannot turn
 * them off, and both arms load the same set. Any other plugin is refused at init.
 */
export const BUILTIN_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-privacy', 'cc-plugin-sec-default', 'cc-plugin-telemetry'];

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
  const extraPlugins = (init.plugins ?? []).map((plugin) => plugin.name).filter((name) => !BUILTIN_PLUGINS.includes(name));
  if (extraPlugins.length > 0) return `plugins loaded: ${extraPlugins.join(', ')}`;
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

/** Trace entry: the tool name, with the command for Bash. */
const describeToolUse = (block) => (block.name === 'Bash' && typeof block.input?.command === 'string' ? `Bash: ${block.input.command}` : String(block.name));

function onAssistant(state, event) {
  const toolUses = (event.message?.content ?? []).filter((block) => block?.type === 'tool_use');
  state.toolCalls += toolUses.length;
  state.toolTrace.push(...toolUses.map(describeToolUse));
  if (LIMIT_ERRORS.has(event.error)) return { status: 'rate-limited', error: `client error: ${event.error}` };
  if (ACCOUNT_ERRORS.has(event.error)) return { status: 'failed', error: `client error: ${event.error}` };
  return null;
}

/**
 * Stream-json reader of one run. onLine returns true when the run must be killed;
 * every stop it records also stops the whole benchmark.
 */
export function createClaudeParser(serverNames) {
  /** @type {{ toolCalls: number, toolTrace: string[], init: boolean, plugins: string[], result: Record<string, any> | null, stop: { status: string, error: string } | null, stopAfter: string | null }} */
  const state = { toolCalls: 0, toolTrace: [], init: false, plugins: [], result: null, stop: null, stopAfter: null };
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
      state.plugins = (event.plugins ?? []).map((plugin) => plugin.name);
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
  return { ...run, metrics: claudeMetrics(state.result, state.toolCalls), toolTrace: state.toolTrace, stopBench: run.stopBench ?? state.stopAfter };
}

/** What a live run would do, without spawning anything. */
export function renderDryRun({ tasks, arms, armSpecs, buildPrompt, removedEnv }) {
  return renderDryRunPage({
    client: 'claude',
    intro: [
      `Child environment drops: ${removedEnv.length > 0 ? removedEnv.join(', ') : '(none set)'}; sets CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, CLAUDE_CODE_MAX_RETRIES=0.`,
      'Before the first task: `claude auth status --json` must report a claude.ai subscription.',
    ],
    tasks,
    arms,
    armSpecs,
    buildPrompt,
    config: (arm) => ({ lang: 'json', text: JSON.stringify(armMcpConfig(armSpecs[arm], '<worktree>'), null, 2) }),
    command: (arm) => claudeArgs(arm, '<tmp>/mcp-' + arm + '.json'),
  });
}

async function runOne({ task, arm, repetition, setup, buildPrompt, env, log }) {
  const prompt = buildPrompt(task);
  const parser = createClaudeParser(setup[arm].serverNames);
  log(`${task.id} / ${arm} #${repetition}...`);
  // shortcut: spawns `claude` without a shell, so a Windows npm `claude.cmd` shim is not found; use the native installer there.
  const outcome = await runProcess('claude', claudeArgs(arm, setup[arm].mcpConfig), { cwd: setup[arm].worktree, env, input: prompt, timeoutMs: RUN_TIMEOUT_MS, onLine: parser.onLine });
  const { stopBench, ...run } = finishRun(parser.state, outcome);
  log(` ${run.status}\n`);
  return { record: { taskId: task.id, arm, repetition, prompt, response: run.response ?? null, ...run }, stopBench, plugins: parser.state.plugins };
}

/**
 * Live run: verifies the subscription route, prepares one corpus copy per arm (warm index
 * for MCP arms), runs every task and arm once, then the planned reruns, and returns the
 * recorded runs and metadata for the shared report builder. Answer keys were checked first.
 */
export async function runClaudeBench({ tasks, arms, armSpecs, agentFiles, buildPrompt, commit, repoRoot, corpusGit, dirName, rerunBudget, env = process.env, log = (text) => process.stderr.write(text) }) {
  const childEnvironment = claudeEnv(env);
  const authRoute = checkClaudeRoute(childEnvironment);
  const clientVersion = execFileSync('claude', ['--version'], { env: childEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim(); // NOSONAR S4036: developer tool, trusted PATH
  const configDir = mkdtempSync(path.join(tmpdir(), 'agent-bench-mcp-'));
  const configure = (arm, worktree) => {
    const mcpConfig = path.join(configDir, `mcp-${arm}.json`);
    writeFileSync(mcpConfig, JSON.stringify(armMcpConfig(armSpecs[arm], worktree)));
    return { mcpConfig };
  };
  try {
    return await withArmCopies({ arms, armSpecs, agentFiles, commit, repoRoot, corpusGit, dirName, env: childEnvironment, configure }, async ({ setup, indexState, coldIndexMs }) => {
      const plugins = new Set();
      const { runs, reruns, stopReason } = await runAllCells(tasks, arms, async (cell) => {
        const outcome = await runOne({ ...cell, setup, buildPrompt, env: childEnvironment, log });
        outcome.plugins.forEach((name) => plugins.add(name));
        return outcome;
      }, rerunBudget);
      return {
        runs,
        meta: { client: 'claude', clientVersion, model: CLAUDE_MODEL, effort: CLAUDE_EFFORT, authRoute, indexState, coldIndexMs, reruns, stopReason, builtinPlugins: [...plugins].sort((a, b) => a.localeCompare(b)) },
      };
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
