/**
 * AIDD hooks (scripts/aidd-hook.mjs): agent calls need a started step, `gh pr merge`
 * needs GATE-6 approved, session start lists open items for resume.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cli, main } from '../../scripts/aidd-hook.mjs';
import { run } from '../../scripts/aidd-state.mjs';

let dir: string;
let agentsDir: string;
const state = (...args: string[]) => run(args);
const agentCall = (subagent_type: string) => JSON.stringify({ tool_name: 'Agent', tool_input: { subagent_type, prompt: 'x' } });
const bash = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const toGate6 = (id: string) => {
  for (let next = state('status', id).next; next !== 'GATE-6'; next = state('status', id).next) {
    if (next === 'branch') state('done', id, 'branch', '--artifact', 'branch=fix/42-cache');
    else state('done', id, next);
  }
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aidd-hook-'));
  process.env.AIDD_STATE_DIR = path.join(dir, 'state');
  agentsDir = path.join(dir, 'agents');
  mkdirSync(agentsDir);
  writeFileSync(path.join(agentsDir, 'lucas-analyzer-developer.md'), '---\nname: lucas-analyzer-developer\n---\n');
});
afterEach(() => {
  delete process.env.AIDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('agent hook', () => {
  it('blocks an AIDD agent without a started step and says what to run', () => {
    state('start', '42', 'bugfix');
    const result = main('agent', agentCall('lucas-analyzer-developer'), { agentsDir });
    expect(result.code).toBe(2);
    expect(result.err).toContain('begin <id> <step> lucas-analyzer-developer');
    expect(result.err).toContain('42 (next: diagnose)');
  });

  it('blocks with "none" when no item is open', () => {
    expect(main('agent', agentCall('lucas-analyzer-developer'), { agentsDir }).err).toContain('Open items: none');
  });

  it('allows the agent once its step is started, and non-AIDD agents always', () => {
    state('start', '42', 'bugfix');
    state('done', '42', 'diagnose');
    state('done', '42', 'branch', '--artifact', 'branch=fix/42-cache');
    state('begin', '42', 'implement', 'lucas-analyzer-developer');
    expect(main('agent', agentCall('lucas-analyzer-developer'), { agentsDir }).code).toBe(0);
    expect(main('agent', agentCall('Explore'), { agentsDir }).code).toBe(0);
    expect(main('agent', JSON.stringify({ tool_input: {} }), { agentsDir }).code).toBe(0);
  });

  it('ignores corrupt state files when checking', () => {
    state('start', '42', 'bugfix');
    writeFileSync(path.join(dir, 'state', 'bad.json'), '{');
    expect(main('agent', agentCall('lucas-analyzer-developer'), { agentsDir }).err).toContain('42 (next: diagnose)');
  });
});

describe('merge hook', () => {
  it('lets other commands through', () => {
    expect(main('merge', bash('gh pr view 1'), { branch: 'x' }).code).toBe(0);
    expect(main('merge', JSON.stringify({ tool_input: {} }), { branch: 'x' }).code).toBe(0);
  });

  it('blocks a merge on a branch no item records', () => {
    const result = main('merge', bash('gh pr merge 838 --rebase'), { branch: 'feat/x' });
    expect(result.code).toBe(2);
    expect(result.err).toContain('--artifact branch=feat/x');
  });

  it('blocks before GATE-6 and allows after approval', () => {
    state('start', '42', 'bugfix');
    toGate6('42');
    const before = main('merge', bash('GH_TOKEN=x gh pr merge --rebase --delete-branch'), { branch: 'fix/42-cache' });
    expect(before.code).toBe(2);
    expect(before.err).toContain('gate 42 GATE-6 approve');
    state('gate', '42', 'GATE-6', 'approve');
    expect(main('merge', bash('gh pr merge --rebase --delete-branch'), { branch: 'fix/42-cache' }).code).toBe(0);
  });
});

describe('session hook and modes', () => {
  it('prints nothing without open items, then lists them with resume hints', () => {
    expect(main('session', '').out).toBe('');
    state('start', '42', 'bugfix');
    state('begin', '42', 'diagnose', 'main');
    writeFileSync(path.join(dir, 'state', 'bad.json'), '{');
    const out = main('session', '').out;
    expect(out).toContain('- 42 [bugfix] next: diagnose (interrupted step');
    expect(out).toContain('- bad: corrupt state');
  });

  it('rejects an unknown mode', () => {
    expect(main('nope', '{}')).toEqual({ code: 1, err: expect.stringContaining('Unknown hook mode') });
  });

  it('cli reads the current git branch and never blocks on malformed input', () => {
    const merge = cli(['merge'], () => bash('gh pr merge 1'));
    expect(merge.code).toBe(2);
    expect(merge.err).toMatch(/No AIDD item records branch "[^"]+"/);
    expect(cli(['agent'], () => '{bad')).toEqual({ code: 1, err: expect.stringContaining('aidd-hook:') });
    expect(cli(['session'], () => { throw new Error('stdin must not be read'); }).code).toBe(0);
  });
});
