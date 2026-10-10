/**
 * E2E for #295: get_index_status reports the on-disk size of the shared
 * .graph-it/cache/ files, so cache growth is visible without a size limit.
 * Background indexing persists the reverse index once it completes.
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { getIndexStatus, lmToolsSupported, sleep } from './_helpers';

interface IndexStatus {
  state?: string;
  cacheFiles?: { reverseIndexBytes: number; callGraphBytes: number };
}

suite('Index cache sizes (#295)', function () {
  this.timeout(90000);

  test('get_index_status reports the persisted reverse index size', async function () {
    if (!lmToolsSupported()) {
      this.skip();
    }
    await vscode.extensions.getExtension('magic5644.graph-it-live')?.activate();

    let status: IndexStatus = {};
    const deadline = Date.now() + 80000;
    while (Date.now() < deadline) {
      status = await getIndexStatus<IndexStatus>();
      if ((status.cacheFiles?.reverseIndexBytes ?? 0) > 0) break;
      await sleep(500);
    }

    assert.ok((status.cacheFiles?.reverseIndexBytes ?? 0) > 0, `expected a persisted reverse index, got ${JSON.stringify(status)}`);
    assert.strictEqual(typeof status.cacheFiles?.callGraphBytes, 'number');
  });
});
