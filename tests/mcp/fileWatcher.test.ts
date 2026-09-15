import * as fs from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpiderBuilder } from '@/analyzer/SpiderBuilder';
import { SymbolReverseIndex } from '@/analyzer/SymbolReverseIndex';
import { workerState } from '@/mcp/shared/state';
import { ensureCallGraphReady } from '@/mcp/tools/callgraph';
import { setupFileWatcher, stopFileWatcher } from '@/mcp/worker/fileWatcher';
import { normalizePath } from '@/shared/path';

describe('MCP file watcher', () => {
  // Native filesystem notifications can arrive later on Windows CI runners.
  const eventTimeout = 10_000;
  const testTimeout = 15_000;
  let root: string;
  const postMessage = vi.fn();

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-watch-')));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/old.ts'), 'export function helper() { return 1; }');
    await fs.writeFile(path.join(root, 'src/app.ts'), "import { helper } from './old'; export function result() { return helper(); }");
    workerState.config = { rootDir: root, excludeNodeModules: true, maxDepth: 50, extensionPath: process.cwd() };
    workerState.spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
    workerState.symbolReverseIndex = new SymbolReverseIndex(root);
    await workerState.spider.crawl(path.join(root, 'src/app.ts'));
    postMessage.mockClear();
    setupFileWatcher(postMessage);
    await once(workerState.fileWatcher!, 'ready');
  }, testTimeout);

  afterEach(async () => {
    await stopFileWatcher();
    workerState.reset();
    // Windows can briefly retain file handles after the watcher has closed.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, testTimeout);

  it('removes the old path from dependency and call graph indexes after a real rename', async () => {
    await ensureCallGraphReady();
    const oldPath = normalizePath(path.join(root, 'src/old.ts'));
    const newPath = normalizePath(path.join(root, 'src/new.ts'));
    expect(workerState.spider!.getSerializedReverseIndex()).toContain(oldPath);
    expect(workerState.callGraphIndexer!.getFileRecord(oldPath)).not.toBeNull();

    await fs.rename(oldPath, newPath);
    await fs.writeFile(path.join(root, 'src/app.ts'), "import { helper } from './new'; export function result() { return helper(); }");
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'unlink', filePath: oldPath }));
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: newPath }));
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'change' }));
    }, { timeout: eventTimeout });

    expect(workerState.spider!.getSerializedReverseIndex()).not.toContain(oldPath);
    await expect(workerState.spider!.analyze(oldPath)).rejects.toThrow();
    await workerState.spider!.reanalyzeFile(path.join(root, 'src/app.ts'));
    expect(await workerState.spider!.findReferencingFiles(newPath)).toHaveLength(1);
    await ensureCallGraphReady();
    const snapshot = workerState.callGraphIndexer!.getIndexSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(oldPath);
    expect(workerState.callGraphIndexer!.getFileRecord(newPath)).not.toBeNull();
    expect(snapshot.edges).toHaveLength(1);
  }, testTimeout);

  it('ignores unsupported files and excluded directories but watches new nested source files', async () => {
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules/ignored.ts'), 'export const ignored = 1;');
    await fs.writeFile(path.join(root, 'src/ignored.txt'), 'ignored');
    await fs.mkdir(path.join(root, 'src/nested'));
    const newPath = normalizePath(path.join(root, 'src/nested/added.ts'));
    await fs.writeFile(newPath, 'export const added = 1;');
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: newPath }));
    }, { timeout: eventTimeout });
    expect(postMessage.mock.calls.every(([message]) => message.filePath === newPath)).toBe(true);
  }, testTimeout);

  it('does not start watching without a workspace', async () => {
    await stopFileWatcher();
    workerState.config = null;
    setupFileWatcher(postMessage);
    expect(workerState.fileWatcher).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
