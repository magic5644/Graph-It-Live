/**
 * E2E Tests for the Live Call Graph feature.
 *
 * Tests the `graph-it-live.showCallGraph` command, graph rendering via the
 * `callGraphReady` context keys set by CallGraphViewService, cycle detection,
 * live file-save refresh, and Python language smoke.
 *
 * Fixtures used:
 *   symbols/functions.ts  — call hierarchy: helperA, helperB, mainProcess, …
 *   symbols/recursion.ts  — mutual recursion: isEven ↔ isOdd, fibonacci
 *   python-project/main.py — Python smoke (skipped if fixture absent)
 */

import { after, before, teardown } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
  getContextKey,
  getProjectFile,
  openCallGraphFor,
  sleep,
} from './_helpers';

suite('Call Graph Test Suite', () => {
  before(async function () {
    this.timeout(30000);
    vscode.window.showInformationMessage('Starting call graph tests');
    const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
    assert.ok(ext, 'Extension should exist');
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  after(() => {
    vscode.window.showInformationMessage('Call graph tests completed');
  });

  teardown(async function () {
    try {
      // Best-effort: reset sidebar view mode so tests don't bleed into each other
      await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
      await sleep(300);
    } catch {
      // Ignore — graph view may not be open
    }
  });

  // ============================================================================
  // B1 — Command registration
  // ============================================================================

  test('Should register showCallGraph command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('graph-it-live.showCallGraph'),
      'graph-it-live.showCallGraph should be registered in the extension',
    );
  });

  // ============================================================================
  // B2 — Smoke: panel opens for a TypeScript file without throwing
  // ============================================================================

  test('Should open call graph for TypeScript file without error', async function () {
    this.timeout(90000);
    await openCallGraphFor('symbols', 'functions.ts');
    assert.ok(true, 'Call graph opened without error');
  });

  // ============================================================================
  // B3 — Graph content: nodeCount > 0 after opening
  // ============================================================================

  test('Should have callGraphNodeCount > 0 after opening call graph', async function () {
    this.timeout(90000);
    await openCallGraphFor('symbols', 'functions.ts');

    const nodeCount = await getContextKey<number>('graph-it-live.callGraphNodeCount');
    assert.ok(
      (nodeCount ?? 0) > 0,
      `Expected callGraphNodeCount > 0, got ${nodeCount ?? 'undefined'}`,
    );
  });

  // ============================================================================
  // B4 — Graph content: edgeCount is a non-negative integer
  // ============================================================================

  test('Should have callGraphEdgeCount >= 0 after opening call graph', async function () {
    this.timeout(90000);
    await openCallGraphFor('symbols', 'functions.ts');

    const edgeCount = await getContextKey<number>('graph-it-live.callGraphEdgeCount');
    assert.notStrictEqual(edgeCount, undefined, 'callGraphEdgeCount should be defined');
    assert.ok(
      (edgeCount ?? -1) >= 0,
      `Expected callGraphEdgeCount >= 0, got ${edgeCount ?? 'undefined'}`,
    );
  });

  // ============================================================================
  // B5 — Cycle detection: isCyclic edges present for mutually-recursive code
  // ============================================================================

  test('Should detect cyclic edges in recursion.ts fixture', async function () {
    this.timeout(90000);
    // recursion.ts contains isEven ↔ isOdd mutual recursion and fibonacci self-call
    await openCallGraphFor('symbols', 'recursion.ts');

    const cycleCount = await getContextKey<number>('graph-it-live.callGraphCycleCount');
    assert.ok(
      (cycleCount ?? 0) > 0,
      `Expected callGraphCycleCount > 0 for recursion.ts (mutual recursion), ` +
      `got ${cycleCount ?? 'undefined'}`,
    );
  });

  // ============================================================================
  // B6 — Render count: callGraphRenderCount increments on subsequent open
  // ============================================================================

  test('Should increment callGraphRenderCount on each call graph open', async function () {
    this.timeout(90000);
    await openCallGraphFor('symbols', 'functions.ts');
    const renderCountBefore =
      (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;

    // Open a different file so the service re-queries and posts a new callGraphReady
    await openCallGraphFor('symbols', 'recursion.ts');
    const renderCountAfter =
      (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;

    assert.ok(
      renderCountAfter > renderCountBefore,
      `callGraphRenderCount should increase after second open ` +
      `(before=${renderCountBefore}, after=${renderCountAfter})`,
    );
  });

  // ============================================================================
  // B7 — viewMode context key is not corrupted by showCallGraph
  // ============================================================================

  test('Should not corrupt viewMode context key when opening call graph', async function () {
    this.timeout(90000);
    // Open the call graph (which uses the sidebar webview, not the viewMode panel)
    await openCallGraphFor('symbols', 'functions.ts');

    const viewMode = await getContextKey<string>('graph-it-live.viewMode');
    // viewMode may be undefined (graph panel not open) or any valid mode string
    // 'callgraph' is a legitimate value set by showCallGraph via setViewModeCallgraph()
    assert.ok(
      viewMode === undefined || ['file', 'list', 'symbol', 'callgraph'].includes(viewMode),
      `viewMode should be undefined or a valid value, got: ${String(viewMode)}`,
    );
  });

  // ============================================================================
  // B8 — Live refresh: file save triggers re-render (debounce 500 ms)
  // ============================================================================

  test('Should re-render call graph after saving the source file', async function () {
    this.timeout(90000);
    await openCallGraphFor('symbols', 'functions.ts');
    const renderCountBefore =
      (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;

    // Trigger an explicit save of the currently open document.
    // VS Code fires onDidSaveTextDocument even for unmodified files.
    await vscode.commands.executeCommand('workbench.action.files.save');

    // Wait longer than the 500 ms debounce + indexing + query + webview render time
    await sleep(4000);

    const renderCountAfter =
      (await getContextKey<number>('graph-it-live.callGraphRenderCount')) ?? 0;
    assert.ok(
      renderCountAfter > renderCountBefore,
      `callGraphRenderCount should increase after file save ` +
      `(before=${renderCountBefore}, after=${renderCountAfter})`,
    );
  });

  // ============================================================================
  // B9 — Python smoke: showCallGraph on a Python file does not throw
  // ============================================================================

  test('Should open call graph for Python file without error', async function () {
    this.timeout(90000);
    const pyFile = getProjectFile('python-project', 'main.py');
    try {
      await vscode.workspace.fs.stat(pyFile);
    } catch {
      console.log('Python fixture not found — skipping test');
      return;
    }

    const pyDoc = await vscode.workspace.openTextDocument(pyFile);
    await vscode.window.showTextDocument(pyDoc);

    // Python may or may not produce a full graph; the test only verifies no exception
    try {
      await vscode.commands.executeCommand('graph-it-live.showCallGraph');
      await sleep(5000);
    } catch (err) {
      assert.fail(`showCallGraph on Python file threw an error: ${String(err)}`);
    }

    assert.ok(true, 'showCallGraph on Python file executed without error');
  });
});
