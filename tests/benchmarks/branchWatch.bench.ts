import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { BranchWatchAnalyzer } from '../../src/analyzer/BranchWatchAnalyzer';
import { Spider } from '../../src/analyzer/Spider';

const BENCH_OPTIONS = { time: 2000, warmupTime: 0, warmupIterations: 0, iterations: 1 } as const;

let root: string | undefined;
let spider: Spider | undefined;
let analyzer: BranchWatchAnalyzer | undefined;
let setupPromise: Promise<BranchWatchAnalyzer> | undefined;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('Branch Watch benchmarks', () => {
  async function getAnalyzer(): Promise<BranchWatchAnalyzer> {
    if (analyzer) return analyzer;
    setupPromise ??= (async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-watch-bench-'));
    git('init', '-b', 'main');
    git('config', 'user.email', 'benchmark@example.com');
    git('config', 'user.name', 'Branch Watch Benchmark');
    for (let index = 0; index < 100; index++) {
      const file = path.join(root, 'src', `module-${index}.ts`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `export function value${index}(n: number): number { return n + ${index}; }\n`);
    }
    await fs.writeFile(path.join(root, 'src', 'consumer.ts'), "import { value42 } from './module-42'; export const result = value42(1);\n");
    git('add', '.');
    git('commit', '-m', 'base');
    git('switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'src', 'module-42.ts'), 'export function value42(n: number, required: boolean): number { return n + 42; }\n');
    git('commit', '-am', 'feature');
    spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true, indexingConcurrency: 4 });
    await spider.buildFullIndex();
      analyzer = new BranchWatchAnalyzer(root, spider, process.cwd());
      return analyzer;
    })();
    return setupPromise;
  }

  afterAll(async () => {
    await setupPromise;
    await spider?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  bench('capture – 100-file branch snapshot', async () => {
    await (await getAnalyzer()).capture('main');
  }, BENCH_OPTIONS);

  bench('capture + analyze – 100-file branch snapshot', async () => {
    const instance = await getAnalyzer();
    const snapshot = await instance.capture('main');
    await instance.analyze(snapshot);
  }, BENCH_OPTIONS);
});
