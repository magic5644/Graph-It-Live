/**
 * Agent benchmark live Codex run tests (#399 c, #677)
 *
 * scripts/bench-agent/codex.mjs. child_process is mocked: `codex login status`,
 * `codex --version`, `git`, `tar` and `graph-it scan` are emulated, and spawn returns a
 * fake process replaying recorded `codex exec --json` lines. symlinkSync is mocked (no
 * symlink privilege on Windows runners). No real process, client binary, network, git
 * checkout or index build is used.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type SpawnOptions = { cwd: string; env: Record<string, string> };
const childProcess = vi.hoisted(() => {
  const refuse = (name: string) => (): never => {
    throw new Error(`benchAgentCodex tests must not spawn a real process (${name})`);
  };
  return {
    execFileSync: vi.fn<(command: string, args: string[]) => string>(),
    spawn: vi.fn<(command: string, args: string[], options: SpawnOptions) => unknown>(refuse('spawn')),
    spawnSync: vi.fn<(command: string, args: string[], options: SpawnOptions) => unknown>(refuse('spawnSync')),
    exec: vi.fn(refuse('exec')),
    execSync: vi.fn(refuse('execSync')),
    execFile: vi.fn(refuse('execFile')),
    fork: vi.fn(refuse('fork')),
  };
});
vi.mock('node:child_process', () => ({ ...childProcess, default: childProcess }));

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(), symlinkSync: vi.fn(), rmSync: vi.fn(), actualSymlinkSync: null as unknown }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.actualSymlinkSync = actual.symlinkSync;
  fsMock.existsSync.mockImplementation(actual.existsSync);
  fsMock.rmSync.mockImplementation(actual.rmSync);
  const mocked = { ...actual, existsSync: fsMock.existsSync, symlinkSync: fsMock.symlinkSync, rmSync: fsMock.rmSync };
  return { ...mocked, default: mocked };
});

import {
  CODEX_EFFORT,
  CODEX_MODEL,
  DISABLED_FEATURES,
  codexArgs,
  codexConfig,
  codexEnv,
  codexMetrics,
  createCodexParser,
  finishCodexRun,
  renderCodexDryRun,
  runCodexBench,
  verifyCodexLogin,
} from '../../scripts/bench-agent/codex.mjs';
import type { BenchTask } from '../../scripts/bench-agent/harness.mjs';
import { buildReport, renderMarkdown } from '../../scripts/bench-agent/harness.mjs';
import { AGENT_FILES, ARMS, loadDataset } from '../../scripts/bench-agent/index.mjs';
import { fakeChild } from './benchAgentFakeChild';

const COMMIT = 'c'.repeat(40);
const REPO = path.join(tmpdir(), 'bench-agent-codex-repo');
const SOURCE_HOME = path.join(tmpdir(), 'bench-agent-codex-source-home');
const PARENT_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  CODEX_HOME: SOURCE_HOME,
  OPENAI_API_KEY: 'sk-openai',
  OPENAI_BASE_URL: 'http://127.0.0.1:8787',
  CODEX_API_KEY: 'sk-codex',
  AZURE_OPENAI_API_KEY: 'azure',
  ANTHROPIC_API_KEY: 'sk-ant',
};
const CHATGPT = { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
const API_KEY = { status: 0, stdout: '', stderr: 'Logged in using an API key - sk-proj-***ABCD\n' };
const LOGGED_OUT = { status: 1, stdout: '', stderr: 'Not logged in\n' };

const task = (id: string, key = 'a'): BenchTask => ({
  id,
  class: 'known-file',
  prompt: `question ${id}`,
  answerShape: { value: 'string' },
  key: { value: key },
  evidence: [{ path: 'src/a.ts' }],
});

const answer = (value: string) => JSON.stringify({ value });
const started = { type: 'thread.started', thread_id: 't-1' };
const command = { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'rg x', status: 'completed' } };
const mcpCall = (server = 'graph-it-live') => ({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server, tool: 'graphit_find', status: 'completed' } });
const message = (text: string) => ({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text } });
const completed = (usage: Record<string, number> = { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 10 }) => ({ type: 'turn.completed', usage });
const stream = (...events: unknown[]) => events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)));
const run = (lines: string[], outcome: Partial<{ code: number | null; timedOut: boolean; stderr: string }> = {}, serverNames: string[] = []) => {
  const parser = createCodexParser(serverNames);
  const stops = lines.map((line) => parser.onLine(line));
  return { stops, state: parser.state, ...finishCodexRun(parser.state, { code: 0, timedOut: false, stderr: '', ...outcome }, 1500) };
};

/** Emulates `codex login status` (spawnSync), `codex --version`, git, tar and `graph-it scan`. */
function emulateCommands(login: unknown = CHATGPT) {
  const calls: string[] = [];
  childProcess.spawnSync.mockImplementation((cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return login;
  });
  childProcess.execFileSync.mockImplementation((cmd: string, args: string[]) => {
    calls.push(`${path.basename(cmd)} ${args.join(' ')}`);
    if (cmd === 'codex' && args[0] === '--version') return 'codex-cli 0.167.0\n';
    if (cmd === 'git' || cmd === 'tar' || cmd === process.execPath) return '';
    throw new Error(`unexpected command ${cmd}`);
  });
  return calls;
}

const benchDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('agent-bench-'));
const dirsBefore = new Set(benchDirs());

beforeEach(() => {
  vi.clearAllMocks();
  childProcess.spawn.mockImplementation(() => {
    throw new Error('benchAgentCodex tests must not spawn a real process (spawn)');
  });
});

afterAll(() => {
  for (const name of ['exec', 'execSync', 'execFile', 'fork'] as const) {
    expect(childProcess[name]).not.toHaveBeenCalled();
  }
  // Every temporary corpus copy and CODEX_HOME was removed.
  expect(benchDirs().filter((name) => !dirsBefore.has(name))).toEqual([]);
});

describe('child environment and login', () => {
  it('drops every key and billing variable and points CODEX_HOME and HOME at the temporary dirs', () => {
    const env = codexEnv(PARENT_ENV, '/tmp/x/codex-native', '/tmp/x/home');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/x/home', CODEX_HOME: '/tmp/x/codex-native' });
  });

  it.each([
    [CHATGPT, { ok: true, route: 'ChatGPT subscription login' }],
    [{ ...CHATGPT, stdout: 'Logged in using ChatGPT\n', stderr: '' }, { ok: true }],
    [API_KEY, { ok: false, reason: 'API-key login instead of the ChatGPT subscription' }],
    [LOGGED_OUT, { ok: false, reason: expect.stringContaining('not logged in') }],
    [{ status: 0, stdout: '', stderr: 'Logged in using something else' }, { ok: false, reason: 'login route cannot be verified' }],
    [{ ...CHATGPT, status: 1 }, { ok: false, reason: 'login route cannot be verified' }],
    [{ status: null, stdout: null, stderr: null, error: new Error('spawnSync codex ENOENT') }, { ok: false, reason: 'login status cannot be read (spawnSync codex ENOENT)' }],
  ])('verifyCodexLogin(%j)', (login, expected) => {
    expect(verifyCodexLogin(login)).toMatchObject(expected);
  });

  it('never echoes the masked key of an API-key login', () => {
    expect(JSON.stringify(verifyCodexLogin(API_KEY))).not.toContain('sk-');
  });
});

