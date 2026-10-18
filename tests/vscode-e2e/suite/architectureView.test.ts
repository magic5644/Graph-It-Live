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
  /** Entered unit; undefined at the units level. */
  unit?: string;
  /** Entered folder within the unit; undefined at its top level. */
  folder?: string;
  unitLevel?: { units: number; colors: number; redEdges: number; edgesNotDown: number; routedEdges: number; hiddenEdges: number; minLabelPx: number };
}

// Expected numbers from the E2E workspace (tests/fixtures), recorded with:
//   node dist/graph-it.js architecture --level units --format json -w tests/fixtures
//   node dist/graph-it.js architecture --groups --communities louvain --format json -w tests/fixtures
// Path mode draws the units (11 packages or (root), 9 unit edges, the 2 edges of the
// workspaces-project core ↔ types cycle in red); (root) holds 18 folder groups and 4 group edges.
//   node dist/graph-it.js architecture --folder "(root)/graphql-project" --format json -w tests/fixtures
//   node dist/graph-it.js architecture --level units --from workspaces-project/apps/web --to workspaces-project/packages/ui --format json -w tests/fixtures
// Louvain: rendered groups = groups.length + 1 for the unassigned files.
const EXPECTED = {
  units: { groups: 11, groupEdges: 9, redEdges: 2 },
  root: { groups: 18, groupEdges: 4 },
  graphql: { groups: 3, groupEdges: 2, evidenceOf: '(root)/graphql-project/queries' },
  louvain: { groups: 24 + 1, groupEdges: 1 },
  // The first edge of @ws/web, its heaviest: apps/web → packages/ui.
  unitEvidence: {
    of: 'workspaces-project/apps/web',
    title: '@ws/web → @ws/ui: 2 file pairs (static imports)',
    pairs: [
      'workspaces-project/apps/web/src/main.ts → workspaces-project/packages/ui/src/index.ts',
      'workspaces-project/apps/web/src/pages/home.ts → workspaces-project/packages/ui/src/index.ts',
    ],
  },
  // node dist/graph-it.js architecture --level units --matrix --format json -w tests/fixtures (and --folder "(root)", --communities louvain).
  matrix: {
    units: { rows: 11, cells: 14, fileEdges: 213, upwardCells: 1, cycles: 1 },
    root: { rows: 18, cells: 20, fileEdges: 197, upwardCells: 1, cycles: 1 },
    louvain: { rows: 25, cells: 25, fileEdges: 213, upwardCells: 0, cycles: 0 },
  },
} as const;

interface MatrixRender {
  revision: string;
  unit?: string;
  rows: number;
  cells: number;
  fileEdges: number;
  upwardCells: number;
  cycles: number;
  renderedCells: number;
  digest: string;
}

/** Sends the controls, then waits for a matrix paint that satisfies `predicate`. */
async function expectMatrix(
  description: string,
  controls: Record<string, unknown>,
  predicate: (matrix: MatrixRender) => boolean,
): Promise<MatrixRender> {
  const before = (await getContextKey<number>('graph-it-live.architectureMatrixCount')) ?? 0;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const start = Date.now();
  let last: MatrixRender | undefined;
  while (Date.now() - start < 30000) {
    last = await getContextKey<MatrixRender>('graph-it-live.architectureMatrix');
    if (((await getContextKey<number>('graph-it-live.architectureMatrixCount')) ?? 0) > before && last && predicate(last)) return last;
    await sleep(250);
  }
  assert.fail(`${description}: last matrix ${JSON.stringify(last)}`);
}

const totalsOf = ({ rows, cells, fileEdges, upwardCells, cycles }: MatrixRender) => ({ rows, cells, fileEdges, upwardCells, cycles });

/** Enters a folder of the drawn level (empty: up one level), then waits for the render of `expected`. */
async function enterFolder(folder: string, expected: string | undefined): Promise<ArchitectureRender> {
  const before = (await readRender()).renderCount;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { folder });
  return waitForRender(`the ${expected ?? 'unit'} render`, before, render => render.folder === expected);
}

/** Enters a unit (empty: back to the units), then waits for its render. */
async function enterUnit(unit: string): Promise<ArchitectureRender> {
  const before = (await readRender()).renderCount;
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { unit });
  return waitForRender(`the ${unit || 'units'} render`, before, render => (render.unit ?? '') === unit);
}

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
    unit: (await read('Unit')) as string | undefined,
    folder: (await read('Folder')) as string | undefined,
    unitLevel: (await read('UnitLevel')) as ArchitectureRender['unitLevel'],
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
  shownFileEdges: number;
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

