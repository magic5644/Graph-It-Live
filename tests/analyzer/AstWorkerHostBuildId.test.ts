import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AstWorkerHost } from '@/analyzer/ast/AstWorkerHost';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('AstWorkerHost.buildId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-build-id-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is the content hash of the worker bundle, read once per host', () => {
    const worker = path.join(dir, 'worker.js');
    fs.writeFileSync(worker, 'one build');
    const host = new AstWorkerHost(worker);

    expect(host.buildId()).toBe(sha256('one build'));
    fs.writeFileSync(worker, 'another build');
    expect(host.buildId()).toBe(sha256('one build'));
    expect(new AstWorkerHost(worker).buildId()).toBe(sha256('another build'));
  });

  it('is "missing" when the bundle cannot be read', () => {
    expect(new AstWorkerHost(path.join(dir, 'absent.js')).buildId()).toBe('missing');
  });
});
