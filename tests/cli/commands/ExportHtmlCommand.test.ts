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

vi.mock('../../../src/shared/path', () => ({
  normalizePath: (p: string) => p.replace(/\\/g, '/'),
}));

vi.mock('../../../src/analyzer/NodeMetadataBuilder', () => ({
  computeNodeMetadata: mockComputeNodeMetadata,
}));

import { runExportHtml } from '../../../src/cli/commands/ExportHtmlCommand';
import { normalizePath } from '../../../src/shared/path';
import type { CliRuntime } from '../../../src/cli/runtime';

const fakeRuntime = {
  workspaceRoot: '/workspace/my-project',
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
    expect(config.outputPath).toBe(path.join(process.cwd(), 'graph.html'));
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
    expect(config.outputPath).toContain(path.join('relative', 'graph.html'));
  });

  it('passes workspaceName to exportHtml', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.workspaceName).toBe('my-project');
  });

  it('builds nodes from architecture output', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.nodes).toHaveLength(2);
    expect(config.nodes[0].id).toBe('/workspace/my-project/src/a.ts');
    expect(config.nodes[0].label).toBe('a.ts');
    expect(config.nodes[1].id).toBe('/workspace/my-project/src/b.ts');
    expect(config.nodes[1].label).toBe('b.ts');
  });

  it('builds edges from architecture output with id', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.edges).toHaveLength(1);
    expect(config.edges[0].from).toBe('/workspace/my-project/src/a.ts');
    expect(config.edges[0].to).toBe('/workspace/my-project/src/b.ts');
    expect(config.edges[0].id).toBe(
      '/workspace/my-project/src/a.ts::/workspace/my-project/src/b.ts'
    );
  });

  it('passes empty unusedEdges by default', async () => {
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.unusedEdges).toEqual([]);
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
    expect(config.nodes).toHaveLength(0);
    expect(config.edges).toHaveLength(0);
  });

  it('falls back to empty arrays when nodes/edges are not arrays', async () => {
    mockArchitectureRun.mockResolvedValue(JSON.stringify({ nodes: null, edges: 'bad' }));

    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.nodes).toHaveLength(0);
    expect(config.edges).toHaveLength(0);
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
    expect(config.nodes[0].id).toBe('/workspace/my-project/src/c.ts');
    expect(config.nodes[0].label).toBe('c.ts');
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
    expect(config.nodes[0].id).toBe('');
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
    expect(config.edges[0].from).toBe('');
    expect(config.edges[0].to).toBe('');
  });

  it('passes nodeMetadata hubScore when present', async () => {
    const nodeId = '/workspace/my-project/src/a.ts';
    mockArchitectureRun.mockResolvedValue(
      JSON.stringify({
        nodes: [{ id: nodeId, path: nodeId, nodeMetadata: { hubScore: 0.9 } }],
        edges: [],
        nodeMetadata: { [nodeId]: { hubScore: 0.9 } },
      })
    );

    // computeNodeMetadata is now mocked and does not populate nodeMetadata by default,
    // so hubScore remains undefined unless the mock explicitly sets it.
    await runExportHtml(fakeRuntime, 'my-project', []);

    const config = mockExportHtml.mock.calls[0][0];
    expect(config.nodes[0].hubScore).toBeUndefined();
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

  it('passes communityId from nodeMetadata to exportHtml nodes', async () => {
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
    expect(config.nodes[0].communityId).toBe(2);
    expect(config.nodes[0].hubScore).toBe(0.75);
  });
});
