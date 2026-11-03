import React from 'react';
import { createRoot } from 'react-dom/client';
import ReactFlowGraph from '../../../src/webview/components/ReactFlowGraph';
import { CytoscapeGraph } from '../../../src/webview/components/cytoscape/CytoscapeGraph';
import { REACT_IDENTITY } from '../../../src/shared/constants';
import type { GraphData, ShowCallGraphMessage, SymbolInfo } from '../../../src/shared/types';
import type { Core } from 'cytoscape';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const paths = ['App.tsx', 'Card.tsx', 'Plain.tsx', 'Other.jsx', 'Button.vue'].map(name => `/project/${name}`);
const [app, card, plain, other, vue] = paths;
const files: GraphData = {
  nodes: paths,
  edges: paths.slice(1).map(target => ({ source: app, target })).concat({ source: card, target: app }),
  nodeMetadata: Object.fromEntries(paths.map(file => [file, {
    hubScore: file === card ? 0.9 : 0,
    ...([app, card].includes(file) ? { framework: 'react' as const } : {}),
  }])),
};
const symbols: SymbolInfo[] = ['Card', 'helper'].map(name => ({
  id: `${card}:${name}`, name, kind: 'FunctionDeclaration', line: 1, isExported: true,
  category: 'function', ...(name === 'Card' ? { framework: 'react' as const } : {}),
}));
const callGraph: ShowCallGraphMessage = {
  type: 'showCallGraph', rootSymbolId: 'app', depth: 1, timestamp: Date.now(), compounds: [],
  nodes: ['app', 'card', 'helper'].map((id, i) => ({
    id, name: ['App', 'Card', 'helper'][i], type: 'function', lang: 'typescript',
    path: i === 0 ? app : card, folder: '', startLine: i, endLine: i + 1,
    startCol: 0, isExported: true, isRoot: i === 0,
    ...(id === 'helper' ? {} : { framework: 'react' as const }),
  })),
  edges: [
    { sourceId: 'app', targetId: 'card', typeRelation: 'REFERENCES', isCyclic: true, sourceLine: 1, direction: 'outgoing' },
    { sourceId: 'card', targetId: 'app', typeRelation: 'REFERENCES', isCyclic: true, sourceLine: 2, direction: 'incoming' },
    { sourceId: 'card', targetId: 'helper', typeRelation: 'CALLS', isCyclic: false, sourceLine: 3, direction: 'lateral' },
  ],
};
const root = createRoot(document.getElementById('root')!);
let callReady = false;
const noOp = () => {};
const common = { expandAll: true, onExpandAllChange: noOp, onNodeClick: noOp, onDrillDown: noOp, onFindReferences: noOp };
root.render(<main style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '330px 320px', gap: 8 }}>
  <section id="files" style={{ gridColumn: '1 / 3', position: 'relative', minHeight: 0 }} aria-label="File graph">
    <h2>Files · React, Vue and plain JS/TS</h2>
    <div style={{ height: 290 }}><ReactFlowGraph {...common} data={files} currentFilePath={app} selectedNodeId={app} showCommunities={false} /></div>
  </section>
  <section id="symbols" style={{ position: 'relative', minWidth: 0 }} aria-label="Symbol graph">
    <h2>Symbols · components and utilities</h2>
    <div style={{ height: 280 }}><ReactFlowGraph {...common} mode="symbol" currentFilePath={symbols[0].id} selectedNodeId={symbols[0].id}
      data={{ nodes: symbols.map(symbol => symbol.id), edges: [{ source: symbols[0].id, target: symbols[1].id }] }}
      symbolData={{ symbols, dependencies: [] }} /></div>
  </section>
  <section id="calls" style={{ position: 'relative', minWidth: 0 }} aria-label="Call graph">
    <h2>Call graph · JSX references and cycles</h2>
    <div style={{ height: 280, position: 'relative' }}><CytoscapeGraph
      onReady={() => { callReady = true; }}
      postMessage={message => {
        if ((message as { command?: string }).command === 'callGraphMounted') {
          window.dispatchEvent(new MessageEvent('message', { data: callGraph }));
        }
      }} /></div>
  </section>
