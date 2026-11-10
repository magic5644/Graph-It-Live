// Automated Codex run of the agent benchmark (#399 c, #677), on the ChatGPT
// subscription only: `codex exec --json` per task and arm, in an isolated corpus copy,
// with a temporary CODEX_HOME holding only the arm's config and a link to the login,
// and a temporary HOME, so no user config, global AGENTS.md, memories, skills, plugins,
// hooks or rules are loaded. Skips the client unless `codex login status` reports the
// ChatGPT login, and stops at the first rate-limit, allowance or credits message.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { armMcpConfig, childEnv, isLimitMessage, renderDryRunPage, runAllCells, runProcess, withArmCopies } from './live.mjs';

/** "Fast and affordable" model of the ChatGPT plan catalog, the Codex counterpart of the Claude Haiku pin. */
export const CODEX_MODEL = 'gpt-6-luna';
export const CODEX_EFFORT = 'low';
export const RUN_TIMEOUT_MS = 2 * 60 * 1000;

/** Also removed from the Codex corpus copies: Codex reads repository skills and plugin marketplaces in `.agents/`. */
export const CODEX_AGENT_FILES = ['.agents'];

/**
 * Features off in both arms: subagents, apps, plugins, hooks, memories, goals, browser and
 * image tools, skill and tool discovery, and endless reconnects. Both arms keep the same
 * built-in shell tools; the graph arm only adds its MCP server.
 */
export const DISABLED_FEATURES = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'goals', 'hooks', 'image_generation', 'in_app_browser',
  'memories', 'multi_agent', 'plugins', 'remote_plugin', 'skill_mcp_dependency_install', 'skill_search', 'tool_suggest',
  'unbounded_connection_retries',
];

/** Child environment without keys or billing routes, with the temporary CODEX_HOME and HOME. */
export function codexEnv(env, codexHome, home) {
  return { ...childEnv(env), CODEX_HOME: codexHome, HOME: home };
}

/**
 * Accepts only the ChatGPT login (`codex login status`, which prints to stderr). The
 * status text is never echoed: an API-key login prints a masked key.
 */
export function verifyCodexLogin({ status, stdout = '', stderr = '', error }) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (error) return { ok: false, reason: `login status cannot be read (${error.message})` };
  if (status === 0 && /^Logged in using ChatGPT\b/m.test(text)) return { ok: true, route: 'ChatGPT subscription login' };
  if (/api.?key/i.test(text)) return { ok: false, reason: 'API-key login instead of the ChatGPT subscription' };
  if (/not logged in/i.test(text)) return { ok: false, reason: 'not logged in; run `codex login` with the subscription account' };
  return { ok: false, reason: 'login route cannot be verified' };
}

/**
 * Temporary CODEX_HOME: a link to the real login file (no copy of the credentials; a token
 * refresh writes through it) and, for an arm, its config.toml.
 * shortcut: a symlink needs Developer Mode on Windows; run the Codex route on macOS/Linux there.
 */
function makeCodexHome(dir, sourceHome, config = null) {
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(sourceHome, 'auth.json'), path.join(dir, 'auth.json'));
  if (config !== null) writeFileSync(path.join(dir, 'config.toml'), config);
  return dir;
}

const tomlString = (value) => JSON.stringify(String(value));
const tomlKey = (key) => (/^[\w-]+$/.test(key) ? key : tomlString(key));

/**
 * Arm config.toml: ChatGPT login forced, no approval prompt, no web search, features off,
 * and only the arm's MCP servers, each required so a server that fails to start fails the run.
 */
export function codexConfig(armSpec, worktree) {
  const { mcpServers } = armMcpConfig(armSpec, worktree);
  return [
    'forced_login_method = "chatgpt"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    '',
    '[features]',
    ...DISABLED_FEATURES.map((feature) => `${feature} = false`),
    ...Object.entries(mcpServers).flatMap(([name, server]) => {
      const env = Object.entries(server.env).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ');
      return ['', `[mcp_servers.${tomlKey(name)}]`, `command = ${tomlString(server.command)}`, `args = [${server.args.map((arg) => tomlString(arg)).join(', ')}]`, `env = { ${env} }`, 'required = true'];
    }),
    '',
  ].join('\n');
}

/** Arguments of one headless run (an unknown config.toml key fails it); `-` reads the prompt from stdin. */
export function codexArgs(worktree) {
  return [
    'exec', '--json', '--color', 'never',
    '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check',
    '--model', CODEX_MODEL,
    '-c', `model_reasoning_effort="${CODEX_EFFORT}"`,
    '--sandbox', 'read-only',
    '--cd', worktree,
    '-',
  ];
}

