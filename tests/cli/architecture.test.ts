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

vi.mock('../../src/mcp/tools/analysis', () => ({
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
      loadState: () => null,
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

  it('assigns communities by folder by default and by imports with --communities louvain', async () => {
    const workspaceRoot = '/workspace';
    const fileA = normalizePath(path.resolve(workspaceRoot, 'src/api/a.ts'));
    const fileB = normalizePath(path.resolve(workspaceRoot, 'src/db/b.ts'));
    const runtime = { workspaceRoot, ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null };
    const runWith = async (args: string[]) => {
      mocks.collectAllSourceFiles.mockResolvedValueOnce([fileA, fileB]);
      mocks.executeAnalyzeDependencies
        .mockResolvedValueOnce({ dependencies: [{ path: fileB, type: 'import', line: 1, module: '../db/b' }] })
        .mockResolvedValueOnce({ dependencies: [] });
      const parsed = JSON.parse(await run(args, runtime as never, 'json')) as {
        nodes: Array<{ path: string; communityId: number; communityKey: string }>;
      };
      return new Map(parsed.nodes.map((node) => [node.path, node]));
    };

    const byFolder = await runWith([]);
    expect(byFolder.get(fileA)?.communityKey).toBe('api');
    expect(byFolder.get(fileB)?.communityKey).toBe('db');

    const structural = await runWith(['--communities', 'louvain']);
    expect(structural.get(fileA)).toMatchObject({ communityId: 1, communityKey: 'src/api' });
    expect(structural.get(fileB)).toMatchObject({ communityId: 1, communityKey: 'src/api' });

    await expect(run(['--communities', 'folders'], runtime as never, 'json')).rejects.toThrow(
      '--communities must be path or louvain, got "folders"',
    );
  });

  it('adds grouped sections only with --groups', async () => {
    const workspaceRoot = '/workspace';
    const fileA = normalizePath(path.resolve(workspaceRoot, 'src/api/a.ts'));
    const fileB = normalizePath(path.resolve(workspaceRoot, 'src/db/b.ts'));
    const fileC = normalizePath(path.resolve(workspaceRoot, 'src/db/c.ts'));
    const runtime = {
      workspaceRoot,
      ensureIndexed: vi.fn().mockResolvedValue(undefined),
      loadState: () => ({ workspaceRoot, lastScanTimestamp: '2026-10-15T00:00:00.000Z' }),
    };
    const dependencies = new Map([[fileA, [fileB, fileC]], [fileB, [fileC]], [fileC, []]]);
    mocks.executeAnalyzeDependencies.mockImplementation(async ({ filePath }: { filePath: string }) => ({
      dependencies: (dependencies.get(filePath) ?? []).map((dependency) => ({ path: dependency })),
    }));
    const runWith = async (args: string[], format: 'json' | 'toon' | 'mermaid' | 'markdown') => {
      mocks.collectAllSourceFiles.mockResolvedValueOnce([fileA, fileB, fileC]);
      return run(args, runtime as never, format);
    };

    const plain = JSON.parse(await runWith([], 'json')) as Record<string, unknown>;
    expect(Object.keys(plain)).not.toContain('groups');

    const grouped = JSON.parse(await runWith(['--groups', '--maxFiles', '2'], 'json')) as Record<string, unknown>;
    expect(grouped.context).toEqual({
      communityMode: 'path',
      graphKind: 'imports',
      scope: 'workspace',
      exclusions: expect.stringContaining('node_modules, .git, dist'),
      indexedAt: '2026-10-15T00:00:00.000Z',
      maxFiles: 2,
      truncated: true,
      failedFiles: 0,
    });
    expect(grouped.groups).toEqual([
      { id: 1, key: 'api', label: 'api', fileCount: 1, internalEdgeCount: 0 },
      { id: 2, key: 'db', label: 'db', fileCount: 2, internalEdgeCount: 1 },
    ]);
    expect(grouped.groupEdges).toEqual([{ from: 1, to: 2, fileEdgeCount: 2 }]);
    expect(grouped.totals).toEqual({ files: 3, fileEdges: 3, intraGroupEdges: 1, interGroupEdges: 2 });

    const mermaid = await runWith(['--groups', '--maxFiles', '2'], 'mermaid');
    expect(mermaid.split('\n').slice(0, 4)).toEqual([
      'flowchart LR',
      '%% grouped by path · imports graph · scope workspace · analysis cut at --maxFiles 2',
      '%% 3 files, 3 file edges (1 intra-group, 2 inter-group)',
      '%% view: expanded; hidden: 0 group(s), 0 group edge(s)',
    ]);
    expect(mermaid).toContain('  subgraph G2["db (2 files)"]\n    F0["src/db/b.ts"]\n    F1["src/db/c.ts"]\n  end');
    expect(mermaid).toContain('  F0 --> F1\n  G1 -->|2| G2');
    expect(await runWith(['--groups'], 'markdown')).toContain('```mermaid\nflowchart LR\n%% grouped by path');
    expect(await runWith([], 'mermaid')).toMatch(/^graph LR\n {2}N0\["src\/api\/a.ts"\]/);

    const toon = await runWith(['--groups', '--communities', 'louvain'], 'toon');
    expect(toon).toContain('context.communityMode=louvain');
    expect(toon).toContain('totals.fileEdges=3 totals.intraGroupEdges=3 totals.interGroupEdges=0');
    expect(toon).toContain('groups(id,key,label,fileCount,internalEdgeCount)\n[1,src/db,src/db,3,3]');
  });

  it('reports failed files in the grouped context and still counts them as files', async () => {
    const workspaceRoot = '/workspace';
    const fileA = normalizePath(path.resolve(workspaceRoot, 'src/api/a.ts'));
    mocks.collectAllSourceFiles.mockResolvedValueOnce([fileA]);
    mocks.executeAnalyzeDependencies.mockRejectedValueOnce(new Error('parse failed'));
    const runtime = { workspaceRoot, ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null };

    const parsed = JSON.parse(await run(['--groups'], runtime as never, 'json')) as {
      skippedFiles: number;
      context: Record<string, unknown>;
      totals: Record<string, number>;
    };

    expect(parsed.skippedFiles).toBe(1);
    expect(parsed.context).toMatchObject({ failedFiles: 1, truncated: false });
    expect(parsed.context).not.toHaveProperty('indexedAt');
    expect(parsed.context).not.toHaveProperty('maxFiles');
    expect(parsed.totals).toEqual({ files: 1, fileEdges: 0, intraGroupEdges: 0, interGroupEdges: 0 });
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
      loadState: () => null,
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
      loadState: () => null,
    };

    const output = await run([], runtime as never, 'mermaid');
    expect(output).toContain('graph LR');
    expect(output).toContain('-->');
  });
});
