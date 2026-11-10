/**
 * Agent benchmark live Claude Code run tests (#399 b, #676)
 *
 * scripts/bench-agent/live.mjs (shared guards) and claude.mjs (the Claude Code
 * run). child_process is mocked: `claude`, `git`, `tar` and `graph-it scan` are emulated
 * and spawn returns a fake process replaying recorded stream-json lines. No real
 * process, client binary, network, git checkout or index build is used.
 */

import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = await vi.hoisted(async () => (await import('./benchAgentFakeChild')).mockChildProcess('benchAgentClaude'));
vi.mock('node:child_process', () => ({ ...childProcess, default: childProcess }));

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.existsSync.mockImplementation(actual.existsSync);
  return { ...actual, existsSync: fsMock.existsSync, default: { ...actual, existsSync: fsMock.existsSync } };
});

import {
  ALLOWED_TOOLS,
  BUILTIN_PLUGINS,
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  checkClaudeRoute,
  claudeArgs,
  claudeEnv,
  claudeMetrics,
  createClaudeParser,
  finishRun,
  renderDryRun,
  runClaudeBench,
  verifySubscription,
} from '../../scripts/bench-agent/claude.mjs';
import type { BenchTask, RecordedRun } from '../../scripts/bench-agent/harness.mjs';
import { AGENT_FILES, ARMS } from '../../scripts/bench-agent/index.mjs';
import { fakeChild } from './benchAgentFakeChild';
import { KILL_GRACE_MS, armMcpConfig, childEnv, exportCorpus, isLimitMessage, planReruns, removeCorpus, removedEnvNames, runProcess } from '../../scripts/bench-agent/live.mjs';

const COMMIT = 'c'.repeat(40);
const REPO = path.join(tmpdir(), 'bench-agent-claude-repo');
const SUBSCRIPTION = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'someone@example.org' };
const PARENT_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  CLAUDE_CONFIG_DIR: '/home/dev/.claude',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ANTHROPIC_AUTH_TOKEN: 'token',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock',
  OPENAI_API_KEY: 'sk-openai',
  GRAPH_IT_LLM_PROVIDER: 'copilot-cli',
  CLAUDECODE: '1',
  CLAUDE_EFFORT: 'max',
};

const task = (id: string, key = 'a'): BenchTask => ({
  id,
  class: 'known-file',
  prompt: `question ${id}`,
  answerShape: { value: 'string' },
  key: { value: key },
  evidence: [{ path: 'src/a.ts' }],
});

const init = (overrides: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'init', apiKeySource: 'none', plugins: [], mcp_servers: [], model: CLAUDE_MODEL, effort: 'low', ...overrides });
const toolUse = (count: number) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, ...Array.from({ length: count }, () => ({ type: 'tool_use', name: 'Read' }))] } });
const result = (text: string, overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  num_turns: 3,
  duration_ms: 1200,
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 50, cache_read_input_tokens: 400 },
  ...overrides,
});
const answer = (value: string) => JSON.stringify({ value });
const stream = (...events: unknown[]) => events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)));

/** Emulates `claude auth status`, `claude --version`, git worktree commands and `graph-it scan`. */
function emulateCommands({ status = SUBSCRIPTION as unknown, authError = null as string | null } = {}) {
  const calls: string[] = [];
  childProcess.execFileSync.mockImplementation((command: string, args: string[]) => {
    calls.push(`${path.basename(command)} ${args.join(' ')}`);
    if (command === 'claude' && args[0] === 'auth') {
      if (authError) throw new Error(authError);
      return JSON.stringify(status);
    }
    if (command === 'claude' && args[0] === '--version') return '2.1.322 (Claude Code)\n';
    if (command === 'git' || command === 'tar' || command === process.execPath) return '';
    throw new Error(`unexpected command ${command}`);
  });
  return calls;
}

const benchDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('agent-bench-'));
const dirsBefore = new Set(benchDirs());

beforeEach(() => {
  vi.clearAllMocks();
  childProcess.spawn.mockImplementation(() => {
    throw new Error('benchAgentClaude tests must not spawn a real process (spawn)');
  });
});

