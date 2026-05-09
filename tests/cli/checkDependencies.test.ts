import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeAnalyzeDependencies: vi.fn(),
  executeFindReferencingFiles: vi.fn(),
}));

vi.mock('../../src/mcp/tools', () => ({
  executeAnalyzeDependencies: mocks.executeAnalyzeDependencies,
  executeFindReferencingFiles: mocks.executeFindReferencingFiles,
}));

import { run } from '../../src/cli/commands/checkDependencies.js';

describe('check-dependencies command', () => {
  beforeEach(() => {
    mocks.executeAnalyzeDependencies.mockReset();
    mocks.executeFindReferencingFiles.mockReset();
  });

  it('returns incoming and outgoing dependencies for a file', async () => {
    const workspaceRoot = '/workspace';
    const target = path.resolve(workspaceRoot, 'src/index.ts');

    mocks.executeAnalyzeDependencies.mockResolvedValueOnce({
      filePath: target,
      dependencyCount: 1,
      dependencies: [{ path: path.resolve(workspaceRoot, 'src/utils.ts') }],
    });

    mocks.executeFindReferencingFiles.mockResolvedValueOnce({
      targetPath: target,
      referencingFileCount: 1,
      referencingFiles: [{ path: path.resolve(workspaceRoot, 'src/app.ts') }],
    });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['src/index.ts'], runtime as never, 'json');
    const parsed = JSON.parse(output) as {
      outgoing: { dependencyCount: number };
      incoming: { referencingFileCount: number };
    };

    expect(parsed.outgoing.dependencyCount).toBe(1);
    expect(parsed.incoming.referencingFileCount).toBe(1);
  });

  it('supports mermaid output for dependency graph export', async () => {
    const workspaceRoot = '/workspace';
    const target = path.resolve(workspaceRoot, 'src/index.ts');

    mocks.executeAnalyzeDependencies.mockResolvedValueOnce({
      filePath: target,
      dependencyCount: 1,
      dependencies: [{ path: path.resolve(workspaceRoot, 'src/utils.ts') }],
    });

    mocks.executeFindReferencingFiles.mockResolvedValueOnce({
      targetPath: target,
      referencingFileCount: 1,
      referencingFiles: [{ path: path.resolve(workspaceRoot, 'src/app.ts') }],
    });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['src/index.ts'], runtime as never, 'mermaid');
    expect(output).toContain('graph LR');
    expect(output).toContain('-->');
  });
});
