import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
  captureWindow, controls, flowState, getContextKey, getProjectFile, locationOf, saveDocumentText, selectedTab, settleFileEvents,
  waitForFlow, waitUntil, type FlowE2EState, type WindowCapture,
} from './_helpers';

const execFileAsync = promisify(execFile);
const CONTROLLER = 'trace/controller.ts';
/** 0-based editor lines of trace/controller.ts: inside handleGetUser, the blank line after it, inside handleCreateUser. */
const IN_GET_USER = 5;
const BETWEEN_SYMBOLS = 7;
const IN_CREATE_USER = 9;

async function openAt(relative: string, line: number): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(getProjectFile('', relative));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(line, 4, line, 4);
  return editor;
}

/** Show Flow Diagram on `relative` at `line`, then waits until the view shows that flow on the Flow tab. */
async function drawFlowAt(relative: string, line: number, symbol: string): Promise<FlowE2EState> {
  const before = (await flowState()).requestId;
  await openAt(relative, line);
  await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
  return waitForFlow(`the flow of ${symbol}`, state =>
    state.requestId > before && Boolean(state.entry?.includes(symbol)) && state.view?.flowRequestId === state.requestId && selectedTab(state) === 'flow');
}

/**
 * The CLI's diagram, run as a user would (no shell), in the same workspace; `--output -` writes the file's bytes.
 * The repository's build: the VSIX does not ship the CLI (a separate npm package), and `npm run package` builds both.
 */
