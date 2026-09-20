import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BranchWatchAnalyzer } from '../../../src/analyzer/BranchWatchAnalyzer';
import { Spider } from '../../../src/analyzer/Spider';

const heapMb = () => process.memoryUsage().heapUsed / 1024 / 1024;
const forceGc = () => (globalThis as { gc?: () => void }).gc?.();
let root: string;
let spider: Spider;
let analyzer: BranchWatchAnalyzer;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('Branch Watch memory', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-watch-memory-'));
    git('init', '-b', 'main');
    git('config', 'user.email', 'memory@example.com');
    git('config', 'user.name', 'Branch Watch Memory');
    for (let index = 0; index < 50; index++) {
      const file = path.join(root, 'src', `module-${index}.ts`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `export const value${index} = ${index};\n`);
    }
    git('add', '.');
    git('commit', '-m', 'base');
    git('switch', '-c', 'feature');
    await fs.appendFile(path.join(root, 'src', 'module-0.ts'), '// changed\n');
    git('commit', '-am', 'feature');
    spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true, indexingConcurrency: 4 });
    await spider.buildFullIndex();
    analyzer = new BranchWatchAnalyzer(root, spider, process.cwd());
  });

  afterAll(async () => {
    await spider?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps heap growth bounded across repeated capture and analysis cycles', async () => {
    forceGc();
    const before = heapMb();
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    for (let index = 0; index < 20; index++) {
      await analyzer.analyze(await analyzer.capture('main'));
    }
    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = performance.now() - wallBefore;
    forceGc();
    const after = heapMb();
    const growth = after - before;
    console.log(`[Resources] Branch Watch 20 cycles: ${before.toFixed(1)} MB → ${after.toFixed(1)} MB (+${growth.toFixed(1)} MB), wall ${wallMs.toFixed(0)} ms, CPU ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`);
    expect(Number.isFinite(growth)).toBe(true);
    expect(Number.isFinite(wallMs)).toBe(true);
    expect(growth).toBeLessThan(128);
  });
});
