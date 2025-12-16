import { IGNORED_DIRECTORIES } from '../../shared/constants';
import { normalizePath } from '../types';

/**
 * Check if a file path is inside an ignored directory (cross-platform).
 * Note: historical name in Spider was `isInNodeModules` but it actually checks all ignored dirs.
 */
export function isInIgnoredDirectory(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return IGNORED_DIRECTORIES.some(
    (dir) => normalized.includes(`/${dir}/`) || normalized.includes(`/${dir}`)
  );
}