afterAll(() => {
  for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'fork'] as const) {
    expect(childProcess[name]).not.toHaveBeenCalled();
  }
  // Every temporary worktree parent and MCP config directory was removed.
  expect(benchDirs().filter((name) => !dirsBefore.has(name))).toEqual([]);
});

describe('child environment', () => {
  it('drops every API key, auth token, base URL, provider switch and parent-session variable', () => {
    const env = childEnv({ ...PARENT_ENV, UNSET: undefined });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', CLAUDE_CONFIG_DIR: '/home/dev/.claude' });
    expect(removedEnvNames(PARENT_ENV)).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_EFFORT', 'CLAUDECODE', 'GRAPH_IT_LLM_PROVIDER', 'OPENAI_API_KEY']);
  });

  it('matches variable names case-insensitively (Windows env names)', () => {
    expect(childEnv({ Path: 'C:\\Windows', anthropic_api_key: 'sk-x', Openai_Api_Key: 'sk-y' })).toEqual({ Path: 'C:\\Windows' });
  });

  it('claudeEnv also disables auto memory and client-side retries', () => {
    const env = claudeEnv(PARENT_ENV);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CONFIG_DIR: '/home/dev/.claude' });
  });

  it.each([
    ['Claude AI usage limit reached|1760000000', true],
    ["You've hit your limit · resets 5pm", true],
    ['API Error: 429 Too Many Requests', true],
    ['rate_limit_error', true],
    ['Credits required to continue', true],
    ['Your allowance is exhausted', true],
    ['Error: ENOENT no such file', false],
    ['', false],
    [null, false],
  ])('isLimitMessage(%j) is %s', (text, expected) => {
    expect(isLimitMessage(text)).toBe(expected);
  });
});

describe('subscription route', () => {
  it.each([
    [null, 'not logged in'],
    [{ ...SUBSCRIPTION, loggedIn: false }, 'not logged in'],
    [{ ...SUBSCRIPTION, authMethod: 'api_key' }, 'auth route is api_key / firstParty, not a claude.ai subscription'],
    [{ ...SUBSCRIPTION, authMethod: 'console' }, 'auth route is console'],
    [{ ...SUBSCRIPTION, apiProvider: 'bedrock' }, 'claude.ai / bedrock'],
    [{ loggedIn: true }, 'auth route is unknown / unknown'],
    [{ ...SUBSCRIPTION, subscriptionType: null }, 'subscription type cannot be verified'],
    [{ ...SUBSCRIPTION, subscriptionType: '' }, 'subscription type cannot be verified'],
  ])('refuses %j', (status, reason) => {
    const check = verifySubscription(status);
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.reason).toContain(reason);
  });

  it('accepts a claude.ai subscription and keeps no account details in the route', () => {
    expect(verifySubscription(SUBSCRIPTION)).toEqual({ ok: true, route: 'claude.ai subscription (max)' });
  });

  it('checkClaudeRoute reads the route with the given env and refuses an unverifiable or API-key route', () => {
    emulateCommands();
    const env = claudeEnv(PARENT_ENV);
    expect(checkClaudeRoute(env)).toBe('claude.ai subscription (max)');
    expect(childProcess.execFileSync).toHaveBeenCalledWith('claude', ['auth', 'status', '--json'], expect.objectContaining({ env }));
    emulateCommands({ authError: 'spawn claude ENOENT' });
    expect(() => checkClaudeRoute(env)).toThrow('refusing to start: Claude Code auth route cannot be verified (spawn claude ENOENT)');
    emulateCommands({ status: { ...SUBSCRIPTION, authMethod: 'api_key' } });
    expect(() => checkClaudeRoute(env)).toThrow('refusing to start: auth route is api_key');
  });
});

