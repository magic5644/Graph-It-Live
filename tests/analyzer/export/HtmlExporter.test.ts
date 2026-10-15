import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.hoisted(() => vi.fn(() => '// vis-network mock'));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

import {
  htmlEscape,
  hubScoreColor,
  hubScoreBorderWidth,
  nodeColor,
  buildHtmlGraphModel,
  exportHtml,
  jsonForScript,
  type HtmlExporterConfig,
} from '../../../src/analyzer/export/HtmlExporter';
import { aggregateCommunityGroups } from '../../../src/analyzer/community/groupAggregation';
import { COMMUNITY_PALETTE } from '../../../src/shared/communityPalette';
import type { GraphData } from '../../../src/shared/graph-types';
import { normalizePath } from '../../../src/shared/path';

/** Two path groups plus one unassigned file; a cycle between core and ui. */
function sampleGraph(root = '/ws'): GraphData {
  const file = (rel: string): string => `${root}/${rel}`;
  return {
    nodes: [file('src/core/a.ts'), file('src/core/b.ts'), file('src/ui/c.ts'), file('main.ts')],
    edges: [
      { source: file('src/core/a.ts'), target: file('src/core/b.ts') },
      { source: file('src/ui/c.ts'), target: file('src/core/a.ts') },
      { source: file('src/ui/c.ts'), target: file('src/core/b.ts') },
      { source: file('src/core/b.ts'), target: file('src/ui/c.ts') },
      { source: file('main.ts'), target: file('src/ui/c.ts') },
    ],
    nodeMetadata: {
      [file('src/core/a.ts')]: { hubScore: 0.9, communityId: 1, communityKey: 'core' },
      [file('src/core/b.ts')]: { hubScore: 0.1, communityId: 1, communityKey: 'core' },
      [file('src/ui/c.ts')]: { hubScore: 0.1, communityId: 2, communityKey: 'ui' },
      [file('main.ts')]: { hubScore: 0, communityId: 0, communityKey: '' },
    },
  };
}

