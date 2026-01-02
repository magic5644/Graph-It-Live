import { IGNORED_DIRECTORIES } from '../../shared/constants';
import { normalizePath } from '../types';

/**
 * Check if a file path is inside an ignored directory (cross-platform).
 * Note: historical name in Spider was `isInNodeModules` but it actually checks all ignored dirs.
 */
export function isInIgnoredDirectory(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  
  // Split the path into segments
  const segments = normalized.split('/');
  
  // Check if any segment (excluding the last one which is the filename) matches an ignored directory
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRECTORIES.includes(segments[i])) {
      return true;
    }
  }
  
  return false;
}

