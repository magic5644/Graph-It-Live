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
function show(graph: GraphData, key: string) {
  root.render(React.createElement(ReactFlowGraph, {
    key, data: graph, currentFilePath: graph.nodes[0], expandAll: true,
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