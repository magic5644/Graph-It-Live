import React from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlowGraph from '../../../src/webview/components/ReactFlowGraph';
import type { GraphData } from '../../../src/shared/types';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const root = createRoot(document.getElementById('root')!);
const paths = ['a', 'b', 'c', 'd', 'x'].map(name => `/p/src/${name}/${name}.ts`);
const [a, b, c, d, x] = paths;
const data: GraphData = {
  nodes: paths,
  edges: [{ source: a, target: b }, { source: b, target: c }, { source: c, target: d }, { source: a, target: x }],
  nodeMetadata: Object.fromEntries(paths.map((p, i) => [p, { hubScore: 0, communityId: i + 1, communityKey: ['a', 'b', 'c', 'd', 'x'][i] }])),
};
function show(graph: GraphData, key: string, expandAll = true) {
  root.render(React.createElement(ReactFlowGraph, {
    key, data: graph, currentFilePath: graph.nodes[0], expandAll,
    onExpandAllChange: () => {}, onNodeClick: () => {}, onDrillDown: () => {}, onFindReferences: () => {},
  }));
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 10000;
  while (!condition()) {
    check(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const node = (id: string) => document.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`);
const edge = (source: string, target: string) => document.querySelector<SVGGElement>(`[data-testid="rf__edge-${source}->${target}"]`);
const checkbox = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const pane = () => document.querySelector<HTMLElement>('.react-flow__pane')!;
const viewport = () => document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
function click(element: Element) { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
function key(element: Element, value: string) { element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); }

async function run() {
  show(data, 'small');
  await until(() => !!edge(a, b), 'Graph did not initialize');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const initialViewport = viewport();
  const initialPosition = node(a)!.style.transform;
  checkbox('x (1)').click();
  await until(() => !node(x), 'Excluded community remains visible');
  click(edge(a, b)!);
  await until(() => Number(node(d)!.style.opacity) > 0 && Number(node(d)!.style.opacity) < 1, 'Unrelated file was not dimmed');
  check(Number(node(c)!.style.opacity || 1) === 1, 'Direct neighbor was dimmed');
  click(pane());
  await until(() => Number(node(d)!.style.opacity || 1) === 1, 'Pane click did not restore opacity');
  check(!node(x), 'Pane click changed community filters');
  check(!document.querySelector('.react-flow__edge.selected'), 'Pane click left a selected edge');
  check(viewport() === initialViewport, 'Filtering or focus moved the viewport');
  check(node(a)!.style.transform === initialPosition, 'Filtering moved the root');

  edge(a, b)!.focus();
  key(edge(a, b)!, 'Enter');
  await until(() => Number(node(d)!.style.opacity || 1) < 1, 'Enter did not activate edge');
  key(edge(a, b)!, 'Escape');
  await until(() => Number(node(d)!.style.opacity || 1) === 1, 'Escape did not restore graph');
  key(edge(a, b)!, ' ');
  await until(() => Number(node(d)!.style.opacity || 1) < 1, 'Space did not activate edge');
  click(pane());

  for (const box of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked) box.click();
  }
  await until(() => document.querySelectorAll('.react-flow__node').length === 0, 'Empty selection kept files visible');
  // <output> carries role=status implicitly, so the DOM has no role attribute to match on.
  const explanation = document.querySelector('output');
  check(explanation?.textContent?.includes('No files visible'), 'Empty selection has no explanation');
  const restore = [...document.querySelectorAll('button')].find(button => button.textContent === 'Show all');
  check(restore, 'Missing restore action');
  restore.click();
  await until(() => document.querySelectorAll('.react-flow__node').length === 5, 'Restore did not reveal all files');
  await new Promise(resolve => setTimeout(resolve, 800));
  check(viewport() === initialViewport, 'Restoring hidden nodes moved the viewport');

  const leaf = '/p/types/prisma.types.ts';
  const expansionGraph: GraphData = {
    nodes: [...paths, leaf],
    edges: [
      ...paths.slice(1).map(target => ({ source: a, target })),
      { source: b, target: d }, { source: b, target: c }, { source: b, target: x },
      { source: c, target: d }, { source: c, target: leaf }, { source: leaf, target: d }, { source: x, target: d },
    ],
  };
  show(expansionGraph, 'child-expansion', false);
  await until(() => document.querySelectorAll('.react-flow__node').length === 5 && !!node(c)?.querySelector('button[aria-label="Expand node"]'), 'Initial collapsed graph is incorrect');
  node(c)!.querySelector<HTMLButtonElement>('button[aria-label="Expand node"]')!.click();
  show({ ...expansionGraph, nodes: [...expansionGraph.nodes], edges: [...expansionGraph.edges], nodeMetadata: Object.fromEntries([...paths, leaf].map((path, i) => [path, { hubScore: 0, communityId: i === 5 ? 2 : 1, communityKey: i === 5 ? 'types' : 'helpers' }])) }, 'child-expansion', false);
  await until(() => !!node(leaf), 'Expanding a child did not reveal its dependency');
  await new Promise(resolve => setTimeout(resolve, 2500));
  for (const id of [...paths, leaf]) {
    const element = node(id);
    check(element && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none' && Number(getComputedStyle(element).opacity) > 0, `Expanded graph hides ${id}: ${element?.getAttribute('style')}`);
    const bounds = element.getBoundingClientRect();
    check(bounds.width > 0 && bounds.height > 0, `Expanded graph lost geometry for ${id}`);
  }

  const badge = () => document.querySelector<HTMLElement>('[data-testid="cycles-badge"]');
  show({ nodes: [a, b, c], edges: [
    { source: a, target: b }, { source: b, target: a },
    { source: a, target: c }, { source: c, target: b },
  ] }, 'overlapping-cycles');
  await until(() => !!badge()?.textContent?.includes('3 files in analyzed graph'), 'Overlapping cycle participant count is incorrect');
  check(badge()?.title.includes('including collapsed or hidden nodes'), 'Cycle count scope is unexplained');
  await until(() => document.querySelectorAll('.react-flow__edge-text').length === 4, 'Not all overlapping cycle edges are labelled');

  const separateCycles: GraphData = { nodes: [a, b, c, d], edges: [
    { source: a, target: b }, { source: b, target: a }, { source: b, target: c },
    { source: c, target: d }, { source: d, target: c },
  ] };
  show(separateCycles, 'collapsed-cycles', false);
  await until(() => !!badge()?.textContent?.includes('4 files in analyzed graph') && document.querySelectorAll('.react-flow__node').length === 2, 'Collapsed cycle participants were omitted from the badge');
  show(separateCycles, 'separate-cycles');
  await until(() => !!edge(b, c) && document.querySelectorAll('.react-flow__edge-text').length === 4, 'Separate cycles did not render');
  check(edge(b, c)?.querySelector('path')?.style.stroke !== edge(a, b)?.querySelector('path')?.style.stroke, 'One-way bridge was styled as cyclic');

  const cycleNodes = Array.from({ length: 3002 }, (_, i) => `/p/cycle/n${i}.ts`);
  show({ nodes: cycleNodes, edges: cycleNodes.map((source, i) => ({ source, target: cycleNodes[(i + 1) % cycleNodes.length] })) }, 'large-cycle', false);
  await until(() => !!badge()?.textContent?.includes('3002 files in analyzed graph'), 'Cycle detection was skipped above 3000 edges');

  // Exercise the current render ceilings with actual SVG edges and node geometry.
  const largeNodes = Array.from({ length: 400 }, (_, i) => `/p/src/g${i % 4}/f${i}.ts`);
  const largeEdges = largeNodes.slice(1).map(target => ({ source: largeNodes[0], target }));
  for (let source = 1; source < 399 && largeEdges.length < 1500; source++) {
    for (let target = source + 1; target < 400 && largeEdges.length < 1500; target++) {
      largeEdges.push({ source: largeNodes[source], target: largeNodes[target] });
    }
  }
  show({ nodes: largeNodes, edges: largeEdges, nodeMetadata: Object.fromEntries(largeNodes.map((p, i) => [p, { hubScore: 0, communityId: i % 4 + 1, communityKey: `g${i % 4}` }])) }, 'large');
  await until(() => document.querySelectorAll('.react-flow__edge').length === 1500, 'Large graph did not render 1500 edges');
  const start = performance.now();
  checkbox('g1 (100)').click();
  await until(() => document.querySelectorAll('.react-flow__node').length === 300, 'Large graph filter failed');
  const filterMs = performance.now() - start;
  vscode.postMessage({ ok: true, filterMs, nodes: 400, edges: 1500 });
}
run().catch(error => vscode.postMessage({ ok: false, error: String(error) }));
