import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getContextKey, getProjectFile, openGraphFor, sleep, waitForViewMode } from './_helpers';

interface ArchitectureRender {
  renderCount: number;
  groupCount: number;
  groupEdgeCount: number;
  revision?: string;
  buildCount: number;
  communityMode?: string;
  stale: boolean;
}

// Expected numbers from the E2E workspace (tests/fixtures), recorded with:
//   node dist/graph-it.js architecture --groups --communities <mode> --format json -w tests/fixtures
// Rendered groups = groups.length + 1 for the unassigned files (unassigned.fileCount > 0).
const EXPECTED = {
  path: { groups: 19 + 1, groupEdges: 6 },
  louvain: { groups: 23 + 1, groupEdges: 1 },
} as const;

async function readRender(): Promise<ArchitectureRender> {
  const read = (key: string) => getContextKey(`graph-it-live.architecture${key}`);
  return {
    renderCount: (await read('RenderCount')) as number,
    groupCount: (await read('GroupCount')) as number,
    groupEdgeCount: (await read('GroupEdgeCount')) as number,
    revision: (await read('Revision')) as string | undefined,
    buildCount: (await read('BuildCount')) as number,
    communityMode: (await read('CommunityMode')) as string | undefined,
    stale: (await read('Stale')) as boolean,
  };
}

/** Waits for a render after `afterCount` that satisfies `predicate`. */
async function waitForRender(
  description: string,
  afterCount: number,
  predicate: (render: ArchitectureRender) => boolean = () => true,
): Promise<ArchitectureRender> {
  const start = Date.now();
  let render = await readRender();
  while (Date.now() - start < 90000) {
    render = await readRender();
    if (render.renderCount > afterCount && predicate(render)) return render;
    await sleep(250);
  }
  assert.fail(`Timed out waiting for ${description}. Last render: ${JSON.stringify(render)}`);
}

/** Opens the view and refreshes it: earlier suites edit fixtures, which leaves the cached summary stale. */
async function openFreshArchitecture(): Promise<ArchitectureRender> {
  await vscode.commands.executeCommand('graph-it-live.setViewModeArchitecture');
  await waitForViewMode('architecture');
  await sleep(500); // let the mount post architectureMounted first
  const before = (await readRender()).renderCount;
  await vscode.commands.executeCommand('graph-it-live.refreshGraph');
  return waitForRender('a fresh render', before, render => !render.stale && render.communityMode === 'path');
}

suite('Architecture view mode', () => {
  const config = () => vscode.workspace.getConfiguration('graph-it-live');

  suiteSetup(async function () {
    this.timeout(30000);
    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
    await sleep(800); // let resolveWebviewView and the React mount complete
  });

  teardown(async () => {
    await config().update('communityMode', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    await waitForViewMode('file');
  });

  test('renders the collapsed groups of graph-it architecture --groups, then rebuilds for louvain', async function () {
    this.timeout(240000);
    const byFolder = await openFreshArchitecture();
    assert.strictEqual(byFolder.groupCount, EXPECTED.path.groups, 'rendered groups');
    assert.strictEqual(byFolder.groupEdgeCount, EXPECTED.path.groupEdges, 'rendered group edges');
    assert.strictEqual(byFolder.stale, false);
    assert.match(byFolder.revision ?? '', /^[0-9a-f]{64}$/);

    await config().update('communityMode', 'louvain', vscode.ConfigurationTarget.Global);
    const structural = await waitForRender('the louvain render', byFolder.renderCount, render => render.communityMode === 'louvain');
    assert.strictEqual(structural.buildCount, byFolder.buildCount + 1, 'one rebuild for the new communityMode');
    assert.notStrictEqual(structural.revision, byFolder.revision, 'louvain ids get a new revision');
    assert.strictEqual(structural.groupCount, EXPECTED.louvain.groups, 'rendered louvain groups');
    assert.strictEqual(structural.groupEdgeCount, EXPECTED.louvain.groupEdges, 'rendered louvain group edges');
  });

  test('marks the view stale on a file change without rebuilding, and Refresh rebuilds', async function () {
    this.timeout(240000);
    const built = await openFreshArchitecture();

    const file = getProjectFile('sample-project', 'src', 'utils.ts');
    const original = await vscode.workspace.fs.readFile(file);
    try {
      await vscode.workspace.fs.writeFile(file, Buffer.concat([Buffer.from(original), Buffer.from('\n// architecture view E2E\n')]));
      const stale = await waitForRender('the stale banner', built.renderCount, render => render.stale);
      assert.strictEqual(stale.buildCount, built.buildCount, 'a file change does not rebuild');
      assert.strictEqual(stale.revision, built.revision, 'the stale summary keeps its revision');
    } finally {
      await vscode.workspace.fs.writeFile(file, original);
    }
    await sleep(1500); // let the restore's change event mark the view stale before Refresh

    const staleCount = (await readRender()).renderCount;
    await vscode.commands.executeCommand('graph-it-live.refreshGraph');
    const refreshed = await waitForRender('the refreshed render', staleCount, render => !render.stale);
    assert.strictEqual(refreshed.buildCount, built.buildCount + 1, 'Refresh rebuilds once');
    assert.strictEqual(refreshed.groupCount, EXPECTED.path.groups);
  });

  test('re-fits the graph when the view is resized, without re-rendering or rebuilding', async function () {
    this.timeout(240000);
    const built = await openFreshArchitecture();
    const readResize = async () => ({
      count: (await getContextKey<number>('graph-it-live.architectureResizeCount')) ?? 0,
      size: JSON.stringify(await getContextKey('graph-it-live.architectureViewSize')),
    });
    // Mount and header re-fits arrive asynchronously: wait until the count stops moving.
    let before = await readResize();
    for (let settled = 0; settled < 4; ) {
      await sleep(250);
      const next = await readResize();
      settled = next.count === before.count ? settled + 1 : 0;
      before = next;
    }

    // The view lives in the panel: maximizing it changes the container size. Toggling is
    // symmetric, so the finally block restores the layout whatever it was.
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    try {
      const start = Date.now();
      let after = await readResize();
      while (Date.now() - start < 15000 && !(after.count > before.count && after.size !== before.size)) {
        await sleep(250);
        after = await readResize();
      }
      assert.ok(after.count > before.count, `no re-fit after the resize: ${JSON.stringify({ before, after })}`);
      assert.notStrictEqual(after.size, before.size, 'the canvas follows the view size');
      const render = await readRender();
      assert.strictEqual(render.renderCount, built.renderCount, 'a resize does not re-run the layout');
      assert.strictEqual(render.buildCount, built.buildCount, 'a resize does not rebuild');
    } finally {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    }
  });

  test('the Graph, List and Symbol buttons leave the architecture view', async function () {
    this.timeout(60000);
    await openGraphFor('sample-project', 'src', 'utils.ts');
    for (const [command, mode] of [
      ['graph-it-live.setViewModeFile', 'file'],
      ['graph-it-live.setViewModeList', 'list'],
      ['graph-it-live.setViewModeSymbol', 'symbol'],
    ] as const) {
      await vscode.commands.executeCommand('graph-it-live.setViewModeArchitecture');
      await waitForViewMode('architecture');
      await vscode.commands.executeCommand(command);
      await waitForViewMode(mode, { timeoutMs: 15000 });
    }
  });
});