describe('claude arguments and MCP config', () => {
  it('pins model and effort, loads no settings, only the arm MCP config and a fixed tool list', () => {
    const native = claudeArgs('native', '/tmp/mcp-native.json');
    const graph = claudeArgs('graph', '/tmp/mcp-graph.json');
    const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
    for (const args of [native, graph]) {
      expect(args).toEqual(expect.arrayContaining(['-p', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
      expect(flag(args, '--output-format')).toBe('stream-json');
      expect(flag(args, '--model')).toBe(CLAUDE_MODEL);
      expect(flag(args, '--effort')).toBe(CLAUDE_EFFORT);
      expect(flag(args, '--setting-sources')).toBe('');
      expect(flag(args, '--permission-mode')).toBe('dontAsk');
      expect(flag(args, '--tools')).toBe('Bash,Read,Grep,Glob');
    }
    expect(flag(native, '--mcp-config')).toBe('/tmp/mcp-native.json');
    expect(flag(native, '--allowedTools')).toBe('Bash,Read,Grep,Glob');
    expect(flag(graph, '--allowedTools')).toBe('Bash,Read,Grep,Glob,mcp__graph-it-live');
    expect(ALLOWED_TOOLS.graph.slice(0, -1)).toEqual(ALLOWED_TOOLS.native);
  });

  it('armMcpConfig points the graph server at the arm worktree and keeps the native arm empty', () => {
    expect(armMcpConfig(ARMS.native, '/w')).toEqual({ mcpServers: {} });
    const config = armMcpConfig(ARMS.graph, '/w');
    expect(config.mcpServers['graph-it-live']).toMatchObject({ command: 'node', env: { WORKSPACE_ROOT: '/w' } });
    expect(armMcpConfig({ setup: '', mcpServers: { s: { command: 'x', args: [] } } }, '/w')).toEqual({ mcpServers: { s: { command: 'x', args: [], env: {} } } });
  });

  it('renderDryRun prints prompts, commands and MCP configs without running anything', () => {
    const text = renderDryRun({ tasks: [task('t1')], arms: ['native', 'graph'], armSpecs: ARMS, buildPrompt: (t: BenchTask) => `PROMPT ${t.id}`, removedEnv: ['ANTHROPIC_API_KEY'] });
    expect(text).toContain('Child environment drops: ANTHROPIC_API_KEY;');
    expect(text).toContain("--setting-sources '' ");
    expect(text).toContain('--allowedTools Bash,Read,Grep,Glob,mcp__graph-it-live');
    expect(text).toContain('"WORKSPACE_ROOT": "<worktree>"');
    expect(text).toContain('PROMPT t1');
    expect(renderDryRun({ tasks: [], arms: ['native'], armSpecs: ARMS, buildPrompt: () => '', removedEnv: [] })).toContain('drops: (none set)');
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

/** Feeds lines to a parser like runProcess does; returns the finished run and whether it was killed. */
function replay(lines: string[], { serverNames = [] as string[], timedOut = false, stderr = '' } = {}) {
  const parser = createClaudeParser(serverNames);
  let killed = false;
  for (const line of lines) {
    if (parser.onLine(line)) {
      killed = true;
      break;
    }
  }
  return { run: finishRun(parser.state, { timedOut, stderr }), killed };
}

describe('stream-json parsing', () => {
  it('completes with the answer, tool calls, turns, latency, tokens and notional cost', () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rg toon src' } }, { type: 'tool_use', name: 'Bash', input: {} }] } };
    const { run, killed } = replay(stream(init(), 'not json', toolUse(2), bash, result(answer('a'))));
    expect(killed).toBe(false);
    expect(run).toEqual({
      status: 'completed',
      response: answer('a'),
      stopBench: null,
      toolTrace: ['Read', 'Read', 'Bash: rg toon src', 'Bash'],
      metrics: { toolCalls: 4, turns: 3, latencyMs: 1200, inputTokens: 100, cacheWriteTokens: 50, cacheReadTokens: 400, outputTokens: 20, notionalCostUsd: 0.01 },
    });
  });

  it('reports absent cache counters as 0 and every metric as unavailable without a result', () => {
    expect(claudeMetrics({ usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: null } }, 0)).toMatchObject({ cacheWriteTokens: 0, cacheReadTokens: 0, turns: null, latencyMs: null });
    expect(Object.values(claudeMetrics(null, 4))).toEqual(Array(8).fill(null));
  });

  it.each([
    ['an API-key route', init({ apiKeySource: 'ANTHROPIC_API_KEY' }), 'API key route (ANTHROPIC_API_KEY) instead of the subscription'],
    ['a missing apiKeySource', init({ apiKeySource: undefined }), 'API key route (undefined) instead of the subscription'],
    ['a longer model id', init({ model: `${CLAUDE_MODEL}0` }), `model ${CLAUDE_MODEL}0 instead of ${CLAUDE_MODEL}`],
    ['a loaded user plugin', init({ plugins: [{ name: 'cc-plugin-privacy', path: '/b' }, { name: 'ponytail', path: '/p' }] }), 'plugins loaded: ponytail'],
    ['an unexpected MCP server', init({ mcp_servers: [{ name: 'other', status: 'connected' }] }), 'MCP servers [other] instead of []'],
    ['another model', init({ model: 'claude-opus-5-5' }), `model claude-opus-5-5 instead of ${CLAUDE_MODEL}`],
    ['another effort', init({ effort: 'high' }), 'effort high instead of low'],
  ])('refuses at init on %s and stops the benchmark', (_name, event, reason) => {
    const { run, killed } = replay(stream(event, result(answer('a'))));
    expect(killed).toBe(true);
    expect(run).toMatchObject({ status: 'failed', error: `refused at init: ${reason}`, stopBench: `refused at init: ${reason}` });
  });

  it('accepts the Claude Code builtin plugins and records them', () => {
    const builtins = BUILTIN_PLUGINS.map((name) => ({ name, path: `/builtin/${name}` }));
    const parser = createClaudeParser([]);
    expect(parser.onLine(JSON.stringify(init({ plugins: builtins })))).toBe(false);
    expect(parser.state.plugins).toEqual(BUILTIN_PLUGINS);
  });

  it('accepts exactly the arm servers once connected, and refuses one that failed', () => {
    const servers = [{ name: 'graph-it-live', status: 'connected' }];
    expect(replay(stream(init({ mcp_servers: servers, effort: undefined, model: `${CLAUDE_MODEL}[1m]` }), result(answer('a'))), { serverNames: ['graph-it-live'] }).run.status).toBe('completed');
    expect(replay(stream(init({ model: `${CLAUDE_MODEL}-20261101` }), result(answer('a')))).run.status).toBe('completed');
    const failed = replay(stream(init({ mcp_servers: [{ name: 'graph-it-live', status: 'failed' }] })), { serverNames: ['graph-it-live'] });
    expect(failed.run.error).toBe('refused at init: MCP server graph-it-live is failed');
  });

  it.each([
    ['a rejected rate-limit event', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } }, 'rate-limited', 'rate limit: rejected (credits_required)'],
    ['an overage rate-limit event', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } }, 'rate-limited', 'rate limit: allowed, overage'],
    ['a rate_limit assistant error', { type: 'assistant', error: 'rate_limit', message: { content: [] } }, 'rate-limited', 'client error: rate_limit'],
    ['a billing assistant error', { type: 'assistant', error: 'billing_error', message: { content: [] } }, 'rate-limited', 'client error: billing_error'],
    ['an authentication error', { type: 'assistant', error: 'authentication_failed', message: { content: [] } }, 'failed', 'client error: authentication_failed'],
    ['an organization error', { type: 'assistant', error: 'oauth_org_not_allowed' }, 'failed', 'client error: oauth_org_not_allowed'],
    ['an account on hold', { type: 'assistant', error: 'account_on_hold' }, 'failed', 'client error: account_on_hold'],
  ])('kills the run at %s and stops the benchmark without retrying', (_name, event, status, error) => {
    const { run, killed } = replay(stream(init(), event, result(answer('a'))));
    expect(killed).toBe(true);
    expect(run).toMatchObject({ status, error, stopBench: error });
  });

  it('finishes the run on an allowance warning, then stops the benchmark', () => {
    const { run, killed } = replay(stream(init(), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, result('not json')));
    expect(killed).toBe(false);
    expect(run).toMatchObject({ status: 'completed', response: 'not json', stopBench: 'allowance warning: usage close to the subscription limit' });
  });

  it.each([
    ['a limit message in the error result', [init(), result('Claude AI usage limit reached', { is_error: true })], '', 'rate-limited', 'Claude AI usage limit reached', true],
    ['a limit message on stderr without result', [init()], 'API Error: 429', 'rate-limited', 'API Error: 429', true],
    ['an error result', [init(), result('', { is_error: true, subtype: 'error_max_turns', errors: ['max turns'] })], '', 'failed', 'max turns', false],
    ['an error subtype without text', [init(), result('', { subtype: 'error_during_execution', result: undefined })], '', 'failed', 'error_during_execution', false],
    ['a result without init event', [result(answer('a'))], '', 'failed', 'no init event: session route not verified', true],
    ['no result and an empty stderr', [init()], '', 'failed', 'no result event', false],
    ['no result and a crash on stderr', [], 'TypeError: boom', 'failed', 'TypeError: boom', false],
  ])('classifies %s', (_name, events, stderr, status, error, stops) => {
    const { run } = replay(stream(...events), { stderr });
    expect(run).toMatchObject({ status, error });
    expect(Boolean(run.stopBench)).toBe(stops);
  });

  it('a limit text inside a successful answer is not a limit', () => {
    expect(replay(stream(init(), result('{"value":"rate limit"}'))).run.status).toBe('completed');
  });

  it('classifies a timeout, but keeps a success result that arrived first', () => {
    expect(replay(stream(init()), { timedOut: true }).run).toMatchObject({ status: 'timeout', error: 'no result within 120000 ms', stopBench: null });
    expect(replay(stream(init(), result(answer('a'))), { timedOut: true }).run).toMatchObject({ status: 'completed', response: answer('a') });
  });

  it('ignores a rate-limit event without details, and keeps the first stop', () => {
    expect(replay(stream(init(), { type: 'rate_limit_event' }, result(answer('a')))).run.status).toBe('completed');
    const parser = createClaudeParser([]);
    expect(parser.onLine(JSON.stringify({ type: 'assistant', error: 'rate_limit' }))).toBe(true);
    expect(parser.onLine(JSON.stringify(init()))).toBe(false);
    expect(parser.state.stop).toEqual({ status: 'rate-limited', error: 'client error: rate_limit' });
  });
});

describe('runProcess', () => {
  it('writes the prompt to stdin, streams every line and flushes the last one', async () => {
    const child = fakeChild(['one', '', 'two']);
    childProcess.spawn.mockReturnValueOnce(child);
    const lines: string[] = [];
    const outcome = await runProcess('claude', ['-p'], { cwd: '/w', env: { PATH: '/bin' }, input: 'PROMPT', timeoutMs: 5000, onLine: (line) => lines.push(line) > 99 });
    expect(lines).toEqual(['one', 'two']);
    expect(outcome).toEqual({ code: 0, timedOut: false, stopped: false, stderr: '' });
    expect(child.stdin.received).toBe('PROMPT');
    expect(childProcess.spawn).toHaveBeenCalledWith('claude', ['-p'], expect.objectContaining({ cwd: '/w', env: { PATH: '/bin' } }));
  });

  it('kills the process when onLine asks to stop, and ignores later lines', async () => {
    const child = fakeChild(['stop', 'after']);
    childProcess.spawn.mockReturnValueOnce(child);
    const onLine = vi.fn((line: string) => line === 'stop');
    const outcome = await runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 5000, onLine });
    expect(outcome.stopped).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onLine).toHaveBeenCalledTimes(1);
  });

  it('kills a hanging process at the timeout and keeps the stderr tail', async () => {
    const child = fakeChild([], { hang: true, stderr: 'still thinking' });
    childProcess.spawn.mockReturnValueOnce(child);
    const outcome = await runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 20, onLine: () => false });
    expect(outcome).toMatchObject({ timedOut: true, stderr: 'still thinking' });
  });

  it('joins a JSON line split across stdout chunks', async () => {
    childProcess.spawn.mockReturnValueOnce(fakeChild(['{"b":2}'], { chunks: ['{"a"', ':1}\n'] }));
    const lines: string[] = [];
    await runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 5000, onLine: (line) => lines.push(line) > 99 });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('escalates to SIGKILL and resolves after exit even when a grandchild keeps stdout open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = fakeChild([], { hang: true });
      child.kill = vi.fn((signal: string) => {
        if (signal === 'SIGKILL') child.emit('exit', null);
        return true;
      });
      childProcess.spawn.mockReturnValueOnce(child);
      const done = runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 1000, onLine: () => false });
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(await done).toMatchObject({ code: null, timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves after a spawn error that is never followed by close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const child = fakeChild([], { hang: true });
      childProcess.spawn.mockReturnValueOnce(child);
      const done = runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 60_000, onLine: () => false });
      child.emit('error', new Error('spawn claude EACCES'));
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
      expect(await done).toMatchObject({ code: null, stderr: 'spawn claude EACCES', timedOut: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with the spawn error instead of rejecting', async () => {
    childProcess.spawn.mockReturnValueOnce(fakeChild([], { error: 'spawn claude ENOENT' }));
    expect(await runProcess('claude', [], { cwd: '/w', env: {}, input: '', timeoutMs: 5000, onLine: () => false })).toMatchObject({ stderr: 'spawn claude ENOENT', timedOut: false });
  });
});