async function cliDiagram(root: string, args: string[]): Promise<string> {
  const cli = path.resolve(__dirname, '..', '..', '..', 'dist', 'graph-it.js');
  const { stdout } = await execFileAsync(process.execPath, [cli, 'diagram', ...args, '--output', '-', '-w', root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GRAPH_IT_NO_CACHE: '1', GRAPH_IT_NO_STATS: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** diagramThemeFor: dark and high contrast draw the CLI's dark palette, the light themes its light one. */
const cliTheme = () => ([vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast].includes(vscode.window.activeColorTheme.kind) ? 'dark' : 'light');

/** #795: Show Diagram (Units | Folder | Matrix | Flow | Sequence) in the Architecture view. */
suite('Show Diagram (#795)', function () {
  this.timeout(180_000);
  let window: WindowCapture;
  let root: string;

  suiteSetup(async () => {
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();
    root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    window = captureWindow();
  });

  setup(() => {
    window.messages.length = 0;
    window.picks.length = 0;
    window.answer = undefined;
  });

  suiteTeardown(async () => {
    window?.restore();
    await controls({ follow: false });
    // The next suite finds the Architecture mode on its Units tab, as a fresh window shows it.
    await controls({ tab: 'units' });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
  });

  test('Show Diagram… lists exactly the CLI --view names; Escape changes nothing', async () => {
    const help = await cliDiagram(root, ['--help']).catch((error: { stdout?: string }) => error.stdout ?? '');
    const views = /--view VIEW\s+([a-z|]+)/.exec(help)?.[1].split('|');
    assert.deepStrictEqual(views, ['units', 'folder', 'matrix', 'flow', 'sequence'], `the CLI's --view names (help: ${help.slice(0, 200)})`);
    await openAt(CONTROLLER, IN_GET_USER);
    const mode = await getContextKey('graph-it-live.viewMode');
    await vscode.commands.executeCommand('graph-it-live.showDiagram');
    assert.deepStrictEqual(window.picks.map(pick => pick.labels), [views], 'one pick, the CLI names verbatim and in order');
    assert.deepStrictEqual(window.messages, []);
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), mode, 'Escape leaves the view mode');
  });

  test('Flow from the cursor: steps in call order with names; a step opens its file:line, a call its call site', async () => {
    const shown = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'architecture');
    assert.ok(shown.nodes.length >= 2 && shown.nodes.length <= 8, `2 to 8 steps: ${shown.nodes.join(' | ')}`);
    shown.nodes.forEach((name, index) => assert.match(name, new RegExp(`^Step ${index + 1} of ${shown.nodes.length}: .+, .+:\\d+, \\w+ lane$`)));
    assert.match(shown.nodes[0], /^Step 1 of \d+: handleGetUser, trace\/controller\.ts:5, main lane$/);
    assert.ok(shown.edges.length > 0 && shown.edges.every(name => /^Call .+ → .+ at .+:\d+, \w+ lane$/.test(name)), shown.edges.join(' | '));
    // Every step and call has a button with that accessible name, and only those.
    assert.deepStrictEqual(shown.view?.flowButtons, [...shown.nodes, ...shown.edges]);
    assert.deepStrictEqual(shown.view?.crumbs, [path.basename(root), 'trace', 'controller.ts', 'handleGetUser']);
    assert.deepStrictEqual(window.messages, []);

    const expectOpened = async (what: string, control: Record<string, number>, name: string) => {
      const target = locationOf(name);
      await controls(control);
      await waitForFlow(what, state => state.lastOpened?.file === target.file && state.lastOpened.line === target.line
        && vscode.window.activeTextEditor?.selection.active.line === target.line - 1
        && path.relative(path.resolve(root, target.file), vscode.window.activeTextEditor.document.uri.fsPath) === '', 30_000);
    };
    await expectOpened('step 2 opened at its declaration', { flowNode: 1 }, shown.nodes[1]);
    await expectOpened('call 1 opened at its call site', { flowEdge: 0 }, shown.edges[0]);
  });

  // #798 c: the same entry as a sequence diagram, on the Sequence tab.
  test('Sequence tab: the entry at the cursor as the CLI draws it; a lifeline opens its file, a call its call site', async () => {
    const flow = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    await controls({ tab: 'sequence' });
    const shown = await waitForFlow('the sequence of handleGetUser on the Sequence tab', state =>
      state.drawnView === 'sequence' && state.requestId > flow.requestId && state.view?.flowRequestId === state.requestId && selectedTab(state) === 'sequence');
    assert.strictEqual(shown.entry, flow.entry);
    shown.nodes.forEach((name, index) => assert.match(name, new RegExp(`^Lifeline ${index + 1} of ${shown.nodes.length}: .+, .+:\\d+$`)));
    assert.match(shown.nodes[0], /^Lifeline 1 of \d+: controller\.ts, trace\/controller\.ts:1$/);
    assert.ok(shown.edges.length > 0 && shown.edges.every(name => /^Call .+ → .+ at .+:\d+/.test(name)), shown.edges.join(' | '));
    assert.deepStrictEqual(shown.view?.flowButtons, [...shown.nodes, ...shown.edges]);
    assert.deepStrictEqual(window.messages, []);
    const { line } = locationOf(flow.nodes[0]);
    const cli = await cliDiagram(root, ['--view', 'sequence', `${CONTROLLER}#handleGetUser`, '--startLine', String(line), '--format', 'svg', '--theme', cliTheme()]);
    assert.strictEqual(shown.svgDigest, sha256(cli), 'the drawn SVG is the CLI\'s');

    const expectOpened = async (what: string, control: Record<string, number>, target: { file: string; line: number }) => {
      await controls(control);
      await waitForFlow(what, state => state.lastOpened?.file === target.file && state.lastOpened.line === target.line
        && vscode.window.activeTextEditor?.selection.active.line === target.line - 1
        && path.relative(path.resolve(root, target.file), vscode.window.activeTextEditor.document.uri.fsPath) === '', 30_000);
    };
    const [, file, calleeLine] = /, ([^,]+):(\d+)$/.exec(shown.nodes[1])!;
    const callee = { file, line: Number(calleeLine) };
    await expectOpened('lifeline 2 opened at its file', { flowNode: 1 }, callee);
    const site = /at (.+):(\d+)/.exec(shown.edges[0])!;
    await expectOpened('call 1 opened at its call site', { flowEdge: 0 }, { file: site[1], line: Number(site[2]) });
    // The Flow tab draws the same entry as a flow again.
    await controls({ tab: 'flow' });
    await waitForFlow('the flow again on the Flow tab', state => state.drawnView === 'flow' && state.view?.flowRequestId === state.requestId && selectedTab(state) === 'flow');
  });

  // #826: zoom and Fit on a drawn sequence; the call buttons follow the drawing.
  test('Sequence zoom: + zooms in, a key too, Fit fits again, 100% shows the drawn size; a call still opens its call site', async () => {
    const flow = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    await controls({ tab: 'sequence' });
    const shown = await waitForFlow('the sequence drawn', state =>
      state.drawnView === 'sequence' && state.requestId > flow.requestId && state.view?.flowRequestId === state.requestId && Boolean(state.view.flowZoom));
    const fitted = shown.view!.flowZoom!;
    assert.ok(fitted > 0 && fitted <= 1, `a new diagram opens fitted, never above 100%: ${fitted}`);
    await controls({ zoom: 'in' });
    await waitForFlow('zoomed in from the toolbar', state => state.view?.flowZoom === Math.round(fitted * 1.25 * 1000) / 1000, 30_000);
    await controls({ keys: ['Tab', '+'] });
    await waitForFlow('zoomed in again with + on the focused lifeline', state => (state.view?.flowZoom ?? 0) > fitted * 1.5, 30_000);
    await controls({ zoom: 'fit' });
    await waitForFlow('fitted again', state => state.view?.flowZoom === fitted, 30_000);
    await controls({ zoom: 'reset' });
    await waitForFlow('100%', state => state.view?.flowZoom === 1, 30_000);
    assert.deepStrictEqual((await flowState()).view?.flowButtons, [...shown.nodes, ...shown.edges], 'every button stays after the zoom');
    const site = /at (.+):(\d+)/.exec(shown.edges[0])!;
    await controls({ flowEdge: 0 });
    await waitForFlow('call 1 opened at its call site after the zoom', state => state.lastOpened?.file === site[1] && state.lastOpened.line === Number(site[2])
      && vscode.window.activeTextEditor?.selection.active.line === Number(site[2]) - 1, 30_000);
  });

  test('Sequence on a file without a symbol says so once, draws nothing and leaves the view mode', async () => {
    const before = await flowState();
    const mode = await getContextKey('graph-it-live.viewMode');
    await openAt('bench-permanent/src/module0.ts', 0);
    window.answer = 'sequence';
    await vscode.commands.executeCommand('graph-it-live.showDiagram');
    assert.deepStrictEqual(window.messages, ['Graph-It-Live: bench-permanent/src/module0.ts has no symbol to draw a sequence from.']);
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), mode);
    assert.strictEqual((await flowState()).requestId, before.requestId);
  });

  test('keyboard only: Tab enters the first step, ArrowRight follows the call, Escape returns to the tabs, Enter opens', async () => {
    const shown = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    await controls({ keys: ['Tab'] });
    await waitForFlow('the first step focused', state => state.view?.focused === shown.nodes[0], 30_000);
    await controls({ keys: ['ArrowRight'] });
    const second = await waitForFlow('the callee focused', state => state.view?.focused !== shown.nodes[0] && shown.nodes.includes(state.view?.focused ?? ''), 30_000);
    await controls({ keys: ['Escape'] });
    await waitForFlow('the Flow tab focused', state => state.view?.focused === 'flow', 30_000);
    await controls({ keys: ['Tab', 'Enter'] });
    const first = locationOf(shown.nodes[0]);
    await waitForFlow('Enter opened the first step', state => state.lastOpened?.line === first.line && state.lastOpened.file === first.file, 30_000);
    assert.ok(second.view?.focused, 'a named step had the focus');
  });

  test('an unsupported file says so once and leaves the view mode', async () => {
    const mode = await getContextKey('graph-it-live.viewMode');
    const before = (await flowState()).requestId;
    await openAt('sample-project/tsconfig.json', 0);
    await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
    assert.strictEqual(window.messages.length, 1, window.messages.join(' | '));
    assert.match(window.messages[0], /^Graph-It-Live: Flow Diagram is not supported for "jsonc?"\. Supported: TypeScript, JavaScript, /);
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), mode);
    assert.strictEqual((await flowState()).requestId, before);
  });

  test('no active editor says so once and leaves the view mode', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const mode = await getContextKey('graph-it-live.viewMode');
    await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
    assert.deepStrictEqual(window.messages, ['Graph-It-Live: Open a source file and position the cursor on a symbol first.']);
    assert.strictEqual(await getContextKey('graph-it-live.viewMode'), mode);
  });

  test('between symbols: a pick of the file symbols, Escape is silent and changes nothing', async () => {
    const before = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    await openAt(CONTROLLER, BETWEEN_SYMBOLS);
    await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
    assert.strictEqual(window.picks.length, 1);
    assert.strictEqual(window.picks[0].placeHolder, `Pick the symbol of ${CONTROLLER} to draw its flow`);
    assert.ok(window.picks[0].labels.includes('handleGetUser') && window.picks[0].labels.includes('handleCreateUser'), window.picks[0].labels.join(', '));
    assert.deepStrictEqual(window.messages, []);
    const after = await flowState();
    assert.deepStrictEqual([after.requestId, after.entry, selectedTab(after)], [before.requestId, before.entry, 'flow']);
  });

  test('cancel keeps the previous diagram and tab, with no message but the progress notification', async () => {
    const before = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    // The driver cancels the next wait: a warm index could end it before the driver reached it.
    await controls({ cancelFlow: true });
    await openAt(CONTROLLER, IN_CREATE_USER);
    await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
    const after = await waitForFlow('the view back on the previous flow', state => state.view?.flowBusy === false && state.view.flowRequestId === before.requestId, 30_000);
    assert.deepStrictEqual([after.requestId, after.entry, after.nodes, selectedTab(after)], [before.requestId, before.entry, before.nodes, 'flow']);
    assert.deepStrictEqual(window.messages, []);
  });

  test('an unknown symbol (renamed, then Refresh) says why once, on the view too, and keeps the diagram', async () => {
    const file = getProjectFile('', CONTROLLER);
    const original = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    const before = await drawFlowAt(CONTROLLER, IN_CREATE_USER, 'handleCreateUser');
    try {
      await settleFileEvents([file], () => saveDocumentText(file, original.replace('handleCreateUser', 'handleCreateAccount')));
      await waitForFlow('the flow marked stale', state => state.stale && Boolean(state.view?.flowLine?.startsWith('Stale')), 30_000);
      await controls({ flowRefresh: true });
      const failed = await waitForFlow('the refresh error', state => state.state === 'error', 60_000);
      assert.strictEqual(window.messages.length, 1, window.messages.join(' | '));
      assert.match(window.messages[0], /^Graph-It-Live: .*handleCreateUser/);
      assert.strictEqual(window.messages[0], `Graph-It-Live: ${failed.lastError}`);
      assert.ok(!window.messages[0].includes(root), 'the workspace root is masked');
      await waitForFlow('the error line under the kept diagram', state => state.view?.flowLine === failed.lastError && state.view?.flowRequestId === before.requestId, 30_000);
      assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'architecture');
    } finally {
      await settleFileEvents([file], () => saveDocumentText(file, original));
    }
  });

  test('a theme change re-colours the flow as the CLI draws it in that theme, on the same tab', async () => {
    const shown = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    const { line } = locationOf(shown.nodes[0]);
    const cliArgs = (theme: string) => ['--view', 'flow', `${CONTROLLER}#handleGetUser`, '--startLine', String(line), '--format', 'svg', '--theme', theme];
    assert.strictEqual(shown.svgDigest, sha256(await cliDiagram(root, cliArgs(cliTheme()))), `the drawn SVG is the CLI's in the ${cliTheme()} theme`);
    const settings = vscode.workspace.getConfiguration('workbench');
    const original = settings.inspect<string>('colorTheme')?.globalValue;
    const next = cliTheme() === 'dark' ? 'Default Light Modern' : 'Default Dark Modern';
    try {
      await settings.update('colorTheme', next, vscode.ConfigurationTarget.Global);
      const recoloured = await waitForFlow(`the flow in ${next}`, state => state.requestId > shown.requestId && state.view?.flowRequestId === state.requestId, 30_000);
      assert.notStrictEqual(recoloured.svgDigest, shown.svgDigest);
      assert.strictEqual(recoloured.svgDigest, sha256(await cliDiagram(root, cliArgs(cliTheme()))), `the CLI's ${cliTheme()} palette`);
      assert.deepStrictEqual([selectedTab(recoloured), recoloured.entry, recoloured.nodes], ['flow', shown.entry, shown.nodes], 'same tab and flow, no re-index');
    } finally {
      await settings.update('colorTheme', original, vscode.ConfigurationTarget.Global);
    }
    await waitForFlow('the flow back in the original theme', state => state.svgDigest === shown.svgDigest, 30_000);
  });

  test('pinned by default; Follow cursor redraws once per symbol, debounced; a command re-scope turns it off', async () => {
    const pinned = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    assert.strictEqual(pinned.follow, false, 'pinned by default');
    const editor = await openAt(CONTROLLER, IN_CREATE_USER);
    await controls({ follow: true });
    await waitForFlow('Follow cursor on', state => state.follow, 30_000);
    // Three moves inside one symbol: one redraw (a loading state and its flow), nothing for the pinned move before.
    for (const line of [IN_CREATE_USER + 1, IN_CREATE_USER, IN_CREATE_USER + 1]) editor.selection = new vscode.Selection(line, 2, line, 2);
    const followed = await waitForFlow('the followed flow', state => Boolean(state.entry?.includes('handleCreateUser')) && state.view?.flowRequestId === state.requestId, 30_000);
    assert.strictEqual(followed.requestId, pinned.requestId + 2, 'one recompute');
    assert.deepStrictEqual(window.messages, []);

    await openAt(CONTROLLER, IN_GET_USER);
    await vscode.commands.executeCommand('graph-it-live.showFlowDiagram');
    await waitForFlow('Follow off after the command', state => !state.follow && Boolean(state.entry?.includes('handleGetUser')), 30_000);
  });

  test('export writes the CLI bytes (same --theme and --startLine), inside the workspace', async () => {
    const shown = await drawFlowAt(CONTROLLER, IN_GET_USER, 'handleGetUser');
    const { line } = locationOf(shown.nodes[0]);
    const files: vscode.Uri[] = [];
    try {
      for (const format of ['svg', 'html']) {
        const output = `flow-e2e-795.${format}`;
        const file = vscode.Uri.file(path.join(root, output));
        files.push(file);
        await controls({ exportDiagram: { target: 'file', output } });
        let written = '';
        await waitUntil(async () => {
          written = await Promise.resolve(vscode.workspace.fs.readFile(file)).then(bytes => Buffer.from(bytes).toString('utf8'), () => '');
          return written.length > 0;
        }, `${output} written`);
        // --theme colours SVG only: the HTML page follows the reader's scheme.
        const theme = format === 'svg' ? ['--theme', cliTheme()] : [];
        const expected = await cliDiagram(root, ['--view', 'flow', `${CONTROLLER}#handleGetUser`, '--startLine', String(line), '--format', format, ...theme]);
        assert.ok(written === expected, `${output} differs from the CLI (${written.length} vs ${expected.length} bytes)`);
      }
      assert.deepStrictEqual(window.messages, ['Flow diagram saved to flow-e2e-795.svg.', 'Flow diagram saved to flow-e2e-795.html.']);
    } finally {
      const existing = (await Promise.all(files.map(file => Promise.resolve(vscode.workspace.fs.stat(file)).then(() => file, () => undefined))))
        .filter((file): file is vscode.Uri => file !== undefined);
      if (existing.length > 0) await settleFileEvents(existing, () => Promise.all(existing.map(file => vscode.workspace.fs.delete(file))));
    }
  });

  test('a folder from the Explorer draws its Folder level, the breadcrumb naming its unit and folders', async () => {
    const folder = getProjectFile('bench-permanent', 'src', 'components');
    await vscode.commands.executeCommand('graph-it-live.showFolderDiagram', folder);
    let rendered: { unit?: string; folder?: string } | undefined;
    const shown = await waitForFlow('the Folder diagram of bench-permanent/src/components', state => {
      return selectedTab(state) === 'folder' && state.view?.crumbs.at(-1) === 'components';
    }, 120_000);
    await waitUntil(async () => {
      rendered = await getContextKey('graph-it-live.architectureRendered');
      return rendered?.unit === 'bench-permanent' && Boolean(rendered.folder?.endsWith('/components'));
    }, `the drawn level (last: ${JSON.stringify(rendered)})`);
    assert.strictEqual(shown.view?.crumbs[0], 'All units');
    assert.ok(shown.view?.crumbs.includes('bench-permanent'), shown.view?.crumbs.join(' › '));
    assert.deepStrictEqual(window.messages, []);
  });
});
