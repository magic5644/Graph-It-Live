import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BranchWatchAnalyzer } from '@/analyzer/BranchWatchAnalyzer';
import { Spider } from '@/analyzer/Spider';
import { branchWatchLanguages, createBranchWatchFixture } from '../vscode-e2e/fixtures/branchWatch.fixture';

describe('Branch watch real language parsers', () => {
  let root: string;
  let spider: Spider;
  let analyzer: BranchWatchAnalyzer;
  beforeAll(async () => {
    root = await createBranchWatchFixture();
    spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true });
    analyzer = new BranchWatchAnalyzer(root, spider, process.cwd());
    await spider.buildFullIndex();
  });
  afterAll(async () => { await spider?.dispose(); if (root) await fs.rm(root, { recursive: true, force: true }); });
  it.each(branchWatchLanguages)('$name retains impact for a real saved source file', async language => {
    await fs.writeFile(path.join(root, language.source), language.changed);
    await spider.reanalyzeFile(path.join(root, language.source));
    const result = await analyzer.analyze(await analyzer.capture('main'));
    const impact = result.fileImpacts.find(item => item.path === language.source);
    if (['Java', 'GraphQL'].includes(language.name) && !impact?.dependents.length) {
      expect(impact?.limitations.join(' ')).toContain('no known importers');
    } else {
      expect(impact?.dependents).toContainEqual({ path: language.consumer, depth: 1, changed: false });
    }
    if (['TypeScript', 'JavaScript'].includes(language.name)) expect(result.review.symbols.some(s => s.filePath === language.source)).toBe(true);
    else expect(result.limitations.join(' ')).toContain(`${language.source}: behavior unverified; signature comparison unavailable`);
    await fs.writeFile(path.join(root, language.source), language.content);
  });
});
