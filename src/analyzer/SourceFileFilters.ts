import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { SUPPORTED_FILE_EXTENSIONS, IGNORED_DIRECTORIES } from '../shared/constants';

const ALWAYS_SKIPPED_DIRECTORIES = new Set(IGNORED_DIRECTORIES.filter(dir => dir !== 'node_modules'));

/**
 * Paths skipped by default on top of `.gitignore`. A `.graphitignore` negation
 * (for example `!tests/fixtures/`) opts back in.
 */
export const DEFAULT_IGNORE_PATTERNS = ['tests/fixtures/', 'out-*/'];

/** Ignore files read from the workspace root, in precedence order. */
const IGNORE_FILES = ['.gitignore', '.graphitignore'];

export type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

export function isSupportedSourceFile(fileName: string): boolean {
  return SUPPORTED_FILE_EXTENSIONS.some(ext => fileName.endsWith(ext));
}

export function shouldSkipDirectory(entryName: string, excludeNodeModules: boolean): boolean {
  if (excludeNodeModules && entryName === 'node_modules') {
    return true;
  }
  if (ALWAYS_SKIPPED_DIRECTORIES.has(entryName)) {
    return true;
  }
  return entryName.startsWith('.');
}

/**
 * Build a matcher from the default patterns, then the root `.gitignore` and
 * `.graphitignore`. Paths are relative to `rootDir`; paths outside it never match.
 */
// ponytail: root-level ignore files only; add nested .gitignore support when monorepos need it
export function createIgnoreMatcher(rootDir: string): IgnoreMatcher {
  const matcher = ignore().add(DEFAULT_IGNORE_PATTERNS);
  for (const fileName of IGNORE_FILES) {
    try {
      matcher.add(fs.readFileSync(path.join(rootDir, fileName), 'utf8'));
    } catch {
      // Missing or unreadable ignore file: nothing to add
    }
  }

  return (relativePath, isDirectory) => {
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return false;
    }
    const posixPath = relativePath.split(path.sep).join('/');
    return matcher.ignores(isDirectory ? `${posixPath}/` : posixPath);
  };
}
