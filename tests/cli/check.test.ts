import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeScanDeadCode: vi.fn(),
  executeFindUnusedSymbols: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeScanDeadCode: mocks.executeScanDeadCode,
  executeFindUnusedSymbols: mocks.executeFindUnusedSymbols,
}));

import { run } from '../../src/cli/commands/check.js';
import { classifyError } from '../../src/cli/errors';
import { CliProgress } from "@/cli/progress";

describe('check command', () => {
  let root: string;
  const runtime = () => ({ workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn().mockResolvedValue(undefined) }) as never;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitl-check-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    mocks.executeScanDeadCode.mockReset().mockResolvedValue({ entries: [] });
    mocks.executeFindUnusedSymbols.mockReset().mockResolvedValue({ unusedSymbols: [] });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [[], { minConfidence: undefined, verbose: false, unreferencedFiles: false }, undefined, expect.any(Function)],
    [['--minConfidence', 'low'], { minConfidence: 'low', verbose: false, unreferencedFiles: false }, undefined, expect.any(Function)],
    [['--verbose'], { minConfidence: undefined, verbose: true, unreferencedFiles: false }, undefined, expect.any(Function)],
    [['--verbose', '--minConfidence', 'medium'], { minConfidence: 'medium', verbose: true, unreferencedFiles: false }, undefined, expect.any(Function)],
  ])('scans the workspace for %j', async (args, expected) => {
    await run(args, runtime(), 'json');
    expect(mocks.executeScanDeadCode).toHaveBeenCalledWith(expected, undefined, expect.any(Function));
  });

  it('scans a folder given before or after --minConfidence', async () => {
    await run(['--minConfidence', 'medium', 'src'], runtime(), 'json');
    await run(['src', '--minConfidence', 'medium'], runtime(), 'json');
    expect(mocks.executeScanDeadCode.mock.calls).toEqual([
      [{ scopePath: path.join(root, 'src'), minConfidence: 'medium', verbose: false, unreferencedFiles: false }, undefined, expect.any(Function)],
      [{ scopePath: path.join(root, 'src'), minConfidence: 'medium', verbose: false, unreferencedFiles: false }, undefined, expect.any(Function)],
    ]);
  });

  it('passes --verbose to a folder scan, wherever it stands', async () => {
    await run(['src', '--verbose'], runtime(), 'json');
    await run(['--verbose', 'src'], runtime(), 'json');
    expect(mocks.executeScanDeadCode.mock.calls).toEqual([
      [{ scopePath: path.join(root, 'src'), minConfidence: undefined, verbose: true, unreferencedFiles: false }, undefined, expect.any(Function)],
      [{ scopePath: path.join(root, 'src'), minConfidence: undefined, verbose: true, unreferencedFiles: false }, undefined, expect.any(Function)],
    ]);
  });

  it.each([
    [['--unreferencedFiles'], { minConfidence: undefined, verbose: false, unreferencedFiles: true }],
    [['src', '--unreferencedFiles', '--verbose'], { scopePath: '<src>', minConfidence: undefined, verbose: true, unreferencedFiles: true }],
    [['--unreferencedFiles', '--minConfidence', 'medium', 'src'], { scopePath: '<src>', minConfidence: 'medium', verbose: false, unreferencedFiles: true }],
  ])('lists unreferenced files for %j', async (args, expected) => {
    await run(args, runtime(), 'json');
    const scopePath = 'scopePath' in expected ? { scopePath: path.join(root, 'src') } : {};
    expect(mocks.executeScanDeadCode).toHaveBeenCalledWith({ ...expected, ...scopePath }, undefined, expect.any(Function));
  });

  it('rejects --unreferencedFiles on a file', async () => {
    const rt = runtime();
    const error = classifyError(await run(['src/a.ts', '--unreferencedFiles'], rt, 'json').then(() => undefined, (e: unknown) => e));
    expect(error.message).toContain('--unreferencedFiles applies to the workspace or a folder');
    expect((rt as { ensureIndexed: ReturnType<typeof vi.fn> }).ensureIndexed).not.toHaveBeenCalled();
    expect(mocks.executeFindUnusedSymbols).not.toHaveBeenCalled();
  });

  it('checks one file at the requested confidence', async () => {
    await run(['src/a.ts', '--minConfidence', 'low'], runtime(), 'json');
    expect(mocks.executeFindUnusedSymbols).toHaveBeenCalledWith({ filePath: expect.stringContaining('a.ts'), minConfidence: 'low' });
  });

  it.each([[['--minConfidence']], [['--minConfidence', 'sure']]])('rejects %j before indexing', async (args) => {
    const rt = runtime();
    const error = classifyError(await run(args, rt, 'json').then(() => undefined, (e: unknown) => e));
    expect(error.message).toContain('--minConfidence must be high or medium or low');
    expect((rt as { ensureIndexed: ReturnType<typeof vi.fn> }).ensureIndexed).not.toHaveBeenCalled();
  });
});
