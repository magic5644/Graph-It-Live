import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeCrawlDependencyGraph: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeCrawlDependencyGraph: mocks.executeCrawlDependencyGraph,
}));

import { run } from '../../src/cli/commands/cycles.js';

describe('cycles command', () => {
  beforeEach(() => {
    mocks.executeCrawlDependencyGraph.mockReset();
  });

  it('returns confirmed cycles that include the target file', async () => {
    const workspaceRoot = '/workspace';
    const target = path.resolve(workspaceRoot, 'src/index.ts');
    const fileB = path.resolve(workspaceRoot, 'src/b.ts');

    mocks.executeCrawlDependencyGraph.mockResolvedValueOnce({
      circularDependencies: [
        [target, fileB, target],
        [fileB, target],
      ],
    });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['src/index.ts'], runtime as never, 'json');
    const parsed = JSON.parse(output) as {
      cycleCount: number;
      confirmedCycles: string[][];
    };

    expect(parsed.cycleCount).toBe(2);
    expect(parsed.confirmedCycles[0][0]).toBe('src/index.ts');
  });
});