describe('htmlEscape', () => {
  it('escapes &', () => {
    expect(htmlEscape('a & b')).toBe('a &amp; b');
  });

  it('escapes < and >', () => {
    expect(htmlEscape('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes double quotes', () => {
    expect(htmlEscape('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it("escapes single quotes", () => {
    expect(htmlEscape("it's")).toBe('it&#39;s');
  });

  it('returns plain string unchanged', () => {
    expect(htmlEscape('hello world')).toBe('hello world');
  });
});

describe('jsonForScript', () => {
  it('neutralizes HTML script terminators in repository-derived values', () => {
    const serialized = jsonForScript({ id: '</script><script>alert(1)</script>' });

    expect(serialized).not.toContain('</script>');
    expect(serialized).toContain('\\u003C/script\\u003E');
  });
});

describe('hubScoreColor', () => {
  it('tier 0: undefined → dark grey', () => {
    const c = hubScoreColor(undefined);
    expect(c.background).toBe('#2d2d2d');
    expect(c.border).toBe('#555');
  });

  it('tier 0: score < 0.2 → dark grey', () => {
    const c = hubScoreColor(0.1);
    expect(c.background).toBe('#2d2d2d');
    expect(c.border).toBe('#555');
  });

  it('tier 1: score 0.2 → blue', () => {
    const c = hubScoreColor(0.2);
    expect(c.background).toBe('#1a3a5c');
    expect(c.border).toBe('#4a9eff');
  });

  it('tier 1: score 0.4 → blue', () => {
    const c = hubScoreColor(0.4);
    expect(c.background).toBe('#1a3a5c');
    expect(c.border).toBe('#4a9eff');
  });

  it('tier 2: score 0.5 → orange', () => {
    const c = hubScoreColor(0.5);
    expect(c.background).toBe('#3a2a00');
    expect(c.border).toBe('#ffaa00');
  });

  it('tier 2: score 0.7 → orange', () => {
    const c = hubScoreColor(0.7);
    expect(c.background).toBe('#3a2a00');
    expect(c.border).toBe('#ffaa00');
  });

  it('tier 3: score 0.8 → red', () => {
    const c = hubScoreColor(0.8);
    expect(c.background).toBe('#3a0000');
    expect(c.border).toBe('#ff4444');
  });

  it('tier 3: score 1.0 → red', () => {
    const c = hubScoreColor(1.0);
    expect(c.background).toBe('#3a0000');
    expect(c.border).toBe('#ff4444');
  });
});

describe('hubScoreBorderWidth', () => {
  it('tier 0: undefined → 1', () => {
    expect(hubScoreBorderWidth(undefined)).toBe(1);
  });

  it('tier 0: score 0.0 → 1', () => {
    expect(hubScoreBorderWidth(0.0)).toBe(1);
  });

  it('tier 0: score 0.19 → 1', () => {
    expect(hubScoreBorderWidth(0.19)).toBe(1);
  });

  it('tier 1: score 0.2 → 2', () => {
    expect(hubScoreBorderWidth(0.2)).toBe(2);
  });

  it('tier 1: score 0.49 → 2', () => {
    expect(hubScoreBorderWidth(0.49)).toBe(2);
  });

  it('tier 2: score 0.5 → 3', () => {
    expect(hubScoreBorderWidth(0.5)).toBe(3);
  });

  it('tier 2: score 0.79 → 3', () => {
    expect(hubScoreBorderWidth(0.79)).toBe(3);
  });

  it('tier 3: score 0.8 → 4', () => {
    expect(hubScoreBorderWidth(0.8)).toBe(4);
  });

  it('tier 3: score 1.0 → 4', () => {
    expect(hubScoreBorderWidth(1.0)).toBe(4);
  });
});

describe('nodeColor', () => {
  it('uses community palette when communityId > 0', () => {
    const c = nodeColor(1, 0.1);
    expect(c.background).toBe(COMMUNITY_PALETTE[0]);
    expect(c.border).toBe('#333');
  });

  it('wraps palette index modulo 12', () => {
    const c = nodeColor(13, 0.1); // (13-1) % 12 = 0
    expect(c.background).toBe(COMMUNITY_PALETTE[0]);
  });

  it('falls back to hubScoreColor when communityId is 0', () => {
    const c = nodeColor(0, 0.9);
    expect(c.background).toBe('#3a0000');
  });

  it('falls back to hubScoreColor when communityId is undefined', () => {
    const c = nodeColor(undefined, undefined);
    expect(c.background).toBe('#2d2d2d');
  });
});


describe('buildHtmlGraphModel', () => {
  it('reuses aggregateCommunityGroups labels and counts and adds the unassigned group', () => {
    const graph = sampleGraph();
    const model = buildHtmlGraphModel(graph, '/ws');
    const aggregation = aggregateCommunityGroups(graph);

    expect(model.totals).toEqual(aggregation.totals);
    expect(model.groups.map(({ id, label, fileCount, internalEdgeCount }) => ({ id, label, fileCount, internalEdgeCount }))).toEqual([
      { id: 1, label: 'core', fileCount: 2, internalEdgeCount: 1 },
      { id: 2, label: 'ui', fileCount: 1, internalEdgeCount: 0 },
      { id: 0, label: 'unassigned', fileCount: 1, internalEdgeCount: 0 },
    ]);
    expect(model.groups[0].color).toBe(COMMUNITY_PALETTE[0]);
    expect(model.edges).toHaveLength(5);
  });

  it('labels files with workspace-relative paths and keeps absolute ids', () => {
    const model = buildHtmlGraphModel(sampleGraph(), '/ws');
    const file = model.files.find(f => f.id === '/ws/src/core/a.ts');
    expect(file).toMatchObject({ label: 'src/core/a.ts', group: 1, borderWidth: 4 });
  });

  it('normalizes Windows paths for ids, groups and relative labels', () => {
    const graph = sampleGraph(String.raw`C:\repo`);
    graph.nodes = graph.nodes.map(node => node.replaceAll('/', '\\'));
    graph.edges = graph.edges.map(edge => ({ source: edge.source.replaceAll('/', '\\'), target: edge.target.replaceAll('/', '\\') }));
    graph.nodeMetadata = Object.fromEntries(
      Object.entries(graph.nodeMetadata!).map(([key, value]) => [normalizePath(key), value]),
    );

    const model = buildHtmlGraphModel(graph, String.raw`C:\repo`);

    expect(model.files.map(f => f.id)).toContain('c:/repo/src/ui/c.ts');
    expect(model.files.find(f => f.id === 'c:/repo/src/ui/c.ts')).toMatchObject({ label: 'src/ui/c.ts', group: 2 });
    expect(model.totals.files).toBe(4);
  });

  it('names a group without key by its id and keeps paths outside the root absolute', () => {
    const graph: GraphData = {
      nodes: ['/elsewhere/x.ts'],
      edges: [],
      nodeMetadata: { '/elsewhere/x.ts': { hubScore: 0, communityId: 3, communityKey: '' } },
    };
    const model = buildHtmlGraphModel(graph, '/ws');
    expect(model.groups).toMatchObject([{ id: 3, label: 'group 3' }]);
    expect(model.files[0].label).toBe('/elsewhere/x.ts');
  });

  it('returns an empty model for an empty graph', () => {
    expect(buildHtmlGraphModel({ nodes: [], edges: [] })).toMatchObject({ groups: [], files: [], edges: [] });
  });
});

describe('exportHtml', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockReadFileSync.mockReturnValue('// vis-network mock');
    const mockRequire = Object.assign(vi.fn(), {
      resolve: vi.fn().mockReturnValue('/mock/vis-network.min.js'),
    }) as unknown as NodeRequire;
    vi.stubGlobal('require', mockRequire);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseConfig: HtmlExporterConfig = {
    graphData: sampleGraph(),
    context: { scope: 'workspace', revision: '2026-10-15T09:10:38.000Z', communityMode: 'path' },
    workspaceName: 'my-project',
    outputPath: '/output/graph.html',
    workspaceRoot: '/ws',
  };

  function render(config: HtmlExporterConfig = baseConfig): string {
    exportHtml(config);
    return mockWriteFileSync.mock.calls[0][1] as string;
  }

  /** Runs the page script against minimal vis-network and DOM fakes. */
  function runPage(html: string) {
    const script = html.split('<script>')[2].split('</script>')[0];
    class DataSet {
      items = new Map<string, Record<string, unknown>>();
      clear(): void { this.items.clear(); }
      add(list: Record<string, unknown>[]): void { list.forEach(item => this.items.set(String(item.id), item)); }
      update(list: Record<string, unknown>[]): void {
        list.forEach(item => this.items.set(String(item.id), { ...this.items.get(String(item.id)), ...item }));
      }
      get(arg?: string | { filter: (item: Record<string, unknown>) => boolean }): unknown {
        if (typeof arg === 'string') return this.items.get(arg);
        const all = [...this.items.values()];
        return arg ? all.filter(arg.filter) : all;
      }
    }
    const handlers: Record<string, (params: { nodes: string[]; edges: string[] }) => void> = {};
    class Network {
      getPositions(): Record<string, unknown> { return {}; }
      on(event: string, handler: (params: { nodes: string[]; edges: string[] }) => void): void { handlers[event] = handler; }
      once(): void {}
      setOptions(): void {}
      stabilize(): void {}
      fit(): void {}
    }
    const elements = new Map<string, Record<string, unknown>>();
    const element = (tag = 'div'): Record<string, unknown> => {
      const node: Record<string, unknown> = {
        tag, textContent: '', style: {}, children: [] as unknown[],
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        appendChild: (child: unknown) => (node.children as unknown[]).push(child),
        replaceChildren: (...children: unknown[]) => { node.children = children; },
        addEventListener: (_event: string, listener: () => void) => { node.onClick = listener; },
      };
      return node;
    };
    const document = {
      getElementById: (id: string) => elements.get(id) ?? elements.set(id, element()).get(id),
      createElement: element,
    };
    const run = new Function('vis', 'document', `${script}; return { nodes, edges, expanded, render, applyFilter, setAllExpanded };`);
    const page = run({ DataSet, Network }, document);
    const text = (node: Record<string, unknown>): string =>
      [node.textContent, ...(node.children as Record<string, unknown>[]).map(text)].join(' ');
    return { ...page, handlers, panelText: () => text(document.getElementById('panel')!) };
  }

  it('creates output directory and writes to outputPath', () => {
    render();
    expect(mockMkdirSync).toHaveBeenCalledWith('/output', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith('/output/graph.html', expect.any(String), 'utf-8');
  });

  it('inlines vis-network and produces the page structure', () => {
    const html = render();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('vis-network mock');
    expect(html).toContain('<div id="graph">');
    expect(html).toContain('vis.Network');
  });

  it('states workspace, scope, revision, grouping and totals in the header', () => {
    const header = render().split('<div id="titlebar">')[1].split('</div>')[0];
    expect(header).toContain('my-project');
    expect(header).toContain('scope: workspace');
    expect(header).toContain('revision: 2026-10-15T09:10:38.000Z');
    expect(header).toContain('grouping: path');
    expect(header).toContain('5 file edges (1 intra-group, 4 inter-group), 3 groups');
    expect(header).not.toContain('failed analysis');
  });

  it('reports an unknown revision and failed files', () => {
    const header = render({ ...baseConfig, context: { scope: 'src', communityMode: 'louvain', failedFiles: 2 } });
    expect(header).toContain('revision: unknown');
    expect(header).toContain('grouping: louvain');
    expect(header).toContain('2 file(s) failed analysis');
  });

  it('builds the legend from computed group labels, not from paths', () => {
    const legend = render().split('<div id="legend">')[1];
    expect(legend).toContain('Groups (path)');
    expect(legend).toContain('core — 2 file(s), 1 internal edge(s)');
    expect(legend).toContain('unassigned — 1 file(s)');
    expect(legend).not.toContain('Cluster');
  });

  it('omits the legend for an empty graph', () => {
    const html = render({ ...baseConfig, graphData: { nodes: [], edges: [] } });
    expect(html).not.toContain('<div id="legend">');
  });

  it('escapes workspace name, context, group labels and paths', () => {
    const graphData = sampleGraph();
    graphData.nodeMetadata!['/ws/src/core/a.ts'].communityKey = '<img src=x onerror=alert(1)>';
    graphData.nodeMetadata!['/ws/src/core/b.ts'].communityKey = '<img src=x onerror=alert(1)>';
    graphData.nodes.push('/ws/</script><script>alert(1)</script>.ts');
    const html = render({
      ...baseConfig,
      graphData,
      workspaceName: '<My & Project>',
      context: { scope: '<scope>', revision: '"rev"', communityMode: '<mode>' },
    });

    expect(html).toContain('&lt;My &amp; Project&gt;');
    expect(html).toContain('scope: &lt;scope&gt;');
    expect(html).toContain('revision: &quot;rev&quot;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; — 2 file(s)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<My & Project>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain(String.raw`\u003C/script\u003E`);
  });

  it('starts expanded with file edges for small graphs', () => {
    const page = runPage(render());
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toHaveLength(4);
    expect(page.edges.get()).toHaveLength(5);
    expect(page.edges.get().every((e: { label?: string }) => e.label === undefined)).toBe(true);
  });

  it('collapses groups into directed group edges whose counts match the aggregation', () => {
    const page = runPage(render());
    page.setAllExpanded(false);

    expect(page.nodes.get().map((n: { id: string; shape: string }) => [n.id, n.shape])).toEqual([
      ['group:1', 'ellipse'], ['group:2', 'ellipse'], ['group:0', 'ellipse'],
    ]);
    const groupEdges = page.edges.get().map((e: { from: string; to: string; label: string }) => [e.from, e.to, e.label]);
    const expected = aggregateCommunityGroups(sampleGraph()).groupEdges
      .map(edge => [`group:${edge.from}`, `group:${edge.to}`, String(edge.fileEdgeCount)]);
    expect(groupEdges).toEqual(expect.arrayContaining(expected));
    expect(groupEdges).toHaveLength(expected.length);
  });

  it('lists the file pairs behind a clicked aggregated edge', () => {
    const page = runPage(render());
    page.setAllExpanded(false);
    page.handlers.click({ nodes: [], edges: ['["group:2","group:1"]'] });

    const panel = page.panelText();
    expect(panel).toContain('ui → core');
    expect(panel).toContain('2 distinct file pair(s)');
    expect(panel).toContain('src/ui/c.ts → src/core/a.ts');
    expect(panel).toContain('src/ui/c.ts → src/core/b.ts');
    expect(panel).toContain('page 1 / 1');
  });

  it('paginates evidence 50 pairs at a time', () => {
    const graphData: GraphData = { nodes: [], edges: [], nodeMetadata: {} };
    for (let i = 0; i < 60; i++) {
      const source = `/ws/a/f${i}.ts`;
      graphData.nodes.push(source);
      graphData.edges.push({ source, target: '/ws/b/t.ts' });
      graphData.nodeMetadata![source] = { hubScore: 0, communityId: 1, communityKey: 'a' };
    }
    graphData.nodeMetadata!['/ws/b/t.ts'] = { hubScore: 0, communityId: 2, communityKey: 'b' };
    const page = runPage(render({ ...baseConfig, graphData }));
    page.setAllExpanded(false);
    page.handlers.click({ nodes: [], edges: ['["group:1","group:2"]'] });
    expect(page.panelText()).toContain('page 1 / 2');
    expect(page.panelText()).toContain('a/f0.ts → b/t.ts');
    expect(page.panelText()).not.toContain('a/f50.ts → b/t.ts');
  });

  it('expands a group on double-click, collapses it from a file, and lists incoming and outgoing', () => {
    const page = runPage(render());
    page.setAllExpanded(false);
    page.handlers.doubleClick({ nodes: ['group:1'], edges: [] });
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['group:2', 'group:0', '/ws/src/core/a.ts', '/ws/src/core/b.ts']);

    page.handlers.click({ nodes: ['/ws/src/core/b.ts'], edges: [] });
    expect(page.panelText()).toContain('Outgoing → depends on (orange): 1');
    expect(page.panelText()).toContain('Incoming ← used by (blue): 2');
    expect(page.edges.get('["/ws/src/core/b.ts","group:2"]').color.color).toBe('#ffaa00');

    page.handlers.doubleClick({ nodes: ['/ws/src/core/a.ts'], edges: [] });
    expect(page.nodes.get()).toHaveLength(3);
    page.handlers.doubleClick({ nodes: [], edges: [] });
    expect(page.nodes.get()).toHaveLength(3);
  });

  it('filters by file path or group label', () => {
    const page = runPage(render());
    page.applyFilter('  CORE ');
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['/ws/src/core/a.ts', '/ws/src/core/b.ts']);

    page.applyFilter('c.ts');
    page.setAllExpanded(false);
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['group:2']);
  });

  it('starts collapsed above 200 files', () => {
    const graphData: GraphData = { nodes: [], edges: [], nodeMetadata: {} };
    for (let i = 0; i < 201; i++) graphData.nodes.push(`/ws/a/f${i}.ts`);
    const page = runPage(render({ ...baseConfig, graphData }));
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['group:0']);
  });
});
