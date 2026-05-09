import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePath } from '../../src/shared/path';

const mocks = vi.hoisted(() => ({
  collectAllSourceFiles: vi.fn(),
  executeAnalyzeDependencies: vi.fn(),
}));

vi.mock('../../src/analyzer/SourceFileCollector.js', () => ({
  SourceFileCollector: class {
    collectAllSourceFiles = mocks.collectAllSourceFiles;
  },
}));

vi.mock('../../src/mcp/tools', () => ({
  executeAnalyzeDependencies: mocks.executeAnalyzeDependencies,
}));

import { run } from '../../src/cli/commands/architecture.js';

describe('architecture command', () => {
  beforeEach(() => {
    mocks.collectAllSourceFiles.mockReset();
    mocks.executeAnalyzeDependencies.mockReset();
  });

  it('builds workspace architecture graph from all source files', async () => {
    const workspaceRoot = '/workspace';
    const fileA = normalizePath(path.resolve(workspaceRoot, 'src/index.ts'));
    const fileB = normalizePath(path.resolve(workspaceRoot, 'src/utils.ts'));

    mocks.collectAllSourceFiles.mockResolvedValueOnce([fileA, fileB]);
    mocks.executeAnalyzeDependencies
      .mockResolvedValueOnce({
        dependencies: [
          {
            path: fileB,
            relativePath: 'src/utils.ts',
            type: 'import',
            line: 1,
            module: './utils',
            extension: 'ts',
          },
        ],
      })
      .mockResolvedValueOnce({ dependencies: [] });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run([], runtime as never, 'json');
    const parsed = JSON.parse(output) as {
      nodeCount: number;
      edgeCount: number;
      analyzedFiles: number;
      nodes: Array<{ path: string }>;
      edges: Array<{ source: string; target: string }>;
    };

    expect(parsed.analyzedFiles).toBe(2);
    expect(parsed.nodeCount).toBe(2);
    expect(parsed.edgeCount).toBe(1);
    expect(parsed.nodes.map((n) => n.path)).toEqual(expect.arrayContaining([fileA, fileB]));
    expect(parsed.edges[0]).toMatchObject({ source: fileA, target: fileB });
  });

  it('respects --maxFiles cap', async () => {
    const workspaceRoot = '/workspace';
    const files = [
      path.resolve(workspaceRoot, 'src/a.ts'),
      path.resolve(workspaceRoot, 'src/b.ts'),
      path.resolve(workspaceRoot, 'src/c.ts'),
    ];

    mocks.collectAllSourceFiles.mockResolvedValueOnce(files);
    mocks.executeAnalyzeDependencies.mockResolvedValue({ dependencies: [] });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run(['--maxFiles', '2'], runtime as never, 'json');
    const parsed = JSON.parse(output) as { analyzedFiles: number; scannedFiles: number };

    expect(parsed.scannedFiles).toBe(3);
    expect(parsed.analyzedFiles).toBe(2);
    expect(mocks.executeAnalyzeDependencies).toHaveBeenCalledTimes(2);
  });

  it('supports mermaid output for workspace architecture graph', async () => {
    const workspaceRoot = '/workspace';
    const fileA = path.resolve(workspaceRoot, 'src/index.ts');
    const fileB = path.resolve(workspaceRoot, 'src/utils.ts');

    mocks.collectAllSourceFiles.mockResolvedValueOnce([fileA, fileB]);
    mocks.executeAnalyzeDependencies
      .mockResolvedValueOnce({ dependencies: [{ path: fileB }] })
      .mockResolvedValueOnce({ dependencies: [] });

    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
    };

    const output = await run([], runtime as never, 'mermaid');
    expect(output).toContain('graph LR');
    expect(output).toContain('-->');
  });
});