// Items that are tool calls; agent_message, reasoning, todo_list and error are not.
const TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'collab_tool_call']);

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const sum = total ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  const add = (value) => (typeof value === 'number' ? value : 0);
  return {
    input: sum.input + add(usage.input_tokens),
    cached: sum.cached + add(usage.cached_input_tokens),
    // Omitted from the event when zero.
    cacheWrite: sum.cacheWrite + add(usage.cache_write_input_tokens),
    output: sum.output + add(usage.output_tokens),
  };
}

/** Trace entry: MCP server and tool, or the shell command, or the item type. */
function describeItem(item) {
  if (item.type === 'mcp_tool_call') return `mcp:${item.server}/${item.tool}`;
  if (item.type === 'command_execution') return `shell: ${item.command}`;
  return item.type;
}

function onItem(state, item) {
  if (TOOL_ITEMS.has(item?.type)) {
    state.toolCalls++;
    state.toolTrace.push(describeItem(item));
  }
  if (item?.type === 'agent_message' && typeof item.text === 'string') state.lastMessage = item.text;
  if (item?.type === 'mcp_tool_call' && !state.serverNames.includes(item.server)) {
    return { status: 'failed', error: `refused: call to MCP server ${item.server}, not configured for this arm` };
  }
  return null;
}

function onError(state, message) {
  const text = typeof message === 'string' ? message : 'unknown error';
  state.errors.push(text);
  return isLimitMessage(text) ? { status: 'rate-limited', error: text } : null;
}

/**
 * JSONL reader of one run. onLine returns true when the run must be killed; every stop
 * it records also stops the whole benchmark.
 */
export function createCodexParser(serverNames) {
  /** @type {{ serverNames: string[], started: boolean, toolCalls: number, toolTrace: string[], turns: number, usage: { input: number, cached: number, cacheWrite: number, output: number } | null, lastMessage: string | null, errors: string[], failed: boolean, stop: { status: string, error: string } | null }} */
  const state = { serverNames, started: false, toolCalls: 0, toolTrace: [], turns: 0, usage: null, lastMessage: null, errors: [], failed: false, stop: null };
  const onLine = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    let stop = null;
    if (event?.type === 'thread.started') state.started = true;
    else if (event?.type === 'item.completed') stop = onItem(state, event.item);
    else if (event?.type === 'turn.completed') {
      state.turns++;
      state.usage = addUsage(state.usage, event.usage);
    } else if (event?.type === 'turn.failed') {
      state.failed = true;
      stop = onError(state, event.error?.message);
    } else if (event?.type === 'error') stop = onError(state, event.message);
    if (stop === null) return false;
    state.stop = stop;
    return true;
  };
  return { onLine, state };
}

/**
 * Metrics from the events: input excludes cached reads and cache writes (both are part of
 * input_tokens), latency is the harness wall clock (no duration event), and no cost field.
 * Turns are unavailable: `codex exec` emits one turn.completed per prompt, not one per model
 * request, so it would always read 1 and not compare with Claude Code's num_turns.
 */
export function codexMetrics(state, latencyMs) {
  const { usage } = state;
  const done = state.turns > 0;
  return {
    toolCalls: done ? state.toolCalls : null,
    turns: null,
    latencyMs,
    inputTokens: usage ? usage.input - usage.cached - usage.cacheWrite : null,
    cacheWriteTokens: usage ? usage.cacheWrite : null,
    cacheReadTokens: usage ? usage.cached : null,
    outputTokens: usage ? usage.output : null,
    notionalCostUsd: null,
  };
}

function runStatus(state, { code, timedOut, stderr }) {
  if (state.stop) return { ...state.stop, stopBench: state.stop.error };
  const done = state.turns > 0 && !state.failed;
  if (timedOut && !done) return { status: 'timeout', error: `no turn.completed within ${RUN_TIMEOUT_MS} ms` };
  const errorText = state.errors.length > 0 ? state.errors.join('; ') : stderr.trim();
  if (!done && isLimitMessage(errorText)) return { status: 'rate-limited', error: errorText, stopBench: errorText };
  // Fail closed: without thread.started, the session never ran under this config.
  if (!state.started) return { status: 'failed', error: errorText || 'no thread.started event' };
  if (!done) return { status: 'failed', error: errorText || 'no turn.completed event' };
  if (code !== 0) return { status: 'failed', error: errorText || `exit code ${code}` };
  if (state.lastMessage === null) return { status: 'failed', error: 'no agent message' };
  return { status: 'completed', response: state.lastMessage };
}

