/**
 * E2E regression for #264: an import resolving outside the opened folder used
 * to be dropped silently. The folder (tests/fixtures) holds
 * out-of-root-import/consumer.ts, whose import targets tests/out-of-root-target/,
 * so after background indexing the index status must report the skipped import.
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getIndexStatus, lmToolsSupported, sleep } from './_helpers';

interface IndexStatus {
  state?: string;
  outOfRootImports?: number;
  outOfRootImportExamples?: string[];
  warning?: string;
}

suite('Out-of-root imports (#264)', function () {
  this.timeout(90000);

  test('background indexing reports the import that resolves outside the folder', async function () {
    if (!lmToolsSupported()) {
      this.skip();
    }
    const extension = vscode.extensions.getExtension('magic5644.graph-it-live');
    await extension?.activate();
    // Index from source rather than whatever .graph-it/cache an earlier run left behind.
    await vscode.commands.executeCommand('graph-it-live.forceReindex');

    let status: IndexStatus = {};
    const deadline = Date.now() + 80000;
    while (Date.now() < deadline) {
      status = await getIndexStatus<IndexStatus>();
      if (status.state === 'complete' && (status.outOfRootImports ?? 0) > 0) break;
      await sleep(500);
    }

    assert.ok((status.outOfRootImports ?? 0) >= 1, `expected skipped imports, got ${JSON.stringify(status)}`);
    assert.ok(status.outOfRootImportExamples?.includes('../../out-of-root-target/shared'));
    assert.match(status.warning ?? '', /outside the workspace root/);
    assert.ok(!(status.warning ?? '').includes(vscode.workspace.workspaceFolders![0].uri.fsPath));
  });
});
