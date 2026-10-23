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
  unitLevel?: {
    units: number; colors: number; redEdges: number; edgesNotDown: number; routedEdges: number; hiddenEdges: number; minLabelPx: number;
    roleBadges: number; roleTooltips: number; shownUnits: number;
    layerBands: number; unitsOutsideBand: number; cycleBlocks: number; cycleMembersOutside: number;
    minLabelContrast?: number; labelledRedEdges: number;
  };
  /** Drawn edges breaking a declared rule, and the Rules panel as `name=count`. */
  violationEdges: number;
  rulesPanel: string[];
  /** The role legend: `role=count`, `*` after the filtered role. */
  roles: string[];
  /** A group level: its header counts, isolated groups and label size. */
  groupLevel?: {
    shownGroups: number; totalGroups: number; hiddenGroups: number; hiddenGroupEdges: number;
    isolatedGroups: number; isolatedBelow: number; minLabelPx: number;
  };
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
  // 3 layers (@ws/web… on 2, (root), core, types… on 0); 1 cycle block (core ↔ types).
  units: { groups: 11, groupEdges: 9, redEdges: 2, layers: 3, cycles: 1 },
  root: { groups: 18, groupEdges: 4 },
  graphql: { groups: 3, groupEdges: 2, evidenceOf: '(root)/graphql-project/queries' },
  louvain: { groups: 25 + 1, groupEdges: 1 },
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
    units: { rows: 11, cells: 14, fileEdges: 214, upwardCells: 1, cycles: 1 },
    root: { rows: 18, cells: 20, fileEdges: 198, upwardCells: 1, cycles: 1 },
    louvain: { rows: 26, cells: 26, fileEdges: 214, upwardCells: 0, cycles: 0 },
  },
  // RULES_CONFIG written at the workspace root, then:
  //   node dist/graph-it.js check-architecture --format json -w tests/fixtures
  // web-not-ui: the 2 pairs of the @ws/web → @ws/ui edge; no-unit-cycles: both core ↔ types imports.
  rules: {
    panel: ['web-not-ui=2', 'no-unit-cycles=2'],
    violationEdges: 3,
    title: 'Rule "web-not-ui" (error): 2 violating file pairs: The web app reaches the UI kit through core.',
  },
  // roleCounts of: node dist/graph-it.js architecture --level units --format json -w tests/fixtures
  // (with ROLES_CONFIG written at the workspace root for `declared`).
  roles: {
    legend: ['function=1', 'library=4', 'tooling=2', 'unknown=4'],
    libraries: 4,
    declared: ['function=1', 'frontend=1', 'library=4', 'tooling=2', 'unknown=3'],
  },
} as const;

/** Declares a role only: no element, no rule. */
const ROLES_CONFIG = { roles: { '@ws/web': 'frontend' } };

const RULES_CONFIG = {
  elements: { web: { unit: '@ws/web' }, ui: { unit: '@ws/ui' } },
  rules: [
    { name: 'web-not-ui', from: 'web', forbid: 'ui', reason: 'The web app reaches the UI kit through core.' },
    { name: 'no-unit-cycles', noCycles: 'units', severity: 'warning' },
  ],
};

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
  violationCells?: number;
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
    violationEdges: (await read('ViolationEdges')) as number,
    rulesPanel: (await read('RulesPanel')) as string[],
    roles: (await read('Roles')) as string[],
    groupLevel: (await read('GroupLevel')) as ArchitectureRender['groupLevel'],
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
  selectedGroups?: number;
  foundGroups?: number;
  ringedGroups?: number;
  announcement?: string;
  canvasFocused?: boolean;
  zoom?: number;
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
    const shown = last && Object.fromEntries(Object.keys(expected).map(key => [key, last![key as keyof ArchitectureInteraction]]));
    if ((await readInteractionCount()) > before && JSON.stringify(shown) === JSON.stringify(expected)) return;
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
  findStatus?: string;
  viewport?: string;
  evidence?: { edgeCount: number; total: number; shown: number; firstSource?: string; title: string; pairs: string[] };
}

/** Sends the controls, then waits for the next interaction report satisfying `predicate`. */
async function waitForInteraction(
  description: string,
  controls: Record<string, unknown>,
  predicate: (interaction: ArchitectureInteraction) => boolean,
): Promise<ArchitectureInteraction> {
  const before = await readInteractionCount();
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const start = Date.now();
  let last: ArchitectureInteraction | undefined;
  while (Date.now() - start < 15000) {
    last = await getContextKey<ArchitectureInteraction>('graph-it-live.architectureInteraction');
    if ((await readInteractionCount()) > before && last && predicate(last)) return last;
    await sleep(250);
  }
  assert.fail(`${description}: last interaction ${JSON.stringify(last)}`);
}

