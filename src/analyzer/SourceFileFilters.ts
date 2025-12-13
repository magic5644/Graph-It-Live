import { SUPPORTED_FILE_EXTENSIONS, IGNORED_DIRECTORIES } from '../shared/constants';

const ALWAYS_SKIPPED_DIRECTORIES = new Set(IGNORED_DIRECTORIES.filter(dir => dir !== 'node_modules'));

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
