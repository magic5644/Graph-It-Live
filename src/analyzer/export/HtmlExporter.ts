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

export function buildCommunityLegend(nodes: HtmlNodeData[]): string {
  // Collect communities with communityId > 0
  const communityMap = new Map<number, { label: string; hubScore: number }>();
  for (const node of nodes) {
    const cid = node.communityId;
    if (cid === undefined || cid <= 0) continue;
    const hub = node.hubScore ?? 0;
    const existing = communityMap.get(cid);
    if (!existing || hub > existing.hubScore) {
      communityMap.set(cid, { label: node.label, hubScore: hub });
    }
  }
  if (communityMap.size === 0) return '';

  const sortedIds = Array.from(communityMap.keys()).sort((a, b) => a - b);

  const items = sortedIds.map(cid => {
    const color = COMMUNITY_PALETTE[(cid - 1) % COMMUNITY_PALETTE.length];
    const topLabel = htmlEscape(communityMap.get(cid)!.label);
    return `    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">` +
      `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${color};flex-shrink:0;"></span>` +
      `<span style="font-size:11px;white-space:nowrap;">Cluster ${cid} — ${topLabel}</span>` +
      `</div>`;
  }).join('\n');

  return `<div style="position:fixed;bottom:16px;left:16px;background:#252526;border:1px solid #444;border-radius:6px;padding:10px 14px;z-index:1000;max-width:220px;">` +
    `<div style="font-size:11px;font-weight:600;margin-bottom:8px;color:#aaa;text-transform:uppercase;letter-spacing:.05em;">Import clusters</div>\n` +
    items + `\n</div>`;
}

export function exportHtml(config: HtmlExporterConfig): void {
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
  const legend = buildCommunityLegend(config.nodes);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — Graph-It</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; font-family: sans-serif; overflow: hidden; }
    #titlebar { padding: 8px 16px; margin: 0; font-size: 14px; background: #252526; border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #graph { width: 100vw; height: calc(100vh - 36px); }
    #toolbar { position: fixed; top: 6px; right: 8px; z-index: 200; display: flex; gap: 4px; }
    #toolbar button { background: #3c3c3c; color: #ccc; border: 1px solid #555; border-radius: 3px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
    #toolbar button:hover { background: #505050; }
    #toolbar button.active { background: #0e639c; border-color: #1177bb; color: #fff; }
    #progress { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); background: #252526; border: 1px solid #444; border-radius: 4px; padding: 6px 16px; font-size: 12px; z-index: 200; }
  </style>
</head>
<body>
  <div id="titlebar">${title}</div>
  <div id="toolbar">
    <button onclick="network.fit()">⊞ Fit</button>
    <button id="btn-physics" class="active" onclick="togglePhysics()">⚡ Physics</button>
    <button onclick="resetLayout()">↺ Reset</button>
  </div>
  <div id="progress">Laying out graph…</div>
  <div id="graph"></div>
  <script>${safeVisSource}</script>
  <script>
    const nodesData = ${nodesJson};
    const edgesData = ${edgesJson};
    const nodes = new vis.DataSet(nodesData);
    const edges = new vis.DataSet(edgesData);
    const container = document.getElementById('graph');
    const options = {
      physics: {
        barnesHut: {
          gravitationalConstant: -8000,
          springLength: 130,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 0.9,
        },
        stabilization: { iterations: 300, updateInterval: 30 },
      },
      edges: {
        smooth: { type: 'continuous' },
        arrows: { to: { enabled: true, scaleFactor: 0.4 } },
        color: { color: '#555', opacity: 0.55 },
        width: 0.8,
      },
      nodes: {
        shape: 'box',
        font: { color: '#ccc', size: 11 },
        color: { border: '#555', highlight: { border: '#fff', background: '#3a3a3a' } },
        margin: { top: 4, bottom: 4, left: 6, right: 6 },
      },
      interaction: { dragNodes: true, zoomView: true, dragView: true, hover: true },
    };
    const network = new vis.Network(container, { nodes, edges }, options);
    let physicsOn = true;

    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
      physicsOn = false;
      document.getElementById('btn-physics').classList.remove('active');
      document.getElementById('progress').style.display = 'none';
      network.fit();
    });

    function togglePhysics() {
      physicsOn = !physicsOn;
      network.setOptions({ physics: { enabled: physicsOn } });
      const btn = document.getElementById('btn-physics');
      btn.classList.toggle('active', physicsOn);
    }

    function resetLayout() {
      network.setOptions({ physics: { enabled: true } });
      physicsOn = true;
      document.getElementById('btn-physics').classList.add('active');
      document.getElementById('progress').style.display = '';
      network.stabilize(300);
      network.once('stabilizationIterationsDone', () => {
        network.setOptions({ physics: { enabled: false } });
        physicsOn = false;
        document.getElementById('btn-physics').classList.remove('active');
        document.getElementById('progress').style.display = 'none';
        network.fit();
      });
    }

    network.on('click', params => {
      if (params.nodes.length > 0) {
        document.getElementById('titlebar').textContent = params.nodes[0];
      }
    });
  </script>
  ${legend}
</body>
</html>`;

  fs.mkdirSync(path.dirname(config.outputPath), { recursive: true });
  fs.writeFileSync(config.outputPath, html, 'utf-8');
}
