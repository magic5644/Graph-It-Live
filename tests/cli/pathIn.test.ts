import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeFindReferencingFiles: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeFindReferencingFiles: mocks.executeFindReferencingFiles,
}));

import { run } from '../../src/cli/commands/pathIn.js';

/** A real workspace holding the target files: the command refuses a missing file. */
function tempWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-')));
  for (const file of ['src/index.ts', 'src/impl/one.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

describe('path-in command', () => {
  beforeEach(() => {
    mocks.executeFindReferencingFiles.mockReset();
  });

  it('returns incoming dependencies with graph nodes/edges', async () => {
    const workspaceRoot = tempWorkspace();
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

  it('links a consumer behind a barrel to the barrel, not to the target', async () => {
    const workspaceRoot = tempWorkspace();
    const target = path.resolve(workspaceRoot, 'src/impl/one.ts');
    const barrel = path.resolve(workspaceRoot, 'src/index.ts');
    const consumer = path.resolve(workspaceRoot, 'src/main.ts');
    mocks.executeFindReferencingFiles.mockResolvedValueOnce({
      targetPath: target,
      referencingFileCount: 2,
      referencingFiles: [
        { path: barrel, relativePath: 'src/index.ts', type: 'export', line: 1, module: './impl/one' },
        { path: consumer, relativePath: 'src/main.ts', type: 'import', line: 1, module: './index', via: 'src/index.ts' },
      ],
    });

    const output = await run(['src/impl/one.ts'], { workspaceRoot, ensureIndexed: vi.fn() } as never, 'json');

    expect((JSON.parse(output) as { edges: unknown[] }).edges).toEqual([
      { source: barrel, target },
      { source: consumer, target: barrel },
    ]);
  });
});
