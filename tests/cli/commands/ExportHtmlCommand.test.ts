import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

const mockExportHtml = vi.hoisted(() => vi.fn());
const mockArchitectureRun = vi.hoisted(() => vi.fn());
const mockComputeNodeMetadata = vi.hoisted(() => vi.fn());

vi.mock('../../../src/analyzer/export/HtmlExporter', () => ({
  exportHtml: mockExportHtml,
}));

vi.mock('../../../src/cli/commands/architecture.js', () => ({
  run: mockArchitectureRun,
}));

vi.mock('../../../src/analyzer/NodeMetadataBuilder', () => ({
  computeNodeMetadata: mockComputeNodeMetadata,
}));

import { runExportHtml } from '../../../src/cli/commands/ExportHtmlCommand';
import { normalizePath } from '../../../src/shared/path';
import type { CliRuntime } from '../../../src/cli/runtime';

const fakeRuntime = {
  workspaceRoot: '/workspace/my-project',
  loadState: () => ({ lastScanTimestamp: '2026-10-15T09:10:38.000Z' }),
} as unknown as CliRuntime;

const architectureJsonOutput = JSON.stringify({
  nodes: [
    { id: '/workspace/my-project/src/a.ts', path: '/workspace/my-project/src/a.ts' },
    { id: '/workspace/my-project/src/b.ts', path: '/workspace/my-project/src/b.ts' },
  ],
  edges: [
    { source: '/workspace/my-project/src/a.ts', target: '/workspace/my-project/src/b.ts' },
  ],
});

