/**
 * AIDD workflow state machine (scripts/aidd-state.mjs): step order, loop bounds,
 * tier changes, human gates, handoffs and crash-safe resume.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AiddError,
  LIMITS,
  createState,
  nextStep,
  rewindTarget,
  run,
  summary,
} from '../../scripts/aidd-state.mjs';

const HANDOFF = [
  'CONTEXT: issue 42, Spider cache',
  'PHASE: implement',
  'BLOCKERS: none',
  'PRIOR OUTPUTS: spec docs/specs/42.md',
  'ACTION: implement section 2, tests with the code',
].join('\n');

let dir: string;
const cli = (...args: string[]) => run(args, () => HANDOFF);
const errorOf = (fn: () => unknown): AiddError => {
  try {
    fn();
  } catch (error) {
    return error as AiddError;
  }
  throw new Error('expected an AiddError');
};
const advanceTo = (id: string, step: string) => {
  for (let next = cli('status', id).next; next !== step; next = cli('status', id).next) {
    if (next.startsWith('GATE-')) cli('gate', id, next, 'approve');
    else cli('done', id, next);
  }
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aidd-state-'));
  process.env.AIDD_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AIDD_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('step order', () => {
  it('starts at the first step and refuses out-of-order completion', () => {
    expect(cli('start', '42', 'bugfix').next).toBe('diagnose');
    const error = errorOf(() => cli('done', '42', 'implement'));
    expect(error.code).toBe(2);
    expect(error.message).toContain('next step of 42 is "diagnose"');
  });

  it('runs a full bugfix to close, with the human gate recorded', () => {
    cli('start', '42', 'bugfix');
    advanceTo('42', 'GATE-6');
    expect(cli('status', '42').nextIsHumanGate).toBe(true);
    expect(errorOf(() => cli('done', '42', 'GATE-6')).message).toContain('human gate');
    cli('gate', '42', 'GATE-6', 'approve');
    cli('done', '42', 'merge');
    expect(cli('close', '42').closed).toBe(true);
    expect(cli('status')).toEqual([]);
  });

  it('skips only optional steps, with a reason', () => {
    cli('start', 'qw', 'quick-win');
    cli('done', 'qw', 'branch');
    expect(errorOf(() => cli('skip', 'qw', 'spec')).message).toContain('--reason');
    cli('skip', 'qw', 'spec', '--reason', 'two-file fix');
    cli('skip', 'qw', 'spec-review', '--reason', 'two-file fix');
    expect(errorOf(() => cli('skip', 'qw', 'implement', '--reason', 'x')).message).toContain('mandatory');
  });

  it('refuses to close an unfinished item and to act on a closed one', () => {
    cli('start', 'h', 'bug-hunt');
    expect(errorOf(() => cli('close', 'h')).message).toContain('investigate');
    cli('done', 'h', 'investigate');
    cli('done', 'h', 'report');
    cli('close', 'h');
    expect(errorOf(() => cli('done', 'h', 'report')).message).toContain('closed');
    expect(errorOf(() => cli('round', 'h', 'investigate')).message).toContain('closed');
  });

  it('stores artifacts passed with done', () => {
    cli('start', 'f', 'feature');
    cli('done', 'f', 'classify');
    expect(cli('done', 'f', 'spec', '--artifact', 'spec=docs/specs/f.md').artifacts).toEqual({ spec: 'docs/specs/f.md' });
  });
});

describe('loop bounds', () => {
  it('rewinds a QA or review block to implement', () => {
    cli('start', 'f', 'feature');
    advanceTo('f', 'qa');
    expect(cli('round', 'f', 'qa', '--reason', 'coverage 70%').next).toBe('implement');
    expect(cli('status', 'f').totalRounds).toBe('1/3');
  });

  it('stops after two rounds on one step and three in total (exit code 3)', () => {
    cli('start', 'f', 'feature');
    advanceTo('f', 'review');
    cli('round', 'f', 'review');
    advanceTo('f', 'review');
    cli('round', 'f', 'review');
    advanceTo('f', 'review');
    const perStep = errorOf(() => cli('round', 'f', 'review'));
    expect(perStep.code).toBe(3);
    expect(perStep.message).toContain('limit 2');
    cli('round', 'f', 'qa');
    advanceTo('f', 'checks');
    const total = errorOf(() => cli('round', 'f', 'checks'));
    expect(total.code).toBe(3);
    expect(total.message).toContain(`limit ${LIMITS.total}`);
  });

  it('keeps the bound event on disk even though the command failed', () => {
    cli('start', 'h', 'bug-hunt');
    cli('done', 'h', 'investigate');
    cli('round', 'h', 'investigate');
    expect(errorOf(() => cli('round', 'h', 'investigate')).code).toBe(3);
    const reloaded = cli('status', 'h');
    expect(reloaded.rounds).toEqual({ investigate: 1 });
  });

  it('bounds CI fix pushes separately from correction rounds', () => {
    cli('start', 'b', 'bugfix');
    advanceTo('b', 'ci');
    cli('round', 'b', 'ci');
    cli('round', 'b', 'ci');
    expect(errorOf(() => cli('round', 'b', 'ci')).code).toBe(3);
    expect(cli('status', 'b').totalRounds).toBe('0/3');
  });

  it('lets the human grant one more round', () => {
    cli('start', 'h', 'bug-hunt');
    cli('round', 'h', 'investigate');
    expect(errorOf(() => cli('round', 'h', 'investigate')).code).toBe(3);
    cli('override', 'h');
    expect(cli('round', 'h', 'investigate').rounds).toEqual({ investigate: 2 });
  });

  it('treats a rejected gate as a bounded round back to the previous step', () => {
    cli('start', 'f', 'feature');
    advanceTo('f', 'GATE-5');
    expect(cli('gate', 'f', 'GATE-5', 'reject').next).toBe('spec-review');
    expect(errorOf(() => cli('gate', 'f', 'GATE-5', 'maybe')).message).toContain('spec-review');
  });

  it('maps devil steps back to the challenged step and refuses unknown ones', () => {
    expect(rewindTarget('epic', 'design-review')).toBe('design');
    expect(rewindTarget('security-audit', 'attack')).toBe('threat-model');
    expect(rewindTarget('adr', 'challenge')).toBe('options');
    expect(rewindTarget('optimize', 'measure')).toBe('implement');
    expect(() => rewindTarget('feature', 'branch')).toThrow('cannot raise');
  });
});

describe('tier changes', () => {
  it('allows one tier change, keeps the branch, refuses a second (no ping-pong)', () => {
    cli('start', 'q', 'quick-win');
    cli('done', 'q', 'branch');
    const moved = cli('retier', 'q', 'feature');
    expect(moved.tier).toBe('feature');
    expect(moved.done).toEqual(['branch']);
    expect(moved.next).toBe('classify');
    expect(errorOf(() => cli('retier', 'q', 'quick-win')).code).toBe(3);
  });

  it('rejects unknown tiers', () => {
    expect(errorOf(() => cli('start', 'x', 'epicc')).message).toContain('Unknown tier');
    cli('start', 'x', 'bugfix');
    expect(errorOf(() => cli('retier', 'x', 'nope')).message).toContain('Unknown tier');
  });
});

describe('handoffs', () => {
  it('stores a five-field handoff per agent and returns it in status', () => {
    cli('start', 'f', 'feature');
    cli('handoff', 'f', 'lucas-analyzer-developer', 'handoff.txt');
    expect(cli('status', 'f').handoffs['lucas-analyzer-developer']).toContain('ACTION: implement');
  });

  it('rejects a handoff with a missing field or pasted output', () => {
    cli('start', 'f', 'feature');
    const missing = errorOf(() => run(['handoff', 'f', 'emma', 'x'], () => 'CONTEXT: a\nACTION: b'));
    expect(missing.message).toContain('PHASE, BLOCKERS, PRIOR OUTPUTS');
    const pasted = HANDOFF.replace('PRIOR OUTPUTS: spec docs/specs/42.md', 'PRIOR OUTPUTS: a\nb\nc');
    expect(errorOf(() => run(['handoff', 'f', 'emma', 'x'], () => pasted)).message).toContain('at most two lines');
  });
});

describe('resume after a stop or crash', () => {
  it('reports the interrupted agent step and the next step', () => {
    cli('start', 'f', 'feature');
    advanceTo('f', 'implement');
    cli('begin', 'f', 'implement', 'lucas-analyzer-developer');
    const resumed = cli('status', 'f');
    expect(resumed.next).toBe('implement');
    expect(resumed.interrupted).toContain('lucas-analyzer-developer');
    expect(cli('status')).toEqual([expect.objectContaining({ id: 'f', next: 'implement', interrupted: true })]);
    expect(cli('done', 'f', 'implement').interrupted).toBeNull();
  });

  it('refuses to start an item twice and points to status', () => {
    cli('start', 'f', 'feature');
    expect(errorOf(() => cli('start', 'f', 'feature')).message).toContain('status f');
  });

  it('reports a missing or corrupt state file clearly', () => {
    expect(errorOf(() => cli('status', 'nope')).message).toContain('start nope <tier>');
    writeFileSync(path.join(dir, 'bad.json'), '{"id": "bad",');
    expect(errorOf(() => cli('status', 'bad')).message).toContain('corrupt');
  });

  it('still lists the other open items when one state file is corrupt', () => {
    cli('start', 'ok', 'bugfix');
    writeFileSync(path.join(dir, 'bad.json'), '{"id": "bad",');
    expect(cli('status')).toEqual([
      expect.objectContaining({ id: 'bad', corrupt: expect.stringContaining('corrupt') }),
      expect.objectContaining({ id: 'ok', next: 'diagnose' }),
    ]);
  });

  it('lists nothing when no state folder exists', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(cli('status')).toEqual([]);
  });
});

describe('input validation', () => {
  it('rejects path-like ids and unknown commands', () => {
    expect(errorOf(() => cli('start', '../etc', 'bugfix')).message).toContain('Invalid id');
    expect(errorOf(() => cli('status', '../x')).message).toContain('Invalid id');
    cli('start', 'f', 'feature');
    expect(errorOf(() => cli('frobnicate', 'f')).message).toContain('Usage');
    expect(errorOf(() => cli('done')).message).toContain('Usage');
  });

  it('builds a summary from a fresh state', () => {
    const state = createState('s', 'adr', 'epic-1');
    expect(nextStep(state)).toBe('options');
    expect(summary(state)).toMatchObject({ parent: 'epic-1', nextIsHumanGate: false, ciFixes: '0/2' });
  });
});