describe('corpus copy', () => {
  it('exports the commit without .git into a directory named like the repository, removes the agent files, then cleans up', () => {
    const calls = emulateCommands();
    const dir = createCorpus();
    expect(path.basename(dir)).toBe('Graph-It-Live');
    expect(path.basename(path.dirname(dir))).toMatch(/^agent-bench-/);
    expect(existsSync(dir)).toBe(true);
    const archive = path.join(path.dirname(dir), 'corpus.tar');
    expect(calls).toEqual([`git archive --format=tar -o ${archive} ${COMMIT}`, `tar -xf ${archive} -C ${dir}`]);
    expect(existsSync(path.join(dir, '.git'))).toBe(false);
    removeCorpus(dir);
    expect(existsSync(path.dirname(dir))).toBe(false);
  });

  it.each(['git', 'tar'])('removes the temporary parent when %s fails, and removal never throws', (failing) => {
    childProcess.execFileSync.mockImplementation((command: string) => {
      if (command === failing) throw new Error(`${failing} failed`);
      return '';
    });
    expect(() => createCorpus()).toThrow(`${failing} failed`);
    expect(() => removeCorpus(path.join(tmpdir(), 'agent-bench-gone', 'Graph-It-Live'))).not.toThrow();
  });
  it('names the copy after another corpus repository, and refuses a name that leaves its directory', () => {
    emulateCommands();
    const dir = exportCorpus('/corpora/vue.git', COMMIT, AGENT_FILES, 'vitepress');
    expect(path.basename(dir)).toBe('vitepress');
    removeCorpus(dir);
    for (const name of ['..', '.', 'a/b', String.raw`a\b`, '']) {
      expect(() => exportCorpus(REPO, COMMIT, AGENT_FILES, name)).toThrow(`invalid corpus directory name ${name}`);
    }
  });
});