describe('runExportHtml', () => {
  beforeEach(() => {
    mockExportHtml.mockReset();
    mockArchitectureRun.mockReset();
    mockComputeNodeMetadata.mockReset();
    mockArchitectureRun.mockResolvedValue(architectureJsonOutput);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('uses default outputPath (cwd/graph.html) when no --output provided', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    expect(mockExportHtml).toHaveBeenCalledOnce();
    const config = mockExportHtml.mock.calls[0][0];
    expect(config.outputPath).toBe(normalizePath(path.join(process.cwd(), 'graph.html')));
  });

  it('uses --output absolute path when provided', async () => {
    await runExportHtml(fakeRuntime, 'my-project', ['--output', '/custom/output.html']);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.outputPath).toBe(normalizePath(path.resolve('/custom/output.html')));
  });

  it('uses -o short flag for output path', async () => {
    await runExportHtml(fakeRuntime, 'my-project', ['-o', '/short/flag.html']);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.outputPath).toBe(normalizePath(path.resolve('/short/flag.html')));
  });

  it('resolves relative output path to absolute', async () => {
    await runExportHtml(fakeRuntime, 'my-project', ['--output', 'relative/graph.html']);

    const config = mockExportHtml.mock.calls[0][0];
    expect(path.isAbsolute(config.outputPath)).toBe(true);
    expect(config.outputPath).toContain(normalizePath(path.join('relative', 'graph.html')));
  });

  it('passes workspaceName to exportHtml', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.workspaceName).toBe('my-project');
  });

  it('passes the scoped graph and header context to exportHtml', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodes).toEqual(['/workspace/my-project/src/a.ts', '/workspace/my-project/src/b.ts']);
    expect(config.graphData.edges).toEqual([
      { source: '/workspace/my-project/src/a.ts', target: '/workspace/my-project/src/b.ts' },
    ]);
    expect(config.context).toEqual({
      scope: 'workspace',
      revision: '2026-10-15T09:10:38.000Z',
      communityMode: 'path',
      failedFiles: 0,
    });
    expect(config.workspaceRoot).toBe('/workspace/my-project');
  });

  it('states a relative scope, the community mode and failed files', async () => {
    mockArchitectureRun.mockResolvedValue(JSON.stringify({
      ...JSON.parse(architectureJsonOutput),
      failedFiles: [{ filePath: '/workspace/my-project/src/x.ts' }],
    }));

    await runExportHtml(fakeRuntime, 'my-project', ['src', '--communities', 'louvain']);

    expect(mockExportHtml.mock.calls[0][0].context).toMatchObject({ scope: 'src', communityMode: 'louvain', failedFiles: 1 });
  });

  it('names a scope equal to the workspace root "." and tolerates a missing state', async () => {
    const runtime = { ...fakeRuntime, loadState: () => null } as unknown as CliRuntime;
    await runExportHtml(runtime, 'my-project', ['.']);

    expect(mockExportHtml.mock.calls[0][0].context).toMatchObject({ scope: '.', revision: undefined });
  });

  it('calls architecture run with json format', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    expect(mockArchitectureRun).toHaveBeenCalledWith([], fakeRuntime, 'json');
  });

  it('writes success message to stdout', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('Graph exported to')
    );
  });

  it('handles empty architecture output gracefully', async () => {
    mockArchitectureRun.mockResolvedValue(JSON.stringify({ nodes: [], edges: [] }));

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodes).toHaveLength(0);
    expect(config.graphData.edges).toHaveLength(0);
  });

  it('falls back to empty arrays when nodes/edges are not arrays', async () => {
    mockArchitectureRun.mockResolvedValue(JSON.stringify({ nodes: null, edges: 'bad' }));

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodes).toHaveLength(0);
    expect(config.graphData.edges).toHaveLength(0);
  });

  it('falls back to path when node id is absent', async () => {
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [{ path: '/workspace/my-project/src/c.ts' }],
        edges: [],
      })
    );

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodes).toEqual(['/workspace/my-project/src/c.ts']);
  });

  it('falls back to empty string when both node id and path are absent', async () => {
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [{}],
        edges: [],
      })
    );

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodes).toEqual(['']);
  });

  it('falls back to empty string when edge source or target are absent', async () => {
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [],
        edges: [{}],
      })
    );

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.edges).toEqual([{ source: '', target: '' }]);
  });

  it('calls computeNodeMetadata with graphData after parentCounts reconstruction', async () => {
    const nodeId = '/workspace/my-project/src/a.ts';
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [{ id: nodeId, path: nodeId, dependentCount: 5 }],
        edges: [],
      })
    );

    await runExportHtml(fakeRuntime, 'my-project', []);

    expect(mockComputeNodeMetadata).toHaveBeenCalledOnce();
    const graphDataArg = mockComputeNodeMetadata.mock.calls[0][0];
    expect(graphDataArg.parentCounts).toEqual({ [nodeId]: 5 });
    expect(graphDataArg.nodes).toEqual([nodeId]);
  });

  it('passes --communities to computeNodeMetadata without reading its value as the scope', async () => {
    await runExportHtml(fakeRuntime, 'my-project', ['--communities', 'louvain']);

    expect(mockComputeNodeMetadata).toHaveBeenCalledWith(expect.anything(), fakeRuntime.workspaceRoot, 'louvain');
    expect(mockExportHtml.mock.calls[0][0].graphData.nodes).toHaveLength(2);
  });

  it('uses path communities by default and rejects an unknown mode', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);
    expect(mockComputeNodeMetadata).toHaveBeenCalledWith(expect.anything(), fakeRuntime.workspaceRoot, undefined);

    await expect(runExportHtml(fakeRuntime, 'my-project', ['--communities', 'folders'])).rejects.toThrow(
      '--communities must be path or louvain, got "folders"',
    );
  });

  it('passes the nodeMetadata computed before the scope filter to exportHtml', async () => {
    const nodeId = '/workspace/my-project/src/a.ts';
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [{ id: nodeId, path: nodeId, dependentCount: 3 }],
        edges: [],
      })
    );
    // Simulate computeNodeMetadata populating communityId on graphData
    mockComputeNodeMetadata.mockImplementation(
      (graphData: { nodeMetadata?: Record<string, { hubScore: number; communityId?: number }> }) => {
        graphData.nodeMetadata = { [nodeId]: { hubScore: 0.75, communityId: 2 } };
      }
    );

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.graphData.nodeMetadata[nodeId]).toEqual({ hubScore: 0.75, communityId: 2 });
  });
});
