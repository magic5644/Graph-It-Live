import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeFindReferencingFiles: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeFindReferencingFiles: mocks.executeFindReferencingFiles,
}));

import { run } from '../../src/cli/commands/pathIn.js';

describe('path-in command', () => {
  beforeEach(() => {
    mocks.executeFindReferencingFiles.mockReset();
  });

  it('returns incoming dependencies with graph nodes/edges', async () => {
    const workspaceRoot = '/workspace';
    const target = path.resolve(workspaceRoot, 'src/index.ts');
    const refA = path.resolve(workspaceRoot, 'src/app.ts');

    mocks.executeFindReferencingFiles.mockResolvedValueOnce({
      targetPath: target,
      referencingFileCount: 1,
      referencingFiles: [
        {
          path: refA,
          relativePath: 'src/app.ts',
          type: 'import',
          line: 2,
          module: './index',
        },
      ],
    });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['src/index.ts'], runtime as never, 'json');
    const parsed = JSON.parse(output) as {
      nodeCount: number;
      edgeCount: number;
      nodes: Array<{ path: string }>;
      edges: Array<{ source: string; target: string }>;
    };

    expect(parsed.nodeCount).toBe(2);
    expect(parsed.edgeCount).toBe(1);
    expect(parsed.nodes.map((node) => node.path)).toEqual(
      expect.arrayContaining([target, refA]),
    );
    expect(parsed.edges[0]).toEqual({ source: refA, target });
  });
});
