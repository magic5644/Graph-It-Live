import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.hoisted(() => vi.fn(() => '// vis-network mock'));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_file: string) => false));

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
  },
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

import {
  htmlEscape,
  inkFor,
  GROUP_FONT,
  MAX_DRAWN_GROUPS,
  MIN_LABEL_PX,
  hubScoreColor,
  hubScoreBorderWidth,
  nodeColor,
  buildHtmlGraphModel,
  compactGraphModel,
  jsonForScript,
  renderHtmlPage,
  type HtmlPageConfig,
  type HtmlOverlay,
} from '../../../src/analyzer/export/HtmlExporter';
import { aggregateCommunityGroups } from '../../../src/analyzer/community/groupAggregation';
import { COMMUNITY_PALETTE } from '../../../src/shared/communityPalette';
import type { GraphData } from '../../../src/shared/graph-types';
import { normalizePath } from '../../../src/shared/path';
import { REACT_IDENTITY, VUE_IDENTITY } from '../../../src/shared/constants';

const VIS_NEXT_TO_CODE = path.join(__dirname, '..', '..', '..', 'src', 'analyzer', 'export', 'vis-network.min.js');

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
    const file = buildHtmlGraphModel(graph, '/ws').files.find((entry) => entry.label === 'src/core/a.ts')!;
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

// #758: the page carries each path once; edges are index pairs, colours a shared style table.
describe('compactGraphModel', () => {
  it('writes a file row per file, its label after the part it shares with the previous one, shared styles, and edges as file row indexes', () => {
    const graph = sampleGraph();
    graph.nodeMetadata!['/ws/src/core/b.ts'].framework = 'react';
    const model = buildHtmlGraphModel(graph, '/ws');
    const data = compactGraphModel(model);
    // Files sorted by path, pairs by importer then imported.
    expect(data.files).toEqual([
      [0, 'main.ts', 0, 0],
      [0, 'src/core/a.ts', 1, 1],
      [9, 'b.ts', 1, 2, 'react'],
      [4, 'ui/c.ts', 2, 3],
    ]);
    expect(data.styles[1]).toEqual([COMMUNITY_PALETTE[0], '#333', 4]);
    expect(data.edges).toEqual([0, 3, 1, 2, 2, 3, 3, 1, 3, 2]);
    // Each index pair names the same files as the model's path pairs.
    const pairs = data.edges.flatMap((row, index) => (index % 2 === 0 ? [[model.files[row].id, model.files[data.edges[index + 1]].id]] : []));
    expect(pairs).toEqual(model.edges);
  });

  it('shares one style between the files drawn alike, and gives nothing for an empty graph', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => `/ws/a/f${index}.ts`);
    const nodeMetadata = Object.fromEntries(nodes.map((node) => [node, { hubScore: 0, communityId: 1, communityKey: 'a' }]));
    expect(compactGraphModel(buildHtmlGraphModel({ nodes, edges: [], nodeMetadata }, '/ws')).styles).toHaveLength(1);
    expect(compactGraphModel(buildHtmlGraphModel({ nodes: [], edges: [] }))).toEqual({ files: [], styles: [], edges: [] });
  });
});

