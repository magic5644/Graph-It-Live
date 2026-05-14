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
});
