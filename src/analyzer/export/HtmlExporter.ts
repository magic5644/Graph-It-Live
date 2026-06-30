import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePath } from '../../shared/path';
import { COMMUNITY_PALETTE } from '../../shared/communityPalette';

export interface HtmlNodeData {
  id: string;
  label: string;
  hubScore?: number;
  communityId?: number;
}

export interface HtmlEdgeData {
  from: string;
  to: string;
  id: string;
}

export interface HtmlExporterConfig {
  nodes: HtmlNodeData[];
  edges: HtmlEdgeData[];
  unusedEdges: string[];
  workspaceName: string;
  outputPath: string;
}

export function htmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
}

export function hubScoreColor(score: number | undefined): { background: string; border: string } {
  if (score === undefined || score < 0.2) return { background: '#2d2d2d', border: '#555' };
  if (score < 0.5) return { background: '#1a3a5c', border: '#4a9eff' };
  if (score < 0.8) return { background: '#3a2a00', border: '#ffaa00' };
  return { background: '#3a0000', border: '#ff4444' };
}

export function nodeColor(communityId?: number, hubScore?: number): { background: string; border: string } {
  if (communityId !== undefined && communityId > 0) {
    const bg = COMMUNITY_PALETTE[(communityId - 1) % COMMUNITY_PALETTE.length];
    return { background: bg, border: '#333' };
  }
  return hubScoreColor(hubScore); // fallback: garder hubScoreColor existante
}

export function hubScoreBorderWidth(score: number | undefined): number {
  if (score === undefined || score < 0.2) return 1;
  if (score < 0.5) return 2;
  if (score < 0.8) return 3;
  return 4;
}

export function exportHtml(config: HtmlExporterConfig): void {
  // CJS context: require is available globally (nodenext module without "type":"module")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const visPath = (require as NodeRequire).resolve('vis-network/standalone/umd/vis-network.min.js');
  const visSource = fs.readFileSync(visPath, 'utf-8');
  const safeVisSource = visSource.replaceAll('</script>', '<\\/script>');

  const unusedSet = new Set(config.unusedEdges.map(id => normalizePath(id)));

  const nodesJson = JSON.stringify(config.nodes.map(n => ({
    id: normalizePath(n.id),
    label: htmlEscape(n.label),
    title: htmlEscape(normalizePath(n.id)),
    color: nodeColor(n.communityId, n.hubScore),
    borderWidth: hubScoreBorderWidth(n.hubScore),
  })));

  const edgesJson = JSON.stringify(config.edges.map(e => ({
    from: normalizePath(e.from),
    to: normalizePath(e.to),
    id: normalizePath(e.id),
    dashes: unusedSet.has(normalizePath(e.id)),
    arrows: 'to',
  })));

  const title = htmlEscape(config.workspaceName);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — Graph-It</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; font-family: sans-serif; }
    h1 { padding: 8px 16px; margin: 0; font-size: 14px; background: #252526; border-bottom: 1px solid #333; }
    #graph { width: 100vw; height: calc(100vh - 36px); }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div id="graph"></div>
  <script>${safeVisSource}</script>
  <script>
    const nodes = new vis.DataSet(${nodesJson});
    const edges = new vis.DataSet(${edgesJson});
    const container = document.getElementById('graph');
    const network = new vis.Network(container, { nodes, edges }, {
      physics: { stabilization: { iterations: 150 } },
      edges: { smooth: { type: 'cubicBezier' } },
      nodes: { shape: 'box', font: { color: '#ccc' }, color: { border: '#555' } }
    });
    network.on('click', params => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        document.querySelector('h1').textContent = nodeId;
      }
    });
  </script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(config.outputPath), { recursive: true });
  fs.writeFileSync(config.outputPath, html, 'utf-8');
}
