import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Framework, GraphData } from '../../shared/graph-types';
import { getRelativePath, normalizePath } from '../../shared/path';
import { COMMUNITY_PALETTE } from '../../shared/communityPalette';
import { FRAMEWORK_IDENTITIES } from '../../shared/constants';
import { byCodeUnit } from '../architecture/architectureUnits';
import { aggregateCommunityGroups } from '../community/groupAggregation';
import { LEGEND, legendDash, PALETTES, type LegendKind } from '../diagram/diagramStyle';

/** What was analysed and how it was grouped, stated in the page header. */
export interface HtmlExportContext {
  scope: string;
  /** Index revision; the last scan timestamp for the CLI. */
  revision?: string;
  communityMode: string;
  failedFiles?: number;
}

/** A file pair the overlay draws, in the shared legend's style (diagramStyle edgeStyle): a violation wins over a cycle or upward. */
export type HtmlEdgeKind = Exclude<LegendKind, 'down' | 'cut' | 'dead'>;

/** The overlay's kinds, strongest first: an edge of several file pairs takes the first one it holds. */
const OVERLAY_KINDS: readonly HtmlEdgeKind[] = ['error', 'accepted', 'cycle', 'lazy', 'type-only', 'upward'];

/** One finding as report.md words it, with the units and files it names. */
export interface HtmlFindingItem {
  label: string;
  subject: string;
  note?: string;
  details: string[];
  next?: string;
  /** Group labels to centre on when the item names no file. */
  units: readonly string[];
  /** File ids whose groups expand and that the page centres on. */
  files: string[];
}

export interface HtmlFindingSection {
  /** The heading as report.md words it: what it counts ("Dead files: 235 files in 22 units"). */
  title: string;
  intro?: string;
  items: HtmlFindingItem[];
  more: string[];
}

/** What the init page adds to the exported graph (#718). Files are named by their page id: their label, a workspace-relative path without workspaceRoot. */
export interface HtmlOverlay {
  /** [importer, imported, kind] file pairs. */
  edgeKinds: [string, string, HtmlEdgeKind][];
  deadFiles: string[];
  findings: HtmlFindingSection[];
  /** The page opens expanded on these files, with the units they depend on and the units using them. */
  focus?: { label: string; files: string[] };
  /** matrix.svg (renderDiagramSvg, escaped, no script) and how to read it: the Dependency matrix panel (#745). */
  matrix?: { svg: string; guide: { reading: string[]; patterns: { pattern: string; meaning: string; action: string }[] } };
}

/** The Dependency matrix panel: the SVG as matrix.svg draws it, then the reading guide; empty without a matrix. */
function matrixPanel(matrix: HtmlOverlay['matrix']): string {
  if (!matrix) return '';
  const reading = matrix.guide.reading.map(line => `<li>${htmlEscape(line)}</li>`).join('');
  const patterns = matrix.guide.patterns.map(({ pattern, meaning, action }) =>
    `<li><strong>${htmlEscape(pattern)}</strong>: ${htmlEscape(meaning)} <em>${htmlEscape(action)}</em></li>`).join('');
  return '\n  <details id="matrix-view"><summary>Dependency matrix</summary><div class="matrix-body">' +
    `<p>Click a cell to list its file pairs.</p>${matrix.svg}<h4>How to read the matrix</h4><ul>${reading}</ul><ul>${patterns}</ul></div></details>`;
}

/** The page without its output file: what renderHtmlPage needs. */
export interface HtmlPageConfig {
  graphData: GraphData;
  context: HtmlExportContext;
  workspaceName: string;
  workspaceRoot?: string;
  /** The name each group key is shown by (a unit's unitDisplayName, #774); a group without one shows its key. */
  groupNames?: Record<string, string>;
  overlay?: HtmlOverlay;
}

/** Above this many files the page opens with every group collapsed. */
const EXPANDED_FILE_LIMIT = 200;
/** Group nodes drawn at most, the largest first (#774): past it labels get too small to read, the legend lists every group and draws one on click. */
export const MAX_DRAWN_GROUPS = 40;
/** Group label size in graph units, and the smallest it may show on screen once the first view is fitted (#774). */
export const GROUP_FONT = 24;
export const MIN_LABEL_PX = 11;
/** The page never draws fewer of the largest groups to keep their labels readable. */
const MIN_DRAWN_GROUPS = 8;
/** Width of the left strip the findings and the legend take: the graph is laid out right of it, never under them. */
const SIDE_WIDTH = 400;

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
  /** The community key: what findings, matrix cells and `--focus` name a group by. */
  key: string;
  label: string;
  fileCount: number;
  internalEdgeCount: number;
  color: string;
  /** The label colour on `color`: dark on a light swatch, white on a dark one. */
  ink: string;
}

