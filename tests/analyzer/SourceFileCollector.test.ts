import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { SourceFileCollector } from '../../src/analyzer/SourceFileCollector';

async function createTempWorkspace(structure: Record<string, string | null>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'collector-'));
  await Promise.all(
    Object.entries(structure).map(async ([relativePath, content]) => {
      const absolute = path.join(root, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (content === null) {
        await fs.mkdir(absolute, { recursive: true });
      } else {
        await fs.writeFile(absolute, content);
      }
    })
  );
  return root;
}

describe('SourceFileCollector', () => {
  const noopYield = async () => {};
  const toRelativePosix = (files: string[], root: string): string[] =>
    files
      .map(f => path.relative(root, f).split(path.sep).join('/'))
      .sort();

  it('collects supported files while skipping ignored directories', async () => {
    const root = await createTempWorkspace({
      'src/index.ts': '',
      'src/component.jsx': '',
      'notes.txt': '',
      'node_modules/pkg/index.ts': '',
      '.git/ignored.ts': '',
    });

    try {
      const collector = new SourceFileCollector({
        excludeNodeModules: true,
        yieldIntervalMs: 1,
        yieldCallback: noopYield,
        isCancelled: () => false,
      });

      const files = await collector.collectAllSourceFiles(root);
      expect(toRelativePosix(files, root)).toEqual(['src/component.jsx', 'src/index.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('can include node_modules when exclusion is disabled at runtime', async () => {
    const root = await createTempWorkspace({
      'node_modules/pkg/index.ts': '',
      'main.ts': '',
    });

    try {
      const collector = new SourceFileCollector({
        excludeNodeModules: true,
        yieldIntervalMs: 1,
        yieldCallback: noopYield,
        isCancelled: () => false,
      });

      const initial = await collector.collectAllSourceFiles(root);
      expect(toRelativePosix(initial, root)).toEqual(['main.ts']);

      collector.updateOptions({ excludeNodeModules: false });
      const updated = await collector.collectAllSourceFiles(root);
      expect(toRelativePosix(updated, root)).toEqual(['main.ts', 'node_modules/pkg/index.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
