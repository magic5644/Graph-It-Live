import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getContextKey, getProjectFile, openGraphFor, sleep, waitForViewMode } from './_helpers';

type NodeMetadata = Record<string, { communityId?: number; communityKey?: string }>;

const key = (...segments: string[]): string =>
  getProjectFile('sample-project', 'src', ...segments).fsPath.split(path.sep).join('/');

async function waitForCommunities(
  description: string,
  predicate: (metadata: NodeMetadata) => boolean,
): Promise<NodeMetadata> {
  const start = Date.now();
  let metadata: NodeMetadata | undefined;
  while (Date.now() - start < 15000) {
    metadata = await getContextKey<NodeMetadata>('graph-it-live.fileGraphNodeMetadata');
    if (metadata && predicate(metadata)) return metadata;
    await sleep(200);
  }
  assert.fail(`Timed out waiting for ${description}. Last metadata: ${JSON.stringify(metadata)}`);
}

function lookup(metadata: NodeMetadata, nodeKey: string) {
  // Windows drive letters may differ in case between fsPath and normalizePath.
  const match = Object.entries(metadata).find(([candidate]) => candidate.toLowerCase() === nodeKey.toLowerCase());
  return match?.[1];
}

function community(metadata: NodeMetadata, nodeKey: string) {
  const meta = lookup(metadata, nodeKey);
  return { communityId: meta?.communityId, communityKey: meta?.communityKey };
}

suite('Community mode setting', () => {
  const config = () => vscode.workspace.getConfiguration('graph-it-live');

  setup(async () => {
    // Earlier suites can leave the view in symbol or list mode.
    await vscode.commands.executeCommand('graph-it-live.setViewModeFile');
    await waitForViewMode('file');
  });

  teardown(async () => {
    await config().update('communityMode', undefined, vscode.ConfigurationTarget.Global);
  });

  test('switches file-graph communities between path and louvain', async function () {
    this.timeout(60000);
    assert.strictEqual(config().get('communityMode'), 'path');

    // main.ts → utils.ts, components/Button.tsx; Button.tsx → utils.ts
    await openGraphFor('sample-project', 'src', 'main.ts');
    const main = key('main.ts');
    const utils = key('utils.ts');
    const button = key('components', 'Button.tsx');

    const byFolder = await waitForCommunities('path communities', metadata =>
      lookup(metadata, button)?.communityKey === 'components');
    assert.strictEqual(lookup(byFolder, utils)?.communityId, 0, 'utils.ts sits in no folder domain');

    await config().update('communityMode', 'louvain', vscode.ConfigurationTarget.Global);
    const structural = await waitForCommunities('louvain communities', metadata =>
      lookup(metadata, utils)?.communityKey === 'sample-project/src');
    for (const node of [main, button]) {
      assert.deepStrictEqual(community(structural, node), community(structural, utils), `${node} joins the import triangle`);
    }

    await config().update('communityMode', undefined, vscode.ConfigurationTarget.Global);
    await waitForCommunities('path communities again', metadata =>
      lookup(metadata, button)?.communityKey === 'components');
  });
});