const createCorpus = () => exportCorpus(REPO, COMMIT, AGENT_FILES);

describe('rerun plan', () => {
  const tasks = [task('t1'), task('t2'), task('t3')];
  const run = (taskId: string, arm: string, status: RecordedRun['status'], value = 'a'): RecordedRun => ({ taskId, arm, status, response: answer(value) });

  it('reruns failed and timed-out cells first, then both arms of a task whose arms disagree', () => {
    const runs = [run('t1', 'native', 'completed'), run('t1', 'graph', 'completed', 'b'), run('t2', 'native', 'timeout'), run('t2', 'graph', 'completed'), run('t3', 'native', 'completed'), run('t3', 'graph', 'failed')];
    expect(planReruns(runs, tasks, ['native', 'graph'])).toEqual([
      { taskId: 't2', arm: 'native' },
      { taskId: 't3', arm: 'graph' },
      { taskId: 't1', arm: 'native' },
      { taskId: 't1', arm: 'graph' },
    ]);
  });

  it('plans nothing when arms agree, and caps the plan at the budget', () => {
    expect(planReruns([run('t1', 'native', 'completed'), run('t1', 'graph', 'completed')], tasks, ['native', 'graph'])).toEqual([]);
    const failures = tasks.flatMap((t) => ['native', 'graph'].map((arm) => run(t.id, arm, 'failed')));
    expect(planReruns(failures, tasks, ['native', 'graph'], 4)).toHaveLength(4);
    expect(planReruns(failures, tasks, ['native', 'graph'])).toHaveLength(6);
  });
});

