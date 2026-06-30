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
  buildCommunityLegend,
  exportHtml,
  type HtmlExporterConfig,
  type HtmlNodeData,
} from '../../../src/analyzer/export/HtmlExporter';
import { COMMUNITY_PALETTE } from '../../../src/shared/communityPalette';

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

describe('buildCommunityLegend', () => {
  it('returns empty string when no nodes have communityId > 0', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/a.ts', label: 'a.ts', hubScore: 0.5 },
      { id: '/src/b.ts', label: 'b.ts', communityId: 0 },
    ];
    expect(buildCommunityLegend(nodes)).toBe('');
  });

  it('returns empty string for empty nodes array', () => {
    expect(buildCommunityLegend([])).toBe('');
  });

  it('renders the "Import clusters" title when communities exist', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.8 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).toContain('Import clusters');
  });

  it('renders one cluster entry per unique communityId', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
      { id: '/src/b.ts', label: 'b.ts', communityId: 2, hubScore: 0.3 },
      { id: '/src/c.ts', label: 'c.ts', communityId: 1, hubScore: 0.2 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).toContain('Cluster 1');
    expect(html).toContain('Cluster 2');
    // Should not duplicate cluster 1
    expect(html.split('Cluster 1').length - 1).toBe(1);
  });

  it('uses directory path from any community node as label', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/workspace/src/analyzer/low.ts', label: 'low.ts', communityId: 1, hubScore: 0.1 },
      { id: '/workspace/src/analyzer/high.ts', label: 'high.ts', communityId: 1, hubScore: 0.9 },
      { id: '/workspace/src/analyzer/mid.ts', label: 'mid.ts', communityId: 1, hubScore: 0.5 },
    ];
    const html = buildCommunityLegend(nodes);
    // Label should be the common directory path, not a specific file
    expect(html).toContain('src/analyzer');
    // No individual filenames should appear as labels
    expect(html).not.toContain('low.ts');
    expect(html).not.toContain('high.ts');
    expect(html).not.toContain('mid.ts');
  });

  it('uses directory path label regardless of hubScore', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/workspace/src/webview/a.ts', label: 'a.ts', communityId: 1 },
      { id: '/workspace/src/webview/b.ts', label: 'b.ts', communityId: 1, hubScore: 0.4 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).toContain('src/webview');
  });

  it('sorts clusters by communityId ascending', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/z.ts', label: 'z.ts', communityId: 3, hubScore: 0.5 },
      { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
      { id: '/src/m.ts', label: 'm.ts', communityId: 2, hubScore: 0.5 },
    ];
    const html = buildCommunityLegend(nodes);
    const pos1 = html.indexOf('Cluster 1');
    const pos2 = html.indexOf('Cluster 2');
    const pos3 = html.indexOf('Cluster 3');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  it('uses the correct palette color for communityId', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/a.ts', label: 'a.ts', communityId: 2, hubScore: 0.5 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).toContain(COMMUNITY_PALETTE[1]); // index (2-1) % 12 = 1
  });

  it('escapes special characters in node paths (Règle 10)', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/<evil>&dir/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
    expect(html).toContain('&amp;dir');
  });

  it('is a fixed-position overlay with inline CSS only', () => {
    const nodes: HtmlNodeData[] = [
      { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
    ];
    const html = buildCommunityLegend(nodes);
    expect(html).toContain('position:fixed');
    // No external stylesheet references
    expect(html).not.toContain('href=');
    expect(html).not.toContain('url(');
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
    nodes: [
      { id: '/src/a.ts', label: 'a.ts', hubScore: 0.1 },
      { id: '/src/b.ts', label: 'b.ts', hubScore: 0.6 },
    ],
    edges: [
      { from: '/src/a.ts', to: '/src/b.ts', id: '/src/a.ts::/src/b.ts' },
      { from: '/src/b.ts', to: '/src/a.ts', id: '/src/b.ts::/src/a.ts' },
    ],
    unusedEdges: ['/src/b.ts::/src/a.ts'],
    workspaceName: 'my-project',
    outputPath: '/output/graph.html',
  };

  it('creates output directory', () => {
    exportHtml(baseConfig);
    expect(mockMkdirSync).toHaveBeenCalledWith('/output', { recursive: true });
  });

  it('writes to correct outputPath', () => {
    exportHtml(baseConfig);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/output/graph.html',
      expect.any(String),
      'utf-8',
    );
  });

  it('inlines vis-network source', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('vis-network mock');
  });

  it('marks unused edges as dashes:true', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('"dashes":true');
  });

  it('marks used edges as dashes:false', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('"dashes":false');
  });

  it('escapes workspaceName in HTML title', () => {
    const config = { ...baseConfig, workspaceName: '<My & Project>' };
    exportHtml(config);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('&lt;My &amp; Project&gt;');
    expect(html).not.toContain('<My & Project>');
  });

  it('includes node labels in output', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('a.ts');
    expect(html).toContain('b.ts');
  });

  it('uses custom outputPath', () => {
    const config = { ...baseConfig, outputPath: '/custom/output/result.html' };
    exportHtml(config);
    expect(mockMkdirSync).toHaveBeenCalledWith('/custom/output', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/custom/output/result.html',
      expect.any(String),
      'utf-8',
    );
  });

  it('produces valid HTML structure', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<div id="graph">');
    expect(html).toContain('vis.Network');
    expect(html).toContain('vis.DataSet');
  });

  it('does NOT include legend when no node has communityId > 0', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).not.toContain('Import clusters');
  });

  it('includes legend when at least one node has communityId > 0', () => {
    const config: HtmlExporterConfig = {
      ...baseConfig,
      nodes: [
        { id: '/src/a.ts', label: 'a.ts', hubScore: 0.1, communityId: 1 },
        { id: '/src/b.ts', label: 'b.ts', hubScore: 0.6, communityId: 2 },
      ],
    };
    exportHtml(config);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('Import clusters');
    expect(html).toContain('Cluster 1');
    expect(html).toContain('Cluster 2');
  });

  it('legend appears before </body>', () => {
    const config: HtmlExporterConfig = {
      ...baseConfig,
      nodes: [
        { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
      ],
    };
    exportHtml(config);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    const legendPos = html.indexOf('Import clusters');
    const bodyClosePos = html.indexOf('</body>');
    expect(legendPos).toBeGreaterThan(0);
    expect(legendPos).toBeLessThan(bodyClosePos);
  });

  it('legend uses inline CSS only (CSP safe)', () => {
    const config: HtmlExporterConfig = {
      ...baseConfig,
      nodes: [
        { id: '/src/a.ts', label: 'a.ts', communityId: 1, hubScore: 0.5 },
      ],
    };
    exportHtml(config);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    // Extract legend portion
    const legendStart = html.indexOf('<div style="position:fixed');
    const legendEnd = html.indexOf('</div>', legendStart) + 6;
    const legendHtml = html.slice(legendStart, legendEnd);
    expect(legendHtml).not.toContain('href=');
    expect(legendHtml).not.toContain('url(');
  });
});
