import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphData } from '../../shared/graph-types';
import { getRelativePath, normalizePath } from '../../shared/path';
import { COMMUNITY_PALETTE } from '../../shared/communityPalette';
import { aggregateCommunityGroups } from '../community/groupAggregation';

/** What was analysed and how it was grouped, stated in the page header. */
export interface HtmlExportContext {
  scope: string;
  /** Index revision; the last scan timestamp for the CLI. */
  revision?: string;
  communityMode: string;
  failedFiles?: number;
}

export interface HtmlExporterConfig {
  /** File graph with nodeMetadata (hubScore, communityId, communityKey) from computeNodeMetadata. */
  graphData: GraphData;
  context: HtmlExportContext;
  workspaceName: string;
  outputPath: string;
  workspaceRoot?: string;
}

/** Above this many files the page opens with every group collapsed. */
const EXPANDED_FILE_LIMIT = 200;

export function htmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
}

/** Escapes JSON for safe interpolation inside an HTML script element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', String.raw`\u003C`)
    .replaceAll('>', String.raw`\u003E`)
    .replaceAll('&', String.raw`\u0026`)
    .replaceAll('\u2028', String.raw`\u2028`)
    .replaceAll('\u2029', String.raw`\u2029`);
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

interface HtmlGroup {
  id: number;
  label: string;
  fileCount: number;
  internalEdgeCount: number;
  color: string;
}

/**
 * Groups, files and distinct file pairs for the page. Groups and their counts come from
 * aggregateCommunityGroups on the whole exported graph; the page re-aggregates the same
 * pairs per visible node, so a group edge count always equals its listed evidence.
 */
export function buildHtmlGraphModel(graphData: GraphData, workspaceRoot?: string) {
  const aggregation = aggregateCommunityGroups(graphData);
  const groups: HtmlGroup[] = aggregation.groups.map(({ id, label, fileCount, internalEdgeCount }) => ({
    id, label: label || `group ${id}`, fileCount, internalEdgeCount, color: nodeColor(id).background,
  }));
  if (aggregation.unassigned.fileCount > 0) {
    groups.push({ id: 0, label: 'unassigned', ...aggregation.unassigned, color: nodeColor(0).background });
  }

  const root = workspaceRoot ? normalizePath(workspaceRoot) : undefined;
  const pairs = new Map(graphData.edges.map(edge => {
    const pair = [normalizePath(edge.source), normalizePath(edge.target)] as const;
    return [`${pair[0]}\0${pair[1]}`, pair];
  }));
  const filePaths = new Set([...graphData.nodes.map(normalizePath), ...[...pairs.values()].flat()]);
  const files = [...filePaths].map(filePath => {
    const metadata = graphData.nodeMetadata?.[filePath];
    return {
      id: filePath,
      label: root ? getRelativePath(filePath, root) : filePath,
      group: metadata?.communityId ?? 0,
      color: nodeColor(metadata?.communityId, metadata?.hubScore),
      borderWidth: hubScoreBorderWidth(metadata?.hubScore),
    };
  });
  return { groups, files, edges: [...pairs.values()], totals: aggregation.totals };
}

function buildHeader(workspaceName: string, context: HtmlExportContext, model: ReturnType<typeof buildHtmlGraphModel>): string {
  const { totals } = model;
  return [
    `<strong>${htmlEscape(workspaceName)}</strong>`,
    `scope: ${htmlEscape(context.scope)}`,
    `revision: ${htmlEscape(context.revision ?? 'unknown')}`,
    `grouping: ${htmlEscape(context.communityMode)}`,
    'imports graph (static analysis)',
    `${totals.files} files, ${totals.fileEdges} file edges (${totals.intraGroupEdges} intra-group, ${totals.interGroupEdges} inter-group), ${model.groups.length} groups`,
    context.failedFiles ? `${context.failedFiles} file(s) failed analysis` : '',
  ].filter(Boolean).join(' · ');
}

function buildLegend(groups: HtmlGroup[], communityMode: string): string {
  if (groups.length === 0) return '';
  const items = groups.toSorted((a, b) => b.fileCount - a.fileCount || a.id - b.id).map(group =>
    `<div class="legend-item"><span class="swatch" style="background:${group.color};"></span>` +
    `<span>${htmlEscape(group.label)} — ${group.fileCount} file(s), ${group.internalEdgeCount} internal edge(s)</span></div>`,
  ).join('\n');
  return `<div id="legend"><div class="legend-title">Groups (${htmlEscape(communityMode)})</div>\n${items}\n` +
    '<div class="legend-hint">Ellipse = group, box = file. Double-click a group to expand it, a file to collapse its group. ' +
    'Click an edge to list the file pairs behind its count.</div></div>';
}

