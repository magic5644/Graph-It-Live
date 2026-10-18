/**
 * VS Code surface of the end-to-end benchmarks (#321). scripts/bench-e2e.mjs runs
 * this entry in the extension host of a fresh VS Code instance (empty profile and
 * index cache) and reads the one sample it writes to BENCH_VSCODE_OUT.
 */

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { getContextKey, getIndexStatus, showCallGraphAndWait, sleep } from '../suite/_helpers';

const MB = 1024 * 1024;
const TIMEOUT_MS = 600_000;
const POLL_MS = 20;

interface Sample {
  wallMs: number;
  rssMB: number;
}

const currentRssMB = (): number => process.memoryUsage().rss / MB;

/** Time from `started` until the background index reports `complete`. */
async function waitForIndex(started: number): Promise<number> {
  while (performance.now() - started < TIMEOUT_MS) {
    const status = await getIndexStatus<{ state?: string }>();
    if (status.state === 'complete') return performance.now() - started;
    if (status.state === 'error') throw new Error('Background indexing failed');
    await sleep(POLL_MS); // NOSONAR S9382: polling, each check waits for the previous one
  }
  throw new Error(`Background indexing did not complete within ${TIMEOUT_MS} ms`);
}

/** Resolves once the architecture view has rendered a build after `afterBuilds`. */
async function waitForArchitecture(afterBuilds: number): Promise<void> {
  const started = performance.now();
  const read = (key: string) => getContextKey<number>(`graph-it-live.architecture${key}`);
  while (performance.now() - started < TIMEOUT_MS) {
    // A render of the new build: the view renders once the build's summary arrives.
    if (((await read('BuildCount')) ?? 0) > afterBuilds && ((await read('RenderCount')) ?? 0) > afterBuilds) return;
    await sleep(POLL_MS); // NOSONAR S9382: polling, each check waits for the previous one
  }
  throw new Error(`The architecture view did not render within ${TIMEOUT_MS} ms`);
}

interface MatrixPaint { unit?: string; rows: number; digest: string; paintMs: number; cause: string }

/** Sends the architecture controls, then waits for a matrix paint that satisfies `predicate`. */
async function matrixPaint(controls: object, predicate: (paint: MatrixPaint) => boolean): Promise<MatrixPaint> {
  const read = <T>(key: string) => getContextKey<T>(`graph-it-live.architectureMatrix${key}`);
  const before = (await read<number>('Count')) ?? 0;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const started = performance.now();
  while (performance.now() - started < TIMEOUT_MS) {
    const paint = await read<MatrixPaint>('');
    if (((await read<number>('Count')) ?? 0) > before && paint && predicate(paint)) return paint;
    await sleep(POLL_MS); // NOSONAR S9382: polling, each check waits for the previous one
  }
  throw new Error(`The matrix did not paint within ${TIMEOUT_MS} ms`);
}

/**
 * The Matrix view of the unit holding the generated folders (one group per 100 modules): first
 * paint from the toggle, then a scroll to its last cell. Wall time, polling included.
 */
async function measureMatrix(unit: string): Promise<{ firstPaint: Sample; scroll: Sample; rows: number }> {
  const read = (key: string) => getContextKey<number>(`graph-it-live.architecture${key}`);
  const renders = (await read('RenderCount')) ?? 0;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { unit });
  while (((await read('RenderCount')) ?? 0) <= renders) await sleep(POLL_MS); // NOSONAR S9382: polling
  let started = performance.now();
  const shown = await matrixPaint({ view: 'matrix' }, (paint) => paint.unit === unit && paint.cause === 'matrix');
  const firstPaint = { wallMs: performance.now() - started, rssMB: currentRssMB() };
  const cells = shown.digest.split(';');
  const [row, column] = cells[cells.length - 1].split(/>|=/);
  started = performance.now();
  await matrixPaint({ matrixCell: { row, column } }, (paint) => paint.cause === 'scroll');
  return { firstPaint, scroll: { wallMs: performance.now() - started, rssMB: currentRssMB() }, rows: shown.rows };
}

/** Peak RSS so far of the extension host and its worker threads. */
const peakRssMB = (): number => process.resourceUsage().maxRSS / 1024;

/** Time from `showCallGraph` to the webview's `callGraphReady`, the view already mounted. */
async function measureFirstCallGraph(root: vscode.Uri, file: string): Promise<Sample> {
  await vscode.window.showTextDocument(vscode.Uri.joinPath(root, file));
  const started = performance.now();
  await showCallGraphAndWait(TIMEOUT_MS, POLL_MS);
  return { wallMs: performance.now() - started, rssMB: currentRssMB() };
}

export async function run(): Promise<void> {
  const { BENCH_VSCODE_FILE: file, BENCH_VSCODE_OUT: out } = process.env;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const extension = vscode.extensions.getExtension('magic5644.graph-it-live');
  if (!file || !out || !folder || !extension) {
    throw new Error('Needs BENCH_VSCODE_FILE, BENCH_VSCODE_OUT, an open folder and the Graph-It-Live extension');
  }

  // onStartupFinished fires after the test runner starts; if it ever wins the race, fail rather than report 0 ms.
  if (extension.isActive) throw new Error('Graph-It-Live activated before the benchmark could time it');
  const started = performance.now();
  await extension.activate();
  const activation: Sample = { wallMs: performance.now() - started, rssMB: currentRssMB() };
  // Background indexing starts when the view resolves. Index first: the status is polled
  // through vscode.lm, a round trip to the renderer that a rendering call graph would hold up.
  await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  await sleep(800); // resolveWebviewView + React mount, as in openCallGraphFor
  // Opened while the background index is being built, as on a first start (#383).
  const architectureStarted = performance.now();
  await vscode.commands.executeCommand('graph-it-live.setViewModeArchitecture');
  const indexReady: Sample = { wallMs: await waitForIndex(started), rssMB: currentRssMB() };
  await waitForArchitecture(0);
  const architectureDuringIndex: Sample = { wallMs: performance.now() - architectureStarted, rssMB: peakRssMB() };
  // Built again with the index ready: what reopening the view costs.
  const rebuildStarted = performance.now();
  await vscode.commands.executeCommand('graph-it-live.refreshGraph');
  await waitForArchitecture(1);
  const architectureIndexed: Sample = { wallMs: performance.now() - rebuildStarted, rssMB: peakRssMB() };
  const matrixUnit = process.env.BENCH_VSCODE_MATRIX_UNIT;
  const matrix = matrixUnit ? await measureMatrix(matrixUnit) : undefined;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { view: 'graph', unit: '' });
  await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
  const firstCallGraph = await measureFirstCallGraph(folder.uri, file);
  // The peak RSS of the whole session: extension host and its worker threads.
  firstCallGraph.rssMB = peakRssMB();
  fs.writeFileSync(out, JSON.stringify({
    activation, firstCallGraph, indexReady, architectureDuringIndex, architectureIndexed,
    matrixFirstPaint: matrix?.firstPaint, matrixScroll: matrix?.scroll, matrixRows: matrix?.rows,
  }));
}