/** Dark text on a light `#rrggbb` background, white on a dark one (WCAG relative luminance, contrast ≥ 4.5 either way on the palette). */
export function inkFor(background: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(background.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#1e1e1e' : '#ffffff';
}

/**
 * Groups, files and distinct file pairs for the page. Groups and their counts come from
 * aggregateCommunityGroups on the whole exported graph; the page re-aggregates the same
 * pairs per visible node, so a group edge count always equals its listed evidence.
 */
export function buildHtmlGraphModel(graphData: GraphData, workspaceRoot?: string, groupNames: Record<string, string> = {}) {
  const aggregation = aggregateCommunityGroups(graphData);
  const group = (id: number, key: string, label: string, counts: { fileCount: number; internalEdgeCount: number }): HtmlGroup => {
    const color = nodeColor(id).background;
    return { id, key, label, ...counts, color, ink: inkFor(color) };
  };
  // Sorted by key, files and pairs by path: vis-network lays out a seeded page the same way only in the same node order.
  const groups: HtmlGroup[] = aggregation.groups.toSorted((a, b) => byCodeUnit(a.key, b.key)).map(({ id, key, label, fileCount, internalEdgeCount }) =>
    group(id, key, (Object.hasOwn(groupNames, key) ? groupNames[key] : label) || `group ${id}`, { fileCount, internalEdgeCount }));
  if (aggregation.unassigned.fileCount > 0) {
    groups.push(group(0, '', 'unassigned', aggregation.unassigned));
  }

  const root = workspaceRoot ? normalizePath(workspaceRoot) : undefined;
  const pairs = new Map(graphData.edges.map(edge => {
    const pair = [normalizePath(edge.source), normalizePath(edge.target)] as const;
    return [`${pair[0]}\0${pair[1]}`, pair];
  }));
  const filePaths = [...new Set([...graphData.nodes.map(normalizePath), ...[...pairs.values()].flat()])].sort(byCodeUnit);
  const files = filePaths.map(filePath => {
    const metadata = graphData.nodeMetadata?.[filePath];
    return {
      id: filePath,
      label: root ? getRelativePath(filePath, root) : filePath,
      group: metadata?.communityId ?? 0,
      framework: metadata?.framework,
      color: nodeColor(metadata?.communityId, metadata?.hubScore),
      borderWidth: hubScoreBorderWidth(metadata?.hubScore),
    };
  });
  const edges = [...pairs.values()].sort(([fromA, toA], [fromB, toB]) => byCodeUnit(fromA, fromB) || byCodeUnit(toA, toB));
  return { groups, files, edges, totals: aggregation.totals };
}

type HtmlGraphModel = ReturnType<typeof buildHtmlGraphModel>;

/**
 * The page's file and edge data, compact (#758): a file row is [shared, rest, group, style(, framework)],
 * its label (doubling as its page id) being the first `shared` characters of the previous label
 * followed by `rest`; a style is [background, border, borderWidth], shared by the files drawn alike;
 * edges are file row indexes, two per file pair (importer, imported), never paths.
 */
export function compactGraphModel(model: HtmlGraphModel) {
  const styles: [string, string, number][] = [];
  const styleIndex = new Map<string, number>();
  const rowOf = new Map(model.files.map((file, row) => [file.id, row]));
  let previous = '';
  const files = model.files.map(({ label, group, framework, color, borderWidth }) => {
    const key = `${color.background} ${color.border} ${borderWidth}`;
    let style = styleIndex.get(key);
    if (style === undefined) {
      style = styles.push([color.background, color.border, borderWidth]) - 1;
      styleIndex.set(key, style);
    }
    let shared = 0;
    while (shared < label.length && label[shared] === previous[shared]) shared++;
    previous = label;
    const row = [shared, label.slice(shared), group, style];
    return framework ? [...row, framework] : row;
  });
  const edges = model.edges.flatMap(([from, to]) => [rowOf.get(from)!, rowOf.get(to)!]);
  return { files, styles, edges };
}

function buildHeader(workspaceName: string, context: HtmlExportContext, model: HtmlGraphModel): string {
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

const frameworkImage = (framework: Framework) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FRAMEWORK_IDENTITIES[framework].svg)}`;

const OVERLAY = PALETTES.dark;

/** Each overlay kind's colour, vis-network dashes and text, from the shared legend. */
const overlayStyle = (kind: LegendKind) => {
  const dash = legendDash(kind);
  return { color: OVERLAY[LEGEND[kind].colour], dashes: dash === undefined ? false : dash.split(' ').map(Number), text: LEGEND[kind].text };
};

/** A legend line sample drawn as the SVG diagrams draw it. */
function legendSample(kind: LegendKind): string {
  const { color } = overlayStyle(kind);
  const dash = legendDash(kind);
  const dashAttribute = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<svg class="sample" width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="${color}" stroke-width="2"${dashAttribute}/></svg>`;
}

