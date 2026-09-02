import path from 'node:path';
import { normalizePath } from '@/shared/path';

export interface CompiledFileScope {
  sqlGlob: string;
  matches(filePath: string): boolean;
}

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;
const WINDOWS_ROOT_PATH = /^[a-zA-Z]:\/$/;

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || filePath.startsWith('//') || WINDOWS_ABSOLUTE_PATH.test(filePath);
}

function normalizeResolvedPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const isUncPath = normalized.startsWith('//');
  const resolved = normalizePath(path.posix.normalize(normalized));
  return isUncPath && !resolved.startsWith('//') ? `/${resolved}` : resolved;
}

function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalizedRoot = normalizeResolvedPath(workspaceRoot);
  if (normalizedRoot === '/' || WINDOWS_ROOT_PATH.test(normalizedRoot)) {
    return normalizedRoot;
  }
  return normalizedRoot.replace(/\/+$/, '');
}

function joinToRoot(workspaceRoot: string, relativePath: string): string {
  return workspaceRoot.endsWith('/')
    ? `${workspaceRoot}${relativePath}`
    : `${workspaceRoot}/${relativePath}`;
}

function rootBoundary(workspaceRoot: string): string {
  return workspaceRoot.endsWith('/') ? workspaceRoot : `${workspaceRoot}/`;
}

function isWithinRoot(filePath: string, workspaceRoot: string): boolean {
  return filePath === workspaceRoot || filePath.startsWith(rootBoundary(workspaceRoot));
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globToRegexSource(pattern: string): string {
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexCharacter(character);
    }
  }

  return source;
}

function escapeSqlGlobLiteral(value: string): string {
  return value
    .replaceAll('[', '[[]')
    .replaceAll('*', '[*]')
    .replaceAll('?', '[?]');
}

function globToSqlGlob(pattern: string): string {
  let sqlGlob = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      sqlGlob += '*';
      index += pattern[index + 2] === '/' ? 2 : 1;
    } else if (character === '*' || character === '?') {
      sqlGlob += character;
    } else if (character === '[') {
      sqlGlob += '[[]';
    } else {
      sqlGlob += character;
    }
  }

  return sqlGlob;
}

export function compileFileScope(workspaceRoot: string, pattern: string): CompiledFileScope {
  const normalizedRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const normalizedPattern = normalizePath(pattern || '**');
  const qualifiedPattern = normalizeResolvedPath(
    isAbsolutePath(normalizedPattern)
      ? normalizedPattern
      : joinToRoot(normalizedRoot, normalizedPattern),
  );

  if (!isWithinRoot(qualifiedPattern, normalizedRoot)) {
    throw new Error('File scope must stay within the workspace root');
  }

  const relativePattern = qualifiedPattern === normalizedRoot
    ? ''
    : qualifiedPattern.slice(rootBoundary(normalizedRoot).length);
  const rootRegexSource = [...normalizedRoot].map(escapeRegexCharacter).join('');
  const qualifiedRegex = new RegExp(
    relativePattern.length > 0
      ? `^${joinToRoot(rootRegexSource, globToRegexSource(relativePattern))}$`
      : `^${rootRegexSource}$`,
  );
  const escapedSqlRoot = escapeSqlGlobLiteral(normalizedRoot);
  const sqlGlob = relativePattern.length > 0
    ? joinToRoot(escapedSqlRoot, globToSqlGlob(relativePattern))
    : escapedSqlRoot;

  return {
    sqlGlob,
    matches(filePath: string): boolean {
      const normalizedFilePath = normalizeResolvedPath(filePath);
      return isAbsolutePath(normalizedFilePath)
        && isWithinRoot(normalizedFilePath, normalizedRoot)
        && qualifiedRegex.test(normalizedFilePath);
    },
  };
}