describe('renderHtmlPage: the export page', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('// vis-network mock');
    const mockRequire = Object.assign(vi.fn(), {
      resolve: vi.fn().mockReturnValue('/mock/vis-network.min.js'),
    }) as unknown as NodeRequire;
    vi.stubGlobal('require', mockRequire);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseConfig: HtmlPageConfig = {
    graphData: sampleGraph(),
    context: { scope: 'workspace', revision: '2026-10-15T09:10:38.000Z', communityMode: 'path' },
    workspaceName: 'my-project',
    workspaceRoot: '/ws',
  };

  function render(config: HtmlPageConfig = baseConfig): string {
    return renderHtmlPage(config);
  }

  it('writes no path twice, however many edges a file has, and rebuilds every file and pair in the page (#758)', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => `/ws/src/deep/folder/name/file${index}.ts`);
    const edges = nodes.flatMap((source) => nodes.filter((target) => target !== source).map((target) => ({ source, target })));
    const html = render({ ...baseConfig, graphData: { nodes, edges, nodeMetadata: {} } });
    expect(html).not.toContain('/ws/');
    expect(html.split('src/deep/folder/name/')).toHaveLength(2);
    // 1560 edges, a few bytes each: file row indexes, not paths.
    const edgeRows = html.split('const edgeRows = ')[1].split(';\n')[0];
    expect(JSON.parse(edgeRows)).toHaveLength(edges.length * 2);
    expect(edgeRows.length).toBeLessThan(edges.length * 6);
    const view = runPage(html);
    view.setAllExpanded(true);
    expect(view.nodes.get().map((node: { id: string }) => node.id)).toEqual(nodes.map((node) => node.slice(4)).toSorted((a, b) => (a < b ? -1 : Number(a > b))));
    expect(view.edges.get()).toHaveLength(edges.length);
  });

  it('inlines the vis-network copy shipped next to the bundle when present', () => {
    mockExistsSync.mockReturnValue(true);
    render();
    expect(normalizePath(mockReadFileSync.mock.calls[0][0] as string)).toBe(normalizePath(VIS_NEXT_TO_CODE));
  });

  it('resolves vis-network from node_modules when no copy sits next to the code', () => {
    render();
    expect(normalizePath(mockExistsSync.mock.calls[0][0])).toBe(normalizePath(VIS_NEXT_TO_CODE));
    expect(normalizePath(mockReadFileSync.mock.calls[0][0] as string)).toMatch(/\/node_modules\/vis-network\/standalone\/umd\/vis-network\.min\.c?js$/);
  });

  /**
   * Runs the page script against minimal vis-network and DOM fakes. `area`: the free area the graph is fitted to;
   * the fake lays nodes out as physics does, work-free: a grid whose side grows with the node count, nodes with no
   * edge flung far out, each node as wide as its label.
   */
  function runPage(html: string, area = { width: 1e6, height: 1e6 }) {
    const script = html.split('<script>')[2].split('</script>')[0];
    class DataSet {
      items = new Map<string, Record<string, unknown>>();
      /** Bumped on every change: the fake layout is cached per version. */
      version = 0;
      getIds(): string[] { return [...this.items.keys()]; }
      clear(): void { this.items.clear(); this.version++; }
      add(list: Record<string, unknown>[]): void { list.forEach(item => this.items.set(String(item.id), item)); this.version++; }
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
    type Box = { left: number; right: number; top: number; bottom: number };
    class Network {
      moved = new Map<string, { x: number; y: number }>();
      view = { scale: 1, x: 0, y: 0 };
      constructor(_container: unknown, private readonly data: { nodes: DataSet; edges: DataSet }) {}
      getPositions(ids?: string[]): Record<string, { x: number; y: number }> {
        return Object.fromEntries((ids ?? []).map((id) => {
          const b = this.getBoundingBox(id);
          return [id, { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }];
        }));
      }
      getBoundingBox(id: string): Box {
        const node = this.data.nodes.get(id) as { label: string; font?: { size: number } };
        const size = node.font?.size ?? 11;
        const width = Math.max(...node.label.split('\n').map((line) => line.length)) * size * 0.6 + 12;
        const height = node.label.split('\n').length * size * 1.2 + 8;
        const { index: indexOf, linked, side } = this.layout();
        const index = indexOf.get(id)!;
        const at = this.moved.get(id) ?? (linked.has(id) || linked.size === 0
          ? { x: (index % side) * 220 + (Math.floor(index / side) % 2) * 90, y: Math.floor(index / side) * 50 }
          : { x: 4000 + index * 50, y: -3000 });
        return { left: at.x - width / 2, right: at.x + width / 2, top: at.y - height / 2, bottom: at.y + height / 2 };
      }
      cache?: { key: string; index: Map<string, number>; linked: Set<string>; side: number };
      layout() {
        const key = `${this.data.nodes.version}:${this.data.edges.version}`;
        if (this.cache?.key !== key) {
          const ids = this.data.nodes.getIds();
          const linked = new Set((this.data.edges.get() as { from: string; to: string }[]).flatMap((e) => [e.from, e.to]));
          this.cache = { key, index: new Map(ids.map((id, index) => [id, index])), linked, side: Math.ceil(Math.sqrt(ids.length)) };
        }
        return this.cache;
      }
      moveNode(id: string, x: number, y: number): void { this.moved.set(id, { x, y }); }
      getScale(): number { return this.view.scale; }
      moveTo(options: { scale: number; position?: { x: number; y: number } }): void {
        this.view = { ...this.view, ...options.position, scale: options.scale };
      }
      /** On screen (free-area pixels, origin top left) at the current view. */
      screenBox(id: string): Box {
        const box = this.getBoundingBox(id);
        const { scale, x, y } = this.view;
        const screen = (wx: number, wy: number) => ({ sx: (wx - x) * scale + area.width / 2, sy: (wy - y) * scale + area.height / 2 });
        const [a, b] = [screen(box.left, box.top), screen(box.right, box.bottom)];
        return { left: a.sx, top: a.sy, right: b.sx, bottom: b.sy };
      }
      on(event: string, handler: (params: { nodes: string[]; edges: string[] }) => void): void { handlers[event] = handler; }
      once(_event: string, callback: () => void): void { pending.push(callback); }
      setOptions(): void {}
      redraw(): void {}
      stopSimulation(): void {}
      stabilize(): void {}
      fit(options?: unknown): void {
        calls.fit.push(options);
        const boxes = this.data.nodes.getIds().map((id) => this.getBoundingBox(id));
        if (boxes.length === 0) return;
        const [left, right] = [Math.min(...boxes.map((b) => b.left)), Math.max(...boxes.map((b) => b.right))];
        const [top, bottom] = [Math.min(...boxes.map((b) => b.top)), Math.max(...boxes.map((b) => b.bottom))];
        this.view = { scale: Math.min(area.width / (right - left), area.height / (bottom - top)), x: (left + right) / 2, y: (top + bottom) / 2 };
      }
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
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
      };
      return node;
    };
    const documentListeners: Record<string, (event: unknown) => void> = {};
    elements.set('graph', { ...element(), clientWidth: area.width, clientHeight: area.height });
    const document = {
      getElementById: (id: string) => elements.get(id) ?? elements.set(id, element()).get(id),
      createElement: element,
      addEventListener: (event: string, listener: (event: unknown) => void) => { documentListeners[event] = listener; },
    };
    const run = new Function('vis', 'document', `${script}; return { nodes, edges, expanded, pinnedGroups, render, applyFilter, setAllExpanded,
      revealFocus: typeof revealFocus === 'function' ? revealFocus : undefined };`);
    let network: Network | undefined;
    const page = run({ DataSet, Network: class extends Network {
      constructor(container: unknown, data: { nodes: DataSet; edges: DataSet }) { super(container, data); network = this; }
    } }, document);
    const text = (node: Record<string, unknown>): string =>
      [node.textContent, ...(node.children as Record<string, unknown>[]).map(text)].join(' ');
    const stabilized = () => pending.splice(0).forEach(callback => callback());
    const findings = () => (document.getElementById('findings-list')!.children as Record<string, unknown>[]);
    const matrixListeners = () => (document.getElementById('matrix-view')!.listeners as Record<string, (event: unknown) => void>);
    return { ...page, network: network!, handlers, calls, stabilized, findings, text, matrixListeners, documentListeners, drawnCount: () => text(document.getElementById('drawn-count')!), element: (id: string) => document.getElementById(id)!, panelText: () => text(document.getElementById('panel')!) };
  }

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
    const react = page.nodes.get('src/core/a.ts');
    expect(react.label).toBe('a.ts [React]');
    expect(react.title).toContain('React');
    expect(react.image).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(REACT_IDENTITY.svg)}`);
    expect(react.borderWidth).toBe(4);
    expect(react.color).toEqual(nodeColor(1, 0.9));
    expect(page.nodes.get('src/core/b.ts').label).toBe('b.ts');
    expect(page.nodes.get('src/core/b.ts').image).toBeUndefined();
    expect(html).toContain('React component files');
    expect(html).toContain('aria-label="Dependency graph. React: src/core/a.ts"');
  });

  it('exports React and Vue files with their own icon, label and legend key in a mixed graph', () => {
    const graphData = sampleGraph();
    graphData.nodeMetadata!['/ws/src/core/a.ts'].framework = 'react';
    graphData.nodeMetadata!['/ws/src/core/b.ts'].framework = 'vue';
    const html = render({ ...baseConfig, graphData });
    const page = runPage(html);
    const vue = page.nodes.get('src/core/b.ts');
    expect(vue.label).toBe('b.ts [Vue]');
    expect(vue.image).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(VUE_IDENTITY.svg)}`);
    expect(page.nodes.get('src/core/a.ts').label).toBe('a.ts [React]');
    expect(html.indexOf('React component files')).toBeLessThan(html.indexOf('Vue component files'));
    expect(html).toContain('aria-label="Dependency graph. React: src/core/a.ts. Vue: src/core/b.ts"');
  });

  it('collapses groups into directed group edges whose counts match the aggregation', () => {
    const page = runPage(render());
    page.setAllExpanded(false);

    expect(page.nodes.get().map((n: { id: string; shape: string }) => [n.id, n.shape])).toEqual([
      ['group:1', 'box'], ['group:2', 'box'], ['group:0', 'box'],
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
    // Pairs in path order: a/f9.ts is the last one.
    expect(page.panelText()).not.toContain('a/f9.ts → b/t.ts');
  });

  it('expands a group on double-click, collapses it from a file, and lists incoming and outgoing', () => {
    const page = runPage(render());
    page.setAllExpanded(false);
    page.handlers.doubleClick({ nodes: ['group:1'], edges: [] });
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['group:2', 'group:0', 'src/core/a.ts', 'src/core/b.ts']);

    page.handlers.click({ nodes: ['src/core/b.ts'], edges: [] });
    expect(page.panelText()).toContain('Outgoing → depends on (orange): 1');
    expect(page.panelText()).toContain('Incoming ← used by (blue): 2');
    expect(page.edges.get('["src/core/b.ts","group:2"]').color.color).toBe('#ffaa00');

    page.handlers.doubleClick({ nodes: ['src/core/a.ts'], edges: [] });
    expect(page.nodes.get()).toHaveLength(3);
    page.handlers.doubleClick({ nodes: [], edges: [] });
    expect(page.nodes.get()).toHaveLength(3);
  });

  it('filters by file path or group label', () => {
    const page = runPage(render());
    page.applyFilter('  CORE ');
    expect(page.nodes.get().map((n: { id: string }) => n.id)).toEqual(['src/core/a.ts', 'src/core/b.ts']);

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

  describe('a page of 96 units (#774)', () => {
    // As a large monorepo: 96 units from 3 000 files down to 2 (12 501 files), long scoped package names
    // (one in four unnamed: its folder), each unit importing 1 to 3 larger ones, 4 units importing none.
    const UNITS = 96;
    const ISOLATED = new Set([20, 47, 71, 90]);
    const WORDS = ['orchestrator', 'document', 'accounting', 'notification', 'declaration', 'storage', 'runtime-config', 'access-rights', 'scheduler', 'importer'];
    const unitKey = (index: number) => `${['apps', 'packages', 'services'][index % 3]}/${WORDS[index % 10]}-${index}`;
    const unitName = (index: number) => (index % 4 === 3 ? unitKey(index) : `@acme-platform/${WORDS[index % 10]}-${WORDS[(index * 7) % 10]}-${index}`);
    const fileCount = (index: number) => Math.max(2, Math.round(3000 * (2 / 3000) ** Math.sqrt(index / (UNITS - 1))));
    function bigGraph(): GraphData {
      const graph: GraphData = { nodes: [], edges: [], nodeMetadata: {} };
      const file = (unit: number, index: number) => `/ws/${unitKey(unit)}/src/f${index}.ts`;
      for (let unit = 0; unit < UNITS; unit++) {
        for (let index = 0; index < fileCount(unit); index++) {
          graph.nodes.push(file(unit, index));
          graph.nodeMetadata![file(unit, index)] = { hubScore: 0, communityId: unit + 1, communityKey: unitKey(unit) };
          if (index > 0) graph.edges.push({ source: file(unit, index), target: file(unit, index - 1) });
        }
        if (unit === 0 || ISOLATED.has(unit)) continue;
        // The larger units, the first ones most: hubs.
        for (const target of new Set([0, (unit * 5) % unit, (unit * 13) % unit].slice(0, 1 + (unit % 3)))) {
          if (!ISOLATED.has(target)) graph.edges.push({ source: file(unit, 0), target: file(target, 0) });
        }
      }
      return graph;
    }
    const graphData = bigGraph();
    const groupNames = Object.fromEntries(Array.from({ length: UNITS }, (_, index) => [unitKey(index), unitName(index)]));
    const config = (): HtmlPageConfig => ({ ...baseConfig, graphData, groupNames });
    type GroupNode = { id: string; label: string; title: string; font: { color: string; size: number } };
    const groupNodes = (page: ReturnType<typeof runPage>) => (page.nodes.get() as GroupNode[]).filter((node) => node.id.startsWith('group:'));
    const unitOf = (node: GroupNode) => Number(node.id.slice(6)) - 1;

    it('is the large monorepo it stands for', () => {
      expect(graphData.nodes.length).toBeGreaterThan(12_000);
      expect([fileCount(0), fileCount(UNITS - 1)]).toEqual([3000, 2]);
    });

    it('labels every group node with its display name, its distinct end kept, whole in the tooltip with its folder', () => {
      const page = runPage(render(config()));
      page.stabilized();
      const drawn = groupNodes(page);
      expect(drawn.length).toBeGreaterThan(0);
      for (const node of drawn) {
        const unit = unitOf(node);
        const [name] = node.label.split('\n');
        expect(name.length).toBeLessThanOrEqual(20);
        const [head, tail = ''] = name.split('…');
        expect(unitName(unit).startsWith(head) && unitName(unit).endsWith(tail)).toBe(true);
        // The end tells the units apart: their number is in the label.
        expect(name.endsWith(`-${unit}`)).toBe(true);
        expect(node.title).toContain(unitName(unit) === unitKey(unit) ? `${unitKey(unit)}:` : `${unitName(unit)} (${unitKey(unit)})`);
      }
    });

    // The free areas of a 1800×1100 and a 1280×800 window.
    for (const area of [{ width: 1400, height: 977 }, { width: 880, height: 677 }]) {
      it(`opens on readable labels, every drawn node inside the ${area.width}×${area.height} free area`, () => {
        const page = runPage(render(config()), area);
        // Each layout pass ends with a fit, which may draw fewer groups and lay them out again.
        for (let pass = 0; pass < 10; pass++) page.stabilized();
        const drawn = groupNodes(page);
        expect(drawn.length).toBeGreaterThanOrEqual(8);
        expect(drawn.length).toBeLessThanOrEqual(MAX_DRAWN_GROUPS);
        // The legend says how many are drawn when it is fewer than the cap.
        expect(page.drawnCount() || String(MAX_DRAWN_GROUPS)).toBe(String(drawn.length));
        // The largest units are the ones drawn, the disconnected ones packed with them.
        expect(drawn.map(unitOf).sort((a, b) => a - b)).toEqual(Array.from({ length: drawn.length }, (_, index) => index));
        const scale = page.network.getScale();
        expect(GROUP_FONT * scale).toBeGreaterThanOrEqual(MIN_LABEL_PX);
        // No group box hides another one's label.
        const boxes = drawn.map((node) => page.network.getBoundingBox(node.id));
        for (const [i, a] of boxes.entries()) {
          for (const b of boxes.slice(i + 1)) {
            expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
          }
        }
        for (const node of drawn) {
          const box = page.network.screenBox(node.id);
          expect(box.left).toBeGreaterThanOrEqual(-0.5);
          expect(box.top).toBeGreaterThanOrEqual(-0.5);
          expect(box.right).toBeLessThanOrEqual(area.width + 0.5);
          expect(box.bottom).toBeLessThanOrEqual(area.height + 0.5);
        }
      });
    }

    it('packs the units with no drawn edge next to the others instead of far away', () => {
      const page = runPage(render(config()), { width: 1400, height: 977 });
      page.stabilized();
      const loose = groupNodes(page).filter((node) => ISOLATED.has(unitOf(node)));
      expect(loose.length).toBeGreaterThan(0);
      const linked = groupNodes(page).filter((node) => !ISOLATED.has(unitOf(node))).map((node) => page.network.getBoundingBox(node.id));
      const [left, right, top, bottom] = [Math.min(...linked.map((b) => b.left)), Math.max(...linked.map((b) => b.right)),
        Math.min(...linked.map((b) => b.top)), Math.max(...linked.map((b) => b.bottom))];
      // Within the others' extent, one row below it at most (they start 3 000 units away).
      for (const node of loose) {
        const box = page.network.getBoundingBox(node.id);
        expect(box.left).toBeGreaterThanOrEqual(left);
        expect(box.right).toBeLessThanOrEqual(right);
        expect(box.top).toBeGreaterThanOrEqual(top);
        expect(box.bottom).toBeLessThanOrEqual(bottom + 2 * (box.bottom - box.top) + 40);
      }
    });

    it('centres on readable labels when even the fewest groups cannot fit, and fits files plainly', () => {
      const page = runPage(render(config()), { width: 60, height: 40 });
      for (let pass = 0; pass < 10; pass++) page.stabilized();
      expect(groupNodes(page)).toHaveLength(8);
      expect(page.network.getScale()).toBe(MIN_LABEL_PX / GROUP_FONT);
      // A filter shows every match, never fewer: past the fit, the view centres at the readable size.
      page.applyFilter('scheduler');
      page.stabilized();
      expect(groupNodes(page).length).toBeGreaterThan(8);
      expect(page.network.getScale()).toBe(MIN_LABEL_PX / GROUP_FONT);
      // Files shown: a plain fit.
      page.applyFilter('');
      page.setAllExpanded(true);
      page.stabilized();
      expect(groupNodes(page)).toHaveLength(0);
      expect(page.network.getScale()).toBeLessThan(MIN_LABEL_PX / GROUP_FONT);
    });

    it('draws a clicked or filtered group past the cap, and lists every group in the legend', () => {
      const html = render(config());
      const page = runPage(html);
      page.stabilized();
      expect(groupNodes(page)).toHaveLength(MAX_DRAWN_GROUPS);
      expect(page.expanded.size).toBe(0);
      expect(html).toContain(`<div class="legend-hint" id="drawn-hint"><span id="drawn-count">${MAX_DRAWN_GROUPS}</span> of ${UNITS} groups drawn, the largest.`);
      for (let unit = 0; unit < UNITS; unit++) {
        expect(html).toContain(`data-group="${unit + 1}"`);
        expect(html).toContain(unitName(unit) === unitKey(unit) ? `${unitKey(unit)} — ` : `${unitName(unit)} <span class="secondary">${unitKey(unit)}</span>`);
      }
      // A legend click on an undrawn unit draws it, then selects and centres it.
      page.documentListeners.click({ target: { closest: () => ({ dataset: { group: '96' } }) } });
      expect(groupNodes(page).map((node) => node.id)).toContain('group:96');
      page.stabilized();
      expect(page.calls.selected.at(-1)).toEqual(['group:96']);
      // Enter on a focused item does the same; another key does nothing.
      const prevented = vi.fn();
      page.documentListeners.keydown({ key: 'Tab', preventDefault: prevented, target: { closest: () => ({ dataset: { group: '95' } }) } });
      expect(prevented).not.toHaveBeenCalled();
      page.documentListeners.keydown({ key: 'Enter', preventDefault: prevented, target: { closest: () => ({ dataset: { group: '95' } }) } });
      expect(prevented).toHaveBeenCalled();
      expect(groupNodes(page).map((node) => node.id)).toContain('group:95');
      // A click elsewhere draws nothing more.
      const count = groupNodes(page).length;
      page.documentListeners.click({ target: { closest: () => null } });
      expect(groupNodes(page)).toHaveLength(count);
      // The filter reaches every group, drawn or not.
      page.applyFilter('-access-rights-');
      const matching = Array.from({ length: UNITS }, (_, unit) => unit).filter((unit) => unitName(unit).includes('-access-rights-'));
      expect(matching.length).toBeGreaterThan(MAX_DRAWN_GROUPS / 10);
      expect(groupNodes(page).map(unitOf).sort((a, b) => a - b)).toEqual(matching);
    });

    it('says how many groups are drawn when fewer than the cap must go for readable labels', () => {
      // 30 groups of 10 files: under the cap, over the 200 files that open every group collapsed.
      const graph: GraphData = { nodes: [], edges: [], nodeMetadata: {} };
      for (let unit = 0; unit < 30; unit++) {
        for (let index = 0; index < 10; index++) {
          const id = `/ws/u${unit}/f${index}.ts`;
          graph.nodes.push(id);
          graph.nodeMetadata![id] = { hubScore: 0, communityId: unit + 1, communityKey: `u${unit}` };
        }
      }
      const html = render({ ...baseConfig, graphData: graph });
      // Every group drawn at first: the count is in the page, hidden.
      expect(html).toContain('<div class="legend-hint" id="drawn-hint" hidden><span id="drawn-count">30</span> of 30 groups drawn');
      const page = runPage(html, { width: 60, height: 40 });
      for (let pass = 0; pass < 10; pass++) page.stabilized();
      expect(groupNodes(page)).toHaveLength(8);
      expect(page.element('drawn-hint').hidden).toBe(false);
      expect(page.drawnCount()).toBe('8');
      // A filter draws every match: the count is hidden while it applies.
      page.applyFilter('u1');
      expect(page.element('drawn-hint').hidden).toBe(true);
    });

    it('lays a model out the same whatever the order the scan listed it in', () => {
      const shuffled: GraphData = {
        nodes: graphData.nodes.toReversed(),
        edges: graphData.edges.toReversed(),
        nodeMetadata: Object.fromEntries(Object.entries(graphData.nodeMetadata!).toReversed()),
      };
      const [html, reversed] = [render(config()), render({ ...config(), graphData: shuffled })];
      expect(reversed).toBe(html);
      const ids = (page: ReturnType<typeof runPage>) => (page.nodes.get() as { id: string }[]).map((node) => node.id);
      expect(ids(runPage(reversed))).toEqual(ids(runPage(html)));
    });

    it('shows a unit name holding HTML as text only, in the legend and the tooltips', () => {
      const evil = '<img src=x onerror=alert(1)>';
      const html = render({ ...config(), groupNames: { ...groupNames, [unitKey(0)]: evil } });
      expect(html).not.toContain(evil);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      // vis-network shows a string title with innerText, never as HTML.
      const node = (runPage(html).nodes.get() as GroupNode[]).find((entry) => entry.id === 'group:1')!;
      expect(typeof node.title).toBe('string');
      expect(node.title).toContain(evil);
    });

    it('lays the graph out right of the legend and the findings, never under them', () => {
      const html = render(config());
      expect(html).toContain('#graph { margin-left: 400px; width: calc(100vw - 400px); }');
      expect(render({ ...baseConfig, graphData: { nodes: [], edges: [] } })).not.toContain('margin-left: 400px');
    });

    it('writes each group label in a colour readable on its swatch', () => {
      expect(inkFor('#EDC948')).toBe('#1e1e1e');
      expect(inkFor('#1a3a5c')).toBe('#ffffff');
      const luminance = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      for (const background of [...COMMUNITY_PALETTE, '#2d2d2d']) {
        const [light, dark] = [luminance(background), luminance(inkFor(background))].sort((a, b) => b - a);
        // WCAG AA for large bold text (the group labels are 24px bold): 3:1.
        expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(3);
      }
      const page = runPage(render(config()));
      for (const node of groupNodes(page)) expect(['#1e1e1e', '#ffffff']).toContain(node.font.color);
    });
  });

  describe('init page overlay (#718)', () => {
    const A = '/ws/src/core/a.ts';
    const B = '/ws/src/core/b.ts';
    const C = '/ws/src/ui/c.ts';
    const MAIN = '/ws/main.ts';
    const item = (fields: Partial<HtmlOverlay['findings'][number]['items'][number]>) =>
      ({ label: 'kind', subject: 'subject', details: [], units: [], files: [], ...fields });
    const overlay = (fields: Partial<HtmlOverlay> = {}): HtmlOverlay => ({
      edgeKinds: [[C, A, 'error'], [B, C, 'cycle'], [MAIN, C, 'upward']],
      deadFiles: [MAIN],
      findings: [],
      ...fields,
    });
    // An init page has no workspaceRoot: its file ids are its labels, as the overlay names them.
    const initConfig = { ...baseConfig, workspaceRoot: undefined };
    const page = (fields: Partial<HtmlOverlay> = {}) => runPage(renderHtmlPage({ ...initConfig, overlay: overlay(fields) }));

    it('renders exactly the export page without an overlay', () => {
      const html = renderHtmlPage(baseConfig);
      for (const part of ['findings', 'overlay', 'revealFocus', 'KIND_ORDER']) expect(html).not.toContain(part);
    });

    it('colours violation, cycle and upward file pairs, and restores them when the panel closes', () => {
      const view = page();
      const edge = (from: string, to: string) => view.edges.get(JSON.stringify([from, to]));
      expect(edge(C, A)).toMatchObject({ base: '#ff7b72', dashes: false, title: 'breaks a rule: 1 of 1 file pair(s). Click to list them.' });
      expect(edge(B, C)).toMatchObject({ base: '#bc8cff', dashes: false, title: 'runtime cycle: 1 of 1 file pair(s). Click to list them.' });
      expect(edge(MAIN, C)).toMatchObject({ base: '#f0883e', title: 'upward: 1 of 1 file pair(s). Click to list them.' });
      expect(edge(A, B).base).toBeUndefined();

      // Collapsed: a violation among the pairs wins over the plain ones.
      view.setAllExpanded(false);
      expect(view.edges.get('["group:2","group:1"]')).toMatchObject({ base: '#ff7b72', dashes: false, title: 'breaks a rule: 1 of 2 file pair(s). Click to list them.' });
      view.handlers.click({ nodes: ['group:1'], edges: [] });
      expect(view.edges.get('["group:2","group:1"]').color.color).toBe('#4a9eff');
      view.handlers.click({ nodes: [], edges: [] });
      expect(view.edges.get('["group:2","group:1"]').color).toEqual({ color: '#ff7b72', opacity: 0.9 });
      expect(view.edges.get('["group:0","group:2"]').color).toEqual({ color: '#f0883e', opacity: 0.9 });
    });

    it('draws accepted, type-only and lazy pairs dashed in their shared legend style (#745)', () => {
      const view = page({ edgeKinds: [[C, A, 'accepted'], [B, C, 'type-only'], [MAIN, C, 'lazy']] });
      const edge = (from: string, to: string) => view.edges.get(JSON.stringify([from, to]));
      expect(edge(C, A)).toMatchObject({ base: '#ff7b72', dashes: [4, 3], title: 'accepted in baseline: 1 of 1 file pair(s). Click to list them.' });
      expect(edge(B, C)).toMatchObject({ base: '#bc8cff', dashes: [2, 3], title: 'type-only cycle: 1 of 1 file pair(s). Click to list them.' });
      expect(edge(MAIN, C)).toMatchObject({ base: '#bc8cff', dashes: [8, 4], title: 'lazy cycle (import()): 1 of 1 file pair(s). Click to list them.' });
      const legend = renderHtmlPage({ ...initConfig, overlay: overlay({ edgeKinds: [[B, C, 'type-only']], deadFiles: [] }) }).split('<div id="legend">')[1];
      expect(legend).toContain('stroke-dasharray="2 3"/></svg><span>type-only cycle</span>');
      expect(legend).not.toContain('runtime cycle');
      expect(legend).not.toContain('dead file');
    });

    it('shows matrix.svg and its reading guide, and lists the file pairs of a clicked cell (#745)', () => {
      const matrix = {
        svg: '<svg><g class="matrix-cell" data-from="ui" data-to="core"><rect/></g></svg>',
        guide: { reading: ['Each row imports the columns <where> it has a number.'], patterns: [{ pattern: 'wide-row', meaning: 'imports many', action: 'Put a facade.' }] },
      };
      const html = renderHtmlPage({ ...initConfig, overlay: overlay({ matrix }) });
      expect(html).toContain('<details id="matrix-view"><summary>Dependency matrix</summary>');
      expect(html).toContain(matrix.svg);
      expect(html).toContain('<li>Each row imports the columns &lt;where&gt; it has a number.</li>');
      expect(html).toContain('<li><strong>wide-row</strong>: imports many <em>Put a facade.</em></li>');
      const view = runPage(html);
      const listeners = (view as unknown as { matrixListeners: () => Record<string, (event: unknown) => void> }).matrixListeners();
      listeners.click({ target: { closest: () => ({ dataset: { from: 'ui', to: 'core' } }) } });
      view.stabilized();
      const panel = view.panelText().replaceAll(/\s+/g, ' ');
      expect(panel).toContain('ui → core: 2 file pair(s)');
      expect(panel).toContain('/ws/src/ui/c.ts → /ws/src/core/a.ts (breaks a rule)');
      // A click outside a cell does nothing.
      expect(() => listeners.click({ target: { closest: () => null } })).not.toThrow();
      expect(renderHtmlPage({ ...initConfig, overlay: overlay() })).not.toContain('<details id="matrix-view"');
    });

    it('marks dead files and lists the overlay in the legend', () => {
      const html = renderHtmlPage({ ...initConfig, overlay: overlay() });
      const view = runPage(html);
      expect(view.nodes.get(MAIN)).toMatchObject({ label: 'main.ts · dead', shapeProperties: { borderDashes: [4, 3] } });
      expect(view.nodes.get(MAIN).title).toContain('Dead file: no production file imports it.');
      expect(view.nodes.get(A).label).toBe('a.ts');
      expect(view.nodes.get(A).opacity).toBeUndefined();
      const legend = html.split('<div id="legend">')[1];
      // The legend lists the styles the overlay uses, in the order and words of the SVG legend.
      const texts = [...legend.matchAll(/<\/svg><span>([^<]+)<\/span>/g)].map((match) => match[1]);
      expect(texts).toEqual(['upward', 'runtime cycle', 'breaks a rule', 'dead file: no production file imports it']);
      expect(html).not.toContain('revealFocus()">');
    });

    it('lists the findings in order with their text, and reveals the files or units of a clicked one', () => {
      const view = page({
        findings: [
          { title: 'Dead files: 3 files in 1 unit', intro: 'Cheapest first.', more: ['... 1 more (--format json lists them all)'], items: [
            item({ label: '1 file', subject: 'core', details: ['src/core/b.ts: 3 lines'], next: 'graph-it check "core" --unreferencedFiles', units: ['core'], files: [B] }),
            item({ label: 'hub-at-risk', subject: 'ui', note: 'split it', units: ['ui'] }),
          ] },
          { title: 'Other leads: 1', more: [], items: [item({ label: 'entry-row', subject: 'a, b' })] },
        ],
      });
      const entries = view.findings();
      expect(entries.map(entry => view.text(entry).replaceAll(/\s+/g, ' ').trim())).toEqual([
        'Dead files: 3 files in 1 unit',
        'Cheapest first.',
        '1 file : core src/core/b.ts: 3 lines next: graph-it check "core" --unreferencedFiles',
        'hub-at-risk : ui split it',
        '... 1 more (--format json lists them all)',
        'Other leads: 1',
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

    it('keeps the kinds of drawn file pairs only, as file row indexes (#758)', () => {
      const html = renderHtmlPage({ ...initConfig, overlay: overlay({ edgeKinds: [[C, A, 'error'], ['/ws/gone.ts', A, 'cycle']] }) });
      expect(JSON.parse(html.split('const overlay = ')[1].split(';\n')[0]).edgeKinds).toEqual([[3, 1, 'error']]);
      expect(runPage(html).edges.get(JSON.stringify([C, A]))).toMatchObject({ base: '#ff7b72' });
    });

    it('says when there is no finding', () => {
      expect(page().findings().map(entry => entry.textContent)).toEqual(['No finding: nothing to clean up.']);
    });

    it('opens on the focus: its groups expanded, other files dimmed, its boundary in the panel', () => {
      const html = renderHtmlPage({ ...initConfig, overlay: overlay({ focus: { label: 'src/core/b.ts', files: [B, '/ws/gone.ts'] } }) });
      expect(html).toContain('<button onclick="revealFocus()">◎ Focus</button>');
      const view = runPage(html);
      expect([...view.expanded]).toEqual([1]);
      expect(view.nodes.get(A).opacity).toBe(0.35);
      expect(view.nodes.get(B).opacity).toBeUndefined();
      view.stabilized();
      expect(view.calls.fit.at(-1)).toEqual({ nodes: [B] });
      const panel = view.panelText().replaceAll(/\s+/g, ' ');
      expect(panel).toContain('Focus: src/core/b.ts (1 file(s))');
      expect(panel).toContain('Depends on → (orange): 1 unit(s) ui: 1 file pair(s) (runtime cycle: 1)');
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
      const html = renderHtmlPage({ ...initConfig, overlay: overlay({
        findings: [{ title: 'T', more: [], items: [item({ subject: '</script><script>alert(1)</script>' })] }],
        focus: { label: '<img src=x>', files: [] },
      }) });
      expect(html).not.toContain('</script><script>alert(1)');
      expect(html).not.toContain('<img src=x>');
    });
  });
});