/** The overlay's legend: the styles its file pairs use, in the shared order, then dead files when there are any. */
function overlayLegend(overlay: HtmlOverlay): string {
  const used = new Set(overlay.edgeKinds.map(([, , kind]) => kind));
  const kinds = (Object.keys(LEGEND) as LegendKind[]).filter(kind => used.has(kind as HtmlEdgeKind) || (kind === 'dead' && overlay.deadFiles.length > 0));
  return kinds.map(kind => `<div class="legend-item">${legendSample(kind)}<span>${htmlEscape(LEGEND[kind].text)}${kind === 'dead' ? ': no production file imports it' : ''}</span></div>`).join('\n');
}

function buildLegend(groups: HtmlGroup[], communityMode: string, frameworks: ReadonlySet<Framework>, overlay?: HtmlOverlay): string {
  if (groups.length === 0) return '';
  const secondary = (group: HtmlGroup) =>
    group.key && group.key !== group.label ? ` <span class="secondary">${htmlEscape(group.key)}</span>` : '';
  const items = groups.toSorted((a, b) => b.fileCount - a.fileCount || a.id - b.id).map(group =>
    `<div class="legend-item group-item" role="button" tabindex="0" data-group="${group.id}" title="Draw and centre this group">` +
    `<span class="swatch" style="background:${group.color};"></span>` +
    `<span>${htmlEscape(group.label)}${secondary(group)}` +
    ` — ${group.fileCount} file(s), ${group.internalEdgeCount} internal edge(s)</span></div>`,
  ).join('\n');
  // Shown whenever fewer groups are drawn than exist (past the cap, or fewer for readable labels): render() keeps it live.
  const drawn = Math.min(groups.length, MAX_DRAWN_GROUPS);
  const capped = `<div class="legend-hint" id="drawn-hint"${drawn < groups.length ? '' : ' hidden'}><span id="drawn-count">${drawn}</span> of ${groups.length} groups drawn, the largest. ` +
    'Click a group here, or filter, to draw another.</div>\n';
  const framework = (Object.keys(FRAMEWORK_IDENTITIES) as Framework[]).filter(name => frameworks.has(name)).map(name =>
    `<div class="legend-item"><img alt="" width="20" height="20" src="${frameworkImage(name)}"><span>${FRAMEWORK_IDENTITIES[name].label} component files</span></div>`,
  ).join('\n');
  return `<div id="legend"><div class="legend-title">Groups (${htmlEscape(communityMode)})</div>\n${capped}${items}\n${framework}${overlay ? '\n' + overlayLegend(overlay) : ''}` +
    '<div class="legend-hint">Large bold box = group, small box = file. Double-click a group to expand it, a file to collapse its group. ' +
    'Click an edge to list the file pairs behind its count.</div></div>';
}

const OVERLAY_CSS = `
    #findings { position: fixed; top: 44px; left: 8px; width: 360px; max-height: calc(55vh - 60px); overflow: auto; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; z-index: 1000; font-size: 12px; }
    #findings summary { cursor: pointer; font-weight: 600; color: #aaa; text-transform: uppercase; letter-spacing: .05em; }
    #findings h4 { font-size: 12px; margin: 10px 0 4px; color: #ddd; }
    #findings p { margin: 4px 0; color: #999; }
    .finding { padding: 4px 6px; margin: 2px -6px; border-radius: 4px; overflow-wrap: anywhere; }
    .finding[role="button"] { cursor: pointer; }
    .finding[role="button"]:hover, .finding[role="button"]:focus-visible { background: #37373d; }
    .finding[role="button"]:focus-visible { outline: 1px solid #1177bb; }
    .finding ul { margin: 2px 0 0; padding-left: 18px; font-family: monospace; color: #aaa; }
    .finding code { color: #e6edf3; }
    #matrix-view summary { cursor: pointer; color: #ddd; margin: 6px 0; }
    #matrix-view[open] .matrix-body { position: fixed; top: 44px; left: ${SIDE_WIDTH}px; right: 8px; max-height: calc(100vh - 60px); overflow: auto; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; z-index: 999; }
    #matrix-view .matrix-cell { cursor: pointer; }
    #matrix-view li { margin-bottom: 4px; color: #bbb; }`;