describe('codex arguments and arm config', () => {
  it('pins model, effort and a read-only sandbox, without session files, rules or user config bypasses', () => {
    const args = codexArgs('/w');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args[args.indexOf('--model') + 1]).toBe(CODEX_MODEL);
    expect(args).toContain(`model_reasoning_effort="${CODEX_EFFORT}"`);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('--cd') + 1]).toBe('/w');
    expect(args).toEqual(expect.arrayContaining(['--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check']));
    expect(args.at(-1)).toBe('-');
    expect(args.join(' ')).not.toMatch(/dangerously|--oss|--profile|--ignore-user-config/);
  });

  it('native config forces the ChatGPT login, turns features off and declares no MCP server', () => {
    const config = codexConfig(ARMS.native, '/w');
    expect(config).toContain('forced_login_method = "chatgpt"');
    expect(config).toContain('web_search = "disabled"');
    for (const feature of DISABLED_FEATURES) expect(config).toContain(`\n${feature} = false`);
    expect(config).not.toContain('mcp_servers');
  });

  it('graph config declares only its required server, indexing the arm worktree', () => {
    const config = codexConfig(ARMS.graph, '/tmp/a "b"/Graph-It-Live');
    expect(config.match(/\[mcp_servers\./g)).toHaveLength(1);
    expect(config).toContain('[mcp_servers.graph-it-live]\ncommand = "node"');
    expect(config).toContain(String.raw`env = { WORKSPACE_ROOT = "/tmp/a \"b\"/Graph-It-Live" }`);
    expect(config).toContain('required = true');
    expect(codexConfig(ARMS.graph, String.raw`C:\w\Graph-It-Live`)).toContain(String.raw`WORKSPACE_ROOT = "C:\\w\\Graph-It-Live"`);
    expect(codexConfig({ setup: '', mcpServers: { 'a.b': { command: 'x', args: [], env: { 'K.1': 'v' } } } }, '/w')).toContain('[mcp_servers."a.b"]\ncommand = "x"\nargs = []\nenv = { "K.1" = "v" }');
  });

  it('dry run lists the dropped variables, the config and the command, never a value', () => {
    const text = renderCodexDryRun({ tasks: [task('t1')], arms: ['native', 'graph'], armSpecs: ARMS, buildPrompt: (t) => `PROMPT ${t.id}`, removedEnv: ['OPENAI_API_KEY'] });
    expect(text).toContain('Child environment drops: OPENAI_API_KEY;');
    expect(text).toContain('`codex login status` must report the ChatGPT login');
    expect(text).toContain('[mcp_servers.graph-it-live]');
    expect(text).toContain("codex exec --json --color never --strict-config --ephemeral --ignore-rules --skip-git-repo-check --model gpt-6-luna -c 'model_reasoning_effort=\"low\"' --sandbox read-only --cd '<worktree>' - < <prompt>");
    expect(text).toContain('PROMPT t1');
    expect(renderCodexDryRun({ tasks: [], arms: ['native'], armSpecs: ARMS, buildPrompt: () => '', removedEnv: [] })).toContain('(none set)');
  });
});

describe('codex exec --json parsing', () => {
  it('counts tool calls, reports turns as unavailable, keeps the last agent message and splits cached input', () => {
    const result = run(stream(started, command, mcpCall(), message('thinking'), message(answer('a')), completed(), 'not json'), {}, ['graph-it-live']);
    expect(result.stops.every((stop) => !stop)).toBe(true);
    expect(result).toMatchObject({ status: 'completed', response: answer('a'), stopBench: null });
    expect(result.metrics).toEqual({ toolCalls: 2, turns: null, latencyMs: 1500, inputTokens: 400, cacheWriteTokens: 0, cacheReadTokens: 600, outputTokens: 50, notionalCostUsd: null });
  });

  it('sums the usage of several turns and subtracts reported cache writes from input', () => {
    const result = run(stream(started, message(answer('a')), completed({ input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 5 }), completed({ input_tokens: 50, output_tokens: 1 })));
    expect(result.metrics).toMatchObject({ turns: null, inputTokens: 100, cacheWriteTokens: 30, cacheReadTokens: 20, outputTokens: 6 });
  });

  it('reports metrics as unavailable without a completed turn', () => {
    const { state } = run(stream(started));
    expect(codexMetrics(state, 10)).toEqual({ toolCalls: null, turns: null, latencyMs: 10, inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: null, notionalCostUsd: null });
  });

  it.each([
    ['error event', { type: 'error', message: "You've hit your usage limit. Upgrade or try again later." }],
    ['failed turn', { type: 'turn.failed', error: { message: 'Rate limit reached for requests' } }],
    ['credits', { type: 'error', message: 'Credits required to continue' }],
  ])('stops at a limit message (%s) and stops the benchmark', (_name, event) => {
    const result = run(stream(started, event, completed()));
    expect(result.stops).toEqual([false, true, false]);
    expect(result).toMatchObject({ status: 'rate-limited', stopBench: expect.any(String) });
  });

  it('keeps a transient error when the turn still completes', () => {
    expect(run(stream(started, { type: 'error', message: 'Reconnecting... 1/5' }, message(answer('a')), completed()))).toMatchObject({ status: 'completed', stopBench: null });
  });

  it('fails a turn.failed run with its message, without stopping the benchmark', () => {
    expect(run(stream(started, { type: 'turn.failed', error: { message: 'model not supported' } }))).toMatchObject({ status: 'failed', error: 'model not supported', stopBench: null });
    expect(run(stream(started, { type: 'turn.failed' }))).toMatchObject({ status: 'failed', error: 'unknown error' });
  });

  it('refuses a call to an MCP server the arm does not configure', () => {
    const result = run(stream(started, mcpCall('other'), message(answer('a')), completed()), {}, ['graph-it-live']);
    expect(result.stops[1]).toBe(true);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('MCP server other'), stopBench: expect.stringContaining('refused') });
  });

  it.each([
    ['no thread.started', stream(message(answer('a')), completed()), {}, 'no thread.started event'],
    ['no event at all', [], { code: 1, stderr: 'boom' }, 'boom'],
    ['non-zero exit', stream(started, message(answer('a')), completed()), { code: 1 }, 'exit code 1'],
    ['no agent message', stream(started, completed()), {}, 'no agent message'],
    ['no turn', stream(started), {}, 'no turn.completed event'],
  ])('fails closed: %s', (_name, lines, outcome, error) => {
    expect(run(lines, outcome)).toMatchObject({ status: 'failed', error, stopBench: null });
  });

  it('reports a limit printed on stderr and a timeout', () => {
    expect(run([], { code: 1, stderr: 'ERROR: usage limit reached' })).toMatchObject({ status: 'rate-limited', stopBench: 'ERROR: usage limit reached' });
    expect(run(stream(started), { code: null, timedOut: true })).toMatchObject({ status: 'timeout', stopBench: null });
    expect(run(stream(started, message(answer('a')), completed()), { code: null, timedOut: true })).toMatchObject({ status: 'failed', error: 'exit code null' });
  });
});

