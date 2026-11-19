import * as fs from 'node:fs';
import * as os from 'node:os';
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

/** A real workspace holding the target files: the command refuses a missing file. */
function tempWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-')));
  for (const file of ['src/index.ts', 'src/impl/one.ts']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

describe('check-dependencies command', () => {
  beforeEach(() => {
    mocks.executeAnalyzeDependencies.mockReset();
    mocks.executeFindReferencingFiles.mockReset();
  });

  it('returns incoming and outgoing dependencies for a file', async () => {
    const workspaceRoot = tempWorkspace();
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
    const workspaceRoot = tempWorkspace();
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