/** Overlay data and the focus expansion, before the first render; edge kinds hold file row indexes, as edgeRows. */
function overlayHead(overlay: HtmlOverlay, model: HtmlGraphModel): string {
  const rowOf = new Map(model.files.map((file, row) => [file.label, row]));
  const edgeKinds = overlay.edgeKinds.flatMap(([from, to, kind]) => {
    const pair = [rowOf.get(from), rowOf.get(to)];
    return pair.includes(undefined) ? [] : [[...pair, kind]];
  });
  return String.raw`
    const overlay = ${jsonForScript({ ...overlay, edgeKinds })};
    const STYLES = ${jsonForScript(Object.fromEntries(OVERLAY_KINDS.map(kind => [kind, overlayStyle(kind)])))};
    const KIND_ORDER = ${jsonForScript(OVERLAY_KINDS)};
    const pairKind = new Map(overlay.edgeKinds.map(([from, to, kind]) => [filesData[from].id + '\0' + filesData[to].id, kind]));
    const deadFiles = new Set(overlay.deadFiles);
    const focusFiles = new Set(overlay.focus ? overlay.focus.files.filter(id => fileById.has(id)) : []);
    const groupByKey = new Map(groupsData.map(g => [g.key, g.id]));
    const groupName = key => groupByKey.has(key) ? groupById.get(groupByKey.get(key)).label : key;
    if (focusFiles.size > 0) {
      expanded.clear();
      focusFiles.forEach(id => expanded.add(fileById.get(id).group));
    }`;
}

/** Overlay functions (hoisted, so the first render uses them), the findings panel and the focus view. */
const OVERLAY_TAIL = String.raw`
    function kindText(counts) {
      return KIND_ORDER.filter(kind => counts[kind]).map(kind => STYLES[kind].text + ': ' + counts[kind]).join(', ');
    }
    function overlayFile(f, frameworkLabel) {
      return {
        ...(deadFiles.has(f.id) ? {
          label: f.label.split('/').pop() + frameworkLabel + ' · dead',
          title: f.label + frameworkLabel + ' (group: ' + groupById.get(f.group).label + '). Dead file: no production file imports it. Double-click to collapse the group.',
          borderWidth: 2, shapeProperties: { useBorderWithImage: true, borderDashes: [4, 3] },
        } : {}),
        ...(focusFiles.size > 0 && !focusFiles.has(f.id) ? { opacity: 0.35 } : {}),
      };
    }
    function overlayEdge(pairs) {
      const counts = {};
      for (const [from, to] of pairs) {
        const kind = pairKind.get(from + '\0' + to);
        if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
      }
      const kind = KIND_ORDER.find(candidate => counts[candidate]);
      if (!kind) return {};
      const base = STYLES[kind].color;
      return { base, dashes: STYLES[kind].dashes, color: { color: base, opacity: 0.9 }, title: kindText(counts) + ' of ' + pairs.length + ' file pair(s). Click to list them.' };
    }

    // Expands the groups of the files, then selects and centres the files, or the units when it names no file.
    function reveal(units, files, then) {
      const ids = files.filter(id => fileById.has(id));
      ids.forEach(id => expanded.add(fileById.get(id).group));
      // A unit already expanded has no group node: its files stand for it.
      const groups = units.map(unit => groupByKey.get(unit)).filter(g => g !== undefined);
      groups.forEach(g => pinnedGroups.add(g));
      const groupIds = ids.length > 0 ? groups.filter(g => !expanded.has(g)).map(groupNodeId)
        : groups.flatMap(g => expanded.has(g) ? filesData.filter(f => f.group === g).map(f => f.id) : [groupNodeId(g)]);
      render();
      network.once('stabilizationIterationsDone', () => {
        const shown = [...ids, ...groupIds].filter(id => nodes.get(id));
        if (shown.length > 0) {
          network.selectNodes(shown);
          network.fit({ nodes: shown, animation: true });
        }
        if (then) then();
      });
    }

    function revealFocus() { reveal([], [...focusFiles], showFocus); }
    // The focus boundary: units it depends on (orange) and units using it (blue), file pairs and overlay kinds.
    function showFocus() {
      const sides = { out: new Map(), in: new Map() };
      for (const [from, to] of edgesData) {
        const out = focusFiles.has(from);
        if (out === focusFiles.has(to)) continue;
        const unit = groupById.get(fileById.get(out ? to : from).group).label;
        const side = out ? sides.out : sides.in;
        const counts = side.get(unit) ?? { pairs: 0 };
        counts.pairs++;
        const kind = pairKind.get(from + '\0' + to);
        if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
        side.set(unit, counts);
      }
      edges.update(edges.get().map(e => {
        const out = e.pairs.some(([from, to]) => focusFiles.has(from) && !focusFiles.has(to));
        const into = e.pairs.some(([from, to]) => !focusFiles.has(from) && focusFiles.has(to));
        return { id: e.id, color: { color: out ? '#ffaa00' : (into ? '#4a9eff' : '#555'), opacity: out || into ? 1 : 0.25 } };
      }));
      const sorted = side => [...side].sort((a, b) => b[1].pairs - a[1].pairs || (a[0] < b[0] ? -1 : 1));
      const describe = ([unit, counts]) => unit + ': ' + counts.pairs + ' file pair(s)' + (kindText(counts) ? ' (' + kindText(counts) + ')' : '');
      showPanel([
        el('h3', 'Focus: ' + overlay.focus.label + ' (' + focusFiles.size + ' file(s))'),
        el('h4', 'Depends on → (orange): ' + sides.out.size + ' unit(s)'),
        list(sorted(sides.out).map(describe)),
        el('h4', 'Used by ← (blue): ' + sides.in.size + ' unit(s)'),
        list(sorted(sides.in).map(describe)),
      ]);
    }

    // The findings of report.md, same order and words; text only, as the details panel.
    function findingEntry(item) {
      const head = el('div');
      head.append(el('strong', item.label), ': ', el('code', item.subject), ...(item.note ? [' ' + item.note] : []));
      const entry = el('div');
      entry.className = 'finding';
      entry.append(head, ...(item.details.length > 0 ? [list(item.details)] : []));
      if (item.next) {
        const next = el('div', 'next: ');
        next.append(el('code', item.next));
        entry.append(next);
      }
      if (item.files.some(id => fileById.has(id)) || item.units.some(unit => groupByKey.has(unit))) {
        entry.tabIndex = 0;
        entry.setAttribute('role', 'button');
        entry.title = 'Expand its unit and centre the files it names';
        const go = () => reveal(item.units, item.files);
        entry.addEventListener('click', go);
        entry.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          go();
        });
      }
      return entry;
    }
    // A matrix cell: the file pairs from its row's unit to its column's, with their kind; their files centred.
    const unitOfFile = id => fileById.has(id) ? groupById.get(fileById.get(id).group).key : undefined;
    function showCell(from, to) {
      const pairs = edgesData.filter(([source, target]) => unitOfFile(source) === from && unitOfFile(target) === to);
      const describe = ([source, target]) => {
        const kind = pairKind.get(source + '\0' + target);
        return source + ' → ' + target + (kind ? ' (' + STYLES[kind].text + ')' : '');
      };
      reveal([from, to], pairs.flat(), () => showPanel([
        el('h3', (from === to ? groupName(from) + ', inside' : groupName(from) + ' → ' + groupName(to)) + ': ' + pairs.length + ' file pair(s)'),
        list(pairs.map(describe)),
      ]));
    }
    const matrixView = document.getElementById('matrix-view');
    if (matrixView) {
      const open = cell => {
        matrixView.open = false;
        showCell(cell.dataset.from, cell.dataset.to);
      };
      for (const cell of matrixView.querySelectorAll('.matrix-cell')) {
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('role', 'button');
        cell.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open(cell);
        });
      }
      matrixView.addEventListener('click', event => {
        const cell = event.target.closest('.matrix-cell');
        if (cell) open(cell);
      });
    }
    const findingsList = document.getElementById('findings-list');
    for (const section of overlay.findings) {
      findingsList.append(el('h4', section.title), ...(section.intro ? [el('p', section.intro)] : []),
        ...section.items.map(findingEntry), ...section.more.map(line => el('p', line)));
    }
    if (overlay.findings.length === 0) findingsList.append(el('p', 'No finding: nothing to clean up.'));
    if (focusFiles.size > 0) {
      network.once('stabilizationIterationsDone', () => {
        const ids = [...focusFiles].filter(id => nodes.get(id));
        if (ids.length > 0) network.fit({ nodes: ids });
        showFocus();
      });
    }`;

