import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createIgnoreMatcher, createNestedGitignoreMatcher, isSupportedSourceFile, shouldSkipDirectory } from '../../src/analyzer/SourceFileFilters';

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
        for (const [name, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
          await fs.writeFile(path.join(root, name), content);
        }
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

    it('createNestedGitignoreMatcher honors the .gitignore of a nested folder, relative to that folder', async () => {
      await withRoot({ 'pkg/api/.gitignore': '/dist-tsc\n*.log\n', 'pkg/.gitignore': 'tmp/\n', '.gitignore': '*.ts\n' }, root => {
        expect(createIgnoreMatcher(root)(path.join('pkg', 'api', 'dist-tsc', 'a.js'), false)).toBe(false);
        const isIgnored = createNestedGitignoreMatcher(root);
        expect(isIgnored(path.join('..', 'pkg', 'x.log'), false)).toBe(false);
        expect(isIgnored(path.resolve(root, 'pkg', 'tmp', 'a.ts'), false)).toBe(false);
        expect(isIgnored('top.ts', false)).toBe(false);
        expect(isIgnored(path.join('pkg', 'api', 'dist-tsc'), true)).toBe(true);
        expect(isIgnored(path.join('pkg', 'api', 'dist-tsc', 'src', 'a.js'), false)).toBe(true);
        expect(isIgnored(path.join('pkg', 'api', 'src', 'dist-tsc', 'a.js'), false)).toBe(false);
        expect(isIgnored(path.join('pkg', 'api', 'deep', 'x.log'), false)).toBe(true);
        expect(isIgnored(path.join('pkg', 'tmp', 'a.ts'), false)).toBe(true);
        expect(isIgnored(path.join('pkg', 'api', 'tmp', 'a.ts'), false)).toBe(true);
        expect(isIgnored(path.join('dist-tsc', 'a.js'), false)).toBe(false);
        expect(isIgnored(path.join('other', 'x.log'), false)).toBe(false);
        expect(isIgnored(path.join('pkg', 'api', 'src', 'a.ts'), false)).toBe(false);
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
