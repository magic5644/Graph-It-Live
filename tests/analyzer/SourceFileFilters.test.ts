import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createIgnoreMatcher, isSupportedSourceFile, shouldSkipDirectory } from '../../src/analyzer/SourceFileFilters';

describe('SourceFileFilters', () => {
  it('detects supported file extensions', () => {
    expect(isSupportedSourceFile('index.ts')).toBe(true);
    expect(isSupportedSourceFile('component.jsx')).toBe(true);
    expect(isSupportedSourceFile('style.css')).toBe(false);
  });

  it('skips ignored and hidden directories, respects node_modules toggle', () => {
    expect(shouldSkipDirectory('node_modules', true)).toBe(true);
    expect(shouldSkipDirectory('node_modules', false)).toBe(false);

    expect(shouldSkipDirectory('.git', true)).toBe(true);
    expect(shouldSkipDirectory('dist', true)).toBe(true);
    expect(shouldSkipDirectory('some-dir', true)).toBe(false);
    expect(shouldSkipDirectory('.hidden', true)).toBe(true);
  });

  describe('createIgnoreMatcher', () => {
    const withRoot = async (files: Record<string, string>, run: (root: string) => void): Promise<void> => {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'ignore-matcher-'));
      try {
        await Promise.all(Object.entries(files).map(([name, content]) => fs.writeFile(path.join(root, name), content)));
        run(root);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    };

    it('applies default patterns when no ignore file exists', async () => {
      await withRoot({}, root => {
        const isIgnored = createIgnoreMatcher(root);
        expect(isIgnored(path.join('tests', 'fixtures'), true)).toBe(true);
        expect(isIgnored(path.join('tests', 'fixtures', 'a.ts'), false)).toBe(true);
        expect(isIgnored('out-webview', true)).toBe(true);
        expect(isIgnored(path.join('src', 'tests', 'fixtures', 'a.ts'), false)).toBe(false);
        expect(isIgnored(path.join('src', 'index.ts'), false)).toBe(false);
      });
    });

    it('honors .gitignore and lets .graphitignore re-include default paths', async () => {
      await withRoot({ '.gitignore': '/wiki/\n*.gen.ts\n', '.graphitignore': '!tests/fixtures/\n' }, root => {
        const isIgnored = createIgnoreMatcher(root);
        expect(isIgnored('wiki', true)).toBe(true);
        expect(isIgnored(path.join('src', 'wiki', 'a.ts'), false)).toBe(false);
        expect(isIgnored(path.join('src', 'a.gen.ts'), false)).toBe(true);
        expect(isIgnored(path.join('tests', 'fixtures', 'a.ts'), false)).toBe(false);
      });
    });

    it('never matches the root itself or paths outside it', async () => {
      await withRoot({ '.gitignore': '*\n' }, root => {
        const isIgnored = createIgnoreMatcher(root);
        expect(isIgnored('', true)).toBe(false);
        expect(isIgnored(path.join('..', 'other.ts'), false)).toBe(false);
        expect(isIgnored(path.resolve(root, 'a.ts'), false)).toBe(false);
        expect(isIgnored('..hidden.ts', false)).toBe(true);
      });
    });
  });
});
