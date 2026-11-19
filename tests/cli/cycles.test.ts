import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCrawlDependencyGraph: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeCrawlDependencyGraph: mocks.executeCrawlDependencyGraph,
}));

import { run } from '../../src/cli/commands/cycles.js';

/** A real workspace holding the target files: the command refuses a missing file. */
function tempWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-')));
  for (const file of ['src/index.ts', 'src/impl/one.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

describe('cycles command', () => {
  beforeEach(() => {
    mocks.executeCrawlDependencyGraph.mockReset();
  });

  it('returns confirmed cycles that include the target file', async () => {
    const workspaceRoot = tempWorkspace();
    const target = path.resolve(workspaceRoot, 'src/index.ts');
    const fileB = path.resolve(workspaceRoot, 'src/b.ts');

    mocks.executeCrawlDependencyGraph.mockResolvedValueOnce({
      circularDependencies: [
        [target, fileB, target],
        [fileB, target],
      ],
      circularDependencyKinds: ['runtime', 'type-only'],
    });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['src/index.ts'], runtime as never, 'json');
    const parsed = JSON.parse(output) as {
      cycleCount: number;
      confirmedCycles: string[][];
      cycleKinds: string[];
      typeOnlyCycleCount: number;
    };

    expect(parsed.cycleCount).toBe(2);
    expect(parsed.cycleKinds).toEqual(['runtime', 'type-only']);
    expect(parsed.typeOnlyCycleCount).toBe(1);
    expect(parsed.confirmedCycles[0][0]).toBe('src/index.ts');
  });
});