/** The self-contained page; without an overlay, exactly what `graph-it export --format html` writes. */
export function renderHtmlPage(config: HtmlPageConfig): string {
  const { overlay } = config;
  // Bundles read the copy esbuild.js puts next to them (the npm package has no vis-network); source runs resolve it.
  const bundledVis = path.join(__dirname, 'vis-network.min.js');
  const visPath = fs.existsSync(bundledVis)
    ? bundledVis
    : (require as { resolve(id: string): string }).resolve('vis-network/standalone/umd/vis-network.min.js');
  const visSource = fs.readFileSync(visPath, 'utf-8');
  const safeVisSource = visSource.replaceAll('</script>', String.raw`<\/script>`);

  const model = buildHtmlGraphModel(config.graphData, config.workspaceRoot, config.groupNames);
  const data = compactGraphModel(model);
  const header = buildHeader(config.workspaceName, config.context, model);
  const frameworkFiles = model.files.flatMap(file => file.framework ? [{ label: file.label, framework: file.framework }] : []);
  const legend = buildLegend(model.groups, config.context.communityMode, new Set(frameworkFiles.map(file => file.framework)), overlay);
  const graphLabel = htmlEscape(['Dependency graph', ...frameworkFiles.map(file => `${FRAMEWORK_IDENTITIES[file.framework].label}: ${file.label}`)].join('. '));
  const title = htmlEscape(config.workspaceName);

  // Groups are collapsed by the page itself, not by vis-network clustering: a vis cluster
  // edge merges both directions, which would misreport directed file-pair counts.
  // Physics layout only: hierarchical layout would imply false layering on cyclic groups.
  // Overlay parts are appended to existing lines only, so the page without overlay keeps its bytes.
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title} — Graph-It</title>
  <style>
    body { margin: 0; background: #1e1e1e; color: #ccc; font-family: sans-serif; overflow: hidden; }
    #titlebar { padding: 8px 16px; margin: 0; font-size: 13px; background: #252526; border-bottom: 1px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #graph { width: 100vw; height: calc(100vh - 36px); }${legend || overlay ? `\n    #graph { margin-left: ${SIDE_WIDTH}px; width: calc(100vw - ${SIDE_WIDTH}px); }` : ''}
    #toolbar { position: fixed; top: 44px; right: 8px; z-index: 200; display: flex; gap: 4px; }
    #toolbar button, #toolbar input, #panel button { background: #3c3c3c; color: #ccc; border: 1px solid #555; border-radius: 3px; padding: 3px 8px; font-size: 12px; }
    #toolbar button, #panel button { cursor: pointer; }
    #toolbar button:hover, #panel button:hover { background: #505050; }
    #toolbar button.active { background: #0e639c; border-color: #1177bb; color: #fff; }
    #progress { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); background: #252526; border: 1px solid #444; border-radius: 4px; padding: 6px 16px; font-size: 12px; z-index: 200; }
    #legend { position: fixed; bottom: 16px; left: 16px; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 10px 14px; z-index: 1000; max-width: 320px; max-height: 40vh; overflow: auto; font-size: 11px; }
    .legend-title { font-weight: 600; margin-bottom: 8px; color: #aaa; text-transform: uppercase; letter-spacing: .05em; }
    .legend-item { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .legend-hint { margin-top: 8px; color: #999; }
    .group-item { cursor: pointer; border-radius: 3px; }
    .group-item:hover, .group-item:focus-visible { background: #37373d; outline: none; }
    .secondary { color: #999; }
    .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
    .sample { flex-shrink: 0; }
    #panel { position: fixed; top: 80px; right: 8px; width: 380px; max-height: calc(100vh - 100px); overflow: auto; background: #252526; border: 1px solid #444; border-radius: 6px; padding: 10px 14px; z-index: 1000; font-size: 12px; display: none; }
    #panel h3 { font-size: 13px; margin: 0 0 8px; word-break: break-all; }
    #panel h4 { font-size: 12px; margin: 10px 0 4px; color: #aaa; }
    #panel ul { margin: 0; padding-left: 18px; }
    #panel li { word-break: break-all; margin-bottom: 2px; }${overlay ? OVERLAY_CSS : ''}
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
    <button onclick="resetLayout()">↺ Reset</button>${overlay?.focus ? '\n    <button onclick="revealFocus()">◎ Focus</button>' : ''}
  </div>
  <div id="progress">Laying out graph…</div>
  <div id="graph" role="img" aria-label="${graphLabel}"></div>
  <div id="panel" role="dialog" aria-live="polite"></div>${overlay ? '\n  <details id="findings" open><summary>Findings</summary>' + matrixPanel(overlay.matrix) + '<div id="findings-list"></div></details>' : ''}
  <script>${safeVisSource}</script>
  <script>
    const groupsData = ${jsonForScript(model.groups)};
    const fileStyles = ${jsonForScript(data.styles)};
    const fileRows = ${jsonForScript(data.files)};
    const edgeRows = ${jsonForScript(data.edges)};
    // A file's page id is its label, rebuilt from the previous one; its colours and border come from its style.
    let previousLabel = '';
    const filesData = fileRows.map(([shared, rest, group, style, framework]) => {
      const id = previousLabel = previousLabel.slice(0, shared) + rest;
      return { id, label: id, group, framework, color: { background: fileStyles[style][0], border: fileStyles[style][1] }, borderWidth: fileStyles[style][2] };
    });
    const frameworks = ${jsonForScript(Object.fromEntries((Object.keys(FRAMEWORK_IDENTITIES) as Framework[]).map(name => [name, { label: FRAMEWORK_IDENTITIES[name].label, image: frameworkImage(name) }])))};
    const edgesData = [];
    for (let i = 0; i < edgeRows.length; i += 2) edgesData.push([filesData[edgeRows[i]].id, filesData[edgeRows[i + 1]].id]);
    const PAGE_SIZE = 50;
    const groupById = new Map(groupsData.map(g => [g.id, g]));
    const fileById = new Map(filesData.map(f => [f.id, f]));
    const expanded = new Set(${model.files.length <= EXPANDED_FILE_LIMIT && model.groups.length <= MAX_DRAWN_GROUPS} ? groupsData.map(g => g.id) : []);
    // The largest groups are drawn; the legend (a list of every group) and the filter draw the others.
    // The largest groups are drawn (fewer when their labels would not stay readable); the legend and the filter pin others.
    const groupRank = new Map(groupsData.slice().sort((a, b) => b.fileCount - a.fileCount || a.id - b.id).map((g, rank) => [g.id, rank]));
    let drawLimit = ${MAX_DRAWN_GROUPS};
    const pinnedGroups = new Set();
    const isDrawn = id => groupRank.get(id) < drawLimit || pinnedGroups.has(id);${overlay ? overlayHead(overlay, model) : ''}
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
      // Seeded: a page opens on the same layout every time.
      layout: { randomSeed: 1 },
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

    // Every group node carries its name, cut to fit; the tooltip has it whole, with its key when it differs.
    // The middle goes: a scope is shared by many units, the end tells them apart.
    const shortName = name => name.length > 20 ? name.slice(0, 6) + '…' + name.slice(-13) : name;
    function groupNode(g, position) {
      return {
        id: groupNodeId(g.id), shape: 'box', ...position,
        label: shortName(g.label) + '\n' + g.fileCount + ' file(s)',
        title: g.label + (g.key && g.key !== g.label ? ' (' + g.key + ')' : '') + ': ' + g.fileCount + ' file(s), ' + g.internalEdgeCount + ' internal edge(s). Double-click to expand.',
        color: { background: g.color, border: '#ddd' }, borderWidth: 2,
        font: { color: g.ink, size: ${GROUP_FONT}, bold: true },
      };
    }
    function fileNode(f, position) {
      const framework = frameworks[f.framework];
      const frameworkLabel = framework ? ' [' + framework.label + ']' : '';
      return {
        id: f.id, label: f.label.split('/').pop() + frameworkLabel, ...position,
        title: f.label + frameworkLabel + ' (group: ' + groupById.get(f.group).label + '). Double-click to collapse the group.',
        color: f.color, borderWidth: f.borderWidth,
        ...(framework ? { shape: 'image', image: framework.image, shapeProperties: { useBorderWithImage: true } } : {}),${overlay ? ' ...overlayFile(f, frameworkLabel),' : ''}
      };
    }

    // Rebuilds the visible nodes, then aggregates every file pair onto its visible ends.
    // The legend says how many groups are drawn whenever some are not, whatever the reason.
    function updateDrawnHint() {
      const hint = document.getElementById('drawn-hint');
      if (!hint) return;
      const drawn = groupsData.filter(g => expanded.has(g.id) || isDrawn(g.id)).length;
      hint.hidden = filterText !== '' || drawn === groupsData.length;
      document.getElementById('drawn-count').textContent = String(drawn);
    }
    function render() {
      updateDrawnHint();
      const positions = network.getPositions();
      const shown = [];
      for (const g of groupsData) {
        if (!expanded.has(g.id) && groupMatches(g) && (filterText || isDrawn(g.id))) shown.push(groupNode(g, positions[groupNodeId(g.id)]));
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
        width: Math.min(0.8 + Math.log2(e.pairs.length), 6),${overlay ? ' ...overlayEdge(e.pairs),' : ''}
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
        fitView();
      });
    }

    // Two boxes overlapping by less across than down move apart sideways, else up and down, each by half.
    function pushApart(a, b, gap) {
      const across = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
      const down = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
      if (across <= 0 || down <= 0) return false;
      const axis = across < down ? 'x' : 'y';
      const shift = Math.min(across, down) / 2;
      const sign = a[axis] < b[axis] || (a[axis] === b[axis] && a.id < b.id) ? -1 : 1;
      a[axis] += sign * shift;
      b[axis] -= sign * shift;
      return true;
    }
    // Physics leaves wide group boxes on top of each other: they are pushed apart until none hides another's label.
    function separateGroups() {
      const boxes = boxesOf(nodes.getIds().filter(isGroupNode));
      for (let sweep = 0; sweep < 200; sweep++) {
        let moved = false;
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) moved = pushApart(boxes[i], boxes[j], 8) || moved;
        }
        if (!moved) break;
      }
      boxes.forEach(b => network.moveNode(b.id, b.x, b.y));
    }

    // Nodes with no drawn edge go in rows under the others: physics alone flings them to the edges, and the fit shrinks every label.
    // Node boxes centred on their current positions: vis-network's own boxes only follow a move at the next draw.
    function boxesOf(ids) {
      const at = network.getPositions(ids);
      return ids.map(id => {
        const b = network.getBoundingBox(id);
        return { id, x: at[id].x, y: at[id].y, w: b.right - b.left, h: b.bottom - b.top };
      });
    }
    function rangeOf(boxes) {
      return {
        left: Math.min(...boxes.map(b => b.x - b.w / 2)), right: Math.max(...boxes.map(b => b.x + b.w / 2)),
        top: Math.min(...boxes.map(b => b.y - b.h / 2)), bottom: Math.max(...boxes.map(b => b.y + b.h / 2)),
      };
    }
    function packLoose() {
      const linked = new Set(edges.get().flatMap(e => [e.from, e.to]));
      const ids = nodes.getIds();
      const loose = boxesOf(ids.filter(id => !linked.has(id)));
      const boxes = boxesOf(ids.filter(id => linked.has(id)));
      if (loose.length === 0 || boxes.length === 0) return;
      const gap = 20;
      const { left, right, bottom } = rangeOf(boxes);
      let x = left;
      let y = bottom + gap;
      let rowHeight = 0;
      for (const box of loose) {
        if (x > left && x + box.w > right) {
          x = left;
          y += rowHeight + gap;
          rowHeight = 0;
        }
        network.moveNode(box.id, x + box.w / 2, y + box.h / 2);
        x += box.w + gap;
        rowHeight = Math.max(rowHeight, box.h);
      }
    }
    // network.fit() on the boxes as they now stand, below the toolbar, with a 5 % margin.
    function fitAll() {
      const ids = nodes.getIds();
      if (ids.length === 0) return;
      const { left, right, top, bottom } = rangeOf(boxesOf(ids));
      const toolbar = Math.max(0, document.getElementById('toolbar').getBoundingClientRect().bottom - container.getBoundingClientRect().top);
      const scale = 0.95 * Math.min(container.clientWidth / (right - left), (container.clientHeight - toolbar) / (bottom - top));
      network.moveTo({ position: { x: (left + right) / 2, y: (top + bottom) / 2 - toolbar / 2 / scale }, scale });
    }
    // Every node fitted to the free area with group labels of ${MIN_LABEL_PX}px at least: on the collapsed view, fewer of the
    // largest groups are drawn until they fit (the scale grows about as 1 / sqrt(groups)); else the view centres at that size.
    function fitView() {
      // No simulation may move a node after the layout below; then size the boxes of nodes added since the last
      // draw (stabilizing draws nothing): getBoundingBox reads them.
      network.stopSimulation();
      network.redraw();
      layoutView();
      // Paints the moves and the view now: a requested redraw may never come once physics is off.
      network.redraw();
    }
    function layoutView() {
      packLoose();
      separateGroups();
      fitAll();
      const minScale = ${MIN_LABEL_PX / GROUP_FONT};
      const scale = network.getScale();
      const groups = nodes.getIds().filter(isGroupNode).length;
      if (groups === 0 || expanded.size > 0 || scale >= minScale) return;
      if (!filterText && drawLimit > ${MIN_DRAWN_GROUPS}) {
        // At most a quarter fewer per pass: a smaller set lays out tighter, the estimate alone overshoots.
        const estimate = Math.max(Math.floor(groups * (scale / minScale) ** 2), Math.ceil(groups * 0.75));
        drawLimit = Math.max(${MIN_DRAWN_GROUPS}, Math.min(drawLimit - 1, estimate));
        render();
        return;
      }
      network.moveTo({ scale: minScale });
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
      edges.update(edges.get().map(e => ({ id: e.id, color: { color: ${overlay ? 'e.base ?? ' : ''}'#555', opacity: ${overlay ? 'e.base ? 0.9 : ' : ''}0.55 } })));
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
        color: { color: e.from === id ? '#ffaa00' : (e.to === id ? '#4a9eff' : ${overlay ? 'e.base ?? ' : ''}'#555'), opacity: e.from === id || e.to === id ? 1 : 0.25 },
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

    // A legend group: drawn (past the cap), then selected and centred.
    function showGroup(id) {
      pinnedGroups.add(id);
      render();
      network.once('stabilizationIterationsDone', () => {
        const ids = (expanded.has(id) ? filesData.filter(f => f.group === id).map(f => f.id) : [groupNodeId(id)]).filter(n => nodes.get(n));
        if (ids.length === 0) return;
        network.selectNodes(ids);
        network.fit({ nodes: ids, animation: true });
      });
    }
    const groupItem = event => event.target.closest && event.target.closest('[data-group]');
    document.addEventListener('click', event => {
      const item = groupItem(event);
      if (item) showGroup(Number(item.dataset.group));
    });
    document.addEventListener('keydown', event => {
      const item = groupItem(event);
      if (!item || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      showGroup(Number(item.dataset.group));
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

    render();${overlay ? OVERLAY_TAIL : ''}
  </script>
  ${legend}
</body>
</html>`;
}