export function exportHtml(config: HtmlExporterConfig): void {
  const visPath = (require as { resolve(id: string): string }).resolve('vis-network/standalone/umd/vis-network.min.js');
  const visSource = fs.readFileSync(visPath, 'utf-8');
  const safeVisSource = visSource.replaceAll('</script>', String.raw`<\/script>`);

  const model = buildHtmlGraphModel(config.graphData, config.workspaceRoot);
  const header = buildHeader(config.workspaceName, config.context, model);
  const legend = buildLegend(model.groups, config.context.communityMode);
  const title = htmlEscape(config.workspaceName);

  // Groups are collapsed by the page itself, not by vis-network clustering: a vis cluster
  // edge merges both directions, which would misreport directed file-pair counts.
  // Physics layout only: hierarchical layout would imply false layering on cyclic groups.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — Graph-It</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; font-family: sans-serif; overflow: hidden; }
    #titlebar { padding: 8px 16px; margin: 0; font-size: 13px; background: #252526; border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #graph { width: 100vw; height: calc(100vh - 36px); }
    #toolbar { position: fixed; top: 44px; right: 8px; z-index: 200; display: flex; gap: 4px; }
    #toolbar button, #toolbar input, #panel button { background: #3c3c3c; color: #ccc; border: 1px solid #555; border-radius: 3px; padding: 3px 8px; font-size: 12px; }
    #toolbar button, #panel button { cursor: pointer; }
    #toolbar button:hover, #panel button:hover { background: #505050; }
    #toolbar button.active { background: #0e639c; border-color: #1177bb; color: #fff; }
    #progress { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); background: #252526; border: 1px solid #444; border-radius: 4px; padding: 6px 16px; font-size: 12px; z-index: 200; }
    #legend { position: fixed; bottom: 16px; left: 16px; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 10px 14px; z-index: 1000; max-width: 320px; max-height: 40vh; overflow: auto; font-size: 11px; }
    .legend-title { font-weight: 600; margin-bottom: 8px; color: #aaa; text-transform: uppercase; letter-spacing: .05em; }
    .legend-item { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .legend-hint { margin-top: 8px; color: #888; }
    .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
    #panel { position: fixed; top: 80px; right: 8px; width: 380px; max-height: calc(100vh - 100px); overflow: auto; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 10px 14px; z-index: 1000; font-size: 12px; display: none; }
    #panel h3 { font-size: 13px; margin: 0 0 8px; word-break: break-all; }
    #panel h4 { font-size: 12px; margin: 10px 0 4px; color: #aaa; }
    #panel ul { margin: 0; padding-left: 18px; }
    #panel li { word-break: break-all; margin-bottom: 2px; }
  </style>
</head>
<body>
  <div id="titlebar">${header}</div>
  <div id="toolbar">
    <input id="filter" type="search" placeholder="Filter files or groups" aria-label="Filter files or groups" oninput="applyFilter(this.value)">
    <button onclick="setAllExpanded(true)">Expand all</button>
    <button onclick="setAllExpanded(false)">Collapse all</button>
    <button onclick="network.fit()">⊞ Fit</button>
    <button id="btn-physics" class="active" onclick="togglePhysics()">⚡ Physics</button>
    <button onclick="resetLayout()">↺ Reset</button>
  </div>
  <div id="progress">Laying out graph…</div>
  <div id="graph"></div>
  <div id="panel" role="dialog" aria-live="polite"></div>
  <script>${safeVisSource}</script>
  <script>
    const groupsData = ${jsonForScript(model.groups)};
    const filesData = ${jsonForScript(model.files)};
    const edgesData = ${jsonForScript(model.edges)};
    const PAGE_SIZE = 50;
    const groupById = new Map(groupsData.map(g => [g.id, g]));
    const fileById = new Map(filesData.map(f => [f.id, f]));
    const expanded = new Set(${model.files.length <= EXPANDED_FILE_LIMIT} ? groupsData.map(g => g.id) : []);
    let filterText = '';

    const nodes = new vis.DataSet([]);
    const edges = new vis.DataSet([]);
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
        font: { color: '#ccc', size: 10, strokeWidth: 0 },
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

    function groupNodeId(id) { return 'group:' + id; }
    function isGroupNode(id) { return String(id).startsWith('group:'); }
    function nodeLabel(id) { return isGroupNode(id) ? groupById.get(Number(id.slice(6))).label : fileById.get(id).label; }
    function visibleEnd(fileId) {
      const group = fileById.get(fileId).group;
      return expanded.has(group) ? fileId : groupNodeId(group);
    }
    function matches(text) { return text.toLowerCase().includes(filterText); }
    function fileMatches(f) { return !filterText || matches(f.label) || matches(groupById.get(f.group).label); }
    function groupMatches(g) { return !filterText || matches(g.label) || filesData.some(f => f.group === g.id && matches(f.label)); }

    function groupNode(g, position) {
      return {
        id: groupNodeId(g.id), shape: 'ellipse', ...position,
        label: g.label + '\\n' + g.fileCount + ' file(s)',
        title: g.label + ': ' + g.fileCount + ' file(s), ' + g.internalEdgeCount + ' internal edge(s). Double-click to expand.',
        color: { background: g.color, border: '#ddd' }, borderWidth: 2,
        font: { color: '#fff', size: 13, bold: true },
      };
    }
    function fileNode(f, position) {
      return {
        id: f.id, label: f.label.split('/').pop(), ...position,
        title: f.label + ' (group: ' + groupById.get(f.group).label + '). Double-click to collapse the group.',
        color: f.color, borderWidth: f.borderWidth,
      };
    }

    // Rebuilds the visible nodes, then aggregates every file pair onto its visible ends.
    function render() {
      const positions = network.getPositions();
      const shown = [];
      for (const g of groupsData) {
        if (!expanded.has(g.id) && groupMatches(g)) shown.push(groupNode(g, positions[groupNodeId(g.id)]));
      }
      for (const f of filesData) {
        if (expanded.has(f.group) && fileMatches(f)) shown.push(fileNode(f, positions[f.id] ?? positions[groupNodeId(f.group)]));
      }
      const shownIds = new Set(shown.map(n => n.id));
      const byKey = new Map();
      for (const [from, to] of edgesData) {
        const a = visibleEnd(from);
        const b = visibleEnd(to);
        if (a === b || !shownIds.has(a) || !shownIds.has(b)) continue;
        const key = JSON.stringify([a, b]);
        if (!byKey.has(key)) byKey.set(key, { id: key, from: a, to: b, pairs: [] });
        byKey.get(key).pairs.push([from, to]);
      }
      panel.style.display = 'none';
      nodes.clear();
      nodes.add(shown);
      edges.clear();
      edges.add([...byKey.values()].map(e => ({
        ...e,
        label: isGroupNode(e.from) || isGroupNode(e.to) ? String(e.pairs.length) : undefined,
        width: Math.min(0.8 + Math.log2(e.pairs.length), 6),
      })));
      resetLayout();
    }

    function applyFilter(value) {
      filterText = value.trim().toLowerCase();
      render();
    }

    function setAllExpanded(expand) {
      expanded.clear();
      if (expand) groupsData.forEach(g => expanded.add(g.id));
      render();
    }

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

    // Panel content is built with textContent only: labels and paths come from the repository.
    const panel = document.getElementById('panel');
    function el(tag, text) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(text, onClick) {
      const node = el('button', text);
      node.addEventListener('click', onClick);
      return node;
    }
    function showPanel(children) {
      panel.replaceChildren(button('✕ Close', hidePanel), ...children);
      panel.style.display = 'block';
    }
    function hidePanel() {
      panel.style.display = 'none';
      edges.update(edges.get().map(e => ({ id: e.id, color: { color: '#555', opacity: 0.55 } })));
    }
    function list(items) {
      const ul = el('ul');
      items.forEach(item => ul.appendChild(el('li', item)));
      return ul;
    }

    function showNode(id) {
      const incoming = edges.get({ filter: e => e.to === id });
      const outgoing = edges.get({ filter: e => e.from === id });
      edges.update(edges.get().map(e => ({
        id: e.id,
        color: { color: e.from === id ? '#ffaa00' : (e.to === id ? '#4a9eff' : '#555'), opacity: e.from === id || e.to === id ? 1 : 0.25 },
      })));
      const describe = (e, otherEnd) => nodeLabel(otherEnd) + ' (' + e.pairs.length + ' file pair(s))';
      showPanel([
        el('h3', nodeLabel(id)),
        el('h4', 'Outgoing → depends on (orange): ' + outgoing.length),
        list(outgoing.map(e => describe(e, e.to))),
        el('h4', 'Incoming ← used by (blue): ' + incoming.length),
        list(incoming.map(e => describe(e, e.from))),
      ]);
    }

    function showEvidence(edgeId, page) {
      const edge = edges.get(edgeId);
      if (!edge) return;
      const pages = Math.max(1, Math.ceil(edge.pairs.length / PAGE_SIZE));
      const start = page * PAGE_SIZE;
      const pager = el('div');
      if (page > 0) pager.appendChild(button('‹ Previous', () => showEvidence(edgeId, page - 1)));
      pager.appendChild(el('span', ' page ' + (page + 1) + ' / ' + pages + ' '));
      if (page + 1 < pages) pager.appendChild(button('Next ›', () => showEvidence(edgeId, page + 1)));
      showPanel([
        el('h3', nodeLabel(edge.from) + ' → ' + nodeLabel(edge.to)),
        el('h4', edge.pairs.length + ' distinct file pair(s) (importer → imported)'),
        list(edge.pairs.slice(start, start + PAGE_SIZE).map(([from, to]) => fileById.get(from).label + ' → ' + fileById.get(to).label)),
        pager,
      ]);
    }

    network.on('click', params => {
      if (params.nodes.length > 0) {
        showNode(params.nodes[0]);
      } else if (params.edges.length > 0) {
        showEvidence(params.edges[0], 0);
      } else {
        hidePanel();
      }
    });

    network.on('doubleClick', params => {
      const id = params.nodes[0];
      if (id === undefined) return;
      if (isGroupNode(id)) {
        expanded.add(Number(id.slice(6)));
      } else {
        expanded.delete(fileById.get(id).group);
      }
      render();
    });

    render();
  </script>
  ${legend}
</body>
</html>`;

  fs.mkdirSync(path.dirname(config.outputPath), { recursive: true });
  fs.writeFileSync(config.outputPath, html, 'utf-8');
}