/** Run record from the process outcome and the parser state, plus stopBench when nothing else may start. */
export function finishCodexRun(state, outcome, latencyMs) {
  const { stopBench = null, ...run } = runStatus(state, outcome);
  return { ...run, metrics: codexMetrics(state, latencyMs), toolTrace: state.toolTrace, stopBench };
}

/** What a live run would do, without spawning anything. */
export function renderCodexDryRun({ tasks, arms, armSpecs, buildPrompt, removedEnv }) {
  return renderDryRunPage({
    client: 'codex',
    intro: [
      `Child environment drops: ${removedEnv.length > 0 ? removedEnv.join(', ') : '(none set)'}; sets CODEX_HOME=<tmp>/codex-<arm> (config.toml + link to the login file) and HOME=<tmp>/home.`,
      'Before the first task: `codex login status` must report the ChatGPT login; otherwise codex is reported as skipped.',
    ],
    tasks,
    arms,
    armSpecs,
    buildPrompt,
    config: (arm) => ({ lang: 'toml', text: codexConfig(armSpecs[arm], '<worktree>').trimEnd() }),
    command: () => codexArgs('<worktree>'),
  });
}

async function runOne({ task, arm, repetition, setup, buildPrompt, env, log }) {
  const prompt = buildPrompt(task);
  const parser = createCodexParser(setup[arm].serverNames);
  log(`${task.id} / ${arm} #${repetition}...`);
  const started = Date.now();
  // shortcut: spawns `codex` without a shell, so a Windows npm `codex.cmd` shim is not found; use the native binary there.
  const outcome = await runProcess('codex', codexArgs(setup[arm].worktree), { cwd: setup[arm].worktree, env: { ...env, CODEX_HOME: setup[arm].codexHome }, input: prompt, timeoutMs: RUN_TIMEOUT_MS, onLine: parser.onLine });
  const { stopBench, ...run } = finishCodexRun(parser.state, outcome, Date.now() - started);
  log(` ${run.status}\n`);
  return { record: { taskId: task.id, arm, repetition, prompt, response: run.response ?? null, ...run }, stopBench };
}

/**
 * Live run: checks the ChatGPT login (skipped otherwise, before any copy), prepares one
 * corpus copy and CODEX_HOME per arm, runs every task and arm once, then the planned
 * reruns, and returns the recorded runs and metadata for the shared report builder.
 */
export async function runCodexBench({ tasks, arms, armSpecs, agentFiles, buildPrompt, commit, repoRoot, env = process.env, log = (text) => process.stderr.write(text) }) {
  const sourceHome = env.CODEX_HOME || path.join(homedir(), '.codex');
  const tempDir = mkdtempSync(path.join(tmpdir(), 'agent-bench-codex-'));
  const home = path.join(tempDir, 'home');
  const baseMeta = { client: 'codex', model: CODEX_MODEL, effort: CODEX_EFFORT };
  try {
    mkdirSync(home);
    const loginEnv = codexEnv(env, makeCodexHome(path.join(tempDir, 'codex-login'), sourceHome), home);
    const login = spawnSync('codex', ['login', 'status'], { env: loginEnv, encoding: 'utf8', timeout: 30_000 }); // NOSONAR S4036: developer tool, trusted PATH
    const check = verifyCodexLogin(login);
    if (!check.ok) {
      log(`codex skipped: ${check.reason}\n`);
      return { runs: [], meta: { ...baseMeta, clientVersion: null, authRoute: null, indexState: 'none', coldIndexMs: null, reruns: 0, skipped: check.reason, stopReason: `codex skipped: ${check.reason}` } };
    }
    const clientVersion = execFileSync('codex', ['--version'], { env: loginEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim(); // NOSONAR S4036: developer tool, trusted PATH
    const configure = (arm, worktree) => ({ codexHome: makeCodexHome(path.join(tempDir, `codex-${arm}`), sourceHome, codexConfig(armSpecs[arm], worktree)) });
    return await withArmCopies({ arms, armSpecs, agentFiles: [...agentFiles, ...CODEX_AGENT_FILES], commit, repoRoot, env: loginEnv, configure }, async ({ setup, indexState, coldIndexMs }) => {
      const { runs, reruns, stopReason } = await runAllCells(tasks, arms, (cell) => runOne({ ...cell, setup, buildPrompt, env: loginEnv, log }));
      return { runs, meta: { ...baseMeta, clientVersion, authRoute: check.route, indexState, coldIndexMs, reruns, skipped: null, stopReason } };
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
