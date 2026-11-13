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
  renderHtmlPage,
  type HtmlExporterConfig,
  type HtmlOverlay,
} from '../../../src/analyzer/export/HtmlExporter';
import { aggregateCommunityGroups } from '../../../src/analyzer/community/groupAggregation';
import { COMMUNITY_PALETTE } from '../../../src/shared/communityPalette';
import type { GraphData } from '../../../src/shared/graph-types';
import { normalizePath } from '../../../src/shared/path';
import { REACT_IDENTITY, VUE_IDENTITY } from '../../../src/shared/constants';

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
  it.each([undefined, 'react'] as const)('preserves risk/community styling with framework %s', (framework) => {
    const graph = sampleGraph();
    graph.nodeMetadata!['/ws/src/core/a.ts'] = { hubScore: 0.9, communityId: 1, framework };
    const file = buildHtmlGraphModel(graph, '/ws').files[0];
    expect(file.framework).toBe(framework);
    expect(file.color).toEqual(nodeColor(1, 0.9));
    expect(file.borderWidth).toBe(4);
  });
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
    // Layout-done callbacks, run by stabilized() in registration order as vis-network does.
    const pending: (() => void)[] = [];
    const calls = { fit: [] as unknown[], selected: [] as unknown[] };
    class Network {
      getPositions(): Record<string, unknown> { return {}; }
      on(event: string, handler: (params: { nodes: string[]; edges: string[] }) => void): void { handlers[event] = handler; }
      once(_event: string, callback: () => void): void { pending.push(callback); }
      setOptions(): void {}
      stabilize(): void {}
      fit(options?: unknown): void { calls.fit.push(options); }
      selectNodes(ids: string[]): void { calls.selected.push(ids); }
    }
    const elements = new Map<string, Record<string, unknown>>();
    const element = (tag = 'div'): Record<string, unknown> => {
      const listeners: Record<string, (event?: unknown) => void> = {};
      const node: Record<string, unknown> = {
        tag, textContent: '', style: {}, children: [] as unknown[], attributes: {}, listeners,
        classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        appendChild: (child: unknown) => (node.children as unknown[]).push(child),
        append: (...children: unknown[]) => (node.children as unknown[]).push(...children.map(child => typeof child === 'string' ? { textContent: child, children: [] } : child)),
        replaceChildren: (...children: unknown[]) => { node.children = children; },
        setAttribute: (name: string, value: string) => { (node.attributes as Record<string, string>)[name] = value; },
        addEventListener: (event: string, listener: () => void) => { listeners[event] = listener; },
      };
      return node;
    };
    const document = {
      getElementById: (id: string) => elements.get(id) ?? elements.set(id, element()).get(id),
      createElement: element,
    };
    const run = new Function('vis', 'document', `${script}; return { nodes, edges, expanded, render, applyFilter, setAllExpanded,
      revealFocus: typeof revealFocus === 'function' ? revealFocus : undefined };`);
    const page = run({ DataSet, Network }, document);
    const text = (node: Record<string, unknown>): string =>
      [node.textContent, ...(node.children as Record<string, unknown>[]).map(text)].join(' ');
    const stabilized = () => pending.splice(0).forEach(callback => callback());
    const findings = () => (document.getElementById('findings-list')!.children as Record<string, unknown>[]);
    return { ...page, handlers, calls, stabilized, findings, text, panelText: () => text(document.getElementById('panel')!) };
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
    expect(html).toContain('<div id="graph" role="img"');
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

  it('exports a React icon and accessible text without losing risk or non-React identity', () => {
    const graphData = sampleGraph();
    graphData.nodeMetadata!['/ws/src/core/a.ts'].framework = 'react';
    const html = render({ ...baseConfig, graphData });
    const page = runPage(html);
    const react = page.nodes.get('/ws/src/core/a.ts');
    expect(react.label).toBe('a.ts [React]');
    expect(react.title).toContain('React');
    expect(react.image).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(REACT_IDENTITY.svg)}`);
    expect(react.borderWidth).toBe(4);
    expect(react.color).toEqual(nodeColor(1, 0.9));
    expect(page.nodes.get('/ws/src/core/b.ts').label).toBe('b.ts');
    expect(page.nodes.get('/ws/src/core/b.ts').image).toBeUndefined();
    expect(html).toContain('React component files');
    expect(html).toContain('aria-label="Dependency graph. React: src/core/a.ts"');
  });

  it('exports React and Vue files with their own icon, label and legend key in a mixed graph', () => {
    const graphData = sampleGraph();
    graphData.nodeMetadata!['/ws/src/core/a.ts'].framework = 'react';
    graphData.nodeMetadata!['/ws/src/core/b.ts'].framework = 'vue';
    const html = render({ ...baseConfig, graphData });
    const page = runPage(html);
    const vue = page.nodes.get('/ws/src/core/b.ts');
    expect(vue.label).toBe('b.ts [Vue]');
    expect(vue.image).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(VUE_IDENTITY.svg)}`);
    expect(page.nodes.get('/ws/src/core/a.ts').label).toBe('a.ts [React]');
    expect(html.indexOf('React component files')).toBeLessThan(html.indexOf('Vue component files'));
    expect(html).toContain('aria-label="Dependency graph. React: src/core/a.ts. Vue: src/core/b.ts"');
  });

  it('collapses groups into directed group edges whose counts match the aggregation', () => {
    const page = runPage(render());
    page.setAllExpanded(false);

    expect(page.nodes.get().map((n: { id: string; shape: string }) => [n.id, n.shape])).toEqual([
      ['group:1', 'ellipse'], ['group:2', 'ellipse'], ['group:0', 'ellipse'],
    ]);
    expect(page.nodes.get('group:1').label).toBe('core\n2 file(s)');
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

  describe('init page overlay (#718)', () => {
    const A = '/ws/src/core/a.ts';
    const B = '/ws/src/core/b.ts';
    const C = '/ws/src/ui/c.ts';
    const MAIN = '/ws/main.ts';
    const item = (fields: Partial<HtmlOverlay['findings'][number]['items'][number]>) =>
      ({ label: 'kind', subject: 'subject', details: [], units: [], files: [], ...fields });
    const overlay = (fields: Partial<HtmlOverlay> = {}): HtmlOverlay => ({
      edgeKinds: [[C, A, 'violation'], [B, C, 'cycle'], [MAIN, C, 'upward']],
      deadFiles: [MAIN],
      findings: [],
      ...fields,
    });
    const page = (fields: Partial<HtmlOverlay> = {}) => runPage(renderHtmlPage({ ...baseConfig, overlay: overlay(fields) }));

    it('renders exactly the export page without an overlay', () => {
      const { outputPath: _outputPath, ...config } = baseConfig;
      const html = renderHtmlPage(config);
      expect(html).toBe(render());
      for (const part of ['findings', 'overlay', 'revealFocus', 'violation']) expect(html).not.toContain(part);
    });

    it('colours violation, cycle and upward file pairs, and restores them when the panel closes', () => {
      const view = page();
      const edge = (from: string, to: string) => view.edges.get(JSON.stringify([from, to]));
      expect(edge(C, A)).toMatchObject({ base: '#ff7b72', dashes: true, title: '1 violation(s) of 1 file pair(s). Click to list them.' });
      expect(edge(B, C)).toMatchObject({ base: '#f0883e', dashes: false, title: '1 in a unit cycle of 1 file pair(s). Click to list them.' });
      expect(edge(MAIN, C)).toMatchObject({ base: '#f0883e', title: '1 upward of 1 file pair(s). Click to list them.' });
      expect(edge(A, B).base).toBeUndefined();

      // Collapsed: a violation among the pairs wins over the plain ones.
      view.setAllExpanded(false);
      expect(view.edges.get('["group:2","group:1"]')).toMatchObject({ base: '#ff7b72', dashes: true, title: '1 violation(s) of 2 file pair(s). Click to list them.' });
      view.handlers.click({ nodes: ['group:1'], edges: [] });
      expect(view.edges.get('["group:2","group:1"]').color.color).toBe('#4a9eff');
      view.handlers.click({ nodes: [], edges: [] });
      expect(view.edges.get('["group:2","group:1"]').color).toEqual({ color: '#ff7b72', opacity: 0.9 });
      expect(view.edges.get('["group:0","group:2"]').color).toEqual({ color: '#f0883e', opacity: 0.9 });
    });

    it('marks dead files and lists the overlay in the legend', () => {
      const html = renderHtmlPage({ ...baseConfig, overlay: overlay() });
      const view = runPage(html);
      expect(view.nodes.get(MAIN)).toMatchObject({ label: 'main.ts · dead', shapeProperties: { borderDashes: [4, 3] } });
      expect(view.nodes.get(MAIN).title).toContain('Dead file: no production file imports it.');
      expect(view.nodes.get(A).label).toBe('a.ts');
      expect(view.nodes.get(A).opacity).toBeUndefined();
      const legend = html.split('<div id="legend">')[1];
      expect(legend).toContain('upward or cycle edge');
      expect(legend).toContain('violation, accepted in the baseline (dashed)');
      expect(legend).toContain('dead file: no production file imports it');
      expect(html).not.toContain('revealFocus()">');
    });

    it('lists the findings in order with their text, and reveals the files or units of a clicked one', () => {
      const view = page({
        findings: [
          { title: 'Dead files', intro: 'Cheapest first.', total: 3, more: ['... 1 more (--format json lists them all)'], items: [
            item({ label: '1 file', subject: 'core', details: ['src/core/b.ts: 3 lines'], next: 'graph-it check "core" --unreferencedFiles', units: ['core'], files: [B] }),
            item({ label: 'hub-at-risk', subject: 'ui', note: 'split it', units: ['ui'] }),
          ] },
          { title: 'Other leads', total: 1, more: [], items: [item({ label: 'entry-row', subject: 'a, b' })] },
        ],
      });
      const entries = view.findings();
      expect(entries.map(entry => view.text(entry).replaceAll(/\s+/g, ' ').trim())).toEqual([
        'Dead files (3)',
        'Cheapest first.',
        '1 file : core src/core/b.ts: 3 lines next: graph-it check "core" --unreferencedFiles',
        'hub-at-risk : ui split it',
        '... 1 more (--format json lists them all)',
        'Other leads (1)',
        'entry-row : a, b',
      ]);
      const [, , file, unit, , , none] = entries as Record<string, Record<string, (event?: unknown) => void>>[];
      expect((unit.attributes as unknown as Record<string, string>).role).toBe('button');
      expect((none.attributes as unknown as Record<string, string>).role).toBeUndefined();

      view.setAllExpanded(false);
      view.stabilized();
      file.listeners.click();
      expect(view.expanded.has(1)).toBe(true);
      view.stabilized();
      expect(view.calls.selected.at(-1)).toEqual([B]);
      expect(view.calls.fit.at(-1)).toEqual({ nodes: [B], animation: true });

      // A unit-level finding centres its collapsed unit without expanding it.
      const preventDefault = vi.fn();
      unit.listeners.keydown({ key: 'Tab', preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      unit.listeners.keydown({ key: 'Enter', preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      expect(view.expanded.has(2)).toBe(false);
      view.stabilized();
      expect(view.calls.selected.at(-1)).toEqual(['group:2']);

      // Once its unit is expanded, the same finding centres on the unit's files.
      view.setAllExpanded(true);
      view.stabilized();
      unit.listeners.click();
      view.stabilized();
      expect(view.calls.selected.at(-1)).toEqual([C]);
    });

    it('says when there is no finding', () => {
      expect(page().findings().map(entry => entry.textContent)).toEqual(['No finding: nothing to clean up.']);
    });

    it('opens on the focus: its groups expanded, other files dimmed, its boundary in the panel', () => {
      const html = renderHtmlPage({ ...baseConfig, overlay: overlay({ focus: { label: 'src/core/b.ts', files: [B, '/ws/gone.ts'] } }) });
      expect(html).toContain('<button onclick="revealFocus()">◎ Focus</button>');
      const view = runPage(html);
      expect([...view.expanded]).toEqual([1]);
      expect(view.nodes.get(A).opacity).toBe(0.35);
      expect(view.nodes.get(B).opacity).toBeUndefined();
      view.stabilized();
      expect(view.calls.fit.at(-1)).toEqual({ nodes: [B] });
      const panel = view.panelText().replaceAll(/\s+/g, ' ');
      expect(panel).toContain('Focus: src/core/b.ts (1 file(s))');
      expect(panel).toContain('Depends on → (orange): 1 unit(s) ui: 1 file pair(s) (1 in a unit cycle)');
      // Sorted by file pairs, then by unit; core counts a.ts, the same unit as the focus.
      expect(panel).toContain('Used by ← (blue): 2 unit(s) core: 1 file pair(s) ui: 1 file pair(s)');
      expect(view.edges.get(JSON.stringify([B, 'group:2'])).color.color).toBe('#ffaa00');
      expect(view.edges.get(JSON.stringify([A, B])).color.color).toBe('#4a9eff');

      view.handlers.click({ nodes: [], edges: [] });
      view.revealFocus();
      view.stabilized();
      expect(view.panelText()).toContain('Focus: src/core/b.ts');
    });

    it('keeps repository text out of the markup', () => {
      const html = renderHtmlPage({ ...baseConfig, overlay: overlay({
        findings: [{ title: 'T', total: 1, more: [], items: [item({ subject: '</script><script>alert(1)</script>' })] }],
        focus: { label: '<img src=x>', files: [] },
      }) });
      expect(html).not.toContain('</script><script>alert(1)');
      expect(html).not.toContain('<img src=x>');
    });
  });
});
