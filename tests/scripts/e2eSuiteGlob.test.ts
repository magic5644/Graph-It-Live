/**
 * VS Code E2E suite selection tests
 *
 * tests/vscode-e2e/suite/index.ts runs the suites matched by `E2E_SUITE_GLOB`
 * (used by .github/workflows/e2e-os.yml), or every suite without it, and fails
 * when the glob matches no suite.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { glob } from 'glob';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { run, suiteGlob } from '../vscode-e2e/suite/index';

describe('suiteGlob', () => {
  let testsRoot: string;

  beforeAll(() => {
    testsRoot = mkdtempSync(path.join(tmpdir(), 'e2e-suite-glob-'));
    mkdirSync(path.join(testsRoot, 'suite'));
    for (const file of ['architectureView.test.js', 'callGraph.test.js', 'index.js']) {
      writeFileSync(path.join(testsRoot, 'suite', file), '');
    }
  });

  afterAll(() => {
    rmSync(testsRoot, { recursive: true, force: true });
  });

  const select = async (env: NodeJS.ProcessEnv) =>
    (await glob(suiteGlob(env), { cwd: testsRoot, posix: true })).sort((a, b) => a.localeCompare(b));

  it('runs every suite without E2E_SUITE_GLOB', async () => {
    expect(suiteGlob({})).toBe('**/**.test.js');
    expect(await select({})).toEqual(['suite/architectureView.test.js', 'suite/callGraph.test.js']);
  });

  it('runs every suite when E2E_SUITE_GLOB is blank', async () => {
    expect(await select({ E2E_SUITE_GLOB: '  ' })).toEqual(['suite/architectureView.test.js', 'suite/callGraph.test.js']);
  });

  it('runs only the suites matched by E2E_SUITE_GLOB', async () => {
    expect(await select({ E2E_SUITE_GLOB: '**/architectureView.test.js' })).toEqual(['suite/architectureView.test.js']);
  });

  it('accepts Windows separators', async () => {
    expect(suiteGlob({ E2E_SUITE_GLOB: String.raw`suite\architectureView.test.js` })).toBe('suite/architectureView.test.js');
    expect(await select({ E2E_SUITE_GLOB: String.raw`**\architectureView.test.js` })).toEqual(['suite/architectureView.test.js']);
  });

  it('selects nothing when no suite matches', async () => {
    expect(await select({ E2E_SUITE_GLOB: '**/missing.test.js' })).toEqual([]);
  });
});

describe('run', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails instead of passing with 0 tests when E2E_SUITE_GLOB matches no suite', async () => {
    vi.stubEnv('E2E_SUITE_GLOB', '**/missing.test.js');
    await expect(run()).rejects.toThrow('No E2E suite matches "**/missing.test.js"');
  });
});