describe('runClaudeBench', () => {
  const tasks = [task('t1'), task('t2')];
  const base = { tasks, armSpecs: ARMS, agentFiles: AGENT_FILES, buildPrompt: (t: BenchTask) => `PROMPT ${t.id}`, commit: COMMIT, repoRoot: REPO, env: PARENT_ENV, log: vi.fn() };
  const graphInit = init({ mcp_servers: [{ name: 'graph-it-live', status: 'connected' }] });

  it('verifies the route first, builds the index once, runs every task and arm, and cleans up', async () => {
    const calls = emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(true);
    const children = [stream(init({ plugins: [{ name: 'cc-plugin-telemetry', path: '/b' }] }), toolUse(2), result(answer('a'))), stream(graphInit, toolUse(1), result(answer('a'))), stream(init(), result(answer('a'))), stream(graphInit, result(answer('a')))];
    childProcess.spawn.mockImplementation(() => fakeChild(children.shift() as string[]));
    const { runs, meta } = await runClaudeBench({ ...base, arms: ['native', 'graph'] });
    expect(calls[0]).toBe('claude auth status --json');
    expect(calls.filter((call) => call.includes('scan --workspace'))).toHaveLength(1);
    expect(runs.map((r) => `${r.taskId}/${r.arm}/${r.status}/${r.repetition}`)).toEqual(['t1/native/completed/1', 't1/graph/completed/1', 't2/native/completed/1', 't2/graph/completed/1']);
    expect(runs[0]).toMatchObject({ prompt: 'PROMPT t1', response: answer('a'), metrics: { toolCalls: 2 } });
    expect(meta).toMatchObject({ client: 'claude', clientVersion: '2.1.322 (Claude Code)', model: CLAUDE_MODEL, effort: 'low', authRoute: 'claude.ai subscription (max)', indexState: 'warm', reruns: 0, stopReason: null });
    expect(typeof meta.coldIndexMs).toBe('number');
    expect(meta.builtinPlugins).toEqual(['cc-plugin-telemetry']);
    expect(JSON.stringify(meta)).not.toContain('someone@example.org');
    // The child never sees a key, and runs in the arm worktree with its own MCP config.
    for (const [command, args, options] of childProcess.spawn.mock.calls) {
      expect(command).toBe('claude');
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(options.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
      expect(path.basename(options.cwd)).toBe('Graph-It-Live');
      expect(args[args.indexOf('--mcp-config') + 1]).toMatch(/mcp-(native|graph)\.json$/);
    }
    expect(calls.filter((call) => call.startsWith('git archive'))).toHaveLength(2);
  });

  it('stops at the first rate limit: no later task, no rerun', async () => {
    emulateCommands();
    const children = [stream(init(), result(answer('a'))), stream(init(), { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })];
    childProcess.spawn.mockImplementation(() => fakeChild(children.shift() as string[]));
    const { runs, meta } = await runClaudeBench({ ...base, tasks: [task('t1'), task('t2'), task('t3')], arms: ['native'] });
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    expect(runs.map((r) => r.status)).toEqual(['completed', 'rate-limited']);
    expect(meta).toMatchObject({ stopReason: 'rate limit: rejected', indexState: 'none', coldIndexMs: null, reruns: 0 });
  });

  it('reruns a task whose arms disagree, as a second repetition', async () => {
    emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(true);
    const children = [stream(init(), result(answer('a'))), stream(graphInit, result(answer('wrong'))), stream(init(), result(answer('a'))), stream(graphInit, result(answer('a')))];
    childProcess.spawn.mockImplementation(() => fakeChild(children.shift() as string[]));
    const { runs, meta } = await runClaudeBench({ ...base, tasks: [task('t1')], arms: ['native', 'graph'] });
    expect(runs.map((r) => `${r.arm}#${r.repetition}`)).toEqual(['native#1', 'graph#1', 'native#2', 'graph#2']);
    expect(meta.reruns).toBe(2);
  });

  it('refuses an API-key route before creating a worktree or starting a run', async () => {
    const calls = emulateCommands({ status: { ...SUBSCRIPTION, authMethod: 'api_key' } });
    await expect(runClaudeBench({ ...base, arms: ['native'] })).rejects.toThrow('refusing to start');
    expect(calls).toEqual(['claude auth status --json']);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('refuses the graph arm without a built MCP server', async () => {
    emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(false);
    await expect(runClaudeBench({ ...base, arms: ['graph'] })).rejects.toThrow('dist/mcpServer.mjs is missing');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