interface ArchitectureDetail {
  expandedGroups: number;
  expandedFileCount: number;
  renderedFiles: number;
  groupLevelEdges: number;
  visibleGroups: number;
  focusedGroup?: string;
  capReached: boolean;
  evidence?: { edgeCount: number; total: number; shown: number; firstSource?: string; title: string; pairs: string[] };
}

const readDetailCount = async () => (await getContextKey<number>('graph-it-live.architectureDetailCount')) ?? 0;

/** Sends the controls (none: only waits), then waits for what the expanded groups and evidence show to satisfy `predicate`. */
async function expectDetail(
  description: string,
  controls: Record<string, unknown> | undefined,
  predicate: (detail: ArchitectureDetail) => boolean,
): Promise<ArchitectureDetail> {
  const before = controls ? await readDetailCount() : -1;
  if (controls) await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const start = Date.now();
  let last: ArchitectureDetail | undefined;
  while (Date.now() - start < 30000) {
    last = await getContextKey<ArchitectureDetail>('graph-it-live.architectureDetail');
    if ((await readDetailCount()) > before && last && predicate(last)) return last;
    await sleep(250);
  }
  assert.fail(`${description}: last detail ${JSON.stringify(last)}`);
}

/**
 * Focuses `key` (it and its one neighbour stay drawn), enters it, opens the evidence of one of
 * its edges and its first file, then goes back to the overview.
 */