describe('runCodexBench', () => {
  const tasks = [task('t1'), task('t2')];
  const base = { tasks, armSpecs: ARMS, agentFiles: AGENT_FILES, buildPrompt: (t: BenchTask) => `PROMPT ${t.id}`, commit: COMMIT, repoRoot: REPO, env: PARENT_ENV, log: vi.fn() };
  const ok = (value = 'a', ...extra: unknown[]) => stream(started, ...extra, message(answer(value)), completed());

  it('checks the login in a temporary CODEX_HOME, then runs every task and arm with its own config, and cleans up', async () => {
    const calls = emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(true);
    const children = [ok('a', command, command), ok('a', mcpCall()), ok(), ok()];
    const configs: string[] = [];
    childProcess.spawn.mockImplementation((_cmd, _args, options) => {
      configs.push(readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8'));
      return fakeChild(children.shift() as string[]);
    });
    const { runs, meta } = await runCodexBench({ ...base, arms: ['native', 'graph'] });
    expect(calls[0]).toBe('codex login status');
    const loginEnv = childProcess.spawnSync.mock.calls[0]?.[2].env ?? {};
    expect(loginEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(loginEnv).not.toHaveProperty('CODEX_API_KEY');
    expect(loginEnv.CODEX_HOME).not.toBe(SOURCE_HOME);
    expect(loginEnv.HOME).not.toBe('/home/dev');
    // The login file is linked, never copied, into every temporary CODEX_HOME.
    expect(fsMock.symlinkSync.mock.calls.map(([target, link]) => [target, path.basename(path.dirname(link))])).toEqual([
      [path.join(SOURCE_HOME, 'auth.json'), 'codex-login'],
      [path.join(SOURCE_HOME, 'auth.json'), 'codex-native'],
      [path.join(SOURCE_HOME, 'auth.json'), 'codex-graph'],
    ]);
    expect(calls.filter((call) => call.includes('scan --workspace'))).toHaveLength(1);
    expect(runs.map((r) => `${r.taskId}/${r.arm}/${r.status}/${r.repetition}`)).toEqual(['t1/native/completed/1', 't1/graph/completed/1', 't2/native/completed/1', 't2/graph/completed/1']);
    expect(runs[0]).toMatchObject({ prompt: 'PROMPT t1', response: answer('a'), metrics: { toolCalls: 2, turns: null, inputTokens: 400 } });
    expect(meta).toMatchObject({ client: 'codex', clientVersion: 'codex-cli 0.167.0', model: CODEX_MODEL, effort: 'low', authRoute: 'ChatGPT subscription login', indexState: 'warm', reruns: 0, stopReason: null, skipped: null });
    expect(configs.map((config) => config.includes('[mcp_servers.graph-it-live]'))).toEqual([false, true, false, true]);
    for (const [cmd, args, options] of childProcess.spawn.mock.calls) {
      expect(cmd).toBe('codex');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(path.basename(options.env.CODEX_HOME)).toMatch(/^codex-(native|graph)$/);
      expect(path.basename(options.cwd)).toBe('Graph-It-Live');
      expect(args[args.indexOf('--cd') + 1]).toBe(options.cwd);
    }
    // Codex reads repository skills and plugin marketplaces in .agents/: removed from each copy.
    expect(fsMock.rmSync.mock.calls.filter(([target]) => String(target).endsWith(`${path.sep}.agents`))).toHaveLength(2);
  });

  it.each([
    ['an API-key login', API_KEY, 'API-key login instead of the ChatGPT subscription'],
    ['no login', LOGGED_OUT, 'not logged in; run `codex login` with the subscription account'],
    ['a missing codex binary', { status: null, stdout: null, stderr: null, error: new Error('spawnSync codex ENOENT') }, 'login status cannot be read (spawnSync codex ENOENT)'],
  ])('reports codex as skipped with %s, before any corpus copy or run', async (_name, login, reason) => {
    const calls = emulateCommands(login);
    const { runs, meta } = await runCodexBench({ ...base, arms: ['native', 'graph'] });
    expect(runs).toEqual([]);
    expect(meta).toMatchObject({ client: 'codex', skipped: reason, stopReason: `codex skipped: ${reason}`, authRoute: null });
    expect(calls).toEqual(['codex login status']);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  // Real symlink: Windows runners lack the privilege, and the code path is the same on every OS.
  it.skipIf(process.platform === 'win32')('cleanup removes the login link, never the real login file', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'bench-agent-codex-auth-'));
    writeFileSync(path.join(source, 'auth.json'), '{"auth_mode":"chatgpt"}');
    fsMock.symlinkSync.mockImplementation(fsMock.actualSymlinkSync as typeof fsMock.symlinkSync);
    emulateCommands(LOGGED_OUT);
    try {
      await runCodexBench({ ...base, env: { ...PARENT_ENV, CODEX_HOME: source }, arms: ['native'] });
      expect(readFileSync(path.join(source, 'auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}');
    } finally {
      fsMock.symlinkSync.mockReset();
      fsMock.rmSync(source, { recursive: true, force: true });
    }
  });

  it('removes every copy and CODEX_HOME when a run throws', async () => {
    emulateCommands();
    childProcess.spawn.mockImplementation(() => {
      throw new Error('spawn codex EACCES');
    });
    await expect(runCodexBench({ ...base, arms: ['native'] })).rejects.toThrow('spawn codex EACCES');
    expect(benchDirs().filter((name) => !dirsBefore.has(name))).toEqual([]);
  });

  it('a skipped client still gets a report without runs', () => {
    const { hypotheses, tasks: all } = loadDataset();
    const report = buildReport({ meta: { client: 'codex', corpusCommit: COMMIT, stopReason: 'codex skipped: not logged in' }, tasks: all, hypotheses, arms: ['native', 'graph'], runs: [] });
    expect(renderMarkdown(report)).toContain('- Stopped early: codex skipped: not logged in');
  });

  it('stops at the first limit message: no later task, no rerun', async () => {
    emulateCommands();
    const children = [ok(), stream(started, { type: 'error', message: "You've hit your usage limit." })];
    childProcess.spawn.mockImplementation(() => fakeChild(children.shift() as string[]));
    const { runs, meta } = await runCodexBench({ ...base, tasks: [task('t1'), task('t2'), task('t3')], arms: ['native'] });
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    expect(runs.map((r) => r.status)).toEqual(['completed', 'rate-limited']);
    expect(meta).toMatchObject({ stopReason: "You've hit your usage limit.", indexState: 'none', coldIndexMs: null, reruns: 0 });
  });

  it('reruns a task whose arms disagree, as a second repetition', async () => {
    emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(true);
    const children = [ok(), ok('wrong'), ok(), ok()];
    childProcess.spawn.mockImplementation(() => fakeChild(children.shift() as string[]));
    const { runs, meta } = await runCodexBench({ ...base, tasks: [task('t1')], arms: ['native', 'graph'] });
    expect(runs.map((r) => `${r.arm}#${r.repetition}`)).toEqual(['native#1', 'graph#1', 'native#2', 'graph#2']);
    expect(meta.reruns).toBe(2);
  });

  it('refuses the graph arm without a built MCP server', async () => {
    emulateCommands();
    fsMock.existsSync.mockReturnValueOnce(false);
    await expect(runCodexBench({ ...base, arms: ['graph'] })).rejects.toThrow('dist/mcpServer.mjs is missing');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
