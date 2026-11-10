/**
 * Fakes of the agent benchmark tests (#675-#677, #685): the `node:child_process` mock, and
 * an agent client process that replays stdout lines, then closes; kill() closes it at once.
 * Nothing is spawned.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough & { received?: string };
  kill: ReturnType<typeof vi.fn>;
}

export function fakeChild(lines: string[], { stderr = '', hang = false, error = null as string | null, chunks = null as string[] | null } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += String(chunk);
    child.stdin.received = input;
  });
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    child.emit('close', code);
  };
  child.kill = vi.fn(() => {
    setImmediate(() => close(null));
    return true;
  });
  setImmediate(() => {
    if (error) {
      child.emit('error', new Error(error));
      close(-2);
      return;
    }
    child.stderr.end(stderr);
    // Last line without a trailing newline: runProcess must flush it on close.
    chunks?.forEach((chunk) => child.stdout.write(chunk));
    if (!hang) child.stdout.end(lines.join('\n'));
  });
  child.stdout.on('end', () => setImmediate(() => close(0)));
  return child;
}

/**
 * `node:child_process` mock: execFileSync and spawn are vi.fn() a test sets up; spawn and every
 * other process call throw until then. Load it from vi.hoisted (dynamic import) before vi.mock.
 */
export function mockChildProcess(suite: string) {
  const refuse = (name: string) => () => {
    throw new Error(`${suite} tests must not spawn a real process (${name})`);
  };
  return {
    execFileSync: vi.fn(),
    spawn: vi.fn(refuse('spawn')),
    spawnSync: vi.fn(refuse('spawnSync')),
    exec: vi.fn(refuse('exec')),
    execSync: vi.fn(refuse('execSync')),
    execFile: vi.fn(refuse('execFile')),
    fork: vi.fn(refuse('fork')),
  };
}
