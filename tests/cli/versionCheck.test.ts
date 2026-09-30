import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:https', () => ({ get: vi.fn() }));

function mockRegistryResponse(statusCode: number, body: unknown): void {
  vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
    const payload = JSON.stringify(body);
    const res = {
      statusCode,
      on(event: string, handler: (data?: Buffer) => void) {
        if (event === 'data') handler(Buffer.from(payload));
        if (event === 'end') handler();
        return res;
      },
      resume: vi.fn(),
    };

    (cb as (r: typeof res) => void)(res);
    return {
      on: vi.fn(),
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof https.get>;
  });
}

describe('versionCheck', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    vi.resetAllMocks();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-version-check-'));
    delete process.env['GRAPH_IT_DISABLE_UPDATE_CHECK'];
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env['GRAPH_IT_DISABLE_UPDATE_CHECK'];
  });

  it('detects update and caches latest version', async () => {
    mockRegistryResponse(200, { version: '1.2.0' });
    const { checkForCliUpdate } = await import('../../src/cli/versionCheck.js');

    const result = await checkForCliUpdate({
      workspaceRoot,
      currentVersion: '1.1.0',
      minIntervalMs: 0,
      timeoutMs: 100,
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('1.2.0');

    const cachePath = path.join(workspaceRoot, '.graph-it', 'update-check.json');
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it('uses cache when fresh and skips network request', async () => {
    const cacheDir = path.join(workspaceRoot, '.graph-it');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'update-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '2.0.0' }),
    );

    const { checkForCliUpdate } = await import('../../src/cli/versionCheck.js');
    const result = await checkForCliUpdate({
      workspaceRoot,
      currentVersion: '1.0.0',
      minIntervalMs: 24 * 60 * 60 * 1000,
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('2.0.0');
    expect(https.get).not.toHaveBeenCalled();
  });

  it('writes startup notification when update available', async () => {
    mockRegistryResponse(200, { version: '3.0.0' });
    const writes: string[] = [];

    const { maybeNotifyCliUpdate } = await import('../../src/cli/versionCheck.js');
    await maybeNotifyCliUpdate({
      workspaceRoot,
      currentVersion: '2.9.9',
      write: (message: string) => {
        writes.push(message);
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Update available: v3.0.0');
    expect(writes[0]).toContain('Run: graph-it update');
  });

  it('does not notify when disabled by env flag', async () => {
    mockRegistryResponse(200, { version: '3.0.0' });
    process.env['GRAPH_IT_DISABLE_UPDATE_CHECK'] = '1';
    const writes: string[] = [];

    const { maybeNotifyCliUpdate } = await import('../../src/cli/versionCheck.js');
    await maybeNotifyCliUpdate({
      workspaceRoot,
      currentVersion: '2.9.9',
      write: (message: string) => {
        writes.push(message);
      },
    });

    expect(writes).toHaveLength(0);
    expect(https.get).not.toHaveBeenCalled();
  });
  it('does not notify dev builds', async () => {
    mockRegistryResponse(200, { version: '3.0.0' });
    const writes: string[] = [];

    const { maybeNotifyCliUpdate } = await import('../../src/cli/versionCheck.js');
    await maybeNotifyCliUpdate({
      workspaceRoot,
      currentVersion: '0.0.0-dev',
      write: (message: string) => {
        writes.push(message);
      },
    });

    expect(writes).toHaveLength(0);
    expect(https.get).not.toHaveBeenCalled();
  });

  it.each([
    [false, 0],
    [true, 1],
  ])('with default writer and stderr.isTTY=%s writes %i notice(s)', async (isTTY, count) => {
    mockRegistryResponse(200, { version: '3.0.0' });
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      const { maybeNotifyCliUpdate } = await import('../../src/cli/versionCheck.js');
      await maybeNotifyCliUpdate({ workspaceRoot, currentVersion: '2.9.9' });

      expect(writeSpy).toHaveBeenCalledTimes(count);
      expect(https.get).toHaveBeenCalledTimes(count);
    } finally {
      writeSpy.mockRestore();
      if (ttyDescriptor) Object.defineProperty(process.stderr, 'isTTY', ttyDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });

  it.each([
    ['1.2.4', '1.2.3', true],
    ['1.2.3', '1.2.3', false],
    ['1.2.3', '1.3.0', false],
    ['1.2.3', '1.2.3-rc.1', true],
    ['1.2.3-rc.1', '1.2.3', false],
    ['1.2.3-rc.2', '1.2.3-rc.1', true],
    ['1.2.3', 'not-a-version', false],
  ])('latest %s vs current %s reports updateAvailable=%s', async (latest, current, expected) => {
    mockRegistryResponse(200, { version: latest });
    const { checkForCliUpdate } = await import('../../src/cli/versionCheck.js');

    const result = await checkForCliUpdate({ workspaceRoot, currentVersion: current, minIntervalMs: 0 });

    expect(result).toEqual({ updateAvailable: expected, latestVersion: latest });
  });

  it('reports no update from a fresh cache holding an older version', async () => {
    const cacheDir = path.join(workspaceRoot, '.graph-it');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'update-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '1.0.0' }),
    );

    const { checkForCliUpdate } = await import('../../src/cli/versionCheck.js');
    const result = await checkForCliUpdate({ workspaceRoot, currentVersion: '1.0.0' });

    expect(result).toEqual({ updateAvailable: false, latestVersion: '1.0.0' });
    expect(https.get).not.toHaveBeenCalled();
  });

  it.each([
    ['non-numeric checkedAt', { checkedAt: 'x' }],
    ['non-string latestVersion', { checkedAt: Date.now(), latestVersion: 42 }],
  ])('ignores a cache with %s', async (_label, cache) => {
    const cacheDir = path.join(workspaceRoot, '.graph-it');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'update-check.json'), JSON.stringify(cache));
    mockRegistryResponse(200, { version: '1.0.0' });

    const { checkForCliUpdate } = await import('../../src/cli/versionCheck.js');
    await checkForCliUpdate({ workspaceRoot, currentVersion: '1.0.0' });

    expect(https.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    [500, { version: '3.0.0' }, 'npm registry returned HTTP 500'],
    [200, { version: 'latest' }, 'Unexpected or invalid version from npm registry'],
  ])('rejects registry status %i with body %j', async (status, body, message) => {
    mockRegistryResponse(status, body);
    const { fetchLatestVersion } = await import('../../src/cli/versionCheck.js');

    await expect(fetchLatestVersion()).rejects.toThrow(message);
  });

  it('stays silent when the registry check fails', async () => {
    mockRegistryResponse(500, {});
    const writes: string[] = [];

    const { maybeNotifyCliUpdate } = await import('../../src/cli/versionCheck.js');
    await maybeNotifyCliUpdate({
      workspaceRoot,
      currentVersion: '2.9.9',
      write: (message: string) => {
        writes.push(message);
      },
    });

    expect(writes).toHaveLength(0);
  });
});