</main>);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 15000;
  while (!condition()) {
    check(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const fileNode = (file: string) => document.querySelector<HTMLElement>(`#files [data-testid="rf__node-${file}"]`);
const accessible = (scope: string, label: string) => document.querySelector<HTMLElement>(`#${scope} [aria-label="${label}"]`);
const rgb = (hex: string) => hex.match(/\w\w/g)!.map(value => Number.parseInt(value, 16));
function luminance(color: number[]): number {
  const linear = color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first: number[], second: number[]): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function run(): Promise<void> {
  await until(() => paths.every(file => !!fileNode(file)) && callReady, 'The file/symbol/call graphs did not finish rendering');
  await until(() => !!accessible('symbols', 'React: Card'), 'Symbol component identity missing');
  check(accessible('files', 'React: App.tsx'), 'Selected React file has no accessible framework name');
  check(accessible('files', 'React: Card.tsx'), 'Risky React file has no accessible framework name');
  check(fileNode(vue)?.querySelector('[aria-label="vue file"]'), 'Vue identity changed');
  for (const [file, language] of [[plain, 'typescript'], [other, 'javascript']]) {
    check(fileNode(file)?.querySelector(`[aria-label="${language} file"]`), `${file} lost its language fallback`);
    check(!fileNode(file)?.querySelector('[aria-label*="React"]'), `${file} was identified as React without proof`);
  }
  const hasBorder = (file: string, width: string) => [...fileNode(file)!.querySelectorAll('div')].some(element => getComputedStyle(element).borderWidth === width);
  check(hasBorder(app, '4px'), 'React identity hides selection');
  check(hasBorder(card, '5px'), 'React identity hides high-risk border width');
  check(fileNode(card)?.querySelector('[title="Part of circular dependency"]'), 'React identity hides cycle marker');
  check(!accessible('symbols', 'React: helper'), 'Utility symbol inherited its containing file framework');
  const callName = document.querySelector('#calls [data-testid="cytoscape-container"]')?.getAttribute('aria-label');
  check(callName?.includes('React: Card'), 'Call graph has no accessible React component');
  check(!callName.includes('React: helper'), 'Plain call graph symbol became React');
  const callContainer = document.querySelector('#calls [data-testid="cytoscape-container"]') as HTMLElement & { _cyreg: { cy: Core } };
  const cy = callContainer._cyreg.cy;
  check(cy.edges().length === 3, 'Call graph lost edges');
  check(cy.edges('[?isCyclic]').length === 2, 'Call graph lost JSX cycle evidence');
  check(cy.edges('[?isCyclic]').every(edge => edge.style('line-color') === 'rgb(255,77,77)'), 'React styling hides cyclic edges');
  const beforeSelection = Number.parseFloat(cy.getElementById('card').style('border-width'));
  cy.getElementById('card').select();
  check(Number.parseFloat(cy.getElementById('card').style('border-width')) > beforeSelection, 'React styling hides call graph selection');
  check(cy.getElementById('card').style('background-color') === `rgb(${rgb(REACT_IDENTITY.color).join(',')})`, 'Call graph selection hides React fill');
  // Identity screenshots use fixed positions so fcose randomness cannot obscure a component under the legend.
  cy.nodes().positions(node => ({ x: ({ app: 0, card: 160, helper: 320 } as Record<string, number>)[node.id()], y: 80 }));
  cy.fit(cy.elements(), 60);
  cy.forceRender();
  const canvas = document.querySelector<HTMLCanvasElement>('#calls canvas');
  check(canvas && canvas.width > 0 && canvas.height > 0, 'Call graph has no rendered canvas');
  await until(() => !!document.querySelector('#calls [data-testid="react-badge"]')?.textContent?.includes('React'), 'Call graph omits the React badge');
  check(contrast(rgb(REACT_IDENTITY.color), rgb(REACT_IDENTITY.foreground)) >= 4.5, 'React badge text/icon contrast is insufficient');
  const background = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
  check(background && contrast(rgb(REACT_IDENTITY.color), background) >= 3, 'React border contrast is insufficient in the active VS Code theme');
  await new Promise(resolve => setTimeout(resolve, 1000));
  vscode.postMessage({ ok: true, theme: document.body.className });
}
run().catch(error => vscode.postMessage({ ok: false, error: String(error) }));