async function exploreGroup(key: string, groups: number, groupEdges: number): Promise<void> {
  const focused = await expectDetail(`focusing ${key}`, { focus: key }, detail => detail.focusedGroup === key);
  assert.strictEqual(focused.visibleGroups, 2, 'the focus keeps the group and the group it imports');
  assert.strictEqual(focused.expandedGroups, 0, 'a focus does not expand');

  const expanded = await expectDetail(`entering ${key}`, { expand: key }, detail => detail.expandedGroups === 1);
  assert.ok(expanded.expandedFileCount > 0, 'the entered group has files');
  assert.strictEqual(expanded.renderedFiles, Math.min(expanded.expandedFileCount, 200), 'rendered file nodes');
  assert.strictEqual(expanded.groupLevelEdges, groupEdges, 'the group edges stay on the entered group');
  const interaction = await getContextKey<ArchitectureInteraction>('graph-it-live.architectureInteraction');
  assert.strictEqual(interaction?.shownFileEdges, 0, 'file edges wait for a hovered or selected file');

  const { evidence } = await expectDetail(`the evidence of ${key}`, { evidenceOf: key }, detail => detail.evidence !== undefined);
  assert.ok(evidence && evidence.total > 0, 'the evidence lists file pairs');
  assert.strictEqual(evidence.total, evidence.edgeCount, 'the evidence total equals the edge label');

  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { openEvidenceRow: 0 });
  const start = Date.now();
  const active = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? vscode.workspace.asRelativePath(uri, false) : undefined;
  };
  while (Date.now() - start < 15000 && active() !== evidence.firstSource) await sleep(250);
  assert.strictEqual(active(), evidence.firstSource, 'the clicked row opens its file');

  await vscode.commands.executeCommand('graph-it-live.graphView.focus');
  const collapsed = await expectDetail(`leaving ${key}`, { collapse: key }, detail => detail.expandedGroups === 0);
  assert.strictEqual(collapsed.renderedFiles, 0);
  const overview = await expectDetail('the overview', { focus: '' }, detail => detail.focusedGroup === undefined);
  assert.strictEqual(overview.visibleGroups, groups, 'the overview draws every group again');
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

  test('renders the units of graph-it architecture --level units in layers, then rebuilds for louvain', async function () {
    this.timeout(240000);
    const byFolder = await openFreshArchitecture();
    assert.strictEqual(byFolder.unit, undefined, 'path mode opens on the units');
    assert.strictEqual(byFolder.groupCount, EXPECTED.units.groups, 'rendered units');
    assert.strictEqual(byFolder.groupEdgeCount, EXPECTED.units.groupEdges, 'rendered unit edges');
    assert.deepStrictEqual(byFolder.unitLevel, {
      units: EXPECTED.units.groups,
      colors: EXPECTED.units.groups,
      redEdges: EXPECTED.units.redEdges,
      edgesNotDown: 0,
      // ELK ran in its blob worker under the webview CSP, and routed every drawn edge.
      routedEdges: EXPECTED.units.groupEdges,
      hiddenEdges: 0,
      minLabelPx: byFolder.unitLevel?.minLabelPx,
    }, 'one colour per unit, red cycle edges, every other edge drawn downwards, none hidden');
    assert.ok((byFolder.unitLevel?.minLabelPx ?? 0) >= 8, `labels readable after the fit: ${byFolder.unitLevel?.minLabelPx}px`);
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
    assert.strictEqual(refreshed.groupCount, EXPECTED.units.groups);
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

  test('enters a unit: its folder groups only, in the unit colour, and goes back to the units', async function () {
    this.timeout(240000);
    const units = await openFreshArchitecture();
    const web = await enterUnit('workspaces-project/apps/web');
    assert.strictEqual(web.groupCount, 2, 'the groups of @ws/web only');
    assert.strictEqual(web.groupEdgeCount, 1, 'the group edges inside @ws/web');
    assert.strictEqual(web.unitLevel, undefined);
    assertReadableLayout(web);
    const back = await enterUnit('');
    assert.strictEqual(back.groupCount, EXPECTED.units.groups);
    assert.strictEqual(back.positions, units.positions, 'the units come back where they were');
  });

  test('lists the file pairs behind a clicked unit edge, opens one, and entering a unit closes them', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    const { of, title, pairs } = EXPECTED.unitEvidence;
    const { evidence } = await expectDetail('the evidence of a unit edge', { evidenceOf: of }, detail => detail.evidence?.shown === pairs.length);
    assert.ok(evidence);
    assert.strictEqual(evidence.title, title);
    assert.deepStrictEqual(evidence.pairs, pairs, 'the Evidence region lists the unit edge\'s file pairs');
    assert.strictEqual(evidence.total, evidence.edgeCount, 'the evidence total equals the edge label');

    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { openEvidenceRow: 0 });
    const active = () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      return uri ? vscode.workspace.asRelativePath(uri, false) : undefined;
    };
    const start = Date.now();
    while (Date.now() - start < 15000 && active() !== evidence.firstSource) await sleep(250);
    assert.strictEqual(active(), evidence.firstSource, 'the clicked row opens its file');

    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
    await enterUnit(of);
    await expectDetail('the evidence closed by entering the unit', undefined, detail => detail.evidence === undefined);
    await enterUnit('');
  });

  test('walks down a unit folder by folder: its sub-folders and their edges, evidence there, and back up', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    const root = await enterUnit('(root)');
    assert.strictEqual(root.groupCount, EXPECTED.root.groups);
    // (root)/graphql-project holds 3 sub-folders, 2 folder edges between them (graph-it architecture --folder).
    const graphql = await enterFolder('(root)/graphql-project', '(root)/graphql-project');
    assert.strictEqual(graphql.unit, '(root)');
    assert.strictEqual(graphql.groupCount, EXPECTED.graphql.groups, 'the sub-folders of graphql-project');
    assert.strictEqual(graphql.groupEdgeCount, EXPECTED.graphql.groupEdges, 'the edges between them');
    assert.notStrictEqual(graphql.revision, undefined);
    assertReadableLayout(graphql);
    const { evidence } = await expectDetail('the evidence one level down', { evidenceOf: EXPECTED.graphql.evidenceOf }, detail => detail.evidence !== undefined);
    assert.ok(evidence && evidence.total > 0 && evidence.total === evidence.edgeCount, 'the evidence lists the edge\'s file pairs');
    const up = await enterFolder('', undefined);
    assert.strictEqual(up.groupCount, EXPECTED.root.groups, 'back to the unit\'s top folders');
    assert.strictEqual(up.positions, root.positions, 'the top folders come back where they were');
    await enterUnit('');
  });

  test('labels only highlighted edges, highlights a found group neighbourhood, filters weak edges, and clears', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    await enterUnit('(root)');
    const { groups, groupEdges } = EXPECTED.root;
    const nothing = { highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0 };
    const noFileEdge = { shownFileEdges: 0 };
    try {
      // Count labels are hidden until an edge is highlighted.
      await expectInteraction('the default picture', undefined, { ...nothing, shownGroupEdges: groupEdges, ...noFileEdge });
      // layers imports one file of the (root) group: both stay, the 16 other groups fade.
      await expectInteraction('the layers neighbourhood', { find: 'LAYERS' }, {
        highlightedGroups: 2, fadedGroups: groups - 2, labelledEdges: 1, shownGroupEdges: groupEdges, ...noFileEdge,
      });
      // 1 of the 4 group edges carries a single import: the layers edge.
      await expectInteraction('the min-imports filter', { minImports: 2 }, {
        highlightedGroups: 1, fadedGroups: groups - 1, labelledEdges: 0, shownGroupEdges: 3, ...noFileEdge,
      });
      await expectInteraction('the cleared find', { find: '' }, { ...nothing, shownGroupEdges: 3, ...noFileEdge });
      await expectInteraction('the reset filter', { minImports: 1 }, { ...nothing, shownGroupEdges: groupEdges, ...noFileEdge });
    } finally {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { find: '', minImports: 1 });
      await enterUnit('');
    }
  });

  test('focuses and enters a group, lists the evidence of its edge, opens a file and goes back, in path and louvain modes', async function () {
    this.timeout(300000);
    await openFreshArchitecture();
    const byFolder = await enterUnit('(root)');
    // layers (4 files) imports one file of the (root) group.
    await exploreGroup('(root)/layers', EXPECTED.root.groups, EXPECTED.root.groupEdges);

    // A stale mark keeps the entered unit and the expanded group.
    await expectDetail('expanding layers again', { expand: '(root)/layers' }, detail => detail.expandedGroups === 1);
    const file = getProjectFile('sample-project', 'src', 'utils.ts');
    const original = await vscode.workspace.fs.readFile(file);
    try {
      await vscode.workspace.fs.writeFile(file, Buffer.concat([Buffer.from(original), Buffer.from('\n// architecture detail E2E\n')]));
      await waitForRender('the stale banner', byFolder.renderCount, render => render.stale);
      const kept = await expectDetail('the stale detail', undefined, detail => detail.expandedGroups === 1);
      assert.strictEqual((await readRender()).unit, '(root)', 'a stale mark keeps the entered unit');
      assert.strictEqual(kept.renderedFiles, Math.min(kept.expandedFileCount, 200), 'a stale mark keeps the rendered files');
    } finally {
      await vscode.workspace.fs.writeFile(file, original);
    }
    await expectDetail('collapsing layers', { collapse: '(root)/layers' }, detail => detail.expandedGroups === 0);
    await expectDetail('the overview', { focus: '' }, detail => detail.focusedGroup === undefined);

    await config().update('communityMode', 'louvain', vscode.ConfigurationTarget.Global);
    await waitForRender('the louvain render', byFolder.renderCount, render => render.communityMode === 'louvain');
    // src/layers (4 files) imports one file of src/components.
    await exploreGroup('src/layers', EXPECTED.louvain.groups, EXPECTED.louvain.groupEdges);
  });

  test('shows the matrix of graph-it architecture --matrix, opens a cell\'s evidence, enters a unit from its header and goes back, in path and louvain modes', async function () {
    this.timeout(300000);
    await openFreshArchitecture();
    try {
      const units = await expectMatrix('the units matrix', { view: 'matrix' }, matrix => matrix.unit === undefined && matrix.rows === EXPECTED.matrix.units.rows);
      assert.deepStrictEqual(totalsOf(units), EXPECTED.matrix.units, 'the same cells and totals as the CLI');
      assert.ok(units.renderedCells > 0 && units.renderedCells <= units.cells + 1, `virtualised cells in the DOM: ${units.renderedCells}`);
      assert.match(units.digest, /workspaces-project\/apps\/web>workspaces-project\/packages\/ui=2/);

      const { of, title, pairs } = EXPECTED.unitEvidence;
      const { evidence } = await expectDetail('the evidence of a matrix cell',
        { matrixCell: { row: of, column: 'workspaces-project/packages/ui' } }, detail => detail.evidence?.shown === pairs.length);
      assert.ok(evidence);
      assert.strictEqual(evidence.title, title);
      assert.deepStrictEqual(evidence.pairs, pairs, 'the cell lists the unit edge\'s file pairs');
      assert.strictEqual(evidence.total, evidence.edgeCount, 'the evidence total equals the cell');

      const root = await expectMatrix('the (root) matrix', { matrixHeader: '(root)' }, matrix => matrix.unit === '(root)');
      assert.deepStrictEqual(totalsOf(root), EXPECTED.matrix.root, 'an entered unit\'s groups, as graph-it architecture --folder "(root)" --matrix');
      const back = await expectMatrix('the units matrix again', { unit: '' }, matrix => matrix.unit === undefined);
      assert.strictEqual(back.digest, units.digest, 'back to the units');

      await config().update('communityMode', 'louvain', vscode.ConfigurationTarget.Global);
      const louvain = await expectMatrix('the louvain matrix', {}, matrix => matrix.rows === EXPECTED.matrix.louvain.rows);
      assert.deepStrictEqual(totalsOf(louvain), EXPECTED.matrix.louvain);
      const cell = louvain.digest.split(';').map(entry => entry.split(/>|=/)).find(([row, column]) => row !== column);
      assert.ok(cell, 'one cell between two groups');
      const louvainEvidence = await expectDetail('the evidence of a louvain cell',
        { matrixCell: { row: cell[0], column: cell[1] } }, detail => detail.evidence?.total !== undefined);
      assert.strictEqual(louvainEvidence.evidence?.total, Number(cell[2]), 'the evidence total equals the cell');
    } finally {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { view: 'graph' });
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
