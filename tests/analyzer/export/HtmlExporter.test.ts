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
  exportHtml,
  type HtmlExporterConfig,
} from '../../../src/analyzer/export/HtmlExporter';

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

  it('calls mkdirSync with the output directory', () => {
    exportHtml(baseConfig);
    expect(mockMkdirSync).toHaveBeenCalledWith('/output', { recursive: true });
  });

  it('calls writeFileSync with the correct outputPath', () => {
    exportHtml(baseConfig);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/output/graph.html',
      expect.any(String),
      'utf-8',
    );
  });

  it('includes vis-network source inline', () => {
    exportHtml(baseConfig);
    const html = mockWriteFileSync.mock.calls[0][1] as string;
    expect(html).toContain('// vis-network mock');
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
});