/** The whole last render report: header height, legend and zoom have no key of their own. */
interface RenderedReport {
  headerHeightPx?: number;
  viewHeightPx?: number;
  legendOverflowing?: boolean;
  legendScrolls?: boolean;
  headerRows?: string[];
  zoom?: number;
}
const readRendered = async () => (await getContextKey<RenderedReport>('graph-it-live.architectureRendered')) ?? {};

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

interface DependentsReport {
  seedLabel: string;
  rows: string[];
  highlightedGroups: number;
  view: 'graph' | 'matrix';
}

/** Sends controls, then waits for the dependents panel and highlight to satisfy `predicate`. */
async function expectDependents(
  description: string,
  controls: Record<string, unknown>,
  predicate: (report: DependentsReport, groupCount: number) => boolean,
): Promise<DependentsReport> {
  await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', controls);
  const start = Date.now();
  let last: DependentsReport | undefined;
  let count = 0;
  while (Date.now() - start < 30000) {
    last = await getContextKey<DependentsReport>('graph-it-live.architectureDependents');
    count = (await getContextKey<number>('graph-it-live.architectureDependentsGroupCount')) ?? 0;
    if (last && predicate(last, count)) return last;
    await sleep(250);
  }
  assert.fail(`${description}: last dependents ${JSON.stringify(last)}, ${count} highlighted`);
}

/** Workspace-relative path of the active editor's file. */
const activeFile = () => {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri ? vscode.workspace.asRelativePath(uri, false) : undefined;
};

