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
  overlappingGroups: number;
  overflowingLabels: number;
  positions?: string;
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
    overlappingGroups: (await read('OverlappingGroups')) as number,
    overflowingLabels: (await read('OverflowingLabels')) as number,
    positions: (await read('Positions')) as string | undefined,
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

interface ArchitectureInteraction {
  highlightedGroups: number;
  fadedGroups: number;
  labelledEdges: number;
  shownGroupEdges: number;
}

const readInteractionCount = async () => (await getContextKey<number>('graph-it-live.architectureInteractionCount')) ?? 0;

/**
 * Sets the find and min-imports controls (none: the picture the render drew), then waits
 * for the drawn picture to match `expected`.
 */
async function expectInteraction(
  description: string,
  controls: { find?: string; minImports?: number } | undefined,
  expected: ArchitectureInteraction,
): Promise<void> {
  const before = controls ? await readInteractionCount() : -1;
  if (controls) await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const start = Date.now();
  let last: ArchitectureInteraction | undefined;
  while (Date.now() - start < 15000) {
    last = await getContextKey<ArchitectureInteraction>('graph-it-live.architectureInteraction');
    if ((await readInteractionCount()) > before && JSON.stringify(last) === JSON.stringify({ command: 'architectureInteracted', ...expected })) return;
    await sleep(250);
  }
  assert.fail(`${description}: expected ${JSON.stringify(expected)}, last interaction ${JSON.stringify(last)}`);
}

/** Measured on the real canvas: no two group boxes intersect and every label fits its box. */
function assertReadableLayout(render: ArchitectureRender): void {
  assert.strictEqual(render.overlappingGroups, 0, 'overlapping group nodes');
  assert.strictEqual(render.overflowingLabels, 0, 'labels drawn outside their node');
  assert.strictEqual(render.positions?.split(';').length, render.groupCount, 'one position per group');
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
    assertReadableLayout(byFolder);

    await config().update('communityMode', 'louvain', vscode.ConfigurationTarget.Global);
    const structural = await waitForRender('the louvain render', byFolder.renderCount, render => render.communityMode === 'louvain');
    assert.strictEqual(structural.buildCount, byFolder.buildCount + 1, 'one rebuild for the new communityMode');
    assert.notStrictEqual(structural.revision, byFolder.revision, 'louvain ids get a new revision');
    assert.strictEqual(structural.groupCount, EXPECTED.louvain.groups, 'rendered louvain groups');
    assert.strictEqual(structural.groupEdgeCount, EXPECTED.louvain.groupEdges, 'rendered louvain group edges');
    assertReadableLayout(structural);

    await config().update('communityMode', undefined, vscode.ConfigurationTarget.Global);
    const back = await waitForRender('the path render again', structural.renderCount, render => render.communityMode === 'path');
    assert.strictEqual(back.positions, byFolder.positions, 'a communityMode round trip redraws the same picture');
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
    assert.strictEqual(refreshed.positions, built.positions, 'Refresh of an unchanged graph keeps every position');
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

  test('labels only highlighted edges, highlights a found group neighbourhood, filters weak edges, and clears', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    const { groups, groupEdges } = EXPECTED.path;
    const nothing = { highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0 };
    try {
      // Count labels are hidden until an edge is highlighted.
      await expectInteraction('the default picture', undefined, { ...nothing, shownGroupEdges: groupEdges });
      // layers imports one unassigned file: layers and unassigned stay, the 18 other groups fade.
      await expectInteraction('the layers neighbourhood', { find: 'LAYERS' }, {
        highlightedGroups: 2, fadedGroups: groups - 2, labelledEdges: 1, shownGroupEdges: groupEdges,
      });
      // 3 of the 6 group edges carry a single import; the layers edge is one of them.
      await expectInteraction('the min-imports filter', { minImports: 2 }, {
        highlightedGroups: 1, fadedGroups: groups - 1, labelledEdges: 0, shownGroupEdges: 3,
      });
      await expectInteraction('the cleared find', { find: '' }, { ...nothing, shownGroupEdges: 3 });
      await expectInteraction('the reset filter', { minImports: 1 }, { ...nothing, shownGroupEdges: groupEdges });
    } finally {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { find: '', minImports: 1 });
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
