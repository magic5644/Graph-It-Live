/**
 * MCP session helper tests
 *
 * stopSession must resolve only once the process has exited, so a caller can
 * delete the workspace without racing a server still writing its cache.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopSession } from '../../scripts/mcpSession';

const longRunning = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

describe('stopSession', () => {
  it('kills a running process and resolves after it exited', async () => {
    const child = longRunning();
    await once(child, 'spawn');

    await stopSession(child);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('returns at once for a process that already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');

    await expect(stopSession(child)).resolves.toBeUndefined();
    expect(child.exitCode).toBe(0);
  });

  // Windows has no catchable SIGTERM: kill() already terminates the process.
  it.skipIf(process.platform === 'win32')('force-kills a process that ignores SIGTERM after the grace period', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await once(child.stdout!, 'data');

    await stopSession(child, 200);

    expect(child.signalCode).toBe('SIGKILL');
  });
});
