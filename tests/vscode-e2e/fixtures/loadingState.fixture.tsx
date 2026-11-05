// Acquired before App loads: App acquires the API at import time, and its second call fails silently (no messages).
import { vscode } from './vscodeApi.fixture';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../../src/webview/App';
import { ArchitectureGraph } from '../../../src/webview/components/architecture/ArchitectureGraph';
import { CytoscapeGraph } from '../../../src/webview/components/cytoscape/CytoscapeGraph';
import { LoadingState } from '../../../src/webview/components/LoadingState';

const noOp = () => {};
const views: Array<[id: string, title: string, view: React.ReactNode]> = [
  ['waiting', 'File / symbol views · waiting for graph data', <App key="app" />],
  ['calls', 'Call graph · indexing with a known percentage', <CytoscapeGraph key="calls" postMessage={noOp} />],
  ['architecture', 'Architecture · building with a known percentage', <ArchitectureGraph key="architecture" postMessage={noOp} />],
  // The matrix shows this exact element over its canvas while it waits for the extension (unit-tested on the real view).
  ['matrix', 'Matrix · building', <div key="matrix" style={{ position: 'absolute', inset: 0 }}><LoadingState message="Building the matrix…" /></div>],
];
createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
    {views.map(([id, title, view]) => (
      <section key={id} id={id} aria-label={title}>
        <h2>{title}</h2>
        <div className="view">{view}</div>
      </section>
    ))}
  </main>,
);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function until(condition: () => boolean, message: string, deadline = performance.now() + 15000): Promise<void> {
  if (condition()) return;
  check(performance.now() < deadline, message);
  await new Promise(resolve => setTimeout(resolve, 50));
  return until(condition, message, deadline);
}
const send = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
const logoOf = (id: string) => document.querySelector<HTMLElement>(`#${id} [data-testid="graph-it-live-logo"]`);
const textOf = (id: string) => document.querySelector(`#${id} output`)?.textContent ?? '';
const progressOf = (id: string) => document.querySelector<HTMLProgressElement>(`#${id} progress`);

async function run(): Promise<void> {
  // Sent until shown: the views listen only once mounted. The call graph shows its loading state on these messages only.
  await until(() => {
    send({ type: 'architectureState', status: 'building', message: 'Building architecture: 120 of 400 files', percent: 30 });
    send({ type: 'callGraphIndexing', status: 'progress', message: 'Indexing workspace…', percent: 40 });
    return progressOf('calls')?.value === 40 && progressOf('architecture')?.value === 30;
  }, 'The percentages sent by the extension are not shown');
  check(views.every(([id]) => logoOf(id) !== null), 'A view shows no logo');

  check(textOf('waiting').includes('Waiting for graph data...'), `Waiting screen message: ${textOf('waiting')}`);
  check(textOf('calls').includes('Indexing workspace… (40%)'), `Call graph message: ${textOf('calls')}`);
  check(textOf('architecture').includes('Building architecture: 120 of 400 files (30%)'), `Architecture message: ${textOf('architecture')}`);
  check(textOf('matrix').includes('Building the matrix…'), `Matrix message: ${textOf('matrix')}`);
  check(!progressOf('waiting') && !progressOf('matrix'), 'A progress bar shows without a percentage');

  const ids = Array.from(document.querySelectorAll('[data-testid="graph-it-live-logo"] [id]'), element => element.id);
  check(ids.length === views.length * 3, `Expected 3 ids per logo, got ${ids.length}`);
  check(new Set(ids).size === ids.length, `Logo ids collide: ${ids.join(', ')}`);
  for (const [id] of views) {
    const logo = logoOf(id)!;
    check(logo.getAttribute('aria-hidden') === 'true', `#${id} logo is not hidden from assistive technology`);
    check(logo.closest('output')?.getAttribute('aria-live') === 'polite', `#${id} loading state is not a polite live region`);
    const box = logo.getBoundingClientRect();
    check(Math.round(box.width) === 64 && Math.round(box.height) === 64, `#${id} logo is ${box.width}×${box.height}`);
    // Each gradient fill and star resolves inside its own logo: no instance paints with another one's ids.
    for (const [, ref] of logo.innerHTML.matchAll(/(?:url\(#|href="#)([^)"]+)/g)) {
      check(logo.querySelector(`[id="${ref}"]`), `#${id} logo references #${ref} outside itself`);
    }
    check(logo.querySelector('circle')!.getBoundingClientRect().width > 0, `#${id} logo is not painted`);
  }
  // Let the theme settle before the screenshot.
  await new Promise(resolve => setTimeout(resolve, 1000));
  vscode.postMessage({ ok: true, theme: document.body.className });
}
run().catch(error => vscode.postMessage({ ok: false, error: String(error) }));
