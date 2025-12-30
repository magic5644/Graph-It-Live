/**
 * Test utilities for cross-platform file system operations
 */

import * as fs from 'node:fs/promises';

/**
 * Remove directory with retry for Windows compatibility
 * 
 * Windows may briefly hold file handles after operations, causing:
 * - ENOTEMPTY: directory not empty
 * - EBUSY: resource busy
 * - EPERM: operation not permitted
 * 
 * This function retries the operation with exponential backoff.
 * 
 * @param dirPath - Directory path to remove
 * @param retries - Number of retry attempts (default: 3)
 * @param initialDelayMs - Initial delay between retries in milliseconds (default: 100)
 * @returns Promise that resolves when directory is removed or doesn't exist
 * 
 * @example
 * ```typescript
 * afterEach(async () => {
 *   await removeDirectoryWithRetry(tempDir);
 * });
 * ```
 */
export async function removeDirectoryWithRetry(
  dirPath: string,
  retries: number = 3,
  initialDelayMs: number = 100
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return; // Success
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const isRetryableError =
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOTEMPTY' ||
          error.code === 'EBUSY' ||
          error.code === 'EPERM');

      if (isRetryableError && !isLastAttempt) {
        // Exponential backoff: 100ms, 200ms, 400ms
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // If not retryable or last attempt failed, check if directory exists
      try {
        await fs.access(dirPath);
        // Directory still exists, re-throw error
        throw error;
      } catch {
        // Directory doesn't exist (or not accessible), consider it success
        return;
      }
    }
  }
}

/**
 * Create directory with retries for Windows compatibility
 * 
 * @param dirPath - Directory path to create
 * @param options - Options for mkdir
 * @param retries - Number of retry attempts (default: 3)
 * @param delayMs - Delay between retries in milliseconds (default: 50)
 */
export async function createDirectoryWithRetry(
  dirPath: string,
  options: { recursive?: boolean } = { recursive: true },
  retries: number = 3,
  delayMs: number = 50
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.mkdir(dirPath, options);
      return;
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const isRetryableError =
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EBUSY' || error.code === 'EPERM');

      if (isRetryableError && !isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // If EEXIST, directory already exists - success
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return;
      }

      throw error;
    }
  }
}
