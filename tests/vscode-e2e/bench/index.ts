/**
 * VS Code surface of the end-to-end benchmarks (#321). scripts/bench-e2e.mjs runs
 * this entry in the extension host of a fresh VS Code instance (empty profile and
 * index cache) and reads the one sample it writes to BENCH_VSCODE_OUT.
 */

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { getIndexStatus, showCallGraphAndWait, sleep } from '../suite/_helpers';

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

/** Time from `showCallGraph` to the webview's `callGraphReady`, the view already mounted. */
async function measureFirstCallGraph(root: vscode.Uri, file: string): Promise<Sample> {
  await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  await sleep(800); // resolveWebviewView + React mount, as in openCallGraphFor
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
  // Polled alongside the first graph, which competes with indexing as it would for a user.
  const [firstCallGraph, indexMs] = await Promise.all([measureFirstCallGraph(folder.uri, file), waitForIndex(started)]);
  // The peak RSS of the whole session: extension host and its worker threads.
  const indexReady: Sample = { wallMs: indexMs, rssMB: process.resourceUsage().maxRSS / 1024 };
  fs.writeFileSync(out, JSON.stringify({ activation, firstCallGraph, indexReady }));
}