/** Waits for the file Dependency Graph to be rooted on `relativePath`, in view mode file. */
async function expectFileGraphOn(relativePath: string): Promise<void> {
  await waitForViewMode('file', { timeoutMs: 15000 });
  const start = Date.now();
  const root = async () => {
    const filePath = await getContextKey<string>('graph-it-live.fileGraphRoot');
    return filePath ? vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false) : undefined;
  };
  while (Date.now() - start < 15000 && (await root()) !== relativePath) await sleep(250);
  assert.strictEqual(await root(), relativePath, 'the file graph is rooted on the revealed file');
  assert.strictEqual(activeFile(), relativePath, 'the revealed file is the active editor');
  assert.strictEqual(await getContextKey('graph-it-live.viewMode'), 'file');
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
      roleBadges: EXPECTED.units.groups,
      roleTooltips: EXPECTED.units.groups,
      shownUnits: EXPECTED.units.groups,
      // One band per layer, every unit inside its own; the cycle as one block around its units.
      layerBands: EXPECTED.units.layers,
      unitsOutsideBand: 0,
      cycleBlocks: EXPECTED.units.cycles,
      cycleMembersOutside: 0,
      minLabelContrast: byFolder.unitLevel?.minLabelContrast,
      // Upward and cycle edges show their count without a hover.
      labelledRedEdges: EXPECTED.units.redEdges,
    }, 'one colour and role badge per unit, red cycle edges, every other edge drawn downwards, none hidden');
    assert.ok((byFolder.unitLevel?.minLabelContrast ?? 0) >= 4.5, `unit labels readable on their fill: ${byFolder.unitLevel?.minLabelContrast}:1`);
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
    // 1 group edge among 25 groups: every other group is announced and packed below the linked ones.
    assert.strictEqual(structural.groupLevel?.isolatedGroups, EXPECTED.louvain.groups - 2, 'isolated louvain groups');
    assert.strictEqual(structural.groupLevel?.isolatedBelow, structural.groupLevel?.isolatedGroups, 'isolated groups drawn below the others');
    assert.ok((structural.groupLevel?.minLabelPx ?? 0) >= 8, `labels readable after the fit: ${structural.groupLevel?.minLabelPx}px`);

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

  // #387: the importer is unchanged, so the view reads it from the index; only the target's creation can add the edge.
  test('draws the edge of an unchanged importer once its missing import target is created', async function () {
    this.timeout(240000);
    const importer = getProjectFile('sample-project', 'src', 'e2eLateImporter.ts');
    const target = getProjectFile('workspaces-project', 'packages', 'ui', 'src', 'e2eLateTarget.ts');
    try {
      await vscode.workspace.fs.writeFile(importer, Buffer.from(
        "import { late } from '../../workspaces-project/packages/ui/src/e2eLateTarget';\nexport const viaLate = late;\n",
      ));
      await sleep(2000); // let the importer's create event index it, its import still unresolved
      await openFreshArchitecture();
      const before = await expectMatrix('the units matrix', { view: 'matrix' }, matrix => matrix.unit === undefined);

      const staleCount = (await readRender()).renderCount;
      await vscode.workspace.fs.writeFile(target, Buffer.from('export const late = 1;\n'));
      await waitForRender('the stale banner', staleCount, render => render.stale);
      await sleep(2000); // let the create event re-analyse the importer before Refresh
      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      const after = await expectMatrix('the matrix with the new edge', { view: 'matrix' },
        matrix => matrix.unit === undefined && matrix.revision !== before.revision);
      assert.strictEqual(after.fileEdges, before.fileEdges + 1, 'the importer → created target edge');
    } finally {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { view: 'graph' });
      await vscode.workspace.fs.delete(importer).then(undefined, () => undefined);
      await vscode.workspace.fs.delete(target).then(undefined, () => undefined);
      await sleep(1500); // let the delete events reach the index before the next test refreshes
    }
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
    // The (root) ↔ components cycle edges always show their count; any other edge only once highlighted.
    const red = 2;
    const nothing = { highlightedGroups: 0, fadedGroups: 0, labelledEdges: red };
    const noFileEdge = { shownFileEdges: 0 };
    try {
      // Count labels are hidden until an edge is highlighted.
      await expectInteraction('the default picture', undefined, { ...nothing, shownGroupEdges: groupEdges, ...noFileEdge });
      // layers imports one file of the (root) group: both stay, the 16 other groups fade.
      await expectInteraction('the layers neighbourhood', { find: 'LAYERS' }, {
        highlightedGroups: 2, fadedGroups: groups - 2, labelledEdges: 1 + red, shownGroupEdges: groupEdges, ...noFileEdge,
      });
      // 1 of the 4 group edges carries a single import: the layers edge.
      await expectInteraction('the min-imports filter', { minImports: 2 }, {
        highlightedGroups: 1, fadedGroups: groups - 1, labelledEdges: red, shownGroupEdges: 3, ...noFileEdge,
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

  test('checks graphit.architecture.json: stale on edit, red edges and cells, Rules panel counts of the CLI, a rule\'s pairs', async function () {
    this.timeout(240000);
    const plain = await openFreshArchitecture();
    assert.strictEqual(plain.violationEdges, 0, 'no config, no violation');
    assert.deepStrictEqual(plain.rulesPanel, [], 'no config, no Rules panel');

    const root = vscode.workspace.workspaceFolders![0].uri;
    const configFile = vscode.Uri.joinPath(root, 'graphit.architecture.json');
    try {
      await vscode.workspace.fs.writeFile(configFile, Buffer.from(JSON.stringify(RULES_CONFIG, null, 2)));
      const stale = await waitForRender('the stale banner after writing the config', plain.renderCount, render => render.stale);
      assert.strictEqual(stale.buildCount, plain.buildCount, 'a config edit marks the view stale without rebuilding');

      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      const ruled = await waitForRender('the render with rules', stale.renderCount, render => !render.stale && render.rulesPanel.length > 0);
      assert.deepStrictEqual(ruled.rulesPanel, EXPECTED.rules.panel, 'Rules panel counts equal graph-it check-architecture');
      assert.strictEqual(ruled.violationEdges, EXPECTED.rules.violationEdges, 'violating unit edges drawn red');
      assert.strictEqual(ruled.groupCount, EXPECTED.units.groups, 'rules change no unit');

      const { evidence } = await expectDetail('the pairs of web-not-ui', { rule: 'web-not-ui' }, detail => detail.evidence?.title === EXPECTED.rules.title);
      assert.deepStrictEqual(evidence?.pairs, EXPECTED.unitEvidence.pairs, 'clicking a rule lists its violating pairs');

      const matrix = await expectMatrix('the units matrix with rules', { view: 'matrix' }, painted => painted.unit === undefined);
      assert.strictEqual(matrix.violationCells, EXPECTED.rules.violationEdges, 'violating matrix cells framed red');
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { view: 'graph' });

      await vscode.workspace.fs.writeFile(configFile, Buffer.from('{ "elements": {}, "rules": [{ "name": "r", "noCycles": "ghost" }] }'));
      await waitForRender('the stale banner after breaking the config', ruled.renderCount, render => render.stale);
    } finally {
      await vscode.workspace.fs.delete(configFile);
    }
    await sleep(1500); // let the delete mark the view stale before Refresh
    const staleCount = (await readRender()).renderCount;
    await vscode.commands.executeCommand('graph-it-live.refreshGraph');
    const restored = await waitForRender('the render without rules', staleCount, render => !render.stale && render.rulesPanel.length === 0);
    assert.strictEqual(restored.violationEdges, 0, 'deleting the config removes the red edges');
  });

  test('shows the unit roles of graph-it architecture --level units: legend counts, badges, evidence tooltips, role filter, declared role', async function () {
    this.timeout(240000);
    const built = await openFreshArchitecture();
    assert.deepStrictEqual(built.roles, EXPECTED.roles.legend, 'legend counts equal the CLI roleCounts');
    assert.strictEqual(built.unitLevel?.roleBadges, EXPECTED.units.groups, 'every unit drawn with its role badge');
    assert.strictEqual(built.unitLevel?.roleTooltips, EXPECTED.units.groups, 'every unit tooltip lists its role and evidence');

    // A real click on the legend's button: only the libraries stay drawn; a second click shows every unit.
    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { role: 'library' });
    const filtered = await waitForRender('the library filter', built.renderCount, render => render.roles.includes('library=4*'));
    assert.strictEqual(filtered.unitLevel?.shownUnits, EXPECTED.roles.libraries, 'the filter keeps the libraries only');
    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { role: 'library' });
    const all = await waitForRender('every unit again', filtered.renderCount, render => !render.roles.some(role => role.endsWith('*')));
    assert.strictEqual(all.unitLevel?.shownUnits, EXPECTED.units.groups, 'a second click shows every unit');

    const root = vscode.workspace.workspaceFolders![0].uri;
    const configFile = vscode.Uri.joinPath(root, 'graphit.architecture.json');
    try {
      await vscode.workspace.fs.writeFile(configFile, Buffer.from(JSON.stringify(ROLES_CONFIG, null, 2)));
      const stale = await waitForRender('the stale banner after declaring a role', all.renderCount, render => render.stale);
      await vscode.commands.executeCommand('graph-it-live.refreshGraph');
      const declared = await waitForRender('the render with the declared role', stale.renderCount,
        render => !render.stale && render.roles.includes('frontend=1'));
      assert.deepStrictEqual(declared.roles, EXPECTED.roles.declared, 'a declared role overrides the inferred one, as the CLI reports');
      assert.notStrictEqual(declared.revision, built.revision, 'roles are part of the revision');
    } finally {
      await vscode.workspace.fs.delete(configFile);
    }
    await sleep(1500); // let the delete mark the view stale before Refresh
    const staleCount = (await readRender()).renderCount;
    await vscode.commands.executeCommand('graph-it-live.refreshGraph');
    await waitForRender('the inferred roles again', staleCount, render => !render.stale && render.roles.join() === EXPECTED.roles.legend.join());
  });

  test('keeps the focused group, the find and the viewport across a stale mark and the min-imports filter', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    await enterUnit('(root)');
    const file = getProjectFile('sample-project', 'src', 'utils.ts');
    const original = await vscode.workspace.fs.readFile(file);
    try {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { find: 'LAYERS' });
      const focused = await expectDetail('focusing layers', { focus: '(root)/layers' }, detail => detail.focusedGroup === '(root)/layers');
      const highlight = await getContextKey<ArchitectureInteraction>('graph-it-live.architectureInteraction');
      const before = (await readRender()).renderCount;
      await vscode.workspace.fs.writeFile(file, Buffer.concat([Buffer.from(original), Buffer.from('\n// architecture context E2E\n')]));
      const stale = await waitForRender('the stale banner', before, render => render.stale);
      assert.strictEqual(stale.unit, '(root)', 'a stale mark keeps the entered unit');
      const kept = await expectDetail('the stale detail', undefined, detail => detail.focusedGroup === '(root)/layers');
      assert.strictEqual(kept.viewport, focused.viewport, 'a stale mark does not move the viewport');
      assert.deepStrictEqual(await getContextKey('graph-it-live.architectureInteraction'), highlight, 'a stale mark keeps the found highlight');
      assert.strictEqual(stale.groupLevel?.totalGroups, EXPECTED.root.groups, 'hidden and isolated groups stay counted');

      const filtered = await expectDetail('the min-imports filter', { minImports: 2 }, detail => detail.focusedGroup === '(root)/layers');
      assert.strictEqual(filtered.viewport, focused.viewport, 'the min-imports filter does not move the viewport');
    } finally {
      await vscode.workspace.fs.writeFile(file, original);
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { find: '', minImports: 1, focus: '' });
      await enterUnit('');
    }
  });

  test('draws the 50 largest groups of a folder, finds a hidden one, and Show more groups draws up to 150', async function () {
    this.timeout(300000);
    // A (root) folder of 60 sub-folders: d0..d49 hold 2 files, d50..d59 one; d0 → d1 → … → d45 import each other.
    const root = vscode.workspace.workspaceFolders![0].uri;
    const unit = vscode.Uri.joinPath(root, 'zz-many-groups');
    try {
      for (let index = 0; index < 60; index++) {
        const next = index < 45 ? `import { b } from '../d${index + 1}/b';\nexport const a = b;\n` : 'export const a = 1;\n';
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(unit, `d${index}`, 'a.ts'), Buffer.from(next));
        if (index < 50) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(unit, `d${index}`, 'b.ts'), Buffer.from('export const b = 1;\n'));
      }
      await openFreshArchitecture();
      await enterUnit('(root)');
      const capped = await enterFolder('(root)/zz-many-groups', '(root)/zz-many-groups');
      assert.strictEqual(capped.groupCount, 50, 'the 50 largest groups are drawn');
      assert.deepStrictEqual(capped.groupLevel, {
        shownGroups: 50, totalGroups: 60, hiddenGroups: 10, hiddenGroupEdges: 0,
        // d46..d49 import nothing and nobody imports them.
        isolatedGroups: 4, isolatedBelow: 4, minLabelPx: capped.groupLevel?.minLabelPx,
      });
      assert.ok((capped.groupLevel?.minLabelPx ?? 0) >= 8, `labels readable after the fit: ${capped.groupLevel?.minLabelPx}px`);
      assertReadableLayout(capped);

      const hidden = await expectDetail('finding a hidden group', { find: 'd55' }, detail => (detail.findStatus ?? '').includes('hidden'));
      assert.match(hidden.findStatus ?? '', /"d55" is also in 1 hidden group \(d55\)\. Show more groups/);

      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { showMoreGroups: true });
      const more = await waitForRender('Show more groups', capped.renderCount, render => render.groupCount === 60);
      assert.strictEqual(more.folder, '(root)/zz-many-groups', 'Show more groups keeps the entered folder');
      assert.strictEqual(more.revision, capped.revision, 'Show more groups keeps the revision');
      assert.deepStrictEqual({ ...more.groupLevel, minLabelPx: 0 }, {
        shownGroups: 60, totalGroups: 60, hiddenGroups: 0, hiddenGroupEdges: 0, isolatedGroups: 14, isolatedBelow: 14, minLabelPx: 0,
      });
      assertReadableLayout(more);
      const drawn = await expectDetail('the find once drawn', undefined, detail => detail.findStatus === '');
      assert.strictEqual(drawn.findStatus, '', 'the found group is drawn: nothing left to report');
    } finally {
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { find: '' });
      await vscode.workspace.fs.delete(unit, { recursive: true });
    }
    await sleep(1500); // let the delete mark the view stale before Refresh
    const staleCount = (await readRender()).renderCount;
    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { unit: '' });
    await vscode.commands.executeCommand('graph-it-live.refreshGraph');
    await waitForRender('the fixtures again', staleCount, render => !render.stale && render.groupCount === EXPECTED.units.groups);
  });

  test('rings found and selected units, fits back, moves with the keyboard, and shows the cycle block', async function () {
    this.timeout(180000);
    const units = await openFreshArchitecture();
    const rendered = await readRendered();
    assert.strictEqual(rendered.legendOverflowing, false, 'the legend overlay stays inside the canvas');

    // Find: each match ringed in the accent colour, never in its unit colour.
    const found = await waitForInteraction('finding @ws/core', { find: '@ws/core' }, interaction => (interaction.foundGroups ?? 0) >= 1);
    assert.strictEqual(found.ringedGroups, found.foundGroups, 'every found unit has a 3px+ ring of another colour');
    await waitForInteraction('clearing the find', { find: '' }, interaction => interaction.foundGroups === 0);

    // A click in the legend selects the unit, ringed the same way.
    const selected = await waitForInteraction('selecting @ws/web', { legendUnit: 'workspaces-project/apps/web' }, interaction => interaction.selectedGroups === 1);
    assert.strictEqual(selected.ringedGroups, 1, 'the selected unit is ringed');

    // Zoom in moves away from the fit; Fit comes back to the first fit's zoom (±1%).
    const initialZoom = rendered.zoom ?? 0;
    const zoomed = await waitForInteraction('zooming in', { zoom: 'in' }, interaction => (interaction.zoom ?? 0) > initialZoom * 1.1);
    assert.ok((zoomed.zoom ?? 0) > initialZoom, 'zoomed in');
    const fitted = await waitForInteraction('Fit', { zoom: 'fit' }, interaction => Math.abs((interaction.zoom ?? 0) - initialZoom) <= initialZoom * 0.01);
    assert.ok(Math.abs((fitted.zoom ?? 0) - initialZoom) <= initialZoom * 0.01, `Fit zoom ${fitted.zoom} vs ${initialZoom}`);

    // Keyboard only: an arrow selects a unit on the focused canvas and the live region names it.
    const moved = await waitForInteraction('an arrow key', { keys: ['ArrowDown'] }, interaction => interaction.canvasFocused === true && interaction.selectedGroups === 1);
    assert.ok((moved.announcement ?? '').length > 0, 'the live region announces the selection');
    const name = (moved.announcement ?? '').split(', ')[0];
    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { keys: ['Enter'] });
    const entered = await waitForRender('Enter on the selection', units.renderCount, render => render.unit !== undefined);
    assert.ok(name.length > 0 && entered.unit !== undefined, `entered ${entered.unit} from "${name}"`);
    await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { keys: ['Escape'] });
    const back = await waitForRender('Escape', entered.renderCount, render => render.unit === undefined);
    assert.strictEqual(back.unitLevel?.cycleBlocks, EXPECTED.units.cycles, 'back on the units with their cycle block');

    // The header's cycle count highlights the block's units.
    const cycle = await waitForInteraction('the cycle count', { cycleCount: true }, interaction => interaction.highlightedGroups >= 2);
    assert.ok(cycle.highlightedGroups >= 2, 'the cycle block\'s units are highlighted');
  });

  test('keeps unit labels readable on a light theme', async function () {
    this.timeout(120000);
    const workbench = vscode.workspace.getConfiguration('workbench');
    await workbench.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    try {
      const light = await openFreshArchitecture();
      assert.ok((light.unitLevel?.minLabelContrast ?? 0) >= 4.5, `light theme contrast ${light.unitLevel?.minLabelContrast}:1`);
    } finally {
      await workbench.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('keeps the header compact and scrolls the legend overlay with 60 more units', async function () {
    this.timeout(300000);
    const root = vscode.workspace.workspaceFolders![0].uri;
    const many = vscode.Uri.joinPath(root, 'zz-many-units');
    // The view's panel at its working size: 25% of a 230px strip cannot hold a toolbar.
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    try {
      for (let index = 0; index < 60; index++) {
        const unit = vscode.Uri.joinPath(many, `pkg-${index}`);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(unit, 'package.json'), Buffer.from(JSON.stringify({ name: `@many/pkg-${index}` })));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(unit, 'index.ts'), Buffer.from('export const a = 1;\n'));
      }
      await sleep(1500); // let the new files mark the view stale before Refresh: a late mark adds the stale banner
      const before = (await readRender()).renderCount;
      await openFreshArchitecture();
      const render = await waitForRender('the 71 units', before, current => !current.stale && current.groupCount === EXPECTED.units.groups + 60);
      const rendered = await readRendered() as RenderedReport & { stale?: boolean };
      assert.ok((rendered.headerHeightPx ?? Infinity) <= (rendered.viewHeightPx ?? 0) * 0.25,
        `header and controls within 25% of the view: ${rendered.headerHeightPx} of ${rendered.viewHeightPx}px (stale ${rendered.stale}, ${rendered.headerRows?.join(' ')})`);
      assert.strictEqual(rendered.legendOverflowing, false, 'the legend stays inside the canvas');
      assert.strictEqual(rendered.legendScrolls, true, '71 units scroll inside the legend, capped at 40% of the canvas');
      assert.strictEqual(render.unitLevel?.layerBands, EXPECTED.units.layers, 'the new units sit on layer 0');
    } finally {
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      await vscode.workspace.fs.delete(many, { recursive: true });
    }
    await sleep(1500); // let the delete mark the view stale before Refresh
    const staleCount = (await readRender()).renderCount;
    await vscode.commands.executeCommand('graph-it-live.refreshGraph');
    await waitForRender('the fixtures again', staleCount, render => !render.stale && render.groupCount === EXPECTED.units.groups);
  });

  // Expected rows from the view's answers on tests/fixtures (path mode), checked against
  // node dist/graph-it.js architecture --level units --format json -w tests/fixtures: @ws/web imports @ws/ui
  // twice and workspaces-root once; in (root), only the (root) group reaches graphql-project's fragments/user.gql (depth 2).
  test('shows dependents by group from a unit, a group and a file, highlights them in the graph and the matrix, and clears', async function () {
    this.timeout(240000);
    await openFreshArchitecture();
    const ui = await expectDependents('the dependents of @ws/ui', { dependentsOf: 'workspaces-project/packages/ui' },
      (report) => report.seedLabel === '@ws/ui');
    assert.deepStrictEqual(ui.rows, ['workspaces-project/apps/web=2/2@1', 'workspaces-project=1/1@1']);
    assert.strictEqual(ui.highlightedGroups, 2, 'both units are highlighted');
    assert.strictEqual(await getContextKey('graph-it-live.architectureDependentsGroupCount'), 2);
    await expectDependents('the matrix rows', { view: 'matrix' }, (report, count) => report.view === 'matrix' && count === 2);
    await expectDependents('the graph again', { view: 'graph' }, (report, count) => report.view === 'graph' && count === 2);
    await expectDependents('the cleared dependents', { clearDependents: true }, (report, count) => report.seedLabel === '' && count === 0);

    await enterUnit('(root)');
    const group = await expectDependents('the dependents of graphql-project', { dependentsOf: '(root)/graphql-project' },
      (report) => report.seedLabel === '(root)/graphql-project');
    assert.deepStrictEqual(group.rows, ['(root)=1/1@1']);
    assert.strictEqual(group.highlightedGroups, 1);
    await expectDetail('graphql-project expanded', { expand: '(root)/graphql-project' }, (detail) => detail.expandedGroups === 1);
    const file = await expectDependents('the dependents of a file', { dependentsOf: 'graphql-project/fragments/user.gql' },
      (report) => report.seedLabel === 'graphql-project/fragments/user.gql');
    assert.deepStrictEqual(file.rows, ['(root)=0/1@2']);
    assert.strictEqual(file.highlightedGroups, 1);
    // Another level groups dependents differently: leaving the unit clears them.
    await enterUnit('');
    await expectDependents('the dependents cleared by the level change', {}, (report, count) => report.seedLabel === '' && count === 0);
  });

  test('Show in Dependency Graph roots the file graph on the file, whether or not it was the active editor', async function () {
    this.timeout(240000);
    const target = 'workspaces-project/packages/ui/src/index.ts';
    const reveal = async () => {
      await openFreshArchitecture();
      await enterUnit('workspaces-project/packages/ui');
      await expectDetail('the ui group expanded', { expand: 'workspaces-project/packages/ui' }, (detail) => detail.renderedFiles > 0);
      await vscode.commands.executeCommand('graph-it-live.e2eArchitectureControls', { revealFile: target });
      await expectFileGraphOn(target);
    };
    // Not the active editor: utils.ts is.
    await openGraphFor('sample-project', 'src', 'utils.ts');
    await reveal();

    // Already the active editor, opened while the architecture view showed (so the file graph is still on utils.ts).
    await openGraphFor('sample-project', 'src', 'utils.ts');
    await openFreshArchitecture();
    await vscode.window.showTextDocument(getProjectFile('workspaces-project', 'packages', 'ui', 'src', 'index.ts'));
    await vscode.commands.executeCommand('graph-it-live.graphView.focus');
    assert.strictEqual(activeFile(), target);
    const before = await getContextKey<string>('graph-it-live.fileGraphRoot');
    assert.ok(before?.endsWith('utils.ts'), `the file graph stays on utils.ts in architecture mode (${before})`);
    await reveal();
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
