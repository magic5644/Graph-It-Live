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
    await fs.writeFile(path.join(root, '.gitignore'), 'generated/\n');
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

  // #387: the importer's own mtime never moves, so only the created file's event can add the edge.
  it('adds the edge of an unchanged importer when its missing import target is created', async () => {
    const appPath = path.join(root, 'src/app.ts');
    const laterPath = normalizePath(path.join(root, 'src/later.ts'));
    await fs.writeFile(appPath, "import { later } from './later'; export const result = later;");
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'change' }));
    }, { timeout: eventTimeout });
    await workerState.spider!.reanalyzeFile(appPath);
    expect(await workerState.spider!.analyzeFromIndex(appPath)).toEqual([]);

    await fs.writeFile(laterPath, 'export const later = 1;');
    await vi.waitFor(async () => {
      expect((await workerState.spider!.analyzeFromIndex(appPath)).map((d) => d.path)).toEqual([laterPath]);
    }, { timeout: eventTimeout });
  }, testTimeout);

  // #419: a tsconfig `paths` change moves no importer's mtime, so only its own event can re-resolve them.
  it('adds then removes the edge of an unchanged importer when a tsconfig alias is added then removed', async () => {
    const appPath = path.join(root, 'src/app.ts');
    const oldPath = normalizePath(path.join(root, 'src/old.ts'));
    const tsConfig = normalizePath(path.join(root, 'tsconfig.json'));
    await fs.writeFile(appPath, "import { helper } from '@app/old'; export const result = helper;");
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'change' }));
    }, { timeout: eventTimeout });
    await workerState.spider!.reanalyzeFile(appPath);
    expect(await workerState.spider!.analyzeFromIndex(appPath)).toEqual([]);

    await fs.writeFile(tsConfig, JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }));
    await vi.waitFor(async () => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: tsConfig }));
      expect((await workerState.spider!.analyzeFromIndex(appPath)).map((d) => d.path)).toEqual([oldPath]);
    }, { timeout: eventTimeout });

    await fs.rm(tsConfig);
    await vi.waitFor(async () => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'unlink', filePath: tsConfig }));
      expect(await workerState.spider!.analyzeFromIndex(appPath)).toEqual([]);
    }, { timeout: eventTimeout });
  }, testTimeout);

  // #431: an `extends` target named base.json moves no importer's mtime either, and tsconfig*.json is not its name.
  it('re-resolves an unchanged importer when an extends target named base.json is edited', async () => {
    const appPath = path.join(root, 'src/app.ts');
    const oldPath = normalizePath(path.join(root, 'src/old.ts'));
    const base = normalizePath(path.join(root, 'config/base.json'));
    await fs.mkdir(path.join(root, 'config'));
    await fs.writeFile(base, JSON.stringify({ compilerOptions: { baseUrl: '..', paths: {} } }));
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './config/base.json' }));
    await fs.writeFile(appPath, "import { helper } from '@app/old'; export const result = helper;");
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ filePath: normalizePath(path.join(root, 'tsconfig.json')) }));
    }, { timeout: eventTimeout });
    await workerState.spider!.reanalyzeFile(appPath);
    expect(await workerState.spider!.analyzeFromIndex(appPath)).toEqual([]);
    await vi.waitFor(() => expect(workerState.spider!.isResolverConfig(base)).toBe(true), { timeout: eventTimeout });

    await fs.writeFile(base, JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@app/*': ['./src/*'] } } }));
    await vi.waitFor(async () => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'change', filePath: base }));
      expect((await workerState.spider!.analyzeFromIndex(appPath)).map((d) => d.path)).toEqual([oldPath]);
    }, { timeout: eventTimeout });
  }, testTimeout);

  it('ignores a JSON file no tsconfig extends', async () => {
    const data = normalizePath(path.join(root, 'data.json'));
    const handle = vi.spyOn(workerState.spider!, 'handleResolverConfigChange');
    await fs.writeFile(data, '{}');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(handle).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ filePath: data }));
  }, testTimeout);

  // #430: a package.json edit that keeps its imports re-indexes nothing.
  it('re-indexes nothing when a resolver configuration edit keeps its effective content', async () => {
    const packageJson = normalizePath(path.join(root, 'package.json'));
    const handle = vi.spyOn(workerState.spider!, 'handleResolverConfigChange');
    await fs.writeFile(packageJson, '{ "name": "fx", "version": "1.0.0" }');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(packageJson, past, past);
    await vi.waitFor(() => {
      expect(handle).toHaveBeenCalledWith(packageJson);
    }, { timeout: eventTimeout });
    await Promise.all(handle.mock.results.map((result) => result.value));
    await workerState.spider!.buildFullIndex();
    // Waits for the snapshot taken after the index.
    expect(await workerState.spider!.handleResolverConfigChange(packageJson)).toBeNull();
    const reindex = vi.spyOn(workerState.spider!, 'reindexStaleFiles');
    const clearResolver = vi.fn();
    workerState.resolver = { clearCaches: clearResolver } as unknown as typeof workerState.resolver;
    const stale = vi.spyOn(workerState, 'markCallGraphStale');
    handle.mockClear();

    await fs.writeFile(packageJson, '{ "name": "fx", "version": "1.0.1", "scripts": { "test": "vitest" } }');
    await vi.waitFor(() => {
      expect(handle).toHaveBeenCalledWith(packageJson);
    }, { timeout: eventTimeout });
    expect(await handle.mock.results[0].value).toBeNull();
    expect(reindex).not.toHaveBeenCalled();
    expect(clearResolver).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalledWith();
  }, testTimeout);

  // #432: call edges resolved through `paths` follow the configuration without a manual rebuild.
  it('marks the call graph for a full rebuild when a resolver configuration change re-indexed', async () => {
    const stale = vi.spyOn(workerState, 'markCallGraphStale');
    const tsConfig = normalizePath(path.join(root, 'tsconfig.json'));
    await fs.writeFile(tsConfig, JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }));
    await vi.waitFor(() => {
      expect(stale).toHaveBeenCalledWith();
    }, { timeout: eventTimeout });
    expect(workerState.callGraphFullRebuild).toBe(true);
  }, testTimeout);

  it('keeps watching when re-indexing after a resolver configuration change fails', async () => {
    const reindex = vi.spyOn(workerState.spider!, 'handleResolverConfigChange').mockRejectedValue(new Error('boom'));
    const clearResolver = vi.fn();
    workerState.resolver = { clearCaches: clearResolver } as unknown as typeof workerState.resolver;
    const packageJson = normalizePath(path.join(root, 'package.json'));
    await fs.writeFile(packageJson, '{ "imports": { "#app/*": "./src/*" } }');
    await vi.waitFor(() => {
      expect(reindex).toHaveBeenCalled();
      expect(clearResolver).toHaveBeenCalled();
      expect(workerState.callGraphFullRebuild).toBe(true);
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: packageJson }));
    }, { timeout: eventTimeout });
  }, testTimeout);

  it('keeps the same watcher after a non-EMFILE watcher error', async () => {
    const watcher = workerState.fileWatcher!;
    watcher.emit('error', new Error('boom'));
    watcher.emit('error', 'not an Error');
    expect(workerState.fileWatcher).toBe(watcher);

    const addedPath = normalizePath(path.join(root, 'src/afterError.ts'));
    await fs.writeFile(addedPath, 'export const afterError = 1;');
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: addedPath }));
    }, { timeout: eventTimeout });
  }, testTimeout);

  it('keeps watching when re-analysing the importers of a created file fails', async () => {
    const reanalyze = vi.spyOn(workerState.spider!, 'reanalyzeUnresolvedImporters').mockRejectedValue(new Error('boom'));
    const createdPath = normalizePath(path.join(root, 'src/created.ts'));
    await fs.writeFile(createdPath, 'export const created = 1;');
    await vi.waitFor(() => {
      expect(reanalyze).toHaveBeenCalledWith(createdPath);
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: createdPath }));
    }, { timeout: eventTimeout });
  }, testTimeout);

  it('ignores unsupported files, excluded and gitignored directories but watches new nested source files', async () => {
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules/ignored.ts'), 'export const ignored = 1;');
    await fs.writeFile(path.join(root, 'src/ignored.txt'), 'ignored');
    await fs.mkdir(path.join(root, 'generated'));
    await fs.writeFile(path.join(root, 'generated/ignored.ts'), 'export const ignored = 1;');
    await fs.mkdir(path.join(root, 'out-webview'));
    await fs.writeFile(path.join(root, 'out-webview/ignored.d.ts'), 'export declare const ignored: number;');
    await fs.mkdir(path.join(root, 'src/nested'));
    const newPath = normalizePath(path.join(root, 'src/nested/added.ts'));
    await fs.writeFile(newPath, 'export const added = 1;');
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: newPath }));
    }, { timeout: eventTimeout });
    expect(postMessage.mock.calls.every(([message]) => message.filePath === newPath)).toBe(true);
  }, testTimeout);

  it('skips excluded and gitignored subdirectories when reconciling a new directory', async () => {
    const batch = path.join(root, 'src/batch');
    await fs.mkdir(path.join(batch, 'deep'), { recursive: true });
    await fs.mkdir(path.join(batch, 'generated'));
    await fs.mkdir(path.join(batch, 'node_modules'));
    await fs.writeFile(path.join(batch, 'generated/skipped.ts'), 'export const skipped = 1;');
    await fs.writeFile(path.join(batch, 'node_modules/skipped.ts'), 'export const skipped = 1;');
    const keptPath = normalizePath(path.join(batch, 'deep/kept.ts'));
    await fs.writeFile(keptPath, 'export const kept = 1;');
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'add', filePath: keptPath }));
      expect(workerState.pendingInvalidations.size).toBe(0);
    }, { timeout: eventTimeout });
    expect(postMessage.mock.calls.every(([message]) => message.filePath === keptPath)).toBe(true);
  }, testTimeout);

  it('cancels a pending new-directory reconciliation when stopped', async () => {
    const nested = path.join(root, 'src/pending');
    await fs.mkdir(nested);
    await vi.waitFor(() => {
      expect(workerState.pendingInvalidations.has(normalizePath(nested))).toBe(true);
    }, { timeout: eventTimeout });

    await stopFileWatcher();
    await fs.writeFile(path.join(nested, 'late.ts'), 'export const late = 1;');
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(workerState.pendingInvalidations.size).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
  }, testTimeout);

  it('does not start watching without a workspace', async () => {
    await stopFileWatcher();
    workerState.config = null;
    setupFileWatcher(postMessage);
    expect(workerState.fileWatcher).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
