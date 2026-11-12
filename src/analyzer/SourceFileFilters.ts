import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
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

/**
 * Whether the `.gitignore` of a folder below `rootDir` ignores a path, read relative to that folder as git reads it
 * (a package's `/dist-tsc`). The walk honors only the root ignore files: a git-ignored file generated at build time
 * (`*.generated.ts` importing every resolver) stays indexed as an importer, so this only filters what to report.
 * Each folder's `.gitignore` is read once.
 */
export function createNestedGitignoreMatcher(rootDir: string): IgnoreMatcher {
  const rulesByFolder = new Map<string, Ignore | null>();
  const rulesOf = (folder: string): Ignore | null => {
    let rules = rulesByFolder.get(folder);
    if (rules === undefined) {
      try {
        rules = ignore().add(fs.readFileSync(path.join(rootDir, folder, '.gitignore'), 'utf8'));
      } catch {
        rules = null;
      }
      rulesByFolder.set(folder, rules);
    }
    return rules;
  };
  return (relativePath, isDirectory) => {
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;
    const posixPath = relativePath.split(path.sep).join('/');
    const target = isDirectory ? `${posixPath}/` : posixPath;
    for (let end = posixPath.indexOf('/'); end > 0; end = posixPath.indexOf('/', end + 1)) {
      if (rulesOf(posixPath.slice(0, end))?.ignores(target.slice(end + 1))) return true;
    }
    return false;
  };
}
